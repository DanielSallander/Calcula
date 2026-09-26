//! FILENAME: app/extensions/Pivot/rendering/pivotStatusPainters.ts
// PURPOSE: The two "no view to show" states of a pivot, painted into a RECT:
//          the empty-pivot placeholder ("Click in this area...") and the
//          loading indicator (dim, progress bar, stage text, Cancel button).
// CONTEXT: A worksheet pivot's rect comes from its cells; a canvas pivot's rect
//          is its designer-sized box. Both paths call these, so the two looks
//          cannot drift apart. The caller owns clipping; these only draw.

/** The loading state the painter needs (structural: pivotViewStore's own type). */
export interface PivotLoadingPaintState {
  stage: string;
  stageIndex: number;
  totalStages: number;
  /** `performance.now()` when the operation started. */
  startedAt: number;
}

export interface PaintRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Paint the empty-pivot placeholder inside `rect`: the pivot's name in a small
 * bordered box at the top centre, and the "Click in this area..." hint centred
 * below it when the rect is big enough to hold it.
 */
export function paintPivotPlaceholderContent(
  ctx: CanvasRenderingContext2D,
  rect: PaintRect,
  pivotName: string,
): void {
  const name = pivotName || "PivotTable";
  const nameBoxPadding = 8;
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  const nameWidth = ctx.measureText(name).width;
  const nameBoxWidth = nameWidth + nameBoxPadding * 2;
  const nameBoxHeight = 24;
  const nameBoxX = rect.x + (rect.width - nameBoxWidth) / 2;
  const nameBoxY = rect.y + 10;

  // Name box background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(nameBoxX, nameBoxY, nameBoxWidth, nameBoxHeight);
  // Name box border
  ctx.strokeStyle = "#b0b0b0";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(
    Math.floor(nameBoxX) + 0.5,
    Math.floor(nameBoxY) + 0.5,
    nameBoxWidth,
    nameBoxHeight,
  );
  // Name text
  ctx.fillStyle = "#333333";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, nameBoxX + nameBoxWidth / 2, nameBoxY + nameBoxHeight / 2);

  // Centered instruction text below the name box
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2 + 10;

  if (rect.width > 120 && rect.height > 60) {
    ctx.fillStyle = "#888888";
    ctx.font = "12px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Click in this area to work with", centerX, centerY - 8);
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = "#aaaaaa";
    ctx.fillText("the PivotTable report", centerX, centerY + 8);
  }
}

/** Cancel button appears after this long, so a fast operation does not flicker one. */
const CANCEL_DELAY_MS = 1000;

/**
 * Paint the loading indicator over the (dimmed) previous view inside `rect`.
 * Returns the Cancel button's rect (in the same coordinates as `rect`) once it
 * is showing, else null. The caller stores it for its click handling.
 */
export function paintPivotLoadingIndicator(
  ctx: CanvasRenderingContext2D,
  rect: PaintRect,
  state: PivotLoadingPaintState,
  now: number = performance.now(),
): PaintRect | null {
  const { x: startX, y: startY, width } = rect;
  if (width <= 0 || rect.height <= 0) return null;

  // Semi-transparent overlay to dim the previous view
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.fillRect(startX, startY, width, rect.height);

  // Indeterminate progress bar (3px, animated at the top of the rect)
  const BAR_HEIGHT = 3;
  const elapsed = now - state.startedAt;
  const barWidth = width * 0.3;
  const period = 1500; // ms for one full sweep
  const progress = (elapsed % period) / period;
  // Smooth ease-in-out using sine
  const eased = 0.5 - 0.5 * Math.cos(progress * Math.PI * 2);
  const barX = startX + (width - barWidth) * eased;

  ctx.fillStyle = "#5B9BD5";
  ctx.fillRect(barX, startY, barWidth, BAR_HEIGHT);

  // Stage text with step indicator, e.g. "Calculating... (2/4)"
  const { stage, stageIndex, totalStages } = state;
  const stepText = totalStages > 0 ? `${stage} (${stageIndex + 1}/${totalStages})` : stage;

  // Text and cancel button just below the progress bar (fixed at top)
  const textY = startY + BAR_HEIGHT + 16;
  const centerX = startX + width / 2;

  ctx.fillStyle = "#555555";
  ctx.font = "13px Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(stepText, centerX, textY);

  if (elapsed <= CANCEL_DELAY_MS) return null;

  const btnWidth = 70;
  const btnHeight = 24;
  const btnX = centerX - btnWidth / 2;
  const btnY = textY + 14;

  // Button background
  ctx.fillStyle = "#e5e7eb";
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(btnX, btnY, btnWidth, btnHeight, 4);
  ctx.fill();
  ctx.stroke();

  // Button text
  ctx.fillStyle = "#374151";
  ctx.font = "12px Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Cancel", btnX + btnWidth / 2, btnY + btnHeight / 2);

  return { x: btnX, y: btnY, width: btnWidth, height: btnHeight };
}
