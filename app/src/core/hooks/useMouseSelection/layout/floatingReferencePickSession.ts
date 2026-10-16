//! FILENAME: app/src/core/hooks/useMouseSelection/layout/floatingReferencePickSession.ts
// PURPOSE: The PICK press and drag on a floating object (D-PICK, owner finding
//          F3): while a formula is picking a reference, a press Core's overlay
//          door turned into a pick (the object's `referenceAt` answered) is
//          followed here until its release, which inserts ONE reference -- the
//          pressed cell, or the rectangle a drag across the object covered.
// CONTEXT: overlayMoveHandlers.ts decides the press (before `pressZone`: no
//          object-selection press hook, no `floatingObject:selected`, no
//          `bodyDragStart`, no move). This module owns what follows it and the
//          only window listeners it binds (census rows in
//          core/lib/globalInputListeners.ts, verdict session-scoped):
//            mousemove  re-asks `referenceAtPoint` for the SAME region, at the
//                       pointer clamped into the region's bounds; a null answer
//                       keeps the last cell; every change updates the preview
//                       (the owning family paints it dashed) and redraws.
//                       A move with the primary button UP is a release this
//                       page never heard: it finishes the pick.
//            mouseup    the primary release finishes it. A non-primary release
//                       with the primary still held is ignored.
//          No keydown listener: Escape belongs to the edit, as on the grid.
//          Finishing clears the preview, hands the range to the caller (Core's
//          routing in useSpreadsheetSelection) and remembers the pick so the
//          second press and the dblclick of a double-click are its ECHO.

import {
  getLiveGridRegions,
  referenceAtPoint,
  requestOverlayRedraw,
  type FloatingReferencePickRange,
  type GridRegion,
  type OverlayReferencePick,
} from "../../../../api/gridOverlays";
import {
  noteFinishedReferencePick,
  setFloatingReferencePickPreview,
} from "../../../lib/referencePickState";

/** What the session needs from the hook that started it. */
export interface FloatingReferencePickDeps {
  /** Canvas bounds of a region at the CURRENT viewport (overlayMoveHandlers' getFloatingCanvasBounds). */
  boundsOf(region: GridRegion): { x: number; y: number; width: number; height: number } | null;
  /** CLIENT -> logical canvas px (grid area origin, / zoom), or null before mount. */
  clientToCanvas(clientX: number, clientY: number): { x: number; y: number } | null;
  /** Where a finished pick goes (useSpreadsheetSelection.handleFloatingReferencePick). */
  onPick(range: FloatingReferencePickRange): void;
}

/** How far inside the region's edge a clamped pointer is placed (so the edge cell answers). */
const CLAMP_INSET_PX = 0.01;

interface LivePick {
  regionId: string;
  /** Where the press was (CLIENT px): a click's echo is measured from here. */
  pressX: number;
  pressY: number;
  region: GridRegion;
  first: OverlayReferencePick;
  last: OverlayReferencePick;
  deps: FloatingReferencePickDeps;
  onMove: (e: MouseEvent) => void;
  onUp: (e: MouseEvent) => void;
}

let live: LivePick | null = null;

/** The single cell `pick` names, as a range. */
function singleRange(pick: OverlayReferencePick): FloatingReferencePickRange {
  return pick.space === "sheet"
    ? { space: "sheet", startRow: pick.row, startCol: pick.col, endRow: pick.row, endCol: pick.col }
    : { space: "object", name: pick.name, startRow: pick.row, startCol: pick.col, endRow: pick.row, endCol: pick.col };
}

/**
 * PURE: the normalized range two picks span, or null when they are not in the
 * same space (a "sheet" cell and an "object" cell, or two differently named
 * objects) -- the caller then keeps `a` alone.
 */
export function spanReferencePicks(a: OverlayReferencePick, b: OverlayReferencePick): FloatingReferencePickRange | null {
  const startRow = Math.min(a.row, b.row);
  const startCol = Math.min(a.col, b.col);
  const endRow = Math.max(a.row, b.row);
  const endCol = Math.max(a.col, b.col);
  if (a.space === "sheet" && b.space === "sheet") {
    return { space: "sheet", startRow, startCol, endRow, endCol };
  }
  if (a.space === "object" && b.space === "object" && a.name === b.name) {
    return { space: "object", name: a.name, startRow, startCol, endRow, endCol };
  }
  return null;
}

function currentRange(pick: LivePick): FloatingReferencePickRange {
  return spanReferencePicks(pick.first, pick.last) ?? singleRange(pick.first);
}

function samePick(a: OverlayReferencePick, b: OverlayReferencePick): boolean {
  if (a.space !== b.space || a.row !== b.row || a.col !== b.col) return false;
  return a.space === "sheet" || (b.space === "object" && a.name === b.name);
}

function unbind(pick: LivePick): void {
  window.removeEventListener("mousemove", pick.onMove, true);
  window.removeEventListener("mouseup", pick.onUp, true);
}

/** End `pick` and insert what it covers. */
function finish(pick: LivePick, clientX: number, clientY: number): void {
  if (live !== pick) return;
  live = null;
  unbind(pick);
  const range = currentRange(pick);
  setFloatingReferencePickPreview(null);
  requestOverlayRedraw();
  // The echo window opens BEFORE the insertion runs: an async insertion (the
  // GETPIVOTDATA interceptor) keeps the predicate true for a while, and the
  // second press of a double-click must already count as an echo then.
  // A click (the pick never left its first cell) echoes where it was PRESSED --
  // the second press of a double-click lands beside the first one, whatever
  // jitter the release had; a drag echoes where it was released.
  const clicked = samePick(pick.first, pick.last);
  noteFinishedReferencePick(
    pick.regionId,
    clicked ? pick.pressX : clientX,
    clicked ? pick.pressY : clientY,
  );
  try {
    pick.deps.onPick(range);
  } catch (err) {
    console.error("[floatingReferencePick] inserting the picked reference failed:", err);
  }
}

/** Re-ask the region at the pointer and update the preview when the cell changed. */
function extend(pick: LivePick, clientX: number, clientY: number): void {
  const region = getLiveGridRegions().find((r) => r.id === pick.regionId);
  if (!region) {
    // The object is gone (unpublished, sheet switched): the pick ends with
    // what it had when it started.
    pick.last = pick.first;
    finish(pick, clientX, clientY);
    return;
  }
  pick.region = region;
  const point = pick.deps.clientToCanvas(clientX, clientY);
  const bounds = pick.deps.boundsOf(region);
  if (!point || !bounds) return;
  const minX = bounds.x + CLAMP_INSET_PX;
  const maxX = bounds.x + Math.max(CLAMP_INSET_PX, bounds.width - CLAMP_INSET_PX);
  const minY = bounds.y + CLAMP_INSET_PX;
  const maxY = bounds.y + Math.max(CLAMP_INSET_PX, bounds.height - CLAMP_INSET_PX);
  const canvasX = Math.min(Math.max(point.x, minX), maxX);
  const canvasY = Math.min(Math.max(point.y, minY), maxY);
  const next = referenceAtPoint({
    region,
    canvasX,
    canvasY,
    row: 0,
    col: 0,
    floatingCanvasBounds: bounds,
  });
  if (!next || samePick(next, pick.last)) return;
  // A cell of another space (or another named object) cannot extend this pick.
  if (spanReferencePicks(pick.first, next) === null) return;
  pick.last = next;
  setFloatingReferencePickPreview({ regionId: pick.regionId, range: currentRange(pick) });
  requestOverlayRedraw();
}

/**
 * Start a pick at a press whose `referenceAt` answered `first`. Binds capture
 * mousemove/mouseup on window until the release. A pick still live (its
 * release never came) is cancelled first, inserting nothing.
 */
export function beginFloatingReferencePick(
  region: GridRegion,
  first: OverlayReferencePick,
  clientX: number,
  clientY: number,
  deps: FloatingReferencePickDeps,
): void {
  cancelFloatingReferencePick();
  const pick: LivePick = {
    regionId: region.id,
    pressX: clientX,
    pressY: clientY,
    region,
    first,
    last: first,
    deps,
    onMove: (e: MouseEvent) => {
      if ((e.buttons & 1) === 0) {
        finish(pick, e.clientX, e.clientY);
        return;
      }
      extend(pick, e.clientX, e.clientY);
    },
    onUp: (e: MouseEvent) => {
      if (e.button !== 0 && (e.buttons & 1) !== 0) return; // another button, primary still held
      finish(pick, e.clientX, e.clientY);
    },
  };
  live = pick;
  window.addEventListener("mousemove", pick.onMove, true);
  window.addEventListener("mouseup", pick.onUp, true);
  setFloatingReferencePickPreview({ regionId: region.id, range: singleRange(first) });
  requestOverlayRedraw();
}

/** End a live pick WITHOUT inserting anything (teardown, a newer press). */
export function cancelFloatingReferencePick(): void {
  const pick = live;
  if (!pick) return;
  live = null;
  unbind(pick);
  setFloatingReferencePickPreview(null);
  requestOverlayRedraw();
}

/** Whether a pick press is being followed right now. */
export function isFloatingReferencePickLive(): boolean {
  return live !== null;
}
