//! FILENAME: app/extensions/Pivot/lib/pivotCellPress.ts
// PURPOSE: A press on a canvas pivot box's CELLS (D-CELLS, owner finding F4):
//          the press selects -- a plain press anchors the cell under it, a
//          Shift+press extends the selection to it -- and the DRAG that follows
//          extends the selection to the cell under the pointer until the
//          release. A drag past the box's body edge auto-scrolls the box.
// CONTEXT: The box's cells are CONTENT in its one zone answer
//          (pivotVisualOverlay.ts `pivotVisualZoneAt`, part "cell"), so Core
//          hands the press to `floatingObject:bodyDragStart` and never moves
//          the box from it. The precedent is pivotChromePress.ts (the chrome's
//          press), and the rules are the same:
//            - The window listeners live only as long as the press: bound at
//              the press, removed at its primary release, Escape, window blur,
//              a move with the primary button UP (a release this page never
//              heard), a release of another button with the primary one up,
//              the next press (cell or chrome: one press at a time), or the
//              box's teardown (`installPivotVisual`).
//            - While it is held the press holds Core's pointer over the box
//              (`holdContentGestureCursor`, "cell"), released on EVERY end
//              path: no grip shows and no resize handle answers under it.
//            - Escape belongs to the press while it lives: it ENDS THE DRAG and
//              keeps the cells selected; it is stopped here (capture phase) and
//              the box's object-selection provider owns it meanwhile, so the
//              canvas does not also deselect the box.
//          Nothing here writes to the document: the selection is a viewing
//          state (pivotVisualCellSelection.ts).
//
//          AUTO-SCROLL. While the pointer is past the box's BODY edge (below or
//          right of the box; above or left of the frozen header band, while
//          the body can still scroll that way), a requestAnimationFrame loop
//          steps the box's scroll 16 px per frame toward it (clamped by
//          `clampVisualScroll`), re-extends to the cell at the box edge and
//          repaints. It stops at the release, when the pointer comes back, or
//          when the scroll cannot move further.
//
//          A CLICK (P4 cross-filter, S7). A press the caller hands an
//          `onClick` (a plain or Ctrl press on a canvas BI pivot box outside
//          Design Mode, pivotVisualOverlay.ts) calls it at its primary RELEASE
//          when the release is over the press cell and the drag never reached
//          another cell: a drag selects cells and never cross-filters, nor
//          does a Shift-extend (no `onClick`), Escape, a blur or a lost release.

import { holdContentGestureCursor, requestOverlayRedraw } from "@api/gridOverlays";
import { getPivotVisualRecord, type PivotVisualRecord } from "./pivotVisualHits";
import { getPivotVisualScroll, setPivotVisualScroll } from "./pivotVisualScroll";
import {
  clampVisualScroll,
  frozenExtent,
  viewCellAtLocal,
  type PivotVisualScroll,
} from "../rendering/pivotVisualRenderer";
import {
  extendPivotCellSelection,
  getPivotCellSelection,
  setPivotCellAnchor,
} from "./pivotVisualCellSelection";
import {
  cancelPivotPress,
  isPivotCellPressHeld,
  registerPivotPressCanceller,
  setPivotCellPressHeld,
} from "./pivotVisualMenuState";

/** Pixels the box's body scrolls per animation frame while a drag is past its edge. */
export const PIVOT_CELL_AUTOSCROLL_STEP = 16;

/** A cell press, as the box's bodyDragStart listener hands it over. */
export interface PivotCellPress {
  pivotId: string;
  /** The grid region Core pressed (the box's): the press holds Core's pointer over it. */
  regionId?: string;
  /** Where the press landed, in logical canvas px (Core's own basis). */
  canvasX: number;
  canvasY: number;
  /** Shift was held: extend the box's selection instead of anchoring a new one. */
  shiftKey: boolean;
  /** A window mouse event's point in logical canvas px; null before the grid mounts. */
  clientToCanvas(clientX: number, clientY: number): { x: number; y: number } | null;
  /**
   * Called at the primary release when the press was a CLICK on its cell (the
   * release over the press cell, no drag to another cell), with that cell.
   */
  onClick?(cell: { viewRow: number; viewCol: number }): void;
}

interface Session {
  pivotId: string;
  clientToCanvas: PivotCellPress["clientToCanvas"];
  /** Lets go of Core's pointer this press holds (every end path runs it). */
  releaseCursor: () => void;
  /** The pointer's last point, logical canvas px (the auto-scroll's direction). */
  lastX: number;
  lastY: number;
  /** The pending animation frame of the auto-scroll loop, or null. */
  frame: number | null;
  /** The click the press may still be: its cell and callback; null once it dragged off or has none. */
  click: { viewRow: number; viewCol: number; run: NonNullable<PivotCellPress["onClick"]> } | null;
}

let session: Session | null = null;

/** Whether a cell press (its drag) is live. */
export function isPivotCellPressLive(): boolean {
  return isPivotCellPressHeld();
}

/**
 * The view cell for a canvas point, the point first CLAMPED into the box (a
 * drag past the edge extends to the edge cell), at `scroll` (the box's live
 * scroll, which an auto-scroll step may have moved before the next paint).
 */
function cellAtClamped(
  record: PivotVisualRecord,
  scroll: PivotVisualScroll,
  canvasX: number,
  canvasY: number,
): { viewRow: number; viewCol: number } | null {
  if (!record.geometry || record.box.width <= 0 || record.box.height <= 0) return null;
  const inset = 0.01;
  const lx = Math.min(Math.max(canvasX - record.box.x, inset), record.box.width - inset);
  const ly = Math.min(Math.max(canvasY - record.box.y, inset), record.box.height - inset);
  return viewCellAtLocal(record.geometry, scroll, lx, ly);
}

/**
 * Start a cell press. Returns false (and binds nothing) when no cell is under
 * the press after all -- the box repainted under the pointer, or the pivot has
 * no painted record. A Shift+press extends the box's own selection; with no
 * selection in THIS box it anchors.
 */
export function beginPivotCellPress(press: PivotCellPress): boolean {
  // One press at a time: a cell press whose release was never heard ends
  // here, and so does a chrome press.
  cancelPivotCellPress();
  cancelPivotPress("chrome");

  const record = getPivotVisualRecord(press.pivotId);
  if (!record || !record.geometry) return false;
  const scroll = getPivotVisualScroll(press.pivotId);
  const lx = press.canvasX - record.box.x;
  const ly = press.canvasY - record.box.y;
  if (lx < 0 || ly < 0 || lx > record.box.width || ly > record.box.height) return false;
  const at = viewCellAtLocal(record.geometry, scroll, lx, ly);
  if (!at) return false;

  const current = getPivotCellSelection();
  if (press.shiftKey && current !== null && current.pivotId === press.pivotId) {
    extendPivotCellSelection(at.viewRow, at.viewCol);
  } else {
    setPivotCellAnchor(press.pivotId, at.viewRow, at.viewCol);
  }

  const regionId = press.regionId ?? null;
  session = {
    pivotId: press.pivotId,
    clientToCanvas: press.clientToCanvas,
    releaseCursor: regionId !== null ? holdContentGestureCursor(regionId, "cell") : () => {},
    lastX: press.canvasX,
    lastY: press.canvasY,
    frame: null,
    click: press.onClick ? { viewRow: at.viewRow, viewCol: at.viewCol, run: press.onClick } : null,
  };
  setPivotCellPressHeld(true);
  window.addEventListener("mousemove", onPressMove);
  window.addEventListener("mouseup", onPressUp);
  window.addEventListener("keydown", onPressKey, true);
  window.addEventListener("blur", onPressBlur);
  requestOverlayRedraw();
  return true;
}

/** End a live press (Escape, blur, a lost release, the next press, teardown). The cells stay selected. */
export function cancelPivotCellPress(): void {
  endPress();
}

registerPivotPressCanceller("cell", cancelPivotCellPress);

function endPress(): void {
  const s = session;
  if (!s) return;
  session = null;
  if (s.frame !== null) cancelAnimationFrame(s.frame);
  s.releaseCursor();
  setPivotCellPressHeld(false);
  window.removeEventListener("mousemove", onPressMove);
  window.removeEventListener("mouseup", onPressUp);
  window.removeEventListener("keydown", onPressKey, true);
  window.removeEventListener("blur", onPressBlur);
  requestOverlayRedraw();
}

/**
 * Which way the body must scroll for the pointer at (x, y): -1, 0 or +1 per
 * axis. Past the bottom/right of the box; above/left of the frozen band (the
 * top/left of the box when nothing is frozen) only while the body is scrolled.
 */
function autoScrollDirection(
  record: PivotVisualRecord,
  scroll: PivotVisualScroll,
  x: number,
  y: number,
): { dx: number; dy: number } {
  if (!record.geometry) return { dx: 0, dy: 0 };
  const { frozenWidth, frozenHeight } = frozenExtent(record.geometry);
  const b = record.box;
  const dy = y > b.y + b.height ? 1 : y < b.y + frozenHeight && scroll.top > 0 ? -1 : 0;
  const dx = x > b.x + b.width ? 1 : x < b.x + frozenWidth && scroll.left > 0 ? -1 : 0;
  return { dx, dy };
}

/** Extend the selection to the cell under the session's last point at the box's live scroll. */
function extendToPointer(s: Session): void {
  const record = getPivotVisualRecord(s.pivotId);
  if (!record) return;
  const at = cellAtClamped(record, getPivotVisualScroll(s.pivotId), s.lastX, s.lastY);
  if (!at) return;
  // A drag that reaches another cell selects cells; it is no click any more.
  if (s.click && (at.viewRow !== s.click.viewRow || at.viewCol !== s.click.viewCol)) s.click = null;
  extendPivotCellSelection(at.viewRow, at.viewCol);
}

/** Start the auto-scroll loop when the pointer is past the body edge (idempotent). */
function ensureAutoScroll(s: Session): void {
  if (s.frame !== null) return;
  const record = getPivotVisualRecord(s.pivotId);
  if (!record) return;
  const { dx, dy } = autoScrollDirection(record, getPivotVisualScroll(s.pivotId), s.lastX, s.lastY);
  if (dx === 0 && dy === 0) return;
  s.frame = requestAnimationFrame(() => autoScrollTick(s));
}

function autoScrollTick(s: Session): void {
  s.frame = null;
  if (session !== s) return;
  const record = getPivotVisualRecord(s.pivotId);
  if (!record || !record.geometry) return;
  const scroll = getPivotVisualScroll(s.pivotId);
  const { dx, dy } = autoScrollDirection(record, scroll, s.lastX, s.lastY);
  if (dx === 0 && dy === 0) return;
  const next = clampVisualScroll(record.geometry, record.box.width, record.box.height, {
    left: scroll.left + dx * PIVOT_CELL_AUTOSCROLL_STEP,
    top: scroll.top + dy * PIVOT_CELL_AUTOSCROLL_STEP,
  });
  // At the end of the content: nothing more to show, the loop rests until
  // the pointer moves again.
  if (next.left === scroll.left && next.top === scroll.top) return;
  setPivotVisualScroll(s.pivotId, next);
  extendToPointer(s);
  requestOverlayRedraw();
  s.frame = requestAnimationFrame(() => autoScrollTick(s));
}

const onPressMove = (e: MouseEvent): void => {
  const s = session;
  if (!s) return;
  // The press exists only while the primary button is HELD: a move with it up
  // means its release was never heard. The cells stay as they are.
  if ((e.buttons & 1) === 0) {
    endPress();
    return;
  }
  const at = s.clientToCanvas(e.clientX, e.clientY);
  if (!at) return;
  s.lastX = at.x;
  s.lastY = at.y;
  extendToPointer(s);
  ensureAutoScroll(s);
};

const onPressUp = (e: MouseEvent): void => {
  if (!session) return;
  if (e.button !== 0) {
    // Another button let go: with the primary one still held the drag goes
    // on; with it up this was never a primary press, and it ends here.
    if ((e.buttons & 1) === 0) endPress();
    return;
  }
  const s = session;
  const click = s ? clickAtRelease(s, e) : null;
  endPress();
  if (click) {
    try {
      click.run({ viewRow: click.viewRow, viewCol: click.viewCol });
    } catch (err) {
      console.error("[pivot] a cell click handler threw:", err);
    }
  }
};

/**
 * The click a primary release completes, or null: the press armed one, never
 * dragged to another cell, and is released over its own cell (inside the box,
 * at the box's live scroll).
 */
function clickAtRelease(s: Session, e: MouseEvent): Session["click"] {
  const click = s.click;
  if (!click) return null;
  const record = getPivotVisualRecord(s.pivotId);
  const point = s.clientToCanvas(e.clientX, e.clientY);
  if (!record?.geometry || !point) return null;
  const lx = point.x - record.box.x;
  const ly = point.y - record.box.y;
  if (lx < 0 || ly < 0 || lx > record.box.width || ly > record.box.height) return null;
  const at = viewCellAtLocal(record.geometry, getPivotVisualScroll(s.pivotId), lx, ly);
  if (!at || at.viewRow !== click.viewRow || at.viewCol !== click.viewCol) return null;
  return click;
}

const onPressKey = (e: KeyboardEvent): void => {
  if (!session || e.key !== "Escape") return;
  // The Escape is the drag's: it ends the drag and keeps the cells; nothing
  // else acts on it too.
  e.preventDefault();
  e.stopPropagation();
  endPress();
};

const onPressBlur = (): void => {
  endPress();
};
