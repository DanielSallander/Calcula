//! FILENAME: app/src/core/lib/activeCell.ts
// PURPOSE: The ONE rule for which cell of a selection is the ACTIVE cell -- the
//          cell the grid draws the active-cell border on, and the cell every
//          "about the cell" read or write uses: a format toggle's direction
//          (Ctrl+B / Ctrl+I / Ctrl+U), the ribbon's and the mini toolbar's
//          style read, the Format Cells dialog's starting values, Ctrl+; / Ctrl+:.
// CONTEXT: `Selection.startRow/startCol` is the ANCHOR; the active cell is
//          `activeRow/activeCol` when the grid sets them, else `endRow/endCol`
//          (the Selection type documents end as the active cell, and the
//          renderer draws it there). Before 2026-10-04 the rule was spelled
//          three ways: the Home tab read end, Format Cells and Ctrl+B read the
//          anchor, the mini toolbar's style load read the top-left cell -- so
//          after a drag from a bold B2 down to a plain B5 the ribbon showed Bold
//          off while Ctrl+B un-bolded and Format Cells showed Bold on. Go To
//          Special writes its main range anchor-at-the-far-corner on purpose
//          (the first match is the active cell), which made the anchor readers
//          visibly wrong (review findings (f) and (g)). Extensions reach this
//          as `@api/activeCell`.

/** The fields of a selection the rule reads (a Selection, or a snapshot of one). */
export interface ActiveCellSource {
  endRow: number;
  endCol: number;
  activeRow?: number;
  activeCol?: number;
}

/** The cell the grid draws as active, or null with no selection. */
export function activeCellOf(
  selection: ActiveCellSource | null | undefined,
): { row: number; col: number } | null {
  if (!selection) return null;
  return { row: selection.activeRow ?? selection.endRow, col: selection.activeCol ?? selection.endCol };
}
