//! FILENAME: app/extensions/Sparklines/__tests__/groupAreas.test.ts
// PURPOSE: BUG-0616#4 -- Excel keeps a sparkline group ONE group whatever a
//          structural edit does to its cells (column F inserted beside E2:E6
//          over A2:C6 leaves one group of ten, F2:F6 over B2:D6 among them;
//          live probe 2026-10-30). The backend's shift writes the parts such
//          an edit leaves into the group's `moreAreas`
//          (app/src-tauri/src/chart_range_shift.rs, GROUP IDENTITY), so the
//          store must draw, read, select, ungroup and replace EVERY area.

import { describe, it, expect, vi, beforeEach } from "vitest";

const typedRead = vi.fn();
vi.mock("@api/lib", () => ({
  getRangeCellsTyped: (...args: unknown[]) => typedRead(...args),
}));

import {
  createSparklineGroup,
  getAllGroups,
  getGroupsForRange,
  getSparklineForCell,
  importGroups,
  resetSparklineStore,
  ungroupSparkline,
  updateSparklineGroup,
} from "../store";
import { fetchGroupData } from "../rendering";
import type { SparklineGroup } from "../types";

/** The group the column-F insert leaves (what the backend writes back). */
function twoAreaGroup(): SparklineGroup {
  return {
    id: 7,
    type: "line",
    color: "#FF0000",
    location: { startRow: 1, startCol: 4, endRow: 5, endCol: 4 },
    dataRange: { startRow: 1, startCol: 0, endRow: 5, endCol: 2 },
    moreAreas: [
      {
        location: { startRow: 1, startCol: 5, endRow: 5, endCol: 5 },
        dataRange: { startRow: 1, startCol: 1, endRow: 5, endCol: 3 },
      },
    ],
  } as unknown as SparklineGroup;
}

beforeEach(() => {
  resetSparklineStore();
  typedRead.mockReset();
});

describe("a sparkline group of several areas (BUG-0616#4)", () => {
  it("every cell of every area is a sparkline of the ONE group, numbered across the areas", () => {
    importGroups([twoAreaGroup()]);
    const e2 = getSparklineForCell(1, 4);
    const f2 = getSparklineForCell(1, 5);
    const f6 = getSparklineForCell(5, 5);
    expect(e2?.group.id).toBe(7);
    expect(f2?.group.id).toBe(7);
    expect(e2?.index).toBe(0);
    expect(f2?.index).toBe(5);
    expect(f6?.index).toBe(9);
    expect(f2?.count).toBe(10);
    // The second area's cells are found by a range lookup too (fill, Design tab).
    expect(getGroupsForRange(3, 5, 3, 5).map((g) => g.id)).toEqual([7]);
  });

  it("reads each area's data in turn, in the order the cells are numbered", async () => {
    typedRead.mockImplementation(async (r0: number, c0: number, r1: number, c1: number) => {
      const cells = [];
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) cells.push({ row: r, col: c, type: "number", value: r * 10 + c });
      }
      return cells;
    });
    const slices = await fetchGroupData(twoAreaGroup(), "byRow");
    expect(slices).toHaveLength(10);
    expect(slices[0]).toEqual([10, 11, 12]); // E2 over A2:C2
    expect(slices[5]).toEqual([11, 12, 13]); // F2 over B2:D2
    expect(slices[9]).toEqual([51, 52, 53]); // F6 over B6:D6
  });

  it("ungroup cuts every area into its own sparklines", () => {
    importGroups([twoAreaGroup()]);
    expect(ungroupSparkline(7)).toBe(10);
    const groups = getAllGroups();
    expect(groups).toHaveLength(10);
    expect(groups.every((g) => g.moreAreas === undefined)).toBe(true);
    const f3 = groups.find((g) => g.location.startRow === 2 && g.location.startCol === 5)!;
    expect(f3.dataRange).toEqual({ startRow: 2, startCol: 1, endRow: 2, endCol: 3 });
  });

  it("a new group over a cell of the SECOND area replaces the group", () => {
    importGroups([twoAreaGroup()]);
    createSparklineGroup(
      { startRow: 3, startCol: 5, endRow: 3, endCol: 5 },
      { startRow: 3, startCol: 0, endRow: 3, endCol: 2 },
      "column",
    );
    expect(getAllGroups().map((g) => g.id)).not.toContain(7);
  });

  it("Edit Data replaces every area with the one entered, as Excel's Edit Group Location & Data", () => {
    importGroups([twoAreaGroup()]);
    updateSparklineGroup(7, {
      location: { startRow: 1, startCol: 4, endRow: 5, endCol: 4 },
      dataRange: { startRow: 1, startCol: 0, endRow: 5, endCol: 1 },
    });
    expect(getAllGroups()[0].moreAreas).toBeUndefined();
    expect(getSparklineForCell(1, 5)).toBeUndefined();
  });
});
