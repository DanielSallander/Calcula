//! FILENAME: app/src/core/lib/sheetRowsColumns/__tests__/rowColumnGestures.test.ts
// PURPOSE: Excel's Insert / Delete Sheet Rows / Columns as gestures over ANY
//          selection, against doubles of the backend: the span each call gets,
//          the order several blocks are applied in, ONE undo step for several
//          blocks, the overlap refusal, and every backend refusal shown.
// CONTEXT: The grid commands behind these (core.grid.insertRow ...) returned
//          early unless whole rows / columns were selected, so the Home tab's
//          buttons were dead on a cell selection -- and they are script-safe,
//          so a script's DELETE_ROW over a cell selection silently did nothing.
//
// The dialog double takes the TAURI shape (alertAsync resolves a Promise).

import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  insertRows: vi.fn(),
  insertColumns: vi.fn(),
  deleteRows: vi.fn(),
  deleteColumns: vi.fn(),
  beginUndoTransaction: vi.fn(),
  commitUndoTransaction: vi.fn(),
  cancelUndoTransaction: vi.fn(),
  beginUndoSavepoint: vi.fn(),
  rollBackToUndoSavepoint: vi.fn(),
}));
const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(), confirmAsync: vi.fn() }));
const moved = vi.hoisted(() => ({ announceRolledBackRestore: vi.fn() }));

vi.mock("../../tauri-api", () => api);
vi.mock("../../dialogs", () => dialogs);
vi.mock("../../cellsMoved", () => moved);

import type { Selection } from "../../../types";
import {
  runRowColumnGesture,
  OVERLAPPING_SELECTIONS,
  shiftOffSheetRefusal,
  type RowColumnGestureHost,
} from "../rowColumnGestures";

const TOTAL_ROWS = 1048576;
const TOTAL_COLS = 16384;

function sel(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  extra?: Selection["additionalRanges"],
  type: Selection["type"] = "cells",
): Selection {
  return { startRow, startCol, endRow, endCol, type, additionalRanges: extra };
}

const afterChange = vi.fn();

function host(selection: Selection | null): RowColumnGestureHost {
  return { selection, totalRows: TOTAL_ROWS, totalCols: TOTAL_COLS, afterChange };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  dialogs.alertAsync.mockReset();
  afterChange.mockReset();
  api.insertRows.mockResolvedValue([]);
  api.insertColumns.mockResolvedValue([]);
  api.deleteRows.mockResolvedValue([]);
  api.deleteColumns.mockResolvedValue([]);
  api.beginUndoTransaction.mockResolvedValue(41);
  api.commitUndoTransaction.mockResolvedValue(undefined);
  api.cancelUndoTransaction.mockResolvedValue(undefined);
  api.beginUndoSavepoint.mockResolvedValue({ ticket: null, savepoint: { transaction: 41, changes: 0 } });
  api.rollBackToUndoSavepoint.mockResolvedValue({ success: true, updatedCells: [] });
  moved.announceRolledBackRestore.mockReset();
  dialogs.alertAsync.mockReturnValue(Promise.resolve());
  afterChange.mockResolvedValue(undefined);
});

describe("one block: the rows / columns it spans, whatever its shape", () => {
  it("Insert Sheet Rows on a CELL range inserts the rows it spans (was: did nothing)", async () => {
    await runRowColumnGesture("insertRow", host(sel(2, 1, 3, 2)));
    expect(api.insertRows.mock.calls).toEqual([[2, 2]]);
    expect(afterChange).toHaveBeenCalledWith("insertRow", [{ start: 2, count: 2 }]);
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  it("Insert Sheet Columns on one cell inserts one column", async () => {
    await runRowColumnGesture("insertColumn", host(sel(4, 3, 4, 3)));
    expect(api.insertColumns.mock.calls).toEqual([[3, 1]]);
  });

  it("Delete Sheet Rows / Columns on a cell range delete what it spans", async () => {
    await runRowColumnGesture("deleteRow", host(sel(5, 0, 7, 9)));
    await runRowColumnGesture("deleteColumn", host(sel(5, 2, 7, 4)));
    expect(api.deleteRows.mock.calls).toEqual([[5, 3]]);
    expect(api.deleteColumns.mock.calls).toEqual([[2, 3]]);
  });

  it("whole rows (the right-click menu's selection) still work exactly as before", async () => {
    await runRowColumnGesture("insertRow", host(sel(1, 0, 3, TOTAL_COLS - 1, undefined, "rows")));
    expect(api.insertRows.mock.calls).toEqual([[1, 3]]);
  });

  it("one block needs no outer undo step: the backend's own command is that step", async () => {
    await runRowColumnGesture("insertRow", host(sel(2, 1, 3, 2)));
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
  });

  it("no selection: nothing runs and nothing is said", async () => {
    await runRowColumnGesture("deleteRow", host(null));
    expect(api.deleteRows).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
    expect(afterChange).not.toHaveBeenCalled();
  });
});

describe("several Ctrl+click blocks: one insertion / deletion each, ONE undo step", () => {
  const twoRows = (): Selection => sel(4, 0, 4, 0, [{ startRow: 1, startCol: 0, endRow: 1, endCol: 0 }]);

  it("inserts BOTTOM-UP, so the upper block's index is still right when its turn comes", async () => {
    await runRowColumnGesture("insertRow", host(twoRows()));
    // Excel (A2,A5): 1,_,2,3,4,_,5 -- a row above row 5, then above row 2.
    expect(api.insertRows.mock.calls).toEqual([
      [4, 1],
      [1, 1],
    ]);
  });

  it("deletes bottom-up too (Excel A2,A5: rows 2 and 5 go)", async () => {
    await runRowColumnGesture("deleteRow", host(twoRows()));
    expect(api.deleteRows.mock.calls).toEqual([
      [4, 1],
      [1, 1],
    ]);
  });

  it("columns: B2,E2 inserts a column before E and before B", async () => {
    await runRowColumnGesture("insertColumn", host(sel(1, 4, 1, 4, [{ startRow: 1, startCol: 1, endRow: 1, endCol: 1 }])));
    expect(api.insertColumns.mock.calls).toEqual([
      [4, 1],
      [1, 1],
    ]);
  });

  it("the blocks are ONE undo step: its own begin, committed with its ticket", async () => {
    await runRowColumnGesture("insertRow", host(twoRows()));
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(41);
    expect(api.cancelUndoTransaction).not.toHaveBeenCalled();
    expect(afterChange).toHaveBeenCalledWith("insertRow", [
      { start: 1, count: 1 },
      { start: 4, count: 1 },
    ]);
  });

  it("inside a script's open batch it joins and closes nothing", async () => {
    api.beginUndoTransaction.mockResolvedValue(null);
    await runRowColumnGesture("deleteRow", host(twoRows()));
    expect(api.deleteRows).toHaveBeenCalledTimes(2);
    expect(api.commitUndoTransaction).not.toHaveBeenCalled();
    expect(api.cancelUndoTransaction).not.toHaveBeenCalled();
  });
});

describe("refusals reach the user", () => {
  it("blocks that share a row are refused whole, with Excel's sentence", async () => {
    await runRowColumnGesture("insertRow", host(sel(2, 2, 2, 2, [{ startRow: 2, startCol: 0, endRow: 2, endCol: 0 }])));
    expect(api.insertRows).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith(OVERLAPPING_SELECTIONS);
    expect(afterChange).not.toHaveBeenCalled();
  });

  it("inserting as many rows as the sheet has would push every row off it: refused", async () => {
    await runRowColumnGesture("insertRow", host(sel(0, 2, TOTAL_ROWS - 1, 2, undefined, "columns")));
    expect(api.insertRows).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith(shiftOffSheetRefusal("insertRow"));
  });

  it("the same for columns", async () => {
    await runRowColumnGesture("insertColumn", host(sel(3, 0, 3, TOTAL_COLS - 1, undefined, "rows")));
    expect(api.insertColumns).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith(shiftOffSheetRefusal("insertColumn"));
  });

  it("DELETING every row is allowed (Excel empties the sheet)", async () => {
    await runRowColumnGesture("deleteRow", host(sel(0, 2, TOTAL_ROWS - 1, 2, undefined, "columns")));
    expect(api.deleteRows.mock.calls).toEqual([[0, TOTAL_ROWS]]);
  });

  it("a backend refusal of one block is shown, and the grid is not told anything changed", async () => {
    api.insertRows.mockRejectedValue("The sheet is protected.");
    await runRowColumnGesture("insertRow", host(sel(2, 1, 3, 2)));
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The sheet is protected.");
    expect(afterChange).not.toHaveBeenCalled();
  });

  it("an Error's message is shown, not '[object Error]'", async () => {
    api.deleteColumns.mockRejectedValue(new Error("A PivotTable is in the way."));
    await runRowColumnGesture("deleteColumn", host(sel(2, 1, 3, 2)));
    expect(dialogs.alertAsync).toHaveBeenCalledWith("A PivotTable is in the way.");
  });

  it("refused at the FIRST of several blocks: nothing landed, so the step is cancelled", async () => {
    api.deleteRows.mockRejectedValue("The sheet is protected.");
    await runRowColumnGesture("deleteRow", host(sel(4, 0, 4, 0, [{ startRow: 1, startCol: 0, endRow: 1, endCol: 0 }])));
    expect(api.cancelUndoTransaction).toHaveBeenCalledWith(41);
    expect(api.commitUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("The sheet is protected.");
    expect(afterChange).not.toHaveBeenCalled();
  });

  // rev-dt2-2. Excel [LIVE, dtrefresh/probe4.ps1]: rows 3 and 10 selected with
  // a data table on K1:L4 -- Insert / Delete Sheet Rows changed NOTHING, row 10
  // included. The blocks run bottom-up, so row 10 had landed when row 3 was
  // refused; it stayed inserted.
  //
  // SABOTAGE: skip the take-back in runRowColumnGesture -- fails at the
  // rollBackToUndoSavepoint expectation.
  it("refused LATER: the block that landed is taken back -- all or nothing, as Excel", async () => {
    api.insertRows.mockResolvedValueOnce([]).mockRejectedValueOnce("Can't change part of a data table.");
    await runRowColumnGesture("insertRow", host(sel(9, 0, 9, 0, [{ startRow: 2, startCol: 0, endRow: 2, endCol: 0 }])));
    expect(api.insertRows.mock.calls).toEqual([
      [9, 1],
      [2, 1],
    ]);
    expect(api.beginUndoSavepoint).toHaveBeenCalledTimes(1);
    expect(api.rollBackToUndoSavepoint).toHaveBeenCalledWith({ transaction: 41, changes: 0 });
    expect(moved.announceRolledBackRestore).toHaveBeenCalledTimes(1);
    // The step holds nothing of the gesture's any more: cancelled, not committed.
    expect(api.cancelUndoTransaction).toHaveBeenCalledWith(41);
    expect(api.commitUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Can't change part of a data table.");
    expect(afterChange).not.toHaveBeenCalled();
  });

  it("refused LATER and the take-back refused: what landed is committed (so Ctrl+Z takes it back), shown, and repainted", async () => {
    api.rollBackToUndoSavepoint.mockResolvedValue({ success: false, updatedCells: [], refusal: "the step moved" });
    api.deleteRows.mockResolvedValueOnce([]).mockRejectedValueOnce("A PivotTable is in the way.");
    await runRowColumnGesture("deleteRow", host(sel(4, 0, 4, 0, [{ startRow: 1, startCol: 0, endRow: 1, endCol: 0 }])));
    // A cancel would DROP the undo record of the row already deleted and leave
    // the deletion itself in place -- undoable by nothing.
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(41);
    expect(api.cancelUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("A PivotTable is in the way.");
    expect(afterChange).toHaveBeenCalledWith("deleteRow", [{ start: 4, count: 1 }]);
  });

  it("no savepoint can be named (a granted run holds the step): the old commit path", async () => {
    api.beginUndoSavepoint.mockResolvedValue({ ticket: null, savepoint: null, refused: "a run holds it" });
    api.deleteRows.mockResolvedValueOnce([]).mockRejectedValueOnce("A PivotTable is in the way.");
    await runRowColumnGesture("deleteRow", host(sel(4, 0, 4, 0, [{ startRow: 1, startCol: 0, endRow: 1, endCol: 0 }])));
    expect(api.rollBackToUndoSavepoint).not.toHaveBeenCalled();
    expect(api.commitUndoTransaction).toHaveBeenCalledWith(41);
    expect(afterChange).toHaveBeenCalledWith("deleteRow", [{ start: 4, count: 1 }]);
  });
});
