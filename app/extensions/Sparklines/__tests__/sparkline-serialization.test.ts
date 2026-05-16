//! FILENAME: app/extensions/Sparklines/__tests__/sparkline-serialization.test.ts
// PURPOSE: Round-trip serialization tests for sparkline groups.

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSparklineGroup,
  exportGroups,
  importGroups,
  resetSparklineStore,
  getAllGroups,
  updateSparklineGroup,
} from "../store";
import type { SparklineGroup, SparklineType, EmptyCellHandling } from "../types";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetSparklineStore();
});

/** Simulate a full round-trip: export -> JSON.stringify -> JSON.parse -> import -> export */
function roundTrip(): SparklineGroup[] {
  const exported = exportGroups();
  const json = JSON.stringify(exported);
  const parsed = JSON.parse(json) as SparklineGroup[];
  resetSparklineStore();
  importGroups(parsed);
  return exportGroups();
}

// ============================================================================
// Basic Round-Trip
// ============================================================================

describe("sparkline serialization round-trip", () => {
  it("export -> import -> export produces identical JSON for a single group", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
      "line",
    );
    const first = JSON.stringify(exportGroups());
    const after = JSON.stringify(roundTrip());
    expect(after).toBe(first);
  });

  it("export -> import -> export produces identical JSON for multiple groups", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
      "line",
    );
    createSparklineGroup(
      { startRow: 1, startCol: 0, endRow: 1, endCol: 0 },
      { startRow: 1, startCol: 1, endRow: 1, endCol: 5 },
      "column",
    );
    createSparklineGroup(
      { startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
      { startRow: 2, startCol: 1, endRow: 2, endCol: 5 },
      "winloss",
    );
    const first = JSON.stringify(exportGroups());
    const after = JSON.stringify(roundTrip());
    expect(after).toBe(first);
  });
});

// ============================================================================
// All Sparkline Types
// ============================================================================

describe("all sparkline types round-trip", () => {
  const types: SparklineType[] = ["line", "column", "winloss"];

  for (const type of types) {
    it(`type "${type}" survives round-trip`, () => {
      createSparklineGroup(
        { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
        type,
      );
      const result = roundTrip();
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe(type);
    });
  }
});

// ============================================================================
// All Boolean Options
// ============================================================================

describe("boolean options round-trip", () => {
  const booleanFields: Array<keyof SparklineGroup> = [
    "showMarkers",
    "showHighPoint",
    "showLowPoint",
    "showFirstPoint",
    "showLastPoint",
    "showNegativePoints",
    "showAxis",
  ];

  for (const field of booleanFields) {
    it(`${field} = true survives round-trip`, () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
        "line",
      );
      updateSparklineGroup(result.group!.id, { [field]: true });
      const after = roundTrip();
      expect(after[0][field]).toBe(true);
    });

    it(`${field} = false survives round-trip`, () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
        "line",
      );
      updateSparklineGroup(result.group!.id, { [field]: false });
      const after = roundTrip();
      expect(after[0][field]).toBe(false);
    });
  }
});

// ============================================================================
// Custom Colors
// ============================================================================

describe("custom colors round-trip", () => {
  it("all color fields survive round-trip", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
      "line",
    );
    updateSparklineGroup(result.group!.id, {
      color: "#112233",
      negativeColor: "#445566",
      highPointColor: "#AABBCC",
      lowPointColor: "#DDEEFF",
      firstPointColor: "#001122",
      lastPointColor: "#334455",
      negativePointColor: "#667788",
      markerColor: "#99AABB",
    });
    const after = roundTrip();
    expect(after[0].color).toBe("#112233");
    expect(after[0].negativeColor).toBe("#445566");
    expect(after[0].highPointColor).toBe("#AABBCC");
    expect(after[0].lowPointColor).toBe("#DDEEFF");
    expect(after[0].firstPointColor).toBe("#001122");
    expect(after[0].lastPointColor).toBe("#334455");
    expect(after[0].negativePointColor).toBe("#667788");
    expect(after[0].markerColor).toBe("#99AABB");
  });
});

// ============================================================================
// Axis Options
// ============================================================================

describe("axis options round-trip", () => {
  it("custom axis bounds survive round-trip", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
      "line",
    );
    updateSparklineGroup(result.group!.id, {
      axisScaleType: "custom",
      axisMinValue: -50,
      axisMaxValue: 200,
    });
    const after = roundTrip();
    expect(after[0].axisScaleType).toBe("custom");
    expect(after[0].axisMinValue).toBe(-50);
    expect(after[0].axisMaxValue).toBe(200);
  });

  it("null axis bounds survive round-trip", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
      "line",
    );
    updateSparklineGroup(result.group!.id, {
      axisScaleType: "auto",
      axisMinValue: null,
      axisMaxValue: null,
    });
    const after = roundTrip();
    expect(after[0].axisMinValue).toBeNull();
    expect(after[0].axisMaxValue).toBeNull();
  });

  it("sameForAll axis scale type survives round-trip", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
      "line",
    );
    updateSparklineGroup(result.group!.id, { axisScaleType: "sameForAll" });
    const after = roundTrip();
    expect(after[0].axisScaleType).toBe("sameForAll");
  });
});

// ============================================================================
// Empty Cell Handling
// ============================================================================

describe("empty cell handling round-trip", () => {
  const modes: EmptyCellHandling[] = ["gaps", "zero", "connect"];

  for (const mode of modes) {
    it(`emptyCellHandling "${mode}" survives round-trip`, () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
        "line",
      );
      updateSparklineGroup(result.group!.id, { emptyCellHandling: mode });
      const after = roundTrip();
      expect(after[0].emptyCellHandling).toBe(mode);
    });
  }
});

// ============================================================================
// Plot Order
// ============================================================================

describe("plot order round-trip", () => {
  it("rightToLeft plot order survives round-trip", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
      "line",
    );
    updateSparklineGroup(result.group!.id, { plotOrder: "rightToLeft" });
    const after = roundTrip();
    expect(after[0].plotOrder).toBe("rightToLeft");
  });
});

// ============================================================================
// Stress: 100 Groups
// ============================================================================

describe("large-scale round-trip", () => {
  it("100 groups round-trip without data loss", () => {
    for (let i = 0; i < 100; i++) {
      createSparklineGroup(
        { startRow: i, startCol: 0, endRow: i, endCol: 0 },
        { startRow: i, startCol: 1, endRow: i, endCol: 10 },
        (["line", "column", "winloss"] as SparklineType[])[i % 3],
      );
    }

    expect(getAllGroups()).toHaveLength(100);
    const before = JSON.stringify(exportGroups());
    const after = JSON.stringify(roundTrip());
    expect(after).toBe(before);
    expect(getAllGroups()).toHaveLength(100);
  });
});

// ============================================================================
// Line Width
// ============================================================================

describe("lineWidth round-trip", () => {
  it("custom lineWidth survives round-trip", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      { startRow: 0, startCol: 1, endRow: 0, endCol: 5 },
      "line",
    );
    updateSparklineGroup(result.group!.id, { lineWidth: 3.5 });
    const after = roundTrip();
    expect(after[0].lineWidth).toBe(3.5);
  });
});
