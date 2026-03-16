//! FILENAME: app/extensions/Charts/rendering/scales.ts
// PURPOSE: Scale computations for mapping data values to pixel coordinates.
// CONTEXT: Inspired by D3 scales but minimal. Supports all chart types.

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
  /** Map a category to its band start pixel (by name — first match for duplicates). */
  scale(category: string): number;
  /** Map a category index to its band start pixel (safe for duplicate names). */
  scaleIndex(index: number): number;
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
    scaleIndex(index: number): number {
      return r0 + outerPadding + index * (bandwidth + bandwidth * padding);
    },
  };
}

// ============================================================================
// Point Scale (for line, area, scatter X-axis)
// ============================================================================

export interface PointScale {
  domain: string[];
  range: [number, number];
  /** Step between points in pixels. */
  step: number;
  /** Map a category to its center point pixel (by name — first match for duplicates). */
  scale(category: string): number;
  /** Map a category index to its center point pixel (safe for duplicate names). */
  scaleIndex(index: number): number;
}

/**
 * Create a point scale mapping categorical values to evenly-spaced center points.
 * Unlike BandScale, there is no bandwidth — each category maps to a single point.
 * @param padding Fraction of step used as outer padding (0..1). Default 0.5.
 */
export function createPointScale(
  domain: string[],
  range: [number, number],
  padding = 0.5,
): PointScale {
  const [r0, r1] = range;
  const totalWidth = r1 - r0;
  const n = domain.length || 1;

  // n points, with padding on both sides
  const step = n > 1 ? totalWidth / (n - 1 + padding * 2) : totalWidth;
  const offset = n > 1 ? step * padding : totalWidth / 2;

  const indexMap = new Map<string, number>();
  domain.forEach((d, i) => indexMap.set(d, i));

  return {
    domain,
    range: [r0, r1],
    step,
    scale(category: string): number {
      const i = indexMap.get(category) ?? 0;
      return r0 + offset + i * step;
    },
    scaleIndex(index: number): number {
      return r0 + offset + index * step;
    },
  };
}

// ============================================================================
// Angular utilities (for pie/donut charts)
// ============================================================================

/**
 * Convert an array of values to start/end angles (in radians).
 * @param values Numeric values for each slice.
 * @param startAngleDeg Start angle in degrees (0 = 12 o'clock). Default 0.
 * @param padAngleDeg Padding between slices in degrees. Default 1.
 * @returns Array of { startAngle, endAngle } in radians.
 */
export function valuesToAngles(
  values: number[],
  startAngleDeg = 0,
  padAngleDeg = 1,
): Array<{ startAngle: number; endAngle: number }> {
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total === 0) {
    return values.map(() => ({ startAngle: 0, endAngle: 0 }));
  }

  const padRad = (padAngleDeg * Math.PI) / 180;
  const totalPad = padRad * values.length;
  const available = Math.PI * 2 - totalPad;
  // Start at -90deg (12 o'clock) + user offset
  let current = ((startAngleDeg - 90) * Math.PI) / 180;

  return values.map((v) => {
    const fraction = Math.max(0, v) / total;
    const sweep = fraction * available;
    const start = current + padRad / 2;
    const end = start + sweep;
    current = start + sweep + padRad / 2;
    return { startAngle: start, endAngle: end };
  });
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
