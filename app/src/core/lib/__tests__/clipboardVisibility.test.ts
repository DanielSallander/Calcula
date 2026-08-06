//! FILENAME: app/src/core/lib/__tests__/clipboardVisibility.test.ts
// PURPOSE: Pin Excel's hidden-row clipboard rule.
// CONTEXT: Copy and Cut deliberately disagree about filter-hidden rows, and
//          "hidden" is not one thing: hand hides and outline collapses are
//          copied, filter hides are not. Every case below is a data-integrity
//          case — a copy that drops rows but pastes into the original
//          rectangle, or a cut that captures fewer cells than it clears,
//          silently loses data.

import { describe, it, expect } from "vitest";
import {
  MAX_CLIPBOARD_CELLS,
  copyableSourceRows,
  captureClipboardCells,
  clipboardSourceRow,
  pasteRowDeltas,
} from "../clipboardVisibility";

/** Cell stand-in: value is "r,c" so a matrix can be read back positionally. */
interface TestCell {
  row: number;
  col: number;
  display: string;
}

function makeReader(missing: Set<string> = new Set(), throwAt: Set<string> = new Set()) {
  const reads: string[] = [];
  const readCell = async (row: number, col: number): Promise<TestCell | null> => {
    const key = `${row},${col}`;
    reads.push(key);
    if (throwAt.has(key)) throw new Error("read failed");
    if (missing.has(key)) return null;
    return { row, col, display: key };
  };
  return { readCell, reads };
}

describe("copyableSourceRows", () => {
  it("returns the whole span when nothing is filter-hidden", () => {
    expect(copyableSourceRows(2, 5, new Set(), false)).toEqual([2, 3, 4, 5]);
    expect(copyableSourceRows(2, 5, undefined, false)).toEqual([2, 3, 4, 5]);
  });

  it("COPY drops filter-hidden rows", () => {
    expect(copyableSourceRows(0, 5, new Set([1, 2, 4]), false)).toEqual([0, 3, 5]);
  });

  it("CUT keeps filter-hidden rows — Excel cuts everything between top and bottom", () => {
    expect(copyableSourceRows(0, 5, new Set([1, 2, 4]), true)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("a single-row selection on a filter-hidden row copies nothing", () => {
    expect(copyableSourceRows(3, 3, new Set([3]), false)).toEqual([]);
  });

  it("every row filtered away yields an empty capture list", () => {
    expect(copyableSourceRows(1, 3, new Set([1, 2, 3]), false)).toEqual([]);
  });
});

describe("captureClipboardCells — COPY over a filtered range", () => {
  it("yields visible rows only, collapsed, with the paste dimensions to match", async () => {
    const { readCell, reads } = makeReader();
    const capture = await captureClipboardCells<TestCell>({
      minRow: 0,
      maxRow: 4,
      minCol: 1,
      maxCol: 2,
      filterHiddenRows: new Set([1, 3]),
      includeFilterHidden: false,
      readCell,
    });

    // Shape: 3 visible rows x 2 columns — NOT the 5-row selection rectangle.
    expect(capture.cells.length).toBe(3);
    expect(capture.cells.every((r) => r.length === 2)).toBe(true);
    expect(capture.sourceRows).toEqual([0, 2, 4]);
    expect(capture.sourceMinCol).toBe(1);
    expect(capture.tooLarge).toBe(false);

    // The hidden rows are never even read.
    expect(reads).toEqual(["0,1", "0,2", "2,1", "2,2", "4,1", "4,2"]);

    // The visible rows slid together: matrix row 1 holds sheet row 2.
    expect(capture.cells[1][0]?.display).toBe("2,1");
  });

  it("CUT of the same range keeps the full rectangle", async () => {
    const { readCell } = makeReader();
    const capture = await captureClipboardCells<TestCell>({
      minRow: 0,
      maxRow: 4,
      minCol: 1,
      maxCol: 2,
      filterHiddenRows: new Set([1, 3]),
      includeFilterHidden: true,
      readCell,
    });

    expect(capture.cells.length).toBe(5);
    expect(capture.sourceRows).toEqual([0, 1, 2, 3, 4]);
    expect(capture.cells[1][0]?.display).toBe("1,1");
  });

  it("manual hides and outline collapses are NOT passed in, so they are copied", async () => {
    // The caller hands over the FILTER set only. A row that is hand-hidden or
    // outline-collapsed is simply absent from it and therefore captured.
    const { readCell } = makeReader();
    const capture = await captureClipboardCells<TestCell>({
      minRow: 0,
      maxRow: 2,
      minCol: 0,
      maxCol: 0,
      filterHiddenRows: new Set(),
      includeFilterHidden: false,
      readCell,
    });
    expect(capture.sourceRows).toEqual([0, 1, 2]);
  });

  it("columns are never skipped", async () => {
    const { readCell } = makeReader();
    const capture = await captureClipboardCells<TestCell>({
      minRow: 0,
      maxRow: 0,
      minCol: 0,
      maxCol: 3,
      filterHiddenRows: new Set([0]),
      includeFilterHidden: true,
      readCell,
    });
    expect(capture.cells[0].length).toBe(4);
  });

  it("an empty range (all rows filtered) captures nothing", async () => {
    const { readCell, reads } = makeReader();
    const capture = await captureClipboardCells<TestCell>({
      minRow: 0,
      maxRow: 2,
      minCol: 0,
      maxCol: 0,
      filterHiddenRows: new Set([0, 1, 2]),
      includeFilterHidden: false,
      readCell,
    });
    expect(capture.cells).toEqual([]);
    expect(capture.sourceRows).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("missing cells become null and a failing read is swallowed as null", async () => {
    const { readCell } = makeReader(new Set(["0,1"]), new Set(["1,0"]));
    const capture = await captureClipboardCells<TestCell>({
      minRow: 0,
      maxRow: 1,
      minCol: 0,
      maxCol: 1,
      includeFilterHidden: false,
      readCell,
    });
    expect(capture.cells[0][1]).toBeNull();
    expect(capture.cells[1][0]).toBeNull();
    expect(capture.cells[1][1]?.display).toBe("1,1");
  });

  it("refuses an oversized range without reading anything", async () => {
    const { readCell, reads } = makeReader();
    const capture = await captureClipboardCells<TestCell>({
      minRow: 0,
      maxRow: 3,
      minCol: 0,
      maxCol: 3,
      includeFilterHidden: false,
      readCell,
      maxCells: 8,
    });
    expect(capture.tooLarge).toBe(true);
    expect(capture.cells).toEqual([]);
    expect(capture.sourceRows).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("the cap counts the cells actually captured, not the selection rectangle", async () => {
    // Two of the four rows are filtered away, halving the read volume and
    // bringing the capture back under the cap.
    const { readCell } = makeReader();
    const capture = await captureClipboardCells<TestCell>({
      minRow: 0,
      maxRow: 3,
      minCol: 0,
      maxCol: 3,
      filterHiddenRows: new Set([1, 2]),
      includeFilterHidden: false,
      readCell,
      maxCells: 8,
    });
    expect(capture.tooLarge).toBe(false);
    expect(capture.sourceRows).toEqual([0, 3]);
  });

  it("the default cap is the shared MAX_CLIPBOARD_CELLS", () => {
    expect(MAX_CLIPBOARD_CELLS).toBe(5_000_000);
  });
});

describe("clipboardSourceRow", () => {
  it("maps through sourceRows when present", () => {
    expect(clipboardSourceRow([0, 2, 4], 0, 1)).toBe(2);
  });

  it("falls back to contiguity when there is no source-row map", () => {
    expect(clipboardSourceRow(undefined, 7, 3)).toBe(10);
    expect(clipboardSourceRow([0, 2], 7, 5)).toBe(12);
  });
});

describe("pasteRowDeltas", () => {
  it("is a single shared delta for an ordinary copy", () => {
    expect(pasteRowDeltas([10, 11, 12], 10, 20, 3)).toEqual([10, 10, 10]);
  });

  it("varies per row once filter-hidden rows collapsed the block", () => {
    // Sheet rows 0, 2, 4 pasted at rows 10, 11, 12.
    expect(pasteRowDeltas([0, 2, 4], 0, 10, 3)).toEqual([10, 9, 8]);
  });

  it("pasting a collapsed block back onto its own first row still shifts later rows", () => {
    // Row 0 stays put (delta 0) but rows 2 and 4 move up to 1 and 2.
    expect(pasteRowDeltas([0, 2, 4], 0, 0, 3)).toEqual([0, -1, -2]);
  });

  it("falls back to contiguous deltas without a source-row map", () => {
    expect(pasteRowDeltas(undefined, 5, 5, 3)).toEqual([0, 0, 0]);
    expect(pasteRowDeltas(undefined, 5, 8, 3)).toEqual([3, 3, 3]);
  });
});
