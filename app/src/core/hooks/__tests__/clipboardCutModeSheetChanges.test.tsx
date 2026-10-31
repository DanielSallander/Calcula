//! FILENAME: app/src/core/hooks/__tests__/clipboardCutModeSheetChanges.test.tsx
// PURPOSE: What a sheet change between Cut (or Copy) and Paste does, as Excel
//          does it: a RENAME keeps the mode and the paste spells the new name
//          (the snapshot is read again from its source); a sheet DELETED, MOVED
//          or COPIED ends it and the Paste pastes nothing; adding or hiding a
//          sheet keeps it, and the Paste still moves the cells. Driven through
//          the REAL tauri-api sheet wrappers (their announcements) and the REAL
//          clipboard hook; the IPC and the Tauri clipboard plugin are doubles.
// UPDATE:  Round 9 (lane clipexcel, BUG-0616 item 5 -- the owner's rule: when
//          Calcula and Excel differ, Excel wins). Round 8 ENDED the cut on a
//          rename and KEPT it on a move or a copy; both are now Excel's.
// CONTEXT: Bug-ledger fix programme round 8 (lane cutmode, review rev6A#6). A
//          cut stores its formulas as TEXT at the cut, and a rename repairs the
//          workbook's formulas but not that text: Sheet1!A2 =Sheet2!B1*2, Cut
//          A2, rename Sheet2 to Inputs, Paste at C2 -- C2 got =Sheet2!B1*2, a
//          #REF! (no such sheet), and A2 was emptied. Excel [LIVE, Excel 16,
//          2026-10-30, cutmode/probe-sheetlist.ps1] KEEPS cut mode across a
//          rename and moves the formula spelling the new name (=Inputs!B1*2);
//          this cut moves a snapshot, so a rename ENDS it instead (the
//          data-preserving choice, as round 7 decided for an undo). Excel ENDS
//          cut mode when any sheet is deleted, moved or copied, and keeps it
//          when one is added or hidden. A delete ends it here too; a move or a
//          copy changes no name and the source is found by its stable id, so
//          they keep it.

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
/** The system clipboard: what readText answers, and every write made to it. */
const sys = vi.hoisted(() => ({ text: null as string | null }));

/** The backend's sheet list, as the sheet commands change it. */
const backend = vi.hoisted(() => {
  interface Sheet {
    name: string;
    sheetId: string;
    visibility: string;
  }
  const b = {
    sheets: [] as Sheet[],
    activeIndex: 0,
    list() {
      return {
        sheets: b.sheets.map((s, index) => ({ index, name: s.name, sheetId: s.sheetId, visibility: s.visibility })),
        activeIndex: b.activeIndex,
      };
    },
    reset() {
      b.sheets = [
        { name: "Sheet1", sheetId: "S1", visibility: "visible" },
        { name: "Sheet2", sheetId: "S2", visibility: "visible" },
        { name: "Sheet3", sheetId: "S3", visibility: "visible" },
      ];
      b.activeIndex = 0;
    },
  };
  return b;
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "get_sheets":
        return backend.list();
      case "get_active_sheet":
        return backend.activeIndex;
      case "rename_sheet": {
        // The backend repairs every formula naming the sheet (here: Sheet1's cells).
        const oldName = backend.sheets[a.index as number].name;
        backend.sheets[a.index as number].name = a.newName as string;
        for (const cell of model.cells.values()) {
          if (cell.formula) cell.formula = cell.formula.split(`${oldName}!`).join(`${a.newName as string}!`);
        }
        return backend.list();
      }
      case "delete_sheet":
        backend.sheets.splice(a.index as number, 1);
        return backend.list();
      case "add_sheet":
        backend.sheets.push({ name: `Sheet${backend.sheets.length + 1}`, sheetId: "S9", visibility: "visible" });
        return backend.list();
      case "copy_sheet": {
        const from = backend.sheets[a.sourceIndex as number];
        backend.sheets.push({ name: `${from.name} (2)`, sheetId: "S8", visibility: "visible" });
        return backend.list();
      }
      case "move_sheet": {
        const [moved] = backend.sheets.splice(a.fromIndex as number, 1);
        backend.sheets.splice(a.toIndex as number, 0, moved);
        return backend.list();
      }
      case "hide_sheet":
        backend.sheets[a.index as number].visibility = "hidden";
        return backend.list();
      default:
        throw new Error(`no backend for ${cmd} in this double`);
    }
  }),
}));

const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (_u: unknown[], _o?: unknown) => [] as unknown[]),
  clearCell: vi.fn(async (_row?: number, _col?: number) => {}),
  relocateCellReferences: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));

function cellData(row: number, col: number): unknown {
  const cell = model.cells.get(`${row},${col}`);
  return cell ? { row, col, display: cell.display, formula: cell.formula, styleIndex: cell.styleIndex } : null;
}

// The CELL commands are doubles; the SHEET wrappers (renameSheet, deleteSheet,
// addSheet, moveSheet, copySheet, hideSheet) are the real ones, over the IPC
// double above, so their own announcements are what the cut hears.
vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async () => 7),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  beginUndoSavepoint: vi.fn(async () => ({ ticket: null, savepoint: { transaction: 7, changes: 0 } })),
  rollBackToUndoSavepoint: vi.fn(async () => ({ success: true })),
  updateCellsBatch: (u: unknown[], o?: unknown) => api.updateCellsBatch(u, o),
  clearCell: (row: number, col: number) => api.clearCell(row, col),
  relocateCellReferences: (...args: unknown[]) => api.relocateCellReferences(...args),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
  // The sheet-addressed reads a stale snapshot is read again through: Sheet1
  // (id S1) holds the model's cells, wherever it stands; every other sheet is empty.
  getWatchCells: vi.fn(async (requests: [number, number, number][]) =>
    requests.map(([sheet, row, col]) => (backend.sheets[sheet]?.sheetId === "S1" ? cellData(row, col) : null)),
  ),
  getRangeCellsTyped: vi.fn(async (r0: number, c0: number, r1: number, c1: number, sheet?: number) => {
    const out: unknown[] = [];
    if (backend.sheets[sheet ?? backend.activeIndex]?.sheetId !== "S1") return out;
    for (const [key, cell] of model.cells) {
      const [row, col] = key.split(",").map(Number);
      if (row < r0 || row > r1 || col < c0 || col > c1) continue;
      const n = Number(cell.display);
      out.push({ row, col, display: cell.display, formula: cell.formula, type: Number.isFinite(n) ? "number" : "text", value: Number.isFinite(n) ? n : cell.display });
    }
    return out;
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
    sys.text = t;
  }),
  writeHtml: vi.fn(async (_html: string, t: string) => {
    sys.text = t;
  }),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));

import { useClipboard, getInternalClipboard, isCutModeLive, type UseClipboardReturn } from "../useClipboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection, setSheetContext } from "../../state/gridActions";
import { renameSheet, deleteSheet, addSheet, moveSheet, copySheet, hideSheet } from "../../lib/tauri-api";
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function select(r0: number, c0: number): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: r0, startCol: c0, endRow: r0, endCol: c0, type: "cells" }));
  });
  await settle();
}

/** The review's cell: Sheet1!A2 =Sheet2!B1*2 (showing 42), cut. */
async function cutA2(): Promise<void> {
  model.cells.set("1,0", { display: "42", formula: "=Sheet2!B1*2", styleIndex: 0 });
  await select(1, 0);
  await act(async () => {
    await clipboard.cut();
  });
  await settle();
  expect(isCutModeLive(), "precondition: the cut is pending").toBe(true);
  expect(gridState.clipboard.mode).toBe("cut");
}

async function pasteAtC2(): Promise<void> {
  await select(1, 2);
  await act(async () => {
    await clipboard.paste();
  });
  await settle();
}

async function change(run: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await run();
  });
  await settle();
}

/** The sheet change ENDED the cut, and the Paste after it pasted nothing. */
async function expectEndedAndNothingPasted(why: string): Promise<void> {
  expect(isCutModeLive(), `${why}: the cut is still a pending move of a stale snapshot`).toBe(false);
  expect(getInternalClipboard()).toBeNull();
  expect(gridState.clipboard.mode, `${why}: the marching ants stayed up`).toBe("none");
  await pasteAtC2();
  expect(api.updateCellsBatch, `${why}: the paste wrote the cut's stale formula text`).not.toHaveBeenCalled();
  expect(api.clearCell, `${why}: the paste emptied the cut's source`).not.toHaveBeenCalled();
}

/** The sheet change KEPT the cut, and the Paste still moved A2 to C2. */
async function expectKeptAndMoved(why: string): Promise<void> {
  expect(isCutModeLive(), `${why}: ended the cut`).toBe(true);
  await pasteAtC2();
  expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
  const [updates] = api.updateCellsBatch.mock.calls[0] as unknown as [Array<{ row: number; col: number; value: string }>];
  expect(updates.map((u) => [u.row, u.col, u.value])).toEqual([[1, 2, "=Sheet2!B1*2"]]);
  expect(api.clearCell.mock.calls).toEqual([[1, 0]]);
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  model.cells.clear();
  sys.text = null;
  backend.reset();
  for (const fn of Object.values(api)) fn.mockClear();
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

/** The rename KEPT the cut (Excel's), and the Paste moved A2 to C2 spelling the formula `formula`. */
async function expectKeptAndMovedAs(why: string, formula: string): Promise<void> {
  expect(isCutModeLive(), `${why}: ended the cut (Excel keeps cut mode across a rename)`).toBe(true);
  expect(gridState.clipboard.mode).toBe("cut");
  await pasteAtC2();
  expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
  const [updates] = api.updateCellsBatch.mock.calls[0] as unknown as [Array<{ row: number; col: number; value: string }>];
  expect(
    updates.map((u) => [u.row, u.col, u.value]),
    `${why}: the paste wrote the snapshot's stale formula text (a #REF! in the workbook)`,
  ).toEqual([[1, 2, formula]]);
  expect(api.clearCell.mock.calls).toEqual([[1, 0]]);
}

// BUG-0616 item 5 / the endings round 8 chose against Excel. Excel 16 [LIVE,
// 2026-10-30, clipexcel/probe-copy.ps1] KEEPS cut mode across a rename of the
// source sheet or of another one, and the paste spells the new name. Round 8
// ENDED the cut instead (its snapshot held the old spelling); the snapshot is
// now read again from its source after a rename (useClipboard.ts CLIPBOARD MODE).
describe("a sheet renamed between Cut and Paste keeps the cut, and the paste spells the new name", () => {
  it("the review's case: Sheet2 renamed to Inputs -- the paste writes =Inputs!B1*2, never =Sheet2!B1*2", async () => {
    await cutA2();
    await change(() => renameSheet(1, "Inputs"));
    expect(backend.sheets[1].name, "precondition: the rename landed").toBe("Inputs");
    await expectKeptAndMovedAs("Sheet2 renamed", "=Inputs!B1*2");
  });

  it("the cut's OWN sheet renamed: a formula naming it (=Sheet1!B5) moves as =Src!B5", async () => {
    model.cells.set("1,0", { display: "3", formula: "=Sheet1!B5", styleIndex: 0 });
    await select(1, 0);
    await act(async () => {
      await clipboard.cut();
    });
    await settle();
    await change(() => renameSheet(0, "Src"));
    await expectKeptAndMovedAs("Sheet1 renamed", "=Src!B5");
  });

  it("a COPY across a rename pastes the new name as well (Excel: =Inputs!E1*2 after the copy's shift)", async () => {
    model.cells.set("1,0", { display: "42", formula: "=Sheet2!B1*2", styleIndex: 0 });
    await select(1, 0);
    await act(async () => {
      await clipboard.copy();
    });
    await settle();
    await change(() => renameSheet(1, "Inputs"));
    expect(getInternalClipboard(), "the rename ended the copy").not.toBeNull();
    await pasteAtC2();
    const [updates] = api.updateCellsBatch.mock.calls[0] as unknown as [Array<{ row: number; col: number; value: string }>];
    expect(updates.map((u) => [u.row, u.col, u.value])).toEqual([[1, 2, "=Inputs!B1*2"]]);
    expect(api.clearCell).not.toHaveBeenCalled();
  });
});

describe("a sheet deleted, moved or copied between Cut and Paste ends the cut, as Excel does", () => {
  it("a THIRD sheet deleted ends it", async () => {
    await cutA2();
    await change(() => deleteSheet(2));
    expect(backend.sheets.map((s) => s.name), "precondition: the delete landed").toEqual(["Sheet1", "Sheet2"]);
    await expectEndedAndNothingPasted("Sheet3 deleted");
  });

  // Round 8 kept the cut across a move and a copy (no name changes); Excel
  // [LIVE] ends cut mode on both, and Excel wins.
  it("a sheet MOVED ends it (the move as the tab strip and the script door announce it)", async () => {
    await cutA2();
    await change(async () => {
      await moveSheet(2, 1);
      window.dispatchEvent(new CustomEvent("sheet:reorder", { detail: { fromIndex: 2, toIndex: 1 } }));
    });
    expect(backend.sheets.map((s) => s.name), "precondition: the move landed").toEqual(["Sheet1", "Sheet3", "Sheet2"]);
    await expectEndedAndNothingPasted("Sheet3 moved");
  });

  it("a sheet COPIED ends it", async () => {
    await cutA2();
    await change(() => copySheet(1));
    await expectEndedAndNothingPasted("Sheet2 copied");
  });
});

describe("the sheet changes that keep the cut, and the Paste still moves it", () => {
  it("a sheet ADDED keeps it (Excel keeps it too)", async () => {
    await cutA2();
    await change(() => addSheet());
    await expectKeptAndMoved("a sheet added");
  });

  it("a sheet HIDDEN keeps it (Excel keeps it too)", async () => {
    await cutA2();
    await change(() => hideSheet(2));
    await expectKeptAndMoved("Sheet3 hidden");
  });

  it("a sheet INSERTED before the source keeps it (its sheet:reorder is an insertion, not a move)", async () => {
    await cutA2();
    await change(async () => {
      await addSheet();
      window.dispatchEvent(
        new CustomEvent("sheet:reorder", { detail: { fromIndex: Number.MAX_SAFE_INTEGER, toIndex: 0 } }),
      );
    });
    await expectKeptAndMoved("a sheet inserted");
  });
});
