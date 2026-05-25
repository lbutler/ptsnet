/**
 * Quasi-steady friction — recompute the Darcy friction factor `f` each time step
 * from the *instantaneous* velocity instead of freezing it at the steady-state
 * value. As the velocity (hence Reynolds number) swings during a transient, the
 * real `f` changes; a frozen `f` slightly mis-damps the trace. This is the cheap
 * "stepping stone before Brunone" unsteady friction.
 *
 * We use the explicit Swamee–Jain approximation of the Colebrook–White law and
 * **anchor** it to the steady operating point so the model needs no extra input
 * and a no-transient run stays at steady state: per pipe we back out an effective
 * relative roughness `ε/D` from the steady `(f_steady, Re₀)` such that
 * `f(Re₀) = f_steady` exactly. This is formula-agnostic — it works whether the
 * `.inp` used Hazen–Williams or Darcy–Weisbach, since it only consumes the
 * resulting steady `f` and Reynolds number.
 *
 * The friction enters the MOC compatibility equations exactly like the steady
 * friction — as `R·|Q|` added to each characteristic impedance — except `R`
 * becomes `f(Re)·Rgeo` with `Rgeo = Δx/(2gDA²)` the (frozen) geometric part and
 * `f(Re)` recomputed from `Re = |Q|·D/(Aν)` each step. The per-point geometric
 * resistance `Rgeo`, the Reynolds factor `D/(Aν)`, and the effective relative
 * roughness are precomputed here. See {@link ./kernels} (and the duplicated
 * worker stencil in {@link ../parallel/parallelEngine}) for the runtime term.
 */
import { G, SteadyState } from './types';
import { EngineModel } from './serialModel';

/** Laminar/turbulent transition Reynolds number for the friction-factor law. */
export const RE_LAMINAR = 2000;

export interface QuasiSteadyFrictionOptions {
  /**
   * Kinematic viscosity ν [m²/s] used for the Reynolds number. Default 1e-6
   * (water at ~20 °C).
   */
  viscosity?: number;
}

/**
 * Darcy friction factor from the Reynolds number and relative roughness `ε/D`:
 * laminar `f = 64/Re` below {@link RE_LAMINAR}, otherwise the explicit
 * Swamee–Jain approximation of Colebrook–White
 * `f = 0.25 / [log10(ε/D / 3.7 + 5.74 / Re^0.9)]²`.
 */
export function swameeJain(Re: number, relRough: number): number {
  if (Re < RE_LAMINAR) return 64 / Re;
  const l = Math.log10(relRough / 3.7 + 5.74 / Re ** 0.9);
  return 0.25 / (l * l);
}

/**
 * Effective relative roughness `ε/D` backed out from the steady operating point
 * by inverting Swamee–Jain at `(fSteady, Re0)`, so `swameeJain(Re0, ε/D) = fSteady`.
 * The Swamee–Jain argument is < 1 (its log is negative), hence the `-0.5/√f`
 * root. Clamped to `≥ 0`; returns 0 when the steady point is laminar/zero-flow
 * (nothing to anchor to — fall back to a smooth pipe).
 */
export function effectiveRoughness(fSteady: number, Re0: number): number {
  if (!(Re0 >= RE_LAMINAR) || !(fSteady > 0)) return 0;
  const rr = 3.7 * (10 ** (-0.5 / Math.sqrt(fSteady)) - 5.74 / Re0 ** 0.9);
  return rr > 0 ? rr : 0;
}

/**
 * Build the per-point quasi-steady-friction constants: the geometric resistance
 * `Rgeo[i] = Δx/(2gDA²)` (so `fSteady·Rgeo` equals the frozen `model.R`), the
 * Reynolds factor `refac[i] = D/(Aν)` (so `Re = |Q|·refac`), and the per-pipe
 * effective relative roughness `rrough[i]`. Filled for **all** points of each
 * pipe (boundary points included — the interior stencil's end-term lines read
 * the boundary indices).
 */
export function buildQuasiSteadyFrictionFactors(
  ss: SteadyState,
  model: EngineModel,
  opts: QuasiSteadyFrictionOptions,
): { rgeo: Float64Array; refac: Float64Array; rrough: Float64Array } {
  const n = model.numPoints;
  const rgeo = new Float64Array(n);
  const refac = new Float64Array(n);
  const rrough = new Float64Array(n);
  const nu = opts.viscosity ?? 1e-6;
  const pipe = ss.pipe;
  for (let p = 0; p < pipe.n; p++) {
    const area = pipe.area[p];
    const d = pipe.diameter[p];
    const rg = pipe.dx[p] / (2 * G * d * area ** 2);
    const rf = d / (area * nu);
    const Re0 = Math.abs(pipe.flowrate[p]) * rf;
    const rr = effectiveRoughness(pipe.ffactor[p], Re0);
    for (let j = model.dboundary[p]; j <= model.uboundary[p]; j++) {
      rgeo[j] = rg;
      refac[j] = rf;
      rrough[j] = rr;
    }
  }
  return { rgeo, refac, rrough };
}
