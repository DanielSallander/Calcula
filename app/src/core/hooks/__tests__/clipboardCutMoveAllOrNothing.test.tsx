//! FILENAME: app/src/core/hooks/__tests__/clipboardCutMoveAllOrNothing.test.tsx
// PURPOSE: A cut's paste is a MOVE, all or nothing. When the source cannot be
//          emptied -- a protected source sheet, part of a spill, a writeback
//          claim, a pivot -- or the relocation that makes it a move fails, the
//          paste is TAKEN BACK whole to the undo savepoint it marked before it
//          wrote, and the user is told nothing was pasted. Driven through the
//          REAL clipboard hook; the backend and the Tauri clipboard plugin are
//          doubles.
// CONTEXT: Bug-ledger fix programme round 8 (lane cutmode, review rev6A#5).
//          The cut's formulas are written UNSHIFTED, which is right only
//          because the relocation re-points them afterwards. When the off-sheet
//          clear was refused the paste alerted "copied rather than moved" and
//          skipped the relocation, so Sheet1!A1:A2 (7, =A1+B5) cut on a
//          protected Sheet1 and pasted on Sheet2 at D4 left Sheet2!D5 = =A1+B5,
//          reading SHEET2's A1 and B5 -- neither a copy (=D4+E8) nor a move
//          (=D4+Sheet1!B5). On one sheet each refused clearCell was swallowed
//          and the relocation re-pointed references to cells that never moved.
//          Excel never moves half [LIVE, Excel 16, 2026-10-30,
//          cutmode/probe-refusals.ps1]: the Cut of a locked cell on a protected
//          sheet is refused, protecting the source after the cut ends cut mode
//          so the Paste does nothing, Range.Cut Destination onto another sheet
//          is refused whole, and a spill's child cell pastes nothing.

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
}));

/** The point the savepoint double hands out. */
const POINT = { transaction: 7, changes: 0 };

const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (_u: unknown[], _o?: unknown) => [] as unknown[]),
  clearCell: vi.fn(async (_row?: number, _col?: number) => {}),
  clearRangeWithOptions: vi.fn(async (..._a: unknown[]) => undefined as unknown),
  relocateCellReferences: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  getSheets: vi.fn(async () => ({ sheets: book.sheets, activeIndex: book.activeIndex })),
  beginUndoTransaction: vi.fn(async (_d?: string) => 7 as number | null),
  commitUndoTransaction: vi.fn(async (_t?: unknown) => {}),
  cancelUndoTransaction: vi.fn(async (_t?: unknown) => {}),
  // The paste's begin opened ticket 7; the savepoint door JOINS it (no ticket
  // of its own) and names the point in it.
  beginUndoSavepoint: vi.fn(async (_d?: string) => ({
    ticket: null as number | null,
    savepoint: { transaction: 7, changes: 0 } as { transaction: number; changes: number } | null,
    refused: null as string | null,
  })),
  rollBackToUndoSavepoint: vi.fn(async (_p?: unknown) => ({
    success: true as boolean,
    refusal: null as string | null,
    updatedCells: [] as unknown[],
    takenBackCells: [] as unknown[],
  })),
}));
const dialogs = vi.hoisted(() => ({
  alertAsync: vi.fn(async (_m?: string) => {}),
}));
const seam = vi.hoisted(() => ({
  getCellTargetCells: vi.fn(async () => ({ cells: [] as unknown[], merges: [], conditional: [], styles: [], rules: [] })),
  selectTargetCells: vi.fn(),
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

vi.mock("../../../api/cellTarget", () => seam);

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

import { useClipboard, getInternalClipboard, isCutModeLive, type UseClipboardReturn } from "../useClipboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection, setSheetContext } from "../../state/gridActions";
import type { CellTarget } from "../../lib/selectionOwner";
import type { GridState } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let hook: UseClipboardReturn;
let gridState: GridState;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  gridState = state;
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

/** The review's scenario: cut Sheet1!A1:A2 (7, =A1+B5) with Sheet1 active. */
async function cutSheet1A1A2(): Promise<void> {
  model.cells.set("0,0", { display: "7", formula: null, styleIndex: 0 });
  model.cells.set("1,0", { display: "7", formula: "=A1+B5", styleIndex: 0 });
  await onSheet(0, "Sheet1", "S1");
  await select(0, 0, 1, 0);
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

/** The paste was TAKEN BACK whole to its point, its step closed empty, and the user told. */
function expectTakenBack(why: string, reason: string): void {
  expect(api.updateCellsBatch, `${why}: precondition, the destination was written first`).toHaveBeenCalledTimes(1);
  expect(
    api.rollBackToUndoSavepoint.mock.calls,
    `${why}: the half move was left in place -- the pasted formulas were written unshifted for a move that never happened`,
  ).toEqual([[POINT]]);
  // Taken back AFTER the destination's write: everything the paste did goes.
  expect(api.rollBackToUndoSavepoint.mock.invocationCallOrder[0]).toBeGreaterThan(
    api.updateCellsBatch.mock.invocationCallOrder[0],
  );
  expect(api.commitUndoTransaction, `${why}: the half move was committed as an undo step`).not.toHaveBeenCalled();
  expect(api.cancelUndoTransaction.mock.calls, `${why}: the paste's own step was not closed`).toEqual([[7]]);
  const said = dialogs.alertAsync.mock.calls.map((c) => String(c[0]));
  expect(said, `${why}: the user was not told nothing was pasted`).toEqual([
    expect.stringContaining("nothing was pasted"),
  ]);
  expect(said[0]).toContain(reason);
  expect(said[0], `${why}: still called a copy`).not.toContain("copied");
  // The cut is over: its source refused the move.
  expect(isCutModeLive()).toBe(false);
  expect(getInternalClipboard()).toBeNull();
  expect(gridState.clipboard.mode).toBe("none");
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
  for (const fn of Object.values(api)) fn.mockClear();
  api.clearCell.mockReset();
  api.clearCell.mockImplementation(async () => {});
  api.clearRangeWithOptions.mockReset();
  api.clearRangeWithOptions.mockImplementation(async () => undefined);
  api.relocateCellReferences.mockReset();
  api.relocateCellReferences.mockImplementation(async () => []);
  api.beginUndoSavepoint.mockReset();
  api.beginUndoSavepoint.mockImplementation(async () => ({ ticket: null, savepoint: { ...POINT }, refused: null }));
  api.rollBackToUndoSavepoint.mockReset();
  api.rollBackToUndoSavepoint.mockImplementation(async () => ({
    success: true,
    refusal: null,
    updatedCells: [],
    takenBackCells: [],
  }));
  dialogs.alertAsync.mockClear();
  seam.getCellTargetCells.mockClear();
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
  await act(async () => {
    hook.clearClipboardState();
  });
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("a cut whose source refuses to be emptied is taken back whole (rev6A#5)", () => {
  it("the review's case: Sheet1 protected, pasted on Sheet2 at D4 -- the paste is taken back, nothing re-pointed", async () => {
    await cutSheet1A1A2();
    await onSheet(1, "Sheet2", "S2");
    api.clearRangeWithOptions.mockRejectedValueOnce(
      "The cell or chart you're trying to change is on a protected sheet.",
    );
    await pasteAt(3, 3);

    // The point was marked inside the paste's step, BEFORE anything was written.
    expect(api.beginUndoSavepoint).toHaveBeenCalledTimes(1);
    expect(api.beginUndoSavepoint.mock.invocationCallOrder[0]).toBeGreaterThan(
      api.beginUndoTransaction.mock.invocationCallOrder[0],
    );
    expect(api.beginUndoSavepoint.mock.invocationCallOrder[0]).toBeLessThan(
      api.updateCellsBatch.mock.invocationCallOrder[0],
    );
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[0, 0, 1, 0, "all", 0]]);
    expect(api.relocateCellReferences, "re-pointed references to cells that were never moved").not.toHaveBeenCalled();
    expectTakenBack("Sheet1 protected", "protected sheet");
  });

  it("on ONE sheet: the first refused clearCell (a spill's child) stops the clears and takes the paste back", async () => {
    model.cells.set("0,0", { display: "1", formula: null, styleIndex: 0 });
    model.cells.set("1,0", { display: "2", formula: null, styleIndex: 0 });
    model.cells.set("2,0", { display: "3", formula: null, styleIndex: 0 });
    await onSheet(0, "Sheet1", "S1");
    book.activeIndex = 0;
    await select(0, 0, 2, 0);
    await act(async () => {
      await hook.cut();
    });
    sys.text = sys.written.at(-1) ?? null;
    api.clearCell.mockImplementation(async (row?: number) => {
      if (row === 1) throw "We can't delete this value. The value contained in this cell is spilled from the formula in Z1.";
    });
    await pasteAt(0, 2);

    expect(api.clearCell.mock.calls, "the clears carried on past the refusal").toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(api.relocateCellReferences, "re-pointed references into cells that never moved").not.toHaveBeenCalled();
    expectTakenBack("a spill's child on the same sheet", "spilled");
  });

  it("a floating grid's cut whose source clear is refused (a claim) is taken back whole", async () => {
    seam.getCellTargetCells.mockResolvedValue({
      cells: [{ row: 1, col: 1, display: "moved", formula: null, styleIndex: 0 }],
      merges: [],
      conditional: [],
      styles: [],
      rules: [],
    });
    await onSheet(0, "Sheet1", "S1");
    const grid: CellTarget = {
      kind: "object",
      ownerId: "floatingRange",
      ref: { kind: "floatingRange", id: "fr-1" },
      selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" },
      bounds: { rows: 10, cols: 5 },
      label: "Float1",
      wholeObject: false,
    };
    await act(async () => {
      await hook.cut(undefined, { target: grid });
    });
    sys.text = sys.written.at(-1) ?? null;
    api.clearRangeWithOptions.mockRejectedValueOnce("This cell holds a writeback answer; clear this range is refused.");
    await pasteAt(4, 4);

    expect(api.clearRangeWithOptions).toHaveBeenCalledTimes(1);
    expectTakenBack("a floating grid's source", "writeback answer");
  });

  it("a relocation that fails after the source was cleared takes the whole move back too", async () => {
    await cutSheet1A1A2();
    await onSheet(1, "Sheet2", "S2");
    api.relocateCellReferences.mockRejectedValueOnce(
      "The sheet the cells were cut from (index 0) no longer exists; nothing was re-pointed.",
    );
    await pasteAt(3, 3);

    expect(api.clearRangeWithOptions).toHaveBeenCalledTimes(1);
    expect(api.relocateCellReferences).toHaveBeenCalledTimes(1);
    expectTakenBack("the relocation failed", "nothing was re-pointed");
  });

  it("when the take-back itself is refused, the paste stays ONE undo step and the user is told to undo it", async () => {
    await cutSheet1A1A2();
    await onSheet(1, "Sheet2", "S2");
    api.clearRangeWithOptions.mockRejectedValueOnce("Sheet1 is protected.");
    api.rollBackToUndoSavepoint.mockImplementationOnce(async () => ({
      success: false,
      refusal: "the undo step it was recorded in is no longer open",
      updatedCells: [],
      takenBackCells: [],
    }));
    await pasteAt(3, 3);

    expect(api.rollBackToUndoSavepoint).toHaveBeenCalledTimes(1);
    expect(api.commitUndoTransaction.mock.calls, "the half move was left outside any undo step").toEqual([[7]]);
    const said = dialogs.alertAsync.mock.calls.map((c) => String(c[0]));
    expect(said).toEqual([expect.stringContaining("Undo takes the paste back")]);
    expect(said[0]).toContain("Sheet1 is protected.");
    expect(said[0]).toContain("no longer open");
    expect(isCutModeLive()).toBe(false);
  });

  it("a cut whose step cannot carry a point is refused BEFORE anything is written, and stays pending", async () => {
    await cutSheet1A1A2();
    await onSheet(1, "Sheet2", "S2");
    api.beginUndoSavepoint.mockImplementationOnce(async () => ({
      ticket: null,
      savepoint: null,
      refused: "another macro you started holds the open undo step until it ends",
    }));
    await pasteAt(3, 3);

    expect(api.updateCellsBatch, "wrote a move that could not be taken back").not.toHaveBeenCalled();
    expect(api.clearRangeWithOptions).not.toHaveBeenCalled();
    expect(api.relocateCellReferences).not.toHaveBeenCalled();
    expect(api.commitUndoTransaction).not.toHaveBeenCalled();
    expect(api.cancelUndoTransaction.mock.calls).toEqual([[7]]);
    const said = dialogs.alertAsync.mock.calls.map((c) => String(c[0]));
    expect(said).toEqual([expect.stringContaining("Nothing was pasted")]);
    expect(said[0]).toContain("another macro you started");
    // Nothing about the source refused it: the cut is still there to paste.
    expect(isCutModeLive()).toBe(true);
  });

  it("a savepoint begin that OPENED a step (the paste's own closed underneath) closes it and refuses", async () => {
    await cutSheet1A1A2();
    await onSheet(1, "Sheet2", "S2");
    api.beginUndoSavepoint.mockImplementationOnce(async () => ({
      ticket: 31,
      savepoint: { transaction: 31, changes: 0 },
      refused: null,
    }));
    await pasteAt(3, 3);

    expect(api.updateCellsBatch).not.toHaveBeenCalled();
    expect(api.cancelUndoTransaction, "the step the savepoint begin opened was left open").toHaveBeenCalledWith(31);
  });

  it("positive control: a move whose source clears takes nothing back and commits ONE step", async () => {
    await cutSheet1A1A2();
    await onSheet(1, "Sheet2", "S2");
    await pasteAt(3, 3);

    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.clearRangeWithOptions.mock.calls).toEqual([[0, 0, 1, 0, "all", 0]]);
    expect(api.relocateCellReferences.mock.calls).toEqual([[0, 0, 1, 0, 3, 3, 0]]);
    expect(api.rollBackToUndoSavepoint).not.toHaveBeenCalled();
    expect(api.commitUndoTransaction.mock.calls).toEqual([[7]]);
    expect(dialogs.alertAsync).not.toHaveBeenCalled();
  });

  it("positive control: a COPY marks no point (only a move is taken back)", async () => {
    model.cells.set("0,0", { display: "7", formula: null, styleIndex: 0 });
    await onSheet(0, "Sheet1", "S1");
    await select(0, 0);
    await act(async () => {
      await hook.copy();
    });
    sys.text = sys.written.at(-1) ?? null;
    await pasteAt(4, 4);

    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(api.beginUndoSavepoint).not.toHaveBeenCalled();
    expect(api.commitUndoTransaction.mock.calls).toEqual([[7]]);
  });
});

describe("the SAME-sheet move's relocation, and the move's announcement (round 10)", () => {
  /** Every CELLS_MOVED announced while `run` runs. */
  async function heardMoves(run: () => Promise<void>): Promise<unknown[]> {
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener("app:cells-moved", listen);
    try {
      await run();
    } finally {
      window.removeEventListener("app:cells-moved", listen);
    }
    return heard;
  }

  /** Cut Sheet1!A1:A2 with Sheet1 on screen (the paste stays on Sheet1). */
  async function cutOnSheet1(): Promise<void> {
    model.cells.set("0,0", { display: "7", formula: null, styleIndex: 0 });
    model.cells.set("1,0", { display: "7", formula: "=A1+B5", styleIndex: 0 });
    await onSheet(0, "Sheet1", "S1");
    book.activeIndex = 0;
    await select(0, 0, 1, 0);
    await act(async () => {
      await hook.cut();
    });
    sys.text = sys.written.at(-1) ?? null;
  }

  it("rev8B: a relocation refused AFTER a same-sheet cut's source was cleared takes the whole move back", async () => {
    await cutOnSheet1();
    api.relocateCellReferences.mockRejectedValueOnce("The relocation could not be recorded; nothing was re-pointed.");
    const heard = await heardMoves(() => pasteAt(2, 2));

    // The same-sheet branch: per-cell clears on the active sheet, then the relocation.
    expect(api.clearCell.mock.calls).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(api.clearRangeWithOptions).not.toHaveBeenCalled();
    expect(api.relocateCellReferences.mock.calls).toEqual([[0, 0, 1, 0, 2, 2]]);
    expectTakenBack("the same-sheet relocation failed", "nothing was re-pointed");
    expect(heard, "a move that was taken back was announced as moved").toEqual([]);
  });

  it("a committed Cut + Paste announces CELLS_MOVED: the block, the sheet it left and where it landed", async () => {
    await cutSheet1A1A2();
    await onSheet(1, "Sheet2", "S2");
    const heard = await heardMoves(() => pasteAt(3, 3));
    expect(api.commitUndoTransaction.mock.calls).toEqual([[7]]);
    expect(heard).toEqual([
      {
        moves: [
          {
            kind: "move",
            fromSheetIndex: 0,
            fromStartRow: 0,
            fromStartCol: 0,
            fromEndRow: 1,
            fromEndCol: 0,
            toSheetIndex: 1,
            toRow: 3,
            toCol: 3,
          },
        ],
        source: "edit",
      },
    ]);
  });

  it("a COPY's paste moves nothing and announces no move", async () => {
    model.cells.set("0,0", { display: "7", formula: null, styleIndex: 0 });
    await onSheet(0, "Sheet1", "S1");
    await select(0, 0);
    await act(async () => {
      await hook.copy();
    });
    sys.text = sys.written.at(-1) ?? null;
    const heard = await heardMoves(() => pasteAt(4, 4));
    expect(api.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
  });
});
