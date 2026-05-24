import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';
import type { RecordingOptions } from '../src/index';

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

async function runHammer(recording?: RecordingOptions): Promise<PtsnetSimulation> {
  const sim = await PtsnetSimulation.create({
    inp: HAMMER_INP,
    settings: { duration: 4, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
    recording,
  });
  sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.5, endTime: 1.0 });
  sim.run();
  return sim;
}

describe('recording: element subset', () => {
  it('records only the selected nodes/pipes with identical values', async () => {
    const full = await runHammer();
    const subset = await runHammer({ nodes: ['J1'], pipes: ['P1'] });

    expect(subset.results.node.head.labels).toEqual(['J1']);
    expect(subset.results.pipeStart.flowrate.labels).toEqual(['P1']);

    expect(Array.from(subset.results.node.head.get('J1'))).toEqual(
      Array.from(full.results.node.head.get('J1')),
    );
    expect(Array.from(subset.results.pipeEnd.flowrate.get('P1'))).toEqual(
      Array.from(full.results.pipeEnd.flowrate.get('P1')),
    );
  });

  it("nodes:'none' stores no node series", async () => {
    const sim = await runHammer({ nodes: 'none', pipes: 'none' });
    expect(sim.results.node.head.labels).toEqual([]);
    expect(sim.results.pipeStart.flowrate.labels).toEqual([]);
    expect(sim.time.length).toBe(sim.settings.timeSteps);
  });

  it('throws on an unknown selection label', async () => {
    await expect(runHammer({ nodes: ['NOPE'] })).rejects.toThrow(/unknown node/);
  });
});

describe('recording: time downsampling', () => {
  it('keeps every Nth sample, time-aligned to the full run', async () => {
    const full = await runHammer();
    const every = 4;
    const ds = await runHammer({ every });

    const expectedCols = Math.floor((full.settings.timeSteps - 1) / every) + 1;
    expect(ds.results.node.head.cols).toBe(expectedCols);
    expect(ds.time.length).toBe(expectedCols);

    const fullH = full.results.node.head.get('J1');
    const dsH = ds.results.node.head.get('J1');
    for (let c = 0; c < expectedCols; c++) {
      expect(dsH[c]).toBe(fullH[c * every]);
      expect(ds.time[c]).toBeCloseTo(full.time[c * every], 9);
    }
  });
});

describe('recording: envelope', () => {
  it('min/max match the full time series, and work with no stored series', async () => {
    const full = await runHammer();
    const env = await runHammer({ nodes: 'none', pipes: 'none', envelope: true });

    expect(env.envelope).toBeDefined();
    const e = env.envelope!;

    const j1 = e.node.labels.indexOf('J1');
    const fullH = full.results.node.head.get('J1');
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of fullH) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    expect(e.node.headMin[j1]).toBeCloseTo(lo, 9);
    expect(e.node.headMax[j1]).toBeCloseTo(hi, 9);

    // Envelope covers every element even though no time series were stored.
    expect(e.node.headMin.length).toBe(e.node.labels.length);
    expect(env.results.node.head.labels).toEqual([]);
  });

  it('is undefined when not requested', async () => {
    const sim = await runHammer();
    expect(sim.envelope).toBeUndefined();
  });
});
