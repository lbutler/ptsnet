/**
 * The per-step "boundary phase": everything after the interior MOC stencil
 * (general junctions, valves, pumps, surge protections) plus result recording.
 *
 * Shared by the serial and parallel engines so they stay byte-identical: the
 * only thing parallelism changes is how the interior stencil is computed.
 */
import { SteadyState } from './types';
import { EngineModel } from './serialModel';
import { Recorder } from './recorder';
import {
  runGeneralJunction,
  runValveStep,
  runPumpStep,
  runOpenProtections,
  runClosedProtections,
} from './kernels';

const HB = 10.3;
const GAS_EXP = 1.2;

/** Main-thread scratch + persistent state for the boundary kernels. */
export interface BoundaryState {
  E1: Float64Array;
  D1: Float64Array;
  jSc: Float64Array;
  jSb: Float64Array;
  jHH: Float64Array;
  openQT: Float64Array;
  closedQT0: Float64Array;
  closedHT0: Float64Array;
  closedVA: Float64Array;
  closedC: Float64Array;
}

export function makeBoundaryState(model: EngineModel): BoundaryState {
  return {
    E1: new Float64Array(model.numJip),
    D1: new Float64Array(model.numJip),
    jSc: new Float64Array(model.numJip),
    jSb: new Float64Array(model.numJip),
    jHH: new Float64Array(model.numJip),
    openQT: new Float64Array(model.openStart.length),
    closedQT0: new Float64Array(model.closedStart.length),
    closedHT0: new Float64Array(model.closedStart.length),
    closedVA: new Float64Array(model.closedStart.length),
    closedC: new Float64Array(model.closedStart.length),
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
    );
  }

  runValveStep(Q1, H1, Cp, Bp, Cm, Bm, ss.valve.setting, ss.valve.K, ss.valve.area, model);
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

  if (model.openStart.length > 0) {
    runOpenProtections(H0, H1, Q1, Cp, Bp, Cm, Bm, st.openQT, model, timeStep);
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

  recorder.record(t, H1, Q1, st.E1, st.D1);
}
