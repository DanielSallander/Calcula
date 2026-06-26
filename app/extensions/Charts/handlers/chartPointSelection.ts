//! FILENAME: app/extensions/Charts/handlers/chartPointSelection.ts
// PURPOSE: Ephemeral per-chart point-selection state (C5 slice 3) — which
//          categories/series the user has clicked, keyed by chartId, by
//          select-param name. EPHEMERAL: never serialized to the spec; carried
//          onto ParsedChartData at read time and cleared on data re-read,
//          chart deselect, and chart removal. Distinct from the design-mode
//          editor sub-selection (selectionHandler.ts).

import type { ChartSelectionMap, ParamSpec } from "../types";

/**
 * Marks whose painters consume data.selection (and so can highlight a point
 * selection). Click capture is gated to these — other marks keep the normal
 * sub-selection click behavior.
 */
export const SELECTION_SUPPORTED_MARKS: ReadonlySet<string> = new Set([
  "bar", "horizontalBar", "scatter", "bubble",
]);

/**
 * Whether a hit-test result landed on an actual datum (vs the plot background /
 * an axis / a miss). hitTestGeometry always returns an object, so callers must
 * test the type rather than truthiness.
 */
export function isDataHit(hit: { type: string } | null | undefined): boolean {
  return hit != null && (hit.type === "bar" || hit.type === "point" || hit.type === "slice");
}

const store = new Map<string, ChartSelectionMap>();

/** The live point-selection for a chart, or undefined when nothing is selected. */
export function getPointSelection(chartId: string): ChartSelectionMap | undefined {
  return store.get(chartId);
}

/** Replace a chart's point-selection (one entry per select-param name). */
export function setPointSelection(chartId: string, selection: ChartSelectionMap): void {
  store.set(chartId, selection);
}

/** Clear a chart's point-selection. Returns true if anything was cleared. */
export function clearPointSelection(chartId: string): boolean {
  return store.delete(chartId);
}

/** Clear every chart's point-selection (e.g. on data edit / deactivation). */
export function clearAllPointSelections(): void {
  store.clear();
}

/** The stable string key a click selects on, per the param's `on` mode. Pure. */
export function pointSelectionKey(
  hit: { seriesName?: string; categoryName?: string },
  on: "category" | "series",
): string {
  return on === "series" ? hit.seriesName ?? "" : hit.categoryName ?? "";
}

/** Build a single-datum selection map for one select-param. Pure. */
export function buildPointSelection(
  paramName: string,
  on: "category" | "series",
  key: string,
): ChartSelectionMap {
  return { [paramName]: { on, values: [key] } };
}

/**
 * The unique selection keys covered by a brush (S6) — each hit's category or
 * series name per `on`, de-duplicated, blanks dropped. Pure. A zero-size brush
 * (a click) yields the single datum under the point. Empty => clears selection.
 */
export function brushKeysFromHits(
  hits: ReadonlyArray<{ categoryName?: string; seriesName?: string }>,
  on: "category" | "series",
): string[] {
  const out: string[] = [];
  for (const h of hits) {
    const k = on === "series" ? h.seriesName ?? "" : h.categoryName ?? "";
    if (k !== "" && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * The other charts that mirror a cross-chart-linked selection (S7b): every chart
 * (except the source) with a select:"point" param whose sharedAs matches. Pure.
 */
export function matchingSharedParams(
  charts: ReadonlyArray<{ chartId: string; spec: { params?: ParamSpec[] } }>,
  sourceChartId: string,
  sharedAs: string,
): Array<{ chartId: string; paramName: string; on: "category" | "series" }> {
  const out: Array<{ chartId: string; paramName: string; on: "category" | "series" }> = [];
  for (const c of charts) {
    if (c.chartId === sourceChartId) continue;
    const p = c.spec.params?.find((pp) => pp.select === "point" && pp.sharedAs === sharedAs);
    // The target's OWN `on` defines the dimension its selection keys on — not the
    // source's. (An incompatible source/target `on` simply won't match, which
    // degrades to no highlight rather than keying the wrong field.)
    if (p) out.push({ chartId: c.chartId, paramName: p.name, on: p.on ?? "category" });
  }
  return out;
}
