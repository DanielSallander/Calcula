//! FILENAME: app/src/core/state/sheetGrouping.ts
// PURPOSE: Global state for multi-sheet selection (sheet grouping).
// CONTEXT: When the user Ctrl+clicks sheet tabs, multiple sheets become "grouped".
// Any editing or formatting action on the active sheet is replicated to all grouped sheets.
// Uses module-level variables for synchronous access (same pattern as globalIsEditing).
//
// ONE OWNER (review revG#4, BUG-0350). The tab strip used to keep its own copy
// of the group in React state, so the highlight and this state could disagree
// the moment anything but a tab click changed the group. Every change now
// happens here and is announced (`subscribeToSheetGrouping`); the strip
// renders from it. The group is keyed by TRUE sheet index, so it follows every
// renumbering (`renumberSheetGroup`), and an ordinary switch to a sheet
// outside it ends it (`endSheetGroupUnlessMember`) -- both called from Core's
// sheet-switch listeners (components/Spreadsheet/sheetSwitchListeners.ts). A
// DOCUMENT REPLACEMENT (File > New / Open, a checkout) ends it too
// (`clearSheetGrouping`, from core/lib/file-api.ts): the group named the old
// document's sheets, and the new one opens on index 0, usually a member, so a
// stale group kept replicating typing and formats onto the new workbook's
// sheets off screen (review rev5C#2).

import { renumberedSheetIndex } from "./sheetRenumbering";

/**
 * The set of currently selected (grouped) sheet indices.
 * Always includes the active sheet index when grouping is active.
 * When empty or containing only one sheet, grouping is inactive.
 */
let selectedSheetIndices: number[] = [];

/** Who is told when the group changes (the tab strip's highlight). */
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of [...listeners]) listener();
}

function sameIndices(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Replace the group and tell the listeners, when it actually changed. */
function replaceGroup(next: number[]): void {
  if (sameIndices(next, selectedSheetIndices)) return;
  selectedSheetIndices = next;
  announce();
}

/**
 * Be told whenever the group changes. Returns the unsubscribe. The snapshot to
 * read is `getSelectedSheetIndices`, which keeps its identity until the group
 * changes (a `useSyncExternalStore` pair).
 */
export function subscribeToSheetGrouping(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Get the currently selected (grouped) sheet indices.
 * Returns an empty array when no multi-selection is active.
 */
export function getSelectedSheetIndices(): number[] {
  return selectedSheetIndices;
}

/**
 * Set the selected (grouped) sheet indices.
 * Pass an empty array or single-element array to clear grouping.
 */
export function setSelectedSheetIndices(indices: number[]): void {
  replaceGroup([...indices].sort((a, b) => a - b));
}

/**
 * Check if sheet grouping is active (more than one sheet selected).
 */
export function isSheetGroupingActive(): boolean {
  return selectedSheetIndices.length > 1;
}

/**
 * THE group a gesture on the sheet on screen reaches, that sheet INCLUDED (in
 * ascending order) -- or NONE: when no sheets are grouped, when the sheet on
 * screen is not known (nothing tells it from the others, so nothing is
 * replicated), or when it is NOT one of the group (review G#4).
 *
 * WHY THE LAST ONE. Excel keeps the active sheet one of the selected sheets: a
 * switch that is not a tab click -- the Name Box, Go To, a link, the command
 * line, a script -- ENDS the group when it lands outside it [LIVE, Excel 16:
 * Sheet1+Sheet3 grouped, Application.Goto Sheet2!A1 or Sheet2.Activate -> one
 * selected sheet; a ribbon Bold there (ExecuteMso "Bold") bolds Sheet2!A1
 * ONLY; Goto Sheet3!B2, a member, keeps the group]. Core ends it on such a
 * switch (`endSheetGroupUnlessMember`, on `sheet:normalSwitch`); this check
 * stays as the guard for any moment the two disagree -- a gesture on a sheet
 * outside the group must never reach the group's sheets off screen. Every
 * reader of the group asks HERE: the formatting wrappers' `groupArgs`
 * (core/lib/tauri-api.ts), and the typed entry through `getGroupedSheetIndices`
 * below.
 */
export function getGroupForActiveSheet(activeSheetIndex: number | null | undefined): number[] {
  if (!isSheetGroupingActive()) return [];
  if (activeSheetIndex === null || activeSheetIndex === undefined) return [];
  if (!selectedSheetIndices.includes(activeSheetIndex)) return [];
  return [...selectedSheetIndices];
}

/**
 * Get the non-active grouped sheet indices (for replication): the group of
 * `getGroupForActiveSheet` without the active sheet -- NONE when the active
 * sheet is not one of the group (review G#4).
 */
export function getGroupedSheetIndices(activeSheetIndex: number): number[] {
  return getGroupForActiveSheet(activeSheetIndex).filter(i => i !== activeSheetIndex);
}

/**
 * Clear sheet grouping (deselect all except active).
 */
export function clearSheetGrouping(): void {
  replaceGroup([]);
}

/**
 * An ORDINARY switch landed on sheet `activeSheetIndex` (`sheet:normalSwitch`):
 * end the group when that sheet is not one of it, as Excel does (see
 * `getGroupForActiveSheet`). A switch to a member keeps it. Formula point mode
 * never calls this -- its visits fire `sheet:formulaModeSwitch` -- so a group
 * survives picking a reference on another sheet.
 */
export function endSheetGroupUnlessMember(activeSheetIndex: number): void {
  if (!isSheetGroupingActive()) return;
  if (selectedSheetIndices.includes(activeSheetIndex)) return;
  replaceGroup([]);
}

/**
 * `sheet:reorder { fromIndex, toIndex }`: the sheets were renumbered, so the
 * group follows its sheets (core/state/sheetRenumbering.ts). A deleted member
 * leaves the group; a group left with one sheet is no group.
 */
export function renumberSheetGroup(fromIndex: number, toIndex: number): void {
  if (selectedSheetIndices.length === 0) return;
  const next: number[] = [];
  for (const index of selectedSheetIndices) {
    const moved = renumberedSheetIndex(index, fromIndex, toIndex);
    if (moved !== null) next.push(moved);
  }
  next.sort((a, b) => a - b);
  replaceGroup(next.length > 1 ? next : []);
}

/**
 * Toggle a sheet in the selection.
 * If already selected, removes it. If not, adds it.
 * Always ensures the active sheet remains in the selection.
 */
export function toggleSheetInGroup(
  sheetIndex: number,
  activeSheetIndex: number
): number[] {
  const idx = selectedSheetIndices.indexOf(sheetIndex);
  if (idx >= 0) {
    // Don't allow removing the active sheet
    if (sheetIndex === activeSheetIndex) {
      return selectedSheetIndices;
    }
    replaceGroup(selectedSheetIndices.filter(i => i !== sheetIndex));
  } else {
    // If grouping wasn't active, start it with both active and clicked sheet
    if (selectedSheetIndices.length <= 1) {
      replaceGroup([activeSheetIndex, sheetIndex].sort((a, b) => a - b));
    } else {
      replaceGroup([...selectedSheetIndices, sheetIndex].sort((a, b) => a - b));
    }
  }
  return selectedSheetIndices;
}
