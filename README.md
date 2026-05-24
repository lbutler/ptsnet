<p align="center">
  <img src="https://github.com/gandresr/PTSNET/raw/development/docs/images/ptsnet_logo.png" alt="Logo" width="650" height="100">
</p>

<p align="center">
  <b>ptsnet</b> — Transient Simulation in Water Networks, in TypeScript
</p>

`ptsnet` is a TypeScript port of [PTSNET](https://github.com/gandresr/PTSNET), a
simulator for hydraulic transients (water hammer) in water distribution
networks using the **Method of Characteristics (MOC)**. It runs in Node.js and
in the browser, and is published as a library.

Steady-state initial conditions are obtained from
[`epanet-js`](https://github.com/modelcreate/epanet-js) (OWA‑EPANET 2.2); the
transient solution is computed by a self-contained serial MOC engine.

> This package is a conversion of the original Python research code. See
> [Differences from the Python version](#differences-from-the-python-version)
> and [Python ↔ JavaScript parity](#python--javascript-parity) below.

## Installation

```sh
npm install ptsnet epanet-js
```

`epanet-js` is a peer/runtime dependency (it ships the EPANET WASM engine and is
kept external from the bundle).

## Usage

```ts
import { PtsnetSimulation } from 'ptsnet';

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
sim.defineValveOperation(names, { initialSetting, finalSetting, startTime, endTime });
sim.definePumpOperation(names, { initialSetting, finalSetting, startTime, endTime });
sim.addBurst(nodeNames, burstCoeff, startTime, endTime);
sim.addSurgeProtection(nodeName, 'open',   tankArea);
sim.addSurgeProtection(nodeName, 'closed', tankArea, tankHeight, waterLevel);
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

## Differences from the Python version

The port is faithful to the numerical engine (see parity numbers below). The
following structural changes were made to fit a JavaScript library:

- **Serial engine.** The Python code parallelizes points across MPI ranks
  (`mpi4py`). JavaScript has no MPI, so this port runs a single serial engine
  that owns every point. The kernels operate on plain typed arrays, so the same
  shape can back a Web Worker / `worker_threads` implementation later.
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

## Python ↔ JavaScript parity

The transient engine is validated against the original Python PTSNET. For an
apples-to-apples comparison, both sides use OWA‑EPANET 2.2 for the steady state
(the Python loader is pointed at PTSNET's bundled `libepanet22_amd64.so`; the
default loader would otherwise pick the older EPANET 2.0 build). The Python
reference is generated by [`compare/run_python.py`](compare/run_python.py) and
checked by [`test/parity.test.ts`](test/parity.test.ts).

| Scenario | Network | Steps × points | Max head difference |
| --- | --- | --- | --- |
| `simple` | reservoir → pipe → junction (no valves/pumps) | 20 × 42 | **≈1 × 10⁻⁶ m** |
| `hammer` | rapid inline-valve closure (Joukowsky surge) | 80 × 42 | **7.3 × 10⁻⁴ m** |
| `tnet3`  | full network: 129 nodes, 168 pipes, 2 pumps, 8 valves; `VALVE-179` closure | 523 × 5098 | **6.3 × 10⁻⁵ m** |

(The committed reference is rounded to 10⁻⁶ m to keep the fixture small; the
unrounded `simple` agreement is ≈5 × 10⁻⁷ m.)

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

## Development

```sh
npm install
npm test          # vitest (includes the Python-parity check)
npm run build     # vite library build (ESM + CJS) + .d.ts
npm run typecheck
```

### Regenerating the Python reference

The committed `compare/python_results.json` is produced from the original Python
code (kept in [`ptsnet/`](ptsnet)). It requires a pinned environment because the
Python code uses removed NumPy aliases (`np.int`/`np.float`) and `mpi4py`:

```sh
sudo apt-get install -y libopenmpi-dev openmpi-bin   # for mpi4py
python3 -m venv .venv-py && . .venv-py/bin/activate
pip install "numpy==1.23.5" "scipy==1.10.1" "pandas==2.0.3" \
            "matplotlib==3.7.3" "networkx==3.1" mpi4py h5py tqdm \
            "numba==0.57.1" kneed "wntr==1.1.0"
python compare/run_python.py
```

See [`compare/README.md`](compare/README.md) for details.

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
