import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';

/**
 * Enhancements to the open surge tank (`addSurgeProtection(..., 'open', ...)`):
 * a throttling orifice at the connection, a finite standpipe height that
 * overflows at `maxLevel`, and an empty level `minLevel` below which it runs dry.
 *
 * Two scenarios are used. The DRAIN net (a reservoir feeding a downstream demand;
 * a burst at J2 makes the tank node JT down-surge and the tank *feed* the line,
 * draining it) exercises the orifice and the empty/run-dry behaviour. The FILL
 * net (closing a downstream valve up-surges the high point J1, *filling* the tank)
 * exercises overflow.
 */
const DRAIN_INP = `[TITLE]
[JUNCTIONS]
 JT 0 0
 J2 0 50
[RESERVOIRS]
 R1 100
[PIPES]
 P1 R1 JT 1000 500 100 0 Open
 P2 JT J2 1000 500 100 0 Open
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;

const FILL_INP = `[TITLE]
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

const drainSettings = { duration: 6, timeStep: 0.002, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' as const };
const fillSettings = { duration: 3, timeStep: 0.001, defaultWaveSpeed: 1200, waveSpeedMethod: 'user' as const };

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

async function drain(
  setup?: (sim: PtsnetSimulation) => void,
  opts?: { workers?: number; cavitation?: boolean },
) {
  const sim = await PtsnetSimulation.create({
    inp: DRAIN_INP,
    settings: drainSettings,
    recording: { nodes: ['JT'] },
    ...(opts?.cavitation ? { cavitation: true } : {}),
    ...(opts?.workers ? { parallel: { workers: opts.workers } } : {}),
  });
  setup?.(sim);
  sim.addBurst('J2', 0.06, 0.5, 0.7); // extra downstream demand → JT down-surge → tank feeds
  sim.run();
  return sim.results.node.head.get('JT');
}

async function fill(setup?: (sim: PtsnetSimulation) => void) {
  const sim = await PtsnetSimulation.create({
    inp: FILL_INP,
    settings: fillSettings,
    recording: { nodes: ['J1'] },
  });
  setup?.(sim);
  sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.1, endTime: 0.13 });
  sim.run();
  return sim.results.node.head.get('J1');
}

describe('open surge tank enhancements', () => {
  it('a throttling orifice reduces protection (deeper surge at the node)', async () => {
    const bare = await drain();
    const plain = await drain((s) => s.addSurgeProtection('JT', 'open', 0.5));
    const throttled = await drain((s) =>
      s.addSurgeProtection('JT', 'open', 0.5, undefined, undefined, { orificeArea: 0.05 }),
    );
    expect(throttled.every(Number.isFinite)).toBe(true);

    // The orifice head loss decouples the tank from the line: the node down-surges
    // deeper than with a direct connection, but still far less than unprotected.
    expect(min(throttled)).toBeLessThan(min(plain));
    expect(min(throttled)).toBeGreaterThan(min(bare));
  });

  it('a very large orifice approaches a plain (direct) open tank', async () => {
    const plain = await drain((s) => s.addSurgeProtection('JT', 'open', 0.5));
    const open = await drain((s) =>
      s.addSurgeProtection('JT', 'open', 0.5, undefined, undefined, { orificeArea: 50 }),
    );
    let d = 0;
    for (let i = 0; i < plain.length; i++) d = Math.max(d, Math.abs(plain[i] - open[i]));
    expect(d).toBeLessThan(0.01); // a near-frictionless orifice ≈ direct connection
  });

  it('runs dry at minLevel and then stops feeding (less protection once empty)', async () => {
    const plain = await drain((s) => s.addSurgeProtection('JT', 'open', 0.5));
    const steady = plain[0];
    // minLevel set above where the bottomless tank would settle: it empties mid
    // down-surge, the check on water availability stops the feed, and the node
    // resumes plunging — so it protects less than the bottomless tank.
    const empty = await drain((s) =>
      s.addSurgeProtection('JT', 'open', 0.5, undefined, undefined, { minLevel: steady - 2 }),
    );
    expect(empty.every(Number.isFinite)).toBe(true);
    expect(min(plain)).toBeLessThan(steady - 2); // the bottomless tank drains past minLevel...
    expect(min(empty)).toBeLessThan(min(plain)); // ...so the limited tank empties and protects less
  });

  it('overflows at maxLevel (caps the up-surge near the standpipe top)', async () => {
    const plain = await fill((s) => s.addSurgeProtection('J1', 'open', 0.1));
    const steady = plain[0];
    const cap = steady + 0.2;
    const overflow = await fill((s) =>
      s.addSurgeProtection('J1', 'open', 0.1, undefined, undefined, { maxLevel: cap }),
    );
    expect(overflow.every(Number.isFinite)).toBe(true);

    // The bottomless standpipe fills above the cap; the finite one spills there.
    expect(max(plain)).toBeGreaterThan(cap);
    expect(max(overflow)).toBeLessThanOrEqual(cap + 1e-6);
    expect(max(overflow)).toBeLessThan(max(plain));
  });

  it('honors a custom initialLevel (starts the tank off-equilibrium)', async () => {
    const plain = await drain((s) => s.addSurgeProtection('JT', 'open', 0.5));
    const steady = plain[0];
    // Seed the tank 5 m above the steady line: it starts the node high and drains
    // toward equilibrium, so the peak head clearly exceeds the equilibrium tank.
    const high = await drain((s) =>
      s.addSurgeProtection('JT', 'open', 0.5, undefined, undefined, { initialLevel: steady + 5 }),
    );
    expect(high.every(Number.isFinite)).toBe(true);
    expect(max(high)).toBeGreaterThan(steady + 4);
    expect(max(plain)).toBeLessThan(steady + 1);
  });

  it('is bit-identical across worker counts', async () => {
    const setup = (s: PtsnetSimulation) =>
      s.addSurgeProtection('JT', 'open', 0.5, undefined, undefined, {
        orificeArea: 0.05,
        minLevel: 97,
        maxLevel: 101,
      });
    const one = await drain(setup, { workers: 1 });
    const many = await drain(setup, { workers: 4 });
    let d = 0;
    for (let i = 0; i < one.length; i++) d = Math.max(d, Math.abs(one[i] - many[i]));
    expect(d).toBe(0);
    expect(one.every(Number.isFinite)).toBe(true);
  });

  it('composes with column separation (cavitation)', async () => {
    const bareCav = await drain(undefined, { cavitation: true });
    const guardedCav = await drain((s) => s.addSurgeProtection('JT', 'open', 0.5), {
      cavitation: true,
    });
    expect(bareCav.every(Number.isFinite)).toBe(true);
    expect(guardedCav.every(Number.isFinite)).toBe(true);
    // The tank feeds the line and lifts the down-surge above the vapor clamp.
    expect(min(guardedCav)).toBeGreaterThan(min(bareCav));
  });

  it('validates placement and parameters', async () => {
    const sim = await PtsnetSimulation.create({ inp: FILL_INP, settings: fillSettings });
    expect(() => sim.addSurgeProtection('NOPE', 'open', 1)).toThrow(/unknown node/);
    expect(() => sim.addSurgeProtection('J2', 'open', 1)).toThrow(/between two pipes/); // valve node
    expect(() => sim.addSurgeProtection('J1', 'open', 0)).toThrow(/tankArea/);
    expect(() =>
      sim.addSurgeProtection('J1', 'open', 1, undefined, undefined, { orificeArea: -1 }),
    ).toThrow(/orificeArea/);
    expect(() =>
      sim.addSurgeProtection('J1', 'open', 1, undefined, undefined, { minLevel: 40, maxLevel: 35 }),
    ).toThrow(/minLevel < maxLevel/);
    expect(() =>
      sim.addSurgeProtection('J1', 'open', 1, undefined, undefined, {
        initialLevel: 100,
        maxLevel: 50,
      }),
    ).toThrow(/initialLevel/);
    // Enhancement options are open-only.
    expect(() =>
      sim.addSurgeProtection('J1', 'closed', 1, 5, 2, { orificeArea: 0.01 }),
    ).toThrow(/only to open tanks/);

    sim.addSurgeProtection('J1', 'open', 1, undefined, undefined, { orificeArea: 0.01 });
    expect(() => sim.addSurgeProtection('J1', 'open', 1)).toThrow(/already has/);
  });
});
