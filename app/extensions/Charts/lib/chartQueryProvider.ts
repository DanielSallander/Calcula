//! FILENAME: app/extensions/Charts/lib/chartQueryProvider.ts
// PURPOSE: Register design-query charts with the shared query-object refresh
//   service — a chart whose DSL binds a control / ribbon filter via @Name is
//   invalidated + repainted when that bound value changes (the same targeted,
//   coalesced pass that re-materializes grid reports).
//
//   And re-run them when their PAGE's model filters move (@api/pageFilters,
//   CONTRACT-CANVAS §4.8): a model slicer on a chart's sheet or canvas keeps
//   some items of a model column, and every design-query chart on THAT page
//   against THAT model follows it -- the reader merges the filter into the
//   query (designQueryChartDataReader.ts), this file makes the chart read
//   again. A chart on another sheet, or on another model, is not touched:
//   re-running it would cost a model query and change nothing.

import { emitAppEvent, AppEvents } from "@api/events";
import { onPageFiltersChange, type PageFiltersChange } from "@api/pageFilters";
import {
  registerQueryObjectProvider,
  type QueryObjectBinding,
} from "../../_shared/lib/queryObjectRefresh";
import { extractControlParams } from "../../_shared/dsl/pivotLayout/paramSubstitution";
import { getAllCharts } from "./chartStore";
import { isDesignQueryDataSource } from "../types";
import { invalidateChartCache } from "../rendering/chartRenderer";

/**
 * The design-query charts a page-filter change reaches: the chart sits on a
 * changed page AND queries the changed page's model. Pure over the store.
 */
export function chartsReachedByPageFilters(change: PageFiltersChange): string[] {
  const pages = new Set(change.pages.map((p) => `${p.sheetIndex}\u0000${p.connectionId}`));
  const ids: string[] = [];
  for (const chart of getAllCharts()) {
    const data = chart.spec?.data;
    if (!isDesignQueryDataSource(data) || !data.connectionId) continue;
    if (pages.has(`${chart.sheetIndex}\u0000${String(data.connectionId)}`)) ids.push(chart.chartId);
  }
  return ids;
}

/** Register the "chart" family. Returns an unregister fn. */
export function registerChartQueryProvider(): () => void {
  const unregisterControls = registerQueryObjectProvider({
    kind: "chart",
    listBindings: async () => {
      const bindings: QueryObjectBinding[] = [];
      for (const chart of getAllCharts()) {
        const data = chart.spec?.data;
        if (!isDesignQueryDataSource(data)) continue;
        bindings.push({
          id: chart.chartId,
          name: chart.name ?? chart.chartId,
          boundControls: extractControlParams(data.dslText),
        });
      }
      return bindings;
    },
    refreshObjects: async (ids) => {
      for (const id of ids) {
        invalidateChartCache(id);
      }
      // Charts are canvas OVERLAYS: the repaint-only app event is the correct
      // one here (the invalidated charts refetch their data on redraw) — no
      // grid-cell refetch is involved.
      emitAppEvent(AppEvents.GRID_REFRESH);
    },
  });

  // The page's model slicers. Same refresh as a control change: invalidate
  // the reached charts, then ONE repaint (they refetch on redraw, with the
  // page's new filters merged into their query).
  const unsubscribePageFilters = onPageFiltersChange((change) => {
    const ids = chartsReachedByPageFilters(change);
    if (ids.length === 0) return;
    for (const id of ids) invalidateChartCache(id);
    emitAppEvent(AppEvents.GRID_REFRESH);
  });

  return () => {
    unsubscribePageFilters();
    unregisterControls();
  };
}
