//! FILENAME: app/extensions/DataValidation/lib/listSourceRef.ts
// PURPOSE: The Source box's text <-> ListSource conversion, in pure string and
//          rectangle math (no IPC, no React).
// CONTEXT: The dialog used to store an "="-prefixed Source as a ONE-ELEMENT
//          LITERAL list whose single legal cell value was the string
//          "=$A$1:$A$4" — so the approved-list case, the headline data
//          validation example, could only be built by a script. Worse,
//          populateFromValidation rendered a script-built rectangle as the
//          pseudo-string "=1:0:4:0", and OK saved THAT back as a literal: merely
//          OPENING the dialog on a range-backed dropdown destroyed it, silently.
//          Both directions live here so "parse(format(r)) is r" is a property a
//          test can hold.

import { columnToLetter, letterToColumn, DEFAULT_GRID_CONFIG } from "@api/types";
import type { ListSource } from "@api";
import { quoteSheetNameForFormula } from "@api/externalEdit";
import { indexOfSheetName } from "@api/sheetNames";

/**
 * The rectangle half of `ListSource`, taken FROM the @api union rather than
 * retyped, so a change to the wire shape breaks this file at compile time
 * instead of at the user's dropdown.
 */
export type ListRangeRef = Extract<ListSource, { range: unknown }>["range"];

/** What the Source box's text means once parsed. */
export type ParsedListSource =
  | { kind: "values"; values: string[] }
  | { kind: "range"; range: ListRangeRef }
  | { kind: "error"; message: string };

/**
 * The most cells a range source may cover.
 *
 * The backend resolver walks the source rectangle cell by cell for EVERY cell it
 * validates — `resolve_list_source` is called from inside the per-cell loop of
 * `get_invalid_cells` — so the work is (source cells x validated cells). A
 * whole-column source over a 100-cell validated range would be a hundred million
 * map lookups on one "Circle Invalid Data" click. A refused reference is
 * visible; a frozen window is not.
 */
export const MAX_LIST_SOURCE_CELLS = 10000;

/**
 * `A1`, `$A$1`, `a1` — with either or both anchors. A part without `$` is
 * RELATIVE: Excel reads it moved by each validated cell's offset from the
 * range's top-left (`=F1:F2` on H2:H4 lists F2:F3 at H3; BUG-0745).
 */
const CELL_REF = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/;

/** A column-only (`A`, `$A`) or row-only (`3`, `$3`) half of a full-column ref. */
const COLUMN_ONLY = /^\$?[A-Za-z]{1,3}$/;
const ROW_ONLY = /^\$?[0-9]{1,7}$/;

/**
 * Quote a sheet name the way a formula must, by the formula PARSER's rule
 * (quoteSheetNameForFormula, @api/externalEdit): `'` doubles inside quotes.
 * W13: a rule of its own left TRUE and a trailing-dot name (`Q1.`) bare, and
 * `=TRUE!$A$1:$A$4` is not a reference the parser reads. A reference-SHAPED
 * name (`A1`) is bare for the parser -- the `!` after it makes it a sheet --
 * and `splitSheetPrefix` reads it back either way.
 */
function quoteSheetName(name: string): string {
  return quoteSheetNameForFormula(name);
}

/** Split `Sheet1!A1:B2` / `'My Sheet'!A1` into its name and its reference. */
function splitSheetPrefix(
  ref: string
): { sheet: string | null; rest: string } | { error: string } {
  if (ref.startsWith("'")) {
    let i = 1;
    let name = "";
    while (i < ref.length) {
      if (ref[i] === "'") {
        if (ref[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        break;
      }
      name += ref[i];
      i++;
    }
    if (i >= ref.length || ref[i] !== "'") {
      return { error: "The sheet name is missing its closing quote." };
    }
    if (ref[i + 1] !== "!") {
      return { error: "Put a '!' between the sheet name and the range." };
    }
    return { sheet: name, rest: ref.slice(i + 2) };
  }

  const bang = ref.indexOf("!");
  if (bang < 0) {
    return { sheet: null, rest: ref };
  }
  const name = ref.slice(0, bang);
  // AN UNQUOTED SHEET NAME HOLDS NO SPACE (misc19, round 19). In a formula a
  // space is an operator, so a name with one must be quoted. [LIVE] Excel 16
  // (misc19/probe1.ps1, probe4.ps1) refuses the list source `=Data !A1:A3`
  // whether or not a sheet named `Data ` exists, and takes `='Data '!A1:A3`
  // (and `=Data! A1:A3`, `= Data!A1:A3`, `=data!A1:A3` for `Data`). Looked up as
  // written, the unquoted `Data ` bound the rule to a sheet named `Data `.
  if (/\s/.test(name)) {
    return {
      error: `A sheet name with a space must be in single quotes, like ='${name.replace(/'/g, "''")}'!$A$1:$A$10.`,
    };
  }
  return { sheet: name, rest: ref.slice(bang + 1) };
}

/** One `A1`-style cell reference as 0-based row/col and which parts are relative, or null. */
function parseCellRef(
  part: string
): { row: number; col: number; rowRelative: boolean; colRelative: boolean } | null {
  const match = CELL_REF.exec(part.trim());
  if (!match) return null;
  const col = letterToColumn(match[2].toUpperCase());
  const row = Number(match[4]) - 1;
  if (row < 0) return null;
  return { row, col, colRelative: match[1] === "", rowRelative: match[3] === "" };
}

function fail(message: string): ParsedListSource {
  return { kind: "error", message };
}

/**
 * Read the Source box.
 *
 * Text that does not start with `=` is Excel's inline list ("Yes,No,Maybe").
 * Text that does is a range reference, and it must PARSE: the old code kept an
 * unparseable one as a literal list of one string, which produced a dropdown
 * offering "=$A$1:$A$4" as its only approved value.
 *
 * `currentSheetIndex` is the sheet the rule is being written to; an unqualified
 * reference is stored against it EXPLICITLY rather than left open, so the list
 * cannot rebind itself to whichever sheet happens to be active when the dropdown
 * is opened.
 */
export function parseListSourceText(
  text: string,
  sheetNames: readonly string[],
  currentSheetIndex: number
): ParsedListSource {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return fail("Enter a source: a list like Yes,No,Maybe or a range like =$A$1:$A$10.");
  }

  if (!trimmed.startsWith("=")) {
    const values = trimmed
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (values.length === 0) {
      // An empty value list is not an empty rule: the backend compares against
      // nothing, so EVERY non-blank entry is rejected.
      return fail("Enter at least one list value, separated by commas.");
    }
    return { kind: "values", values };
  }

  const ref = trimmed.slice(1).trim();
  if (ref.length === 0) {
    return fail("Enter a range after the '=', like =$A$1:$A$10.");
  }
  if (/^#REF!/i.test(ref)) {
    return fail("This list pointed at a sheet that no longer exists. Enter a new range, like =$A$1:$A$10.");
  }

  const split = splitSheetPrefix(ref);
  if ("error" in split) {
    return fail(split.error);
  }

  let sheetIndex = currentSheetIndex;
  if (split.sheet !== null) {
    // The name EXACTLY as written: a sheet name keeps its spaces (` Data ` is
    // a sheet of its own beside `Data`), and Excel keeps the list formula as
    // =' Data '!$A$1:$A$1 [LIVE, rev15C/probe2.ps1]. Trimming it here bound
    // the rule to `Data`, or refused it when only ` Data ` existed.
    const found = indexOfSheetName(sheetNames, split.sheet);
    if (found < 0) {
      return fail(`There is no sheet named "${split.sheet}".`);
    }
    sheetIndex = found;
  }

  const parts = split.rest.split(":");
  if (parts.length > 2) {
    return fail(`"${trimmed}" is not a cell range. Use one range, like =$A$1:$A$10.`);
  }
  if (
    parts.length === 2 &&
    ((COLUMN_ONLY.test(parts[0].trim()) && COLUMN_ONLY.test(parts[1].trim())) ||
      (ROW_ONLY.test(parts[0].trim()) && ROW_ONLY.test(parts[1].trim())))
  ) {
    // See MAX_LIST_SOURCE_CELLS: a whole column is walked per validated cell.
    return fail("A whole column or row is too large for a list source. Give the rows too, like =$A$1:$A$100.");
  }

  const first = parseCellRef(parts[0]);
  const second = parts.length === 2 ? parseCellRef(parts[1]) : first;
  if (!first || !second) {
    return fail(`"${trimmed}" is not a cell range. Use a range like =$A$1:$A$10.`);
  }

  // Each line keeps the `$` it was typed with when the corners are put in
  // top-left / bottom-right order.
  const rowsSwap = first.row > second.row;
  const colsSwap = first.col > second.col;
  const startRow = Math.min(first.row, second.row);
  const endRow = Math.max(first.row, second.row);
  const startCol = Math.min(first.col, second.col);
  const endCol = Math.max(first.col, second.col);
  const relative = {
    startRow: rowsSwap ? second.rowRelative : first.rowRelative,
    endRow: rowsSwap ? first.rowRelative : second.rowRelative,
    startCol: colsSwap ? second.colRelative : first.colRelative,
    endCol: colsSwap ? first.colRelative : second.colRelative,
  };
  const anyRelative = relative.startRow || relative.endRow || relative.startCol || relative.endCol;

  if (endRow >= DEFAULT_GRID_CONFIG.totalRows || endCol >= DEFAULT_GRID_CONFIG.totalCols) {
    // An off-grid rectangle resolves to no values at all, which is a dropdown
    // that silently rejects everything.
    return fail(`"${trimmed}" is outside the sheet.`);
  }

  const cells = (endRow - startRow + 1) * (endCol - startCol + 1);
  if (cells > MAX_LIST_SOURCE_CELLS) {
    return fail(
      `That range covers ${cells} cells; a list source is limited to ${MAX_LIST_SOURCE_CELLS}.`
    );
  }

  return {
    kind: "range",
    range: anyRelative
      ? { sheetIndex, startRow, startCol, endRow, endCol, relative }
      : { sheetIndex, startRow, startCol, endRow, endCol },
  };
}

/** One corner of a range source: its cell and which parts are relative. */
interface Corner {
  row: number;
  col: number;
  rowRelative: boolean;
  colRelative: boolean;
}

/** A relative part moved by the offset, WRAPPING round the sheet (Excel's rule). */
function moveCorner(c: Corner, drow: number, dcol: number): Corner {
  const wrap = (v: number, size: number) => ((v % size) + size) % size;
  return {
    ...c,
    row: c.rowRelative ? wrap(c.row + drow, DEFAULT_GRID_CONFIG.totalRows) : c.row,
    col: c.colRelative ? wrap(c.col + dcol, DEFAULT_GRID_CONFIG.totalCols) : c.col,
  };
}

/** The two corners of a range source, as stored (top-left, bottom-right). */
function cornersOf(range: ListRangeRef): [Corner, Corner] {
  const rel = range.relative;
  return [
    { row: range.startRow, col: range.startCol, rowRelative: !!rel?.startRow, colRelative: !!rel?.startCol },
    { row: range.endRow, col: range.endCol, rowRelative: !!rel?.endRow, colRelative: !!rel?.endCol },
  ];
}

/**
 * A range source as the cell `drow` rows below and `dcol` columns right of
 * the cell it is written for reads it: each relative part moved (wrapping at
 * the sheet's edge), the corners put back in order with each line keeping its
 * own `$`. The Data Validation dialog states the Source for the ACTIVE cell
 * and stores it for the range's top-left, as Excel's does (lane cfdvfix,
 * [LIVE] cfdvb/probe1.ps1 C1/C2: `=F1:F2` on H2:H4 reads `=F2:F3` at H3).
 */
export function moveListRange(range: ListRangeRef, drow: number, dcol: number): ListRangeRef {
  if ((drow === 0 && dcol === 0) || !range.relative) return range;
  const [a, b] = cornersOf(range).map((c) => moveCorner(c, drow, dcol));
  const rowsSwap = a.row > b.row;
  const colsSwap = a.col > b.col;
  const relative = {
    startRow: rowsSwap ? b.rowRelative : a.rowRelative,
    endRow: rowsSwap ? a.rowRelative : b.rowRelative,
    startCol: colsSwap ? b.colRelative : a.colRelative,
    endCol: colsSwap ? a.colRelative : b.colRelative,
  };
  return {
    ...range,
    startRow: Math.min(a.row, b.row),
    endRow: Math.max(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endCol: Math.max(a.col, b.col),
    relative,
  };
}

/**
 * Render a stored `ListSource` back into the Source box.
 *
 * The sheet prefix is written only for a range on ANOTHER sheet, which is what
 * Excel shows and what keeps the round trip stable. A `sheetIndex` that names no
 * sheet renders as `#REF!` rather than losing the prefix: dropping it would
 * quietly rebind the list to the sheet the dialog happens to be open on, and
 * parse refuses `#REF!` so the rule cannot be saved back in that state.
 *
 * `offset` states a RELATIVE source for the cell that far from the one it is
 * written for (the dialog's active cell), each corner moved where it lands and
 * NOT re-ordered, as Excel shows it: `=$F1:F$2` written for J2 reads
 * `=$F3:F$2` at J4 ([LIVE] cfdvb/probe1.ps1 C2).
 */
export function formatListSourceText(
  source: ListSource,
  sheetNames: readonly string[],
  currentSheetIndex: number,
  offset: { drow: number; dcol: number } = { drow: 0, dcol: 0 }
): string {
  if ("values" in source) {
    return source.values.join(",");
  }

  const [first, second] = cornersOf(source.range).map((c) => moveCorner(c, offset.drow, offset.dcol));
  const { sheetIndex, relative, sheetGone } = source.range;
  const startRow = first.row;
  const startCol = first.col;
  const endRow = second.row;
  const endCol = second.col;
  let prefix = "";
  if (sheetGone) {
    // The source's sheet was deleted: Excel shows `=#REF!$A$1:$A$3`
    // [LIVE, cfdvb/probe1.ps1 F1], and parse refuses it back.
    prefix = "#REF!";
  } else if (sheetIndex !== undefined && sheetIndex !== currentSheetIndex) {
    const name = sheetNames[sheetIndex];
    prefix = name === undefined ? "#REF!" : `${quoteSheetName(name)}!`;
  }

  const part = (row: number, col: number, rowRelative?: boolean, colRelative?: boolean) =>
    `${colRelative ? "" : "$"}${columnToLetter(col)}${rowRelative ? "" : "$"}${row + 1}`;
  const topLeft = part(startRow, startCol, relative?.startRow, relative?.startCol);
  const bottomRight = part(endRow, endCol, relative?.endRow, relative?.endCol);
  return `=${prefix}${topLeft}:${bottomRight}`;
}
