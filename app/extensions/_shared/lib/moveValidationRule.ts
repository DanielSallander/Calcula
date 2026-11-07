//! FILENAME: app/extensions/_shared/lib/moveValidationRule.ts
// PURPOSE: A whole data-validation rule as the cell `drow` rows below and
//          `dcol` columns right of the cell it is written for reads it: a
//          custom formula's relative references moved (`moveRuleFormula`, the
//          backend's shifter, wrapping round the sheet's edge), and a list
//          source's relative corners moved the same way. Absolute parts stay;
//          a typed list of values and the numeric, date, time and text-length
//          rules carry no reference and are returned as they are.
// CONTEXT: Paste Validation (BuiltIn/PasteSpecial) restates a copied rule for
//          the pasted block: a rule is stored for its range's TOP-LEFT cell,
//          and Excel's pasted cell reads it as the copied cell did -- moved by
//          (destination - the source range's top-left) [LIVE, Excel 16,
//          2026-11-06, lane obj4 v1.ps1: `=A1>0` on A1:A10, A5:A6 pasted at
//          C1 reads `=C1>0` / `=C2>0`; the list `=G1:H1` on E1:E10, E5 pasted
//          at J20 lists `=L20:M20`]. The list-corner rule is the Data
//          Validation dialog's (`DataValidation/lib/listSourceRef.ts`
//          `moveListRange`, [LIVE] cfdvb/probe1.ps1): kept here because an
//          extension may not import another's internals; the two must agree.

import type { DataValidation, ListSource } from "@api";
import { moveRuleFormula, SHEET_COLS, SHEET_ROWS, type FormulaShifter } from "./moveRuleFormula";

type ListRange = Extract<ListSource, { range: unknown }>["range"];

interface Corner {
  row: number;
  col: number;
  rowRelative: boolean;
  colRelative: boolean;
}

function wrap(v: number, size: number): number {
  return ((v % size) + size) % size;
}

function moveCorner(c: Corner, drow: number, dcol: number): Corner {
  return {
    ...c,
    row: c.rowRelative ? wrap(c.row + drow, SHEET_ROWS) : c.row,
    col: c.colRelative ? wrap(c.col + dcol, SHEET_COLS) : c.col,
  };
}

/** A list source's range moved: each relative part moved, the corners put back in order. */
export function moveListSourceRange(range: ListRange, drow: number, dcol: number): ListRange {
  if ((drow === 0 && dcol === 0) || !range.relative) return range;
  const rel = range.relative;
  const a = moveCorner(
    { row: range.startRow, col: range.startCol, rowRelative: !!rel.startRow, colRelative: !!rel.startCol },
    drow,
    dcol,
  );
  const b = moveCorner(
    { row: range.endRow, col: range.endCol, rowRelative: !!rel.endRow, colRelative: !!rel.endCol },
    drow,
    dcol,
  );
  const rowsSwap = a.row > b.row;
  const colsSwap = a.col > b.col;
  return {
    ...range,
    startRow: Math.min(a.row, b.row),
    endRow: Math.max(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endCol: Math.max(a.col, b.col),
    relative: {
      startRow: rowsSwap ? b.rowRelative : a.rowRelative,
      endRow: rowsSwap ? a.rowRelative : b.rowRelative,
      startCol: colsSwap ? b.colRelative : a.colRelative,
      endCol: colsSwap ? a.colRelative : b.colRelative,
    },
  };
}

/**
 * `validation` as read `drow` rows below and `dcol` columns right of the cell
 * it is written for. Null when a custom formula has no exact answer (a range
 * whose two ends would wrap apart, `moveRuleFormula`).
 */
export async function moveValidationRule(
  validation: DataValidation,
  drow: number,
  dcol: number,
  shift?: FormulaShifter,
): Promise<DataValidation | null> {
  if (drow === 0 && dcol === 0) return validation;
  const rule = validation.rule;
  if ("custom" in rule) {
    const formula = await moveRuleFormula(rule.custom.formula, drow, dcol, shift);
    if (formula === null) return null;
    return { ...validation, rule: { custom: { ...rule.custom, formula } } };
  }
  if ("list" in rule && "range" in rule.list.source) {
    const range = moveListSourceRange(rule.list.source.range, drow, dcol);
    return { ...validation, rule: { list: { ...rule.list, source: { range } } } };
  }
  return validation;
}
