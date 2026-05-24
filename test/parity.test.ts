import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PtsnetSimulation } from '../src/index';
import { exampleInp } from './fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const REF_PATH = resolve(here, '..', 'compare', 'python_results.json');

const SIMPLE_INP = `[TITLE]
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

interface ScenarioRef {
  time_step: number;
  time_steps: number;
  num_points: number;
  node_head: Record<string, number[]>;
  pipe_start_flow: Record<string, number[]>;
  pipe_end_flow: Record<string, number[]>;
}

interface DiffStats {
  maxAbs: number;
  maxRel: number;
}

function compareField(
  ref: Record<string, number[]>,
  get: (label: string) => Float64Array,
  scale: number,
): DiffStats {
  let maxAbs = 0;
  let maxRel = 0;
  for (const [label, series] of Object.entries(ref)) {
    const js = get(label);
    expect(js.length).toBe(series.length);
    for (let t = 0; t < series.length; t++) {
      const abs = Math.abs(js[t] - series[t]);
      maxAbs = Math.max(maxAbs, abs);
      maxRel = Math.max(maxRel, abs / (Math.abs(series[t]) + scale));
    }
  }
  return { maxAbs, maxRel };
}

const simpleSim = () =>
  PtsnetSimulation.create({
    inp: SIMPLE_INP,
    settings: { duration: 1.0, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
  });
const hammerSim = () =>
  PtsnetSimulation.create({
    inp: HAMMER_INP,
    settings: { duration: 4.0, timeStep: 0.05, defaultWaveSpeed: 1000, waveSpeedMethod: 'user' },
  });
const tnet3Sim = () =>
  PtsnetSimulation.create({
    inp: exampleInp('TNET3'),
    settings: { duration: 4.0, timeStep: 0.1, defaultWaveSpeed: 1000, waveSpeedMethod: 'optimal' },
  });

async function buildSim(scenario: string): Promise<PtsnetSimulation> {
  switch (scenario) {
    case 'simple':
      return simpleSim();
    case 'hammer': {
      const sim = await hammerSim();
      sim.defineValveOperation('V1', { initialSetting: 1, finalSetting: 0, startTime: 0.5, endTime: 1.0 });
      return sim;
    }
    case 'tnet3': {
      const sim = await tnet3Sim();
      sim.defineValveOperation('VALVE-179', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 2 });
      return sim;
    }
    case 'tnet3_pump': {
      const sim = await tnet3Sim();
      sim.definePumpOperation('PUMP-172', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 3 });
      return sim;
    }
    case 'tnet3_burst': {
      const sim = await tnet3Sim();
      sim.addBurst('JUNCTION-73', 0.05, 1, 2);
      return sim;
    }
    case 'hammer_custom': {
      const sim = await hammerSim();
      sim.defineValveSettings('V1', [0.5, 0.7, 0.9], [0.8, 0.4, 0.0]);
      return sim;
    }
    case 'simple_demand': {
      const sim = await simpleSim();
      sim.defineDemandSettings('J1', [0.3, 0.6], [0.005, 0.02]);
      return sim;
    }
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

const hasRef = existsSync(REF_PATH);
const refData: Record<string, ScenarioRef> = hasRef ? JSON.parse(readFileSync(REF_PATH, 'utf8')) : {};

// Per-scenario tolerances. 'simple' has no valves/curves -> machine-precision
// agreement; valve scenarios additionally depend on the cubic-spline
// interpolation of the loss curve (scipy splrep vs the TS not-a-knot spline).
// Observed agreement (EPANET 2.2 reference): simple ~5e-7, hammer ~7e-4,
// tnet3 ~6e-5 m on head. Tolerances sit a margin above those.
const TOL: Record<string, { head: number; flow: number }> = {
  simple: { head: 1e-5, flow: 1e-8 },
  hammer: { head: 5e-3, flow: 1e-5 },
  tnet3: { head: 1e-3, flow: 1e-6 },
  tnet3_pump: { head: 1e-3, flow: 1e-6 },
  tnet3_burst: { head: 1e-3, flow: 1e-6 },
  hammer_custom: { head: 5e-3, flow: 1e-5 },
  simple_demand: { head: 1e-5, flow: 1e-8 },
};

const SCENARIOS = ['simple', 'hammer', 'tnet3', 'tnet3_pump', 'tnet3_burst', 'hammer_custom', 'simple_demand'];

describe.skipIf(!hasRef)('Python <-> JavaScript parity', () => {
  for (const scenario of SCENARIOS) {
    it(`matches the Python reference: ${scenario}`, async () => {
      const ref = refData[scenario];
      const sim = await buildSim(scenario);
      sim.run();

      // Discretization grid must be identical.
      expect(sim.settings.timeStep).toBeCloseTo(ref.time_step, 9);
      expect(sim.settings.timeSteps).toBe(ref.time_steps);
      expect(sim.numPoints).toBe(ref.num_points);

      const head = compareField(ref.node_head, (l) => sim.results.node.head.get(l), 1);
      const pstart = compareField(ref.pipe_start_flow, (l) => sim.results.pipeStart.flowrate.get(l), 1e-3);
      const pend = compareField(ref.pipe_end_flow, (l) => sim.results.pipeEnd.flowrate.get(l), 1e-3);

      // eslint-disable-next-line no-console
      console.log(
        `[parity:${scenario}] head maxAbs=${head.maxAbs.toExponential(3)} ` +
          `pipeStart maxAbs=${pstart.maxAbs.toExponential(3)} pipeEnd maxAbs=${pend.maxAbs.toExponential(3)}`,
      );

      const tol = TOL[scenario];
      expect(head.maxAbs).toBeLessThan(tol.head);
      expect(pstart.maxAbs).toBeLessThan(tol.flow);
      expect(pend.maxAbs).toBeLessThan(tol.flow);
    });
  }
});
