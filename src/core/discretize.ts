/**
 * Pipe discretization and wave-speed handling.
 * Port of `Initializer.set_wave_speeds` / `_set_segments` from `init.py`.
 */
import { SteadyState, ResolvedSettings, WaveSpeedMethod } from './types';

export interface DiscretizationResult {
  numSegments: number;
  numPoints: number;
}

/**
 * Assign wave speeds, segment each pipe and (for the adaptive methods) refine
 * the simulation time step. Mutates `ss.pipe` and `settings` in place.
 */
export function discretize(ss: SteadyState, settings: ResolvedSettings): DiscretizationResult {
  const pipe = ss.pipe;
  const n = pipe.n;

  let modified = 0;
  if (settings.waveSpeeds) {
    for (const [label, value] of Object.entries(settings.waveSpeeds)) {
      const idx = pipe.index.get(label);
      if (idx === undefined) throw new Error(`unknown pipe '${label}' in waveSpeeds`);
      pipe.waveSpeed[idx] = value;
      modified++;
    }
  }
  if (settings.defaultWaveSpeed !== undefined && settings.defaultWaveSpeed !== null) {
    pipe.waveSpeed.fill(settings.defaultWaveSpeed);
    modified = n;
  }
  if (modified !== n) {
    throw new Error(
      'Wave speed values are not defined for all pipes; provide a default wave speed.',
    );
  }

  pipe.desiredWaveSpeed.set(pipe.waveSpeed);

  const result = setSegments(ss, settings, settings.waveSpeedMethod);

  for (let i = 0; i < n; i++) {
    pipe.waveSpeedAdjustment[i] =
      (Math.abs(pipe.waveSpeed[i] - pipe.desiredWaveSpeed[i]) * 100) / pipe.desiredWaveSpeed[i];
  }

  settings.timeSteps = Math.round(settings.duration / settings.timeStep);
  return result;
}

function setSegments(
  ss: SteadyState,
  settings: ResolvedSettings,
  method: WaveSpeedMethod,
): DiscretizationResult {
  const pipe = ss.pipe;
  const n = pipe.n;
  const seg = pipe.segments;

  if (method === 'critical' || method === 'dt' || method === 'optimal') {
    for (let i = 0; i < n; i++) seg[i] = pipe.length[i] / pipe.waveSpeed[i];
    let minSeg = Infinity;
    for (let i = 0; i < n; i++) minSeg = Math.min(minSeg, seg[i]);
    const maxDt = minSeg / 2; // at least 2 segments in the critical pipe
    settings.timeStep = Math.min(settings.timeStep, maxDt);
    for (let i = 0; i < n; i++) seg[i] /= settings.timeStep;
  } else if (method === 'user') {
    for (let i = 0; i < n; i++) seg[i] = pipe.length[i] / (pipe.waveSpeed[i] * settings.timeStep);
  } else {
    throw new Error(`Unsupported wave_speed method: ${method}`);
  }

  const intSeg = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = Math.round(seg[i]);
    if (s < 2) s = 2;
    intSeg[i] = s;
  }

  if (method === 'critical' || method === 'user') {
    // Adjust wave speed to absorb the truncation error.
    for (let i = 0; i < n; i++) {
      pipe.waveSpeed[i] = (pipe.waveSpeed[i] * seg[i]) / intSeg[i];
      seg[i] = intSeg[i];
    }
  } else if (method === 'dt') {
    for (let i = 0; i < n; i++) seg[i] = intSeg[i];
  } else {
    // optimal: choose a single time step minimizing wave-speed adjustment.
    for (let i = 0; i < n; i++) seg[i] = intSeg[i];
    const phi = new Float64Array(n);
    let dot1 = 0;
    let dot2 = 0;
    for (let i = 0; i < n; i++) {
      phi[i] = pipe.length[i] / (pipe.waveSpeed[i] * seg[i]);
      dot1 += phi[i];
      dot2 += phi[i] * phi[i];
    }
    const theta = dot1 / dot2;
    settings.timeStep = 1 / theta;
    for (let i = 0; i < n; i++) pipe.waveSpeed[i] = pipe.waveSpeed[i] * (phi[i] * theta);
  }

  let numSegments = 0;
  for (let i = 0; i < n; i++) {
    pipe.dx[i] = pipe.length[i] / seg[i];
    numSegments += seg[i];
  }
  numSegments = Math.round(numSegments);
  return { numSegments, numPoints: numSegments + n };
}
