//! FILENAME: app/extensions/Charts/types.ts
// PURPOSE: Chart specification types (Vega-Lite inspired, simplified).
// CONTEXT: The ChartSpec is the single source of truth for chart rendering.
//          The dialog produces it, the renderer reads it, the script editor exposes it.

// ============================================================================
// Chart Types
// ============================================================================

/** Supported chart types. */
export type ChartType =
  | "bar"
  | "horizontalBar"
  | "line"
  | "area"
  | "scatter"
  | "pie"
  | "donut"
  | "waterfall"
  | "combo"
  | "radar"
  | "bubble"
  | "histogram"
  | "funnel"
  | "treemap"
  | "stock"
  | "boxPlot"
  | "sunburst"
  | "pareto";

/** Chart types that use cartesian axes (X/Y). */
export type CartesianChartType = "bar" | "horizontalBar" | "line" | "area" | "scatter" | "waterfall" | "combo" | "bubble" | "histogram" | "stock" | "boxPlot" | "pareto";

/** Chart types that use polar/radial layout (no axes). */
export type RadialChartType = "pie" | "donut" | "radar";

/** Check if a chart type uses cartesian axes. */
export function isCartesianChart(mark: ChartType): mark is CartesianChartType {
  return mark !== "pie" && mark !== "donut" && mark !== "radar" && mark !== "funnel" && mark !== "treemap" && mark !== "sunburst";
}

// ============================================================================
// Mark-Specific Options
// ============================================================================

/** Stacking mode for bar, line, and area charts. */
export type StackMode = "none" | "stacked" | "percentStacked";

/** Error bar configuration for showing uncertainty/variability. */
export interface ErrorBarOptions {
  /** Whether error bars are enabled. */
  enabled: boolean;
  /** How to compute error bar extent. */
  type: "standardError" | "percentage" | "standardDeviation" | "custom";
  /** Value for percentage (e.g., 10 = +/-10%) or stddev multiplier. Default: 10 */
  value?: number;
  /** Which direction to draw error bars. Default: "both" */
  direction: "both" | "plus" | "minus";
  /** Override color (hex). Null = use dark gray. Default: "#333333" */
  color?: string;
  /** Line width in pixels. Default: 1.5 */
  lineWidth?: number;
}

/** Options specific to bar and horizontal bar charts. */
export interface BarMarkOptions {
  /** Border radius on bars (pixels). Default: 2 */
  borderRadius?: number;
  /** Gap between bars in a group (pixels). Default: 2 */
  barGap?: number;
  /** Stacking mode. Default: "none" */
  stackMode?: StackMode;
  /** Error bars configuration. */
  errorBars?: ErrorBarOptions;
}

/** Line interpolation mode. */
export type LineInterpolation = "linear" | "smooth" | "step";

/** Options specific to line charts. */
export interface LineMarkOptions {
  /** Interpolation mode for connecting data points. Default: "linear" */
  interpolation?: LineInterpolation;
  /** Line width in pixels. Default: 2 */
  lineWidth?: number;
  /** Show point markers at data points. Default: true */
  showMarkers?: boolean;
  /** Point marker radius in pixels. Default: 4 */
  markerRadius?: number;
  /** Stacking mode. Default: "none" */
  stackMode?: StackMode;
  /** Error bars configuration. */
  errorBars?: ErrorBarOptions;
}

/** Options specific to area charts. */
export interface AreaMarkOptions {
  /** Interpolation mode. Default: "linear" */
  interpolation?: LineInterpolation;
  /** Line width in pixels. Default: 2 */
  lineWidth?: number;
  /** Fill opacity (0-1). Default: 0.3 */
  fillOpacity?: number;
  /** Show point markers. Default: false */
  showMarkers?: boolean;
  /** Marker radius in pixels. Default: 4 */
  markerRadius?: number;
  /** Stack overlapping areas. Default: false */
  stacked?: boolean;
  /** Stacking mode (supercedes `stacked` boolean). Default: "none" */
  stackMode?: StackMode;
}

/** Scatter point shape. */
export type PointShape = "circle" | "square" | "diamond" | "triangle";

/** Options specific to scatter charts. */
export interface ScatterMarkOptions {
  /** Point shape. Default: "circle" */
  pointShape?: PointShape;
  /** Point size (radius in pixels). Default: 5 */
  pointSize?: number;
  /** Error bars configuration. */
  errorBars?: ErrorBarOptions;
}

/** Options specific to pie and donut charts. */
export interface PieMarkOptions {
  /** Inner radius ratio (0 = pie, 0.4-0.7 = donut). Overridden to 0 for "pie", >0 for "donut". */
  innerRadiusRatio?: number;
  /** Start angle in degrees. Default: 0 (12 o'clock) */
  startAngle?: number;
  /** Padding angle between slices in degrees. Default: 1 */
  padAngle?: number;
  /** Show value/percentage labels on slices. Default: true */
  showLabels?: boolean;
  /** Label format: "value", "percent", or "both". Default: "percent" */
  labelFormat?: "value" | "percent" | "both";
}

/** Waterfall bar classification. */
export type WaterfallBarType = "increase" | "decrease" | "total";

/** Options specific to waterfall charts. */
export interface WaterfallMarkOptions {
  /** Show connector lines between bars. Default: true */
  showConnectors?: boolean;
  /** Color for increasing bars. Default: palette-derived green */
  increaseColor?: string;
  /** Color for decreasing bars. Default: palette-derived red */
  decreaseColor?: string;
  /** Color for total bars. Default: palette-derived blue/gray */
  totalColor?: string;
  /** Indices of categories that are totals (running sum resets). */
  totalIndices?: number[];
}

/** Mark type override for individual series in a combo chart. */
export type ComboSeriesMark = "bar" | "line" | "area";

/** Options specific to combo charts. */
export interface ComboMarkOptions {
  /** Per-series mark type overrides. Key = series index, value = mark type. */
  seriesMarks?: Record<number, ComboSeriesMark>;
  /** Enable secondary (right) Y axis. Default: false */
  secondaryYAxis?: boolean;
  /** Series indices that use the secondary Y axis. */
  secondaryAxisSeries?: number[];
  /** Secondary Y axis configuration. */
  secondaryAxis?: AxisSpec;
}

/** Options specific to radar charts. */
export interface RadarMarkOptions {
  /** Show filled polygon behind lines. Default: true */
  showFill?: boolean;
  /** Fill opacity (0-1). Default: 0.2 */
  fillOpacity?: number;
  /** Line width in pixels. Default: 2 */
  lineWidth?: number;
  /** Show point markers at vertices. Default: true */
  showMarkers?: boolean;
  /** Point marker radius in pixels. Default: 4 */
  markerRadius?: number;
}

/** Options specific to bubble charts. */
export interface BubbleMarkOptions {
  /** Index of the series whose values determine bubble size. Default: last series index */
  sizeSeriesIndex?: number;
  /** Minimum bubble radius in pixels. Default: 4 */
  minBubbleSize?: number;
  /** Maximum bubble radius in pixels. Default: 30 */
  maxBubbleSize?: number;
  /** Bubble opacity (0-1). Default: 0.7 */
  bubbleOpacity?: number;
}

/** Options specific to histogram charts. */
export interface HistogramMarkOptions {
  /** Number of bins. Default: 10 */
  binCount?: number;
  /** Border radius on bars (pixels). Default: 1 */
  borderRadius?: number;
}

/** Options specific to funnel charts. */
export interface FunnelMarkOptions {
  /** Width ratio of the narrowest section (0-1). Default: 0.3 */
  neckWidthRatio?: number;
  /** Show value labels on sections. Default: true */
  showLabels?: boolean;
  /** Label format: "value", "percent", or "both". Default: "both" */
  labelFormat?: "value" | "percent" | "both";
  /** Gap between sections in pixels. Default: 2 */
  sectionGap?: number;
}

/** Options specific to treemap charts. */
export interface TreemapMarkOptions {
  /** Show category labels on tiles. Default: true */
  showLabels?: boolean;
  /** Label format: "category", "value", "both". Default: "both" */
  labelFormat?: "category" | "value" | "both";
  /** Border width between tiles in pixels. Default: 2 */
  tileBorderWidth?: number;
  /** Border color between tiles. Default: "#ffffff" */
  tileBorderColor?: string;
  /** Tile corner radius in pixels. Default: 2 */
  tileRadius?: number;
}

/** Stock chart display style. */
export type StockStyle = "candlestick" | "ohlc";

/** Options specific to stock (OHLC/Candlestick) charts. */
export interface StockMarkOptions {
  /** Display style. Default: "candlestick" */
  style?: StockStyle;
  /** Color for up (close > open) candles/bars. Default: "#4CAF50" */
  upColor?: string;
  /** Color for down (close < open) candles/bars. Default: "#E53935" */
  downColor?: string;
  /** Candle body width as fraction of available space (0-1). Default: 0.6 */
  bodyWidth?: number;
  /** Wick/shadow line width in pixels. Default: 1 */
  wickWidth?: number;
  /**
   * Series index mapping for OHLC data. The data must contain 4 series
   * in this order: Open, High, Low, Close. These indices refer to the
   * order within spec.series[]. Default: [0, 1, 2, 3].
   */
  ohlcIndices?: [number, number, number, number];
}

/** Options specific to box & whisker (box plot) charts. */
export interface BoxPlotMarkOptions {
  /** Width of each box as fraction of available space (0-1). Default: 0.5 */
  boxWidth?: number;
  /** Show individual outlier points beyond whiskers. Default: true */
  showOutliers?: boolean;
  /** Outlier point radius in pixels. Default: 3 */
  outlierRadius?: number;
  /** Median line color override. Null = use contrasting color. Default: null */
  medianColor?: string | null;
  /** Median line width in pixels. Default: 2 */
  medianLineWidth?: number;
  /** Whisker line width in pixels. Default: 1 */
  whiskerLineWidth?: number;
  /** Show mean marker (diamond). Default: false */
  showMean?: boolean;
}

/** Options specific to sunburst charts. */
export interface SunburstMarkOptions {
  /** Show labels on arc segments. Default: true */
  showLabels?: boolean;
  /** Label format: "category", "value", "percent", "both". Default: "category" */
  labelFormat?: "category" | "value" | "percent" | "both";
  /** Inner radius of the center hole as fraction of total radius (0-0.5). Default: 0.15 */
  innerRadiusRatio?: number;
  /** Padding angle between segments in degrees. Default: 0.5 */
  padAngle?: number;
  /** Level separator in category labels (to define hierarchy). Default: " > " */
  levelSeparator?: string;
}

/** Options specific to Pareto charts. */
export interface ParetoMarkOptions {
  /** Border radius on bars (pixels). Default: 2 */
  borderRadius?: number;
  /** Color for the cumulative percentage line. Default: "#E53935" */
  lineColor?: string;
  /** Line width in pixels. Default: 2 */
  lineWidth?: number;
  /** Show point markers on the cumulative line. Default: true */
  showMarkers?: boolean;
  /** Marker radius in pixels. Default: 4 */
  markerRadius?: number;
  /** Show the 80% reference line. Default: true */
  show80PercentLine?: boolean;
}

/** Options for rule marks (reference lines). Used in layers. */
export interface RuleMarkOptions {
  /** Y value for a horizontal reference line. */
  y?: number;
  /** X category index for a vertical reference line. */
  x?: number;
  /** Line color. Default: "#999999" */
  color?: string;
  /** Stroke width in pixels. Default: 1 */
  strokeWidth?: number;
  /** Dash pattern (e.g., [6, 3]). Default: [] (solid) */
  strokeDash?: number[];
  /** Label displayed near the line. */
  label?: string;
}

/** Options for text marks (annotations). Used in layers. */
export interface TextMarkOptions {
  /** X position as category index. */
  x?: number;
  /** Y position as data value. */
  y?: number;
  /** Text content to display. Supports cell references like "=A1". */
  text: string;
  /** Font size in pixels. Default: 11 */
  fontSize?: number;
  /** Text color. Default: "#333333" */
  color?: string;
  /** Horizontal anchor. Default: "middle" */
  anchor?: "start" | "middle" | "end";
  /** Vertical baseline. Default: "middle" */
  baseline?: "top" | "middle" | "bottom";
}

/** Union of all mark-specific options. */
export type MarkOptions =
  | BarMarkOptions
  | LineMarkOptions
  | AreaMarkOptions
  | ScatterMarkOptions
  | PieMarkOptions
  | WaterfallMarkOptions
  | ComboMarkOptions
  | RadarMarkOptions
  | BubbleMarkOptions
  | HistogramMarkOptions
  | FunnelMarkOptions
  | TreemapMarkOptions
  | StockMarkOptions
  | BoxPlotMarkOptions
  | SunburstMarkOptions
  | ParetoMarkOptions
  | RuleMarkOptions
  | TextMarkOptions;

/** How series data is oriented within the data range. */
export type SeriesOrientation = "columns" | "rows";

// ============================================================================
// Per-Series Cell References (for SERIES formula reconstruction)
// ============================================================================

/**
 * Per-series cell references from XLSX import or user-defined.
 * Used to reconstruct the Excel-style =SERIES(name, categories, values, order) formula
 * and to highlight the source ranges when a series is selected.
 */
export interface SeriesRef {
  /** Cell reference for the series name (e.g., "Sheet1!$B$1"). */
  nameRef?: string;
  /** Range reference for category labels (e.g., "Sheet1!$A$2:$A$10"). */
  catRef?: string;
  /** Range reference for series values (e.g., "Sheet1!$B$2:$B$10"). */
  valRef?: string;
}

// ============================================================================
// Data Source
// ============================================================================

/** A cell range reference (0-indexed, inclusive). */
export interface DataRangeRef {
  /** Sheet index (0-based). */
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * A pivot table data source for a PivotChart.
 * The chart reads its data directly from the pivot table's aggregated output
 * instead of from a cell range.
 */
export interface PivotDataSource {
  /** Discriminant tag. */
  type: "pivot";
  /** The pivot table ID to read data from. */
  pivotId: number;
  /** Whether to include subtotal rows as categories. Default: false. */
  includeSubtotals?: boolean;
  /** Whether to include grand total row as a category. Default: false. */
  includeGrandTotal?: boolean;
}

/**
 * Data source for a chart. Can be:
 * - A `DataRangeRef` object (explicit cell coordinates)
 * - A string in A1 notation (e.g., "Sheet1!A1:D10")
 * - A named range name (e.g., "SalesData")
 * - A `PivotDataSource` object (reads from a pivot table's aggregated data)
 */
export type DataSource = DataRangeRef | string | PivotDataSource;

/** Type guard: check if a DataSource is a resolved DataRangeRef. */
export function isDataRangeRef(source: DataSource): source is DataRangeRef {
  return typeof source === "object" && source !== null && "startRow" in source;
}

/** Type guard: check if a DataSource is a PivotDataSource. */
export function isPivotDataSource(source: DataSource): source is PivotDataSource {
  return typeof source === "object" && source !== null && "type" in source && (source as PivotDataSource).type === "pivot";
}

// ============================================================================
// Series
// ============================================================================

/** A single data series within the chart. */
export interface ChartSeries {
  /** Human-readable series name (from header cell or user override). */
  name: string;
  /** Column or row index within the data range that holds this series' values. */
  sourceIndex: number;
  /** Override color (hex). Null = use palette color. */
  color: string | null;
  /** Per-data-point visual encoding overrides. */
  encoding?: SeriesEncoding;
}

// ============================================================================
// Conditional Encoding
// ============================================================================

/** Per-data-point visual property overrides for a series. */
export interface SeriesEncoding {
  /** Color override — static, or conditional based on data value/category. */
  color?: ConditionalValue<string>;
  /** Opacity override (0-1). */
  opacity?: ConditionalValue<number>;
  /** Size override (for scatter/bubble point radius). */
  size?: ConditionalValue<number>;
  /** Stroke dash pattern override. */
  strokeDash?: number[];
  /** Stroke width override. */
  strokeWidth?: number;
}

/**
 * A value that can be static or conditional.
 * - Static: just the value (e.g., "#FF0000")
 * - Conditional: { condition, value, otherwise }
 */
export type ConditionalValue<T> =
  | T
  | { condition: ValueCondition; value: T; otherwise: T };

/** Condition for conditional encoding, evaluated per data point. */
export interface ValueCondition {
  /** Which field to test: "value" (numeric data value) or "category" (category label). */
  field: "value" | "category";
  /** Greater than. */
  gt?: number;
  /** Less than. */
  lt?: number;
  /** Greater than or equal. */
  gte?: number;
  /** Less than or equal. */
  lte?: number;
  /** Value is one of these. */
  oneOf?: (string | number)[];
}

// ============================================================================
// Axis & Legend
// ============================================================================

// ============================================================================
// Scale Specification
// ============================================================================

/** Scale type for value axes. */
export type ScaleType = "linear" | "log" | "pow" | "sqrt";

/** Scale configuration for a value axis. */
export interface ScaleSpec {
  /** Scale type. Default: "linear" */
  type?: ScaleType;
  /** Override data extent [min, max]. Default: auto from data. */
  domain?: [number, number];
  /** Include zero in the domain. Default: true for bar, false for line/scatter. */
  zero?: boolean;
  /** Extend domain to nice round numbers. Default: true */
  nice?: boolean;
  /** Reverse the scale direction. Default: false */
  reverse?: boolean;
  /** Exponent for "pow" scale type. Default: 2 */
  exponent?: number;
}

/** Axis configuration. */
export interface AxisSpec {
  /** Axis title (null = auto from headers). */
  title: string | null;
  /** Show grid lines. */
  gridLines: boolean;
  /** Show axis labels. */
  showLabels: boolean;
  /** Label rotation in degrees (0, 45, 90). */
  labelAngle: number;
  /** Min value for value axis (null = auto). */
  min: number | null;
  /** Max value for value axis (null = auto). */
  max: number | null;
  /** Scale configuration for this axis. */
  scale?: ScaleSpec;
  /** Desired number of tick marks. Default: 5 */
  tickCount?: number;
  /** Number format string for tick labels (e.g., ",.2f", "$,.0f", "%"). */
  tickFormat?: string;
}

/** Legend configuration. */
export interface LegendSpec {
  /** Whether to show the legend. */
  visible: boolean;
  /** Legend position. */
  position: "top" | "bottom" | "left" | "right";
}

// ============================================================================
// Layer Specification
// ============================================================================

/** Mark types available in layers (chart types + annotation marks). */
export type LayerMarkType = ChartType | "rule" | "text";

/** A layer overlaid on the primary chart. */
export interface LayerSpec {
  /** Mark type for this layer. */
  mark: LayerMarkType;
  /** Layer-specific data source. If omitted, shares the parent chart's data. */
  data?: DataSource;
  /** Series definitions for this layer (if omitted, uses parent's series). */
  series?: ChartSeries[];
  /** Mark-specific options for this layer. */
  markOptions?: MarkOptions;
  /** Opacity for the entire layer (0-1). Default: 1 */
  opacity?: number;
}

// ============================================================================
// Data Transforms
// ============================================================================

/** Aggregation operations. */
export type AggregateOp = "sum" | "mean" | "median" | "min" | "max" | "count";

/** Window (running) operations. */
export type WindowOp = "running_sum" | "running_mean" | "rank";

/** Filter transform: remove data points where the predicate is false. */
export interface FilterTransform {
  type: "filter";
  /** Series name to evaluate. Use "$category" for the category label. */
  field: string;
  /**
   * Predicate string applied to each value: "> 100", "!= 0", "<= 50",
   * "= someText" (for categories). Supports: >, <, >=, <=, =, !=
   */
  predicate: string;
}

/** Sort transform: reorder data points by a field's values. */
export interface SortTransform {
  type: "sort";
  /** Series name to sort by. Use "$category" for alphabetical category sort. */
  field: string;
  /** Sort order. Default: "asc". */
  order?: "asc" | "desc";
}

/** Aggregate transform: group by categories and reduce series values. */
export interface AggregateTransform {
  type: "aggregate";
  /** Fields to group by (typically ["$category"] or a subset). */
  groupBy: string[];
  /** Aggregation operation. */
  op: AggregateOp;
  /** Series name whose values to aggregate. */
  field: string;
  /** Name for the resulting series. */
  as: string;
}

/** Calculate transform: create a new series from a simple expression. */
export interface CalculateTransform {
  type: "calculate";
  /**
   * Expression string. Supports references to series by name:
   * "Revenue * 1.1", "Revenue - Cost", "Revenue / Total * 100"
   * Available variables: series names (spaces replaced with _), $index, $category.
   */
  expr: string;
  /** Name for the resulting series. */
  as: string;
}

/** Window transform: compute a running value over a series. */
export interface WindowTransform {
  type: "window";
  /** Window operation. */
  op: WindowOp;
  /** Series name to compute over. */
  field: string;
  /** Name for the resulting series. */
  as: string;
}

/** Bin transform: group numeric category values into bins. */
export interface BinTransform {
  type: "bin";
  /** Series name whose values to bin. */
  field: string;
  /** Number of bins. Default: 10. */
  binCount?: number;
  /** Name for the binned category output. */
  as: string;
}

/** A data transform step. Applied in sequence before rendering. */
export type TransformSpec =
  | FilterTransform
  | SortTransform
  | AggregateTransform
  | CalculateTransform
  | WindowTransform
  | BinTransform;

// ============================================================================
// Deep Theming & Tooltip Config
// ============================================================================

/**
 * Override any property of the built-in chart render theme.
 * All fields are optional — only specified fields override the defaults.
 */
export interface ThemeOverrides {
  background?: string;
  plotBackground?: string;
  gridLineColor?: string;
  gridLineWidth?: number;
  axisColor?: string;
  axisLabelColor?: string;
  axisTitleColor?: string;
  titleColor?: string;
  legendTextColor?: string;
  fontFamily?: string;
  titleFontSize?: number;
  axisTitleFontSize?: number;
  labelFontSize?: number;
  legendFontSize?: number;
  barBorderRadius?: number;
  barGap?: number;
}

/** Data table configuration (grid of values below the chart plot area). */
export interface DataTableOptions {
  /** Whether the data table is shown. */
  enabled: boolean;
  /** Show legend color swatches in the first column. Default: true */
  showLegendKeys?: boolean;
  /** Show horizontal borders between rows. Default: true */
  showHorizontalBorder?: boolean;
  /** Show vertical borders between columns. Default: true */
  showVerticalBorder?: boolean;
  /** Show outline border around the entire table. Default: true */
  showOutlineBorder?: boolean;
}

/** Chart-level configuration for theming and defaults. */
export interface ChartConfig {
  /** Override any theme property. */
  theme?: ThemeOverrides;
}

/** Tooltip display configuration. */
export interface TooltipSpec {
  /** Whether tooltips are shown on hover. Default: true. */
  enabled?: boolean;
  /** Which fields to display. Default: ["series", "category", "value"]. */
  fields?: Array<"series" | "category" | "value">;
  /** Number format overrides per field (e.g., { "value": "$,.2f" }). */
  format?: Record<string, string>;
}

// ============================================================================
// Data Label Specification
// ============================================================================

/** Position of data labels relative to data points. */
export type DataLabelPosition = "auto" | "above" | "below" | "center" | "inside" | "outside";

/** What content to display in data labels. */
export type DataLabelContent = "value" | "category" | "seriesName" | "percent";

/** Configuration for data labels displayed on chart data points. */
export interface DataLabelSpec {
  /** Whether data labels are shown. Default: false. */
  enabled: boolean;
  /** What to display. Default: ["value"]. */
  content?: DataLabelContent[];
  /** Label position relative to data point. Default: "auto". */
  position?: DataLabelPosition;
  /** Font size in pixels. Default: 10. */
  fontSize?: number;
  /** Text color. Default: auto (dark on light, light on dark). */
  color?: string;
  /** Background color for label badge. Null = no background. Default: null. */
  backgroundColor?: string | null;
  /** Number format string (e.g., "$,.2f", ".1%"). Default: auto. */
  format?: string;
  /** Separator between multiple content fields. Default: " - ". */
  separator?: string;
  /** Show labels only for series indices listed. Null = all series. Default: null. */
  seriesFilter?: number[] | null;
  /** Minimum value threshold — hide labels for values below this. Default: null. */
  minValue?: number | null;
}

// ============================================================================
// Trendline Specification
// ============================================================================

/** Supported trendline types. */
export type TrendlineType = "linear" | "exponential" | "polynomial" | "power" | "logarithmic" | "movingAverage";

/** Configuration for a trendline drawn on a chart series. */
export interface TrendlineSpec {
  /** Trendline type. */
  type: TrendlineType;
  /** Index of the series this trendline applies to. Default: 0. */
  seriesIndex?: number;
  /** Override color (hex). Null = use series color (darkened). */
  color?: string | null;
  /** Line width in pixels. Default: 2 */
  lineWidth?: number;
  /** Dash pattern (e.g., [6, 3]). Default: [6, 3] (dashed) */
  strokeDash?: number[];
  /** Polynomial degree (only for "polynomial" type). Default: 2 */
  polynomialDegree?: number;
  /** Window size for moving average (number of data points). Default: 3 */
  movingAveragePeriod?: number;
  /** Show the trendline equation on the chart. Default: false */
  showEquation?: boolean;
  /** Show R-squared value on the chart. Default: false */
  showRSquared?: boolean;
  /** Optional label. If omitted, auto-generated from type. */
  label?: string;
}

// ============================================================================
// Chart Specification (Vega-Lite inspired)
// ============================================================================

/** The complete, declarative chart specification. */
export interface ChartSpec {
  /** Chart type. */
  mark: ChartType;
  /** Data source: a DataRangeRef, an A1 reference string, or a named range name. */
  data: DataSource;
  /** Whether the first row/column of the range contains headers. */
  hasHeaders: boolean;
  /** Whether series are laid out in columns or rows. */
  seriesOrientation: SeriesOrientation;
  /** Index of the column/row used for category labels (e.g., X axis for bar chart). */
  categoryIndex: number;
  /** Series definitions. */
  series: ChartSeries[];
  /** Chart title (null = no title). */
  title: string | null;
  /** X-axis configuration. */
  xAxis: AxisSpec;
  /** Y-axis configuration. */
  yAxis: AxisSpec;
  /** Legend configuration. */
  legend: LegendSpec;
  /** Color palette name. */
  palette: string;
  /** Mark-specific options (type depends on `mark`). */
  markOptions?: MarkOptions;
  /** Additional layers overlaid on the primary chart (annotations, overlays). */
  layers?: LayerSpec[];
  /** Data transform pipeline applied after reading data, before rendering. */
  transform?: TransformSpec[];
  /** Chart-level configuration (theme overrides, defaults). */
  config?: ChartConfig;
  /** Tooltip display configuration. */
  tooltip?: TooltipSpec;
  /** Trendlines overlaid on chart series. */
  trendlines?: TrendlineSpec[];
  /** Data labels displayed on data points. */
  dataLabels?: DataLabelSpec;
  /** Data table displayed below the chart plot area. */
  dataTable?: DataTableOptions;
  /** Per-series cell references for SERIES formula reconstruction (from XLSX import or computed). */
  seriesRefs?: SeriesRef[];
}

// ============================================================================
// Chart Definition (spec + placement)
// ============================================================================

/** A chart definition persisted in the store. */
export interface ChartDefinition {
  /** Unique chart ID. */
  chartId: number;
  /** Display name (e.g., "Chart 1"). */
  name: string;
  /** Sheet index where the chart is rendered. */
  sheetIndex: number;
  /** Position in sheet pixels (from top-left of cell A1). */
  x: number;
  y: number;
  /** Size in pixels. */
  width: number;
  height: number;
  /** The chart specification. */
  spec: ChartSpec;
}

// ============================================================================
// Parsed Data (output of chartDataReader)
// ============================================================================

/** Parsed chart data ready for rendering. */
export interface ParsedChartData {
  /** Category labels (X axis for cartesian, slice labels for radial). */
  categories: string[];
  /** Data series with numeric values, one per category. */
  series: Array<{
    name: string;
    values: number[];
    color: string | null;
  }>;
}

// ============================================================================
// Hit-Testing & Interaction
// ============================================================================

/** Result of hit-testing a point within a chart. */
export interface ChartHitResult {
  /** What type of chart element was hit. */
  type: "bar" | "point" | "slice" | "plotArea" | "title" | "legend" | "axis" | "filterButton" | "none";
  /** Series index (set when a data element is hit). */
  seriesIndex?: number;
  /** Category/data point index (set when a data element is hit). */
  categoryIndex?: number;
  /** Data value. */
  value?: number;
  /** Series name. */
  seriesName?: string;
  /** Category label. */
  categoryName?: string;
  /** Field button info (set when a filter button is hit). */
  fieldButton?: PivotChartFieldButton;
}

/** Hierarchical selection level within a chart. */
export type ChartSelectionLevel = "none" | "chart" | "series" | "dataPoint";

/** Sub-selection state within a selected chart. */
export interface ChartSubSelection {
  level: ChartSelectionLevel;
  /** Selected series index (set at "series" and "dataPoint" levels). */
  seriesIndex?: number;
  /** Selected category index (set at "dataPoint" level). */
  categoryIndex?: number;
}

// ============================================================================
// Hit Geometry (per chart type)
// ============================================================================

/** A computed bar rectangle with metadata, used for hit-testing. */
export interface BarRect {
  seriesIndex: number;
  categoryIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
  seriesName: string;
  categoryName: string;
}

/** A data point marker (for line, area, scatter charts). */
export interface PointMarker {
  seriesIndex: number;
  categoryIndex: number;
  cx: number;
  cy: number;
  radius: number;
  value: number;
  seriesName: string;
  categoryName: string;
}

/** A pie/donut slice. */
export interface SliceArc {
  seriesIndex: number;
  startAngle: number;
  endAngle: number;
  innerRadius: number;
  outerRadius: number;
  centerX: number;
  centerY: number;
  value: number;
  label: string;
  percent: number;
}

/** Union of all hit-testable geometry arrays. */
export type HitGeometry =
  | { type: "bars"; rects: BarRect[] }
  | { type: "points"; markers: PointMarker[] }
  | { type: "slices"; arcs: SliceArc[] }
  | { type: "composite"; groups: HitGeometry[] };

// ============================================================================
// PivotChart Field Buttons
// ============================================================================

/** Which pivot area a field button belongs to. */
export type PivotFieldArea = "filter" | "row" | "column";

/** Metadata about a pivot field for rendering filter buttons on PivotCharts. */
export interface PivotChartFieldInfo {
  /** Pivot area (filter, row, column). */
  area: PivotFieldArea;
  /** Field index in the pivot table's source fields. */
  fieldIndex: number;
  /** Display name of the field. */
  name: string;
  /** Whether any filter is currently active on this field. */
  isFiltered: boolean;
}

/** A computed filter dropdown button on a PivotChart. */
export interface PivotChartFieldButton {
  /** The field this button represents. */
  field: PivotChartFieldInfo;
  /** Button bounds in chart-local coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

// ============================================================================
// Chart Layout (generalized)
// ============================================================================

/** Shared layout structure for all chart types. */
export interface ChartLayout {
  /** Total canvas dimensions. */
  width: number;
  height: number;
  /** Margins around the plot area. */
  margin: { top: number; right: number; bottom: number; left: number };
  /** The plot area rect (inside margins). For radial charts, this is the bounding box of the circle. */
  plotArea: { x: number; y: number; width: number; height: number };
}
