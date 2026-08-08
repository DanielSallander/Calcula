//! FILENAME: app/src/core/lib/hiddenRowsCols.ts
// PURPOSE: The ONE place the frontend performs a user hide/unhide gesture.
// CONTEXT: Hiding a row/column used to be frontend-only session state — a
//          window CustomEvent into the grid reducer, never persisted, never
//          undoable, and it did not even mark the document dirty, so the hide
//          was silently lost on save/reload. The backend now owns the user
//          hidden sets per sheet (set_rows_hidden / set_cols_hidden), and the
//          reducer's manuallyHiddenRows/Cols is a MIRROR of that authority.
//
//          Every gesture must go through here so it cannot regress into a
//          frontend-only write again:
//            1. call the backend command (the authority; records undo, marks
//               the document dirty, refuses on a protected sheet)
//            2. dispatch the RESULT into the reducer mirror
//            3. announce the dirty state so the window title picks up the "*"
//
//          On a backend refusal the mirror is re-synced from the authority and
//          the refusal is surfaced — the two must never diverge silently.

import { setRowsHidden, setColsHidden, getUserHiddenRows, getUserHiddenCols } from "./tauri-api";
import { setManuallyHiddenRows, setManuallyHiddenCols } from "../state/gridActions";
import type { GridAction } from "../state/gridActions";
import { emitAppEvent, AppEvents } from "./events";
import { alertAsync } from "./dialogs";

/** Minimal dispatch shape — the grid reducer dispatch, or api/gridDispatch. */
export type HiddenDispatch = (action: GridAction) => void;

/**
 * Re-read the authoritative user-hidden sets for the ACTIVE sheet and refresh
 * the reducer mirror. Call this wherever the active sheet or its coordinates
 * can have changed underneath the frontend: sheet switch, file load, structural
 * edit, and any undo/redo that reports hiddenChanged.
 */
export async function refreshUserHidden(dispatch: HiddenDispatch): Promise<void> {
  try {
    const [rows, cols] = await Promise.all([getUserHiddenRows(), getUserHiddenCols()]);
    dispatch(setManuallyHiddenRows(rows));
    dispatch(setManuallyHiddenCols(cols));
  } catch (error) {
    console.error("[hiddenRowsCols] Failed to refresh user-hidden sets:", error);
  }
}

/** Re-sync the mirror after a refused write, then surface the refusal. */
async function resyncAndReport(dispatch: HiddenDispatch, error: unknown): Promise<void> {
  await refreshUserHidden(dispatch);
  void alertAsync(error instanceof Error ? error.message : String(error));
}

/**
 * Hide or unhide ROWS on the active sheet.
 *
 * @param rows   Row indices to act on (the DELTA, not the resulting set).
 * @param hidden true to hide, false to unhide.
 * @returns true when the backend accepted the change.
 */
export async function applyRowsHidden(
  rows: number[],
  hidden: boolean,
  dispatch: HiddenDispatch
): Promise<boolean> {
  if (rows.length === 0) return false;
  try {
    const resulting = await setRowsHidden(rows, hidden);
    dispatch(setManuallyHiddenRows(resulting));
    emitAppEvent(AppEvents.DIRTY_STATE_CHANGED, { isDirty: true });
    return true;
  } catch (error) {
    console.error("[hiddenRowsCols] set_rows_hidden failed:", error);
    await resyncAndReport(dispatch, error);
    return false;
  }
}

/**
 * Hide or unhide COLUMNS on the active sheet. See {@link applyRowsHidden}.
 */
export async function applyColsHidden(
  cols: number[],
  hidden: boolean,
  dispatch: HiddenDispatch
): Promise<boolean> {
  if (cols.length === 0) return false;
  try {
    const resulting = await setColsHidden(cols, hidden);
    dispatch(setManuallyHiddenCols(resulting));
    emitAppEvent(AppEvents.DIRTY_STATE_CHANGED, { isDirty: true });
    return true;
  } catch (error) {
    console.error("[hiddenRowsCols] set_cols_hidden failed:", error);
    await resyncAndReport(dispatch, error);
    return false;
  }
}

/** Inclusive index range as a flat array (used by the range-taking commands). */
export function indexRange(start: number, end: number): number[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}
