//! FILENAME: app/extensions/Insights/lib/chartCueSpike.ts
// PURPOSE: The hidden developer command: place every cue the bundle justifies
//          on the selected chart, from a freshly computed bundle, through the
//          seam — or clear them if it already carries some.
// CONTEXT: Not a user surface. There is no menu item and no ribbon button;
//          the command exists so placement can be exercised on a real chart in
//          the running app before IO-3a builds the context-menu entry, the
//          stepper and the pane's "Show on chart". It toggles: a chart that
//          already carries cues is cleared, so the same command turns the lens
//          off again.
//
//          The bundle is computed the way "Explain this chart" computes it —
//          the same snapshot, the same request (strategy included), the same
//          Rust route — and the cues come from `@api/insightCues`, so the
//          rings and the pane's sentences are two views of one set of facts.

import { setChartCues, clearChartCues, getChartCues } from "@api/chartCues";
import { CHART_SERIES_MAX_POINTS, getSelectedChartId, resolveChartSeries } from "@api/chartData";
import { cuesForChart, type ChartCueSet } from "@api/insightCues";
import { analyzeSeries } from "./backend";
import { seriesRequestFrom } from "./chartExplain";

export const RING_BEST_ON_SELECTED_CHART_COMMAND = "insights.dev.ringBestOnSelectedChart";

export type CueSpikeResult =
  | { outcome: "cleared"; chartId: string }
  | { outcome: "placed"; chartId: string; placement: ChartCueSet }
  | { outcome: "refused"; chartId: string | null; reason: string };

/** Place every justified cue on `chartId`, or clear if it has cues. */
export async function ringBestOnChart(chartId: string): Promise<CueSpikeResult> {
  if (getChartCues(chartId).length > 0) {
    clearChartCues(chartId);
    return { outcome: "cleared", chartId };
  }

  const snapshot = await resolveChartSeries(chartId, CHART_SERIES_MAX_POINTS);
  if (!snapshot) {
    return { outcome: "refused", chartId, reason: "This chart has no single set of series to place cues on." };
  }

  const bundle = await analyzeSeries(seriesRequestFrom(snapshot));
  const placement = cuesForChart(bundle, snapshot);
  setChartCues(chartId, placement.cues);
  return { outcome: "placed", chartId, placement };
}

/** The command body: the selected chart, or a refusal that names the problem. */
export async function ringBestOnSelectedChart(): Promise<CueSpikeResult> {
  const chartId = getSelectedChartId();
  if (!chartId) {
    return { outcome: "refused", chartId: null, reason: "Select a chart first." };
  }
  return ringBestOnChart(chartId);
}
