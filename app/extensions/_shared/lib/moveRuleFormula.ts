//! FILENAME: app/extensions/_shared/lib/moveRuleFormula.ts
// PURPOSE: Move a rule formula (a conditional format's or a data validation's)
//          from the cell it is written for to another cell, the way Excel
//          moves it: relative parts move, absolute parts stay, and a part
//          moved past the sheet's edge WRAPS round it.
// CONTEXT: Shared by ConditionalFormatting (New Rule and the Highlight Cells
//          doors restate what is typed relative to the ACTIVE cell for the
//          rule's anchor, BUG-0748) and DataValidation (the dialog shows a
//          custom formula for the active cell and stores it for the range's
//          top-left, as Excel's does -- lane cfdvfix). Moved here from
//          ConditionalFormatting/lib/ruleFormulaAnchor.ts, which re-exports it.
//
//          THE SHIFT IS THE BACKEND'S (`shiftFormulasBatch`, the fill shifter):
//          no second copy of the reference grammar lives here. That shifter
//          writes #REF! for a reference moved off the sheet, where a rule's
//          reference wraps (the backend's own rule evaluation wraps too:
//          `shift_relative_refs`, conditional_formatting.rs). A wrapped
//          reference is the same move by the delta plus or minus the sheet's
//          size, so the formula is shifted by every such variant and each
//          reference is taken from the one variant in which it stayed on the
//          sheet; the variants differ ONLY at reference sites, which is what
//          lets them be merged. The answer is checked by moving it back. When
//          no exact answer exists -- one range whose two ends would wrap
//          differently -- the conversion refuses (null) rather than storing a
//          #REF! the user never typed.

import { shiftFormulasBatch } from "@api";

/** Excel's sheet: 1,048,576 rows and 16,384 columns. */
export const SHEET_ROWS = 1048576;
export const SHEET_COLS = 16384;

/** The backend's batch shifter's shape (injectable for tests). */
export type FormulaShifter = (
  inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>,
) => Promise<string[]>;

const defaultShifter: FormulaShifter = (inputs) => shiftFormulasBatch(inputs);

const REF_ERROR = "#REF!";

function countRefErrors(text: string): number {
  return text.toUpperCase().split(REF_ERROR).length - 1;
}

/**
 * One reference as the backend's shifter writes it: a cell or a cell range, a
 * column range or a row range. Only ever matched AT a site the variants
 * disagree about -- it never searches the text.
 */
const SITE_TOKEN = /^(?:\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)/;

/**
 * Merge shifter outputs of ONE formula that differ only at reference sites,
 * where each variant holds either `#REF!` or the reference: the text where they
 * agree, and at each site the reference of the variant that kept it. Null when
 * the variants disagree anywhere else, or at a site no variant kept.
 */
export function mergeShiftVariants(variants: readonly string[]): string | null {
  const pos = variants.map(() => 0);
  let out = "";
  for (;;) {
    const ended = variants.map((v, i) => pos[i] >= v.length);
    if (ended.every(Boolean)) return out;
    if (ended.some(Boolean)) return null;
    const chars = variants.map((v, i) => v[pos[i]]);
    if (chars.every((c) => c === chars[0])) {
      out += chars[0];
      for (let i = 0; i < pos.length; i++) pos[i]++;
      continue;
    }
    let kept: string | null = null;
    const lengths: number[] = [];
    for (let i = 0; i < variants.length; i++) {
      const rest = variants[i].slice(pos[i]);
      if (rest.toUpperCase().startsWith(REF_ERROR)) {
        lengths.push(REF_ERROR.length);
        continue;
      }
      const m = SITE_TOKEN.exec(rest);
      if (!m || (kept !== null && kept !== m[0])) return null;
      kept = m[0];
      lengths.push(m[0].length);
    }
    if (kept === null) return null;
    out += kept;
    for (let i = 0; i < pos.length; i++) pos[i] += lengths[i];
  }
}

/** The delta, and the same move wrapped the other way round the sheet. */
function deltasFor(delta: number, size: number): number[] {
  if (delta === 0) return [0];
  return [delta, delta > 0 ? delta - size : delta + size];
}

/**
 * `formula` as the cell `drow` rows below and `dcol` columns right of the cell
 * it is written for reads it, every relative reference moved and WRAPPED round
 * the sheet's edge (Excel's rule for conditional formats and validations).
 * Absolute parts stay. Null when no exact answer exists (a range whose ends
 * would wrap apart).
 */
export async function moveRuleFormula(
  formula: string,
  drow: number,
  dcol: number,
  shift: FormulaShifter = defaultShifter,
): Promise<string | null> {
  if (drow === 0 && dcol === 0) return formula;
  const rows = deltasFor(drow, SHEET_ROWS);
  const cols = deltasFor(dcol, SHEET_COLS);
  const inputs: Array<{ formula: string; rowDelta: number; colDelta: number }> = [];
  for (const rowDelta of rows) for (const colDelta of cols) inputs.push({ formula, rowDelta, colDelta });
  // The first variant is the plain move; no reference left the sheet when it
  // carries no #REF! the formula did not already have.
  const errors = countRefErrors(formula);
  const variants = await shift(inputs);
  if (variants.length !== inputs.length) return null;
  if (countRefErrors(variants[0]) === errors) return variants[0];

  const merged = mergeShiftVariants(variants);
  if (merged === null || countRefErrors(merged) !== errors) return null;
  // Moved back, the answer must be the formula again (as the shifter writes it
  // unmoved: it normalises an inverted range).
  const backRows = deltasFor(-drow, SHEET_ROWS);
  const backCols = deltasFor(-dcol, SHEET_COLS);
  const back: Array<{ formula: string; rowDelta: number; colDelta: number }> = [{ formula, rowDelta: 0, colDelta: 0 }];
  for (const rowDelta of backRows) for (const colDelta of backCols) back.push({ formula: merged, rowDelta, colDelta });
  const checked = await shift(back);
  if (checked.length !== back.length) return null;
  const [unmoved, ...backVariants] = checked;
  const returned =
    countRefErrors(backVariants[0]) === countRefErrors(merged) ? backVariants[0] : mergeShiftVariants(backVariants);
  return returned === unmoved ? merged : null;
}
