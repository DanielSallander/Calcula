//! FILENAME: app/extensions/Slicer/lib/slicerGeometry.ts
// PURPOSE: Slicer's provider for the `@api/objectGeometry` seam -- move and
//          resize slicers for a caller that is NOT a pointer gesture: the
//          canvas's align / distribute, its arrow-key nudge, and a group drag
//          that carries a slicer along with another family's object.
// CONTEXT: A slicer's geometry is written by `update_slicer_position`, which
//          records undo JOINING an open transaction (so the seam's one
//          transaction makes an arrange one step) and refuses a protected
//          sheet that disallows editing objects. Preview moves the cache only.
//          A refusal re-reads the cache from the backend before the commit
//          rejects -- the seam's revert contract -- and the seam tells the user
//          once for the whole arrange.
//
//          Slicer co-moves its OWN multi-selection when one of its slicers is
//          dragged (index.ts), so a canvas group drag led by a slicer leaves
//          the other selected slicers to it (`coMovesOwnSelection`).

import type { GridRegion } from "@api/gridOverlays";
import type { ObjectGeometryChange, ObjectGeometryProvider } from "@api/objectGeometry";
import { updateCachedSlicerBounds, writeSlicerGeometryAsync, type SlicerGeometryWrite } from "./slicerStore";

/** The slicer id a published slicer region carries, or null. */
export function slicerIdOfRegion(region: GridRegion): string | null {
  const id = region.data?.slicerId;
  return typeof id === "string" && id !== "" ? id : null;
}

function writesOf(changes: readonly ObjectGeometryChange[]): SlicerGeometryWrite[] {
  const writes: SlicerGeometryWrite[] = [];
  for (const c of changes) {
    const slicerId = slicerIdOfRegion(c.region);
    if (slicerId === null) continue;
    writes.push({ slicerId, x: c.x, y: c.y, width: c.width, height: c.height });
  }
  return writes;
}

/** Build the provider registered for region type "slicer". */
export function createSlicerGeometryProvider(deps: { afterCommit?: () => void } = {}): ObjectGeometryProvider {
  return {
    types: ["slicer"],
    coMovesOwnSelection: true,

    preview(changes: readonly ObjectGeometryChange[]): void {
      for (const w of writesOf(changes)) {
        updateCachedSlicerBounds(w.slicerId, w.x, w.y, w.width, w.height);
      }
    },

    async commit(changes: readonly ObjectGeometryChange[]): Promise<void> {
      const writes = writesOf(changes);
      if (writes.length === 0) return;
      const reasons = await writeSlicerGeometryAsync(writes);
      deps.afterCommit?.();
      if (reasons.length > 0) {
        throw new Error(Array.from(new Set(reasons.filter((r) => r !== ""))).join(" ") || "The slicer could not be moved.");
      }
    },
  };
}
