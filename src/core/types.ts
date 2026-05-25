/** Data structures describing the steady-state network and simulation settings. */

/** EPANET node types. */
export const NODE_JUNCTION = 0;
export const NODE_RESERVOIR = 1;
export const NODE_TANK = 2;

/** Physical and numerical constants (from `simulation/constants.py`). */
export const G = 9.807; // SI gravity
export const TOL = 1e-6;
export const COEFF_TOL = 1e-6;
export const DEFAULT_FFACTOR = 0.035;

export interface NodeTable {
  n: number;
  labels: string[];
  index: Map<string, number>;
  demand: Float64Array;
  head: Float64Array;
  pressure: Float64Array;
  elevation: Float64Array;
  type: Int32Array; // NODE_JUNCTION | NODE_RESERVOIR | NODE_TANK
  degree: Int32Array;
  leakCoefficient: Float64Array;
  demandCoefficient: Float64Array;
}

export interface PipeTable {
  n: number;
  labels: string[];
  index: Map<string, number>;
  startNode: Int32Array;
  endNode: Int32Array;
  length: Float64Array;
  diameter: Float64Array;
  area: Float64Array;
  waveSpeed: Float64Array;
  desiredWaveSpeed: Float64Array;
  waveSpeedAdjustment: Float64Array;
  segments: Float64Array; // integer counts stored as float (matches Python)
  flowrate: Float64Array;
  velocity: Float64Array;
  headLoss: Float64Array;
  direction: Int32Array;
  ffactor: Float64Array;
  dx: Float64Array;
  type: Int32Array;
  isInline: Uint8Array;
  /** 1 if this pipe carries a check valve (EPANET CV status, or added via API). */
  isCheckValve: Uint8Array;
}

export interface PumpTable {
  n: number;
  labels: string[];
  index: Map<string, number>;
  startNode: Int32Array;
  endNode: Int32Array;
  flowrate: Float64Array;
  velocity: Float64Array;
  headLoss: Float64Array;
  direction: Int32Array;
  initialStatus: Float64Array;
  isInline: Uint8Array;
  sourceHead: Float64Array;
  a1: Float64Array;
  a2: Float64Array;
  Hs: Float64Array;
  curveIndex: Int32Array;
  setting: Float64Array;
}

export interface ValveTable {
  n: number;
  labels: string[];
  index: Map<string, number>;
  startNode: Int32Array;
  endNode: Int32Array;
  diameter: Float64Array;
  area: Float64Array;
  headLoss: Float64Array;
  flowrate: Float64Array;
  velocity: Float64Array;
  direction: Int32Array;
  initialStatus: Float64Array;
  type: Int32Array;
  isInline: Uint8Array;
  adjustment: Float64Array;
  K: Float64Array;
  setting: Float64Array;
  curveIndex: Int32Array;
}

export interface OpenProtection {
  label: string;
  node: number;
  area: number;
}

export interface ClosedProtection {
  label: string;
  node: number;
  area: number;
  height: number;
  waterLevel: number;
}

/** A combination air/vacuum valve at a node: admits air on vacuum, expels on pressurization. */
export interface AirValve {
  label: string;
  node: number;
  inflowArea: number; // inlet orifice area [m²]
  outflowArea: number; // outlet orifice area [m²]
  inCoeff: number; // inlet discharge coefficient
  outCoeff: number; // outlet discharge coefficient
}

/** The complete steady-state model produced from the EPANET solve. */
export interface SteadyState {
  node: NodeTable;
  pipe: PipeTable;
  pump: PumpTable;
  valve: ValveTable;
  openProtection: Map<string, OpenProtection>;
  closedProtection: Map<string, ClosedProtection>;
  airValve: Map<string, AirValve>;
  /** Adjacency: link names touching each node (by node index). */
  linksForNode: string[][];
}

export type WaveSpeedMethod = 'optimal' | 'critical' | 'user' | 'dt';

export interface PtsnetSettingsInput {
  timeStep?: number;
  duration?: number;
  warningsOn?: boolean;
  skipCompatibilityCheck?: boolean;
  /** Default wave speed [m/s] applied to every pipe. Pass `null` to rely solely on `waveSpeeds`. */
  defaultWaveSpeed?: number | null;
  waveSpeedMethod?: WaveSpeedMethod;
  /** Map of pipe label -> wave speed (replaces the wave-speed file). */
  waveSpeeds?: Record<string, number>;
  /** EPANET extended-period index to take initial conditions from. */
  period?: number;
}

export interface ResolvedSettings {
  timeStep: number;
  duration: number;
  warningsOn: boolean;
  skipCompatibilityCheck: boolean;
  defaultWaveSpeed: number | null;
  waveSpeedMethod: WaveSpeedMethod;
  waveSpeeds?: Record<string, number>;
  period: number;
  timeSteps: number;
}
