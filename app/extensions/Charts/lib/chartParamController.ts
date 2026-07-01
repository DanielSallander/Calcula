//! FILENAME: app/extensions/Charts/lib/chartParamController.ts
// PURPOSE: The Charts-side implementation of the @api/chartParams IoC contract.
//          Wraps the chart store (enumeration), the ephemeral widget-value store
//          (live param overrides), and the cache-invalidate + GRID_REFRESH repaint
//          so external consumers (e.g. the Animation chart-param driver) can sweep
//          a param without importing Charts internals. Registered in activate().
import type { ChartParamController } from "@api/chartParams";
import { emitAppEvent, AppEvents } from "@api/events";
import { getAllCharts, getChartById } from "./chartStore";
import { getWidgetValue, setWidgetValue, deleteWidgetValue } from "../handlers/chartWidgetValues";
import { invalidateChartCache } from "../rendering/chartRenderer";

export const chartParamController: ChartParamController = {
  listAnimatableCharts(sheetIndex) {
    return getAllCharts()
      .filter(
        (c) =>
          (sheetIndex === undefined || c.sheetIndex === sheetIndex) &&
          (c.spec.params?.some((p) => p.bind) ?? false),
      )
      .map((c) => ({ chartId: c.chartId, name: c.name, sheetIndex: c.sheetIndex }));
  },

  listParams(chartId) {
    const chart = getChartById(chartId);
    return (chart?.spec.params ?? []).map((p) => ({ name: p.name, bind: p.bind }));
  },

  getParamValue(chartId, paramName) {
    return getWidgetValue(chartId, paramName);
  },

  setParamValue(chartId, paramName, value) {
    setWidgetValue(chartId, paramName, value);
    invalidateChartCache(chartId);
    emitAppEvent(AppEvents.GRID_REFRESH);
  },

  clearParamValue(chartId, paramName) {
    deleteWidgetValue(chartId, paramName);
    invalidateChartCache(chartId);
    emitAppEvent(AppEvents.GRID_REFRESH);
  },
};
