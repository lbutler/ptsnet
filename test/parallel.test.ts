import { describe, it, expect } from 'vitest';
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

describe('parallel engine (worker_threads)', () => {
  it('hammer: parallel is bit-identical to serial', async () => {
    const serial = await PtsnetSimulation.create({
      inp: HAMMER_INP,
      settings: { duration: 4, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
    });
    serial.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.5, endTime: 1.0 });
    serial.run();

    const par = await PtsnetSimulation.create({
      inp: HAMMER_INP,
      settings: { duration: 4, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
      parallel: { workers: 4 },
    });
    par.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.5, endTime: 1.0 });
    par.run();

    for (const label of serial.results.node.head.labels) {
      expect(maxDiff(par.results.node.head.get(label), serial.results.node.head.get(label))).toBe(0);
    }
    for (const label of serial.results.pipeEnd.flowrate.labels) {
      expect(maxDiff(par.results.pipeEnd.flowrate.get(label), serial.results.pipeEnd.flowrate.get(label))).toBe(0);
    }
  });

  it('tnet3: parallel is bit-identical to serial', async () => {
    const opts = {
      inp: exampleInp('TNET3'),
      settings: { duration: 2, timeStep: 0.1, defaultWaveSpeed: 1000, waveSpeedMethod: 'optimal' as const },
    };
    const serial = await PtsnetSimulation.create(opts);
    serial.defineValveOperation('VALVE-179', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 2 });
    serial.run();

    const par = await PtsnetSimulation.create({ ...opts, parallel: { workers: 4 } });
    par.defineValveOperation('VALVE-179', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 2 });
    par.run();

    let worst = 0;
    for (const label of serial.results.node.head.labels) {
      worst = Math.max(worst, maxDiff(par.results.node.head.get(label), serial.results.node.head.get(label)));
    }
    expect(worst).toBe(0);
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
