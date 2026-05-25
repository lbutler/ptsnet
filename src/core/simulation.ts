/**
 * Public simulation API. Port of `PTSNETSimulation` (and the helper classes
 * `PTSNETSettings`, `PTSNETCurve`, `PTSNETElementSettings`) from
 * `simulation/sim.py`, specialized to the serial engine.
 */
import { SteadyState, ResolvedSettings, PtsnetSettingsInput, COEFF_TOL, G } from './types';
import { loadInitialConditions } from '../epanet/initialConditions';
import { discretize } from './discretize';
import { buildEngineModel, EngineModel } from './serialModel';
import { ParallelEngine } from '../parallel/parallelEngine';
import { resolveBackend, WorkerBackend } from '../parallel/workerBackend';
import { CavitationOptions, PumpTripState } from './boundaryPhase';
import { checkCompatibility } from './validation';
import { cubicSpline, linspace, roundHalfEven, pyFloorDiv } from './math';
import {
  SimulationResults,
  SerializedResults,
  serializeResults,
  RecordingOptions,
  Envelope,
  CavitationReport,
} from './results';

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
  /** What to store. Defaults to every element at every step. */
  recording?: RecordingOptions;
  /**
   * Worker-pool size for the transient (the engine always runs on workers).
   * `workers` defaults to the hardware concurrency.
   */
  parallel?: { workers?: number };
  /**
   * Enable column separation (Discrete Gas Cavity Model) so head cannot drop
   * below the liquid vapor pressure. `true` uses defaults.
   */
  cavitation?: boolean | CavitationOptions;
}

/** Streaming / progress / cancellation options for {@link PtsnetSimulation.run}. */
export interface RunOptions {
  /** Abort the run; partial results remain accessible on `sim.results`. */
  signal?: AbortSignal;
  /** Called after each computed step with the just-finished step index. */
  onStep?: (step: number) => void;
  /** Periodic progress callback. */
  onProgress?: (p: { step: number; totalSteps: number; fraction: number }) => void;
  /** Steps between `onProgress` calls (default ≈ totalSteps/100). */
  progressInterval?: number;
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The simulation was aborted.', 'AbortError');
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

export interface PumpTripOptions {
  /** Power-failure time [s]; the pump coasts down on its rotating inertia after this. */
  tripTime: number;
  /** Polar moment of inertia of the rotating assembly [kg·m²]. */
  inertia: number;
  /** Rated rotational speed [rpm]. */
  ratedSpeed: number;
  /** Rated efficiency (0–1). Provide this or `ratedPower`; defaults to 0.8 (with a warning). */
  ratedEfficiency?: number;
  /** Rated shaft power [W]; used to derive efficiency from the steady operating point. */
  ratedPower?: number;
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

  private readonly recording: RecordingOptions;
  private readonly curves = new Map<string, PtsnetCurve>();
  private readonly pumpTrips = new Map<number, PumpTripOptions>();
  private readonly elementSettings: Record<SettingType, ElementSettings>;
  private model?: EngineModel;
  private engine?: ParallelEngine;
  private workerBackend!: WorkerBackend;
  private workers = 1;
  private cavitationOptions?: CavitationOptions;
  private t = 0;
  private initialized = false;
  private updatedSettings = false;

  private constructor(ss: SteadyState, settings: ResolvedSettings, recording: RecordingOptions) {
    this.ss = ss;
    this.settings = settings;
    this.recording = recording;
    const disc = discretize(ss, settings);
    this.numSegments = disc.numSegments;
    this.numPoints = disc.numPoints;
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
    const sim = new PtsnetSimulation(ss, settings, options.recording ?? {});
    const backend = await resolveBackend();
    if (!backend) {
      throw new Error(
        'ptsnet requires SharedArrayBuffer-backed workers (Node `worker_threads`, or a ' +
          'cross-origin-isolated browser context with COOP/COEP headers).',
      );
    }
    const hw = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency;
    sim.workerBackend = backend;
    sim.workers = options.parallel?.workers ?? hw ?? 4;
    if (options.cavitation) {
      sim.cavitationOptions = options.cavitation === true ? {} : options.cavitation;
    }
    return sim;
  }

  /** Recorded time stamps [s] (one per stored sample; honours `recording.every`). */
  get time(): Float64Array {
    if (this.engine) return this.engine.time;
    const t = new Float64Array(this.settings.timeSteps);
    for (let i = 0; i < t.length; i++) t[i] = i * this.settings.timeStep;
    return t;
  }

  // --- Curve / setting helpers ---

  /** Register a curve (`type` = 'valve' | 'pump'). Mirrors `add_curve`. */
  addCurve(name: string, type: CurveType, X: number[], Y: number[]): void {
    const tbl = type === 'valve' ? this.ss.valve : this.ss.pump;
    if (tbl.labels.length === 0) {
      throw new Error(`There are no elements of type '${type}' in the model`);
    }
    this.curves.set(name, new PtsnetCurve(X, Y, type));
  }

  /** Assign a registered curve to elements (by label). Mirrors `assign_curve_to`. */
  assignCurveTo(name: string, elements: string | string[]): void {
    this.assignCurveToImpl(name, typeof elements === 'string' ? [elements] : elements);
  }

  private assignCurveToImpl(name: string, elements: string[]): void {
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

  /**
   * Trip a pump (power failure) at `tripTime`: afterwards its speed coasts down
   * on the rotating inertia rather than following a schedule, and its discharge
   * check valve blocks backflow. Requires `inertia` [kg·m²] and `ratedSpeed`
   * [rpm]; supply `ratedEfficiency` (0–1) or `ratedPower` [W] (else efficiency
   * defaults to 0.8). A pump cannot have both a trip and a speed schedule.
   */
  definePumpTrip(pumpName: string, options: PumpTripOptions): void {
    const idx = this.ss.pump.index.get(pumpName);
    if (idx === undefined) throw new Error(`unknown pump '${pumpName}'`);
    if (options.inertia <= 0) throw new Error('pump trip requires inertia > 0');
    if (options.ratedSpeed <= 0) throw new Error('pump trip requires ratedSpeed > 0');
    this.pumpTrips.set(idx, options);
  }

  /** Build the per-pump trip state (tripStep, K) used by the boundary phase. */
  private buildPumpTripState(): PumpTripState | undefined {
    if (this.pumpTrips.size === 0) return undefined;
    const pump = this.ss.pump;
    const tripStep = new Int32Array(pump.n).fill(-1);
    const K = new Float64Array(pump.n);
    const scheduled = new Set(Array.from(this.elementSettings.pump.elements));
    for (const [pp, opts] of this.pumpTrips) {
      if (scheduled.has(pp)) {
        throw new Error(`pump '${pump.labels[pp]}' cannot have both a trip and a speed schedule`);
      }
      const wR = (2 * Math.PI * opts.ratedSpeed) / 60; // rated angular speed [rad/s]
      let eta = opts.ratedEfficiency;
      if (eta === undefined && opts.ratedPower !== undefined && opts.ratedPower > 0) {
        eta = (1000 * G * pump.flowrate[pp] * pump.headLoss[pp]) / opts.ratedPower;
      }
      if (eta === undefined || !(eta > 0)) {
        eta = 0.8;
        if (this.settings.warningsOn) {
          console.warn(`ptsnet: pump '${pump.labels[pp]}' trip efficiency not given; assuming 0.8`);
        }
      }
      tripStep[pp] = Math.round(opts.tripTime / this.settings.timeStep);
      K[pp] = (1000 * G) / (eta * opts.inertia * wR * wR);
    }
    return { tripStep, K };
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

  /**
   * Mark a pipe as carrying an (ideal) check valve: it passes flow in the
   * steady-state direction and shuts the instant flow reverses, preventing
   * backflow (e.g. on the down-surge after a downstream valve closure or, later,
   * a pump trip). EPANET `CV`-status pipes are honored automatically; use this
   * for check valves not already in the `.inp`. The valve is enforced at an end
   * node of the pipe that joins exactly two pipes.
   */
  addCheckValve(pipeName: string): void {
    const idx = this.ss.pipe.index.get(pipeName);
    if (idx === undefined) throw new Error(`unknown pipe '${pipeName}'`);
    this.ss.pipe.isCheckValve[idx] = 1;
  }

  // --- Custom setting schedules (arbitrary time/value profiles) ---

  private toF64(a: number[] | Float64Array): Float64Array {
    return a instanceof Float64Array ? a : Float64Array.from(a);
  }

  defineValveSettings(name: string, X: number[] | Float64Array, Y: number[] | Float64Array): void {
    this.defineElementSetting(name, 'valve', this.toF64(X), this.toF64(Y));
  }

  definePumpSettings(name: string, X: number[] | Float64Array, Y: number[] | Float64Array): void {
    this.defineElementSetting(name, 'pump', this.toF64(X), this.toF64(Y));
  }

  defineBurstSettings(name: string, X: number[] | Float64Array, Y: number[] | Float64Array): void {
    this.defineElementSetting(name, 'burst', this.toF64(X), this.toF64(Y));
  }

  defineDemandSettings(name: string, X: number[] | Float64Array, Y: number[] | Float64Array): void {
    this.defineElementSetting(name, 'demand', this.toF64(X), this.toF64(Y));
  }

  // --- Manual real-time control (during stepping) ---

  /** Whether the current time aligns with a `step`-second operation interval. */
  canBeOperated(step: number, checkWarning = false): boolean {
    const checkTime = this.t * this.settings.timeStep;
    if (checkTime % step >= this.settings.timeStep) return false;
    if (checkWarning) console.warn(`operating at time ${checkTime}`);
    return true;
  }

  setValveSetting(name: string | string[], value: number | number[], step?: number, checkWarning = false): void {
    this.setElementSetting('valve', name, value, step, checkWarning);
  }

  setPumpSetting(name: string | string[], value: number | number[], step?: number, checkWarning = false): void {
    this.setElementSetting('pump', name, value, step, checkWarning);
  }

  setBurstSetting(name: string | string[], value: number | number[], step?: number, checkWarning = false): void {
    this.setElementSetting('burst', name, value, step, checkWarning);
  }

  setDemandSetting(name: string | string[], value: number | number[], step?: number, checkWarning = false): void {
    this.setElementSetting('demand', name, value, step, checkWarning);
  }

  private setElementSetting(
    type: SettingType,
    elementName: string | string[],
    value: number | number[],
    step?: number,
    checkWarning = false,
  ): void {
    if (this.t === 0) throw new Error('simulation has not been initialized');
    if (step !== undefined && !this.canBeOperated(step, checkWarning)) return;

    const names = typeof elementName === 'string' ? [elementName] : elementName;
    const values = Array.isArray(value) ? value : names.map(() => value);
    if (names.length !== values.length) {
      throw new Error("length of 'name' does not match length of 'value'");
    }
    for (const v of values) {
      if ((type === 'valve' || type === 'pump') && (v < 0 || v > 1)) {
        throw new Error(`setting for ${type} not in [0, 1]`);
      }
      if ((type === 'burst' || type === 'demand') && v < 0) {
        throw new Error(`${type} coefficient has to be >= 0`);
      }
    }
    const icType = SETTING_IC_TYPE[type];
    const tbl = icType === 'valve' ? this.ss.valve : icType === 'pump' ? this.ss.pump : this.ss.node;
    for (let i = 0; i < names.length; i++) {
      const idx = tbl.index.get(names[i]);
      if (idx === undefined) throw new Error(`unknown element '${names[i]}'`);
      this.applySetting(type, idx, values[i]);
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

    this.model = buildEngineModel(this.ss, this.numPoints, (msg) => {
      if (this.settings.warningsOn) console.warn(`ptsnet: ${msg}`);
    });
    this.engine = new ParallelEngine(
      this.workerBackend,
      this.workers,
      this.ss,
      this.model,
      this.settings.timeStep,
      this.settings.timeSteps,
      this.recording,
      this.cavitationOptions,
      this.buildPumpTripState(),
    );
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

  /** Current time-step index (0 before the first step). */
  get currentStep(): number {
    return this.t;
  }

  /** Advance the simulation by a single time step (synchronous). */
  runStep(): void {
    if (!this.initialized) this.initialize();
    if (!this.updatedSettings) this.updateSettings();
    this.engine!.runStep(this.t);
    this.t++;
  }

  /** Advance by a single time step without blocking the calling thread. */
  async runStepAsync(): Promise<void> {
    if (!this.initialized) this.initialize();
    if (!this.updatedSettings) this.updateSettings();
    const e = this.engine!;
    if (e.runStepAsync) await e.runStepAsync(this.t);
    else e.runStep(this.t);
    this.t++;
  }

  private progressInterval(options: RunOptions): number {
    return options.progressInterval ?? Math.max(1, Math.floor(this.settings.timeSteps / 100));
  }

  private afterStep(options: RunOptions, interval: number): void {
    const step = this.t - 1; // step just computed
    options.onStep?.(step);
    if (options.onProgress && (this.t % interval === 0 || this.isOver)) {
      const total = this.settings.timeSteps;
      options.onProgress({ step, totalSteps: total, fraction: Math.min(1, this.t / total) });
    }
    if (options.signal?.aborted) {
      this.dispose();
      throw abortError(options.signal);
    }
  }

  /**
   * Run the full transient simulation synchronously. Disposes the worker pool
   * (if any) when done. In the browser, parallel runs must use {@link runAsync}
   * because the main thread cannot block on `Atomics.wait`.
   *
   * Optional callbacks stream progress (`onProgress`) and per-step events
   * (`onStep`); an `AbortSignal` cancels the run (partial results remain in
   * `sim.results`).
   */
  run(options: RunOptions = {}): void {
    if (typeof window !== 'undefined') {
      throw new Error('In the browser, simulations must use `await sim.runAsync()`.');
    }
    if (options.signal?.aborted) throw abortError(options.signal);
    if (!this.initialized) this.initialize();
    const interval = this.progressInterval(options);
    while (!this.isOver) {
      this.runStep();
      this.afterStep(options, interval);
    }
    this.warnInvalidCavitation();
    this.dispose();
  }

  /**
   * Run the full transient simulation without blocking the calling thread
   * (uses `Atomics.waitAsync` for parallel runs). Works in the browser and Node.
   * Accepts the same streaming/progress/cancellation options as {@link run}.
   */
  async runAsync(options: RunOptions = {}): Promise<void> {
    if (options.signal?.aborted) throw abortError(options.signal);
    if (!this.initialized) this.initialize();
    const interval = this.progressInterval(options);
    while (!this.isOver) {
      await this.runStepAsync();
      this.afterStep(options, interval);
    }
    this.warnInvalidCavitation();
    this.dispose();
  }

  /** Release the worker pool (parallel runs). Safe to call multiple times. */
  dispose(): void {
    this.engine?.dispose?.();
  }

  // --- Results ---

  get results(): SimulationResults {
    if (!this.engine) throw new Error('simulation has not been run yet');
    return this.engine.results;
  }

  /** Per-element min/max envelope over the whole run (if `recording.envelope`). */
  get envelope(): Envelope | undefined {
    if (!this.engine) throw new Error('simulation has not been run yet');
    return this.engine.envelope;
  }

  /** Largest vapor-cavity volume [m³] seen during the run (column separation only). */
  get maxCavityVolume(): number | undefined {
    return this.engine?.maxCavityVolume;
  }

  /**
   * Per-element column-separation diagnostics: peak cavity volume at each
   * cavitating pipe/node and a `valid` flag that's false if any cavity outgrew
   * its mesh cell. Returns `undefined` when cavitation wasn't enabled.
   */
  cavitationReport(): CavitationReport | undefined {
    if (!this.engine) throw new Error('simulation has not been run yet');
    return this.engine.cavitationReport();
  }

  private warnInvalidCavitation(): void {
    if (!this.cavitationOptions || !this.settings.warningsOn) return;
    const r = this.engine?.cavitationReport();
    if (r && !r.valid) {
      console.warn(
        `ptsnet: a column-separation cavity reached its mesh-cell volume (worst fill fraction ` +
          `${r.worstFillFraction.toFixed(1)}); the discrete-cavity model is unreliable there — ` +
          `refine the mesh / time step near the worst site or treat those results with caution.`,
      );
    }
  }

  /** Serialize results + time stamps to a JSON-safe object. */
  serializeResults(): SerializedResults {
    return serializeResults(this.results, this.time);
  }

  get allValves(): string[] {
    return this.ss.valve.labels;
  }

  get allPumps(): string[] {
    return this.ss.pump.labels;
  }
}
