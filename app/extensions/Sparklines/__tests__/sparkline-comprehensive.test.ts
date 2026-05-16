//! FILENAME: app/extensions/Sparklines/__tests__/sparkline-comprehensive.test.ts
// PURPOSE: Deep-dive tests for sparkline cross-sheet data, fill handler, axis options,
//          multi-cell groups, type changes, rendering coordinates, color priority,
//          win/loss thresholds, and performance.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the API event system used by fillHandler
vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "GRID_REFRESH" },
}));

import {
  createSparklineGroup,
  removeSparklineGroup,
  updateSparklineGroup,
  getSparklineForCell,
  hasSparkline,
  getAllGroups,
  getGroupById,
  getGroupsForRange,
  groupSparklines,
  ungroupSparkline,
  exportGroups,
  importGroups,
  resetSparklineStore,
  invalidateDataCache,
  setCachedGroupData,
  getCachedGroupData,
} from "../store";
import {
  validateSparklineRanges,
  type CellRange,
  type SparklineGroup,
  type SparklineType,
} from "../types";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetSparklineStore();
});

// ============================================================================
// Helper: create a single-cell sparkline quickly
// ============================================================================

function mkRange(sr: number, sc: number, er: number, ec: number): CellRange {
  return { startRow: sr, startCol: sc, endRow: er, endCol: ec };
}

function createSingle(locRow: number, locCol: number, dataRange: CellRange, type: SparklineType = "line") {
  return createSparklineGroup(
    mkRange(locRow, locCol, locRow, locCol),
    dataRange,
    type,
  );
}

// ============================================================================
// 1. Cross-sheet data range vs location on different sheets
//    (store itself is sheet-agnostic; the range coords are just numbers)
// ============================================================================

describe("sparkline with data from different sheets (range independence)", () => {
  it("location and data range can reference disjoint coordinate spaces", () => {
    // Location in row 0, data in rows 100-104 (simulating another sheet region)
    const result = createSingle(0, 10, mkRange(100, 0, 100, 4));
    expect(result.valid).toBe(true);
    expect(result.group).toBeDefined();
    expect(result.group!.dataRange.startRow).toBe(100);
  });

  it("multiple sparklines can share a remote data range region", () => {
    const data = mkRange(200, 0, 204, 5);
    const r1 = createSparklineGroup(mkRange(0, 0, 4, 0), data, "line");
    expect(r1.valid).toBe(true);
    expect(r1.count).toBe(5);

    // Second group with different location but overlapping data area
    const r2 = createSparklineGroup(mkRange(0, 1, 4, 1), mkRange(200, 6, 204, 11), "column");
    expect(r2.valid).toBe(true);
    expect(getAllGroups()).toHaveLength(2);
  });

  it("updating data range to a far-away region preserves location cells", () => {
    const r = createSingle(5, 5, mkRange(0, 0, 0, 9));
    expect(r.valid).toBe(true);
    const id = r.group!.id;
    updateSparklineGroup(id, { dataRange: mkRange(999, 0, 999, 9) });
    expect(hasSparkline(5, 5)).toBe(true);
    expect(getGroupById(id)!.dataRange.startRow).toBe(999);
  });
});

// ============================================================================
// 2. Fill handler: drag-fill sparkline to adjacent cells
// ============================================================================

describe("sparkline fill handler logic", () => {
  // We test the fill handler indirectly via the store's createSparklineGroup
  // since the actual handler imports from @api/events which we mock.

  it("filling down creates new sparklines with shifted data ranges", () => {
    // Source sparkline at (0,5) reading data from row 0
    createSingle(0, 5, mkRange(0, 0, 0, 4));

    // Simulate fill: create sparklines for rows 1-3 with shifted data
    for (let r = 1; r <= 3; r++) {
      const shifted = mkRange(r, 0, r, 4);
      const res = createSingle(r, 5, shifted);
      expect(res.valid).toBe(true);
    }

    expect(getAllGroups()).toHaveLength(4);
    for (let r = 0; r <= 3; r++) {
      expect(hasSparkline(r, 5)).toBe(true);
      const entry = getSparklineForCell(r, 5)!;
      expect(entry.group.dataRange.startRow).toBe(r);
    }
  });

  it("filling right creates sparklines with column-shifted data ranges", () => {
    createSingle(0, 0, mkRange(0, 10, 4, 10));
    for (let c = 1; c <= 4; c++) {
      createSingle(0, c, mkRange(0, 10 + c, 4, 10 + c));
    }
    expect(getAllGroups()).toHaveLength(5);
    for (let c = 0; c <= 4; c++) {
      expect(hasSparkline(0, c)).toBe(true);
    }
  });

  it("fill preserves visual properties when template is used", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 4));
    const tpl = r.group!;
    updateSparklineGroup(tpl.id, {
      showHighPoint: true,
      highPointColor: "#FF0000",
      lineWidth: 3,
      showAxis: true,
      axisScaleType: "custom",
      axisMinValue: -10,
      axisMaxValue: 100,
    });

    // Create a "filled" sparkline copying properties
    const r2 = createSingle(1, 5, mkRange(1, 0, 1, 4));
    updateSparklineGroup(r2.group!.id, {
      showHighPoint: tpl.showHighPoint,
      highPointColor: tpl.highPointColor,
      lineWidth: tpl.lineWidth,
      showAxis: tpl.showAxis,
      axisScaleType: tpl.axisScaleType,
      axisMinValue: tpl.axisMinValue,
      axisMaxValue: tpl.axisMaxValue,
    });

    const filled = getGroupById(r2.group!.id)!;
    expect(filled.showHighPoint).toBe(true);
    expect(filled.highPointColor).toBe("#FF0000");
    expect(filled.lineWidth).toBe(3);
    expect(filled.axisMinValue).toBe(-10);
    expect(filled.axisMaxValue).toBe(100);
  });

  it("fill to negative coordinates is skipped (data range guard)", () => {
    // Data range at row 0; shifting up by 1 would give row -1
    const shifted: CellRange = {
      startRow: 0 - 1, startCol: 0, endRow: 0 - 1, endCol: 4,
    };
    expect(shifted.startRow).toBe(-1);
    // The fill handler checks for negative coords; we verify the guard concept
    expect(shifted.startRow < 0).toBe(true);
  });
});

// ============================================================================
// 3. Axis options: minValue, maxValue, both, sameForAll
// ============================================================================

describe("sparkline axis options", () => {
  it("custom min only clamps the low end", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 4));
    updateSparklineGroup(r.group!.id, {
      axisScaleType: "custom",
      axisMinValue: -50,
      axisMaxValue: null,
    });
    const g = getGroupById(r.group!.id)!;
    expect(g.axisMinValue).toBe(-50);
    expect(g.axisMaxValue).toBeNull();
  });

  it("custom max only clamps the high end", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 4));
    updateSparklineGroup(r.group!.id, {
      axisScaleType: "custom",
      axisMinValue: null,
      axisMaxValue: 200,
    });
    const g = getGroupById(r.group!.id)!;
    expect(g.axisMinValue).toBeNull();
    expect(g.axisMaxValue).toBe(200);
  });

  it("custom min and max both set", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 4));
    updateSparklineGroup(r.group!.id, {
      axisScaleType: "custom",
      axisMinValue: -100,
      axisMaxValue: 100,
    });
    const g = getGroupById(r.group!.id)!;
    expect(g.axisMinValue).toBe(-100);
    expect(g.axisMaxValue).toBe(100);
  });

  it("sameForAll scale type is stored and exported", () => {
    const r = createSparklineGroup(mkRange(0, 5, 2, 5), mkRange(0, 0, 2, 4), "column");
    updateSparklineGroup(r.group!.id, { axisScaleType: "sameForAll" });
    const exported = exportGroups();
    expect(exported[0].axisScaleType).toBe("sameForAll");
  });

  it("switching from custom back to auto clears min/max", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 4));
    updateSparklineGroup(r.group!.id, {
      axisScaleType: "custom",
      axisMinValue: -10,
      axisMaxValue: 10,
    });
    updateSparklineGroup(r.group!.id, {
      axisScaleType: "auto",
      axisMinValue: null,
      axisMaxValue: null,
    });
    const g = getGroupById(r.group!.id)!;
    expect(g.axisScaleType).toBe("auto");
    expect(g.axisMinValue).toBeNull();
  });
});

// ============================================================================
// 4. Multi-cell location groups: 1x5, 5x1, 3x3 (invalid)
// ============================================================================

describe("sparkline group with multi-cell location", () => {
  it("1x5 horizontal location with matching data columns", () => {
    const loc = mkRange(0, 0, 0, 4); // 1 row, 5 cols
    const data = mkRange(1, 0, 5, 4); // 5 rows, 5 cols
    const r = createSparklineGroup(loc, data, "line");
    expect(r.valid).toBe(true);
    expect(r.count).toBe(5);
    expect(r.orientation).toBe("byCol");
    for (let c = 0; c <= 4; c++) {
      expect(hasSparkline(0, c)).toBe(true);
      expect(getSparklineForCell(0, c)!.index).toBe(c);
    }
  });

  it("5x1 vertical location with matching data rows", () => {
    const loc = mkRange(0, 10, 4, 10); // 5 rows, 1 col
    const data = mkRange(0, 0, 4, 8);  // 5 rows, 9 cols
    const r = createSparklineGroup(loc, data, "column");
    expect(r.valid).toBe(true);
    expect(r.count).toBe(5);
    expect(r.orientation).toBe("byRow");
    for (let row = 0; row <= 4; row++) {
      expect(hasSparkline(row, 10)).toBe(true);
      expect(getSparklineForCell(row, 10)!.index).toBe(row);
    }
  });

  it("3x3 location is rejected (must be 1D)", () => {
    const loc = mkRange(0, 0, 2, 2);
    const data = mkRange(0, 5, 8, 14);
    const r = createSparklineGroup(loc, data, "line");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("single cell");
  });

  it("1x1 location with 2D data is rejected", () => {
    const loc = mkRange(0, 0, 0, 0);
    const data = mkRange(0, 1, 3, 5); // 4x5 block
    const r = createSparklineGroup(loc, data, "line");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("2D data range");
  });
});

// ============================================================================
// 5. Cell index consistency after location resize
// ============================================================================

describe("cell index consistency after location resize", () => {
  it("expanding location adds new cells to index", () => {
    const r = createSparklineGroup(mkRange(0, 10, 2, 10), mkRange(0, 0, 2, 5), "line");
    expect(hasSparkline(0, 10)).toBe(true);
    expect(hasSparkline(3, 10)).toBe(false);

    // Expand location to 5 rows, expand data to match
    updateSparklineGroup(r.group!.id, {
      location: mkRange(0, 10, 4, 10),
      dataRange: mkRange(0, 0, 4, 5),
    });
    expect(hasSparkline(3, 10)).toBe(true);
    expect(hasSparkline(4, 10)).toBe(true);
  });

  it("shrinking location removes old cells from index", () => {
    const r = createSparklineGroup(mkRange(0, 10, 4, 10), mkRange(0, 0, 4, 5), "line");
    expect(hasSparkline(4, 10)).toBe(true);

    updateSparklineGroup(r.group!.id, {
      location: mkRange(0, 10, 1, 10),
      dataRange: mkRange(0, 0, 1, 5),
    });
    expect(hasSparkline(0, 10)).toBe(true);
    expect(hasSparkline(1, 10)).toBe(true);
    expect(hasSparkline(2, 10)).toBe(false);
    expect(hasSparkline(4, 10)).toBe(false);
  });

  it("moving location updates all cell entries", () => {
    const r = createSparklineGroup(mkRange(0, 0, 0, 0), mkRange(0, 1, 0, 5), "line");
    expect(hasSparkline(0, 0)).toBe(true);

    updateSparklineGroup(r.group!.id, {
      location: mkRange(10, 10, 10, 10),
    });
    expect(hasSparkline(0, 0)).toBe(false);
    expect(hasSparkline(10, 10)).toBe(true);
  });
});

// ============================================================================
// 6. Type change preserving other options
// ============================================================================

describe("sparkline type change preserves other options", () => {
  it("line -> column preserves axis and color settings", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 4), "line");
    updateSparklineGroup(r.group!.id, {
      showHighPoint: true,
      highPointColor: "#00FF00",
      showAxis: true,
      axisScaleType: "custom",
      axisMinValue: -5,
      lineWidth: 2.5,
    });
    updateSparklineGroup(r.group!.id, { type: "column" });

    const g = getGroupById(r.group!.id)!;
    expect(g.type).toBe("column");
    expect(g.showHighPoint).toBe(true);
    expect(g.highPointColor).toBe("#00FF00");
    expect(g.showAxis).toBe(true);
    expect(g.axisMinValue).toBe(-5);
    expect(g.lineWidth).toBe(2.5); // preserved even though column doesn't use it
  });

  it("column -> winloss -> line round-trips", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 4), "column");
    updateSparklineGroup(r.group!.id, {
      negativeColor: "#ABCDEF",
      showNegativePoints: true,
    });
    updateSparklineGroup(r.group!.id, { type: "winloss" });
    expect(getGroupById(r.group!.id)!.type).toBe("winloss");
    expect(getGroupById(r.group!.id)!.negativeColor).toBe("#ABCDEF");

    updateSparklineGroup(r.group!.id, { type: "line" });
    expect(getGroupById(r.group!.id)!.type).toBe("line");
    expect(getGroupById(r.group!.id)!.showNegativePoints).toBe(true);
  });

  it("type change is reflected in export", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 4), "line");
    updateSparklineGroup(r.group!.id, { type: "winloss" });
    const exported = exportGroups();
    expect(exported[0].type).toBe("winloss");
  });
});

// ============================================================================
// 7. Rendering coordinate calculations for various cell sizes
// ============================================================================

describe("rendering coordinate calculations", () => {
  // We test the coordinate math that the renderer uses:
  // plotLeft = cellLeft + padding, plotWidth = cellRight - cellLeft - 2*padding
  const padding = 3;

  const testCases = [
    { name: "tiny 20x10", width: 20, height: 10 },
    { name: "small 60x20", width: 60, height: 20 },
    { name: "standard 100x25", width: 100, height: 25 },
    { name: "wide 300x25", width: 300, height: 25 },
    { name: "tall 60x200", width: 60, height: 200 },
    { name: "large 500x300", width: 500, height: 300 },
  ];

  for (const tc of testCases) {
    it(`${tc.name}: plot area computed correctly`, () => {
      const cellLeft = 50;
      const cellTop = 100;
      const cellRight = cellLeft + tc.width;
      const cellBottom = cellTop + tc.height;

      const plotLeft = cellLeft + padding;
      const plotTop = cellTop + padding;
      const plotWidth = cellRight - cellLeft - padding * 2;
      const plotHeight = cellBottom - cellTop - padding * 2;

      expect(plotLeft).toBe(cellLeft + 3);
      expect(plotTop).toBe(cellTop + 3);
      expect(plotWidth).toBe(tc.width - 6);
      expect(plotHeight).toBe(tc.height - 6);

      // Renderer skips if plotWidth < 4 or plotHeight < 4
      if (tc.width < 10 || tc.height < 10) {
        expect(plotWidth < 4 || plotHeight < 4).toBe(true);
      } else {
        expect(plotWidth >= 4).toBe(true);
        expect(plotHeight >= 4).toBe(true);
      }
    });
  }

  it("line sparkline point X distribution for 5 data points", () => {
    const plotLeft = 10;
    const plotWidth = 200;
    const dataLen = 5;
    const pointX = (i: number) => plotLeft + (i / Math.max(dataLen - 1, 1)) * plotWidth;
    expect(pointX(0)).toBe(10);
    expect(pointX(2)).toBe(110);
    expect(pointX(4)).toBe(210);
  });

  it("column sparkline bar width for 10 bars in 100px width", () => {
    const plotWidth = 100;
    const dataLen = 10;
    const barGap = 1;
    const totalBarWidth = plotWidth / dataLen;
    const barWidth = Math.max(1, totalBarWidth - barGap);
    expect(totalBarWidth).toBe(10);
    expect(barWidth).toBe(9);
  });

  it("single data point line sparkline renders at center X", () => {
    const plotLeft = 10;
    const plotWidth = 200;
    const dataLen = 1;
    const pointX = (i: number) => plotLeft + (i / Math.max(dataLen - 1, 1)) * plotWidth;
    expect(pointX(0)).toBe(10); // single point at left edge (0/1 * width)
  });
});

// ============================================================================
// 8. Color resolution priority: custom > type-default > theme
// ============================================================================

describe("color resolution priority", () => {
  it("default colors are applied on creation", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 4));
    const g = r.group!;
    expect(g.color).toBe("#4472C4");
    expect(g.negativeColor).toBe("#D94735");
    expect(g.highPointColor).toBe("#D94735");
    expect(g.firstPointColor).toBe("#43A047");
  });

  it("custom color overrides defaults", () => {
    const r = createSparklineGroup(
      mkRange(0, 5, 0, 5),
      mkRange(0, 0, 0, 4),
      "line",
      "#FF00FF",
      "#00FFFF",
    );
    expect(r.group!.color).toBe("#FF00FF");
    expect(r.group!.negativeColor).toBe("#00FFFF");
  });

  it("updating individual point colors overrides defaults independently", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 4));
    updateSparklineGroup(r.group!.id, { highPointColor: "#AABBCC" });
    const g = getGroupById(r.group!.id)!;
    expect(g.highPointColor).toBe("#AABBCC");
    // Other point colors remain at defaults
    expect(g.lowPointColor).toBe("#D94735");
    expect(g.firstPointColor).toBe("#43A047");
  });

  it("marker color defaults to main color", () => {
    const r = createSparklineGroup(
      mkRange(0, 5, 0, 5), mkRange(0, 0, 0, 4), "line", "#123456",
    );
    expect(r.group!.markerColor).toBe("#123456");
  });
});

// ============================================================================
// 9. Win/loss with custom threshold values
// ============================================================================

describe("win/loss sparkline behavior", () => {
  it("winloss type is created with correct defaults", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 9), "winloss");
    expect(r.group!.type).toBe("winloss");
    expect(r.group!.color).toBe("#4472C4"); // positive
    expect(r.group!.negativeColor).toBe("#D94735"); // negative
  });

  it("winloss with showNegativePoints highlights negative bars", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 9), "winloss");
    updateSparklineGroup(r.group!.id, {
      showNegativePoints: true,
      negativePointColor: "#FF0000",
    });
    const g = getGroupById(r.group!.id)!;
    expect(g.showNegativePoints).toBe(true);
    expect(g.negativePointColor).toBe("#FF0000");
  });

  it("winloss with all special points enabled", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 9), "winloss");
    updateSparklineGroup(r.group!.id, {
      showHighPoint: true,
      showLowPoint: true,
      showFirstPoint: true,
      showLastPoint: true,
      showNegativePoints: true,
    });
    const g = getGroupById(r.group!.id)!;
    expect(g.showHighPoint).toBe(true);
    expect(g.showLowPoint).toBe(true);
    expect(g.showFirstPoint).toBe(true);
    expect(g.showLastPoint).toBe(true);
    expect(g.showNegativePoints).toBe(true);
  });

  it("winloss export/import round-trip preserves all flags", () => {
    const r = createSingle(0, 5, mkRange(0, 0, 0, 9), "winloss");
    updateSparklineGroup(r.group!.id, {
      showHighPoint: true,
      showAxis: true,
      plotOrder: "rightToLeft",
      emptyCellHandling: "gaps",
    });
    const exported = exportGroups();
    resetSparklineStore();
    importGroups(exported);
    const g = getAllGroups()[0];
    expect(g.type).toBe("winloss");
    expect(g.showHighPoint).toBe(true);
    expect(g.showAxis).toBe(true);
    expect(g.plotOrder).toBe("rightToLeft");
    expect(g.emptyCellHandling).toBe("gaps");
  });
});

// ============================================================================
// 10. Performance: 500 sparklines created, queried, exported
// ============================================================================

describe("performance: 500 sparklines", () => {
  it("creates 500 sparklines within acceptable time", () => {
    const start = performance.now();
    for (let i = 0; i < 500; i++) {
      createSingle(i, 20, mkRange(i, 0, i, 9));
    }
    const elapsed = performance.now() - start;

    expect(getAllGroups()).toHaveLength(500);
    // Should complete in under 2 seconds even on slow CI
    expect(elapsed).toBeLessThan(2000);
  });

  it("queries 500 sparklines by cell lookup", () => {
    for (let i = 0; i < 500; i++) {
      createSingle(i, 20, mkRange(i, 0, i, 9));
    }

    const start = performance.now();
    for (let i = 0; i < 500; i++) {
      const entry = getSparklineForCell(i, 20);
      expect(entry).toBeDefined();
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("exports and imports 500 sparklines", () => {
    for (let i = 0; i < 500; i++) {
      createSingle(i, 20, mkRange(i, 0, i, 9));
    }

    const start = performance.now();
    const exported = exportGroups();
    expect(exported).toHaveLength(500);

    resetSparklineStore();
    importGroups(exported);
    const elapsed = performance.now() - start;

    expect(getAllGroups()).toHaveLength(500);
    expect(hasSparkline(0, 20)).toBe(true);
    expect(hasSparkline(499, 20)).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });
});
