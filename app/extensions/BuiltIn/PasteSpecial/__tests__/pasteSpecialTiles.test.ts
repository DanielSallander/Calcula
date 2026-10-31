//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialTiles.test.ts
// PURPOSE: Every Paste Special door TILES a copy into a selection that is an
//          exact multiple of it, as plain Paste does and as Excel does.
// CONTEXT: Bug-ledger fix programme, round 13 (lane clip5,
//          NEW-paste-does-not-tile). Live Excel 16 [2026-10-30, fresh
//          instances over COM, clip5/probe-tile.ps1]: Paste Values of B1
//          (=A1*2, 2) into H1:H3 -> 2, 2, 2; PasteSpecial All of B1 into D1:D3
//          -> =C1*2, =C2*2, =C3*2 (each tile shifted to where it lands); a
//          selection holding a merged cell, or of a size that is no multiple,
//          takes the copy once. Paste Special pasted once at the top-left.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  batch: vi.fn(),
  merges: [] as Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>,
  log: [] as string[],
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 0, startCol: 7, endRow: 2, endCol: 7, type: "cells" },
    config: { totalRows: 1000, totalCols: 100 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(async () => ({ numberFormat: "General" })),
  updateCell: vi.fn(async (row: number, col: number) => ({ cells: [{ row, col, display: "", formula: null, styleIndex: 0 }] })),
  setCellStyle: vi.fn(async () => null),
  setCellStyles: vi.fn(async () => undefined),
  applyFormatting: vi.fn(async () => ({ cells: [], styles: [] })),
  updateCellsBatch: (...a: unknown[]) => h.batch(...a),
  getRangeCellsTyped: vi.fn(async () => []),
  getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1", sheetId: "sheet-a" }], activeIndex: 0 })),
  // A shifted formula says by how much, so a test sees each tile's shift.
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>) =>
    inputs.map((i) => `${i.formula}@${i.rowDelta},${i.colDelta}`),
  ),
  getMergedRegions: vi.fn(async () => h.merges),
  beginUndoTransaction: vi.fn(async () => 5),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
  getSpillRanges: vi.fn(async () => []),
  isSheetProtected: vi.fn(async () => false),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: vi.fn(async () => []),
  getCellTargetCells: vi.fn(async () => ({ cells: [], merges: [], conditional: [], styles: [], rules: [] })),
}));
vi.mock("@api/floatingRangeSpills", () => ({ getFloatingRangeSpillRanges: vi.fn(async () => []) }));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(async () => undefined) }));

import { executePasteSpecial } from "../pasteSpecialExecute";
import * as lib from "@api/lib";
import type { PasteAttribute } from "../types";

/** A copy of B1 (=A1*2, showing 2) -- or of the constant 7 when `formula` is false. */
function clipOfB1(formula = true, isCut = false): never {
  return {
    cells: [[{ row: 0, col: 1, display: formula ? "2" : "7", formula: formula ? "=A1*2" : null, styleIndex: 0 }]],
    values: [[{ type: "number", value: formula ? 2 : 7 }]],
    sourceSelection: { startRow: 0, startCol: 1, endRow: 0, endCol: 1, type: "cells" },
    sourceRows: [0],
    isCut,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    sourceSheetId: "sheet-a",
    text: formula ? "=A1*2" : "7",
  } as never;
}

const sel = (r0: number, c0: number, r1: number, c1: number) =>
  ({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }) as never;

async function paste(clipboard: never, pasteAttribute: PasteAttribute, dest: never): Promise<boolean> {
  return executePasteSpecial(clipboard, dest, { pasteAttribute, operation: "none", skipBlanks: false, transpose: false }, 1000, 100);
}

/** Every cell the paste wrote, "row,col=value", in write order. */
function written(): string[] {
  return h.batch.mock.calls.flatMap((c) => (c[0] as Array<{ row: number; col: number; value: string }>).map((u) => `${u.row},${u.col}=${u.value}`));
}

beforeEach(() => {
  h.batch.mockReset();
  h.batch.mockImplementation(async (updates: Array<{ row: number; col: number }>) =>
    updates.map((u) => ({ row: u.row, col: u.col, display: "", formula: null, styleIndex: 0 })),
  );
  h.merges = [];
  h.log.length = 0;
});

describe("[LIVE] Paste Special tiles a copy over a selection that is a multiple of it", () => {
  it("Paste Values of B1 (2) into H1:H3: the value in all three", async () => {
    expect(await paste(clipOfB1(), "values", sel(0, 7, 2, 7))).toBe(true);
    expect(written(), "Paste Values pasted once, not tiled over H1:H3").toEqual(["0,7=2", "1,7=2", "2,7=2"]);
  });

  it("Paste Special All of B1 (=A1*2) into D1:D3: each tile shifted to where it lands", async () => {
    await paste(clipOfB1(), "all", sel(0, 3, 2, 3));
    expect(written(), "every tile carried the first tile's shift").toEqual([
      "0,3==A1*2@0,2",
      "1,3==A1*2@1,2",
      "2,3==A1*2@2,2",
    ]);
  });

  it("controls: a merged cell in the selection, and a size that is no multiple, paste once", async () => {
    h.merges = [{ startRow: 1, startCol: 7, endRow: 1, endCol: 8 }];
    await paste(clipOfB1(false), "values", sel(0, 7, 2, 8));
    expect(written(), "a selection holding a merged cell").toEqual(["0,7=7"]);
    h.batch.mockClear();
    h.merges = [];
    const twoCells = {
      ...(clipOfB1(false) as object),
      cells: [[{ row: 0, col: 1, display: "7", formula: null, styleIndex: 0 }], [{ row: 1, col: 1, display: "8", formula: null, styleIndex: 0 }]],
      values: [[{ type: "number", value: 7 }], [{ type: "number", value: 8 }]],
      sourceSelection: { startRow: 0, startCol: 1, endRow: 1, endCol: 1, type: "cells" },
      sourceRows: [0, 1],
    } as never;
    await paste(twoCells, "values", sel(0, 7, 2, 7));
    expect(written(), "two cells into three").toEqual(["0,7=7", "1,7=8"]);
  });
});

// Round 15 (lane clip7, rev13B MAJOR): the tiled route wrote cell by cell --
// one awaited IPC per pasted cell (each with its own backend recalculation),
// and one formula-shift call per tile -- so one copied cell over a column was
// about a million sequential calls with the undo step open. A tiled paste
// now sends every tile's content (with the style riding it) in ONE batch,
// every tile's formulas in ONE shift, and a number format per COPIED cell.
describe("a tiled Paste Special makes a BOUNDED number of backend calls, whatever the area", () => {
  const N = 100_000;
  const column = sel(0, 7, N - 1, 7);

  /** Every call the paste made through the mocked library (the backend's doors). */
  function callCount(): number {
    let n = h.batch.mock.calls.length;
    for (const value of Object.values(lib)) {
      const mock = (value as { mock?: { calls: unknown[] } } | null)?.mock;
      if (mock && Array.isArray(mock.calls)) n += mock.calls.length;
    }
    return n;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const attribute of ["all", "formulas", "values", "valuesAndSourceFormatting", "valuesAndNumberFormats", "formulasAndNumberFormats"] as const) {
    it(`${attribute}: B1 into H1:H${N} -- one batch of ${N} cells, a handful of calls`, async () => {
      const ok = await executePasteSpecial(
        clipOfB1(),
        column,
        { pasteAttribute: attribute, operation: "none", skipBlanks: false, transpose: false },
        1_048_576,
        100,
      );
      expect(ok).toBe(true);
      expect(h.batch, "every tiled cell was its own write").toHaveBeenCalledTimes(1);
      expect((h.batch.mock.calls[0][0] as unknown[]).length).toBe(N);
      expect(vi.mocked(lib.shiftFormulasBatch).mock.calls.length, "one shift call per tile").toBeLessThanOrEqual(1);
      expect(vi.mocked(lib.setCellStyle), "a style written cell by cell beside its content").not.toHaveBeenCalled();
      expect(callCount(), "the paste's backend calls grow with the area").toBeLessThanOrEqual(12);
    });
  }

  // Round 16 (lane cutfmt, clip7's remainder): the style-only writes had no
  // batch door and stayed one call per cell -- Paste Formatting of one cell
  // over a column was 100,000 setCellStyle calls, and No Borders added a read
  // and a border restore per cell. They now go out in ONE setCellStyles.
  it(`formats: B1 into H1:H${N} -- ONE style-only batch of ${N} cells, no per-cell style call`, async () => {
    const styled = { ...(clipOfB1(false) as object), cells: [[{ row: 0, col: 1, display: "7", formula: null, styleIndex: 9 }]] } as never;
    const ok = await executePasteSpecial(
      styled,
      column,
      { pasteAttribute: "formats", operation: "none", skipBlanks: false, transpose: false },
      1_048_576,
      100,
    );
    expect(ok).toBe(true);
    expect(vi.mocked(lib.setCellStyle), "every tiled cell's style was its own call").not.toHaveBeenCalled();
    expect(vi.mocked(lib.setCellStyles), "the style-only writes were not sent together").toHaveBeenCalledTimes(1);
    const writes = vi.mocked(lib.setCellStyles).mock.calls[0][0];
    expect(writes.length).toBe(N);
    expect(writes[N - 1]).toEqual({ row: N - 1, col: 7, styleIndex: 9 });
    expect(h.batch, "Paste Formatting writes no content").not.toHaveBeenCalled();
    expect(callCount(), "the paste's backend calls grow with the area").toBeLessThanOrEqual(12);
  });

  it(`allExceptBorders: B1 into H1:H${N} -- one content batch, ONE style batch keeping each cell's borders, no per-cell read`, async () => {
    const styled = { ...(clipOfB1(false) as object), cells: [[{ row: 0, col: 1, display: "7", formula: null, styleIndex: 9 }]] } as never;
    const ok = await executePasteSpecial(
      styled,
      column,
      { pasteAttribute: "allExceptBorders", operation: "none", skipBlanks: false, transpose: false },
      1_048_576,
      100,
    );
    expect(ok).toBe(true);
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect((h.batch.mock.calls[0][0] as unknown[]).length).toBe(N);
    expect(vi.mocked(lib.getCell), "each destination was read for its borders").not.toHaveBeenCalled();
    expect(vi.mocked(lib.applyFormatting), "each destination's borders were put back with their own call").not.toHaveBeenCalled();
    expect(vi.mocked(lib.setCellStyles)).toHaveBeenCalledTimes(1);
    const writes = vi.mocked(lib.setCellStyles).mock.calls[0][0];
    expect(writes.length).toBe(N);
    expect(writes.every((w) => w.styleIndex === 9 && w.keepBorders === true), "the source's style, the destination's own borders").toBe(true);
    expect(callCount(), "the paste's backend calls grow with the area").toBeLessThanOrEqual(12);
  });

  it("all: the source's style rides each cell's content update (one write, as plain Paste sends it)", async () => {
    const styled = { ...(clipOfB1(false) as object), cells: [[{ row: 0, col: 1, display: "7", formula: null, styleIndex: 9 }]] } as never;
    await executePasteSpecial(styled, sel(0, 7, 2, 7), { pasteAttribute: "all", operation: "none", skipBlanks: false, transpose: false }, 1000, 100);
    const updates = h.batch.mock.calls[0][0] as Array<{ row: number; styleIndex?: number }>;
    expect(updates.map((u) => [u.row, u.styleIndex])).toEqual([[0, 9], [1, 9], [2, 9]]);
  });

  it("a 2x2 block over 4x4: the number formats go out once per COPIED cell, over its tiles' rows x columns", async () => {
    const block = {
      ...(clipOfB1(false) as object),
      cells: [
        [{ row: 0, col: 1, display: "1", formula: null, styleIndex: 1 }, { row: 0, col: 2, display: "2", formula: null, styleIndex: 2 }],
        [{ row: 1, col: 1, display: "3", formula: null, styleIndex: 3 }, { row: 1, col: 2, display: "4", formula: null, styleIndex: 4 }],
      ],
      values: [[{ type: "number", value: 1 }, { type: "number", value: 2 }], [{ type: "number", value: 3 }, { type: "number", value: 4 }]],
      sourceSelection: { startRow: 0, startCol: 1, endRow: 1, endCol: 2, type: "cells" },
      sourceRows: [0, 1],
    } as never;
    await executePasteSpecial(block, sel(0, 7, 3, 10), { pasteAttribute: "valuesAndNumberFormats", operation: "none", skipBlanks: false, transpose: false }, 1000, 100);
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect((h.batch.mock.calls[0][0] as unknown[]).length).toBe(16);
    expect(vi.mocked(lib.applyFormatting).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [[0, 2], [7, 9]],
      [[0, 2], [8, 10]],
      [[1, 3], [7, 9]],
      [[1, 3], [8, 10]],
    ]);
  });
});
