/**
 * Simple serial-engine benchmark. Run with `npm run bench`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PtsnetSimulation } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const inp = readFileSync(resolve(here, '..', 'examples', 'TNET3.inp'), 'utf8');

async function bench(duration: number): Promise<void> {
  const t0 = performance.now();
  const sim = await PtsnetSimulation.create({
    inp,
    settings: { duration, timeStep: 0.1, defaultWaveSpeed: 1000, waveSpeedMethod: 'optimal' },
  });
  const tCreate = performance.now() - t0;

  sim.defineValveOperation('VALVE-179', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 2 });

  const t1 = performance.now();
  sim.run();
  const tRun = performance.now() - t1;

  const pointSteps = sim.numPoints * sim.settings.timeSteps;
  console.log(
    `TNET3 duration=${duration}s  points=${sim.numPoints} steps=${sim.settings.timeSteps}\n` +
      `  steady state : ${tCreate.toFixed(0)} ms\n` +
      `  transient    : ${tRun.toFixed(0)} ms  ` +
      `(${((tRun / pointSteps) * 1e6).toFixed(1)} ns/point-step, ` +
      `${(pointSteps / 1e6 / (tRun / 1000)).toFixed(0)} M point-steps/s)`,
  );
}

await bench(20);
