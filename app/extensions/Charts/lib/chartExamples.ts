//! FILENAME: app/extensions/Charts/lib/chartExamples.ts
// PURPOSE: A curated gallery of complete, valid ChartSpec examples.
// CONTEXT: Shown in the Chart Spec Editor's "Examples" panel as ready-to-load
//          starting points that showcase the spec language — mark options,
//          conditional encoding, transforms (filter/aggregate/calculate/lookup),
//          layers, theming, and quantitative scatter axes. Each example is a
//          full spec; loading one replaces the editor contents. They reference a
//          conventional data range — adapt `data`/`series` to your own sheet.

import type { AxisSpec, ChartSpec } from "../types";

// ============================================================================
// Types
// ============================================================================

export interface ChartExample {
  /** Stable id. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description of what the example demonstrates. */
  description: string;
  /** Grouping shown as a section header in the gallery. */
  category: string;
  /** The complete chart specification. */
  spec: ChartSpec;
}

// ============================================================================
// Helpers (build complete specs with minimal noise)
// ============================================================================

function axis(title: string | null = null, gridLines = false): AxisSpec {
  return { title, gridLines, showLabels: true, labelAngle: 0, min: null, max: null };
}

const RANGE = "Sheet1!A1:D13";

// ============================================================================
// Examples
// ============================================================================

export const CHART_EXAMPLES: ChartExample[] = [
  // ── Basics ───────────────────────────────────────────────────────────────
  {
    id: "basic-bar",
    name: "Bar chart",
    description: "A simple grouped bar chart — the starting point for most charts.",
    category: "Basics",
    spec: {
      mark: "bar",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Revenue", sourceIndex: 1, color: null }],
      title: "Revenue by Category",
      xAxis: axis(),
      yAxis: axis("Revenue", true),
      legend: { visible: false, position: "bottom" },
      palette: "default",
      markOptions: { borderRadius: 3 },
    },
  },
  {
    id: "basic-line",
    name: "Smooth line",
    description: "Line chart with smooth interpolation and point markers.",
    category: "Basics",
    spec: {
      mark: "line",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [
        { name: "Actual", sourceIndex: 1, color: null },
        { name: "Forecast", sourceIndex: 2, color: null },
      ],
      title: "Trend over Time",
      xAxis: axis(),
      yAxis: axis(null, true),
      legend: { visible: true, position: "top" },
      palette: "default",
      markOptions: { interpolation: "smooth", lineWidth: 2, showMarkers: true },
    },
  },
  {
    id: "basic-donut",
    name: "Donut chart",
    description: "Donut with percentage labels.",
    category: "Basics",
    spec: {
      mark: "donut",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Share", sourceIndex: 1, color: null }],
      title: "Market Share",
      xAxis: axis(),
      yAxis: axis(),
      legend: { visible: true, position: "right" },
      palette: "vivid",
      markOptions: { showLabels: true, labelFormat: "percent", innerRadiusRatio: 0.55 },
    },
  },
  {
    id: "scatter-quantitative",
    name: "Scatter (numeric X)",
    description: "Scatter plot with a quantitative X axis — when the category column is numeric, points are positioned by value (not evenly spaced).",
    category: "Basics",
    spec: {
      mark: "scatter",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Measurement", sourceIndex: 1, color: null }],
      title: "Y vs X",
      xAxis: axis("X value"),
      yAxis: axis("Y value", true),
      legend: { visible: false, position: "bottom" },
      palette: "ocean",
      markOptions: { pointShape: "circle", pointSize: 5 },
    },
  },

  {
    id: "time-series-line",
    name: "Time series (date axis)",
    description: "A line on a true time axis — set xAxis.scale to \"time\" and use a date category column for proportionally-spaced points with calendar-aware ticks.",
    category: "Basics",
    spec: {
      mark: "line",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Value", sourceIndex: 1, color: null }],
      title: "Over Time",
      xAxis: { title: "Date", gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null, scale: { type: "time" } },
      yAxis: axis(null, true),
      legend: { visible: false, position: "bottom" },
      palette: "default",
      markOptions: { interpolation: "smooth", lineWidth: 2, showMarkers: true },
    },
  },

  // ── Styling ──────────────────────────────────────────────────────────────
  {
    id: "conditional-color",
    name: "Profit & Loss (conditional color)",
    description: "Color bars by value — red for negatives, green for positives — using conditional encoding.",
    category: "Styling",
    spec: {
      mark: "bar",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{
        name: "P&L",
        sourceIndex: 1,
        color: null,
        encoding: {
          color: {
            condition: { field: "value", lt: 0 },
            value: "#E15759",
            otherwise: "#59A14F",
          },
        },
      }],
      title: "Profit & Loss",
      xAxis: axis(),
      yAxis: axis(null, true),
      legend: { visible: false, position: "bottom" },
      palette: "default",
    },
  },
  {
    id: "dark-theme",
    name: "Dark theme",
    description: "Override the chart theme via config.theme for a dark look.",
    category: "Styling",
    spec: {
      mark: "line",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Population", sourceIndex: 1, color: "#4DBBD5" }],
      title: "Population Growth",
      xAxis: axis("Year"),
      yAxis: axis("People", true),
      legend: { visible: false, position: "bottom" },
      palette: "default",
      markOptions: { interpolation: "smooth", lineWidth: 2, showMarkers: false },
      config: {
        theme: {
          background: "#1a1a2e",
          plotBackground: "#16213e",
          gridLineColor: "#2a3a5c",
          axisColor: "#4a5a7c",
          axisLabelColor: "#8899bb",
          axisTitleColor: "#aabbdd",
          titleColor: "#e0e8ff",
          legendTextColor: "#8899bb",
        },
      },
    },
  },
  {
    id: "gradient-area",
    name: "Gradient area",
    description: "Filled area with a vertical gradient.",
    category: "Styling",
    spec: {
      mark: "area",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Traffic", sourceIndex: 1, color: null }],
      title: "Site Traffic",
      xAxis: axis(),
      yAxis: axis(null, true),
      legend: { visible: false, position: "bottom" },
      palette: "ocean",
      markOptions: {
        interpolation: "smooth",
        fillOpacity: 0.5,
        fill: {
          type: "linear",
          direction: "topToBottom",
          stops: [
            { offset: 0, color: "#4DBBD5" },
            { offset: 1, color: "#ffffff" },
          ],
        },
      },
    },
  },
  {
    id: "combo-secondary-axis",
    name: "Combo (bars + line, 2nd axis)",
    description: "Bars for one series, a line on a secondary axis for another.",
    category: "Styling",
    spec: {
      mark: "combo",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [
        { name: "Revenue", sourceIndex: 1, color: null },
        { name: "Growth %", sourceIndex: 2, color: "#E15759" },
      ],
      title: "Revenue & Growth",
      xAxis: axis(),
      yAxis: axis("Revenue", true),
      legend: { visible: true, position: "top" },
      palette: "default",
      markOptions: {
        seriesMarks: { 0: "bar", 1: "line" },
        secondaryYAxis: true,
        secondaryAxisSeries: [1],
        secondaryAxis: axis("Growth %"),
      },
    },
  },

  // ── Annotations ──────────────────────────────────────────────────────────
  {
    id: "target-line",
    name: "Target line + data labels",
    description: "A dashed reference line via a rule layer, plus value labels on the bars.",
    category: "Annotations",
    spec: {
      mark: "bar",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Sales", sourceIndex: 1, color: null }],
      title: "Sales vs Target",
      xAxis: axis(),
      yAxis: axis(null, true),
      legend: { visible: false, position: "bottom" },
      palette: "default",
      dataLabels: { enabled: true, content: ["value"], position: "above" },
      layers: [
        { mark: "rule", markOptions: { y: 500, color: "#E15759", strokeDash: [6, 3], label: "Target" } },
      ],
    },
  },

  // ── Data shaping ─────────────────────────────────────────────────────────
  {
    id: "sort-filter",
    name: "Top performers (filter + sort)",
    description: "Keep only rows above a threshold, then sort descending.",
    category: "Data shaping",
    spec: {
      mark: "bar",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Revenue", sourceIndex: 1, color: null }],
      title: "Top Products",
      xAxis: axis(),
      yAxis: axis(null, true),
      legend: { visible: false, position: "bottom" },
      palette: "default",
      transform: [
        { type: "filter", field: "Revenue", predicate: "> 100" },
        { type: "sort", field: "Revenue", order: "desc" },
      ],
    },
  },
  {
    id: "calculate-margin",
    name: "Computed margin (calculate + IF)",
    description: "Derive a new series with a formula, guarding divide-by-zero with IF.",
    category: "Data shaping",
    spec: {
      mark: "bar",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [
        { name: "Revenue", sourceIndex: 1, color: null },
        { name: "Cost", sourceIndex: 2, color: null },
      ],
      title: "Margin %",
      xAxis: axis(),
      yAxis: axis("Margin %", true),
      legend: { visible: false, position: "bottom" },
      palette: "default",
      transform: [
        { type: "calculate", expr: "IF(Revenue > 0, ROUND((Revenue - Cost) / Revenue * 100, 1), 0)", as: "Margin %" },
      ],
    },
  },
  {
    id: "aggregate-multi",
    name: "Totals by group (multi-series aggregate)",
    description: "Group rows by category and sum every series at once.",
    category: "Data shaping",
    spec: {
      mark: "bar",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [
        { name: "Units", sourceIndex: 1, color: null },
        { name: "Revenue", sourceIndex: 2, color: null },
      ],
      title: "Totals by Region",
      xAxis: axis(),
      yAxis: axis(null, true),
      legend: { visible: true, position: "top" },
      palette: "default",
      transform: [
        { type: "aggregate", groupBy: ["$category"], op: "sum" },
      ],
    },
  },
  {
    id: "lookup-targets",
    name: "Join targets (lookup)",
    description: "Pull a Target series from a second range, matched by category.",
    category: "Data shaping",
    spec: {
      mark: "combo",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Actual", sourceIndex: 1, color: null }],
      title: "Actual vs Target",
      xAxis: axis(),
      yAxis: axis(null, true),
      legend: { visible: true, position: "top" },
      palette: "default",
      markOptions: { seriesMarks: { 0: "bar", 1: "line" } },
      transform: [
        { type: "lookup", from: "Targets!A1:B13", fields: ["Target"], default: 0 },
      ],
    },
  },
  {
    id: "pivot-long",
    name: "Pivot long data into series",
    description: "A long table (rows of Region | Month | Sales) reshaped so each Month becomes a series across Regions. Reference source columns by header; place pivot first.",
    category: "Data shaping",
    spec: {
      mark: "bar",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Sales", sourceIndex: 2, color: null }],
      title: "Sales by Region & Month",
      xAxis: axis(),
      yAxis: axis(null, true),
      legend: { visible: true, position: "top" },
      palette: "default",
      transform: [
        { type: "pivot", category: "Region", key: "Month", value: "Sales", op: "sum" },
      ],
    },
  },

  // ── Encoding ───────────────────────────────────────────────────────────────
  {
    id: "encoding-color",
    name: "Encoding: color by field",
    description: "Describe the chart with encoding channels over a long table — x=Date, y=Sales, color=Region — and Calcula compiles it to one line per Region.",
    category: "Encoding",
    spec: {
      mark: "line",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [],
      title: "Sales by Region over Time",
      xAxis: axis("Date"),
      yAxis: axis("Sales", true),
      legend: { visible: true, position: "top" },
      palette: "default",
      markOptions: { interpolation: "smooth", lineWidth: 2, showMarkers: false },
      encoding: {
        x: { field: "Date", type: "temporal" },
        y: { field: "Sales", aggregate: "sum" },
        color: { field: "Region" },
      },
    },
  },

  // ── Composition ──────────────────────────────────────────────────────────
  {
    id: "repeat-small-multiples",
    name: "Small multiples (repeat)",
    description: "Render one panel per series in a tiled grid, sharing the Y scale so the metrics are directly comparable.",
    category: "Composition",
    spec: {
      mark: "line",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [
        { name: "Revenue", sourceIndex: 1, color: null },
        { name: "Cost", sourceIndex: 2, color: null },
        { name: "Profit", sourceIndex: 3, color: null },
      ],
      title: "Metrics over Time",
      xAxis: axis(),
      yAxis: axis(null, true),
      legend: { visible: false, position: "bottom" },
      palette: "default",
      markOptions: { interpolation: "smooth", lineWidth: 2, showMarkers: false },
      repeat: { columns: 2, sharedYScale: true },
    },
  },
  {
    id: "facet-by-field",
    name: "Facet by field",
    description: "Split a long table into one panel per distinct value of a categorical column (e.g. Region). Panels share X and Y scales so they are directly comparable.",
    category: "Composition",
    spec: {
      mark: "bar",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 1,
      series: [{ name: "Sales", sourceIndex: 2, color: null }],
      title: "Sales by Month, per Region",
      xAxis: axis(),
      yAxis: axis(null, true),
      legend: { visible: false, position: "bottom" },
      palette: "default",
      facet: { field: "Region", columns: 2, sharedYScale: true, sharedXScale: true },
    },
  },
  {
    id: "concat-dashboard",
    name: "Concat (mini dashboard)",
    description: "Lay out several independent charts side by side — each with its own data, mark, and axes. Set columns to control the grid (1 = stacked, n = a single row).",
    category: "Composition",
    spec: {
      mark: "bar",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [],
      title: "Overview",
      xAxis: axis(),
      yAxis: axis(),
      legend: { visible: false, position: "bottom" },
      palette: "default",
      concat: {
        columns: 2,
        charts: [
          {
            mark: "bar",
            data: RANGE,
            hasHeaders: true,
            seriesOrientation: "columns",
            categoryIndex: 0,
            series: [{ name: "Revenue", sourceIndex: 1, color: null }],
            title: "Revenue",
            xAxis: axis(),
            yAxis: axis(null, true),
            legend: { visible: false, position: "bottom" },
            palette: "default",
          },
          {
            mark: "line",
            data: RANGE,
            hasHeaders: true,
            seriesOrientation: "columns",
            categoryIndex: 0,
            series: [{ name: "Growth", sourceIndex: 2, color: null }],
            title: "Growth",
            xAxis: axis(),
            yAxis: axis(null, true),
            legend: { visible: false, position: "bottom" },
            palette: "ocean",
            markOptions: { interpolation: "smooth", lineWidth: 2 },
          },
        ],
      },
    },
  },

  // ── Interactivity ──────────────────────────────────────────────────────────
  {
    id: "param-threshold-filter",
    name: "Cell-bound parameter filter",
    description: "Declare a Threshold param read live from cell B1 and filter to rows above it. Type a new value in B1 and the chart re-filters — spreadsheet-native interactivity.",
    category: "Interactivity",
    spec: {
      mark: "bar",
      data: RANGE,
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Revenue", sourceIndex: 1, color: null }],
      title: "Revenue above Threshold",
      xAxis: axis(),
      yAxis: axis("Revenue", true),
      legend: { visible: false, position: "bottom" },
      palette: "default",
      params: [{ name: "Threshold", cellRef: "=B1", value: 100, description: "Minimum revenue to show" }],
      transform: [{ type: "filter", field: "Revenue", predicate: "value > [Threshold]" }],
    },
  },
];

// ============================================================================
// Public helpers
// ============================================================================

/** Examples grouped by their category, preserving declaration order. */
export function getExamplesByCategory(): Record<string, ChartExample[]> {
  const grouped: Record<string, ChartExample[]> = {};
  for (const ex of CHART_EXAMPLES) {
    (grouped[ex.category] ??= []).push(ex);
  }
  return grouped;
}
