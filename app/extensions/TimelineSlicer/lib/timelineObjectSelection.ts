//! FILENAME: app/extensions/TimelineSlicer/lib/timelineObjectSelection.ts
// PURPOSE: The TimelineSlicer's provider for @api/objectSelection — select,
//          deselect and report timelines for a caller that is NOT a mouse press
//          (a canvas sheet's Tab / Shift+Tab / Escape, its click on the page).
// CONTEXT: The mouse route (`floatingObject:selected` in index.ts) arms a
//          PENDING CLICK the next mouseup anywhere completes, and reads the
//          Ctrl state of the last real mouse press. A keyboard selection wants
//          neither: this provider selects exactly one timeline (never
//          additive), shows the contextual Timeline tab as a click does, and
//          arms nothing.

import type { GridRegion } from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { canvasObjectRef } from "@api/canvasSheet";
import {
  deselectTimeline,
  isTimelineSelected,
  selectTimeline,
} from "../handlers/selectionHandler";
import { deleteTimelinesReporting, getTimelineById } from "./timelineSlicerStore";
import { isTimelineContentGestureActive } from "./timelineRangeDrag";
import { isTimelineKeyFocusActive } from "./timelineKeyFocus";
import { isTimelineContextMenuOpen } from "./timelineMenuState";

/** The `GridRegion.type` timelines publish (see timelineSlicerStore). */
export const TIMELINE_REGION_TYPE = "timeline-slicer";

/** The timeline id a published region carries, or null. */
export function timelineIdOf(region: GridRegion): string | null {
  const id = region.data?.timelineId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The provider object (exported for tests; register it through
 *  `registerTimelineObjectSelection`). */
export function createTimelineSelectionProvider(): ObjectSelectionProvider {
  return {
    types: [TIMELINE_REGION_TYPE],

    isSelected(region: GridRegion): boolean {
      const id = timelineIdOf(region);
      return id !== null && isTimelineSelected(id);
    },

    select(region: GridRegion): void {
      const id = timelineIdOf(region);
      if (id === null) return;
      // Exclusive: a keyboard step selects ONE object. The handler ignores an
      // id the store does not hold.
      selectTimeline(id, false);
    },

    deselectAll(): void {
      // No-op (and no repaint) when nothing is selected.
      deselectTimeline();
    },

    // While a range drag (or a press on a timeline button or scrollbar) is
    // live, Escape CANCELS it (lib/timelineRangeDrag.ts). Owning the key keeps
    // a canvas's Escape binding from also deselecting the timeline under the
    // pointer -- that binding runs first, in the keybinding dispatcher. And
    // while the KEYBOARD is inside a timeline (lib/timelineKeys.ts, M8 S8)
    // Escape drops its preview or leaves the periods -- the timeline stays
    // selected -- and the arrows move the focus ring: a canvas's Escape and
    // arrow-nudge bindings run first and stand down on this answer.
    //
    // Delete / Backspace (BUG-0270): a SELECTED timeline is deleted by the
    // generic object Delete (ObjectPosition lib/selectedObjectKeys.ts), which
    // asks this first. Inside, the keys are refused by the inside claim
    // (lib/timelineKeys.ts) -- they must never delete the timeline the
    // keyboard is in; nor, during a live range drag, the timeline under it.
    //
    // The timeline's right-click MENU, while open, owns both keys too
    // (BUG-0270 review). It takes no focus, so the grid keeps the keyboard:
    // Delete deleted the timeline BEHIND the open menu, and the generic
    // Escape deselected it and left the menu standing (the BUG-0196 pattern;
    // the menu now closes itself on Escape, handlers/timelineSlicerContextMenu.ts).
    ownsKey(key): boolean {
      if (key === "Escape" || key === "Delete") {
        return isTimelineContentGestureActive() || isTimelineKeyFocusActive() || isTimelineContextMenuOpen();
      }
      return key === "Arrow" && isTimelineKeyFocusActive();
    },

    refOf(region: GridRegion) {
      const id = timelineIdOf(region);
      return id === null ? null : canvasObjectRef("timelineSlicer", id);
    },

    // The timeline family holds several (its Ctrl+click set), so a canvas
    // multi-selection keeps every timeline in it. `selectTimeline(id, true)`
    // TOGGLES, so it is only called when the answer is a change.
    addToSelection(region: GridRegion): void {
      const id = timelineIdOf(region);
      if (id === null || isTimelineSelected(id)) return;
      selectTimeline(id, true);
    },

    removeFromSelection(region: GridRegion): void {
      const id = timelineIdOf(region);
      if (id === null || !isTimelineSelected(id)) return;
      selectTimeline(id, true);
    },

    labelOf(region: GridRegion): string | null {
      const id = timelineIdOf(region);
      return id === null ? null : getTimelineById(id)?.name ?? null;
    },

    // A canvas-wide Delete (a multi-selection spanning families) hands the
    // timelines their share (W26; withheld in the review of A4 while the
    // backend's `delete_timeline_slicer` committed whatever transaction was
    // open, which split the seam's ONE undo step). The backend delete now
    // JOINS an open transaction behind its `editObjects` gate (wave C, W1);
    // `timelineDeleteObjects.test.ts` pins that pairing against the Rust
    // delete PATH (the command and every same-file function it reaches --
    // `delete_timeline_slicer_core` holds the logic), so a return of the old
    // begin/commit pair fails the build of this attachment rather than
    // splitting the user's Ctrl+Z. The Rust tier guards it too
    // (timeline_slicer/tests.rs: a delete inside an open transaction joins
    // it; no timeline command runs an unconditional begin/commit pair).
    deleteObjects: deleteTimelineRegions,
  };
}

/**
 * The timelines' share of a canvas-wide Delete, ready for the provider's
 * `deleteObjects` (see above): resolves once every delete LANDED (the store
 * re-read); REJECTS with the backend's reason when any was refused, so the
 * seam keeps the refused ones selected and names them.
 */
export async function deleteTimelineRegions(regions: readonly GridRegion[]): Promise<void> {
  const ids = regions.map(timelineIdOf).filter((id): id is string => id !== null);
  if (ids.length === 0) return;
  const refused = await deleteTimelinesReporting(ids);
  if (refused.length > 0) {
    throw new Error(Array.from(new Set(refused.map((r) => r.reason))).join(" "));
  }
}

/** Register the provider; returns the cleanup for the extension's list. */
export function registerTimelineObjectSelection(): () => void {
  return registerObjectSelectionProvider(createTimelineSelectionProvider());
}
