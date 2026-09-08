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

export interface ChartSeriesSnapshot {
  chartId: string;
  name: string;
  title: string | null;
  sheetIndex: number;
  mark: string;
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
