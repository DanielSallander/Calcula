//! FILENAME: app/src/core/hooks/__tests__/clipboardFollowsSource.test.tsx
// PURPOSE: The clipboard mode ends where Excel ends it -- a Sort, a Remove
//          Duplicates, a Text to Columns, a Delete Cells or any delete -- and
//          where Excel keeps it, the paste takes what the source holds NOW
//          whatever its size, with the text, comments and validations that
//          travel with it. Driven through the REAL useClipboard hook and the
//          REAL @api sortRange / removeDuplicates wrappers; the backend and the
//          Tauri clipboard plugin are doubles.
// CONTEXT: Bug-ledger fix programme round 11 (lane clip3), reviewer rev9B's
//          findings on round 9/10:
//          (1) a ribbon Sort ended nothing, so a later Paste moved the
//              PRE-SORT snapshot (every name next to the wrong score). Excel 16
//              [LIVE 2026-10-30, rev9B/probe-sort.ps1 and clip3/probe-*.ps1]:
//              SortAscending / SortDescending (ribbon and AutoFilter), COM
//              Range.Sort, Range.RemoveDuplicates and Range.TextToColumns all
//              set CutCopyMode to 0 for a copy and a cut, on any range, and a
//              Paste then fails.
//          (2) above 100,000 cells (any whole-column copy) the re-read was
//              skipped: a copy pasted its stale snapshot silently and a cut was
//              refused with "The cut cells changed..." although nothing in it
//              had. Size no longer decides whether a snapshot is read again.
//          (3) a re-read kept the copy-time text, comments and validations;
//              Excel's clipboard follows the source.
//          (4) Delete Cells was assumed to behave like Insert Cells (keep a
//              copy). Excel [LIVE 2026-10-30, clip3/probe-dialogs.ps1]: COM
//              Range.Delete xlShiftUp above, inside, below and beside the
//              copied block, on another sheet, and Rows(2).Delete (COM and the
//              ribbon) all set CutCopyMode to 0 for a copy as well as a cut.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface ModelCell {
  display: string;
  formula: string | null;
  styleIndex: number;
}

/** The cells the doubles serve: "row,col" -> cell. */
const model = vi.hoisted(() => ({
  cells: new Map<string, ModelCell>(),
  comments: [] as Array<Record<string, unknown>>,
}));
/** The system clipboard: what readText answers, and every write made to it. */
const sys = vi.hoisted(() => ({ text: null as string | null, written: [] as string[], rereadFails: false }));
/** What the Tauri bridge answers for the commands the REAL @api wrappers invoke. */
const bridge = vi.hoisted(() => ({
  sortSucceeds: true,
  invoked: [] as string[],
  cellShiftAsks: false,
  /** Called inside the next insert_rows, before it answers (once): another door's insert landing meanwhile. */
  duringInsertRows: null as null | (() => void),
}));

const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (_u: unknown[], _o?: unknown) => [] as unknown[]),
  clearCell: vi.fn(async (_row?: number, _col?: number) => {}),
  clearRange: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  clearRangeWithOptions: vi.fn(async (..._a: unknown[]) => undefined as unknown),
  relocateCellReferences: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  beginUndoTransaction: vi.fn(async (_d?: string) => 7),
  commitUndoTransaction: vi.fn(async (_t?: unknown) => {}),
  cancelUndoTransaction: vi.fn(async (_t?: unknown) => {}),
  getRangeCellsTyped: vi.fn(),
  getWatchCells: vi.fn(),
}));

function cellData(row: number, col: number): unknown {
  const cell = model.cells.get(`${row},${col}`);
  return cell ? { row, col, display: cell.display, formula: cell.formula, styleIndex: cell.styleIndex } : null;
}

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    bridge.invoked.push(cmd);
    if (cmd === "sort_range") {
      return bridge.sortSucceeds
        ? { success: true, updatedCells: [], error: null }
        : { success: false, updatedCells: [], error: "refused" };
    }
    if (cmd === "remove_duplicates") {
      return { success: true, duplicatesRemoved: 1, uniqueRemaining: 2, updatedCells: [], error: null };
    }
    // The row / column / cell edits the REAL @api wrappers invoke (round 12):
    // the sheet on screen is 0, and a cell shift reports the band it made.
    if (cmd === "get_active_sheet") return 0;
    // An insert moves the model's cells down (rows) the way the backend does,
    // so a re-read at the moved address finds them.
    const shiftDown = (at: number, count: number, inCols?: [number, number]) => {
      const moved = new Map<string, ModelCell>();
      for (const [key, cell] of model.cells) {
        const [row, col] = key.split(",").map(Number);
        const inside = row >= at && (!inCols || (col >= inCols[0] && col <= inCols[1]));
        moved.set(inside ? `${row + count},${col}` : key, cell);
      }
      model.cells = moved;
    };
    if (cmd === "insert_rows") {
      const a = (args ?? {}) as { row: number; count: number };
      shiftDown(a.row, a.count);
      const during = bridge.duringInsertRows;
      bridge.duringInsertRows = null;
      during?.();
      return [];
    }
    if (cmd === "delete_rows" || cmd === "delete_columns" || cmd === "insert_columns") return [];
    if (cmd === "delete_cells" || cmd === "insert_cells") {
      // The backend stops to ask before unmerging a merge the shift cuts.
      if (bridge.cellShiftAsks && !(args as { unmergeCutMerges?: boolean } | undefined)?.unmergeCutMerges) {
        return { applied: false, confirm: "This operation will cause some merged cells to unmerge.", wholeLines: false, delta: null };
      }
      const a = (args ?? {}) as { startRow: number; startCol: number; endRow: number; endCol: number; shift: string };
      const rowWise = a.shift === "up" || a.shift === "down";
      if (cmd === "insert_cells" && a.shift === "down") shiftDown(a.startRow, a.endRow - a.startRow + 1, [a.startCol, a.endCol]);
      const kind = cmd === "delete_cells" ? (rowWise ? "rowDelete" : "colDelete") : rowWise ? "rowInsert" : "colInsert";
      return {
        applied: true,
        confirm: null,
        wholeLines: false,
        delta: {
          kind,
          sheetIndex: 0,
          at: rowWise ? a.startRow : a.startCol,
          count: rowWise ? a.endRow - a.startRow + 1 : a.endCol - a.startCol + 1,
          band: rowWise ? { start: a.startCol, end: a.endCol } : { start: a.startRow, end: a.endRow },
        },
      };
    }
    throw new Error(`no backend for ${cmd} in this double`);
  }),
}));

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: (d: string) => api.beginUndoTransaction(d),
  commitUndoTransaction: (t?: unknown) => api.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: unknown) => api.cancelUndoTransaction(t),
  beginUndoSavepoint: vi.fn(async () => ({ ticket: null, savepoint: { transaction: 7, changes: 0 } })),
  rollBackToUndoSavepoint: vi.fn(async () => ({ success: true })),
  updateCellsBatch: (u: unknown[], o?: unknown) => api.updateCellsBatch(u, o),
  clearCell: (row: number, col: number) => api.clearCell(row, col),
  clearRange: (...a: unknown[]) => api.clearRange(...a),
  clearRangeWithOptions: (...a: unknown[]) => api.clearRangeWithOptions(...a),
  relocateCellReferences: (...args: unknown[]) => api.relocateCellReferences(...args),
  updateCell: vi.fn(async (row: number, col: number, value: string) => ({ cells: [{ row, col, display: value, formula: null }] })),
  getSheets: vi.fn(async () => ({
    sheets: [{ index: 0, name: "Sheet1", sheetId: "S1", visibility: "visible" }],
    activeIndex: 0,
  })),
  getMergeInfo: vi.fn(async () => null),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
  // The typed read: none at the copy (no sheet named: the paste then falls
  // back to the display); the sheet-addressed re-read answers from the model,
  // SPARSE (only the cells the model holds), unless `sys.rereadFails`.
  getRangeCellsTyped: (r0: number, c0: number, r1: number, c1: number, sheet?: number) =>
    api.getRangeCellsTyped(r0, c0, r1, c1, sheet),
  getWatchCells: (requests: [number, number, number][]) => api.getWatchCells(requests),
  getCell: vi.fn(async (row: number, col: number) => cellData(row, col)),
  getCollectionTexts: vi.fn(async () => []),
  getComment: vi.fn(async (row: number, col: number) => model.comments.find((c) => c.row === row && c.col === col) ?? null),
  getDataValidation: vi.fn(async () => null),
  getCommentsForSheet: vi.fn(async () => model.comments),
  getAllDataValidations: vi.fn(async () => []),
}));

vi.mock("../../../api/cellTarget", () => ({
  getCellTargetCells: vi.fn(async () => ({ cells: [], merges: [], conditional: [], styles: [], rules: [] })),
  selectTargetCells: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => sys.text),
  writeText: vi.fn(async (t: string) => {
    sys.written.push(t);
    sys.text = t;
  }),
  writeHtml: vi.fn(async (_html: string, t: string) => {
    sys.written.push(t);
    sys.text = t;
  }),
}));

const dialogs = vi.hoisted(() => ({ alerts: [] as string[] }));
vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async (m?: string) => {
    dialogs.alerts.push(String(m));
  }),
  confirmAsync: vi.fn(async () => true),
}));

import {
  useClipboard,
  getInternalClipboard,
  isCutModeLive,
  settledInternalClipboard,
  SNAPSHOT_EAGER_REREAD_MAX_CELLS,
  type UseClipboardReturn,
} from "../useClipboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection, setSheetContext } from "../../state/gridActions";
import { cellEvents } from "../../lib/cellEvents";
import { emitAppEvent } from "../../lib/events";
import { AppEvents as ApiAppEvents } from "../../../api/events";
import { sortRange, removeDuplicates } from "../../../api/backend";
import * as tauriApi from "../../lib/tauri-api";
import * as coreDialogs from "../../lib/dialogs";
import { deleteCellsRange, deleteColumns, deleteRows, insertRows } from "../../lib/tauri-api";
import { gridCommands } from "../../lib/gridCommands";
import { insertCopiedCells, insertCopiedCellsLabel } from "../useClipboard";
import { AppEvents as CoreAppEvents } from "../../lib/events";
import { followStructuralEdits, followCell, type StructuralFollowStep, type StructuralFollowEdit } from "../../../api/structuralFollow";
import type { GridState } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let clipboard: UseClipboardReturn;
let gridState: GridState;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  gridState = state;
  dispatchOut = dispatch;
  clipboard = useClipboard();
  return <div />;
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function select(r0: number, c0: number, r1 = r0, c1 = c0): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }));
  });
  await settle();
}

/** Copy (or cut) Sheet1!A1, which holds 5. */
async function takeA1(how: "copy" | "cut"): Promise<void> {
  model.cells.set("0,0", { display: "5", formula: null, styleIndex: 0 });
  await select(0, 0);
  await act(async () => {
    await (how === "copy" ? clipboard.copy() : clipboard.cut());
  });
  await settle();
  expect(getInternalClipboard(), `precondition: the ${how} is pending`).not.toBeNull();
  expect(gridState.clipboard.mode).toBe(how);
}

async function pasteAt(row: number, col: number): Promise<void> {
  await select(row, col);
  await act(async () => {
    await clipboard.paste();
  });
  await settle();
}

/** The mode ENDED: nothing pending, no ants, the clipboard emptied -- and a Paste pastes nothing. */
async function expectModeEnded(why: string): Promise<void> {
  expect(getInternalClipboard(), `${why}: the copy or cut is still pasteable`).toBeNull();
  expect(isCutModeLive()).toBe(false);
  expect(gridState.clipboard.mode, `${why}: the marching ants stayed up`).toBe("none");
  expect(sys.text, `${why}: the system clipboard still holds the copied text`).toBe("");
  api.updateCellsBatch.mockClear();
  await pasteAt(0, 2);
  expect(api.updateCellsBatch, `${why}: a Paste still pasted`).not.toHaveBeenCalled();
  expect(api.clearCell, `${why}: a Paste still emptied the source`).not.toHaveBeenCalled();
}

/** Every value the pastes wrote, keyed "row,col". */
function written(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [updates] of api.updateCellsBatch.mock.calls as unknown as Array<[Array<{ row: number; col: number; value: string }>]>) {
    for (const u of updates) out.set(`${u.row},${u.col}`, u.value);
  }
  return out;
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  model.cells.clear();
  model.comments = [];
  sys.text = null;
  sys.written = [];
  sys.rereadFails = false;
  bridge.sortSucceeds = true;
  bridge.cellShiftAsks = false;
  bridge.invoked = [];
  bridge.duringInsertRows = null;
  dialogs.alerts = [];
  for (const fn of Object.values(api)) fn.mockReset();
  api.updateCellsBatch.mockImplementation(async () => []);
  api.clearCell.mockImplementation(async () => {});
  api.clearRange.mockImplementation(async () => []);
  api.clearRangeWithOptions.mockImplementation(async () => undefined);
  api.relocateCellReferences.mockImplementation(async () => []);
  api.beginUndoTransaction.mockImplementation(async () => 7);
  api.commitUndoTransaction.mockImplementation(async () => {});
  api.cancelUndoTransaction.mockImplementation(async () => {});
  api.getRangeCellsTyped.mockImplementation(async (r0: number, c0: number, r1: number, c1: number, sheet?: number) => {
    if (sheet === undefined || sys.rereadFails) throw new Error("no typed read in this double");
    const out: unknown[] = [];
    for (const [key, cell] of model.cells) {
      const [row, col] = key.split(",").map(Number);
      if (row < r0 || row > r1 || col < c0 || col > c1) continue;
      const n = Number(cell.display);
      out.push({
        row,
        col,
        display: cell.display,
        formula: cell.formula,
        type: Number.isFinite(n) ? "number" : "text",
        value: Number.isFinite(n) ? n : cell.display,
      });
    }
    return out;
  });
  api.getWatchCells.mockImplementation(async (requests: [number, number, number][]) => {
    if (sys.rereadFails) throw new Error("the read failed");
    return requests.map(([, row, col]) => cellData(row, col));
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider>
        <Harness />
      </GridProvider>,
    );
  });
  await act(async () => {
    dispatchOut(setSheetContext(0, "Sheet1", undefined, "S1"));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => {
    clipboard.clearClipboardState();
  });
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("[LIVE] a Sort, a Remove Duplicates and a Text to Columns END the mode", () => {
  for (const how of ["copy", "cut"] as const) {
    it(`a Sort (the real @api sortRange) ends a ${how}: the Paste moves no pre-sort snapshot`, async () => {
      await takeA1(how);
      await act(async () => {
        await sortRange(0, 0, 2, 1, [{ key: 1, ascending: true }]);
      });
      await settle();
      expect(bridge.invoked).toContain("sort_range");
      await expectModeEnded(`a Sort with a ${how} pending`);
    });
  }

  it("Remove Duplicates (the real @api removeDuplicates) ends a copy", async () => {
    await takeA1("copy");
    await act(async () => {
      await removeDuplicates(0, 0, 4, 1, [0], true);
    });
    await settle();
    await expectModeEnded("Remove Duplicates");
  });

  it("Text to Columns (its DATA_COMMAND_APPLIED) ends a cut", async () => {
    await takeA1("cut");
    await act(async () => {
      emitAppEvent(ApiAppEvents.DATA_COMMAND_APPLIED, { command: "textToColumns" });
    });
    await settle();
    await expectModeEnded("Text to Columns");
  });

  it("control: a REFUSED sort changes nothing, and the copy stays pasteable", async () => {
    await takeA1("copy");
    bridge.sortSucceeds = false;
    await act(async () => {
      await sortRange(0, 0, 2, 1, [{ key: 1, ascending: true }]);
    });
    await settle();
    expect(getInternalClipboard(), "a refused sort ended the copy").not.toBeNull();
    await pasteAt(0, 2);
    expect(written().get("0,2")).toBe("5");
  });
});

describe("[LIVE] a DELETE ends a copy as well as a cut", () => {
  it("Delete Cells shift up beside the copied block (STRUCTURAL_UNDO, source edit) ends a copy", async () => {
    await takeA1("copy");
    await act(async () => {
      emitAppEvent(ApiAppEvents.STRUCTURAL_UNDO, {
        description: "Delete Cells",
        source: "edit",
        deltas: [{ kind: "rowDelete", sheetIndex: 0, at: 1, count: 1, band: { start: 3, end: 3 } }],
      });
    });
    await settle();
    await expectModeEnded("Delete Cells (shift up) in another column");
  });

  it("a script's delete on ANOTHER sheet ends a copy", async () => {
    await takeA1("copy");
    await act(async () => {
      emitAppEvent(ApiAppEvents.STRUCTURAL_EDIT_ELSEWHERE, {
        descriptions: ["Delete Rows"],
        edits: [{ sheetIndex: 2, kind: "rowDelete", at: 0, count: 1 }],
      });
    });
    await settle();
    await expectModeEnded("a COM delete on Sheet3");
  });

  // Round 12 (clip4): the same, through the REAL @api wrappers every route
  // calls -- Delete Cells, a script's row or column delete on the sheet on
  // screen, and one on ANOTHER sheet -- so the ending cannot depend on an
  // event a route forgot to make [LIVE, rev10A probe_del2.ps1 and clip3
  // probe-dialogs.ps1: every delete variant sets CutCopyMode to 0].
  it("the REAL deleteCellsRange (Delete Cells, shift up, another column) ends a copy", async () => {
    await takeA1("copy");
    await act(async () => {
      await deleteCellsRange(1, 3, 1, 3, "up");
    });
    await settle();
    expect(bridge.invoked).toContain("delete_cells");
    await expectModeEnded("the real Delete Cells");
  });

  it("the REAL deleteRows on the sheet on screen (a script's Rows(2).Delete) ends a copy", async () => {
    await takeA1("copy");
    await act(async () => {
      await deleteRows(5, 1);
    });
    await settle();
    expect(bridge.invoked).toContain("delete_rows");
    await expectModeEnded("a row deleted below the copied cell");
  });

  it("the REAL deleteColumns on ANOTHER sheet (a script's delete on Sheet2) ends a cut", async () => {
    await takeA1("cut");
    await act(async () => {
      await deleteColumns(4, 1, 1);
    });
    await settle();
    expect(bridge.invoked).toContain("delete_columns");
    await expectModeEnded("a column deleted on another sheet");
  });

  it("control: Insert Cells beside the band keeps the copy (Excel keeps it)", async () => {
    await takeA1("copy");
    await act(async () => {
      emitAppEvent(ApiAppEvents.STRUCTURAL_UNDO, {
        description: "Insert Cells",
        source: "edit",
        deltas: [{ kind: "rowInsert", sheetIndex: 0, at: 1, count: 1, band: { start: 3, end: 3 } }],
      });
    });
    await settle();
    expect(getInternalClipboard(), "an insert beside the band ended the copy").not.toBeNull();
  });
});

// Round 12 (clip4), clip3's NEW item: with a COPY pending, Excel's Insert is
// "Insert Copied Cells" [LIVE 2026-10-30, clip4/probe-insert*.ps1, fresh
// visible instances]: F6 copied, F2 selected, Ctrl+Plus, Shift cells down ->
// F2 = f6, column F shifted down, CutCopyMode stays xlCopy and a later Paste
// pastes f6 (the source moved to F7 with its cells); ONE Ctrl+Z takes it all
// back; row 6 copied into row 2 -> the copied row inserted, the copy kept.
// The primitive, through the REAL hook, the REAL @api wrappers and the grid
// command door its paste goes through.
describe("[LIVE] Insert Copied Cells: room made, the copy pasted there, one step, the copy kept", () => {
  let offPaste: (() => void) | null = null;
  beforeEach(() => {
    gridCommands.register("paste", (args, ctx) => clipboard.paste(args, ctx));
    offPaste = () => gridCommands.unregister("paste");
    vi.mocked(tauriApi.rollBackToUndoSavepoint).mockClear();
  });
  afterEach(() => {
    offPaste?.();
  });

  /** Copy A6 (row 5), which holds 66. */
  async function copyA6(): Promise<void> {
    model.cells.set("5,0", { display: "66", formula: null, styleIndex: 0 });
    await select(5, 0);
    await act(async () => {
      await clipboard.copy();
    });
    await settle();
  }

  it("inserts room at A2 (shift down) and pastes the copy there, in ONE step named Insert Copied Cells", async () => {
    await copyA6();
    expect(insertCopiedCellsLabel(false)).toBe("Insert Copied Cells...");
    expect(insertCopiedCellsLabel(true)).toBe("Insert Copied Cells");
    api.beginUndoTransaction.mockClear();
    let result: unknown;
    await act(async () => {
      result = await insertCopiedCells({ kind: "cells", startRow: 1, startCol: 0, endRow: 1, endCol: 0, shift: "down" });
    });
    await settle();
    expect(result).toEqual({ inserted: true });
    expect(bridge.invoked).toContain("insert_cells");
    expect(api.beginUndoTransaction.mock.calls[0]?.[0], "the insert and its paste are not one step").toBe("Insert Copied Cells");
    expect(written().get("1,0"), "the copied value was not pasted into the room made").toBe("66");
    // The copy stays pending, its source moved down with its cells (A6 -> A7).
    expect(getInternalClipboard(), "Insert Copied Cells ended the copy").not.toBeNull();
    expect(getInternalClipboard()?.sourceSelection.startRow).toBe(6);
  });

  it("whole lines: the row insert made for the copy KEEPS the copy (an ordinary row insert ends it)", async () => {
    await copyA6();
    await act(async () => {
      await insertCopiedCells({ kind: "rows", start: 1, count: 1 });
    });
    await settle();
    expect(bridge.invoked).toContain("insert_rows");
    expect(written().get("1,0")).toBe("66");
    expect(getInternalClipboard(), "the row insert ended the copy it was making room for").not.toBeNull();
    expect(getInternalClipboard()?.sourceSelection.startRow).toBe(6);
    // Control: a ribbon Insert Sheet Rows inserts BLANK lines and ends the copy (Excel [LIVE]).
    await act(async () => {
      await insertRows(0, 1);
    });
    await settle();
    expect(getInternalClipboard()).toBeNull();
  });

  it("a paste that does not land takes the inserted room back: nothing is left of the gesture", async () => {
    await copyA6();
    api.updateCellsBatch.mockImplementation(async () => {
      throw new Error("the paste was refused");
    });
    let result: unknown;
    await act(async () => {
      result = await insertCopiedCells({ kind: "cells", startRow: 1, startCol: 0, endRow: 1, endCol: 0, shift: "down" });
    });
    await settle();
    expect(result).toEqual({ inserted: false, message: null });
    expect(vi.mocked(tauriApi.rollBackToUndoSavepoint), "the room was left inserted with nothing pasted").toHaveBeenCalledTimes(1);
  });

  // Round 14 (lane clip6), reviewer rev12A's MAJOR (CONFIRMED, its probe
  // rev12A/probeInsertRollback.test.tsx): a refused paste took the inserted
  // room back in the BACKEND only. The copy's source, the followers (a
  // bookmark, a watch) and the screen stayed shifted, so the next Paste
  // pasted the cell the insert had pushed onto the copy's address. The
  // take-back is now shown the way Ctrl+Z shows a restore: its inverse
  // deltas announced (STRUCTURAL_UNDO, source "rollback"), the dimensions
  // and cells re-read.
  it("a paste that does not land puts the copy's source, a follower and the screen back: the next Paste pastes A6", async () => {
    await copyA6();
    expect(getInternalClipboard()?.sourceSelection.startRow).toBe(5);
    // A follower of cell coordinates (a bookmark on A10) -- @api/structuralFollow.
    let bookmark = { sheetIndex: 0, row: 9, col: 0 };
    const offFollow = followStructuralEdits(
      (step: StructuralFollowStep<StructuralFollowEdit>) => {
        const moved = followCell(step.edit, bookmark.sheetIndex, bookmark.row, bookmark.col);
        if (moved) bookmark = moved;
      },
      { moves: true },
    );
    const refreshes: string[] = [];
    const onRefresh = (event: Event) => refreshes.push(event.type);
    window.addEventListener("grid:refresh", onRefresh);
    window.addEventListener("dimensions:refresh", onRefresh);
    // The backend's take-back: the band insert at A2 undone (the inverse
    // delta it reports), and the cells it pushed down moved back up.
    vi.mocked(tauriApi.rollBackToUndoSavepoint).mockImplementationOnce(async () => {
      const back = new Map<string, ModelCell>();
      for (const [key, cell] of model.cells) {
        const [row, col] = key.split(",").map(Number);
        back.set(col === 0 && row >= 2 ? `${row - 1},${col}` : key, cell);
      }
      model.cells = back;
      return {
        success: true,
        description: "Insert Copied Cells",
        updatedCells: [],
        structuralRestore: true,
        mergeChanged: false,
        hiddenChanged: false,
        refreshDomains: ["objects"],
        structuralDeltas: [{ kind: "rowDelete", sheetIndex: 0, at: 1, count: 1, band: { start: 0, end: 0 } }],
      } as unknown as Awaited<ReturnType<typeof tauriApi.rollBackToUndoSavepoint>>;
    });
    api.updateCellsBatch.mockImplementationOnce(async () => {
      throw new Error("the paste was refused");
    });
    try {
      await act(async () => {
        await insertCopiedCells({ kind: "cells", startRow: 1, startCol: 0, endRow: 1, endCol: 0, shift: "down" });
      });
      await settle();
      expect(vi.mocked(tauriApi.rollBackToUndoSavepoint)).toHaveBeenCalledTimes(1);
      expect(getInternalClipboard(), "the take-back ended the copy (nothing happened: it stays pending)").not.toBeNull();
      expect(getInternalClipboard()?.sourceSelection.startRow, "the rolled-back insert left the copy's source moved").toBe(5);
      expect(bookmark, "the rolled-back insert left the bookmark one row low").toEqual({ sheetIndex: 0, row: 9, col: 0 });
      expect(refreshes, "the screen was not re-read after the take-back").toEqual(
        expect.arrayContaining(["grid:refresh", "dimensions:refresh"]),
      );
      // ...and the next Paste pastes what A6 holds.
      api.updateCellsBatch.mockClear();
      await pasteAt(0, 2);
      expect(written().get("0,2"), "the next Paste pasted the wrong cell").toBe("66");
    } finally {
      offFollow();
      window.removeEventListener("grid:refresh", onRefresh);
      window.removeEventListener("dimensions:refresh", onRefresh);
    }
  });

  // rev12A's nit: the insert Insert Copied Cells makes for the copy was told
  // apart by a module-global COUNTER held across the IPC await, so any row
  // insert landing meanwhile (a script's, another door's) was taken for the
  // copy's own and moved the copy instead of ending it. It is now the ONE
  // insert the call expects -- its first line and count -- consumed once.
  it("another door's row insert that lands while Insert Copied Cells' own is in flight ends the copy", async () => {
    await copyA6();
    bridge.duringInsertRows = () => {
      // An ordinary insert of three rows at row 10 on the sheet on screen.
      emitAppEvent(CoreAppEvents.ROWS_INSERTED, { startRow: 9, count: 3 });
    };
    await act(async () => {
      await insertCopiedCells({ kind: "rows", start: 1, count: 1 });
    });
    await settle();
    expect(bridge.invoked).toContain("insert_rows");
    expect(getInternalClipboard(), "a foreign insert borrowed Insert Copied Cells' hold and kept the copy").toBeNull();
  });

  it("Cancel on the unmerge question changes nothing and leaves no hold behind: a later ribbon row insert still ends the copy", async () => {
    await copyA6();
    bridge.cellShiftAsks = true;
    vi.mocked(coreDialogs.confirmAsync).mockResolvedValueOnce(false);
    let result: unknown;
    await act(async () => {
      result = await insertCopiedCells({ kind: "cells", startRow: 1, startCol: 0, endRow: 1, endCol: 0, shift: "down" });
    });
    await settle();
    expect(result).toEqual({ inserted: false, message: null });
    expect(written().size, "a Cancel still pasted").toBe(0);
    expect(getInternalClipboard(), "a Cancel ended the copy").not.toBeNull();
    await act(async () => {
      await insertRows(0, 1);
    });
    await settle();
    expect(getInternalClipboard(), "the cancelled Insert Copied Cells left its hold: an ordinary row insert kept the copy").toBeNull();
  });

  it("with no copy pending there is nothing to insert, and nothing is invoked", async () => {
    expect(insertCopiedCellsLabel(false)).toBeNull();
    let result: unknown;
    await act(async () => {
      result = await insertCopiedCells({ kind: "rows", start: 1, count: 1 });
    });
    expect(result).toMatchObject({ inserted: false });
    expect(bridge.invoked).not.toContain("insert_rows");
  });
});

describe("size never decides whether the paste takes what the source holds now", () => {
  // Bigger than the eager limit: read again when the paste asks, not on every undo.
  const ROWS = SNAPSHOT_EAGER_REREAD_MAX_CELLS + 500;

  async function takeColumn(how: "copy" | "cut"): Promise<void> {
    model.cells.set("9,0", { display: "5", formula: null, styleIndex: 0 });
    await select(0, 0, ROWS - 1, 0);
    await act(async () => {
      await (how === "copy" ? clipboard.copy() : clipboard.cut());
    });
    await settle();
    expect(getInternalClipboard()?.cells.length, `precondition: the whole ${how} is pending`).toBe(ROWS);
  }

  it("a COPY of more than the eager limit, across an undo, pastes what A10 holds NOW (it pasted the stale 5)", async () => {
    await takeColumn("copy");
    model.cells.set("9,0", { display: "3", formula: null, styleIndex: 0 });
    await act(async () => {
      emitAppEvent(ApiAppEvents.MUTATION_REFRESH, { domains: ["cells"], source: "undo" });
    });
    await settle();
    expect(
      api.getRangeCellsTyped.mock.calls.some((c) => c[4] !== undefined),
      "a snapshot this large was read again eagerly on the undo (it waits for a paste)",
    ).toBe(false);
    await pasteAt(0, 2);
    expect(dialogs.alerts, "the paste was refused").toEqual([]);
    expect(written().get("9,2"), "the paste took the copy-time 5, not the 3 A10 holds now").toBe("3");
  });

  it("a CUT of more than the eager limit, across an unrelated rename, MOVES (it was refused with an untrue message)", async () => {
    await takeColumn("cut");
    await act(async () => {
      emitAppEvent(ApiAppEvents.SHEET_RENAMED, { sheetIndex: 4, oldName: "Other", newName: "Renamed" });
    });
    await settle();
    expect(isCutModeLive(), "a rename ended the cut").toBe(true);
    await pasteAt(0, 2);
    expect(dialogs.alerts, "the cut was refused although nothing in it changed").toEqual([]);
    expect(written().get("9,2")).toBe("5");
  });

  it("a COPY whose re-read FAILS is never pasted stale: refused, and the copy ends", async () => {
    await takeA1("copy");
    sys.rereadFails = true;
    model.cells.set("0,0", { display: "3", formula: null, styleIndex: 0 });
    await act(async () => {
      emitAppEvent(ApiAppEvents.MUTATION_REFRESH, { domains: ["cells"], source: "undo" });
    });
    await settle();
    api.updateCellsBatch.mockClear();
    await pasteAt(0, 2);
    expect(api.updateCellsBatch, "the stale copy was pasted").not.toHaveBeenCalled();
    expect(dialogs.alerts.join(" ")).toMatch(/could not be read/);
    expect(getInternalClipboard(), "the refused copy is still pending").toBeNull();
  });
});

describe("what travels with the cells follows the source too", () => {
  it("a script writes 77 into a copied A1: the system clipboard text and the snapshot's text become 77 (Excel's clipboard follows)", async () => {
    await takeA1("copy");
    expect(sys.text).toBe("5");
    model.cells.set("0,0", { display: "77", formula: null, styleIndex: 0 });
    model.comments = [{ id: "c1", row: 0, col: 0, sheetIndex: 0, authorEmail: "", authorName: "A", content: "new note" }];
    await act(async () => {
      cellEvents.emitBatch([{ row: 0, col: 0, newValue: "77", formula: null }], "script");
    });
    await settle();
    const clip = getInternalClipboard();
    expect(clip?.cells[0][0]?.display).toBe("77");
    expect(clip?.text, "the snapshot kept its copy-time text").toBe("77");
    expect(sys.text, "the system clipboard kept the copy-time text").toBe("77");
    expect(clip?.comments?.get("0,0"), "the snapshot kept its copy-time comments").toMatchObject({ id: "c1" });
    // ...and plain Paste still takes the internal clipboard (the texts agree).
    await pasteAt(0, 2);
    expect(written().get("0,2")).toBe("77");
  });

  it("control: another program's newer copy on the system clipboard is never overwritten by a re-read", async () => {
    await takeA1("copy");
    sys.text = "from Notepad";
    model.cells.set("0,0", { display: "77", formula: null, styleIndex: 0 });
    await act(async () => {
      cellEvents.emitBatch([{ row: 0, col: 0, newValue: "77", formula: null }], "script");
    });
    await settle();
    expect(sys.text).toBe("from Notepad");
    expect(getInternalClipboard()?.text, "the internal text moved although the system clipboard is another program's").toBe("5");
  });

  it("Paste Special's door (settledInternalClipboard) waits for a re-read still under way", async () => {
    await takeA1("copy");
    model.cells.set("0,0", { display: "3", formula: null, styleIndex: 0 });
    let fresh: ReturnType<typeof getInternalClipboard> = null;
    await act(async () => {
      emitAppEvent(ApiAppEvents.MUTATION_REFRESH, { domains: ["cells"], source: "undo" });
      // No settle in between: the re-read has only just started.
      fresh = await settledInternalClipboard();
    });
    expect((fresh as ReturnType<typeof getInternalClipboard>)?.cells[0][0]?.display, "Paste Special read the pre-undo snapshot").toBe("3");
  });
});
