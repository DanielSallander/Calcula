//! FILENAME: app/extensions/Pivot/lib/getPivotDataPick.ts
// PURPOSE: What a formula-mode click on a pivot value inserts while Formulas >
//          Generate GetPivotData is on: the GETPIVOTDATA call naming that
//          value. The formula-reference interceptor Pivot registers (index.ts);
//          Core qualifies the pivot cell's reference with the sheet it was
//          picked on (qualifyInterceptedCellRef).

import { columnToLetter } from "@api";
import type { FormulaReferenceOverride } from "@api/formulaReferenceInterceptors";
import { isPointModeOnForeignSheet } from "@api/gridOverlays";
import { getLocaleSettings } from "@api/locale";
import { findPivotRegionAtCell } from "../handlers/selectionHandler";
import { getPivotDataFormula } from "./pivot-api";
import { isGenerateGetPivotDataEnabled } from "./getPivotDataToggle";

/** A formula string literal: quoted, an embedded quote doubled. */
function stringLiteral(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The GETPIVOTDATA text for a pick on (`row`, `col`) of the sheet the grid
 * SHOWS, or null to insert the plain reference.
 *
 * THE CACHE IS ONLY A SHORTCUT, AND ONLY ON THE EDIT'S OWN SHEET. The cached
 * pivot regions belong to the sheet the edit lives on: a point-mode switch to
 * another sheet emits no SHEET_CHANGED, so nothing re-reads them. There they
 * say nothing about the cell under the pointer, and the backend -- which
 * answers for the sheet the grid shows -- decides. Before this, a pick on a
 * pivot on ANOTHER sheet inserted `=Pivots!E4` and never GETPIVOTDATA (found
 * live 2026-09-29, e2e fixall-edit W14).
 */
export async function getPivotDataPick(row: number, col: number): Promise<FormulaReferenceOverride | null> {
  if (!isGenerateGetPivotDataEnabled()) return null;
  if (!isPointModeOnForeignSheet() && !findPivotRegionAtCell(row, col)) return null;

  const result = await getPivotDataFormula(row, col);
  if (!result) return null;

  // The locale's list separator: the editing pipeline delocalizes the formula
  // before storing it (";" on a Swedish workbook).
  const locale = await getLocaleSettings();
  const sep = locale.listSeparator;
  const cellRef = "$" + columnToLetter(col) + "$" + (row + 1);
  let formula = `GETPIVOTDATA(${stringLiteral(result.dataField)}${sep}${cellRef}`;
  for (const [fieldName, itemValue] of result.fieldItemPairs) {
    formula += `${sep}${stringLiteral(fieldName)}${sep}${stringLiteral(itemValue)}`;
  }
  formula += ")";

  return { text: formula, highlightRow: row, highlightCol: col };
}
