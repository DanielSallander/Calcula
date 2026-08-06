//! FILENAME: app/src/core/lib/clipboardVisibility.ts
// PURPOSE: Excel's hidden-row rules for clipboard capture, as pure functions.
// CONTEXT: Copy and Cut do NOT treat hidden rows the same way, and Excel does
//          not treat all *kinds* of hidden the same way either. Keeping the
//          rule here (instead of inline in useClipboard) makes it testable
//          without a React tree and keeps ONE definition of the rule.
//
// THE RULE (verified against Excel documentation/behaviour, see below):
//
//   COPY of a range that spans FILTER-hidden rows copies only the VISIBLE
//   rows. The copied block collapses: the visible rows slide together and
//   paste as a contiguous rectangle at the destination.
//     "If you copy from a filtered range, Excel will only copy those cells on
//      display."  -- wizardofexcel, "Danger: copying and cutting in a filtered
//      range". Microsoft's own "command cannot be used on multiple selections"
//      article describes the same collapse: Excel "slides the ranges together
//      and pastes them as a single rectangle".
//
//   CUT of the same range cuts EVERYTHING between the top and bottom of the
//   selection, INCLUDING the filter-hidden rows.
//     "If you cut from a filtered range, Excel will cut everything in between
//      the top and bottom of your selection, including those intervening cells
//      that are hidden because of filtering."  -- ibid.
//
//   MANUALLY hidden rows/columns are copied. So are OUTLINE-collapsed rows:
//   copying a collapsed subtotal outline famously drags every hidden detail
//   row along, which is why the Alt+; ("visible cells only") trick exists.
//
//   COLUMNS are never skipped. Excel has no column filter; a hidden column is
//   a hand hide, and hand hides are copied. Calcula's `filterHiddenCols` is
//   fed only by a restored view bookmark, which is likewise not a filter.
//
//   PASTE is always a plain contiguous rectangle — it writes THROUGH hidden
//   rows at the destination. (Excel does the same, which is the other half of
//   the "danger" above.) Nothing in this module applies to the paste target.

/**
 * Hard cap on a single clipboard capture, so a select-all on a 1M x 16K grid
 * cannot try to marshal the whole sheet cell by cell.
 */
export const MAX_CLIPBOARD_CELLS = 5_000_000;

/**
 * The absolute source rows a clipboard capture should read, top to bottom.
 *
 * @param minRow            First row of the selection (inclusive).
 * @param maxRow            Last row of the selection (inclusive).
 * @param filterHiddenRows  Rows hidden by AutoFilter / Advanced Filter. Pass
 *                          ONLY the filter source — never the effective union,
 *                          which also contains hand hides and outline
 *                          collapses that Excel copies.
 * @param includeFilterHidden true for CUT (takes the whole rectangle), false
 *                          for COPY (visible rows only).
 */
export function copyableSourceRows(
  minRow: number,
  maxRow: number,
  filterHiddenRows: ReadonlySet<number> | undefined,
  includeFilterHidden: boolean
): number[] {
  const rows: number[] = [];
  for (let r = minRow; r <= maxRow; r++) {
    if (!includeFilterHidden && filterHiddenRows?.has(r)) continue;
    rows.push(r);
  }
  return rows;
}

/** Result of a clipboard capture: the matrix plus where each row came from. */
export interface ClipboardCapture<T> {
  /** Cell matrix, [matrixRow][matrixCol]. Filter-hidden rows are absent on copy. */
  cells: (T | null)[][];
  /**
   * Absolute sheet row for each matrix row, same length as `cells`. With no
   * filter-hidden rows in play this is simply minRow, minRow+1, ... — but it
   * is the ONLY safe way to map a matrix row back to the sheet after a
   * collapsed copy, so consumers must use it rather than `minRow + r`.
   */
  sourceRows: number[];
  /** First column of the capture (matrix column 0). Columns are never skipped. */
  sourceMinCol: number;
  /** True when the capture was refused for exceeding MAX_CLIPBOARD_CELLS. */
  tooLarge: boolean;
}

/**
 * Read a rectangle into a clipboard matrix, applying the copy/cut hidden rule.
 *
 * `readCell` is injected so this stays free of the Tauri bridge (and testable).
 * A read that throws yields a null cell, matching the previous inline loop.
 */
export async function captureClipboardCells<T>(params: {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
  filterHiddenRows?: ReadonlySet<number>;
  includeFilterHidden: boolean;
  readCell: (row: number, col: number) => Promise<T | null>;
  /** Cap override; defaults to MAX_CLIPBOARD_CELLS. */
  maxCells?: number;
}): Promise<ClipboardCapture<T>> {
  const {
    minRow, maxRow, minCol, maxCol,
    filterHiddenRows, includeFilterHidden, readCell,
    maxCells = MAX_CLIPBOARD_CELLS,
  } = params;

  const width = maxCol - minCol + 1;
  const sourceRows = copyableSourceRows(minRow, maxRow, filterHiddenRows, includeFilterHidden);

  // The cap counts the cells actually READ, not the selection rectangle: a
  // filtered copy of a huge range may only need a handful of visible rows.
  if (sourceRows.length * width > maxCells) {
    return { cells: [], sourceRows: [], sourceMinCol: minCol, tooLarge: true };
  }

  const cells: (T | null)[][] = [];
  for (const absRow of sourceRows) {
    const row: (T | null)[] = [];
    for (let c = minCol; c <= maxCol; c++) {
      try {
        row.push((await readCell(absRow, c)) ?? null);
      } catch {
        row.push(null);
      }
    }
    cells.push(row);
  }

  return { cells, sourceRows, sourceMinCol: minCol, tooLarge: false };
}

/**
 * Absolute sheet row that matrix row `r` was captured from.
 *
 * Falls back to the contiguous assumption when a clipboard payload predates
 * `sourceRows` (or came from the system clipboard, which has no source rows).
 */
export function clipboardSourceRow(
  sourceRows: number[] | undefined,
  sourceMinRow: number,
  r: number
): number {
  const mapped = sourceRows?.[r];
  return mapped === undefined ? sourceMinRow + r : mapped;
}

/**
 * Per-matrix-row relative-reference shift for a paste.
 *
 * A collapsed copy does NOT have one shared row delta: matrix row `r` came
 * from `sourceRows[r]` and lands on `targetRow + r`, so each row's formulas
 * shift by a different amount. Using a single delta would leave every row
 * after the first filter-hidden gap pointing at the wrong cells.
 */
export function pasteRowDeltas(
  sourceRows: number[] | undefined,
  sourceMinRow: number,
  targetRow: number,
  height: number
): number[] {
  const deltas: number[] = [];
  for (let r = 0; r < height; r++) {
    deltas.push(targetRow + r - clipboardSourceRow(sourceRows, sourceMinRow, r));
  }
  return deltas;
}
