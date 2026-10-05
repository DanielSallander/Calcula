//! FILENAME: app/src/shell/SheetTabs/sheetPlacement.ts
// PURPOSE: Where a sheet must be ROTATED to so it lands where the user asked:
//          immediately before another sheet (Excel's Insert Sheet, Move or
//          Copy's "Before sheet"), or at the end ("(move to end)"). Pure.
// CONTEXT: The backend places sheets three ways only -- `add_sheet` appends
//          (at the end of the user prefix), `copy_sheet` inserts right after
//          its source, and `move_sheet` ROTATES one sheet (`rotate_element`:
//          remove at `from`, insert at `to`; the active sheet follows its
//          sheet). Every placement the Home tab offers is one of the first two
//          followed by a rotate, and the rotate target is where the off-by-one
//          lives: "before C" is `C - 1` when the sheet moves RIGHT (removing it
//          first shifts C left) and `C` when it moves left.
//
//          The anchor is followed by IDENTITY, never by index: an add or a copy
//          renumbers the sheets after it, and an add can even land BEFORE the
//          anchor (a floating range's object sheet in the tail makes the user
//          prefix end early -- `append_user_sheet`). An index taken before the
//          add names a different sheet after it, silently.

/** A sheet as `getSheets()` lists it: the TRUE workbook index, plus identity. */
export interface PlacedSheet {
  index: number;
  name: string;
  /** Stable uuid; absent only against an older backend. */
  sheetId?: string;
  visibility?: string;
}

/**
 * The same sheet in another listing of the workbook: by its stable id when
 * both sides carry one (a sheet deleted and re-created under the same name is
 * NOT the same sheet), else by name -- unique within a workbook, ignoring case
 * in the backend's rule, so an exact match is the conservative reading.
 */
export function findSameSheet<T extends PlacedSheet>(
  list: readonly T[],
  sheet: PlacedSheet,
): T | undefined {
  if (sheet.sheetId) {
    const byId = list.find((s) => s.sheetId === sheet.sheetId);
    if (byId) return byId;
    // Both sides identified and no match: the sheet is gone. A name match here
    // would be a DIFFERENT sheet wearing the same name.
    if (list.some((s) => s.sheetId)) return undefined;
  }
  return list.find((s) => s.name === sheet.name);
}

/**
 * The `move_sheet` target that leaves the sheet at `from` immediately before
 * the sheet at `before` (both TRUE indices in the same listing). Moving before
 * itself is the identity.
 */
export function moveTargetBefore(from: number, before: number): number {
  return before > from ? before - 1 : before;
}

/** The last sheet's TRUE index (hidden sheets included), -1 for none. */
export function lastSheetIndex(list: readonly PlacedSheet[]): number {
  return list.reduce((max, s) => Math.max(max, s.index), -1);
}

/**
 * The `move_sheet` target for the sheet now at `from`: immediately before
 * `anchor` (re-found by identity in `list`, the listing the backend returned
 * LAST), or the end when `anchor` is null. An anchor that is no longer listed
 * moves nothing.
 */
export function moveTargetFor(
  from: number,
  anchor: PlacedSheet | null,
  list: readonly PlacedSheet[],
): number {
  if (anchor === null) {
    const last = lastSheetIndex(list);
    return last < 0 ? from : last;
  }
  const now = findSameSheet(list, anchor);
  return now ? moveTargetBefore(from, now.index) : from;
}

// ============================================================================
// Telling Core's per-sheet view cache
// ============================================================================
//
// Core remembers each sheet's selection and scroll by TRUE index and re-keys
// that cache on `sheet:reorder { fromIndex, toIndex }` with rotate semantics
// (Spreadsheet.tsx, `handleSheetReorder`). An INSERTION or a REMOVAL is a
// rotate to or from "beyond every sheet", so both are told through the same
// event with a far index:
//   - insertion at `at` == a rotate from the far end to `at`: every key at or
//     past `at` moves up one;
//   - removal at `at` == a rotate from `at` to the far end: every key past
//     `at` moves down one, and the removed sheet's view is parked where no
//     sheet will ever be.
// Untold, a copy or a delete left every later sheet restoring its NEIGHBOUR's
// selection and scroll on its next visit.

/** Beyond every sheet a workbook can hold. */
const FAR_INDEX = Number.MAX_SAFE_INTEGER;

/** The `sheet:reorder` detail announcing a sheet inserted at `at`. */
export function insertionReorderDetail(at: number): { fromIndex: number; toIndex: number } {
  return { fromIndex: FAR_INDEX, toIndex: at };
}

/** The `sheet:reorder` detail announcing the sheet at `at` removed. */
export function removalReorderDetail(at: number): { fromIndex: number; toIndex: number } {
  return { fromIndex: at, toIndex: FAR_INDEX };
}
