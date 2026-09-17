//! FILENAME: app/src/api/chartCues.ts
// PURPOSE: The transient "points of interest" channel for charts — a cue is a
//          mark drawn OVER a chart at a datum, on or off, never in the spec.
// CONTEXT: Every visual state a chart has today is persisted state: layers and
//          dataPointOverrides live in the spec, and `updateChartSpec` is a
//          document mutation that dirties the file and enters undo. An insight
//          overlay is a LENS, not an edit (docs/design/insight-overlays.md §1),
//          so it needs a channel the spec never sees. This is that channel: a
//          store keyed by chart id, cleared on document open/new like every
//          document-scoped store, and read by the Charts painter at composite
//          time — the same place selection highlights and tooltips are drawn.
//
//          THE SEAM RUNS ONE WAY. Insights (the consumer) says WHAT: a fact id,
//          a datum, a polarity. Charts (the painter) decides HOW a ring looks on
//          a bar, a line point or a pie slice through its own hit geometry, so
//          a stacked or grouped bar is solved where hit-testing already solved
//          it. Nothing here names pixels; nothing here imports an extension.
//
//          THE ANCHOR CARRIES ITS OWN CHECK. `categoryIndex` is the painter-space
//          index the snapshot (`@api/chartData`) reported, and `categoryLabel`
//          is what the fact said that category is called. The painter refuses
//          to draw when the two disagree — a stale index after a filter or a
//          data change is the encircled wrong bar, and a dropped ring is the
//          only honest answer.
//
//          THE VOCABULARY IS CLOSED (§4.2): five kinds, four anchors, and no
//          sixth of either without a measured reason. `@api/insightCues` is
//          the only producer; the Charts painter is the only consumer.

/** Good / bad come from a declared direction, never from a number's sign. */
export type ChartCuePolarity = "good" | "bad" | "attention" | "neutral";

/** The closed cue vocabulary (docs/design/insight-overlays.md §4.2). */
export type ChartCueKind = "ring" | "emphasis" | "band" | "rule" | "callout";

/**
 * One datum on a chart: a series by NAME (indices shift when a series is
 * hidden; names do not) and a category by painter-space index, with the label
 * the fact used so the painter can validate before it draws.
 */
export interface ChartCueDatumAnchor {
  type: "datum";
  series: string;
  categoryIndex: number;
  categoryLabel: string;
}

/** A whole series (the largest of several, say). */
export interface ChartCueSeriesAnchor {
  type: "series";
  series: string;
}

/** A run of categories, inclusive, in painter-space indices. */
export interface ChartCueSpanAnchor {
  type: "span";
  series?: string;
  from: number;
  to: number;
}

/** A data value on the value axis (a fence, a target). */
export interface ChartCueLevelAnchor {
  type: "level";
  series?: string;
  value: number;
}

export type ChartCueAnchor =
  | ChartCueDatumAnchor
  | ChartCueSeriesAnchor
  | ChartCueSpanAnchor
  | ChartCueLevelAnchor;

export interface ChartCue {
  /** The fact this cue is the picture of. A cue with no fact behind it is a defect. */
  factId: string;
  kind: ChartCueKind;
  polarity: ChartCuePolarity;
  anchor: ChartCueAnchor;
  /** The fact's own deterministic sentence. */
  label?: string;
  /** A few words for the stepper: "Highest Revenue", "Level shift in Cost". Deterministic. */
  description?: string;
}

type Listener = (chartId: string) => void;

const cuesByChart = new Map<string, readonly ChartCue[]>();
const listeners = new Set<Listener>();

function notify(chartId: string): void {
  for (const l of [...listeners]) l(chartId);
}

/**
 * Replace a chart's cues. An empty list clears the entry. The stored list is a
 * frozen copy, so a caller mutating its own array afterwards changes nothing.
 */
export function setChartCues(chartId: string, cues: readonly ChartCue[]): void {
  if (cues.length === 0) {
    clearChartCues(chartId);
    return;
  }
  cuesByChart.set(chartId, Object.freeze(cues.map((c) => ({ ...c, anchor: { ...c.anchor } }))));
  notify(chartId);
}

/** Drop one chart's cues. Notifies only if there was something to drop. */
export function clearChartCues(chartId: string): void {
  if (!cuesByChart.delete(chartId)) return;
  notify(chartId);
}

/** Drop every chart's cues — document open/new, extension teardown. */
export function clearAllChartCues(): void {
  const ids = [...cuesByChart.keys()];
  cuesByChart.clear();
  for (const id of ids) notify(id);
}

const NONE: readonly ChartCue[] = Object.freeze([]);

/** A chart's current cues, or an empty (frozen) list. */
export function getChartCues(chartId: string): readonly ChartCue[] {
  return cuesByChart.get(chartId) ?? NONE;
}

/** Chart ids that currently carry at least one cue. */
export function listChartsWithCues(): string[] {
  return [...cuesByChart.keys()];
}

/** Subscribe to per-chart changes. Returns the unsubscribe. */
export function onChartCuesChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
