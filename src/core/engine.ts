/**
 * Serial Method-of-Characteristics engine.
 *
 * Replaces `parallel/worker.py` for the single-process case: one engine owns all
 * discretization points, advancing the transient solution one time step at a
 * time. The boundary phase is shared with the parallel engine; only the interior
 * stencil differs.
 */
import { SteadyState } from './types';
import { EngineModel } from './serialModel';
import { SimulationResults, RecordingOptions, Envelope } from './results';
import { Recorder } from './recorder';
import { runInteriorStep } from './kernels';
import {
  BoundaryState,
  makeBoundaryState,
  initClosedProtection,
  runBoundaryPhase,
} from './boundaryPhase';

export class SerialEngine {
  private readonly recorder: Recorder;
  private readonly flow: [Float64Array, Float64Array];
  private readonly head: [Float64Array, Float64Array];
  private readonly Cp: Float64Array;
  private readonly Bp: Float64Array;
  private readonly Cm: Float64Array;
  private readonly Bm: Float64Array;
  private readonly st: BoundaryState;

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
    this.st = makeBoundaryState(model);

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
    const { model } = this;
    this.flow[0].set(model.initFlow);
    this.head[0].set(model.initHead);
    // t = 0: leak/demand come from the steady-state coefficients (e1/d1 = null).
    this.recorder.record(0, this.head[0], this.flow[0], null, null);
    initClosedProtection(model, this.ss, this.st);
  }

  /** Advance the solution to time-step index `t` (1-based). */
  runStep(t: number): void {
    const { model } = this;
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

    runBoundaryPhase(
      this.ss,
      model,
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
}
