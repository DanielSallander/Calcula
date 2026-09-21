//! FILENAME: app/extensions/Charts/lib/__tests__/dataPointOverrides.test.ts
// PURPOSE: Tests for data point override utility functions.
// CONTEXT: This file used to spend ~40 of its tests on `getDataPointOverride`,
//          `applyOverrideColor`, `applyOverrideOpacity`, `buildOverrideMap` and
//          `getOverrideFromMap`. Once every painter went through
//          `resolveDatumStyle`, a repo-wide grep found those five exports had no
//          caller outside THIS file — the tests were the only thing keeping them
//          alive, and they were an INDEX-ONLY route past the key matching and
//          the authoring-space translation. They are gone, and what they were
//          really asserting (an override's colour, opacity, border and explode
//          offset reach the datum) is asserted here through the one resolver a
//          painter is allowed to call.

import { describe, it, expect } from "vitest";
import {
  getExplodeOffset,
  resolveDatumStyle,
} from "../dataPointOverrides";
import type { ChartSpec, DataPointOverride, ParsedChartData } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeSpec(overrides?: DataPointOverride[]): ChartSpec {
  return {
    mark: "bar",
    data: { startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "A", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true },
    yAxis: { title: null, gridLines: true, showLabels: true },
    legend: { visible: true, position: "right" },
    palette: "default",
    dataPointOverrides: overrides,
  } as ChartSpec;
}

/** Three series x four categories, no filtering (painter space == authoring). */
function makeData(): ParsedChartData {
  return {
    categories: ["Q1", "Q2", "Q3", "Q4"],
    series: [
      { name: "A", values: [10, 20, 30, 40], color: null },
      { name: "B", values: [11, 21, 31, 41], color: null },
      { name: "C", values: [12, 22, 32, 42], color: null },
    ],
  } as ParsedChartData;
}

// ============================================================================
// getExplodeOffset
// ============================================================================

describe("getExplodeOffset", () => {
  it("returns 0 when no override", () => {
    expect(getExplodeOffset(undefined)).toBe(0);
  });

  it("returns 0 when override has no exploded field", () => {
    const override: DataPointOverride = { seriesIndex: 0, categoryIndex: 0, color: "#FF0000" };
    expect(getExplodeOffset(override)).toBe(0);
  });

  it("returns the explode offset", () => {
    const override: DataPointOverride = { seriesIndex: 0, categoryIndex: 0, exploded: 15 };
    expect(getExplodeOffset(override)).toBe(15);
  });
});

// ============================================================================
// Index-keyed overrides, through the ONE resolver
// ============================================================================

describe("resolveDatumStyle — index-keyed overrides", () => {
  const data = makeData();

  it("leaves the painter's base style alone when no overrides exist", () => {
    const style = resolveDatumStyle(makeSpec(), data, 0, 0, { fill: "#4472C4" });
    expect(style.fill).toBe("#4472C4");
    expect(style.opacity).toBeNull();
    expect(style.matchedBy).toBe("none");
    expect(style.override).toBeUndefined();
  });

  it("leaves the painter's base style alone for an empty overrides array", () => {
    const style = resolveDatumStyle(makeSpec([]), data, 0, 0, { fill: "#4472C4" });
    expect(style.fill).toBe("#4472C4");
    expect(style.matchedBy).toBe("none");
  });

  it("applies the override at its index pair and nowhere else", () => {
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 2, color: "#FF0000" }]);
    expect(resolveDatumStyle(spec, data, 0, 2, { fill: "#4472C4" }).fill).toBe("#FF0000");
    expect(resolveDatumStyle(spec, data, 0, 0, { fill: "#4472C4" }).fill).toBe("#4472C4");
    expect(resolveDatumStyle(spec, data, 1, 2, { fill: "#4472C4" }).fill).toBe("#4472C4");
  });

  it("picks the right override out of several", () => {
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 0, color: "#111111" },
      { seriesIndex: 0, categoryIndex: 1, color: "#222222" },
      { seriesIndex: 1, categoryIndex: 0, color: "#333333" },
    ]);
    expect(resolveDatumStyle(spec, data, 0, 0).fill).toBe("#111111");
    expect(resolveDatumStyle(spec, data, 0, 1).fill).toBe("#222222");
    expect(resolveDatumStyle(spec, data, 1, 0).fill).toBe("#333333");
  });

  it("keeps the base colour when the override sets only opacity", () => {
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 0, opacity: 0.5 }]);
    const style = resolveDatumStyle(spec, data, 0, 0, { fill: "#4472C4" });
    expect(style.fill).toBe("#4472C4");
    expect(style.opacity).toBe(0.5);
  });

  it("keeps the base opacity when the override sets only a colour", () => {
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 0, color: "#FF0000" }]);
    const style = resolveDatumStyle(spec, data, 0, 0, { fill: "#4472C4", opacity: 0.8 });
    expect(style.fill).toBe("#FF0000");
    expect(style.opacity).toBe(0.8);
  });

  it("honours a ZERO opacity override rather than falling through it", () => {
    // `?? ` not `||`: an invisible datum is a legal thing to ask for, and the
    // old applyOverrideOpacity had a dedicated test for exactly this.
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 0, opacity: 0 }]);
    expect(resolveDatumStyle(spec, data, 0, 0, { fill: "#4472C4", opacity: 0.8 }).opacity).toBe(0);
  });
});

// ============================================================================
// Integration: Override with all fields
// ============================================================================

describe("full override integration", () => {
  it("carries every field of a fully-populated override onto its datum", () => {
    const override: DataPointOverride = {
      seriesIndex: 1,
      categoryIndex: 3,
      color: "#FF5500",
      opacity: 0.7,
      borderColor: "#000000",
      borderWidth: 3,
      exploded: 12,
    };

    const style = resolveDatumStyle(makeSpec([override]), makeData(), 1, 3, {
      fill: "#4472C4",
    });

    expect(style.fill).toBe("#FF5500");
    expect(style.opacity).toBe(0.7);
    expect(style.borderColor).toBe("#000000");
    expect(style.borderWidth).toBe(3);
    expect(style.explodeOffset).toBe(12);
    expect(style.matchedBy).toBe("index");
    expect(style.override).toBe(override);
  });

  it("serializes to JSON and back correctly", () => {
    const overrides: DataPointOverride[] = [
      { seriesIndex: 0, categoryIndex: 0, color: "#FF0000" },
      { seriesIndex: 1, categoryIndex: 2, opacity: 0.5, exploded: 10 },
      { seriesIndex: 0, categoryIndex: 3, borderColor: "#000", borderWidth: 2 },
    ];

    const json = JSON.stringify(overrides);
    const parsed: DataPointOverride[] = JSON.parse(json);

    expect(parsed).toHaveLength(3);
    expect(parsed[0].color).toBe("#FF0000");
    expect(parsed[1].opacity).toBe(0.5);
    expect(parsed[1].exploded).toBe(10);
    expect(parsed[2].borderColor).toBe("#000");
    expect(parsed[2].borderWidth).toBe(2);
  });
});

// ============================================================================
// The five deleted exports stay deleted
// ============================================================================

describe("the index-only helpers are gone", () => {
  it("exports no route past the key matching and the authoring translation", async () => {
    const mod = await import("../dataPointOverrides");
    for (const name of [
      "getDataPointOverride",
      "applyOverrideColor",
      "applyOverrideOpacity",
      "buildOverrideMap",
      "getOverrideFromMap",
    ]) {
      expect(mod).not.toHaveProperty(name);
    }
  });
});
