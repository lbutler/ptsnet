/**
 * Serial Method-of-Characteristics engine.
 *
 * Replaces `parallel/worker.py` for the single-process case: one engine owns all
 * discretization points, advancing the transient solution one time step at a
 * time. The kernels operate on plain typed arrays, so the same shape can later
 * back a Web Worker / worker_threads implementation.
 */
import { SteadyState } from './types';
import { EngineModel } from './serialModel';
import { SimulationResults, RecordingOptions, Envelope } from './results';
import { Recorder } from './recorder';
import {
  runInteriorStep,
  runGeneralJunction,
  runValveStep,
  runPumpStep,
  runOpenProtections,
  runClosedProtections,
} from './kernels';

const HB = 10.3;
const GAS_EXP = 1.2;

export class SerialEngine {
  private readonly recorder: Recorder;
  private readonly flow: [Float64Array, Float64Array];
  private readonly head: [Float64Array, Float64Array];
  private readonly Cp: Float64Array;
  private readonly Bp: Float64Array;
  private readonly Cm: Float64Array;
  private readonly Bm: Float64Array;
  private readonly E1: Float64Array;
  private readonly D1: Float64Array;
  private readonly jSc: Float64Array;
  private readonly jSb: Float64Array;
  private readonly jHH: Float64Array;

  private readonly openQT: Float64Array;
  private readonly closedQT0: Float64Array;
  private readonly closedHT0: Float64Array;
  private readonly closedVA: Float64Array;
  private readonly closedC: Float64Array;

  constructor(
    private readonly ss: SteadyState,
    private readonly model: EngineModel,
    private readonly timeStep: number,
    timeSteps: number,
    recording: RecordingOptions = {},
  ) {
    const n = model.numPoints;
    this.flow = [new Float64Array(n), new Float64Array(n)];
    this.head = [new Float64Array(n), new Float64Array(n)];
    this.Cp = new Float64Array(n);
    this.Bp = new Float64Array(n);
    this.Cm = new Float64Array(n);
    this.Bm = new Float64Array(n);
    this.E1 = new Float64Array(model.numJip);
    this.D1 = new Float64Array(model.numJip);
    this.jSc = new Float64Array(model.numJip);
    this.jSb = new Float64Array(model.numJip);
    this.jHH = new Float64Array(model.numJip);

    this.openQT = new Float64Array(model.openStart.length);
    this.closedQT0 = new Float64Array(model.closedStart.length);
    this.closedHT0 = new Float64Array(model.closedStart.length);
    this.closedVA = new Float64Array(model.closedStart.length);
    this.closedC = new Float64Array(model.closedStart.length);

    this.recorder = new Recorder(model, ss, timeSteps, timeStep, recording);

    this.loadInitialConditions();
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

  private loadInitialConditions(): void {
    const { model, ss } = this;
    this.flow[0].set(model.initFlow);
    this.head[0].set(model.initHead);

    // t = 0: leak/demand come from the steady-state coefficients (e1/d1 = null).
    this.recorder.record(0, this.head[0], this.flow[0], null, null);

    const node = ss.node;
    // Closed surge-protection initial state.
    for (let i = 0; i < model.closedStart.length; i++) {
      const wl = model.closedWaterLevel[i];
      this.closedHT0[i] = wl;
      const HA = node.head[model.closedNode[i]] - wl + HB;
      this.closedVA[i] = model.closedArea[i] * (model.closedHeight[i] - wl);
      this.closedC[i] = HA * this.closedVA[i] ** GAS_EXP;
    }
  }

  /** Advance the solution to time-step index `t` (1-based). */
  runStep(t: number): void {
    const { model, ss } = this;
    const t1 = t % 2;
    const t0 = 1 - t1;
    const Q0 = this.flow[t0];
    const H0 = this.head[t0];
    const Q1 = this.flow[t1];
    const H1 = this.head[t1];

    runInteriorStep(
      Q0,
      H0,
      Q1,
      H1,
      model.B,
      model.R,
      this.Cp,
      this.Bp,
      this.Cm,
      this.Bm,
      model.hasPlus,
      model.hasMinus,
    );

    if (model.numResultNodes > 0) {
      runGeneralJunction(
        H0,
        Q1,
        H1,
        this.E1,
        this.D1,
        this.Cp,
        this.Bp,
        this.Cm,
        this.Bm,
        ss.node.leakCoefficient,
        ss.node.demandCoefficient,
        ss.node.elevation,
        model,
        this.jSc,
        this.jSb,
        this.jHH,
      );
    }

    runValveStep(
      Q1,
      H1,
      this.Cp,
      this.Bp,
      this.Cm,
      this.Bm,
      ss.valve.setting,
      ss.valve.K,
      ss.valve.area,
      model,
    );

    runPumpStep(
      ss.pump.sourceHead,
      Q1,
      H1,
      this.Cp,
      this.Bp,
      this.Cm,
      this.Bm,
      ss.pump.a1,
      ss.pump.a2,
      ss.pump.Hs,
      ss.pump.setting,
      model,
    );

    if (model.openStart.length > 0) {
      runOpenProtections(H0, H1, Q1, this.Cp, this.Bp, this.Cm, this.Bm, this.openQT, model, this.timeStep);
    }
    if (model.closedStart.length > 0) {
      runClosedProtections(
        H1,
        Q1,
        this.Cp,
        this.Bp,
        this.Cm,
        this.Bm,
        this.closedQT0,
        this.closedHT0,
        this.closedVA,
        this.closedC,
        model,
        this.timeStep,
      );
    }

    // Store results (subset / downsampling / envelope handled by the recorder).
    this.recorder.record(t, H1, Q1, this.E1, this.D1);
  }
}
