//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialStoredValues.test.ts
// PURPOSE: Every Paste Special variant pastes a CONSTANT -- and, under a
//          values attribute, a formula's RESULT -- from the value the copy read
//          TYPED (`ClipboardData.values`), written invariant: never by
//          re-typing the display text.
// CONTEXT: Bug-ledger fix programme, round 4 (NEW-paste-by-display-text;
//          revE#2's remainder). Paste Values wrote `display` through the
//          user-input ladder, so 1.23456 shown under 0.00 pasted as 1.23, =1/3
//          shown as 0.33 pasted as 0.33, "5,50 kr" came back as text, and the
//          number 5 pasted into a Text-formatted (@) cell was stored as text.
//          Excel, measured live through COM (2026-10-29): Paste Values of
//          1.23456 under 0.00 -> 1.23456; of =1/3 -> 0.333333333333333; of a
//          date under yyyy-mm-dd into General -> 43983; of 5.5 "kr" -> 5.5; of
//          the text '00123 -> the text 00123; of the number 5, TRUE or #N/A into
//          an @ cell -> the number / boolean / error, the cell keeping its @;
//          Paste Formulas of the number 5 into @ -> the number 5.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  batch: vi.fn(),
  updateCell: vi.fn(),
  setCellStyle: vi.fn(),
  applyFormatting: vi.fn(),
  typedSheet: vi.fn(),
  typedTarget: vi.fn(),
  sheets: vi.fn(),
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
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  updateCellsBatch: (...a: unknown[]) => h.batch(...a),
  getRangeCellsTyped: (...a: unknown[]) => h.typedSheet(...a),
  getSheets: (...a: unknown[]) => h.sheets(...a),
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string }>) => inputs.map((i) => i.formula)),
  beginUndoTransaction: vi.fn(async () => 5),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
  getSpillRanges: vi.fn(async () => []),
  isSheetProtected: vi.fn(async () => false),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: (...a: unknown[]) => h.typedTarget(...a),
  getCellTargetCells: vi.fn(async () => ({ cells: [], merges: [], conditional: [], styles: [], rules: [] })),
}));
vi.mock("@api/floatingRangeSpills", () => ({ getFloatingRangeSpillRanges: vi.fn(async () => []) }));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import { executePasteSpecial } from "../pasteSpecialExecute";
import type { PasteAttribute, PasteOperation } from "../types";
import type { ClipboardCellValue } from "@api/lib";

const REF = { kind: "floatingRange" as const, id: "fr-1" };
/** Style 9 is formatted as Text (@), style 8 as a date; every other style is General. */
const TEXT_STYLE = 9;
const DATE_STYLE = 8;
const F3 = { startRow: 2, startCol: 5, endRow: 2, endCol: 5, type: "cells" } as never;

interface Source {
  display: string;
  formula?: string | null;
  styleIndex?: number;
  stored: ClipboardCellValue | null;
}

/**
 * A copy of E1.. (row 0, from col 4), one cell per entry, WITH the stored
 * values the copy read typed (`values`) -- or, `withValues` false, without
 * them (a copy whose typed read failed).
 */
function clip(sources: Source[], withValues = true): never {
  return {
    cells: [
      sources.map((s, c) =>
        s.display === "" && !s.formula ? null : { row: 0, col: 4 + c, display: s.display, formula: s.formula ?? null, styleIndex: s.styleIndex ?? 0 },
      ),
    ],
    ...(withValues ? { values: [sources.map((s) => s.stored)] } : {}),
    sourceSelection: { startRow: 0, startCol: 4, endRow: 0, endCol: 4 + sources.length - 1, type: "cells" },
    sourceRows: [0],
    isCut: false,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    sourceSheetId: "sheet-a",
    text: sources.map((s) => s.display).join("\t"),
  } as never;
}

const num = (value: number): ClipboardCellValue => ({ type: "number", value });

async function paste(
  clipboard: never,
  pasteAttribute: PasteAttribute,
  operation: PasteOperation = "none",
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

let destStyle = 0;

beforeEach(() => {
  for (const fn of [h.batch, h.updateCell, h.setCellStyle, h.applyFormatting, h.typedSheet, h.typedTarget, h.sheets, h.style, h.alert]) {
    fn.mockReset();
  }
  h.log.length = 0;
  destStyle = 0;
  h.style.mockImplementation(async (i: number) => ({
    numberFormat: i === TEXT_STYLE ? "@" : i === DATE_STYLE ? "yyyy-mm-dd" : "General",
  }));
  h.batch.mockImplementation(async (updates: Array<{ row: number; col: number; styleIndex?: number }>, opts?: { target?: unknown }) => {
    h.log.push(`batch${opts?.target ? "@target" : ""} ${JSON.stringify(updates)}`);
    return updates.flatMap((u) => landedIn(u.row, u.col, u.styleIndex ?? destStyle));
  });
  h.updateCell.mockImplementation(async (row: number, col: number, value: string) => {
    h.log.push(`updateCell ${row},${col} ${value}`);
    return { cells: landedIn(row, col, destStyle) };
  });
  h.setCellStyle.mockImplementation(async (row: number, col: number, index: number) => {
    h.log.push(`setCellStyle ${row},${col} ${index}`);
    return null;
  });
  h.applyFormatting.mockImplementation(async (rows: number[], cols: number[], fmt: Record<string, unknown>, opts?: { target?: unknown }) => {
    h.log.push(`applyFormatting${opts?.target ? "@target" : ""} ${rows},${cols} ${JSON.stringify(fmt)}`);
    return { cells: [], styles: [] };
  });
  h.typedSheet.mockResolvedValue([]);
  h.typedTarget.mockResolvedValue([]);
  h.sheets.mockResolvedValue({ sheets: [{ index: 0, name: "Sheet1", sheetId: "sheet-a" }], activeIndex: 0 });
  h.alert.mockResolvedValue(undefined);
});

describe("on the sheet: Paste Values writes the stored value, never the display", () => {
  it("1.23456 under 0.00, =1/3 shown as 0.33, 5.5 shown as '5,50 kr': exact, invariant, no user-input parse", async () => {
    const copy = clip([
      { display: "1.23", styleIndex: 4, stored: num(1.23456) },
      { display: "0.33", formula: "=1/3", styleIndex: 4, stored: num(1 / 3) },
      { display: "5,50 kr", styleIndex: 6, stored: num(5.5) },
    ]);
    expect(await paste(copy, "values", "none", undefined, { startRow: 2, startCol: 5, endRow: 2, endCol: 5, type: "cells" } as never)).toBe(true);
    expect(h.log, "a value was re-typed from its display text").toEqual([
      `batch ${JSON.stringify([{ row: 2, col: 5, value: "1.23456", invariant: true, pasted: true }])}`,
      `batch ${JSON.stringify([{ row: 2, col: 6, value: String(1 / 3), invariant: true, pasted: true }])}`,
      `batch ${JSON.stringify([{ row: 2, col: 7, value: "5.5", invariant: true, pasted: true }])}`,
    ]);
  });

  it("text stays text (the verbatim escape), TRUE and an error keep their kind, an empty cell clears", async () => {
    const copy = clip([
      { display: "00123", stored: { type: "text", value: "00123" } },
      { display: "TRUE", stored: { type: "boolean", value: true } },
      { display: "#N/A", stored: { type: "error", value: "#N/A" } },
      { display: "", stored: null },
    ]);
    await paste(copy, "values");
    expect(h.log).toEqual([
      `batch ${JSON.stringify([{ row: 2, col: 5, value: "'00123", invariant: true, pasted: true }])}`,
      `batch ${JSON.stringify([{ row: 2, col: 6, value: "TRUE", invariant: true, pasted: true }])}`,
      `batch ${JSON.stringify([{ row: 2, col: 7, value: "#N/A", invariant: true, pasted: true }])}`,
      `batch ${JSON.stringify([{ row: 2, col: 8, value: "", invariant: true, pasted: true }])}`,
    ]);
  });

  it("the number 5 into an @ cell: ONE write flagged pasted (the backend keeps it a number); the text '007' too", async () => {
    destStyle = TEXT_STYLE;
    await paste(clip([{ display: "5", stored: num(5) }]), "values");
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "5", invariant: true, pasted: true }])}`]);
    h.log.length = 0;
    await paste(clip([{ display: "007", stored: { type: "text", value: "007" } }]), "values");
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "'007", invariant: true, pasted: true }])}`]);
  });

  it("Values & Number Formats of a date: the serial, then the source's number format", async () => {
    await paste(clip([{ display: "2020-06-01", styleIndex: DATE_STYLE, stored: num(43983) }]), "valuesAndNumberFormats");
    expect(h.log).toEqual([
      `batch ${JSON.stringify([{ row: 2, col: 5, value: "43983", invariant: true, pasted: true }])}`,
      `applyFormatting 2,5 ${JSON.stringify({ numberFormat: "yyyy-mm-dd" })}`,
    ]);
  });

  it("a List / Dict collection still pastes its JSON text", async () => {
    const copy = clip([{ display: "[List(2)]", stored: { type: "text", value: "[List(2)]" } }]) as unknown as {
      collectionTexts?: Map<string, string>;
    };
    copy.collectionTexts = new Map([["0,0", "[1,2]"]]);
    await paste(copy as never, "values");
    expect(h.log).toEqual(["updateCell 2,5 [1,2]"]);
  });

  it("positive control: a copy WITHOUT stored values keeps the display-text route", async () => {
    await paste(clip([{ display: "1.23", styleIndex: 4, stored: num(1.23456) }], false), "values");
    expect(h.log).toEqual(["updateCell 2,5 1.23"]);
  });
});

describe("on the sheet: Paste Formulas and Paste All paste a constant's stored value too", () => {
  it("Paste Formulas of the constant 1.23456 into an @ cell: the number, ONE write flagged pasted", async () => {
    destStyle = TEXT_STYLE;
    await paste(clip([{ display: "1.23", styleIndex: 4, stored: num(1.23456) }]), "formulas");
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "1.23456", invariant: true, pasted: true }])}`]);
  });

  it("Paste Formulas of a FORMULA writes the formula (not invariant), flagged pasted", async () => {
    await paste(clip([{ display: "0.33", formula: "=1/3", styleIndex: 4, stored: num(1 / 3) }]), "formulas");
    expect(h.log).toEqual([`batch ${JSON.stringify([{ row: 2, col: 5, value: "=1/3", pasted: true }])}`]);
  });

  it("Paste All of TRUE: the boolean, then the source's style", async () => {
    await paste(clip([{ display: "TRUE", styleIndex: 3, stored: { type: "boolean", value: true } }]), "all");
    expect(h.log).toEqual([
      `batch ${JSON.stringify([{ row: 2, col: 5, value: "TRUE", invariant: true, pasted: true }])}`,
      "setCellStyle 2,5 3",
    ]);
  });
});

describe("on a floating grid: the stored value, in the one targeted batch", () => {
  const G = { startRow: 3, startCol: 0, endRow: 3, endCol: 0, type: "cells" } as never;

  it("Paste Values: 1.23456 and the text abc in ONE targeted batch, flagged pasted (no number-format detour)", async () => {
    destStyle = TEXT_STYLE;
    const copy = clip([
      { display: "1.23", styleIndex: 4, stored: num(1.23456) },
      { display: "abc", stored: { type: "text", value: "abc" } },
    ]);
    await paste(copy, "values", "none", REF, G);
    expect(h.log).toEqual([
      `batch@target ${JSON.stringify([
        { row: 3, col: 0, value: "1.23456", invariant: true, pasted: true },
        { row: 3, col: 1, value: "'abc", invariant: true, pasted: true },
      ])}`,
    ]);
  });

  it("Paste All of a constant carries the stored value and the source style", async () => {
    await paste(clip([{ display: "1.23", styleIndex: 4, stored: num(1.23456) }]), "all", "none", REF, G);
    expect(h.log).toEqual([
      `batch@target ${JSON.stringify([{ row: 3, col: 0, value: "1.23456", invariant: true, pasted: true, styleIndex: 4 }])}`,
    ]);
  });
});

describe("an operation whose source can no longer be re-read uses the stored values the copy read", () => {
  it("the source sheet was deleted: 1 + Values > Add of 1.23456 (shown 1.23) is 2.23456", async () => {
    h.sheets.mockResolvedValue({ sheets: [{ index: 0, name: "Other", sheetId: "sheet-b" }], activeIndex: 0 });
    h.typedSheet.mockImplementation(async (r0: number) => (r0 === 2 ? [{ row: 2, col: 5, value: 1, display: "1", formula: null, type: "number" }] : []));
    await paste(clip([{ display: "1.23", styleIndex: 4, stored: num(1.23456) }]), "values", "add");
    expect(h.log).toEqual([
      `batch ${JSON.stringify([{ row: 2, col: 5, value: String(1 + 1.23456), invariant: true, pasted: true }])}`,
    ]);
  });
});
