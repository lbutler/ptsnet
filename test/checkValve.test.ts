import { describe, it, expect, vi } from 'vitest';
import { PtsnetSimulation } from '../src/index';

/**
 * Check valves are a pipe property (matching EPANET's CV pipes). A valve passes
 * flow in the steady-state direction and shuts the instant flow reverses; it's
 * enforced at an end node of the pipe that joins exactly two pipes. Scenario: a
 * reservoir feeds a demand through P1 + P2 joined at J1; a rapid downstream valve
 * closure drives the flow at J1 into reversal.
 */
function inp(p1status: string): string {
  return `[TITLE]
[JUNCTIONS]
 J1 0 0
 J2v 0 0
 J2 0 8
[RESERVOIRS]
 R1 50
[PIPES]
 P1 R1 J1 600 300 130 0 ${p1status}
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
}

const settings = { duration: 5, timeStep: 0.02, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' as const };

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

async function runClosure(opts: { status?: string; api?: boolean } = {}) {
  const sim = await PtsnetSimulation.create({
    inp: inp(opts.status ?? 'Open'),
    settings,
    recording: { nodes: ['J1'], pipes: ['P2'] },
  });
  if (opts.api) sim.addCheckValve('P1');
  const steadyQ = sim.ss.pipe.flowrate[sim.ss.pipe.index.get('P2')!];
  sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 1.4 });
  sim.run();
  return { q: sim.results.pipeStart.flowrate.get('P2'), steadyQ };
}

describe('check valve', () => {
  it('blocks backflow that the bare junction allows (pipe API)', async () => {
    const open = await runClosure();
    const cv = await runClosure({ api: true });

    expect(open.q.every(Number.isFinite)).toBe(true);
    expect(cv.q.every(Number.isFinite)).toBe(true);

    const steady = open.steadyQ;
    expect(steady).toBeGreaterThan(0);
    expect(min(open.q)).toBeLessThan(-0.3 * steady); // bare junction reverses
    expect(min(cv.q)).toBeGreaterThan(-1e-9); // check valve holds it shut
    expect(max(cv.q)).toBeCloseTo(max(open.q), 6); // transparent to forward flow
  });

  it('honors EPANET CV-status pipes automatically (no API call)', async () => {
    const sim = await PtsnetSimulation.create({ inp: inp('CV'), settings, recording: { pipes: ['P2'] } });
    expect(sim.ss.pipe.isCheckValve[sim.ss.pipe.index.get('P1')!]).toBe(1);
    sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 1.4 });
    sim.run();
    expect(min(sim.results.pipeStart.flowrate.get('P2'))).toBeGreaterThan(-1e-9);
  });

  it('is transparent at steady state (stays put with no operation)', async () => {
    const sim = await PtsnetSimulation.create({ inp: inp('Open'), settings, recording: { nodes: ['J1'], pipes: ['P2'] } });
    sim.addCheckValve('P1');
    sim.run(); // no operation -> steady
    const q = sim.results.pipeStart.flowrate.get('P2');
    const h = sim.results.node.head.get('J1');
    expect(max(q) - min(q)).toBeLessThan(1e-6);
    expect(max(h) - min(h)).toBeLessThan(1e-6);
  });

  it('throws on an unknown pipe', async () => {
    const sim = await PtsnetSimulation.create({ inp: inp('Open'), settings });
    expect(() => sim.addCheckValve('NOPE')).toThrow(/unknown pipe/);
  });

  it('warns and falls back to a plain pipe when it cannot be placed', async () => {
    // P1 -> J1 -> V1: J1 is a valve node, R1 a reservoir, so neither end of P1 can host the check.
    const noPlace = `[TITLE]
[JUNCTIONS]
 J1 0 0
 J2 0 8
[RESERVOIRS]
 R1 50
[PIPES]
 P1 R1 J1 600 300 130 0 CV
[VALVES]
 V1 J1 J2 300 TCV 5 0
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sim = await PtsnetSimulation.create({
        inp: noPlace,
        settings: { ...settings, warningsOn: true },
        recording: { pipes: ['P1'] },
      });
      sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 1.4 });
      sim.run();
      expect(warn.mock.calls.some((c) => /check valve on pipe 'P1' could not be placed/.test(String(c[0])))).toBe(true);
      // With no usable check, the pipe behaves normally and flow still reverses.
      expect(min(sim.results.pipeStart.flowrate.get('P1'))).toBeLessThan(0);
    } finally {
      warn.mockRestore();
    }
  });
});
