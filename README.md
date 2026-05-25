<p align="center">
  <img src="https://github.com/gandresr/PTSNET/raw/development/docs/images/ptsnet_logo.png" alt="Logo" width="650" height="100">
</p>

<p align="center">
  <b>ptsnet</b> — Transient Simulation in Water Networks, in TypeScript
</p>

<p align="center">
  <a href="https://github.com/lbutler/ptsnet/actions/workflows/ci.yml"><img src="https://github.com/lbutler/ptsnet/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

`ptsnet` is a TypeScript port of [PTSNET](https://github.com/gandresr/PTSNET), a
simulator for hydraulic transients (water hammer) in water distribution
networks using the **Method of Characteristics (MOC)**. It runs in Node.js and
in the browser, and is published as a library.

Steady-state initial conditions are obtained from
[`epanet-js`](https://github.com/modelcreate/epanet-js) (OWA‑EPANET 2.2); the
transient solution is computed by a self-contained MOC engine that runs on a
`SharedArrayBuffer`-backed worker pool.

> This package is a conversion of the original Python research code. See
> [Differences from the Python version](#differences-from-the-python-version)
> and [Python ↔ JavaScript parity](#python--javascript-parity) below.

## Installation

```sh
npm install @epanet-js/ptsnet epanet-js
```

`epanet-js` is a peer/runtime dependency (it ships the EPANET WASM engine and is
kept external from the bundle).

## Usage

```ts
import { PtsnetSimulation } from '@epanet-js/ptsnet';

// `inp` is the text of an EPANET .inp file.
const sim = await PtsnetSimulation.create({
  inp: inpFileContents,
  settings: { duration: 20, timeStep: 0.01 },
});

// Close VALVE-179 linearly between t = 1 s and t = 2 s.
sim.defineValveOperation('VALVE-179', {
  initialSetting: 1,
  finalSetting: 0,
  startTime: 1,
  endTime: 2,
});

sim.run();

// Results are labeled time series (Float64Array, one value per time step).
const time = sim.time;                                   // time stamps [s]
const head = sim.results.node.head.get('JUNCTION-73');   // head [m] over time
const flow = sim.results.pipeStart.flowrate.get('PIPE-1');
```

Reading an `.inp` file in Node:

```ts
import { readFileSync } from 'node:fs';
const sim = await PtsnetSimulation.create({ inp: readFileSync('net.inp', 'utf8') });
```

### Operations

```ts
sim.defineValveOperation(names, { initialSetting, finalSetting, startTime, endTime, valveType });
                             // valveType: butterfly (default) | globe | gate | ball | needle —
                             // built-in inherent characteristic curves (relative Cv vs % open)

sim.definePumpOperation(names, { initialSetting, finalSetting, startTime, endTime });
sim.definePumpTrip(pumpName, { tripTime, inertia, ratedSpeed, ratedEfficiency }); // power failure: speed coasts down on inertia
sim.addBurst(nodeNames, burstCoeff, startTime, endTime);
sim.addSurgeProtection(nodeName, 'open',   tankArea);
sim.addSurgeProtection(nodeName, 'closed', tankArea, tankHeight, waterLevel);
sim.addSurgeProtection(nodeName, 'open',   tankArea, undefined, undefined,
                       { orificeArea, maxLevel, minLevel, initialLevel });
                             // open-tank enhancements: a throttling orifice at the
                             // connection (head loss Cf·Q|Q|), an overflow at maxLevel,
                             // and an empty level minLevel below which it runs dry.
                             // Omit them all for the plain, bottomless, direct standpipe.
sim.addCheckValve(pipeName); // forward-flow-only pipe; shuts on reversal (no backflow).
                             // EPANET CV-status pipes are honored automatically.
sim.addAirValve(nodeName, { inflowArea, outflowArea }); // combination air/vacuum valve at a high point
sim.addSurgeReliefValve(nodeName, { setpoint, area, openTime, closeTime, reseat });
                             // pressure-relief valve: opens above the gauge-head setpoint,
                             // vents to atmosphere, recloses below reseat (defaults to setpoint)
sim.addOneWaySurgeTank(nodeName, { tankArea, initialLevel, bottomLevel, refillArea });
                             // open tank + check valve: feeds the line on a down-surge
                             // (caps it near the tank level), shut on the up-surge so it
                             // passes through; drains to bottomLevel, optional slow refill.
                             // initialLevel defaults to the steady head, bottomLevel to the node elevation
```

Column separation and friction models are `create` options, not operations:

```ts
PtsnetSimulation.create({ inp, settings, cavitation: true });           // column separation (DGCM)
PtsnetSimulation.create({ inp, settings, unsteadyFriction: true });     // Brunone unsteady friction
PtsnetSimulation.create({ inp, settings, quasiSteadyFriction: true });  // recompute f from instantaneous V
```

### Results

`sim.results` exposes labeled [`ResultSeries`](src/core/results.ts):

| Accessor | Quantity | Rows |
| --- | --- | --- |
| `results.node.head` | hydraulic head `[m]` | every node with a representative point |
| `results.node.leakFlow` / `demandFlow` | emitter / demand flow `[m³/s]` | junction nodes |
| `results.pipeStart.flowrate` / `pipeEnd.flowrate` | flow at pipe ends `[m³/s]` | every pipe |

```ts
const series = sim.results.node.head.get('JUNCTION-73'); // Float64Array
const value  = sim.results.node.head.at('JUNCTION-73', 10); // value at step 10
const labels = sim.results.node.head.labels;
```

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `duration` | `20` | transient duration `[s]` |
| `timeStep` | `0.01` | requested time step `[s]` (may be reduced by the wave-speed method) |
| `defaultWaveSpeed` | `1000` | wave speed `[m/s]` applied to all pipes (`null` to use `waveSpeeds`) |
| `waveSpeedMethod` | `'optimal'` | `'optimal' \| 'critical' \| 'user' \| 'dt'` |
| `waveSpeeds` | – | per-pipe wave speeds `{ [pipeLabel]: number }` |
| `period` | `0` | EPANET extended-period index for the initial conditions |
| `skipCompatibilityCheck` | `false` | skip the model validation pass |

All physical quantities are SI (m, m³/s, m of head), matching the original.

### Recording (large models)

By default every node and pipe is recorded at every time step. For large
networks or long runs the full `elements × steps` matrix can be huge (a 20 s
transient of a 12.5k-node model at the default `optimal` time step is ~18 GB), so
recording is configurable:

```ts
const sim = await PtsnetSimulation.create({
  inp,
  settings: { duration: 20, timeStep: 0.05 },
  recording: {
    nodes: ['JUNCTION-73'],   // string[] | 'all' (default) | 'none'
    pipes: 'none',            // string[] | 'all' (default) | 'none'
    every: 10,                // keep one sample every 10 steps (t=0 always kept)
    envelope: true,           // also track per-element min/max over every step
    pipeProfileHead: true,    // also keep head at every interior point of every pipe
  },
});
sim.run();

sim.results.node.head.get('JUNCTION-73'); // downsampled series
sim.envelope!.node.headMax;               // max head at every node (O(elements))
```

`envelope` tracks per-element extrema over *all* steps (independent of the
`nodes`/`pipes`/`every` selection), so `nodes: 'none', pipes: 'none', envelope:
true` gives the full pressure envelope at O(elements) memory — bounded
regardless of run length.

`pipeProfileHead` keeps the head at **every discretization point** (interior +
boundary) of every pipe each recorded step, exposed as `sim.results.pipeProfile`
— so you can read head *along* a pipe (e.g. a travelling pressure-wave overlay),
not just at its end nodes. It honours `every` but its memory is
O(numPoints × recorded steps) (potentially large), so it's intended for small
networks / visualization. The data is laid out step-major: head for step `t` at
point `j` is `data[t*numPoints + j]`, and pipe `p`'s profile (start node → end
node) is the contiguous block `data[t*numPoints + offset[p] .. + offset[p] +
segments[p]]`.

```ts
const pp = sim.results.pipeProfile!;
const p  = pp.labels.indexOf('PIPE-12');
const t  = pp.cols - 1;                                  // last recorded step
const start = pp.offset[p];
const profile = pp.data.subarray(                        // head start→end of PIPE-12
  t * pp.numPoints + start,
  t * pp.numPoints + start + pp.segments[p] + 1,
);
```

### Progress, streaming & cancellation

`run()` / `runAsync()` accept callbacks and an `AbortSignal`:

```ts
const controller = new AbortController();
await sim.runAsync({
  signal: controller.signal,                       // cancel; partial results remain on sim.results
  onProgress: ({ fraction }) => updateBar(fraction),
  onStep: (step) => {                              // stream live values (e.g. for plotting)
    if (step % 50 === 0) draw(sim.results.node.head.get('JUNCTION-73'));
  },
  progressInterval: 25,                            // steps between onProgress calls
});
```

Aborting throws an `AbortError` (or the signal's `reason`); whatever was computed
before the abort stays available on `sim.results`.

### The engine (always parallel)

There is a single engine and it always runs the interior MOC stencil — ~99% of
the per-step work, and embarrassingly parallel — on a worker pool (Node
`worker_threads` or browser Web Workers). Tune the pool size with `parallel`:

```ts
const sim = await PtsnetSimulation.create({
  inp,
  settings: { duration: 20, timeStep: 0.05 },
  recording: { nodes: 'none', pipes: 'none', envelope: true }, // bound memory
  parallel: { workers: 8 }, // defaults to navigator.hardwareConcurrency
});
```

Point arrays live in a `SharedArrayBuffer`; each worker owns a contiguous point
range and reads the shared previous-step columns, so there is **no ghost
exchange** and results are **independent of the worker count**. Only the cheap
boundary kernels run on the main thread.

`workers: 1` (the default on a single-core host) runs the interior stencil
**inline on the calling thread** — no worker spawn, no per-step barrier — so
small and medium networks aren't taxed by parallel overhead. Reach for more
workers on large models, where the per-step interior work dominates the barrier
cost. (On a 5k-point TNET3, `workers: 1` beats `workers: 4` because the barrier
overhead outweighs the parallelism; on millions of points the reverse holds.)

#### `run()` vs `runAsync()`

```ts
sim.run();            // synchronous; Node only (blocks the thread on Atomics.wait)
await sim.runAsync(); // non-blocking; required in the browser, works everywhere
```

`run()` blocks the calling thread on `Atomics.wait`, which the browser main
thread forbids — so **in the browser use `await sim.runAsync()`** (it uses
`Atomics.waitAsync` and keeps the page responsive). Both auto-release the worker
pool when finished; for manual `runStep`/`runStepAsync` loops call `sim.dispose()`.

#### Browser requirements

`SharedArrayBuffer` needs the page to be **cross-origin isolated**, i.e. served
with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If `SharedArrayBuffer`-backed workers are unavailable (a page without those
headers, or no `worker_threads`), `create()` **throws** — there is no serial
fallback.

### Interactive playground

```bash
npm run demo   # serves examples/browser with the required COOP/COEP headers
```

A browser playground for exploring the engine: pick a bundled example network (or
load your own `.inp`), set the run parameters (duration, time step, wave speed,
cavitation), choose a transient event (valve closure or pump trip), run it, and
plot node-head and pipe-flow series. No map — just controls and charts.

On BWSN_F (12,530 nodes, ~3.2 M discretization points), per-step cost on a
4-core machine:

| Workers | ms/step | Speedup |
| --- | --- | --- |
| 1 | 68.9 | 1.0× |
| 2 | 30.0 | 2.3× |
| 4 | 19.1 | 3.6× |

### Column separation (DGCM)

The basic MOC lets head drop arbitrarily below the liquid vapor pressure, which
is unphysical (and makes the valve kernel `sqrt` a negative head). Enable column
separation with the **Discrete Gas Cavity Model** to clamp head at vapor
pressure:

```ts
const sim = await PtsnetSimulation.create({
  inp,
  settings: { duration: 0.5, timeStep: 5e-4, defaultWaveSpeed: 1319, waveSpeedMethod: 'user' },
  cavitation: true, // or { voidFraction, vaporHead, barometricHead, psi }
});
sim.run();
sim.maxCavityVolume; // largest vapor-cavity volume anywhere [m³]

const report = sim.cavitationReport()!;
report.valid;            // false if any cavity outgrew its mesh cell (A·Δx)
report.worstFillFraction;// largest cavity / mesh-cell ratio
report.nodes;            // [{ label, maxVolume, fillFraction }, …] junctions & end valves
report.pipes;            // [{ label, maxVolume, fillFraction }, …] per pipe (interior peak)
```

A tiny free-gas void fraction (α₀ ≈ 1e-7) is concentrated at each point; its
volume follows the isothermal gas law and varies smoothly with pressure, which
damps the 2Δt grid oscillation that makes the simpler Discrete *Vapor* Cavity
Model spike. Cavities form at **interior points, single/end valves, and junction
nodes** (high points, knees, multi-pipe junctions): the workers solve the
per-point gas quadratic, and the main-thread boundary phase adds the valve and
junction-node gas cavities. Validated in [`test/cavitation.test.ts`](test/cavitation.test.ts)
on the canonical **Bergant–Simpson reservoir–pipe–valve** case (head clamps at the
vapor head, a cavity forms and collapses into a short-duration pulse exceeding the
Joukowsky rise — "active" column separation — and the first peak matches `a·V₀/g`)
and on a high-point junction that clamps at its own elevation-set vapor head.
Column separation is **opt-in**; default (cavitation off) runs are unchanged.

`cavitationReport()` gives per-element peak cavity volumes (HAMMER records these
per point) plus a `valid` flag — false when a cavity reached its mesh-cell volume,
the point past which the discrete-cavity assumption breaks down. HAMMER leaves
that check to the user; here it's surfaced (and, with `warningsOn`, logged).

> Note: this is a *physical-correctness* feature, not a way to match the bundled
> HAMMER references — those were run without column separation (their heads reach
> ≈ −327 m pressure head), so cavitation makes ptsnet diverge from them by being
> more physical, not less.

### Unsteady (Brunone) friction

Steady (Darcy–Weisbach / Hazen–Williams) friction under-damps the repeated peaks
of a transient: the measured pressure trace decays faster than the steady-friction
MOC predicts. Enable **unsteady friction** to add the Brunone
instantaneous-acceleration term (Vítkovský formulation), which damps those peaks
realistically:

```ts
const sim = await PtsnetSimulation.create({
  inp,
  settings: { duration: 3, timeStep: 2e-4, defaultWaveSpeed: 1200, waveSpeedMethod: 'user' },
  unsteadyFriction: true, // or { coefficient, viscosity }
});
```

The extra friction slope is

```
J_u = (k / (g·A))·( ∂Q/∂t + a·sign(Q)·|∂Q/∂x| )
```

with the `sign()` (Vítkovský) making it valid for both flow/wave directions
(Brunone's original `∂Q/∂t − a·∂Q/∂x` cancels for an upstream-travelling wave).
It folds into the interior MOC stencil: the local-acceleration part is taken at
the new time level (implicit — this is what keeps the explicit convective part
stable), adding `k·B` to each characteristic impedance, and slots in exactly like
the steady friction.

The **Brunone coefficient `k`** is either supplied (`{ coefficient: 0.03 }`, a
constant for every pipe) or, by default, estimated per pipe from the Vardy–Brown
shear-decay coefficient C* and the steady Reynolds number, `k = √C*/2` (HAMMER's
recommended *Transient Friction* method; `{ viscosity }` sets ν for the Reynolds
number, default 1e-6 m²/s). Validated in
[`test/unsteadyFriction.test.ts`](test/unsteadyFriction.test.ts) on a
reservoir–pipe–valve line: the first (Joukowsky) peak is unchanged while the later
oscillations decay markedly faster, a larger `k` damps more, and the result is
bit-identical across worker counts. Unsteady friction is **opt-in** (default runs
are byte-identical), composes with column separation, and matters most for
small-scale / laboratory pipelines (its damping signature shrinks on large
transmission mains).

### Quasi-steady friction

The base engine freezes the Darcy friction factor `f` at its steady-state value.
As the velocity (hence Reynolds number) swings during a transient the real `f`
changes, so a frozen `f` slightly mis-damps the trace. **Quasi-steady friction**
recomputes `f` each step from the *instantaneous* velocity using the explicit
Swamee–Jain approximation of Colebrook–White — a cheap, modest accuracy gain and
the stepping stone before Brunone:

```ts
const sim = await PtsnetSimulation.create({
  inp,
  settings: { duration: 3, timeStep: 2e-4, defaultWaveSpeed: 1200, waveSpeedMethod: 'user' },
  quasiSteadyFriction: true, // or { viscosity }
});
```

The MOC friction term `R·|Q|` becomes `f(Re)·Rgeo·|Q|`, with `Rgeo = Δx/(2gDA²)`
the geometric part and `Re = |Q|·D/(Aν)` (`{ viscosity }` sets ν, default
1e-6 m²/s). To stay formula-agnostic and need no extra input, the law is
**anchored to the steady operating point**: per pipe an effective relative
roughness `ε/D` is backed out from the steady `(f_steady, Re₀)` by inverting
Swamee–Jain, so `f(Re₀) = f_steady` exactly — it therefore works whether the
`.inp` used Hazen–Williams or Darcy–Weisbach, and a no-transient run stays at
steady state. Below `Re = 2000` it falls back to laminar `f = 64/Re`. Validated in
[`test/quasiSteadyFriction.test.ts`](test/quasiSteadyFriction.test.ts): the first
(Joukowsky) peak is essentially unchanged while later oscillations shift, the
recomputed factor matches Swamee–Jain, and the result is bit-identical across
worker counts. Quasi-steady friction is **opt-in** (default runs are
byte-identical) and composes with column separation and Brunone unsteady friction.

## Differences from the Python version

The port is faithful to the numerical engine (see parity numbers below). The
following structural changes were made to fit a JavaScript library:

- **Worker-pool engine.** The Python code parallelizes points across MPI ranks
  (`mpi4py`). JavaScript has no MPI, so this port partitions the points across a
  `SharedArrayBuffer`-backed worker pool (`worker_threads` / Web Workers) instead;
  the result is independent of the worker count.
- **epanet-js for initial conditions.** The steady-state solve and `.inp`
  parsing use `epanet-js` (OWA‑EPANET 2.2) instead of `wntr` + the bundled
  EPANET DLLs.
- **In-memory results.** Results are labeled typed-array series rather than
  HDF5 workspaces. Plotting (matplotlib), the HPC/TACC helpers, and the
  profiler are not ported.
- **Surge-tank state bug fixed.** In the Python kernels
  (`funcs.run_open_protections` / `run_closed_protections`) the tank state
  (`QT`, `HT`, `VA`) was rebound to local variables and **never written back**,
  so surge tanks did not accumulate state between time steps. This port
  persists that state, which is the physically intended behaviour. As a result,
  models that use surge-protection devices will differ from the Python output
  (by design); everything else matches.
- **Pumps are forward-only (discharge check valve).** Like EPANET, a pump never
  passes reverse flow: when the lift can no longer be sustained the pump isolates
  (the downstream reflects as a dead end) instead of holding its shutoff head.
  The Python reference held shutoff head on reversal, so a *single* pump's
  shutdown/trip diverges from it (inline pumps already dead-ended, so they
  match). This is why the `single_pump` parity case is replaced by behaviour
  tests in `test/pumpTrip.test.ts`.
- **Sub-atmospheric end valves.** A single (end) valve discharges to atmosphere
  via `Q = K0·√(2gH)`, valid only for gauge head `H ≥ 0`. When a down-surge drives
  it sub-atmospheric the correct boundary condition is no forward flow (`Q = 0`,
  dead-end reflection); the previous code took `√` of a negative head and produced
  `NaN`. Positive-head operation is unchanged.

## Python ↔ JavaScript parity

The transient engine was validated against the original Python PTSNET across
**17 scenarios covering every engine code path** (inline & single valves, inline
& single pumps, junctions/reservoirs/tanks, demand & emitter nodes, open &
closed surge tanks, all four wave-speed methods, custom schedules, and several
network topologies). For an apples-to-apples comparison, both sides use
OWA‑EPANET 2.2 for the steady state (the Python loader was pointed at PTSNET's
bundled `libepanet22_amd64.so`; the default loader would otherwise pick the older
EPANET 2.0 build). The frozen reference lives in
[`compare/python_results.json`](compare/python_results.json) (generated by
[`compare/run_python.py`](compare/run_python.py)) and is checked by
[`test/parity.test.ts`](test/parity.test.ts). Representative results:

| Scenario | Network | Steps × points | Max head difference |
| --- | --- | --- | --- |
| `simple` | reservoir → pipe → junction (no valves/pumps) | 20 × 42 | **≈1 × 10⁻⁶ m** |
| `hammer` | rapid inline-valve closure (Joukowsky surge) | 80 × 42 | **7.3 × 10⁻⁴ m** |
| `tnet3`  | full network: 129 nodes, 168 pipes, 2 pumps, 8 valves; `VALVE-179` closure | 523 × 5098 | **6.3 × 10⁻⁵ m** |
| `single_pump` / `single_valve` | end pump / end valve branches | 40 × 21 | **< 4 × 10⁻⁶ m** |
| `surge_open` / `surge_closed` | open / closed surge tanks | 60 × 42 | **1.4 × 10⁻⁶ m** |

(The committed reference is rounded to 10⁻⁶ m to keep the fixture small; the
unrounded `simple` agreement is ≈5 × 10⁻⁷ m. Surge tanks are compared against
*corrected* Python kernels — see the bug note above.)

The `simple` agreement is at the floor set by EPANET's single-precision
steady-state output, i.e. the core MOC is effectively bit-faithful. Getting the
valve scenarios to match required reproducing three Python-specific behaviours
exactly:

- **Float floor-division.** Python's `t // dt` differs from `Math.floor(t/dt)`
  (e.g. `0.5 // 0.05 === 9` in Python but `Math.floor(0.5/0.05) === 10`). This
  determines operation step indices; the port replicates CPython's `float.__floordiv__`.
- **Banker's rounding.** `numpy.round` / `round` round half-to-even when
  computing pipe segment counts and step totals.
- **EPS stepping quirk.** `get_initial_conditions` calls `ENnextH()` before the
  first `ENrunH()`, advancing an extended-period model by one hydraulic step
  before sampling. The port mirrors this exactly.

The only remaining (sub-0.1 mm) differences come from EPANET's float output and
a tiny pump-curve least-squares fit difference (`numpy.polyfit` SVD vs. normal
equations).

Beyond the cross-check, a [Joukowsky surge test](test/waterHammer.test.ts)
confirms a rapid inline-valve closure produces a head rise of `a·V₀/g` within
~3 %.

### Independent-solver validation (HAMMER)

The PTSNET paper ships reference head time series for the TNET3 valve/pump/burst
scenarios from PTSNET, TSNet and the commercial **Bentley HAMMER** solver
(`publication/SI_results`). [`test/validationHammer.test.ts`](test/validationHammer.test.ts)
confirms the TypeScript engine:

- **reproduces the published PTSNET results** — initial state identical, max
  deviation over 20 s of **1.5 m (valve), 0.03 m (pump), 0.006 m (burst)**; and
- **agrees with HAMMER** on the steady state (0.07 m) and the up-surge peaks
  (within **7.5%**).

Down-surge minima differ because HAMMER models column separation (vapor
cavities) and the basic MOC here does not — a known modeling difference, not an
error (and a candidate future feature).

## Development

```sh
npm install
npm test          # vitest (includes the Python-parity check)
npm run build     # vite library build (ESM + CJS) + .d.ts
npm run typecheck
npm run bench     # engine benchmark (TNET3)
```

A runnable usage example lives in [`examples/run.mjs`](examples/run.mjs).

### The original Python code

Now that the port is at parity, the original Python PTSNET has been removed from
the working tree (it remains in git history). The frozen parity reference
(`compare/python_results.json`) keeps guarding against regressions. To regenerate
it you must restore the Python package from history; see
[`compare/README.md`](compare/README.md) for the exact steps.

## Publishing to npm (`@epanet-js/ptsnet`)

Released to the public npm registry under the `@epanet-js` scope. `package.json`
already sets `"name": "@epanet-js/ptsnet"` and `"publishConfig": { "access":
"public" }`, so a plain `npm publish` goes out publicly.

```sh
# 1. Confirm you're logged in to the right account
npm login            # or: npm whoami  to check

# 2. Green tests + a clean working tree (npm version requires this)
npm test
git status           # should report "nothing to commit, working tree clean"

# 3. Bump the version (writes package.json, commits, and creates a git tag)
npm version patch    # or: minor / major

# 4. Dry-run: inspect the tarball without uploading
npm publish --dry-run
#    └─ verify the package name is @epanet-js/ptsnet and the tarball
#       contains only dist/ and examples/

# 5. Publish (the build runs automatically via the prepublishOnly script)
npm publish          # add --otp=<code> if 2FA prompts you

# 6. Push the version commit and tag
git push --follow-tags
```

After it lands, verify at
<https://www.npmjs.com/package/@epanet-js/ptsnet> and smoke-test a clean
install in an empty directory: `npm install @epanet-js/ptsnet epanet-js`.

<!-- Cite Us -->
## Cite Us

If PTSNET has been useful for your research, please cite:

[PTSNet: A Parallel Transient Simulator for Water Transport Networks based on vectorization and distributed computing](https://www.sciencedirect.com/science/article/pii/S1364815222002547)

```
@article{riano2022ptsnet,
  title={PTSNet: A Parallel Transient Simulator for Water Transport Networks based on vectorization and distributed computing},
  author={Ria{\~n}o-Brice{\~n}o, Gerardo and Hodges, Ben R and Sela, Lina},
  journal={Environmental Modelling \& Software},
  volume={158},
  pages={105554},
  year={2022},
  publisher={Elsevier}
}
```

[Distributed and Vectorized Method of Characteristics for Fast Transient Simulations in Water Distribution Systems](https://onlinelibrary.wiley.com/doi/full/10.1111/mice.12709)

```
@article{riano2022distributed,
  title={Distributed and vectorized method of characteristics for fast transient simulations in water distribution systems},
  author={Ria{\~n}o-Brice{\~n}o, Gerardo and Sela, Lina and Hodges, Ben R},
  journal={Computer-Aided Civil and Infrastructure Engineering},
  year={2022},
  publisher={Wiley Online Library}
}
```

## License

Distributed under the Unlicense. See `LICENSE.txt`.

## Acknowledgements

Original PTSNET by Gerardo Riaño-Briceño and Lina Sela (UT Austin). The authors
acknowledge the Texas Advanced Computing Center (TACC). This work was supported
in part by NSF award 2015658 and EPA Cooperative Agreement No. 83595001.
