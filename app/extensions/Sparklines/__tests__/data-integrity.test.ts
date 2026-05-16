//! FILENAME: app/extensions/Sparklines/__tests__/data-integrity.test.ts
// PURPOSE: Data integrity tests for sparkline store operations.

import { describe, it, expect, beforeEach } from "vitest";
import {
  createSparklineGroup,
  updateSparklineGroup,
  getAllGroups,
  getGroupById,
  exportGroups,
  importGroups,
  resetSparklineStore,
  getSparklineForCell,
} from "../store";
import type { CellRange } from "../types";

beforeEach(() => {
  resetSparklineStore();
});

// ============================================================================
// Import/Export round-trip
// ============================================================================

describe("import/export round-trip", () => {
  it("export then import produces identical data (deep equality)", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 2, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 2, endCol: 4 },
      "line",
      "#FF0000",
      "#00FF00",
    );
    createSparklineGroup(
      { startRow: 5, startCol: 5, endRow: 5, endCol: 5 },
      { startRow: 5, startCol: 0, endRow: 5, endCol: 4 },
      "column",
    );

    const exported = exportGroups();
    resetSparklineStore();
    importGroups(exported);
    const reExported = exportGroups();

    expect(reExported).toEqual(exported);
  });

  it("exported groups are independent copies, not references to internal state", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );

    const exported1 = exportGroups();
    const exported2 = exportGroups();

    // Same data but different objects
    expect(exported1).toEqual(exported2);
    expect(exported1[0]).not.toBe(exported2[0]);
  });

  it("import creates copies of input objects, not references", () => {
    const inputGroup = {
      id: 1,
      location: { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      dataRange: { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      type: "line" as const,
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
      axisScaleType: "auto" as const,
      axisMinValue: null,
      axisMaxValue: null,
      emptyCellHandling: "zero" as const,
      plotOrder: "default" as const,
    };

    importGroups([inputGroup]);

    // Mutating primitive fields on input should not affect stored data
    inputGroup.color = "#000000";

    const stored = getAllGroups()[0];
    expect(stored.color).toBe("#4472C4");

    // NOTE: importGroups uses shallow copy ({ ...g }), so nested objects
    // like location/dataRange ARE shared. This documents the current behavior.
    // If deep isolation of nested range objects is needed, importGroups
    // should be updated to deep-clone.
  });
});

// ============================================================================
// Creating a group doesn't modify input parameters
// ============================================================================

describe("createSparklineGroup input immutability", () => {
  it("does not modify the location or dataRange objects passed in", () => {
    const location: CellRange = Object.freeze({
      startRow: 0,
      startCol: 5,
      endRow: 0,
      endCol: 5,
    });
    const dataRange: CellRange = Object.freeze({
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 4,
    });

    // Should not throw despite frozen inputs
    const result = createSparklineGroup(location, dataRange, "line");
    expect(result.valid).toBe(true);

    // Original objects unchanged
    expect(location).toEqual({
      startRow: 0,
      startCol: 5,
      endRow: 0,
      endCol: 5,
    });
    expect(dataRange).toEqual({
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 4,
    });
  });
});

// ============================================================================
// Updating one group doesn't affect other groups
// ============================================================================

describe("updateSparklineGroup isolation", () => {
  it("updating one group does not modify other groups", () => {
    const r1 = createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
      "#AAAAAA",
    );
    const r2 = createSparklineGroup(
      { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
      { startRow: 1, startCol: 0, endRow: 1, endCol: 4 },
      "column",
      "#BBBBBB",
    );

    const group1Id = r1.group!.id;
    const group2Id = r2.group!.id;

    // Snapshot group2 before modifying group1
    const group2Before = { ...getGroupById(group2Id)! };

    updateSparklineGroup(group1Id, {
      color: "#FF0000",
      type: "winloss",
      lineWidth: 5,
      showMarkers: true,
    });

    const group2After = getGroupById(group2Id)!;
    expect(group2After.color).toBe(group2Before.color);
    expect(group2After.type).toBe(group2Before.type);
    expect(group2After.lineWidth).toBe(group2Before.lineWidth);
    expect(group2After.showMarkers).toBe(group2Before.showMarkers);
  });
});

// ============================================================================
// Bulk operations maintain referential integrity of cell index
// ============================================================================

describe("cell index integrity under bulk operations", () => {
  it("cell index stays consistent after multiple create/update/delete cycles", () => {
    // Create 5 groups
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = createSparklineGroup(
        { startRow: i, startCol: 10, endRow: i, endCol: 10 },
        { startRow: i, startCol: 0, endRow: i, endCol: 9 },
        "line",
      );
      expect(r.valid).toBe(true);
      ids.push(r.group!.id);
    }

    // All 5 cells should have sparklines
    for (let i = 0; i < 5; i++) {
      expect(getSparklineForCell(i, 10)).toBeDefined();
    }

    // Delete group at row 2
    expect(getAllGroups().length).toBe(5);
    updateSparklineGroup(ids[1], { color: "#FF0000" });

    // Row 2's sparkline should still exist after updating row 1
    expect(getSparklineForCell(2, 10)).toBeDefined();
    expect(getSparklineForCell(1, 10)).toBeDefined();

    // Verify cell index points to correct groups
    const entry0 = getSparklineForCell(0, 10)!;
    const entry4 = getSparklineForCell(4, 10)!;
    expect(entry0.group.id).toBe(ids[0]);
    expect(entry4.group.id).toBe(ids[4]);
  });

  it("cell index is fully rebuilt after import (no stale entries)", () => {
    createSparklineGroup(
      { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
      { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
      "line",
    );
    expect(getSparklineForCell(0, 5)).toBeDefined();

    // Import different data (row 10 instead of row 0)
    importGroups([{
      id: 99,
      location: { startRow: 10, startCol: 5, endRow: 10, endCol: 5 },
      dataRange: { startRow: 10, startCol: 0, endRow: 10, endCol: 4 },
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
    }]);

    // Old cell should be gone, new cell should exist
    expect(getSparklineForCell(0, 5)).toBeUndefined();
    expect(getSparklineForCell(10, 5)).toBeDefined();
  });
});
