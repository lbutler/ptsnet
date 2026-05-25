/// <reference types="vite/client" />
import { PtsnetSimulation } from '../../src/index';
import { NODE_JUNCTION } from '../../src/index';
import type { SimulationResults } from '../../src/index';

// Bundled example networks (Vite inlines each .inp as a raw string).
const files = import.meta.glob('../*.inp', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;
const examples: Record<string, string> = {};
for (const path in files) examples[path.split('/').pop()!.replace(/\.inp$/, '')] = files[path];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const exampleSel = $<HTMLSelectElement>('example');
const fileInput = $<HTMLInputElement>('file');
const inpArea = $<HTMLTextAreaElement>('inp');
const loadBtn = $<HTMLButtonElement>('load');
const runBtn = $<HTMLButtonElement>('run');
const netInfo = $<HTMLParagraphElement>('netinfo');
const statusEl = $<HTMLParagraphElement>('status');
const valveSel = $<HTMLSelectElement>('valve');
const pumpSel = $<HTMLSelectElement>('pump');
const nodeSel = $<HTMLSelectElement>('nodes');
const pipeSel = $<HTMLSelectElement>('pipes');

const num = (id: string) => parseFloat($<HTMLInputElement>(id).value);
const hwc = (navigator.hardwareConcurrency as number) || 4;

let results: SimulationResults | undefined;
let time: Float64Array | undefined;

const PALETTE = ['#0b66c3', '#e8590c', '#2f9e44', '#9c36b5', '#c92a2a', '#1098ad', '#f08c00', '#5c7cfa'];

function setStatus(msg: string, err = false): void {
  statusEl.textContent = msg;
  statusEl.className = err ? 'err' : '';
}

function fillSelect(sel: HTMLSelectElement, labels: string[], withNone: boolean, selectFirst = 0): void {
  sel.innerHTML = '';
  if (withNone) sel.add(new Option('(none)', ''));
  for (const l of labels) sel.add(new Option(l, l));
  if (!withNone) for (let i = 0; i < selectFirst && i < sel.options.length; i++) sel.options[i].selected = true;
}

function selected(sel: HTMLSelectElement): string[] {
  return Array.from(sel.selectedOptions).map((o) => o.value);
}

/** Parse the current .inp and populate the element pickers (no transient run). */
async function loadNetwork(): Promise<void> {
  runBtn.disabled = true;
  try {
    const sim = await PtsnetSimulation.create({ inp: inpArea.value, settings: { duration: 1, timeStep: 0.1 } });
    const ss = sim.ss;
    const junctions = ss.node.labels.filter((_, i) => ss.node.type[i] === NODE_JUNCTION);
    fillSelect(valveSel, sim.allValves, true);
    fillSelect(pumpSel, sim.allPumps, true);
    fillSelect(nodeSel, junctions, false, 2);
    fillSelect(pipeSel, ss.pipe.labels, false, 2);
    if (sim.allValves.length) valveSel.value = sim.allValves[0];
    netInfo.textContent = `${ss.node.n} nodes · ${ss.pipe.n} pipes · ${ss.valve.n} valves · ${ss.pump.n} pumps · ${sim.numPoints} points`;
    setStatus(`crossOriginIsolated=${(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated} · up to ${hwc} workers`);
    runBtn.disabled = false;
    sim.dispose();
  } catch (e) {
    netInfo.textContent = '';
    setStatus('Could not load network: ' + (e as Error).message, true);
  }
}

async function run(): Promise<void> {
  runBtn.disabled = true;
  setStatus('running…');
  try {
    const sim = await PtsnetSimulation.create({
      inp: inpArea.value,
      settings: {
        duration: num('duration'),
        timeStep: num('dt'),
        defaultWaveSpeed: num('wavespeed'),
        waveSpeedMethod: $<HTMLSelectElement>('method').value as 'optimal' | 'user' | 'critical' | 'dt',
      },
      cavitation: $<HTMLInputElement>('cavitation').checked,
      parallel: { workers: hwc },
    });
    if (valveSel.value) {
      sim.defineValveOperation(valveSel.value, {
        initialSetting: 1,
        finalSetting: num('vfinal'),
        startTime: num('vstart'),
        endTime: num('vend'),
      });
    }
    if (pumpSel.value) {
      sim.definePumpTrip(pumpSel.value, {
        tripTime: num('ptrip'),
        inertia: num('pinertia'),
        ratedSpeed: num('pspeed'),
      });
    }
    const t0 = performance.now();
    await sim.runAsync({ onProgress: (p) => setStatus(`running… ${(p.fraction * 100) | 0}%`) });
    const ms = performance.now() - t0;
    results = sim.results;
    time = sim.time;
    const cav = sim.maxCavityVolume;
    setStatus(
      `done · ${sim.numPoints} points × ${sim.settings.timeSteps} steps in ${ms.toFixed(0)} ms` +
        (cav !== undefined ? ` · max cavity ${cav.toExponential(2)} m³` : ''),
    );
    sim.dispose();
    replot();
  } catch (e) {
    setStatus('Run failed: ' + (e as Error).message, true);
  } finally {
    runBtn.disabled = false;
  }
}

function replot(): void {
  if (!results || !time) return;
  const heads = selected(nodeSel)
    .filter((l) => results!.node.head.labels.includes(l))
    .map((l, i) => ({ label: l, data: results!.node.head.get(l), color: PALETTE[i % PALETTE.length] }));
  const flows = selected(pipeSel)
    .filter((l) => results!.pipeStart.flowrate.labels.includes(l))
    .map((l, i) => ({ label: l, data: results!.pipeStart.flowrate.get(l), color: PALETTE[i % PALETTE.length] }));
  drawChart($<HTMLCanvasElement>('headChart'), $('headLegend'), time, heads, 1);
  drawChart($<HTMLCanvasElement>('flowChart'), $('flowLegend'), time, flows, 1000); // m³/s → L/s
}

interface Series {
  label: string;
  data: Float64Array;
  color: string;
}

function drawChart(canvas: HTMLCanvasElement, legendEl: HTMLElement, time: Float64Array, series: Series[], scale: number): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  legendEl.innerHTML = '';
  if (series.length === 0) {
    ctx.fillStyle = '#98a2b3';
    ctx.fillText('select one or more series', 12, 20);
    return;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) for (const v of s.data) {
    const x = v * scale;
    if (Number.isFinite(x)) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (hi === lo) hi = lo + 1;
  const padL = 52;
  const padR = 12;
  const padT = 10;
  const padB = 26;
  const tEnd = time[time.length - 1] || 1;
  const X = (t: number) => padL + (t / tEnd) * (w - padL - padR);
  const Y = (v: number) => h - padB - ((v - lo) / (hi - lo)) * (h - padT - padB);

  // grid + axis labels
  ctx.strokeStyle = '#eef0f3';
  ctx.fillStyle = '#667085';
  ctx.font = '11px system-ui';
  ctx.textAlign = 'right';
  for (let g = 0; g <= 4; g++) {
    const v = lo + ((hi - lo) * g) / 4;
    const py = Y(v);
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(w - padR, py);
    ctx.stroke();
    ctx.fillText(v.toFixed(Math.abs(hi - lo) < 10 ? 2 : 0), padL - 5, py + 3);
  }
  ctx.textAlign = 'center';
  for (let g = 0; g <= 5; g++) {
    const t = (tEnd * g) / 5;
    ctx.fillText(t.toFixed(t < 10 ? 1 : 0) + 's', X(t), h - 8);
  }

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < s.data.length; i++) {
      const px = X(time[i]);
      const py = Y(s.data[i] * scale);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    const sw = document.createElement('span');
    sw.innerHTML = `<span class="swatch" style="background:${s.color}"></span>${s.label}`;
    legendEl.appendChild(sw);
  }
}

// --- wire up ---
for (const name of Object.keys(examples).sort()) exampleSel.add(new Option(name, name));
exampleSel.value = examples['TNET3'] ? 'TNET3' : exampleSel.options[0]?.value;

function loadExample(): void {
  inpArea.value = examples[exampleSel.value] ?? '';
  void loadNetwork();
}
exampleSel.addEventListener('change', loadExample);
loadBtn.addEventListener('click', () => void loadNetwork());
runBtn.addEventListener('click', () => void run());
nodeSel.addEventListener('change', replot);
pipeSel.addEventListener('change', replot);
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  f.text().then((txt) => {
    inpArea.value = txt;
    exampleSel.selectedIndex = -1;
    void loadNetwork();
  });
});

loadExample();
