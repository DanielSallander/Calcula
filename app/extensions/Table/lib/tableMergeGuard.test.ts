//! FILENAME: app/extensions/Table/lib/tableMergeGuard.test.ts
// PURPOSE: Excel refuses every Merge command when the selection touches a
//          table -- even half of one -- and allows them entirely outside it.

import { describe, it, expect } from "vitest";
import type { Selection } from "@api/types";
import { tableMergeGuard, TABLE_MERGE_REFUSAL, TABLE_MERGE_GUARDED_COMMANDS } from "./tableMergeGuard";

const table = { startRow: 1, startCol: 1, endRow: 5, endCol: 3 };

function sel(startRow: number, startCol: number, endRow: number, endCol: number, extra?: Selection["additionalRanges"]): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", additionalRanges: extra };
}

describe("tableMergeGuard", () => {
  it("refuses a selection that overlaps a table only partly", () => {
    expect(tableMergeGuard(sel(1, 0, 1, 1), [table])).toBe(TABLE_MERGE_REFUSAL);
  });

  it("refuses when only a Ctrl+click block touches the table", () => {
    expect(tableMergeGuard(sel(20, 0, 20, 2, [{ startRow: 3, startCol: 3, endRow: 3, endCol: 4 }]), [table])).toBe(
      TABLE_MERGE_REFUSAL,
    );
  });

  it("allows a selection entirely outside every table (positive control)", () => {
    expect(tableMergeGuard(sel(6, 0, 6, 4), [table])).toBe(true);
    expect(tableMergeGuard(sel(0, 0, 0, 4), [])).toBe(true);
    expect(tableMergeGuard(null, [table])).toBe(true);
  });

  it("sits on all four Merge commands", () => {
    expect([...TABLE_MERGE_GUARDED_COMMANDS].sort()).toEqual(["mergeAcross", "mergeCells", "mergeCenter", "unmergeCells"]);
  });
});
