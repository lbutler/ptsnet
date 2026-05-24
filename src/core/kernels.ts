/**
 * Method-of-Characteristics step kernels.
 * Ported from the vectorized routines in `simulation/funcs.py`.
 */
import { G } from './types';
import { EngineModel } from './serialModel';
import { sign, newton } from './math';

/**
 * Interior MOC stencil for the inline (single-worker) path. Must stay in sync
 * with the plain branch of the worker source in `parallel/parallelEngine.ts`.
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
): void {
  const n = Q0.length;
  for (let i = 1; i < n - 1; i++) {
    Cm[i] = (H0[i + 1] - B[i] * Q0[i + 1]) * hasMinus[i];
    Bm[i] = (B[i] + R[i] * Math.abs(Q0[i + 1])) * hasMinus[i];
    Cp[i] = (H0[i - 1] + B[i] * Q0[i - 1]) * hasPlus[i];
    Bp[i] = (B[i] + R[i] * Math.abs(Q0[i - 1])) * hasPlus[i];
    H1[i] = (Cp[i] * Bm[i] + Cm[i] * Bp[i]) / (Bp[i] + Bm[i]);
    Q1[i] = (Cp[i] - Cm[i]) / (Bp[i] + Bm[i]);
  }
  Cm[0] = H0[1] - B[0] * Q0[1];
  Cp[n - 1] = H0[n - 2] + B[n - 2] * Q0[n - 2];
  Bm[0] = B[0] + R[0] * Math.abs(Q0[1]);
  Bp[n - 1] = B[n - 2] + R[n - 2] * Math.abs(Q0[n - 2]);
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
): void {
  const n = h0.length;
  for (let i = 1; i < n - 1; i++) {
    const cp = (h0[i - 1] + B[i] * qd0[i - 1]) * hasPlus[i];
    const bp = (B[i] + R[i] * Math.abs(qd0[i - 1])) * hasPlus[i];
    const cm = (h0[i + 1] - B[i] * qu0[i + 1]) * hasMinus[i];
    const bm = (B[i] + R[i] * Math.abs(qu0[i + 1])) * hasMinus[i];
    Cp[i] = cp;
    Bp[i] = bp;
    Cm[i] = cm;
    Bm[i] = bm;
    if (hasPlus[i] && hasMinus[i]) {
      const invBp = 1 / bp;
      const invBm = 1 / bm;
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
  Bm[0] = B[0] + R[0] * Math.abs(qu0[1]);
  Cp[n - 1] = h0[n - 2] + B[n - 2] * qd0[n - 2];
  Bp[n - 1] = B[n - 2] + R[n - 2] * Math.abs(qd0[n - 2]);
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
    const X = sc[c] / sb[c];
    const i = ajip[c];
    let K = ((Ke[i] + Kd[i]) / sb[c]) ** 2;
    const HZ = X - Z[i];
    if (HZ < 0) K = 0;
    HH[c] = (2 * X + K - Math.sqrt(K * K + 4 * K * HZ)) / 2;
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
    H1[pt] = (2 * cpEnd + K - Math.sqrt((2 * cpEnd + K) ** 2 - 4 * cpEnd ** 2)) / 2;
    Q1[pt] = K0 * Math.sqrt(2 * G * H1[pt]);
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
  const solveQ = (A: number, Bc: number, C: number): number => {
    if (Math.abs(A) < 1e-30) {
      // Degenerate (under-determined) pump fit: fall back to a linear root.
      let q = Bc !== 0 ? -C / Bc : 0;
      return q < 0 ? 0 : q;
    }
    let root = Bc * Bc - 4 * A * C;
    if (root < 0) root = 0;
    let q = (-Bc - Math.sqrt(root)) / (2 * A);
    return q < 0 ? 0 : q;
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
    Q1[pt] = Q;
    const hp = a2[pp] * Q * Q + a1[pp] * alpha * Q + Hs[pp] * alpha ** 2;
    H1[pt] = CP + hp;
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
    const Q = solveQ(A, Bc, C);
    Q1[j] = Q;
    Q1[k] = Q;
    H1[j] = CP - BP * Q;
    // funcs.py computes H1[k] = H1[j] + pump head then overwrites with the
    // characteristic value below; only the latter survives.
    H1[k] = CM + BM * Q;
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
