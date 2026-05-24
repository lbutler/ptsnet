/**
 * EPANET unit conversions, ported from `ptsnet/epanet/util.py` (wntr).
 *
 * EPANET reports values in the unit system implied by the model's flow units
 * (US customary or metric). Internally PTSNET works in SI (m, m^3/s, m of head).
 * These helpers convert raw toolkit values to SI, matching the `to_si` behaviour
 * of the original Python implementation.
 */

/** EPANET flow-unit codes (match epanet-js `FlowUnits`). */
export enum FlowUnit {
  CFS = 0,
  GPM = 1,
  MGD = 2,
  IMGD = 3,
  AFD = 4,
  LPS = 5,
  LPM = 6,
  MLD = 7,
  CMH = 8,
  CMD = 9,
}

/** Multiplicative factor converting a flow value to SI (m^3/s). */
const FLOW_FACTOR: Record<FlowUnit, number> = {
  [FlowUnit.CFS]: 0.0283168466,
  [FlowUnit.GPM]: 0.003785411784 / 60.0,
  [FlowUnit.MGD]: (1e6 * 0.003785411784) / 86400.0,
  [FlowUnit.IMGD]: (1e6 * 0.00454609) / 86400.0,
  [FlowUnit.AFD]: 1233.48184 / 86400.0,
  [FlowUnit.LPS]: 0.001,
  [FlowUnit.LPM]: 0.001 / 60.0,
  [FlowUnit.MLD]: (1e6 * 0.001) / 86400.0,
  [FlowUnit.CMH]: 1.0 / 3600.0,
  [FlowUnit.CMD]: 1.0 / 86400.0,
};

export function flowFactor(units: FlowUnit): number {
  return FLOW_FACTOR[units];
}

export function isTraditional(units: FlowUnit): boolean {
  return (
    units === FlowUnit.CFS ||
    units === FlowUnit.GPM ||
    units === FlowUnit.MGD ||
    units === FlowUnit.IMGD ||
    units === FlowUnit.AFD
  );
}

export function isMetric(units: FlowUnit): boolean {
  return (
    units === FlowUnit.LPS ||
    units === FlowUnit.LPM ||
    units === FlowUnit.MLD ||
    units === FlowUnit.CMH ||
    units === FlowUnit.CMD
  );
}

/** Hydraulic parameter kinds requiring unit conversion. */
export enum HydParam {
  Elevation,
  Demand,
  HydraulicHead,
  Pressure,
  Length,
  PipeDiameter,
  Flow,
  Velocity,
  EmitterCoeff,
}

const FT_TO_M = 0.3048;
const IN_TO_M = 0.0254;
const MM_TO_M = 0.001;

/** Convert a single EPANET value to SI units. Mirrors `HydParam._to_si`. */
export function toSi(units: FlowUnit, value: number, param: HydParam): number {
  const traditional = isTraditional(units);
  const metric = isMetric(units);

  switch (param) {
    case HydParam.Demand:
    case HydParam.Flow:
      return value * flowFactor(units);
    case HydParam.EmitterCoeff: {
      let v = value * flowFactor(units);
      if (traditional) v *= Math.sqrt(1.422070534698521); // flowunit/psi^0.5 -> flowunit/m^0.5
      return v;
    }
    case HydParam.PipeDiameter:
      if (traditional) return value * IN_TO_M;
      if (metric) return value * MM_TO_M;
      return value;
    case HydParam.Elevation:
    case HydParam.HydraulicHead:
    case HydParam.Length:
      return traditional ? value * FT_TO_M : value;
    case HydParam.Velocity:
      return traditional ? value * FT_TO_M : value;
    case HydParam.Pressure:
      return traditional ? value * (FT_TO_M / 0.4333) : value;
    default:
      return value;
  }
}

/** Convert an array in place to SI units. */
export function toSiArray(units: FlowUnit, data: Float64Array, param: HydParam): void {
  for (let i = 0; i < data.length; i++) data[i] = toSi(units, data[i], param);
}
