//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialKeepsKind.test.ts
// PURPOSE: A pasted NUMBER or FORMULA stays one in a Text-formatted (@) cell,
//          and a floating grid's Paste All with an operation pastes the source
//          format onto the cells the operation leaves alone.
// CONTEXT: Round-2 review of BUG-0346 (revE#2, revE#4). Excel, measured live
//          through COM (2026-10-29), in an @ cell:
//            =A1 + Values > Add 1      -> the formula =(A1)+1 (HasFormula True), still @
//            5 + Values > Add 1        -> the NUMBER 6, still @
//            blank + Values > Add 1    -> the number 1
//            Paste Formulas of =A1     -> a formula
//          The engine reads every TYPED entry into an @ cell as text (the
//          typed-entry ladder's rung 3, right for typing), so Calcula stored
//          "=(A1)+1" as text. Since round 5 every paste write says it is one
//          (`CellUpdateInput.pasted`) and the ladder skips that rung for it,
//          in the same write. And Excel's Paste All + Add onto "abc" with a bold 0.00% 1
//          leaves "abc" and pastes bold and 0.00%; on a floating grid the
//          source's style rode only on a cell the operation WROTE, so it was lost.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  batch: vi.fn(),
  updateCell: vi.fn(),
  setCellStyle: vi.fn(),
  setCellStyles: vi.fn(),
  applyFormatting: vi.fn(),
  typedSheet: vi.fn(),
  typedTarget: vi.fn(),
  styledTarget: vi.fn(),
  style: vi.fn(),
  alert: vi.fn(),
  /** Every backend write, in order. */
  log: [] as string[],
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
  getStyle: (...a: unknown[]) => h.style(...a),
  updateCell: (...a: unknown[]) => h.updateCell(...a),
  setCellStyle: (...a: unknown[]) => h.setCellStyle(...a),
  setCellStyles: (...a: unknown[]) => h.setCellStyles(...a),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  updateCellsBatch: (...a: unknown[]) => h.batch(...a),
  getRangeCellsTyped: (...a: unknown[]) => h.typedSheet(...a),
  getSheets: vi.fn(async () => ({ sheets: [], activeIndex: 0 })),
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string }>) => inputs.map((i) => i.formula.replace("C1", "D3"))),
  beginUndoTransaction: vi.fn(async () => 5),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
  getSpillRanges: vi.fn(async () => []),
  isSheetProtected: vi.fn(async () => false),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: (...a: unknown[]) => h.typedTarget(...a),
  getCellTargetCells: (...a: unknown[]) => h.styledTarget(...a),
}));
vi.mock("@api/floatingRangeSpills", () => ({ getFloatingRangeSpillRanges: vi.fn(async () => []) }));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import { executePasteLink, executePasteSpecial } from "../pasteSpecialExecute";
import type { PasteAttribute, PasteOperation } from "../types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };
/** Style 9 is formatted as Text (@); every other style is General. */
const TEXT_STYLE = 9;
const F3 = { startRow: 2, startCol: 5, endRow: 2, endCol: 5, type: "cells" } as never;

type Kind = "number" | "text" | "boolean" | "error" | "empty";
const typed = (row: number, col: number, type: Kind, value: unknown, formula: string | null = null) => ({
  row,
  col,
  type,
  value,
  formula,
  display: String(value ?? ""),
});

/** A one-cell copy of E1 (row 0, col 4), its style `styleIndex`. */
function clip(display: string, formula: string | null = null, styleIndex = 0): never {
  return {
    cells: [[display === "" && formula === null ? null : { row: 0, col: 4, display, formula, styleIndex }]],
    sourceSelection: { startRow: 0, startCol: 4, endRow: 0, endCol: 4, type: "cells" },
    sourceRows: [0],
    isCut: false,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    text: display,
  } as never;
}

async function paste(
  clipboard: never,
  pasteAttribute: PasteAttribute,
  operation: PasteOperation,
  target?: typeof REF,
  dest: never = F3,
): Promise<boolean> {
  return executePasteSpecial(
    clipboard,
    dest,
    { pasteAttribute, operation, skipBlanks: false, transpose: false },
    target ? 10 : 1000,
    target ? 10 : 100,
    "Paste Special",
    target,
  );
}

/** The cell the backend answers for a write at (row, col): it landed in style `styleIndex`. */
const landedIn = (row: number, col: number, styleIndex: number) => [{ row, col, display: "", formula: null, styleIndex }];

let destStyle = TEXT_STYLE;

beforeEach(() => {
  for (const fn of [h.batch, h.updateCell, h.setCellStyle, h.setCellStyles, h.applyFormatting, h.typedSheet, h.typedTarget, h.styledTarget, h.style, h.alert]) {
    fn.mockReset();
  }
  h.log.length = 0;
  destStyle = TEXT_STYLE;
  h.style.mockImplementation(async (i: number) => ({ numberFormat: i === TEXT_STYLE ? "@" : "General" }));
  // Every write answers the written cells as they landed: in the destination's style.
  h.batch.mockImplementation(async (updates: Array<{ row: number; col: number; styleIndex?: number }>, opts?: { target?: unknown }) => {
    h.log.push(`batch${opts?.target ? "@target" : ""} ${JSON.stringify(updates)}`);
    return updates.flatMap((u) => landedIn(u.row, u.col, u.styleIndex ?? destStyle));
  });
  h.updateCell.mockImplementation(async (row: number, col: number, value: string) => {
    h.log.push(`updateCell ${row},${col} ${value}`);
    return { cells: landedIn(row, col, destStyle) };
  });
  h.setCellStyle.mockImplementation(async (row: number, col: number, index: number, opts?: { target?: unknown; checkArea?: { startRow: number; startCol: number; endRow: number; endCol: number } }) => {
    // The whole-rectangle CHECK (`checkArea`) writes nothing: logged as "check".
    const c = opts?.checkArea;
    if (c) {
      h.log.push(`check${opts?.target ? "@target" : ""} ${c.startRow},${c.startCol}:${c.endRow},${c.endCol}`);
      return null;
    }
    h.log.push(`setCellStyle${opts?.target ? "@target" : ""} ${row},${col} ${index}`);
    return null;
  });
  // The style-only BATCH (one call for every style-only write).
  h.setCellStyles.mockImplementation(async (writes: Array<{ row: number; col: number; styleIndex: number; keepBorders?: boolean }>, opts?: { target?: unknown }) => {
    h.log.push(`setCellStyles${opts?.target ? "@target" : ""} ${writes.map((w) => `${w.row},${w.col} ${w.styleIndex}${w.keepBorders ? " keepBorders" : ""}`).join("; ")}`);
  });
  h.applyFormatting.mockImplementation(async (rows: number[], cols: number[], fmt: Record<string, unknown>, opts?: { target?: unknown }) => {
    h.log.push(`applyFormatting${opts?.target ? "@target" : ""} ${rows},${cols} ${JSON.stringify(fmt)}`);
    return { cells: [], styles: [] };
  });
  h.styledTarget.mockResolvedValue({ cells: [], merges: [], conditional: [], styles: [], rules: [] });
  h.alert.mockResolvedValue(undefined);
});

/** The source E1 and the destination F3 as the engine stores them. */
function givenSheet(dest: ReturnType<typeof typed> | null, source: ReturnType<typeof typed> | null): void {
  h.typedSheet.mockImplementation(async (r0: number, c0: number, r1: number, c1: number) =>
    [dest, source].filter((c): c is ReturnType<typeof typed> => !!c && c.row >= r0 && c.row <= r1 && c.col >= c0 && c.col <= c1),
  );
}

// THE ROOT FIX (round 5, rev3B#1): every pasted formula or stored value is
// written ONCE, flagged `pasted`, and the backend's ladder skips its Text rung
// for it (pinned in Rust: commands/paste_kind_tests.rs). Round 3 wrote such a
// cell a second time with `styleIndex: 0` and put its style back -- which also
// replaced the cell's PROTECTION flags, so an unlocked @ input cell on a
// protected sheet came back LOCKED, the style restore was refused, and the cell
// was reported "skipped" though the write had landed. Nothing below is ever
// written twice, restyled or detoured through a number format.
describe("on the sheet: a pasted number or formula is written ONCE, as a paste", () => {
  it("=A1 + Values > Add 1: one write of =(A1)+1, flagged pasted; no restyle", async () => {
    givenSheet(typed(2, 5, "number", 5, "=A1"), typed(0, 4, "number", 1));
    expect(await paste(clip("1"), "values", "add")).toBe(true);
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "=(A1)+1", pasted: true }])}`]);
  });

  it("5 + Values > Add 1: the number 6, invariant, flagged pasted", async () => {
    givenSheet(typed(2, 5, "number", 5), typed(0, 4, "number", 1));
    await paste(clip("1"), "values", "add");
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "6", invariant: true, pasted: true }])}`]);
  });

  it("Paste Formulas of =C1 into an @ cell: the shifted formula, flagged pasted", async () => {
    givenSheet(null, null);
    await paste(clip("7", "=C1"), "formulas", "none");
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "=D3", pasted: true }])}`]);
  });

  it("Paste All + Add: ONE write, the source's style riding it (BUG-0345: it was a second call)", async () => {
    givenSheet(typed(2, 5, "number", 5, "=A1"), typed(0, 4, "number", 1));
    await paste(clip("1", null, 4), "all", "add");
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "=(A1)+1", pasted: true, styleIndex: 4 }])}`]);
  });

  it("the destination's format does not change the write: a General cell gets the same one", async () => {
    destStyle = 3;
    givenSheet(typed(2, 5, "number", 5, "=A1"), typed(0, 4, "number", 1));
    await paste(clip("1"), "values", "add");
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "=(A1)+1", pasted: true }])}`]);
    expect(h.style, "no style is read to decide anything").not.toHaveBeenCalled();
  });

  it("Paste Link into an @ cell: one write of the link, flagged pasted (Excel: =$C$1, HasFormula True, still @)", async () => {
    expect(await executePasteLink(clip("7"), F3, 1000, 100)).toBe(true);
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "=$E$1", pasted: true }])}`]);
  });

  it("a copy WITHOUT stored values keeps the display-text route as an ENTRY: Paste Values of 007 into @ stays text", async () => {
    givenSheet(null, null);
    await paste(clip("007"), "values", "none");
    // In the paste's ONE batch, without `pasted` / `invariant`: an entry, read as typed.
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "007" }])}`]);
  });

  it("rev3B#1: a style write the backend refuses AFTER the content landed is never reported as a skipped cell", async () => {
    // Paste (No Borders) into a cell whose formatting the sheet refuses at the
    // write: the formula landed, so the cell was pasted -- just without its
    // formatting. (Paste All's style rides its content write, so it has no
    // separate style write to refuse.)
    givenSheet(null, null);
    h.setCellStyles.mockRejectedValue(new Error("This sheet is protected: formatting cells is not allowed."));
    expect(await paste(clip("7", "=C1", 4), "allExceptBorders", "none")).toBe(true);
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "=D3", pasted: true }])}`]);
    const said = h.alert.mock.calls.map((c) => String(c[0]));
    expect(said, "a cell whose formula landed was counted as skipped").toEqual([
      "Paste Special pasted 1 cell(s) without their formatting:\nThis sheet is protected: formatting cells is not allowed.",
    ]);
  });

  it("positive control: a content batch the backend REFUSES refuses the paste whole, said once", async () => {
    // The content goes out in ONE batch (BUG-0345), refused whole -- as Excel
    // refuses a paste whole.
    givenSheet(null, null);
    h.batch.mockRejectedValue(new Error("The cell is protected."));
    await expect(paste(clip("7", "=C1", 4), "all", "none")).rejects.toThrow("The cell is protected.");
    expect(h.alert.mock.calls.map((c) => String(c[0]))).toEqual(["The cell is protected."]);
  });
});

describe("on a floating grid: a pasted number or formula is written once, as a paste (no number-format detour)", () => {
  it("=A1 + Values > Add 1: one targeted write, flagged pasted", async () => {
    givenSheet(null, typed(0, 4, "number", 1));
    h.typedTarget.mockResolvedValue([typed(3, 0, "number", 5, "=A1")]);
    await paste(clip("1"), "values", "add", REF, { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" } as never);
    expect(h.log).toEqual([`batch@target ${JSON.stringify([{ row: 3, col: 0, value: "=(A1)+1", pasted: true }])}`]);
    expect(h.applyFormatting).not.toHaveBeenCalled();
  });

  it("Paste Link onto the grid: every link flagged pasted", async () => {
    await executePasteLink(clip("7"), { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" } as never, 10, 10, "Paste Link", REF);
    expect(h.log).toEqual([`batch@target ${JSON.stringify([{ row: 3, col: 0, value: "=Sheet1!$E$1", pasted: true }])}`]);
  });
});

describe("on a floating grid: Paste All + an operation pastes the source's style where the operation writes nothing", () => {
  const ROW3 = { startRow: 3, startCol: 0, endRow: 3, endCol: 3, type: "cells" } as never;
  /** A copy of E1:H1: four cells of the source style 4 (bold, 0.00%). */
  function four(displays: string[]): never {
    return {
      cells: [displays.map((d, c) => (d === "" ? { row: 0, col: 4 + c, display: "", formula: null, styleIndex: 4 } : { row: 0, col: 4 + c, display: d, formula: null, styleIndex: 4 }))],
      sourceSelection: { startRow: 0, startCol: 4, endRow: 0, endCol: 7, type: "cells" },
      sourceRows: [0],
      isCut: false,
      sourceSheetIndex: 0,
      sourceSheetName: "Sheet1",
      text: "",
    } as never;
  }

  beforeEach(() => {
    destStyle = 3;
  });

  // BUG-0513: the style now arrives through a style-only write with the
  // target (`setCellStyle`), exactly as `pasteAll` writes it on a sheet. It
  // used to be carried by writing the cell's own content BACK with the style
  // (no style-index write took a target), which could not reach a formula or
  // rich text: those kept their old format, unlike Excel.
  it("text, a number with text copied onto it, and blank on blank keep their content and take the style", async () => {
    // Source: 1, "x", blank, 1. Destination: "abc", 5, blank, =A1.
    h.typedSheet.mockResolvedValue([typed(0, 4, "number", 1), typed(0, 5, "text", "x"), typed(0, 7, "number", 1)]);
    h.typedTarget.mockResolvedValue([typed(3, 0, "text", "abc"), typed(3, 1, "number", 5), typed(3, 3, "number", 5, "=A1")]);
    await paste(four(["1", "x", "", "1"]), "all", "add", REF, ROW3);
    expect(h.log).toEqual([
      // Every cell that takes the style is CHECKED before any write (never half done).
      "check@target 3,0:3,3",
      `batch@target ${JSON.stringify([{ row: 3, col: 3, value: "=(A1)+1", pasted: true, styleIndex: 4 }])}`,
      // The style-only writes in ONE call (BUG-0345).
      "setCellStyles@target 3,0 4; 3,1 4; 3,2 4",
    ]);
  });

  it("a formula the operation leaves alone, and rich text, keep their content and take the style (Excel)", async () => {
    h.typedSheet.mockResolvedValue([typed(0, 4, "text", "x"), typed(0, 5, "text", "y")]);
    h.typedTarget.mockResolvedValue([typed(3, 0, "number", 5, "=A1"), typed(3, 1, "text", "rich")]);
    await paste(four(["x", "y"]), "all", "add", REF, { startRow: 3, startCol: 0, endRow: 3, endCol: 1, type: "cells" } as never);
    expect(h.batch, "a content write re-entered the formula or flattened the rich text").not.toHaveBeenCalled();
    expect(h.log).toEqual(["check@target 3,0:3,1", "setCellStyles@target 3,0 4; 3,1 4"]);
  });

  it("Values + Add (no style travels) writes nothing back", async () => {
    h.typedSheet.mockResolvedValue([typed(0, 4, "number", 1)]);
    h.typedTarget.mockResolvedValue([typed(3, 0, "text", "abc")]);
    await paste(four(["1"]), "values", "add", REF, { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" } as never);
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.setCellStyle, "Paste Values carries no style").not.toHaveBeenCalled();
    expect(h.setCellStyles, "Paste Values carries no style").not.toHaveBeenCalled();
    expect(h.styledTarget, "no styled read is needed").not.toHaveBeenCalled();
  });
});
