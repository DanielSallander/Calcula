//! FILENAME: app/src/api/tableTotalsService.ts
// PURPOSE: The feature-neutral seam through which a caller (AutoSum) asks for
//          a TABLE's total at a cell without knowing that a Table extension
//          exists (BUG-0769).
// CONTEXT: Inversion of Control, the shape textToColumnsService.ts and
//          autoFilterService.ts use. The Table extension OWNS a table's totals
//          row: turning it on, the function of each column and the formula
//          that function writes (the backend's `build_subtotal_formula`). A
//          caller says WHAT it wants -- "Sum at this cell" -- and the owner
//          decides HOW. Excel [LIVE, Excel 16, 2026-11-06, lane uimisc probe3]:
//          AutoSum on a table's totals-row cell writes =SUBTOTAL(109,[H]), and
//          AutoSum on the cell just below a table whose totals row is OFF turns
//          the totals row ON and writes the same.
//
// ACTIVE SHEET ONLY: a table's cells are the active sheet's. With the Table
// extension disabled `applyTableTotal` answers null ("not a table's total"),
// and the caller goes on with its own rules -- a missing owner is never a
// silent success.

/** The functions a totals cell can be asked for (AutoSum's menu). */
export type TableTotalFunction = "sum" | "average" | "countNumbers" | "max" | "min";

/** What the Table extension provides. */
export interface TableTotalsProvider {
  /**
   * Put `fn` in the table's totals cell at (row, col) of the ACTIVE sheet, as
   * ONE undo step: a cell of a table's totals row, or the cell just below a
   * table whose totals row is off (which turns it on). Resolves true when it
   * wrote the total, false when the table refused (the reason was shown), and
   * null when the cell is no table's totals cell -- nothing was done.
   */
  applyTotal(row: number, col: number, fn: TableTotalFunction): Promise<boolean | null>;
}

let provider: TableTotalsProvider | null = null;

/**
 * Register the totals provider. Called once by the Table extension at
 * activation; returns the unregister function for its cleanup list. Last
 * registration wins, and unregistering clears only the provider it registered.
 */
export function registerTableTotalsProvider(next: TableTotalsProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/**
 * A table's total at (row, col): see `TableTotalsProvider.applyTotal`. Null
 * when no provider is registered or the cell is no table's totals cell.
 */
export async function applyTableTotal(row: number, col: number, fn: TableTotalFunction): Promise<boolean | null> {
  if (!provider) return null;
  return provider.applyTotal(row, col, fn);
}
