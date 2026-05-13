//! FILENAME: app/extensions/Sparklines/__tests__/store.test.ts
// PURPOSE: Tests for sparkline store (CRUD, group, ungroup, import/export).

import { describe, it, expect, beforeEach } from "vitest";
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
} from "../store";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetSparklineStore();
});

// ============================================================================
// CRUD Tests
// ============================================================================

describe("createSparklineGroup", () => {
  it("creates a valid sparkline group", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    expect(result.valid).toBe(true);
    expect(result.group).toBeDefined();
    expect(result.group!.type).toBe("line");
    expect(result.group!.color).toBe("#4472C4");
  });

  it("creates group with custom colors", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "column",
      "#FF0000",
      "#00FF00",
    );
    expect(result.valid).toBe(true);
    expect(result.group!.color).toBe("#FF0000");
    expect(result.group!.negativeColor).toBe("#00FF00");
  });

  it("rejects invalid range combination", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 0, endRow: 2, endCol: 2 }, // 2D location
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    expect(result.valid).toBe(false);
  });

  it("sets default values for new properties", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    expect(result.group!.showAxis).toBe(false);
    expect(result.group!.axisScaleType).toBe("auto");
    expect(result.group!.axisMinValue).toBeNull();
    expect(result.group!.axisMaxValue).toBeNull();
    expect(result.group!.emptyCellHandling).toBe("zero");
    expect(result.group!.plotOrder).toBe("default");
  });

  it("removes overlapping groups when creating", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    expect(getAllGroups()).toHaveLength(1);

    // Create another in the same location
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 9 },
      "column",
    );
    expect(getAllGroups()).toHaveLength(1);
    expect(getAllGroups()[0].type).toBe("column");
  });
});

describe("removeSparklineGroup", () => {
  it("removes an existing group", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    expect(removeSparklineGroup(result.group!.id)).toBe(true);
    expect(getAllGroups()).toHaveLength(0);
  });

  it("returns false for non-existent group", () => {
    expect(removeSparklineGroup(999)).toBe(false);
  });
});

describe("updateSparklineGroup", () => {
  it("updates visual properties", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const id = result.group!.id;

    updateSparklineGroup(id, {
      color: "#FF0000",
      showHighPoint: true,
      showAxis: true,
      axisScaleType: "custom",
      axisMinValue: -10,
      axisMaxValue: 100,
      emptyCellHandling: "gaps",
      plotOrder: "rightToLeft",
    });

    const group = getGroupById(id)!;
    expect(group.color).toBe("#FF0000");
    expect(group.showHighPoint).toBe(true);
    expect(group.showAxis).toBe(true);
    expect(group.axisScaleType).toBe("custom");
    expect(group.axisMinValue).toBe(-10);
    expect(group.axisMaxValue).toBe(100);
    expect(group.emptyCellHandling).toBe("gaps");
    expect(group.plotOrder).toBe("rightToLeft");
  });

  it("returns false for non-existent group", () => {
    expect(updateSparklineGroup(999, { color: "#FF0000" })).toBe(false);
  });

  it("rebuilds cell index when location changes", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const id = result.group!.id;
    expect(hasSparkline(0, 5)).toBe(true);

    updateSparklineGroup(id, {
      location: { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
    });
    expect(hasSparkline(0, 5)).toBe(false);
    expect(hasSparkline(1, 5)).toBe(true);
  });
});

// ============================================================================
// Lookup Tests
// ============================================================================

describe("cell lookup", () => {
  it("finds sparkline for cells in location range", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 4, endCol: 5 }, // 5 cells in column
      { startRow: 0, startCol: 0, endRow: 4, endCol: 3 }, // 5 rows x 4 cols
      "line",
    );

    for (let r = 0; r <= 4; r++) {
      expect(hasSparkline(r, 5)).toBe(true);
      const entry = getSparklineForCell(r, 5)!;
      expect(entry.index).toBe(r);
      expect(entry.orientation).toBe("byRow");
    }
  });

  it("returns undefined for non-sparkline cells", () => {
    expect(getSparklineForCell(0, 0)).toBeUndefined();
    expect(hasSparkline(0, 0)).toBe(false);
  });

  it("finds groups overlapping a range", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    createSparklineGroup(
      { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
      { startRow: 1, startCol: 0, endRow: 1, endCol: 4 },
      "column",
    );
    createSparklineGroup(
      { startRow: 10, startCol: 5, endRow: 10, endCol: 5 },
      { startRow: 10, startCol: 0, endRow: 10, endCol: 4 },
      "winloss",
    );

    const overlapping = getGroupsForRange(0, 5, 1, 5);
    expect(overlapping).toHaveLength(2);
  });
});

// ============================================================================
// Group / Ungroup Tests
// ============================================================================

describe("groupSparklines", () => {
  it("merges overlapping groups into one", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    createSparklineGroup(
      { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
      { startRow: 1, startCol: 0, endRow: 1, endCol: 4 },
      "line",
    );
    expect(getAllGroups()).toHaveLength(2);

    const merged = groupSparklines(0, 5, 1, 5);
    expect(merged).not.toBeNull();
    expect(getAllGroups()).toHaveLength(1);
    expect(merged!.location.startRow).toBe(0);
    expect(merged!.location.endRow).toBe(1);
  });

  it("returns null if fewer than 2 groups overlap", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    expect(groupSparklines(0, 5, 0, 5)).toBeNull();
  });

  it("preserves visual properties from first group", () => {
    const r1 = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
      "#FF0000",
    );
    updateSparklineGroup(r1.group!.id, { showHighPoint: true });

    createSparklineGroup(
      { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
      { startRow: 1, startCol: 0, endRow: 1, endCol: 4 },
      "line",
      "#0000FF",
    );

    const merged = groupSparklines(0, 5, 1, 5)!;
    expect(merged.color).toBe("#FF0000");
    expect(merged.showHighPoint).toBe(true);
  });
});

describe("ungroupSparkline", () => {
  it("splits a multi-cell group into individual groups", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 2, endCol: 5 }, // 3 cells
      { startRow: 0, startCol: 0, endRow: 2, endCol: 3 }, // 3 rows x 4 cols
      "line",
    );
    expect(getAllGroups()).toHaveLength(1);

    const count = ungroupSparkline(result.group!.id);
    expect(count).toBe(3);
    expect(getAllGroups()).toHaveLength(3);

    // Each group should have a single-cell location
    for (const group of getAllGroups()) {
      expect(group.location.startRow).toBe(group.location.endRow);
      expect(group.location.startCol).toBe(group.location.endCol);
    }
  });

  it("returns 0 for single-cell group", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const count = ungroupSparkline(result.group!.id);
    expect(count).toBe(0);
  });

  it("preserves visual properties in ungrouped sparklines", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 2, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 2, endCol: 3 },
      "line",
      "#FF0000",
    );
    updateSparklineGroup(result.group!.id, { showAxis: true, showHighPoint: true });

    ungroupSparkline(result.group!.id);

    for (const group of getAllGroups()) {
      expect(group.color).toBe("#FF0000");
      expect(group.showAxis).toBe(true);
      expect(group.showHighPoint).toBe(true);
    }
  });
});

// ============================================================================
// Import / Export Tests
// ============================================================================

describe("import/export", () => {
  it("exports and reimports groups correctly", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
      "#FF0000",
    );
    createSparklineGroup(
      { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
      { startRow: 1, startCol: 0, endRow: 1, endCol: 4 },
      "column",
    );

    const exported = exportGroups();
    expect(exported).toHaveLength(2);

    // Reset and reimport
    resetSparklineStore();
    expect(getAllGroups()).toHaveLength(0);

    importGroups(exported);
    expect(getAllGroups()).toHaveLength(2);
    expect(hasSparkline(0, 5)).toBe(true);
    expect(hasSparkline(1, 5)).toBe(true);
  });

  it("preserves new properties through export/import", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    updateSparklineGroup(result.group!.id, {
      showAxis: true,
      axisScaleType: "custom",
      axisMinValue: -5,
      axisMaxValue: 50,
      emptyCellHandling: "connect",
      plotOrder: "rightToLeft",
    });

    const exported = exportGroups();
    resetSparklineStore();
    importGroups(exported);

    const group = getAllGroups()[0];
    expect(group.showAxis).toBe(true);
    expect(group.axisScaleType).toBe("custom");
    expect(group.axisMinValue).toBe(-5);
    expect(group.axisMaxValue).toBe(50);
    expect(group.emptyCellHandling).toBe("connect");
    expect(group.plotOrder).toBe("rightToLeft");
  });

  it("JSON serialization roundtrip preserves all fields", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 2, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 2, endCol: 4 },
      "winloss",
      "#123456",
      "#654321",
    );
    updateSparklineGroup(result.group!.id, {
      showMarkers: true,
      lineWidth: 2.5,
      showHighPoint: true,
      showLowPoint: true,
      showFirstPoint: true,
      showLastPoint: true,
      showNegativePoints: true,
      highPointColor: "#AA0000",
      lowPointColor: "#00AA00",
      firstPointColor: "#0000AA",
      lastPointColor: "#AAAAAA",
      negativePointColor: "#FF00FF",
      markerColor: "#00FFFF",
      showAxis: true,
      axisScaleType: "sameForAll",
      emptyCellHandling: "gaps",
      plotOrder: "rightToLeft",
    });

    const json = JSON.stringify(exportGroups());
    resetSparklineStore();
    importGroups(JSON.parse(json));

    const group = getAllGroups()[0];
    expect(group.type).toBe("winloss");
    expect(group.color).toBe("#123456");
    expect(group.negativeColor).toBe("#654321");
    expect(group.showMarkers).toBe(true);
    expect(group.lineWidth).toBe(2.5);
    expect(group.showHighPoint).toBe(true);
    expect(group.showLowPoint).toBe(true);
    expect(group.showFirstPoint).toBe(true);
    expect(group.showLastPoint).toBe(true);
    expect(group.showNegativePoints).toBe(true);
    expect(group.highPointColor).toBe("#AA0000");
    expect(group.lowPointColor).toBe("#00AA00");
    expect(group.firstPointColor).toBe("#0000AA");
    expect(group.lastPointColor).toBe("#AAAAAA");
    expect(group.negativePointColor).toBe("#FF00FF");
    expect(group.markerColor).toBe("#00FFFF");
    expect(group.showAxis).toBe(true);
    expect(group.axisScaleType).toBe("sameForAll");
    expect(group.emptyCellHandling).toBe("gaps");
    expect(group.plotOrder).toBe("rightToLeft");
  });
});

// ============================================================================
// Reset Tests
// ============================================================================

describe("resetSparklineStore", () => {
  it("clears all state", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    expect(getAllGroups()).toHaveLength(1);

    resetSparklineStore();
    expect(getAllGroups()).toHaveLength(0);
    expect(hasSparkline(0, 5)).toBe(false);
  });
});
