//! FILENAME: app/src/api/__tests__/rangeApplyFormatting.test.ts
// PURPOSE: What the public @api `CellRange.applyFormatting` sends the backend.
// CONTEXT: BUG-0354 follow-up (round-2 review revA#5). `applyFormatting(rows,
//          cols, ...)` formats every listed row CROSSED with every listed
//          column, and the wrapper pushed one row and one column per CELL, so a
//          300 x 10 range sent two 3,000-entry lists full of duplicates: the
//          backend walked 9,000,000 positions and, with the 4,000,000-cell
//          bound, refused every range over 2,000 cells. The range's distinct
//          rows and columns, once each, in order, are the right lists.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib", () => ({
  getCell: vi.fn(),
  updateCellsBatch: vi.fn(),
  applyFormatting: vi.fn(),
  applyBorderPreset: vi.fn(),
  getActiveSheet: vi.fn(),
  getRangeEdge: vi.fn(),
  getWatchCells: vi.fn(),
  updateCellOnSheets: vi.fn(),
}));
vi.mock("../grid", () => ({
  navigateToCell: vi.fn(),
  navigateToRange: vi.fn(),
  borderAround: vi.fn(),
}));

import { applyFormatting } from "../lib";
import { CellRange } from "../range";

const EMPTY_RESULT = { cells: [], styles: [] };

beforeEach(() => {
  vi.mocked(applyFormatting).mockReset();
  vi.mocked(applyFormatting).mockResolvedValue(EMPTY_RESULT as never);
});

describe("CellRange.applyFormatting sends the range's rows and columns once each", () => {
  it("a 300 x 10 range is 300 rows and 10 columns, not 3,000 of each", async () => {
    await new CellRange(0, 0, 299, 9).applyFormatting({ bold: true });
    expect(applyFormatting).toHaveBeenCalledTimes(1);
    const [rows, cols, formatting] = vi.mocked(applyFormatting).mock.calls[0];
    expect(rows).toHaveLength(300);
    expect(cols).toHaveLength(10);
    expect(rows).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(cols).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(formatting).toEqual({ bold: true });
  });

  it("an offset range B3:D4 is rows [2, 3] and columns [1, 2, 3]", async () => {
    await CellRange.fromAddress("B3:D4").applyFormatting({ italic: true });
    const [rows, cols] = vi.mocked(applyFormatting).mock.calls[0];
    expect(rows).toEqual([2, 3]);
    expect(cols).toEqual([1, 2, 3]);
  });

  it("one cell is one row and one column", async () => {
    await CellRange.fromCell(7, 4).applyFormatting({ bold: false });
    const [rows, cols] = vi.mocked(applyFormatting).mock.calls[0];
    expect(rows).toEqual([7]);
    expect(cols).toEqual([4]);
  });
});
