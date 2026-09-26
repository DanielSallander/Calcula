//! FILENAME: app/extensions/Charts/lib/chartGeometry.ts
// PURPOSE: Charts' provider for the `@api/objectGeometry` seam -- move and
//          resize charts for a caller that is NOT a pointer gesture: the
//          canvas's align / distribute, its arrow-key nudge, and a group drag
//          that carries a chart along with another object.
// CONTEXT: A chart's geometry lives in the chart store and reaches the backend
//          through the store's DEBOUNCED save (`update_chart`, which records
//          undo joining an open transaction). The seam wants two things the
//          drag path does not:
//            - a PREVIEW that writes nothing (`previewChartPlacement`): a nudge
//              burst previews every keystroke, and a preview that scheduled
//              saves would land a write mid-burst, outside the burst's one
//              undo step;
//            - a COMMIT that has LANDED when it resolves, and that reports a
//              refusal to its caller instead of in a chart dialog of its own
//              (`flushPendingChartSavesQuietly`): the seam shows ONE toast for
//              the whole arrange, whichever families were refused.
//          A refused chart is rolled back to its last persisted version by the
//          store before the commit rejects -- the seam's revert contract.

import type { ObjectGeometryChange, ObjectGeometryProvider } from "@api/objectGeometry";
import { chartIdOfRegion } from "./chartObjectSelection";
import {
  flushPendingChartSaves,
  flushPendingChartSavesQuietly,
  previewChartPlacement,
  reportChartFailures,
  syncChartRegions,
  updateChartPlacement,
} from "./chartStore";

/** The side effects a geometry change needs, injected by activate(). */
export interface ChartGeometryDeps {
  /** A chart's cached raster was drawn at the old size; drop it. */
  invalidateChart: (chartId: string) => void;
  /** Repaint the grid (and with it the overlay regions). */
  refresh: () => void;
}

/** Build the provider registered for region type "chart". */
export function createChartGeometryProvider(deps: ChartGeometryDeps): ObjectGeometryProvider {
  return {
    types: ["chart"],

    preview(changes: readonly ObjectGeometryChange[]): void {
      let any = false;
      for (const c of changes) {
        const id = chartIdOfRegion(c.region);
        if (id === null) continue;
        any = previewChartPlacement(id, { x: c.x, y: c.y, width: c.width, height: c.height }) || any;
      }
      if (!any) return;
      syncChartRegions();
      deps.refresh();
    },

    async commit(changes: readonly ObjectGeometryChange[]): Promise<void> {
      const ids: string[] = [];
      for (const c of changes) {
        const id = chartIdOfRegion(c.region);
        if (id === null) continue;
        if (updateChartPlacement(id, { x: c.x, y: c.y, width: c.width, height: c.height })) ids.push(id);
      }
      if (ids.length === 0) return;
      syncChartRegions();
      const failures = await flushPendingChartSavesQuietly();
      for (const id of ids) deps.invalidateChart(id);
      deps.refresh();
      const mine = new Set(ids);
      const refused = failures.filter((f) => mine.has(f.chartId));
      const unrelated = failures.filter((f) => !mine.has(f.chartId));
      // A refused write of some OTHER chart (an unrelated edit that shared the
      // flush) is still the user's to hear about, the way it always was.
      if (unrelated.length > 0) void reportChartFailures(unrelated);
      if (refused.length > 0) {
        const reasons = Array.from(new Set(refused.map((f) => f.reason).filter((r) => r !== "")));
        throw new Error(reasons.join(" ") || "The chart could not be saved.");
      }
    },

    // A drag's own persist is debounced: land it (the group drag commits its
    // one undo transaction only after this).
    flush: () => flushPendingChartSaves(),
  };
}
