import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';

/**
 * One-way surge tank at a high point. Layout (shared with the air-valve case):
 * R1 → P1 → J1 (elevation 30, the high point) → P2 → J2 → V1 (inline) → P3 → R2.
 * Closing V1 swings J1 hard — a deep down-surge and a large up-surge. A one-way
 * surge tank at J1 feeds the line through its check valve while the head is below
 * the tank water level, capping the down-surge near that level; but the check
 * valve is shut on the up-surge, so it passes through (unlike a plain open tank,
 * which damps both directions).
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

function min(a: Float64Array) {
  let m = Infinity;
  for (const v of a) m = Math.min(m, v);
  return m;
}
function max(a: Float64Array) {
  let m = -Infinity;
  for (const v of a) m = Math.max(m, v);
  return m;
}

async function run(
  setup?: (sim: PtsnetSimulation) => void,
  opts?: { workers?: number; cavitation?: boolean },
) {
  const sim = await PtsnetSimulation.create({
    inp: INP,
    settings,
    recording: { nodes: ['J1'] },
    ...(opts?.cavitation ? { cavitation: true } : {}),
    ...(opts?.workers ? { parallel: { workers: opts.workers } } : {}),
  });
  setup?.(sim);
  sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.1, endTime: 0.13 });
  sim.run();
  return sim.results.node.head.get('J1');
}

describe('one-way surge tank', () => {
  it('caps the down-surge near the tank level', async () => {
    const bare = await run();
    const guarded = await run((s) => s.addOneWaySurgeTank('J1', { tankArea: 5 }));
    const steady = bare[0];

    expect(bare.every(Number.isFinite)).toBe(true);
    expect(guarded.every(Number.isFinite)).toBe(true);

    // Without protection the high point plunges far below the steady head...
    expect(min(bare)).toBeLessThan(steady - 100);
    // ...the one-way tank feeds the line and holds it near the (steady) tank level.
    expect(min(guarded)).toBeGreaterThan(steady - 1);
  });

  it('feeds the down-surge like an open tank but passes the up-surge (check valve shut)', async () => {
    const bare = await run();
    const oneWay = await run((s) => s.addOneWaySurgeTank('J1', { tankArea: 5 }));
    const open = await run((s) => s.addSurgeProtection('J1', 'open', 5));
    const steady = bare[0];

    // Both cap the down-surge (feed the line) to roughly the tank level.
    expect(min(oneWay)).toBeGreaterThan(steady - 1);
    expect(min(open)).toBeGreaterThan(steady - 1);

    // The open tank also absorbs the up-surge (peak pinned near the tank level),
    // while the one-way tank's check valve is shut on the up-surge so it passes
    // through essentially unchanged from the unprotected run.
    expect(max(open)).toBeLessThan(steady + 1);
    expect(max(oneWay)).toBeGreaterThan(steady + 100);
    expect(Math.abs(max(oneWay) - max(bare))).toBeLessThan(0.01);
  });

  it('an undersized tank drains and protects less', async () => {
    const bare = await run();
    const big = await run((s) => s.addOneWaySurgeTank('J1', { tankArea: 5 }));
    const tiny = await run((s) => s.addOneWaySurgeTank('J1', { tankArea: 0.01 }));

    // The small tank empties mid-down-surge and then stops feeding, so it caps
    // the surge less than the large one — but still does something.
    expect(min(tiny)).toBeLessThan(min(big));
    expect(min(tiny)).toBeGreaterThan(min(bare));
    expect(tiny.every(Number.isFinite)).toBe(true);
  });

  it('stays shut (bit-identical to no tank) when the tank level is below the down-surge', async () => {
    const bare = await run();
    const lo = min(bare);
    // Tank level set below the deepest down-surge: the check valve never opens.
    const shut = await run((s) =>
      s.addOneWaySurgeTank('J1', { tankArea: 5, initialLevel: lo - 1, bottomLevel: lo - 2 }),
    );
    let d = 0;
    for (let i = 0; i < bare.length; i++) d = Math.max(d, Math.abs(bare[i] - shut[i]));
    expect(d).toBe(0);
  });

  it('is bit-identical across worker counts', async () => {
    const setup = (s: PtsnetSimulation) => s.addOneWaySurgeTank('J1', { tankArea: 5, refillArea: 0.001 });
    const one = await run(setup, { workers: 1 });
    const many = await run(setup, { workers: 4 });
    let d = 0;
    for (let i = 0; i < one.length; i++) d = Math.max(d, Math.abs(one[i] - many[i]));
    expect(d).toBe(0);
    expect(one.every(Number.isFinite)).toBe(true);
  });

  it('composes with column separation (cavitation)', async () => {
    const bareCav = await run(undefined, { cavitation: true });
    const guardedCav = await run((s) => s.addOneWaySurgeTank('J1', { tankArea: 5 }), { cavitation: true });
    expect(bareCav.every(Number.isFinite)).toBe(true);
    expect(guardedCav.every(Number.isFinite)).toBe(true);
    // The tank feeds the line and lifts the down-surge above the vapor clamp.
    expect(min(guardedCav)).toBeGreaterThan(min(bareCav));
  });

  it('validates placement and parameters', async () => {
    const sim = await PtsnetSimulation.create({ inp: INP, settings });
    expect(() => sim.addOneWaySurgeTank('NOPE', { tankArea: 5 })).toThrow(/unknown node/);
    expect(() => sim.addOneWaySurgeTank('J2', { tankArea: 5 })).toThrow(/between two pipes/); // valve node
    expect(() => sim.addOneWaySurgeTank('J1', { tankArea: 0 })).toThrow(/tankArea/);
    expect(() => sim.addOneWaySurgeTank('J1', { tankArea: 5, initialLevel: 30, bottomLevel: 35 })).toThrow(
      /bottomLevel/,
    );
    sim.addOneWaySurgeTank('J1', { tankArea: 5 });
    expect(() => sim.addOneWaySurgeTank('J1', { tankArea: 5 })).toThrow(/already has/);
  });
});
