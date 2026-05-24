/**
 * ptsnet — Transient simulation in water networks (Method of Characteristics).
 *
 * TypeScript port of PTSNET. Initial (steady-state) conditions are obtained via
 * epanet-js; the transient solution is computed by a serial MOC engine.
 */
export { PtsnetSimulation } from './core/simulation';
export type {
  SimulationCreateOptions,
  ValveOperationOptions,
  PumpOperationOptions,
  RunOptions,
} from './core/simulation';

export type {
  SteadyState,
  NodeTable,
  PipeTable,
  PumpTable,
  ValveTable,
  PtsnetSettingsInput,
  ResolvedSettings,
  WaveSpeedMethod,
} from './core/types';
export { NODE_JUNCTION, NODE_RESERVOIR, NODE_TANK, G } from './core/types';

export { ResultSeries, serializeResults, deserializeResults } from './core/results';
export type {
  SimulationResults,
  NodeResults,
  PipeResults,
  SerializedResults,
  SerializedSeries,
  RecordingOptions,
  Envelope,
} from './core/results';

export type { CavitationOptions } from './core/cavitationEngine';
export { loadInitialConditions } from './epanet/initialConditions';
export { FlowUnit, HydParam, toSi } from './epanet/units';
