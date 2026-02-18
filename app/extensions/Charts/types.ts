//! FILENAME: app/extensions/Charts/types.ts
// PURPOSE: Chart specification types (Vega-Lite inspired, simplified).
// CONTEXT: The ChartSpec is the single source of truth for chart rendering.
//          The dialog produces it, the renderer reads it, the script editor exposes it.

// ============================================================================
// Chart Types
// ============================================================================

/** Supported chart types (starting with bar only). */
export type ChartType = "bar";

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
  /** Data source range. */
  data: DataRangeRef;
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
  /** Category labels (X axis). */
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
  type: "bar" | "plotArea" | "title" | "legend" | "axis" | "none";
  /** Series index (set when type is "bar"). */
  seriesIndex?: number;
  /** Category index (set when type is "bar"). */
  categoryIndex?: number;
  /** Data value (set when type is "bar"). */
  value?: number;
  /** Series name (set when type is "bar"). */
  seriesName?: string;
  /** Category label (set when type is "bar"). */
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
