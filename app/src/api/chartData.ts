//! FILENAME: app/src/api/chartData.ts
// PURPOSE: Feature-neutral access to a chart's RESOLVED series, so something
//          other than Charts can reason about what a chart shows.
// CONTEXT: "Explain this chart" needs the numbers behind it. Those numbers only
//          exist in TypeScript: Rust stores a chart's spec as an opaque JSON
//          string and validates three fields of it, while the resolution — the
//          pivot source, the design query, the transforms, the filters, the
//          params — all lives in the Charts extension. So the seam runs the
//          other way from most: Charts RESOLVES, and the analysis happens
//          elsewhere on the result.
//
//          THE `null` IN `values` IS THE WHOLE POINT. The chart renderer reads
//          formatted DISPLAY strings and turns anything unparseable into 0,
//          which is right for drawing a bar and a lie for computing a trend: a
//          blank month becomes a zero and the series appears to collapse. An
//          implementation of this seam must return `null` for a cell that holds
//          no number, and should re-read the source range TYPED rather than
//          re-parsing what was rendered.
//
//          Mirrors `chartParams.ts`, which is the established precedent for
//          reaching Charts without importing it.

export interface ChartDataSummary {
  chartId: string;
  name: string;
  title: string | null;
  sheetIndex: number;
  /** "bar", "line", "pie", … or a registered custom mark. */
  mark: string;
  sourceKind: "range" | "pivot" | "designQuery" | "concat";
}

/**
 * The strategy behind a chart, when the chart knows it.
 *
 * A design-query chart holds its connection and the DSL that names its
 * measures, so each plotted series can be traced back to the measure it
 * plots — and the measure's declared direction ("lower is better" for a cost)
 * is what lets a fact about that series say "worst month" instead of "peak".
 * A range chart has no such thing and leaves this absent.
 */
export interface ChartSeriesStrategy {
  connectionId: string;
  /** Plotted series name → the model measure it plots. Only series that resolve are listed. */
  measures: ReadonlyArray<{ series: string; measure: string }>;
}

export interface ChartSeriesSnapshot {
  chartId: string;
  name: string;
  title: string | null;
  sheetIndex: number;
  mark: string;
  /** Present for a design-query chart whose series map to model measures. */
  strategy?: ChartSeriesStrategy;
  /** The category labels as drawn, in draw order. */
  categories: readonly string[];
  /** What the categories ARE, which decides whether time-series facts apply. */
  categoryKind: "nominal" | "quantitative" | "temporal";
  /** Numeric category positions when there are any (epoch ms for temporal). */
  categoryValues?: readonly number[];
  series: ReadonlyArray<{
    name: string;
    /** `null` where the source held no number. NEVER a substituted zero. */
    values: readonly (number | null)[];
    /** Where this series came from, so a fact can point at it. */
    evidence?: {
      sheetIndex: number;
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
    };
  }>;
  /** True when points were dropped to fit the cap, so a fact can say so. */
  truncated: boolean;
  /**
   * Caveats that apply to these numbers. Empty when every value was re-read
   * typed from its source cells.
   *
   * It lives on the seam rather than on the implementation because the caveat
   * has to travel WITH the numbers: a pivot-backed chart's values come from
   * rendered strings and cannot be re-read typed, and the analysis that turns
   * them into a sentence is the code that needs to say so. A note the provider
   * knows and the consumer cannot see is a note nobody reads.
   */
  assumptions?: readonly string[];
}

export interface ChartDataProvider {
  listCharts(sheetIndex?: number): ChartDataSummary[];
  /**
   * Resolve a chart's series to numbers.
   *
   * Returns null for a chart that has no single series set to report — a
   * concat container, say. A caller shows "pick one of its child charts"
   * rather than an empty analysis.
   */
  resolveSeries(chartId: string, maxPoints: number): Promise<ChartSeriesSnapshot | null>;
  /** The chart the user has selected, when one is. */
  getSelectedChartId(): string | null;
}

/**
 * Above this, a snapshot is stride-sampled before it crosses to the analysis.
 *
 * A chart with more points than this is not a chart anyone is reading
 * point-by-point, and the facts that matter (trend, seasonality, change points)
 * survive sampling. The cap exists because the snapshot crosses an IPC boundary.
 */
export const CHART_SERIES_MAX_POINTS = 10_000;

let provider: ChartDataProvider | null = null;

/** Provide the implementation. Called once by Charts in activate(), null on deactivate. */
export function registerChartDataProvider(impl: ChartDataProvider | null): void {
  provider = impl;
}

export function getChartDataProvider(): ChartDataProvider | null {
  return provider;
}

/** Charts on a sheet, or [] when Charts is unavailable. */
export function listChartsForData(sheetIndex?: number): ChartDataSummary[] {
  return provider ? provider.listCharts(sheetIndex) : [];
}

/** A chart's numbers, or null when Charts is unavailable or the chart has none. */
export function resolveChartSeries(
  chartId: string,
  maxPoints: number = CHART_SERIES_MAX_POINTS,
): Promise<ChartSeriesSnapshot | null> {
  return provider ? provider.resolveSeries(chartId, maxPoints) : Promise.resolve(null);
}

/** The selected chart id, or null. */
export function getSelectedChartId(): string | null {
  return provider ? provider.getSelectedChartId() : null;
}

// ============================================================================
// The RIGHT-CLICKED target
// ============================================================================

/**
 * Every chart element a right-click can land on.
 *
 * THIS IS A DELIBERATE SECOND SPELLING of `CHART_ELEMENT_IDS` in
 * `app/extensions/Charts/types.ts`, and it exists because `@api` must never
 * import from `app/extensions` — the Alien Rule is not negotiable for the
 * convenience of one union. Two spellings of one fact is exactly the defect
 * class CI-7 spent its whole budget removing, so the copy is PINNED: the drift
 * guard in `ChartContextMenu.test.tsx` imports both arrays and asserts set
 * equality in BOTH directions, plus a compile-time assignability check each
 * way. Add a member to either list without the other and that test fails.
 */
export const CHART_TARGET_ELEMENTS = [
  "chartArea",
  "plotArea",
  "datum",
  "title",
  "xAxisTitle",
  "yAxisTitle",
  "xAxis",
  "yAxis",
  "legend",
  "legendEntry",
  "trendline",
  "errorBars",
  "dataLabel",
  "dataTable",
  "filterButton",
  "none",
] as const;

/** Name of the chart element a right-click landed on. */
export type ChartTargetElement = (typeof CHART_TARGET_ELEMENTS)[number];

/**
 * What a right-click was ON — the subject a context-menu item must act on.
 *
 * THE DEFECT THIS EXISTS FOR: a menu item acted on whatever the last LEFT
 * click had selected, so right-clicking bar B while bar A was selected
 * formatted A. `ChartContextMenuContribution` carries only a `chartId` and
 * widening it would change the subject of all six existing contributions, so
 * the subject travels beside the seam instead of inside the contract.
 *
 * LIFETIME: exactly one right-click. The chart's right-click handler REPLACES
 * it on every `contextmenu` event (writing `null` for a right-click that was
 * not on a chart), so a reader inside a menu that was just opened always sees
 * that menu's own subject. It is NOT a general "what is selected" query — a
 * ribbon command must ask the selection, not this. It is deliberately not
 * cleared when the menu unmounts, because `onClose()` runs BEFORE a
 * contribution's `onSelect` and clearing on unmount would hand every
 * contribution a null subject.
 */
export interface ChartRightClickTarget {
  chartId: string;
  element: ChartTargetElement;
  /**
   * PAINTER-space (post-filter) series index, when the element has one: a
   * datum, or the series a legend entry stands for.
   */
  seriesIndex?: number;
  /**
   * PAINTER-space point index within the series. ABSENT is Excel's
   * `PointIndex = -1` — the whole series rather than one of its points, which
   * is what decides "Format Data Series..." vs "Format Data Point...".
   */
  pointIndex?: number;
  /**
   * The same pair in AUTHORING (pre-filter) space.
   *
   * `dataPointOverrides` are keyed in authoring space while the hit test
   * answers in painter space, so a chart with a hidden series or category
   * aliases an override onto the wrong datum unless the recorder translates.
   * Absent means "no translation was available"; a consumer then falls back to
   * the painter pair, which is identical whenever no filter is active.
   */
  authoring?: { seriesIndex: number; pointIndex: number };
  /** Resolved series name, as drawn. */
  seriesName?: string;
  /** Resolved category label, as drawn. */
  categoryName?: string;
  /** The datum's value. */
  value?: number;
  /** Which axis, for `xAxis` / `yAxis`. */
  axisType?: "x" | "y";
}

let rightClickTarget: ChartRightClickTarget | null = null;

/**
 * Record the subject of the right-click that is about to open a menu.
 *
 * Called by the chart's `contextmenu` handler for EVERY right-click, `null`
 * included — a right-click that opens no chart menu must not leave the previous
 * one standing.
 */
export function setChartRightClickTarget(target: ChartRightClickTarget | null): void {
  rightClickTarget = target;
}

/**
 * The subject of the right-click that opened the current menu.
 *
 * Pass `chartId` to get it only when it belongs to THAT chart: a target
 * recorded on another chart is not this menu's subject, and answering with it
 * would reintroduce the very defect the record exists to fix.
 */
export function getChartRightClickTarget(chartId?: string): ChartRightClickTarget | null {
  if (rightClickTarget === null) return null;
  if (chartId !== undefined && rightClickTarget.chartId !== chartId) return null;
  return rightClickTarget;
}
