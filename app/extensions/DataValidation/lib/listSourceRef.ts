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

/** `A1`, `$A$1`, `a1` — with either or both anchors, which carry no meaning here. */
const CELL_REF = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;

/** A column-only (`A`, `$A`) or row-only (`3`, `$3`) half of a full-column ref. */
const COLUMN_ONLY = /^\$?[A-Za-z]{1,3}$/;
const ROW_ONLY = /^\$?[0-9]{1,7}$/;

/** A sheet name Excel writes without quotes. */
const BARE_SHEET_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** Quote a sheet name the way a formula must: `'` doubles inside quotes. */
function quoteSheetName(name: string): string {
  if (BARE_SHEET_NAME.test(name) && !CELL_REF.test(name)) {
    return name;
  }
  return `'${name.replace(/'/g, "''")}'`;
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
  return { sheet: ref.slice(0, bang), rest: ref.slice(bang + 1) };
}

/** One `A1`-style cell reference as 0-based row/col, or null. */
function parseCellRef(part: string): { row: number; col: number } | null {
  const match = CELL_REF.exec(part.trim());
  if (!match) return null;
  const col = letterToColumn(match[1].toUpperCase());
  const row = Number(match[2]) - 1;
  if (row < 0) return null;
  return { row, col };
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
    const wanted = split.sheet.trim().toLowerCase();
    const found = sheetNames.findIndex((n) => n.toLowerCase() === wanted);
    if (found < 0) {
      return fail(`There is no sheet named "${split.sheet.trim()}".`);
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

  const startRow = Math.min(first.row, second.row);
  const endRow = Math.max(first.row, second.row);
  const startCol = Math.min(first.col, second.col);
  const endCol = Math.max(first.col, second.col);

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

  return { kind: "range", range: { sheetIndex, startRow, startCol, endRow, endCol } };
}

/**
 * Render a stored `ListSource` back into the Source box.
 *
 * The sheet prefix is written only for a range on ANOTHER sheet, which is what
 * Excel shows and what keeps the round trip stable. A `sheetIndex` that names no
 * sheet renders as `#REF!` rather than losing the prefix: dropping it would
 * quietly rebind the list to the sheet the dialog happens to be open on, and
 * parse refuses `#REF!` so the rule cannot be saved back in that state.
 */
export function formatListSourceText(
  source: ListSource,
  sheetNames: readonly string[],
  currentSheetIndex: number
): string {
  if ("values" in source) {
    return source.values.join(",");
  }

  const { sheetIndex, startRow, startCol, endRow, endCol } = source.range;
  let prefix = "";
  if (sheetIndex !== undefined && sheetIndex !== currentSheetIndex) {
    const name = sheetNames[sheetIndex];
    prefix = name === undefined ? "#REF!" : `${quoteSheetName(name)}!`;
  }

  const topLeft = `$${columnToLetter(startCol)}$${startRow + 1}`;
  const bottomRight = `$${columnToLetter(endCol)}$${endRow + 1}`;
  return `=${prefix}${topLeft}:${bottomRight}`;
}
