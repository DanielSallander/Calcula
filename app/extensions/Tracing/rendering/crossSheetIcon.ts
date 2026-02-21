//! FILENAME: app/extensions/Tracing/rendering/crossSheetIcon.ts
// PURPOSE: Draws a small "spreadsheet page" icon for cross-sheet references.
// CONTEXT: Rendered at the endpoint of dashed cross-sheet trace arrows.

// ============================================================================
// Constants
// ============================================================================

const ICON_WIDTH = 16;
const ICON_HEIGHT = 20;
const ICON_COLOR = "#333333";
const ICON_FILL = "#FFFFFF";
const ICON_GRID_COLOR = "#999999";

// ============================================================================
// Public API
// ============================================================================

/**
 * Draw a miniature spreadsheet page icon at the specified position.
 * The icon is centered on (x, y).
 *
 * @param canvasCtx - The 2D canvas rendering context
 * @param x - Center X position
 * @param y - Center Y position
 */
export function drawCrossSheetIcon(
  canvasCtx: CanvasRenderingContext2D,
  x: number,
  y: number,
): void {
  const left = Math.round(x - ICON_WIDTH / 2);
  const top = Math.round(y - ICON_HEIGHT / 2);

  canvasCtx.save();

  // Page background
  canvasCtx.fillStyle = ICON_FILL;
  canvasCtx.strokeStyle = ICON_COLOR;
  canvasCtx.lineWidth = 1;
  canvasCtx.fillRect(left, top, ICON_WIDTH, ICON_HEIGHT);
  canvasCtx.strokeRect(left + 0.5, top + 0.5, ICON_WIDTH - 1, ICON_HEIGHT - 1);

  // Dog-ear (folded corner) at top-right
  const earSize = 4;
  canvasCtx.fillStyle = "#E0E0E0";
  canvasCtx.beginPath();
  canvasCtx.moveTo(left + ICON_WIDTH - earSize, top);
  canvasCtx.lineTo(left + ICON_WIDTH, top + earSize);
  canvasCtx.lineTo(left + ICON_WIDTH - earSize, top + earSize);
  canvasCtx.closePath();
  canvasCtx.fill();
  canvasCtx.stroke();

  // Grid lines (3 horizontal, 2 vertical)
  canvasCtx.strokeStyle = ICON_GRID_COLOR;
  canvasCtx.lineWidth = 0.5;
  canvasCtx.beginPath();

  // Horizontal lines
  const rowH = (ICON_HEIGHT - 6) / 4;
  for (let i = 1; i <= 3; i++) {
    const ly = top + 3 + rowH * i;
    canvasCtx.moveTo(left + 2, ly);
    canvasCtx.lineTo(left + ICON_WIDTH - 2, ly);
  }

  // Vertical lines
  const colW = (ICON_WIDTH - 4) / 3;
  for (let i = 1; i <= 2; i++) {
    const lx = left + 2 + colW * i;
    canvasCtx.moveTo(lx, top + 3);
    canvasCtx.lineTo(lx, top + ICON_HEIGHT - 3);
  }

  canvasCtx.stroke();
  canvasCtx.restore();
}
