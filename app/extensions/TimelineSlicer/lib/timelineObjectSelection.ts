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
import {
  deselectTimeline,
  isTimelineSelected,
  selectTimeline,
} from "../handlers/selectionHandler";

/** The `GridRegion.type` timelines publish (see timelineSlicerStore). */
export const TIMELINE_REGION_TYPE = "timeline-slicer";

/** The timeline id a published region carries, or null. */
function timelineIdOf(region: GridRegion): string | null {
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
  };
}

/** Register the provider; returns the cleanup for the extension's list. */
export function registerTimelineObjectSelection(): () => void {
  return registerObjectSelectionProvider(createTimelineSelectionProvider());
}
