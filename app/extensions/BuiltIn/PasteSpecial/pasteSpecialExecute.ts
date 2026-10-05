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

import type { CellData, Selection, StyleData, FormattingOptions } from "@api/types";
import type { ClipboardData, FormulaShiftInput, AddCommentParams } from "@api/lib";
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
} from "@api/lib";
import { cellEvents } from "@api";
import { alertAsync } from "@api/dialogs";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
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
 * Parse a cell's display value as a number.
 * Returns NaN if the value is not numeric.
 */
function parseNumeric(cell: CellData | null | undefined): number {
  if (!cell || !cell.display) return 0;
  const val = Number(cell.display);
  return isNaN(val) ? 0 : val;
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
function linkSheetPrefix(clipboard: ClipboardData): string {
  const targetSheet = getGridStateSnapshot()?.sheetContext?.activeSheetIndex;
  const sourceSheet = clipboard.sourceSheetIndex;
  const sourceName = clipboard.sourceSheetName;
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
async function mayPaste(clipboard: ClipboardData, area: PasteArea | null, label: string): Promise<boolean> {
  if (refuseIfSelectionOwned(label)) return false;
  if (!clipboard.cells || clipboard.cells.length === 0) {
    void alertAsync(pasteRefusalSentence.nothingCopied(label));
    return false;
  }
  const refusal = await pasteRefusal(clipboard, area, label);
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
): Promise<boolean> {
  // THE Paste Special door: the dialog's OK and the quick commands (Paste
  // Values / Formulas / Formatting) all land here, and the target is Core's
  // selection. While something else owns the selection (BUG-0185) that is a
  // cell the user cannot see: refused, once, nothing written. Column widths
  // write no cell, so no cell area is guarded for them.
  const area =
    options.pasteAttribute === "columnWidths"
      ? null
      : pasteAreaOf(clipboard, targetSelection, options.transpose, totalRows, totalCols);
  if (!(await mayPaste(clipboard, area, label))) return false;
  await pasteCells(clipboard, targetSelection, options, totalRows, totalCols);
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
): Promise<boolean> {
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
  const shiftedFormulaMap = new Map<string, string>();
  const needsFormulaShift =
    pasteAttribute === "all" ||
    pasteAttribute === "formulas" ||
    pasteAttribute === "allExceptBorders" ||
    pasteAttribute === "formulasAndNumberFormats";
  if (!clipboard.isCut && needsFormulaShift) {
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

    if (formulaEntries.length > 0) {
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
    }
  }

  const ctx: PasteContext = { clipboard, shiftedFormulaMap, styles: new Map() };

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
): Promise<boolean> {
  // Same door as executePasteSpecial (the dialog's Paste Link, the Edit menu's
  // Paste Link): refused while the selection is not Core's (BUG-0185), after
  // a cut, from a stale clipboard, over a protected region.
  const area = pasteAreaOf(clipboard, targetSelection, false, totalRows, totalCols);
  if (!(await mayPaste(clipboard, area, label))) return false;

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
  const sheetPrefix = linkSheetPrefix(clipboard);

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
        await pasteAll(sourceCell, destRow, destCol, srcR, srcC, operation, shiftedFormulaMap);
        break;
      case "formulas":
        await pasteFormulas(sourceCell, destRow, destCol, srcR, srcC, operation, shiftedFormulaMap);
        break;
      case "values":
        await pasteValues(sourceCell, destRow, destCol, srcR, srcC, operation, clipboard.collectionTexts);
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
        await pasteValuesAndSourceFormatting(sourceCell, destRow, destCol, srcR, srcC, operation, clipboard.collectionTexts);
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
  shiftedFormulaMap: Map<string, string>
): Promise<void> {
  if (operation !== "none") {
    // With operation: compute and write result, also copy style
    await pasteWithOperation(sourceCell, destRow, destCol, operation);
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
  shiftedFormulaMap: Map<string, string>
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, operation);
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
  collectionTexts?: Map<string, string>,
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, operation);
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
  collectionTexts?: Map<string, string>,
): Promise<void> {
  await pasteValues(sourceCell, destRow, destCol, srcR, srcC, operation, collectionTexts);
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
  operation: PasteOperation
): Promise<void> {
  // Skip arithmetic for collection cells — they are not numeric
  if (isCollectionCell(sourceCell)) return;

  // Read current target cell value
  const targetCell = await getCell(destRow, destCol);

  // Also skip if target is a collection cell
  if (isCollectionCell(targetCell)) return;

  const targetValue = parseNumeric(targetCell);
  const sourceValue = parseNumeric(sourceCell);

  const result = applyOperation(targetValue, sourceValue, operation);

  // Write the computed result as a plain value
  const resultStr = isNaN(result) ? "#DIV/0!" : String(result);
  const { cells: updatedCells } = await updateCell(destRow, destCol, resultStr);
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
    await pasteWithOperation(sourceCell, destRow, destCol, operation);
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
    await applyFormatting([destRow], [destCol], borders as FormattingOptions);
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
    await pasteWithOperation(sourceCell, destRow, destCol, operation);
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
    await applyFormatting([destRow], [destCol], {
      numberFormat: sourceStyle.numberFormat,
    });
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
    await pasteWithOperation(sourceCell, destRow, destCol, operation);
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
    await applyFormatting([destRow], [destCol], {
      numberFormat: sourceStyle.numberFormat,
    });
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
