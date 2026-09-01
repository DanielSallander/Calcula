// FILENAME: app/extensions/Distribution/lib/refreshAftermath.ts
// PURPOSE: Everything the frontend must do after a command rewrites subscribed
//          sheet content, in one place, in the order that works.
// CONTEXT: Two commands rewrite a subscribed sheet's cells wholesale —
//          `calp_reset_subscription` and `calp_refresh_apply` — and each grew
//          its own fan-out at its own call site. They drifted, in the direction
//          that loses data on screen:
//
//            reset   pivots -> recalc -> SHEET_CHANGED -> grid:refresh -> controls
//            refresh recalc -> grid:refresh -> controls
//
//          The refresh path never refreshed pivots. That is not cosmetic: a
//          published application ships with pivot OUTPUT CELLS STRIPPED, because
//          subscribers recalculate them. Refresh replaces the whole grid with
//          that stripped content and then redraws nothing, so every pivot region
//          on a refreshed sheet goes BLANK and stays blank. The reset path's own
//          comment says exactly why the redraw is needed; refresh simply never
//          got the sentence.
//
//          ORDER IS LOAD-BEARING and it is the reset path's order that is right:
//          pivots write cells, so they must land BEFORE the recalculation that
//          evaluates formulas referring to them, which must land before the
//          canvas refetches.
//
//          PACKAGE_UPDATED deliberately stays OUT. It carries a per-subscription
//          payload and its meaning differs between the two callers — reset does
//          not emit it at all, refresh emits one per subscription. Folding it in
//          would make a reset claim an application version had changed.

import { calculateNow, emitAppEvent, AppEvents } from "@api";
import { pivot } from "@api/pivot";

/**
 * Re-render, recalculate and re-read after subscribed sheet content was
 * replaced underneath the user.
 *
 * Every step is independently try/caught: one pivot that will not refresh must
 * not cost the recalculation, and a failed recalculation must not cost the
 * repaint. A half-updated screen is recoverable; a screen that never updates
 * reads as "nothing happened", which is the report this whole change set began
 * with.
 */
export async function announceSubscribedContentReplaced(): Promise<void> {
  // 1. PIVOTS FIRST — they write cells, and the published content arrived with
  //    their output stripped.
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
    console.error("[Distribution] Pivot re-render after content replacement failed:", err);
  }

  // 2. Recalculate: cross-sheet formulas pointing at the replaced sheets.
  try {
    await calculateNow();
  } catch (err) {
    console.error("[Distribution] Recalc after content replacement failed:", err);
  }

  // 3. The sheet COLLECTION may have changed (a refresh can append a sheet).
  emitAppEvent(AppEvents.SHEET_CHANGED, {});

  // 4. Refetch the visible cells.
  window.dispatchEvent(new CustomEvent("grid:refresh"));

  // 5. Pane controls may have been re-materialized by the same command.
  window.dispatchEvent(new CustomEvent("controlspane:controls-refreshed"));
}
