//! FILENAME: app/src/core/state/sheetRenumbering.ts
// PURPOSE: THE rule for where a sheet's TRUE index goes when the sheet list is
//          renumbered, as Core's `sheet:reorder { fromIndex, toIndex }` tells
//          it. Pure; shared by everything Core keeps BY SHEET INDEX -- the
//          per-sheet view memory (selection + scroll, Spreadsheet.tsx through
//          components/Spreadsheet/sheetSwitchListeners.ts) and the sheet group
//          (core/state/sheetGrouping.ts).
// CONTEXT: `sheet:reorder` is a ROTATE (`move_sheet`: remove at `fromIndex`,
//          insert at `toIndex`). An INSERTION and a REMOVAL are told through
//          the same event with an index beyond every sheet
//          (shell/SheetTabs/sheetPlacement.ts, @api/sheetSwitch):
//            - insertion at `at`  = a rotate FROM beyond every sheet TO `at`;
//            - removal at `at`    = a rotate FROM `at` TO beyond every sheet.
//          Read as a plain rotate, the removal PARKED the deleted sheet's view
//          at the far index, and the next insertion -- a rotate FROM that same
//          far index -- handed it to the new sheet, which then opened at the
//          deleted sheet's selection and scroll (review rev3C#5). Here a
//          removal DROPS the removed index and an insertion leaves the new
//          index EMPTY: nothing ever moves from, or to, beyond every sheet.

/** Beyond every sheet a workbook can hold: the far end of an insertion or a removal. */
export const BEYOND_EVERY_SHEET = Number.MAX_SAFE_INTEGER;

/** Whether `index` names no real sheet: the far end of an insertion or a removal. */
export function isBeyondEverySheet(index: number): boolean {
  return !Number.isSafeInteger(index) || index >= BEYOND_EVERY_SHEET;
}

/**
 * Where the sheet at TRUE index `index` stands after `sheet:reorder
 * { fromIndex, toIndex }` -- or `null` when it is gone (the removed sheet) or
 * was never a real sheet (a key parked beyond every sheet by an older reading
 * of a removal, dropped on sight).
 */
export function renumberedSheetIndex(index: number, fromIndex: number, toIndex: number): number | null {
  if (isBeyondEverySheet(index)) return null;
  const inserting = isBeyondEverySheet(fromIndex);
  const removing = isBeyondEverySheet(toIndex);
  if (inserting && removing) return index;
  if (removing) {
    if (index === fromIndex) return null;
    return index > fromIndex ? index - 1 : index;
  }
  if (inserting) {
    // The new sheet's own index is left EMPTY: whatever stood there moved up.
    return index >= toIndex ? index + 1 : index;
  }
  if (index === fromIndex) return toIndex;
  if (fromIndex < toIndex) {
    // Moved right: indices in (from, to] shift left by one.
    return index > fromIndex && index <= toIndex ? index - 1 : index;
  }
  // Moved left: indices in [to, from) shift right by one.
  return index >= toIndex && index < fromIndex ? index + 1 : index;
}
