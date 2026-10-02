//! FILENAME: app/extensions/Pivot/lib/pivotCellChrome.ts
// PURPOSE: A WORKSHEET pivot's in-cell chrome -- the +/- buttons, the report
//          filter combos, the Row/Column Labels filter buttons and the loading
//          indicator's Cancel -- as PAINTED (the bounds each overlay render
//          records), and the ONE cell click interceptor that answers a press on
//          it with a RELEASE CLAIM (@api/cellClickInterceptors), so the chrome
//          acts only when the press is released over the same piece of chrome
//          and sliding off cancels (BUG-0258 design phase 4, "Buttons and pivot
//          +/- act on release instead of on press"; the canvas pivot box has the
//          same rule since M7, pivotChromePress.ts).
// CONTEXT: The worksheet chrome used to act at the PRESS, from four cell click
//          interceptors in Pivot/index.ts. Core now holds the claimed press
//          (core/lib/cellPressRelease.ts): it asks this module's `targetAt` at
//          every move and at the release, against the bounds as painted THEN,
//          and runs the action once over the same chrome -- never over a
//          floating object stacked on the pivot, over DOM above the grid, or on
//          another sheet. What each piece of chrome DOES stays shared with the
//          canvas box (pivotChromeActions.ts).
//
//          A press the chrome cannot serve is NOT claimed, and Core selects the
//          cell as it did before: a +/- whose cell is not in the cached view, a
//          report filter the backend no longer knows (asked at the press).
//
//          A DOUBLE-CLICK acts once, as on the canvas box: the release that
//          repeats the same piece of chrome within 450 ms of the last one that
//          acted is dropped -- the box's own guard, asked here too
//          (pivotChromeRepeat.ts; owner question 27, 2026-10-02). Before it, a
//          double-click on a worksheet +/- toggled twice, back to where it was.

import { actOnRelease, type CellClickAnswer, type CellClickEvent, type CellPressPoint } from "@api/cellClickInterceptors";
import { chromeReleaseActs } from "./pivotChromeRepeat";
import {
  togglePivotHeaderAt,
  findPivotReportFilterZone,
  openPivotReportFilterZone,
  openPivotHeaderFilter,
  cancelPivotLoading,
  getPivotViewCell,
} from "./pivotChromeActions";

// ============================================================================
// The chrome as painted (recorded by Pivot/index.ts's overlay render)
// ============================================================================

export interface StoredIconBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  gridRow: number;
  gridCol: number;
  isExpanded: boolean;
  isRow: boolean;
  pivotId: string;
}

/** Map of icon bounds keyed by "pivotId-gridRow-gridCol", updated every render. */
export const overlayIconBounds = new Map<string, StoredIconBounds>();

/** Extra pixels around icon bounds for easier click targeting (12px icon -> 20px hit area). */
export const ICON_HIT_PADDING = 4;

export interface StoredHeaderFilterBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  zone: "row" | "column";
  pivotId: string;
}

/** Map of header filter button bounds keyed by "pivotId-zone", updated every render. */
export const overlayHeaderFilterBounds = new Map<string, StoredHeaderFilterBounds>();

export interface StoredFilterDropdownBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  fieldIndex: number;
  pivotId: string;
  gridRow: number;
  gridCol: number;
}

/** Map of filter dropdown button bounds keyed by "pivotId-fieldIndex", updated every render. */
export const overlayFilterDropdownBounds = new Map<string, StoredFilterDropdownBounds>();

export interface StoredCancelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Map of cancel button bounds keyed by pivotId, updated every render. */
export const overlayCancelBounds = new Map<string, StoredCancelBounds>();

/** Clear all stored chrome bounds (called at the start of each render cycle). */
export function clearOverlayIconBounds(): void {
  overlayIconBounds.clear();
  overlayHeaderFilterBounds.clear();
  overlayFilterDropdownBounds.clear();
  overlayCancelBounds.clear();
}

// ============================================================================
// Hit test
// ============================================================================

/** One piece of chrome under a point. */
export type PivotCellChromeHit =
  | { kind: "cancel"; pivotId: string }
  | { kind: "icon"; bounds: StoredIconBounds }
  | { kind: "filter"; bounds: StoredFilterDropdownBounds }
  | { kind: "headerFilter"; bounds: StoredHeaderFilterBounds };

function inside(b: { x: number; y: number; width: number; height: number }, x: number, y: number, pad = 0): boolean {
  return x >= b.x - pad && x <= b.x + b.width + pad && y >= b.y - pad && y <= b.y + b.height + pad;
}

/**
 * Every piece of chrome under a canvas point, as painted now, in the order the
 * press asks them: the loading Cancel, the +/- icons (with their padding), the
 * report filter combos, the Row/Column Labels buttons.
 */
export function pivotCellChromeHitsAt(canvasX: number, canvasY: number): PivotCellChromeHit[] {
  const hits: PivotCellChromeHit[] = [];
  for (const [pivotId, bounds] of overlayCancelBounds.entries()) {
    if (inside(bounds, canvasX, canvasY)) hits.push({ kind: "cancel", pivotId });
  }
  for (const bounds of overlayIconBounds.values()) {
    if (inside(bounds, canvasX, canvasY, ICON_HIT_PADDING)) hits.push({ kind: "icon", bounds });
  }
  for (const bounds of overlayFilterDropdownBounds.values()) {
    if (inside(bounds, canvasX, canvasY)) hits.push({ kind: "filter", bounds });
  }
  for (const bounds of overlayHeaderFilterBounds.values()) {
    if (inside(bounds, canvasX, canvasY)) hits.push({ kind: "headerFilter", bounds });
  }
  return hits;
}

/** Names one piece of chrome: the release acts only over the chrome with the same key. */
export function pivotCellChromeKey(hit: PivotCellChromeHit): string {
  switch (hit.kind) {
    case "cancel":
      return `${hit.pivotId}|cancel`;
    case "icon":
      return `${hit.bounds.pivotId}|icon|${hit.bounds.gridRow}:${hit.bounds.gridCol}`;
    case "filter":
      return `${hit.bounds.pivotId}|filter|${hit.bounds.fieldIndex}`;
    case "headerFilter":
      return `${hit.bounds.pivotId}|headerFilter|${hit.bounds.zone}`;
  }
}

// ============================================================================
// The interceptor
// ============================================================================

/** What the interceptor needs from the extension. */
export interface PivotCellChromeDeps {
  /** The grid canvas the chrome was painted on (null before the first paint). */
  canvas(): HTMLCanvasElement | null;
  /** The pivot's region origin on the grid, for the +/- view cell. */
  regionOrigin(pivotId: string): { startRow: number; startCol: number } | undefined;
}

/**
 * The worksheet pivot's ONE cell click interceptor: a press on its chrome is
 * CLAIMED for the release over the same chrome (or not claimed at all, when the
 * chrome cannot serve it); a press anywhere else is not the pivot's.
 */
export async function claimPivotCellChrome(event: CellClickEvent, deps: PivotCellChromeDeps): Promise<CellClickAnswer> {
  const canvas = deps.canvas();
  if (!canvas) return false;
  /** The chrome under a CLIENT point, measured against the canvas where it is now. */
  const hitsAt = (p: { clientX: number; clientY: number }): PivotCellChromeHit[] => {
    const rect = canvas.getBoundingClientRect();
    return pivotCellChromeHitsAt(p.clientX - rect.left, p.clientY - rect.top);
  };

  for (const hit of hitsAt(event)) {
    const run = await releaseActionFor(hit, deps);
    if (run === null) continue;
    const key = pivotCellChromeKey(hit);
    // The loading Cancel is not guarded, as on the canvas box.
    const guarded = hit.kind !== "cancel";
    return actOnRelease({
      key,
      targetAt: (point) => (hitsAt(point).some((h) => pivotCellChromeKey(h) === key) ? key : null),
      // The second release of a double-click on the same chrome is dropped.
      runAtRelease: (release) => (chromeReleaseActs(key, guarded) ? run(release) : undefined),
    });
  }
  return false;
}

/** What a release over `hit` does, or null when the chrome cannot serve the press. */
async function releaseActionFor(
  hit: PivotCellChromeHit,
  deps: PivotCellChromeDeps,
): Promise<((release: CellPressPoint) => void | Promise<void>) | null> {
  switch (hit.kind) {
    case "cancel": {
      const pivotId = hit.pivotId;
      return () => {
        // Restore the previous view at once, suppress the in-flight result and
        // ask the backend to stop (shared with the canvas pivot box).
        overlayCancelBounds.delete(pivotId);
        cancelPivotLoading(pivotId);
      };
    }
    case "icon": {
      const b = hit.bounds;
      const origin = deps.regionOrigin(b.pivotId);
      const viewRow = b.gridRow - (origin?.startRow ?? 0);
      const viewCol = b.gridCol - (origin?.startCol ?? 0);
      // Not in the cached view: nothing to toggle -- the press selects the cell.
      if (!getPivotViewCell(b.pivotId, viewRow, viewCol)) return null;
      return async () => {
        await togglePivotHeaderAt(b.pivotId, viewRow, viewCol, b.isRow);
      };
    }
    case "filter": {
      const b = hit.bounds;
      const zone = await findPivotReportFilterZone(b.gridRow, b.gridCol, b.fieldIndex);
      if (!zone) return null;
      // The menu opens where the pointer was RELEASED.
      return (release) => openPivotReportFilterZone(zone, release.clientX, release.clientY);
    }
    case "headerFilter": {
      const b = hit.bounds;
      return (release) => openPivotHeaderFilter(b.pivotId, b.zone, release.clientX, release.clientY + 2);
    }
  }
}
