/**
 * Public simulation API. Port of `PTSNETSimulation` (and the helper classes
 * `PTSNETSettings`, `PTSNETCurve`, `PTSNETElementSettings`) from
 * `simulation/sim.py`, specialized to the serial engine.
 */
import { SteadyState, ResolvedSettings, PtsnetSettingsInput, COEFF_TOL } from './types';
import { loadInitialConditions } from '../epanet/initialConditions';
import { discretize } from './discretize';
import { buildEngineModel, EngineModel } from './serialModel';
import { SerialEngine } from './engine';
import { checkCompatibility } from './validation';
import { cubicSpline, linspace, roundHalfEven, pyFloorDiv } from './math';
import { SimulationResults } from './results';

const BUTTERFLY_X = [1, 0.8, 0.6, 0.4, 0.2, 0];
const BUTTERFLY_Y = [0.067, 0.044, 0.024, 0.011, 0.004, 0.0];

type CurveType = 'valve' | 'pump';
type SettingType = 'valve' | 'pump' | 'burst' | 'demand';
const SETTING_TYPES: SettingType[] = ['valve', 'pump', 'burst', 'demand'];
/** Maps a setting type to the steady-state table it operates on. */
const SETTING_IC_TYPE: Record<SettingType, 'valve' | 'pump' | 'node'> = {
  valve: 'valve',
  pump: 'pump',
  burst: 'node',
  demand: 'node',
};

class PtsnetCurve {
  readonly type: CurveType;
  readonly fun: (x: number) => number;
  /** Element (valve/pump) indices this curve applies to. */
  readonly elements: number[] = [];

  constructor(X: number[], Y: number[], type: CurveType) {
    this.type = type;
    this.fun = cubicSpline(X, Y);
  }

  addElement(index: number): void {
    if (!this.elements.includes(index)) this.elements.push(index);
  }

  call(value: number): number {
    return this.fun(value);
  }

  get length(): number {
    return this.elements.length;
  }
}

/** Time-scheduled setting changes for one setting type. */
class ElementSettings {
  private raw: Array<[number, number, number]> = []; // [elementIndex, stepIndex, value]
  private readonly knownElements = new Set<number>();
  private sorted = false;

  elements: Int32Array = new Int32Array(0);
  values: Float64Array = new Float64Array(0);
  activationTimes: number[] = [];
  activationIndices: number[] = [];
  ptr = 0;
  updated = false;

  get size(): number {
    return this.knownElements.size;
  }

  dump(elementIndex: number, X: Float64Array, Y: Float64Array, timeStep: number): void {
    if (this.sorted) throw new Error('the simulation has started, settings cannot be added');
    if (X.length !== Y.length) throw new Error('X and Y have different shapes');
    const xx = new Float64Array(X.length);
    for (let i = 0; i < X.length; i++) xx[i] = pyFloorDiv(X[i], timeStep);
    if (new Set(xx).size !== xx.length) {
      throw new Error('more than one modification per time step');
    }
    if (this.knownElements.has(elementIndex)) {
      this.raw = this.raw.filter((e) => e[0] !== elementIndex);
      this.knownElements.delete(elementIndex);
    }
    for (let i = 0; i < X.length; i++) this.raw.push([elementIndex, xx[i], Y[i]]);
    this.knownElements.add(elementIndex);
  }

  sort(): void {
    if (this.raw.length > 0 && !this.sorted) {
      this.raw.sort((a, b) => a[1] - b[1]);
      this.elements = Int32Array.from(this.raw.map((e) => e[0]));
      this.values = Float64Array.from(this.raw.map((e) => e[2]));
      const times: number[] = [];
      const indices: number[] = [];
      const seen = new Set<number>();
      for (let i = 0; i < this.raw.length; i++) {
        const step = this.raw[i][1];
        if (!seen.has(step)) {
          seen.add(step);
          times.push(step);
          indices.push(i);
        }
      }
      this.activationTimes = times;
      this.activationIndices = indices;
    }
    this.sorted = true;
  }
}

export interface SimulationCreateOptions {
  /** Contents of the EPANET `.inp` file. */
  inp: string;
  settings?: PtsnetSettingsInput;
}

export interface ValveOperationOptions {
  initialSetting: number;
  finalSetting: number;
  startTime?: number;
  endTime?: number;
  valveType?: 'butterfly';
  function?: 'linear';
}

export interface PumpOperationOptions {
  initialSetting: number;
  finalSetting: number;
  startTime?: number;
  endTime?: number;
  function?: 'linear';
}

function resolveSettings(input: PtsnetSettingsInput = {}): ResolvedSettings {
  const timeStep = input.timeStep ?? 0.01;
  const duration = input.duration ?? 20;
  if (timeStep > duration) throw new Error('Duration has to be larger than time step');
  return {
    timeStep,
    duration,
    warningsOn: input.warningsOn ?? false,
    skipCompatibilityCheck: input.skipCompatibilityCheck ?? false,
    defaultWaveSpeed: input.defaultWaveSpeed === undefined ? 1000 : input.defaultWaveSpeed,
    waveSpeedMethod: input.waveSpeedMethod ?? 'optimal',
    waveSpeeds: input.waveSpeeds,
    period: input.period ?? 0,
    timeSteps: roundHalfEven(duration / timeStep),
  };
}

export class PtsnetSimulation {
  readonly ss: SteadyState;
  readonly settings: ResolvedSettings;
  readonly numSegments: number;
  readonly numPoints: number;
  readonly time: Float64Array;

  private readonly curves = new Map<string, PtsnetCurve>();
  private readonly elementSettings: Record<SettingType, ElementSettings>;
  private model?: EngineModel;
  private engine?: SerialEngine;
  private t = 0;
  private initialized = false;
  private updatedSettings = false;

  private constructor(ss: SteadyState, settings: ResolvedSettings) {
    this.ss = ss;
    this.settings = settings;
    const disc = discretize(ss, settings);
    this.numSegments = disc.numSegments;
    this.numPoints = disc.numPoints;
    this.time = new Float64Array(settings.timeSteps);
    for (let i = 0; i < settings.timeSteps; i++) this.time[i] = i * settings.timeStep;
    this.elementSettings = {
      valve: new ElementSettings(),
      pump: new ElementSettings(),
      burst: new ElementSettings(),
      demand: new ElementSettings(),
    };
  }

  /** Build a simulation from an EPANET `.inp` file (runs the steady-state solve). */
  static async create(options: SimulationCreateOptions): Promise<PtsnetSimulation> {
    const settings = resolveSettings(options.settings);
    const ss = await loadInitialConditions(options.inp, { period: settings.period });
    if (!settings.skipCompatibilityCheck) checkCompatibility(ss);
    return new PtsnetSimulation(ss, settings);
  }

  // --- Curve / setting helpers ---

  private addCurve(name: string, type: CurveType, X: number[], Y: number[]): void {
    const tbl = type === 'valve' ? this.ss.valve : this.ss.pump;
    if (tbl.labels.length === 0) {
      throw new Error(`There are no elements of type '${type}' in the model`);
    }
    this.curves.set(name, new PtsnetCurve(X, Y, type));
  }

  private assignCurveTo(name: string, elements: string[]): void {
    if (elements.length === 0) throw new Error('No elements were specified');
    const curve = this.curves.get(name)!;
    const type = curve.type;
    for (const element of elements) {
      const tbl = type === 'valve' ? this.ss.valve : this.ss.pump;
      const idx = tbl.index.get(element);
      if (idx === undefined) throw new Error(`unknown ${type} '${element}'`);
      if (tbl.curveIndex[idx] !== -1) continue;
      if (type === 'valve') {
        const valve = this.ss.valve;
        const Kv = valve.K[idx];
        const Kc = curve.call(valve.setting[idx]);
        if (Kv === 0) {
          valve.adjustment[idx] = 1;
          valve.K[idx] = Kc;
        } else {
          valve.adjustment[idx] = Kv / Kc;
          if (this.settings.warningsOn && Math.abs(Kv - Kc) > COEFF_TOL) {
            console.warn(`loss coefficient of valve '${element}' adjusted to the curve`);
          }
        }
      }
      tbl.curveIndex[idx] = curve.length;
      curve.addElement(idx);
    }
  }

  private defineElementSetting(element: string, type: SettingType, X: Float64Array, Y: Float64Array): void {
    const icType = SETTING_IC_TYPE[type];
    const tbl = icType === 'valve' ? this.ss.valve : icType === 'pump' ? this.ss.pump : this.ss.node;
    const idx = tbl.index.get(element);
    if (idx === undefined) throw new Error(`unknown element '${element}'`);
    if (X[0] === 0) {
      this.elementSettings[type].dump(idx, X.subarray(1), Y.subarray(1), this.settings.timeStep);
    } else {
      this.elementSettings[type].dump(idx, X, Y, this.settings.timeStep);
    }
  }

  // --- Public operation builders ---

  defineValveOperation(valveNames: string | string[], options: ValveOperationOptions): void {
    const {
      initialSetting,
      finalSetting,
      startTime = 0,
      endTime = 1,
      valveType = 'butterfly',
      function: fn = 'linear',
    } = options;
    if (valveType !== 'butterfly') throw new Error("only 'butterfly' valves are supported");
    if (fn !== 'linear') throw new Error("only 'linear' transient functions are supported");
    if (startTime >= endTime) throw new Error('End time must be greater than start time');
    if (!(initialSetting >= 0 && initialSetting <= 1 && finalSetting >= 0 && finalSetting <= 1)) {
      throw new Error('Setting values must be between [0, 1]');
    }

    this.addCurve(valveType, 'valve', BUTTERFLY_X, BUTTERFLY_Y);
    const names = typeof valveNames === 'string' ? [valveNames] : valveNames;
    this.assignCurveTo(valveType, names);
    const NN = pyFloorDiv(endTime - startTime, this.settings.timeStep);
    for (const valve of names) {
      this.defineElementSetting(
        valve,
        'valve',
        linspace(startTime, endTime, NN),
        linspace(initialSetting, finalSetting, NN),
      );
    }
  }

  definePumpOperation(pumpNames: string | string[], options: PumpOperationOptions): void {
    const { initialSetting, finalSetting, startTime = 0, endTime = 1, function: fn = 'linear' } = options;
    if (fn !== 'linear') throw new Error("only 'linear' transient functions are supported");
    const NN = pyFloorDiv(endTime - startTime, this.settings.timeStep);
    const names = typeof pumpNames === 'string' ? [pumpNames] : pumpNames;
    for (const pump of names) {
      this.defineElementSetting(
        pump,
        'pump',
        linspace(startTime, endTime, NN),
        linspace(initialSetting, finalSetting, NN),
      );
    }
  }

  addBurst(
    nodeNames: string | string[],
    burstCoeff: number,
    startTime = 0,
    endTime = 1,
  ): void {
    const NN = pyFloorDiv(endTime - startTime, this.settings.timeStep);
    const names = typeof nodeNames === 'string' ? [nodeNames] : nodeNames;
    for (const node of names) {
      this.defineElementSetting(
        node,
        'burst',
        linspace(startTime, endTime, NN),
        linspace(0, burstCoeff, NN),
      );
    }
  }

  addSurgeProtection(
    nodeName: string,
    protectionType: 'open' | 'closed',
    tankArea: number,
    tankHeight?: number,
    waterLevel?: number,
  ): void {
    const node = this.ss.node;
    const nodeId = node.index.get(nodeName);
    if (nodeId === undefined) throw new Error(`unknown node '${nodeName}'`);
    if (this.ss.openProtection.has(nodeName) || this.ss.closedProtection.has(nodeName)) {
      throw new Error(`node '${nodeName}' already has a surge protection`);
    }

    const onNonPipe =
      [...this.ss.pump.startNode, ...this.ss.pump.endNode, ...this.ss.valve.startNode, ...this.ss.valve.endNode].includes(
        nodeId,
      );
    if (node.degree[nodeId] !== 2 || onNonPipe) {
      throw new Error(`node '${nodeName}' is not between two pipes`);
    }

    if (protectionType === 'open') {
      this.ss.openProtection.set(nodeName, { label: nodeName, node: nodeId, area: tankArea });
    } else {
      if (tankHeight === undefined || waterLevel === undefined) {
        throw new Error('tank height and water level are required for closed protection');
      }
      this.ss.closedProtection.set(nodeName, {
        label: nodeName,
        node: nodeId,
        area: tankArea,
        height: tankHeight,
        waterLevel,
      });
    }
  }

  // --- Run loop ---

  private initialize(): void {
    for (const type of SETTING_TYPES) this.elementSettings[type].sort();

    const valve = this.ss.valve;
    const unassigned: string[] = [];
    for (let i = 0; i < valve.n; i++) if (valve.curveIndex[i] === -1) unassigned.push(valve.labels[i]);
    if (unassigned.length > 0) {
      this.addCurve('butterfly', 'valve', BUTTERFLY_X, BUTTERFLY_Y);
      this.assignCurveTo('butterfly', unassigned);
    }

    this.model = buildEngineModel(this.ss, this.numPoints);
    this.engine = new SerialEngine(this.ss, this.model, this.settings.timeStep, this.settings.timeSteps);
    this.t = 1;
    this.initialized = true;
  }

  private updateCoefficients(): void {
    const valve = this.ss.valve;
    for (const curve of this.curves.values()) {
      if (curve.type === 'valve') {
        for (const idx of curve.elements) {
          valve.K[idx] = valve.adjustment[idx] * curve.call(valve.setting[idx]);
        }
      }
    }
  }

  private applySetting(type: SettingType, elementIndex: number, value: number): void {
    if (type === 'valve') this.ss.valve.setting[elementIndex] = value;
    else if (type === 'pump') this.ss.pump.setting[elementIndex] = value;
    else if (type === 'burst') this.ss.node.leakCoefficient[elementIndex] = value;
    else this.ss.node.demandCoefficient[elementIndex] = value;
  }

  private updateSettings(): void {
    if (this.updatedSettings) return;
    this.updateCoefficients();

    let allUpdated = true;
    for (const type of SETTING_TYPES) allUpdated &&= this.elementSettings[type].updated;
    this.updatedSettings = allUpdated;
    if (allUpdated) return;

    for (const type of SETTING_TYPES) {
      const es = this.elementSettings[type];
      if (es.activationTimes.length === 0) {
        es.updated = true;
        continue;
      }
      if (es.ptr >= es.activationTimes.length) {
        es.updated = true;
        continue;
      }
      if (es.activationTimes[es.ptr] === 0) {
        es.ptr++;
        continue;
      }
      if (this.t >= es.activationTimes[es.ptr]) {
        const i1 = es.activationIndices[es.ptr];
        const i2 =
          es.ptr + 1 < es.activationIndices.length ? es.activationIndices[es.ptr + 1] : es.elements.length;
        for (let j = i1; j < i2; j++) this.applySetting(type, es.elements[j], es.values[j]);
        es.ptr++;
      }
    }
  }

  get isOver(): boolean {
    return this.t > this.settings.timeSteps - 1;
  }

  /** Advance the simulation by a single time step. */
  runStep(): void {
    if (!this.initialized) this.initialize();
    if (!this.updatedSettings) this.updateSettings();
    this.engine!.runStep(this.t);
    this.t++;
  }

  /** Run the full transient simulation. */
  run(): void {
    if (!this.initialized) this.initialize();
    while (!this.isOver) this.runStep();
  }

  // --- Results ---

  get results(): SimulationResults {
    if (!this.engine) throw new Error('simulation has not been run yet');
    return this.engine.results;
  }

  get allValves(): string[] {
    return this.ss.valve.labels;
  }

  get allPumps(): string[] {
    return this.ss.pump.labels;
  }
}
