//! FILENAME: app/extensions/TimelineSlicer/lib/timelineView.ts
// PURPOSE: What the user sees of a timeline RIGHT NOW: how far its periods are
//          scrolled (viewing state -- never saved, never undone), and the
//          ZONE under a canvas point, answered by the pure zone table
//          (timelineZones.ts) against the live store.
// CONTEXT: The scroll offsets lived in the renderer. They moved here so the
//          range drag (timelineRangeDrag.ts) can scroll the periods without
//          importing the renderer, which reads the drag's preview -- one
//          direction, no cycle.
//
//          `timelineOverlayZoneAt` is the overlay registration's `zoneAt`
//          (index.ts): the ONE answer Core derives the press, the hover
//          pointer and the meaning of Ctrl/Shift from (@api/gridOverlays
//          `resolveFloatingZone`), so a point the pointer shape promises to
//          the content is a point the press gives to the content (BUG-0258).
//          It is PURE: while a content gesture holds the button, the pointer
//          is the gesture's through Core's gesture-cursor seam
//          (`holdContentGestureCursor`, held by timelineRangeDrag.ts), never a
//          second answer from here.
//
//          The zone input places the range-end markers on the range the
//          renderer PAINTS (a released drag's, until its commit lands), read
//          from timelineGestureView.ts.

import type { OverlayHitTestContext, OverlayZoneFn } from "@api/gridOverlays";
import { getCachedTimelineData, getTimelineById } from "./timelineSlicerStore";
import { getTimelineRangePreview } from "./timelineGestureView";
import {
  computeTimelineLayout,
  maxScrollOf,
  timelineZoneAt,
  zoneInputOf,
  type TimelineZone,
  type TimelineZoneInput,
} from "./timelineZones";

// ============================================================================
// Scroll (viewing state)
// ============================================================================

const scrollOffsets = new Map<string, number>();

export function getScrollOffset(timelineId: string): number {
  return scrollOffsets.get(timelineId) ?? 0;
}

export function setScrollOffset(timelineId: string, offset: number): void {
  const max = getMaxScrollOffset(timelineId);
  scrollOffsets.set(timelineId, Math.max(0, Math.min(offset, max)));
}

export function getMaxScrollOffset(timelineId: string): number {
  const tl = getTimelineById(timelineId);
  if (!tl) return 0;
  const data = getCachedTimelineData(timelineId);
  if (!data) return 0;
  return maxScrollOf(computeTimelineLayout(tl, data.periods.length));
}

export function resetScrollOffsets(): void {
  scrollOffsets.clear();
}

// ============================================================================
// Zones against the live store
// ============================================================================

/**
 * The zone input of a timeline as it is SHOWN now -- its markers on the
 * range the renderer paints -- or null for an unknown id.
 */
export function liveTimelineZoneInput(timelineId: string): TimelineZoneInput | null {
  const tl = getTimelineById(timelineId);
  if (!tl) return null;
  const periods = getCachedTimelineData(timelineId)?.periods ?? [];
  return zoneInputOf(tl, periods, getScrollOffset(timelineId), getTimelineRangePreview(timelineId));
}

/**
 * The zone at a logical canvas point on the timeline whose canvas rectangle
 * is `bounds`; null off the rectangle or for an unknown id.
 */
export function timelineZoneAtCanvas(
  timelineId: string,
  canvasX: number,
  canvasY: number,
  bounds: { x: number; y: number; width: number; height: number },
): TimelineZone | null {
  const relX = canvasX - bounds.x;
  const relY = canvasY - bounds.y;
  if (relX < 0 || relY < 0 || relX > bounds.width || relY > bounds.height) return null;
  const input = liveTimelineZoneInput(timelineId);
  if (!input) return null;
  return timelineZoneAt(input, relX, relY);
}

/** The timeline a hit-test context's region carries, or null. */
function timelineIdOf(ctx: OverlayHitTestContext): string | null {
  const timelineId = ctx.region.data?.timelineId;
  return typeof timelineId === "string" && timelineId.length > 0 ? timelineId : null;
}

/** The zone Core's press or hover is over (the overlay hit-test context). */
export function timelineZoneOf(ctx: OverlayHitTestContext): TimelineZone | null {
  if (!ctx.floatingCanvasBounds) return null;
  const timelineId = timelineIdOf(ctx);
  if (timelineId === null) return null;
  return timelineZoneAtCanvas(timelineId, ctx.canvasX, ctx.canvasY, ctx.floatingCanvasBounds);
}

/**
 * The registration's `zoneAt`: the zone table's answer in Core's terms.
 *
 *   content  `{kind:'content', cursor, part}` -- Core selects the timeline as
 *            a PLAIN press and hands the press to `floatingObject:bodyDragStart`
 *            (index.ts starts the content gesture, with the raw Shift that
 *            extends a range); it never moves the timeline, locked or not.
 *   frame    `{kind:'frame', part}` with NO cursor of its own, so Core's
 *            answer applies: 'move' where the timeline can move, 'default'
 *            where it is locked or on a subscribed page.
 *
 * Null off the timeline (Core then treats the point as frame).
 */
export const timelineOverlayZoneAt: OverlayZoneFn = (ctx) => {
  const zone = timelineZoneOf(ctx);
  if (!zone) return null;
  if (zone.kind === "content") {
    return { kind: "content", cursor: zone.cursor ?? "default", part: zone.part };
  }
  return { kind: "frame", part: zone.part };
};
