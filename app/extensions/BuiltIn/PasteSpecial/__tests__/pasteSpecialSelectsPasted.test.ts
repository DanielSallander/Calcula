//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialSelectsPasted.test.ts
// PURPOSE: BUG-0349. Every Paste Special variant SELECTS the pasted range, as
//          plain Paste does and as Excel does; and Values / Formulas and Number
//          Formats give an EMPTY source position's number format to its
//          destination too.
// CONTEXT: Excel, measured live through COM (Excel 16 build 20527, 2026-11-04,
//          paste-x/probe1.ps1): a 3x2 copy of A1:B3 pasted on D1 as Values,
//          Formulas, Formats, All Except Borders, Values and Number Formats,
//          Formulas and Number Formats, All and Paste Link leaves D1:E3
//          selected (D1 active); Transpose D1:F2; into D1:E4 (no multiple)
//          D1:E3; into D1:E6 (a multiple, tiled) D1:E6. G1 = 5 and an EMPTY G2
//          (General) pasted with Values and Number Formats onto I1:I2 (9 in
//          0.00 and 9 in 0%, bold) leaves I2 EMPTY in General, still bold.
//          Calcula left the selection where it was, and skipped the empty
//          position's number format.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  batch: vi.fn(),
  applyFormatting: vi.fn(),
  setCellStyle: vi.fn(),
  setCellStyles: vi.fn(),
  select: vi.fn(),
  owner: null as unknown,
  alert: vi.fn(),
  protectedSheet: false,
  setDV: vi.fn(),
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 0, startCol: 3, endRow: 0, endCol: 3, type: "cells" },
    config: { totalRows: 1000, totalCols: 100 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getCell: vi.fn(async () => null),
  // Style 7 shows 0.000; every other style (the default 0 included) is General.
  getStyle: vi.fn(async (i: number) => ({ numberFormat: i === 7 ? "0.000" : "General" })),
  updateCell: vi.fn(async () => ({ cells: [] })),
  setCellStyle: (...a: unknown[]) => h.setCellStyle(...a),
  setCellStyles: (...a: unknown[]) => h.setCellStyles(...a),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  updateCellsBatch: (...a: unknown[]) => h.batch(...a),
  setDataValidation: (...a: unknown[]) => h.setDV(...a),
  getRangeCellsTyped: vi.fn(async () => []),
  getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1", sheetId: "sheet-a" }], activeIndex: 0 })),
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string }>) => inputs.map((i) => i.formula)),
  getMergedRegions: vi.fn(async () => []),
  beginUndoTransaction: vi.fn(async () => 5),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
  getSpillRanges: vi.fn(async () => []),
  isSheetProtected: vi.fn(async () => h.protectedSheet),
  // A protected host with Format Cells NOT allowed and every destination unlocked.
  canPerformAction: vi.fn(async () => ({ canEdit: false, reason: "Format Cells is not allowed." })),
  canEditCells: vi.fn(async () => ({ canEdit: true, reason: "" })),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: vi.fn(async () => []),
  getCellTargetCells: vi.fn(async () => ({ cells: [], merges: [], conditional: [], styles: [], rules: [] })),
  selectTargetCells: (...a: unknown[]) => h.select(...a),
  cellTargetFor: () => h.owner ?? { kind: "grid", selection: null },
}));
vi.mock("@api/floatingRangeSpills", () => ({ getFloatingRangeSpillRanges: vi.fn(async () => []) }));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import { executePasteLink, executePasteSpecial, validationGroups } from "../pasteSpecialExecute";
import type { PasteAttribute } from "../types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };

/** A copy of A1:B3 (1..6), every cell in style 0. */
const A1B3 = (() => {
  const cells = [];
  const values = [];
  for (let r = 0; r < 3; r++) {
    cells.push([0, 1].map((c) => ({ row: r, col: c, display: String(r * 2 + c + 1), formula: null, styleIndex: 0 })));
    values.push([0, 1].map((c) => ({ type: "number", value: r * 2 + c + 1 })));
  }
  return {
    cells,
    values,
    sourceSelection: { startRow: 0, startCol: 0, endRow: 2, endCol: 1, type: "cells" },
    sourceRows: [0, 1, 2],
    isCut: false,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    sourceSheetId: "sheet-a",
    text: "",
  } as never;
})();

const sel = (r0: number, c0: number, r1: number, c1: number) =>
  ({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }) as never;

function paste(pasteAttribute: PasteAttribute, dest: never, transpose = false, target?: typeof REF): Promise<boolean> {
  return executePasteSpecial(
    A1B3,
    dest,
    { pasteAttribute, operation: "none", skipBlanks: false, transpose },
    target ? 10 : 1000,
    target ? 10 : 100,
    "Paste Special",
    target,
  );
}

/** The one selection the paste made: [kind of target, the rectangle]. */
function selected(): Array<[string, { startRow: number; startCol: number; endRow: number; endCol: number }]> {
  return h.select.mock.calls.map((c) => {
    const [t, s] = c as [{ kind: string }, { startRow: number; startCol: number; endRow: number; endCol: number }];
    return [t.kind, { startRow: s.startRow, startCol: s.startCol, endRow: s.endRow, endCol: s.endCol }];
  });
}

const D1E3 = { startRow: 0, startCol: 3, endRow: 2, endCol: 4 };

beforeEach(() => {
  for (const fn of [h.batch, h.applyFormatting, h.setCellStyle, h.setCellStyles, h.select, h.alert]) fn.mockReset();
  h.batch.mockResolvedValue([]);
  h.applyFormatting.mockResolvedValue({ cells: [], styles: [] });
  h.setCellStyle.mockResolvedValue(null);
  h.setCellStyles.mockResolvedValue(undefined);
  h.alert.mockResolvedValue(undefined);
  h.owner = null;
  h.protectedSheet = false;
  h.setDV.mockReset();
  h.setDV.mockResolvedValue({ success: true, validation: null, error: null });
});

describe("[LIVE] every Paste Special variant selects the pasted range (BUG-0349)", () => {
  for (const attribute of ["values", "formulas", "formats", "allExceptBorders", "valuesAndNumberFormats", "formulasAndNumberFormats", "all", "valuesAndSourceFormatting"] as const) {
    it(`${attribute}: A1:B3 pasted on D1 selects D1:E3`, async () => {
      expect(await paste(attribute, sel(0, 3, 0, 3))).toBe(true);
      expect(selected(), `${attribute} left the selection where it was`).toEqual([["grid", D1E3]]);
    });
  }

  it("Transpose selects the transposed range, D1:F2", async () => {
    await paste("all", sel(0, 3, 0, 3), true);
    expect(selected()).toEqual([["grid", { startRow: 0, startCol: 3, endRow: 1, endCol: 5 }]]);
  });

  it("a selection that is no multiple (D1:E4) pastes once and selects D1:E3; a multiple (D1:E6) selects the tiled D1:E6", async () => {
    await paste("values", sel(0, 3, 3, 4));
    expect(selected()).toEqual([["grid", D1E3]]);
    h.select.mockReset();
    await paste("values", sel(0, 3, 5, 4));
    expect(selected()).toEqual([["grid", { startRow: 0, startCol: 3, endRow: 5, endCol: 4 }]]);
  });

  it("Paste Link selects the pasted range", async () => {
    expect(await executePasteLink(A1B3, sel(0, 3, 0, 3), 1000, 100)).toBe(true);
    expect(selected()).toEqual([["grid", D1E3]]);
  });

  // BUG-0725 [LIVE, Excel 16 COM, 2026-11-06, backmisc/probe1.ps1]: a
  // formatting-only Paste Special that CHANGES NOTHING -- onto unlocked cells of
  // a protected sheet with Format Cells off -- still selects the destination
  // (Excel: C1:C3 selected, C1 not bold). Calcula selected nothing.
  // SABOTAGE: drop the selectPastedSheetArea call in the nothingToPaste branch.
  it("a formatting-only paste that changes nothing still selects the destination, on a sheet and on a floating grid", async () => {
    h.protectedSheet = true;
    h.setCellStyle.mockRejectedValue(new Error("Format Cells is not allowed."));
    expect(await paste("formats", sel(0, 3, 0, 3))).toBe(true);
    expect(h.setCellStyles, "nothing was formatted").not.toHaveBeenCalled();
    expect(selected()).toEqual([["grid", D1E3]]);
    h.select.mockReset();
    h.owner = { kind: "object", ownerId: "floatingRange", ref: REF, selection: sel(3, 0, 3, 0), bounds: { rows: 10, cols: 10 }, label: "Float1", wholeObject: false };
    expect(await paste("formats", sel(3, 0, 3, 0), false, REF)).toBe(true);
    expect(h.setCellStyles).not.toHaveBeenCalled();
    expect(h.alert, "nothing is said").not.toHaveBeenCalled();
    expect(selected()).toEqual([["object", { startRow: 3, startCol: 0, endRow: 5, endCol: 1 }]]);
  });

  it("a paste the backend refuses selects nothing", async () => {
    h.batch.mockRejectedValue(new Error("The cell is protected."));
    await expect(paste("values", sel(0, 3, 0, 3))).rejects.toThrow("protected");
    expect(h.select).not.toHaveBeenCalled();
  });

  it("on a floating grid: the GRID's own selection, through the owner that holds it", async () => {
    h.owner = { kind: "object", ownerId: "floatingRange", ref: REF, selection: sel(3, 0, 3, 0), bounds: { rows: 10, cols: 10 }, label: "Float1", wholeObject: false };
    expect(await paste("values", sel(3, 0, 3, 0), false, REF)).toBe(true);
    expect(selected()).toEqual([["object", { startRow: 3, startCol: 0, endRow: 5, endCol: 1 }]]);
  });

  it("on a floating grid whose owner no longer answers that grid: nothing is selected (never another object's cells)", async () => {
    h.owner = { kind: "object", ownerId: "floatingRange", ref: { kind: "floatingRange", id: "fr-OTHER" }, selection: sel(0, 0, 0, 0), bounds: { rows: 10, cols: 10 }, label: "Float2", wholeObject: false };
    expect(await paste("values", sel(3, 0, 3, 0), false, REF)).toBe(true);
    expect(h.select).not.toHaveBeenCalled();
  });
});

describe("[LIVE] Values / Formulas and Number Formats give an EMPTY source position's number format too (BUG-0349)", () => {
  /** A copy of G1:G2: G1 = 5 (General); G2 an EMPTY position, or an empty cell formatted 0.000 (style 7). */
  function g1g2(emptyStyle: number | null): never {
    return {
      cells: [[{ row: 0, col: 6, display: "5", formula: null, styleIndex: 0 }], [emptyStyle === null ? null : { row: 1, col: 6, display: "", formula: null, styleIndex: emptyStyle }]],
      values: [[{ type: "number", value: 5 }], [null]],
      sourceSelection: { startRow: 0, startCol: 6, endRow: 1, endCol: 6, type: "cells" },
      sourceRows: [0, 1],
      isCut: false,
      sourceSheetIndex: 0,
      sourceSheetName: "Sheet1",
      sourceSheetId: "sheet-a",
      text: "",
    } as never;
  }

  /** Every number format written, "row,col=format" (a rows x columns call expanded). */
  function formats(): string[] {
    return h.applyFormatting.mock.calls.flatMap((c) => {
      const [rows, cols, fmt] = c as [number[], number[], { numberFormat: string }];
      return rows.flatMap((r) => cols.map((col) => `${r},${col}=${fmt.numberFormat}`));
    }).sort();
  }

  for (const attribute of ["valuesAndNumberFormats", "formulasAndNumberFormats"] as const) {
    it(`${attribute}: the empty G2 gives I2 General (its 0% goes); an empty G2 in 0.000 gives 0.000`, async () => {
      await executePasteSpecial(g1g2(null), sel(0, 8, 0, 8), { pasteAttribute: attribute, operation: "none", skipBlanks: false, transpose: false }, 1000, 100);
      expect(formats(), "the empty source position's number format was skipped").toEqual(["0,8=General", "1,8=General"]);
      h.applyFormatting.mockClear();
      await executePasteSpecial(g1g2(7), sel(0, 8, 0, 8), { pasteAttribute: attribute, operation: "none", skipBlanks: false, transpose: false }, 1000, 100);
      expect(formats()).toEqual(["0,8=General", "1,8=0.000"]);
    });

    it(`${attribute} on a floating grid: the same`, async () => {
      h.owner = { kind: "object", ownerId: "floatingRange", ref: REF, selection: sel(0, 0, 0, 0), bounds: { rows: 10, cols: 10 }, label: "Float1", wholeObject: false };
      await executePasteSpecial(g1g2(null), sel(0, 0, 0, 0), { pasteAttribute: attribute, operation: "none", skipBlanks: false, transpose: false }, 10, 10, "Paste Special", REF);
      expect(formats()).toEqual(["0,0=General", "1,0=General"]);
    });
  }

  it("Skip Blanks still skips the empty position (nothing is written there)", async () => {
    await executePasteSpecial(g1g2(null), sel(0, 8, 0, 8), { pasteAttribute: "valuesAndNumberFormats", operation: "none", skipBlanks: true, transpose: false }, 1000, 100);
    expect(formats()).toEqual(["0,8=General"]);
  });
});

// BUG-0725: Paste Validation wrote ONE backend call per cell. A block under
// one rule is now one call over the pasted block, a block under two rules one
// call per rectangle of each, all in the paste's one undo step.
// SABOTAGE: make validationGroups return one 1x1 rectangle per cell.
describe("Paste Validation sends one call per rectangle of one rule (BUG-0725)", () => {
  const ruleA = { rule: { type: "wholeNumber", operator: "between", formula1: "1", formula2: "9" } };
  const ruleB = { rule: { type: "list", source: "a,b" } };
  function withRules(rules: Array<Array<unknown>>): never {
    const validations = new Map<string, unknown>();
    rules.forEach((row, r) => row.forEach((v, c) => { if (v) validations.set(`${r},${c}`, v); }));
    return { ...(A1B3 as object), validations } as never;
  }

  it("a 3x2 block under one rule is ONE call over the pasted D1:E3", async () => {
    const clip = withRules([[ruleA, ruleA], [ruleA, ruleA], [ruleA, ruleA]]);
    expect(await executePasteSpecial(clip, sel(0, 3, 0, 3), { pasteAttribute: "validation", operation: "none", skipBlanks: false, transpose: false }, 1000, 100)).toBe(true);
    expect(h.setDV.mock.calls.map((c) => c.slice(0, 4))).toEqual([[0, 3, 2, 4]]);
  });

  it("two rules side by side: one call per column block; a cell without a rule is left alone", () => {
    const groups = validationGroups([
      { row: 0, col: 0, validation: ruleA }, { row: 1, col: 0, validation: ruleA },
      { row: 0, col: 1, validation: ruleB }, { row: 1, col: 1, validation: ruleB },
      { row: 0, col: 2, validation: ruleB },
    ] as never);
    expect(groups.map((g) => [g.startRow, g.startCol, g.endRow, g.endCol, g.validation === ruleA ? "A" : "B"])).toEqual([
      [0, 0, 1, 0, "A"],
      [0, 1, 1, 1, "B"],
      [0, 2, 0, 2, "B"],
    ]);
  });

  it("a refused rectangle is told, not dropped unread", async () => {
    h.setDV.mockResolvedValue({ success: false, validation: null, error: "The cell is protected." });
    const clip = withRules([[ruleA, ruleA], [ruleA, ruleA], [ruleA, ruleA]]);
    await executePasteSpecial(clip, sel(0, 3, 0, 3), { pasteAttribute: "validation", operation: "none", skipBlanks: false, transpose: false }, 1000, 100);
    expect(String(h.alert.mock.calls[0]?.[0])).toContain("The cell is protected.");
  });
});
