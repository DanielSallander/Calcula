//! FILENAME: app/src/core/lib/editSheetIdentity.ts
// PURPOSE: WHICH sheet an open cell edit belongs to -- decided by the sheet's
//          IDENTITY (its stable id, else its name), never by an index other
//          code can renumber.
// CONTEXT: Review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT (2026-10-23). The tab
//          strip discards a drill-through's temporary sheet in the background
//          once the user leaves it, and that RENUMBERS every sheet after it. An
//          edit opened on the destination just before the discard landed kept
//          `editing.sourceSheetIndex` at the OLD index while Core's sheet
//          context moved to the new one: the in-cell editor vanished (it
//          compared indices), and Enter "switched back" to the old index --
//          writing the value into whichever sheet held that index now, or
//          failing "out of range" and losing it. A delete, a move or a copy
//          does the same, and so does one made by MCP or a script, which never
//          sends the strip's `sheet:reorder`.
//
//          Then review F1-rename-refuses-entry (2026-10-23, round 5): deciding
//          by NAME broke a RENAME of the edited sheet while the edit was open
//          (the formula bar holds the edit, and the strip's rename doors are
//          open to a plain value): the edit looked like it belonged to another
//          sheet, the in-cell editor unmounted, every object overlay blanked,
//          and Enter REFUSED the entry. So the identity is the sheet's STABLE id
//          (`SheetInfo.sheetId`, which neither a renumbering nor a rename
//          changes) whenever both sides carry one; the name only when an id is
//          missing on either side (an older backend, or a context dispatched
//          without one -- the reducer CLEARS the context's id then, so a stale
//          id never misleads); the index only when a name is missing too:
//            - `isEditOnShownSheet`        is the grid showing the edit's sheet?
//                                          (InlineEditor, useEditing, pointModeView)
//            - `rebaseEditOntoShownSheet`  the stored index -- and, by id, the
//                                          stored name -- follow the sheet
//                                          (gridReducer: START_EDITING and every
//                                          sheet-context change)
//            - `findEditSheet` / `isEditSheet`  where is the edit's sheet NOW,
//                                          in a fresh list (useEditing's return
//                                          to it on commit and cancel; the tab
//                                          strip's source-tab marker)
//          Names compare with `sameSheetName` (the backend's ASCII-case-
//          insensitive uniqueness rule); ids compare exactly.
//
//          PURE: no IPC and no grid state -- the reducer imports it.

import { sameSheetName } from "./formulaEditTarget";
import type { EditingCell } from "../types";

/** The part of an edit that says which sheet it belongs to. */
export type EditSheetRef = Pick<EditingCell, "sourceSheetIndex" | "sourceSheetName" | "sourceSheetId">;

/** A sheet as a sheet list names it (`SheetInfo` is one). */
export interface ListedSheet {
  index: number;
  name: string;
  sheetId?: string;
}

/** The sheet the grid shows, as Core's sheet context names it. */
export interface ShownSheet {
  activeSheetIndex: number;
  activeSheetName?: string;
  activeSheetId?: string;
}

function hasText(value: string | undefined | null): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Whether the grid shows the sheet this edit belongs to.
 *
 * By the STABLE id when both the edit and the grid know theirs -- whatever
 * index or name either holds: a renumbering moves the index and a rename the
 * name, never the id. By NAME when an id is missing on either side. By index
 * only when a name is missing too. An edit that names no sheet at all is on
 * whatever sheet is shown (an ordinary edit must never read as point mode).
 */
export function isEditOnShownSheet(editing: EditSheetRef, shown: ShownSheet): boolean {
  if (hasText(editing.sourceSheetId) && hasText(shown.activeSheetId)) {
    return editing.sourceSheetId === shown.activeSheetId;
  }
  if (hasText(editing.sourceSheetName) && hasText(shown.activeSheetName)) {
    return sameSheetName(editing.sourceSheetName, shown.activeSheetName);
  }
  if (typeof editing.sourceSheetIndex === "number") {
    return editing.sourceSheetIndex === shown.activeSheetIndex;
  }
  return true;
}

/** Whether `sheet` (an entry of a sheet list) IS the edit's sheet: by id when both carry one, else by name, else by index. */
export function isEditSheet(editing: EditSheetRef, sheet: ListedSheet): boolean {
  if (hasText(editing.sourceSheetId) && hasText(sheet.sheetId)) return editing.sourceSheetId === sheet.sheetId;
  if (hasText(editing.sourceSheetName)) return sameSheetName(editing.sourceSheetName, sheet.name);
  return typeof editing.sourceSheetIndex === "number" && editing.sourceSheetIndex === sheet.index;
}

/**
 * The edit's sheet in `sheets` -- a FRESH list -- or null when the list has no
 * such sheet. By id a RENAMED sheet is found (a rename is followed); null then
 * means it was DELETED while the edit was open (or, for an edit that carries no
 * id, deleted or renamed). Null is a refusal for whoever asked, never a cue to
 * fall back to the stored index: that index names whichever sheet slid into it.
 */
export function findEditSheet<T extends ListedSheet>(editing: EditSheetRef, sheets: readonly T[]): T | null {
  return sheets.find((sheet) => isEditSheet(editing, sheet)) ?? null;
}

/**
 * The edit, following the shown sheet when the shown sheet IS the edit's sheet;
 * the SAME object when there is nothing to follow (another sheet, or already
 * right).
 *
 *  - BY ID (both carry one): the same id follows BOTH the index (a renumbering)
 *    and the name (a rename); a different id is another sheet, whatever its name.
 *  - BY NAME (an id missing on either side): the index follows; and an edit
 *    that carries no id ADOPTS the shown sheet's (names are unique, so the
 *    sheet shown under the edit's name right now IS its sheet), which lets a
 *    later rename be followed.
 *
 * The reducer applies it to every sheet-context change and to the open itself,
 * so `sourceSheetIndex` / `sourceSheetName` keep naming the edit's sheet for
 * the readers that still take them (the tab strip's indicator, the edit-ended
 * event, a refusal's sentence).
 */
export function rebaseEditOntoShownSheet<T extends EditSheetRef>(
  editing: T,
  index: number,
  name: string,
  sheetId?: string,
): T {
  if (hasText(editing.sourceSheetId) && hasText(sheetId)) {
    if (editing.sourceSheetId !== sheetId) return editing;
    const followIndex = typeof editing.sourceSheetIndex === "number" && editing.sourceSheetIndex !== index;
    const followName = hasText(name) && editing.sourceSheetName !== name;
    if (!followIndex && !followName) return editing;
    return {
      ...editing,
      ...(followIndex ? { sourceSheetIndex: index } : {}),
      ...(followName ? { sourceSheetName: name } : {}),
    };
  }
  if (!hasText(editing.sourceSheetName) || !sameSheetName(editing.sourceSheetName, name)) return editing;
  const followIndex = typeof editing.sourceSheetIndex === "number" && editing.sourceSheetIndex !== index;
  const adoptId = !hasText(editing.sourceSheetId) && hasText(sheetId);
  if (!followIndex && !adoptId) return editing;
  return {
    ...editing,
    ...(followIndex ? { sourceSheetIndex: index } : {}),
    ...(adoptId ? { sourceSheetId: sheetId } : {}),
  };
}
