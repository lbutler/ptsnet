// Runnable usage example:  node examples/run.mjs
// (from a clone; uses the built library in ../dist via the package entry)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PtsnetSimulation } from '@epanet-js/ptsnet';

const here = dirname(fileURLToPath(import.meta.url));
const inp = readFileSync(resolve(here, 'TNET3.inp'), 'utf8');

const sim = await PtsnetSimulation.create({
  inp,
  settings: { duration: 20, timeStep: 0.01 },
});

sim.defineValveOperation('VALVE-179', {
  initialSetting: 1,
  finalSetting: 0,
  startTime: 1,
  endTime: 2,
});

sim.run();

const head = sim.results.node.head.get('JUNCTION-73');
let min = Infinity;
let max = -Infinity;
for (const h of head) {
  min = Math.min(min, h);
  max = Math.max(max, h);
}

console.log(`Simulated ${sim.settings.timeSteps} steps over ${sim.settings.duration}s`);
console.log(`JUNCTION-73 head: initial ${head[0].toFixed(2)} m, range [${min.toFixed(2)}, ${max.toFixed(2)}] m`);
