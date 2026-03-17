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
  | "funnel";

/** Chart types that use cartesian axes (X/Y). */
export type CartesianChartType = "bar" | "horizontalBar" | "line" | "area" | "scatter" | "waterfall" | "combo" | "bubble" | "histogram";

/** Chart types that use polar/radial layout (no axes). */
export type RadialChartType = "pie" | "donut" | "radar";

/** Check if a chart type uses cartesian axes. */
export function isCartesianChart(mark: ChartType): mark is CartesianChartType {
  return mark !== "pie" && mark !== "donut" && mark !== "radar" && mark !== "funnel";
}

// ============================================================================
// Mark-Specific Options
// ============================================================================

/** Options specific to bar and horizontal bar charts. */
export interface BarMarkOptions {
  /** Border radius on bars (pixels). Default: 2 */
  borderRadius?: number;
  /** Gap between bars in a group (pixels). Default: 2 */
  barGap?: number;
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
}

/** Scatter point shape. */
export type PointShape = "circle" | "square" | "diamond" | "triangle";

/** Options specific to scatter charts. */
export interface ScatterMarkOptions {
  /** Point shape. Default: "circle" */
  pointShape?: PointShape;
  /** Point size (radius in pixels). Default: 5 */
  pointSize?: number;
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
  | FunnelMarkOptions;

/** How series data is oriented within the data range. */
export type SeriesOrientation = "columns" | "rows";

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
 * Data source for a chart. Can be:
 * - A `DataRangeRef` object (explicit cell coordinates)
 * - A string in A1 notation (e.g., "Sheet1!A1:D10")
 * - A named range name (e.g., "SalesData")
 */
export type DataSource = DataRangeRef | string;

/** Type guard: check if a DataSource is a resolved DataRangeRef. */
export function isDataRangeRef(source: DataSource): source is DataRangeRef {
  return typeof source === "object" && source !== null && "startRow" in source;
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
}

// ============================================================================
// Axis & Legend
// ============================================================================

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
}

/** Legend configuration. */
export interface LegendSpec {
  /** Whether to show the legend. */
  visible: boolean;
  /** Legend position. */
  position: "top" | "bottom" | "left" | "right";
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
  type: "bar" | "point" | "slice" | "plotArea" | "title" | "legend" | "axis" | "none";
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
