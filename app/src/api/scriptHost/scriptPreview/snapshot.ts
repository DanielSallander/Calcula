//! FILENAME: app/src/api/scriptHost/scriptPreview/snapshot.ts
// PURPOSE: Give the preview a document — a bounded READ-ONLY copy of the live
//          workbook's active sheet, so a draft can be run against the data it
//          would really see.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          THIS IS THE ANSWER TO "a preview has no document for". It does not
//          need one of its own: it needs a COPY, and the workbook can be read
//          without being touched. `ai_dry_run_script` already works this way on
//          the Rust side (`state.grids.read().clone()`), so previewing against
//          the user's real data is the established posture of this rung, not a
//          new one.
//
//          READ-ONLY BY CONSTRUCTION. Every call below is a `class: "read"` row
//          in the ALLOWLIST; nothing here writes, dirties the document, enters
//          the undo stack or emits a refresh. The copy then lives entirely in
//          the preview grid, and the script mutates THAT.
//
//          BOUNDED ON PURPOSE. A workbook can hold a million rows and a preview
//          is a thing a person waits for. The snapshot is capped, and a capped
//          snapshot SAYS SO (`truncated`) rather than quietly presenting a
//          corner of the sheet as the whole of it — a script whose answer
//          depends on rows that were never copied must not be graded on it.

import { PreviewGrid } from "./grid";

/** How much of a sheet a preview copies. */
export const MAX_SNAPSHOT_CELLS = 20_000;

export interface SnapshotResult {
  grid: PreviewGrid;
  sheetNames: string[];
  activeSheet: number;
  /** The used-range rectangle actually copied, or null for an empty sheet. */
  copied: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  /**
   * The sheet was larger than `MAX_SNAPSHOT_CELLS` and the copy is a PREFIX of
   * it. Callers must treat a run over a truncated snapshot as inconclusive
   * about anything outside the copied rectangle.
   */
  truncated: boolean;
}

/** The reads a snapshot needs. Injected so the module is testable headless. */
export interface SnapshotSource {
  getSheetNames(): Promise<string[]>;
  getActiveSheet(): Promise<number>;
  getUsedRange(): Promise<{
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    empty: boolean;
  }>;
  getRangeCells(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): Promise<
    Array<{
      row: number;
      col: number;
      value: number | string | boolean | null;
      display: string;
      formula: string | null;
    }>
  >;
}

/**
 * The INPUT STRING for a snapshotted cell — what the user would see in the
 * formula bar, and the vocabulary the whole preview stores and diffs in.
 *
 * Derived from `value`, never from `display`: `display` is FORMATTED text, so a
 * currency cell holding 42 displays "$42.00", and storing that as the input
 * would make the diff report a change the moment anything rewrote the cell with
 * the number it already held.
 */
export function inputStringOf(cell: {
  value: number | string | boolean | null;
  formula: string | null;
}): string {
  if (cell.formula) return cell.formula.startsWith("=") ? cell.formula : `=${cell.formula}`;
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : String(v);
  return String(v);
}

/**
 * Copy the active sheet's used range into a fresh preview grid.
 *
 * Both halves of each cell are carried: the INPUT STRING (what the script reads
 * as a formula and what the diff compares) and the DISPLAY (what the workbook
 * computed and formatted, which is what `api.getCellValue` actually returns).
 * Carrying only the first would make every formula cell read as empty and every
 * formatted cell read raw — a preview that quietly disagrees with the product
 * about what is in the workbook.
 */
export async function snapshotActiveSheet(source: SnapshotSource): Promise<SnapshotResult> {
  const [sheetNames, activeSheet, used] = await Promise.all([
    source.getSheetNames(),
    source.getActiveSheet(),
    source.getUsedRange(),
  ]);

  const grid = new PreviewGrid();
  if (used.empty) {
    return { grid, sheetNames, activeSheet, copied: null, truncated: false };
  }

  // Clamp rows-first: a sheet is far more often long than wide, and keeping
  // whole ROWS keeps every record the copy does carry internally consistent.
  // Halving a row instead would hand a script a record missing its own columns,
  // which reads as data corruption rather than as a bound.
  const width = used.endCol - used.startCol + 1;
  const maxRows = Math.max(1, Math.floor(MAX_SNAPSHOT_CELLS / Math.max(1, width)));
  const endRow = Math.min(used.endRow, used.startRow + maxRows - 1);
  const truncated = endRow < used.endRow;

  const cells = await source.getRangeCells(used.startRow, used.startCol, endRow, used.endCol);
  for (const cell of cells) {
    grid.seedFromDocument(cell.row, cell.col, inputStringOf(cell), cell.display);
  }

  return {
    grid,
    sheetNames,
    activeSheet,
    copied: { startRow: used.startRow, startCol: used.startCol, endRow, endCol: used.endCol },
    truncated,
  };
}
