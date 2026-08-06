//! FILENAME: app/extensions/Review/handlers/hoverHandler.ts
// PURPOSE: Hover preview for annotated cells - the primary way notes are read.
// CONTEXT: Mounted by the extension on activate(), torn down on deactivate().
//   Watches the pointer over the grid canvas and, after a short rest over a cell
//   that carries a note/comment indicator, shows the "annotation-preview"
//   tooltip overlay. In Excel hovering a noted cell is how you read the note;
//   without this the only way in was to click the cell open.
//
// TRIGGER AREA: the whole annotated cell, not the 6x6px corner triangle. The
//   triangle is the MARK that says "this cell has a note"; Excel (and every
//   other spreadsheet) previews on the cell. A 6px target would be unhittable,
//   and cells without an indicator never trigger anything at all, so the
//   indicator still gates the whole feature.
//
// LIFECYCLE: all listeners live on `document` / `window` and are removed by
//   destroyHoverHandler(); a module-level `mounted` flag additionally makes any
//   in-flight timer or await a no-op after teardown, so nothing this file
//   schedules can survive extension deactivation.

import { showOverlay, hideOverlay, getComment, getNote, OverlayExtensions } from "@api";
import { getCellFromPixel, getGridStateSnapshot } from "@api/grid";
import { getGridCanvas } from "@api/rendering";
import { getCommentIndicatorAt, getNoteIndicatorAt } from "../lib/annotationStore";

// ============================================================================
// Constants
// ============================================================================

const PREVIEW_OVERLAY_ID = "annotation-preview";

/** Overlays that own the annotation UI; the preview must not fight them. */
const EDITOR_OVERLAY_IDS = ["note-editor", "comment-panel"];

/** Rest time before the preview appears (ms). Excel-ish; long enough that
 *  sweeping the pointer across a column of noted cells shows nothing. */
const HOVER_DELAY_MS = 350;

// ============================================================================
// State
// ============================================================================

let mounted = false;
let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
let currentHoverKey: string | null = null;
let isPreviewVisible = false;

/** Invalidation token: bumped by every hover change and by teardown, so a timer
 *  or an awaited fetch that resolves late can tell it is stale. */
let hoverToken = 0;

/** Last pointer position that was actually resolved to a cell (client px).
 *  Sub-pixel jitter must not cost a cell lookup on every mousemove. */
let lastProcessedX = Number.NaN;
let lastProcessedY = Number.NaN;

/** Pointer travel (px) below which a mousemove is ignored. */
const MOVE_EPSILON = 2;

// ============================================================================
// Public API
// ============================================================================

/**
 * Mount the hover preview. Idempotent: a second call is a no-op, so a double
 * activate() cannot double-register the listeners.
 */
export function initHoverHandler(): void {
  if (mounted) return;
  mounted = true;
  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("mouseleave", handleMouseLeave, true);
  // Scrolling/zooming moves the grid under a stationary pointer, so whatever is
  // being previewed is no longer the cell under the cursor. Passive: this
  // listener never calls preventDefault and must not slow scrolling down.
  document.addEventListener("wheel", handleMouseLeave, { capture: true, passive: true });
  window.addEventListener("blur", handleMouseLeave);
}

/**
 * Unmount the hover preview: remove every listener, cancel any pending timer,
 * hide a visible preview, and make late async work inert.
 */
export function destroyHoverHandler(): void {
  if (!mounted) {
    clearHoverState();
    return;
  }
  document.removeEventListener("mousemove", handleMouseMove, true);
  document.removeEventListener("mouseleave", handleMouseLeave, true);
  document.removeEventListener("wheel", handleMouseLeave, { capture: true });
  window.removeEventListener("blur", handleMouseLeave);
  mounted = false;
  lastProcessedX = Number.NaN;
  lastProcessedY = Number.NaN;
  clearHoverState();
}

/** True when the hover handler currently has listeners attached. */
export function isHoverHandlerMounted(): boolean {
  return mounted;
}

/**
 * Arm the preview for a cell. Repeated calls for the SAME cell are ignored, so
 * moving the pointer within one cell neither restarts the delay nor re-shows
 * (and therefore never flickers). Moving to a different cell cancels whatever
 * the previous cell had pending or showing.
 *
 * Exported so the click/selection paths and tests can drive it directly.
 */
export function showPreviewForCell(
  row: number,
  col: number,
  anchorX: number,
  anchorY: number
): void {
  const key = `${row},${col}`;
  if (key === currentHoverKey) return;

  clearHoverState();
  currentHoverKey = key;

  if (!mounted) return;
  // The editors are the authoritative view of an annotation; while one is open
  // a tooltip would just cover it.
  if (isAnnotationEditorOpen()) return;

  const commentIndicator = getCommentIndicatorAt(row, col);
  const noteIndicator = getNoteIndicatorAt(row, col);
  if (!commentIndicator && !noteIndicator) return;

  const token = hoverToken;
  hoverTimeout = setTimeout(() => {
    hoverTimeout = null;
    void revealPreview(row, col, anchorX, anchorY, token, Boolean(commentIndicator));
  }, HOVER_DELAY_MS);
}

/** Hide any visible preview and cancel any pending one. */
export function hidePreview(): void {
  clearHoverState();
}

// ============================================================================
// Internal
// ============================================================================

async function revealPreview(
  row: number,
  col: number,
  anchorX: number,
  anchorY: number,
  token: number,
  preferComment: boolean
): Promise<void> {
  if (!isCurrent(token)) return;

  const anchorRect = { x: anchorX, y: anchorY, width: 0, height: 0 };

  if (preferComment) {
    const comment = await getComment(row, col);
    // The pointer may have moved on (or the extension been torn down) while the
    // fetch was in flight.
    if (!isCurrent(token) || !comment) return;
    showOverlay(PREVIEW_OVERLAY_ID, {
      data: {
        type: "comment",
        authorName: comment.authorName,
        content: comment.content,
        resolved: comment.resolved,
        replyCount: comment.replies.length,
      },
      anchorRect,
    });
    isPreviewVisible = true;
    return;
  }

  const note = await getNote(row, col);
  if (!isCurrent(token) || !note) return;
  showOverlay(PREVIEW_OVERLAY_ID, {
    data: {
      type: "note",
      authorName: note.authorName,
      content: note.content,
    },
    anchorRect,
  });
  isPreviewVisible = true;
}

/** A scheduled reveal is still wanted only if nothing invalidated it meanwhile. */
function isCurrent(token: number): boolean {
  return mounted && token === hoverToken && !isAnnotationEditorOpen();
}

function isAnnotationEditorOpen(): boolean {
  try {
    return OverlayExtensions.getVisibleOverlays().some((o) =>
      EDITOR_OVERLAY_IDS.includes(o.definition.id)
    );
  } catch {
    return false;
  }
}

function handleMouseMove(e: MouseEvent): void {
  if (!mounted) return;

  const canvas = getGridCanvas();
  // Only the grid canvas hovers; anything else (menus, panes, the editors
  // themselves) clears the preview.
  if (!canvas || e.target !== canvas) {
    clearHoverState();
    return;
  }

  // Mid-drag (selection, fill, resize) is not a hover.
  if (e.buttons !== 0) {
    clearHoverState();
    return;
  }

  if (
    Math.abs(e.clientX - lastProcessedX) < MOVE_EPSILON &&
    Math.abs(e.clientY - lastProcessedY) < MOVE_EPSILON
  ) {
    return;
  }
  lastProcessedX = e.clientX;
  lastProcessedY = e.clientY;

  const state = getGridStateSnapshot();
  if (!state) return;

  const bounds = canvas.getBoundingClientRect();
  const zoom = state.zoom || 1;
  const x = (e.clientX - bounds.left) / zoom;
  const y = (e.clientY - bounds.top) / zoom;

  const cell = getCellFromPixel(x, y, state.config, state.viewport, state.dimensions, {
    freezeConfig: state.freezeConfig,
  });
  if (!cell) {
    // Headers and out-of-grid space.
    clearHoverState();
    return;
  }

  showPreviewForCell(cell.row, cell.col, e.clientX, e.clientY);
}

function handleMouseLeave(): void {
  clearHoverState();
}

function clearHoverState(): void {
  hoverToken++;
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  if (isPreviewVisible) {
    hideOverlay(PREVIEW_OVERLAY_ID);
    isPreviewVisible = false;
  }
  currentHoverKey = null;
}
