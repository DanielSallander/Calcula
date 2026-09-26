//! FILENAME: app/extensions/FloatingRange/lib/frGeometry.ts
// PURPOSE: The Floating Range's provider for the `@api/objectGeometry` seam --
//          MOVE floating ranges for a caller that is NOT a pointer gesture:
//          the canvas's align / distribute, its arrow-key nudge, and a group
//          drag that carries a range along with another object.
// CONTEXT: POSITION ONLY (`canResize` false). A range's frame size is DERIVED
//          from its whole rows and columns (frDimensions.ts) -- a pixel size
//          handed to it means nothing, so the seam pins every change's size to
//          the frame's current one.
//
//          The position persists through the store's debounced
//          `update_floating_range` (undo `obj_floating_range`, joining an open
//          transaction). Preview writes nothing; commit schedules the write and
//          FLUSHES it, so the commit has landed when it resolves. A refused
//          write puts the range back where the backend has it (the store) and
//          the commit rejects; the seam tells the user once for the whole
//          arrange.

import type { ObjectGeometryChange, ObjectGeometryProvider } from "@api/objectGeometry";
import {
  FLOATING_RANGE_REGION_TYPE,
  flushPendingFloatingRangeSaves,
  flushPendingFloatingRangeSavesQuietly,
  moveFloatingRange,
  previewFloatingRangePosition,
  syncFloatingRangeRegions,
} from "./floatingRangeStore";
import { frIdOf } from "./frObjectSelection";

/** Build the provider registered for region type "floating-range". */
export function createFloatingRangeGeometryProvider(): ObjectGeometryProvider {
  return {
    types: [FLOATING_RANGE_REGION_TYPE],
    canResize: () => false,

    preview(changes: readonly ObjectGeometryChange[]): void {
      let any = false;
      for (const c of changes) {
        const id = frIdOf(c.region);
        if (id === null) continue;
        any = previewFloatingRangePosition(id, c.x, c.y) || any;
      }
      if (any) syncFloatingRangeRegions();
    },

    async commit(changes: readonly ObjectGeometryChange[]): Promise<void> {
      let any = false;
      for (const c of changes) {
        const id = frIdOf(c.region);
        if (id === null) continue;
        moveFloatingRange(id, c.x, c.y);
        any = true;
      }
      if (!any) return;
      syncFloatingRangeRegions();
      const reasons = await flushPendingFloatingRangeSavesQuietly();
      if (reasons.length > 0) {
        throw new Error(
          Array.from(new Set(reasons.filter((r) => r !== ""))).join(" ") || "The floating range could not be moved.",
        );
      }
    },

    // A drag's own persist is debounced: land it (the group drag commits its
    // one undo transaction only after this).
    flush: () => flushPendingFloatingRangeSaves(),
  };
}
