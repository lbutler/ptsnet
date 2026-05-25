import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';

/**
 * Surge-relief valve. Layout: R1 (head 48) → P1 → J1 (elevation 0, the SRV node)
 * → P2 → J2 → V1 (inline, throttled) → P3 → R2 (head 40). Flow runs R1 → R2;
 * closing V1 sends an up-surge up the line and J1 (upstream of the valve) climbs
 * well above its steady head. A surge-relief valve at J1 opens once the gauge head
 * passes the setpoint, vents to atmosphere, and caps the peak near it. Elevation 0
 * makes gauge head == total head, so the setpoint reads directly off the series.
 */
const INP = `[TITLE]
[JUNCTIONS]
 J1 0 0
 J2 0 0
 J3 0 0
[RESERVOIRS]
 R1 48
 R2 40
[PIPES]
 P1 R1 J1 150 100 130 0 Open
 P2 J1 J2 150 100 130 0 Open
 P3 J3 R2 150 100 130 0 Open
[VALVES]
 V1 J2 J3 100 TCV 500 0
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;

const settings = { duration: 3, timeStep: 0.001, defaultWaveSpeed: 1200, waveSpeedMethod: 'user' as const };

type SrvOpts = { setpoint: number; area: number; openTime?: number; closeTime?: number; reseat?: number };

function max(a: Float64Array) {
  let m = -Infinity;
  for (const v of a) m = Math.max(m, v);
  return m;
}

async function run(srv?: SrvOpts, workers?: number) {
  const sim = await PtsnetSimulation.create({
    inp: INP,
    settings,
    recording: { nodes: ['J1'] },
    ...(workers ? { parallel: { workers } } : {}),
  });
  if (srv) sim.addSurgeReliefValve('J1', srv);
  sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.1, endTime: 0.3 });
  sim.run();
  return sim.results.node.head.get('J1');
}

describe('surge-relief valve', () => {
  it('caps the up-surge near the setpoint', async () => {
    const bare = await run();
    const steady = bare[0];
    const peak = max(bare);
    expect(bare.every(Number.isFinite)).toBe(true);
    expect(peak).toBeGreaterThan(steady + 10); // the closure really does over-pressurize J1

    const setpoint = steady + 0.4 * (peak - steady); // gauge head == total head here (elevation 0)
    const guarded = await run({ setpoint, area: 0.02, openTime: 0.02, closeTime: 0.05, reseat: setpoint - 2 });

    expect(guarded.every(Number.isFinite)).toBe(true);
    expect(max(guarded)).toBeLessThan(peak - 10); // the valve relieves the peak
    expect(max(guarded)).toBeLessThan(setpoint + 0.3 * (peak - setpoint)); // and holds it near the setpoint
  });

  it('an undersized orifice cannot hold the setpoint; an adequate one can', async () => {
    const bare = await run();
    const setpoint = bare[0] + 0.4 * (max(bare) - bare[0]);
    const tiny = await run({ setpoint, area: 0.0002 });
    const big = await run({ setpoint, area: 0.02 });
    expect(max(tiny)).toBeGreaterThan(setpoint); // too small to vent the surge → overshoots
    expect(max(big)).toBeLessThan(setpoint + 0.5); // adequately sized → pinned at the setpoint
    expect(max(big)).toBeLessThan(max(tiny)); // more relief area caps harder
  });

  it('stays shut (bit-identical to no valve) when the setpoint is above the peak', async () => {
    const bare = await run();
    const above = await run({ setpoint: max(bare) + 10, area: 0.02 });
    let d = 0;
    for (let i = 0; i < bare.length; i++) d = Math.max(d, Math.abs(bare[i] - above[i]));
    expect(d).toBe(0);
  });

  it('is bit-identical across worker counts', async () => {
    const srv: SrvOpts = { setpoint: 65, area: 0.02, openTime: 0.02, closeTime: 0.05, reseat: 63 };
    const one = await run(srv, 1);
    const many = await run(srv, 4);
    let d = 0;
    for (let i = 0; i < one.length; i++) d = Math.max(d, Math.abs(one[i] - many[i]));
    expect(d).toBe(0);
    expect(one.every(Number.isFinite)).toBe(true);
  });

  it('validates placement', async () => {
    const sim = await PtsnetSimulation.create({ inp: INP, settings });
    expect(() => sim.addSurgeReliefValve('NOPE', { setpoint: 65, area: 0.02 })).toThrow(/unknown node/);
    expect(() => sim.addSurgeReliefValve('J2', { setpoint: 65, area: 0.02 })).toThrow(/between two pipes/); // valve node
    expect(() => sim.addSurgeReliefValve('J1', { setpoint: 65, area: 0 })).toThrow(/area/);
    expect(() => sim.addSurgeReliefValve('J1', { setpoint: 65, area: 0.02, reseat: 70 })).toThrow(/reseat/);
    sim.addSurgeReliefValve('J1', { setpoint: 65, area: 0.02 });
    expect(() => sim.addSurgeReliefValve('J1', { setpoint: 65, area: 0.02 })).toThrow(/already has/);
  });
});
