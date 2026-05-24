# Python ↔ JavaScript parity harness

This directory cross-checks the TypeScript port against the original Python
PTSNET so we can be confident the conversion is numerically faithful.

## How it works

1. [`run_python.py`](run_python.py) runs the **original Python code** (in
   [`../ptsnet`](../ptsnet)) on three scenarios and writes the head and pipe-flow
   time series to [`python_results.json`](python_results.json).
2. [`../test/parity.test.ts`](../test/parity.test.ts) runs the **TypeScript
   engine** on the same scenarios and asserts the results match the committed
   JSON within tight tolerances.

`python_results.json` is committed so `npm test` validates parity without needing
Python installed. The parity test skips automatically if the file is absent.

## Scenarios

| Name | Description |
| --- | --- |
| `simple` | reservoir → pipe → junction (demand). No valves/pumps — exercises only the interior + junction MOC kernels. |
| `hammer` | reservoir → pipe → inline valve → pipe → reservoir, with a rapid valve closure (Joukowsky surge). |
| `tnet3`  | the bundled `TNET3` network (129 nodes, 168 pipes, 2 pumps, 8 valves) with `VALVE-179` closing, using the adaptive `optimal` time step. |

## Results

Maximum absolute head difference between Python and TypeScript:

| Scenario | Steps × points | Max head diff |
| --- | --- | --- |
| `simple` | 20 × 42 | 5.3 × 10⁻⁷ m |
| `hammer` | 80 × 42 | 7.3 × 10⁻⁴ m |
| `tnet3`  | 523 × 5098 | 6.3 × 10⁻⁵ m |

`simple` agrees to the precision of EPANET's single-precision steady-state
output, i.e. the core engine is effectively bit-faithful.

## Engine parity caveat

Both sides must use the **same EPANET version** for the steady state. epanet-js
uses OWA‑EPANET 2.2. PTSNET ships two Linux libraries and its loader picks
`libepanet2_amd64.so` (EPANET 2.0) first, which produces different tank/pump
steady states. `run_python.py` therefore patches the loader to use the bundled
`libepanet22_amd64.so` (2.2). Without this, `tnet3` head differences reach
several metres (purely from the 2.0-vs-2.2 steady state, not the transient).

## Regenerating `python_results.json`

The Python code needs a pinned environment (it uses removed NumPy aliases
`np.int` / `np.float`, and `mpi4py`):

```sh
sudo apt-get install -y libopenmpi-dev openmpi-bin
python3 -m venv ../.venv-py && . ../.venv-py/bin/activate
pip install "numpy==1.23.5" "scipy==1.10.1" "pandas==2.0.3" \
            "matplotlib==3.7.3" "networkx==3.1" mpi4py h5py tqdm \
            "numba==0.57.1" kneed "wntr==1.1.0"
python run_python.py
```

`wntr` is used only for `.inp` parsing/topology in the Python code; its EPANET
build is not used (PTSNET uses its own bundled library for the hydraulic solve).
