import { describe, it, expect } from 'vitest';
import { PtsnetSimulation, VALVE_CURVES, ValveCharacteristic } from '../src/index';

/**
 * Built-in valve characteristic-curve library (butterfly/globe/gate/ball/needle).
 * `defineValveOperation({ valveType })` selects an inherent characteristic
 * (relative flow coefficient vs % open); the kernel is unchanged — only the curve
 * shape differs. Layout: R1(40) → P1 → J1 → V1(inline) → J2 → P2 → R2(20). Closing
 * V1 sends an up-surge to J1; the curve shape changes how abruptly the flow is
 * choked off, hence the peak. Steady flow is identical across types (the curve is
 * normalized to the steady-state loss at full open), so peaks are directly
 * comparable.
 */
const INP = `[TITLE]
[JUNCTIONS]
 J1 0 0
 J2 0 0
[RESERVOIRS]
 R1 40
 R2 20
[PIPES]
 P1 R1 J1 400 100 130 0 Open
 P2 J2 R2 400 100 130 0 Open
[VALVES]
 V1 J1 J2 100 TCV 30 0
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;

const settings = { duration: 4, timeStep: 0.002, defaultWaveSpeed: 1200, waveSpeedMethod: 'user' as const };
const G = 9.807;

const TYPES: ValveCharacteristic[] = ['butterfly', 'gate', 'globe', 'needle', 'ball'];

async function run(valveType: ValveCharacteristic, workers?: number) {
  const sim = await PtsnetSimulation.create({
    inp: INP,
    settings,
    recording: { nodes: ['J1'], pipes: ['P1'] },
    ...(workers ? { parallel: { workers } } : {}),
  });
  const pidx = sim.ss.pipe.index.get('P1')!;
  const v0 = sim.ss.pipe.flowrate[pidx] / sim.ss.pipe.area[pidx];
  const a = sim.ss.pipe.waveSpeed[pidx];
  const steady = sim.ss.node.head[sim.ss.node.index.get('J1')!];
  sim.defineValveOperation('V1', {
    initialSetting: 1,
    finalSetting: 0,
    startTime: 0.3,
    endTime: 1.3,
    valveType,
  });
  sim.run();
  const h = sim.results.node.head.get('J1');
  const q = sim.results.pipeEnd.flowrate.get('P1'); // flow at the valve face
  let max = -Infinity;
  for (const v of h) max = Math.max(max, v);
  return { h, q, max, steady, jouk: (a * v0) / G };
}

describe('valve characteristic-curve library', () => {
  it('every built-in type produces a finite, Joukowsky-bounded closure', async () => {
    for (const t of TYPES) {
      const r = await run(t);
      expect(r.h.every(Number.isFinite), `${t} finite`).toBe(true);
      const rise = r.max - r.steady;
      // A real up-surge happened, but it can't exceed the instantaneous-closure
      // Joukowsky head a·V₀/g (small tolerance for discretization).
      expect(rise, `${t} surged`).toBeGreaterThan(0.5 * r.jouk);
      expect(rise, `${t} bounded`).toBeLessThan(1.05 * r.jouk);
      // Fully shut → no flow through the valve at the final step.
      expect(Math.abs(r.q[r.q.length - 1]), `${t} shut`).toBeLessThan(1e-6);
    }
  });

  it('curve shape changes the peak: quick-opening (gate) surges harder than equal-percentage (ball)', async () => {
    const peaks = new Map<ValveCharacteristic, number>();
    for (const t of TYPES) peaks.set(t, (await run(t)).max);

    // Gate stays open until late (sharp final cutoff) → higher peak; ball tapers
    // flow early (equal-percentage) → gentler cutoff → lower peak.
    expect(peaks.get('gate')!).toBeGreaterThan(peaks.get('ball')! + 2);
    // The library is not degenerate: the types give distinct peaks.
    expect(new Set([...peaks.values()].map((p) => p.toFixed(3))).size).toBeGreaterThan(1);
  });

  it('is bit-identical across worker counts', async () => {
    const one = await run('gate', 1);
    const many = await run('gate', 4);
    let d = 0;
    for (let i = 0; i < one.h.length; i++) d = Math.max(d, Math.abs(one.h[i] - many.h[i]));
    expect(d).toBe(0);
    expect(one.h.every(Number.isFinite)).toBe(true);
  });

  it('exposes the curve data and rejects unknown valve types', async () => {
    // The shipped library covers the documented set.
    expect(Object.keys(VALVE_CURVES).sort()).toEqual(['ball', 'butterfly', 'gate', 'globe', 'needle']);
    for (const t of TYPES) {
      const c = VALVE_CURVES[t];
      expect(c.X.length).toBe(c.Y.length);
      expect(c.X[0]).toBe(1); // fully open first
      expect(c.Y[c.Y.length - 1]).toBe(0); // shut → no flow
    }

    const sim = await PtsnetSimulation.create({ inp: INP, settings });
    expect(() =>
      // @ts-expect-error — exercising the runtime guard for non-TS callers
      sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, valveType: 'bogus' }),
    ).toThrow(/unknown valveType/);
  });
});
