//! FILENAME: app/src/core/hooks/__tests__/clipboardPasteTiles.test.tsx
// PURPOSE: Paste TILES a copy into a selection that is an exact multiple of it,
//          as Excel does -- through the REAL clipboard hook -- and a row or
//          column drag whose relocation was refused announces no move.
// CONTEXT: Bug-ledger fix programme, round 13 (lane clip5): clip4's
//          NEW-paste-does-not-tile and rev11B's nit on moveRows / moveColumns.
//          Live Excel 16 [2026-10-30, fresh instances over COM,
//          clip5/probe-tile.ps1 and probe-f.ps1]: F6 copied into H1:H3 -> f6
//          three times; F1:F2 into H1:H4 -> f1,f2,f1,f2; F1:G2 into H1:K4 -> a
//          2x2 of the block; F1:F2 into H1:H3 -> ONCE; F1:G2 into H1:J4 (rows a
//          multiple, columns not) -> ONCE; a copied formula moves its relative
//          references per tile (B1 =A1*2 into D1:D3 -> =C1*2, =C2*2, =C3*2); a
//          selection holding a merged cell -> ONCE; a cut into a larger
//          selection is refused, never tiled. Calcula pasted every copy once
//          at the selection's top-left. The backend and the Tauri clipboard
//          plugin are doubles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface ModelCell {
  display: string;
  formula: string | null;
  styleIndex: number;
}

/** The sheet the doubles serve: "row,col" -> cell, and its merged regions. */
const model = vi.hoisted(() => ({
  cells: new Map<string, ModelCell>(),
  merges: [] as Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>,
}));

const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (_u: unknown[], _o?: unknown) => [] as unknown[]),
  relocateCellReferences: vi.fn(async (..._args: number[]) => [] as unknown[]),
  clearCell: vi.fn(async (_row?: number, _col?: number) => {}),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string; rowDelta: number; colDelta: number }[]) =>
    // A shifted formula says by how much, so a test sees each tile's shift.
    inputs.map((i) => (i.rowDelta || i.colDelta ? i.formula + "@" + i.rowDelta + "," + i.colDelta : i.formula)),
  ),
  getMergedRegions: vi.fn(async (range?: { startRow: number; startCol: number; endRow: number; endCol: number }) =>
    model.merges.filter(
      (m) =>
        !range ||
        (m.startRow <= range.endRow && m.endRow >= range.startRow && m.startCol <= range.endCol && m.endCol >= range.startCol),
    ),
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
  beginUndoSavepoint: vi.fn(async () => ({ ticket: null, savepoint: { transaction: 7, changes: 0 } })),
  rollBackToUndoSavepoint: vi.fn(async () => ({ success: true })),
  updateCellsBatch: (u: unknown[], o?: unknown) => api.updateCellsBatch(u, o),
  updateCell: vi.fn(async () => ({ cells: [], dimensionChanges: [] })),
  clearCell: (row: number, col: number) => api.clearCell(row, col),
  relocateCellReferences: (...args: number[]) => api.relocateCellReferences(...args),
  shiftFormulasBatch: (inputs: { formula: string; rowDelta: number; colDelta: number }[]) => api.shiftFormulasBatch(inputs),
  getMergedRegions: (range?: { startRow: number; startCol: number; endRow: number; endCol: number }) =>
    api.getMergedRegions(range),
  getRangeCellsTyped: vi.fn(async () => {
    throw new Error("no typed read in this double");
  }),
  getCell: vi.fn(async (row: number, col: number) => cellData(row, col)),
  getViewportCells: vi.fn(async () => []),
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
  readText: vi.fn(async () => null),
  writeText: vi.fn(async () => {}),
  writeHtml: vi.fn(async () => {}),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));

import { useClipboard, type UseClipboardReturn } from "../useClipboard";
import { pasteTiles, PASTE_ONCE } from "../../lib/pasteTiling";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection } from "../../state/gridActions";
import { AppEvents as ApiAppEvents } from "../../../api/events";
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

async function select(r0: number, c0: number, r1 = r0, c1 = c0): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }));
  });
  await settle();
}

type Update = { row: number; col: number; value: string };

/** Every cell the paste wrote, "row,col=value", in write order. */
function written(): string[] {
  return api.updateCellsBatch.mock.calls
    .flatMap((c) => c[0] as Update[])
    .map(({ row, col, value }) => `${row},${col}=${value}`);
}

async function copyThenPaste(src: [number, number, number, number], dest: [number, number, number, number], cut = false): Promise<void> {
  await select(...src);
  await act(async () => {
    if (cut) await hook.cut();
    else await hook.copy();
  });
  await settle();
  await select(...dest);
  await act(async () => {
    await hook.paste();
  });
  await settle();
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  model.cells.clear();
  model.merges = [];
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
  await act(async () => {
    hook.clearClipboardState();
  });
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("the tiling rule (core/lib/pasteTiling.ts) [LIVE]", () => {
  it("tiles only when BOTH axes are exact multiples and the selection is larger", () => {
    const sel = (r1: number, c1: number) => ({ startRow: 0, startCol: 7, endRow: r1, endCol: 7 + c1 });
    expect(pasteTiles(1, 1, sel(2, 0))).toEqual({ rows: 3, cols: 1 });
    expect(pasteTiles(2, 1, sel(3, 0))).toEqual({ rows: 2, cols: 1 });
    expect(pasteTiles(2, 2, sel(3, 3))).toEqual({ rows: 2, cols: 2 });
    expect(pasteTiles(2, 1, sel(3, 1)), "F1:F2 into H1:I4: both axes multiples").toEqual({ rows: 2, cols: 2 });
    expect(pasteTiles(2, 1, sel(2, 0)), "F1:F2 into H1:H3: 3 is no multiple of 2").toEqual(PASTE_ONCE);
    expect(pasteTiles(2, 2, sel(3, 2)), "F1:G2 into H1:J4: columns not a multiple").toEqual(PASTE_ONCE);
    expect(pasteTiles(2, 1, sel(1, 0)), "the same size").toEqual(PASTE_ONCE);
    expect(pasteTiles(1, 1, sel(3, 1), true), "a merged cell in the selection").toEqual(PASTE_ONCE);
  });
});

describe("Paste tiles a copy over a selection that is a multiple of it [LIVE]", () => {
  it("one cell copied into three: pasted into all three (Excel: f6, f6, f6)", async () => {
    model.cells.set("5,5", { display: "f6", formula: null, styleIndex: 0 });
    await copyThenPaste([5, 5, 5, 5], [0, 7, 2, 7]);
    expect(written(), "the copy was pasted once, not tiled over H1:H3").toEqual(["0,7=f6", "1,7=f6", "2,7=f6"]);
    expect(gridState.selection, "the pasted area is the whole selection").toMatchObject({ startRow: 0, endRow: 2, startCol: 7, endCol: 7 });
  });

  it("a 2x2 block into a 4x4 selection: the block four times", async () => {
    model.cells.set("0,5", { display: "f1", formula: null, styleIndex: 0 });
    model.cells.set("0,6", { display: "g1", formula: null, styleIndex: 0 });
    model.cells.set("1,5", { display: "f2", formula: null, styleIndex: 0 });
    model.cells.set("1,6", { display: "g2", formula: null, styleIndex: 0 });
    await copyThenPaste([0, 5, 1, 6], [0, 7, 3, 10]);
    expect(written()).toEqual([
      "0,7=f1", "0,8=g1", "0,9=f1", "0,10=g1",
      "1,7=f2", "1,8=g2", "1,9=f2", "1,10=g2",
      "2,7=f1", "2,8=g1", "2,9=f1", "2,10=g1",
      "3,7=f2", "3,8=g2", "3,9=f2", "3,10=g2",
    ]);
  });

  it("a copied formula is shifted PER TILE (B1 =A1*2 into D1:D3 -> =C1*2, =C2*2, =C3*2)", async () => {
    model.cells.set("0,1", { display: "2", formula: "=A1*2", styleIndex: 0 });
    await copyThenPaste([0, 1, 0, 1], [0, 3, 2, 3]);
    expect(written(), "every tile carried the first tile's shift").toEqual([
      "0,3==A1*2@0,2",
      "1,3==A1*2@1,2",
      "2,3==A1*2@2,2",
    ]);
  });

  it("controls: a size that is no multiple, one axis only, a merged cell, and a cut -- each pasted ONCE", async () => {
    model.cells.set("0,5", { display: "f1", formula: null, styleIndex: 0 });
    model.cells.set("1,5", { display: "f2", formula: null, styleIndex: 0 });
    await copyThenPaste([0, 5, 1, 5], [0, 7, 2, 7]);
    expect(written(), "F1:F2 into H1:H3").toEqual(["0,7=f1", "1,7=f2"]);

    api.updateCellsBatch.mockClear();
    model.cells.set("0,6", { display: "g1", formula: null, styleIndex: 0 });
    model.cells.set("1,6", { display: "g2", formula: null, styleIndex: 0 });
    await copyThenPaste([0, 5, 1, 6], [0, 7, 3, 9]);
    expect(written(), "F1:G2 into H1:J4").toEqual(["0,7=f1", "0,8=g1", "1,7=f2", "1,8=g2"]);

    api.updateCellsBatch.mockClear();
    model.merges = [{ startRow: 2, startCol: 7, endRow: 2, endCol: 8 }];
    await copyThenPaste([5, 5, 5, 5], [0, 7, 3, 8]);
    expect(written(), "a selection holding a merged cell").toHaveLength(1);
    model.merges = [];

    api.updateCellsBatch.mockClear();
    model.cells.set("5,5", { display: "f6", formula: null, styleIndex: 0 });
    await copyThenPaste([5, 5, 5, 5], [0, 7, 2, 7], true);
    expect(written(), "a cut was tiled").toEqual(["0,7=f6"]);
  });

  it("the grid paste command's { at } with endRow / endCol (Insert Copied Cells' room) tiles the room", async () => {
    model.cells.set("5,5", { display: "f6", formula: null, styleIndex: 0 });
    await select(5, 5);
    await act(async () => {
      await hook.copy();
    });
    await settle();
    await act(async () => {
      await hook.paste({ at: { row: 1, col: 5, endRow: 2, endCol: 5 } });
    });
    await settle();
    expect(written(), "the room F2:F3 got the copy once").toEqual(["1,5=f6", "2,5=f6"]);
  });
});

// rev11B nit (round 12): moveRows / moveColumns caught a refused
// relocateCellReferences, committed and STILL announced CELLS_MOVED -- the
// followers (watches, bookmarks) went to the new rows while every formula
// reference stayed on the old ones, and the step recorded no move for its Undo.
describe("a row or column drag whose relocation was refused announces no move", () => {
  function movedAnnouncements(): unknown[] {
    const seen: unknown[] = [];
    window.addEventListener(ApiAppEvents.CELLS_MOVED, (e) => {
      seen.push((e as CustomEvent).detail);
    });
    return seen;
  }

  it("moveRows", async () => {
    const seen = movedAnnouncements();
    model.cells.set("2,2", { display: "c3", formula: null, styleIndex: 0 });
    api.relocateCellReferences.mockRejectedValueOnce(new Error("the relocation was refused"));
    await act(async () => {
      await hook.moveRows(2, 2, 9);
    });
    await settle();
    expect(api.relocateCellReferences).toHaveBeenCalledTimes(1);
    expect(seen, "a row drag whose references did not follow announced CELLS_MOVED").toEqual([]);
  });

  it("moveColumns", async () => {
    const seen = movedAnnouncements();
    model.cells.set("0,1", { display: "5", formula: null, styleIndex: 0 });
    api.relocateCellReferences.mockRejectedValueOnce(new Error("the relocation was refused"));
    await act(async () => {
      await hook.moveColumns(1, 1, 4);
    });
    await settle();
    expect(seen, "a column drag whose references did not follow announced CELLS_MOVED").toEqual([]);
  });

  it("control: a row drag whose relocation landed announces the move", async () => {
    const seen = movedAnnouncements();
    model.cells.set("2,2", { display: "c3", formula: null, styleIndex: 0 });
    await act(async () => {
      await hook.moveRows(2, 2, 9);
    });
    await settle();
    expect(seen).toHaveLength(1);
  });
});
