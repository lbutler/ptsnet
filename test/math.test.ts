import { describe, it, expect } from 'vitest';
import { linspace, cumsum, argsort, polyfit2, cubicSpline, newton, sign } from '../src/core/math';

describe('math helpers', () => {
  it('linspace matches numpy semantics', () => {
    expect(Array.from(linspace(0, 1, 5))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(Array.from(linspace(2, 3, 1))).toEqual([2]);
    expect(linspace(0, 1, 0).length).toBe(0);
  });

  it('cumsum and argsort', () => {
    expect(Array.from(cumsum([1, 2, 3]))).toEqual([1, 3, 6]);
    expect(argsort([3, 1, 2])).toEqual([1, 2, 0]);
  });

  it('sign matches numpy', () => {
    expect(sign(-4)).toBe(-1);
    expect(sign(0)).toBe(0);
    expect(sign(2)).toBe(1);
  });

  it('polyfit2 recovers a known quadratic (highest order first)', () => {
    const x = [-2, -1, 0, 1, 2, 3];
    const y = x.map((xi) => 2 * xi * xi - 3 * xi + 1);
    const [a2, a1, a0] = polyfit2(x, y);
    expect(a2).toBeCloseTo(2, 6);
    expect(a1).toBeCloseTo(-3, 6);
    expect(a0).toBeCloseTo(1, 6);
  });

  it('cubicSpline interpolates through its knots', () => {
    const x = [0, 1, 2, 3];
    const y = [0, 1, 8, 27];
    const f = cubicSpline(x, y);
    for (let i = 0; i < x.length; i++) expect(f(x[i])).toBeCloseTo(y[i], 6);
    // Monotonic between knots.
    expect(f(1.5)).toBeGreaterThan(1);
    expect(f(1.5)).toBeLessThan(8);
  });

  it('newton finds a root', () => {
    // f(x) = x^2 - 2, root sqrt(2).
    const root = newton((x) => x * x - 2, 1, (x) => 2 * x);
    expect(root).toBeCloseTo(Math.SQRT2, 8);
  });
});
