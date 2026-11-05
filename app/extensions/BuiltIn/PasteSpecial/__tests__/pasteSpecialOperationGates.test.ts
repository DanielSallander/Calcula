//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialOperationGates.test.ts
// PURPOSE: The questions an OPERATION paste (Add / Subtract / Multiply / Divide)
//          asks before it writes anything, and a clipboard too tall for a
//          spread argument list.
// CONTEXT: Round-2 review of BUG-0346 (revE#1, revE#3, revE#5):
//            - a paste area touching a DYNAMIC ARRAY was written cell by cell:
//              the formula cell became =(SEQUENCE(3))+10 and re-spilled, every
//              spilled cell after it was refused on its own, and the result
//              was neither the old numbers nor the expected ones. Excel,
//              measured live through COM (2026-10-29), refuses the whole paste
//              with "You can't change part of an array." -- onto the whole
//              array, the formula cell alone, one spilled cell, or the array
//              plus a cell beyond it -- and allows a plain paste of values;
//            - on a protected sheet an unlocked cell set to HIDE its formula
//              was read without its formula (the typed read withholds it), so
//              the operation replaced the formula with a constant, silently.
//              Excel keeps it (=(A1)+1); keeping it needs the formula text the
//              renderer may not read, so the paste is refused instead;
//            - `Math.min(...rows)` / `Math.max(...cells.map(..))` threw
//              RangeError above ~125,000 copied rows, so every Paste Special
//              variant failed with only a console error.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  batch: vi.fn(),
  updateCell: vi.fn(),
  typedSheet: vi.fn(),
  typedTarget: vi.fn(),
  spills: vi.fn(),
  targetSpills: vi.fn(),
  isProtected: vi.fn(),
  viewport: vi.fn(),
  style: vi.fn(),
  begin: vi.fn(),
  commit: vi.fn(),
  cancel: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
    config: { totalRows: 1_048_576, totalCols: 100 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getCell: vi.fn(async () => null),
  getStyle: (...a: unknown[]) => h.style(...a),
  updateCell: (...a: unknown[]) => h.updateCell(...a),
  setCellStyle: vi.fn(async () => null),
  applyFormatting: vi.fn(async () => ({ cells: [], styles: [] })),
  updateCellsBatch: (...a: unknown[]) => h.batch(...a),
  getRangeCellsTyped: (...a: unknown[]) => h.typedSheet(...a),
  getSheets: vi.fn(async () => ({ sheets: [], activeIndex: 0 })),
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string }>) => inputs.map((i) => i.formula)),
  beginUndoTransaction: (...a: unknown[]) => h.begin(...a),
  commitUndoTransaction: (...a: unknown[]) => h.commit(...a),
  cancelUndoTransaction: (...a: unknown[]) => h.cancel(...a),
  getSpillRanges: (...a: unknown[]) => h.spills(...a),
  isSheetProtected: (...a: unknown[]) => h.isProtected(...a),
  getViewportCells: (...a: unknown[]) => h.viewport(...a),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: (...a: unknown[]) => h.typedTarget(...a),
  getCellTargetCells: vi.fn(async () => ({ cells: [], merges: [], conditional: [], styles: [], rules: [] })),
}));
vi.mock("@api/floatingRangeSpills", () => ({
  getFloatingRangeSpillRanges: (...a: unknown[]) => h.targetSpills(...a),
}));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import { executePasteSpecial } from "../pasteSpecialExecute";
import { pasteRefusalSentence } from "../pasteRefusals";
import type { PasteAttribute, PasteOperation } from "../types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };

/** A copy of C1:C{n} (col 2) holding 10, 20, 30, ... */
function column(n: number): never {
  const cells = [];
  for (let r = 0; r < n; r++) cells.push([{ row: r, col: 2, display: String((r + 1) * 10), formula: null, styleIndex: 0 }]);
  return {
    cells,
    sourceSelection: { startRow: 0, startCol: 2, endRow: n - 1, endCol: 2, type: "cells" },
    isCut: false,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    text: "",
  } as never;
}

const at = (row: number, col: number, endRow = row) =>
  ({ startRow: row, startCol: col, endRow, endCol: col, type: "cells" }) as never;

async function paste(
  clipboard: never,
  dest: never,
  pasteAttribute: PasteAttribute,
  operation: PasteOperation,
  totalRows = 1_048_576,
  target?: typeof REF,
): Promise<boolean> {
  return executePasteSpecial(
    clipboard,
    dest,
    { pasteAttribute, operation, skipBlanks: false, transpose: false },
    totalRows,
    100,
    "Paste Special",
    target,
  );
}

/** A1 = =SEQUENCE(3), spilling into A1:A3. */
const SEQUENCE_A1_A3 = [{ originRow: 0, originCol: 0, endRow: 2, endCol: 0 }];

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.batch.mockResolvedValue([]);
  h.updateCell.mockResolvedValue({ cells: [] });
  // What the engine stores: the copied numbers in column C, nothing elsewhere.
  h.typedSheet.mockImplementation(async (r0: number, c0: number, r1: number, c1: number) => {
    const out: unknown[] = [];
    if (c0 <= 2 && c1 >= 2) {
      for (let r = r0; r <= r1; r++) out.push({ row: r, col: 2, type: "number", value: (r + 1) * 10, display: "", formula: null });
    }
    return out;
  });
  h.typedTarget.mockResolvedValue([]);
  h.spills.mockResolvedValue([]);
  h.targetSpills.mockResolvedValue([]);
  h.isProtected.mockResolvedValue(false);
  h.viewport.mockResolvedValue([]);
  h.style.mockResolvedValue({ numberFormat: "General", locked: true, formulaHidden: false });
  h.begin.mockResolvedValue(3);
  h.commit.mockResolvedValue(undefined);
  h.cancel.mockResolvedValue(undefined);
  h.alert.mockResolvedValue(undefined);
});

/** Nothing was written and no undo step was opened. */
function expectNothingWritten(): void {
  expect(h.batch, "an operation over part of an array was written").not.toHaveBeenCalled();
  expect(h.updateCell).not.toHaveBeenCalled();
  expect(h.begin, "a refused paste opened an undo step").not.toHaveBeenCalled();
}

describe("an operation over a DYNAMIC ARRAY is refused whole, before anything is written (Excel)", () => {
  const cases: Array<[string, never, never]> = [
    ["the whole array A1:A3", column(3), at(0, 0)],
    ["its formula cell A1 alone", column(1), at(0, 0)],
    ["one spilled cell A2", column(1), at(1, 0)],
    ["the array plus a cell beyond it (A1:A4)", column(4), at(0, 0)],
  ];
  for (const [name, clipboard, dest] of cases) {
    it(`Add onto ${name}`, async () => {
      h.spills.mockResolvedValue(SEQUENCE_A1_A3);
      expect(await paste(clipboard, dest, "all", "add")).toBe(false);
      expectNothingWritten();
      expect(h.alert.mock.calls.map((c) => c[0])).toEqual([pasteRefusalSentence.partOfArray("Paste Special")]);
    });
  }

  it("positive control: Add onto A4, just below the array, pastes", async () => {
    h.spills.mockResolvedValue(SEQUENCE_A1_A3);
    expect(await paste(column(1), at(3, 0), "values", "add")).toBe(true);
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("a paste WITHOUT an operation is not this gate's to refuse (Excel allows Paste Values over an array)", async () => {
    h.spills.mockResolvedValue(SEQUENCE_A1_A3);
    expect(await paste(column(3), at(0, 0), "values", "none")).toBe(true);
    expect(h.batch, "the three values go out in ONE batch (BUG-0345)").toHaveBeenCalledTimes(1);
    expect((h.batch.mock.calls[0][0] as unknown[]).length).toBe(3);
    expect(h.spills).not.toHaveBeenCalled();
  });

  it("on a floating grid: its own arrays, in its own coordinates", async () => {
    h.targetSpills.mockResolvedValue([{ originRow: 2, originCol: 1, endRow: 2, endCol: 3 }]);
    expect(await paste(column(1), at(2, 3), "values", "add", 10, REF)).toBe(false);
    expect(h.targetSpills).toHaveBeenCalledWith("fr-1");
    expect(h.spills, "the active sheet's arrays were asked about a floating grid's cells").not.toHaveBeenCalled();
    expectNothingWritten();
    // Positive control: a cell of the grid outside its array.
    h.alert.mockClear();
    expect(await paste(column(1), at(3, 3), "values", "add", 10, REF)).toBe(true);
    expect(h.batch).toHaveBeenCalledTimes(1);
  });
});

describe("on a protected sheet, an operation over a WITHHELD formula is refused (the formula cannot be kept)", () => {
  // The typed read says which cells had a formula WITHHELD
  // (`TypedCellData.formulaWithheld`, decided in Rust: a protected sheet hiding
  // a formula the cell HOLDS, whatever its lock state). The gate refuses
  // exactly those; a hidden-format cell holding a constant or nothing is
  // computed over, as Excel does [LIVE, COM 2026-10-29: =A1 hidden + Add 1 ->
  // =(A1)+1; blank hidden + Add 1 -> 1; 7 hidden + Add 1 -> 8].
  type Typed = { row: number; col: number; type: string; value: unknown; display: string; formula: string | null; formulaWithheld?: boolean };

  /** A protected sheet whose destination cells read typed as `dest`, with the copied numbers in column C. */
  function protectedSheetWith(dest: Typed[]): void {
    h.isProtected.mockResolvedValue(true);
    h.typedSheet.mockImplementation(async (r0: number, c0: number, r1: number, c1: number) => {
      const out: Typed[] = [];
      if (c0 <= 2 && c1 >= 2) {
        for (let r = r0; r <= r1; r++) out.push({ row: r, col: 2, type: "number", value: (r + 1) * 10, display: "", formula: null });
      }
      for (const c of dest) if (c.row >= r0 && c.row <= r1 && c.col >= c0 && c.col <= c1) out.push(c);
      return out;
    });
  }

  /**
   * What the round-3 gate read instead: each cell's STYLE (getViewportCells +
   * getStyle), refusing only `formulaHidden && !locked`. Given here so a
   * reverted gate meets the cells it used to misjudge.
   */
  function stylesAre(cells: Array<{ row: number; col: number; locked: boolean }>): void {
    h.viewport.mockResolvedValue(cells.map((c, i) => ({ row: c.row, col: c.col, display: "", formula: null, styleIndex: 20 + i })));
    h.style.mockImplementation(async (index: number) => {
      const cell = cells[index - 20];
      return cell
        ? { numberFormat: "General", locked: cell.locked, formulaHidden: true }
        : { numberFormat: "General", locked: true, formulaHidden: false };
    });
  }

  it("Values > Add of 1 onto the unlocked, hidden =A1 at F3 writes nothing and names the cell", async () => {
    protectedSheetWith([{ row: 2, col: 5, type: "number", value: 5, display: "5", formula: null, formulaWithheld: true }]);
    stylesAre([{ row: 2, col: 5, locked: false }]);
    expect(await paste(column(1), at(2, 5), "values", "add")).toBe(false);
    expectNothingWritten();
    expect(h.typedSheet).toHaveBeenCalledWith(2, 5, 2, 5, undefined);
    expect(h.alert.mock.calls.map((c) => c[0])).toEqual([pasteRefusalSentence.hiddenFormula("Paste Special", "F3")]);
  });

  it("rev3B#2: a LOCKED cell inside an allow-edit range (writable) whose formula is withheld is refused too", async () => {
    // D5 = =A1, locked and hidden, inside an allow-edit range: the backend lets
    // the write through, so a constant would replace the formula.
    protectedSheetWith([{ row: 4, col: 3, type: "number", value: 5, display: "5", formula: null, formulaWithheld: true }]);
    stylesAre([{ row: 4, col: 3, locked: true }]);
    expect(await paste(column(1), at(4, 3), "values", "add")).toBe(false);
    expectNothingWritten();
    expect(h.alert.mock.calls.map((c) => c[0])).toEqual([pasteRefusalSentence.hiddenFormula("Paste Special", "D5")]);
  });

  it("rev3B#3: unlocked hidden cells holding a BLANK and a CONSTANT are computed (blank + 10 = 10, 7 + 20 = 27)", async () => {
    // E5 blank and E6 = 7, both unlocked and set to hide formulas: nothing is
    // withheld, so nothing is refused.
    protectedSheetWith([{ row: 5, col: 4, type: "number", value: 7, display: "7", formula: null }]);
    stylesAre([
      { row: 4, col: 4, locked: false },
      { row: 5, col: 4, locked: false },
    ]);
    expect(await paste(column(2), at(4, 4, 5), "values", "add")).toBe(true);
    expect(h.alert, "a hidden blank or constant was refused").not.toHaveBeenCalled();
    // Both cells in the paste's ONE batch (BUG-0345).
    expect(h.batch.mock.calls.map((c) => c[0])).toEqual([
      [
        { row: 4, col: 4, value: "10", invariant: true, pasted: true },
        { row: 5, col: 4, value: "27", invariant: true, pasted: true },
      ],
    ]);
  });

  it("positive control: a formula the typed read RETURNED is kept, not refused (=(A1)+10)", async () => {
    protectedSheetWith([{ row: 2, col: 5, type: "number", value: 5, display: "5", formula: "=A1" }]);
    expect(await paste(column(1), at(2, 5), "values", "add")).toBe(true);
    expect(h.batch.mock.calls.map((c) => c[0])).toEqual([[{ row: 2, col: 5, value: "=(A1)+10", pasted: true }]]);
  });

  it("an unprotected sheet withholds nothing: the gate reads nothing (only the operation's own read)", async () => {
    expect(await paste(column(1), at(2, 5), "values", "add")).toBe(true);
    expect(h.typedSheet.mock.calls.filter((c) => c[0] === 2 && c[1] === 5)).toHaveLength(1);
    expect(h.viewport).not.toHaveBeenCalled();
  });

  it("a protection state that cannot be read refuses (fail closed)", async () => {
    h.isProtected.mockRejectedValue(new Error("ipc down"));
    expect(await paste(column(1), at(2, 5), "values", "add")).toBe(false);
    expectNothingWritten();
    expect(h.alert.mock.calls.map((c) => c[0])).toEqual([pasteRefusalSentence.protectionUnknown("Paste Special")]);
  });

  it("a typed read that fails on a protected sheet refuses (fail closed)", async () => {
    h.isProtected.mockResolvedValue(true);
    h.typedSheet.mockRejectedValue(new Error("ipc down"));
    expect(await paste(column(1), at(2, 5), "values", "add")).toBe(false);
    expectNothingWritten();
    expect(h.alert.mock.calls.map((c) => c[0])).toEqual([pasteRefusalSentence.protectionUnknown("Paste Special")]);
  });
});

describe("a clipboard taller than a spread argument list (200,000 rows)", () => {
  const TALL = 200_000;

  it("Paste Values pastes instead of throwing RangeError", async () => {
    await expect(paste(column(TALL), at(0, 4), "values", "none", 5)).resolves.toBe(true);
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect((h.batch.mock.calls[0][0] as unknown[]).length, "the paste clamps to the grid's 5 rows").toBe(5);
  });

  it("Values > Add re-reads the 200,000 source rows and pastes", async () => {
    await expect(paste(column(TALL), at(0, 4), "values", "add", 5)).resolves.toBe(true);
    // The source is re-read typed over its whole extent, in bands the backend accepts.
    expect(h.typedSheet.mock.calls.filter((c) => c[1] === 2).map((c) => [c[0], c[2]])).toEqual([
      [0, 99_999],
      [100_000, 199_999],
    ]);
    expect(h.batch, "the five results go out in ONE batch (BUG-0345)").toHaveBeenCalledTimes(1);
    expect((h.batch.mock.calls[0][0] as unknown[]).length).toBe(5);
  });
});
