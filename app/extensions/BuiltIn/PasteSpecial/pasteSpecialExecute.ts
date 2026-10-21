//! FILENAME: app/extensions/BuiltIn/PasteSpecial/pasteSpecialExecute.ts
// PURPOSE: Core execution logic for Paste Special operations.
// CONTEXT: Handles all paste variants (values, formulas, formats, operations,
//          transpose, skip blanks, paste link, keep source column widths)
//          using existing API primitives.
//
//          EVERY door lands in one of the three exported functions below --
//          the Paste Special dialog's OK and Paste Link, the quick pastes and
//          the Home tab's Paste menu rows (index.ts) -- and each one asks the
//          same questions before it writes anything: does something else own
//          the selection (BUG-0185), was the clipboard CUT, is the internal
//          clipboard stale, does a protected region lie under the paste
//          (pasteRefusals.ts). A refused paste writes nothing, opens no undo
//          step and says ONE sentence. The functions answer whether they
//          pasted (true) or refused (false).
//
//          ON A FLOATING GRID'S CELLS (P3, owner finding G3): a door that
//          resolved an OBJECT target hands it in (`target`), and the paste is
//          written to the object's cells in ONE `updateCellsBatch(.., { target })`
//          -- value and source style together, Excel's relative shift on the
//          object's own coordinates -- plus the number formats through
//          `applyFormatting(.., { target })`. What has no route onto an object's
//          cells is refused there in one sentence: a style-only write
//          (Formatting, No Borders -- there is no style-index write that takes a
//          target, BUG-0513), comments and validation (their doors refuse on a floating
//          grid), and column widths (the object's widths are not the sheet's).

import type { CellData, Selection, StyleData, FormattingOptions } from "@api/types";
import type { ClipboardData, FormulaShiftInput, AddCommentParams, CellUpdateInput, TypedCellData } from "@api/lib";
import type { PasteSpecialOptions, PasteOperation, PasteAttribute } from "./types";
import {
  getCell,
  updateCell,
  setCellStyle,
  getStyle,
  applyFormatting,
  getColumnWidth,
  setColumnWidth,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
  shiftFormulasBatch,
  indexToCol,
  addComment,
  setDataValidation,
  clipboardSourceRow,
  pasteRowDeltas,
  updateCellsBatch,
  getRangeCellsTyped,
} from "@api/lib";
import { cellEvents } from "@api";
import { alertAsync } from "@api/dialogs";
import {
  getCellTargetCells,
  getCellTargetCellsTyped,
  resolveCellTarget,
  type CellTargetRef,
} from "@api/cellTarget";
import { parseNumber } from "@api/locale";
import { getGridStateSnapshot } from "@api/state";
import { quoteSheetNameForFormula } from "@api/externalEdit";
import { ownUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";
import { pasteRefusal, pasteRefusalSentence, type PasteArea } from "./pasteRefusals";

// The closes this module's gestures make, bound to each begin's answer by
// ownUndoTransaction: a gesture closes ONLY the undo transaction its own begin
// OPENED. Inside a script's open batch (or a command-line run) the begin JOINS,
// the gesture's writes become part of that holder's step, and the holder closes
// it -- an unconditional commit ended the batch halfway, and a cancel dropped
// its undo record (wave E, Y7). Keep Source Column Widths relies on the same
// rule from the other side: its OWN begin opens the step, and the cell paste
// and the width paste inside it join that step instead of closing it.
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a source cell is considered "blank" for skip-blanks logic.
 */
function isCellBlank(cell: CellData | null | undefined): boolean {
  if (!cell) return true;
  return !cell.display && !cell.formula;
}

/**
 * Check if a cell displays a List or Dict collection value.
 */
function isCollectionCell(cell: CellData | null | undefined): boolean {
  if (!cell?.display) return false;
  return cell.display.startsWith("[List(") || cell.display.startsWith("[Dict(");
}

/**
 * The NUMBERS an operation (Add / Subtract / Multiply / Divide) computes from,
 * read TYPED -- the value the engine stores (5.5), never the display text
 * ("5,50 kr", "1,234.00", "50%"). Display text is the app locale's and the
 * number format's, so `Number(display)` read every formatted number, and every
 * fraction under a comma-decimal locale, as 0.
 */
interface OperationOperands {
  /** The source's number at clipboard matrix position "r,c" (absent = 0). */
  source: Map<string, number>;
  /** The destination's number at "row,col", its own coordinates (absent = 0). */
  dest: Map<string, number>;
  /** The paste's place, passed on to the result's write (undefined = the active sheet). */
  target: CellTargetRef | undefined;
}

/** A typed cell's number for an operation: text, booleans, errors and blanks are 0. */
function numberOfTyped(cell: TypedCellData): number {
  return typeof cell.value === "number" && Number.isFinite(cell.value) ? cell.value : 0;
}

/** The most cells one typed sheet read asks for (the backend's MAX_TYPED_RANGE_CELLS). */
const TYPED_READ_BAND = 100_000;

/** A typed read of a sheet rectangle, banded so no call asks for more than the backend's cap. */
async function readSheetTyped(
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  sheetIndex?: number,
): Promise<TypedCellData[]> {
  const width = c1 - c0 + 1;
  const rowBand = Math.max(1, Math.floor(TYPED_READ_BAND / Math.max(1, width)));
  const out: TypedCellData[] = [];
  for (let br = r0; br <= r1; br += rowBand) {
    out.push(...(await getRangeCellsTyped(br, c0, Math.min(r1, br + rowBand - 1), c1, sheetIndex)));
  }
  return out;
}

/**
 * The source's numbers, keyed by clipboard matrix position: a typed read of
 * where the cells were copied FROM (a sheet, or an object's cells), each matrix
 * row mapped back through `sourceRows` (a filtered copy skips rows). When the
 * source can no longer be read (its sheet is gone), the clipboard's display
 * text is read as a number in the APP locale -- never with `Number()`.
 */
async function readSourceOperands(clipboard: ClipboardData, height: number, width: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (height === 0 || width === 0) return out;
  const minRow = Math.min(clipboard.sourceSelection.startRow, clipboard.sourceSelection.endRow);
  const minCol = Math.min(clipboard.sourceSelection.startCol, clipboard.sourceSelection.endCol);
  const rows: number[] = [];
  for (let r = 0; r < height; r++) rows.push(clipboard.sourceRows?.[r] ?? minRow + r);
  const rowOf = new Map(rows.map((abs, r) => [abs, r] as const));
  const r0 = Math.min(...rows);
  const r1 = Math.max(...rows);
  const c1 = minCol + width - 1;
  try {
    const read = clipboard.sourceTarget
      ? await getCellTargetCellsTyped(clipboard.sourceTarget, { startRow: r0, startCol: minCol, endRow: r1, endCol: c1 })
      : await readSheetTyped(r0, minCol, r1, c1, clipboard.sourceSheetIndex);
    for (const cell of read) {
      const r = rowOf.get(cell.row);
      if (r === undefined || cell.col < minCol || cell.col > c1) continue;
      out.set(`${r},${cell.col - minCol}`, numberOfTyped(cell));
    }
  } catch (err) {
    console.warn("[PasteSpecial] the copied cells could not be re-read; using their copied text:", err);
    clipboard.cells.forEach((row, r) =>
      row.forEach((cell, c) => {
        const n = cell?.display ? parseNumber(cell.display) : null;
        if (n !== null && Number.isFinite(n)) out.set(`${r},${c}`, n);
      }),
    );
  }
  return out;
}

/** The destination's numbers over a rectangle, from a typed read (sheet or object). */
function destOperandsOf(read: readonly TypedCellData[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const cell of read) out.set(`${cell.row},${cell.col}`, numberOfTyped(cell));
  return out;
}

/**
 * An operation's result as cell input: INVARIANT text (String(3.5) is "3.5"),
 * written with `invariant: true`, so the backend never reads it as a de-DE /
 * sv-SE entry (where "3.5" is not 3,5).
 */
function operationResultInput(result: number): string {
  return isNaN(result) ? "#DIV/0!" : String(result);
}

/**
 * Apply a mathematical operation between source and target values.
 */
function applyOperation(
  targetValue: number,
  sourceValue: number,
  operation: PasteOperation
): number {
  switch (operation) {
    case "add":
      return targetValue + sourceValue;
    case "subtract":
      return targetValue - sourceValue;
    case "multiply":
      return targetValue * sourceValue;
    case "divide":
      return sourceValue !== 0 ? targetValue / sourceValue : NaN;
    default:
      return sourceValue;
  }
}

/**
 * The formula Paste Link writes for one source cell, spelled the way Excel
 * spells it (measured live through COM, 2026-10-04, Worksheet.Paste
 * Link:=True):
 *   - ONE cell copied: an ABSOLUTE link, `=$A$1`;
 *   - a RANGE copied: a RELATIVE link per cell, `=A1`, `=B2`;
 *   - on another sheet the source sheet is named, quoted when the parser
 *     cannot read it bare: `=Sheet1!$A$1`, `='My Data'!A1`.
 */
function buildLinkFormula(sheetPrefix: string, row: number, col: number, absolute: boolean): string {
  const colLetter = indexToCol(col);
  return absolute ? `=${sheetPrefix}$${colLetter}$${row + 1}` : `=${sheetPrefix}${colLetter}${row + 1}`;
}

/**
 * The sheet prefix a link needs: none on the source sheet itself, `Name!`
 * anywhere else. Before ClipboardData recorded its source sheet the link was
 * always written bare, so a Paste Link on another sheet linked to the same
 * ADDRESSES on the destination sheet (clipboard survey defect 1). Unknown on
 * either side (a payload that predates the field, no grid state) is treated
 * as the same sheet -- the old behaviour, never a guess at a name.
 */
function linkSheetPrefix(clipboard: ClipboardData, target?: CellTargetRef): string {
  const sourceName = clipboard.sourceSheetName;
  const sourceTarget = clipboard.sourceTarget;
  if (target || sourceTarget) {
    // An OBJECT on either side (a floating grid's cells, P3). The link lives
    // where it is written: inside the same object it is bare; anywhere else it
    // names its source -- the sheet, or the object, whose name a formula
    // spells as a sheet's (`=Float1!$A$1`).
    if (target && sourceTarget && target.kind === sourceTarget.kind && target.id === sourceTarget.id) return "";
    return sourceName ? `${quoteSheetNameForFormula(sourceName)}!` : "";
  }
  const targetSheet = getGridStateSnapshot()?.sheetContext?.activeSheetIndex;
  const sourceSheet = clipboard.sourceSheetIndex;
  if (targetSheet === undefined || sourceSheet === undefined || !sourceName) return "";
  if (targetSheet === sourceSheet) return "";
  return `${quoteSheetNameForFormula(sourceName)}!`;
}

/** The matrix's size: rows, and the widest row. */
function matrixSize(cells: (CellData | null)[][]): { height: number; width: number } {
  return { height: cells.length, width: cells.length === 0 ? 0 : Math.max(...cells.map((r) => r.length)) };
}

/**
 * The cells a paste of `clipboard` at `target` writes: the target's top-left,
 * the source's size (swapped by Transpose), clamped to the grid. Plain Paste's
 * guard asks about exactly this rectangle.
 */
function pasteAreaOf(
  clipboard: ClipboardData,
  target: Selection,
  transpose: boolean,
  totalRows: number,
  totalCols: number,
): PasteArea {
  const row = Math.min(target.startRow, target.endRow);
  const col = Math.min(target.startCol, target.endCol);
  const { height, width } = matrixSize(clipboard.cells ?? []);
  return {
    row,
    col,
    height: Math.max(0, Math.min(transpose ? width : height, totalRows - row)),
    width: Math.max(0, Math.min(transpose ? height : width, totalCols - col)),
  };
}

/**
 * The questions every door asks before writing (see the file header):
 * Core's selection must be Core's, and `pasteRefusal` must have nothing to
 * say. Says the refusal ONCE (the owner's toast, or an alert) and answers
 * false; answers true when the paste may go ahead.
 */
async function mayPaste(
  clipboard: ClipboardData,
  area: PasteArea | null,
  label: string,
  target?: CellTargetRef,
): Promise<boolean> {
  // A door that resolved an OBJECT target hands it in; otherwise the question
  // is asked here (the paste lands in Core's selection, or -- with an owner
  // that does not admit pasting -- is refused once, BUG-0185).
  if (!target && resolveCellTarget(label, "content") === null) return false;
  if (!clipboard.cells || clipboard.cells.length === 0) {
    void alertAsync(pasteRefusalSentence.nothingCopied(label));
    return false;
  }
  // The range guards describe the ACTIVE sheet's regions; an object's cells
  // are gated by the backend on the object's own cells.
  const refusal = await pasteRefusal(clipboard, target ? null : area, label);
  if (refusal !== null) {
    void alertAsync(refusal);
    return false;
  }
  return true;
}

// ============================================================================
// Main Execution Functions
// ============================================================================

/**
 * Execute a Paste Special operation. Answers true when it pasted (a partial
 * paste included -- its skipped cells are named in one alert), false when it
 * refused before writing anything.
 *
 * @param label - What the door is called in a refusal ("Paste Values",
 *   "Paste (Transpose)", ...). The dialog's OK is "Paste Special".
 */
export async function executePasteSpecial(
  clipboard: ClipboardData,
  targetSelection: Selection,
  options: PasteSpecialOptions,
  totalRows: number,
  totalCols: number,
  label = "Paste Special",
  target?: CellTargetRef,
): Promise<boolean> {
  if (target && !TARGET_PASTE_ATTRIBUTES.has(options.pasteAttribute)) {
    void alertAsync(pasteRefusalSentence.notOnFloatingGrid(label));
    return false;
  }
  // THE Paste Special door: the dialog's OK and the quick commands (Paste
  // Values / Formulas / Formatting) all land here, and the target is Core's
  // selection. While something else owns the selection (BUG-0185) that is a
  // cell the user cannot see: refused, once, nothing written. Column widths
  // write no cell, so no cell area is guarded for them.
  const area =
    options.pasteAttribute === "columnWidths"
      ? null
      : pasteAreaOf(clipboard, targetSelection, options.transpose, totalRows, totalCols);
  if (!(await mayPaste(clipboard, area, label, target))) return false;
  if (target) await pasteCellsOnTarget(clipboard, targetSelection, options, totalRows, totalCols, target);
  else await pasteCells(clipboard, targetSelection, options, totalRows, totalCols);
  return true;
}

/**
 * Excel's "Keep Source Column Widths" (Home > Paste): the FULL paste (values,
 * formulas, formatting -- Paste Special "All") AND the source columns' widths
 * on the destination columns, as ONE undo step. Paste Special's own "Column
 * widths" radio pastes the widths only, never the cells; this row is both.
 *
 * Its OWN begin opens the step; the cell paste's and the width paste's begins
 * JOIN it (ownUndoTransaction makes their closes no-ops), so Ctrl+Z takes the
 * cells and the widths back together. Anything that throws -- a width the
 * backend refuses -- cancels the WHOLE step: cells and widths go together.
 */
export async function executePasteKeepSourceColumnWidths(
  clipboard: ClipboardData,
  targetSelection: Selection,
  totalRows: number,
  totalCols: number,
  label = "Paste (Keep Source Column Widths)",
  target?: CellTargetRef,
): Promise<boolean> {
  if (target) {
    // A floating grid's column widths are the OBJECT's, not the sheet's that
    // this paste copies them from and to.
    void alertAsync(pasteRefusalSentence.notOnFloatingGrid(label));
    return false;
  }
  const options: PasteSpecialOptions = { pasteAttribute: "all", operation: "none", skipBlanks: false, transpose: false };
  const area = pasteAreaOf(clipboard, targetSelection, false, totalRows, totalCols);
  if (!(await mayPaste(clipboard, area, label))) return false;

  const tx = ownUndoTransaction(
    await beginUndoTransaction(`${label} ${area.height * area.width} cells`),
    UNDO_CLOSES,
  );
  try {
    await pasteCells(clipboard, targetSelection, options, totalRows, totalCols);
    const { width: sourceWidth } = matrixSize(clipboard.cells);
    await pasteColumnWidths(clipboard, area.col, sourceWidth, totalCols);
    await tx.commit();
  } catch (error) {
    // The cell paste and the width paste have each told the user why; here
    // the step they joined is dropped whole, so no half of the gesture stays.
    try { await tx.cancel(); } catch { /* already closed */ }
    throw error;
  }
  return true;
}

/**
 * Excel's relative shift for the formulas a paste of `clipboard` at
 * (`targetRow`, `targetCol`) writes, keyed "r,c" by SOURCE matrix position.
 * Coordinate-relative, so a floating grid's own (backing) coordinates shift
 * exactly like a sheet's; a sheet-qualified reference (`=Float1!A1`) keeps the
 * sheet it names. Empty for a cut and for the attributes that write no formula.
 */
async function shiftedFormulasFor(
  clipboard: ClipboardData,
  pasteAttribute: PasteAttribute,
  transpose: boolean,
  targetRow: number,
  targetCol: number,
): Promise<Map<string, string>> {
  const shiftedFormulaMap = new Map<string, string>();
  const cellsToPaste = clipboard.cells;
  const { height: sourceHeight, width: sourceWidth } = matrixSize(cellsToPaste);
  const needsFormulaShift =
    pasteAttribute === "all" ||
    pasteAttribute === "formulas" ||
    pasteAttribute === "allExceptBorders" ||
    pasteAttribute === "formulasAndNumberFormats";
  if (clipboard.isCut || !needsFormulaShift) return shiftedFormulaMap;

  const sourceSel = clipboard.sourceSelection;
  const sourceMinRow = Math.min(sourceSel.startRow, sourceSel.endRow);
  const sourceMinCol = Math.min(sourceSel.startCol, sourceSel.endCol);

  const formulaEntries: { r: number; c: number; formula: string }[] = [];
  for (let r = 0; r < sourceHeight; r++) {
    for (let c = 0; c < sourceWidth; c++) {
      const cell = cellsToPaste[r]?.[c];
      if (cell?.formula) {
        formulaEntries.push({ r, c, formula: cell.formula });
      }
    }
  }
  if (formulaEntries.length === 0) return shiftedFormulaMap;

  // A FILTERED COPY HAS NO SINGLE ROW DELTA. `cellsToPaste` matrix row `r`
  // was captured from absolute sheet row `clipboard.sourceRows[r]`, which
  // skips filter-hidden rows, so the visible rows slide together. Every row
  // after the first hidden gap therefore shifts by a DIFFERENT amount, and
  // the old shared `targetRow - sourceMinRow` mis-pointed all of them.
  // For an unfiltered copy every delta is identical, i.e. unchanged.
  const rowDeltas = pasteRowDeltas(
    clipboard.sourceRows,
    sourceMinRow,
    targetRow,
    sourceHeight
  );

  // Calculate deltas accounting for transpose
  const inputs: FormulaShiftInput[] = formulaEntries.map((e) => {
    if (transpose) {
      // When transposed, source [r][c] maps to target [c][r]
      const destRow = targetRow + e.c;
      const destCol = targetCol + e.r;
      return {
        formula: e.formula,
        rowDelta:
          destRow - clipboardSourceRow(clipboard.sourceRows, sourceMinRow, e.r),
        colDelta: destCol - (sourceMinCol + e.c),
      };
    } else {
      return {
        formula: e.formula,
        rowDelta: rowDeltas[e.r],
        colDelta: targetCol - sourceMinCol,
      };
    }
  });
  const shiftedFormulas = await shiftFormulasBatch(inputs);
  for (let i = 0; i < formulaEntries.length; i++) {
    const { r, c } = formulaEntries[i];
    shiftedFormulaMap.set(`${r},${c}`, shiftedFormulas[i]);
  }
  return shiftedFormulaMap;
}

/**
 * The cell paste itself, AFTER the questions (`mayPaste`): no refusal here,
 * only the work. Its begin opens its own undo step, or joins the one a caller
 * (Keep Source Column Widths, a script's batch) holds open.
 */
async function pasteCells(
  clipboard: ClipboardData,
  targetSelection: Selection,
  options: PasteSpecialOptions,
  totalRows: number,
  totalCols: number,
): Promise<void> {
  const { pasteAttribute, operation, skipBlanks, transpose } = options;
  const cellsToPaste = clipboard.cells;

  const targetRow = Math.min(targetSelection.startRow, targetSelection.endRow);
  const targetCol = Math.min(targetSelection.startCol, targetSelection.endCol);

  const { height: sourceHeight, width: sourceWidth } = matrixSize(cellsToPaste);

  // When transposing, swap dimensions
  const pasteHeight = transpose ? sourceWidth : sourceHeight;
  const pasteWidth = transpose ? sourceHeight : sourceWidth;

  // Clamp to grid bounds
  const actualPasteHeight = Math.min(pasteHeight, totalRows - targetRow);
  const actualPasteWidth = Math.min(pasteWidth, totalCols - targetCol);

  // Handle Column Widths specially - no cell data involved
  if (pasteAttribute === "columnWidths") {
    await pasteColumnWidths(clipboard, targetCol, sourceWidth, totalCols);
    return;
  }

  // Shift formulas for copy operations (not cut)
  const shiftedFormulaMap = await shiftedFormulasFor(clipboard, pasteAttribute, transpose, targetRow, targetCol);

  // An operation computes from NUMBERS: the source's and the destination's,
  // read typed before anything is written (never their display text).
  let operands: OperationOperands | null = null;
  if (operation !== "none" && actualPasteHeight > 0 && actualPasteWidth > 0) {
    const [source, destRead] = await Promise.all([
      readSourceOperands(clipboard, sourceHeight, sourceWidth),
      readSheetTyped(targetRow, targetCol, targetRow + actualPasteHeight - 1, targetCol + actualPasteWidth - 1),
    ]);
    operands = { source, dest: destOperandsOf(destRead), target: undefined };
  }

  // The grid route: no object target (`ctx.target` is the paste's place).
  const ctx: PasteContext = { clipboard, shiftedFormulaMap, styles: new Map(), target: undefined, operands };

  // Begin undo transaction
  const cellCount = actualPasteHeight * actualPasteWidth;
  const tx = ownUndoTransaction(
    await beginUndoTransaction(`Paste Special (${pasteAttribute}) ${cellCount} cells`),
    UNDO_CLOSES,
  );

  let failedCells = 0;
  let firstFailure: string | null = null;
  try {
    for (let pr = 0; pr < actualPasteHeight; pr++) {
      for (let pc = 0; pc < actualPasteWidth; pc++) {
        const destRow = targetRow + pr;
        const destCol = targetCol + pc;

        // Map paste position back to source position
        const srcR = transpose ? pc : pr;
        const srcC = transpose ? pr : pc;

        // Bounds check on source
        if (srcR >= sourceHeight || srcC >= sourceWidth) continue;

        const sourceCell = cellsToPaste[srcR]?.[srcC] ?? null;

        // Skip blanks check
        if (skipBlanks && isCellBlank(sourceCell)) {
          continue;
        }

        // Grid bounds check
        if (destRow >= totalRows || destCol >= totalCols) continue;

        const failure = await pasteSingleCell(
          sourceCell,
          destRow,
          destCol,
          srcR,
          srcC,
          pasteAttribute,
          operation,
          ctx,
        );
        if (failure !== null) {
          failedCells++;
          firstFailure = firstFailure ?? failure;
        }
      }
    }

    // Commit whatever applied (an all-refused paste commits an empty
    // transaction, which is a no-op) so a partial paste stays undoable.
    await tx.commit();

    // Refresh grid
    window.dispatchEvent(new CustomEvent("styles:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  } catch (error) {
    // Close the transaction — left open, every subsequent edit silently joins
    // it and collapses into one giant Ctrl+Z step.
    try { await tx.cancel(); } catch { /* already closed */ }
    void alertAsync(error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (failedCells > 0) {
    void alertAsync(
      `Paste Special skipped ${failedCells} cell(s):\n${firstFailure ?? "unknown error"}`,
    );
  }
}

/**
 * Execute a Paste Link operation: one link formula per copied cell, pointing
 * at the cell it was copied FROM -- on the sheet it was copied from, the row
 * it was copied from (a filtered copy's rows map back through `sourceRows`,
 * never `sourceMinRow + r`: clipboard survey defect 2). Answers true when it
 * pasted, false when it refused.
 */
export async function executePasteLink(
  clipboard: ClipboardData,
  targetSelection: Selection,
  totalRows: number,
  totalCols: number,
  label = "Paste Link",
  target?: CellTargetRef,
): Promise<boolean> {
  // Same door as executePasteSpecial (the dialog's Paste Link, the Edit menu's
  // Paste Link): refused while the selection is not Core's (BUG-0185), after
  // a cut, from a stale clipboard, over a protected region. With an OBJECT
  // target the links go into the object's cells in one batch.
  const area = pasteAreaOf(clipboard, targetSelection, false, totalRows, totalCols);
  if (!(await mayPaste(clipboard, area, label, target))) return false;

  const cellsToPaste = clipboard.cells;

  const targetRow = area.row;
  const targetCol = area.col;

  const sourceSel = clipboard.sourceSelection;
  const sourceMinRow = Math.min(sourceSel.startRow, sourceSel.endRow);
  const sourceMinCol = Math.min(sourceSel.startCol, sourceSel.endCol);

  const { height: pasteHeight, width: pasteWidth } = matrixSize(cellsToPaste);
  const actualPasteHeight = area.height;
  const actualPasteWidth = area.width;

  // Excel: one copied cell links absolutely, a copied range relatively.
  const absolute = pasteHeight === 1 && pasteWidth === 1;
  const sheetPrefix = linkSheetPrefix(clipboard, target);

  if (target) {
    const updates: CellUpdateInput[] = [];
    for (let r = 0; r < actualPasteHeight; r++) {
      for (let c = 0; c < actualPasteWidth; c++) {
        const srcRow = clipboardSourceRow(clipboard.sourceRows, sourceMinRow, r);
        const srcCol = sourceMinCol + c;
        updates.push({ row: targetRow + r, col: targetCol + c, value: buildLinkFormula(sheetPrefix, srcRow, srcCol, absolute) });
      }
    }
    await writeTargetBatch(updates, [], `Paste Link ${updates.length} cells`, target);
    return true;
  }

  const tx = ownUndoTransaction(
    await beginUndoTransaction(`Paste Link ${actualPasteHeight * actualPasteWidth} cells`),
    UNDO_CLOSES,
  );

  let failedCells = 0;
  let firstFailure: string | null = null;
  try {
    for (let r = 0; r < actualPasteHeight; r++) {
      for (let c = 0; c < actualPasteWidth; c++) {
        const destRow = targetRow + r;
        const destCol = targetCol + c;

        if (destRow >= totalRows || destCol >= totalCols) continue;

        // The cell this matrix entry was copied from.
        const srcRow = clipboardSourceRow(clipboard.sourceRows, sourceMinRow, r);
        const srcCol = sourceMinCol + c;
        const formula = buildLinkFormula(sheetPrefix, srcRow, srcCol, absolute);

        try {
          const { cells: updatedCells } = await updateCell(destRow, destCol, formula);
          for (const cell of updatedCells) {
            if (cell.sheetIndex !== undefined) continue;
            cellEvents.emit({
              row: cell.row,
              col: cell.col,
              oldValue: undefined,
              newValue: cell.display,
              formula: cell.formula ?? null,
            });
          }
        } catch (err) {
          console.error(`[PasteSpecial] Failed to paste link (${destRow}, ${destCol}):`, err);
          failedCells++;
          firstFailure = firstFailure ?? (err instanceof Error ? err.message : String(err));
        }
      }
    }

    await tx.commit();

    window.dispatchEvent(new CustomEvent("styles:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  } catch (error) {
    try { await tx.cancel(); } catch { /* already closed */ }
    void alertAsync(error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (failedCells > 0) {
    void alertAsync(
      `Paste Link skipped ${failedCells} cell(s):\n${firstFailure ?? "unknown error"}`,
    );
  }
  return true;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** What one paste shares across its cells. */
interface PasteContext {
  clipboard: ClipboardData;
  shiftedFormulaMap: Map<string, string>;
  /** Style-table reads, once per index per paste (a column of one style asks once). */
  styles: Map<number, Promise<StyleData>>;
  /**
   * The paste's place: undefined on this per-cell route, which writes the
   * ACTIVE sheet (an object's cells go through `pasteCellsOnTarget`). Passed on
   * every target-taking wrapper call, so a write can never drop it.
   */
  target: CellTargetRef | undefined;
  /** An operation's typed operands (null when the paste has no operation). */
  operands: OperationOperands | null;
}

/** The style table entry `index`, read once per paste. */
function styleOf(ctx: PasteContext, index: number): Promise<StyleData> {
  let style = ctx.styles.get(index);
  if (!style) {
    style = getStyle(index);
    ctx.styles.set(index, style);
  }
  return style;
}

/**
 * The style a source cell carries. An EMPTY source position (no cell record:
 * the matrix holds null) carries the DEFAULT style, index 0 -- what plain
 * Paste writes for it (`sourceCell?.styleIndex ?? 0`, useClipboard.ts), and
 * what Excel does: pasting an unformatted empty cell clears the destination's
 * formatting. Paste All and Paste Formatting used to skip such a cell and
 * leave the destination's old formatting standing.
 */
function sourceStyleIndex(sourceCell: CellData | null): number {
  return sourceCell?.styleIndex ?? 0;
}

/**
 * Paste a single cell based on the selected attribute and operation.
 */
async function pasteSingleCell(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  pasteAttribute: PasteAttribute,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<string | null> {
  const { clipboard, shiftedFormulaMap } = ctx;
  try {
    switch (pasteAttribute) {
      case "all":
        await pasteAll(sourceCell, destRow, destCol, srcR, srcC, operation, shiftedFormulaMap, ctx.operands);
        break;
      case "formulas":
        await pasteFormulas(sourceCell, destRow, destCol, srcR, srcC, operation, shiftedFormulaMap, ctx.operands);
        break;
      case "values":
        await pasteValues(sourceCell, destRow, destCol, srcR, srcC, operation, clipboard.collectionTexts, ctx.operands);
        break;
      case "formats":
        await pasteFormats(sourceCell, destRow, destCol);
        break;
      case "comments":
        await pasteComments(clipboard, destRow, destCol, srcR, srcC);
        break;
      case "validation":
        await pasteValidation(clipboard, destRow, destCol, srcR, srcC);
        break;
      case "allExceptBorders":
        await pasteAllExceptBorders(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
        break;
      case "formulasAndNumberFormats":
        await pasteFormulasAndNumberFormats(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
        break;
      case "valuesAndNumberFormats":
        await pasteValuesAndNumberFormats(sourceCell, destRow, destCol, srcR, srcC, operation, ctx);
        break;
      case "valuesAndSourceFormatting":
        await pasteValuesAndSourceFormatting(
          sourceCell,
          destRow,
          destCol,
          srcR,
          srcC,
          operation,
          clipboard.collectionTexts,
          ctx.operands,
        );
        break;
      case "columnWidths":
        // Handled before the cell loop (pasteCells); no cell is written.
        break;
    }
  } catch (err) {
    // Per-cell failure (most commonly a sheet-protection refusal): report it
    // to the caller so the OPERATION can tell the user, instead of swallowing
    // every refusal and finishing as a silent no-op.
    console.error(`[PasteSpecial] Failed to paste cell (${destRow}, ${destCol}):`, err);
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

/** Announce the cells a write changed (the active sheet's only). */
function emitUpdated(updatedCells: CellData[]): void {
  for (const cell of updatedCells) {
    if (cell.sheetIndex !== undefined) continue;
    cellEvents.emit({
      row: cell.row,
      col: cell.col,
      oldValue: undefined,
      newValue: cell.display,
      formula: cell.formula ?? null,
    });
  }
}

/**
 * Paste All: value/formula + style (same as standard paste).
 */
async function pasteAll(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  shiftedFormulaMap: Map<string, string>,
  operands: OperationOperands | null,
): Promise<void> {
  if (operation !== "none") {
    // With operation: compute and write result, also copy style
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, operands);
    await setCellStyle(destRow, destCol, sourceStyleIndex(sourceCell));
  } else {
    // No operation: paste formula/value + style
    const value =
      shiftedFormulaMap.get(`${srcR},${srcC}`) ??
      sourceCell?.formula ??
      sourceCell?.display ??
      "";

    const { cells: updatedCells } = await updateCell(destRow, destCol, value);
    await setCellStyle(destRow, destCol, sourceStyleIndex(sourceCell));
    emitUpdated(updatedCells);
  }
}

/**
 * Paste Formulas: formula text only, keep target formatting.
 */
async function pasteFormulas(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  shiftedFormulaMap: Map<string, string>,
  operands: OperationOperands | null,
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, operands);
  } else {
    const value =
      shiftedFormulaMap.get(`${srcR},${srcC}`) ??
      sourceCell?.formula ??
      sourceCell?.display ??
      "";

    const { cells: updatedCells } = await updateCell(destRow, destCol, value);
    // Do NOT set style - keep target formatting
    emitUpdated(updatedCells);
  }
}

/**
 * Paste Values: display value only (flattens formulas), no formatting change.
 * For List/Dict cells, pastes the JSON representation if available.
 */
async function pasteValues(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  collectionTexts: Map<string, string> | undefined,
  operands: OperationOperands | null,
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, operands);
  } else {
    // For collection cells, use JSON text if available
    let value = sourceCell?.display ?? "";
    if (isCollectionCell(sourceCell)) {
      const jsonText = collectionTexts?.get(`${srcR},${srcC}`);
      if (jsonText) {
        value = jsonText;
      }
    }

    const { cells: updatedCells } = await updateCell(destRow, destCol, value);
    // Do NOT set style - keep target formatting
    emitUpdated(updatedCells);
  }
}

/**
 * Paste Values and Source Formatting (Excel's Home > Paste > "Values & Source
 * Formatting"): the flattened value, as Paste Values writes it, and then the
 * source cell's WHOLE style -- every field, by pointing the destination at the
 * source's style index, so a field added to the style later travels too.
 */
async function pasteValuesAndSourceFormatting(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  collectionTexts: Map<string, string> | undefined,
  operands: OperationOperands | null,
): Promise<void> {
  await pasteValues(sourceCell, destRow, destCol, srcR, srcC, operation, collectionTexts, operands);
  await setCellStyle(destRow, destCol, sourceStyleIndex(sourceCell));
}

/**
 * Paste Formats: style only, no value change.
 */
async function pasteFormats(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number
): Promise<void> {
  await setCellStyle(destRow, destCol, sourceStyleIndex(sourceCell));

  cellEvents.emit({
    row: destRow,
    col: destCol,
    oldValue: undefined,
    newValue: "",
    formula: null,
  });
}

/**
 * Paste with mathematical operation: read target, compute, write result.
 * Skips List/Dict collection cells (not meaningful for arithmetic).
 */
async function pasteWithOperation(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  operands: OperationOperands | null,
): Promise<void> {
  // Skip arithmetic for collection cells — they are not numeric
  if (isCollectionCell(sourceCell)) return;

  // Read current target cell value
  const targetCell = await getCell(destRow, destCol);

  // Also skip if target is a collection cell
  if (isCollectionCell(targetCell)) return;

  // The NUMBERS, read typed before the paste wrote anything (pasteCells).
  const targetValue = operands?.dest.get(`${destRow},${destCol}`) ?? 0;
  const sourceValue = operands?.source.get(`${srcR},${srcC}`) ?? 0;

  const result = applyOperation(targetValue, sourceValue, operation);

  // Write the computed result as a plain value, in INVARIANT form.
  const updatedCells = await updateCellsBatch(
    [{ row: destRow, col: destCol, value: operationResultInput(result), invariant: true }],
    { target: operands?.target },
  );
  emitUpdated(updatedCells);
}

// ----------------------------------------------------------------------------
// No Borders
// ----------------------------------------------------------------------------

/** The style fields that ARE borders -- derived from the type, never listed. */
type BorderKey = Extract<keyof StyleData, `border${string}`>;
/** What applyFormatting takes for one border side. */
type BorderParam = NonNullable<FormattingOptions[BorderKey]>;
/** One border side as the style table reports it. */
type BorderSide = StyleData[BorderKey];

/** The border sides a style carries, read off the style itself. */
function borderKeysOf(style: StyleData): BorderKey[] {
  return (Object.keys(style) as Array<keyof StyleData>).filter(
    (k): k is BorderKey => k.startsWith("border"),
  );
}

function isNoBorder(side: BorderSide | undefined): boolean {
  return !side || side.style === "none" || side.width === 0;
}

function sameBorder(a: BorderSide | undefined, b: BorderSide | undefined): boolean {
  if (isNoBorder(a) && isNoBorder(b)) return true;
  if (isNoBorder(a) || isNoBorder(b)) return false;
  return a!.style === b!.style && a!.color === b!.color && a!.width === b!.width;
}

function borderParamOf(side: BorderSide | undefined): BorderParam {
  return isNoBorder(side) ? { style: "none", color: "#000000" } : { style: side!.style, color: side!.color };
}

/**
 * Paste All Except Borders (Excel's "No Borders"): the value/formula and
 * EVERY style field of the source except its borders; the destination keeps
 * its OWN borders.
 *
 * Excel, measured live through COM (2026-10-04, xlPasteAllExceptBorders onto a
 * cell that had a thick top border and italic): bold and indent 2 arrived from
 * the source, the destination's italic went, the source's bottom border did
 * NOT arrive, and the destination's thick top border STAYED.
 *
 * DERIVED, not hand-listed. This used to re-apply a hand-copied list of
 * fifteen style fields through applyFormatting, which left out indent,
 * shrink-to-fit, fills, theme colours and the protection flags -- and would
 * have left out every field added to the style after it (clipboard survey
 * defect 5). Now the destination is pointed at the SOURCE's style index (the
 * whole style, whatever it holds), and only the border sides -- found by
 * their `border` prefix on the style objects themselves -- are put back to
 * what the destination had, side by side, and only where the two differ.
 * The one lossy corner is the border wire itself: applyFormatting takes a
 * side as {style, color}, so a destination border coloured from a THEME slot
 * comes back as its resolved colour.
 */
async function pasteAllExceptBorders(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  // The destination's borders, read BEFORE the source style replaces them.
  const destCell = await getCell(destRow, destCol);
  const destStyle = await styleOf(ctx, destCell?.styleIndex ?? 0);

  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, ctx.operands);
  } else {
    const value =
      ctx.shiftedFormulaMap.get(`${srcR},${srcC}`) ??
      sourceCell?.formula ??
      sourceCell?.display ??
      "";

    const { cells: updatedCells } = await updateCell(destRow, destCol, value);
    emitUpdated(updatedCells);
  }

  // Every style field of the source...
  const sourceIndex = sourceStyleIndex(sourceCell);
  const sourceStyle = await styleOf(ctx, sourceIndex);
  await setCellStyle(destRow, destCol, sourceIndex);

  // ...except borders: each side the destination had differently goes back.
  const borders: Partial<Record<BorderKey, BorderParam>> = {};
  for (const key of new Set([...borderKeysOf(sourceStyle), ...borderKeysOf(destStyle)])) {
    if (sameBorder(sourceStyle[key], destStyle[key])) continue;
    borders[key] = borderParamOf(destStyle[key]);
  }
  if (Object.keys(borders).length > 0) {
    await applyFormatting([destRow], [destCol], borders as FormattingOptions, { target: ctx.target });
  }
}

/**
 * Paste Formulas and Number Formats: formula text + number format, keep other formatting.
 */
async function pasteFormulasAndNumberFormats(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, ctx.operands);
  } else {
    const value =
      ctx.shiftedFormulaMap.get(`${srcR},${srcC}`) ??
      sourceCell?.formula ??
      sourceCell?.display ??
      "";

    const { cells: updatedCells } = await updateCell(destRow, destCol, value);
    emitUpdated(updatedCells);
  }

  // Copy only the number format from source style
  if (sourceCell) {
    const sourceStyle = await styleOf(ctx, sourceCell.styleIndex);
    await applyFormatting([destRow], [destCol], { numberFormat: sourceStyle.numberFormat }, { target: ctx.target });
  }
}

/**
 * Paste Values and Number Formats: display value (flattened) + number format, keep other formatting.
 */
async function pasteValuesAndNumberFormats(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  operation: PasteOperation,
  ctx: PasteContext,
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, srcR, srcC, operation, ctx.operands);
  } else {
    let value = sourceCell?.display ?? "";
    if (isCollectionCell(sourceCell)) {
      const jsonText = ctx.clipboard.collectionTexts?.get(`${srcR},${srcC}`);
      if (jsonText) {
        value = jsonText;
      }
    }

    const { cells: updatedCells } = await updateCell(destRow, destCol, value);
    emitUpdated(updatedCells);
  }

  // Copy only the number format from source style
  if (sourceCell) {
    const sourceStyle = await styleOf(ctx, sourceCell.styleIndex);
    await applyFormatting([destRow], [destCol], { numberFormat: sourceStyle.numberFormat }, { target: ctx.target });
  }
}

/**
 * Paste Comments: copy comment from source cell to target cell.
 *
 * A refusal THROWS to pasteSingleCell, which counts it and names it in the
 * paste's one alert -- it used to be caught here and logged, so a protected
 * destination finished as a silent no-op.
 */
async function pasteComments(
  clipboard: ClipboardData,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
): Promise<void> {
  const comment = clipboard.comments?.get(`${srcR},${srcC}`);
  if (!comment) return;

  const params: AddCommentParams = {
    row: destRow,
    col: destCol,
    authorEmail: comment.authorEmail,
    authorName: comment.authorName,
    content: comment.content,
    richContent: comment.richContent,
    mentions: comment.mentions,
  };
  await addComment(params);
}

/**
 * Paste Validation: copy data validation rule from source cell to target cell.
 * A refusal throws to pasteSingleCell (see pasteComments).
 */
async function pasteValidation(
  clipboard: ClipboardData,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
): Promise<void> {
  const validation = clipboard.validations?.get(`${srcR},${srcC}`);
  if (!validation) return;

  await setDataValidation(destRow, destCol, destRow, destCol, validation);
}

/**
 * Paste Column Widths: copy source column dimensions to target columns.
 */
async function pasteColumnWidths(
  clipboard: ClipboardData,
  targetCol: number,
  sourceWidth: number,
  totalCols: number
): Promise<void> {
  const sourceSel = clipboard.sourceSelection;
  const sourceMinCol = Math.min(sourceSel.startCol, sourceSel.endCol);

  const tx = ownUndoTransaction(await beginUndoTransaction(`Paste Column Widths`), UNDO_CLOSES);

  try {
    for (let c = 0; c < sourceWidth; c++) {
      const srcCol = sourceMinCol + c;
      const destCol = targetCol + c;

      if (destCol >= totalCols) break;

      const width = await getColumnWidth(srcCol);
      if (width !== null) {
        await setColumnWidth(destCol, width);
      }
    }

    await tx.commit();
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  } catch (error) {
    console.error("[PasteSpecial] Column widths paste failed:", error);
    try { await tx.cancel(); } catch { /* already closed */ }
    void alertAsync(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

// ============================================================================
// The OBJECT route (a floating grid's cells, P3)
// ============================================================================

/**
 * The attributes a paste onto an object's cells can write: those expressible
 * as a value (with or without the source's whole style) plus a number format.
 * A style-only write has no route onto an object's cells (no style-index write
 * takes a target), comments and validation have no door there, and column
 * widths are the object's own.
 */
const TARGET_PASTE_ATTRIBUTES: ReadonlySet<PasteAttribute> = new Set<PasteAttribute>([
  "all",
  "formulas",
  "values",
  "valuesAndSourceFormatting",
  "formulasAndNumberFormats",
  "valuesAndNumberFormats",
]);

/**
 * Write `updates` (values, with a style index where the source's style
 * travels) to the object's cells in ONE batch, then each `numberFormats`
 * entry, all inside ONE undo step (the batch's own owned step joins it).
 * A refusal is shown and the step closed; nothing half-applied is left open.
 */
async function writeTargetBatch(
  updates: CellUpdateInput[],
  numberFormats: Array<{ row: number; col: number; numberFormat: string }>,
  description: string,
  target: CellTargetRef,
): Promise<void> {
  const tx = ownUndoTransaction(await beginUndoTransaction(description), UNDO_CLOSES);
  let landed = false;
  try {
    if (updates.length > 0) {
      await updateCellsBatch(updates, { target });
      landed = true;
    }
    for (const nf of numberFormats) {
      await applyFormatting([nf.row], [nf.col], { numberFormat: nf.numberFormat }, { target });
      landed = true;
    }
    await tx.commit();
  } catch (error) {
    // What landed stays ONE undoable step; with nothing landed the step is dropped.
    try {
      if (landed) await tx.commit();
      else await tx.cancel();
    } catch {
      /* already closed */
    }
    void alertAsync(error instanceof Error ? error.message : String(error));
    throw error;
  }
  window.dispatchEvent(new CustomEvent("styles:refresh"));
  window.dispatchEvent(new CustomEvent("grid:refresh"));
}

/**
 * Paste Special onto an OBJECT's cells: the same rules as `pasteCells`
 * (transpose, skip blanks, operations, Excel's relative shift), written as one
 * batch through the target instead of one active-sheet call per cell.
 */
async function pasteCellsOnTarget(
  clipboard: ClipboardData,
  targetSelection: Selection,
  options: PasteSpecialOptions,
  totalRows: number,
  totalCols: number,
  target: CellTargetRef,
): Promise<void> {
  const { pasteAttribute, operation, skipBlanks, transpose } = options;
  const cellsToPaste = clipboard.cells;
  const targetRow = Math.min(targetSelection.startRow, targetSelection.endRow);
  const targetCol = Math.min(targetSelection.startCol, targetSelection.endCol);
  const { height: sourceHeight, width: sourceWidth } = matrixSize(cellsToPaste);
  const pasteHeight = transpose ? sourceWidth : sourceHeight;
  const pasteWidth = transpose ? sourceHeight : sourceWidth;
  const actualPasteHeight = Math.max(0, Math.min(pasteHeight, totalRows - targetRow));
  const actualPasteWidth = Math.max(0, Math.min(pasteWidth, totalCols - targetCol));
  if (actualPasteHeight === 0 || actualPasteWidth === 0) return;

  const shiftedFormulaMap = await shiftedFormulasFor(clipboard, pasteAttribute, transpose, targetRow, targetCol);

  // An operation reads what the destination holds now: the object's cells,
  // through its styled read (never the active sheet's cell at those coordinates).
  // The collection check reads the display; the arithmetic reads NUMBERS,
  // typed (the object's and the source's stored values, never display text).
  const destNow = new Map<string, CellData>();
  let operands: OperationOperands | null = null;
  if (operation !== "none") {
    const rect = {
      startRow: targetRow,
      startCol: targetCol,
      endRow: targetRow + actualPasteHeight - 1,
      endCol: targetCol + actualPasteWidth - 1,
    };
    const [read, typed, source] = await Promise.all([
      getCellTargetCells(target, rect),
      getCellTargetCellsTyped(target, rect),
      readSourceOperands(clipboard, sourceHeight, sourceWidth),
    ]);
    for (const cell of read.cells) destNow.set(`${cell.row},${cell.col}`, cell);
    operands = { source, dest: destOperandsOf(typed), target };
  }

  const styles = new Map<number, Promise<StyleData>>();
  const styleOfIndex = (index: number): Promise<StyleData> => {
    let style = styles.get(index);
    if (!style) {
      style = getStyle(index);
      styles.set(index, style);
    }
    return style;
  };

  const carriesStyle = pasteAttribute === "all" || pasteAttribute === "valuesAndSourceFormatting";
  const carriesNumberFormat =
    pasteAttribute === "formulasAndNumberFormats" || pasteAttribute === "valuesAndNumberFormats";
  const writesFormula =
    pasteAttribute === "all" || pasteAttribute === "formulas" || pasteAttribute === "formulasAndNumberFormats";

  const updates: CellUpdateInput[] = [];
  const numberFormats: Array<{ row: number; col: number; numberFormat: string }> = [];
  for (let pr = 0; pr < actualPasteHeight; pr++) {
    for (let pc = 0; pc < actualPasteWidth; pc++) {
      const destRow = targetRow + pr;
      const destCol = targetCol + pc;
      const srcR = transpose ? pc : pr;
      const srcC = transpose ? pr : pc;
      if (srcR >= sourceHeight || srcC >= sourceWidth) continue;
      const sourceCell = cellsToPaste[srcR]?.[srcC] ?? null;
      if (skipBlanks && isCellBlank(sourceCell)) continue;

      let value: string | null;
      let invariant = false;
      if (operation !== "none") {
        const destCell = destNow.get(`${destRow},${destCol}`) ?? null;
        // Arithmetic skips collection cells on either side, as on a sheet.
        if (isCollectionCell(sourceCell) || isCollectionCell(destCell)) {
          value = null;
        } else {
          const result = applyOperation(
            operands?.dest.get(`${destRow},${destCol}`) ?? 0,
            operands?.source.get(`${srcR},${srcC}`) ?? 0,
            operation,
          );
          value = operationResultInput(result);
          invariant = true;
        }
      } else if (writesFormula) {
        value = shiftedFormulaMap.get(`${srcR},${srcC}`) ?? sourceCell?.formula ?? sourceCell?.display ?? "";
      } else {
        value = sourceCell?.display ?? "";
        if (isCollectionCell(sourceCell)) {
          const jsonText = clipboard.collectionTexts?.get(`${srcR},${srcC}`);
          if (jsonText) value = jsonText;
        }
      }

      if (value !== null) {
        const update: CellUpdateInput = { row: destRow, col: destCol, value };
        if (invariant) update.invariant = true;
        if (carriesStyle) update.styleIndex = sourceStyleIndex(sourceCell);
        updates.push(update);
      }
      if (carriesNumberFormat && sourceCell) {
        const sourceStyle = await styleOfIndex(sourceCell.styleIndex);
        numberFormats.push({ row: destRow, col: destCol, numberFormat: sourceStyle.numberFormat });
      }
    }
  }
  if (updates.length === 0 && numberFormats.length === 0) return;
  await writeTargetBatch(
    updates,
    numberFormats,
    `Paste Special (${pasteAttribute}) ${actualPasteHeight * actualPasteWidth} cells`,
    target,
  );
}
