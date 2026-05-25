import { describe, it, expect } from 'vitest';
import { PtsnetSimulation, swameeJain } from '../src/index';
import { effectiveRoughness } from '../src/core/quasiSteadyFriction';

/**
 * Quasi-steady friction. Same layout as the unsteady-friction suite:
 * R1 → P1 → V1 (inline) → P2 → R2 on a small-diameter line. Closing V1 launches a
 * Joukowsky surge that oscillates for many cycles. Quasi-steady friction
 * recomputes the Darcy `f` each step from the instantaneous velocity (Swamee–Jain),
 * anchored to the steady operating point — so the first (Joukowsky) peak is
 * essentially unchanged while the later oscillations shift slightly as `f` tracks
 * the changing Reynolds number.
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

type QSF = boolean | { viscosity?: number };

async function run(qsf?: QSF, workers?: number, operate = true) {
  const sim = await PtsnetSimulation.create({
    inp: INP,
    settings,
    recording: { nodes: ['J1'] },
    ...(qsf ? { quasiSteadyFriction: qsf } : {}),
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
function maxDiff(a: Float64Array, b: Float64Array) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

describe('quasi-steady friction', () => {
  it('leaves the first Joukowsky peak essentially unchanged but shifts later oscillations', async () => {
    const base = await run();
    const qsf = await run(true);
    const hb = base.results.node.head.get('J1');
    const hq = qsf.results.node.head.get('J1');
    const dt = base.settings.timeStep;

    expect(hb.every(Number.isFinite)).toBe(true);
    expect(hq.every(Number.isFinite)).toBe(true);

    const steady = base.ss.node.head[base.ss.node.index.get('J1')!];
    const a = base.ss.pipe.waveSpeed[0];
    const v0 = Math.abs(base.ss.pipe.flowrate[0]) / base.ss.pipe.area[0];
    const joukowsky = (a * v0) / G;

    // First up-surge ≈ steady + Joukowsky, and quasi-steady friction barely touches it.
    const firstBase = maxIn(hb, dt, 0.08, 0.3);
    const firstQsf = maxIn(hq, dt, 0.08, 0.3);
    expect(Math.abs(firstBase - (steady + joukowsky))).toBeLessThan(0.05 * joukowsky);
    expect(Math.abs(firstQsf - firstBase)).toBeLessThan(0.02 * joukowsky);

    // Over the whole trace the correction is real but modest (a few % of Joukowsky).
    const md = maxDiff(hb, hq);
    expect(md).toBeGreaterThan(0.05);
    expect(md).toBeLessThan(0.3 * joukowsky);
  });

  it('does not disturb a steady (no-transient) run', async () => {
    const sim = await run(true, undefined, false); // quasi-steady friction on, no valve operation
    const h = sim.results.node.head.get('J1');
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of h) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi - lo).toBeLessThan(1e-4); // stays at steady state (anchored back-out)
  });

  it('is bit-identical across worker counts', async () => {
    const one = (await run(true, 1)).results.node.head.get('J1');
    const many = (await run(true, 4)).results.node.head.get('J1');
    expect(maxDiff(one, many)).toBe(0);
    expect(one.every(Number.isFinite)).toBe(true);
  });

  it('recomputes f from the Reynolds number (Swamee–Jain), anchored to the steady point', () => {
    // Laminar below the transition: f = 64/Re.
    expect(swameeJain(1000, 0)).toBeCloseTo(64 / 1000, 9);
    // Turbulent: f decreases with Re and increases with roughness, all physical.
    expect(swameeJain(1e5, 1e-4)).toBeCloseTo(0.018452, 5);
    expect(swameeJain(1e4, 1e-4)).toBeGreaterThan(swameeJain(1e5, 1e-4));
    expect(swameeJain(1e5, 1e-4)).toBeGreaterThan(swameeJain(1e6, 1e-4));
    expect(swameeJain(1e5, 1e-2)).toBeGreaterThan(swameeJain(1e5, 1e-4));
    // Anchoring: roughness backed out from (f0, Re0) reproduces f0 at Re0.
    const f0 = 0.03;
    const Re0 = 1e5;
    expect(swameeJain(Re0, effectiveRoughness(f0, Re0))).toBeCloseTo(f0, 6);
    // Nothing to anchor to in the laminar/zero-flow case → smooth fallback.
    expect(effectiveRoughness(0.04, 1000)).toBe(0);
  });

  it('validates options', async () => {
    await expect(
      PtsnetSimulation.create({ inp: INP, settings, quasiSteadyFriction: { viscosity: 0 } }),
    ).rejects.toThrow(/viscosity/);
  });
});

/**
 * Quasi-steady friction also composes with column separation (DGCM): the
 * canonical Bergant reservoir–pipe–valve case still cavitates and stays finite
 * with the recomputed friction layered on, and remains worker-count invariant.
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

async function runCav(qsf: boolean, workers?: number) {
  const sim = await PtsnetSimulation.create({
    inp: BERGANT_INP,
    settings: cavSettings,
    cavitation: true,
    recording: { nodes: ['J1'] },
    ...(qsf ? { quasiSteadyFriction: true } : {}),
    ...(workers ? { parallel: { workers } } : {}),
  });
  sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.05, endTime: 0.06 });
  sim.run();
  return sim;
}

describe('quasi-steady friction with column separation', () => {
  it('stays finite, forms a cavity, and is worker-count invariant', async () => {
    const qsf = await runCav(true);
    const h = qsf.results.node.head.get('J1');
    expect(h.every(Number.isFinite)).toBe(true);
    expect(qsf.maxCavityVolume!).toBeGreaterThan(0); // a cavity still forms

    const one = (await runCav(true, 1)).results.node.head.get('J1');
    const many = (await runCav(true, 4)).results.node.head.get('J1');
    expect(maxDiff(one, many)).toBe(0);
  });
});
