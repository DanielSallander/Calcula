//! FILENAME: app/src/shell/SheetTabs/sheetRangePrefix.ts
// PURPOSE: The 3-D reference prefix a Shift+click on a sheet tab inserts into
//          a formula in point mode: `Sheet1:Sheet3!`, or `'Q1-2026:Q2'!`.
// CONTEXT: W13 (wave C). SheetTabs built it with a display rule of its own
//          (quote only whitespace, ' ! [ ]), so a pair like Q1-2026 / Q2 was
//          written bare -- `Q1-2026:Q2!A1` -- and the formula did not parse.
//          ONE pair of apostrophes wraps the whole `A:B` pair, each half's
//          inner ' doubled: the backend's own rendering (ast_render.rs,
//          Sheet3DRef).

import { quoteSheetNameForFormula } from "../../api/externalEdit";

/**
 * A name the range grammar could read as a cell (`Q1`, `AB12`), a column
 * (`N`) or an R1C1 address. The backend renders a 3-D pair bare only when the
 * bare text PARSES back as the same two sheets (`sheet_range_renders_bare`):
 * `A1:Other!B2` reads as the range A1:OTHER, `N:Q1!B2` as columns. That parse
 * is not available here, so a pair with a reference-shaped half is quoted --
 * the quoted form always reads back.
 */
const REFERENCE_SHAPED = /^(?:[A-Za-z]{1,3}[0-9]*|[Rr][0-9]*[Cc][0-9]*)$/;

function isBare(name: string): boolean {
  return quoteSheetNameForFormula(name) === name && !REFERENCE_SHAPED.test(name);
}

/** The 3-D prefix for the sheets `start` through `end`, `!` included. */
export function sheetRangePrefix(start: string, end: string): string {
  if (isBare(start) && isBare(end)) return `${start}:${end}!`;
  return `'${start.replace(/'/g, "''")}:${end.replace(/'/g, "''")}'!`;
}
