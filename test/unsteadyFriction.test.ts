import { describe, it, expect } from 'vitest';
import { PtsnetSimulation, brunoneCoefficient } from '../src/index';

/**
 * Unsteady (Brunone) friction. Layout: R1 → P1 → V1 (inline) → P2 → R2, on a
 * small-diameter line. Closing V1 launches a Joukowsky surge that oscillates for
 * many cycles. The reservoir head is high enough that the down-surge stays well
 * above vapor pressure (no cavitation), so steady- vs unsteady-friction runs can
 * be compared directly. Steady friction under-damps the repeated peaks; the
 * Brunone term decays them at a realistic rate while leaving the first
 * (Joukowsky) peak essentially unchanged.
 */
const INP = `[TITLE]
[JUNCTIONS]
 J1 0 0
 J2 0 0
[RESERVOIRS]
 R1 90
 R2 88
[PIPES]
 P1 R1 J1 40 25 120 0 Open
 P2 J2 R2 40 25 120 0 Open
[VALVES]
 V1 J1 J2 25 TCV 5 0
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;

const G = 9.807;
const settings = {
  duration: 3,
  timeStep: 0.0002,
  defaultWaveSpeed: 1200,
  waveSpeedMethod: 'user' as const,
};

type UF = boolean | { coefficient?: number; viscosity?: number };

async function run(uf?: UF, workers?: number, operate = true) {
  const sim = await PtsnetSimulation.create({
    inp: INP,
    settings,
    recording: { nodes: ['J1'] },
    ...(uf ? { unsteadyFriction: uf } : {}),
    ...(workers ? { parallel: { workers } } : {}),
  });
  if (operate) {
    sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.05, endTime: 0.08 });
  }
  sim.run();
  return sim;
}

function maxIn(h: Float64Array, dt: number, t0: number, t1: number) {
  let m = -Infinity;
  for (let i = 0; i < h.length; i++) {
    const t = i * dt;
    if (t >= t0 && t <= t1) m = Math.max(m, h[i]);
  }
  return m;
}
function range(h: Float64Array, dt: number, t0: number, t1: number) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < h.length; i++) {
    const t = i * dt;
    if (t >= t0 && t <= t1) {
      lo = Math.min(lo, h[i]);
      hi = Math.max(hi, h[i]);
    }
  }
  return hi - lo;
}

describe('unsteady (Brunone) friction', () => {
  it('matches Joukowsky on the first peak but damps the later oscillations', async () => {
    const base = await run();
    const uf = await run(true);
    const hb = base.results.node.head.get('J1');
    const hu = uf.results.node.head.get('J1');
    const dt = base.settings.timeStep;

    expect(hb.every(Number.isFinite)).toBe(true);
    expect(hu.every(Number.isFinite)).toBe(true);

    const steady = base.ss.node.head[base.ss.node.index.get('J1')!];
    const a = base.ss.pipe.waveSpeed[0];
    const v0 = Math.abs(base.ss.pipe.flowrate[0]) / base.ss.pipe.area[0];
    const joukowsky = (a * v0) / G;

    // First up-surge ≈ steady + Joukowsky, and unsteady friction barely touches it.
    const firstBase = maxIn(hb, dt, 0.08, 0.3);
    const firstUf = maxIn(hu, dt, 0.08, 0.3);
    expect(Math.abs(firstBase - (steady + joukowsky))).toBeLessThan(0.05 * joukowsky);
    expect(Math.abs(firstUf - firstBase)).toBeLessThan(0.02 * joukowsky);

    // Late-time oscillation amplitude is markedly smaller with unsteady friction.
    const ampBase = range(hb, dt, 2, 3);
    const ampUf = range(hu, dt, 2, 3);
    expect(ampUf).toBeLessThan(0.85 * ampBase);
  });

  it('a larger Brunone coefficient damps more', async () => {
    const small = await run({ coefficient: 0.02 });
    const large = await run({ coefficient: 0.06 });
    const dt = settings.timeStep;
    const ampSmall = range(small.results.node.head.get('J1'), dt, 2, 3);
    const ampLarge = range(large.results.node.head.get('J1'), dt, 2, 3);
    expect(ampLarge).toBeLessThan(ampSmall);
  });

  it('does not disturb a steady (no-transient) run', async () => {
    const sim = await run(true, undefined, false); // unsteady friction on, no valve operation
    const h = sim.results.node.head.get('J1');
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of h) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi - lo).toBeLessThan(1e-4); // stays at steady state
  });

  it('is bit-identical across worker counts', async () => {
    const one = (await run(true, 1)).results.node.head.get('J1');
    const many = (await run(true, 4)).results.node.head.get('J1');
    let d = 0;
    for (let i = 0; i < one.length; i++) d = Math.max(d, Math.abs(one[i] - many[i]));
    expect(d).toBe(0);
    expect(one.every(Number.isFinite)).toBe(true);
  });

  it('estimates the Brunone coefficient from the Vardy–Brown C* (k = √C*/2)', () => {
    // Laminar: C* = 0.00476 (constant).
    const kLam = Math.sqrt(0.00476) / 2;
    expect(brunoneCoefficient(0)).toBeCloseTo(kLam, 6);
    expect(brunoneCoefficient(1000)).toBeCloseTo(kLam, 6);
    // Turbulent: decreases with Reynolds number, all positive and physical.
    expect(brunoneCoefficient(5600)).toBeCloseTo(0.027, 2);
    expect(brunoneCoefficient(3000)).toBeGreaterThan(brunoneCoefficient(1e4));
    expect(brunoneCoefficient(1e4)).toBeGreaterThan(brunoneCoefficient(1e5));
    expect(brunoneCoefficient(1e6)).toBeGreaterThan(0);
  });

  it('validates options', async () => {
    await expect(
      PtsnetSimulation.create({ inp: INP, settings, unsteadyFriction: { coefficient: -1 } }),
    ).rejects.toThrow(/coefficient/);
    await expect(
      PtsnetSimulation.create({ inp: INP, settings, unsteadyFriction: { viscosity: 0 } }),
    ).rejects.toThrow(/viscosity/);
  });
});

/**
 * Unsteady friction also composes with column separation (DGCM): the canonical
 * Bergant reservoir–pipe–valve case still cavitates and stays finite, with the
 * unsteady-friction damping layered on top — and remains worker-count invariant.
 */
const BERGANT_INP = `[TITLE]
[JUNCTIONS]
 J1 0 0
 J2 0 0.115
[RESERVOIRS]
 R1 22
[PIPES]
 P1 R1 J1 37.23 22.1 150 0 Open
[VALVES]
 V1 J1 J2 22.1 TCV 5 0
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;
const cavSettings = { duration: 0.5, timeStep: 0.0005, defaultWaveSpeed: 1319, waveSpeedMethod: 'user' as const };

async function runCav(uf: boolean, workers?: number) {
  const sim = await PtsnetSimulation.create({
    inp: BERGANT_INP,
    settings: cavSettings,
    cavitation: true,
    recording: { nodes: ['J1'] },
    ...(uf ? { unsteadyFriction: true } : {}),
    ...(workers ? { parallel: { workers } } : {}),
  });
  sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.05, endTime: 0.06 });
  sim.run();
  return sim;
}

describe('unsteady friction with column separation', () => {
  it('stays finite, forms a cavity, and is worker-count invariant', async () => {
    const uf = await runCav(true);
    const h = uf.results.node.head.get('J1');
    expect(h.every(Number.isFinite)).toBe(true);
    expect(uf.maxCavityVolume!).toBeGreaterThan(0); // a cavity still forms

    const one = (await runCav(true, 1)).results.node.head.get('J1');
    const many = (await runCav(true, 4)).results.node.head.get('J1');
    let d = 0;
    for (let i = 0; i < one.length; i++) d = Math.max(d, Math.abs(one[i] - many[i]));
    expect(d).toBe(0);
  });
});
