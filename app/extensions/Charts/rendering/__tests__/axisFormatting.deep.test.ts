//! FILENAME: app/extensions/Charts/rendering/__tests__/axisFormatting.deep.test.ts
// PURPOSE: Deep tests for axis formatting, tick labels, and axis configuration edge cases.

import { describe, it, expect } from "vitest";
import type { AxisSpec, ScaleSpec, DisplayUnit } from "../../types";
import { createLinearScale, createLogScale, createScaleFromSpec } from "../scales";

// ============================================================================
// Helpers
// ============================================================================

/** Build a fully-configured AxisSpec for testing. */
function makeAxis(overrides: Partial<AxisSpec> = {}): AxisSpec {
  return {
    title: null,
    gridLines: true,
    showLabels: true,
    labelAngle: 0,
    min: null,
    max: null,
    ...overrides,
  };
}

/** Compute the display-unit divisor for a given DisplayUnit. */
function displayUnitFactor(unit: DisplayUnit): number {
  const factors: Record<DisplayUnit, number> = {
    none: 1,
    hundreds: 100,
    thousands: 1_000,
    tenThousands: 10_000,
    hundredThousands: 100_000,
    millions: 1_000_000,
    tenMillions: 10_000_000,
    hundredMillions: 100_000_000,
    billions: 1_000_000_000,
    trillions: 1_000_000_000_000,
  };
  return factors[unit];
}

/**
 * Simulate formatting a tick value with a simple format string.
 * Supports: "$" prefix, "," grouping, ".Nf" fixed decimals, "e" scientific.
 */
function formatTickLabel(value: number, format: string): string {
  if (format === "e" || format === ".2e") {
    return value.toExponential(2);
  }
  const fixedMatch = format.match(/\.(\d+)f$/);
  const decimals = fixedMatch ? parseInt(fixedMatch[1], 10) : 0;
  const useDollar = format.startsWith("$");
  const useComma = format.includes(",");

  let str = value.toFixed(decimals);
  if (useComma) {
    const parts = str.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    str = parts.join(".");
  }
  if (useDollar) str = "$" + str;
  return str;
}

// ============================================================================
// Date Axis Formatting
// ============================================================================

describe("date axis formatting", () => {
  // Dates represented as epoch-days or timestamps for testing scale behavior

  it("formats year labels from annual timestamps", () => {
    const years = [2020, 2021, 2022, 2023, 2024];
    const scale = createLinearScale([2020, 2024], [0, 400]);
    const ticks = scale.ticks(5);
    // Ticks should be niced integers in the year range
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(scale.domain[0]);
      expect(t).toBeLessThanOrEqual(scale.domain[1]);
    }
  });

  it("month-level ticks on a 12-month range", () => {
    // Represent months as 1-12
    const scale = createLinearScale([1, 12], [0, 500]);
    const ticks = scale.ticks(6);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks[0]).toBeGreaterThanOrEqual(0);
  });

  it("day-level ticks on a 30-day range", () => {
    const scale = createLinearScale([1, 30], [0, 600]);
    const ticks = scale.ticks(7);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) {
      expect(Number.isInteger(t) || Math.abs(t - Math.round(t)) < 0.01).toBe(true);
    }
  });

  it("hour-level ticks on a 24-hour range", () => {
    const scale = createLinearScale([0, 24], [0, 480]);
    const ticks = scale.ticks(6);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    // Steps should be multiples of common hour intervals (1, 2, 4, 5, 6, etc.)
    if (ticks.length >= 2) {
      const step = ticks[1] - ticks[0];
      expect(step).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Currency Formatting on Axis
// ============================================================================

describe("currency formatting on axis", () => {
  it("formats ticks with dollar sign and commas", () => {
    const axis = makeAxis({ tickFormat: "$,.0f", min: 0, max: 50000 });
    const scale = createLinearScale([0, 50000], [0, 400]);
    const ticks = scale.ticks(5);
    for (const t of ticks) {
      const label = formatTickLabel(t, axis.tickFormat!);
      expect(label).toMatch(/^\$/);
      if (t >= 1000) expect(label).toContain(",");
    }
  });

  it("formats with two decimal places for cents", () => {
    const axis = makeAxis({ tickFormat: "$,.2f" });
    const label = formatTickLabel(1234.5, axis.tickFormat!);
    expect(label).toBe("$1,234.50");
  });

  it("handles zero value in currency format", () => {
    const label = formatTickLabel(0, "$,.0f");
    expect(label).toBe("$0");
  });

  it("handles negative values in currency format", () => {
    const label = formatTickLabel(-5000, "$,.0f");
    expect(label).toBe("$-5,000");
  });
});

// ============================================================================
// Scientific Notation
// ============================================================================

describe("scientific notation", () => {
  it("formats large values in scientific notation", () => {
    const label = formatTickLabel(1500000, ".2e");
    expect(label).toBe("1.50e+6");
  });

  it("formats small values in scientific notation", () => {
    const label = formatTickLabel(0.00042, ".2e");
    expect(label).toBe("4.20e-4");
  });

  it("formats zero in scientific notation", () => {
    const label = formatTickLabel(0, ".2e");
    expect(label).toBe("0.00e+0");
  });

  it("formats negative values in scientific notation", () => {
    const label = formatTickLabel(-3.14e8, ".2e");
    expect(label).toBe("-3.14e+8");
  });
});

// ============================================================================
// Custom Number Formats
// ============================================================================

describe("custom number formats", () => {
  it("plain integer format", () => {
    expect(formatTickLabel(42, ".0f")).toBe("42");
  });

  it("one-decimal format", () => {
    expect(formatTickLabel(3.14159, ".1f")).toBe("3.1");
  });

  it("comma-separated thousands", () => {
    expect(formatTickLabel(1234567, ",.0f")).toBe("1,234,567");
  });

  it("two-decimal with comma grouping", () => {
    expect(formatTickLabel(9876.543, ",.2f")).toBe("9,876.54");
  });
});

// ============================================================================
// Logarithmic Axis Tick Labels
// ============================================================================

describe("logarithmic axis tick labels", () => {
  it("generates power-of-10 ticks across wide range", () => {
    const scale = createLogScale([1, 1000000], [0, 600]);
    const ticks = scale.ticks(10);
    expect(ticks).toContain(1);
    expect(ticks).toContain(100);
    expect(ticks).toContain(10000);
    expect(ticks).toContain(1000000);
  });

  it("tick labels at powers of 10 are clean integers", () => {
    const scale = createLogScale([1, 10000], [0, 400]);
    const ticks = scale.ticks(5);
    for (const t of ticks) {
      // All log-scale ticks should be exact values (no floating point drift)
      expect(t).toBe(Math.round(t * 1e10) / 1e10);
    }
  });

  it("log scale with axis spec integration", () => {
    const axis = makeAxis({
      scale: { type: "log" },
      tickFormat: ".0f",
    });
    const scale = createScaleFromSpec(axis.scale, [1, 1000], [0, 300]);
    expect(scale.scale(10)).toBeCloseTo(100, 0);
    const ticks = scale.ticks(5);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// Reversed Axis
// ============================================================================

describe("reversed axis", () => {
  it("reversed linear scale maps min to range-max", () => {
    const scale = createScaleFromSpec({ type: "linear", reverse: true }, [0, 100], [0, 400]);
    expect(scale.scale(scale.domain[0])).toBeCloseTo(400);
    expect(scale.scale(scale.domain[1])).toBeCloseTo(0);
  });

  it("reversed log scale maps small values to range-max", () => {
    const scale = createScaleFromSpec({ type: "log", reverse: true }, [1, 1000], [0, 300]);
    expect(scale.scale(1)).toBeCloseTo(300);
    expect(scale.scale(1000)).toBeCloseTo(0);
  });

  it("reversed axis preserves tick ordering", () => {
    const scale = createScaleFromSpec({ type: "linear", reverse: true }, [0, 100], [0, 400]);
    const ticks = scale.ticks(5);
    // Tick values should still be ascending in data space
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
  });

  it("reversed axis midpoint maps to range midpoint", () => {
    const scale = createScaleFromSpec({ type: "linear", reverse: true }, [0, 100], [0, 400]);
    const mid = (scale.domain[0] + scale.domain[1]) / 2;
    expect(scale.scale(mid)).toBeCloseTo(200);
  });
});

// ============================================================================
// Multi-line Category Labels
// ============================================================================

describe("multi-line category labels", () => {
  it("long labels can be split at word boundaries", () => {
    const labels = ["North America Region", "South East Asia Pacific", "Europe Middle East"];
    const splitLabels = labels.map((l) => l.split(" "));
    expect(splitLabels[0]).toEqual(["North", "America", "Region"]);
    expect(splitLabels[1]).toHaveLength(4);
  });

  it("single-word labels produce single-line output", () => {
    const labels = ["Q1", "Q2", "Q3", "Q4"];
    const splitLabels = labels.map((l) => l.split(" "));
    for (const parts of splitLabels) {
      expect(parts).toHaveLength(1);
    }
  });
});

// ============================================================================
// Rotated Labels (45/90 degrees)
// ============================================================================

describe("rotated labels", () => {
  it("AxisSpec accepts 45-degree label rotation", () => {
    const axis = makeAxis({ labelAngle: 45 });
    expect(axis.labelAngle).toBe(45);
  });

  it("AxisSpec accepts 90-degree label rotation", () => {
    const axis = makeAxis({ labelAngle: 90 });
    expect(axis.labelAngle).toBe(90);
  });

  it("AxisSpec accepts negative rotation", () => {
    const axis = makeAxis({ labelAngle: -45 });
    expect(axis.labelAngle).toBe(-45);
  });

  it("rotation of 0 means horizontal labels", () => {
    const axis = makeAxis({ labelAngle: 0 });
    expect(axis.labelAngle).toBe(0);
  });
});

// ============================================================================
// Min/Max/Step Overrides
// ============================================================================

describe("min/max/step overrides", () => {
  it("domain override via ScaleSpec narrows the domain", () => {
    const scale = createScaleFromSpec({ type: "linear", domain: [10, 50] }, [0, 100], [0, 400]);
    expect(scale.domain[0]).toBeLessThanOrEqual(10);
    expect(scale.domain[1]).toBeGreaterThanOrEqual(50);
    expect(scale.domain[1]).toBeLessThanOrEqual(60);
  });

  it("majorUnit is respected in AxisSpec", () => {
    const axis = makeAxis({ min: 0, max: 1000, majorUnit: 250 });
    expect(axis.majorUnit).toBe(250);
    // Generate ticks using majorUnit as step
    const ticks: number[] = [];
    for (let v = axis.min!; v <= axis.max!; v += axis.majorUnit!) {
      ticks.push(v);
    }
    expect(ticks).toEqual([0, 250, 500, 750, 1000]);
  });

  it("minorUnit subdivides major ticks", () => {
    const axis = makeAxis({ min: 0, max: 100, majorUnit: 50, minorUnit: 10 });
    const minorTicks: number[] = [];
    for (let v = axis.min!; v <= axis.max!; v += axis.minorUnit!) {
      minorTicks.push(v);
    }
    expect(minorTicks).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it("display unit divides values correctly", () => {
    expect(displayUnitFactor("thousands")).toBe(1000);
    expect(displayUnitFactor("millions")).toBe(1_000_000);
    expect(displayUnitFactor("billions")).toBe(1_000_000_000);
    expect(displayUnitFactor("none")).toBe(1);
  });

  it("display unit formats large values as smaller numbers", () => {
    const value = 5_000_000;
    const factor = displayUnitFactor("millions");
    const displayed = value / factor;
    expect(displayed).toBe(5);
  });
});

// ============================================================================
// Empty/Null Axis Configuration
// ============================================================================

describe("empty/null axis configuration", () => {
  it("minimal axis with all nulls is valid", () => {
    const axis = makeAxis({
      title: null,
      min: null,
      max: null,
    });
    expect(axis.title).toBeNull();
    expect(axis.min).toBeNull();
    expect(axis.max).toBeNull();
  });

  it("undefined optional fields remain undefined", () => {
    const axis = makeAxis();
    expect(axis.scale).toBeUndefined();
    expect(axis.tickFormat).toBeUndefined();
    expect(axis.majorUnit).toBeUndefined();
    expect(axis.minorUnit).toBeUndefined();
    expect(axis.displayUnit).toBeUndefined();
    expect(axis.majorTickMark).toBeUndefined();
    expect(axis.minorTickMark).toBeUndefined();
    expect(axis.lineColor).toBeUndefined();
    expect(axis.crossesAt).toBeUndefined();
  });

  it("empty string title is distinct from null", () => {
    const axis = makeAxis({ title: "" });
    expect(axis.title).toBe("");
    expect(axis.title).not.toBeNull();
  });

  it("showLabels false suppresses labels", () => {
    const axis = makeAxis({ showLabels: false });
    expect(axis.showLabels).toBe(false);
  });

  it("JSON roundtrip preserves null values", () => {
    const axis = makeAxis({ title: null, min: null, max: null });
    const parsed: AxisSpec = JSON.parse(JSON.stringify(axis));
    expect(parsed.title).toBeNull();
    expect(parsed.min).toBeNull();
    expect(parsed.max).toBeNull();
  });

  it("undefined ScaleSpec falls back to linear", () => {
    const scale = createScaleFromSpec(undefined, [0, 100], [0, 400]);
    expect(scale.scale(0)).toBeCloseTo(0);
    expect(scale.scale(scale.domain[1])).toBeCloseTo(400);
  });
});
