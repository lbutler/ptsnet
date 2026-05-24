import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';

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

const settings = { duration: 1, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' as const };

describe('streaming / progress / cancellation', () => {
  it('onStep fires once per computed step', async () => {
    const sim = await PtsnetSimulation.create({ inp: HAMMER_INP, settings });
    const steps: number[] = [];
    sim.run({ onStep: (s) => steps.push(s) });
    // Steps 1..timeSteps-1 are computed (step 0 is the initial condition).
    expect(steps.length).toBe(sim.settings.timeSteps - 1);
    expect(steps[0]).toBe(1);
    expect(steps[steps.length - 1]).toBe(sim.settings.timeSteps - 1);
  });

  it('onProgress is monotonic and reaches fraction 1', async () => {
    const sim = await PtsnetSimulation.create({ inp: HAMMER_INP, settings });
    const fractions: number[] = [];
    sim.run({ onProgress: (p) => fractions.push(p.fraction), progressInterval: 1 });
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  it('AbortSignal stops the run and keeps partial results', async () => {
    const sim = await PtsnetSimulation.create({ inp: HAMMER_INP, settings });
    const ctrl = new AbortController();
    let threw: unknown;
    try {
      sim.run({
        signal: ctrl.signal,
        onStep: (s) => {
          if (s === 5) ctrl.abort();
        },
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as Error)?.name).toBe('AbortError');
    expect(sim.currentStep).toBe(6); // computed steps 1..5, then aborted
    const h = sim.results.node.head.get('J1');
    expect(h[5]).not.toBe(0); // step 5 was computed
    expect(h[h.length - 1]).toBe(0); // later steps were not
  });

  it('a pre-aborted signal throws immediately', async () => {
    const sim = await PtsnetSimulation.create({ inp: HAMMER_INP, settings });
    expect(() => sim.run({ signal: AbortSignal.abort() })).toThrow();
  });

  it('runAsync supports progress and abort', async () => {
    const sim = await PtsnetSimulation.create({ inp: HAMMER_INP, settings });
    const ctrl = new AbortController();
    let last = 0;
    await expect(
      sim.runAsync({
        signal: ctrl.signal,
        onProgress: (p) => {
          last = p.step;
        },
        onStep: (s) => {
          if (s === 3) ctrl.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(last).toBeGreaterThan(0);
    expect(sim.currentStep).toBe(4);
  });
});
