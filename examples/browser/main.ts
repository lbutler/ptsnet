import { PtsnetSimulation } from '../../src/index';
// Vite imports the .inp file as a raw string.
import inp from '../TNET3.inp?raw';

const out = document.getElementById('out') as HTMLPreElement;
const log = (m: string) => {
  out.textContent += m + '\n';
};

function plot(series: Float64Array, time: Float64Array): void {
  const c = document.getElementById('plot') as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  const w = c.width;
  const h = c.height;
  ctx.clearRect(0, 0, w, h);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of series) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const pad = 24;
  const x = (i: number) => pad + (i / (series.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo || 1)) * (h - 2 * pad);
  ctx.strokeStyle = '#0b66c3';
  ctx.beginPath();
  for (let i = 0; i < series.length; i++) {
    const px = x(i);
    const py = y(series[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.fillStyle = '#333';
  ctx.fillText(`${hi.toFixed(1)} m`, 2, 14);
  ctx.fillText(`${lo.toFixed(1)} m`, 2, h - 6);
  ctx.fillText(`${time[time.length - 1].toFixed(1)} s`, w - 40, h - 6);
}

async function main(): Promise<void> {
  log('crossOriginIsolated: ' + (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated);

  const sim = await PtsnetSimulation.create({
    inp,
    settings: { duration: 20, timeStep: 0.1 },
    recording: { nodes: ['JUNCTION-73'], pipes: 'none', envelope: true },
    parallel: { workers: navigator.hardwareConcurrency },
  });
  log(`workers up to ${navigator.hardwareConcurrency}`);
  log(`points=${sim.numPoints} steps=${sim.settings.timeSteps}`);

  sim.defineValveOperation('VALVE-179', { initialSetting: 1, finalSetting: 0, startTime: 1, endTime: 2 });

  const t0 = performance.now();
  await sim.runAsync(); // non-blocking barrier; keeps the page responsive
  log(`ran in ${(performance.now() - t0).toFixed(0)} ms`);

  const head = sim.results.node.head.get('JUNCTION-73');
  log(`JUNCTION-73 head: [${Math.min(...head).toFixed(2)}, ${Math.max(...head).toFixed(2)}] m`);
  plot(head, sim.time);
}

main().catch((e) => log('ERROR: ' + (e as Error).message));
