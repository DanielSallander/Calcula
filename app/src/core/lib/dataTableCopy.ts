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

/**
 * What the FORMULA BAR shows for a data table's body cell (BUG-0752): Excel's
 * `{=TABLE(,A1)}`, the array braces round the marker and never the identity
 * argument Calcula adds for a table touching another with the same inputs
 * (`=TABLE(,A1,M2)`, `engine::data_table::TableInputs::anchor`) -- Excel has
 * no such argument. In R1C1 the inputs are ABSOLUTE, as Excel's FormulaR1C1
 * of a body cell reads `=TABLE(,R1C1)` [LIVE, Excel 16 over COM, 2026-11-06,
 * dtable/probe1.ps1: Formula and Formula2 `=TABLE(,A1)`, FormulaR1C1
 * `=TABLE(,R1C1)`, FormulaArray `=TABLE(;A1)` (the list separator), HasArray
 * true]. The separator the marker came with (`,` or the locale's `;`) is kept.
 * Answers `null` for anything that is not a marker, so the caller shows the
 * cell's formula as it does today.
 */
export function dataTableFormulaBarText(formula: string | null | undefined, r1c1: boolean): string | null {
  if (!isDataTableFormula(formula)) return null;
  const m = /^\s*\{?\s*=\s*(TABLE)\s*\(([^()]*)\)\s*\}?\s*$/i.exec(formula as string);
  if (!m) return null;
  const sepMatch = /[,;]/.exec(m[2]);
  const sep = sepMatch ? sepMatch[0] : ",";
  const args = m[2].split(/[,;]/).map((a) => a.trim());
  if (args.length < 2) return null;
  const shown = args.slice(0, 2).map((arg) => (r1c1 ? absoluteR1C1(arg) : arg));
  return `{=${m[1].toUpperCase()}(${shown.join(sep)})}`;
}

/** An A1 cell reference as Excel's absolute R1C1 (`A1` -> `R1C1`); anything else unchanged. */
function absoluteR1C1(ref: string): string {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
  if (!m) return ref;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return `R${m[2]}C${col}`;
}

/**
 * What EDIT MODE (F2, a double-click) shows for a data table's body cell:
 * the formula bar's text without the array braces -- Excel [LIVE, Excel 16
 * over COM and UI Automation, 2026-11-06, dtui/probe2.ps1: L2 selected, the
 * formula bar reads `{=TABLE(;A1)}`; after F2 it reads `=TABLE(;A1)`, and
 * Enter answers "That function isn't valid."]. Never the identity argument
 * (`dataTableFormulaBarText`). `null` for anything that is not a marker.
 */
export function dataTableEditText(formula: string | null | undefined, r1c1: boolean): string | null {
  const shown = dataTableFormulaBarText(formula, r1c1);
  return shown === null ? null : shown.slice(1, -1);
}
