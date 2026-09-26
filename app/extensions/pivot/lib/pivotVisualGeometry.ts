//! FILENAME: app/extensions/Pivot/lib/pivotVisualGeometry.ts
// PURPOSE: The canvas pivot box's provider for the `@api/objectGeometry` seam
//          -- move and resize pivot boxes for a caller that is NOT a pointer
//          gesture: the canvas's align / distribute, its arrow-key nudge, and
//          a group drag that carries a pivot box along with another object.
// CONTEXT: A box's frame is patched as a LIVE frame (`setLiveFrame`: the box
//          follows at once, nothing is written) and persisted by
//          `commitLiveFrame` -> `update_pivot_properties({ canvasFrame })`,
//          whose undo record joins an open transaction. On a refusal the live
//          frame is dropped, so the box returns to the backend's frame -- the
//          seam's revert contract -- and the commit rejects; the seam tells the
//          user once for the whole arrange.
//
//          The box's own drag persists through the same `commitLiveFrame` from
//          pivotVisualOverlay.ts; `trackPivotFrameSave` records those saves so
//          `flush` can wait for them (a canvas group drag led by a pivot box
//          commits its one undo transaction only after the box's frame landed).

import type { ObjectGeometryChange, ObjectGeometryProvider } from "@api/objectGeometry";
import type { CanvasFrameConfig } from "../types";
import { PIVOT_VISUAL_REGION_TYPE, commitLiveFrame, pivotIdOfVisual, setLiveFrame } from "./pivotVisualRegions";

/** Frame saves in flight (the box's own drag, or a commit here). */
const inFlight = new Set<Promise<unknown>>();

/** Record a frame save so `flush` can wait for it. Returns the same promise. */
export function trackPivotFrameSave<T>(save: Promise<T>): Promise<T> {
  inFlight.add(save);
  const done = (): void => {
    inFlight.delete(save);
  };
  save.then(done, done);
  return save;
}

/** Wait for every frame save in flight (including ones started while waiting). */
export async function settlePivotFrameSaves(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How a frame is saved (injected: the pivot API's properties update). */
export type PivotFrameSave = (pivotId: string, frame: CanvasFrameConfig) => Promise<unknown>;

/** Build the provider registered for region type "pivot-visual". */
export function createPivotVisualGeometryProvider(save: PivotFrameSave): ObjectGeometryProvider {
  return {
    types: [PIVOT_VISUAL_REGION_TYPE],

    preview(changes: readonly ObjectGeometryChange[]): void {
      for (const c of changes) {
        const id = pivotIdOfVisual(c.region);
        if (id === null) continue;
        setLiveFrame(id, { x: c.x, y: c.y, width: c.width, height: c.height });
      }
    },

    async commit(changes: readonly ObjectGeometryChange[]): Promise<void> {
      const reasons: string[] = [];
      for (const c of changes) {
        const id = pivotIdOfVisual(c.region);
        if (id === null) continue;
        if (!setLiveFrame(id, { x: c.x, y: c.y, width: c.width, height: c.height })) continue;
        let failure: unknown = null;
        await trackPivotFrameSave(
          commitLiveFrame(
            id,
            (frame) => save(id, frame),
            (error) => {
              failure = error;
            },
          ),
        );
        if (failure !== null) reasons.push(describeError(failure));
      }
      if (reasons.length > 0) {
        throw new Error(
          Array.from(new Set(reasons.filter((r) => r !== ""))).join(" ") || "The PivotTable box could not be moved.",
        );
      }
    },

    flush: () => settlePivotFrameSaves(),
  };
}
