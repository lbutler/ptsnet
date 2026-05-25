/**
 * Unsteady (Brunone) friction — the instantaneous-acceleration term added to the
 * quasi-steady (Darcy–Weisbach) friction so repeated transient peaks decay at a
 * realistic rate instead of being under-damped.
 *
 * Vítkovský formulation (Vítkovský et al. 2006; Bergant, Simpson & Vítkovský
 * 2001), in discharge form:
 *
 *   J_u = (k / (g·A))·( ∂Q/∂t + a·sign(Q)·|∂Q/∂x| )
 *
 * The sign() makes it valid for both flow/wave directions (Brunone's original
 * `∂Q/∂t − a·∂Q/∂x` vanishes for an upstream-travelling wave). The Brunone
 * coefficient `k` is either supplied or estimated from Vardy & Brown's shear-decay
 * coefficient C* and the steady Reynolds number, `k = √C* / 2`.
 *
 * The reach head-loss `ΔH_u = Δx·J_u` is lumped at each interior point i. With
 * Δx = a·Δt and B = a/(g·A) it is, for the new-time flow Q_i and previous-step
 * flows (superscript n),
 *
 *   ΔH_u,i = k·B·[ (Q_i − Q_i^n) + sign(Q_i^n)·|Q_{i+1}^n − Q_{i−1}^n|/2 ]
 *
 * The local-acceleration part is taken at the new time level (implicit), which
 * is what keeps the explicit convective part stable: it adds `k·B` to each
 * characteristic impedance and slots into the MOC compatibility equations like
 * the steady friction (`Bp,Bm ← +k·B`, `Cp,Cm` shifted by the explicit part).
 * The per-point factor `k·B` is precomputed here as `Ku`. See {@link ./kernels}
 * and the project README.
 */
import { SteadyState } from './types';
import { EngineModel } from './serialModel';

export interface UnsteadyFrictionOptions {
  /**
   * Brunone coefficient k (dimensionless). If omitted, it is computed per pipe
   * from the Vardy–Brown shear-decay coefficient C* and the steady Reynolds
   * number (`k = √C* / 2`).
   */
  coefficient?: number;
  /**
   * Kinematic viscosity ν [m²/s] used for the Reynolds number when `coefficient`
   * is not given. Default 1e-6 (water at ~20 °C).
   */
  viscosity?: number;
}

const RE_LAMINAR = 2300; // laminar/turbulent transition for C*
const C_STAR_LAMINAR = 0.00476; // Vardy–Brown shear-decay coefficient, laminar

/**
 * Brunone coefficient `k = √C* / 2` from the steady Reynolds number, using the
 * Vardy–Brown shear-decay coefficient C* (HAMMER's Transient Friction method):
 *   laminar:   C* = 0.00476
 *   turbulent: C* = 12.86 / Re^κ,  κ = log10(15.29 / Re^0.0567)
 */
export function brunoneCoefficient(Re: number): number {
  let cStar: number;
  if (Re < RE_LAMINAR) {
    cStar = C_STAR_LAMINAR;
  } else {
    const kappa = Math.log10(15.29 / Re ** 0.0567);
    cStar = 12.86 / Re ** kappa;
  }
  return Math.sqrt(cStar) / 2;
}

/**
 * Build the per-point unsteady-friction factor `Ku[i] = k·B[i]` (zero at pipe
 * boundary points — the term is applied at interior points only). `k` is either
 * the supplied constant or, per pipe, the Vardy–Brown estimate from the steady
 * Reynolds number.
 */
export function buildUnsteadyFrictionFactors(
  ss: SteadyState,
  model: EngineModel,
  opts: UnsteadyFrictionOptions,
): Float64Array {
  const Ku = new Float64Array(model.numPoints);
  const nu = opts.viscosity ?? 1e-6;
  for (let p = 0; p < ss.pipe.n; p++) {
    let k = opts.coefficient;
    if (k === undefined) {
      const v = Math.abs(ss.pipe.flowrate[p]) / ss.pipe.area[p];
      const Re = (v * ss.pipe.diameter[p]) / nu;
      k = brunoneCoefficient(Re);
    }
    const d = model.dboundary[p];
    const u = model.uboundary[p];
    for (let j = d + 1; j < u; j++) Ku[j] = k * model.B[j];
  }
  return Ku;
}
