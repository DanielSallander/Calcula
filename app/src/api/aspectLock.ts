//! FILENAME: app/src/api/aspectLock.ts
// PURPOSE: LOCK ASPECT RATIO (D-FORMAT `container.lockAspect`): the ONE rule
//          that turns a free resize into a ratio-keeping one.
// CONTEXT: Pure. Used by Core's resize drag (overlayResizeHandlers), by the
//          Size and Position dialog and by the Format pane's Properties card
//          (W/H rows), so a drag, a dialog edit and a card edit agree on what
//          "keep the ratio" means. In @api because Core may import @api and an
//          extension may not import Core.
//
//          The ratio is the ORIGINAL rect's (width / height). Which side
//          drives depends on the dragged edges:
//            - a corner (one horizontal AND one vertical edge): the dominant
//              change wins -- the axis whose relative change (new / old) is
//              farther from 1 -- and the rect stays anchored at the OPPOSITE
//              corner;
//            - the left or right edge only: the height follows the width, the
//              top edge stays fixed;
//            - the top or bottom edge only: the width follows the height, the
//              left edge stays fixed.
//          `fit: "shrink"` is the second pass after a page clamp or a snap cut
//          one dimension: the SMALLER relative size wins, so the other side
//          shrinks to match instead of growing back past the page.
//          Sizes are whole pixels (rounded) and never below `minSize`; the
//          fixed edges never move.

/** A rectangle in sheet px. */
export interface AspectLockRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The sides a resize drags (Core's DraggedEdges shape). */
export interface AspectLockEdges {
  left: boolean;
  top: boolean;
  right: boolean;
  bottom: boolean;
}

export interface AspectLockOptions {
  /**
   * "dominant" (default): the axis the user changed most drives (an edge
   * handle: its own axis). "shrink": the axis that is relatively SMALLER
   * drives -- for re-fitting after a clamp cut one dimension.
   */
  fit?: "dominant" | "shrink";
}

/**
 * The sides that MOVE when the lock is on: the dragged ones plus, for an edge
 * handle, the side that follows (a left/right edge moves the BOTTOM, a
 * top/bottom edge moves the RIGHT). A snap or page clamp after the lock must
 * treat those as dragged, or a following side could run past the page.
 */
export function aspectLockedEdges(edges: AspectLockEdges): AspectLockEdges {
  const horizontal = edges.left || edges.right;
  const vertical = edges.top || edges.bottom;
  if (horizontal && !vertical) return { ...edges, bottom: true };
  if (vertical && !horizontal) return { ...edges, right: true };
  return { ...edges };
}

/**
 * `next` (a free resize of `orig` by the handle dragging `edges`) with
 * `orig`'s width/height ratio restored. A degenerate `orig` (zero or
 * non-finite size) or no dragged edge returns `next` unchanged.
 */
export function applyAspectLock(
  orig: AspectLockRect,
  next: AspectLockRect,
  edges: AspectLockEdges,
  minSize: number,
  opts: AspectLockOptions = {},
): AspectLockRect {
  const ow = orig.width;
  const oh = orig.height;
  if (!(ow > 0) || !(oh > 0) || !Number.isFinite(ow) || !Number.isFinite(oh)) return { ...next };
  const horizontal = edges.left || edges.right;
  const vertical = edges.top || edges.bottom;
  if (!horizontal && !vertical) return { ...next };

  const sw = next.width / ow;
  const sh = next.height / oh;
  let s: number;
  if (opts.fit === "shrink") {
    s = Math.min(sw, sh);
  } else if (horizontal && vertical) {
    s = Math.abs(sw - 1) >= Math.abs(sh - 1) ? sw : sh;
  } else {
    s = horizontal ? sw : sh;
  }
  if (!Number.isFinite(s) || s <= 0) s = 0;
  const floor = Math.max(0, minSize);
  s = Math.max(s, floor / ow, floor / oh);

  const width = Math.max(floor, Math.round(ow * s));
  const height = Math.max(floor, Math.round(oh * s));

  // Anchors: a dragged left edge (alone on its axis) keeps the RIGHT edge; a
  // dragged top edge keeps the BOTTOM edge; everything else keeps left / top.
  const keepRight = edges.left && !edges.right;
  const keepBottom = edges.top && !edges.bottom;
  const x = keepRight ? next.x + next.width - width : next.x;
  const y = keepBottom ? next.y + next.height - height : next.y;
  return { x, y, width, height };
}
