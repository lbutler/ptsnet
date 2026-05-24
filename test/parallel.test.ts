import { describe, it, expect, vi } from 'vitest';
import { PtsnetSimulation } from '../src/index';
import { exampleInp } from './fixtures';

const HAMMER_INP = `[TITLE]
[JUNCTIONS]
 J1 0 0
 J2 0 0
[RESERVOIRS]
 R1 100
 R2 90
[PIPES]
 P1 R1 J1 1000 500 100 0 Open
 P2 J2 R2 1000 500 100 0 Open
[VALVES]
 V1 J1 J2 500 TCV 5 0
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;

function maxDiff(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

async function runHammer(workers: number) {
  const sim = await PtsnetSimulation.create({
    inp: HAMMER_INP,
    settings: { duration: 4, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
    parallel: { workers },
  });
  sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.5, endTime: 1.0 });
  sim.run();
  return sim;
}

describe('the (parallel) engine', () => {
  it('hammer: result is independent of worker count', async () => {
    const one = await runHammer(1);
    const many = await runHammer(4);
    for (const label of one.results.node.head.labels) {
      expect(maxDiff(many.results.node.head.get(label), one.results.node.head.get(label))).toBe(0);
    }
    for (const label of one.results.pipeEnd.flowrate.labels) {
      expect(
        maxDiff(many.results.pipeEnd.flowrate.get(label), one.results.pipeEnd.flowrate.get(label)),
      ).toBe(0);
    }
  });

  it('tnet3: result is independent of worker count', async () => {
    const opts = {
      inp: exampleInp('TNET3'),
      settings: { duration: 2, timeStep: 0.1, defaultWaveSpeed: 1000, waveSpeedMethod: 'optimal' as const },
    };
    const one = await PtsnetSimulation.create({ ...opts, parallel: { workers: 1 } });
    one.defineValveOperation('VALVE-179', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 2 });
    one.run();

    const many = await PtsnetSimulation.create({ ...opts, parallel: { workers: 4 } });
    many.defineValveOperation('VALVE-179', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 2 });
    many.run();

    let worst = 0;
    for (const label of one.results.node.head.labels) {
      worst = Math.max(worst, maxDiff(many.results.node.head.get(label), one.results.node.head.get(label)));
    }
    expect(worst).toBe(0);
  });

  it('runAsync (Atomics.waitAsync) matches the synchronous run', async () => {
    const sync = await runHammer(4);

    const asyncSim = await PtsnetSimulation.create({
      inp: HAMMER_INP,
      settings: { duration: 4, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
      parallel: { workers: 4 },
    });
    asyncSim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.5, endTime: 1.0 });
    await asyncSim.runAsync();

    for (const label of sync.results.node.head.labels) {
      expect(maxDiff(asyncSim.results.node.head.get(label), sync.results.node.head.get(label))).toBe(0);
    }
  });

  it('throws when SharedArrayBuffer-backed workers are unavailable', async () => {
    vi.stubGlobal('crossOriginIsolated', false); // simulate a non-isolated browser page
    try {
      await expect(
        PtsnetSimulation.create({
          inp: HAMMER_INP,
          settings: { duration: 2, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
        }),
      ).rejects.toThrow(/SharedArrayBuffer/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('works with recording options and disposes cleanly', async () => {
    const sim = await PtsnetSimulation.create({
      inp: HAMMER_INP,
      settings: { duration: 2, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
      parallel: { workers: 2 },
      recording: { nodes: ['J1'], pipes: 'none', envelope: true },
    });
    sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.5, endTime: 1.0 });
    sim.run(); // auto-disposes the pool
    expect(sim.results.node.head.labels).toEqual(['J1']);
    expect(sim.envelope).toBeDefined();
    expect(sim.results.node.head.get('J1').every(Number.isFinite)).toBe(true);
    sim.dispose(); // idempotent
  });
});
