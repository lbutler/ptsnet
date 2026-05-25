# CLAUDE.md

Guidance for AI agents working in this repo. Read this first — it captures the
architecture, conventions, and gotchas so you don't have to rediscover them.

## What this project is

**ptsnet** (`lbutler/ptsnet`, npm `ptsnet`) is a **TypeScript library for hydraulic
transient ("water hammer") simulation in pressurized pipe networks**. It is a port
of the Python *PTSNET*. The transient is solved with the **Method of
Characteristics (MOC)**; steady-state initial conditions come from
[`epanet-js`](https://www.npmjs.com/package/epanet-js) (OWA-EPANET 2.2) parsing an
EPANET `.inp` file. Pure TS, one runtime dependency (`epanet-js`).

## What we're currently doing

**Bringing the engine toward feature parity with Bentley HAMMER** (engine only — no
UI). The backlog, priorities, effort, and validation references live in
[`docs/hammer-feature-roadmap.md`](docs/hammer-feature-roadmap.md) — **check the
boxes there as work lands.**

Done so far (beyond the base MOC port): single worker-pool engine + inline
`workers:1`; column separation (DGCM cavitation: interior + valve + junction) with
a per-element validity report; check valves (pipe-based, auto-imports EPANET `CV`
pipes); pump trip with rotational inertia (forward quadrant) + forward-only pumps;
combination air/vacuum valves (finite-orifice); sub-atmospheric single-valve fix;
unsteady (Brunone) friction (Vítkovský instantaneous-acceleration term in the
interior stencil; composes with cavitation); surge-relief valve (SRV:
orifice-to-atmosphere at a degree-2 node, gauge-head setpoint with finite
open/close rates + optional reseat); one-way surge tank (open tank + check valve
at a degree-2 node: feeds the line on the down-surge, shut on the up-surge, drains
to a bottom level with an optional refill orifice).
**Next on the roadmap: four-quadrant pump characteristics (or surge-anticipator valve).**

## Architecture & where the code lives

Data flow: `.inp` → steady state → discretize → build engine model → step loop
(interior MOC on workers + boundary kernels on the main thread) → recorded results.

| File | Role |
| --- | --- |
| `src/core/simulation.ts` | **Public API** — `PtsnetSimulation` (`create`, `run`/`runAsync`/`runStep`, all `define*`/`add*` operations, results getters). Start here for API work. |
| `src/epanet/initialConditions.ts` | Steady-state solve via `epanet-js` → `SteadyState` tables. |
| `src/epanet/units.ts` | Unit conversions (EPANET ↔ SI). |
| `src/core/types.ts` | `SteadyState`, element tables (`NodeTable`/`PipeTable`/`PumpTable`/`ValveTable`), protection/air-valve structs, constants (`G`, `NODE_*`). |
| `src/core/discretize.ts` | Pipe → computational points; wave-speed methods. |
| `src/core/serialModel.ts` | `buildEngineModel()` → `EngineModel`: point arrays, per-pipe `dboundary`/`uboundary`, junction/valve/pump/protection/check/air groupings. **Element placement logic lives here.** |
| `src/parallel/parallelEngine.ts` | **The engine.** Owns the SharedArrayBuffer columns + `BoundaryState`, drives each step. The **interior MOC stencil is an `eval`'d worker-source string here.** Also holds the cavitation (DGCM) gas state. |
| `src/parallel/workerBackend.ts` | Spawns workers (Node `worker_threads` / browser `Worker`); `resolveBackend()` returns `null` if SharedArrayBuffer is unavailable. |
| `src/core/kernels.ts` | **All boundary-element math** (`runGeneralJunction`, `runCheckValves`, `runValveStep`, `runPumpStep`, `runPumpTrip`, `runOpenProtections`, `runClosedProtections`, `runAirValves`) + the inline-path interior stencils (`runInteriorStep`, `runInteriorStepCav`). |
| `src/core/boundaryPhase.ts` | `runBoundaryPhase()` — calls the boundary kernels **in order** each step (main thread); defines `BoundaryState` (persistent per-step state) and the cavitation/pump-trip state structs. |
| `src/core/recorder.ts`, `src/core/results.ts` | Result storage (labeled typed-array series), envelopes, the cavitation report, (de)serialization. |
| `src/core/math.ts` | `newton`, `cubicSpline`, `linspace`, `roundHalfEven`, `pyFloorDiv`, etc. |
| `src/index.ts` | Public exports — add new public types/options here. |

## The single engine (important)

There is **one engine**: the SharedArrayBuffer-backed worker pool
(`ParallelEngine`). There is no serial engine.
- `create()` **throws** if SAB-backed workers are unavailable (Node
  `worker_threads`, or a cross-origin-isolated browser). No fallback.
- `parallel: { workers }` sizes the pool; **`workers: 1` runs the interior stencil
  inline on the calling thread** (no worker spawn / barrier) — best for small nets.
- **Workers compute interior pipe points only; all boundary kernels run on the main
  thread.** So any boundary element is automatically worker-count invariant.
- `run()` is synchronous (`Atomics.wait`, Node only). In the browser use
  `await runAsync()` (`Atomics.waitAsync`).
- The interior stencil exists **twice**: the worker-source string in
  `parallelEngine.ts` and `runInteriorStep`/`runInteriorStepCav` in `kernels.ts`
  (the inline path). **Keep them in sync.**

## Recipe: adding a boundary element (the common task)

Most HAMMER features are boundary elements at a node or pipe. Established pattern:

1. **Type** in `types.ts` (a struct + a `Map` on `SteadyState`, or a flag on a
   table — e.g. `pipe.isCheckValve`). Init it in `initialConditions.ts`.
2. **API** in `simulation.ts` (`addX(...)` / `defineX(...)`). Validate placement
   (degree-2 node "between two pipes" mirrors `addSurgeProtection`/`addCheckValve`).
3. **Model wiring** in `serialModel.ts`: resolve the element to its computational
   point(s) via `boundaryAtNode[node]` (`u` = uboundary/C+, `d` = dboundary/C−) and
   add arrays to `EngineModel` (build + interface + return). A degree-2 node element
   reuses the same `u`/`d` pattern as the surge tanks.
4. **Kernel** in `kernels.ts`. Boundary-node elements run **after**
   `runGeneralJunction`, which already solves a degree-2 node as a transparent
   series junction and **normalizes** the boundary characteristics (so at those
   points `Q_u = Cp[u] − H·Bp[u]`, `Q_d = H·Bm[e] − Cm[e]`, `CC = Cp[u]+Cm[e]`,
   `BB = Bp[u]+Bm[e]`, junction head `= CC/BB`). Override the node head/flows.
5. **Persistent state** (if the element has memory): add arrays to `BoundaryState`
   (`makeBoundaryState`, sized from the model) and read/update them in place each
   step. See `runClosedProtections` (surge tank) and `runAirValves` as templates.
6. **Call** it from `runBoundaryPhase` guarded by `if (model.xStart.length > 0)`
   so the default path is untouched.
7. **Export** new public option types from `index.ts`.
8. **Test + docs** (below), and tick the roadmap box.

Notes: gas-pocket elements (closed surge tank, air valve) follow the same gas-law +
Newton/bisection structure. Cavitation (DGCM) adds a second flow face (`qu`/`qd`)
and is threaded via the `CavState` object — only relevant in cavitation mode.

## How to build, test, verify

```bash
npm test            # vitest (all suites)
npx vitest run test/airValve.test.ts   # one suite
npm run typecheck   # tsc --noEmit
npm run build       # vite + d.ts
npm run bench       # bench/run.ts (TNET3)
```

Test conventions (see `test/*.test.ts`):
- Build a scenario from an inline EPANET `.inp` string, `create()`, call
  `define*`/`add*`, `run()`, then assert **min/max over a recorded series**,
  finiteness, and comparisons to theory (Joukowsky `a·V₀/g`, vapor head, etc.).
- **Python parity** (`test/parity.test.ts`) diffs against
  `compare/python_results.json` (per-scenario tolerances). The default
  (feature-off) path must stay byte-identical — guard new kernels so they no-op
  when the element isn't present. Some cases intentionally deviate (documented in
  the README "Differences from Python" + replaced by behavior tests).
- **HAMMER validation**: `test/validationHammer.test.ts`.
- For a new boundary feature, assert **worker-count invariance** (`workers: 1` vs
  `4` → bit-identical) — it's the cheapest correctness check (e.g. `airValve.test.ts`).
- Quick experiments: `npx tsx /tmp/foo.mjs` importing
  `'/home/user/ptsnet/src/index.ts'` (absolute path).

## Conventions & workflow

- **Branch off `development`, open a PR back into `development`.** Branch names
  `claude/<feature>`. Each feature PR = kernel + model wiring + API + tests +
  README + roadmap tick. Don't push to `main`.
- GitHub access is via the **GitHub MCP tools** (`mcp__github__*`), restricted to
  `lbutler/ptsnet`. No `gh` CLI.
- Keep the **default path byte-identical**; surface (don't silently rebaseline)
  any parity change.
- Validation style: this is research-grade physics. Validate against literature
  (Wylie & Streeter, Chaudhry, Bergant) and **physical invariants/relative
  behavior**, not only fixed numbers. Be honest about model limitations.

## Gotchas

- **Bare engine (no cavitation) allows sub-vapor heads** — finite but unphysical;
  column separation needs `create({ cavitation: true })` (DGCM).
- **Single (end) valves** discharge to atmosphere (`Q = K0·√(2gH)`, `H ≥ 0`) — they
  dead-end when sub-atmospheric. **Inline valves** (between two pipes) use a
  sign-aware solve and don't have that issue; prefer them for clean test triggers.
- **Pumps are forward-only** (implicit discharge check valve, matching EPANET).
- A node with a **valve or pump** attached is not a "junction" and is excluded from
  degree-2 boundary-element placement (`nonPipeNode` in `serialModel.ts`).
- HAMMER theory help (for formulas) is at `docs.bentley.com/.../GUID-*.html`;
  fetch specific GUID pages with WebFetch. PDFs need `apt-get install poppler-utils`.

## Repo map (non-`src`)

`test/` suites · `compare/python_results.json` parity reference · `examples/`
sample `.inp` networks + browser demo (`npm run demo`) · `bench/run.ts` ·
`docs/hammer-feature-roadmap.md` the backlog.
