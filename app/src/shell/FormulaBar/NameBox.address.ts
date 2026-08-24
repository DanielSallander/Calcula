//! FILENAME: app/src/shell/FormulaBar/NameBox.address.ts
// PURPOSE: Turn what a user types into the Name Box into a range to select.
// CONTEXT: The Name Box used to understand exactly ONE shape — /^([A-Z]+)(\d+)$/,
//          a single relative cell on the active sheet. Every other form Excel
//          accepts there fell through all three Enter branches (address ->
//          defined name -> create a name) and landed on a SILENT REVERT: the box
//          snapped back to the old address with no navigation, no selection and
//          no message. "A1:A10" is the headline case, but "$A$1", "Sheet1!A1"
//          and "'My Sheet'!A1:B2" failed exactly the same way — the ':' , '$'
//          and '!' also make `isValidName` false, so the create-a-name branch
//          could not catch them either.
// NOTE:    Parsing only. NameBox.tsx owns the navigating and the reporting; this
//          module has no React and no backend reach, which is what makes the
//          table of accepted forms testable one row at a time — hence the Core
//          import for `letterToColumn` rather than the @api barrel, which would
//          drag Tauri into a pure-function test.

import { letterToColumn } from "../../core/types";

/** Excel's grid limits as 0-BASED indices (row 1048576 / column XFD). */
export const MAX_ROW_INDEX = 1048575;
export const MAX_COL_INDEX = 16383;

/** Which selection a parsed entry asks for; mirrors the grid's SelectionType. */
export type NameBoxAddressType = "cells" | "rows" | "columns";

export interface ParsedNameBoxAddress {
  /** The sheet the entry named, or null when it was unqualified. */
  sheetName: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  type: NameBoxAddressType;
  /** True only for an entry that named ONE cell — the merge-aware navigation
   *  case. A range must not be expanded to its top-left cell's merge. */
  isSingleCell: boolean;
}

// A1-style forms. The `$` signs are accepted and DISCARDED: absolute and
// relative name the same block, and the Name Box selects, it does not store a
// reference. Column letters are capped at three and row digits at seven so that
// a defined name like "ABCD1" or "A99999999" is not mistaken for an address —
// the range checks below reject the rest (XFE1, A1048577).
const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
const RANGE_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7}):\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
const COLUMN_SPAN_RE = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/;
const ROW_SPAN_RE = /^\$?(\d{1,7}):\$?(\d{1,7})$/;

/** Characters Excel forbids in a sheet name. The ':' is the load-bearing one:
 *  it makes the unquoted branch refuse a 3D reference ("Sheet1:Sheet3!A1")
 *  instead of hunting for a sheet literally called "Sheet1:Sheet3". */
const ILLEGAL_SHEET_CHARS = /[[\]:*?/\\]/;

interface SheetSplit {
  sheetName: string | null;
  ref: string;
}

/**
 * Peel an optional sheet qualifier off the front. Returns null when the entry
 * LOOKS qualified but is malformed (unterminated quote, empty sheet name, a 3D
 * reference) — null means "tell the user", never "try the next branch".
 */
function splitSheetPrefix(input: string): SheetSplit | null {
  if (input.startsWith("'")) {
    // Quoted form. Inside the quotes, '' is one literal apostrophe, which is how
    // Excel writes a sheet actually named  It's  as 'It''s'!A1.
    let i = 1;
    let name = "";
    while (i < input.length) {
      if (input[i] === "'") {
        if (input[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        break;
      }
      name += input[i];
      i += 1;
    }
    if (input[i] !== "'" || input[i + 1] !== "!" || name === "") return null;
    return { sheetName: name, ref: input.slice(i + 2) };
  }

  const bang = input.indexOf("!");
  if (bang === -1) return { sheetName: null, ref: input };

  const name = input.slice(0, bang);
  if (name === "" || ILLEGAL_SHEET_CHARS.test(name)) return null;
  return { sheetName: name, ref: input.slice(bang + 1) };
}

/** 1-based row text -> 0-based index, or null when off the grid. */
function toRowIndex(text: string): number | null {
  const n = parseInt(text, 10);
  if (n < 1 || n - 1 > MAX_ROW_INDEX) return null;
  return n - 1;
}

/** Column letters -> 0-based index, or null when off the grid. */
function toColIndex(letters: string): number | null {
  const col = letterToColumn(letters.toUpperCase());
  if (col < 0 || col > MAX_COL_INDEX) return null;
  return col;
}

/**
 * Parse a Name Box entry as an address. Returns null when the text is not an
 * address at all (it may still be a defined name, or a name to create) AND when
 * it is a malformed address — the caller distinguishes the two by trying the
 * name lookup next, exactly as Excel does.
 *
 * Accepted: A1, a1, A1:B10, B10:A1 (normalised), $A$1, $A$1:$B$10, A:C (whole
 * columns), 2:5 (whole rows), each optionally qualified with Sheet1! or
 * 'My Sheet'!.
 */
export function parseNameBoxAddress(input: string): ParsedNameBoxAddress | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const split = splitSheetPrefix(trimmed);
  if (!split) return null;

  const ref = split.ref.trim().toUpperCase();
  if (!ref) return null;
  const sheetName = split.sheetName;

  const cell = CELL_RE.exec(ref);
  if (cell) {
    const row = toRowIndex(cell[2]);
    const col = toColIndex(cell[1]);
    if (row === null || col === null) return null;
    return {
      sheetName,
      startRow: row,
      startCol: col,
      endRow: row,
      endCol: col,
      type: "cells",
      isSingleCell: true,
    };
  }

  const range = RANGE_RE.exec(ref);
  if (range) {
    const r1 = toRowIndex(range[2]);
    const c1 = toColIndex(range[1]);
    const r2 = toRowIndex(range[4]);
    const c2 = toColIndex(range[3]);
    if (r1 === null || c1 === null || r2 === null || c2 === null) return null;
    // "B10:A1" names the same block as "A1:B10". The selection model assumes
    // start <= end, so normalise here rather than leaving an inverted selection
    // that paints nothing.
    const startRow = Math.min(r1, r2);
    const endRow = Math.max(r1, r2);
    const startCol = Math.min(c1, c2);
    const endCol = Math.max(c1, c2);
    return {
      sheetName,
      startRow,
      startCol,
      endRow,
      endCol,
      type: "cells",
      isSingleCell: startRow === endRow && startCol === endCol,
    };
  }

  const columns = COLUMN_SPAN_RE.exec(ref);
  if (columns) {
    const c1 = toColIndex(columns[1]);
    const c2 = toColIndex(columns[2]);
    if (c1 === null || c2 === null) return null;
    return {
      sheetName,
      startRow: 0,
      startCol: Math.min(c1, c2),
      endRow: MAX_ROW_INDEX,
      endCol: Math.max(c1, c2),
      type: "columns",
      isSingleCell: false,
    };
  }

  const rows = ROW_SPAN_RE.exec(ref);
  if (rows) {
    const r1 = toRowIndex(rows[1]);
    const r2 = toRowIndex(rows[2]);
    if (r1 === null || r2 === null) return null;
    return {
      sheetName,
      startRow: Math.min(r1, r2),
      startCol: 0,
      endRow: Math.max(r1, r2),
      endCol: MAX_COL_INDEX,
      type: "rows",
      isSingleCell: false,
    };
  }

  return null;
}

/**
 * Does this text denote a cell/range address? A defined name may not — that is
 * the rule the Name Box's create-a-name branch enforces, and the reason this
 * lives next to the parser instead of being a second regex that drifts from it.
 */
export function isAddressLike(text: string): boolean {
  return parseNameBoxAddress(text) !== null;
}
