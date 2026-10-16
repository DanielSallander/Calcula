//! FILENAME: app/extensions/FloatingRange/lib/frPatch.ts
// PURPOSE: THE one way the grid's own panes write a range: ONE
//          `update_floating_range` patch (one backend write, one undo step,
//          which joins an open undo transaction), then the store, the cell
//          cache, the regions and the grid brought up to date.
// CONTEXT: Shared by the object pane's Properties tab (rows, columns, header
//          strips: components/FloatingRangePropertiesBody.tsx) and the Format
//          tab's provider (title bar + container: lib/frObjectFormat.ts, whose
//          deps index.ts wires to this), so the two panes cannot drift in what
//          a write refreshes. A patch that changes nothing is never sent.

import { updateFloatingRange, type FloatingRangePatch } from "@api/floatingRanges";
import { AppEvents, emitAppEvent } from "@api/events";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { upsertFromInfo, syncFloatingRangeRegions } from "./floatingRangeStore";
import { invalidateFrCache } from "../rendering/frRenderer";

/** Whether a patch carries anything to write (an absent key = leave it alone). */
export function frPatchIsEmpty(patch: FloatingRangePatch): boolean {
  return Object.values(patch).every((v) => v === undefined);
}

/**
 * Write `patch` for range `frId` and refresh everything that derives from the
 * row. Rejects with the backend's sentence (a protected sheet, a locked
 * page's geometry, an invalid container), leaving the store as it was.
 */
export async function applyFrPatch(frId: string, patch: FloatingRangePatch): Promise<void> {
  if (frPatchIsEmpty(patch)) return;
  const info = await updateFloatingRange(frId, patch);
  upsertFromInfo(info);
  // The visible window or the chrome changed: a regrown row's cells must be
  // re-fetched, and the frame the regions publish derives from the row.
  invalidateFrCache(frId);
  syncFloatingRangeRegions();
  requestOverlayRedraw();
  emitAppEvent(AppEvents.GRID_REFRESH);
}
