//! FILENAME: app/extensions/ControlsPane/lib/dropdownCellRangeSource.ts
// PURPOSE: Read a pane dropdown's cell-range source ("Sheet!A1:A5") into its
//          list items -- from the sheet the source NAMES, or from nothing.
// CONTEXT: X13 (wave D). An unknown sheet prefix, and a source the backend
//          rewrote to `#REF!` when its sheet was deleted (W10), used to fall
//          back to the ACTIVE sheet: the dropdown listed whatever the active
//          sheet held in those cells -- a list that looks right and is not.
//          A quoted name with a doubled apostrophe ('Bob''s') was never
//          unescaped, and a quoted name holding a "!" was handed whole to
//          CellRange (which splits at the FIRST "!"), so both matched no sheet
//          and took the same fall-back or threw.
//
//          The rules:
//            - no prefix ("A1:A5"): the ACTIVE sheet, as the pane always did;
//            - a prefix: the sheet of that name (case-insensitive, quotes and
//              '' escapes understood), and ONLY that sheet -- a name no sheet
//              answers to lists nothing;
//            - `#REF!` anywhere: nothing (the source's sheet is gone);
//            - a prefix that names a FLOATING RANGE (they share the sheet
//              namespace -- =Float1!A1 is a formula like any other): that
//              range's cells, read by its id. `getSheets()` never lists a
//              floating range's backing sheet, so such a source listed
//              nothing (found live 2026-09-29, e2e fixall-calp W7).

import { CellRange, getFloatingRangeCells, getSheets, listFloatingRanges } from "@api";

/** Cap cell-range reads so a whole-column reference stays cheap. */
const MAX_RANGE_CELLS = 1000;

/** The part of a sheet the loader needs to resolve a prefix. */
export interface SourceSheet {
  index: number;
  name: string;
}

/** Where a source's cells are: `sheetIndex` undefined = the active sheet. */
export interface CellRangeSourceTarget {
  sheetIndex: number | undefined;
  /** The range part alone ("A1:A5"), never the prefix. */
  address: string;
}

/**
 * Split a source into its sheet name (unquoted, '' unescaped; null when there
 * is no prefix) and its range part. The LAST "!" separates them, so a quoted
 * name may itself hold a "!".
 */
export function splitCellRangeSource(reference: string): { sheetName: string | null; address: string } {
  const trimmed = reference.trim();
  const bang = trimmed.lastIndexOf("!");
  if (bang === -1) return { sheetName: null, address: trimmed };
  let name = trimmed.substring(0, bang).trim();
  if (name.length >= 2 && name.startsWith("'") && name.endsWith("'")) {
    name = name.substring(1, name.length - 1).replace(/''/g, "'");
  }
  return { sheetName: name, address: trimmed.substring(bang + 1).trim() };
}

/** Whether a source names a sheet at all (a prefix to resolve). */
export function cellRangeSourceNamesASheet(reference: string): boolean {
  return reference.includes("!");
}

/**
 * Where a source's cells are, or null when there is nothing to read: a
 * `#REF!` source, an empty one, or a prefix no sheet answers to.
 */
export function resolveCellRangeSource(
  reference: string,
  sheets: readonly SourceSheet[],
): CellRangeSourceTarget | null {
  if (/#REF!/i.test(reference)) return null;
  const { sheetName, address } = splitCellRangeSource(reference);
  if (address === "") return null;
  if (sheetName === null) return { sheetIndex: undefined, address };
  if (sheetName === "") return null;
  const wanted = sheetName.toLowerCase();
  const match = sheets.find((s) => s.name.toLowerCase() === wanted);
  return match ? { sheetIndex: match.index, address } : null;
}

/** The part of a floating range the loader needs to resolve a prefix. */
export interface SourceFloatingRange {
  id: string;
  name: string;
}

/**
 * The floating range a source's prefix names (case-insensitive, quotes and
 * '' escapes understood), with the range part -- or null when the source has
 * no prefix, or its prefix names no floating range.
 */
export function resolveFloatingRangeSource(
  reference: string,
  ranges: readonly SourceFloatingRange[],
): { id: string; address: string } | null {
  if (/#REF!/i.test(reference)) return null;
  const { sheetName, address } = splitCellRangeSource(reference);
  if (sheetName === null || sheetName === "" || address === "") return null;
  const wanted = sheetName.toLowerCase();
  const match = ranges.find((r) => r.name.toLowerCase() === wanted);
  return match ? { id: match.id, address } : null;
}

/** Items from a floating range's cells, in range order, empties skipped. */
async function loadFloatingRangeItems(id: string, address: string): Promise<string[]> {
  let range = CellRange.fromAddress(address);
  if (range.cellCount > MAX_RANGE_CELLS) {
    const rows = Math.max(1, Math.floor(MAX_RANGE_CELLS / range.colCount));
    range = range.resize(rows, range.colCount);
  }
  const cells = await getFloatingRangeCells(id, range.startRow, range.startCol, range.endRow, range.endCol);
  const byCell = new Map(cells.map((c) => [`${c.row},${c.col}`, c.display]));
  const items: string[] = [];
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      const display = byCell.get(`${r},${c}`) ?? "";
      if (display !== "") items.push(display);
    }
  }
  return items;
}

/**
 * Read a cell-range source's items: display strings in range order
 * (row-major), empties skipped, from the sheet `resolveCellRangeSource`
 * names -- an empty list when it names none. An unparseable range throws (the
 * card shows an empty list for that too).
 */
export async function loadCellRangeItems(reference: string): Promise<string[]> {
  const sheets = cellRangeSourceNamesASheet(reference) ? (await getSheets()).sheets : [];
  const target = resolveCellRangeSource(reference, sheets);
  if (target === null) {
    // A prefix no SHEET answers to may name a floating range.
    if (!cellRangeSourceNamesASheet(reference)) return [];
    const floating = resolveFloatingRangeSource(reference, await listFloatingRanges());
    return floating ? loadFloatingRangeItems(floating.id, floating.address) : [];
  }

  let range = CellRange.fromAddress(target.address, target.sheetIndex);
  if (range.cellCount > MAX_RANGE_CELLS) {
    const rows = Math.max(1, Math.floor(MAX_RANGE_CELLS / range.colCount));
    range = range.resize(rows, range.colCount);
  }

  const values = await range.getValues();
  const items: string[] = [];
  for (let r = range.startRow; r <= range.endRow; r++) {
    for (let c = range.startCol; c <= range.endCol; c++) {
      const display = values.get(`${r},${c}`)?.display ?? "";
      if (display !== "") items.push(display);
    }
  }
  return items;
}
