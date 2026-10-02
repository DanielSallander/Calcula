//! FILENAME: app/extensions/TimelineSlicer/lib/timelineKeyFocus.ts
// PURPOSE: The keyboard's INNER focus in a selected timeline (M8 S8, BUG-0258
//          design part 2 "Keyboard and touch"): which period the arrow keys
//          are on, and where a Shift+arrow preview is anchored.
// CONTEXT: Enter on a selected timeline goes INTO it (lib/timelineKeys.ts);
//          Left and Right then move a focus ring between its periods,
//          Shift+Left / Shift+Right grow a PREVIEW from an anchor, Enter or
//          Space commits, and Escape drops the preview, then leaves. This
//          module is only the state and its change listeners -- a LEAF (no
//          store, no @api), so the renderer, the key handler and the
//          object-selection provider can all read it without a cycle. The
//          Slicer's twin is Slicer/lib/slicerKeyFocus.ts.
//
//          THE RULES THIS FILE KEEPS:
//            - VIEW state (plan decision KD2): never saved, never undone, no
//              DocumentEffect, no Tauri command. Nothing here writes to the
//              backend -- the preview is shown, not committed.
//            - A period is identified by its START DATE, never by its index:
//              an index names another period after a level change or a
//              refresh (the Shift anchor memory's rule, timelineCommit.ts).
//            - The focus is held AT A LEVEL. A level change, or a refresh that
//              removes the focused period, ENDS it (plan S8): there is no
//              "nearest period" across levels that the user would recognise.

export interface TimelineKeyFocus {
  /** The timeline the keyboard is inside. */
  readonly timelineId: string;
  /** The level the focus was taken at (another level ends it). */
  readonly level: string;
  /** The focused period, by its start date. */
  readonly periodStart: string;
  /**
   * Where the Shift+arrow preview is anchored (a period's start date), or null
   * when no preview is live. The preview is anchor..focus, in either order.
   */
  readonly anchorStart: string | null;
}

let focus: TimelineKeyFocus | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (err) {
      console.error("[TimelineSlicer] a key-focus listener threw:", err);
    }
  }
}

/** The live inner focus, or null when the keyboard is not inside a timeline. */
export function getTimelineKeyFocus(): TimelineKeyFocus | null {
  return focus;
}

/** Whether the keyboard is inside some timeline (it owns the arrows and Escape). */
export function isTimelineKeyFocusActive(): boolean {
  return focus !== null;
}

/** Enter a timeline, or move within it. Listeners hear every change. */
export function setTimelineKeyFocus(next: TimelineKeyFocus): void {
  focus = { ...next };
  changed();
}

/** Leave the timeline (no-op, and silent, when the keyboard is not inside one). */
export function leaveTimelineKeyFocus(): void {
  if (focus === null) return;
  focus = null;
  changed();
}

/** Hear every change of the inner focus (enter, move, preview, leave). Returns the unsubscribe. */
export function onTimelineKeyFocusChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop the focus WITHOUT telling anyone (deactivation, tests). */
export function resetTimelineKeyFocus(): void {
  focus = null;
}

/**
 * Where the focus is NOW, against the timeline's current level and periods:
 * the focused period's index and the preview anchor's (null when no preview
 * is live, or when the anchor's period is gone). PURE: the painter and the key
 * handler both ask this, so the ring is drawn where the next key acts.
 *
 * Null -- the focus ends -- when the level is not the one the focus was taken
 * at, or the focused period is no longer listed.
 */
export function resolveTimelineFocus(
  f: Pick<TimelineKeyFocus, "level" | "periodStart" | "anchorStart">,
  level: string,
  periodStarts: readonly string[],
): { index: number; anchorIndex: number | null } | null {
  if (f.level !== level) return null;
  const index = periodStarts.indexOf(f.periodStart);
  if (index < 0) return null;
  const anchor = f.anchorStart === null ? -1 : periodStarts.indexOf(f.anchorStart);
  return { index, anchorIndex: anchor >= 0 ? anchor : null };
}
