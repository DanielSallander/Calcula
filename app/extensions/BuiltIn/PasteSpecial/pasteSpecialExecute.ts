//! FILENAME: app/extensions/BuiltIn/PasteSpecial/pasteSpecialExecute.ts
// PURPOSE: Core execution logic for Paste Special operations.
// CONTEXT: Handles all paste variants (values, formulas, formats, operations,
//          transpose, skip blanks, paste link) using existing API primitives.

import type { CellData, Selection } from "../../../src/api/types";
import type { ClipboardData, FormulaShiftInput } from "../../../src/api/lib";
import type { PasteSpecialOptions, PasteOperation } from "./types";
import {
  getCell,
  updateCell,
  setCellStyle,
  getColumnWidth,
  setColumnWidth,
  beginUndoTransaction,
  commitUndoTransaction,
  shiftFormulasBatch,
  indexToCol,
} from "../../../src/api/lib";
import { cellEvents } from "../../../src/api";

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
 * Build an absolute cell reference formula (e.g., "=$A$1").
 */
function buildAbsoluteRef(row: number, col: number): string {
  const colLetter = indexToCol(col);
  return `=$${colLetter}$${row + 1}`;
}

// ============================================================================
// Main Execution Functions
// ============================================================================

/**
 * Execute a Paste Special operation.
 */
export async function executePasteSpecial(
  clipboard: ClipboardData,
  targetSelection: Selection,
  options: PasteSpecialOptions,
  totalRows: number,
  totalCols: number
): Promise<void> {
  const { pasteAttribute, operation, skipBlanks, transpose } = options;
  const cellsToPaste = clipboard.cells;

  if (!cellsToPaste || cellsToPaste.length === 0) {
    console.log("[PasteSpecial] Nothing to paste");
    return;
  }

  const targetRow = Math.min(targetSelection.startRow, targetSelection.endRow);
  const targetCol = Math.min(targetSelection.startCol, targetSelection.endCol);

  const sourceHeight = cellsToPaste.length;
  const sourceWidth = Math.max(...cellsToPaste.map((r) => r.length));

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
  if (!clipboard.isCut && (pasteAttribute === "all" || pasteAttribute === "formulas")) {
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
      // Calculate deltas accounting for transpose
      const inputs: FormulaShiftInput[] = formulaEntries.map((e) => {
        if (transpose) {
          // When transposed, source [r][c] maps to target [c][r]
          const destRow = targetRow + e.c;
          const destCol = targetCol + e.r;
          return {
            formula: e.formula,
            rowDelta: destRow - (sourceMinRow + e.r),
            colDelta: destCol - (sourceMinCol + e.c),
          };
        } else {
          return {
            formula: e.formula,
            rowDelta: targetRow - sourceMinRow,
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

  // Begin undo transaction
  const cellCount = actualPasteHeight * actualPasteWidth;
  await beginUndoTransaction(`Paste Special (${pasteAttribute}) ${cellCount} cells`);

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

        await pasteSingleCell(
          sourceCell,
          destRow,
          destCol,
          srcR,
          srcC,
          pasteAttribute,
          operation,
          shiftedFormulaMap
        );
      }
    }

    await commitUndoTransaction();

    // Refresh grid
    window.dispatchEvent(new CustomEvent("styles:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  } catch (error) {
    console.error("[PasteSpecial] Failed:", error);
    // Transaction will be left open; next operation will auto-commit or user can undo
    throw error;
  }
}

/**
 * Execute a Paste Link operation.
 * Inserts absolute reference formulas pointing to source cells.
 */
export async function executePasteLink(
  clipboard: ClipboardData,
  targetSelection: Selection,
  totalRows: number,
  totalCols: number
): Promise<void> {
  const cellsToPaste = clipboard.cells;
  if (!cellsToPaste || cellsToPaste.length === 0) return;

  const targetRow = Math.min(targetSelection.startRow, targetSelection.endRow);
  const targetCol = Math.min(targetSelection.startCol, targetSelection.endCol);

  const sourceSel = clipboard.sourceSelection;
  const sourceMinRow = Math.min(sourceSel.startRow, sourceSel.endRow);
  const sourceMinCol = Math.min(sourceSel.startCol, sourceSel.endCol);

  const pasteHeight = cellsToPaste.length;
  const pasteWidth = Math.max(...cellsToPaste.map((r) => r.length));

  const actualPasteHeight = Math.min(pasteHeight, totalRows - targetRow);
  const actualPasteWidth = Math.min(pasteWidth, totalCols - targetCol);

  await beginUndoTransaction(`Paste Link ${actualPasteHeight * actualPasteWidth} cells`);

  try {
    for (let r = 0; r < actualPasteHeight; r++) {
      for (let c = 0; c < actualPasteWidth; c++) {
        const destRow = targetRow + r;
        const destCol = targetCol + c;

        if (destRow >= totalRows || destCol >= totalCols) continue;

        // Create absolute reference to source cell
        const srcRow = sourceMinRow + r;
        const srcCol = sourceMinCol + c;
        const formula = buildAbsoluteRef(srcRow, srcCol);

        try {
          const updatedCells = await updateCell(destRow, destCol, formula);
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
        }
      }
    }

    await commitUndoTransaction();

    window.dispatchEvent(new CustomEvent("styles:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  } catch (error) {
    console.error("[PasteSpecial] Paste Link failed:", error);
    throw error;
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Paste a single cell based on the selected attribute and operation.
 */
async function pasteSingleCell(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  srcR: number,
  srcC: number,
  pasteAttribute: string,
  operation: PasteOperation,
  shiftedFormulaMap: Map<string, string>
): Promise<void> {
  try {
    switch (pasteAttribute) {
      case "all":
        await pasteAll(sourceCell, destRow, destCol, srcR, srcC, operation, shiftedFormulaMap);
        break;
      case "formulas":
        await pasteFormulas(sourceCell, destRow, destCol, srcR, srcC, operation, shiftedFormulaMap);
        break;
      case "values":
        await pasteValues(sourceCell, destRow, destCol, operation);
        break;
      case "formats":
        await pasteFormats(sourceCell, destRow, destCol);
        break;
      case "comments":
        // Comments paste is a placeholder - would need comment copy in clipboard
        console.log("[PasteSpecial] Comments paste not yet implemented");
        break;
      case "validation":
        // Validation paste is a placeholder - would need validation copy in clipboard
        console.log("[PasteSpecial] Validation paste not yet implemented");
        break;
    }
  } catch (err) {
    console.error(`[PasteSpecial] Failed to paste cell (${destRow}, ${destCol}):`, err);
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
    if (sourceCell) {
      await setCellStyle(destRow, destCol, sourceCell.styleIndex);
    }
  } else {
    // No operation: paste formula/value + style
    const value =
      shiftedFormulaMap.get(`${srcR},${srcC}`) ??
      sourceCell?.formula ??
      sourceCell?.display ??
      "";

    const updatedCells = await updateCell(destRow, destCol, value);
    if (sourceCell) {
      await setCellStyle(destRow, destCol, sourceCell.styleIndex);
    }

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

    const updatedCells = await updateCell(destRow, destCol, value);
    // Do NOT set style - keep target formatting

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
}

/**
 * Paste Values: display value only (flattens formulas), no formatting change.
 */
async function pasteValues(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  operation: PasteOperation
): Promise<void> {
  if (operation !== "none") {
    await pasteWithOperation(sourceCell, destRow, destCol, operation);
  } else {
    // Use display value (the computed result), never the formula
    const value = sourceCell?.display ?? "";

    const updatedCells = await updateCell(destRow, destCol, value);
    // Do NOT set style - keep target formatting

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
}

/**
 * Paste Formats: style only, no value change.
 */
async function pasteFormats(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number
): Promise<void> {
  if (!sourceCell) return;

  await setCellStyle(destRow, destCol, sourceCell.styleIndex);

  cellEvents.emit({
    row: destRow,
    col: destCol,
    oldValue: undefined,
    newValue: undefined,
    formula: null,
  });
}

/**
 * Paste with mathematical operation: read target, compute, write result.
 */
async function pasteWithOperation(
  sourceCell: CellData | null,
  destRow: number,
  destCol: number,
  operation: PasteOperation
): Promise<void> {
  // Read current target cell value
  const targetCell = await getCell(destRow, destCol);
  const targetValue = parseNumeric(targetCell);
  const sourceValue = parseNumeric(sourceCell);

  const result = applyOperation(targetValue, sourceValue, operation);

  // Write the computed result as a plain value
  const resultStr = isNaN(result) ? "#DIV/0!" : String(result);
  const updatedCells = await updateCell(destRow, destCol, resultStr);

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

  await beginUndoTransaction(`Paste Column Widths`);

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

    await commitUndoTransaction();
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  } catch (error) {
    console.error("[PasteSpecial] Column widths paste failed:", error);
    throw error;
  }
}
