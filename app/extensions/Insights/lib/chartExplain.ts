//! FILENAME: app/extensions/Insights/lib/chartExplain.ts
// PURPOSE: "Explain this chart" — resolve a chart's series through the Charts
//          seam, then ask Rust for facts about those numbers.
// CONTEXT: The seam runs the OTHER way from most of them. A chart's resolved
//          numbers exist only in TypeScript (Rust stores the spec as an opaque
//          string), so Charts RESOLVES and this module analyses the result. We
//          reach it through `@api/chartData`, never by importing Charts.
//
//          THE `null` IN `values` IS THE POINT OF THE WHOLE ROUTE. The renderer
//          coerces an unparseable cell to 0 to draw a bar; a blank month sent as
//          0 makes a series look like it collapsed. `resolveChartSeries` returns
//          `null` for "no number" and this module passes it through untouched —
//          no `?? 0`, ever.
//
//          `truncated` is re-attached as a NOTE rather than dropped: the sampler
//          runs on this side of the boundary, so Rust cannot know it happened,
//          and a bundle that silently describes a sampled series as if it were
//          the whole one is exactly the kind of quiet lie `notes` exists to
//          prevent. A note is a stated limit, not a computed fact — this module
//          still composes no sentence about the data itself.

import { registerChartContextMenuContribution } from "@api/chartContextMenu";
import {
  CHART_SERIES_MAX_POINTS,
  getChartDataProvider,
  getSelectedChartId,
  listChartsForData,
  resolveChartSeries,
  type ChartSeriesSnapshot,
} from "@api/chartData";
import type { InsightBundle } from "@api/insightsService";
import { analyzeSeries, type SeriesInsightsRequest } from "./backend";
import { analyzeCurrentSource, beginRun, completeRun, describeError, failRun, getState } from "./store";

export const EXPLAIN_CHART_CONTRIBUTION_ID = "insights.explainChart";
export const EXPLAIN_CHART_LABEL = "Explain this chart";

const TRUNCATION_NOTE =
  "The chart had more points than the analysis cap, so the series was sampled before it was analysed.";

/** Append a note without letting the frontend touch anything else in the bundle. */
function withNote(bundle: InsightBundle, note: string): InsightBundle {
  if (bundle.notes.includes(note)) return bundle;
  return { ...bundle, notes: [...bundle.notes, note] };
}

/**
 * The `insights_for_series` request a snapshot becomes. One function, because
 * the overlay (`overlay.ts`, behind the pane's "Show on chart") must send
 * EXACTLY what "Explain this chart" sends: the same numbers in, the same facts
 * out, one bundle behind both views.
 */
export function seriesRequestFrom(snapshot: ChartSeriesSnapshot): SeriesInsightsRequest {
  return {
    title: snapshot.title ?? snapshot.name,
    categories: snapshot.categories,
    categoryKind: snapshot.categoryKind,
    series: snapshot.series.map((s) => ({ name: s.name, values: s.values })),
    ...(snapshot.categoryValues === undefined
      ? {}
      : { categoryValues: snapshot.categoryValues }),
    // The strategy travels with the numbers: a design-query chart's series
    // are measures, and Rust turns "a peak" into "the worst month" only when
    // told which measure — and which connection's document — decides that.
    ...(snapshot.strategy === undefined || snapshot.strategy.measures.length === 0
      ? {}
      : { strategy: snapshot.strategy }),
  };
}

/**
 * Resolve a chart, ask for facts about it, and leave the answer in the pane.
 *
 * `openPane` is injected rather than imported: only `activate()` holds the
 * `ExtensionContext` that can raise a task pane, and this module must stay
 * callable from a test with no shell at all.
 */
export async function explainChart(
  chartId: string,
  openPane: () => void,
): Promise<void> {
  openPane();
  const token = beginRun("this chart", { kind: "chart", chartId });

  let snapshot;
  try {
    snapshot = await resolveChartSeries(chartId, CHART_SERIES_MAX_POINTS);
  } catch (err) {
    failRun(token, describeError(err));
    return;
  }

  if (!snapshot) {
    failRun(
      token,
      "This chart has no single set of series to explain. If it stacks several charts together, explain one of them instead.",
    );
    return;
  }

  const label = snapshot.title ?? snapshot.name;
  const request = seriesRequestFrom(snapshot);

  try {
    const bundle = await analyzeSeries(request);
    completeRun(
      token,
      snapshot.truncated ? withNote(bundle, TRUNCATION_NOTE) : bundle,
      label,
    );
  } catch (err) {
    failRun(token, describeError(err));
  }
}

/**
 * The chart the reader has selected, named as the pane should name it.
 *
 * `null` when no chart is selected, when Charts is not loaded, or when the
 * selected chart is not one the data provider lists — in every one of those
 * cases the grid selection is what Analyse is about.
 */
export function selectedChartTarget(): { chartId: string; label: string } | null {
  const chartId = getSelectedChartId();
  if (chartId === null) return null;
  const summary = listChartsForData().find((c) => c.chartId === chartId);
  return summary === undefined ? null : { chartId, label: summary.title ?? summary.name };
}

/**
 * What the pane's Analyse button runs: a SELECTED CHART wins over the grid
 * selection.
 *
 * The owner found this the obvious reading and the old behaviour the surprising
 * one: with a chart selected, Analyse answered about whichever cell was last
 * clicked — a rectangle the reader had stopped looking at. Selecting a chart is
 * a deliberate act and the most recent one, so it names the subject.
 *
 * The model switch still wins over both: it is a position the reader set, not
 * an incidental selection.
 */
export function analyzeCurrentTarget(openPane: () => void = () => undefined): Promise<void> {
  if (getState().source === "model") return analyzeCurrentSource();
  const chart = selectedChartTarget();
  return chart === null ? analyzeCurrentSource() : explainChart(chart.chartId, openPane);
}

/**
 * Contribute the item to the chart context menu.
 *
 * `visible` is false when no chart data provider is registered: without Charts
 * there is nothing to resolve, and an item that always fails is worse than an
 * item that is not there.
 */
export function registerChartExplain(openPane: () => void): () => void {
  return registerChartContextMenuContribution({
    id: EXPLAIN_CHART_CONTRIBUTION_ID,
    label: EXPLAIN_CHART_LABEL,
    order: 50,
    visible: () => getChartDataProvider() !== null,
    onSelect: (chartId: string) => {
      void explainChart(chartId, openPane);
    },
  });
}
