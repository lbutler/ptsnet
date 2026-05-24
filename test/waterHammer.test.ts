import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';
import { G } from '../src/core/types';

// Reservoir - pipe - inline valve - pipe - reservoir. Closing the valve well
// within the pipe period (2L/a = 2 s) produces a Joukowsky surge of a*V0/g.
const HAMMER_INP = `[TITLE]
[JUNCTIONS]
 J1   0   0
 J2   0   0
[RESERVOIRS]
 R1   100
 R2   90
[PIPES]
 P1   R1   J1   1000   500   100   0   Open
 P2   J2   R2   1000   500   100   0   Open
[VALVES]
 V1  J1    J2    500  TCV  5       0
[OPTIONS]
 Units              LPS
 Headloss           H-W
[TIMES]
 Duration 0
[END]
`;

describe('Joukowsky water hammer', () => {
  it('reproduces the a*V0/g surge for rapid inline valve closure', async () => {
    const sim = await PtsnetSimulation.create({
      inp: HAMMER_INP,
      settings: { duration: 4, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
    });

    const ss = sim.ss;
    const p1 = ss.pipe.index.get('P1')!;
    const a = ss.pipe.waveSpeed[p1];
    const V0 = ss.pipe.flowrate[p1] / ss.pipe.area[p1];
    const joukowsky = (a * Math.abs(V0)) / G;

    // 'user' method with these numbers keeps the wave speed exactly 1000 m/s.
    expect(a).toBeCloseTo(1000, 6);
    expect(V0).toBeGreaterThan(0.5);

    sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.5, endTime: 1.0 });
    sim.run();

    const headJ1 = sim.results.node.head.get('J1');
    const h0 = headJ1[0];
    let peak = -Infinity;
    for (const h of headJ1) peak = Math.max(peak, h);
    const rise = peak - h0;

    // Surge magnitude must match Joukowsky within ~20%.
    expect(rise).toBeGreaterThan(0.85 * joukowsky);
    expect(rise).toBeLessThan(1.25 * joukowsky);
  });
});
