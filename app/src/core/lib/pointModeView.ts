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
//            - a Core edit whose `sourceSheetIndex` is a NUMBER different from
//              the active sheet. An ordinary edit carries no source index; it
//              must never blank the overlays, hence the typeof guard.

import { getGridStateSnapshot } from "../state/GridContext";
import { isExternalSessionParked, subscribeExternalEdit } from "./formulaEditTarget";

/**
 * True while the grid shows a sheet that is not the sheet the open edit (and
 * therefore every published object region) belongs to.
 */
export function isPointModeOnForeignSheet(): boolean {
  if (isExternalSessionParked()) return true;
  const snapshot = getGridStateSnapshot();
  if (!snapshot) return false;
  const source = snapshot.editing?.sourceSheetIndex;
  return typeof source === "number" && source !== snapshot.sheetContext.activeSheetIndex;
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
