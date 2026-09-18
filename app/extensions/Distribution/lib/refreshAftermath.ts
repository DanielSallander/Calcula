// FILENAME: app/extensions/Distribution/lib/refreshAftermath.ts
// PURPOSE: Distribution's name for "the subscribed content was replaced", now a
//          thin call onto the shared @api seam.
// CONTEXT: This sequence was written twice before it was written once. Two
//          commands rewrite a subscribed sheet's cells wholesale —
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
//          on a refreshed sheet goes BLANK and stays blank.
//
//          It is now needed a THIRD time, by BusinessIntelligence (changing the
//          "view as" role changes what every BI-derived cell should say), so the
//          body moved to `@api/dataAftermath` where both extensions can reach it
//          without either importing the other's internals. The order, the
//          per-step try/catch and the reason each step exists are documented
//          there.
//
//          PACKAGE_UPDATED deliberately stays OUT. It carries a per-subscription
//          payload and its meaning differs between the two callers — reset does
//          not emit it at all, refresh emits one per subscription. Folding it in
//          would make a reset claim an application version had changed.

import { announceUnderlyingDataChanged } from "@api/dataAftermath";

/**
 * Re-render, recalculate and re-read after subscribed sheet content was
 * replaced underneath the user.
 *
 * `forceCube` because replaced content invalidates whatever a CUBE cell already
 * holds, and the session latch that normally gates the cube round-trip is armed
 * only by TYPING a cube formula — so a workbook the subscriber merely opened
 * would keep pre-replacement cube values. This path used to call plain
 * `calculateNow()` and had exactly that defect.
 */
export async function announceSubscribedContentReplaced(): Promise<void> {
  await announceUnderlyingDataChanged({ forceCube: true, context: "Distribution" });
}
