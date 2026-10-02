//! FILENAME: app/src/core/lib/gridRenderer/rendering/floatingObjectChrome.ts
// PURPOSE: Core paints the SELECTION CHROME of every selected floating object:
//          one outline in one colour, and the resize handles -- from the SAME
//          geometry and the same liveness rule the resize hit test reads
//          (core/lib/floatingHandles.ts), so a handle is painted exactly where
//          it can be grabbed and nowhere else (BUG-0258 design phase 3).
// CONTEXT: Before this, every family painted its own chrome in its own
//          renderer: charts a 2px inset frame with 6px squares INSIDE the
//          corners, shapes and pictures eight squares of which only four
//          worked, slicers and timelines a half-clipped #0078D4 border and no
//          handles at all (while their corners were live), the pivot box a
//          frame outside the box with white squares, the floating grid its own
//          frame and corner squares, and the canvas a copy of the chart's for
//          the members the selection set held. A family now paints NO selection
//          chrome; what it keeps is chrome of its OWN affordances (a chart's
//          quick-access buttons, the floating grid's yellow edge balls).
//
//          Painted by renderGrid after every floating object and before the
//          "over-selection" grid layers:
//            - after every object, so a selected object's handles show above
//              an object stacked over it -- and floatingHandleAt lets no body
//              occlude a live handle, so they are grabbable there too;
//            - before the layers, so a canvas's padlock (CanvasSheet
//              lib/selectionChrome.ts paintLockMarks) paints over the outline.
//
//          Order: the exact REVERSE of `floatingHitOrder`, so where two
//          selected objects' handles overlap, the handle painted last is the
//          one a press grabs.
//
//          A LOCKED object, an object on a subscribed page and one whose family
//          published `resizable: false` get the outline and NO handles (the
//          liveness rule): the outline says "selected", a handle would promise
//          a resize the press refuses.
//
//          THE GRIP (BUG-0258 design phase 5) is painted here too, by
//          `paintFloatingGrips`, from core/lib/floatingGrip.ts -- the geometry,
//          the visibility rule and the zoom its hit test reads. renderGrid
//          calls it just BEFORE the selection chrome, so a handle overlapping
//          a grip is painted over it, as the press prefers the handle.

import type { GridConfig, Viewport } from "../../../types";
import { floatingHitOrder, type GridRegion } from "../../../../api/gridOverlays";
import { isObjectInSelection } from "../../../../api/objectSelection";
import {
  FLOATING_SELECTION_COLOUR,
  floatingCanvasRect,
  floatingHandleGeometry,
  floatingHandleMode,
  floatingHandlesLive,
} from "../../floatingHandles";
import { currentGripEnv, floatingGripOf, floatingGripShown } from "../../floatingGrip";
import { FLOATING_GRIP_HOVER_INK, FLOATING_GRIP_HOVER_PLATE } from "../../floatingHandleMetrics";
import { rowHeaderGutter, colHeaderGutter } from "../layout/headerVisibility";

/** Width of the selection outline, in logical px (drawn INSIDE the object's edge). */
export const FLOATING_SELECTION_OUTLINE_WIDTH = 2;

/**
 * The plate under each handle: a 1px white border around the coloured
 * square, so a handle reads over any content (a dark chart, a picture).
 */
export const FLOATING_HANDLE_PLATE = "#ffffff";

/**
 * Paint the selection chrome of every SELECTED floating region of
 * `surfaceRegions` (family-held or held by the canvas selection set): the
 * outline always, the handles only while they are live. `config` is the
 * EFFECTIVE config the overlays were painted with (its gutters are the painted
 * ones).
 */
export function paintFloatingSelectionChrome(
  ctx: CanvasRenderingContext2D,
  surfaceRegions: readonly GridRegion[],
  config: GridConfig,
  viewport: Viewport,
): void {
  const gutters = { rowHeaderWidth: rowHeaderGutter(config), colHeaderHeight: colHeaderGutter(config) };
  const scroll = { scrollX: viewport.scrollX || 0, scrollY: viewport.scrollY || 0 };
  const order = floatingHitOrder(surfaceRegions).reverse();

  let opened = false;
  for (const region of order) {
    if (!isObjectInSelection(region)) continue;
    const rect = floatingCanvasRect(region, gutters, scroll);
    if (!rect) continue;
    if (!opened) {
      ctx.save();
      ctx.setLineDash([]);
      opened = true;
    }

    ctx.strokeStyle = FLOATING_SELECTION_COLOUR;
    ctx.lineWidth = FLOATING_SELECTION_OUTLINE_WIDTH;
    ctx.strokeRect(
      rect.x + FLOATING_SELECTION_OUTLINE_WIDTH / 2,
      rect.y + FLOATING_SELECTION_OUTLINE_WIDTH / 2,
      Math.max(0, rect.width - FLOATING_SELECTION_OUTLINE_WIDTH),
      Math.max(0, rect.height - FLOATING_SELECTION_OUTLINE_WIDTH),
    );

    if (!floatingHandlesLive(region)) continue;
    for (const handle of floatingHandleGeometry(rect, floatingHandleMode(region))) {
      const p = handle.paint;
      ctx.fillStyle = FLOATING_HANDLE_PLATE;
      ctx.fillRect(p.x - 1, p.y - 1, p.width + 2, p.height + 2);
      ctx.fillStyle = FLOATING_SELECTION_COLOUR;
      ctx.fillRect(p.x, p.y, p.width, p.height);
    }
  }
  if (opened) ctx.restore();
}

/**
 * Paint the six-dot GRIP of every floating region of `surfaceRegions` whose
 * grip shows (core/lib/floatingGrip.ts `floatingGripShown`: a region
 * publishing `grip: "hover"` while hovered or selected, and on a canvas the
 * selection's primary member; never on a locked, immovable or subscribed
 * object, nor while a gesture or a reference pick is live) -- from the SAME
 * geometry the grip's hit test reads, at the zoom it reads.
 *
 * renderGrid calls this after every floating object and immediately BEFORE
 * `paintFloatingSelectionChrome`: a grip sits over any neighbour it overlaps
 * (and wins its press there), while a Core handle that overlaps a grip is
 * painted over it -- the press scans the handles first. Order: the reverse of
 * `floatingHitOrder`, so where two grips overlap the one painted last is the
 * one a press takes.
 *
 * A SELECTED object's grip is a selection-blue plate with white dots; a grip
 * shown only because its object is HOVERED is a white plate with a grey border
 * and grey dots.
 */
export function paintFloatingGrips(
  ctx: CanvasRenderingContext2D,
  surfaceRegions: readonly GridRegion[],
  config: GridConfig,
  viewport: Viewport,
): void {
  const env = currentGripEnv(surfaceRegions);
  if (env.blocked) return;
  const gutters = { rowHeaderWidth: rowHeaderGutter(config), colHeaderHeight: colHeaderGutter(config) };
  const scroll = { scrollX: viewport.scrollX || 0, scrollY: viewport.scrollY || 0 };
  const page = env.surface?.page ?? null;

  let opened = false;
  for (const region of floatingHitOrder(surfaceRegions).reverse()) {
    if (!floatingGripShown(region, env)) continue;
    const grip = floatingGripOf(region, gutters, scroll, env.zoom, page);
    if (!grip) continue;
    if (!opened) {
      ctx.save();
      ctx.setLineDash([]);
      opened = true;
    }
    const selected = isObjectInSelection(region);
    const p = grip.plate;
    ctx.fillStyle = selected ? FLOATING_SELECTION_COLOUR : FLOATING_GRIP_HOVER_PLATE;
    ctx.fillRect(p.x, p.y, p.width, p.height);
    if (!selected) {
      // One SCREEN px, inside the plate, whatever the zoom.
      const line = 1 / env.zoom;
      ctx.strokeStyle = FLOATING_GRIP_HOVER_INK;
      ctx.lineWidth = line;
      ctx.strokeRect(p.x + line / 2, p.y + line / 2, Math.max(0, p.width - line), Math.max(0, p.height - line));
    }
    ctx.fillStyle = selected ? FLOATING_HANDLE_PLATE : FLOATING_GRIP_HOVER_INK;
    for (const d of grip.dots) {
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, grip.dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (opened) ctx.restore();
}
