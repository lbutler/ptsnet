/**
 * Parallel Method-of-Characteristics engine (Node `worker_threads` or browser
 * Web Workers) — the only engine.
 *
 * The interior stencil reads the previous-step columns and writes disjoint
 * output ranges, so with all point arrays in a SharedArrayBuffer it parallelizes
 * with no ghost exchange: each worker owns a contiguous point range. The cheap
 * boundary kernels run on the main thread. Synchronization is a two-phase
 * Atomics barrier on a shared control block. `runStep` blocks the calling thread
 * (`Atomics.wait`, fine in Node); `runStepAsync` uses `Atomics.waitAsync` so it
 * never blocks the browser main thread.
 *
 * Column separation (DGCM) is an opt-in mode: the worker solves the per-point gas
 * quadratic instead of the plain stencil, carrying two flow faces (qu/qd) and a
 * persistent gas volume; the main thread adds the valve gas cavities. See
 * {@link ./../core/boundaryPhase} and the project README.
 *
 * When the pool size is 1 (`workers: 1`, or a single-core/`n === 1` case) the
 * interior stencil runs inline on the calling thread — no worker spawn, no
 * barrier — via {@link runInteriorStep} / {@link runInteriorStepCav}, which
 * mirror the two branches of the worker source below (keep them in sync).
 */
import { SteadyState } from './../core/types';
import { EngineModel } from './../core/serialModel';
import {
  SimulationResults,
  RecordingOptions,
  Envelope,
  CavitationReport,
  CavityElementReport,
} from './../core/results';
import { Recorder } from './../core/recorder';
import {
  BoundaryState,
  makeBoundaryState,
  initClosedProtection,
  runBoundaryPhase,
  CavState,
  CavitationOptions,
  PumpTripState,
} from './../core/boundaryPhase';
import { WorkerBackend, WorkerHandle } from './workerBackend';
import { runInteriorStep, runInteriorStepCav } from './../core/kernels';
import {
  UnsteadyFrictionOptions,
  buildUnsteadyFrictionFactors,
} from './../core/unsteadyFriction';
import {
  QuasiSteadyFrictionOptions,
  buildQuasiSteadyFrictionFactors,
} from './../core/quasiSteadyFriction';

// Control block indices.
const PHASE = 0;
const DONE = 1;
const T0 = 2;
const T1 = 3;
const TERM = 4;

const WORKER_SOURCE = /* js */ `(function () {
  function start(d) {
    var N = d.N, lo = d.lo, hi = d.hi, W = d.W;
    var head = new Float64Array(d.headSab);
    var B = new Float64Array(d.bSab), R = new Float64Array(d.rSab);
    var Cp = new Float64Array(d.cpSab), Bp = new Float64Array(d.bpSab);
    var Cm = new Float64Array(d.cmSab), Bm = new Float64Array(d.bmSab);
    var hasPlus = new Int32Array(d.hasPlusSab), hasMinus = new Int32Array(d.hasMinusSab);
    var ctrl = new Int32Array(d.ctrlSab);
    var PHASE = 0, DONE = 1, T0 = 2, T1 = 3, TERM = 4;
    var abs = Math.abs, sqrt = Math.sqrt;
    var iLo = lo < 1 ? 1 : lo, iHi = hi < N - 1 ? hi : N - 1;
    var phase = 0;
    var uf = d.uf, Ku = uf ? new Float64Array(d.kuSab) : null;
    function sgn(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }
    var qsf = d.qsf;
    var Rgeo = qsf ? new Float64Array(d.rgeoSab) : null;
    var Refac = qsf ? new Float64Array(d.refacSab) : null;
    var Rrough = qsf ? new Float64Array(d.rroughSab) : null;
    // Quasi-steady friction term f(Re)·Rgeo·|Q| — must match qsfTerm in core/kernels.ts.
    function qsfTerm(aq, i) {
      var re = aq * Refac[i];
      if (re < 2000) return (64 * Rgeo[i]) / Refac[i];
      var l = Math.log10(Rrough[i] / 3.7 + 5.74 / (re ** 0.9));
      return (0.25 / (l * l)) * Rgeo[i] * aq;
    }
    if (d.cav) {
      var qd = new Float64Array(d.flowSab), qu = new Float64Array(d.quSab);
      var gasVol = new Float64Array(d.gasVolSab), Hgas = new Float64Array(d.hgasSab), C3 = new Float64Array(d.c3Sab);
      var isInt = new Int32Array(d.isIntSab);
      var dt = d.dt, psi = d.psi;
      for (;;) {
        Atomics.wait(ctrl, PHASE, phase);
        if (Atomics.load(ctrl, TERM)) break;
        // Stale-wakeup guard: dispatch's store(PHASE) and notify(PHASE) are not a
        // single atomic op, so a fast worker can clear its wait via the value
        // check, finish the step, re-block on the same phase, then be woken by the
        // already-issued notify. Re-running that phase would double-count DONE and
        // let the main thread proceed before every worker has written its range.
        var next = Atomics.load(ctrl, PHASE);
        if (next === phase) continue;
        phase = next;
        var o0 = Atomics.load(ctrl, T0) * N, o1 = Atomics.load(ctrl, T1) * N;
        for (var i = iLo; i < iHi; i++) {
          var up = o0 + i - 1, dn = o0 + i + 1;
          var fup = qsf ? qsfTerm(abs(qd[up]), i) : R[i] * abs(qd[up]);
          var fdn = qsf ? qsfTerm(abs(qu[dn]), i) : R[i] * abs(qu[dn]);
          var cp = (head[up] + B[i] * qd[up]) * hasPlus[i];
          var bp = (B[i] + fup) * hasPlus[i];
          var cm = (head[dn] - B[i] * qu[dn]) * hasMinus[i];
          var bm = (B[i] + fdn) * hasMinus[i];
          Cp[i] = cp; Bp[i] = bp; Cm[i] = cm; Bm[i] = bm;
          if (isInt[i]) {
            if (uf) {
              var kB = Ku[i], q = qd[o0 + i];
              var e = kB * (sgn(q) * abs(qd[dn] - qd[up]) * 0.5 - q);
              cp -= e; cm += e; bp += kB; bm += kB;
            }
            var invBp = 1 / bp, invBm = 1 / bm;
            var B1 = invBp + invBm, K1 = cp * invBp + cm * invBm;
            var Qc = gasVol[i] + dt * (1 - psi) * (qd[o0 + i] - qu[o0 + i]) - dt * psi * K1;
            var P = dt * psi * B1;
            var Hg = Hgas[i];
            var a = P, b = Qc - P * Hg, c = -Qc * Hg - C3[i];
            var disc = b * b - 4 * a * c; if (disc < 0) disc = 0;
            var H = (-b + sqrt(disc)) / (2 * a);
            head[o1 + i] = H;
            var vol = P * H + Qc; if (vol < 0) vol = 0; gasVol[i] = vol;
            qd[o1 + i] = (H - cm) * invBm;
            qu[o1 + i] = (cp - H) * invBp;
          }
        }
        if (lo === 0) { Cm[0] = head[o0 + 1] - B[0] * qu[o0 + 1]; Bm[0] = B[0] + (qsf ? qsfTerm(abs(qu[o0 + 1]), 0) : R[0] * abs(qu[o0 + 1])); }
        if (hi === N) { Cp[N - 1] = head[o0 + N - 2] + B[N - 2] * qd[o0 + N - 2]; Bp[N - 1] = B[N - 2] + (qsf ? qsfTerm(abs(qd[o0 + N - 2]), N - 2) : R[N - 2] * abs(qd[o0 + N - 2])); }
        if (Atomics.add(ctrl, DONE, 1) === W - 1) Atomics.notify(ctrl, DONE);
      }
    } else {
      var flow = new Float64Array(d.flowSab);
      for (;;) {
        Atomics.wait(ctrl, PHASE, phase);
        if (Atomics.load(ctrl, TERM)) break;
        // Stale-wakeup guard: dispatch's store(PHASE) and notify(PHASE) are not a
        // single atomic op, so a fast worker can clear its wait via the value
        // check, finish the step, re-block on the same phase, then be woken by the
        // already-issued notify. Re-running that phase would double-count DONE and
        // let the main thread proceed before every worker has written its range.
        var next = Atomics.load(ctrl, PHASE);
        if (next === phase) continue;
        phase = next;
        var o0 = Atomics.load(ctrl, T0) * N, o1 = Atomics.load(ctrl, T1) * N;
        for (var i = iLo; i < iHi; i++) {
          var up = o0 + i - 1, dn = o0 + i + 1;
          var fdn = qsf ? qsfTerm(abs(flow[dn]), i) : R[i] * abs(flow[dn]);
          var fup = qsf ? qsfTerm(abs(flow[up]), i) : R[i] * abs(flow[up]);
          var cm = (head[dn] - B[i] * flow[dn]) * hasMinus[i];
          var bm = (B[i] + fdn) * hasMinus[i];
          var cp = (head[up] + B[i] * flow[up]) * hasPlus[i];
          var bp = (B[i] + fup) * hasPlus[i];
          Cm[i] = cm; Bm[i] = bm; Cp[i] = cp; Bp[i] = bp;
          if (uf) {
            var kB = Ku[i], q = flow[o0 + i];
            var e = kB * (sgn(q) * abs(flow[dn] - flow[up]) * 0.5 - q);
            cp -= e; cm += e; bp += kB; bm += kB;
          }
          head[o1 + i] = (cp * bm + cm * bp) / (bp + bm);
          flow[o1 + i] = (cp - cm) / (bp + bm);
        }
        if (lo === 0) { Cm[0] = head[o0 + 1] - B[0] * flow[o0 + 1]; Bm[0] = B[0] + (qsf ? qsfTerm(abs(flow[o0 + 1]), 0) : R[0] * abs(flow[o0 + 1])); }
        if (hi === N) { Cp[N - 1] = head[o0 + N - 2] + B[N - 2] * flow[o0 + N - 2]; Bp[N - 1] = B[N - 2] + (qsf ? qsfTerm(abs(flow[o0 + N - 2]), N - 2) : R[N - 2] * abs(flow[o0 + N - 2])); }
        if (Atomics.add(ctrl, DONE, 1) === W - 1) Atomics.notify(ctrl, DONE);
      }
    }
  }
  if (typeof require === 'function') {
    try { require('worker_threads').parentPort.once('message', start); return; } catch (e) {}
  }
  self.onmessage = function (e) { self.onmessage = null; start(e.data); };
})();`;

/** Sites with a peak cavity below this fraction of their mesh cell are omitted from the report. */
const REPORT_THRESHOLD = 1e-4;

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

  private readonly flow: Float64Array; // length 2N (two columns); the qd face when cavitating
  private readonly head: Float64Array;
  private readonly Cp: Float64Array;
  private readonly Bp: Float64Array;
  private readonly Cm: Float64Array;
  private readonly Bm: Float64Array;
  private readonly ctrl: Int32Array;
  private readonly workers: WorkerHandle[] = [];
  /** When the pool size is 1, compute the interior stencil inline (no worker spawn / barrier). */
  private readonly inline: boolean;
  private phase = 0;
  private disposed = false;

  // Unsteady (Brunone) friction, present only when enabled.
  private readonly uf: boolean;
  private readonly Ku?: Float64Array; // per-point k·B factor

  // Quasi-steady friction, present only when enabled.
  private readonly qsf: boolean;
  private readonly Rgeo?: Float64Array; // per-point geometric resistance Δx/(2gDA²)
  private readonly Refac?: Float64Array; // per-point Reynolds factor D/(Aν)
  private readonly Rrough?: Float64Array; // per-point effective relative roughness ε/D

  // Column separation (DGCM) state, present only when cavitating.
  private readonly cav: boolean;
  private readonly qu?: Float64Array; // length 2N (upstream face)
  private readonly gasVol?: Float64Array;
  private readonly Hgas?: Float64Array;
  private readonly C3?: Float64Array;
  private readonly syncPoints?: Int32Array;
  // Per-jip-node gas state (junction-node cavities).
  private readonly gasVolJ?: Float64Array;
  private readonly HgasJ?: Float64Array;
  private readonly C3J?: Float64Array;
  private readonly prevNetJ?: Float64Array;
  private readonly prevHeadJ?: Float64Array;
  // Peak cavity volume per point/node + segment volume (A·Δx) for the validity check.
  private readonly maxGasVol?: Float64Array;
  private readonly maxGasVolJ?: Float64Array;
  private readonly segVol?: Float64Array;
  private readonly segVolJ?: Float64Array;
  private readonly psi: number;
  /** Largest gas-cavity volume [m³] seen during the run (cavitation only). */
  maxCavityVolume?: number;

  constructor(
    backend: WorkerBackend,
    numWorkers: number,
    private readonly ss: SteadyState,
    private readonly model: EngineModel,
    private readonly timeStep: number,
    timeSteps: number,
    recording: RecordingOptions = {},
    cavitation?: CavitationOptions,
    private readonly pumpTrip?: PumpTripState,
    unsteadyFriction?: UnsteadyFrictionOptions,
    quasiSteadyFriction?: QuasiSteadyFrictionOptions,
  ) {
    const n = model.numPoints;
    this.n = n;
    this.W = Math.max(1, Math.min(numWorkers, n));
    this.inline = this.W === 1;
    this.cav = cavitation !== undefined;
    this.psi = cavitation?.psi ?? 1;
    this.uf = unsteadyFriction !== undefined;
    this.qsf = quasiSteadyFriction !== undefined;

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

    let ku: { sab: SharedArrayBuffer; arr: Float64Array } | undefined;
    if (this.uf) {
      ku = f64(n);
      ku.arr.set(buildUnsteadyFrictionFactors(ss, model, unsteadyFriction!));
      this.Ku = ku.arr;
    }

    let rgeo: { sab: SharedArrayBuffer; arr: Float64Array } | undefined;
    let refac: { sab: SharedArrayBuffer; arr: Float64Array } | undefined;
    let rrough: { sab: SharedArrayBuffer; arr: Float64Array } | undefined;
    if (this.qsf) {
      rgeo = f64(n);
      refac = f64(n);
      rrough = f64(n);
      const qf = buildQuasiSteadyFrictionFactors(ss, model, quasiSteadyFriction!);
      rgeo.arr.set(qf.rgeo);
      refac.arr.set(qf.refac);
      rrough.arr.set(qf.rrough);
      this.Rgeo = rgeo.arr;
      this.Refac = refac.arr;
      this.Rrough = rrough.arr;
    }

    const shared: Record<string, unknown> = {
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
      cav: this.cav,
      uf: this.uf,
      kuSab: ku?.sab,
      qsf: this.qsf,
      rgeoSab: rgeo?.sab,
      refacSab: refac?.sab,
      rroughSab: rrough?.sab,
    };

    if (cavitation) {
      const qu = f64(2 * n);
      const gasVol = f64(n);
      const Hgas = f64(n);
      const C3 = f64(n);
      const isInt = i32(n);
      this.qu = qu.arr;
      this.gasVol = gasVol.arr;
      this.Hgas = Hgas.arr;
      this.C3 = C3.arr;
      this.maxCavityVolume = 0;
      this.segVol = new Float64Array(n);
      this.initGasState(qu.arr, gasVol.arr, Hgas.arr, C3.arr, isInt.arr, cavitation);
      const nj = model.numJip;
      this.gasVolJ = new Float64Array(nj);
      this.HgasJ = new Float64Array(nj);
      this.C3J = new Float64Array(nj);
      this.prevNetJ = new Float64Array(nj);
      this.prevHeadJ = new Float64Array(nj);
      this.segVolJ = new Float64Array(nj);
      this.initJunctionGasState(cavitation);
      this.maxGasVol = gasVol.arr.slice();
      this.maxGasVolJ = this.gasVolJ.slice();
      this.syncPoints = this.buildSyncPoints();
      Object.assign(shared, {
        quSab: qu.sab,
        gasVolSab: gasVol.sab,
        hgasSab: Hgas.sab,
        c3Sab: C3.sab,
        isIntSab: isInt.sab,
        dt: timeStep,
        psi: this.psi,
      });
    }

    this.recorder = new Recorder(model, ss, timeSteps, timeStep, recording);
    this.st = makeBoundaryState(model);
    this.recorder.record(0, this.head.subarray(0, n), this.flow.subarray(0, n), null, null);
    initClosedProtection(model, ss, this.st);

    if (!this.inline) {
      const chunk = Math.ceil(n / this.W);
      for (let w = 0; w < this.W; w++) {
        const lo = w * chunk;
        const hi = Math.min(n, lo + chunk);
        const handle = backend.spawn(WORKER_SOURCE);
        handle.postMessage({ ...shared, lo, hi });
        this.workers.push(handle);
      }
    }
  }

  /** Inline interior stencil (single-worker path): mirrors one full-range worker. */
  private computeInterior(t0: number, t1: number): void {
    const n = this.n;
    const m = this.model;
    const h0 = this.head.subarray(t0 * n, t0 * n + n);
    const h1 = this.head.subarray(t1 * n, t1 * n + n);
    if (this.cav) {
      const qd0 = this.flow.subarray(t0 * n, t0 * n + n);
      const qd1 = this.flow.subarray(t1 * n, t1 * n + n);
      const qu0 = this.qu!.subarray(t0 * n, t0 * n + n);
      const qu1 = this.qu!.subarray(t1 * n, t1 * n + n);
      runInteriorStepCav(
        qd0, qu0, h0, qd1, qu1, h1,
        m.B, m.R, this.Cp, this.Bp, this.Cm, this.Bm, m.hasPlus, m.hasMinus,
        this.gasVol!, this.Hgas!, this.C3!, this.timeStep, this.psi, this.Ku,
        this.Rgeo, this.Refac, this.Rrough,
      );
    } else {
      const q0 = this.flow.subarray(t0 * n, t0 * n + n);
      const q1 = this.flow.subarray(t1 * n, t1 * n + n);
      runInteriorStep(
        q0, h0, q1, h1, m.B, m.R, this.Cp, this.Bp, this.Cm, this.Bm, m.hasPlus, m.hasMinus,
        this.Ku, this.Rgeo, this.Refac, this.Rrough,
      );
    }
  }

  /** Initialize DGCM per-point state: H_gas, reference gas volume, gas-law constant. */
  private initGasState(
    qu: Float64Array,
    gasVol: Float64Array,
    Hgas: Float64Array,
    C3: Float64Array,
    isInt: Int32Array,
    opts: CavitationOptions,
  ): void {
    const { model, ss } = this;
    const alpha = opts.voidFraction ?? 1e-7;
    const Hb = opts.barometricHead ?? 10.33;
    const Hv = opts.vaporHead ?? 0.24;
    const vaporGauge = Hv - Hb;
    qu.set(model.initFlow, 0); // qu column 0 = steady flow
    for (let i = 0; i < this.n; i++) if (model.hasPlus[i] && model.hasMinus[i]) isInt[i] = 1;
    for (let p = 0; p < ss.pipe.n; p++) {
      const d = model.dboundary[p];
      const u = model.uboundary[p];
      const z1 = ss.node.elevation[ss.pipe.startNode[p]];
      const z2 = ss.node.elevation[ss.pipe.endNode[p]];
      const seg = u - d;
      const cell = ss.pipe.area[p] * ss.pipe.dx[p];
      const vol0 = alpha * cell;
      for (let j = d; j <= u; j++) {
        const z = z1 + ((z2 - z1) * (j - d)) / seg;
        Hgas[j] = z + vaporGauge;
        C3[j] = (model.initHead[j] - Hgas[j]) * vol0;
        gasVol[j] = vol0;
        this.segVol![j] = cell;
      }
    }
  }

  /** Initialize DGCM per-junction-node gas state (vapor-clamp head, reference volume, gas constant). */
  private initJunctionGasState(opts: CavitationOptions): void {
    const { model, ss } = this;
    const alpha = opts.voidFraction ?? 1e-7;
    const vaporGauge = (opts.vaporHead ?? 0.24) - (opts.barometricHead ?? 10.33);

    // Map each jip boundary point to its node, then sum a half-cell reference
    // volume from every connected pipe.
    const pointToJip = new Int32Array(this.n).fill(-1);
    for (let idx = 0; idx < model.jipPoints.length; idx++) {
      pointToJip[model.jipPoints[idx]] = model.jipNodeOfPoint[idx];
    }
    const vol0 = new Float64Array(model.numJip);
    this.segVolJ!.fill(Infinity);
    for (let p = 0; p < ss.pipe.n; p++) {
      const cell = ss.pipe.area[p] * ss.pipe.dx[p];
      const contrib = (alpha * cell) / 2;
      const cd = pointToJip[model.dboundary[p]];
      const cu = pointToJip[model.uboundary[p]];
      if (cd >= 0) {
        vol0[cd] += contrib;
        this.segVolJ![cd] = Math.min(this.segVolJ![cd], cell); // binding (smallest) adjacent cell
      }
      if (cu >= 0) {
        vol0[cu] += contrib;
        this.segVolJ![cu] = Math.min(this.segVolJ![cu], cell);
      }
    }

    for (let c = 0; c < model.numJip; c++) {
      const i = model.ajip[c];
      const steady = ss.node.head[i];
      this.HgasJ![c] = ss.node.elevation[i] + vaporGauge;
      this.C3J![c] = (steady - this.HgasJ![c]) * vol0[c];
      this.gasVolJ![c] = vol0[c];
      this.prevHeadJ![c] = steady;
      this.prevNetJ![c] = 0;
    }
  }

  /** Boundary points whose qu face must be mirrored from qd each step (all but interior + single valves). */
  private buildSyncPoints(): Int32Array {
    const { model } = this;
    const single = new Set<number>(Array.from(model.singleValvePoints));
    const pts: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const interior = model.hasPlus[i] && model.hasMinus[i];
      if (!interior && !single.has(i)) pts.push(i);
    }
    return Int32Array.from(pts);
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

  /**
   * Per-element peak cavity volumes and a validity flag. `valid` is false if any
   * site's cavity reached its mesh-cell volume (A·Δx) — the point past which the
   * discrete-cavity assumption breaks down (HAMMER leaves this to the user).
   */
  cavitationReport(): CavitationReport | undefined {
    if (!this.cav) return undefined;
    const { model, ss } = this;
    const maxV = this.maxGasVol!;
    const segV = this.segVol!;
    const maxVJ = this.maxGasVolJ!;
    const segVJ = this.segVolJ!;
    let worst = 0;

    const pipes: CavityElementReport[] = [];
    for (let p = 0; p < ss.pipe.n; p++) {
      const d = model.dboundary[p];
      const u = model.uboundary[p];
      let vol = 0;
      for (let j = d + 1; j < u; j++) if (maxV[j] > vol) vol = maxV[j];
      const ff = vol / (ss.pipe.area[p] * ss.pipe.dx[p]);
      if (ff > worst) worst = ff;
      if (ff > REPORT_THRESHOLD) pipes.push({ label: ss.pipe.labels[p], maxVolume: vol, fillFraction: ff });
    }

    const nodes: CavityElementReport[] = [];
    for (let c = 0; c < model.numJip; c++) {
      const ff = maxVJ[c] / segVJ[c];
      if (ff > worst) worst = ff;
      if (ff > REPORT_THRESHOLD)
        nodes.push({ label: ss.node.labels[model.ajip[c]], maxVolume: maxVJ[c], fillFraction: ff });
    }
    for (let k = 0; k < model.singleValvePoints.length; k++) {
      const pt = model.singleValvePoints[k];
      const ff = maxV[pt] / segV[pt];
      if (ff > worst) worst = ff;
      if (ff > REPORT_THRESHOLD)
        nodes.push({
          label: ss.node.labels[ss.valve.startNode[model.singleValveCtx[k]]],
          maxVolume: maxV[pt],
          fillFraction: ff,
        });
    }

    return { maxVolume: this.maxCavityVolume!, valid: worst < 1, worstFillFraction: worst, pipes, nodes };
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
    let cavState: CavState | undefined;
    if (this.cav) {
      cavState = {
        quCur: this.qu!.subarray(t1 * n, t1 * n + n),
        quPrev: this.qu!.subarray(t0 * n, t0 * n + n),
        qdPrev: this.flow.subarray(t0 * n, t0 * n + n),
        gasVol: this.gasVol!,
        Hgas: this.Hgas!,
        C3: this.C3!,
        syncPoints: this.syncPoints!,
        psi: this.psi,
        dt: this.timeStep,
        gasVolJ: this.gasVolJ!,
        HgasJ: this.HgasJ!,
        C3J: this.C3J!,
        prevNetJ: this.prevNetJ!,
        prevHeadJ: this.prevHeadJ!,
      };
    }
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
      cavState,
      this.pumpTrip,
    );
    if (this.cav) {
      const gasVol = this.gasVol!;
      const maxV = this.maxGasVol!;
      let max = this.maxCavityVolume!;
      for (let i = 0; i < n; i++) {
        if (gasVol[i] > maxV[i]) maxV[i] = gasVol[i];
        if (gasVol[i] > max) max = gasVol[i];
      }
      const gj = this.gasVolJ!;
      const maxVJ = this.maxGasVolJ!;
      for (let c = 0; c < gj.length; c++) {
        if (gj[c] > maxVJ[c]) maxVJ[c] = gj[c];
        if (gj[c] > max) max = gj[c];
      }
      this.maxCavityVolume = max;
    }
  }

  /** Synchronous step (blocks via Atomics.wait — Node, or any non-UI thread). */
  runStep(t: number): void {
    const t1 = t % 2;
    const t0 = 1 - t1;
    if (this.inline) {
      this.computeInterior(t0, t1);
    } else {
      this.dispatch(t0, t1);
      let v: number;
      while ((v = Atomics.load(this.ctrl, DONE)) < this.W) Atomics.wait(this.ctrl, DONE, v);
    }
    this.boundary(t, t0, t1);
  }

  /** Non-blocking step (Atomics.waitAsync — safe on the browser main thread). */
  async runStepAsync(t: number): Promise<void> {
    const t1 = t % 2;
    const t0 = 1 - t1;
    if (this.inline) {
      this.computeInterior(t0, t1);
    } else {
      this.dispatch(t0, t1);
      const A = Atomics as AtomicsWithAsync;
      for (;;) {
        const v = Atomics.load(this.ctrl, DONE);
        if (v >= this.W) break;
        const r = A.waitAsync(this.ctrl, DONE, v);
        if (r.async) await r.value;
      }
    }
    this.boundary(t, t0, t1);
  }

  /** Terminate the worker pool. Safe to call multiple times. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inline) return;
    Atomics.store(this.ctrl, TERM, 1);
    this.phase++;
    Atomics.store(this.ctrl, PHASE, this.phase);
    Atomics.notify(this.ctrl, PHASE);
    for (const w of this.workers) w.terminate();
  }
}
