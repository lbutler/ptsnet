import { describe, it, expect } from 'vitest';
import { PtsnetSimulation, serializeResults, deserializeResults } from '../src/index';
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

describe('recording: pipe head profile', () => {
  async function runProfile(
    recording?: RecordingOptions,
    workers?: number,
  ): Promise<PtsnetSimulation> {
    const sim = await PtsnetSimulation.create({
      inp: HAMMER_INP,
      settings: { duration: 4, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
      recording,
      parallel: workers === undefined ? undefined : { workers },
    });
    sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.5, endTime: 1.0 });
    sim.run();
    return sim;
  }

  it('is undefined unless requested (default output unchanged)', async () => {
    const sim = await runProfile();
    expect(sim.results.pipeProfile).toBeUndefined();
  });

  it('exposes a well-formed profile with consistent shape', async () => {
    const sim = await runProfile({ pipeProfileHead: true });
    const pp = sim.results.pipeProfile;
    expect(pp).toBeDefined();
    const p = pp!;

    // One label/offset/segment entry per pipe.
    expect(p.labels).toEqual(['P1', 'P2']);
    expect(p.offset.length).toBe(p.labels.length);
    expect(p.segments.length).toBe(p.labels.length);

    // cols matches the recorded time axis; data is step-major numPoints×cols.
    expect(p.cols).toBe(sim.time.length);
    expect(p.data.length).toBe(p.numPoints * p.cols);

    // Each pipe owns a contiguous [offset .. offset+segments] block; together the
    // blocks tile all numPoints points exactly once.
    let covered = 0;
    for (let i = 0; i < p.labels.length; i++) {
      expect(p.segments[i]).toBeGreaterThan(0);
      covered += p.segments[i] + 1;
    }
    expect(covered).toBe(p.numPoints);
    for (const h of p.data) expect(Number.isFinite(h)).toBe(true);
  });

  it('profile boundary points equal the node head series', async () => {
    const sim = await runProfile({ pipeProfileHead: true });
    const p = sim.results.pipeProfile!;
    const headSeries = sim.results.node.head;

    // P1 = R1 -> J1, so the profile END point (offset+segments) is node J1.
    const p1 = p.labels.indexOf('P1');
    const j1 = headSeries.get('J1');
    // P2 = J2 -> R2, so the profile START point (offset) is node J2.
    const p2 = p.labels.indexOf('P2');
    const j2 = headSeries.get('J2');

    for (let t = 0; t < p.cols; t++) {
      const p1End = p.data[t * p.numPoints + p.offset[p1] + p.segments[p1]];
      const p2Start = p.data[t * p.numPoints + p.offset[p2]];
      expect(p1End).toBe(j1[t]);
      expect(p2Start).toBe(j2[t]);
    }
  });

  it('honours `every` downsampling', async () => {
    const full = await runProfile({ pipeProfileHead: true });
    const every = 4;
    const ds = await runProfile({ pipeProfileHead: true, every });

    const f = full.results.pipeProfile!;
    const d = ds.results.pipeProfile!;
    expect(d.numPoints).toBe(f.numPoints);
    expect(d.cols).toBe(Math.floor((full.settings.timeSteps - 1) / every) + 1);

    for (let t = 0; t < d.cols; t++) {
      for (let j = 0; j < d.numPoints; j++) {
        expect(d.data[t * d.numPoints + j]).toBe(f.data[t * every * f.numPoints + j]);
      }
    }
  });

  it('is worker-count invariant (workers:1 vs 4 bit-identical)', async () => {
    const a = await runProfile({ pipeProfileHead: true }, 1);
    const b = await runProfile({ pipeProfileHead: true }, 4);
    expect(Array.from(b.results.pipeProfile!.data)).toEqual(
      Array.from(a.results.pipeProfile!.data),
    );
  });

  it('round-trips through serialize/deserialize', async () => {
    const sim = await runProfile({ pipeProfileHead: true });
    const json = JSON.parse(JSON.stringify(serializeResults(sim.results, sim.time)));
    const { results } = deserializeResults(json);

    const orig = sim.results.pipeProfile!;
    const back = results.pipeProfile!;
    expect(back.labels).toEqual(orig.labels);
    expect(Array.from(back.offset)).toEqual(Array.from(orig.offset));
    expect(Array.from(back.segments)).toEqual(Array.from(orig.segments));
    expect(back.numPoints).toBe(orig.numPoints);
    expect(back.cols).toBe(orig.cols);
    expect(Array.from(back.data)).toEqual(Array.from(orig.data));
  });
});
