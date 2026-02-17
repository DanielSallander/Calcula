//! FILENAME: app/extensions/Charts/rendering/scales.ts
// PURPOSE: Scale computations for mapping data values to pixel coordinates.
// CONTEXT: Inspired by D3 scales but minimal - only what bar charts need.

// ============================================================================
// Linear Scale (value axis)
// ============================================================================

export interface LinearScale {
  domain: [number, number];
  range: [number, number];
  /** Map a data value to a pixel coordinate. */
  scale(value: number): number;
  /** Generate evenly-spaced tick values. */
  ticks(count?: number): number[];
}

/**
 * Create a linear scale mapping [domainMin, domainMax] -> [rangeMin, rangeMax].
 * Includes "nice" domain extension so axes look clean.
 */
export function createLinearScale(
  domain: [number, number],
  range: [number, number],
): LinearScale {
  const [d0, d1] = niceExtent(domain[0], domain[1]);
  const [r0, r1] = range;
  const dSpan = d1 - d0 || 1;
  const rSpan = r1 - r0;

  return {
    domain: [d0, d1],
    range: [r0, r1],
    scale(value: number): number {
      return r0 + ((value - d0) / dSpan) * rSpan;
    },
    ticks(count = 5): number[] {
      const step = niceStep(d0, d1, count);
      const ticks: number[] = [];
      const start = Math.ceil(d0 / step) * step;
      for (let v = start; v <= d1 + step * 0.001; v += step) {
        ticks.push(Math.round(v * 1e10) / 1e10);
      }
      return ticks;
    },
  };
}

// ============================================================================
// Band Scale (category axis)
// ============================================================================

export interface BandScale {
  domain: string[];
  range: [number, number];
  /** Width of each band in pixels. */
  bandwidth: number;
  /** Map a category to its band start pixel. */
  scale(category: string): number;
}

/**
 * Create a band scale mapping categorical values to equal-width bands.
 * @param padding Fraction of bandwidth used as inner/outer padding (0..1). Default 0.2.
 */
export function createBandScale(
  domain: string[],
  range: [number, number],
  padding = 0.2,
): BandScale {
  const [r0, r1] = range;
  const totalWidth = r1 - r0;
  const n = domain.length || 1;

  // With padding, each "slot" = bandwidth + paddingWidth
  // n bands + (n-1) inner paddings + 2 outer paddings
  // totalWidth = n * bandwidth + (n - 1) * innerPad + 2 * outerPad
  // where innerPad = bandwidth * padding, outerPad = bandwidth * padding / 2
  const step = totalWidth / (n + padding * (n - 1) + padding);
  const bandwidth = step;
  const outerPadding = (step * padding) / 2;

  const indexMap = new Map<string, number>();
  domain.forEach((d, i) => indexMap.set(d, i));

  return {
    domain,
    range: [r0, r1],
    bandwidth,
    scale(category: string): number {
      const i = indexMap.get(category) ?? 0;
      return r0 + outerPadding + i * (bandwidth + bandwidth * padding);
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extend a domain to "nice" round numbers.
 */
function niceExtent(min: number, max: number): [number, number] {
  if (min === max) {
    if (min === 0) return [0, 1];
    return min > 0 ? [0, min * 1.2] : [min * 1.2, 0];
  }

  let lo = min;
  let hi = max;

  // Always include zero for bar charts
  if (lo > 0) lo = 0;
  if (hi < 0) hi = 0;

  const span = hi - lo;
  const step = niceStep(lo, hi, 5);

  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;

  return [lo, hi];
}

/**
 * Compute a "nice" step size for the given range and desired tick count.
 */
function niceStep(min: number, max: number, count: number): number {
  const span = max - min || 1;
  const rawStep = span / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;

  let niceNorm: number;
  if (normalized <= 1) niceNorm = 1;
  else if (normalized <= 2) niceNorm = 2;
  else if (normalized <= 5) niceNorm = 5;
  else niceNorm = 10;

  return niceNorm * magnitude;
}
