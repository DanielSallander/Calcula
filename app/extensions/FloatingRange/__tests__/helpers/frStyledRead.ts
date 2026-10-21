//! FILENAME: app/extensions/FloatingRange/__tests__/helpers/frStyledRead.ts
// PURPOSE: Test doubles for the floating grid's STYLED read (P3): the
//          `get_cell_target_cells` answer the renderer paints from, built from a
//          plain "what does cell (r, c) hold" function, and a plain style that
//          paints like an unformatted sheet cell.

import type { StyleData } from "@api/types";
import type { CellTargetCells, TargetCellData } from "@api/cellTarget";

/** A plain, unformatted style (what style index 0 is on a fresh document). */
export const PLAIN_STYLE = {
  bold: false,
  italic: false,
  underline: "none",
  strikethrough: false,
  fontSize: 11,
  fontFamily: "Calibri",
  textColor: "#000000",
  backgroundColor: "#ffffff",
  textAlign: "general",
  verticalAlign: "bottom",
  numberFormat: "General",
  wrapText: false,
  textRotation: "none",
  indent: 0,
  shrinkToFit: false,
  locked: true,
  formulaHidden: false,
} as unknown as StyleData;

/** One stored cell of the styled read. */
export function targetCell(
  row: number,
  col: number,
  display: string,
  extra: Partial<TargetCellData> = {},
): TargetCellData {
  return { row, col, display, formula: null, styleIndex: 0, valueKind: "text", ...extra };
}

/**
 * The styled read of `rect` where `cellAt(r, c)` says what each cell holds
 * (null = nothing stored). Styles: index 0 = PLAIN_STYLE, plus `styles`.
 */
export function styledRead(
  rect: { startRow: number; startCol: number; endRow: number; endCol: number },
  cellAt: (row: number, col: number) => TargetCellData | null,
  styles: Record<number, StyleData> = {},
  extra: Partial<CellTargetCells> = {},
): CellTargetCells {
  const cells: TargetCellData[] = [];
  for (let r = rect.startRow; r <= rect.endRow; r++) {
    for (let c = rect.startCol; c <= rect.endCol; c++) {
      const cell = cellAt(r, c);
      if (cell) cells.push(cell);
    }
  }
  const all: Record<number, StyleData> = { 0: PLAIN_STYLE, ...styles };
  return {
    cells,
    merges: [],
    conditional: [],
    styles: Object.entries(all).map(([index, style]) => ({ index: Number(index), style })),
    rules: [],
    ...extra,
  };
}
