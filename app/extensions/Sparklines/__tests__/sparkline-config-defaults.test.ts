//! FILENAME: app/extensions/Sparklines/__tests__/sparkline-config-defaults.test.ts
// PURPOSE: Tests for sparkline configuration defaults and value chains.

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSparklineGroup,
  resetSparklineStore,
} from "../store";
import type { CellRange, SparklineType } from "../types";

// ============================================================================
// Fixtures
// ============================================================================

const loc: CellRange = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
const data: CellRange = { startRow: 0, startCol: 1, endRow: 0, endCol: 5 };

beforeEach(() => {
  resetSparklineStore();
});

const HEX_REGEX = /^#[0-9A-Fa-f]{6}$/;

// ============================================================================
// Default sparkline group options for each type
// ============================================================================

const SPARKLINE_TYPES: SparklineType[] = ["line", "column", "winloss"];

describe("sparkline defaults - per type", () => {
  for (const type of SPARKLINE_TYPES) {
    it(`creates a valid group for type "${type}"`, () => {
      const result = createSparklineGroup(loc, data, type);
      expect(result.valid).toBe(true);
      const group = result.group!;
      expect(group.type).toBe(type);
      expect(group.id).toBeGreaterThan(0);
      expect(group.location).toEqual(loc);
      expect(group.dataRange).toEqual(data);
    });
  }
});

// ============================================================================
// All boolean defaults are explicit (not undefined)
// ============================================================================

describe("sparkline defaults - boolean fields are explicit", () => {
  it("all boolean fields are boolean, not undefined", () => {
    const result = createSparklineGroup(loc, data, "line");
    const group = result.group!;
    const boolFields = [
      "showMarkers", "showHighPoint", "showLowPoint",
      "showFirstPoint", "showLastPoint", "showNegativePoints", "showAxis",
    ] as const;
    for (const field of boolFields) {
      expect(typeof group[field]).toBe("boolean");
    }
  });

  it("marker flags default to false for line type", () => {
    const group = createSparklineGroup(loc, data, "line").group!;
    expect(group.showMarkers).toBe(false);
    expect(group.showHighPoint).toBe(false);
    expect(group.showLowPoint).toBe(false);
    expect(group.showFirstPoint).toBe(false);
    expect(group.showLastPoint).toBe(false);
    expect(group.showNegativePoints).toBe(false);
  });

  it("showAxis defaults to false", () => {
    const group = createSparklineGroup(loc, data, "column").group!;
    expect(group.showAxis).toBe(false);
  });
});

// ============================================================================
// Color defaults are valid hex strings
// ============================================================================

describe("sparkline defaults - color fields are valid hex", () => {
  it("primary and negative colors are valid hex", () => {
    const group = createSparklineGroup(loc, data, "line").group!;
    expect(group.color).toMatch(HEX_REGEX);
    expect(group.negativeColor).toMatch(HEX_REGEX);
  });

  it("all point colors are valid hex", () => {
    const group = createSparklineGroup(loc, data, "line").group!;
    expect(group.highPointColor).toMatch(HEX_REGEX);
    expect(group.lowPointColor).toMatch(HEX_REGEX);
    expect(group.firstPointColor).toMatch(HEX_REGEX);
    expect(group.lastPointColor).toMatch(HEX_REGEX);
    expect(group.negativePointColor).toMatch(HEX_REGEX);
    expect(group.markerColor).toMatch(HEX_REGEX);
  });

  it("custom colors override defaults", () => {
    const group = createSparklineGroup(loc, data, "line", "#FF0000", "#00FF00").group!;
    expect(group.color).toBe("#FF0000");
    expect(group.negativeColor).toBe("#00FF00");
  });

  it("marker color defaults to the primary color", () => {
    const group = createSparklineGroup(loc, data, "line", "#AABBCC").group!;
    expect(group.markerColor).toBe("#AABBCC");
  });
});

// ============================================================================
// Axis defaults
// ============================================================================

describe("sparkline defaults - axis configuration", () => {
  it("axisScaleType defaults to auto", () => {
    const group = createSparklineGroup(loc, data, "line").group!;
    expect(group.axisScaleType).toBe("auto");
  });

  it("custom axis min/max default to null", () => {
    const group = createSparklineGroup(loc, data, "line").group!;
    expect(group.axisMinValue).toBeNull();
    expect(group.axisMaxValue).toBeNull();
  });

  it("emptyCellHandling defaults to zero", () => {
    const group = createSparklineGroup(loc, data, "column").group!;
    expect(group.emptyCellHandling).toBe("zero");
  });

  it("plotOrder defaults to default", () => {
    const group = createSparklineGroup(loc, data, "winloss").group!;
    expect(group.plotOrder).toBe("default");
  });

  it("lineWidth is a positive number", () => {
    const group = createSparklineGroup(loc, data, "line").group!;
    expect(group.lineWidth).toBeGreaterThan(0);
  });
});
