//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialOperationTyped.test.ts
// PURPOSE: Paste Special's operations (Add / Subtract / Multiply / Divide)
//          compute from the cells' TYPED values and write the result in
//          INVARIANT form -- on the sheet and on a floating grid's cells (P3).
// CONTEXT: Round-2 integrity review. Both routes used to read the operands
//          with `Number(cell.display)`: under de-DE / sv-SE a cell showing
//          "1,5" read as 0, and under en-US any formatted number ("1,234.00",
//          "$5.00", "50%") read as 0 -- so 2 + 1,5 pasted 2. The result went
//          back as `String(result)` ("3.5") through the USER-INPUT parser,
//          which under a comma-decimal locale does not read "3.5" as 3,5.
//          The displays below are what a comma-decimal locale and a currency
//          format show; the typed values are what the engine stores.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  writes: vi.fn(),
  batch: vi.fn(),
  read: vi.fn(),
  typedTarget: vi.fn(),
  typedSheet: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 40, startCol: 40, endRow: 40, endCol: 40, type: "cells" },
    config: { totalRows: 1000, totalCols: 100 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
vi.mock("@api/lib", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/lib")>();
  const write = (name: string) => async (...a: unknown[]) => {
    h.writes(name, ...a);
    if (name === "updateCell") return { cells: [] };
    if (name === "getCell") {
      const [row, col] = a as [number, number];
      // The destination's DISPLAY, as a comma-decimal locale shows it.
      return row === 5 && col === 1 ? { row, col, display: "2", formula: null, styleIndex: 0 } : null;
    }
    return undefined;
  };
  return {
    ...real,
    getCell: write("getCell"),
    getStyle: vi.fn(async () => ({ numberFormat: "General" })),
    updateCell: write("updateCell"),
    setCellStyle: write("setCellStyle"),
    updateCellsBatch: (...a: unknown[]) => h.batch(...a),
    getRangeCellsTyped: (...a: unknown[]) => h.typedSheet(...a),
    applyFormatting: vi.fn(async () => ({ cells: [], styles: [] })),
    beginUndoTransaction: vi.fn(async () => 11),
    commitUndoTransaction: vi.fn(async () => undefined),
    cancelUndoTransaction: vi.fn(async () => undefined),
    shiftFormulasBatch: vi.fn(async () => []),
  };
});
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCells: (...a: unknown[]) => h.read(...a),
  getCellTargetCellsTyped: (...a: unknown[]) => h.typedTarget(...a),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import { executePasteSpecial } from "../pasteSpecialExecute";
import type { Selection } from "@api/types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };

/** A1:B1 of Sheet1 copied: "1,5" (1.5) and "$1,234.00" (1234), as displayed. */
const CLIP = {
  cells: [
    [
      { row: 0, col: 0, display: "1,5", formula: null, styleIndex: 0 },
      { row: 0, col: 1, display: "$1,234.00", formula: null, styleIndex: 3 },
    ],
  ],
  sourceSelection: { startRow: 0, startCol: 0, endRow: 0, endCol: 1, type: "cells" },
  sourceRows: [0],
  isCut: false,
  sourceSheetIndex: 0,
  sourceSheetName: "Sheet1",
  text: "1,5\t$1,234.00",
};

const typed = (row: number, col: number, value: number, display: string) => ({
  row,
  col,
  value,
  display,
  formula: null,
  type: "number",
});

/** What the engine STORES: the source A1:B1, and the sheet destination B6:C6. */
function sheetTyped(r0: number, c0: number, r1: number, c1: number): unknown[] {
  const all = [
    typed(0, 0, 1.5, "1,5"),
    typed(0, 1, 1234, "$1,234.00"),
    typed(5, 1, 2, "2"),
    typed(5, 2, 1000, "1.000,00"),
  ];
  return all.filter((c) => c.row >= r0 && c.row <= r1 && c.col >= c0 && c.col <= c1);
}

beforeEach(() => {
  for (const fn of [h.writes, h.batch, h.read, h.typedTarget, h.typedSheet, h.alert]) fn.mockReset();
  h.batch.mockResolvedValue([]);
  h.alert.mockResolvedValue(undefined);
  h.typedSheet.mockImplementation(async (r0: number, c0: number, r1: number, c1: number) => sheetTyped(r0, c0, r1, c1));
  h.read.mockResolvedValue({
    cells: [
      { row: 3, col: 0, display: "2", formula: null, styleIndex: 0 },
      { row: 3, col: 1, display: "1.000,00", formula: null, styleIndex: 0 },
    ],
    merges: [],
    conditional: [],
    styles: [],
    rules: [],
  });
  h.typedTarget.mockResolvedValue([typed(3, 0, 2, "2"), typed(3, 1, 1000, "1.000,00")]);
});

/** Every value the paste wrote, with its invariant flag, over every batch call. */
function written(): Array<{ row: number; col: number; value: string; invariant?: boolean }> {
  return h.batch.mock.calls.flatMap((c) => c[0] as Array<{ row: number; col: number; value: string; invariant?: boolean }>);
}

describe("Paste Special operations read typed values and write invariant numbers", () => {
  it("on the sheet: 2 + 1,5 = 3,5 and 1000 + 1234 = 2234, written invariant", async () => {
    const target: Selection = { startRow: 5, startCol: 1, endRow: 5, endCol: 1, type: "cells" };
    const done = await executePasteSpecial(
      CLIP as never,
      target,
      { pasteAttribute: "values", operation: "add", skipBlanks: false, transpose: false },
      1000,
      100,
      "Paste Special",
    );
    expect(done).toBe(true);
    // The source was re-read typed on ITS sheet, the destination on the active one.
    expect(h.typedSheet).toHaveBeenCalledWith(0, 0, 0, 1, 0);
    expect(h.typedSheet).toHaveBeenCalledWith(5, 1, 5, 2, undefined);
    const out = written().map((u) => ({ ...u }));
    expect(out, "an operand was read from its display text").toEqual([
      { row: 5, col: 1, value: "3.5", invariant: true },
      { row: 5, col: 2, value: "2234", invariant: true },
    ]);
    // Never through the user-input parser.
    expect(h.writes.mock.calls.filter((c) => c[0] === "updateCell")).toHaveLength(0);
  });

  it("on the sheet: Multiply and Divide use the stored numbers too", async () => {
    const target: Selection = { startRow: 5, startCol: 1, endRow: 5, endCol: 1, type: "cells" };
    await executePasteSpecial(
      CLIP as never,
      target,
      { pasteAttribute: "values", operation: "divide", skipBlanks: false, transpose: false },
      1000,
      100,
      "Paste Special",
    );
    expect(written().map((u) => u.value)).toEqual([String(2 / 1.5), String(1000 / 1234)]);
  });

  it("on a floating grid's cells: the same typed operands, one targeted batch, invariant", async () => {
    const target: Selection = { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" };
    const done = await executePasteSpecial(
      CLIP as never,
      target,
      { pasteAttribute: "values", operation: "subtract", skipBlanks: false, transpose: false },
      10,
      5,
      "Paste Special",
      REF,
    );
    expect(done).toBe(true);
    expect(h.typedTarget).toHaveBeenCalledWith(REF, { startRow: 3, startCol: 0, endRow: 3, endCol: 1 });
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect(h.batch.mock.calls[0][1]).toEqual({ target: REF });
    expect(written(), "the grid route read an operand from its display text").toEqual([
      { row: 3, col: 0, value: "0.5", invariant: true },
      { row: 3, col: 1, value: String(1000 - 1234), invariant: true },
    ]);
  });

  it("copied FROM a floating grid: the source is re-read typed through the object, by its own coordinates", async () => {
    const fromGrid = { ...CLIP, sourceTarget: REF, sourceSheetIndex: -1, sourceSheetName: "Float1" };
    h.typedTarget.mockImplementation(async (_ref: unknown, rect: { startRow: number }) =>
      rect.startRow === 0 ? [typed(0, 0, 1.5, "1,5"), typed(0, 1, 1234, "$1,234.00")] : [],
    );
    const target: Selection = { startRow: 5, startCol: 1, endRow: 5, endCol: 1, type: "cells" };
    await executePasteSpecial(
      fromGrid as never,
      target,
      { pasteAttribute: "values", operation: "add", skipBlanks: false, transpose: false },
      1000,
      100,
      "Paste Special",
    );
    expect(h.typedTarget).toHaveBeenCalledWith(REF, { startRow: 0, startCol: 0, endRow: 0, endCol: 1 });
    expect(written().map((u) => u.value)).toEqual(["3.5", "2234"]);
  });
});
