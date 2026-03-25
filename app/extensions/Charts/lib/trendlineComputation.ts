//! FILENAME: app/extensions/Charts/lib/trendlineComputation.ts
// PURPOSE: Mathematical computations for chart trendlines.
// CONTEXT: Computes regression lines, moving averages, and other trendlines
//          from chart series data. Returns pixel-ready points for the painter.

import type { TrendlineType, TrendlineSpec, ParsedChartData } from "../types";

// ============================================================================
// Result Type
// ============================================================================

/** A computed trendline: a sequence of (x-index, y-value) pairs for rendering. */
export interface TrendlineResult {
  /** Points as (categoryIndex, predictedValue) pairs. */
  points: Array<{ ci: number; value: number }>;
  /** The equation string (e.g., "y = 2.5x + 3.1"). */
  equation: string;
  /** R-squared goodness of fit (0-1). NaN for moving average. */
  rSquared: number;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute a trendline for a series.
 * Returns predicted values at each category index.
 */
export function computeTrendline(
  data: ParsedChartData,
  trendline: TrendlineSpec,
): TrendlineResult | null {
  const seriesIndex = trendline.seriesIndex ?? 0;
  const series = data.series[seriesIndex];
  if (!series) return null;

  const values = series.values;
  if (values.length < 2) return null;

  // Build (x, y) pairs, skipping NaN/undefined
  const xy: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && isFinite(v)) {
      xy.push({ x: i, y: v });
    }
  }
  if (xy.length < 2) return null;

  switch (trendline.type) {
    case "linear":
      return computeLinear(xy, values.length);
    case "exponential":
      return computeExponential(xy, values.length);
    case "polynomial":
      return computePolynomial(xy, values.length, trendline.polynomialDegree ?? 2);
    case "power":
      return computePower(xy, values.length);
    case "logarithmic":
      return computeLogarithmic(xy, values.length);
    case "movingAverage":
      return computeMovingAverage(values, trendline.movingAveragePeriod ?? 3);
    default:
      return null;
  }
}

// ============================================================================
// Linear Regression: y = mx + b
// ============================================================================

function computeLinear(
  xy: Array<{ x: number; y: number }>,
  numCategories: number,
): TrendlineResult {
  const n = xy.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of xy) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }

  const denom = n * sumX2 - sumX * sumX;
  const m = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const b = (sumY - m * sumX) / n;

  const points: Array<{ ci: number; value: number }> = [];
  for (let ci = 0; ci < numCategories; ci++) {
    points.push({ ci, value: m * ci + b });
  }

  const rSquared = computeRSquared(xy, (x) => m * x + b);
  const equation = `y = ${formatCoeff(m)}x ${b >= 0 ? "+" : "-"} ${formatCoeff(Math.abs(b))}`;

  return { points, equation, rSquared };
}

// ============================================================================
// Exponential Regression: y = a * e^(bx)
// ============================================================================

function computeExponential(
  xy: Array<{ x: number; y: number }>,
  numCategories: number,
): TrendlineResult {
  // Transform: ln(y) = ln(a) + bx, then linear regression on (x, ln(y))
  const lnXY = xy.filter((p) => p.y > 0).map((p) => ({ x: p.x, y: Math.log(p.y) }));
  if (lnXY.length < 2) {
    // Fall back to linear if data has non-positive values
    return computeLinear(xy, numCategories);
  }

  const n = lnXY.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of lnXY) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }

  const denom = n * sumX2 - sumX * sumX;
  const bCoeff = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const lnA = (sumY - bCoeff * sumX) / n;
  const a = Math.exp(lnA);

  const predict = (x: number) => a * Math.exp(bCoeff * x);

  const points: Array<{ ci: number; value: number }> = [];
  for (let ci = 0; ci < numCategories; ci++) {
    points.push({ ci, value: predict(ci) });
  }

  const rSquared = computeRSquared(xy, predict);
  const equation = `y = ${formatCoeff(a)}e^(${formatCoeff(bCoeff)}x)`;

  return { points, equation, rSquared };
}

// ============================================================================
// Polynomial Regression: y = a_n*x^n + ... + a_1*x + a_0
// ============================================================================

function computePolynomial(
  xy: Array<{ x: number; y: number }>,
  numCategories: number,
  degree: number,
): TrendlineResult {
  const deg = Math.min(degree, Math.max(xy.length - 1, 1), 6); // cap at degree 6

  // Build normal equations: X^T * X * a = X^T * y
  const n = xy.length;
  const order = deg + 1;

  // Build Vandermonde-like sums
  const sums: number[] = new Array(2 * deg + 1).fill(0);
  const rhs: number[] = new Array(order).fill(0);

  for (const p of xy) {
    let xPow = 1;
    for (let j = 0; j <= 2 * deg; j++) {
      sums[j] += xPow;
      if (j < order) rhs[j] += xPow * p.y;
      xPow *= p.x;
    }
  }

  // Build augmented matrix
  const matrix: number[][] = [];
  for (let i = 0; i < order; i++) {
    const row: number[] = [];
    for (let j = 0; j < order; j++) {
      row.push(sums[i + j]);
    }
    row.push(rhs[i]);
    matrix.push(row);
  }

  // Gaussian elimination with partial pivoting
  const coeffs = solveLinearSystem(matrix, order);
  if (!coeffs) return computeLinear(xy, numCategories);

  const predict = (x: number) => {
    let result = 0;
    let xPow = 1;
    for (let i = 0; i < coeffs.length; i++) {
      result += coeffs[i] * xPow;
      xPow *= x;
    }
    return result;
  };

  const points: Array<{ ci: number; value: number }> = [];
  for (let ci = 0; ci < numCategories; ci++) {
    points.push({ ci, value: predict(ci) });
  }

  const rSquared = computeRSquared(xy, predict);

  // Build equation string
  const terms: string[] = [];
  for (let i = coeffs.length - 1; i >= 0; i--) {
    const c = coeffs[i];
    if (Math.abs(c) < 1e-10) continue;
    const sign = terms.length > 0 ? (c >= 0 ? " + " : " - ") : (c < 0 ? "-" : "");
    const absC = formatCoeff(Math.abs(c));
    if (i === 0) terms.push(`${sign}${absC}`);
    else if (i === 1) terms.push(`${sign}${absC}x`);
    else terms.push(`${sign}${absC}x^${i}`);
  }
  const equation = `y = ${terms.join("") || "0"}`;

  return { points, equation, rSquared };
}

// ============================================================================
// Power Regression: y = a * x^b
// ============================================================================

function computePower(
  xy: Array<{ x: number; y: number }>,
  numCategories: number,
): TrendlineResult {
  // Transform: ln(y) = ln(a) + b*ln(x), linear regression on (ln(x), ln(y))
  const lnXY = xy.filter((p) => p.x > 0 && p.y > 0).map((p) => ({ x: Math.log(p.x), y: Math.log(p.y) }));
  if (lnXY.length < 2) return computeLinear(xy, numCategories);

  const n = lnXY.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of lnXY) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }

  const denom = n * sumX2 - sumX * sumX;
  const bCoeff = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const lnA = (sumY - bCoeff * sumX) / n;
  const a = Math.exp(lnA);

  // Power regression uses x starting from 1 (not 0, since x^b with x=0 is problematic)
  const predict = (x: number) => a * Math.pow(Math.max(x + 1, 0.001), bCoeff);

  const points: Array<{ ci: number; value: number }> = [];
  for (let ci = 0; ci < numCategories; ci++) {
    points.push({ ci, value: predict(ci) });
  }

  const rSquared = computeRSquared(xy, (x) => a * Math.pow(Math.max(x + 1, 0.001), bCoeff));
  const equation = `y = ${formatCoeff(a)}x^${formatCoeff(bCoeff)}`;

  return { points, equation, rSquared };
}

// ============================================================================
// Logarithmic Regression: y = a * ln(x) + b
// ============================================================================

function computeLogarithmic(
  xy: Array<{ x: number; y: number }>,
  numCategories: number,
): TrendlineResult {
  // Transform: y = a * ln(x+1) + b, linear regression on (ln(x+1), y)
  const lnXY = xy.map((p) => ({ x: Math.log(p.x + 1), y: p.y }));

  const n = lnXY.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of lnXY) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }

  const denom = n * sumX2 - sumX * sumX;
  const a = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const b = (sumY - a * sumX) / n;

  const predict = (x: number) => a * Math.log(x + 1) + b;

  const points: Array<{ ci: number; value: number }> = [];
  for (let ci = 0; ci < numCategories; ci++) {
    points.push({ ci, value: predict(ci) });
  }

  const rSquared = computeRSquared(xy, predict);
  const equation = `y = ${formatCoeff(a)}ln(x) ${b >= 0 ? "+" : "-"} ${formatCoeff(Math.abs(b))}`;

  return { points, equation, rSquared };
}

// ============================================================================
// Moving Average
// ============================================================================

function computeMovingAverage(
  values: number[],
  period: number,
): TrendlineResult {
  const p = Math.max(2, Math.min(period, values.length));
  const points: Array<{ ci: number; value: number }> = [];

  for (let ci = p - 1; ci < values.length; ci++) {
    let sum = 0;
    let count = 0;
    for (let j = ci - p + 1; j <= ci; j++) {
      const v = values[j];
      if (v != null && isFinite(v)) {
        sum += v;
        count++;
      }
    }
    if (count > 0) {
      points.push({ ci, value: sum / count });
    }
  }

  return {
    points,
    equation: `${p}-point moving average`,
    rSquared: NaN,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Compute R-squared goodness of fit. */
function computeRSquared(
  xy: Array<{ x: number; y: number }>,
  predict: (x: number) => number,
): number {
  const n = xy.length;
  if (n < 2) return 0;

  const meanY = xy.reduce((s, p) => s + p.y, 0) / n;
  let ssRes = 0;
  let ssTot = 0;

  for (const p of xy) {
    const predicted = predict(p.x);
    ssRes += (p.y - predicted) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }

  if (ssTot === 0) return 1;
  return Math.max(0, 1 - ssRes / ssTot);
}

/** Solve a linear system using Gaussian elimination with partial pivoting. */
function solveLinearSystem(matrix: number[][], n: number): number[] | null {
  // Make a copy
  const m = matrix.map((row) => [...row]);

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    let maxVal = Math.abs(m[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > maxVal) {
        maxVal = Math.abs(m[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) return null;
    if (maxRow !== col) {
      [m[col], m[maxRow]] = [m[maxRow], m[col]];
    }

    // Eliminate
    for (let row = col + 1; row < n; row++) {
      const factor = m[row][col] / m[col][col];
      for (let j = col; j <= n; j++) {
        m[row][j] -= factor * m[col][j];
      }
    }
  }

  // Back substitution
  const result = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = m[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= m[i][j] * result[j];
    }
    result[i] = sum / m[i][i];
  }

  return result;
}

/** Format a coefficient for display. */
function formatCoeff(v: number): string {
  if (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0)) {
    return v.toExponential(2);
  }
  return v.toFixed(2).replace(/\.?0+$/, "") || "0";
}
