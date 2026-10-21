//! FILENAME: app/extensions/Charts/lib/chartQueryProvider.ts
// PURPOSE: Register design-query charts with the shared query-object refresh
//   service — a chart whose DSL binds a control / ribbon filter via @Name is
//   invalidated + repainted when that bound value changes (the same targeted,
//   coalesced pass that re-materializes grid reports).
//
//   And re-run them when what they RESOLVE moves (@api/reportFilters,
//   CONTRACT-CANVAS §4.8, P4): a model slicer on a chart's sheet or canvas
//   keeps some items of a model column, and every design-query chart on THAT
//   page (by sheet id) against THAT model follows it -- the reader merges the
//   resolved filters into the query (designQueryChartDataReader.ts), this file
//   makes the chart read again. A change for every page ("*", an all-pages
//   ribbon filter) reaches every chart on the model; a change that names
//   TARGETS (a visuals-scoped filter, an interaction pair) reaches those charts
//   whatever their page. A chart on another sheet, or on another model, is not
//   touched: re-running it would cost a model query and change nothing.

import { emitAppEvent, AppEvents } from "@api/events";
import { onReportFiltersChange, type ReportFiltersChange } from "@api/reportFilters";
import { getReportPagesSnapshot, sheetIdAt } from "@api/reportPages";
import {
  registerQueryObjectProvider,
  type QueryObjectBinding,
} from "../../_shared/lib/queryObjectRefresh";
import { extractControlParams } from "../../_shared/dsl/pivotLayout/paramSubstitution";
import { getAllCharts } from "./chartStore";
import { isDesignQueryDataSource } from "../types";
import { invalidateChartCache } from "../rendering/chartRenderer";

/**
 * The design-query charts a report-filter change reaches: the chart queries a
 * changed connection on a changed page (its sheet's id, or "*" for every page),
 * or the change names the chart as a target. Pure over the store and the page
 * list.
 */
export function chartsReachedByReportFilters(change: ReportFiltersChange): string[] {
  const pages = new Set(change.pages.map((p) => `${p.sheetId}|${p.connectionId}`));
  const targets = new Set(change.targets.filter((t) => t.kind === "chart").map((t) => t.id));
  const snapshot = getReportPagesSnapshot();
  const ids: string[] = [];
  for (const chart of getAllCharts()) {
    const data = chart.spec?.data;
    if (!isDesignQueryDataSource(data) || !data.connectionId) continue;
    if (targets.has(chart.chartId)) {
      ids.push(chart.chartId);
      continue;
    }
    const conn = String(data.connectionId);
    const sheetId = sheetIdAt(snapshot, chart.sheetIndex);
    if (pages.has(`*|${conn}`) || (sheetId !== null && pages.has(`${sheetId}|${conn}`))) ids.push(chart.chartId);
  }
  return ids;
}

/**
 * ONE overlay repaint per frame for report-filter changes. A click on a model
 * slicer can move the page's filters and a visual's selection in the same
 * tick (two changes); each invalidates its charts at once, and the repaint
 * that makes them refetch is asked for once. `requestAnimationFrame` where the
 * host has it, else a 16 ms timer (a worker, a test without frames).
 */
let repaintPending = false;
let repaintHandle: { cancel: () => void } | null = null;

function scheduleChartsRepaint(): void {
  if (repaintPending) return;
  repaintPending = true;
  const run = () => {
    repaintPending = false;
    repaintHandle = null;
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  if (typeof requestAnimationFrame === "function") {
    const h = requestAnimationFrame(run);
    repaintHandle = { cancel: () => cancelAnimationFrame(h) };
  } else {
    const h = setTimeout(run, 16);
    repaintHandle = { cancel: () => clearTimeout(h) };
  }
}

function cancelChartsRepaint(): void {
  repaintHandle?.cancel();
  repaintHandle = null;
  repaintPending = false;
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

  // The page's model filters and the visuals' cross-filter selections. Same
  // refresh as a control change: invalidate the reached charts at once, then
  // ONE repaint per frame however many changes landed in it (they refetch on
  // redraw, with the newly resolved filters merged into their query).
  const unsubscribePageFilters = onReportFiltersChange((change) => {
    const ids = chartsReachedByReportFilters(change);
    if (ids.length === 0) return;
    for (const id of ids) invalidateChartCache(id);
    scheduleChartsRepaint();
  });

  return () => {
    cancelChartsRepaint();
    unsubscribePageFilters();
    unregisterControls();
  };
}
