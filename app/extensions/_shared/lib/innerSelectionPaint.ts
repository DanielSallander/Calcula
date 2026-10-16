//! FILENAME: app/extensions/_shared/lib/innerSelectionPaint.ts
// PURPOSE: The ONE look of a selection INSIDE a floating object (a floating
//          grid's local cells, a canvas pivot's cells) and of a reference pick's
//          drag preview over such an object (D-PICK). Two families painting the
//          same thing from two hand-copied colour lists drift on the first
//          change, so the colours and the strokes live here.
// CONTEXT: Sanctioned cross-extension code (extensions/_shared): it imports no
//          extension and nothing but the canvas API. Each family keeps its own
//          GEOMETRY (which cells a selection covers, where they sit in its box,
//          how the box is clipped); only the ink is shared. The caller clips.

/** Fill of an inner selection (moved from FloatingRange frRenderer COLORS.selectionFill). */
export const INNER_SELECTION_FILL = "rgba(33, 115, 70, 0.14)";
/** Border of an inner selection (moved from FloatingRange frRenderer COLORS.selectionBorder). */
export const INNER_SELECTION_BORDER = "#217346";
/** Stroke of a reference pick's drag preview: the formula-reference blue, never the selection green. */
export const PICK_PREVIEW_STROKE = "#1f6fd1";

/** A rectangle in the coordinates the caller paints in (canvas or box-local). */
export interface PaintRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function usable(r: PaintRect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

/**
 * Fill `pieces` except `active` (even-odd: the active cell stays clear, as in
 * the worksheet's own selection), then a 2px border round each piece. The
 * pieces are DISJOINT (one per frozen quadrant of a box, or one for a plain
 * grid); the caller clips to its viewport.
 */
export function paintInnerSelection(
  ctx: CanvasRenderingContext2D,
  pieces: readonly PaintRect[],
  active: PaintRect | null,
): void {
  const shown = pieces.filter(usable);
  if (shown.length === 0) return;
  ctx.save();
  ctx.beginPath();
  for (const p of shown) ctx.rect(p.x, p.y, p.width, p.height);
  if (active && usable(active)) ctx.rect(active.x, active.y, active.width, active.height);
  ctx.fillStyle = INNER_SELECTION_FILL;
  ctx.fill("evenodd");
  ctx.strokeStyle = INNER_SELECTION_BORDER;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  for (const p of shown) ctx.strokeRect(p.x + 1, p.y + 1, p.width - 2, p.height - 2);
  ctx.restore();
}

/**
 * A 1.5px dashed [4,3] rectangle per piece: what a reference pick's drag over
 * an object covers right now. Nothing is filled -- the object's own selection
 * (if any) stays readable underneath. The caller clips.
 */
export function paintPickPreview(ctx: CanvasRenderingContext2D, pieces: readonly PaintRect[]): void {
  const shown = pieces.filter(usable);
  if (shown.length === 0) return;
  ctx.save();
  ctx.strokeStyle = PICK_PREVIEW_STROKE;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  for (const p of shown) ctx.strokeRect(p.x + 0.75, p.y + 0.75, p.width - 1.5, p.height - 1.5);
  ctx.restore();
}
