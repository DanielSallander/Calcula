//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/fakeFillShifter.ts
// PURPOSE: A test double of the backend's fill shifter (`shift_formulas_batch`,
//          commands/structure.rs) for the CF tests that need one.
// CONTEXT: It keeps the backend's PINNED contract (structure.rs tests
//          `a_copy_that_pushes_a_reference_off_the_near_edge_is_ref`,
//          `..._far_edge_is_ref_not_name`,
//          `a_range_with_one_end_off_the_sheet_collapses_whole_and_still_parses`,
//          `a_whole_column_range_follows_a_copy_right`): every relative part of a
//          cell, a cell range, a column range or a row range moves by the delta,
//          `$` parts stay, and a reference (a whole range) moved off the sheet is
//          written `#REF!` in place, the text around it untouched. A site is
//          guarded by a non-identifier character on its left and none of a
//          name's characters (or a call's paren) on its right, as the backend's
//          lead group and `replace_all_guarded` guard it.

const ROWS = 1048576;
const COLS = 16384;

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function colLetters(index: number): string {
  let s = "";
  let c = index;
  for (;;) {
    s = String.fromCharCode(65 + (c % 26)) + s;
    if (c < 26) break;
    c = Math.floor(c / 26) - 1;
  }
  return s;
}

/** A column part moved (its `$` kept), or null off the sheet. */
function moveCol(abs: string, letters: string, d: number): string | null {
  if (abs === "$") return `$${letters}`;
  const i = colIndex(letters) + d;
  return i < 0 || i >= COLS ? null : colLetters(i);
}

/** A row part moved (its `$` kept), or null off the sheet. */
function moveRow(abs: string, digits: string, d: number): string | null {
  if (abs === "$") return `$${digits}`;
  const r = Number(digits) + d;
  return r < 1 || r > ROWS ? null : String(r);
}

const LEAD = String.raw`(^|[^A-Za-z0-9_.\\$])`;
const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?(?![A-Za-z0-9_(])`;
const COLS_RANGE = String.raw`(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])`;
const ROWS_RANGE = String.raw`(\$?)(\d+):(\$?)(\d+)(?![0-9])`;
const SITE = new RegExp(`${LEAD}(?:${CELL}|${COLS_RANGE}|${ROWS_RANGE})`, "g");

/** One formula moved by (`dr`, `dc`), the backend's way. */
export function fakeShift(formula: string, dr: number, dc: number): string {
  // Strings are left alone, as `rewrite_outside_strings` leaves them.
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(SITE, (...m: string[]) => {
            const lead = m[1];
            if (m[3] !== undefined) {
              const c1 = moveCol(m[2], m[3], dc);
              const r1 = moveRow(m[4], m[5], dr);
              if (m[7] === undefined) return c1 === null || r1 === null ? `${lead}#REF!` : `${lead}${c1}${r1}`;
              const c2 = moveCol(m[6], m[7], dc);
              const r2 = moveRow(m[8], m[9], dr);
              if (c1 === null || r1 === null || c2 === null || r2 === null) return `${lead}#REF!`;
              return `${lead}${c1}${r1}:${c2}${r2}`;
            }
            if (m[11] !== undefined) {
              const a = moveCol(m[10], m[11], dc);
              const b = moveCol(m[12], m[13], dc);
              return a === null || b === null ? `${lead}#REF!` : `${lead}${a}:${b}`;
            }
            const a = moveRow(m[14], m[15], dr);
            const b = moveRow(m[16], m[17], dr);
            return a === null || b === null ? `${lead}#REF!` : `${lead}${a}:${b}`;
          }),
    )
    .join("");
}

/** The batch command's shape. */
export async function fakeShiftBatch(inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>): Promise<string[]> {
  return inputs.map((i) => fakeShift(i.formula, i.rowDelta, i.colDelta));
}
