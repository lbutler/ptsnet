/**
 * The per-step "boundary phase": everything after the interior MOC stencil
 * (general junctions, valves, pumps, surge protections) plus result recording.
 *
 * Shared by the serial and parallel engines so they stay byte-identical: the
 * only thing parallelism changes is how the interior stencil is computed.
 */
import { SteadyState, G } from './types';
import { EngineModel } from './serialModel';
import { Recorder } from './recorder';
import {
  runGeneralJunction,
  runCheckValves,
  runValveStep,
  runPumpStep,
  runPumpTrip,
  runOpenProtections,
  runOpenTanksEnhanced,
  runClosedProtections,
  runOneWayTanks,
  runAirValves,
  runSrv,
} from './kernels';

const HB = 10.3;
const GAS_EXP = 1.2;

/** Column separation (DGCM) tuning. See {@link runBoundaryPhase} / the README. */
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

/**
 * Per-step column-separation state handed to the boundary phase. Flows carry two
 * faces (qu/qd); `Q1` is the downstream face (qd). The interior gas quadratic is
 * solved by the workers; here we add the valve gas cavities and mirror the qu
 * face onto the boundary points the workers don't own.
 */
export interface CavState {
  quCur: Float64Array; // current-step upstream face
  quPrev: Float64Array; // previous-step upstream face
  qdPrev: Float64Array; // previous-step downstream face
  gasVol: Float64Array; // persistent gas/cavity volume per point
  Hgas: Float64Array; // head at which absolute-above-vapor pressure is zero
  C3: Float64Array; // gas-law constant per point
  syncPoints: Int32Array; // boundary points whose qu must mirror qd
  psi: number;
  dt: number;
  // Per-jip-node gas state (junction-node cavities).
  gasVolJ: Float64Array; // persistent gas/cavity volume per junction node
  HgasJ: Float64Array; // vapor-clamp head per junction node
  C3J: Float64Array; // gas-law constant per junction node
  prevNetJ: Float64Array; // previous net outflow per junction node (for the 1-ψ term)
  prevHeadJ: Float64Array; // previous head per junction node (explicit leak/demand)
}

/** Gas cavity at single/end valves (valve discharge taken explicitly from the previous head). */
function applyValveGasCavities(
  ss: SteadyState,
  model: EngineModel,
  dt: number,
  cav: CavState,
  H0: Float64Array,
  Q1: Float64Array,
  H1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
): void {
  const psi = cav.psi;
  for (let k = 0; k < model.singleValvePoints.length; k++) {
    const pt = model.singleValvePoints[k];
    const v = model.singleValveCtx[k];
    const K0 = ss.valve.setting[v] * ss.valve.K[v] * ss.valve.area[v];
    const Qd = H0[pt] > 0 ? K0 * Math.sqrt(2 * G * H0[pt]) : 0;
    const invBp = 1 / Bp[pt];
    const Qc =
      cav.gasVol[pt] +
      dt * (1 - psi) * (cav.qdPrev[pt] - cav.quPrev[pt]) +
      dt * psi * (Qd - Cp[pt] * invBp);
    const P = dt * psi * invBp;
    const Hg = cav.Hgas[pt];
    let disc = (Qc - P * Hg) ** 2 - 4 * P * (-Qc * Hg - cav.C3[pt]);
    if (disc < 0) disc = 0;
    const H = (-(Qc - P * Hg) + Math.sqrt(disc)) / (2 * P) || H0[pt];
    H1[pt] = H;
    let vol = P * H + Qc;
    if (vol < 0) vol = 0;
    cav.gasVol[pt] = vol;
    cav.quCur[pt] = (Cp[pt] - H) * invBp;
    Q1[pt] = Qd;
  }
}

/**
 * Per-pump trip configuration (constants built once at engine init). `tripStep`
 * is the step at which power fails (−1 = no trip); `K = ρg/(η I ω_R²)` sizes the
 * speed-decay ODE. Both are indexed by pump index and length `pump.n`. The speed
 * ratio itself lives in `ss.pump.setting`, written each step by {@link runPumpTrip}.
 */
export interface PumpTripState {
  tripStep: Int32Array;
  K: Float64Array;
}

/** Main-thread scratch + persistent state for the boundary kernels. */
export interface BoundaryState {
  E1: Float64Array;
  D1: Float64Array;
  jSc: Float64Array;
  jSb: Float64Array;
  jHH: Float64Array;
  openQT: Float64Array;
  oeZ: Float64Array; // enhanced open-tank water level [m]
  oeQT: Float64Array; // enhanced open-tank inflow (previous step) [m³/s]
  closedQT0: Float64Array;
  closedHT0: Float64Array;
  closedVA: Float64Array;
  closedC: Float64Array;
  owtZ: Float64Array; // one-way surge-tank water level [m]
  owtQT: Float64Array; // one-way surge-tank inflow (previous step) [m³/s]
  airVol: Float64Array; // air-valve pocket volume [m³] (0 = shut)
  airMass: Float64Array; // air-valve pocket air mass [kg]
  srvTau: Float64Array; // surge-relief-valve opening fraction [0,1] (0 = shut)
}

export function makeBoundaryState(model: EngineModel): BoundaryState {
  const owtZ = new Float64Array(model.owtStart.length);
  owtZ.set(model.owtInitLevel); // seed each tank at its initial water level
  const oeZ = new Float64Array(model.oeStart.length);
  oeZ.set(model.oeInitLevel); // seed each enhanced open tank at its initial level
  return {
    E1: new Float64Array(model.numJip),
    D1: new Float64Array(model.numJip),
    jSc: new Float64Array(model.numJip),
    jSb: new Float64Array(model.numJip),
    jHH: new Float64Array(model.numJip),
    openQT: new Float64Array(model.openStart.length),
    oeZ,
    oeQT: new Float64Array(model.oeStart.length),
    closedQT0: new Float64Array(model.closedStart.length),
    closedHT0: new Float64Array(model.closedStart.length),
    closedVA: new Float64Array(model.closedStart.length),
    closedC: new Float64Array(model.closedStart.length),
    owtZ,
    owtQT: new Float64Array(model.owtStart.length),
    airVol: new Float64Array(model.airStart.length),
    airMass: new Float64Array(model.airStart.length),
    srvTau: new Float64Array(model.srvStart.length),
  };
}

/** Initialize closed surge-protection state from the steady-state conditions. */
export function initClosedProtection(model: EngineModel, ss: SteadyState, st: BoundaryState): void {
  for (let i = 0; i < model.closedStart.length; i++) {
    const wl = model.closedWaterLevel[i];
    st.closedHT0[i] = wl;
    const HA = ss.node.head[model.closedNode[i]] - wl + HB;
    st.closedVA[i] = model.closedArea[i] * (model.closedHeight[i] - wl);
    st.closedC[i] = HA * st.closedVA[i] ** GAS_EXP;
  }
}

/**
 * Run the boundary kernels for step `t` on the current-step column views and
 * record the results. `H0` is the previous-step head column (reservoirs/tanks).
 */
export function runBoundaryPhase(
  ss: SteadyState,
  model: EngineModel,
  timeStep: number,
  st: BoundaryState,
  recorder: Recorder,
  t: number,
  H0: Float64Array,
  Q1: Float64Array,
  H1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  cav?: CavState,
  pumpTrip?: PumpTripState,
): void {
  if (model.numResultNodes > 0) {
    runGeneralJunction(
      H0,
      Q1,
      H1,
      st.E1,
      st.D1,
      Cp,
      Bp,
      Cm,
      Bm,
      ss.node.leakCoefficient,
      ss.node.demandCoefficient,
      ss.node.elevation,
      model,
      st.jSc,
      st.jSb,
      st.jHH,
      cav,
    );
  }
  if (model.checkStart.length > 0) runCheckValves(Q1, H1, Cp, Bp, Cm, Bm, model);

  runValveStep(Q1, H1, Cp, Bp, Cm, Bm, ss.valve.setting, ss.valve.K, ss.valve.area, model);
  if (cav) applyValveGasCavities(ss, model, timeStep, cav, H0, Q1, H1, Cp, Bp);
  runPumpStep(
    ss.pump.sourceHead,
    Q1,
    H1,
    Cp,
    Bp,
    Cm,
    Bm,
    ss.pump.a1,
    ss.pump.a2,
    ss.pump.Hs,
    ss.pump.setting,
    model,
  );
  if (pumpTrip) {
    runPumpTrip(t, timeStep, ss.pump.setting, ss.pump.a1, ss.pump.a2, ss.pump.Hs, Q1, H1, model, pumpTrip);
  }

  if (model.openStart.length > 0) {
    runOpenProtections(H0, H1, Q1, Cp, Bp, Cm, Bm, st.openQT, model, timeStep);
  }
  if (model.oeStart.length > 0) {
    runOpenTanksEnhanced(H1, Q1, Cp, Bp, Cm, Bm, st.oeZ, st.oeQT, model, timeStep);
  }
  if (model.closedStart.length > 0) {
    runClosedProtections(
      H1,
      Q1,
      Cp,
      Bp,
      Cm,
      Bm,
      st.closedQT0,
      st.closedHT0,
      st.closedVA,
      st.closedC,
      model,
      timeStep,
    );
  }
  if (model.owtStart.length > 0) {
    runOneWayTanks(H1, Q1, Cp, Bp, Cm, Bm, st.owtZ, st.owtQT, model, timeStep);
  }
  if (model.airStart.length > 0) {
    runAirValves(H1, Q1, Cp, Bp, Cm, Bm, st.airVol, st.airMass, ss.node.elevation, model, timeStep);
  }
  if (model.srvStart.length > 0) {
    runSrv(H1, Q1, Cp, Bp, Cm, Bm, st.srvTau, ss.node.elevation, model, timeStep, cav);
  }

  if (cav) {
    // Mirror the qu face onto boundary points the workers don't own, so next
    // step's neighbour reads are correct.
    for (let k = 0; k < cav.syncPoints.length; k++) {
      const p = cav.syncPoints[k];
      cav.quCur[p] = Q1[p];
    }
    // Recorded pipe-end flow is the pipe-side (qu) face; elsewhere qu == qd.
    for (let p = 0; p < model.uboundary.length; p++) {
      const u = model.uboundary[p];
      Q1[u] = cav.quCur[u];
    }
  }

  recorder.record(t, H1, Q1, st.E1, st.D1);
}
