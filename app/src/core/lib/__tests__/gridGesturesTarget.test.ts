//! FILENAME: app/src/core/lib/__tests__/gridGesturesTarget.test.ts
// PURPOSE: The grid commands' gestures on a floating grid's cells (P3 S10,
//          owner finding G3): Clear, Insert / Delete Sheet Rows / Columns,
//          Fill and AutoFit each name the OBJECT target on every write and
//          never touch the active sheet at the object's coordinates.
// CONTEXT: The grid-command door (`gridCommands.execute`) resolves the target
//          once and the Spreadsheet's handlers hand it to these gestures as
//          `host.target`. The backend wrappers and the cell-target seam are
//          doubles; every positive control runs the SHEET form unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  beginUndoTransaction: vi.fn(),
  cancelUndoTransaction: vi.fn(),
  commitUndoTransaction: vi.fn(),
  clearCommentsInRange: vi.fn(),
  clearHyperlinksInRange: vi.fn(),
  clearNotesInRange: vi.fn(),
  clearRange: vi.fn(),
  clearRangeWithOptions: vi.fn(),
  getHyperlinksInRange: vi.fn(),
  insertRows: vi.fn(),
  insertColumns: vi.fn(),
  deleteRows: vi.fn(),
  deleteColumns: vi.fn(),
  fillRange: vi.fn(),
  getAllStyles: vi.fn(),
  getCellsInCols: vi.fn(),
  getCellsInRows: vi.fn(),
  setColumnWidth: vi.fn(),
  setRowHeight: vi.fn(),
  setColumnWidths: vi.fn(),
  setRowHeights: vi.fn(),
  setRowsHidden: vi.fn(),
  setColsHidden: vi.fn(),
}));
const seam = vi.hoisted(() => ({
  announceCellTargetObjectChanged: vi.fn(),
  getCellTargetCells: vi.fn(),
  getCellTargetLines: vi.fn(),
}));
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(), confirmAsync: vi.fn() }));
const emit = vi.hoisted(() => vi.fn());
const emitBatch = vi.hoisted(() => vi.fn());
const hidden = vi.hoisted(() => ({ applyRowsHidden: vi.fn(), applyColsHidden: vi.fn() }));

vi.mock("../tauri-api", () => api);
vi.mock("../../../api/cellTarget", () => seam);
vi.mock("../dialogs", () => dialogs);
vi.mock("../cellEvents", () => ({ cellEvents: { emit, emitBatch }, cellToChange: (c: unknown) => c }));
vi.mock("../hiddenRowsCols", () => hidden);
// The renderer's measuring needs a canvas; the gesture's choices are under test.
const measure = vi.hoisted(() => ({
  measureOptimalColumnWidth: vi.fn((_col: number, cells: unknown[]) => (cells.length > 0 ? 120 : null)),
  measureOptimalRowHeight: vi.fn((cells: unknown[]) => (cells.length > 0 ? 30 : null)),
}));
vi.mock("../gridRenderer/layout/autoFit", () => measure);

import type { CellTargetRef, Selection } from "../../types";
import { runClearGesture } from "../clearGestures";
import { runRowColumnGesture } from "../sheetRowsColumns";
import { runFillCommand } from "../fillCommands";
import { runAutoFitColumnWidth, runAutoFitRowHeight, type AutoFitCommandHost } from "../autoFitCommands";

const REF: CellTargetRef = { kind: "floatingRange", id: "fr-1" };

function sel(startRow: number, startCol: number, endRow: number, endCol: number, extra: Partial<Selection> = {}): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", ...extra };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of Object.values(seam)) fn.mockReset();
  dialogs.alertAsync.mockReset().mockReturnValue(Promise.resolve());
  emit.mockReset();
  emitBatch.mockReset();
  hidden.applyRowsHidden.mockReset().mockResolvedValue(true);
  hidden.applyColsHidden.mockReset().mockResolvedValue(true);
  api.beginUndoTransaction.mockResolvedValue(3);
  api.commitUndoTransaction.mockResolvedValue(undefined);
  api.cancelUndoTransaction.mockResolvedValue(undefined);
  api.clearRangeWithOptions.mockResolvedValue(undefined);
  api.clearRange.mockResolvedValue(0);
  api.insertRows.mockResolvedValue([]);
  api.insertColumns.mockResolvedValue([]);
  api.deleteRows.mockResolvedValue([]);
  api.deleteColumns.mockResolvedValue([]);
  api.fillRange.mockResolvedValue([]);
  api.getAllStyles.mockResolvedValue([]);
  api.setColumnWidths.mockResolvedValue(undefined);
  api.setRowHeights.mockResolvedValue(undefined);
  api.setRowsHidden.mockResolvedValue([]);
  api.setColsHidden.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

describe("Clear on a floating grid's cells", () => {
  it("Clear Contents / Formats / All: one clearRangeWithOptions per block, with the target", async () => {
    const refresh = vi.fn();
    const two = sel(0, 0, 1, 1, { additionalRanges: [{ startRow: 4, startCol: 2, endRow: 4, endCol: 3 }] });
    await runClearGesture("clearContents", { selection: two, target: REF, refresh });
    await runClearGesture("clearFormatting", { selection: sel(2, 2, 2, 2), target: REF, refresh });
    await runClearGesture("clearAll", { selection: sel(3, 3, 3, 3), target: REF, refresh });
    expect(api.clearRangeWithOptions.mock.calls).toEqual([
      [0, 0, 1, 1, "contents", undefined, { target: REF }],
      [4, 2, 4, 3, "contents", undefined, { target: REF }],
      [2, 2, 2, 2, "formats", undefined, { target: REF }],
      [3, 3, 3, 3, "all", undefined, { target: REF }],
    ]);
    // Two blocks are ONE undo step.
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    // Nothing of the ACTIVE sheet: no plain clearRange, no comment / note / link clear, no cell event.
    expect(api.clearRange).not.toHaveBeenCalled();
    expect(api.clearCommentsInRange).not.toHaveBeenCalled();
    expect(api.clearNotesInRange).not.toHaveBeenCalled();
    expect(api.clearHyperlinksInRange).not.toHaveBeenCalled();
    expect(emit, "a cell event aliased the host's cell").not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("Clear Comments / Hyperlinks / Remove Hyperlinks change nothing on a floating grid (no such content there)", async () => {
    const refresh = vi.fn();
    for (const kind of ["clearComments", "clearHyperlinks", "removeHyperlinks"] as const) {
      await runClearGesture(kind, { selection: sel(0, 0, 1, 1), target: REF, refresh });
    }
    expect(api.getHyperlinksInRange, "read the HOST's links at the grid's coordinates").not.toHaveBeenCalled();
    expect(api.clearCommentsInRange).not.toHaveBeenCalled();
    expect(api.clearHyperlinksInRange).not.toHaveBeenCalled();
    expect(api.clearRangeWithOptions).not.toHaveBeenCalled();
  });

  it("positive control: the SHEET's Clear Contents is the plain clearRange, as before", async () => {
    await runClearGesture("clearContents", { selection: sel(0, 0, 1, 1), refresh: vi.fn() });
    expect(api.clearRange).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(api.clearRangeWithOptions).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Insert / Delete Sheet Rows / Columns (table semantics on the grid)
// ---------------------------------------------------------------------------

describe("Insert / Delete rows and columns on a floating grid's cells", () => {
  it("each wrapper call names the target; the sheet's push-off refusal does not apply", async () => {
    const afterChange = vi.fn();
    const host = (selection: Selection) => ({ selection, target: REF, totalRows: 4, totalCols: 3, afterChange });
    // A selection as tall as the grid's extent: the SHEET rule would refuse it.
    await runRowColumnGesture("insertRow", host(sel(0, 0, 3, 0)));
    await runRowColumnGesture("insertColumn", host(sel(0, 1, 0, 1)));
    await runRowColumnGesture("deleteRow", host(sel(2, 0, 2, 0)));
    await runRowColumnGesture("deleteColumn", host(sel(0, 0, 0, 1)));
    expect(api.insertRows).toHaveBeenCalledWith(0, 4, undefined, { target: REF });
    expect(api.insertColumns).toHaveBeenCalledWith(1, 1, undefined, { target: REF });
    expect(api.deleteRows).toHaveBeenCalledWith(2, 1, undefined, { target: REF });
    expect(api.deleteColumns).toHaveBeenCalledWith(0, 2, undefined, { target: REF });
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
    expect(afterChange).toHaveBeenCalledTimes(4);
  });

  it("positive control: the SHEET call is spelled as it always was", async () => {
    await runRowColumnGesture("insertRow", { selection: sel(2, 0, 2, 0), totalRows: 100, totalCols: 10, afterChange: vi.fn() });
    expect(api.insertRows).toHaveBeenCalledWith(2, 1);
  });
});

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

describe("Fill on a floating grid's cells", () => {
  it("fills with the target, the grid's extent is its edge, and no active-sheet cell event is emitted", async () => {
    api.fillRange.mockResolvedValue([{ row: 2, col: 1, display: "x", formula: null, styleIndex: 0 }]);
    await runFillCommand("down", { selection: sel(1, 1, 3, 1), totalRows: 4, totalCols: 3, target: REF });
    expect(api.fillRange).toHaveBeenCalledWith(1, 1, 1, 1, 2, 1, 3, 1, { target: REF });
    expect(emitBatch).not.toHaveBeenCalled();
    // Fill Up on the grid's LAST row has no source: nothing runs.
    api.fillRange.mockClear();
    await runFillCommand("up", { selection: sel(3, 0, 3, 0), totalRows: 4, totalCols: 3, target: REF });
    expect(api.fillRange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AutoFit
// ---------------------------------------------------------------------------

function autoFitHost(selection: Selection, withTarget: boolean): AutoFitCommandHost {
  return {
    selection,
    config: {
      totalRows: 1048576,
      totalCols: 16384,
      defaultCellWidth: 64,
      defaultCellHeight: 20,
      minColumnWidth: 8,
      minRowHeight: 8,
    },
    dimensions: undefined,
    dispatch: vi.fn(),
    onColumnResized: vi.fn(),
    onRowResized: vi.fn(),
    redraw: vi.fn(),
    ...(withTarget ? { target: { ref: REF, bounds: { rows: 5, cols: 3 } } } : {}),
  };
}

describe("AutoFit on a floating grid's cells", () => {
  beforeEach(() => {
    seam.getCellTargetLines.mockResolvedValue({ rowHeights: { 1: 40 }, colWidths: {}, hiddenRows: [2], hiddenCols: [] });
    seam.getCellTargetCells.mockResolvedValue({
      cells: [{ row: 0, col: 1, display: "a long piece of text", formula: null, styleIndex: 0, valueKind: "text" }],
      merges: [],
      conditional: [],
      styles: [],
      rules: [],
    });
  });

  it("Column Width measures the grid's styled read and writes the OBJECT's width with the target", async () => {
    const host = autoFitHost(sel(0, 1, 0, 1), true);
    await runAutoFitColumnWidth(host);
    expect(seam.getCellTargetCells).toHaveBeenCalledWith(REF, { startRow: 0, startCol: 1, endRow: 0, endCol: 1 });
    expect(api.getCellsInRows, "measured the ACTIVE sheet's cells").not.toHaveBeenCalled();
    expect(api.getCellsInCols).not.toHaveBeenCalled();
    expect(api.setColumnWidths).toHaveBeenCalledTimes(1);
    const [runs, width, opts] = api.setColumnWidths.mock.calls[0];
    expect(runs).toEqual([[1, 1]]);
    expect(width).toBeGreaterThan(8);
    expect(opts).toEqual({ target: REF });
    expect(api.setColumnWidth, "wrote the SHEET's column width").not.toHaveBeenCalled();
    expect(host.dispatch, "moved Core's mirror of the host's sizes").not.toHaveBeenCalled();
    expect(seam.announceCellTargetObjectChanged).toHaveBeenCalledWith(REF);
    // The extension contributions describe the ACTIVE sheet's columns: not asked.
    expect(measure.measureOptimalColumnWidth.mock.calls[0][5]).toBe(false);
  });

  it("Row Height fits the WHOLE row of the grid, unhides the grid's own hidden row, and resets an empty row", async () => {
    const host = autoFitHost(sel(0, 0, 2, 0), true);
    await runAutoFitRowHeight(host);
    // The whole row of the GRID (its extent's columns), never the sheet's.
    expect(seam.getCellTargetCells).toHaveBeenCalledWith(REF, { startRow: 0, startCol: 0, endRow: 2, endCol: 2 });
    expect(api.setRowsHidden).toHaveBeenCalledWith([2], false, { target: REF });
    expect(hidden.applyRowsHidden, "unhid the HOST's rows").not.toHaveBeenCalled();
    // Row 1 had its own height (40) and nothing in it: back to the standard height.
    expect(api.setRowHeights).toHaveBeenCalledWith([[1, 1]], 20, { target: REF });
    for (const call of api.setRowHeights.mock.calls) expect(call[2]).toEqual({ target: REF });
    expect(api.setRowHeight).not.toHaveBeenCalled();
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
  });

  it("growOnly never unhides or shrinks on the grid", async () => {
    const host = autoFitHost(sel(0, 0, 2, 0), true);
    await runAutoFitRowHeight(host, { growOnly: true });
    expect(api.setRowsHidden).not.toHaveBeenCalled();
    expect(api.setRowHeights.mock.calls.every((c) => c[1] >= 20)).toBe(true);
  });

  it("positive control: the SHEET fit reads the sheet's cells and writes the sheet's widths", async () => {
    api.getCellsInRows.mockResolvedValue([{ row: 0, col: 1, display: "a long piece of text", formula: null, styleIndex: 0 }]);
    await runAutoFitColumnWidth(autoFitHost(sel(0, 1, 0, 1), false));
    expect(seam.getCellTargetCells).not.toHaveBeenCalled();
    expect(api.setColumnWidth).toHaveBeenCalledTimes(1);
    expect(api.setColumnWidths).not.toHaveBeenCalled();
  });
});
