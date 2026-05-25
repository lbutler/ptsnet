import { describe, it, expect, vi } from 'vitest';
import { PtsnetSimulation } from '../src/index';

/**
 * Pump trip with rotational inertia. A pump lifts water from R1 (10 m) up to
 * R2 (40 m) through P1; on power failure the speed coasts down on its inertia,
 * the pump keeps delivering decaying head/flow, and its discharge check valve
 * blocks backflow once the lift can no longer be sustained. Forward-quadrant
 * model (Wylie & Streeter / Chaudhry).
 */
const INP = `[TITLE]
[JUNCTIONS]
 J1 0 0
[RESERVOIRS]
 R1 10
 R2 40
[PIPES]
 P1 J1 R2 1000 500 130 0 Open
[PUMPS]
 PU1 R1 J1 HEAD C1
[CURVES]
 C1 0 60
 C1 100 50
 C1 200 30
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;

const settings = { duration: 6, timeStep: 0.02, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' as const };
const dt = settings.timeStep;

function min(a: Float64Array) {
  let m = Infinity;
  for (const v of a) m = Math.min(m, v);
  return m;
}
const at = (a: Float64Array, t: number) => a[Math.round(t / dt)];

type Trip = { inertia: number } | 'instant';

async function run(trip: Trip, workers?: number) {
  const sim = await PtsnetSimulation.create({
    inp: INP,
    settings,
    recording: { nodes: ['J1'], pipes: ['P1'] },
    ...(workers ? { parallel: { workers } } : {}),
  });
  const q0 = sim.ss.pipe.flowrate[sim.ss.pipe.index.get('P1')!];
  if (trip === 'instant') {
    sim.definePumpOperation('PU1', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 1.04 });
  } else {
    sim.definePumpTrip('PU1', { tripTime: 1, inertia: trip.inertia, ratedSpeed: 1450, ratedEfficiency: 0.8 });
  }
  sim.run();
  return { q: sim.results.pipeStart.flowrate.get('P1'), h: sim.results.node.head.get('J1'), q0 };
}

describe('pump trip with inertia', () => {
  it('coasts down (not instant) and blocks backflow', async () => {
    const cd = await run({ inertia: 5 });
    expect(cd.q.every(Number.isFinite)).toBe(true);
    expect(cd.q0).toBeGreaterThan(0);

    // Just after the trip the pump is still delivering most of its flow...
    expect(at(cd.q, 1.1)).toBeGreaterThan(0.6 * cd.q0);
    // ...then the flow decays.
    expect(at(cd.q, 3)).toBeLessThan(0.85 * cd.q0);
    // The discharge check valve prevents backflow.
    expect(min(cd.q)).toBeGreaterThan(-1e-9);
  });

  it('larger inertia decays slower and softens the down-surge', async () => {
    const small = await run({ inertia: 5 });
    const large = await run({ inertia: 50 });
    const instant = await run('instant');

    // Bigger inertia keeps the flow up longer.
    expect(at(large.q, 3)).toBeGreaterThan(at(small.q, 3));
    // Inertia softens the J1 down-surge: instant trip is the most severe.
    expect(min(small.h)).toBeGreaterThan(min(instant.h));
    expect(min(large.h)).toBeGreaterThan(min(small.h));

    for (const r of [small, large, instant]) {
      expect(r.q.every(Number.isFinite)).toBe(true);
      expect(min(r.q)).toBeGreaterThan(-1e-9); // forward-only (all pumps)
    }
  });

  it('is bit-identical across worker counts', async () => {
    const one = await run({ inertia: 5 }, 1);
    const many = await run({ inertia: 5 }, 4);
    let d = 0;
    for (let i = 0; i < one.h.length; i++) d = Math.max(d, Math.abs(one.h[i] - many.h[i]));
    expect(d).toBe(0);
  });

  it('warns when efficiency/power is omitted (uses 0.8)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sim = await PtsnetSimulation.create({
        inp: INP,
        settings: { ...settings, warningsOn: true },
        recording: { pipes: ['P1'] },
      });
      sim.definePumpTrip('PU1', { tripTime: 1, inertia: 5, ratedSpeed: 1450 });
      sim.run();
      expect(warn.mock.calls.some((c) => /efficiency not given/.test(String(c[0])))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('validates inputs and rejects trip + schedule on the same pump', async () => {
    const a = await PtsnetSimulation.create({ inp: INP, settings });
    expect(() => a.definePumpTrip('NOPE', { tripTime: 1, inertia: 5, ratedSpeed: 1450 })).toThrow(/unknown pump/);
    expect(() => a.definePumpTrip('PU1', { tripTime: 1, inertia: 0, ratedSpeed: 1450 })).toThrow(/inertia/);

    const b = await PtsnetSimulation.create({ inp: INP, settings });
    b.definePumpTrip('PU1', { tripTime: 1, inertia: 5, ratedSpeed: 1450, ratedEfficiency: 0.8 });
    b.definePumpOperation('PU1', { initialSetting: 1, finalSetting: 0, startTime: 2, endTime: 3 });
    expect(() => b.run()).toThrow(/both a trip and a speed schedule/);
  });
});
