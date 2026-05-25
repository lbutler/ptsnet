import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';

/**
 * A single (end) valve discharges to atmosphere: Q = K0·√(2gH) with H the gauge
 * head, valid only for H ≥ 0. On a rapid closure the down-surge drives the valve
 * head below atmospheric; the old kernel evaluated √ of a negative head → NaN,
 * which poisoned the whole network. The correct boundary condition there is
 * Q = 0 with the valve point reflecting as a dead end (H = Cp). This guards that
 * regression while leaving normal (positive-head) operation unchanged.
 */
const INP = `[TITLE]
[JUNCTIONS]
 J1 0 0
 J2 0 0.115
[RESERVOIRS]
 R1 22
[PIPES]
 P1 R1 J1 37.23 22.1 150 0 Open
[VALVES]
 V1 J1 J2 22.1 TCV 5 0
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;
const G = 9.807;

describe('single (end) valve at sub-atmospheric head', () => {
  it('stays finite on a rapid closure (no sqrt-of-negative NaN)', async () => {
    const sim = await PtsnetSimulation.create({
      inp: INP,
      settings: { duration: 0.5, timeStep: 0.0005, defaultWaveSpeed: 1319, waveSpeedMethod: 'user' },
      recording: { nodes: ['J1'], pipes: ['P1'] },
    });
    const area = (Math.PI * 0.0221 ** 2) / 4;
    const v0 = sim.ss.pipe.flowrate[0] / area;
    const a = sim.ss.pipe.waveSpeed[0];
    const steady = sim.ss.node.head[sim.ss.node.index.get('J1')!];
    sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.05, endTime: 0.06 });
    sim.run();

    const h = sim.results.node.head.get('J1');
    const q = sim.results.pipeEnd.flowrate.get('P1'); // flow through the valve

    // The whole run is finite — the fix's core purpose.
    expect(h.every(Number.isFinite)).toBe(true);
    expect(q.every(Number.isFinite)).toBe(true);

    // Normal up-surge is unaffected: first peak ≈ steady + Joukowsky.
    let max = -Infinity;
    let min = Infinity;
    for (const v of h) {
      max = Math.max(max, v);
      min = Math.min(min, v);
    }
    expect(Math.abs(max - (steady + (a * v0) / G))).toBeLessThan(0.1 * (a * v0) / G);

    // The down-surge drives the valve sub-atmospheric (head < 0) — finite, no NaN.
    expect(min).toBeLessThan(0);

    // A discharge valve never passes reverse flow: Q stays ≥ 0 (forward or shut).
    let minQ = Infinity;
    for (const v of q) minQ = Math.min(minQ, v);
    expect(minQ).toBeGreaterThan(-1e-9);
  });
});
