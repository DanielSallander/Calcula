// FILENAME: app/extensions/Collaboration/lib/listedSheets.ts
// PURPOSE: Keep the Publish dialog's sheet selection inside the checkbox list,
//          and say it by STABLE ID.
// CONTEXT: The backend lists only USER sheets as checkboxes, but its
//          `defaultSheetIndices` used to be seeded into the selection verbatim.
//          An index the list does not show (a floating range's hidden backing
//          sheet) then had no checkbox to untick it, rode every push, and was
//          counted as "selected" -- so unticking the canvas that hosts the
//          floating range still published the range's cells as an orphan. The
//          backend now admits an object sheet only through its host; this is
//          the dialog's half of the same rule.
//
//          BY ID, NOT BY POSITION (review round 9). The push dialog is
//          non-modal and read its list in an earlier command, so a tick kept as
//          a workbook POSITION went to whichever sheet held that position when
//          the push ran: drag the private sheet in front of the report and the
//          push shipped the private one under the author's key, and "Try again"
//          after a refusal resent the same stale positions. A tick is now its
//          row's stable id, the wire carries the ids (`sheetIds`), and Rust
//          resolves them against the sheet list as it stands at the push --
//          refusing, by name, an id that is gone (`CALP_PUSH_SHEET_GONE`).
//
//          A row the backend listed WITHOUT an id is the one exception: only
//          its position can name it, and then the whole selection travels as
//          positions. Ids take precedence on the wire, so a partial id list
//          would publish fewer sheets than were ticked, in silence; positions
//          let the backend refuse the id-less sheet by name instead.

import type { PublishSheetSelection } from "@api/collaboration";

/**
 * The subset of `indices` that the checkbox list shows, in ascending order.
 * With no list yet (`sheets` undefined) nothing can be checked against, so the
 * indices pass through unchanged.
 */
export function listedIndices(
  indices: Iterable<number>,
  sheets: readonly { index: number }[] | undefined,
): number[] {
  const all = Array.from(indices);
  if (!sheets) return all.sort((a, b) => a - b);
  const shown = new Set(sheets.map((s) => s.index));
  return all.filter((i) => shown.has(i)).sort((a, b) => a - b);
}

/**
 * One row of a sheet list: its TRUE workbook index in the answer that listed
 * it, and its stable id ("" when the sheet has none).
 */
export interface ListedSheet {
  index: number;
  sheetId: string;
}

/**
 * A row's key in a tick list: its stable id, so a tick follows its sheet
 * through every move, copy and delete -- or, for a row with no id, its
 * position, the only name it has.
 */
export function sheetKey(sheet: ListedSheet): string {
  return sheet.sheetId ? sheet.sheetId : `#${sheet.index}`;
}

/**
 * The rows of `sheets` that `keys` tick, in list order. A key with no row in
 * the list -- a sheet deleted since it was ticked -- ticks nothing.
 */
export function tickedSheets<T extends ListedSheet>(keys: ReadonlySet<string>, sheets: readonly T[]): T[] {
  return sheets.filter((s) => keys.has(sheetKey(s)));
}

/**
 * The keys of the rows at `indices`: positions read against the list FROM THE
 * SAME ANSWER (`defaultSheetIndices` beside its own `sheets`), never against an
 * older list. A position the list does not show has no key, as in
 * {@link listedIndices}.
 */
export function keysAt(indices: Iterable<number>, sheets: readonly ListedSheet[]): string[] {
  const wanted = new Set(indices);
  return sheets.filter((s) => wanted.has(s.index)).map(sheetKey);
}

/**
 * Chosen rows the way the publish doors read them: their positions, and --
 * when EVERY row has one -- their stable ids, which the backend takes in
 * preference to the positions. No rows is `{ sheetIndices: [], sheetIds: [] }`,
 * which means exactly what an empty `sheetIndices` means.
 */
export function selectionWire(sheets: readonly ListedSheet[]): PublishSheetSelection {
  const sheetIndices = sheets.map((s) => s.index);
  if (sheets.some((s) => !s.sheetId)) return { sheetIndices };
  return { sheetIndices, sheetIds: sheets.map((s) => s.sheetId) };
}
