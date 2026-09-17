//! FILENAME: app/extensions/Insights/lib/chartCueSpike.ts
// PURPOSE: IO-0's hidden developer command: ring `Extremes.best` on the
//          selected chart, from a freshly computed bundle, through the seam.
// CONTEXT: Not a user surface. There is no menu item and no ribbon button;
//          the command exists so the placement can be exercised on a real
//          chart in the running app (command palette, a keybinding, or a
//          script) before IO-3 builds the context-menu entry and the pane's
//          "Show on chart". It toggles: a chart that already carries cues is
//          cleared, so the same command turns the lens off again.
//
//          The bundle is computed the way "Explain this chart" computes it —
//          the same snapshot, the same request, the same Rust route — so the
//          ring and the pane's sentence are two views of one set of facts.

import { setChartCues, clearChartCues, getChartCues } from "@api/chartCues";
import { CHART_SERIES_MAX_POINTS, getSelectedChartId, resolveChartSeries } from "@api/chartData";
import { analyzeSeries } from "./backend";
import { seriesRequestFrom } from "./chartExplain";
import { ringsOnBest, type CuePlacement } from "./cuePlacement";

export const RING_BEST_ON_SELECTED_CHART_COMMAND = "insights.dev.ringBestOnSelectedChart";

export type CueSpikeResult =
  | { outcome: "cleared"; chartId: string }
  | { outcome: "placed"; chartId: string; placement: CuePlacement }
  | { outcome: "refused"; chartId: string | null; reason: string };

/** Ring the best point of every extremes fact on `chartId`, or clear if it has cues. */
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
  const placement = ringsOnBest(bundle, snapshot);
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
