/**
 * Independent-solver validation.
 *
 * The published PTSNET paper (Riano-Briceno et al., 2022) ships reference head
 * time series for the TNET3 valve/pump/burst scenarios from three solvers:
 * PTSNET, TSNet, and the commercial Bentley HAMMER (in publication/SI_results).
 *
 * We check that this TypeScript engine (a) reproduces the published PTSNET
 * results, and (b) agrees with HAMMER on the steady state and the up-surge
 * peaks. Down-surge minima are NOT asserted: HAMMER models column separation
 * (vapor cavities), which the basic Method of Characteristics here does not, so
 * the solvers legitimately differ on the negative-pressure phase.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PtsnetSimulation } from '../src/index';
import { exampleInp } from './fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const siDir = resolve(here, '..', 'publication', 'SI_results');
const hasRefs = existsSync(siDir);

const NODES = ['JUNCTION-30', 'JUNCTION-16', 'JUNCTION-20', 'JUNCTION-45', 'JUNCTION-90'];

function loadCsv(name: string): { time: number[]; cols: Record<string, number[]> } {
  const lines = readFileSync(resolve(siDir, name), 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const time: number[] = [];
  const cols: Record<string, number[]> = {};
  for (let j = 1; j < header.length; j++) cols[header[j]] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    time.push(parseFloat(p[0]));
    for (let j = 1; j < header.length; j++) cols[header[j]].push(parseFloat(p[j]));
  }
  return { time, cols };
}

async function runScenario(scn: 'valve' | 'pump' | 'burst'): Promise<PtsnetSimulation> {
  const sim = await PtsnetSimulation.create({
    inp: exampleInp('TNET3'),
    settings: { duration: 20, timeStep: 0.01, defaultWaveSpeed: 1000, waveSpeedMethod: 'optimal' },
  });
  if (scn === 'valve')
    sim.defineValveOperation('VALVE-179', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 2 });
  if (scn === 'pump')
    sim.definePumpOperation('PUMP-172', { initialSetting: 1, finalSetting: 0, startTime: 0, endTime: 1 });
  if (scn === 'burst') sim.addBurst('JUNCTION-73', 0.02, 1, 2);
  sim.run();
  return sim;
}

function maxArr(a: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) m = Math.max(m, a[i]);
  return m;
}

describe.skipIf(!hasRefs)('validation against published PTSNET/HAMMER references', () => {
  for (const scn of ['valve', 'pump', 'burst'] as const) {
    it(`${scn}: reproduces PTSNET and agrees with HAMMER`, async () => {
      const sim = await runScenario(scn);
      const ptsnet = loadCsv(`${scn}_ptsnet.txt`);
      const hammer = loadCsv(`${scn}_hammer.txt`);

      let ptInitial = 0;
      let ptMax = 0;
      let hamSteady = 0;
      let hamPeakRel = 0;

      for (const node of NODES) {
        const js = sim.results.node.head.get(node);
        const pt = ptsnet.cols[node];
        const n = Math.min(js.length, pt.length);
        // PTSNET shares the same (optimal-dt) grid -> compare directly.
        ptInitial = Math.max(ptInitial, Math.abs(js[0] - pt[0]));
        for (let i = 0; i < n; i++) ptMax = Math.max(ptMax, Math.abs(js[i] - pt[i]));
        // HAMMER: steady state + up-surge peak.
        hamSteady = Math.max(hamSteady, Math.abs(js[0] - hammer.cols[node][0]));
        const hmax = maxArr(hammer.cols[node]);
        hamPeakRel = Math.max(hamPeakRel, Math.abs(maxArr(js) - hmax) / Math.abs(hmax));
      }

      // eslint-disable-next-line no-console
      console.log(
        `[validate:${scn}] vs PTSNET max=${ptMax.toFixed(3)}m (t0=${ptInitial.toExponential(1)}) | ` +
          `vs HAMMER steady=${hamSteady.toFixed(2)}m peak<=${(hamPeakRel * 100).toFixed(1)}%`,
      );

      // Reproduces the peer-reviewed PTSNET results.
      expect(ptInitial).toBeLessThan(1e-3);
      expect(ptMax).toBeLessThan(3);
      // Independent cross-check against HAMMER.
      expect(hamSteady).toBeLessThan(0.5);
      expect(hamPeakRel).toBeLessThan(0.12);
    });
  }
});
