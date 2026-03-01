//! FILENAME: app/extensions/Review/handlers/hoverHandler.ts
// PURPOSE: Mouse hover handler for showing annotation previews.
// CONTEXT: Listens for mousemove on the grid canvas and shows/hides tooltip overlays
//          when the cursor enters the triangle indicator area in the top-right of cells.

import {
  showOverlay,
  hideOverlay,
  getComment,
  getNote,
} from "../../../src/api";
import {
  getCommentIndicatorAt,
  getNoteIndicatorAt,
} from "../lib/annotationStore";

// ============================================================================
// State
// ============================================================================

let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
let currentHoverKey: string | null = null;
let isPreviewVisible = false;

/** Cell-to-pixel lookup function, set by the extension on init */
let getCellFromPixelFn:
  | ((x: number, y: number) => { row: number; col: number } | null)
  | null = null;

/** Reference to the canvas element */
let canvasElement: HTMLCanvasElement | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the hover handler.
 * @param canvas The grid canvas element
 * @param getCellFromPixel Function to convert pixel coordinates to cell coordinates
 */
export function initHoverHandler(
  canvas: HTMLCanvasElement,
  getCellFromPixel: (
    x: number,
    y: number
  ) => { row: number; col: number } | null
): void {
  canvasElement = canvas;
  getCellFromPixelFn = getCellFromPixel;
  canvas.addEventListener("mousemove", handleMouseMove);
  canvas.addEventListener("mouseleave", handleMouseLeave);
}

/**
 * Cleanup the hover handler.
 */
export function destroyHoverHandler(): void {
  if (canvasElement) {
    canvasElement.removeEventListener("mousemove", handleMouseMove);
    canvasElement.removeEventListener("mouseleave", handleMouseLeave);
  }
  canvasElement = null;
  getCellFromPixelFn = null;
  clearHoverState();
}

/**
 * Simplified hover handler that works without getCellFromPixel.
 * Uses the annotation indicator maps to check for annotations
 * and shows a preview when hovering over annotated cells.
 *
 * This version doesn't need canvas coordinate mapping - it relies on
 * the cell click interceptor and selection change handlers to show previews.
 */
export function showPreviewForCell(
  row: number,
  col: number,
  anchorX: number,
  anchorY: number
): void {
  const key = `${row},${col}`;
  if (key === currentHoverKey && isPreviewVisible) return;

  clearHoverState();
  currentHoverKey = key;

  const commentIndicator = getCommentIndicatorAt(row, col);
  const noteIndicator = getNoteIndicatorAt(row, col);

  if (!commentIndicator && !noteIndicator) return;

  hoverTimeout = setTimeout(async () => {
    if (commentIndicator) {
      const comment = await getComment(row, col);
      if (comment) {
        showOverlay("annotation-preview", {
          data: {
            type: "comment",
            authorName: comment.authorName,
            content: comment.content,
            resolved: comment.resolved,
            replyCount: comment.replies.length,
          },
          anchorRect: { x: anchorX, y: anchorY, width: 0, height: 0 },
        });
        isPreviewVisible = true;
      }
    } else if (noteIndicator) {
      const note = await getNote(row, col);
      if (note) {
        showOverlay("annotation-preview", {
          data: {
            type: "note",
            authorName: note.authorName,
            content: note.content,
          },
          anchorRect: { x: anchorX, y: anchorY, width: 0, height: 0 },
        });
        isPreviewVisible = true;
      }
    }
  }, 300);
}

/**
 * Hide any visible preview.
 */
export function hidePreview(): void {
  clearHoverState();
}

// ============================================================================
// Internal
// ============================================================================

function handleMouseMove(e: MouseEvent): void {
  if (!getCellFromPixelFn || !canvasElement) return;

  const rect = canvasElement.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const cell = getCellFromPixelFn(x, y);
  if (!cell) {
    clearHoverState();
    return;
  }

  showPreviewForCell(cell.row, cell.col, e.clientX, e.clientY);
}

function handleMouseLeave(): void {
  clearHoverState();
}

function clearHoverState(): void {
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  if (isPreviewVisible) {
    hideOverlay("annotation-preview");
    isPreviewVisible = false;
  }
  currentHoverKey = null;
}
