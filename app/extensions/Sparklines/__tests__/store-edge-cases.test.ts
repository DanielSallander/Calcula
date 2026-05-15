//! FILENAME: app/extensions/Sparklines/__tests__/store-edge-cases.test.ts
// PURPOSE: Edge-case and stress tests for the sparkline store.
// CONTEXT: Tests mass creation, overlapping ranges, corrupted imports, and rapid mutations.

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSparklineGroup,
  removeSparklineGroup,
  updateSparklineGroup,
  getSparklineForCell,
  hasSparkline,
  getAllGroups,
  getGroupById,
  exportGroups,
  importGroups,
  resetSparklineStore,
  invalidateDataCache,
  getCachedGroupData,
  setCachedGroupData,
  isDataCacheDirty,
  markDataCacheClean,
  setOnMutationCallback,
} from "../store";
import type { SparklineGroup } from "../types";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetSparklineStore();
  setOnMutationCallback(null);
});

// ============================================================================
// Mass Creation (100+ groups)
// ============================================================================

describe("mass creation", () => {
  it("creates 100 sparkline groups simultaneously without data loss", () => {
    for (let i = 0; i < 100; i++) {
      // Each group: location at (i, 10), data at (i, 0..4)
      const result = createSparklineGroup(
        { startRow: i, startCol: 10, endRow: i, endCol: 10 },
        { startRow: i, startCol: 0, endRow: i, endCol: 4 },
        "line",
      );
      expect(result.valid).toBe(true);
    }
    expect(getAllGroups()).toHaveLength(100);

    // Verify each cell is properly indexed
    for (let i = 0; i < 100; i++) {
      expect(hasSparkline(i, 10)).toBe(true);
      const entry = getSparklineForCell(i, 10)!;
      expect(entry.index).toBe(0);
      expect(entry.orientation).toBe("byRow");
    }
  });

  it("creates 150 groups and removes 50 without corruption", () => {
    const ids: number[] = [];
    for (let i = 0; i < 150; i++) {
      const result = createSparklineGroup(
        { startRow: i, startCol: 10, endRow: i, endCol: 10 },
        { startRow: i, startCol: 0, endRow: i, endCol: 4 },
        "column",
      );
      ids.push(result.group!.id);
    }
    expect(getAllGroups()).toHaveLength(150);

    // Remove every 3rd group
    for (let i = 0; i < 150; i += 3) {
      removeSparklineGroup(ids[i]);
    }
    expect(getAllGroups()).toHaveLength(100);

    // Remaining groups should still be indexed
    for (let i = 0; i < 150; i++) {
      if (i % 3 === 0) {
        expect(hasSparkline(i, 10)).toBe(false);
      } else {
        expect(hasSparkline(i, 10)).toBe(true);
      }
    }
  });

  it("handles 100 groups with unique IDs", () => {
    const ids = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const result = createSparklineGroup(
        { startRow: i, startCol: 10, endRow: i, endCol: 10 },
        { startRow: i, startCol: 0, endRow: i, endCol: 4 },
        "line",
      );
      ids.add(result.group!.id);
    }
    expect(ids.size).toBe(100);
  });

  it("mutation callback fires for each creation", () => {
    let callCount = 0;
    setOnMutationCallback(() => callCount++);

    for (let i = 0; i < 20; i++) {
      createSparklineGroup(
        { startRow: i, startCol: 10, endRow: i, endCol: 10 },
        { startRow: i, startCol: 0, endRow: i, endCol: 4 },
        "line",
      );
    }
    expect(callCount).toBe(20);
  });
});

// ============================================================================
// Overlapping Ranges
// ============================================================================

describe("overlapping ranges replacement", () => {
  it("new group replaces existing group at same single-cell location", () => {
    const r1 = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const r2 = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 9 },
      "column",
    );

    expect(getAllGroups()).toHaveLength(1);
    expect(getGroupById(r1.group!.id)).toBeUndefined();
    expect(getAllGroups()[0].type).toBe("column");
  });

  it("new group replaces multiple existing groups that it overlaps", () => {
    // Create 5 groups in a column, each at (i, 5)
    for (let i = 0; i < 5; i++) {
      createSparklineGroup(
        { startRow: i, startCol: 5, endRow: i, endCol: 5 },
        { startRow: i, startCol: 0, endRow: i, endCol: 4 },
        "line",
      );
    }
    expect(getAllGroups()).toHaveLength(5);

    // Create one large group that spans rows 1-3 at col 5
    const result = createSparklineGroup(
      { startRow: 1, startCol: 5, endRow: 3, endCol: 5 },
      { startRow: 1, startCol: 0, endRow: 3, endCol: 4 },
      "column",
    );
    expect(result.valid).toBe(true);
    // Rows 1-3 were replaced, rows 0 and 4 remain
    expect(getAllGroups()).toHaveLength(3);
  });

  it("partial overlap removes the entire overlapped group", () => {
    // Group spanning rows 0-4 at col 5
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 4, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 4, endCol: 4 },
      "line",
    );
    expect(getAllGroups()).toHaveLength(1);

    // New group at row 2, col 5 overlaps partially
    createSparklineGroup(
      { startRow: 2, startCol: 5, endRow: 2, endCol: 5 },
      { startRow: 2, startCol: 0, endRow: 2, endCol: 4 },
      "column",
    );
    // The original 5-cell group is entirely removed (not split)
    expect(getAllGroups()).toHaveLength(1);
    expect(getAllGroups()[0].type).toBe("column");
    // Rows 0,1,3,4 at col 5 should no longer have sparklines
    expect(hasSparkline(0, 5)).toBe(false);
    expect(hasSparkline(1, 5)).toBe(false);
    expect(hasSparkline(3, 5)).toBe(false);
    expect(hasSparkline(4, 5)).toBe(false);
  });

  it("adjacent but non-overlapping groups coexist", () => {
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
    expect(getAllGroups()).toHaveLength(2);
    expect(hasSparkline(0, 5)).toBe(true);
    expect(hasSparkline(1, 5)).toBe(true);
  });
});

// ============================================================================
// Import/Export with Corrupted Data
// ============================================================================

describe("import with corrupted data", () => {
  it("imports groups with missing optional fields gracefully", () => {
    const corrupted = [
      {
        id: 1,
        location: { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        dataRange: { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        type: "line",
        color: "#4472C4",
        negativeColor: "#D94735",
        // Missing showMarkers, lineWidth, etc.
      },
    ] as unknown as SparklineGroup[];

    importGroups(corrupted);
    expect(getAllGroups()).toHaveLength(1);
    // Cell index should be rebuilt even with partial data
    expect(hasSparkline(0, 5)).toBe(true);
  });

  it("handles import with empty array", () => {
    // First add something
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    expect(getAllGroups()).toHaveLength(1);

    importGroups([]);
    expect(getAllGroups()).toHaveLength(0);
    expect(hasSparkline(0, 5)).toBe(false);
  });

  it("handles import with duplicate IDs by keeping all", () => {
    const dupes: SparklineGroup[] = [
      {
        id: 1,
        location: { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        dataRange: { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
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
      },
      {
        id: 1, // same ID
        location: { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
        dataRange: { startRow: 1, startCol: 0, endRow: 1, endCol: 4 },
        type: "column",
        color: "#FF0000",
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
        markerColor: "#FF0000",
        showAxis: false,
        axisScaleType: "auto",
        axisMinValue: null,
        axisMaxValue: null,
        emptyCellHandling: "zero",
        plotOrder: "default",
      },
    ];

    importGroups(dupes);
    // Both are imported (store does not deduplicate on import)
    expect(getAllGroups()).toHaveLength(2);
  });

  it("nextGroupId advances past imported IDs", () => {
    const imported: SparklineGroup[] = [
      {
        id: 500,
        location: { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        dataRange: { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
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
      },
    ];

    importGroups(imported);

    // Create a new group - its ID should be > 500
    const result = createSparklineGroup(
      { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
      { startRow: 1, startCol: 0, endRow: 1, endCol: 4 },
      "line",
    );
    expect(result.group!.id).toBeGreaterThan(500);
  });

  it("export creates deep copies (mutations do not affect exported data)", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const exported = exportGroups();
    const originalColor = exported[0].color;

    // Mutate the store
    updateSparklineGroup(exported[0].id, { color: "#CHANGED" });

    // Exported copy should be unchanged
    expect(exported[0].color).toBe(originalColor);
  });
});

// ============================================================================
// Update Non-Existent Groups
// ============================================================================

describe("update non-existent groups", () => {
  it("updateSparklineGroup returns false for ID 0", () => {
    expect(updateSparklineGroup(0, { color: "#FF0000" })).toBe(false);
  });

  it("updateSparklineGroup returns false for negative ID", () => {
    expect(updateSparklineGroup(-1, { color: "#FF0000" })).toBe(false);
  });

  it("updateSparklineGroup returns false after group was deleted", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const id = result.group!.id;
    removeSparklineGroup(id);
    expect(updateSparklineGroup(id, { color: "#FF0000" })).toBe(false);
  });

  it("removeSparklineGroup returns false for non-existent ID", () => {
    expect(removeSparklineGroup(99999)).toBe(false);
  });

  it("getGroupById returns undefined for non-existent ID", () => {
    expect(getGroupById(99999)).toBeUndefined();
  });
});

// ============================================================================
// Rapid Create/Delete Cycles
// ============================================================================

describe("rapid create/delete cycles", () => {
  it("handles 200 create-then-delete cycles at the same location", () => {
    for (let i = 0; i < 200; i++) {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "line",
      );
      expect(result.valid).toBe(true);
      removeSparklineGroup(result.group!.id);
    }
    expect(getAllGroups()).toHaveLength(0);
    expect(hasSparkline(0, 5)).toBe(false);
  });

  it("handles alternating create at two locations", () => {
    for (let i = 0; i < 100; i++) {
      createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        i % 2 === 0 ? "line" : "column",
      );
    }
    // Each create at same location replaces the previous
    expect(getAllGroups()).toHaveLength(1);
    expect(getAllGroups()[0].type).toBe("column"); // last was odd index
  });

  it("bulk delete all groups leaves clean state", () => {
    for (let i = 0; i < 50; i++) {
      createSparklineGroup(
        { startRow: i, startCol: 10, endRow: i, endCol: 10 },
        { startRow: i, startCol: 0, endRow: i, endCol: 4 },
        "line",
      );
    }
    const allIds = getAllGroups().map((g) => g.id);
    for (const id of allIds) {
      removeSparklineGroup(id);
    }
    expect(getAllGroups()).toHaveLength(0);

    // New creation should work fine
    const result = createSparklineGroup(
      { startRow: 0, startCol: 10, endRow: 0, endCol: 10 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "winloss",
    );
    expect(result.valid).toBe(true);
    expect(hasSparkline(0, 10)).toBe(true);
  });

  it("data cache is invalidated on rapid mutations", () => {
    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    const id = result.group!.id;
    setCachedGroupData(id, [[1, 2, 3]]);
    markDataCacheClean();
    expect(isDataCacheDirty()).toBe(false);

    updateSparklineGroup(id, { color: "#FF0000" });
    expect(isDataCacheDirty()).toBe(true);
    expect(getCachedGroupData(id)).toBeNull(); // cache cleared per group
  });

  it("reset between create cycles produces correct IDs", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    resetSparklineStore();

    const result = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    // After reset, nextGroupId goes back to 1
    expect(result.group!.id).toBe(1);
  });
});
