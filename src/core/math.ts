/**
 * Numeric helpers replacing the numpy / scipy operations used by PTSNET.
 */

/** numpy-compatible linspace with inclusive endpoints. */
export function linspace(start: number, stop: number, num: number): Float64Array {
  const out = new Float64Array(Math.max(0, num));
  if (num <= 0) return out;
  if (num === 1) {
    out[0] = start;
    return out;
  }
  const step = (stop - start) / (num - 1);
  for (let i = 0; i < num; i++) out[i] = start + step * i;
  out[num - 1] = stop;
  return out;
}

/** Stable argsort returning indices that would sort `arr` ascending. */
export function argsort(arr: ArrayLike<number>): number[] {
  const idx = Array.from({ length: arr.length }, (_, i) => i);
  idx.sort((a, b) => {
    const d = arr[a] - arr[b];
    if (d !== 0) return d;
    return a - b; // stable
  });
  return idx;
}

/** numpy.sign: -1, 0, or 1. */
export function sign(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

/**
 * Least-squares quadratic fit `y ~ a2*x^2 + a1*x + a0`, returning
 * `[a2, a1, a0]` to match `numpy.polyfit(x, y, 2)` ordering.
 *
 * Falls back gracefully when fewer than 3 distinct abscissae are available
 * (an under-determined system), preferring lower-order terms.
 */
export function polyfit2(x: ArrayLike<number>, y: ArrayLike<number>): [number, number, number] {
  const n = x.length;
  const distinct = new Set<number>();
  for (let i = 0; i < n; i++) distinct.add(x[i]);
  const k = distinct.size;

  if (k >= 3) {
    // Normal equations for [a0, a1, a2] using a Vandermonde basis [1, x, x^2].
    const A = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const b = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      const p = [1, xi, xi * xi];
      for (let r = 0; r < 3; r++) {
        b[r] += p[r] * yi;
        for (let c = 0; c < 3; c++) A[r][c] += p[r] * p[c];
      }
    }
    const sol = solveLinear(A, b);
    if (sol) return [sol[2], sol[1], sol[0]];
  }

  if (k === 2) {
    // Fit a line through the two distinct points (a2 = 0).
    const xs: number[] = [];
    const ys: number[] = [];
    const seen = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (!seen.has(x[i])) {
        seen.set(x[i], y[i]);
        xs.push(x[i]);
        ys.push(y[i]);
      }
    }
    const a1 = (ys[1] - ys[0]) / (xs[1] - xs[0]);
    const a0 = ys[0] - a1 * xs[0];
    return [0, a1, a0];
  }

  // Single distinct point: constant.
  return [0, 0, y.length ? y[0] : 0];
}

/** Solve a 3x3 (or NxN) system via Gaussian elimination with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-15) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Interpolating cubic spline (not-a-knot end conditions), a practical
 * replacement for scipy's `splrep`/`splev` used by PTSNET's `define_curve`.
 * Points are sorted by `x`; evaluation clamps to the endpoints' polynomials.
 */
export function cubicSpline(xIn: ArrayLike<number>, yIn: ArrayLike<number>): (x: number) => number {
  const order = argsort(xIn);
  const x = order.map((i) => xIn[i]);
  const y = order.map((i) => yIn[i]);
  const n = x.length;

  if (n === 1) return () => y[0];
  if (n === 2) {
    const slope = (y[1] - y[0]) / (x[1] - x[0]);
    return (q: number) => y[0] + slope * (q - x[0]);
  }

  const h = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) h[i] = x[i + 1] - x[i];

  // Build the tridiagonal system for second derivatives (c) with not-a-knot ends.
  const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const rhs = new Array(n).fill(0);

  // Not-a-knot at the left.
  A[0][0] = h[1];
  A[0][1] = -(h[0] + h[1]);
  A[0][2] = h[0];
  rhs[0] = 0;

  for (let i = 1; i < n - 1; i++) {
    A[i][i - 1] = h[i - 1];
    A[i][i] = 2 * (h[i - 1] + h[i]);
    A[i][i + 1] = h[i];
    rhs[i] = 3 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]);
  }

  // Not-a-knot at the right.
  A[n - 1][n - 3] = h[n - 2];
  A[n - 1][n - 2] = -(h[n - 3] + h[n - 2]);
  A[n - 1][n - 1] = h[n - 3];
  rhs[n - 1] = 0;

  const c = solveLinear(A, rhs) ?? new Array(n).fill(0);

  const b = new Array(n - 1);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    b[i] = (y[i + 1] - y[i]) / h[i] - (h[i] * (2 * c[i] + c[i + 1])) / 3;
    d[i] = (c[i + 1] - c[i]) / (3 * h[i]);
  }

  return (q: number) => {
    // Locate interval (clamped to endpoints).
    let i = n - 2;
    if (q <= x[0]) i = 0;
    else if (q >= x[n - 1]) i = n - 2;
    else {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (x[mid] <= q) lo = mid;
        else hi = mid;
      }
      i = lo;
    }
    const dx = q - x[i];
    return y[i] + b[i] * dx + c[i] * dx * dx + d[i] * dx * dx * dx;
  };
}

/** Newton-Raphson root finder (scipy.optimize.newton with derivative). */
export function newton(
  f: (x: number) => number,
  x0: number,
  fprime: (x: number) => number,
  tol = 1e-10,
  maxiter = 50,
): number {
  let x = x0;
  for (let i = 0; i < maxiter; i++) {
    const fx = f(x);
    if (Math.abs(fx) < tol) return x;
    const dfx = fprime(x);
    if (dfx === 0) break;
    const next = x - fx / dfx;
    if (Math.abs(next - x) < tol) return next;
    x = next;
  }
  return x;
}

/**
 * Python float floor-division (`a // b`), reproducing CPython's `float_divmod`.
 *
 * This differs from `Math.floor(a / b)`: e.g. `0.5 // 0.05` is 9 in Python even
 * though `0.5 / 0.05 === 10`. PTSNET uses `//` to turn operation times into time
 * step indices, so matching it is required for identical valve/pump schedules.
 */
export function pyFloorDiv(a: number, b: number): number {
  let mod = a % b; // JS % is C fmod for floats (truncated remainder)
  let div = (a - mod) / b;
  if (mod !== 0) {
    if (b < 0 !== mod < 0) {
      mod += b;
      div -= 1.0;
    }
  }
  let floordiv: number;
  if (div !== 0) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
  } else {
    floordiv = 0;
  }
  return floordiv;
}

/** Round half to even (banker's rounding), matching numpy.round / Python round. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** numpy.cumsum. */
export function cumsum(arr: ArrayLike<number>): Float64Array {
  const out = new Float64Array(arr.length);
  let acc = 0;
  for (let i = 0; i < arr.length; i++) {
    acc += arr[i];
    out[i] = acc;
  }
  return out;
}
