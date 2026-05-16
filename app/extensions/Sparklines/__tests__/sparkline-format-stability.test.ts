//! FILENAME: app/extensions/Sparklines/__tests__/sparkline-format-stability.test.ts
// PURPOSE: Verify backward-compatible behavior for sparkline data formats.

import { describe, it, expect, beforeEach } from "vitest";
import type { SparklineGroup, SparklineType, EmptyCellHandling, AxisScaleType, PlotOrder } from "../types";
import {
  createSparklineGroup,
  exportGroups,
  importGroups,
  resetSparklineStore,
} from "../store";

beforeEach(() => {
  resetSparklineStore();
});

// ============================================================================
// Sparkline Type Strings
// ============================================================================

describe("SparklineType string stability", () => {
  it("all sparkline type strings are stable", () => {
    const types: SparklineType[] = ["line", "column", "winloss"];
    expect(types).toMatchInlineSnapshot(`
      [
        "line",
        "column",
        "winloss",
      ]
    `);
  });

  it("EmptyCellHandling strings are stable", () => {
    const values: EmptyCellHandling[] = ["gaps", "zero", "connect"];
    expect(values).toMatchInlineSnapshot(`
      [
        "gaps",
        "zero",
        "connect",
      ]
    `);
  });

  it("AxisScaleType strings are stable", () => {
    const values: AxisScaleType[] = ["auto", "sameForAll", "custom"];
    expect(values).toMatchInlineSnapshot(`
      [
        "auto",
        "sameForAll",
        "custom",
      ]
    `);
  });

  it("PlotOrder strings are stable", () => {
    const values: PlotOrder[] = ["default", "rightToLeft"];
    expect(values).toMatchInlineSnapshot(`
      [
        "default",
        "rightToLeft",
      ]
    `);
  });
});

// ============================================================================
// Default Options Values
// ============================================================================

describe("SparklineGroup default values stability", () => {
  it("createSparklineGroup uses stable default color", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    expect(result.group).toBeDefined();
    expect(result.group!.color).toBe("#4472C4");
    expect(result.group!.negativeColor).toBe("#D94735");
  });

  it("default boolean flags are all false", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const g = result.group!;
    expect(g.showMarkers).toBe(false);
    expect(g.showHighPoint).toBe(false);
    expect(g.showLowPoint).toBe(false);
    expect(g.showFirstPoint).toBe(false);
    expect(g.showLastPoint).toBe(false);
    expect(g.showNegativePoints).toBe(false);
    expect(g.showAxis).toBe(false);
  });

  it("default numeric values are stable", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const g = result.group!;
    expect(g.lineWidth).toBe(1.5);
    expect(g.axisMinValue).toBeNull();
    expect(g.axisMaxValue).toBeNull();
  });

  it("default point colors are stable", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const g = result.group!;
    expect(g.highPointColor).toBe("#D94735");
    expect(g.lowPointColor).toBe("#D94735");
    expect(g.firstPointColor).toBe("#43A047");
    expect(g.lastPointColor).toBe("#43A047");
    expect(g.negativePointColor).toBe("#D94735");
  });

  it("default axis and empty cell handling are stable", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const g = result.group!;
    expect(g.axisScaleType).toBe("auto");
    expect(g.emptyCellHandling).toBe("zero");
    expect(g.plotOrder).toBe("default");
  });
});

// ============================================================================
// Exported JSON Format Stability
// ============================================================================

describe("Sparkline export/import JSON format stability", () => {
  it("exported JSON has all expected fields", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const exported = exportGroups();
    expect(exported).toHaveLength(1);
    const g = exported[0];

    // Verify all fields are present (structural contract)
    const expectedKeys: (keyof SparklineGroup)[] = [
      "id", "location", "dataRange", "type", "color", "negativeColor",
      "showMarkers", "lineWidth",
      "showHighPoint", "showLowPoint", "showFirstPoint", "showLastPoint", "showNegativePoints",
      "highPointColor", "lowPointColor", "firstPointColor", "lastPointColor",
      "negativePointColor", "markerColor",
      "showAxis", "axisScaleType", "axisMinValue", "axisMaxValue",
      "emptyCellHandling", "plotOrder",
    ];
    for (const key of expectedKeys) {
      expect(g).toHaveProperty(key);
    }
  });

  it("JSON round-trip preserves all values", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "column",
      "#FF0000",
      "#00FF00",
    );
    const exported = exportGroups();
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as SparklineGroup[];

    resetSparklineStore();
    importGroups(parsed);
    const reimported = exportGroups();

    expect(reimported).toHaveLength(1);
    expect(reimported[0].type).toBe("column");
    expect(reimported[0].color).toBe("#FF0000");
    expect(reimported[0].negativeColor).toBe("#00FF00");
    expect(reimported[0].location).toEqual({ startRow: 0, startCol: 5, endRow: 0, endCol: 5 });
    expect(reimported[0].dataRange).toEqual({ startRow: 0, startCol: 0, endRow: 0, endCol: 4 });
  });

  it("location and dataRange use CellRange shape", () => {
    createSparklineGroup(
      { startRow: 1, startCol: 3, endRow: 1, endCol: 3 },
      { startRow: 1, startCol: 0, endRow: 1, endCol: 2 },
      "winloss",
    );
    const g = exportGroups()[0];
    expect(g.location).toEqual({ startRow: 1, startCol: 3, endRow: 1, endCol: 3 });
    expect(g.dataRange).toEqual({ startRow: 1, startCol: 0, endRow: 1, endCol: 2 });
  });
});
