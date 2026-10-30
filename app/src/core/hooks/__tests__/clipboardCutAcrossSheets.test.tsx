//! FILENAME: app/src/core/hooks/__tests__/clipboardCutAcrossSheets.test.tsx
// PURPOSE: A Cut on one sheet pasted on ANOTHER sheet is a move between sheets:
//          the source is cleared on ITS OWN sheet, found by the stable id the
//          cut recorded, and the references to the cut cells are re-pointed to
//          the sheet and address they landed on -- through the REAL clipboard hook.
// CONTEXT: Bug-ledger fix programme, round 6 (lane cutpaste,
//          NEW-cut-paste-across-sheets-clears-destination-sheet). Nothing
//          resets a cut on a sheet switch (Excel keeps the marching ants too),
//          so the paste reached its cut branch, whose source-clear loop called
//          clearCell(r, c) -- a command that acts on the ACTIVE sheet. Cut
//          Sheet1!B1, switch to Sheet2, paste at B6: Sheet2!B1 was ERASED and
//          Sheet1!B1 kept its value. Excel [LIVE, Excel 16, 2026-10-29,
//          cutpaste/probe-xsheet.ps1] moves the cells: the source is cleared on
//          its own sheet (value and format) and every reference to them -- on
//          every sheet and in defined names -- names the new sheet and address.
//          The floating-grid route (a sheet cut pasted into a floating grid on
//          another sheet) cleared the active sheet the same way.
//          The backend and the Tauri clipboard plugin are doubles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface ModelCell {
  display: string;
  formula: string | null;
  styleIndex: number;
}

/** The cells the doubles serve at the CUT: "row,col" -> cell. */
const model = vi.hoisted(() => ({ cells: new Map<string, ModelCell>() }));
const sys = vi.hoisted(() => ({ text: null as string | null, written: [] as string[] }));
/** The workbook's sheets as `get_sheets` answers them now. */
const book = vi.hoisted(() => ({
  sheets: [] as { index: number; name: string; sheetId?: string; visibility: string }[],
  activeIndex: 1,
  fail: false,
}));

const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (_u: unknown[], _o?: unknown) => [] as unknown[]),
  clearCell: vi.fn(async (_row?: number, _col?: number) => {}),
  clearRangeWithOptions: vi.fn(async (..._a: unknown[]) => undefined as unknown),
  relocateCellReferences: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  getSheets: vi.fn(async () => {
    if (book.fail) throw new Error("no backend");
    return { sheets: book.sheets, activeIndex: book.activeIndex };
  }),
  beginUndoTransaction: vi.fn(async (_d?: string) => 7),
  commitUndoTransaction: vi.fn(async (_t?: unknown) => {}),
  cancelUndoTransaction: vi.fn(async (_t?: unknown) => {}),
  // A cut's paste marks the point it is taken back to when the move cannot
  // finish (round 8, rev6A#5): the door joins the paste's step 7.
  beginUndoSavepoint: vi.fn(async (_d?: string) => ({ ticket: null, savepoint: { transaction: 7, changes: 0 } })),
  rollBackToUndoSavepoint: vi.fn(async (_p?: unknown) => ({ success: true })),
}));
const dialogs = vi.hoisted(() => ({
  alertAsync: vi.fn(async (_m?: string) => {}),
}));

function cellData(row: number, col: number): unknown {
  const cell = model.cells.get(`${row},${col}`);
  return cell ? { row, col, display: cell.display, formula: cell.formula, styleIndex: cell.styleIndex } : null;
}

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: (d: string) => api.beginUndoTransaction(d),
  commitUndoTransaction: (t?: unknown) => api.commitUndoTransaction(t),
  cancelUndoTransaction: (t?: unknown) => api.cancelUndoTransaction(t),
  beginUndoSavepoint: (d: string) => api.beginUndoSavepoint(d),
  rollBackToUndoSavepoint: (p: unknown) => api.rollBackToUndoSavepoint(p),
  updateCellsBatch: (u: unknown[], o?: unknown) => api.updateCellsBatch(u, o),
  clearCell: (row: number, col: number) => api.clearCell(row, col),
  clearRangeWithOptions: (...a: unknown[]) => api.clearRangeWithOptions(...a),
  relocateCellReferences: (...args: unknown[]) => api.relocateCellReferences(...args),
  getSheets: () => api.getSheets(),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
  // No typed read: every constant falls back to its display.
  getRangeCellsTyped: vi.fn(async () => {
    throw new Error("no typed read in this double");
  }),
  getCell: vi.fn(async (row: number, col: number) => cellData(row, col)),
  getCollectionTexts: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getDataValidation: vi.fn(async () => null),
}));

vi.mock("../../../api/cellTarget", () => ({
  getCellTargetCells: vi.fn(async () => ({ cells: [], merges: [], conditional: [], styles: [], rules: [] })),
  selectTargetCells: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => sys.text),
  writeText: vi.fn(async (t: string) => {
    sys.written.push(t);
  }),
  writeHtml: vi.fn(async (_html: string, t: string) => {
    sys.written.push(t);
  }),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: (m: string) => dialogs.alertAsync(m),
  confirmAsync: vi.fn(async () => true),
}));

import { useClipboard, getInternalClipboard, type UseClipboardReturn } from "../useClipboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection, setSheetContext } from "../../state/gridActions";
import type { CellTarget } from "../../lib/selectionOwner";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let hook: UseClipboardReturn;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Harness(): React.ReactElement {
  const { dispatch } = useGridContext();
  dispatchOut = dispatch;
  hook = useClipboard();
  return <div />;
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function onSheet(index: number, name: string, id?: string): Promise<void> {
  await act(async () => {
    dispatchOut(setSheetContext(index, name, undefined, id));
  });
  await settle();
}

async function select(r0: number, c0: number, r1 = r0, c1 = c0): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }));
  });
  await settle();
}

const SHEETS = [
  { index: 0, name: "Sheet1", sheetId: "S1", visibility: "visible" },
  { index: 1, name: "Sheet2", sheetId: "S2", visibility: "visible" },
];

/** Cut Sheet1!B1 (=A1, showing 5) with Sheet1 active. */
async function cutSheet1B1(): Promise<void> {
  model.cells.set("0,1", { display: "5", formula: "=A1", styleIndex: 2 });
  await onSheet(0, "Sheet1", "S1");
  await select(0, 1);
  await act(async () => {
    await hook.cut();
  });
  sys.text = sys.written.at(-1) ?? null;
}

async function pasteAt(row: number, col: number, ctx?: { target: CellTarget }): Promise<void> {
  await select(row, col);
  await act(async () => {
    await hook.paste(undefined, ctx);
  });
  await settle();
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  model.cells.clear();
  sys.text = null;
  sys.written = [];
  book.sheets = SHEETS.map((s) => ({ ...s }));
  book.activeIndex = 1;
  book.fail = false;
  for (const fn of Object.values(api)) fn.mockClear();
  dialogs.alertAsync.mockClear();
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
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Cut on Sheet1, Paste on Sheet2 moves the cells between the sheets", () => {
  it("clears the source on SHEET1 with one sheet-addressed clear, never clearCell on the active Sheet2", async () => {
    await cutSheet1B1();
    await onSheet(1, "Sheet2", "S2");
    await pasteAt(5, 1);

    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(
      api.clearCell,
      "the cut cleared the ACTIVE sheet's B1 -- Sheet2's cell, which the user never cut -- and left Sheet1's source",
    ).not.toHaveBeenCalled();
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[0, 1, 0, 1, "all", 0]]);
    // After the destination is written, inside the paste's ONE undo step.
    expect(api.clearRangeWithOptions.mock.invocationCallOrder[0]).toBeGreaterThan(
      api.updateCellsBatch.mock.invocationCallOrder[0],
    );
    expect(api.beginUndoTransaction).toHaveBeenCalledTimes(1);
    expect(api.commitUndoTransaction).toHaveBeenCalledTimes(1);
  });

  it("re-points the references to the cut cells across the sheets: the relocation names the SOURCE sheet", async () => {
    await cutSheet1B1();
    await onSheet(1, "Sheet2", "S2");
    await pasteAt(5, 1);

    expect(
      api.relocateCellReferences.mock.calls,
      "a cross-sheet Cut + Paste re-pointed nothing: a formula reading Sheet1!B1 kept naming the emptied cell",
    ).toEqual([[0, 1, 0, 1, 5, 1, 0]]);
    expect(api.relocateCellReferences.mock.invocationCallOrder[0]).toBeGreaterThan(
      api.clearRangeWithOptions.mock.invocationCallOrder[0],
    );
    // A cut is one-time: the paste ENDS it, and (Excel [LIVE], round 7 lane
    // clipgroup) leaves nothing to paste -- not the moved snapshot as a copy.
    expect(getInternalClipboard()).toBeNull();
  });

  it("finds the source sheet by its stable id after a sheet was inserted before it", async () => {
    await cutSheet1B1();
    // A sheet inserted at the front: Sheet1 is now index 1, Sheet2 index 2.
    book.sheets = [
      { index: 0, name: "New", sheetId: "S9", visibility: "visible" },
      { index: 1, name: "Sheet1", sheetId: "S1", visibility: "visible" },
      { index: 2, name: "Sheet2", sheetId: "S2", visibility: "visible" },
    ];
    book.activeIndex = 2;
    await onSheet(2, "Sheet2", "S2");
    await pasteAt(5, 1);

    expect(api.clearCell).not.toHaveBeenCalled();
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[0, 1, 0, 1, "all", 1]]);
    expect(api.relocateCellReferences.mock.calls).toEqual([[0, 1, 0, 1, 5, 1, 1]]);
  });

  it("refuses cleanly, writing nothing, when the source sheet was deleted", async () => {
    await cutSheet1B1();
    book.sheets = [{ index: 0, name: "Sheet2", sheetId: "S2", visibility: "visible" }];
    book.activeIndex = 0;
    await onSheet(0, "Sheet2", "S2");
    await pasteAt(5, 1);

    expect(api.updateCellsBatch, "pasted the cut of a sheet that no longer exists").not.toHaveBeenCalled();
    expect(api.clearCell).not.toHaveBeenCalled();
    expect(api.clearRangeWithOptions).not.toHaveBeenCalled();
    expect(api.relocateCellReferences).not.toHaveBeenCalled();
    expect(api.beginUndoTransaction).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledTimes(1);
    // The cut is over (Excel ends cut mode when the source sheet goes), and a
    // later Paste pastes nothing (round 7 lane clipgroup).
    expect(getInternalClipboard()).toBeNull();
  });

  // CHANGED ON PURPOSE (round 8, rev6A#5): this used to pin the half move --
  // the paste committed as a "copy" whose formulas were written unshifted for
  // a move and never re-qualified, so they read the DESTINATION sheet's cells.
  // The paste is now taken back whole (clipboardCutMoveAllOrNothing.test.tsx).
  it("a source clear the backend refuses is reported, nothing is re-pointed, and the paste is TAKEN BACK", async () => {
    await cutSheet1B1();
    await onSheet(1, "Sheet2", "S2");
    api.clearRangeWithOptions.mockRejectedValueOnce("Sheet1 is protected.");
    await pasteAt(5, 1);

    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.clearCell).not.toHaveBeenCalled();
    expect(dialogs.alertAsync).toHaveBeenCalledWith(expect.stringContaining("Sheet1 is protected."));
    expect(api.relocateCellReferences, "re-pointed references to cells that were never moved").not.toHaveBeenCalled();
    expect(api.rollBackToUndoSavepoint.mock.calls, "the half move was left in place").toEqual([
      [{ transaction: 7, changes: 0 }],
    ]);
    expect(api.commitUndoTransaction, "the half move was committed").not.toHaveBeenCalled();
  });

  it("a sheet cut pasted into a FLOATING GRID on another sheet clears the source on its own sheet", async () => {
    await cutSheet1B1();
    await onSheet(1, "Sheet2", "S2");
    const target: CellTarget = {
      kind: "object",
      ownerId: "floatingRange",
      ref: { kind: "floatingRange", id: "fr-1" },
      selection: { startRow: 2, startCol: 2, endRow: 2, endCol: 2, type: "cells" },
      bounds: { rows: 10, cols: 5 },
      label: "Float1",
      wholeObject: false,
    };
    await act(async () => {
      await hook.paste(undefined, { target });
    });
    await settle();

    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.clearCell, "the floating-grid route cleared the ACTIVE sheet's B1").not.toHaveBeenCalled();
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[0, 1, 0, 1, "all", 0]]);
  });

  it("positive control: a cut pasted on its OWN sheet keeps the per-cell clear and the same-sheet relocation", async () => {
    await cutSheet1B1();
    book.activeIndex = 0;
    await pasteAt(5, 1);

    expect(api.clearCell.mock.calls).toEqual([[0, 1]]);
    expect(api.clearRangeWithOptions).not.toHaveBeenCalled();
    expect(api.relocateCellReferences.mock.calls).toEqual([[0, 1, 0, 1, 5, 1]]);
    expect(api.getSheets, "a same-sheet paste needs no sheet-list read").not.toHaveBeenCalled();
  });
});
