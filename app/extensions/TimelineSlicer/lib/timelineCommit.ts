//! FILENAME: app/extensions/TimelineSlicer/lib/timelineCommit.ts
// PURPOSE: THE commit of a timeline range a user gesture chose -- the mouse's
//          range drag (timelineRangeDrag.ts) and the keyboard inside a selected
//          timeline (timelineKeys.ts, M8 S8) -- and the Shift anchor memory the
//          next Shift+press extends from.
// CONTEXT: Moved here unchanged from timelineRangeDrag.ts `commitRange` (M8 S8,
//          an extraction that changes no behaviour) so both gestures ask ONE
//          rule. A copy of the date rule in the keyboard would be the drift
//          CLAUDE.md warns about: the first change to either would leave the
//          other committing a different range for the same periods.
//
//          THE RULES THIS FILE KEEPS:
//            - "Already the range" (no empty undo step) is a question about
//              DATES. The periods' `isSelected` flags cannot answer it: the
//              backend sets them by OVERLAP (timeline_slicer/commands.rs), so a
//              partial range flags whole periods, and a click on one of them
//              must still select all of it.
//            - ONE commit through `updateTimelineSelectionAsync` with
//              `askBeforeOverwrite` -- one undo step for the range and the
//              pivots it filters, one overwrite question.
//            - The committed range stays on screen until it LANDS
//              (timelineGestureView.ts `holdLandingRange`), so the old range
//              does not flash back between the commit and the refreshed flags.
//            - The ANCHOR the commit leaves is remembered for the session, by
//              the period's START DATE (an index means another period after a
//              level change or a refresh), with the level and the DATES of the
//              range it left; a later Shift+press uses it only while the range
//              shown still is exactly those dates at the same level
//              (`rememberedTimelineAnchor`).

import { requestOverlayRedraw } from "@api/gridOverlays";
import {
  getCachedTimelineData,
  getTimelineById,
  updateTimelineSelectionAsync,
} from "./timelineSlicerStore";
import { holdLandingRange, releaseLandingRange } from "./timelineGestureView";
import type { TimelineSpan } from "./timelineZones";

// ============================================================================
// The Shift+press anchor (session memory, per timeline)
// ============================================================================

/**
 * What the last range gesture on a timeline left: its ANCHOR period (by start
 * date -- an index means another period after a level change or a refresh),
 * the level it was made at, and the DATES of the range it committed.
 */
interface ShiftAnchor {
  level: string;
  anchorStart: string;
  start: string;
  end: string;
}

const shiftAnchors = new Map<string, ShiftAnchor>();

/**
 * The remembered anchor's period index for a Shift+press, or null when there
 * is none to trust: no gesture of this session left one, the level changed,
 * or the range SHOWN is no longer exactly the dates that gesture left (a
 * script, the backend or a refresh changed it) -- the anchor must lie inside it.
 */
export function rememberedTimelineAnchor(timelineId: string, level: string, shown: TimelineSpan): number | null {
  const a = shiftAnchors.get(timelineId);
  if (!a || a.level !== level) return null;
  const periods = getCachedTimelineData(timelineId)?.periods ?? [];
  if (shown.last >= periods.length) return null;
  if (periods[shown.first].startDate !== a.start || periods[shown.last].endDate !== a.end) return null;
  const index = periods.findIndex((p) => p.startDate === a.anchorStart);
  return index >= shown.first && index <= shown.last ? index : null;
}

/** Forget every remembered anchor (deactivation, tests). timelineRangeDrag.ts's reset calls it. */
export function resetTimelineCommit(): void {
  shiftAnchors.clear();
}

// ============================================================================
// The commit
// ============================================================================

/**
 * Commit periods `span` (indices into the timeline's CURRENT periods) as the
 * timeline's range, from a user gesture whose anchor was period `anchorIndex`.
 *
 * Writes nothing when the span is not within the periods, or when the
 * timeline's DATES already are exactly that span's (no empty undo step); the
 * anchor is remembered either way, while the range it leaves stands. Resolves
 * once the commit has LANDED (immediately when nothing was written); it never
 * rejects -- the store reports its own failures.
 */
export function commitTimelineSpan(timelineId: string, span: TimelineSpan, anchorIndex: number): Promise<void> {
  const periods = getCachedTimelineData(timelineId)?.periods ?? [];
  if (span.last >= periods.length) return Promise.resolve();
  const start = periods[span.first].startDate;
  const end = periods[span.last].endDate;
  const tl = getTimelineById(timelineId);
  // The next Shift+press extends from THIS gesture's anchor, while the range
  // it leaves stands (committed now, or already the range).
  if (tl && anchorIndex < periods.length) {
    shiftAnchors.set(timelineId, { level: tl.level, anchorStart: periods[anchorIndex].startDate, start, end });
  }
  if (tl && tl.selectionStart === start && tl.selectionEnd === end) return Promise.resolve();
  holdLandingRange(timelineId, span);
  return updateTimelineSelectionAsync(timelineId, start, end, { askBeforeOverwrite: true }).finally(() => {
    releaseLandingRange(timelineId, span);
    requestOverlayRedraw();
  });
}
