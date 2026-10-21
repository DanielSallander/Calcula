//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialCellTarget.test.ts
// PURPOSE: The paste variants and the Paste Special dialog on a floating
//          grid's cells (P3 S10, owner finding G3): the door resolves the
//          grid's cells as the target ("content") and the paste lands THERE --
//          one targeted `updateCellsBatch` (value + source style, Excel's
//          relative shift on the grid's coordinates) plus number formats
//          through `applyFormatting(.., { target })` -- never a per-cell write
//          to the active sheet. Paste Link names its source. What has no route
//          onto a grid's cells (a style-only paste, column widths) is refused
//          in one sentence with nothing written.
// CONTEXT: The selection owner is REAL (@api/selectionOwner), shaped like the
//          floating grid's.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  openDialog: vi.fn(),
  writes: vi.fn(),
  batch: vi.fn(),
  applyFormatting: vi.fn(),
  read: vi.fn(),
  readTyped: vi.fn(async () => [] as unknown[]),
  alert: vi.fn(),
  clipboard: null as unknown,
}));

vi.mock("@api/ui", () => ({
  DialogExtensions: {
    registerDialog: vi.fn(),
    unregisterDialog: vi.fn(),
    openDialog: (...a: unknown[]) => h.openDialog(...a),
  },
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
    return name === "updateCell" ? { cells: [] } : undefined;
  };
  return {
    ...real,
    getInternalClipboard: () => h.clipboard,
    getCell: write("getCell"),
    getStyle: vi.fn(async (index: number) => ({ numberFormat: `fmt-${index}` })),
    updateCell: write("updateCell"),
    setCellStyle: write("setCellStyle"),
    setColumnWidth: write("setColumnWidth"),
    getColumnWidth: vi.fn(async () => 64),
    updateCellsBatch: (...a: unknown[]) => h.batch(...a),
    // The copied B2:C2 as the engine stores it (an operation reads numbers typed).
    getRangeCellsTyped: vi.fn(async () => [
      { row: 1, col: 1, value: 10, display: "10", formula: null, type: "number" },
      { row: 1, col: 2, value: 11, display: "11", formula: "=B2+1", type: "number" },
    ]),
    applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
    beginUndoTransaction: vi.fn(async () => 11),
    commitUndoTransaction: vi.fn(async () => undefined),
    cancelUndoTransaction: vi.fn(async () => undefined),
    shiftFormulasBatch: vi.fn(async (inputs: { formula: string; rowDelta: number; colDelta: number }[]) =>
      inputs.map((i) => `${i.formula}@${i.rowDelta},${i.colDelta}`),
    ),
  };
});
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCells: (...a: unknown[]) => h.read(...a),
  getCellTargetCellsTyped: (...a: unknown[]) => h.readTyped(...a),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import extension from "../index";
import { executePasteSpecial } from "../pasteSpecialExecute";
import { pasteRefusalSentence } from "../pasteRefusals";
import { CoreCommands } from "@api/commands";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import type { Selection } from "@api/types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };
const ADMITS: readonly CellTargetCapability[] = ["read", "format", "numberFormat", "content", "clear"];

/** B2:C2 of Sheet1 copied: a value with style 2 and a formula with style 5. */
const SHEET_CLIP = {
  cells: [
    [
      { row: 1, col: 1, display: "10", formula: null, styleIndex: 2 },
      { row: 1, col: 2, display: "11", formula: "=B2+1", styleIndex: 5 },
    ],
  ],
  sourceSelection: { startRow: 1, startCol: 1, endRow: 1, endCol: 2, type: "cells" },
  sourceRows: [1],
  isCut: false,
  sourceSheetIndex: 0,
  sourceSheetName: "Sheet1",
  text: "10\t11",
};

let frSelection: Selection | null = null;
const handlers = new Map<string, (...a: unknown[]) => unknown>();
let release: () => void = () => {};

beforeEach(() => {
  for (const fn of [h.openDialog, h.writes, h.batch, h.applyFormatting, h.read, h.alert]) fn.mockReset();
  h.batch.mockResolvedValue([]);
  h.applyFormatting.mockResolvedValue({ cells: [], styles: [] });
  h.alert.mockResolvedValue(undefined);
  h.read.mockResolvedValue({ cells: [], merges: [], conditional: [], styles: [], rules: [] });
  h.clipboard = SHEET_CLIP;
  frSelection = { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" };
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => frSelection !== null,
    actsOn: ADMITS,
    cellTarget: () =>
      frSelection === null
        ? null
        : { ref: REF, selection: frSelection, bounds: { rows: 10, cols: 5 }, label: "Float1", wholeObject: false },
  });
  handlers.clear();
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => handlers.set(id, fn),
      unregister: vi.fn(),
    },
  } as never);
});

afterEach(() => {
  extension.deactivate();
  release();
});

function batchCall(i = 0): { updates: Array<Record<string, unknown>>; opts: unknown } {
  const [updates, opts] = h.batch.mock.calls[i] as [Array<Record<string, unknown>>, unknown];
  return { updates, opts };
}

describe("the paste variants on a floating grid's cells", () => {
  it("Paste Formulas: ONE targeted batch, relative shift on the grid's coordinates, no active-sheet write", async () => {
    await handlers.get(CoreCommands.PASTE_FORMULAS)!();
    expect(h.batch).toHaveBeenCalledTimes(1);
    const { updates, opts } = batchCall();
    expect(opts).toEqual({ target: REF });
    expect(updates).toEqual([
      { row: 3, col: 0, value: "10" },
      { row: 3, col: 1, value: "=B2+1@2,-1" },
    ]);
    expect(h.writes, "a per-cell write hit the ACTIVE sheet").not.toHaveBeenCalled();
  });

  it("Paste Values & Source Formatting carries the source style index in the batch", async () => {
    await handlers.get(CoreCommands.PASTE_VALUES_AND_SOURCE_FORMATTING)!();
    expect(batchCall().updates).toEqual([
      { row: 3, col: 0, value: "10", styleIndex: 2 },
      { row: 3, col: 1, value: "11", styleIndex: 5 },
    ]);
  });

  it("Paste Values & Number Formatting: values in the batch, each number format with the target", async () => {
    await handlers.get(CoreCommands.PASTE_VALUES_AND_NUMBER_FORMATS)!();
    expect(batchCall().updates.map((u) => u.value)).toEqual(["10", "11"]);
    expect(h.applyFormatting.mock.calls).toEqual([
      [[3], [0], { numberFormat: "fmt-2" }, { target: REF }],
      [[3], [1], { numberFormat: "fmt-5" }, { target: REF }],
    ]);
  });

  it("Paste (Transpose) transposes onto the grid", async () => {
    await handlers.get(CoreCommands.PASTE_TRANSPOSE)!();
    expect(batchCall().updates.map((u) => [u.row, u.col])).toEqual([
      [3, 0],
      [4, 0],
    ]);
  });

  it("Paste Link from the sheet names the sheet (the link lives on the grid)", async () => {
    await handlers.get(CoreCommands.PASTE_LINK)!();
    expect(batchCall().updates.map((u) => u.value)).toEqual(["=Sheet1!B2", "=Sheet1!C2"]);
    expect(batchCall().opts).toEqual({ target: REF });
  });

  it("Paste Link inside the SAME grid is bare", async () => {
    h.clipboard = { ...SHEET_CLIP, sourceSheetIndex: -1, sourceSheetName: "Float1", sourceTarget: REF };
    await handlers.get(CoreCommands.PASTE_LINK)!();
    expect(batchCall().updates.map((u) => u.value)).toEqual(["=B2", "=C2"]);
  });

  it("an operation reads the destination from the GRID's styled read", async () => {
    h.readTyped.mockResolvedValueOnce([{ row: 3, col: 0, value: 5, display: "5", formula: null, type: "number" }]);
    h.read.mockResolvedValue({
      cells: [{ row: 3, col: 0, display: "5", formula: null, styleIndex: 0, valueKind: "number" }],
      merges: [],
      conditional: [],
      styles: [],
      rules: [],
    });
    const done = await executePasteSpecial(
      SHEET_CLIP as never,
      frSelection!,
      { pasteAttribute: "values", operation: "add", skipBlanks: false, transpose: false },
      10,
      5,
      "Paste Special",
      REF,
    );
    expect(done).toBe(true);
    expect(h.read).toHaveBeenCalledWith(REF, { startRow: 3, startCol: 0, endRow: 3, endCol: 1 });
    expect(batchCall().updates.map((u) => u.value)).toEqual(["15", "11"]);
    expect(h.writes).not.toHaveBeenCalled();
  });

  it("Paste Formatting / Keep Source Column Widths have no route onto the grid: refused, nothing written", async () => {
    await handlers.get(CoreCommands.PASTE_FORMATTING)!();
    await handlers.get(CoreCommands.PASTE_KEEP_SOURCE_COLUMN_WIDTHS)!();
    expect(h.alert.mock.calls.map((c) => c[0])).toEqual([
      pasteRefusalSentence.notOnFloatingGrid("Paste Formatting"),
      pasteRefusalSentence.notOnFloatingGrid("Paste (Keep Source Column Widths)"),
    ]);
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.writes).not.toHaveBeenCalled();
  });

  it("Paste Special... opens the dialog WITH the grid's target", async () => {
    await handlers.get(CoreCommands.PASTE_SPECIAL)!();
    expect(h.openDialog).toHaveBeenCalledTimes(1);
    const [id, data] = h.openDialog.mock.calls[0] as [string, { target: { kind: string; ref: unknown } }];
    expect(id).toBe("paste-special");
    expect(data.target.kind).toBe("object");
    expect(data.target.ref).toEqual(REF);
  });

  it("positive control: on the sheet, Paste Formulas writes the active sheet per cell, no target", async () => {
    frSelection = null;
    await handlers.get(CoreCommands.PASTE_FORMULAS)!();
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.writes.mock.calls.filter((c) => c[0] === "updateCell")).toHaveLength(2);
  });
});
