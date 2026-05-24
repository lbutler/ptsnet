/**
 * Column separation via the Discrete Gas Cavity Model (DGCM).
 *
 * A tiny amount of free gas (void fraction α₀ ≈ 1e-7) is concentrated at each
 * computational point. Its volume follows the isothermal ideal-gas law
 *   (p − p_v)·∀ = (p₀ − p_v)·∀₀ = C   →   ∀ = C / (H − H_gas),
 * where `H_gas = z − H_b + H_v` so that `H − H_gas` is the absolute pressure head
 * above vapor. Combining this with the cavity continuity equation
 *   ∀ = ∀_prev + Δt·[ψ(Q_d − Q_u) + (1−ψ)(Q_d − Q_u)_prev]
 * and the two characteristics gives a quadratic for the head at each point,
 * solved every step. Because the gas volume varies smoothly with pressure (no
 * on/off switching like the DVCM), it damps the 2Δt grid oscillation and clamps
 * head near the vapor pressure without spurious spikes.
 *
 * Reference: Bergant, Simpson & Tijsseling, "Water hammer with column
 * separation: A historical review", J. Fluids & Structures 22 (2006) 135–171
 * (DGCM, Eqs. 14–15); Wylie (1984); Liou (1999, 2000).
 *
 * Serial, opt-in. Covers interior points and single/end valves (the
 * reservoir–pipe–valve column-separation benchmark). Junction-node gas cavities
 * and parallel execution are follow-ups.
 */
import { SteadyState, G } from './types';
import { EngineModel } from './serialModel';
import { SimulationResults, RecordingOptions, Envelope } from './results';
import { Recorder } from './recorder';
import { BoundaryState, makeBoundaryState, initClosedProtection } from './boundaryPhase';
import { runGeneralJunction, runValveStep, runPumpStep } from './kernels';

export interface CavitationOptions {
  /** Initial free-gas void fraction α₀ at each point. Default 1e-7. */
  voidFraction?: number;
  /** Barometric (atmospheric) pressure head H_b [m]. Default 10.33. */
  barometricHead?: number;
  /** Absolute vapor-pressure head H_v [m] (water ≈ 0.24 at 20 °C). Default 0.24. */
  vaporHead?: number;
  /** Cavity-volume time weighting ψ ∈ [0.5, 1]. Default 1. */
  psi?: number;
}

export class CavitationEngine {
  private readonly recorder: Recorder;
  private readonly st: BoundaryState;
  private readonly n: number;
  private readonly psi: number;

  private readonly head: [Float64Array, Float64Array];
  private readonly qu: [Float64Array, Float64Array];
  private readonly qd: [Float64Array, Float64Array];
  private readonly Cp: Float64Array;
  private readonly Bp: Float64Array;
  private readonly Cm: Float64Array;
  private readonly Bm: Float64Array;
  private readonly Hgas: Float64Array; // head at which absolute-above-vapor pressure is zero
  private readonly C3: Float64Array; // gas-law constant per point
  private readonly gasVol: Float64Array; // current gas/cavity volume (persists)
  private readonly recFlow: Float64Array;
  private readonly isInterior: Uint8Array;
  private readonly isSingleValve: Uint8Array;
  private readonly vaporHeadGauge: number;
  /** Largest gas-cavity volume [m³] seen during the run (diagnostic). */
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
    this.psi = options.psi ?? 1;
    const alpha = options.voidFraction ?? 1e-7;
    const Hb = options.barometricHead ?? 10.33;
    const Hv = options.vaporHead ?? 0.24;
    this.vaporHeadGauge = Hv - Hb; // gauge vapor head, ≈ −10.1 m

    this.head = [new Float64Array(n), new Float64Array(n)];
    this.qu = [new Float64Array(n), new Float64Array(n)];
    this.qd = [new Float64Array(n), new Float64Array(n)];
    this.Cp = new Float64Array(n);
    this.Bp = new Float64Array(n);
    this.Cm = new Float64Array(n);
    this.Bm = new Float64Array(n);
    this.Hgas = new Float64Array(n);
    this.C3 = new Float64Array(n);
    this.gasVol = new Float64Array(n);
    this.recFlow = new Float64Array(n);
    this.isInterior = new Uint8Array(n);
    this.isSingleValve = new Uint8Array(n);

    for (let i = 0; i < n; i++) if (model.hasPlus[i] && model.hasMinus[i]) this.isInterior[i] = 1;
    for (let i = 0; i < model.singleValvePoints.length; i++) this.isSingleValve[model.singleValvePoints[i]] = 1;

    // Gas state per point: H_gas, reference gas volume α₀·A·dx, and C = Ψ₀·∀₀.
    for (let p = 0; p < ss.pipe.n; p++) {
      const d = model.dboundary[p];
      const u = model.uboundary[p];
      const z1 = ss.node.elevation[ss.pipe.startNode[p]];
      const z2 = ss.node.elevation[ss.pipe.endNode[p]];
      const seg = u - d;
      const vol0 = alpha * ss.pipe.area[p] * ss.pipe.dx[p];
      for (let j = d; j <= u; j++) {
        const z = z1 + ((z2 - z1) * (j - d)) / seg;
        this.Hgas[j] = z + this.vaporHeadGauge;
        const psi0 = model.initHead[j] - this.Hgas[j]; // steady absolute-above-vapor head
        this.C3[j] = psi0 * vol0;
        this.gasVol[j] = vol0;
      }
    }

    this.head[0].set(model.initHead);
    this.qu[0].set(model.initFlow);
    this.qd[0].set(model.initFlow);

    this.recorder = new Recorder(model, ss, timeSteps, timeStep, recording);
    this.st = makeBoundaryState(model);
    this.recorder.record(0, this.head[0], this.qd[0], null, null);
    initClosedProtection(model, ss, this.st);
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

  /** Larger root of a·H² + b·H + c = 0 (the physical, higher-pressure solution). */
  private solveHead(a: number, b: number, c: number, fallback: number): number {
    let disc = b * b - 4 * a * c;
    if (disc < 0) disc = 0;
    return (-b + Math.sqrt(disc)) / (2 * a) || fallback;
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

    Cm[0] = H0[1] - B[0] * Qu0[1];
    Cp[n - 1] = H0[n - 2] + B[n - 2] * Qd0[n - 2];
    Bm[0] = B[0] + R[0] * Math.abs(Qu0[1]);
    Bp[n - 1] = B[n - 2] + R[n - 2] * Math.abs(Qd0[n - 2]);

    for (let i = 1; i < n - 1; i++) {
      Cm[i] = (H0[i + 1] - B[i] * Qu0[i + 1]) * hasMinus[i];
      Bm[i] = (B[i] + R[i] * Math.abs(Qu0[i + 1])) * hasMinus[i];
      Cp[i] = (H0[i - 1] + B[i] * Qd0[i - 1]) * hasPlus[i];
      Bp[i] = (B[i] + R[i] * Math.abs(Qd0[i - 1])) * hasPlus[i];

      if (!this.isInterior[i]) continue;

      // DGCM quadratic at an interior point (both characteristics).
      const invBp = 1 / Bp[i];
      const invBm = 1 / Bm[i];
      const B1 = invBp + invBm; // d(Qd-Qu)/dH
      const K1 = Cp[i] * invBp + Cm[i] * invBm; // (Qd-Qu) = H*B1 - K1
      const prevDQ = Qd0[i] - Qu0[i];
      const Qc = this.gasVol[i] + dt * (1 - psi) * prevDQ - dt * psi * K1;
      const P = dt * psi * B1;
      const Hgas = this.Hgas[i];
      // (P*H + Qc)(H - Hgas) = C3
      const H = this.solveHead(P, Qc - P * Hgas, -Qc * Hgas - this.C3[i], H0[i]);
      H1[i] = H;
      let vol = P * H + Qc;
      if (vol < 0) vol = 0;
      this.gasVol[i] = vol;
      if (vol > this.maxCavityVolume) this.maxCavityVolume = vol;
      Qu1[i] = (Cp[i] - H) * invBp;
      Qd1[i] = (H - Cm[i]) * invBm;
    }

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

    this.applyValveGasCavities(H0, H1, Qu1, Qd1, Qu0, Qd0, dt, psi);
    this.syncBoundaryFaces(Qu1, Qd1);

    this.recFlow.set(Qd1);
    for (let p = 0; p < model.uboundary.length; p++) this.recFlow[model.uboundary[p]] = Qu1[model.uboundary[p]];
    this.recorder.record(t, H1, this.recFlow, this.st.E1, this.st.D1);
  }

  /** Gas cavity at single/end valves: valve discharge is taken explicitly (Qd). */
  private applyValveGasCavities(
    H0: Float64Array,
    H1: Float64Array,
    Qu1: Float64Array,
    Qd1: Float64Array,
    Qu0: Float64Array,
    Qd0: Float64Array,
    dt: number,
    psi: number,
  ): void {
    const m = this.model;
    const ss = this.ss;
    for (let k = 0; k < m.singleValvePoints.length; k++) {
      const pt = m.singleValvePoints[k];
      const v = m.singleValveCtx[k];
      // Explicit valve discharge from the previous head (0 when closed).
      const K0 = ss.valve.setting[v] * ss.valve.K[v] * ss.valve.area[v];
      const Qd = H0[pt] > 0 ? K0 * Math.sqrt(2 * G * H0[pt]) : 0;
      const invBp = 1 / this.Bp[pt];
      const prevDQ = Qd0[pt] - Qu0[pt];
      // Qu = (Cp - H)/Bp ; (Qd - Qu) = Qd - Cp/Bp + H/Bp
      const Qc =
        this.gasVol[pt] + dt * (1 - psi) * prevDQ + dt * psi * (Qd - this.Cp[pt] * invBp);
      const P = dt * psi * invBp;
      const Hgas = this.Hgas[pt];
      const H = this.solveHead(P, Qc - P * Hgas, -Qc * Hgas - this.C3[pt], H0[pt]);
      H1[pt] = H;
      let vol = P * H + Qc;
      if (vol < 0) vol = 0;
      this.gasVol[pt] = vol;
      if (vol > this.maxCavityVolume) this.maxCavityVolume = vol;
      Qu1[pt] = (this.Cp[pt] - H) * invBp;
      Qd1[pt] = Qd;
    }
  }

  private syncBoundaryFaces(Qu1: Float64Array, Qd1: Float64Array): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.isInterior[i] && !this.isSingleValve[i]) Qu1[i] = Qd1[i];
    }
  }
}
