//! FILENAME: app/src/core/lib/pointerPrecision.ts
// PURPOSE: TOUCH TARGETS (BUG-0729): while the pointer on the grid is a finger
//          or a pen, a handle or grip is hit within a 44 x 44 SCREEN px square
//          around it -- the size the platform accessibility rules ask of a
//          touch target -- instead of the few pixels a mouse needs.
// CONTEXT: Every hit test (floating handles and grip, the fill handle, the
//          header resize borders, a cell-anchored object's corner handles) is
//          the mouse door's own; the bridge (touchBridge.ts) hands a touch to
//          it as mouse events, and a pen arrives as compatibility mouse events.
//          So the precision is a fact about the LAST pointer the grid saw,
//          noted from its pointerdown / pointermove in the capture phase (both
//          come before the mouse events they cause), and a hit test asks it.
//          The painted chrome does not change: only where it can be grabbed.
//          A mouse pointer puts every target back to its own size at once.

/** A touch target's side, in SCREEN px (Windows' and WCAG's 44 px). */
export const TOUCH_TARGET_SCREEN_PX = 44;

let coarse = false;
/** The grid's zoom, as the installed grid reports it (1 until one is installed). */
let zoomOf: () => number = () => 1;

/** Note the kind of the pointer the grid just saw ("mouse", "pen", "touch"). */
export function notePointerType(pointerType: string | undefined | null): void {
  coarse = pointerType === "touch" || pointerType === "pen";
}

/** Whether the grid's pointer is a finger or a pen now. */
export function isCoarsePointer(): boolean {
  return coarse;
}

/** The grid's zoom (render factor), never 0. */
function zoomNow(): number {
  const z = zoomOf();
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** A hit rectangle in logical (zoom-divided) px. */
export interface HitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `rect` as the current pointer hits it: grown, about its centre, to at least
 * TOUCH_TARGET_SCREEN_PX screen px a side for a finger or a pen (logical px:
 * the screen size over the zoom); itself for a mouse.
 */
export function touchTarget(rect: HitRect, zoom: number = zoomNow()): HitRect {
  if (!coarse) return rect;
  const side = TOUCH_TARGET_SCREEN_PX / (zoom > 0 ? zoom : 1);
  const w = Math.max(rect.width, side);
  const h = Math.max(rect.height, side);
  return { x: rect.x + rect.width / 2 - w / 2, y: rect.y + rect.height / 2 - h / 2, width: w, height: h };
}

/**
 * The half-width of a line target (a header resize border) for the current
 * pointer, in logical px: `mouseHalf` for a mouse, half a touch target for a
 * finger or a pen -- never more than `cap` (half the line's own size, so a
 * narrow column's header keeps a middle that selects it).
 */
export function lineTargetHalf(mouseHalf: number, cap: number, zoom: number = zoomNow()): number {
  if (!coarse) return mouseHalf;
  const half = TOUCH_TARGET_SCREEN_PX / 2 / (zoom > 0 ? zoom : 1);
  return Math.max(mouseHalf, Math.min(half, cap));
}

/**
 * Follow the grid area's pointers: the kind of each pointerdown and
 * pointermove (a pen hovering moves too) decides the targets. Capture phase,
 * so the note is taken before any handler of the mouse events it causes.
 */
export function installPointerPrecision(element: HTMLElement, getZoom: () => number): () => void {
  zoomOf = getZoom;
  const note = (e: PointerEvent) => notePointerType(e.pointerType);
  element.addEventListener("pointerdown", note, true);
  element.addEventListener("pointermove", note, true);
  return () => {
    element.removeEventListener("pointerdown", note, true);
    element.removeEventListener("pointermove", note, true);
    if (zoomOf === getZoom) zoomOf = () => 1;
  };
}

/** Test seam: back to a mouse. */
export function resetPointerPrecisionForTests(): void {
  coarse = false;
  zoomOf = () => 1;
}
