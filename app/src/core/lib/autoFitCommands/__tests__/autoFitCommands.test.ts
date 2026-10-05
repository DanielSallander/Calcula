//! FILENAME: app/src/core/lib/autoFitCommands/__tests__/autoFitCommands.test.ts
// PURPOSE: Excel's AutoFit Column Width / AutoFit Row Height as COMMANDS over
//          the selection (the Home tab's Format menu, object scripts), with the
//          `{ growOnly }` option the Orientation menu uses after rotating text.
// CONTEXT: (Home tab = Excel's Home tab, 2026-10-04.) AutoFit existed only as
//          the header double-click, which fits the clicked column / row (or the
//          selected WHOLE columns / rows) and measures every cell in it. Live
//          Excel (build 20326, 2026-10-04) differs for the ribbon commands:
//          - AutoFit Column Width on a cell RANGE fits ONLY the selected cells,
//            and may SHRINK the column (a column fitted to a 40-character value
//            went to 0.96 with only its 'x' cell selected); whole columns fit
//            everything; a column with nothing selected in it keeps its width;
//            each column is fitted on its own.
//          - AutoFit Row Height fits the WHOLE row whatever is selected (C5
//            selected kept the height B5's 24 pt text needs, and a wrapped cell
//            elsewhere in the row grew it); an empty row goes back to the
//            standard height.
//          - Hidden rows / columns inside the selection are UNHIDDEN and fitted.
//          - One Undo restores a multi-column fit.
//          The measuring itself is the renderer's (gridRenderer/layout/autoFit),
//          doubled here so these tests pin what is measured and what is written.

import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  getCellsInCols: vi.fn(),
  getCellsInRows: vi.fn(),
  getAllStyles: vi.fn(),
  setColumnWidth: vi.fn(),
  setRowHeight: vi.fn(),
  beginUndoTransaction: vi.fn(),
  commitUndoTransaction: vi.fn(),
  cancelUndoTransaction: vi.fn(),
}));
const hidden = vi.hoisted(() => ({ applyRowsHidden: vi.fn(), applyColsHidden: vi.fn() }));
const measure = vi.hoisted(() => ({ measureOptimalColumnWidth: vi.fn(), measureOptimalRowHeight: vi.fn() }));
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(), confirmAsync: vi.fn() }));

vi.mock("../../tauri-api", () => api);
vi.mock("../../hiddenRowsCols", () => hidden);
vi.mock("../../gridRenderer/layout/autoFit", () => measure);
vi.mock("../../dialogs", () => dialogs);
vi.mock("../../../theme/skinLoader", () => ({
  getActiveGridTheme: () => ({ cellFontFamily: "Calibri", cellFontSize: 11 }),
}));

import type { CellData, DimensionOverrides, Selection } from "../../../types";
import { createEmptyDimensionOverrides } from "../../../types";
import { setColumnWidth, setRowHeight } from "../../../state/gridActions";
import { runAutoFitColumnWidth, runAutoFitRowHeight, type AutoFitCommandHost } from "../autoFitCommands";

const ROWS = 1048576;
const COLS = 16384;
const DEFAULT_W = 100;
const DEFAULT_H = 24;

// ---------------------------------------------------------------------------
// Harness: a sparse sheet, and a measurer that is easy to reason about
// ---------------------------------------------------------------------------

/** The sheet's cells: `[row, col, display]`. */
let sheet: Array<[number, number, string]> = [];

function cell(row: number, col: number, display: string): CellData {
  return { row, col, display, styleIndex: 0 } as unknown as CellData;
}

function sel(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  type: Selection["type"] = "cells",
  extra?: Selection["additionalRanges"],
): Selection {
  return { startRow, startCol, endRow, endCol, type, additionalRanges: extra };
}

let dims: DimensionOverrides;
const dispatch = vi.fn();
const onColumnResized = vi.fn();
const onRowResized = vi.fn();
const redraw = vi.fn();

function host(selection: Selection | null): AutoFitCommandHost {
  return {
    selection,
    config: {
      totalRows: ROWS,
      totalCols: COLS,
      defaultCellWidth: DEFAULT_W,
      defaultCellHeight: DEFAULT_H,
      minColumnWidth: 10,
      minRowHeight: 5,
    },
    dimensions: dims,
    dispatch,
    onColumnResized,
    onRowResized,
    redraw,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  hidden.applyRowsHidden.mockReset();
  hidden.applyColsHidden.mockReset();
  measure.measureOptimalColumnWidth.mockReset();
  measure.measureOptimalRowHeight.mockReset();
  dialogs.alertAsync.mockReset();
  dispatch.mockReset();
  onColumnResized.mockReset();
  onRowResized.mockReset();
  redraw.mockReset();
  sheet = [];
  dims = createEmptyDimensionOverrides();

  api.getCellsInCols.mockImplementation(async (c0: number, c1: number) =>
    sheet.filter(([, c]) => c >= c0 && c <= c1).map(([r, c, d]) => cell(r, c, d)),
  );
  api.getCellsInRows.mockImplementation(async (r0: number, r1: number) =>
    sheet.filter(([r]) => r >= r0 && r <= r1).map(([r, c, d]) => cell(r, c, d)),
  );
  api.getAllStyles.mockResolvedValue([]);
  api.setColumnWidth.mockResolvedValue(undefined);
  api.setRowHeight.mockResolvedValue(undefined);
  api.beginUndoTransaction.mockResolvedValue(77);
  api.commitUndoTransaction.mockResolvedValue(undefined);
  api.cancelUndoTransaction.mockResolvedValue(undefined);
  hidden.applyRowsHidden.mockResolvedValue(true);
  hidden.applyColsHidden.mockResolvedValue(true);
  dialogs.alertAsync.mockReturnValue(Promise.resolve());

  // Column: 10px per character of the widest measured cell; nothing -> null.
  measure.measureOptimalColumnWidth.mockImplementation((_col: number, cells: CellData[]) =>
    cells.length === 0 ? null : Math.max(...cells.map((c) => c.display.length * 10)),
  );
  // Row: 24px, or 48px when any cell in it says "BIG"; nothing -> null.
  measure.measureOptimalRowHeight.mockImplementation((cells: CellData[]) =>
    cells.length === 0 ? null : cells.some((c) => c.display === "BIG") ? 48 : 24,
  );
});

/** The `[col, width]` pairs written to the backend. */
const widthsWritten = () => api.setColumnWidth.mock.calls.map((c) => [c[0], c[1]]);
const heightsWritten = () => api.setRowHeight.mock.calls.map((c) => [c[0], c[1]]);

// ---------------------------------------------------------------------------
// AutoFit Column Width
// ---------------------------------------------------------------------------

describe("AutoFit Column Width", () => {
  it("on a cell range fits ONLY the selected cells -- and may shrink the column (Excel)", async () => {
    sheet = [
      [0, 0, "short"],
      [1, 0, "a much much longer value"],
    ];
    dims.columnWidths.set(0, 300);
    await runAutoFitColumnWidth(host(sel(0, 0, 0, 0)));
    expect(widthsWritten()).toEqual([[0, 50]]);
    expect(dispatch).toHaveBeenCalledWith(setColumnWidth(0, 50));
    expect(onColumnResized).toHaveBeenCalledWith(0, 50);
  });

  it("on WHOLE columns fits every cell in them", async () => {
    sheet = [
      [0, 0, "short"],
      [9000, 0, "a much much longer value"],
    ];
    await runAutoFitColumnWidth(host(sel(0, 0, ROWS - 1, 0, "columns")));
    expect(widthsWritten()).toEqual([[0, 240]]);
  });

  it("fits each column of the range on its own (E1:F1)", async () => {
    sheet = [
      [0, 4, "e-short"],
      [0, 5, "f-a-good-deal-longer"],
      [5, 5, "a cell outside the selection, ignored"],
    ];
    await runAutoFitColumnWidth(host(sel(0, 4, 0, 5)));
    expect(widthsWritten()).toEqual([
      [4, 70],
      [5, 200],
    ]);
  });

  it("a column with nothing selected in it keeps its width, and nothing is written or stepped", async () => {
    sheet = [[50, 2, "far below the selection"]];
    dims.columnWidths.set(2, 300);
    await runAutoFitColumnWidth(host(sel(4, 2, 6, 2)));
    expect(widthsWritten()).toEqual([]);
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("a width already right is not rewritten", async () => {
    sheet = [[0, 0, "abcde"]];
    dims.columnWidths.set(0, 50);
    await runAutoFitColumnWidth(host(sel(0, 0, 0, 0)));
    expect(widthsWritten()).toEqual([]);
  });

  it("several columns are ONE undo step, committed with its own ticket", async () => {
    sheet = [
      [0, 9, "jjjjjjjjjjjjjj"],
      [0, 10, "kkkkkkkkkkkkkkkkkkk"],
    ];
    await runAutoFitColumnWidth(host(sel(0, 9, 0, 10)));
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.beginUndoTransaction.mock.calls[0][0]).toBe("AutoFit Column Width");
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(77);
    expect(api.cancelUndoTransaction).not.toHaveBeenCalled();
  });

  it("inside a script's open batch it joins and closes nothing", async () => {
    sheet = [[0, 0, "abc"]];
    api.beginUndoTransaction.mockResolvedValue(null);
    await runAutoFitColumnWidth(host(sel(0, 0, 0, 0)));
    expect(widthsWritten()).toEqual([[0, 30]]);
    expect(api.commitUndoTransaction).not.toHaveBeenCalled();
  });

  it("every Ctrl+click block counts; a column two blocks share is measured over both", async () => {
    sheet = [
      [0, 1, "abc"],
      [5, 1, "abcdefgh"],
      [9, 1, "not selected at all, ignored"],
    ];
    await runAutoFitColumnWidth(host(sel(5, 1, 5, 1, "cells", [{ startRow: 0, startCol: 1, endRow: 0, endCol: 1 }])));
    expect(widthsWritten()).toEqual([[1, 80]]);
  });

  it("a WIDE short range reads its rows, not every column of the sheet", async () => {
    sheet = [[1, 300, "abc"]];
    await runAutoFitColumnWidth(host(sel(0, 0, 2, COLS - 1)));
    expect(api.getCellsInRows).toHaveBeenCalledWith(0, 2);
    expect(api.getCellsInCols).not.toHaveBeenCalled();
    expect(widthsWritten()).toEqual([[300, 30]]);
  });

  it("a hidden column inside the selection is unhidden and fitted (Excel)", async () => {
    sheet = [[0, 1, "bbbbbbbbbbbb"]];
    dims.manuallyHiddenCols = new Set([1]);
    await runAutoFitColumnWidth(host(sel(0, 0, 0, 2)));
    expect(hidden.applyColsHidden).toHaveBeenCalledWith([1], false, dispatch);
    expect(widthsWritten()).toEqual([[1, 120]]);
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(77);
  });

  it("a backend refusal is SHOWN; with nothing landed the step is cancelled", async () => {
    sheet = [[0, 0, "abc"]];
    api.setColumnWidth.mockRejectedValue("The sheet is protected.");
    await runAutoFitColumnWidth(host(sel(0, 0, 0, 0)));
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The sheet is protected.");
    expect(api.cancelUndoTransaction).toHaveBeenCalledWith(77);
    // The reducer is written only AFTER the backend accepted, so it never
    // shows a width the document does not have.
    expect(dispatch).not.toHaveBeenCalled();
  });

  describe("{ growOnly: true }", () => {
    it("grows a column that is too narrow for the selected content", async () => {
      sheet = [[0, 0, "abcdefgh"]];
      dims.columnWidths.set(0, 40);
      await runAutoFitColumnWidth(host(sel(0, 0, 0, 0)), { growOnly: true });
      expect(widthsWritten()).toEqual([[0, 80]]);
    });

    it("never shrinks: a column wider than its content keeps its width", async () => {
      sheet = [[0, 0, "ab"]];
      dims.columnWidths.set(0, 300);
      await runAutoFitColumnWidth(host(sel(0, 0, 0, 0)), { growOnly: true });
      expect(widthsWritten()).toEqual([]);
      expect(api.beginUndoTransaction).not.toHaveBeenCalled();
    });

    it("never unhides", async () => {
      sheet = [[0, 1, "bbbbbbbbbbbbbbbbbbbbbbbb"]];
      dims.manuallyHiddenCols = new Set([1]);
      await runAutoFitColumnWidth(host(sel(0, 0, 0, 2)), { growOnly: true });
      expect(hidden.applyColsHidden).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// AutoFit Row Height
// ---------------------------------------------------------------------------

describe("AutoFit Row Height", () => {
  it("fits the WHOLE row, whatever is selected in it (Excel: C5 selected, B5 is 24 pt)", async () => {
    sheet = [
      [4, 1, "BIG"],
      [4, 2, "small"],
    ];
    await runAutoFitRowHeight(host(sel(4, 2, 4, 2)));
    expect(measure.measureOptimalRowHeight.mock.calls[0][0].map((c: CellData) => c.col)).toEqual([1, 2]);
    expect(heightsWritten()).toEqual([[4, 48]]);
    expect(dispatch).toHaveBeenCalledWith(setRowHeight(4, 48));
    expect(onRowResized).toHaveBeenCalledWith(4, 48);
  });

  it("may shrink a row set too tall for its content", async () => {
    sheet = [[4, 2, "small"]];
    dims.rowHeights.set(4, 60);
    await runAutoFitRowHeight(host(sel(4, 2, 4, 2)));
    expect(heightsWritten()).toEqual([[4, 24]]);
  });

  it("an EMPTY row with a height of its own goes back to the standard height", async () => {
    dims.rowHeights.set(7, 45);
    await runAutoFitRowHeight(host(sel(7, 3, 7, 3)));
    expect(heightsWritten()).toEqual([[7, DEFAULT_H]]);
  });

  it("an empty row already at the standard height: nothing written, no step", async () => {
    await runAutoFitRowHeight(host(sel(7, 3, 9, 3)));
    expect(heightsWritten()).toEqual([]);
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("every row the selection spans, as ONE undo step", async () => {
    sheet = [
      [1, 0, "BIG"],
      [3, 5, "BIG"],
    ];
    await runAutoFitRowHeight(host(sel(1, 0, 3, 0)));
    expect(heightsWritten()).toEqual([
      [1, 48],
      [3, 48],
    ]);
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.beginUndoTransaction.mock.calls[0][0]).toBe("AutoFit Row Height");
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(77);
  });

  it("a whole-column selection reaches only rows that have content or a height of their own", async () => {
    sheet = [[500000, 0, "BIG"]];
    dims.rowHeights.set(12, 40);
    await runAutoFitRowHeight(host(sel(0, 0, ROWS - 1, 0, "columns")));
    expect(heightsWritten()).toEqual([
      [12, DEFAULT_H],
      [500000, 48],
    ]);
    expect(measure.measureOptimalRowHeight.mock.calls.length).toBe(2);
  });

  it("a hidden row inside the selection is unhidden and fitted (Excel)", async () => {
    sheet = [[1, 0, "BIG"]];
    dims.manuallyHiddenRows = new Set([1]);
    await runAutoFitRowHeight(host(sel(0, 0, 2, 0)));
    expect(hidden.applyRowsHidden).toHaveBeenCalledWith([1], false, dispatch);
    expect(heightsWritten()).toEqual([[1, 48]]);
  });

  it("a refused unhide stops the gesture (hiddenRowsCols already told the user)", async () => {
    sheet = [[1, 0, "BIG"]];
    dims.manuallyHiddenRows = new Set([1]);
    hidden.applyRowsHidden.mockResolvedValue(false);
    await runAutoFitRowHeight(host(sel(0, 0, 2, 0)));
    expect(heightsWritten()).toEqual([]);
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
    expect(api.cancelUndoTransaction).toHaveBeenCalledWith(77);
  });

  it("a refusal after a row landed: committed (Ctrl+Z takes it back) and shown", async () => {
    sheet = [
      [1, 0, "BIG"],
      [2, 0, "BIG"],
    ];
    api.setRowHeight.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Protected."));
    await runAutoFitRowHeight(host(sel(1, 0, 2, 0)));
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(77);
    expect(api.cancelUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Protected.");
  });

  describe("{ growOnly: true } (the Orientation menu, after rotating text)", () => {
    it("grows a row too short for its content", async () => {
      sheet = [[4, 1, "BIG"]];
      await runAutoFitRowHeight(host(sel(4, 1, 4, 1)), { growOnly: true });
      expect(heightsWritten()).toEqual([[4, 48]]);
    });

    it("never shrinks a height the user chose", async () => {
      sheet = [[4, 1, "small"]];
      dims.rowHeights.set(4, 60);
      await runAutoFitRowHeight(host(sel(4, 1, 4, 1)), { growOnly: true });
      expect(heightsWritten()).toEqual([]);
    });

    it("never resets an empty row, and never unhides", async () => {
      dims.rowHeights.set(7, 45);
      dims.manuallyHiddenRows = new Set([8]);
      await runAutoFitRowHeight(host(sel(7, 0, 8, 0)), { growOnly: true });
      expect(heightsWritten()).toEqual([]);
      expect(hidden.applyRowsHidden).not.toHaveBeenCalled();
    });
  });
});

it("no selection: nothing is read or written", async () => {
  await runAutoFitColumnWidth(host(null));
  await runAutoFitRowHeight(host(null));
  expect(api.getAllStyles).not.toHaveBeenCalled();
  expect(widthsWritten()).toEqual([]);
  expect(heightsWritten()).toEqual([]);
});
