//! FILENAME: app/extensions/Controls/Button/actionGlyph.ts
// PURPOSE: How a floating button SHOWS its declarative action (Canvas contract
//          §4.4) -- the renderer half of Power BI's report buttons:
//            * Back draws a left arrow before its caption, Clear all slicers a
//              funnel with a cross (Power BI's Back and Clear-all-slicers
//              buttons carry those pictures; a reader recognises them before
//              reading the caption);
//            * a navigation button whose page is the one ON SCREEN is drawn
//              SELECTED (the pressed wash), the way a Power BI page navigator
//              marks the current page's button.
// CONTEXT: Kept out of floatingRenderer.ts so the decisions are testable
//          without a canvas, and light (nothing here imports the switch or the
//          slicer seam). Glyphs are vector paths in the caption colour -- no
//          font glyph, so nothing depends on the font having an arrow.

import type { ButtonAction } from "@api/buttonControlService";

/** The pictured actions; navigation is a caption only (a navigator's tabs). */
export type ButtonActionGlyph = "back" | "clearSlicers";

/** The glyph a button with `action` draws before its caption, or null. */
export function actionGlyphOf(action: ButtonAction | undefined): ButtonActionGlyph | null {
  if (!action) return null;
  if (action.kind === "back") return "back";
  if (action.kind === "clearSlicers") return "clearSlicers";
  return null;
}

/**
 * Whether a navigation button goes to the sheet that is active now. By ID when
 * BOTH the action and the active sheet (any kind: a navigate button may aim at
 * a worksheet) have one -- a page renamed while it is on screen is still the
 * page the button goes to, so its button keeps its current-page wash. By NAME
 * (ignoring case, as sheet names compare) only when either side has no id: a
 * button written before ids existed, or an active sheet the page list has not
 * read yet.
 */
export function isCurrentPageButton(
  action: ButtonAction | undefined,
  active: { sheetId?: string | null; sheetName?: string | null },
): boolean {
  if (!action || action.kind !== "navigate") return false;
  if (action.sheetId && active.sheetId) return action.sheetId === active.sheetId;
  if (!active.sheetName) return false;
  return action.sheetName.toLocaleLowerCase() === active.sheetName.toLocaleLowerCase();
}

/** The glyph's side and its gap to the caption, for a caption font size. */
export function actionGlyphMetrics(fontSize: number): { size: number; gap: number } {
  const size = Math.max(8, Math.round(fontSize * 0.95));
  return { size, gap: Math.max(3, Math.round(fontSize * 0.35)) };
}

/** The 2-D context calls a glyph uses (a test double needs only these). */
export type GlyphContext = Pick<
  CanvasRenderingContext2D,
  "beginPath" | "moveTo" | "lineTo" | "closePath" | "stroke" | "save" | "restore"
> & { lineWidth: number; strokeStyle: string | CanvasGradient | CanvasPattern; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin };

/**
 * Draw `glyph` in the square whose top-left is (x, y) and side `size`, in
 * `color`. Strokes only: the button's fill shows through, as Power BI's
 * outline icons do.
 */
export function drawActionGlyph(
  ctx: GlyphContext,
  glyph: ButtonActionGlyph,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.25, size / 9);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const px = (f: number) => x + f * size;
  const py = (f: number) => y + f * size;
  ctx.beginPath();
  if (glyph === "back") {
    // A left arrow: the shaft, then the head.
    ctx.moveTo(px(0.85), py(0.5));
    ctx.lineTo(px(0.15), py(0.5));
    ctx.moveTo(px(0.45), py(0.2));
    ctx.lineTo(px(0.15), py(0.5));
    ctx.lineTo(px(0.45), py(0.8));
  } else {
    // A funnel (the slicer's filter) ...
    ctx.moveTo(px(0.05), py(0.15));
    ctx.lineTo(px(0.65), py(0.15));
    ctx.lineTo(px(0.42), py(0.48));
    ctx.lineTo(px(0.42), py(0.85));
    ctx.lineTo(px(0.28), py(0.75));
    ctx.lineTo(px(0.28), py(0.48));
    ctx.closePath();
    // ... and the cross that clears it.
    ctx.moveTo(px(0.62), py(0.55));
    ctx.lineTo(px(0.95), py(0.88));
    ctx.moveTo(px(0.95), py(0.55));
    ctx.lineTo(px(0.62), py(0.88));
  }
  ctx.stroke();
  ctx.restore();
}
