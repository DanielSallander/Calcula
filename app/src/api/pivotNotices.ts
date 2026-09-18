/**
 * FILENAME: app/src/api/pivotNotices.ts
 * PURPOSE: The ONE consumer of a pivot response's `notices`, reachable from
 *          every caller of a pivot command.
 *
 * WHY IT LIVES IN @api RATHER THAN THE PIVOT EXTENSION: three of the callers
 * that most often produce a notice are NOT the Pivot extension. The Slicer's
 * filter bridge, the Insert Slicer dialog and the Controls pane's filter
 * bridge all call `updateBiPivotFields` straight from `@api/backend`, never
 * touching the Pivot extension's own api wrapper or its view store — and a
 * slicer field with no value fields is exactly what sends a request down the
 * synthetic-placeholder-measure branch that produces these notices. A
 * consumer wired inside the Pivot extension would be invisible on the very
 * path that needs it most, and having Slicer or ControlsPane import Pivot's
 * internals to reach it would break the Seam Rule.
 *
 * WHY A TOAST AND NOT A BANNER: a notice is RESPONSE-SCOPED. `getPivotView`
 * recomputes from the stored definition and cache and never re-queries, so a
 * notice produced while updating fields is gone by the next read. A banner fed
 * from the cached view would therefore blank itself at an arbitrary later
 * moment, which is a different lie from the one this fixes. Making a notice
 * durable would mean storing it in saved pivot state, which is a
 * `DocumentEffect` decision and not one to take inside a UI change.
 */

import type { PivotNotice } from "./pivotTypes";
import { showToast } from "./notifications";

/** Any response that may carry notices (pivot view, drill-through). */
export interface MaybeHasNotices {
  notices?: PivotNotice[];
}

/**
 * Show whatever the backend asked us to tell the user about this response.
 *
 * A refusal by the active security role is an ERROR — the user can act on it
 * by choosing a different "view as" role. A degradation is a WARNING. The
 * severity comes from the typed `kind`, never from reading the message.
 *
 * Safe to call with anything, including `undefined`: on the ordinary path a
 * response carries no notices and this does nothing.
 */
export function surfacePivotNotices(response: MaybeHasNotices | null | undefined): void {
  const notices = response?.notices;
  if (!notices || notices.length === 0) return;
  for (const notice of notices) {
    showToast(notice.message, {
      type: notice.kind === "refused" ? "error" : "warning",
    });
  }
}
