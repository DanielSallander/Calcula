//! FILENAME: app/src/core/hooks/__tests__/clipboardMoveRelocation.test.tsx
// PURPOSE: A MOVE (drag-move of cells, rows or columns; Cut + Paste) writes the
//          moved formulas UNSHIFTED and leaves the re-pointing to
//          relocateCellReferences -- through the REAL clipboard hook.
// CONTEXT: Bug-ledger fix programme, round 5 (NEW-drag-move-shifts-outside-refs).
//          The drag-move shifted every relative reference of a moved formula by
//          the move's offset, so =A1 moved from B1 to B2 became =A2. Excel's move
//          (Range.Cut Destination, measured live 2026-10-29) keeps every
//          reference to a cell OUTSIDE the moved block (=A1 stays =A1) and
//          re-points only the references INTO it (B1:C1 = (=A1, =B1) moved to
//          B3 gives =A1 and =B3), on every sheet and in defined names -- which
//          the backend relocation now does (Rust: move_relocation_tests.rs).
//          Cut + Paste wrote its formulas unshifted already but never
//          relocated anything, so a formula reading a cut cell kept naming the
//          emptied source. The backend and the Tauri clipboard plugin are doubles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface ModelCell {
  display: string;
  formula: string | null;
  styleIndex: number;
}

/** The sheet the doubles serve: "row,col" -> cell. A missing key is an EMPTY cell. */
const model = vi.hoisted(() => ({ cells: new Map<string, ModelCell>() }));
const sys = vi.hoisted(() => ({ text: null as string | null, written: [] as string[] }));

const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (_u: unknown[], _o?: unknown) => [] as unknown[]),
  updateCell: vi.fn(async (_row: number, _col: number, _value: string) => ({ cells: [], dimensionChanges: [] })),
  clearCell: vi.fn(async (_row?: number, _col?: number) => {}),
  relocateCellReferences: vi.fn(async (..._args: number[]) => [] as unknown[]),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string; rowDelta: number; colDelta: number }[]) =>
    // A shifted formula says by how much, so a test sees that it was shifted.
    inputs.map((i) => (i.rowDelta || i.colDelta ? i.formula + "@" + i.rowDelta + "," + i.colDelta : i.formula)),
  ),
}));

function cellData(row: number, col: number): unknown {
  const cell = model.cells.get(`${row},${col}`);
  return cell ? { row, col, display: cell.display, formula: cell.formula, styleIndex: cell.styleIndex } : null;
}

function sparse(r0: number, r1: number, byCol = false): unknown[] {
  const out: unknown[] = [];
  for (const key of model.cells.keys()) {
    const [row, col] = key.split(",").map(Number);
    const at = byCol ? col : row;
    if (at >= r0 && at <= r1) out.push(cellData(row, col));
  }
  return out;
}

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async () => 7),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  // A cut's paste marks the point it is taken back to when the move cannot
  // finish (round 8, rev6A#5): the door joins the paste's step 7.
  beginUndoSavepoint: vi.fn(async () => ({ ticket: null, savepoint: { transaction: 7, changes: 0 } })),
  rollBackToUndoSavepoint: vi.fn(async () => ({ success: true })),
  updateCellsBatch: (u: unknown[], o?: unknown) => api.updateCellsBatch(u, o),
  updateCell: (row: number, col: number, value: string) => api.updateCell(row, col, value),
  clearCell: (row: number, col: number) => api.clearCell(row, col),
  relocateCellReferences: (...args: number[]) => api.relocateCellReferences(...args),
  shiftFormulasBatch: (inputs: { formula: string; rowDelta: number; colDelta: number }[]) => api.shiftFormulasBatch(inputs),
  applyFormatting: vi.fn(async () => ({ cells: [], styles: [] })),
  getStyle: vi.fn(async () => ({ numberFormat: "General" })),
  // No typed read: every constant falls back to its display, which is all
  // these tests need (they are about FORMULAS).
  getRangeCellsTyped: vi.fn(async () => {
    throw new Error("no typed read in this double");
  }),
  getCell: vi.fn(async (row: number, col: number) => cellData(row, col)),
  getViewportCells: vi.fn(async (r0: number, c0: number, r1: number, c1: number) => {
    const out: unknown[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = cellData(r, c);
        if (cell) out.push(cell);
      }
    }
    return out;
  }),
  getAllComments: vi.fn(async () => []),
  getAllDataValidations: vi.fn(async () => []),
  getCellsInRows: vi.fn(async (r0: number, r1: number) => sparse(r0, r1)),
  getCellsInCols: vi.fn(async (c0: number, c1: number) => sparse(c0, c1, true)),
  hasContentInRange: vi.fn(async () => false),
  clearRange: vi.fn(async () => 0),
  setCellStyle: vi.fn(async () => null),
  getCollectionTexts: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getDataValidation: vi.fn(async () => null),
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
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));

import {
  useClipboard,
  getInternalClipboard,
  MOVE_PAST_THE_EDGE,
  PASTE_PAST_THE_EDGE,
  type UseClipboardReturn,
} from "../useClipboard";
import * as tauriApi from "../../lib/tauri-api";
import * as dialogs from "../../lib/dialogs";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection } from "../../state/gridActions";
import { AppEvents as ApiAppEvents } from "../../../api/events";
import { followCell } from "../../../api/structuralFollow";
import type { StructuralMoveDelta } from "../../types";

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

async function select(r0: number, c0: number, r1 = r0, c1 = c0): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }));
  });
  await settle();
}

type Update = { row: number; col: number; value: string };

/** Every value a gesture wrote: batch updates and per-cell updateCell entries. */
function writes(): Update[] {
  const batched = api.updateCellsBatch.mock.calls.flatMap((c) => c[0] as Update[]).map(({ row, col, value }) => ({ row, col, value }));
  const single = api.updateCell.mock.calls.map(([row, col, value]) => ({ row, col, value }));
  return [...batched, ...single];
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  model.cells.clear();
  sys.text = null;
  sys.written = [];
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
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("a drag-MOVE writes the moved formulas unshifted and relocates the block", () => {
  it("moving B1:C1 (=A1, =B1) to B3 writes =A1 and =B1 as they are, then re-points the block B1:C1 -> B3", async () => {
    model.cells.set("0,1", { display: "5", formula: "=A1", styleIndex: 0 });
    model.cells.set("0,2", { display: "5", formula: "=B1", styleIndex: 0 });
    await act(async () => {
      await hook.moveCells({ startRow: 0, startCol: 1, endRow: 0, endCol: 2, type: "cells" }, 2, 1);
    });
    expect(
      writes(),
      "a moved formula was SHIFTED: Excel keeps =A1 (a reference outside the block) and the relocation re-points =B1",
    ).toEqual([
      { row: 2, col: 1, value: "=A1" },
      { row: 2, col: 2, value: "=B1" },
    ]);
    expect(api.shiftFormulasBatch).not.toHaveBeenCalled();
    expect(api.relocateCellReferences).toHaveBeenCalledWith(0, 1, 0, 2, 2, 1);
    // The relocation runs after the destination is written and the source cleared.
    expect(api.relocateCellReferences.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...api.updateCell.mock.invocationCallOrder, ...api.clearCell.mock.invocationCallOrder),
    );
  });

  it("moving a ROW writes its formulas unshifted and relocates the whole row", async () => {
    model.cells.set("0,1", { display: "5", formula: "=A1", styleIndex: 0 });
    await act(async () => {
      await hook.moveRows(0, 0, 5);
    });
    expect(writes()).toEqual([{ row: 5, col: 1, value: "=A1" }]);
    expect(api.shiftFormulasBatch).not.toHaveBeenCalled();
    const [r0, c0, r1, c1, tr, tc] = api.relocateCellReferences.mock.calls[0] ?? [];
    expect([r0, c0, r1, tr, tc]).toEqual([0, 0, 0, 5, 0]);
    expect(c1).toBeGreaterThan(0);
  });

  it("moving a COLUMN writes its formulas unshifted and relocates the whole column", async () => {
    model.cells.set("0,1", { display: "5", formula: "=A1", styleIndex: 0 });
    await act(async () => {
      await hook.moveColumns(1, 1, 4);
    });
    expect(writes()).toEqual([{ row: 0, col: 4, value: "=A1" }]);
    expect(api.shiftFormulasBatch).not.toHaveBeenCalled();
    const [r0, c0, r1, c1, tr, tc] = api.relocateCellReferences.mock.calls[0] ?? [];
    expect([r0, c0, c1, tr, tc]).toEqual([0, 1, 1, 0, 4]);
    expect(r1).toBeGreaterThan(0);
  });
});

describe("Cut + Paste is a move too", () => {
  async function cutAndPaste(): Promise<void> {
    model.cells.set("0,1", { display: "5", formula: "=A1", styleIndex: 0 });
    await select(0, 1);
    await act(async () => {
      await hook.cut();
    });
    sys.text = sys.written.at(-1) ?? null;
    await select(5, 1);
    await act(async () => {
      await hook.paste();
    });
    await settle();
  }

  it("the pasted formula is written unshifted and the cut cell's references are re-pointed to where it landed", async () => {
    await cutAndPaste();
    expect(writes()).toEqual([{ row: 5, col: 1, value: "=A1" }]);
    expect(
      api.relocateCellReferences,
      "a Cut + Paste never relocated: a formula reading the cut cell kept naming the emptied source",
    ).toHaveBeenCalledWith(0, 1, 0, 1, 5, 1);
    expect(api.relocateCellReferences.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...api.clearCell.mock.invocationCallOrder),
    );
  });

  it("positive control: Copy + Paste shifts the pasted formula and relocates nothing", async () => {
    model.cells.set("0,1", { display: "5", formula: "=A1", styleIndex: 0 });
    await select(0, 1);
    await act(async () => {
      await hook.copy();
    });
    sys.text = sys.written.at(-1) ?? null;
    await select(5, 1);
    await act(async () => {
      await hook.paste();
    });
    await settle();
    expect(writes()).toEqual([{ row: 5, col: 1, value: "=A1@5,0" }]);
    expect(api.relocateCellReferences).not.toHaveBeenCalled();
  });
});

// Round 11 (lane clip3, structdelta NEW-row-column-reorder-not-followed): a
// drag of whole rows or columns is Excel's MOVE of a block -- it OVERWRITES
// the lines it lands on, and the lines it passes over stay where they are
// [LIVE 2026-10-30, clip3/probe-rowmove-watch.ps1: Range("3:4").Cut
// Range("A10") moves the watches on C3/C4 to C10/C11, keeps C6's, removes the
// ones on C10/C11, and =C10 becomes #REF!]. It used to announce nothing and
// tell the backend not to record the move (`recordMove: false`), so a watch or
// a bookmark on a dragged row stayed behind, and so did its Undo.
describe("a drag of whole rows or columns is followed like any moved block", () => {
  function movedAnnouncements(): Array<{ moves: Array<Record<string, unknown>>; source: string }> {
    const seen: Array<{ moves: Array<Record<string, unknown>>; source: string }> = [];
    window.addEventListener(ApiAppEvents.CELLS_MOVED, (e) => {
      seen.push((e as CustomEvent).detail);
    });
    return seen;
  }

  it("moving rows records the move with the backend and announces CELLS_MOVED for the whole rows", async () => {
    const seen = movedAnnouncements();
    model.cells.set("2,2", { display: "c3", formula: null, styleIndex: 0 });
    await act(async () => {
      await hook.moveRows(2, 3, 9);
    });
    await settle();
    const call = api.relocateCellReferences.mock.calls[0] ?? [];
    expect(call.length, "the relocation was told not to record the move (a row drag is a block move)").toBe(6);
    expect(seen.length, "the row drag announced no CELLS_MOVED: a watch on C3 stays behind").toBe(1);
    const [move] = seen[0].moves;
    expect(seen[0].source).toBe("edit");
    expect(move).toMatchObject({
      kind: "move",
      fromSheetIndex: 0,
      fromStartRow: 2,
      fromEndRow: 3,
      fromStartCol: 0,
      toSheetIndex: 0,
      toRow: 9,
      toCol: 0,
    });
    // [LIVE] what a follower then does with it: C3 lands on C10, C6 (passed
    // over) stays, C10 (overwritten) is gone.
    const m = move as unknown as StructuralMoveDelta;
    expect(followCell(m, 0, 2, 2)).toEqual({ sheetIndex: 0, row: 9, col: 2 });
    expect(followCell(m, 0, 5, 2)).toEqual({ sheetIndex: 0, row: 5, col: 2 });
    expect(followCell(m, 0, 9, 2)).toBeNull();
  });

  it("moving columns records the move and announces CELLS_MOVED for the whole columns", async () => {
    const seen = movedAnnouncements();
    model.cells.set("0,1", { display: "5", formula: null, styleIndex: 0 });
    await act(async () => {
      await hook.moveColumns(1, 1, 4);
    });
    await settle();
    expect((api.relocateCellReferences.mock.calls[0] ?? []).length, "the column drag was told not to record the move").toBe(6);
    expect(seen.length, "the column drag announced no CELLS_MOVED").toBe(1);
    expect(seen[0].moves[0]).toMatchObject({ fromStartRow: 0, fromStartCol: 1, fromEndCol: 1, toRow: 0, toCol: 4 });
  });
});

// Round 12 (lane clip4), reviewer rev10A's minors on round 10:
//  - a drag-move SWALLOWED a refused relocation (or a refused source clear),
//    committed and still announced CELLS_MOVED; a refused destination write
//    was CANCELLED, which drops the undo record and keeps the writes. A move
//    is now all or nothing, as a cut's paste is: every refusal takes the whole
//    gesture back to the point marked before it wrote, and nothing is
//    announced.
//  - a drag or paste that ran past the grid's last row wrote the part that
//    fit, cleared the WHOLE source and announced the WHOLE block as moved.
//    Excel refuses it [LIVE 2026-10-30, clip4/probe-edge.ps1]: A1:A3 copied
//    and pasted at D1048575 -> "You can't paste this here because the Copy
//    area and paste area aren't the same size"; Range("A1:A3").Cut
//    Range("B1048575") -> "This selection isn't valid", A1 untouched.
describe("a move is all or nothing, and nothing lands past the sheet's edge", () => {
  const LAST_ROW = 1_048_575;

  beforeEach(() => {
    vi.mocked(tauriApi.rollBackToUndoSavepoint).mockClear();
    vi.mocked(tauriApi.commitUndoTransaction).mockClear();
    vi.mocked(tauriApi.cancelUndoTransaction).mockClear();
    vi.mocked(dialogs.alertAsync).mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      hook.clearClipboardState();
    });
  });

  function movedAnnouncements(): unknown[] {
    const seen: unknown[] = [];
    window.addEventListener(ApiAppEvents.CELLS_MOVED, (e) => {
      seen.push((e as CustomEvent).detail);
    });
    return seen;
  }

  it("a REFUSED relocation takes the whole drag back: rolled back, never committed, no CELLS_MOVED", async () => {
    const seen = movedAnnouncements();
    model.cells.set("0,1", { display: "5", formula: null, styleIndex: 0 });
    api.relocateCellReferences.mockRejectedValueOnce(new Error("the relocation was refused"));
    await act(async () => {
      await hook.moveCells({ startRow: 0, startCol: 1, endRow: 0, endCol: 1, type: "cells" }, 4, 1);
    });
    await settle();
    expect(vi.mocked(tauriApi.rollBackToUndoSavepoint), "the refused move was not taken back").toHaveBeenCalledWith({
      transaction: 7,
      changes: 0,
    });
    expect(vi.mocked(tauriApi.commitUndoTransaction), "a refused move was committed").not.toHaveBeenCalled();
    expect(seen, "a move that was taken back announced CELLS_MOVED").toEqual([]);
    expect(vi.mocked(dialogs.alertAsync).mock.calls.at(-1)?.[0]).toContain("the relocation was refused");
  });

  it("a REFUSED source clear takes the whole drag back too (it used to be swallowed)", async () => {
    const seen = movedAnnouncements();
    model.cells.set("0,1", { display: "5", formula: null, styleIndex: 0 });
    api.clearCell.mockRejectedValueOnce(new Error("the cell is locked"));
    await act(async () => {
      await hook.moveCells({ startRow: 0, startCol: 1, endRow: 0, endCol: 1, type: "cells" }, 4, 1);
    });
    await settle();
    expect(vi.mocked(tauriApi.rollBackToUndoSavepoint)).toHaveBeenCalledTimes(1);
    expect(api.relocateCellReferences, "the move went on after its source refused").not.toHaveBeenCalled();
    expect(vi.mocked(tauriApi.commitUndoTransaction)).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("control: a drag that succeeds commits and announces the move it made", async () => {
    const seen = movedAnnouncements();
    model.cells.set("0,1", { display: "5", formula: null, styleIndex: 0 });
    await act(async () => {
      await hook.moveCells({ startRow: 0, startCol: 1, endRow: 0, endCol: 1, type: "cells" }, 4, 1);
    });
    await settle();
    expect(vi.mocked(tauriApi.rollBackToUndoSavepoint)).not.toHaveBeenCalled();
    expect(vi.mocked(tauriApi.commitUndoTransaction)).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it("[LIVE] a drag whose block would run past the last row is refused whole: nothing written, cleared or announced", async () => {
    const seen = movedAnnouncements();
    model.cells.set("0,1", { display: "a1", formula: null, styleIndex: 0 });
    model.cells.set("2,1", { display: "a3", formula: null, styleIndex: 0 });
    await act(async () => {
      await hook.moveCells({ startRow: 0, startCol: 1, endRow: 2, endCol: 1, type: "cells" }, LAST_ROW - 1, 1);
    });
    await settle();
    expect(writes(), "the part that fit was written").toEqual([]);
    expect(api.clearCell, "the source was cleared: the overhanging cells were lost").not.toHaveBeenCalled();
    expect(seen, "a block that landed nowhere was announced as moved").toEqual([]);
    expect(vi.mocked(dialogs.alertAsync)).toHaveBeenCalledWith(MOVE_PAST_THE_EDGE);
  });

  it("[LIVE] a CUT pasted where it would run past the last row is refused whole, and the cut stays pending", async () => {
    const seen = movedAnnouncements();
    model.cells.set("0,1", { display: "a1", formula: null, styleIndex: 0 });
    model.cells.set("2,1", { display: "a3", formula: null, styleIndex: 0 });
    await select(0, 1, 2, 1);
    await act(async () => {
      await hook.cut();
    });
    sys.text = sys.written.at(-1) ?? null;
    await select(LAST_ROW - 1, 1);
    await act(async () => {
      await hook.paste();
    });
    await settle();
    expect(writes()).toEqual([]);
    expect(api.clearCell).not.toHaveBeenCalled();
    expect(api.relocateCellReferences).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(vi.mocked(dialogs.alertAsync)).toHaveBeenCalledWith(MOVE_PAST_THE_EDGE);
    expect(getInternalClipboard()?.isCut, "a refused paste ended the cut").toBe(true);
  });

  it("[LIVE] a COPY pasted where it would run past the last row is refused whole; at a row where it fits it pastes", async () => {
    model.cells.set("0,1", { display: "a1", formula: null, styleIndex: 0 });
    await select(0, 1, 2, 1);
    await act(async () => {
      await hook.copy();
    });
    sys.text = sys.written.at(-1) ?? null;
    await select(LAST_ROW - 1, 1);
    await act(async () => {
      await hook.paste();
    });
    await settle();
    expect(writes()).toEqual([]);
    expect(vi.mocked(dialogs.alertAsync)).toHaveBeenCalledWith(PASTE_PAST_THE_EDGE);
    await select(LAST_ROW - 2, 1);
    await act(async () => {
      await hook.paste();
    });
    await settle();
    expect(writes().map((w) => w.row)).toEqual([LAST_ROW - 2, LAST_ROW - 1, LAST_ROW]);
  });
});
