//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialProtectedSheet.test.ts
// PURPOSE: Paste Special on a PROTECTED sheet (the per-cell sheet route) is
//          never half done: every written cell is asked before the first
//          write (`protectedPasteGate`), as Excel answers for the whole paste.
// CONTEXT: Bug-ledger fix programme, round 14 (rev12A major: sheet-route Paste
//          Special > Formats / No Borders on a protected sheet painted part of
//          the range and reported "skipped 1 cell(s)"). Excel, measured live
//          through COM (Excel 16, 2026-10-30, fmtprot/probe1-2.ps1; A1:A4
//          unlocked, A5 locked, C1 = 5 bold 0.00):
//            - Paste Special > Values and > All Except Borders onto A4:A5 raise
//              the protected-sheet error and A4 is unchanged, whatever the
//              Format Cells option;
//            - Format Cells NOT allowed: Paste Special > Formats changes
//              nothing; ws.Paste (All) lands 5 with no bold and General;
//            - Format Cells allowed: Paste Special > Formats paints A4 AND the
//              locked A5 (A5 stays locked).
//          The doubles below gate as the backend does: a content write asks
//          the cells' lock flags, a formatting write asks only the Format Cells
//          option (`gate_cell_style_rect`), each refusing before it writes.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  batch: vi.fn(),
  setCellStyle: vi.fn(),
  setCellStyles: vi.fn(),
  applyFormatting: vi.fn(),
  canEditCells: vi.fn(),
  canPerformAction: vi.fn(),
  isProtected: vi.fn(),
  begin: vi.fn(),
  commit: vi.fn(),
  cancel: vi.fn(),
  columnWidth: vi.fn(),
  alert: vi.fn(),
  log: [] as string[],
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 0, startCol: 1, endRow: 0, endCol: 3, type: "cells" },
    config: { totalRows: 1000, totalCols: 100 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));

const NONE = { style: "none", color: "#000000", width: 0 };
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(async () => ({
    numberFormat: "General",
    borderTop: NONE,
    borderRight: NONE,
    borderBottom: NONE,
    borderLeft: NONE,
  })),
  updateCell: vi.fn(async () => ({ cells: [] })),
  setCellStyle: (...a: unknown[]) => h.setCellStyle(...a),
  setCellStyles: (...a: unknown[]) => h.setCellStyles(...a),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  updateCellsBatch: (...a: unknown[]) => h.batch(...a),
  getRangeCellsTyped: vi.fn(async () => []),
  getSheets: vi.fn(async () => ({ sheets: [], activeIndex: 0 })),
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string }>) => inputs.map((i) => i.formula)),
  beginUndoTransaction: (...a: unknown[]) => h.begin(...a),
  commitUndoTransaction: (...a: unknown[]) => h.commit(...a),
  cancelUndoTransaction: (...a: unknown[]) => h.cancel(...a),
  getSpillRanges: vi.fn(async () => []),
  getMergedRegions: vi.fn(async () => []),
  isSheetProtected: (...a: unknown[]) => h.isProtected(...a),
  canEditCells: (...a: unknown[]) => h.canEditCells(...a),
  canPerformAction: (...a: unknown[]) => h.canPerformAction(...a),
  getColumnWidth: (...a: unknown[]) => h.columnWidth(...a),
  setColumnWidth: vi.fn(async () => undefined),
}));
vi.mock("@api/floatingRangeSpills", () => ({ getFloatingRangeSpillRanges: vi.fn(async () => []) }));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import { executePasteKeepSourceColumnWidths, executePasteSpecial } from "../pasteSpecialExecute";
import type { PasteAttribute } from "../types";

/** A copy of Sheet1!F1:H1: three numbers in style 4. */
const CLIP = {
  cells: [[4, 5, 6].map((n, i) => ({ row: 0, col: 5 + i, display: String(n), formula: null, styleIndex: 4 }))],
  values: [[4, 5, 6].map((n, i) => ({ row: 0, col: 5 + i, value: n, display: String(n), formula: null, type: "number" }))],
  sourceSelection: { startRow: 0, startCol: 5, endRow: 0, endCol: 7, type: "cells" },
  sourceRows: [0],
  isCut: false,
  sourceSheetIndex: 0,
  sourceSheetName: "Sheet1",
  text: "4\t5\t6",
} as never;

/** B1:D1, the paste area. */
const B1D1 = { startRow: 0, startCol: 1, endRow: 0, endCol: 3, type: "cells" } as never;

function paste(pasteAttribute: PasteAttribute): Promise<boolean> {
  return executePasteSpecial(
    CLIP,
    B1D1,
    { pasteAttribute, operation: "none", skipBlanks: false, transpose: false },
    1000,
    100,
    "Paste Special",
  );
}

const sheet = { protected: true, locked: new Set<string>(), formatCellsAllowed: true, styleCheckFails: null as string | null };
const LOCKED_REFUSAL = "Cannot change cell D1: it is locked on a protected sheet.";
const FORMAT_REFUSAL = "Cannot format cells on a protected sheet.";

function refuseContent(row: number, col: number): void {
  if (sheet.protected && sheet.locked.has(`${row},${col}`)) throw new Error(LOCKED_REFUSAL);
}

function refuseFormat(): void {
  if (sheet.styleCheckFails !== null) throw new Error(sheet.styleCheckFails);
  if (sheet.protected && !sheet.formatCellsAllowed) throw new Error(FORMAT_REFUSAL);
}

/** The writes that reached a cell (the whole-area check is not one). */
function writes(): string[] {
  return h.log.filter((l) => !l.startsWith("check"));
}

beforeEach(() => {
  for (const fn of Object.values(h)) if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  h.log.length = 0;
  sheet.protected = true;
  sheet.locked.clear();
  sheet.formatCellsAllowed = true;
  sheet.styleCheckFails = null;
  // The Format Cells option, as `can_perform_action` answers it.
  h.canPerformAction.mockImplementation(async (action: string) =>
    action === "formatCells" && sheet.protected && !sheet.formatCellsAllowed
      ? { canEdit: false, reason: "not allowed" }
      : { canEdit: true, reason: null },
  );
  h.isProtected.mockImplementation(async () => sheet.protected);
  // The ONE lock question over every written cell (`canEditCells`).
  h.canEditCells.mockImplementation(async (cells: Array<{ row: number; col: number }>) =>
    sheet.protected && cells.some((c) => sheet.locked.has(`${c.row},${c.col}`))
      ? { canEdit: false, reason: LOCKED_REFUSAL }
      : { canEdit: true, reason: null },
  );
  h.begin.mockImplementation(async () => {
    h.log.push("begin");
    return 21;
  });
  h.commit.mockImplementation(async () => {
    h.log.push("commit");
  });
  h.cancel.mockImplementation(async () => {
    h.log.push("cancel");
  });
  h.batch.mockImplementation(async (updates: Array<{ row: number; col: number; value: string }>) => {
    for (const u of updates) refuseContent(u.row, u.col);
    for (const u of updates) h.log.push(`content ${u.row},${u.col}=${u.value}`);
    return [];
  });
  h.setCellStyle.mockImplementation(async (row: number, col: number, index: number, opts?: { checkArea?: { startRow: number; startCol: number; endRow: number; endCol: number } }) => {
    refuseFormat();
    const c = opts?.checkArea;
    h.log.push(c ? `check ${c.startRow},${c.startCol}:${c.endRow},${c.endCol}` : `style ${row},${col}=${index}`);
    return null;
  });
  // The style-only BATCH: gated once, all or nothing, as the backend does.
  h.setCellStyles.mockImplementation(async (writes: Array<{ row: number; col: number; styleIndex: number }>) => {
    refuseFormat();
    for (const w of writes) h.log.push(`style ${w.row},${w.col}=${w.styleIndex}`);
  });
  h.applyFormatting.mockImplementation(async (rows: number[], cols: number[]) => {
    refuseFormat();
    h.log.push(`format ${rows},${cols}`);
    return { cells: [], styles: [] };
  });
  h.columnWidth.mockResolvedValue(80);
  h.alert.mockResolvedValue(undefined);
});

describe("Paste Special on a protected sheet is never half done (rev12A)", () => {
  it("No Borders onto B1:D1 with D1 LOCKED: refused whole, B1 and C1 untouched, no step", async () => {
    sheet.locked.add("0,3");
    expect(await paste("allExceptBorders"), "the paste reported success").toBe(false);
    expect(writes(), "cells were pasted before the locked D1 refused").toEqual([]);
    expect(h.begin, "a refused paste opened an undo step").not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith(LOCKED_REFUSAL);
  });

  it("Paste Values onto B1:D1 with D1 LOCKED: refused whole, whatever the Format Cells option", async () => {
    for (const allowed of [true, false]) {
      h.log.length = 0;
      h.alert.mockClear();
      sheet.locked.add("0,3");
      sheet.formatCellsAllowed = allowed;
      expect(await paste("values"), `Format Cells ${allowed}: the paste reported success`).toBe(false);
      expect(writes(), `Format Cells ${allowed}: values landed before the locked D1 refused`).toEqual([]);
      expect(h.alert).toHaveBeenCalledWith(LOCKED_REFUSAL);
    }
    expect(h.begin).not.toHaveBeenCalled();
  });

  // Round 16 (rev14A minor, Excel-wins): this used to raise the backend's
  // refusal. Excel [LIVE, fmtprot/probe1.ps1 and cutfmt/probe1.ps1]:
  // PasteSpecial(xlPasteFormats) onto UNLOCKED cells with Format Cells off
  // raises nothing and changes nothing; only a LOCKED cell in the range raises.
  it("Paste Formatting, Format Cells not allowed, every cell unlocked: nothing changes and NOTHING is said, no step", async () => {
    sheet.formatCellsAllowed = false;
    expect(await paste("formats"), "Excel is silent: no refusal").toBe(true);
    expect(h.setCellStyle, "a cell's style write was attempted after the whole-area check refused").toHaveBeenCalledTimes(1);
    expect(writes(), "a cell changed").toEqual([]);
    expect(h.begin, "a paste that changes nothing opened an undo step").not.toHaveBeenCalled();
    expect(h.alert, "Calcula spoke where Excel is silent").not.toHaveBeenCalled();
  });

  it("Paste Formatting, Format Cells not allowed, D1 LOCKED: refused whole with the protected-sheet refusal (Excel raises)", async () => {
    sheet.formatCellsAllowed = false;
    sheet.locked.add("0,3");
    expect(await paste("formats"), "the paste reported success").toBe(false);
    expect(writes()).toEqual([]);
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith(LOCKED_REFUSAL);
  });

  // Round 18 (rev16A minor): only the Format Cells OPTION refusing is silent.
  // Any other failure of the whole-area check -- a canvas sheet's rule, an IPC
  // error -- is shown, never reported as a silent success.
  it("Paste Formatting whose area check fails for ANOTHER reason (Format Cells allowed): the reason is shown, nothing pasted", async () => {
    sheet.styleCheckFails = "Cannot format cells on a canvas sheet.";
    expect(await paste("formats"), "a failed check was reported as success").toBe(false);
    expect(writes()).toEqual([]);
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.alert, "a real failure was passed off as Excel's silence").toHaveBeenCalledWith("Cannot format cells on a canvas sheet.");
  });

  it("Paste Formatting whose area check fails and whose option cannot be read: the reason is shown", async () => {
    sheet.formatCellsAllowed = false;
    h.canPerformAction.mockRejectedValue(new Error("ipc down"));
    expect(await paste("formats")).toBe(false);
    expect(h.alert).toHaveBeenCalledWith(FORMAT_REFUSAL);
  });

  it("Paste All, Format Cells not allowed: the values land WITHOUT their formatting, in one step, and NOTHING is said", async () => {
    sheet.formatCellsAllowed = false;
    expect(await paste("all")).toBe(true);
    expect(h.log).toEqual(["begin", "content 0,1=4", "content 0,2=5", "content 0,3=6", "commit"]);
    expect(h.setCellStyle.mock.calls.filter((a) => !(a[3] as { checkArea?: unknown } | undefined)?.checkArea), "a style write was still attempted per cell").toEqual([]);
    expect(h.alert, "Calcula spoke where Excel is silent (the format is dropped with no error)").not.toHaveBeenCalled();
  });

  it("the lock flags of every written cell are asked in ONE call, however large the paste", async () => {
    const wide = { startRow: 0, startCol: 1, endRow: 999, endCol: 3, type: "cells" } as never;
    expect(
      await executePasteSpecial(
        CLIP,
        wide,
        { pasteAttribute: "values", operation: "none", skipBlanks: false, transpose: false },
        1000,
        100,
        "Paste Special",
      ),
    ).toBe(true);
    expect(h.canEditCells, "one lock question per cell (or per chunk) doubles the calls of a large paste").toHaveBeenCalledTimes(1);
    expect((h.canEditCells.mock.calls[0][0] as unknown[]).length, "the question names every written cell").toBe(3000);
  });

  it("Values & Number Formatting and No Borders, Format Cells not allowed: no number format, no border is attempted", async () => {
    sheet.formatCellsAllowed = false;
    expect(await paste("valuesAndNumberFormats")).toBe(true);
    expect(await paste("allExceptBorders")).toBe(true);
    expect(h.applyFormatting, "a number format or a border was written without Format Cells").not.toHaveBeenCalled();
    expect(writes().filter((l) => l.startsWith("style"))).toEqual([]);
  });

  it("positive control: Format Cells allowed, Paste Formatting paints every cell -- the LOCKED D1 too (Excel)", async () => {
    sheet.locked.add("0,3");
    expect(await paste("formats")).toBe(true);
    expect(h.log).toEqual(["check 0,1:0,3", "begin", "style 0,1=4", "style 0,2=4", "style 0,3=4", "commit"]);
    expect(h.canEditCells, "a formatting-only paste asked the content lock").not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("positive control: an unprotected sheet asks nothing more and pastes", async () => {
    sheet.protected = false;
    expect(await paste("allExceptBorders")).toBe(true);
    expect(h.canEditCells).not.toHaveBeenCalled();
    expect(h.log.filter((l) => l.startsWith("check")), "an unprotected paste paid for the whole-area check").toEqual([]);
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("Keep Source Column Widths onto a locked cell: refused whole -- no cell, no width, its step dropped", async () => {
    sheet.locked.add("0,3");
    expect(await executePasteKeepSourceColumnWidths(CLIP, B1D1, 1000, 100)).toBe(false);
    expect(writes().filter((l) => l !== "begin" && l !== "cancel"), "cells or widths landed").toEqual([]);
    expect(h.columnWidth, "a width was read for a refused paste").not.toHaveBeenCalled();
    expect(h.log).toContain("cancel");
    expect(h.commit).not.toHaveBeenCalled();
  });
});
