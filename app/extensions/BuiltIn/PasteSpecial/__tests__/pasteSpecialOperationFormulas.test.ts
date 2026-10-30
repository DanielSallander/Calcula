//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialOperationFormulas.test.ts
// PURPOSE: Paste Special's operations (Add / Subtract / Multiply / Divide) keep
//          a FORMULA a formula, the way Excel does (BUG-0346).
// CONTEXT: The operation used to compute a number from the two cells' values
//          and write it over the destination -- so `=A1` + 1 became the
//          constant 6 and the cell stopped following A1. Excel, measured live
//          through COM (2026-10-29, Range.PasteSpecial, E1 copied onto F3, so
//          a relative reference shifts by one column and two rows):
//            dest `=A1`, source 1        (All / Values / Formulas) -> =(A1)+1  =(A1)-1  =(A1)*1  =(A1)/1
//            dest 5, source `=C1`        (All / Formulas)          -> =5+(D3)  =5-(D3)  =5*(D3)  =5/(D3)
//            dest 5, source `=C1`        (Values)                  -> 15 (the source's value; a constant)
//            dest `=A1`, source `=C1`    (All)                     -> =(A1)+(D3)
//            dest `=A1`, source `=C1`    (Values)                  -> =(A1)+10
//            blank dest, source `=C1`    (All)                     -> =0+(D3)
//            blank dest, source 1        (Add / Subtract)          -> 1 / -1 (constants)
//            blank dest, blank source                              -> stays blank
//            dest `=A1`, blank source                              -> =(A1)+0
//            dest `=A1`, source -2       (Subtract)                -> =(A1)--2
//            dest `="x"`, source 1                                 -> =("x")+1 (#VALUE!)
//            dest "abc" / TRUE / #N/A (constants), source 1        -> unchanged
//            dest 5 or `=A1`, source "abc"                         -> unchanged
//            dest `=A1`, source `=TRUE`  (Values)                  -> =(A1)+1
//            dest `=A1`, source `=1/0`   (Values)                  -> unchanged
//          The formula goes through the user-input parser like every pasted
//          formula, so a number in it is spelled in the APP locale (`1,5`
//          under a comma-decimal locale); a constant result stays INVARIANT.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  batch: vi.fn(),
  typedSheet: vi.fn(),
  typedTarget: vi.fn(),
  shift: vi.fn(),
  begin: vi.fn(),
  commit: vi.fn(),
  cancel: vi.fn(),
  alert: vi.fn(),
  decimal: ".",
  /** The backend's sheet list NOW, for a copy that recorded its sheet's id. */
  sheets: { sheets: [] as Array<{ index: number; name: string; sheetId: string; visibility: string }>, activeIndex: 0 },
  /** What the engine stores, "sheet:row,col" -> typed cell (sheet 0 = the active sheet). */
  stored: new Map<string, unknown>(),
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 2, startCol: 5, endRow: 2, endCol: 5, type: "cells" },
    config: { totalRows: 1000, totalCols: 100 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(async () => ({ numberFormat: "General" })),
  updateCell: vi.fn(async () => ({ cells: [] })),
  setCellStyle: vi.fn(async () => undefined),
  applyFormatting: vi.fn(async () => ({ cells: [], styles: [] })),
  updateCellsBatch: (...a: unknown[]) => h.batch(...a),
  getRangeCellsTyped: (...a: unknown[]) => h.typedSheet(...a),
  getSheets: vi.fn(async () => h.sheets),
  shiftFormulasBatch: (...a: unknown[]) => h.shift(...a),
  beginUndoTransaction: (...a: unknown[]) => h.begin(...a),
  commitUndoTransaction: (...a: unknown[]) => h.commit(...a),
  cancelUndoTransaction: (...a: unknown[]) => h.cancel(...a),
  // An operation's own gates (no array, no hidden formula) find nothing here.
  getSpillRanges: vi.fn(async () => []),
  isSheetProtected: vi.fn(async () => false),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: (...a: unknown[]) => h.typedTarget(...a),
}));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));
vi.mock("@api/locale", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/locale")>()),
  decimalSeparator: () => h.decimal,
}));

import { executePasteSpecial } from "../pasteSpecialExecute";
import type { PasteAttribute, PasteOperation } from "../types";

/** The destination: F3 (row 2, col 5). The copy: E1 (row 0, col 4), one cell. */
const DEST = { row: 2, col: 5 };
const TARGET = { startRow: 2, startCol: 5, endRow: 2, endCol: 5, type: "cells" } as never;
const REF = { kind: "floatingRange" as const, id: "fr-1" };

type Kind = "number" | "text" | "boolean" | "error" | "empty";
const typed = (row: number, col: number, type: Kind, value: unknown, formula: string | null = null) => ({
  row,
  col,
  type,
  value,
  formula,
  display: String(value ?? ""),
});

/** A one-cell copy of E1 holding `formula` (or the constant `display`). */
function clip(display: string, formula: string | null = null): never {
  return {
    cells: [[display === "" && formula === null ? null : { row: 0, col: 4, display, formula, styleIndex: 0 }]],
    sourceSelection: { startRow: 0, startCol: 4, endRow: 0, endCol: 4, type: "cells" },
    sourceRows: [0],
    isCut: false,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    text: display,
  } as never;
}

/** Store the source E1 and the destination F3 as the engine holds them. */
function given(dest: ReturnType<typeof typed> | null, source: ReturnType<typeof typed> | null): void {
  h.stored.clear();
  if (dest) h.stored.set(`0:${dest.row},${dest.col}`, dest);
  if (source) h.stored.set(`0:${source.row},${source.col}`, source);
}

async function paste(clipboard: never, pasteAttribute: PasteAttribute, operation: PasteOperation): Promise<boolean> {
  return executePasteSpecial(
    clipboard,
    TARGET,
    { pasteAttribute, operation, skipBlanks: false, transpose: false },
    1000,
    100,
    "Paste Special",
  );
}

/** Every write the paste made: value and whether it went INVARIANT. */
function writes(): Array<{ value: string; invariant: boolean }> {
  return h.batch.mock.calls.flatMap((c) =>
    (c[0] as Array<{ value: string; invariant?: boolean }>).map((u) => ({ value: u.value, invariant: u.invariant === true })),
  );
}

const formulaWrite = (value: string) => [{ value, invariant: false }];
const constantWrite = (value: string) => [{ value, invariant: true }];

beforeEach(() => {
  for (const fn of [h.batch, h.typedSheet, h.typedTarget, h.shift, h.begin, h.commit, h.cancel, h.alert]) fn.mockReset();
  h.decimal = ".";
  h.batch.mockResolvedValue([]);
  h.begin.mockResolvedValue(7);
  h.commit.mockResolvedValue(undefined);
  h.cancel.mockResolvedValue(undefined);
  h.alert.mockResolvedValue(undefined);
  h.typedSheet.mockImplementation(async (r0: number, c0: number, r1: number, c1: number, sheet?: number) => {
    const out: unknown[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = h.stored.get(`${sheet ?? 0}:${r},${c}`);
        if (cell) out.push(cell);
      }
    }
    return out;
  });
  // Excel's relative shift from E1 to F3: one column right, two rows down.
  h.shift.mockImplementation(async (inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>) =>
    inputs.map((i) => {
      expect([i.rowDelta, i.colDelta]).toEqual([2, 1]);
      return i.formula.replace("C1", "D3");
    }),
  );
});

describe("a destination FORMULA stays a formula: =(old) op source", () => {
  const OPS: Array<[PasteOperation, string]> = [
    ["add", "=(A1)+1"],
    ["subtract", "=(A1)-1"],
    ["multiply", "=(A1)*1"],
    ["divide", "=(A1)/1"],
  ];
  for (const attribute of ["all", "values", "formulas"] as PasteAttribute[]) {
    for (const [op, expected] of OPS) {
      it(`${attribute} + ${op}: =A1 with 1 copied -> ${expected}`, async () => {
        given(typed(DEST.row, DEST.col, "number", 5, "=A1"), typed(0, 4, "number", 1));
        expect(await paste(clip("1"), attribute, op)).toBe(true);
        expect(writes(), "the operation wrote a constant over the destination's formula").toEqual(formulaWrite(expected));
      });
    }
  }

  it("whatever the formula evaluates to: =\"x\" + 1 -> =(\"x\")+1, an error formula wrapped too", async () => {
    given(typed(DEST.row, DEST.col, "text", "x", '="x"'), typed(0, 4, "number", 1));
    await paste(clip("1"), "all", "add");
    expect(writes()).toEqual(formulaWrite('=("x")+1'));
    h.batch.mockClear();
    given(typed(DEST.row, DEST.col, "error", "#DIV/0!", "=1/0"), typed(0, 4, "number", 1));
    await paste(clip("1"), "all", "add");
    expect(writes()).toEqual(formulaWrite("=(1/0)+1"));
  });

  it("a negative source is spelled as Excel spells it: =(A1)--2", async () => {
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), typed(0, 4, "number", -2));
    await paste(clip("-2"), "all", "subtract");
    expect(writes()).toEqual(formulaWrite("=(A1)--2"));
  });

  it("a blank source counts as 0: =(A1)+0", async () => {
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), null);
    await paste(clip(""), "all", "add");
    expect(writes()).toEqual(formulaWrite("=(A1)+0"));
  });

  it("a fraction is spelled in the APP locale (the formula goes through the user-input parser)", async () => {
    h.decimal = ",";
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), typed(0, 4, "number", 1.5));
    await paste(clip("1,5"), "values", "add");
    expect(writes()).toEqual(formulaWrite("=(A1)+1,5"));
  });
});

describe("a SOURCE formula, under an attribute that pastes formulas, stays a formula (shifted)", () => {
  const OPS: Array<[PasteOperation, string]> = [
    ["add", "=5+(D3)"],
    ["subtract", "=5-(D3)"],
    ["multiply", "=5*(D3)"],
    ["divide", "=5/(D3)"],
  ];
  for (const attribute of ["all", "formulas"] as PasteAttribute[]) {
    for (const [op, expected] of OPS) {
      it(`${attribute} + ${op}: 5 with =C1 copied -> ${expected}`, async () => {
        given(typed(DEST.row, DEST.col, "number", 5), typed(0, 4, "number", 10, "=C1"));
        await paste(clip("10", "=C1"), attribute, op);
        expect(writes()).toEqual(formulaWrite(expected));
      });
    }
  }

  it("both formulas: =(A1)+(D3)", async () => {
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), typed(0, 4, "number", 10, "=C1"));
    await paste(clip("10", "=C1"), "all", "add");
    expect(writes()).toEqual(formulaWrite("=(A1)+(D3)"));
  });

  it("a blank destination counts as 0: =0+(D3)", async () => {
    given(null, typed(0, 4, "number", 10, "=C1"));
    await paste(clip("10", "=C1"), "all", "add");
    expect(writes()).toEqual(formulaWrite("=0+(D3)"));
  });

  it("No Borders and Formulas & Number Formats paste formulas too", async () => {
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), typed(0, 4, "number", 10, "=C1"));
    await paste(clip("10", "=C1"), "allExceptBorders", "add");
    await paste(clip("10", "=C1"), "formulasAndNumberFormats", "add");
    expect(writes()).toEqual([...formulaWrite("=(A1)+(D3)"), ...formulaWrite("=(A1)+(D3)")]);
  });
});

describe("a VALUES attribute pastes the source's value", () => {
  it("5 with =C1 (10) copied -> the constant 15, invariant", async () => {
    given(typed(DEST.row, DEST.col, "number", 5), typed(0, 4, "number", 10, "=C1"));
    await paste(clip("10", "=C1"), "values", "add");
    expect(writes()).toEqual(constantWrite("15"));
  });

  it("=A1 with =C1 (10) copied -> =(A1)+10", async () => {
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), typed(0, 4, "number", 10, "=C1"));
    await paste(clip("10", "=C1"), "valuesAndNumberFormats", "add");
    expect(writes()).toEqual(formulaWrite("=(A1)+10"));
  });

  it("a source formula's TRUE counts as 1; its error leaves the destination alone", async () => {
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), typed(0, 4, "boolean", true, "=TRUE"));
    await paste(clip("TRUE", "=TRUE"), "values", "add");
    expect(writes()).toEqual(formulaWrite("=(A1)+1"));
    h.batch.mockClear();
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), typed(0, 4, "error", "#DIV/0!", "=1/0"));
    await paste(clip("#DIV/0!", "=1/0"), "values", "add");
    expect(writes()).toEqual([]);
  });
});

describe("two constants compute a constant; an inert side writes nothing", () => {
  it("5 + 1.5 = 6.5, invariant", async () => {
    given(typed(DEST.row, DEST.col, "number", 5), typed(0, 4, "number", 1.5));
    await paste(clip("1.5"), "all", "add");
    expect(writes()).toEqual(constantWrite("6.5"));
  });

  it("a blank destination: 1 added is 1, subtracted -1 (constants)", async () => {
    given(null, typed(0, 4, "number", 1));
    await paste(clip("1"), "all", "add");
    await paste(clip("1"), "all", "subtract");
    expect(writes()).toEqual([...constantWrite("1"), ...constantWrite("-1")]);
  });

  it("5 divided by a blank source is #DIV/0!", async () => {
    given(typed(DEST.row, DEST.col, "number", 5), null);
    await paste(clip(""), "all", "divide");
    expect(writes()).toEqual(constantWrite("#DIV/0!"));
  });

  it("blank on blank stays blank (Excel writes no 0)", async () => {
    given(null, null);
    await paste(clip(""), "all", "add");
    await paste(clip(""), "values", "divide");
    expect(writes()).toEqual([]);
  });

  it("text, TRUE or #N/A in the destination is left as it is", async () => {
    for (const dest of [
      typed(DEST.row, DEST.col, "text", "abc"),
      typed(DEST.row, DEST.col, "boolean", true),
      typed(DEST.row, DEST.col, "error", "#N/A"),
    ]) {
      given(dest, typed(0, 4, "number", 1));
      await paste(clip("1"), "all", "add");
    }
    expect(writes(), "an operation wrote over a destination Excel leaves alone").toEqual([]);
  });

  it("text copied leaves a number AND a formula destination as they are", async () => {
    given(typed(DEST.row, DEST.col, "number", 5), typed(0, 4, "text", "abc"));
    await paste(clip("abc"), "all", "add");
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), typed(0, 4, "text", "abc"));
    await paste(clip("abc"), "all", "add");
    expect(writes()).toEqual([]);
  });
});

describe("one paste is ONE undo step", () => {
  it("a two-cell operation opens one step and commits it once", async () => {
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), typed(0, 4, "number", 1));
    h.stored.set(`0:${DEST.row},${DEST.col + 1}`, typed(DEST.row, DEST.col + 1, "number", 3));
    h.stored.set("0:0,5", typed(0, 5, "number", 2, "=C1"));
    const twoCells = {
      cells: [[
        { row: 0, col: 4, display: "1", formula: null, styleIndex: 0 },
        { row: 0, col: 5, display: "2", formula: "=C1", styleIndex: 0 },
      ]],
      sourceSelection: { startRow: 0, startCol: 4, endRow: 0, endCol: 5, type: "cells" },
      sourceRows: [0],
      isCut: false,
      sourceSheetIndex: 0,
      sourceSheetName: "Sheet1",
      text: "1\t2",
    } as never;
    await paste(twoCells, "all", "add");
    expect(writes()).toEqual([...formulaWrite("=(A1)+1"), ...formulaWrite("=3+(D3)")]);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.commit.mock.calls[0]).toContain(7);
    expect(h.cancel).not.toHaveBeenCalled();
  });
});

describe("on a floating grid's cells the same rules hold", () => {
  it("=A1 on the grid with 1 copied -> =(A1)+1 in ONE targeted batch, not invariant", async () => {
    given(null, typed(0, 4, "number", 1));
    h.typedTarget.mockResolvedValue([typed(3, 0, "number", 5, "=A1"), typed(3, 1, "text", "abc")]);
    const twoWide = {
      cells: [[
        { row: 0, col: 4, display: "1", formula: null, styleIndex: 0 },
        { row: 0, col: 5, display: "1", formula: null, styleIndex: 0 },
      ]],
      sourceSelection: { startRow: 0, startCol: 4, endRow: 0, endCol: 5, type: "cells" },
      sourceRows: [0],
      isCut: false,
      sourceSheetIndex: 0,
      sourceSheetName: "Sheet1",
      text: "1\t1",
    } as never;
    h.stored.set("0:0,5", typed(0, 5, "number", 1));
    const done = await executePasteSpecial(
      twoWide,
      { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" } as never,
      { pasteAttribute: "values", operation: "add", skipBlanks: false, transpose: false },
      10,
      5,
      "Paste Special",
      REF,
    );
    expect(done).toBe(true);
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect(h.batch.mock.calls[0][1]).toEqual({ target: REF });
    // The grid's text cell is inert: only the formula cell is written.
    // Written as a PASTE: it stays a formula in an @ cell (CellUpdateInput.pasted).
    expect(h.batch.mock.calls[0][0]).toEqual([{ row: 3, col: 0, value: "=(A1)+1", pasted: true }]);
  });
});

describe("the source is re-read on ITS sheet, found by its id (BUG-0348's other half)", () => {
  const withId = (): never => ({ ...(clip("1") as object), sourceSheetId: "S1" }) as never;

  it("renamed and moved since the copy: the value is read where the sheet is NOW", async () => {
    // Copied on Sheet1 at index 0; a sheet inserted before it moved it to index 2.
    h.sheets = {
      sheets: [
        { index: 0, name: "Summary", sheetId: "S0", visibility: "visible" },
        { index: 1, name: "New", sheetId: "S9", visibility: "visible" },
        { index: 2, name: "Data", sheetId: "S1", visibility: "visible" },
      ],
      activeIndex: 0,
    };
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), null);
    h.stored.set("2:0,4", typed(0, 4, "number", 1));
    h.stored.set("0:0,4", typed(0, 4, "number", 99));
    await paste(withId(), "values", "add");
    expect(h.typedSheet).toHaveBeenCalledWith(0, 4, 0, 4, 2);
    expect(writes(), "the source was read on the sheet now at the index recorded at the copy").toEqual(
      formulaWrite("=(A1)+1"),
    );
  });

  it("deleted since the copy: the copied text stands in, never the cell now at the old index", async () => {
    h.sheets = { sheets: [{ index: 0, name: "Summary", sheetId: "S0", visibility: "visible" }], activeIndex: 0 };
    given(typed(DEST.row, DEST.col, "number", 5, "=A1"), null);
    h.stored.set("0:0,4", typed(0, 4, "number", 99));
    await paste(withId(), "values", "add");
    expect(writes()).toEqual(formulaWrite("=(A1)+1"));
  });
});
