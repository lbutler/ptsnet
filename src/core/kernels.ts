/**
 * Method-of-Characteristics step kernels.
 * Ported from the vectorized routines in `simulation/funcs.py`.
 */
import { G } from './types';
import { EngineModel } from './serialModel';
import { sign, newton } from './math';
import type { CavState, PumpTripState } from './boundaryPhase';

/**
 * Quasi-steady-friction impedance term `f(Re)·Rgeo·|Q|` that replaces the frozen
 * `R·|Q|`. Laminar (`Re < 2000`, matching `RE_LAMINAR` in `./quasiSteadyFriction`)
 * gives the linear term `64·Rgeo/refac` (constant in `|Q|`, finite as `|Q|→0`);
 * otherwise Swamee–Jain. Must stay in sync with the copy in the worker source.
 */
function qsfTerm(absQ: number, rgeo: number, refac: number, rrough: number): number {
  const re = absQ * refac;
  if (re < 2000) return (64 * rgeo) / refac;
  const l = Math.log10(rrough / 3.7 + 5.74 / re ** 0.9);
  return (0.25 / (l * l)) * rgeo * absQ;
}

/**
 * Interior MOC stencil for the inline (single-worker) path. Must stay in sync
 * with the plain branch of the worker source in `parallel/parallelEngine.ts`.
 *
 * When `Ku` is given, the Brunone unsteady-friction term is folded in: the
 * implicit local acceleration adds `k·B` to each characteristic impedance
 * (`Bp,Bm`) and the explicit convective term shifts `Cp,Cm`. See
 * {@link ./unsteadyFriction}.
 *
 * When `Rgeo` is given, quasi-steady friction is active: the frozen `R·|Q|`
 * impedance term is replaced by `f(Re)·Rgeo·|Q|` via {@link qsfTerm}. See
 * {@link ./quasiSteadyFriction}.
 */
export function runInteriorStep(
  Q0: Float64Array,
  H0: Float64Array,
  Q1: Float64Array,
  H1: Float64Array,
  B: Float64Array,
  R: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  hasPlus: Int32Array,
  hasMinus: Int32Array,
  Ku?: Float64Array,
  Rgeo?: Float64Array,
  Refac?: Float64Array,
  Rrough?: Float64Array,
): void {
  const n = Q0.length;
  for (let i = 1; i < n - 1; i++) {
    const fdn = Rgeo
      ? qsfTerm(Math.abs(Q0[i + 1]), Rgeo[i], Refac![i], Rrough![i])
      : R[i] * Math.abs(Q0[i + 1]);
    const fup = Rgeo
      ? qsfTerm(Math.abs(Q0[i - 1]), Rgeo[i], Refac![i], Rrough![i])
      : R[i] * Math.abs(Q0[i - 1]);
    Cm[i] = (H0[i + 1] - B[i] * Q0[i + 1]) * hasMinus[i];
    Bm[i] = (B[i] + fdn) * hasMinus[i];
    Cp[i] = (H0[i - 1] + B[i] * Q0[i - 1]) * hasPlus[i];
    Bp[i] = (B[i] + fup) * hasPlus[i];
    let cp = Cp[i];
    let cm = Cm[i];
    let bp = Bp[i];
    let bm = Bm[i];
    if (Ku) {
      const kB = Ku[i];
      const q = Q0[i];
      const e = kB * (sign(q) * Math.abs(Q0[i + 1] - Q0[i - 1]) * 0.5 - q);
      cp -= e;
      cm += e;
      bp += kB;
      bm += kB;
    }
    H1[i] = (cp * bm + cm * bp) / (bp + bm);
    Q1[i] = (cp - cm) / (bp + bm);
  }
  Cm[0] = H0[1] - B[0] * Q0[1];
  Cp[n - 1] = H0[n - 2] + B[n - 2] * Q0[n - 2];
  Bm[0] =
    B[0] +
    (Rgeo ? qsfTerm(Math.abs(Q0[1]), Rgeo[0], Refac![0], Rrough![0]) : R[0] * Math.abs(Q0[1]));
  Bp[n - 1] =
    B[n - 2] +
    (Rgeo
      ? qsfTerm(Math.abs(Q0[n - 2]), Rgeo[n - 2], Refac![n - 2], Rrough![n - 2])
      : R[n - 2] * Math.abs(Q0[n - 2]));
}

/**
 * Interior DGCM (column-separation) stencil for the inline path. Two flow faces
 * (qu/qd), a per-point gas quadratic, and a persistent gas volume. Must stay in
 * sync with the cavitation branch of the worker source.
 */
export function runInteriorStepCav(
  qd0: Float64Array,
  qu0: Float64Array,
  h0: Float64Array,
  qd1: Float64Array,
  qu1: Float64Array,
  h1: Float64Array,
  B: Float64Array,
  R: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  hasPlus: Int32Array,
  hasMinus: Int32Array,
  gasVol: Float64Array,
  Hgas: Float64Array,
  C3: Float64Array,
  dt: number,
  psi: number,
  Ku?: Float64Array,
  Rgeo?: Float64Array,
  Refac?: Float64Array,
  Rrough?: Float64Array,
): void {
  const n = h0.length;
  for (let i = 1; i < n - 1; i++) {
    const fup = Rgeo
      ? qsfTerm(Math.abs(qd0[i - 1]), Rgeo[i], Refac![i], Rrough![i])
      : R[i] * Math.abs(qd0[i - 1]);
    const fdn = Rgeo
      ? qsfTerm(Math.abs(qu0[i + 1]), Rgeo[i], Refac![i], Rrough![i])
      : R[i] * Math.abs(qu0[i + 1]);
    const cp0 = (h0[i - 1] + B[i] * qd0[i - 1]) * hasPlus[i];
    const bp = (B[i] + fup) * hasPlus[i];
    const cm0 = (h0[i + 1] - B[i] * qu0[i + 1]) * hasMinus[i];
    const bm = (B[i] + fdn) * hasMinus[i];
    Cp[i] = cp0;
    Bp[i] = bp;
    Cm[i] = cm0;
    Bm[i] = bm;
    if (hasPlus[i] && hasMinus[i]) {
      let cp = cp0;
      let cm = cm0;
      let bpu = bp;
      let bmu = bm;
      if (Ku) {
        const kB = Ku[i];
        const q = qd0[i];
        const e = kB * (sign(q) * Math.abs(qd0[i + 1] - qd0[i - 1]) * 0.5 - q);
        cp -= e;
        cm += e;
        bpu += kB;
        bmu += kB;
      }
      const invBp = 1 / bpu;
      const invBm = 1 / bmu;
      const B1 = invBp + invBm;
      const K1 = cp * invBp + cm * invBm;
      const Qc = gasVol[i] + dt * (1 - psi) * (qd0[i] - qu0[i]) - dt * psi * K1;
      const P = dt * psi * B1;
      const Hg = Hgas[i];
      const a = P;
      const b = Qc - P * Hg;
      const c = -Qc * Hg - C3[i];
      let disc = b * b - 4 * a * c;
      if (disc < 0) disc = 0;
      const H = (-b + Math.sqrt(disc)) / (2 * a);
      h1[i] = H;
      let vol = P * H + Qc;
      if (vol < 0) vol = 0;
      gasVol[i] = vol;
      qd1[i] = (H - cm) * invBm;
      qu1[i] = (cp - H) * invBp;
    }
  }
  Cm[0] = h0[1] - B[0] * qu0[1];
  Bm[0] =
    B[0] +
    (Rgeo ? qsfTerm(Math.abs(qu0[1]), Rgeo[0], Refac![0], Rrough![0]) : R[0] * Math.abs(qu0[1]));
  Cp[n - 1] = h0[n - 2] + B[n - 2] * qd0[n - 2];
  Bp[n - 1] =
    B[n - 2] +
    (Rgeo
      ? qsfTerm(Math.abs(qd0[n - 2]), Rgeo[n - 2], Refac![n - 2], Rrough![n - 2])
      : R[n - 2] * Math.abs(qd0[n - 2]));
}

/** Solve boundary points attached to general junction nodes (and reservoirs/tanks). */
export function runGeneralJunction(
  H0: Float64Array,
  Q1: Float64Array,
  H1: Float64Array,
  E1: Float64Array,
  D1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  Ke: Float64Array,
  Kd: Float64Array,
  Z: Float64Array,
  m: EngineModel,
  sc: Float64Array,
  sb: Float64Array,
  HH: Float64Array,
  cav?: CavState,
): void {
  const { jipDboundaries, jipUboundaries, jipPoints, jipNodeOfPoint, ajip, numJip } = m;

  for (let i = 0; i < jipDboundaries.length; i++) {
    const d = jipDboundaries[i];
    Cm[d] /= Bm[d];
    Bm[d] = 1 / Bm[d];
  }
  for (let i = 0; i < jipUboundaries.length; i++) {
    const u = jipUboundaries[i];
    Cp[u] /= Bp[u];
    Bp[u] = 1 / Bp[u];
  }

  sc.fill(0);
  sb.fill(0);
  for (let idx = 0; idx < jipPoints.length; idx++) {
    const p = jipPoints[idx];
    const c = jipNodeOfPoint[idx];
    sc[c] += Cm[p] + Cp[p];
    sb[c] += Bm[p] + Bp[p];
  }

  for (let c = 0; c < numJip; c++) {
    const i = ajip[c];
    if (cav) {
      // DGCM at the junction node: a gas cavity (∀ = C3/(H − Hgas)) absorbs the
      // flow imbalance, so head clamps near vapor instead of going below it.
      // Leak/demand are taken explicitly from the previous head (and vanish once
      // head drops below the node elevation, i.e. during cavitation).
      const ld = (Ke[i] + Kd[i]) * Math.sqrt(Math.max(0, cav.prevHeadJ[c] - Z[i]));
      const P = cav.dt * cav.psi * sb[c];
      const Qc =
        cav.gasVolJ[c] -
        cav.dt * cav.psi * sc[c] +
        cav.dt * cav.psi * ld +
        cav.dt * (1 - cav.psi) * cav.prevNetJ[c];
      const Hg = cav.HgasJ[c];
      let disc = (Qc - P * Hg) ** 2 - 4 * P * (-Qc * Hg - cav.C3J[c]);
      if (disc < 0) disc = 0;
      const H = (-(Qc - P * Hg) + Math.sqrt(disc)) / (2 * P);
      HH[c] = H;
      let vol = P * H + Qc;
      if (vol < 0) vol = 0;
      cav.gasVolJ[c] = vol;
      cav.prevNetJ[c] = H * sb[c] - sc[c] + ld;
      cav.prevHeadJ[c] = H;
    } else {
      const X = sc[c] / sb[c];
      let K = ((Ke[i] + Kd[i]) / sb[c]) ** 2;
      const HZ = X - Z[i];
      if (HZ < 0) K = 0;
      HH[c] = (2 * X + K - Math.sqrt(K * K + 4 * K * HZ)) / 2;
    }
  }

  for (let idx = 0; idx < jipPoints.length; idx++) {
    H1[jipPoints[idx]] = HH[jipNodeOfPoint[idx]];
  }
  for (let i = 0; i < m.areReservoirs.length; i++) {
    const r = m.areReservoirs[i];
    H1[r] = H0[r];
  }
  for (let i = 0; i < m.areTanks.length; i++) {
    const tk = m.areTanks[i];
    H1[tk] = H0[tk];
  }
  for (let i = 0; i < jipDboundaries.length; i++) {
    const d = jipDboundaries[i];
    Q1[d] = H1[d] * Bm[d] - Cm[d];
  }
  for (let i = 0; i < jipUboundaries.length; i++) {
    const u = jipUboundaries[i];
    Q1[u] = Cp[u] - H1[u] * Bp[u];
  }

  for (let c = 0; c < numJip; c++) {
    const i = ajip[c];
    let h = HH[c] - Z[i];
    if (h < 0) h = 0;
    E1[c] = Ke[i] * Math.sqrt(h);
    D1[c] = Kd[i] * Math.sqrt(h);
  }
}

/**
 * Ideal check valves at degree-2 nodes. Runs after {@link runGeneralJunction},
 * which already solves the node as a transparent series junction (the open-valve
 * case) and normalizes the boundary characteristics. If the through-flow has
 * reversed (`Q1[start] < 0`), the valve shuts: flow is zeroed and each side
 * reflects as a dead end (`H = Cp/Bp` upstream, `H = Cm/Bm` downstream).
 */
export function runCheckValves(
  Q1: Float64Array,
  H1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  m: EngineModel,
): void {
  for (let i = 0; i < m.checkStart.length; i++) {
    const s = m.checkStart[i];
    const e = m.checkEnd[i];
    if (Q1[s] < 0) {
      Q1[s] = 0;
      Q1[e] = 0;
      H1[s] = Cp[s] / Bp[s];
      H1[e] = Cm[e] / Bm[e];
    }
  }
}

/** Solve valve boundary points (single/end valves and inline valves). */
export function runValveStep(
  Q1: Float64Array,
  H1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  setting: Float64Array,
  coeff: Float64Array,
  area: Float64Array,
  m: EngineModel,
): void {
  for (let i = 0; i < m.singleValveCtx.length; i++) {
    const v = m.singleValveCtx[i];
    const pt = m.singleValvePoints[i];
    const K0 = setting[v] * coeff[v] * area[v];
    const K = 2 * G * (Bp[pt] * K0) ** 2;
    const cpEnd = Cp[pt];
    if (cpEnd > 0) {
      // Free discharge to atmosphere: H = Cp − Bp·Q and Q = K0·√(2gH), with the
      // forward-flow solution H ∈ [0, Cp].
      H1[pt] = (2 * cpEnd + K - Math.sqrt((2 * cpEnd + K) ** 2 - 4 * cpEnd ** 2)) / 2;
      Q1[pt] = K0 * Math.sqrt(2 * G * H1[pt]);
    } else {
      // Sub-atmospheric driving head: a discharge valve can't pass forward flow
      // (Q=0), so the valve point reflects as a dead end (H = Cp). Without
      // column-separation modelling H may then fall below vapor pressure — the
      // documented bare-engine limitation — but it stays finite (no NaN).
      H1[pt] = cpEnd;
      Q1[pt] = 0;
    }
  }

  for (let i = 0; i < m.startValveCtx.length; i++) {
    const v = m.startValveCtx[i];
    const j = m.startValvePoints[i];
    const k = m.endValvePoints[i];
    const CM = Cm[k];
    const BM = Bm[k];
    const CP = Cp[j];
    const BP = Bp[j];
    const S = sign(CP - CM);
    const CV = 2 * G * (setting[v] * coeff[v] * area[v]) ** 2;
    const X = CV * (BP + BM);
    Q1[j] = (-S * X + S * Math.sqrt(X * X + S * 4 * CV * (CP - CM))) / 2;
    Q1[k] = Q1[j];
    H1[j] = CP - BP * Q1[j];
    H1[k] = CM + BM * Q1[j];
  }
}

/** Solve pump boundary points (single pumps and inline pumps). */
export function runPumpStep(
  sourceHead: Float64Array,
  Q1: Float64Array,
  H1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  a1: Float64Array,
  a2: Float64Array,
  Hs: Float64Array,
  setting: Float64Array,
  m: EngineModel,
): void {
  // Raw quadratic root (may be negative: the pump would pass reverse flow).
  const solveQ = (A: number, Bc: number, C: number): number => {
    if (Math.abs(A) < 1e-30) return Bc !== 0 ? -C / Bc : 0;
    let root = Bc * Bc - 4 * A * C;
    if (root < 0) root = 0;
    return (-Bc - Math.sqrt(root)) / (2 * A);
  };

  for (let i = 0; i < m.singlePumpCtx.length; i++) {
    const pp = m.singlePumpCtx[i];
    const pt = m.singlePumpPoints[i];
    const CP = sourceHead[pp];
    const CM = Cm[pt];
    const BM = Bm[pt];
    const alpha = setting[pp];
    const A = a2[pp];
    const Bc = a1[pp] * alpha - BM;
    const C = Hs[pp] * alpha ** 2 - CM + CP;
    const Q = solveQ(A, Bc, C);
    if (Q < 0) {
      // Forward-only pump (EPANET semantics): discharge check valve shut,
      // downstream reflects as a dead end. (Q == 0 is deadhead: shutoff head.)
      Q1[pt] = 0;
      H1[pt] = CM;
    } else {
      Q1[pt] = Q;
      H1[pt] = CP + (a2[pp] * Q * Q + a1[pp] * alpha * Q + Hs[pp] * alpha ** 2);
    }
  }

  for (let i = 0; i < m.startPumpCtx.length; i++) {
    const pp = m.startPumpCtx[i];
    const j = m.startPumpPoints[i];
    const k = m.endPumpPoints[i];
    const CP = Cp[j];
    const BP = Bp[j];
    const CM = Cm[k];
    const BM = Bm[k];
    const alpha = setting[pp];
    const A = a2[pp];
    const Bc = a1[pp] * alpha - BM - BP;
    const C = Hs[pp] * alpha ** 2 - CM + CP;
    // Forward-only: a negative root reflects both sides as dead ends (Q = 0).
    const Q = Math.max(0, solveQ(A, Bc, C));
    Q1[j] = Q;
    Q1[k] = Q;
    H1[j] = CP - BP * Q;
    // funcs.py computes H1[k] = H1[j] + pump head then overwrites with the
    // characteristic value below; only the latter survives.
    H1[k] = CM + BM * Q;
  }
}

/**
 * Pump trip (power failure) with rotational inertia. After the trip step the
 * pump speed ratio α (= `setting`) is no longer scheduled but decays from the
 * rotating mass: with hydraulic braking torque `T_h = ρ g Q hp / (η ω)` and
 * `ω = α ω_R`, the angular-momentum balance `I dω/dt = −T_h` gives
 *   dα/dt = −K · Q · hp / α,   K = ρ g / (η I ω_R²).
 * Integrated explicitly here (one-step lag) using this step's pump flow Q and
 * head rise hp from {@link runPumpStep}; α is written back for the next step.
 * When the discharge check valve is shut (Q = 0) the term vanishes and α freezes.
 * Forward-quadrant only (Wylie & Streeter / Chaudhry pump rundown).
 */
export function runPumpTrip(
  t: number,
  dt: number,
  setting: Float64Array,
  a1: Float64Array,
  a2: Float64Array,
  Hs: Float64Array,
  Q1: Float64Array,
  H1: Float64Array,
  m: EngineModel,
  trip: PumpTripState,
): void {
  const ALPHA_MIN = 1e-3;
  const advance = (pp: number, Q: number, hp: number): void => {
    const alpha = setting[pp];
    let next = alpha - (dt * trip.K[pp] * Q * hp) / Math.max(alpha, ALPHA_MIN);
    if (next < 0) next = 0;
    setting[pp] = next;
  };
  for (let i = 0; i < m.singlePumpCtx.length; i++) {
    const pp = m.singlePumpCtx[i];
    if (trip.tripStep[pp] < 0 || t < trip.tripStep[pp]) continue;
    const pt = m.singlePumpPoints[i];
    const Q = Q1[pt];
    const alpha = setting[pp];
    advance(pp, Q, a2[pp] * Q * Q + a1[pp] * alpha * Q + Hs[pp] * alpha ** 2);
  }
  for (let i = 0; i < m.startPumpCtx.length; i++) {
    const pp = m.startPumpCtx[i];
    if (trip.tripStep[pp] < 0 || t < trip.tripStep[pp]) continue;
    const j = m.startPumpPoints[i];
    const k = m.endPumpPoints[i];
    advance(pp, Q1[j], H1[k] - H1[j]); // H1[k]-H1[j] is the pump head rise
  }
}

/**
 * Open surge-protection (air chamber open to atmosphere) update.
 *
 * Note: the Python reference (`funcs.run_open_protections`) failed to persist
 * the tank inflow `QT` between steps. Here the state is persisted, which is the
 * physically intended behaviour.
 */
export function runOpenProtections(
  H0: Float64Array,
  H1: Float64Array,
  Q1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  QT: Float64Array,
  m: EngineModel,
  tau: number,
): void {
  for (let i = 0; i < m.openStart.length; i++) {
    const s = m.openStart[i];
    const e = m.openEnd[i];
    const CP = Cp[s];
    const aT = m.openArea[i];
    const BP = Bp[s];
    const CM = Cm[e];
    const BM = Bm[e];
    const CC = CP + CM;
    const BB = BM + BP;
    H1[s] = (CC + QT[i] + (2 * aT * H0[s]) / tau) / (BB + (2 * aT) / tau);
    H1[e] = H1[s];
    Q1[s] = CP - H1[s] * BP;
    Q1[e] = H1[e] * BM - CM;
    QT[i] = Q1[s] - Q1[e];
  }
}

/**
 * Solve the throttled tank continuity `(1 + BB·D)·QT + BB·Cf·QT|QT| = g0` for the
 * net tank inflow QT. With no orifice (`Cf = 0`) it's the linear `g0/(1 + BB·D)`.
 * The orifice term always opposes flow, so `sign(QT) = sign(g0)` and `|QT|` is the
 * positive root of `BB·Cf·x² + (1 + BB·D)·x − |g0| = 0` (Citardauq form, no
 * cancellation). `lin = 1 + BB·D`, `quad = BB·Cf`.
 */
function solveThrottledTank(g0: number, lin: number, quad: number): number {
  if (quad === 0) return g0 / lin;
  const s = sign(g0);
  const x = (2 * Math.abs(g0)) / (lin + Math.sqrt(lin * lin + 4 * quad * Math.abs(g0)));
  return s * x;
}

/**
 * Enhanced open surge tank (simple / two-way standpipe) at a degree-2 node.
 * Extends {@link runOpenProtections} with a throttling orifice at the connection,
 * a finite standpipe height (overflow), and an empty level (runs dry). Runs after
 * {@link runGeneralJunction}, which normalizes the boundary characteristics.
 *
 * Sign convention matches {@link runOpenProtections}: with `CC = Cp[s]+Cm[e]`,
 * `BB = Bp[s]+Bm[e]`, the node continuity is `QT = CC − H·BB` (QT > 0 = into the
 * tank). The tank water level `z` is tracked explicitly (it decouples from the
 * node head once the orifice or a level limit is active):
 *
 *  - **Orifice loss.** A throttle between the line and the tank adds a head loss
 *    `H = z + Cf·QT|QT|`. With trapezoidal tank storage `z = z0 + D·(QT+qt0)`
 *    (`D = Δt/2A_T`) this closes to a single equation in QT solved by
 *    {@link solveThrottledTank}. `Cf = 0` recovers the direct connection `H = z`.
 *  - **Overflow.** If the level would exceed `zMax` the standpipe spills: `z` is
 *    pinned at `zMax` (excess inflow is lost) and H re-solved against that fixed
 *    level — capping the up-surge near `zMax`.
 *  - **Empty.** If the level would fall below `zMin` the tank is at its bottom;
 *    while empty it cannot feed the line, so it reverts to a transparent series
 *    junction (`H = CC/BB`, QT = 0) until the line head rises enough to refill it.
 *
 * State (`z` level, `qt0` previous inflow) persists across steps. Boundary points
 * are mirrored onto the `qu` face by the generic cavitation sync (like the plain
 * open tank), so no `cav` argument is needed.
 *
 * Reference: Wylie & Streeter, *Fluid Transients in Systems* (throttled / simple
 * surge tanks); Chaudhry, *Applied Hydraulic Transients*.
 */
export function runOpenTanksEnhanced(
  H1: Float64Array,
  Q1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  oeZ: Float64Array,
  oeQT: Float64Array,
  m: EngineModel,
  dt: number,
): void {
  for (let i = 0; i < m.oeStart.length; i++) {
    const s = m.oeStart[i];
    const e = m.oeEnd[i];
    const CP = Cp[s];
    const BP = Bp[s];
    const CM = Cm[e];
    const BM = Bm[e];
    const CC = CP + CM;
    const BB = BP + BM;
    const aT = m.oeArea[i];
    const Cf = m.oeCf[i];
    const zMax = m.oeMax[i];
    const zMin = m.oeMin[i];
    const D = dt / (2 * aT);
    const z0 = oeZ[i];
    const qt0 = oeQT[i];

    // Free (unclamped) solve from the tracked level z0.
    const g0 = CC - BB * z0 - BB * D * qt0;
    let QT = solveThrottledTank(g0, 1 + BB * D, BB * Cf);
    let H = (CC - QT) / BB;
    let z = z0 + D * (QT + qt0);
    let qtNext = QT;

    if (z >= zMax) {
      // Overflow: pin the level at the standpipe top, re-solve the orifice
      // against that fixed level (excess inflow spills and is lost).
      QT = solveThrottledTank(CC - BB * zMax, 1, BB * Cf);
      H = (CC - QT) / BB;
      z = zMax;
      qtNext = 0;
    } else if (z0 <= zMin && QT <= 0) {
      // Empty and the line wants to draw: the tank cannot feed → it's inert
      // (transparent series junction) until the head rises enough to refill it.
      H = CC / BB;
      QT = 0;
      z = zMin;
      qtNext = 0;
    } else if (z <= zMin) {
      // Drained to the bottom this step: clamp the level (the next step's empty
      // gate stops further feeding); keep this step's H/QT.
      z = zMin;
      qtNext = 0;
    }

    H1[s] = H;
    H1[e] = H;
    Q1[s] = CP - H * BP;
    Q1[e] = H * BM - CM;
    oeZ[i] = z;
    oeQT[i] = qtNext;
  }
}

/**
 * One-way surge tank at a degree-2 node: an open tank connected through a check
 * valve. Runs after {@link runGeneralJunction} (which normalizes the boundary
 * characteristics). Sign convention matches {@link runOpenProtections}:
 * `QT = Q1[s] − Q1[e]` is net flow *into* the tank, so feeding the line ⇒ QT < 0.
 *
 * Each step, with `CC = Cp[s]+Cm[e]`, `BB = Bp[s]+Bm[e]`, `hJunc = CC/BB`:
 *  1. While the tank holds water (`z0 > zBot`) try the open-tank elastic solve on
 *     the *tracked* level `z0` (not the node head, which decouples when shut):
 *     `H = (CC + qt0 + 2aT/dt·z0)/(BB + 2aT/dt)`, `QT = CC − H·BB`. If `QT ≤ 0` the
 *     check valve passes — the tank feeds the line, node head is pinned to the
 *     (falling) tank level — so accept it and drop the level (clamped at `zBot`).
 *  2. Otherwise the check valve is shut. With a refill orifice (`Kr > 0`) and the
 *     line head above the tank level the tank refills slowly (line → tank):
 *     `CC − H·BB = Kr·√(H − z0)` (same Citardauq form as {@link runSrv}), level
 *     rising (clamped at the "full" level `zFull`). With no refill it's a plain
 *     transparent series junction. The tank thus caps the down-surge but lets the
 *     up-surge pass — unlike a plain open tank, which damps both.
 *
 * State (`owtZ` level, `owtQT` previous inflow) persists across steps. The tank's
 * boundary points are mirrored onto the `qu` face by the generic cavitation
 * sync (like the open/closed surge tanks), so no `cav` argument is needed.
 *
 * Reference: Wylie & Streeter, *Fluid Transients in Systems*; Chaudhry, *Applied
 * Hydraulic Transients* (one-way / feed surge tanks).
 */
export function runOneWayTanks(
  H1: Float64Array,
  Q1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  owtZ: Float64Array,
  owtQT: Float64Array,
  m: EngineModel,
  dt: number,
): void {
  for (let i = 0; i < m.owtStart.length; i++) {
    const s = m.owtStart[i];
    const e = m.owtEnd[i];
    const CP = Cp[s];
    const BP = Bp[s];
    const CM = Cm[e];
    const BM = Bm[e];
    const CC = CP + CM;
    const BB = BP + BM;
    const aT = m.owtArea[i];
    const zBot = m.owtBottom[i];
    const zFull = m.owtInitLevel[i];
    const Kr = m.owtKr[i];
    const z0 = owtZ[i];
    const qt0 = owtQT[i];
    const hJunc = CC / BB;

    // Discharge attempt (only while the tank holds water).
    let H = hJunc;
    let QT = 1; // positive sentinel ⇒ "not discharging"
    if (z0 > zBot) {
      H = (CC + qt0 + (2 * aT * z0) / dt) / (BB + (2 * aT) / dt);
      QT = CC - H * BB;
    }

    if (QT <= 0) {
      // Check valve open: the tank feeds the line (node head == new tank level).
      let zNew = z0 + (dt / (2 * aT)) * (QT + qt0);
      if (zNew < zBot) zNew = zBot;
      H1[s] = H;
      H1[e] = H;
      Q1[s] = CP - H * BP;
      Q1[e] = H * BM - CM;
      owtZ[i] = zNew;
      owtQT[i] = QT;
    } else if (Kr > 0 && hJunc > z0 && z0 < zFull) {
      // Check valve shut; slow refill (line → tank) through the throttle orifice.
      const c = CC - z0 * BB; // = BB·(hJunc − z0) > 0
      let disc = Kr * Kr + 4 * BB * c;
      if (disc < 0) disc = 0;
      const x = (2 * c) / (Kr + Math.sqrt(disc));
      let qIn = Kr * x; // > 0 (into tank)
      let zNew = z0 + (dt * qIn) / aT; // backward Euler (refill is slow)
      if (zNew > zFull) {
        zNew = zFull;
        qIn = (aT * (zFull - z0)) / dt;
        H = (CC - qIn) / BB;
      } else {
        H = z0 + x * x;
      }
      H1[s] = H;
      H1[e] = H;
      Q1[s] = CP - H * BP;
      Q1[e] = H * BM - CM;
      owtZ[i] = zNew;
      owtQT[i] = 0; // discharge trapezoid memory reset (refill used backward Euler)
    } else {
      // Check valve shut, no refill: transparent series junction; level frozen.
      H1[s] = hJunc;
      H1[e] = hJunc;
      Q1[s] = CP - hJunc * BP;
      Q1[e] = hJunc * BM - CM;
      owtQT[i] = 0;
    }
  }
}

const HB = 10.3; // barometric pressure [m H2O]
const GAS_EXP = 1.2; // polytropic gas exponent

/** Closed surge-protection (air chamber) update via Newton iteration. */
export function runClosedProtections(
  H1: Float64Array,
  Q1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  QT0: Float64Array,
  HT0: Float64Array,
  VA: Float64Array,
  C: Float64Array,
  m: EngineModel,
  tau: number,
): void {
  for (let i = 0; i < m.closedStart.length; i++) {
    const s = m.closedStart[i];
    const e = m.closedEnd[i];
    const CP = Cp[s];
    const BP = Bp[s];
    const CM = Cm[e];
    const BM = Bm[e];
    const CC = CP + CM;
    const BB = BM + BP;
    const aT = m.closedArea[i];
    const htank = m.closedHeight[i];
    const Ci = C[i];
    const qt0 = QT0[i];
    const ht0 = HT0[i];
    const va0 = VA[i];

    const f = (QT1: number): number =>
      ((CC - QT1) / BB + HB - (ht0 + (tau * (QT1 + qt0)) / (2 * aT))) *
        (va0 - aT * (((QT1 + qt0) * tau) / (2 * aT))) ** GAS_EXP -
      Ci;
    const fp = (QT1: number): number => {
      const p1 =
        ((-GAS_EXP * aT) / (2 * (aT / tau))) *
        (va0 - ((qt0 + QT1) * aT) / (2 * (aT / tau))) ** (GAS_EXP - 1) *
        ((CC - QT1) / BB + HB - ht0 - (qt0 + QT1) / (2 * (aT / tau)));
      const p2 =
        (-1 / BB - 1 / (2 * (aT / tau))) *
        (va0 - ((qt0 + QT1) * aT) / (2 * (aT / tau))) ** GAS_EXP;
      return p1 + p2;
    };

    const QT1 = newton(f, qt0, fp, 1e-10);
    const HT1 = ht0 + (qt0 + QT1) / (2 * (aT / tau));
    H1[s] = (CC - QT1) / BB;
    H1[e] = H1[s];
    Q1[s] = CP - H1[s] * BP;
    Q1[e] = H1[e] * BM - CM;

    VA[i] = (htank - HT1) * aT;
    HT0[i] = HT1;
    QT0[i] = QT1;
  }
}

const RHO_W = 1000; // water density [kg/m³]
const RHO_AIR0 = 1.293; // air density at standard conditions [kg/m³]
const GAMMA_AIR = 1.4; // isentropic exponent of air

/**
 * Combination air/vacuum valve at a degree-2 node. Admits air through the inlet
 * orifice when the node pressure falls below atmospheric (vacuum breaking, which
 * limits the down-surge / column separation) and expels it through the outlet
 * orifice on repressurization (the trapped air can compress above atmospheric and
 * cause an "air slam" surge on rejoining). Compressible orifice flow
 * (subsonic→choked at p_r = 0.528) with an isothermal air pocket `p∀ = mRT`;
 * runs after {@link runGeneralJunction} and overrides the node while open.
 *
 * Each step solves, for the node head H, the balance between the gas-law pocket
 * volume `(m0 + Δt·ṁ(p))·RT0/p` and the water-continuity volume
 * `∀0 + Δt·(H·BB − CC)`. The residual is monotonic in H, so it's bracketed by
 * bisection. State (`airVol`, `airMass`) persists across steps.
 *
 * Reference: Wylie & Streeter, *Fluid Transients in Systems* (air-inlet valves).
 */
export function runAirValves(
  H1: Float64Array,
  Q1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  airVol: Float64Array,
  airMass: Float64Array,
  Z: Float64Array,
  m: EngineModel,
  dt: number,
): void {
  const P0 = RHO_W * G * HB; // atmospheric pressure [Pa]
  const RT0 = P0 / RHO_AIR0; // R·T0 [m²/s²]
  const g1 = GAMMA_AIR;
  const rCrit = (2 / (g1 + 1)) ** (g1 / (g1 - 1)); // ≈ 0.528
  const choke = Math.sqrt((g1 / RT0) * (2 / (g1 + 1)) ** ((g1 + 1) / (g1 - 1)));
  const sub = (2 * g1) / ((g1 - 1) * RT0);

  // Net air mass flow into the pocket [kg/s] (+admit, −expel) at absolute pressure p.
  const massFlow = (p: number, Ain: number, Aout: number, Cin: number, Cout: number): number => {
    if (p < P0) {
      const r = p / P0;
      const flux = r <= rCrit ? P0 * choke : P0 * Math.sqrt(sub * (r ** (2 / g1) - r ** ((g1 + 1) / g1)));
      return Cin * Ain * flux;
    }
    if (p > P0) {
      const r = P0 / p;
      const flux = r <= rCrit ? p * choke : p * Math.sqrt(sub * (r ** (2 / g1) - r ** ((g1 + 1) / g1)));
      return -Cout * Aout * flux;
    }
    return 0;
  };

  for (let i = 0; i < m.airStart.length; i++) {
    const s = m.airStart[i];
    const e = m.airEnd[i];
    const z = Z[m.airNode[i]];
    const CC = Cp[s] + Cm[e];
    const BB = Bp[s] + Bm[e];
    const hJunc = CC / BB; // degree-2 series-junction head (valve shut)
    const v0 = airVol[i];
    const m0 = airMass[i];
    const Ain = m.airInArea[i];
    const Aout = m.airOutArea[i];
    const Cin = m.airInCoeff[i];
    const Cout = m.airOutCoeff[i];

    if (v0 <= 0 && m0 <= 0 && hJunc - z >= 0) continue; // shut & pressurized: junction stands

    // g(H) = gas-law volume − water-continuity volume; monotonically decreasing in H.
    const resid = (H: number): number => {
      const p = RHO_W * G * (H - z + HB);
      const m1 = Math.max(0, m0 + dt * massFlow(p, Ain, Aout, Cin, Cout));
      return (m1 * RT0) / p - (v0 + dt * (H * BB - CC));
    };
    let lo = z - HB + 1e-3; // p just above vacuum
    let hi = z + 1000;
    for (let k = 0; k < 60; k++) {
      const mid = 0.5 * (lo + hi);
      if (resid(mid) > 0) lo = mid;
      else hi = mid;
    }
    const H = 0.5 * (lo + hi);
    const p = RHO_W * G * (H - z + HB);
    const m1 = m0 + dt * massFlow(p, Ain, Aout, Cin, Cout);

    if (m1 <= 0) {
      // Air fully expelled: valve shuts, node repressurizes as a plain junction.
      airVol[i] = 0;
      airMass[i] = 0;
      H1[s] = hJunc;
      H1[e] = hJunc;
      Q1[s] = Cp[s] - hJunc * Bp[s];
      Q1[e] = hJunc * Bm[e] - Cm[e];
    } else {
      airMass[i] = m1;
      airVol[i] = (m1 * RT0) / p;
      H1[s] = H;
      H1[e] = H;
      Q1[s] = Cp[s] - H * Bp[s];
      Q1[e] = H * Bm[e] - Cm[e];
    }
  }
}

/**
 * Surge-relief valve at a degree-2 node. Stays shut (a transparent series
 * junction) until the node gauge head rises above the setpoint, then opens — over
 * `openTime` — and bleeds flow to atmosphere through an orifice, capping the
 * upsurge; it recloses over `closeTime` once the head drops below the reseat head.
 * Runs after {@link runGeneralJunction}, which already normalized the boundary
 * characteristics, so the node continuity with the relief discharge `Q_r` is
 * `CC − H·BB = Q_r`, with `Q_r = τ·Kq·√(H − z)` (Kq = Cd·A·√(2g), τ ∈ [0,1]).
 *
 * The opening fraction τ is ramped explicitly from the shut-valve head `hJunc − z`
 * (so opening the valve can't immediately command its own reclose), then H is
 * solved in closed form against that frozen τ. With τ held at 1 the head settles
 * where `CC − H·BB = Kq·√(H − z)` — the relief cap. State (`srvTau`) persists.
 *
 * Reference: Wylie & Streeter, *Fluid Transients in Systems*; Chaudhry, *Applied
 * Hydraulic Transients* (pressure-relief / surge-relief valves).
 */
export function runSrv(
  H1: Float64Array,
  Q1: Float64Array,
  Cp: Float64Array,
  Bp: Float64Array,
  Cm: Float64Array,
  Bm: Float64Array,
  srvTau: Float64Array,
  Z: Float64Array,
  m: EngineModel,
  dt: number,
  cav?: CavState,
): void {
  for (let i = 0; i < m.srvStart.length; i++) {
    const s = m.srvStart[i];
    const e = m.srvEnd[i];
    const z = Z[m.srvNode[i]];
    const CC = Cp[s] + Cm[e];
    const BB = Bp[s] + Bm[e];
    const hJunc = CC / BB; // degree-2 series-junction head (valve shut)
    const gauge = hJunc - z; // sensor = shut-valve driving head (breaks feedback chatter)

    // Explicit actuator ramp, before the head solve.
    let tau = srvTau[i];
    if (gauge > m.srvSetpoint[i]) tau += m.srvOpenTime[i] > 0 ? dt / m.srvOpenTime[i] : 1;
    else if (gauge < m.srvReseat[i]) tau -= m.srvCloseTime[i] > 0 ? dt / m.srvCloseTime[i] : 1;
    if (tau < 0) tau = 0;
    else if (tau > 1) tau = 1;
    srvTau[i] = tau;

    // Implicit head solve against the frozen τ.
    const c = CC - z * BB; // = BB·gauge
    let H: number;
    if (tau <= 0 || c <= 0) {
      H = hJunc; // shut, or sub-atmospheric node: plain series junction (no discharge)
    } else {
      const b = tau * m.srvKq[i];
      let disc = b * b + 4 * BB * c; // ≥ b² ≥ 0
      if (disc < 0) disc = 0;
      const x = (2 * c) / (b + Math.sqrt(disc)); // Citardauq form: no cancellation, BB≈0-safe
      H = z + x * x;
    }
    H1[s] = H;
    H1[e] = H;
    Q1[s] = Cp[s] - H * Bp[s];
    Q1[e] = H * Bm[e] - Cm[e]; // Q1[s] − Q1[e] == vented relief flow
    if (cav) cav.quCur[s] = Q1[s]; // satisfy the qu-face mirror contract under cavitation
  }
}
