//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotMergeGuard.test.ts
// PURPOSE: Merging or unmerging cells of a PivotTable is refused for EVERY
//          block of the selection (the structural guards beside it read only
//          the main range), and allowed outside every pivot.

import { describe, it, expect } from "vitest";
import type { Selection } from "@api/types";
import { pivotMergeGuard, PIVOT_MERGE_GUARDED_COMMANDS } from "../pivotMergeGuard";

const pivot = { startRow: 2, startCol: 2, endRow: 10, endCol: 5 };
const REFUSAL = "We can't make this change for the selected cells because it will affect a PivotTable.";

function sel(startRow: number, startCol: number, endRow: number, endCol: number, extra?: Selection["additionalRanges"]): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", additionalRanges: extra };
}

describe("pivotMergeGuard", () => {
  it("refuses a selection inside or partly over a pivot", () => {
    expect(pivotMergeGuard(sel(3, 3, 3, 4), [pivot], REFUSAL)).toBe(REFUSAL);
    expect(pivotMergeGuard(sel(0, 0, 2, 2), [pivot], REFUSAL)).toBe(REFUSAL);
  });

  it("refuses when only a Ctrl+click block touches the pivot", () => {
    expect(pivotMergeGuard(sel(20, 0, 20, 1, [{ startRow: 5, startCol: 5, endRow: 5, endCol: 6 }]), [pivot], REFUSAL)).toBe(
      REFUSAL,
    );
  });

  it("allows a selection outside every pivot (positive control)", () => {
    expect(pivotMergeGuard(sel(11, 0, 11, 5), [pivot], REFUSAL)).toBe(true);
    expect(pivotMergeGuard(sel(0, 0, 0, 1), [], REFUSAL)).toBe(true);
    expect(pivotMergeGuard(null, [pivot], REFUSAL)).toBe(true);
  });

  it("sits on all four Merge commands, unmerge included (a pivot writes its own label merges)", () => {
    expect([...PIVOT_MERGE_GUARDED_COMMANDS].sort()).toEqual(["mergeAcross", "mergeCells", "mergeCenter", "unmergeCells"]);
  });
});
