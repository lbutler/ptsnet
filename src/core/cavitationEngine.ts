/**
 * Column separation via the Discrete Vapor Cavity Model (DVCM).
 *
 * The basic MOC lets head drop arbitrarily below the liquid vapor pressure,
 * which is unphysical. When the head at a computational point reaches the vapor
 * head `Hv = z + h_v` (elevation + gauge vapor-pressure head, ≈ −10 m), a vapor
 * cavity forms: the head is held at `Hv`, the upstream and downstream faces carry
 * different flows, and the cavity volume is integrated from their imbalance
 * (`dV/dt = Qd − Qu`). The cavity collapses when its volume returns to zero.
 *
 * Reference: Bergant, Simpson & Tijsseling, "Water hammer with column
 * separation: A historical review", J. Fluids & Structures 22 (2006) 135–171.
 *
 * This engine is serial and opt-in; it covers interior points and closed/end
 * valves (the reservoir–pipe–valve column-separation benchmark). Junction-node
 * and parallel cavitation are left as follow-ups.
 */
import { SteadyState } from './types';
import { EngineModel } from './serialModel';
import { SimulationResults, RecordingOptions, Envelope } from './results';
import { Recorder } from './recorder';
import {
  BoundaryState,
  makeBoundaryState,
  initClosedProtection,
} from './boundaryPhase';
import { runGeneralJunction, runValveStep, runPumpStep } from './kernels';

export interface CavitationOptions {
  /** Gauge vapor-pressure head [m] (≈ p_vapor/γ − barometric). Default −10.1. */
  vaporPressureHead?: number;
  /** Cavity-volume time weighting ψ ∈ [0.5, 1]. Default 1 (most stable). */
  psi?: number;
}

const DEFAULT_VAPOR_HEAD = -10.1;

export class CavitationEngine {
  private readonly recorder: Recorder;
  private readonly st: BoundaryState;
  private readonly n: number;
  private readonly vaporHead: number;
  private readonly psi: number;

  private readonly head: [Float64Array, Float64Array];
  private readonly qu: [Float64Array, Float64Array]; // upstream-face flow
  private readonly qd: [Float64Array, Float64Array]; // downstream-face flow
  private readonly Cp: Float64Array;
  private readonly Bp: Float64Array;
  private readonly Cm: Float64Array;
  private readonly Bm: Float64Array;
  private readonly Hv: Float64Array; // vapor head per point
  private readonly cavVol: Float64Array; // current cavity volume per point (persists)
  private readonly recFlow: Float64Array; // pipe-side flow for recording
  private readonly isInterior: Uint8Array;
  private readonly isValvePoint: Uint8Array;
  /** Max cavity volume seen at any point (diagnostic). */
  maxCavityVolume = 0;

  constructor(
    private readonly ss: SteadyState,
    private readonly model: EngineModel,
    private readonly timeStep: number,
    timeSteps: number,
    recording: RecordingOptions = {},
    options: CavitationOptions = {},
  ) {
    const n = model.numPoints;
    this.n = n;
    this.vaporHead = options.vaporPressureHead ?? DEFAULT_VAPOR_HEAD;
    this.psi = options.psi ?? 1;

    this.head = [new Float64Array(n), new Float64Array(n)];
    this.qu = [new Float64Array(n), new Float64Array(n)];
    this.qd = [new Float64Array(n), new Float64Array(n)];
    this.Cp = new Float64Array(n);
    this.Bp = new Float64Array(n);
    this.Cm = new Float64Array(n);
    this.Bm = new Float64Array(n);
    this.Hv = new Float64Array(n);
    this.cavVol = new Float64Array(n);
    this.recFlow = new Float64Array(n);
    this.isInterior = new Uint8Array(n);
    this.isValvePoint = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      if (model.hasPlus[i] && model.hasMinus[i]) this.isInterior[i] = 1;
    }
    for (let i = 0; i < model.singleValvePoints.length; i++) this.isValvePoint[model.singleValvePoints[i]] = 1;
    for (let i = 0; i < model.startValvePoints.length; i++) this.isValvePoint[model.startValvePoints[i]] = 1;
    for (let i = 0; i < model.endValvePoints.length; i++) this.isValvePoint[model.endValvePoints[i]] = 1;

    this.computeVaporHeads();

    this.head[0].set(model.initHead);
    this.qu[0].set(model.initFlow);
    this.qd[0].set(model.initFlow);

    this.recorder = new Recorder(model, ss, timeSteps, timeStep, recording);
    this.st = makeBoundaryState(model);
    this.recorder.record(0, this.head[0], this.qd[0], null, null);
    initClosedProtection(model, ss, this.st);
  }

  /** Linear-interpolate node elevations along each pipe to get a vapor head per point. */
  private computeVaporHeads(): void {
    const { model, ss } = this;
    for (let p = 0; p < ss.pipe.n; p++) {
      const d = model.dboundary[p];
      const u = model.uboundary[p];
      const z1 = ss.node.elevation[ss.pipe.startNode[p]];
      const z2 = ss.node.elevation[ss.pipe.endNode[p]];
      const seg = u - d;
      for (let j = d; j <= u; j++) {
        const z = z1 + ((z2 - z1) * (j - d)) / seg;
        this.Hv[j] = z + this.vaporHead;
      }
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

  runStep(t: number): void {
    const { model } = this;
    const n = this.n;
    const t1 = t % 2;
    const t0 = 1 - t1;
    const H0 = this.head[t0];
    const H1 = this.head[t1];
    const Qu0 = this.qu[t0];
    const Qd0 = this.qd[t0];
    const Qu1 = this.qu[t1];
    const Qd1 = this.qd[t1];
    const { B, R, hasPlus, hasMinus } = model;
    const Cp = this.Cp;
    const Bp = this.Bp;
    const Cm = this.Cm;
    const Bm = this.Bm;
    const dt = this.timeStep;
    const psi = this.psi;

    // --- Interior step with two-flow characteristics + vapor cavities ---
    Cm[0] = H0[1] - B[0] * Qu0[1];
    Cp[n - 1] = H0[n - 2] + B[n - 2] * Qd0[n - 2];
    Bm[0] = B[0] + R[0] * Math.abs(Qu0[1]);
    Bp[n - 1] = B[n - 2] + R[n - 2] * Math.abs(Qd0[n - 2]);

    for (let i = 1; i < n - 1; i++) {
      // C+ uses the downstream-face flow of the upstream neighbour; C- the
      // upstream-face flow of the downstream neighbour.
      Cm[i] = (H0[i + 1] - B[i] * Qu0[i + 1]) * hasMinus[i];
      Bm[i] = (B[i] + R[i] * Math.abs(Qu0[i + 1])) * hasMinus[i];
      Cp[i] = (H0[i - 1] + B[i] * Qd0[i - 1]) * hasPlus[i];
      Bp[i] = (B[i] + R[i] * Math.abs(Qd0[i - 1])) * hasPlus[i];

      if (!this.isInterior[i]) continue; // boundaries handled by the kernels below

      const bpbm = Bp[i] + Bm[i];
      const Hn = (Cp[i] * Bm[i] + Cm[i] * Bp[i]) / bpbm;
      if (this.cavVol[i] <= 0 && Hn >= this.Hv[i]) {
        H1[i] = Hn;
        const Qn = (Cp[i] - Cm[i]) / bpbm;
        Qu1[i] = Qn;
        Qd1[i] = Qn;
      } else {
        const Hv = this.Hv[i];
        const qu = (Cp[i] - Hv) / Bp[i];
        const qd = (Hv - Cm[i]) / Bm[i];
        let V =
          this.cavVol[i] + dt * (psi * (qd - qu) + (1 - psi) * (Qd0[i] - Qu0[i]));
        if (V <= 0) {
          // Cavity collapses -> revert to the continuous solution.
          V = 0;
          H1[i] = Hn;
          const Qn = (Cp[i] - Cm[i]) / bpbm;
          Qu1[i] = Qn;
          Qd1[i] = Qn;
        } else {
          H1[i] = Hv;
          Qu1[i] = qu;
          Qd1[i] = qd;
        }
        this.cavVol[i] = V;
        if (V > this.maxCavityVolume) this.maxCavityVolume = V;
      }
    }

    // --- Boundary kernels operate on the downstream-face flow as "Q1". ---
    if (model.numResultNodes > 0) {
      runGeneralJunction(
        H0,
        Qd1,
        H1,
        this.st.E1,
        this.st.D1,
        Cp,
        Bp,
        Cm,
        Bm,
        this.ss.node.leakCoefficient,
        this.ss.node.demandCoefficient,
        this.ss.node.elevation,
        model,
        this.st.jSc,
        this.st.jSb,
        this.st.jHH,
      );
    }
    runValveStep(Qd1, H1, Cp, Bp, Cm, Bm, this.ss.valve.setting, this.ss.valve.K, this.ss.valve.area, model);
    runPumpStep(
      this.ss.pump.sourceHead,
      Qd1,
      H1,
      Cp,
      Bp,
      Cm,
      Bm,
      this.ss.pump.a1,
      this.ss.pump.a2,
      this.ss.pump.Hs,
      this.ss.pump.setting,
      model,
    );

    // --- Vapor cavity at single/end valves (closed or near-closed). ---
    this.applyValveCavities(Qu1, Qd1, H1, Qu0, Qd0, dt, psi);

    // Boundary points carry equal faces unless a valve cavity set them above.
    this.syncBoundaryFaces(Qu1, Qd1);

    // Record using the pipe-side flow (qd at starts, qu at ends).
    this.recFlow.set(Qd1);
    for (let p = 0; p < model.uboundary.length; p++) this.recFlow[model.uboundary[p]] = Qu1[model.uboundary[p]];
    this.recorder.record(t, H1, this.recFlow, this.st.E1, this.st.D1);
  }

  private applyValveCavities(
    Qu1: Float64Array,
    Qd1: Float64Array,
    H1: Float64Array,
    Qu0: Float64Array,
    Qd0: Float64Array,
    dt: number,
    psi: number,
  ): void {
    const sv = this.model.singleValvePoints;
    for (let i = 0; i < sv.length; i++) {
      const pt = sv[i];
      const Hv = this.Hv[pt];
      if (this.cavVol[pt] <= 0 && H1[pt] >= Hv) continue;
      const qu = (this.Cp[pt] - Hv) / this.Bp[pt]; // pipe-side inflow
      const qd = 0; // discharge through a closed / near-closed valve ≈ 0
      let V = this.cavVol[pt] + dt * (psi * (qd - qu) + (1 - psi) * (Qd0[pt] - Qu0[pt]));
      if (V <= 0) {
        V = 0; // collapse: keep the valve-kernel solution
      } else {
        H1[pt] = Hv;
        Qu1[pt] = qu;
        Qd1[pt] = qd;
      }
      this.cavVol[pt] = V;
      if (V > this.maxCavityVolume) this.maxCavityVolume = V;
    }
  }

  private syncBoundaryFaces(Qu1: Float64Array, Qd1: Float64Array): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.isInterior[i] && !this.isValvePoint[i]) {
        Qu1[i] = Qd1[i];
      }
    }
  }
}
