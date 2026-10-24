//! FILENAME: app/src/core/lib/pointModeView.ts
// PURPOSE: What the grid SHOWS during point mode: is it a sheet other than the
//          one the open edit (and every published object region) belongs to?
// CONTEXT: A point-mode sheet switch emits no SHEET_CHANGED, so every object
//          store keeps publishing the EDIT's sheet's regions while the grid
//          shows another sheet. Paint and hit sites then read
//          `getLiveGridRegions()` (@api/gridOverlays), which is empty while
//          this predicate is true, and DOM-hosted overlays (embedded forms,
//          Controls HTML shapes) hide on the edge-triggered signal below.
//
//          Two cases:
//            - a PARKED external session (explicit state in formulaEditTarget,
//              current at notify time), and
//            - a Core edit whose sheet is not the one the grid shows -- decided
//              by the sheet's IDENTITY, its name (core/lib/editSheetIdentity.ts),
//              never by `sourceSheetIndex` alone: a temporary sheet's discard, a
//              delete, a move or a copy renumbers the edit's sheet while it is
//              open, and an index comparison then blanked every overlay on the
//              very sheet the edit belongs to (review
//              TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT). An edit that names no
//              sheet at all must never blank the overlays.

import { getGridStateSnapshot } from "../state/GridContext";
import { isExternalSessionParked, subscribeExternalEdit } from "./formulaEditTarget";
import { isEditOnShownSheet } from "./editSheetIdentity";

/**
 * True while the grid shows a sheet that is not the sheet the open edit (and
 * therefore every published object region) belongs to.
 */
export function isPointModeOnForeignSheet(): boolean {
  if (isExternalSessionParked()) return true;
  const snapshot = getGridStateSnapshot();
  if (!snapshot || !snapshot.editing) return false;
  return !isEditOnShownSheet(snapshot.editing, snapshot.sheetContext);
}

type PointModeViewListener = (foreign: boolean) => void;

const listeners = new Set<PointModeViewListener>();
let lastForeign = false;
let storeUnsubscribe: (() => void) | null = null;

/**
 * Edge-triggered: the listener hears only flips, with the new value. Lazily
 * subscribes to the external-edit store (covers the parked case, whose state
 * is explicit and current at notify time).
 */
export function onPointModeViewChanged(listener: PointModeViewListener): () => void {
  if (listeners.size === 0) lastForeign = isPointModeOnForeignSheet();
  listeners.add(listener);
  if (storeUnsubscribe === null) {
    storeUnsubscribe = subscribeExternalEdit(notifyPointModeViewChanged);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storeUnsubscribe !== null) {
      storeUnsubscribe();
      storeUnsubscribe = null;
    }
  };
}

/**
 * Re-evaluate and fire on a flip. Called by Spreadsheet.tsx AFTER the render
 * that made a Core cross-sheet edit's snapshot current (the snapshot lags a
 * dispatch until render), and by the external-edit store on every change.
 */
export function notifyPointModeViewChanged(): void {
  const now = isPointModeOnForeignSheet();
  if (now === lastForeign) return;
  lastForeign = now;
  for (const listener of [...listeners]) {
    try {
      listener(now);
    } catch (err) {
      console.error("[pointModeView] listener threw:", err);
    }
  }
}
