//! FILENAME: app/extensions/Sparklines/__tests__/sparkline-lifecycle.test.ts
// PURPOSE: Detect memory leaks in sparkline store lifecycle patterns.
// CONTEXT: Verifies create/delete cycles, import/reset, and cell index cleanup.

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSparklineGroup,
  removeSparklineGroup,
  getAllGroups,
  getSparklineForCell,
  hasSparkline,
  importGroups,
  resetSparklineStore,
  invalidateDataCache,
  getCachedGroupData,
  setCachedGroupData,
  isDataCacheDirty,
  exportGroups,
} from "../store";
import type { CellRange, SparklineGroup } from "../types";

// ============================================================================
// Helpers
// ============================================================================

function makeRange(startRow: number, startCol: number, endRow: number, endCol: number): CellRange {
  return { startRow, startCol, endRow, endCol };
}

// ============================================================================
// Create/Delete Lifecycle
// ============================================================================

describe("Sparkline create/delete lifecycle", () => {
  beforeEach(() => {
    resetSparklineStore();
  });

  it("create then delete 1000 groups leaves store empty", () => {
    const groupIds: number[] = [];

    for (let i = 0; i < 1000; i++) {
      // Each sparkline at a unique row to avoid overlap removal
      const result = createSparklineGroup(
        makeRange(i, 0, i, 0),       // location: single cell
        makeRange(i, 1, i, 10),      // data: 10 columns
        "line",
      );
      expect(result.valid).toBe(true);
      groupIds.push(result.group!.id);
    }

    expect(getAllGroups().length).toBe(1000);

    for (const id of groupIds) {
      removeSparklineGroup(id);
    }

    expect(getAllGroups().length).toBe(0);
  });

  it("cell index is empty after deleting all groups", () => {
    for (let i = 0; i < 100; i++) {
      createSparklineGroup(
        makeRange(i, 0, i, 0),
        makeRange(i, 1, i, 5),
        "bar",
      );
    }

    // Verify cells are indexed
    expect(hasSparkline(0, 0)).toBe(true);
    expect(hasSparkline(50, 0)).toBe(true);

    // Delete all groups
    const groups = getAllGroups();
    for (const g of groups) {
      removeSparklineGroup(g.id);
    }

    // Verify cell index is clean
    for (let i = 0; i < 100; i++) {
      expect(hasSparkline(i, 0)).toBe(false);
    }
  });

  it("data cache is cleared after deleting groups", () => {
    const result = createSparklineGroup(
      makeRange(0, 0, 0, 0),
      makeRange(0, 1, 0, 5),
      "line",
    );
    const groupId = result.group!.id;

    setCachedGroupData(groupId, [[1, 2, 3, 4, 5]]);
    expect(getCachedGroupData(groupId)).not.toBeNull();

    removeSparklineGroup(groupId);
    expect(getCachedGroupData(groupId)).toBeNull();
  });

  it("removing non-existent group returns false and does not corrupt state", () => {
    createSparklineGroup(
      makeRange(0, 0, 0, 0),
      makeRange(0, 1, 0, 5),
      "line",
    );

    expect(removeSparklineGroup(99999)).toBe(false);
    expect(getAllGroups().length).toBe(1);
  });
});

// ============================================================================
// Import/Reset Lifecycle
// ============================================================================

describe("Sparkline import/reset lifecycle", () => {
  beforeEach(() => {
    resetSparklineStore();
  });

  it("import large dataset then reset clears all internal maps", () => {
    // Create a large import dataset
    const imported: SparklineGroup[] = [];
    for (let i = 0; i < 500; i++) {
      imported.push({
        id: i + 1,
        location: makeRange(i, 0, i, 0),
        dataRange: makeRange(i, 1, i, 10),
        type: "line",
        color: "#4472C4",
        negativeColor: "#D94735",
        showMarkers: false,
        lineWidth: 1.5,
        showHighPoint: false,
        showLowPoint: false,
        showFirstPoint: false,
        showLastPoint: false,
        showNegativePoints: false,
        highPointColor: "#D94735",
        lowPointColor: "#D94735",
        firstPointColor: "#43A047",
        lastPointColor: "#43A047",
        negativePointColor: "#D94735",
        markerColor: "#4472C4",
        showAxis: false,
        axisScaleType: "auto",
        axisMinValue: null,
        axisMaxValue: null,
        emptyCellHandling: "zero",
        plotOrder: "default",
      });
    }

    importGroups(imported);
    expect(getAllGroups().length).toBe(500);
    expect(hasSparkline(0, 0)).toBe(true);
    expect(hasSparkline(499, 0)).toBe(true);

    // Populate data cache
    for (const g of imported) {
      setCachedGroupData(g.id, [[1, 2, 3]]);
    }

    resetSparklineStore();

    expect(getAllGroups().length).toBe(0);
    expect(hasSparkline(0, 0)).toBe(false);
    expect(hasSparkline(499, 0)).toBe(false);
    expect(getCachedGroupData(1)).toBeNull();
    expect(getCachedGroupData(500)).toBeNull();
    expect(isDataCacheDirty()).toBe(true);
  });

  it("import replaces all existing groups cleanly", () => {
    // Create initial data
    createSparklineGroup(
      makeRange(0, 0, 0, 0),
      makeRange(0, 1, 0, 5),
      "line",
    );
    setCachedGroupData(1, [[1, 2, 3]]);

    expect(getAllGroups().length).toBe(1);
    expect(hasSparkline(0, 0)).toBe(true);

    // Import empty set
    importGroups([]);

    expect(getAllGroups().length).toBe(0);
    expect(hasSparkline(0, 0)).toBe(false);
    expect(getCachedGroupData(1)).toBeNull();
  });
});

// ============================================================================
// Cell Index Integrity
// ============================================================================

describe("Cell index does not retain deleted group references", () => {
  beforeEach(() => {
    resetSparklineStore();
  });

  it("overlapping create clears old cell index entries", () => {
    // Create group at row 0
    createSparklineGroup(
      makeRange(0, 0, 0, 0),
      makeRange(0, 1, 0, 5),
      "line",
    );

    const entry1 = getSparklineForCell(0, 0);
    expect(entry1).toBeDefined();
    const oldGroupId = entry1!.group.id;

    // Create overlapping group at same location
    createSparklineGroup(
      makeRange(0, 0, 0, 0),
      makeRange(0, 1, 0, 3),
      "bar",
    );

    const entry2 = getSparklineForCell(0, 0);
    expect(entry2).toBeDefined();
    expect(entry2!.group.id).not.toBe(oldGroupId);
    expect(entry2!.group.type).toBe("bar");

    // Only one group should exist
    expect(getAllGroups().length).toBe(1);
  });

  it("rapid create/delete cycle does not leak cell entries", () => {
    for (let cycle = 0; cycle < 100; cycle++) {
      const result = createSparklineGroup(
        makeRange(0, 0, 0, 0),
        makeRange(0, 1, 0, 5),
        "line",
      );
      removeSparklineGroup(result.group!.id);
    }

    expect(hasSparkline(0, 0)).toBe(false);
    expect(getAllGroups().length).toBe(0);
  });

  it("invalidateDataCache clears all cached data", () => {
    for (let i = 0; i < 50; i++) {
      const result = createSparklineGroup(
        makeRange(i, 0, i, 0),
        makeRange(i, 1, i, 5),
        "line",
      );
      setCachedGroupData(result.group!.id, [[1, 2, 3]]);
    }

    invalidateDataCache();

    const groups = getAllGroups();
    for (const g of groups) {
      expect(getCachedGroupData(g.id)).toBeNull();
    }
    expect(isDataCacheDirty()).toBe(true);
  });
});
