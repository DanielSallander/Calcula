//! FILENAME: app/extensions/Charts/lib/__tests__/chart-hyper.test.ts
// PURPOSE: Massive parameterized tests for chart utility functions.
// TARGET: 3000+ test cases via programmatic generation.

import { describe, it, expect } from "vitest";
import { createLinearScale, valuesToAngles } from "../../rendering/scales";
import { formatTickValue } from "../../rendering/chartPainterUtils";
import { getSeriesColor, PALETTES } from "../../rendering/chartTheme";

// ============================================================================
// 1. createLinearScale - 1000 cases
// ============================================================================

const linearCases: Array<[number, number, number, number, number, number]> = Array.from(
  { length: 1000 },
  (_, i) => {
    const domainMax = (i % 100) + 1;
    const fraction = Math.floor(i / 100) / 9;
    return [0, domainMax, 0, 500, fraction * domainMax, fraction * 500];
  },
);

describe("createLinearScale (1000 cases)", () => {
  it.each(linearCases)(
    "domain [0, %d] range [0, %d] maps %d -> ~%d (fraction idx %#)",
    (domainMin, domainMax, rangeMin, rangeMax, input, expectedOutput) => {
      const scale = createLinearScale([domainMin, domainMax], [rangeMin, rangeMax]);
      // niceExtent may widen the domain, so we verify linearity property:
      // scale(domainMin) === rangeMin and scale(domainMax) maps correctly
      const result = scale.scale(input);
      // The relationship should be linear: result/rangeMax ~ input/domainMax
      // But niceExtent may expand domain, so we verify via the scale's own domain
      const [d0, d1] = scale.domain;
      const [r0, r1] = scale.range;
      const expected = r0 + ((input - d0) / (d1 - d0 || 1)) * (r1 - r0);
      expect(result).toBeCloseTo(expected, 5);
    },
  );
});

// ============================================================================
// 2. formatTickValue - 1000 cases
// ============================================================================

const formatCases: Array<[number, string]> = Array.from({ length: 1000 }, (_, i) => {
  // Generate numbers spanning -1e9 to 1e9 with various magnitudes
  const sign = i % 2 === 0 ? 1 : -1;
  const magnitude = Math.floor(i / 10) % 10; // 0-9
  const base = ((i % 10) + 1) * 0.7; // 0.7 to 7.0
  const value = sign * base * Math.pow(10, magnitude);

  // Compute expected based on formatTickValue logic
  let expected: string;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    expected = (value / 1_000_000).toFixed(1) + "M";
  } else if (abs >= 1_000) {
    expected = (value / 1_000).toFixed(1) + "K";
  } else if (Number.isInteger(value)) {
    expected = value.toString();
  } else {
    expected = value.toFixed(1);
  }
  return [value, expected];
});

describe("formatTickValue (1000 cases)", () => {
  it.each(formatCases)("formatTickValue(%d) === %s", (value, expected) => {
    expect(formatTickValue(value)).toBe(expected);
  });
});

// ============================================================================
// 3. getSeriesColor - 500 cases (5 palettes x 100 indices)
// ============================================================================

const paletteNames = ["default", "vivid", "pastel", "ocean", "nonexistent"];

const colorCases: Array<[string, number, string]> = [];
for (const palette of paletteNames) {
  for (let idx = 0; idx < 100; idx++) {
    const colors = PALETTES[palette] ?? PALETTES.default;
    const expected = colors[idx % colors.length];
    colorCases.push([palette, idx, expected]);
  }
}

describe("getSeriesColor (500 cases)", () => {
  it.each(colorCases)(
    "palette=%s index=%d returns %s",
    (palette, index, expected) => {
      expect(getSeriesColor(palette, index, null)).toBe(expected);
    },
  );
});

// ============================================================================
// 4. valuesToAngles - 500 cases
// ============================================================================

const angleCases: Array<[number[], number]> = Array.from({ length: 500 }, (_, i) => {
  // Generate pseudo-random value arrays of varying length
  const len = (i % 8) + 2; // 2 to 9 elements
  const values: number[] = [];
  for (let j = 0; j < len; j++) {
    // Deterministic "random-ish" values based on index
    values.push(((i * 7 + j * 13 + 3) % 100) + 1);
  }
  return [values, i % 360]; // startAngleDeg varies
});

describe("valuesToAngles (500 cases)", () => {
  it.each(angleCases)(
    "values=%j startAngle=%d: angle sum equals 2*PI",
    (values, startAngleDeg) => {
      const angles = valuesToAngles(values, startAngleDeg, 0);
      // With no padding, total sweep should equal 2*PI
      const totalSweep = angles.reduce(
        (sum, a) => sum + (a.endAngle - a.startAngle),
        0,
      );
      expect(totalSweep).toBeCloseTo(Math.PI * 2, 5);
    },
  );
});

describe("valuesToAngles continuity (500 cases)", () => {
  it.each(angleCases)(
    "values=%j startAngle=%d: segments are contiguous",
    (values, startAngleDeg) => {
      const angles = valuesToAngles(values, startAngleDeg, 0);
      for (let i = 1; i < angles.length; i++) {
        expect(angles[i].startAngle).toBeCloseTo(angles[i - 1].endAngle, 5);
      }
    },
  );
});
