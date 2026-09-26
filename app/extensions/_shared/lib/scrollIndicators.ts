//! FILENAME: app/extensions/_shared/lib/scrollIndicators.ts
// PURPOSE: The thin overlay scroll bars a scrolled floating object paints over
//          its own content, on each axis that actually overflows.
// CONTEXT: Moved here from the canvas pivot box (Pivot/rendering/
//          pivotVisualRenderer.ts, where it was module-private and read the
//          pivot's geometry directly) so the floating grid (FloatingRange, M7)
//          shows the SAME affordance. The pivot-shaped inputs became plain
//          numbers; the pivot passes the values it used to read, so its paint is
//          unchanged op for op.
//
//          The bars sit OVER the content (no space is reserved), like an overlay
//          scrollbar, so they never change the geometry the object hit-tests
//          with. They are an indication, not a control: nothing hit-tests them.

/** Thickness of the overlay scroll indicators. */
export const SCROLL_INDICATOR_SIZE = 4;
/** Shortest thumb, so a very long content still shows a grabbable-looking mark. */
export const SCROLL_INDICATOR_MIN_THUMB = 16;

const TRACK_FILL = "rgba(0, 0, 0, 0.06)";
const THUMB_FILL = "rgba(0, 0, 0, 0.32)";

export interface ScrollIndicatorArgs {
  /** The scrolling box, in the context's CURRENT coordinates (after any translate). */
  box: { x: number; y: number; width: number; height: number };
  /** The scroll origin, already clamped to [0, max]. */
  scroll: { left: number; top: number };
  /** How far each axis can scroll; an axis with 0 paints no bar. */
  maxScroll: { maxLeft: number; maxTop: number };
  /** The full content size, INCLUDING any frozen band. */
  content: { width: number; height: number };
  /** A frozen band at the top / left of the box that does not scroll (0 when none). */
  frozen?: { width: number; height: number };
}

/**
 * Paint a track + thumb at the right edge (vertical) and bottom edge
 * (horizontal) of `box`, each only when that axis overflows. The vertical
 * track starts below a frozen header band and the horizontal one right of a
 * frozen label band, since only the part between them scrolls.
 */
export function paintScrollIndicators(ctx: CanvasRenderingContext2D, args: ScrollIndicatorArgs): void {
  const { box, scroll: s, content } = args;
  const { maxLeft, maxTop } = args.maxScroll;
  const frozenWidth = args.frozen?.width ?? 0;
  const frozenHeight = args.frozen?.height ?? 0;

  ctx.save();
  if (maxTop > 0) {
    const trackTop = frozenHeight;
    const trackLen = box.height - frozenHeight - (maxLeft > 0 ? SCROLL_INDICATOR_SIZE : 0);
    const bodyContent = content.height - frozenHeight;
    if (trackLen > 0 && bodyContent > 0) {
      const thumbLen = Math.max(
        SCROLL_INDICATOR_MIN_THUMB,
        trackLen * Math.min(1, (box.height - frozenHeight) / bodyContent),
      );
      const thumbTop = trackTop + (trackLen - thumbLen) * (s.top / maxTop);
      ctx.fillStyle = TRACK_FILL;
      ctx.fillRect(box.x + box.width - SCROLL_INDICATOR_SIZE, box.y + trackTop, SCROLL_INDICATOR_SIZE, trackLen);
      ctx.fillStyle = THUMB_FILL;
      ctx.fillRect(box.x + box.width - SCROLL_INDICATOR_SIZE, box.y + thumbTop, SCROLL_INDICATOR_SIZE, thumbLen);
    }
  }
  if (maxLeft > 0) {
    const trackLeft = frozenWidth;
    const trackLen = box.width - frozenWidth - (maxTop > 0 ? SCROLL_INDICATOR_SIZE : 0);
    const bodyContent = content.width - frozenWidth;
    if (trackLen > 0 && bodyContent > 0) {
      const thumbLen = Math.max(
        SCROLL_INDICATOR_MIN_THUMB,
        trackLen * Math.min(1, (box.width - frozenWidth) / bodyContent),
      );
      const thumbLeft = trackLeft + (trackLen - thumbLen) * (s.left / maxLeft);
      ctx.fillStyle = TRACK_FILL;
      ctx.fillRect(box.x + trackLeft, box.y + box.height - SCROLL_INDICATOR_SIZE, trackLen, SCROLL_INDICATOR_SIZE);
      ctx.fillStyle = THUMB_FILL;
      ctx.fillRect(box.x + thumbLeft, box.y + box.height - SCROLL_INDICATOR_SIZE, thumbLen, SCROLL_INDICATOR_SIZE);
    }
  }
  ctx.restore();
}
