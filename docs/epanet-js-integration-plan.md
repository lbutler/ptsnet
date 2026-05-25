# Bringing ptsnet transient analysis into epanet-js

A staged plan for embedding the **ptsnet** hydraulic-transient ("water hammer")
engine into the **epanet-js** web app, starting from a minimal proof of concept
(a single valve closure with a couple of charts) and growing to full coverage of
the ptsnet feature set.

## 1. Context — why this, and what success looks like

epanet-js is a browser-based EPANET editor: it solves *steady-state / extended-
period* hydraulics in-browser via the EPANET 2.2 WASM toolkit and visualises the
result on a map and in time-series graphs. It has **no transient capability** —
it cannot tell a user what pressures a pipe network sees during a valve slam,
pump trip, or other rapid change.

ptsnet (`@epanet-js/ptsnet`, this repo) is a TypeScript Method-of-Characteristics
transient engine. It takes an EPANET `.inp`, computes steady-state initial
conditions with the same `epanet-js` package the app already uses, then marches
the transient and returns head/flow time series. Because both tools share the
EPANET model format and the same underlying solver, the conceptual fit is clean:
**epanet-js owns the model and the UI; ptsnet is a compute engine it hands an
`.inp` to and gets time series back.**

**Success for the POC:** from inside epanet-js, a user picks a valve, says "close
it linearly over 2 s", clicks Run, and within a second or two sees head-vs-time
at a node and flow-vs-time in a pipe — the classic Joukowsky surge — without
anything leaving the browser.

**Success for the full feature:** every ptsnet operation and protection device is
configurable from the UI, transient extrema colour the map, and results sit
alongside the existing steady-state results.

## 2. How the pieces fit (target architecture)

```
 epanet-js (Next.js, main thread)
   Project/Workspace (EPANET WASM)  ──saveInpFile──▶  .inp string
        │                                                  │
        │ Jotai atoms (config, status, results)            │ postMessage({inp, settings, op})
        ▼                                                  ▼
   Transient UI panel  ◀──serialized results──  Transient Web Worker
   (Radix dialog + ECharts)                       └ import @epanet-js/ptsnet
                                                    PtsnetSimulation.create()
                                                    defineValveOperation()
                                                    await runAsync()
                                                    serializeResults() ─┘
```

Data flow:
1. **Export** the current network from epanet-js as an `.inp` string.
2. **Post** it (plus minimal transient config) into a dedicated Web Worker.
3. In the worker, `PtsnetSimulation.create({ inp, ... })` runs the steady-state
   solve and builds the engine; the chosen operation is defined; `runAsync()`
   marches the transient.
4. **`serializeResults(results, time)`** turns the output into a plain JSON object
   that is posted back to the main thread.
5. The main thread feeds the series into **ECharts** (the app's existing charting
   stack) and, later, into map colouring.

### ptsnet public API the integration uses
- `PtsnetSimulation.create(options)` — async factory. `options.inp` is the **`.inp`
  file contents as a string** (not a path). `options.settings` carries
  `{ duration, timeStep, defaultWaveSpeed, waveSpeedMethod, skipCompatibilityCheck }`.
  `options.recording`, `options.parallel`, `options.cavitation`,
  `options.unsteadyFriction`, `options.quasiSteadyFriction` are optional.
- `defineValveOperation(names, { initialSetting, finalSetting, startTime, endTime,
  valveType?, function? })` — the MVP operation. Defaults: `valveType:'butterfly'`,
  `function:'linear'`, `startTime:0`, `endTime:1`.
- `runAsync(opts?)` — non-blocking run (uses `Atomics.waitAsync`); **use this in
  the browser, never `run()`** (which blocks via `Atomics.wait`).
- `results` getter → `{ node: { head, leakFlow, demandFlow }, pipeStart:{flowrate},
  pipeEnd:{flowrate} }` where each is a `ResultSeries` (`.get(label) -> Float64Array`,
  `.labels`, `.at(label,t)`).
- `time` getter → `Float64Array` of recorded timestamps.
- `serializeResults(results, time)` / `deserializeResults(obj)` — JSON-safe
  round-trip, ideal for the worker boundary.
- Introspection for UI pickers: `sim.ss` (the `SteadyState` tables —
  `ss.node.labels`, `ss.node.type` with `NODE_JUNCTION/RESERVOIR/TANK`,
  `ss.pipe.labels`), `sim.allValves`, `sim.allPumps`, `sim.numPoints`.

The existing browser demo at `examples/browser/main.ts` in the ptsnet repo is a
complete working reference for steps 1–5 and should be mirrored.

## 3. Stage 0 — infrastructure prerequisites (do once, gates everything)

These are not user-visible but every later stage depends on them.

### 3.1 Cross-origin isolation (the hard requirement)
ptsnet needs `SharedArrayBuffer`. `PtsnetSimulation.create()` **throws** if the
page is not cross-origin isolated — there is no serial fallback, and even
`parallel:{ workers:1 }` still allocates SABs and requires isolation. The app
sets no isolation headers today.

Add app-wide headers (Next.js `next.config.js` `headers()`), using
**credentialless** COEP to minimise breakage of third-party content (PostHog,
Sentry, map tiles, fonts):

```js
// next.config.js
async headers() {
  return [{
    source: '/:path*',
    headers: [
      { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
      { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
    ],
  }];
}
```

Verify in the running app that `globalThis.crossOriginIsolated === true`.

Caveats to validate during Stage 0:
- **`credentialless`** sends cross-origin `no-cors` requests without credentials
  and does not require those resources to send CORP — so most analytics/tiles
  keep working. Anything that *needs* credentials cross-origin (authenticated
  embeds) must instead be `crossorigin`-tagged or proxied same-origin.
- **Safari**: `credentialless` support is limited/late. If broad Safari support is
  required, fall back to `require-corp` and add `Cross-Origin-Resource-Policy`
  (or `crossorigin` attrs) to each cross-origin asset, or scope isolation to a
  dedicated transient route. Decide based on the app's browser-support matrix.
- **CSP**: ptsnet delivers its worker as a `blob:` URL, so the page CSP must allow
  `worker-src blob:` (or `child-src blob:`). No worker file needs to be bundled.

### 3.2 Dependencies and version alignment
- Add `@epanet-js/ptsnet` (currently v0.2.0; ESM + CJS, ships types).
- ptsnet depends on `epanet-js ^0.8.0`. The app already uses `epanet-js` — confirm
  the app's version is compatible / dedupe so two copies of the EPANET WASM aren't
  shipped unnecessarily. If versions diverge, align them or accept the duplicate
  for the POC.
- The app uses **pnpm**; install accordingly.

### 3.3 Model handoff (`.inp` string)
ptsnet needs an `.inp` string. epanet-js holds the model in its `Project`/
`Workspace` (EPANET WASM toolkit). **Confirm and use the toolkit's INP writer**:
typically `project.saveInpFile('transient.inp')` writes into the virtual
`Workspace` FS, then read it back as a string (e.g. `workspace.readFile(...)`).
Verifying the exact method names against the app's `epanet-js` version is the
first concrete action of Stage 0. (Set ptsnet's `skipCompatibilityCheck: true`
for the POC so real networks load even with a wide-open valve, mirroring the demo.)

### 3.4 Execution model
Run ptsnet inside a **dedicated app-owned Web Worker** so a long march never
freezes the map UI. For the POC configure ptsnet with `parallel:{ workers:1 }`
(its inline path — no nested worker spawn, simplest and robust), and post
`serializeResults()` output back to the main thread. A later performance stage can
enable ptsnet's real worker pool (nested workers) for large networks.

### 3.5 Units
ptsnet works in **SI** (head in m, flow in m³/s). epanet-js displays user units
(e.g. psi/GPM). Add a thin conversion layer at the visualisation boundary —
either reuse the app's unit system or ptsnet's exported `toSi`/`HydParam`/
`FlowUnit` helpers — so charts/labels match the rest of the app.

## 4. Stage 1 — MVP: one valve closure, two charts

**Goal:** prove the full pipeline with the least UI possible.

**Scope (intentionally tiny):**
- One transient operation: a single **valve closure**.
- Inputs: valve (picked from the model's valves), `finalSetting` (default 0 =
  fully closed), `startTime`, `endTime`. Plus run settings `duration` and
  `timeStep`. Everything else defaults: `initialSetting:1`,
  `valveType:'butterfly'`, `function:'linear'`, `defaultWaveSpeed:1000`,
  `waveSpeedMethod:'optimal'`, cavitation off.
- Outputs: head-vs-time at one selected node, flow-vs-time in one selected pipe.

**UI:** a "Transient analysis" entry point — a Radix dialog or a section in the
asset side-panel (next to the existing Quick Graph). Controls: valve dropdown,
three number inputs (final setting, start, end), duration + timestep, node and
pipe pickers for the plots, a Run button, and a status/progress line.

**Wiring (mirrors `examples/browser/main.ts`):**
```ts
// in the transient worker
const sim = await PtsnetSimulation.create({
  inp,                                   // .inp string from the app
  settings: { duration, timeStep, defaultWaveSpeed: 1000, skipCompatibilityCheck: true },
  recording: { nodes: [nodeLabel], pipes: [pipeLabel] }, // keep memory small
  parallel: { workers: 1 },
});
sim.defineValveOperation(valveLabel, { initialSetting: 1, finalSetting, startTime, endTime });
await sim.runAsync({ onProgress: p => postMessage({ type:'progress', fraction:p.fraction }) });
const payload = serializeResults(sim.results, sim.time);
sim.dispose();
postMessage({ type:'done', payload });
```
On the main thread, `deserializeResults(payload)` then render two ECharts line
charts (reuse the Quick Graph component/pattern). State (config, status, results)
lives in **Jotai** atoms.

**Acceptance criteria:**
- Running on a simple reservoir→pipe→valve network produces a head trace whose
  first peak is on the order of the Joukowsky estimate `a·ΔV/g` (sanity check, not
  exact), and flow ramps to ~0 over the closure window.
- No main-thread freeze during the run; progress updates render.
- Errors (e.g. isolation missing, bad `.inp`) surface as a readable message.

## 5. Stage 2 — more transient operations

Add the other source operations, reusing the Stage 1 worker/UI scaffolding:
- **Pump trip** — `definePumpTrip(name, { tripTime, inertia, ratedSpeed,
  ratedEfficiency?|ratedPower? })`. Pump picker + params.
- **Pump speed change** — `definePumpOperation(name, { initialSetting, finalSetting,
  startTime, endTime })`.
- **Valve types** — expose `valveType` (`butterfly|globe|gate|ball|needle`) on the
  valve-closure form.

Allow a single operation at a time for now; multi-operation scenarios come later.

## 6. Stage 3 — envelope + map colouring (the key engineering output)

Surge design is driven by **max/min head** along the system, not single traces.
- Enable `recording: { envelope: true }`; read `sim.envelope`
  (`node.headMin/headMax`, `pipe.startMin/Max`, `pipe.endMin/Max`).
- Colour map nodes by max/min transient head (and pipes by flow extremes), reusing
  the app's existing results-colouring machinery.
- Show a per-element max/min pressure summary. This is the deliverable most users
  actually want from a transient run.

## 7. Stage 4 — cavitation / column separation

- Add a cavitation toggle → `create({ cavitation: true })` (or
  `CavitationOptions`).
- Surface `sim.cavitationReport()`: the `valid` flag, `worstFillFraction`, and
  per-pipe/per-node peak cavity volumes — a panel that warns when the discrete-
  cavity assumption broke down. Note in the UI that without cavitation the engine
  can report unphysical sub-vapour heads.

## 8. Stage 5 — protection devices

Each is a boundary element placed at a node or pipe; UI = a placement picker
(valid degree-2 node "between two pipes", or a pipe) plus a small params form.
- **Check valves** — `addCheckValve(pipe)` (EPANET `CV` pipes are auto-imported;
  expose manual addition too).
- **Air/vacuum valve** — `addAirValve(...)`.
- **Surge-relief valve** — `addSurgeReliefValve(...)`.
- **One-way surge tank** — `addOneWaySurgeTank(...)`.
- **Open / closed surge tank** — `addSurgeProtection(node, { type:'open'|'closed',
  ... })`, including the open-tank enhancements (`OpenSurgeTankOptions`: throttling
  orifice, overflow/max level, min/empty level).

Reuse ptsnet's placement validation; the UI should only offer eligible nodes/pipes
(a node with a valve or pump attached is not eligible — mirror `nonPipeNode`).

## 9. Stage 6 — friction models and wave-speed control

- **Unsteady (Brunone) friction** — `create({ unsteadyFriction: true | {...} })`;
  optional `brunoneCoefficient()` helper for display.
- **Quasi-steady friction** — `create({ quasiSteadyFriction: true | {...} })`.
- **Wave-speed control** — expose `waveSpeedMethod`
  (`optimal|critical|user|dt`), `defaultWaveSpeed`, and per-pipe `waveSpeeds`
  overrides.

## 10. Stage 7 — advanced operations, performance, polish

- **Node burst / leak** — `addBurst(...)` and custom schedules
  (`defineValveSettings`/`definePumpSettings`/`defineBurstSettings`/
  `defineDemandSettings`) for arbitrary time–value profiles.
- **Multiple simultaneous operations / scenarios**, saved via Jotai + the app's
  persistence; results export via `serializeResults` to a downloadable file.
- **Performance** — switch the worker to ptsnet's real pool
  (`parallel:{ workers: navigator.hardwareConcurrency }`, nested workers) for large
  networks; add recording controls (`recording.nodes/pipes/every`) to bound memory
  on long runs.
- **Profile/HGL animation** along a selected path and timestep scrubbing, matching
  the app's existing profile-plot and timestep-jump UX.

## 11. Risks & open questions
- **INP export method** in epanet-js must be confirmed (exact `saveInpFile` /
  workspace-read API for the app's `epanet-js` version).
- **`epanet-js` version alignment** between the app and ptsnet (`^0.8.0`).
- **Isolation breakage**: validate `credentialless` against the app's third-party
  content and Safari support; have the `require-corp`/scoped-route fallback ready.
- **Performance** of large networks (worker-pool stage mitigates).
- **Licensing/contribution**: epanet-js is FSL-1.1-MIT; coordinate how the feature
  is contributed/maintained.

## 12. Verification at each stage
- **MVP**: Joukowsky order-of-magnitude check on a textbook reservoir–pipe–valve
  case; flow → 0 over closure; no UI freeze; clean error on missing isolation.
- **General correctness**: cross-check a scenario against ptsnet's own
  `examples/browser` demo for identical inputs.
- **Determinism**: a given `.inp` + config yields stable results across runs;
  when the worker pool is enabled, spot-check `workers:1` vs `workers:N` agree.
- **Per stage**: each new operation/device produces physically sensible extrema
  (e.g. protection device lowers peak head vs. the unprotected run).
