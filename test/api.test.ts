import { describe, it, expect } from 'vitest';
import { PtsnetSimulation, deserializeResults } from '../src/index';

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

describe('manual real-time control', () => {
  it('setValveSetting mid-run excites a transient', async () => {
    const sim = await PtsnetSimulation.create({
      inp: HAMMER_INP,
      settings: { duration: 4, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
    });

    let h0 = 0;
    while (!sim.isOver) {
      const tSeconds = sim.currentStep * sim.settings.timeStep;
      // Linearly close V1 between t = 0.5 s and t = 1.0 s.
      if (sim.currentStep > 0) {
        if (tSeconds <= 0.5) sim.setValveSetting('V1', 1);
        else if (tSeconds >= 1.0) sim.setValveSetting('V1', 0);
        else sim.setValveSetting('V1', 1 - (tSeconds - 0.5) / 0.5);
      }
      sim.runStep();
      if (h0 === 0) h0 = sim.results.node.head.at('J1', 0);
    }

    const head = sim.results.node.head.get('J1');
    let peak = -Infinity;
    for (const h of head) peak = Math.max(peak, h);
    // Manual closure must raise the upstream head well above steady state.
    expect(peak - h0).toBeGreaterThan(50);
    expect(head.every(Number.isFinite)).toBe(true);
  });

  it('rejects out-of-range settings and uninitialized control', async () => {
    const sim = await PtsnetSimulation.create({ inp: HAMMER_INP, settings: { duration: 1, timeStep: 0.05 } });
    expect(() => sim.setValveSetting('V1', 0.5)).toThrow(/not been initialized/);
    sim.runStep();
    expect(() => sim.setValveSetting('V1', 2)).toThrow(/\[0, 1\]/);
  });
});

describe('results serialization', () => {
  it('round-trips through serialize/deserialize', async () => {
    const sim = await PtsnetSimulation.create({
      inp: HAMMER_INP,
      settings: { duration: 1, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
    });
    sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.2, endTime: 0.6 });
    sim.run();

    const json = JSON.parse(JSON.stringify(sim.serializeResults()));
    const { results, time } = deserializeResults(json);

    expect(Array.from(time)).toEqual(Array.from(sim.time));
    const a = sim.results.node.head.get('J1');
    const b = results.node.head.get('J1');
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(results.pipeStart.flowrate.labels).toEqual(sim.results.pipeStart.flowrate.labels);
  });
});
