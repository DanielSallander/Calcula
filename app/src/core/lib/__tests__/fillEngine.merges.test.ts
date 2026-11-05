//! FILENAME: app/src/core/lib/__tests__/fillEngine.merges.test.ts
// PURPOSE: NEW-fill-merge-replace -- a fill over merged cells that are not the
//          source's own merge pattern is refused BEFORE it writes, with
//          Excel's message, and the merges a fill replicates never grow a
//          destination merge into a union.
//
// [LIVE, Excel 16, 2026-11-05, tablec/probe2.ps1 + probe3.ps1] with A1:B1
// merged, `Range("A1:B1").AutoFill Range("A1:B3")` is refused "To do this,
// all the merged cells need to be the same size." when the destination holds
// B2:C2 (a partial overlap), A2:C2 (wider), A2:A3 (vertical), A3:C3, or even
// A2:B2 / A3:B3 alone (the pattern's shape on one row of two); a plain A1
// filled over a merged A2:B2 is refused too; a destination with no merged
// cell fills and replicates the merge.

import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  shiftFormulasBatch: vi.fn(),
  getMergedRegions: vi.fn(),
  mergeCells: vi.fn(),
}));
vi.mock("../tauri-api", () => api);

import { FILL_MERGE_SHAPES_MESSAGE, fillMergeRefusal, replicateMergeRegions } from "../fillEngine";

const box = (startRow: number, startCol: number, endRow: number, endCol: number) => ({ startRow, startCol, endRow, endCol });

beforeEach(() => {
  vi.clearAllMocks();
  api.mergeCells.mockResolvedValue({ success: true });
});

describe("fillMergeRefusal", () => {
  const source = box(0, 0, 0, 1); // A1:B1
  const down3 = box(0, 0, 2, 1); // A1:B3

  it.each([
    ["a partial overlap B2:C2", [box(1, 1, 1, 2)]],
    ["a wider merge A2:C2", [box(1, 0, 1, 2)]],
    ["a vertical merge A2:A3", [box(1, 0, 2, 0)]],
    ["the pattern's shape on one row only (A2:B2)", [box(1, 0, 1, 1)]],
    ["the pattern's shape on the other row only (A3:B3)", [box(2, 0, 2, 1)]],
  ])("refuses %s", (_label, inTheWay) => {
    expect(fillMergeRefusal([source, ...inTheWay], source, down3, "down")).toBe(FILL_MERGE_SHAPES_MESSAGE);
  });

  it("refuses a plain source filled over a merged destination", () => {
    expect(fillMergeRefusal([box(1, 0, 1, 1)], box(0, 0, 0, 0), box(0, 0, 2, 0), "down")).toBe(FILL_MERGE_SHAPES_MESSAGE);
  });

  it("lets a destination with no merged cell fill (positive control)", () => {
    expect(fillMergeRefusal([source, box(5, 5, 5, 6)], source, down3, "down")).toBeNull();
    expect(fillMergeRefusal([], box(0, 0, 0, 0), box(0, 0, 2, 0), "down")).toBeNull();
  });

  it("lets a destination already holding exactly the replicated pattern fill", () => {
    expect(fillMergeRefusal([source, box(1, 0, 1, 1), box(2, 0, 2, 1)], source, down3, "down")).toBeNull();
  });

  it("judges the other directions on their own destination", () => {
    // Fill RIGHT from A1:A2 merged into B1:B2 holding a different merge.
    const vertical = box(0, 0, 1, 0);
    expect(fillMergeRefusal([vertical, box(0, 1, 0, 2)], vertical, box(0, 0, 1, 1), "right")).toBe(FILL_MERGE_SHAPES_MESSAGE);
    expect(fillMergeRefusal([vertical], vertical, box(0, 0, 1, 1), "right")).toBeNull();
  });
});

describe("replicateMergeRegions", () => {
  it("merges only the replicated pattern, never over a merge already in place", async () => {
    const source = box(0, 0, 0, 1);
    api.getMergedRegions.mockResolvedValue([source, box(1, 0, 1, 1)]);
    await replicateMergeRegions(source, box(0, 0, 2, 1), "down");
    expect(api.mergeCells.mock.calls).toEqual([[2, 0, 2, 1]]);
  });
});
