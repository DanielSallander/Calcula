//! FILENAME: app/src/core/lib/dataTableCopy.ts
// PURPOSE: A COPY of a live data table's body cell carries its VALUE, never its
//          `=TABLE(..)` marker.
// CONTEXT: A What-If Data Table's body holds Excel's `{=TABLE(row, col)}` marker
//          (BUG-0652, core/engine/src/data_table.rs), which only the Data Table
//          command may write: the backend refuses it as a typed or pasted
//          formula ("That function isn't valid."). So a copy that carried the
//          marker as the cell's formula pasted nothing at all. Excel [LIVE,
//          Excel 16 over COM, 2026-11-05, dtfollow/probe1.ps1, table K1:L4]
//          pastes the body's VALUES whatever the paste kind -- Paste, Paste
//          Special Formulas, Values and Formulas and Number Formats of L2 all
//          wrote the number 10; the whole table K1:L4 pasted its formula row
//          shifted (`=B1` -> `=S1`) and its body as values -- and Fill and a
//          Ctrl+drag copy do the same. The copy routes therefore drop the
//          marker from every copied cell (`copiedCell`), and the paste writes
//          the cell's stored value as it writes any constant's.

/** Whether `formula` is a data table's body marker (`=TABLE(,A1)`, `=TABLE(A1;D1)`). */
export function isDataTableFormula(formula: string | null | undefined): boolean {
  return typeof formula === "string" && /^\s*\{?\s*=\s*TABLE\s*\(/i.test(formula);
}

/**
 * A copied cell as a copy carries it: a data-table body cell without its
 * formula (its stored value and display stay), every other cell as it is.
 */
export function copiedCell<T extends { formula?: string | null }>(cell: T): T;
export function copiedCell<T extends { formula?: string | null }>(cell: T | null): T | null;
export function copiedCell<T extends { formula?: string | null }>(cell: T | null): T | null {
  if (cell && isDataTableFormula(cell.formula)) {
    return { ...cell, formula: null };
  }
  return cell;
}
