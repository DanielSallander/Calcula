//! FILENAME: app/extensions/Sparklines/__tests__/sparkline-combos.test.ts
// PURPOSE: Combinatorial tests exercising all combinations of sparkline options.

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSparklineGroup,
  updateSparklineGroup,
  exportGroups,
  importGroups,
  getAllGroups,
  resetSparklineStore,
} from "../store";
import type {
  SparklineType,
  EmptyCellHandling,
  PlotOrder,
  SparklineGroup,
  CellRange,
} from "../types";

// ============================================================================
// Helpers
// ============================================================================

beforeEach(() => {
  resetSparklineStore();
});

const LOC: CellRange = { startRow: 0, startCol: 5, endRow: 0, endCol: 5 };
const DATA: CellRange = { startRow: 0, startCol: 0, endRow: 0, endCol: 4 };

/** Create a group at a unique location to avoid overlap removal. */
function locAt(row: number): CellRange {
  return { startRow: row, startCol: 10, endRow: row, endCol: 10 };
}

function createGroup(type: SparklineType, row: number = 0): SparklineGroup {
  const result = createSparklineGroup(locAt(row), DATA, type);
  expect(result.valid).toBe(true);
  return result.group!;
}

// ============================================================================
// 3 types x 3 empty cell modes x 2 plot orders = 18 combinations
// ============================================================================

const TYPES: SparklineType[] = ["line", "column", "winloss"];
const EMPTY_MODES: EmptyCellHandling[] = ["gaps", "zero", "connect"];
const PLOT_ORDERS: PlotOrder[] = ["default", "rightToLeft"];

describe("type x emptyCellHandling x plotOrder (18 combos)", () => {
  let comboIndex = 0;

  for (const type of TYPES) {
    for (const emptyCellHandling of EMPTY_MODES) {
      for (const plotOrder of PLOT_ORDERS) {
        const label = `${type} / ${emptyCellHandling} / ${plotOrder}`;
        const idx = comboIndex++;

        it(`[${idx}] ${label}: create, validate, export, reimport, verify identical`, () => {
          const group = createGroup(type, idx);
          updateSparklineGroup(group.id, { emptyCellHandling, plotOrder });

          const groups = getAllGroups();
          expect(groups).toHaveLength(1);
          const g = groups[0];
          expect(g.type).toBe(type);
          expect(g.emptyCellHandling).toBe(emptyCellHandling);
          expect(g.plotOrder).toBe(plotOrder);

          // Export and reimport
          const exported = exportGroups();
          expect(exported).toHaveLength(1);

          resetSparklineStore();
          importGroups(exported);

          const reimported = getAllGroups();
          expect(reimported).toHaveLength(1);
          expect(reimported[0].type).toBe(type);
          expect(reimported[0].emptyCellHandling).toBe(emptyCellHandling);
          expect(reimported[0].plotOrder).toBe(plotOrder);
          expect(reimported[0].id).toBe(g.id);
        });
      }
    }
  }
});

// ============================================================================
// Boolean option combos (7 booleans, 10+ patterns)
// ============================================================================

const BOOLEAN_KEYS: (keyof SparklineGroup)[] = [
  "showMarkers",
  "showHighPoint",
  "showLowPoint",
  "showFirstPoint",
  "showLastPoint",
  "showNegativePoints",
  "showAxis",
];

/** Generate deterministic boolean patterns. */
function boolPattern(mask: number): Partial<SparklineGroup> {
  const result: Record<string, boolean> = {};
  for (let i = 0; i < BOOLEAN_KEYS.length; i++) {
    result[BOOLEAN_KEYS[i] as string] = Boolean(mask & (1 << i));
  }
  return result as Partial<SparklineGroup>;
}

// Pick 12 representative masks: all-off, all-on, each single bit, plus a few combos
const BOOL_MASKS = [
  0b0000000, // all off
  0b1111111, // all on
  0b0000001, // showMarkers only
  0b0000010, // showHighPoint only
  0b0000100, // showLowPoint only
  0b0001000, // showFirstPoint only
  0b0010000, // showLastPoint only
  0b0100000, // showNegativePoints only
  0b1000000, // showAxis only
  0b0110011, // markers + highPoint + lastPoint + negativePoints
  0b1010101, // axis + negativePoints + lowPoint + markers
  0b0001111, // first four on
];

describe("boolean option combos (12 patterns)", () => {
  BOOL_MASKS.forEach((mask, i) => {
    it(`[${i}] mask=0b${mask.toString(2).padStart(7, "0")} roundtrips`, () => {
      const group = createGroup("line", i);
      const patch = boolPattern(mask);
      updateSparklineGroup(group.id, patch);

      const exported = exportGroups();
      resetSparklineStore();
      importGroups(exported);

      const reimported = getAllGroups()[0];
      for (const key of BOOLEAN_KEYS) {
        expect(reimported[key]).toBe(Boolean(mask & (1 << BOOLEAN_KEYS.indexOf(key))));
      }
    });
  });
});

// ============================================================================
// Type-specific option combos
// ============================================================================

describe("type-specific options", () => {
  it("line with markers enabled and custom marker color", () => {
    const group = createGroup("line");
    updateSparklineGroup(group.id, {
      showMarkers: true,
      markerColor: "#FF0000",
      lineWidth: 2.5,
    });
    const g = getAllGroups()[0];
    expect(g.showMarkers).toBe(true);
    expect(g.markerColor).toBe("#FF0000");
    expect(g.lineWidth).toBe(2.5);

    const exported = exportGroups();
    resetSparklineStore();
    importGroups(exported);
    const re = getAllGroups()[0];
    expect(re.showMarkers).toBe(true);
    expect(re.markerColor).toBe("#FF0000");
    expect(re.lineWidth).toBe(2.5);
  });

  it("line with all point highlights and distinct colors", () => {
    const group = createGroup("line");
    updateSparklineGroup(group.id, {
      showHighPoint: true,
      showLowPoint: true,
      showFirstPoint: true,
      showLastPoint: true,
      highPointColor: "#AA0000",
      lowPointColor: "#00AA00",
      firstPointColor: "#0000AA",
      lastPointColor: "#AAAA00",
    });
    const exported = exportGroups();
    resetSparklineStore();
    importGroups(exported);
    const re = getAllGroups()[0];
    expect(re.highPointColor).toBe("#AA0000");
    expect(re.lowPointColor).toBe("#00AA00");
    expect(re.firstPointColor).toBe("#0000AA");
    expect(re.lastPointColor).toBe("#AAAA00");
  });

  it("column with negative color and showNegativePoints", () => {
    const group = createGroup("column");
    updateSparklineGroup(group.id, {
      negativeColor: "#FF0000",
      showNegativePoints: true,
      negativePointColor: "#CC0000",
    });
    const g = getAllGroups()[0];
    expect(g.type).toBe("column");
    expect(g.negativeColor).toBe("#FF0000");
    expect(g.showNegativePoints).toBe(true);

    const exported = exportGroups();
    resetSparklineStore();
    importGroups(exported);
    const re = getAllGroups()[0];
    expect(re.negativeColor).toBe("#FF0000");
    expect(re.negativePointColor).toBe("#CC0000");
  });

  it("winloss with axis and custom scale", () => {
    const group = createGroup("winloss");
    updateSparklineGroup(group.id, {
      showAxis: true,
      axisScaleType: "custom",
      axisMinValue: -1,
      axisMaxValue: 1,
    });
    const g = getAllGroups()[0];
    expect(g.type).toBe("winloss");
    expect(g.showAxis).toBe(true);
    expect(g.axisScaleType).toBe("custom");
    expect(g.axisMinValue).toBe(-1);
    expect(g.axisMaxValue).toBe(1);
  });

  it("winloss with sameForAll axis scale", () => {
    const group = createGroup("winloss");
    updateSparklineGroup(group.id, {
      showAxis: true,
      axisScaleType: "sameForAll",
    });
    const exported = exportGroups();
    resetSparklineStore();
    importGroups(exported);
    const re = getAllGroups()[0];
    expect(re.axisScaleType).toBe("sameForAll");
  });

  it("column with rightToLeft plot order and gaps emptyCellHandling", () => {
    const group = createGroup("column");
    updateSparklineGroup(group.id, {
      plotOrder: "rightToLeft",
      emptyCellHandling: "gaps",
    });
    const exported = exportGroups();
    resetSparklineStore();
    importGroups(exported);
    const re = getAllGroups()[0];
    expect(re.plotOrder).toBe("rightToLeft");
    expect(re.emptyCellHandling).toBe("gaps");
  });
});
