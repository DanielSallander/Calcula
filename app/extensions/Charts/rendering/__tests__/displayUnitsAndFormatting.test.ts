//! FILENAME: app/extensions/Charts/rendering/__tests__/displayUnitsAndFormatting.test.ts
// PURPOSE: Tests for display unit helpers and tick format logic in chartPainterUtils.

import { describe, it, expect } from "vitest";
import {
  getDisplayUnitFactor,
  getDisplayUnitLabel,
  formatTickValueWithFormat,
  formatTickValue,
} from "../chartPainterUtils";

// ============================================================================
// getDisplayUnitFactor
// ============================================================================

describe("getDisplayUnitFactor", () => {
  it("returns 1 for undefined", () => {
    expect(getDisplayUnitFactor(undefined)).toBe(1);
  });

  it("returns 1 for 'none'", () => {
    expect(getDisplayUnitFactor("none")).toBe(1);
  });

  it("returns 100 for 'hundreds'", () => {
    expect(getDisplayUnitFactor("hundreds")).toBe(100);
  });

  it("returns 1000 for 'thousands'", () => {
    expect(getDisplayUnitFactor("thousands")).toBe(1_000);
  });

  it("returns 1_000_000 for 'millions'", () => {
    expect(getDisplayUnitFactor("millions")).toBe(1_000_000);
  });

  it("returns 1_000_000_000 for 'billions'", () => {
    expect(getDisplayUnitFactor("billions")).toBe(1_000_000_000);
  });

  it("returns 1_000_000_000_000 for 'trillions'", () => {
    expect(getDisplayUnitFactor("trillions")).toBe(1_000_000_000_000);
  });
});

// ============================================================================
// getDisplayUnitLabel
// ============================================================================

describe("getDisplayUnitLabel", () => {
  it("returns 'Thousands' for 'thousands'", () => {
    expect(getDisplayUnitLabel("thousands")).toBe("Thousands");
  });

  it("returns 'Millions' for 'millions'", () => {
    expect(getDisplayUnitLabel("millions")).toBe("Millions");
  });

  it("returns empty string for 'none'", () => {
    expect(getDisplayUnitLabel("none")).toBe("");
  });

  it("returns 'Billions' for 'billions'", () => {
    expect(getDisplayUnitLabel("billions")).toBe("Billions");
  });
});

// ============================================================================
// formatTickValueWithFormat
// ============================================================================

describe("formatTickValueWithFormat", () => {
  it("formats percentage with default decimals", () => {
    expect(formatTickValueWithFormat(0.5, "%")).toBe("50%");
  });

  it("formats percentage with specified decimals", () => {
    expect(formatTickValueWithFormat(0.1234, ".2%")).toBe("12.34%");
  });

  it("formats dollar values", () => {
    const result = formatTickValueWithFormat(1234, "$.2");
    expect(result).toMatch(/^\$.*1.*234/);
  });

  it("formats with fixed decimals", () => {
    expect(formatTickValueWithFormat(3.14159, ".3")).toBe("3.142");
  });

  it("falls back to formatTickValue for unknown format", () => {
    expect(formatTickValueWithFormat(5000, "")).toBe(formatTickValue(5000));
  });
});

// ============================================================================
// formatTickValue (additional edge cases)
// ============================================================================

describe("formatTickValue edge cases", () => {
  it("formats millions with M suffix", () => {
    expect(formatTickValue(2_500_000)).toBe("2.5M");
  });

  it("formats thousands with K suffix", () => {
    expect(formatTickValue(7_500)).toBe("7.5K");
  });

  it("formats integers without decimals", () => {
    expect(formatTickValue(42)).toBe("42");
  });

  it("formats small decimals with 1 decimal place", () => {
    expect(formatTickValue(3.7)).toBe("3.7");
  });

  it("formats negative millions", () => {
    expect(formatTickValue(-1_500_000)).toBe("-1.5M");
  });

  it("formats negative thousands", () => {
    expect(formatTickValue(-2_500)).toBe("-2.5K");
  });

  it("formats zero", () => {
    expect(formatTickValue(0)).toBe("0");
  });
});
