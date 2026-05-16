//! FILENAME: app/extensions/Sparklines/__tests__/store-idempotent.test.ts
// PURPOSE: Tests for idempotency and reversibility of the sparkline store.
// CONTEXT: Verifies that repeated operations, double-imports, and redundant
//          deletes produce stable, predictable results.

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSparklineGroup,
  removeSparklineGroup,
  getAllGroups,
  getSparklineForCell,
  hasSparkline,
  updateSparklineGroup,
  resetSparklineStore,
  importGroups,
  exportGroups,
  invalidateDataCache,
  isDataCacheDirty,
  markDataCacheClean,
  getCachedGroupData,
  setCachedGroupData,
  getGroupById,
} from "../store";
import type { CellRange, SparklineGroup } from "../types";

// ============================================================================
// Helpers
// ============================================================================

const loc: CellRange = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
const data3: CellRange = { startRow: 0, startCol: 1, endRow: 0, endCol: 3 };

function createDefaultGroup() {
  return createSparklineGroup(loc, data3, "line");
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetSparklineStore();
});

// ============================================================================
// Update with same values = no change
// ============================================================================

describe("sparkline store - update idempotency", () => {
  it("updating a group with same color produces same state", () => {
    const result = createDefaultGroup();
    const group = result.group!;
    const before = { ...getGroupById(group.id)! };

    updateSparklineGroup(group.id, { color: before.color });
    const after = { ...getGroupById(group.id)! };

    expect(after.color).toBe(before.color);
    expect(after.type).toBe(before.type);
  });

  it("updating with same type is a no-op", () => {
    const result = createDefaultGroup();
    const group = result.group!;
    updateSparklineGroup(group.id, { type: "line" });
    expect(getGroupById(group.id)!.type).toBe("line");
  });

  it("updating with empty object does not change any fields", () => {
    const result = createDefaultGroup();
    const group = result.group!;
    const before = exportGroups().find((g) => g.id === group.id)!;
    updateSparklineGroup(group.id, {});
    const after = exportGroups().find((g) => g.id === group.id)!;
    expect(after.color).toBe(before.color);
    expect(after.type).toBe(before.type);
    expect(after.lineWidth).toBe(before.lineWidth);
  });

  it("double update with same values produces identical state", () => {
    const result = createDefaultGroup();
    const group = result.group!;
    updateSparklineGroup(group.id, { color: "#FF0000", lineWidth: 3 });
    const after1 = { ...getGroupById(group.id)! };
    updateSparklineGroup(group.id, { color: "#FF0000", lineWidth: 3 });
    const after2 = { ...getGroupById(group.id)! };
    expect(after1.color).toBe(after2.color);
    expect(after1.lineWidth).toBe(after2.lineWidth);
  });
});

// ============================================================================
// Delete already-deleted = no error
// ============================================================================

describe("sparkline store - delete idempotency", () => {
  it("deleting a non-existent group returns false", () => {
    const result = removeSparklineGroup(9999);
    expect(result).toBe(false);
  });

  it("double delete returns false on second call", () => {
    const result = createDefaultGroup();
    const group = result.group!;
    const first = removeSparklineGroup(group.id);
    const second = removeSparklineGroup(group.id);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("delete on empty store does not throw", () => {
    expect(() => removeSparklineGroup(1)).not.toThrow();
  });

  it("after double delete, getAllGroups is empty", () => {
    const result = createDefaultGroup();
    const group = result.group!;
    removeSparklineGroup(group.id);
    removeSparklineGroup(group.id);
    expect(getAllGroups()).toEqual([]);
  });

  it("hasSparkline returns false after deletion", () => {
    const result = createDefaultGroup();
    const group = result.group!;
    expect(hasSparkline(0, 0)).toBe(true);
    removeSparklineGroup(group.id);
    expect(hasSparkline(0, 0)).toBe(false);
  });
});

// ============================================================================
// Double-import = last wins
// ============================================================================

describe("sparkline store - import idempotency", () => {
  it("double import replaces all groups with second import", () => {
    const groups1: SparklineGroup[] = [
      {
        id: 1, location: loc, dataRange: data3, type: "line",
        color: "#111", negativeColor: "#D94735", showMarkers: false,
        lineWidth: 1.5, showHighPoint: false, showLowPoint: false,
        showFirstPoint: false, showLastPoint: false, showNegativePoints: false,
        highPointColor: "#D94735", lowPointColor: "#D94735",
        firstPointColor: "#43A047", lastPointColor: "#43A047",
        negativePointColor: "#D94735", markerColor: "#111",
        showAxis: false, axisScaleType: "auto",
        axisMinValue: null, axisMaxValue: null,
        emptyCellHandling: "zero", plotOrder: "default",
      },
    ];
    const groups2: SparklineGroup[] = [
      {
        ...groups1[0], id: 2, color: "#222",
      },
    ];

    importGroups(groups1);
    expect(getAllGroups()).toHaveLength(1);
    expect(getAllGroups()[0].color).toBe("#111");

    importGroups(groups2);
    expect(getAllGroups()).toHaveLength(1);
    expect(getAllGroups()[0].color).toBe("#222");
    expect(getAllGroups()[0].id).toBe(2);
  });

  it("import then import same data produces same state", () => {
    const result = createDefaultGroup();
    const exported = exportGroups();

    importGroups(exported);
    const first = exportGroups();
    importGroups(exported);
    const second = exportGroups();

    expect(first.length).toBe(second.length);
    expect(first[0].id).toBe(second[0].id);
    expect(first[0].color).toBe(second[0].color);
  });

  it("import empty array clears all groups", () => {
    createDefaultGroup();
    expect(getAllGroups().length).toBeGreaterThan(0);
    importGroups([]);
    expect(getAllGroups()).toEqual([]);
  });
});

// ============================================================================
// Reset then reset = clean state
// ============================================================================

describe("sparkline store - reset idempotency", () => {
  it("double reset produces same empty state", () => {
    createDefaultGroup();
    resetSparklineStore();
    const after1 = getAllGroups();
    resetSparklineStore();
    const after2 = getAllGroups();
    expect(after1).toEqual(after2);
    expect(after2).toEqual([]);
  });

  it("triple reset does not throw", () => {
    expect(() => {
      resetSparklineStore();
      resetSparklineStore();
      resetSparklineStore();
    }).not.toThrow();
  });

  it("reset clears cell index", () => {
    createDefaultGroup();
    expect(hasSparkline(0, 0)).toBe(true);
    resetSparklineStore();
    expect(hasSparkline(0, 0)).toBe(false);
  });

  it("reset clears data cache", () => {
    const result = createDefaultGroup();
    const group = result.group!;
    setCachedGroupData(group.id, [[1, 2, 3]]);
    expect(getCachedGroupData(group.id)).not.toBeNull();
    resetSparklineStore();
    expect(getCachedGroupData(group.id)).toBeNull();
  });

  it("reset then create works with fresh IDs", () => {
    createDefaultGroup();
    resetSparklineStore();
    const result = createDefaultGroup();
    expect(result.group).toBeDefined();
    expect(result.group!.id).toBe(1); // IDs restart from 1
  });

  it("cache dirty flag is true after reset", () => {
    markDataCacheClean();
    expect(isDataCacheDirty()).toBe(false);
    resetSparklineStore();
    expect(isDataCacheDirty()).toBe(true);
  });

  it("invalidateDataCache is idempotent", () => {
    markDataCacheClean();
    invalidateDataCache();
    expect(isDataCacheDirty()).toBe(true);
    invalidateDataCache();
    expect(isDataCacheDirty()).toBe(true);
  });
});
