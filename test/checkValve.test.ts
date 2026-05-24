import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';

/**
 * Ideal check valve at a degree-2 node: transparent to forward flow, shuts the
 * instant flow reverses. Scenario: a reservoir feeds a demand through two pipes
 * joined at J1; a rapid downstream valve closure drives the flow at J1 into
 * reversal. Without the check valve the flow swings negative; with it the flow
 * is held at zero.
 */
const INP = `[TITLE]
[JUNCTIONS]
 J1 0 0
 J2v 0 0
 J2 0 8
[RESERVOIRS]
 R1 50
[PIPES]
 P1 R1 J1 600 300 130 0 Open
 P2 J1 J2v 600 300 130 0 Open
[VALVES]
 V1 J2v J2 300 TCV 5 0
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;

const settings = { duration: 5, timeStep: 0.02, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' as const };

async function runClosure(useCheckValve: boolean) {
  const sim = await PtsnetSimulation.create({
    inp: INP,
    settings,
    recording: { nodes: ['J1'], pipes: ['P2'] },
  });
  if (useCheckValve) sim.addCheckValve('J1');
  const steadyQ = sim.ss.pipe.flowrate[sim.ss.pipe.index.get('P2')!];
  sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 1.4 });
  sim.run();
  return { q: sim.results.pipeStart.flowrate.get('P2'), steadyQ };
}

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

describe('check valve', () => {
  it('blocks backflow that the bare junction allows', async () => {
    const open = await runClosure(false);
    const cv = await runClosure(true);

    expect(open.q.every(Number.isFinite)).toBe(true);
    expect(cv.q.every(Number.isFinite)).toBe(true);

    const steady = open.steadyQ;
    expect(steady).toBeGreaterThan(0);

    // Without the check valve the flow at J1 reverses strongly.
    expect(min(open.q)).toBeLessThan(-0.3 * steady);
    // With the check valve it never meaningfully reverses.
    expect(min(cv.q)).toBeGreaterThan(-1e-9);

    // Forward flow is unimpeded — the open valve is transparent.
    expect(max(cv.q)).toBeCloseTo(max(open.q), 6);
  });

  it('is transparent at steady state (stays put with no operation)', async () => {
    const sim = await PtsnetSimulation.create({ inp: INP, settings, recording: { nodes: ['J1'], pipes: ['P2'] } });
    sim.addCheckValve('J1');
    sim.run(); // no valve operation -> steady
    const q = sim.results.pipeStart.flowrate.get('P2');
    const h = sim.results.node.head.get('J1');
    expect(max(q) - min(q)).toBeLessThan(1e-6);
    expect(max(h) - min(h)).toBeLessThan(1e-6);
  });

  it('rejects nodes that are not between two pipes', async () => {
    const sim = await PtsnetSimulation.create({ inp: INP, settings });
    expect(() => sim.addCheckValve('J2v')).toThrow(/between two pipes/); // on a valve
    expect(() => sim.addCheckValve('R1')).toThrow(); // reservoir
    expect(() => sim.addCheckValve('NOPE')).toThrow(/unknown node/);
    sim.addCheckValve('J1');
    expect(() => sim.addCheckValve('J1')).toThrow(/already has a check valve/);
  });
});
