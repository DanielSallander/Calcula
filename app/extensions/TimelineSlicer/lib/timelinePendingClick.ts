//! FILENAME: app/extensions/TimelineSlicer/lib/timelinePendingClick.ts
// PURPOSE: The timeline's PENDING CLICK — armed by a left press on a timeline
//          body (`floatingObject:selected`), completed by the next `mouseup`
//          anywhere, which acts on whatever period sits under the pointer.
// CONTEXT: The twin of Slicer/lib/slicerPendingClick.ts, and it moved out of
//          index.ts for the same reason: ONLY a real mouse press may arm it. A
//          keyboard or script selection (@api/objectSelection) that armed it
//          would turn the user's next unrelated mouseup into a period click at
//          wherever the pointer happens to be.

export interface PendingTimelineClick {
  timelineId: string;
  /** Narrow a kept multi-selection to this timeline on mouseup. */
  deferNarrow?: boolean;
}

let pending: PendingTimelineClick | null = null;

/** Arm the click a mouse press on a timeline body starts. */
export function armPendingTimelineClick(click: PendingTimelineClick): void {
  pending = click;
}

/** Take (and clear) the armed click, if any — the mouseup's job. */
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
