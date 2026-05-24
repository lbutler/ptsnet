/**
 * Parallel Method-of-Characteristics engine (Node `worker_threads` or browser
 * Web Workers).
 *
 * The interior stencil reads the previous-step columns and writes disjoint
 * output ranges, so with all point arrays in a SharedArrayBuffer it parallelizes
 * with no ghost exchange: each worker owns a contiguous point range. The cheap
 * boundary kernels run on the main thread, making results bit-identical to the
 * serial engine.
 *
 * Synchronization is a two-phase Atomics barrier on a shared control block.
 * `runStep` blocks the calling thread (`Atomics.wait`, fine in Node); `runStepAsync`
 * uses `Atomics.waitAsync` so it never blocks the browser main thread.
 */
import { SteadyState } from './../core/types';
import { EngineModel } from './../core/serialModel';
import { SimulationResults, RecordingOptions, Envelope } from './../core/results';
import { Recorder } from './../core/recorder';
import {
  BoundaryState,
  makeBoundaryState,
  initClosedProtection,
  runBoundaryPhase,
} from './../core/boundaryPhase';
import { WorkerBackend, WorkerHandle } from './workerBackend';

// Control block indices.
const PHASE = 0;
const DONE = 1;
const T0 = 2;
const T1 = 3;
const TERM = 4;

const WORKER_SOURCE = /* js */ `(function () {
  function start(d) {
    var N = d.N, lo = d.lo, hi = d.hi, W = d.W;
    var flow = new Float64Array(d.flowSab), head = new Float64Array(d.headSab);
    var B = new Float64Array(d.bSab), R = new Float64Array(d.rSab);
    var Cp = new Float64Array(d.cpSab), Bp = new Float64Array(d.bpSab);
    var Cm = new Float64Array(d.cmSab), Bm = new Float64Array(d.bmSab);
    var hasPlus = new Int32Array(d.hasPlusSab), hasMinus = new Int32Array(d.hasMinusSab);
    var ctrl = new Int32Array(d.ctrlSab);
    var PHASE = 0, DONE = 1, T0 = 2, T1 = 3, TERM = 4;
    var abs = Math.abs;
    var iLo = lo < 1 ? 1 : lo, iHi = hi < N - 1 ? hi : N - 1;
    var phase = 0;
    for (;;) {
      Atomics.wait(ctrl, PHASE, phase);
      phase = Atomics.load(ctrl, PHASE);
      if (Atomics.load(ctrl, TERM)) break;
      var o0 = Atomics.load(ctrl, T0) * N, o1 = Atomics.load(ctrl, T1) * N;
      for (var i = iLo; i < iHi; i++) {
        var up = o0 + i - 1, dn = o0 + i + 1;
        var cm = (head[dn] - B[i] * flow[dn]) * hasMinus[i];
        var bm = (B[i] + R[i] * abs(flow[dn])) * hasMinus[i];
        var cp = (head[up] + B[i] * flow[up]) * hasPlus[i];
        var bp = (B[i] + R[i] * abs(flow[up])) * hasPlus[i];
        Cm[i] = cm; Bm[i] = bm; Cp[i] = cp; Bp[i] = bp;
        head[o1 + i] = (cp * bm + cm * bp) / (bp + bm);
        flow[o1 + i] = (cp - cm) / (bp + bm);
      }
      if (lo === 0) { Cm[0] = head[o0 + 1] - B[0] * flow[o0 + 1]; Bm[0] = B[0] + R[0] * abs(flow[o0 + 1]); }
      if (hi === N) { Cp[N - 1] = head[o0 + N - 2] + B[N - 2] * flow[o0 + N - 2]; Bp[N - 1] = B[N - 2] + R[N - 2] * abs(flow[o0 + N - 2]); }
      if (Atomics.add(ctrl, DONE, 1) === W - 1) Atomics.notify(ctrl, DONE);
    }
  }
  if (typeof require === 'function') {
    try { require('worker_threads').parentPort.once('message', start); return; } catch (e) {}
  }
  self.onmessage = function (e) { self.onmessage = null; start(e.data); };
})();`;

function f64(n: number): { sab: SharedArrayBuffer; arr: Float64Array } {
  const sab = new SharedArrayBuffer(n * 8);
  return { sab, arr: new Float64Array(sab) };
}
function i32(n: number): { sab: SharedArrayBuffer; arr: Int32Array } {
  const sab = new SharedArrayBuffer(n * 4);
  return { sab, arr: new Int32Array(sab) };
}

interface WaitAsyncResult {
  async: boolean;
  value: 'ok' | 'not-equal' | 'timed-out' | Promise<'ok' | 'timed-out'>;
}
type AtomicsWithAsync = typeof Atomics & {
  waitAsync(ta: Int32Array, index: number, value: number): WaitAsyncResult;
};

export class ParallelEngine {
  private readonly recorder: Recorder;
  private readonly st: BoundaryState;
  private readonly n: number;
  private readonly W: number;

  private readonly flow: Float64Array; // length 2N (two columns)
  private readonly head: Float64Array;
  private readonly Cp: Float64Array;
  private readonly Bp: Float64Array;
  private readonly Cm: Float64Array;
  private readonly Bm: Float64Array;
  private readonly ctrl: Int32Array;
  private readonly workers: WorkerHandle[] = [];
  private phase = 0;
  private disposed = false;

  constructor(
    backend: WorkerBackend,
    numWorkers: number,
    private readonly ss: SteadyState,
    private readonly model: EngineModel,
    private readonly timeStep: number,
    timeSteps: number,
    recording: RecordingOptions = {},
  ) {
    const n = model.numPoints;
    this.n = n;
    this.W = Math.max(1, Math.min(numWorkers, n));

    const flow = f64(2 * n);
    const head = f64(2 * n);
    const B = f64(n);
    const R = f64(n);
    const Cp = f64(n);
    const Bp = f64(n);
    const Cm = f64(n);
    const Bm = f64(n);
    const hasPlus = i32(n);
    const hasMinus = i32(n);
    const ctrl = i32(8);

    this.flow = flow.arr;
    this.head = head.arr;
    this.Cp = Cp.arr;
    this.Bp = Bp.arr;
    this.Cm = Cm.arr;
    this.Bm = Bm.arr;
    this.ctrl = ctrl.arr;

    B.arr.set(model.B);
    R.arr.set(model.R);
    hasPlus.arr.set(model.hasPlus);
    hasMinus.arr.set(model.hasMinus);
    flow.arr.set(model.initFlow, 0);
    head.arr.set(model.initHead, 0);

    this.recorder = new Recorder(model, ss, timeSteps, timeStep, recording);
    this.st = makeBoundaryState(model);
    this.recorder.record(0, this.head.subarray(0, n), this.flow.subarray(0, n), null, null);
    initClosedProtection(model, ss, this.st);

    const shared = {
      flowSab: flow.sab,
      headSab: head.sab,
      bSab: B.sab,
      rSab: R.sab,
      cpSab: Cp.sab,
      bpSab: Bp.sab,
      cmSab: Cm.sab,
      bmSab: Bm.sab,
      hasPlusSab: hasPlus.sab,
      hasMinusSab: hasMinus.sab,
      ctrlSab: ctrl.sab,
      N: n,
      W: this.W,
    };
    const chunk = Math.ceil(n / this.W);
    for (let w = 0; w < this.W; w++) {
      const lo = w * chunk;
      const hi = Math.min(n, lo + chunk);
      const handle = backend.spawn(WORKER_SOURCE);
      handle.postMessage({ ...shared, lo, hi });
      this.workers.push(handle);
    }
  }

  get results(): SimulationResults {
    return this.recorder.results;
  }
  get envelope(): Envelope | undefined {
    return this.recorder.envelope;
  }
  get time(): Float64Array {
    return this.recorder.time;
  }

  private dispatch(t0: number, t1: number): void {
    const ctrl = this.ctrl;
    Atomics.store(ctrl, DONE, 0);
    Atomics.store(ctrl, T0, t0);
    Atomics.store(ctrl, T1, t1);
    this.phase++;
    Atomics.store(ctrl, PHASE, this.phase);
    Atomics.notify(ctrl, PHASE);
  }

  private boundary(t: number, t0: number, t1: number): void {
    const n = this.n;
    const H0 = this.head.subarray(t0 * n, t0 * n + n);
    const Q1 = this.flow.subarray(t1 * n, t1 * n + n);
    const H1 = this.head.subarray(t1 * n, t1 * n + n);
    runBoundaryPhase(
      this.ss,
      this.model,
      this.timeStep,
      this.st,
      this.recorder,
      t,
      H0,
      Q1,
      H1,
      this.Cp,
      this.Bp,
      this.Cm,
      this.Bm,
    );
  }

  /** Synchronous step (blocks via Atomics.wait — Node, or any non-UI thread). */
  runStep(t: number): void {
    const t1 = t % 2;
    const t0 = 1 - t1;
    this.dispatch(t0, t1);
    let v: number;
    while ((v = Atomics.load(this.ctrl, DONE)) < this.W) Atomics.wait(this.ctrl, DONE, v);
    this.boundary(t, t0, t1);
  }

  /** Non-blocking step (Atomics.waitAsync — safe on the browser main thread). */
  async runStepAsync(t: number): Promise<void> {
    const t1 = t % 2;
    const t0 = 1 - t1;
    this.dispatch(t0, t1);
    const A = Atomics as AtomicsWithAsync;
    for (;;) {
      const v = Atomics.load(this.ctrl, DONE);
      if (v >= this.W) break;
      const r = A.waitAsync(this.ctrl, DONE, v);
      if (r.async) await r.value;
    }
    this.boundary(t, t0, t1);
  }

  /** Terminate the worker pool. Safe to call multiple times. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    Atomics.store(this.ctrl, TERM, 1);
    this.phase++;
    Atomics.store(this.ctrl, PHASE, this.phase);
    Atomics.notify(this.ctrl, PHASE);
    for (const w of this.workers) w.terminate();
  }
}
