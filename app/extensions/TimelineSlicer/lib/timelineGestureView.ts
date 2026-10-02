//! FILENAME: app/extensions/TimelineSlicer/lib/timelineGestureView.ts
// PURPOSE: What a timeline's CONTENT gesture shows while it lives, and while
//          its commit lands: the range to paint. State only -- a leaf with no
//          runtime imports.
// CONTEXT: Two readers must agree on this (BUG-0258 review):
//            - the renderer paints the range from it;
//            - the zone input (timelineView.ts) places the range-end markers
//              on it, so what is painted is what a press hits -- a released
//              drag's range was painted at once while its markers were still
//              hit-tested at the OLD committed range until the commit landed.
//          The POINTER the gesture owns is not here: Core's hover keeps asking
//          while the button is held, and the gesture answers it through Core's
//          own seam (@api/gridOverlays `holdContentGestureCursor`, held and
//          released by timelineRangeDrag.ts), so the zone answer stays pure.
//          timelineRangeDrag.ts writes the live gesture; the commit rule both
//          gestures share (timelineCommit.ts) writes the landing range; the
//          keyboard inside a timeline (timelineKeys.ts, M8 S8) writes its OWN
//          slot, the Shift+arrow preview -- its own, so neither writer can end
//          the other's: a pointer press that ends the keyboard's focus starts
//          a drag in the same event, and clearing a shared slot there would
//          erase the drag's range. timelineRangeDrag.ts imports
//          timelineView.ts, so this state cannot live in either of them
//          without a cycle.

import type { TimelineSpan } from "./timelineZones";

/** The live gesture as the screen shows it. */
export interface TimelineGestureView {
  timelineId: string;
  /** The range a range drag would commit now; null for a button or scrollbar. */
  span: TimelineSpan | null;
}

let live: TimelineGestureView | null = null;

/**
 * The range a released drag committed, kept on screen until the commit has
 * LANDED -- otherwise the old range flashes back between the release and the
 * refreshed period flags.
 */
const landing = new Map<string, TimelineSpan>();

/** Show (or, with null, stop showing) the live gesture. The drag's only. */
export function showTimelineGesture(view: TimelineGestureView | null): void {
  live = view;
}

/** Hold a released range on screen until its commit lands. The drag's only. */
export function holdLandingRange(timelineId: string, span: TimelineSpan): void {
  landing.set(timelineId, span);
}

/** Let go of a landed range -- only if a newer release has not replaced it. */
export function releaseLandingRange(timelineId: string, span: TimelineSpan): void {
  if (landing.get(timelineId) === span) landing.delete(timelineId);
}

/**
 * The keyboard's Shift+arrow PREVIEW (timelineKeys.ts): a range that is shown
 * and never written until Enter or Space commits it. Its own slot (see the
 * header). Nothing here reaches the backend.
 */
let keyPreview: TimelineGestureView | null = null;

/** Show (or, with null, stop showing) the keyboard's preview. The keyboard's only. */
export function showTimelineKeyPreview(view: TimelineGestureView | null): void {
  keyPreview = view;
}

/**
 * The range to PAINT (and to place the markers on) for a timeline instead of
 * its committed one: the live drag's, else the keyboard's Shift+arrow
 * preview, else a released commit's until it lands. Null otherwise.
 */
export function getTimelineRangePreview(timelineId: string): TimelineSpan | null {
  if (live && live.timelineId === timelineId && live.span) return live.span;
  if (keyPreview && keyPreview.timelineId === timelineId && keyPreview.span) return keyPreview.span;
  return landing.get(timelineId) ?? null;
}

/** Forget everything (deactivation, tests). */
export function resetTimelineGestureView(): void {
  live = null;
  keyPreview = null;
  landing.clear();
}
