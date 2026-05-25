import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';

/**
 * Combination air/vacuum valve at a high point. Layout: R1 → P1 → J1 (elevation
 * 30, the high point) → P2 → V1 (inline) → P3 → R2. Closing V1 sends a down-surge
 * to J1; without protection the head there plunges far below atmospheric. The air
 * valve admits air and holds the node near atmospheric (head ≈ elevation), with a
 * smaller orifice throttling more.
 */
const INP = `[TITLE]
[JUNCTIONS]
 J1 30 0
 J2 0 0
 J3 0 0
[RESERVOIRS]
 R1 40
 R2 20
[PIPES]
 P1 R1 J1 150 100 130 0 Open
 P2 J1 J2 150 100 130 0 Open
 P3 J3 R2 150 100 130 0 Open
[VALVES]
 V1 J2 J3 100 TCV 5 0
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;

const settings = { duration: 3, timeStep: 0.001, defaultWaveSpeed: 1200, waveSpeedMethod: 'user' as const };
const ATM = 30; // atmospheric head at J1 == its elevation

function min(a: Float64Array) {
  let m = Infinity;
  for (const v of a) m = Math.min(m, v);
  return m;
}

async function run(av?: { inflowArea: number; outflowArea?: number }, workers?: number) {
  const sim = await PtsnetSimulation.create({
    inp: INP,
    settings,
    recording: { nodes: ['J1'] },
    ...(workers ? { parallel: { workers } } : {}),
  });
  if (av) sim.addAirValve('J1', av);
  sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.1, endTime: 0.13 });
  sim.run();
  return sim.results.node.head.get('J1');
}

describe('air valve', () => {
  it('breaks the vacuum: holds a high point near atmospheric on the down-surge', async () => {
    const bare = await run();
    const valve = await run({ inflowArea: 0.02 });

    expect(bare.every(Number.isFinite)).toBe(true);
    expect(valve.every(Number.isFinite)).toBe(true);

    // Without protection the high point plunges far below atmospheric...
    expect(min(bare)).toBeLessThan(ATM - 30);
    // ...the air valve (large orifice) holds it at ~atmospheric.
    expect(min(valve)).toBeGreaterThan(ATM - 1);
    expect(min(valve)).toBeLessThan(ATM + 0.5);
  });

  it('a smaller orifice throttles more (lower minimum) but still protects', async () => {
    const big = await run({ inflowArea: 0.02 });
    const small = await run({ inflowArea: 0.0006 });
    expect(min(small)).toBeLessThan(min(big)); // more throttling
    expect(min(small)).toBeGreaterThan(ATM - 5); // still far above the unprotected plunge
  });

  it('is bit-identical across worker counts', async () => {
    const one = await run({ inflowArea: 0.01, outflowArea: 0.001 }, 1);
    const many = await run({ inflowArea: 0.01, outflowArea: 0.001 }, 4);
    let d = 0;
    for (let i = 0; i < one.length; i++) d = Math.max(d, Math.abs(one[i] - many[i]));
    expect(d).toBe(0);
    expect(one.every(Number.isFinite)).toBe(true);
  });

  it('validates placement', async () => {
    const sim = await PtsnetSimulation.create({ inp: INP, settings });
    expect(() => sim.addAirValve('NOPE', { inflowArea: 0.01 })).toThrow(/unknown node/);
    expect(() => sim.addAirValve('J2', { inflowArea: 0.01 })).toThrow(/between two pipes/); // valve node
    expect(() => sim.addAirValve('J1', { inflowArea: 0 })).toThrow(/inflowArea/);
    sim.addAirValve('J1', { inflowArea: 0.01 });
    expect(() => sim.addAirValve('J1', { inflowArea: 0.01 })).toThrow(/already has an air valve/);
  });
});
