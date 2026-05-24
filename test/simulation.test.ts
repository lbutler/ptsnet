import { describe, it, expect } from 'vitest';
import { PtsnetSimulation } from '../src/index';
import { SIMPLE_INP, exampleInp } from './fixtures';

function allFinite(a: Float64Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

function range(a: Float64Array): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    lo = Math.min(lo, a[i]);
    hi = Math.max(hi, a[i]);
  }
  return hi - lo;
}

describe('PtsnetSimulation core engine', () => {
  it('preserves the steady state when nothing is operated', async () => {
    const sim = await PtsnetSimulation.create({
      inp: SIMPLE_INP,
      settings: { duration: 2, timeStep: 0.02 },
    });
    sim.run();

    const headJ1 = sim.results.node.head.get('J1');
    const flowP1Start = sim.results.pipeStart.flowrate.get('P1');

    expect(allFinite(headJ1)).toBe(true);
    expect(allFinite(flowP1Start)).toBe(true);

    const h0 = headJ1[0];
    // An unexcited network must stay at its steady state.
    expect(range(headJ1)).toBeLessThan(1e-3);
    expect(headJ1[headJ1.length - 1]).toBeCloseTo(h0, 4);
    // Pipe P1 keeps carrying the 50 LPS demand.
    expect(flowP1Start[flowP1Start.length - 1]).toBeCloseTo(0.05, 4);
  });

  it('produces time-aligned result series', async () => {
    const sim = await PtsnetSimulation.create({
      inp: SIMPLE_INP,
      settings: { duration: 1, timeStep: 0.05 },
    });
    sim.run();
    expect(sim.time.length).toBe(sim.settings.timeSteps);
    expect(sim.results.node.head.cols).toBe(sim.settings.timeSteps);
    expect(sim.time[0]).toBe(0);
  });
});

describe('PtsnetSimulation transient (TNET3 valve closure)', () => {
  it('runs the documented valve-operation scenario', async () => {
    const sim = await PtsnetSimulation.create({
      inp: exampleInp('TNET3'),
      settings: { duration: 4, timeStep: 0.1 },
    });

    expect(sim.allValves).toContain('VALVE-179');
    expect(sim.numPoints).toBeGreaterThan(0);

    sim.defineValveOperation('VALVE-179', {
      initialSetting: 1,
      finalSetting: 0,
      startTime: 1,
      endTime: 2,
    });
    sim.run();

    const nodeHead = sim.results.node.head;
    // Every stored node head series is finite.
    for (const label of nodeHead.labels) {
      expect(allFinite(nodeHead.get(label))).toBe(true);
    }

    // The documented README node is present and has a finite head series.
    expect(nodeHead.has('JUNCTION-73')).toBe(true);
    expect(allFinite(nodeHead.get('JUNCTION-73'))).toBe(true);

    // Closing the valve must excite a transient somewhere in the network.
    const maxRange = Math.max(...nodeHead.labels.map((l) => range(nodeHead.get(l))));
    expect(maxRange).toBeGreaterThan(0.1);

    // Pipe flow results exist for every pipe and are finite.
    for (const label of sim.results.pipeEnd.flowrate.labels) {
      expect(allFinite(sim.results.pipeEnd.flowrate.get(label))).toBe(true);
    }
  });
});
