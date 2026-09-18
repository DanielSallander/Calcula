/**
 * FILENAME: app/src/api/dataAftermath.ts
 * PURPOSE: Everything the frontend must do after something UNDERNEATH the grid
 *          changed what the cells should say, in one place, in the order that
 *          works.
 *
 * CONTEXT: this sequence was written twice before it was written once. Two
 * Distribution commands that rewrite subscribed sheets each grew their own
 * fan-out and drifted, in the direction that loses data on screen (the refresh
 * path never refreshed pivots, so every pivot region on a refreshed sheet went
 * blank and stayed blank). It is now needed a third time, by a completely
 * different extension: changing the BI "view as" role changes what every
 * BI-derived cell should say, and nothing repainted them at all.
 *
 * It lives in `@api` because the callers are in DIFFERENT extensions
 * (Distribution, BusinessIntelligence) and the Seam Rule forbids one reaching
 * into another's internals. A third hand-written copy is what this file exists
 * to prevent.
 *
 * ORDER IS LOAD-BEARING: pivots write cells, so they must land BEFORE the
 * recalculation that evaluates formulas referring to them, which must land
 * before the canvas refetches.
 *
 * EVERY STEP IS INDEPENDENTLY TRY/CAUGHT: one pivot that will not refresh must
 * not cost the recalculation, and a failed recalculation must not cost the
 * repaint. A half-updated screen is recoverable; a screen that never updates
 * reads as "nothing happened".
 */

import { calculateNow, recalcWithCube } from "../core/lib/tauri-api";
import { emitAppEvent, AppEvents } from "./events";
import { pivot } from "./pivot";

export interface DataAftermathOptions {
  /**
   * Force CUBE formulas to be re-resolved even if no CUBE formula was TYPED in
   * this session.
   *
   * Required whenever the change invalidates values a cube cell already holds,
   * because the session latch that normally gates the cube round-trip is armed
   * ONLY by typing a CUBE formula — never by opening a workbook that already
   * contains them. Without this, a workbook the user merely OPENED keeps
   * showing cube values computed under the previous conditions, and pressing
   * F9 does not fix it either.
   */
  forceCube?: boolean;
  /** Prefix for the console messages, so a failure names its caller. */
  context?: string;
}

/**
 * Re-render, recalculate and re-read after the data underneath the grid
 * changed: subscribed content was replaced, or the security role the data is
 * read under was switched.
 */
export async function announceUnderlyingDataChanged(
  options: DataAftermathOptions = {},
): Promise<void> {
  const { forceCube = false, context = "data" } = options;

  // 1. PIVOTS FIRST — they write cells, and their output is real grid content.
  try {
    const allPivots = await pivot.getAll();
    for (const p of allPivots) {
      try {
        await pivot.refreshCache(p.id);
      } catch {
        /* one pivot failing must not stop the rest */
      }
    }
    window.dispatchEvent(new Event("pivot:refresh"));
  } catch (err) {
    console.error(`[${context}] Pivot re-render after data change failed:`, err);
  }

  // 2. Recalculate. `recalcWithCube` forces the cube round-trip; plain
  //    `calculateNow` leaves cube cells to the session latch.
  try {
    await (forceCube ? recalcWithCube() : calculateNow());
  } catch (err) {
    console.error(`[${context}] Recalc after data change failed:`, err);
  }

  // 3. The sheet COLLECTION may have changed (a refresh can append a sheet).
  emitAppEvent(AppEvents.SHEET_CHANGED, {});

  // 4. Refetch the visible cells. This must be the BARE `grid:refresh` event:
  //    `AppEvents.GRID_REFRESH` only redraws what the canvas already holds,
  //    so a fix that emits it would look right in review and change nothing
  //    on screen.
  window.dispatchEvent(new CustomEvent("grid:refresh"));

  // 5. Pane controls may have been re-materialized by the same command.
  window.dispatchEvent(new CustomEvent("controlspane:controls-refreshed"));
}
