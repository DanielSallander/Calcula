//! FILENAME: app/extensions/TimelineSlicer/lib/timelineGeometry.ts
// PURPOSE: The TimelineSlicer's provider for the `@api/objectGeometry` seam --
//          move and resize timelines for a caller that is NOT a pointer
//          gesture: the canvas's align / distribute, its arrow-key nudge, and
//          a group drag that carries a timeline along with another object.
// CONTEXT: `update_timeline_position` records undo JOINING an open transaction
//          and refuses a protected sheet that disallows editing objects.
//          Preview moves the cache only; a refusal re-reads the cache from the
//          backend before the commit rejects (the seam's revert contract), and
//          the seam tells the user once for the whole arrange.
//
//          The TimelineSlicer co-moves its OWN multi-selection when one of its
//          timelines is dragged (index.ts), so a canvas group drag led by a
//          timeline leaves the other selected timelines to it.

import type { ObjectGeometryChange, ObjectGeometryProvider } from "@api/objectGeometry";
import { TIMELINE_REGION_TYPE, timelineIdOf } from "./timelineObjectSelection";
import {
  updateCachedTimelineBounds,
  writeTimelineGeometryAsync,
  type TimelineGeometryWrite,
} from "./timelineSlicerStore";

function writesOf(changes: readonly ObjectGeometryChange[]): TimelineGeometryWrite[] {
  const writes: TimelineGeometryWrite[] = [];
  for (const c of changes) {
    const timelineId = timelineIdOf(c.region);
    if (timelineId === null) continue;
    writes.push({ timelineId, x: c.x, y: c.y, width: c.width, height: c.height });
  }
  return writes;
}

/** Build the provider registered for region type "timeline-slicer". */
export function createTimelineGeometryProvider(deps: { afterCommit?: () => void } = {}): ObjectGeometryProvider {
  return {
    types: [TIMELINE_REGION_TYPE],
    coMovesOwnSelection: true,

    preview(changes: readonly ObjectGeometryChange[]): void {
      for (const w of writesOf(changes)) {
        updateCachedTimelineBounds(w.timelineId, w.x, w.y, w.width, w.height);
      }
    },

    async commit(changes: readonly ObjectGeometryChange[]): Promise<void> {
      const writes = writesOf(changes);
      if (writes.length === 0) return;
      const reasons = await writeTimelineGeometryAsync(writes);
      deps.afterCommit?.();
      if (reasons.length > 0) {
        throw new Error(
          Array.from(new Set(reasons.filter((r) => r !== ""))).join(" ") || "The timeline could not be moved.",
        );
      }
    },
  };
}
