import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';

/**
 * Column separation (DGCM) validated on the canonical Bergant & Simpson
 * reservoir–pipe–valve case (Bergant, Simpson & Tijsseling 2006). A rapid
 * downstream valve closure drives the valve head below vapor pressure; a vapor
 * cavity forms, clamps the head at the vapor head, then collapses into a
 * short-duration pulse that exceeds the Joukowsky rise ("active" column
 * separation).
 */
const BERGANT_INP = `[TITLE]
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
const settings = {
  duration: 0.5,
  timeStep: 0.0005,
  defaultWaveSpeed: 1319,
  waveSpeedMethod: 'user' as const,
};

describe('column separation (DGCM) — Bergant reservoir-pipe-valve', () => {
  it('clamps at vapor pressure, conserves a cavity, and gives the Joukowsky + collapse pulse', async () => {
    const sim = await PtsnetSimulation.create({
      inp: BERGANT_INP,
      settings,
      cavitation: true,
      recording: { nodes: ['J1'], pipes: ['P1'] },
    });

    const area = (Math.PI * 0.0221 ** 2) / 4;
    const v0 = sim.ss.pipe.flowrate[0] / area;
    const a = sim.ss.pipe.waveSpeed[0];
    const steady = sim.ss.node.head[sim.ss.node.index.get('J1')!];
    const joukowsky = (a * v0) / G;
    const vaporHead = 0 + (0.24 - 10.33); // elevation 0 + (Hv − Hb)

    sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.05, endTime: 0.06 });
    sim.run();

    const h = sim.results.node.head.get('J1');
    const dt = sim.settings.timeStep;
    expect(h.every(Number.isFinite)).toBe(true);
    expect(v0).toBeCloseTo(0.3, 1);

    // First peak ≈ steady head + Joukowsky rise.
    let firstPeak = -Infinity;
    for (let i = 0; i < h.length; i++) {
      const t = i * dt;
      if (t >= 0.06 && t <= 0.116) firstPeak = Math.max(firstPeak, h[i]);
    }
    expect(Math.abs(firstPeak - (steady + joukowsky))).toBeLessThan(0.1 * joukowsky);

    // Head clamps at the vapor head and never drops meaningfully below it.
    let min = Infinity;
    let max = -Infinity;
    for (const v of h) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeGreaterThan(vaporHead - 1);
    expect(min).toBeLessThan(vaporHead + 1); // it actually reaches vapor (a cavity forms)

    // A sustained vapor plateau (real, accumulating cavity — the DVCM failure mode
    // would only touch vapor for isolated steps).
    let plateau = 0;
    let longest = 0;
    for (const v of h) {
      if (Math.abs(v - vaporHead) < 0.5) {
        plateau++;
        longest = Math.max(longest, plateau);
      } else plateau = 0;
    }
    expect(longest).toBeGreaterThan(50);
    expect(sim.maxCavityVolume!).toBeGreaterThan(0);

    // Cavity collapse produces a short-duration pulse exceeding the first peak
    // (active column separation).
    expect(max).toBeGreaterThan(firstPeak + 1);
  });

  it('the basic engine (no cavitation) goes unphysical on the same case', async () => {
    const sim = await PtsnetSimulation.create({
      inp: BERGANT_INP,
      settings,
      recording: { nodes: ['J1'], pipes: ['P1'] },
    });
    sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.05, endTime: 0.06 });
    sim.run();
    const h = sim.results.node.head.get('J1');
    const vaporHead = 0.24 - 10.33;
    // Without column separation the head either NaNs (sqrt of negative valve head)
    // or drops far below the vapor head — i.e. unphysical.
    const broken = !h.every(Number.isFinite) || Math.min(...h) < vaporHead - 5;
    expect(broken).toBe(true);
  });
});

describe('column separation does not disturb a steady (non-cavitating) run', () => {
  it('preserves the steady state with cavitation enabled', async () => {
    const SIMPLE = `[TITLE]
[JUNCTIONS]
 J1 0 50
 J2 0 0
[RESERVOIRS]
 R1 100
[PIPES]
 P1 R1 J1 1000 300 100 0 Open
 P2 J1 J2 1000 300 100 0 Open
[OPTIONS]
 Units LPS
 Headloss H-W
[TIMES]
 Duration 0
[END]
`;
    const sim = await PtsnetSimulation.create({
      inp: SIMPLE,
      settings: { duration: 1, timeStep: 0.02, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
      cavitation: true,
    });
    sim.run();
    const h = sim.results.node.head.get('J1');
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of h) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi - lo).toBeLessThan(0.05); // stays at steady state
  });
});
