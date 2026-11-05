//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialStyleOnTarget.test.ts
// PURPOSE: The style-only pastes onto a floating grid's cells (BUG-0513, owner
//          finding G3): Paste Formatting and Paste (No Borders) work sheet ->
//          floating grid exactly as they do sheet -> sheet, as ONE undo step.
//            - Formatting: every destination cell is pointed at the source's
//              style INDEX in ONE `setCellStyles(.., { target })` (BUG-0345);
//              no content is written; Skip Blanks and Transpose apply as on a
//              sheet.
//            - No Borders: the content in ONE targeted batch, then the source's
//              style index as a style-only write that keeps each cell's OWN
//              border sides (`keepBorders`, the backend's: theme colour and
//              weight included, BUG-0347) -- Excel, measured live through COM
//              2026-10-04 and 2026-11-04 (xlPasteAllExceptBorders): the
//              source's bold arrived, its bottom border did not, the
//              destination's thick top border stayed, a theme-coloured medium
//              dashed one in full detail.
//            - Format Cells refused by the host, formatting only: silent over
//              unlocked cells, refused over a locked one (BUG-0655, the
//              sheet's rule; Excel [LIVE]).
//          Nothing reaches the active sheet's cells at the grid's coordinates.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  batch: vi.fn(),
  updateCell: vi.fn(),
  setCellStyle: vi.fn(),
  setCellStyles: vi.fn(),
  canEditCells: vi.fn(),
  canPerformAction: vi.fn(),
  applyFormatting: vi.fn(),
  styledTarget: vi.fn(),
  begin: vi.fn(),
  commit: vi.fn(),
  cancel: vi.fn(),
  alert: vi.fn(),
  log: [] as string[],
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 2, startCol: 5, endRow: 2, endCol: 5, type: "cells" },
    config: { totalRows: 1000, totalCols: 100 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));

const NONE = { style: "none", color: "#000000", width: 0 };
const THIN_RED = { style: "solid", color: "#ff0000", width: 1 };
const THICK = { style: "solid", color: "#000000", width: 3 };
/** Style 4: the SOURCE (bold, a red bottom border). Style 6: the DESTINATION (a thick top border). */
function styleData(index: number): Record<string, unknown> {
  return {
    numberFormat: "General",
    bold: index === 4,
    borderTop: index === 6 ? THICK : NONE,
    borderRight: NONE,
    borderBottom: index === 4 ? THIN_RED : NONE,
    borderLeft: NONE,
    borderDiagonalDown: NONE,
    borderDiagonalUp: NONE,
  };
}

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(async (i: number) => styleData(i)),
  updateCell: (...a: unknown[]) => h.updateCell(...a),
  setCellStyle: (...a: unknown[]) => h.setCellStyle(...a),
  setCellStyles: (...a: unknown[]) => h.setCellStyles(...a),
  canEditCells: (...a: unknown[]) => h.canEditCells(...a),
  canPerformAction: (...a: unknown[]) => h.canPerformAction(...a),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  updateCellsBatch: (...a: unknown[]) => h.batch(...a),
  getRangeCellsTyped: vi.fn(async () => []),
  getSheets: vi.fn(async () => ({ sheets: [], activeIndex: 0 })),
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string }>) => inputs.map((i) => i.formula)),
  beginUndoTransaction: (...a: unknown[]) => h.begin(...a),
  commitUndoTransaction: (...a: unknown[]) => h.commit(...a),
  cancelUndoTransaction: (...a: unknown[]) => h.cancel(...a),
  getSpillRanges: vi.fn(async () => []),
  isSheetProtected: vi.fn(async () => false),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: vi.fn(async () => []),
  getCellTargetCells: (...a: unknown[]) => h.styledTarget(...a),
}));
vi.mock("@api/floatingRangeSpills", () => ({ getFloatingRangeSpillRanges: vi.fn(async () => []) }));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import { executePasteSpecial } from "../pasteSpecialExecute";
import type { PasteAttribute } from "../types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };

/** A copy of Sheet1!E1:F1: "7" in style 4, and an EMPTY position (no cell record). */
const CLIP = {
  cells: [[{ row: 0, col: 4, display: "7", formula: null, styleIndex: 4 }, null]],
  values: [[{ row: 0, col: 4, value: 7, display: "7", formula: null, type: "number" }, null]],
  sourceSelection: { startRow: 0, startCol: 4, endRow: 0, endCol: 5, type: "cells" },
  sourceRows: [0],
  isCut: false,
  sourceSheetIndex: 0,
  sourceSheetName: "Sheet1",
  text: "7\t",
} as never;

/** The grid's B3:C3 (object coordinates). */
const GRID_B3C3 = { startRow: 2, startCol: 1, endRow: 2, endCol: 2, type: "cells" } as never;

function paste(pasteAttribute: PasteAttribute, opts: { skipBlanks?: boolean; transpose?: boolean } = {}): Promise<boolean> {
  return executePasteSpecial(
    CLIP,
    GRID_B3C3,
    { pasteAttribute, operation: "none", skipBlanks: opts.skipBlanks ?? false, transpose: opts.transpose ?? false },
    10,
    5,
    "Paste Special",
    REF,
  );
}

/**
 * The floating grid's HOST protection, as the backend gates it: a formatting
 * write asks ONLY the Format Cells option -- with it allowed, a LOCKED cell is
 * formatted too and keeps its Locked flag (`gate_cell_style_rect`; Excel [LIVE,
 * Excel 16 COM, 2026-10-30]: Paste Special > Formats paints a locked cell when
 * Format Cells is allowed) -- and a content write asks the lock flags only.
 * Every gate refuses before it writes. (Round 12 wrote this double with the
 * lock flags in the formatting gate too, and made the whole-paste refusal fire
 * through a LOCKED cell; that premise is the Format Cells option now.)
 */
const host = { locked: new Set<string>(), formatCellsAllowed: true };
const LOCKED_REFUSAL = "Cell is locked on a protected sheet.";
const FORMAT_REFUSAL = "This sheet is protected: formatting cells is not allowed.";

function lockHostCell(row: number, col: number): void {
  host.locked.add(`${row},${col}`);
}

function refuseContent(cells: ReadonlyArray<readonly [number, number]>): void {
  if (cells.some(([r, c]) => host.locked.has(`${r},${c}`))) throw new Error(LOCKED_REFUSAL);
}

function refuseFormat(_cells: ReadonlyArray<readonly [number, number]>): void {
  if (!host.formatCellsAllowed) throw new Error(FORMAT_REFUSAL);
}

beforeEach(() => {
  for (const fn of [h.batch, h.updateCell, h.setCellStyle, h.setCellStyles, h.canEditCells, h.canPerformAction, h.applyFormatting, h.styledTarget, h.begin, h.commit, h.cancel, h.alert]) {
    fn.mockReset();
  }
  h.log.length = 0;
  h.begin.mockImplementation(async () => {
    h.log.push("begin");
    return 21;
  });
  h.commit.mockImplementation(async () => {
    h.log.push("commit");
  });
  h.cancel.mockResolvedValue(undefined);
  host.locked.clear();
  host.formatCellsAllowed = true;
  h.batch.mockImplementation(async (updates: Array<{ row: number; col: number }>, opts?: { target?: unknown }) => {
    // The content batch gates its own cells whole (lock flags only).
    refuseContent(updates.map((u) => [u.row, u.col] as const));
    h.log.push(`batch${opts?.target ? "@target" : ""} ${JSON.stringify(updates)}`);
    return [];
  });
  h.setCellStyle.mockImplementation(async (row: number, col: number, index: number, opts?: { target?: unknown; checkArea?: { startRow: number; startCol: number; endRow: number; endCol: number } }) => {
    // The whole-rectangle CHECK (`checkArea`) writes nothing: logged as "check".
    const c = opts?.checkArea;
    if (c) {
      const cells: Array<readonly [number, number]> = [];
      for (let r = c.startRow; r <= c.endRow; r++) for (let k = c.startCol; k <= c.endCol; k++) cells.push([r, k]);
      refuseFormat(cells);
      h.log.push(`check${opts?.target ? "@target" : ""} ${c.startRow},${c.startCol}:${c.endRow},${c.endCol}`);
      return null;
    }
    refuseFormat([[row, col]]);
    h.log.push(`setCellStyle${opts?.target ? "@target" : ""} ${row},${col} ${index}`);
    return null;
  });
  // The style-only BATCH: gated once, all or nothing.
  h.setCellStyles.mockImplementation(async (writes: Array<{ row: number; col: number; styleIndex: number; keepBorders?: boolean }>, opts?: { target?: unknown }) => {
    refuseFormat(writes.map((w) => [w.row, w.col] as const));
    h.log.push(`setCellStyles${opts?.target ? "@target" : ""} ${writes.map((w) => `${w.row},${w.col} ${w.styleIndex}${w.keepBorders ? " keepBorders" : ""}`).join("; ")}`);
  });
  // The host's Format Cells option and the GRID's own lock flags, as the
  // backend answers them with a target (BUG-0655).
  h.canPerformAction.mockImplementation(async (action: string, opts?: { target?: unknown }) =>
    action === "formatCells" && opts?.target && !host.formatCellsAllowed ? { canEdit: false, reason: "not allowed" } : { canEdit: true },
  );
  h.canEditCells.mockImplementation(async (cells: Array<{ row: number; col: number }>, opts?: { target?: unknown }) => {
    h.log.push(`canEditCells${opts?.target ? "@target" : ""} ${cells.map((c) => `${c.row},${c.col}`).join("; ")}`);
    return cells.some((c) => host.locked.has(`${c.row},${c.col}`)) ? { canEdit: false, reason: LOCKED_REFUSAL } : { canEdit: true };
  });
  h.applyFormatting.mockImplementation(async (rows: number[], cols: number[], fmt: Record<string, unknown>, opts?: { target?: unknown }) => {
    refuseFormat(rows.flatMap((r) => cols.map((c) => [r, c] as const)));
    h.log.push(`applyFormatting${opts?.target ? "@target" : ""} ${rows},${cols} ${JSON.stringify(fmt)}`);
    return { cells: [], styles: [] };
  });
  h.updateCell.mockImplementation(async (row: number, col: number) => {
    h.log.push(`updateCell ${row},${col}`);
    return { cells: [] };
  });
  // The grid's B3 carries style 6 (a thick top border); C3 stores nothing.
  h.styledTarget.mockResolvedValue({
    cells: [{ row: 2, col: 1, display: "old", formula: null, styleIndex: 6 }],
    merges: [],
    conditional: [],
    styles: [],
    rules: [],
  });
  h.alert.mockResolvedValue(undefined);
});

describe("Paste Formatting onto a floating grid's cells (BUG-0513)", () => {
  it("points each cell at the source's style index through the target, in ONE undo step, with no content", async () => {
    expect(await paste("formats")).toBe(true);
    expect(h.alert, "the paste was refused or failed").not.toHaveBeenCalled();
    // The empty source position carries the default style (index 0), as on a sheet.
    expect(h.log).toEqual(["check@target 2,1:2,2", "begin", "setCellStyles@target 2,1 4; 2,2 0", "commit"]);
    expect(h.updateCell, "wrote the ACTIVE sheet").not.toHaveBeenCalled();
  });

  it("Skip Blanks skips the empty source position; Transpose lays the row down a column", async () => {
    await paste("formats", { skipBlanks: true });
    expect(h.log).toEqual(["check@target 2,1:2,1", "begin", "setCellStyles@target 2,1 4", "commit"]);
    h.log.length = 0;
    await executePasteSpecial(
      CLIP,
      { startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" } as never,
      { pasteAttribute: "formats", operation: "none", skipBlanks: false, transpose: true },
      10,
      5,
      "Paste Special",
      REF,
    );
    expect(h.log).toEqual(["check@target 2,1:3,1", "begin", "setCellStyles@target 2,1 4; 3,1 0", "commit"]);
  });

  it("a refusal from the backend (the host's protection) changes no cell, opens no step, and says why", async () => {
    h.setCellStyle.mockRejectedValue(new Error("Cannot format cells on a protected sheet."));
    await expect(paste("formats")).rejects.toThrow("protected");
    expect(h.begin, "a refused paste opened an undo step").not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith("Cannot format cells on a protected sheet.");
  });

  // BUG-0655 (Excel wins): this used to raise the host's refusal over UNLOCKED
  // cells too. Excel [LIVE, fmtprot/probe1.ps1 and cutfmt/probe1.ps1]:
  // PasteSpecial(xlPasteFormats) onto unlocked cells with Format Cells off
  // raises nothing and changes nothing; only a LOCKED cell in the range raises.
  it("Format Cells not allowed on the host, every grid cell unlocked: nothing changes and NOTHING is said, no step (BUG-0655)", async () => {
    host.formatCellsAllowed = false;
    expect(await paste("formats"), "Excel is silent: no refusal").toBe(true);
    expect(h.begin, "a paste that changes nothing opened an undo step").not.toHaveBeenCalled();
    expect(h.setCellStyles, "a cell was restyled after the whole-area check refused").not.toHaveBeenCalled();
    expect(h.alert, "Calcula spoke where Excel is silent").not.toHaveBeenCalled();
    // The lock question was the GRID's (the target), asked of every cell.
    expect(h.log.filter((l) => l.startsWith("canEditCells"))).toEqual(["canEditCells@target 2,1; 2,2"]);
  });

  it("Format Cells not allowed on the host, a LOCKED grid cell in the range: refused whole before the first cell is restyled (rev10A)", async () => {
    host.formatCellsAllowed = false;
    lockHostCell(2, 2);
    await expect(paste("formats")).rejects.toThrow(LOCKED_REFUSAL);
    expect(h.begin, "a refused paste opened an undo step: it was not refused whole up front").not.toHaveBeenCalled();
    expect(h.setCellStyles, "cells were restyled before the refusal").not.toHaveBeenCalled();
    expect(h.commit, "a partial paste was committed").not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith(LOCKED_REFUSAL);
  });

  it("only the host's OPTION refusing is silent: a check that failed for another reason is shown", async () => {
    // Format Cells allowed (so the option does not refuse), yet the check fails.
    h.setCellStyle.mockRejectedValue(new Error("Floating grid moved while the command ran."));
    await expect(paste("formats")).rejects.toThrow("moved");
    expect(h.alert).toHaveBeenCalledWith("Floating grid moved while the command ran.");
    expect(h.begin).not.toHaveBeenCalled();
  });

  it("an option refusing whose lock flags cannot be read: the refusal is shown (fail closed, never a silent success)", async () => {
    host.formatCellsAllowed = false;
    h.canEditCells.mockRejectedValue(new Error("ipc down"));
    await expect(paste("formats")).rejects.toThrow("protected");
    expect(h.alert).toHaveBeenCalledWith(FORMAT_REFUSAL);
  });

  it("Format Cells allowed: a LOCKED host cell is restyled too, in the one step (Excel [LIVE]; the backend keeps its lock)", async () => {
    lockHostCell(2, 2);
    expect(await paste("formats")).toBe(true);
    expect(h.log).toEqual(["check@target 2,1:2,2", "begin", "setCellStyles@target 2,1 4; 2,2 0", "commit"]);
    expect(h.alert).not.toHaveBeenCalled();
  });
});

describe("Paste (No Borders) onto a floating grid's cells (BUG-0513)", () => {
  it("a host lock on a destination cell refuses the whole paste: nothing lands", async () => {
    lockHostCell(2, 2);
    await expect(paste("allExceptBorders")).rejects.toThrow("protected");
    // The formatting check passes (Format Cells is allowed; a lock is not a
    // formatting question); the content batch -- the first write -- refuses
    // whole on the locked C3.
    expect(
      h.log.filter((l) => l !== "begin" && !l.startsWith("check")),
      "content or styles landed before the refusal",
    ).toEqual([]);
    expect(h.commit, "a partial paste was committed").not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith(LOCKED_REFUSAL);
  });

  it("Format Cells not allowed: the content lands WITHOUT its formatting, never content + half the formatting (rev10A)", async () => {
    // Excel [LIVE, COM]: Format Cells not allowed, Paste Special > All Except
    // Borders onto an unlocked cell pastes the value alone, the format dropped.
    host.formatCellsAllowed = false;
    expect(await paste("allExceptBorders")).toBe(true);
    expect(h.log).toEqual([
      "begin",
      `batch@target ${JSON.stringify([
        { row: 2, col: 1, value: "7", invariant: true, pasted: true },
        { row: 2, col: 2, value: "", invariant: true, pasted: true },
      ])}`,
      "commit",
    ]);
    // Round 16 (Excel-wins): Excel drops the format with NO error [LIVE,
    // cutfmt/probe1.ps1], so nothing is said (this used to raise
    // "pasted 2 cell(s) without their formatting").
    expect(h.alert, "Calcula spoke where Excel is silent").not.toHaveBeenCalled();
  });

  it("pastes the content in one batch, then the source's style KEEPING each cell's own borders in one style batch, one step (BUG-0347)", async () => {
    expect(await paste("allExceptBorders")).toBe(true);
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.styledTarget, "the destination's borders are the backend's to keep: no read of the grid").not.toHaveBeenCalled();
    expect(h.applyFormatting, "a border was put back through the lossy {style, color} wire").not.toHaveBeenCalled();
    expect(h.log).toEqual([
      // Every cell that takes formatting is CHECKED before the content batch
      // (never half done).
      "check@target 2,1:2,2",
      "begin",
      `batch@target ${JSON.stringify([
        { row: 2, col: 1, value: "7", invariant: true, pasted: true },
        { row: 2, col: 2, value: "", invariant: true, pasted: true },
      ])}`,
      // The source's whole style, each cell's OWN border sides kept by the
      // backend (theme colour, weight, style -- every detail).
      "setCellStyles@target 2,1 4 keepBorders; 2,2 0 keepBorders",
      "commit",
    ]);
    expect(h.updateCell, "wrote the ACTIVE sheet").not.toHaveBeenCalled();
  });
});
