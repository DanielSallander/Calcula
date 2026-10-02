//! FILENAME: app/extensions/TimelineSlicer/lib/timelinePendingClick.ts
// PURPOSE: The timeline's PENDING CLICK — armed by a press on a timeline
//          (`floatingObject:selected`, Core's filtered press). Three things
//          end it: a press on the timeline's CONTENT takes it at
//          `floatingObject:bodyDragStart` (the content gesture owns that
//          press's release -- lib/timelineRangeDrag.ts); Core's move of the
//          FRAME clears it (moveComplete); otherwise the press's own mouseup
//          completes it as a click on the frame, which only narrows a kept
//          multi-selection to the timeline pressed. It never selects a
//          period, and nothing reads where the pointer is (BUG-0258: every
//          period, range-end and button click is the content gesture's).
// CONTEXT: The twin of Slicer/lib/slicerPendingClick.ts, and it moved out of
//          index.ts for the same reason: ONLY a real mouse press may arm it. A
//          keyboard or script selection (@api/objectSelection) that armed it
//          would turn the user's next unrelated mouseup into a click on the
//          timeline.

export interface PendingTimelineClick {
  timelineId: string;
  /** Narrow a kept multi-selection to this timeline at the release. */
  deferNarrow?: boolean;
}

let pending: PendingTimelineClick | null = null;

/** Arm the click a mouse press on a timeline body starts. */
export function armPendingTimelineClick(click: PendingTimelineClick): void {
  pending = click;
}

/** Take (and clear) the armed click, if any — the release's (or a content press's) job. */
export function takePendingTimelineClick(): PendingTimelineClick | null {
  const click = pending;
  pending = null;
  return click;
}

/** Drop an armed click (a drag completed, the extension deactivated). */
export function clearPendingTimelineClick(): void {
  pending = null;
}

/** The armed click, left in place. For tests and diagnostics. */
export function peekPendingTimelineClick(): PendingTimelineClick | null {
  return pending;
}
