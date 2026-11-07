//! FILENAME: app/extensions/ConditionalFormatting/lib/ruleFormulaAnchor.ts
// PURPOSE: Turn a rule formula TYPED in New Rule (or a Highlight Cells Rules
//          dialog) into the form the rule stores: written for the rule's
//          ANCHOR, the top-left of the rectangle bounding its ranges.
// CONTEXT: BUG-0748 (dialog part). Excel reads what the user types there
//          RELATIVE TO THE ACTIVE CELL and stores it relative to the anchor
//          [LIVE, Excel 16, 2026-11-06, lane uiforms probe4: A2:E10 selected
//          with B5 active, New Rule "=$C5>100" is stored as =$C2>100;
//          "=A4<>B5" as =XFD1<>A2 -- a reference moved past the sheet's edge
//          WRAPS round it; Greater Than "=$C5" is stored as =$C2]. The dialogs
//          sent the text as typed, so the same entry tested C5 from A2, C8 from
//          B5 -- every cell three rows too low.
//
//          What Excel SHOWS is the stored text, never a form re-stated for the
//          active cell: the Rules Manager lists "Formula: =$C2>100" and Edit
//          Rule shows =$C2>100 with B5 active, and an Edit Rule entry is stored
//          as typed (probe2/probe3/probe4 F4). So only the NEW-rule doors
//          convert; the Rules Manager's description is the stored text.
//
//          The move itself (wrapping at the sheet edge, by the backend's fill
//          shifter) lives in _shared/lib/moveRuleFormula.ts, which the Data
//          Validation dialog uses too; it is re-exported here.

import type { ConditionalFormatRange, ConditionalFormatRule } from "@api";
import { moveRuleFormula, type FormulaShifter } from "../../_shared/lib/moveRuleFormula";

export {
  SHEET_ROWS,
  SHEET_COLS,
  mergeShiftVariants,
  moveRuleFormula,
  type FormulaShifter,
} from "../../_shared/lib/moveRuleFormula";

/** A cell, 0-based. */
export interface CellPos {
  row: number;
  col: number;
}

/**
 * The cell a rule's formulas are written for: the top-left of the rectangle
 * bounding every range (the backend's `rule_anchor`, conditional_formatting.rs
 * -- [LIVE] cfeval probe3 for several ranges). Null for a rule with no range.
 */
export function ruleAnchorOf(ranges: readonly ConditionalFormatRange[]): CellPos | null {
  if (ranges.length === 0) return null;
  let row = Infinity;
  let col = Infinity;
  for (const r of ranges) {
    row = Math.min(row, r.startRow, r.endRow);
    col = Math.min(col, r.startCol, r.endCol);
  }
  return { row, col };
}

/** A cell-value operand is a formula when it starts with "=" (else a value). */
function isFormulaOperand(text: string | undefined): text is string {
  return typeof text === "string" && text.trimStart().startsWith("=");
}

/**
 * A rule as the user typed it in a New Rule door -- relative to `active` --
 * restated for the rule's anchor (`ruleAnchorOf(ranges)`): the expression's
 * formula and a cell-value rule's formula operands. Every other rule kind, and
 * an entry typed at the anchor itself, comes back unchanged. Resolves null when
 * a formula cannot be restated exactly (see `moveRuleFormula`).
 */
export async function ruleForAnchor(
  rule: ConditionalFormatRule,
  ranges: readonly ConditionalFormatRange[],
  active: CellPos | null | undefined,
  shift?: FormulaShifter,
): Promise<ConditionalFormatRule | null> {
  const anchor = ruleAnchorOf(ranges);
  if (!active || !anchor || (active.row === anchor.row && active.col === anchor.col)) return rule;
  const drow = anchor.row - active.row;
  const dcol = anchor.col - active.col;
  const move = (text: string) => moveRuleFormula(text, drow, dcol, shift);
  if (rule.type === "expression") {
    const formula = await move(rule.formula);
    return formula === null ? null : { ...rule, formula };
  }
  if (rule.type === "cellValue") {
    const value1 = isFormulaOperand(rule.value1) ? await move(rule.value1) : rule.value1;
    const value2 = isFormulaOperand(rule.value2) ? await move(rule.value2) : rule.value2;
    if (value1 === null || value2 === null) return null;
    return { ...rule, value1, ...(value2 !== undefined ? { value2 } : {}) };
  }
  return rule;
}

/** What a door says when an entry cannot be restated for the rule's first cell. */
export const UNMOVABLE_FORMULA_REFUSAL =
  "the formula refers to a range that would wrap around the edge of the sheet from the rule's first cell. " +
  "Select the range starting from its top-left cell, or change the reference, and try again.";
