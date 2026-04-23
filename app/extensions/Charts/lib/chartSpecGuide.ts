//! FILENAME: app/extensions/Charts/lib/chartSpecGuide.ts
// PURPOSE: Comprehensive guide/documentation for the ChartSpec language.
// CONTEXT: Displayed in the "Guide" panel of the pop-out Chart Spec Editor.
//          Written as markdown-like text rendered by the editor's simple renderer.

/**
 * Generate the full ChartSpec guide.
 * Returns markdown-like text with headers, tables, code blocks, and examples.
 */
export function generateSpecGuide(): string {
  const sections: string[] = [];

  // ── Getting Started ──────────────────────────────────────────────────
  sections.push(`
# ChartSpec Guide

The ChartSpec is a declarative JSON language for defining charts in Calcula.
It is inspired by Vega-Lite — you describe *what* you want, not *how* to draw it.

Every chart starts with a few required fields and can be progressively
customized to any depth using optional features.

## Getting Started

The simplest chart needs just a mark type, a data source, and series:

\`\`\`json
{
  "mark": "bar",
  "data": "Sheet1!A1:B10",
  "hasHeaders": true,
  "seriesOrientation": "columns",
  "categoryIndex": 0,
  "series": [{ "name": "Revenue", "sourceIndex": 1, "color": null }],
  "title": "Monthly Revenue",
  "xAxis": { "gridLines": false, "showLabels": true, "labelAngle": 0, "title": null },
  "yAxis": { "gridLines": true, "showLabels": true, "labelAngle": 0, "title": null },
  "legend": { "visible": true, "position": "top" },
  "palette": "default"
}
\`\`\`

**Tip:** Start by creating a chart with the Design tab, then switch to the
Spec tab to see the generated JSON and customize it further.

## Progressive Customization

The ChartSpec is designed to be progressively customizable:

| Step | Interface | What you can do |
|------|-----------|----------------|
| 1 | Design Tab | Pick chart type, select data, set title |
| 2 | Spec Editor | Fine-tune any property |
| 3 | Spec Editor | Add scale customization (log, sqrt) |
| 4 | Spec Editor | Add reference lines and annotations |
| 5 | Spec Editor | Add conditional colors by value |
| 6 | Spec Editor | Transform data (filter, sort, aggregate) |
| 7 | Spec Editor | Override theme (dark mode, fonts) |

Each step adds optional fields — existing charts are never broken.
`);

  // ── Chart Types ──────────────────────────────────────────────────────
  sections.push(`
## Chart Types

The \`mark\` field determines the chart type:

| Mark | Description | Axes |
|------|-------------|------|
| bar | Vertical bar chart | Cartesian |
| horizontalBar | Horizontal bar chart | Cartesian |
| line | Line chart with optional markers | Cartesian |
| area | Filled area chart | Cartesian |
| scatter | Scatter plot with point shapes | Cartesian |
| pie | Pie chart | Radial |
| donut | Donut chart | Radial |
| waterfall | Waterfall (bridge) chart | Cartesian |
| combo | Mixed bar + line + area | Cartesian |
| radar | Radar/spider chart | Radial |
| bubble | Scatter with sized bubbles | Cartesian |
| histogram | Auto-binned histogram | Cartesian |
| funnel | Funnel chart | None |
| treemap | Treemap chart | None |
| stock | OHLC/Candlestick chart | Cartesian |
| boxPlot | Box & Whisker (distribution) | Cartesian |
| sunburst | Hierarchical concentric rings | Radial |
| pareto | Bars + cumulative % line | Cartesian |

## Data Sources

The \`data\` field accepts three formats:

**A1 reference string** (most common):
\`\`\`json
"data": "Sheet1!A1:D10"
\`\`\`

**Named range:**
\`\`\`json
"data": "SalesData"
\`\`\`

**Explicit coordinates** (0-based, inclusive):
\`\`\`json
"data": { "sheetIndex": 0, "startRow": 0, "startCol": 0, "endRow": 9, "endCol": 3 }
\`\`\`

## Series Configuration

Each series maps a column (or row) from the data range to visual marks.

\`\`\`json
"series": [
  { "name": "Revenue", "sourceIndex": 1, "color": null },
  { "name": "Cost", "sourceIndex": 2, "color": "#E15759" }
]
\`\`\`

- **name**: Display name (legend, tooltip). Supports cell refs like \`"=B1"\`
- **sourceIndex**: Column/row index in the data range
- **color**: Override hex color, or \`null\` to use the palette
- **encoding**: Per-data-point visual overrides (see Conditional Encoding)

## Cell References

String fields support cell references for dynamic content:

\`\`\`json
"title": "=A1",
"xAxis": { "title": "=Sheet1!B1" },
"series": [{ "name": "='My Sheet'!C1", "sourceIndex": 1, "color": null }]
\`\`\`

The referenced cell's display value is used at render time.
`);

  // ── Mark Options ─────────────────────────────────────────────────────
  sections.push(`
## Mark Options

Each chart type has specific options in the \`markOptions\` field.

### Bar / Horizontal Bar
\`\`\`json
"markOptions": { "borderRadius": 4, "barGap": 3 }
\`\`\`

### Line
\`\`\`json
"markOptions": {
  "interpolation": "smooth",
  "lineWidth": 2.5,
  "showMarkers": true,
  "markerRadius": 4
}
\`\`\`
Interpolation modes: \`"linear"\`, \`"smooth"\`, \`"step"\`

### Area
\`\`\`json
"markOptions": {
  "interpolation": "smooth",
  "fillOpacity": 0.4,
  "stacked": true
}
\`\`\`

### Scatter
\`\`\`json
"markOptions": { "pointShape": "diamond", "pointSize": 6 }
\`\`\`
Shapes: \`"circle"\`, \`"square"\`, \`"diamond"\`, \`"triangle"\`

### Pie / Donut
\`\`\`json
"markOptions": {
  "startAngle": 0,
  "padAngle": 2,
  "showLabels": true,
  "labelFormat": "percent"
}
\`\`\`

### Waterfall
\`\`\`json
"markOptions": {
  "showConnectors": true,
  "increaseColor": "#4CAF50",
  "decreaseColor": "#E53935",
  "totalColor": "#5C6BC0",
  "totalIndices": [5, 11]
}
\`\`\`

### Combo
\`\`\`json
"markOptions": {
  "seriesMarks": { "0": "bar", "1": "line" },
  "secondaryYAxis": true,
  "secondaryAxisSeries": [1],
  "secondaryAxis": { "gridLines": false, "showLabels": true, "labelAngle": 0, "title": "Growth %" }
}
\`\`\`

### Bubble
\`\`\`json
"markOptions": {
  "sizeSeriesIndex": 2,
  "minBubbleSize": 4,
  "maxBubbleSize": 30,
  "bubbleOpacity": 0.7
}
\`\`\`

### Radar
\`\`\`json
"markOptions": {
  "showFill": true,
  "fillOpacity": 0.2,
  "showMarkers": true
}
\`\`\`

### Histogram
\`\`\`json
"markOptions": { "binCount": 15, "borderRadius": 1 }
\`\`\`

### Funnel
\`\`\`json
"markOptions": {
  "neckWidthRatio": 0.3,
  "showLabels": true,
  "labelFormat": "both",
  "sectionGap": 3
}
\`\`\`
`);

  // ── Axes & Scales ────────────────────────────────────────────────────
  sections.push(`
## Axes

Configure the X and Y axes with \`xAxis\` and \`yAxis\`:

\`\`\`json
"yAxis": {
  "title": "Revenue ($)",
  "gridLines": true,
  "showLabels": true,
  "labelAngle": 0,
  "min": 0,
  "max": null
}
\`\`\`

- **title**: Axis title text (null = none). Supports cell refs
- **gridLines**: Show grid lines
- **showLabels**: Show tick labels
- **labelAngle**: 0 (horizontal), 45 (diagonal), or 90 (vertical)
- **min / max**: Fixed range (null = auto-scale from data)
- **scale**: Scale configuration (see below)
- **tickCount**: Desired number of tick marks (default: 5)
- **tickFormat**: Number format for labels (e.g. "$,.0f")

## Scale Customization

Change how values map to pixel positions:

\`\`\`json
"yAxis": {
  "gridLines": true,
  "showLabels": true,
  "labelAngle": 0,
  "title": null,
  "scale": { "type": "log" }
}
\`\`\`

### Scale Types

| Type | Use case | Example |
|------|----------|---------|
| linear | Default, uniform spacing | Most charts |
| log | Exponential data, orders of magnitude | Population, stock prices |
| pow | Emphasize differences at extremes | Area-proportional |
| sqrt | Square root (pow with exponent 0.5) | Bubble area scaling |

### Scale Options
\`\`\`json
"scale": {
  "type": "pow",
  "exponent": 0.5,
  "domain": [0, 1000],
  "reverse": false,
  "nice": true,
  "zero": true
}
\`\`\`

- **domain**: Override the [min, max] range (default: auto from data)
- **reverse**: Flip the axis direction
- **nice**: Round domain to nice values (default: true)
- **zero**: Include zero in the domain (default: true for bar)
- **exponent**: For \`pow\` type only (default: 2)
`);

  // ── Layers & Annotations ─────────────────────────────────────────────
  sections.push(`
## Layers & Annotations

Add overlays to any chart using the \`layers\` array.
Layers share the parent chart's scales and coordinate system.

### Reference Lines (rule)

Add a horizontal target line:
\`\`\`json
"layers": [
  {
    "mark": "rule",
    "markOptions": {
      "y": 1000,
      "color": "#E15759",
      "strokeDash": [6, 3],
      "strokeWidth": 1.5,
      "label": "Target"
    }
  }
]
\`\`\`

Add a vertical line at a category index:
\`\`\`json
"layers": [
  { "mark": "rule", "markOptions": { "x": 3, "color": "#999", "strokeDash": [4, 4] } }
]
\`\`\`

### Text Annotations

Place text at a specific data coordinate:
\`\`\`json
"layers": [
  {
    "mark": "text",
    "markOptions": {
      "x": 2,
      "y": 850,
      "text": "Peak",
      "fontSize": 12,
      "color": "#333",
      "anchor": "middle",
      "baseline": "bottom"
    }
  }
]
\`\`\`

### Chart Overlays

Overlay a line on a bar chart:
\`\`\`json
"layers": [
  {
    "mark": "line",
    "markOptions": {
      "interpolation": "smooth",
      "lineWidth": 2,
      "showMarkers": false
    },
    "opacity": 0.8
  }
]
\`\`\`

### Layer Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| mark | string | yes | Chart type, "rule", or "text" |
| data | DataSource | no | Override data (omit = share parent) |
| series | ChartSeries[] | no | Override series |
| markOptions | object | no | Mark-specific options |
| opacity | number | no | Layer opacity (0-1) |
`);

  // ── Conditional Encoding ─────────────────────────────────────────────
  sections.push(`
## Conditional Encoding

Color, size, or fade data points based on their value or category.
Add an \`encoding\` object to any series definition.

### Color by Value

Color bars red for negative, blue for positive:
\`\`\`json
"series": [{
  "name": "Profit",
  "sourceIndex": 1,
  "color": null,
  "encoding": {
    "color": {
      "condition": { "field": "value", "lt": 0 },
      "value": "#E15759",
      "otherwise": "#4E79A7"
    }
  }
}]
\`\`\`

### Color by Category

Highlight specific categories:
\`\`\`json
"encoding": {
  "color": {
    "condition": { "field": "category", "oneOf": ["Q4", "December"] },
    "value": "#FFD700",
    "otherwise": "#4E79A7"
  }
}
\`\`\`

### Conditional Opacity

Fade out low values:
\`\`\`json
"encoding": {
  "opacity": {
    "condition": { "field": "value", "lt": 100 },
    "value": 0.3,
    "otherwise": 1.0
  }
}
\`\`\`

### Conditional Size (scatter/bubble)

Enlarge outlier points:
\`\`\`json
"encoding": {
  "size": {
    "condition": { "field": "value", "gt": 500 },
    "value": 10,
    "otherwise": 4
  }
}
\`\`\`

### Static Overrides

You can also use encoding for static overrides:
\`\`\`json
"encoding": {
  "color": "#FF5733",
  "opacity": 0.8,
  "strokeDash": [6, 3],
  "strokeWidth": 2
}
\`\`\`

### Condition Operators

| Property | Type | Description |
|----------|------|-------------|
| field | string | "value" (numeric) or "category" (string) |
| gt | number | Greater than |
| lt | number | Less than |
| gte | number | Greater than or equal |
| lte | number | Less than or equal |
| oneOf | array | Value is one of these entries |

Multiple operators can be combined — all must be true.
`);

  // ── Data Transforms ──────────────────────────────────────────────────
  sections.push(`
## Data Transforms

Transform data after it's read from the sheet, before rendering.
Transforms execute in the order they appear in the array.
Use \`"$category"\` to reference category labels.

### Filter — Remove Data Points
\`\`\`json
"transform": [
  { "type": "filter", "field": "Revenue", "predicate": "> 100" }
]
\`\`\`

Operators: \`>\`, \`<\`, \`>=\`, \`<=\`, \`=\`, \`!=\`

Filter by category:
\`\`\`json
{ "type": "filter", "field": "$category", "predicate": "!= Total" }
\`\`\`

### Sort — Reorder Data
\`\`\`json
"transform": [
  { "type": "sort", "field": "Revenue", "order": "desc" }
]
\`\`\`

Alphabetical sort:
\`\`\`json
{ "type": "sort", "field": "$category", "order": "asc" }
\`\`\`

### Aggregate — Group and Reduce
\`\`\`json
"transform": [
  {
    "type": "aggregate",
    "groupBy": ["$category"],
    "op": "sum",
    "field": "Revenue",
    "as": "Total Revenue"
  }
]
\`\`\`

Operations: \`sum\`, \`mean\`, \`median\`, \`min\`, \`max\`, \`count\`

### Calculate — Computed Series
\`\`\`json
"transform": [
  { "type": "calculate", "expr": "Revenue - Cost", "as": "Profit" },
  { "type": "calculate", "expr": "Profit / Revenue * 100", "as": "Margin %" }
]
\`\`\`

Available variables: series names (spaces become underscores), \`$index\`, \`$category\`.

### Window — Running Calculations
\`\`\`json
"transform": [
  { "type": "window", "op": "running_sum", "field": "Revenue", "as": "Cumulative" }
]
\`\`\`

Operations: \`running_sum\`, \`running_mean\`, \`rank\`

### Bin — Histogram Bins
\`\`\`json
"transform": [
  { "type": "bin", "field": "Revenue", "binCount": 8, "as": "Revenue Bins" }
]
\`\`\`

### Chaining Transforms

Transforms compose — the output of one feeds the next:
\`\`\`json
"transform": [
  { "type": "filter", "field": "Revenue", "predicate": "> 0" },
  { "type": "sort", "field": "Revenue", "order": "desc" },
  { "type": "window", "op": "running_sum", "field": "Revenue", "as": "Cumulative" }
]
\`\`\`
`);

  // ── Deep Theming ─────────────────────────────────────────────────────
  sections.push(`
## Deep Theming

Override any visual property via \`config.theme\`.
Only the properties you specify are changed — everything else keeps the default.

### Dark Theme Example
\`\`\`json
"config": {
  "theme": {
    "background": "#1e1e1e",
    "plotBackground": "#2d2d2d",
    "gridLineColor": "#444444",
    "axisColor": "#666666",
    "axisLabelColor": "#aaaaaa",
    "axisTitleColor": "#cccccc",
    "titleColor": "#eeeeee",
    "legendTextColor": "#bbbbbb",
    "titleFontSize": 16,
    "labelFontSize": 12
  }
}
\`\`\`

### Minimal Theme (remove clutter)
\`\`\`json
"config": {
  "theme": {
    "plotBackground": "#ffffff",
    "gridLineColor": "#f0f0f0",
    "axisColor": "#dddddd"
  }
}
\`\`\`

### All Theme Properties

| Property | Default | Description |
|----------|---------|-------------|
| background | #ffffff | Chart background |
| plotBackground | #fafafa | Plot area background |
| gridLineColor | #e8e8e8 | Grid line color |
| gridLineWidth | 1 | Grid line width (px) |
| axisColor | #999999 | Axis line color |
| axisLabelColor | #666666 | Axis label color |
| axisTitleColor | #444444 | Axis title color |
| titleColor | #333333 | Chart title color |
| legendTextColor | #555555 | Legend text color |
| fontFamily | Segoe UI... | Font family |
| titleFontSize | 14 | Title font size (px) |
| axisTitleFontSize | 11 | Axis title size (px) |
| labelFontSize | 10 | Axis label size (px) |
| legendFontSize | 10 | Legend size (px) |
| barBorderRadius | 2 | Bar corner radius (px) |
| barGap | 2 | Bar gap in group (px) |
`);

  // ── Tooltip Config ───────────────────────────────────────────────────
  sections.push(`
## Tooltip Configuration

Control what appears in hover tooltips:

\`\`\`json
"tooltip": {
  "enabled": true,
  "fields": ["series", "category", "value"],
  "format": { "value": "$,.2f" }
}
\`\`\`

### Options

| Property | Default | Description |
|----------|---------|-------------|
| enabled | true | Show tooltips on hover |
| fields | ["series","category","value"] | Which lines to show |
| format | {} | Per-field number format |

### Format Patterns

| Pattern | Example Output | Description |
|---------|---------------|-------------|
| $,.2f | $1,234.56 | Currency with 2 decimals |
| ,.0f | 1,235 | Integer with comma grouping |
| .1f | 1234.6 | One decimal, no commas |
| % | 45.0% | Percentage (value * 100) |

### Disable Tooltips
\`\`\`json
"tooltip": { "enabled": false }
\`\`\`

### Show Only Value
\`\`\`json
"tooltip": { "fields": ["value"], "format": { "value": "$,.0f" } }
\`\`\`
`);

  // ── Palettes ─────────────────────────────────────────────────────────
  sections.push(`
## Color Palettes

Set the \`palette\` field to use a built-in color scheme:

| Palette | Colors |
|---------|--------|
| default | Blues, oranges, reds, teals |
| vivid | High-contrast saturated |
| pastel | Soft, light tones |
| ocean | Blue-purple gradient |

Individual series colors can override the palette:
\`\`\`json
"series": [
  { "name": "A", "sourceIndex": 1, "color": null },
  { "name": "B", "sourceIndex": 2, "color": "#FF5733" }
]
\`\`\`
`);

  // ── Complete Examples ────────────────────────────────────────────────
  sections.push(`
## Complete Examples

### Sorted Bar Chart with Target Line
\`\`\`json
{
  "mark": "bar",
  "data": "Sheet1!A1:B10",
  "hasHeaders": true,
  "seriesOrientation": "columns",
  "categoryIndex": 0,
  "series": [{ "name": "Revenue", "sourceIndex": 1, "color": null }],
  "title": "Revenue by Product",
  "xAxis": { "gridLines": false, "showLabels": true, "labelAngle": 45, "title": null },
  "yAxis": { "gridLines": true, "showLabels": true, "labelAngle": 0, "title": "USD" },
  "legend": { "visible": false, "position": "top" },
  "palette": "default",
  "transform": [
    { "type": "sort", "field": "Revenue", "order": "desc" }
  ],
  "layers": [
    { "mark": "rule", "markOptions": { "y": 500, "strokeDash": [6, 3], "label": "Target", "color": "#E15759" } }
  ]
}
\`\`\`

### Profit/Loss Bar with Conditional Color
\`\`\`json
{
  "mark": "bar",
  "data": "Sheet1!A1:B10",
  "hasHeaders": true,
  "seriesOrientation": "columns",
  "categoryIndex": 0,
  "series": [{
    "name": "P&L",
    "sourceIndex": 1,
    "color": null,
    "encoding": {
      "color": {
        "condition": { "field": "value", "lt": 0 },
        "value": "#E15759",
        "otherwise": "#59A14F"
      }
    }
  }],
  "title": "Profit & Loss",
  "xAxis": { "gridLines": false, "showLabels": true, "labelAngle": 0, "title": null },
  "yAxis": { "gridLines": true, "showLabels": true, "labelAngle": 0, "title": null },
  "legend": { "visible": false, "position": "top" },
  "palette": "default"
}
\`\`\`

### Combo Chart with Secondary Axis
\`\`\`json
{
  "mark": "combo",
  "data": "Sheet1!A1:C10",
  "hasHeaders": true,
  "seriesOrientation": "columns",
  "categoryIndex": 0,
  "series": [
    { "name": "Revenue", "sourceIndex": 1, "color": null },
    { "name": "Growth %", "sourceIndex": 2, "color": "#E15759" }
  ],
  "title": "Revenue & Growth",
  "xAxis": { "gridLines": false, "showLabels": true, "labelAngle": 0, "title": null },
  "yAxis": { "gridLines": true, "showLabels": true, "labelAngle": 0, "title": "Revenue" },
  "legend": { "visible": true, "position": "top" },
  "palette": "default",
  "markOptions": {
    "seriesMarks": { "0": "bar", "1": "line" },
    "secondaryYAxis": true,
    "secondaryAxisSeries": [1],
    "secondaryAxis": { "gridLines": false, "showLabels": true, "labelAngle": 0, "title": "Growth %" }
  }
}
\`\`\`

### Log Scale Line Chart with Dark Theme
\`\`\`json
{
  "mark": "line",
  "data": "Sheet1!A1:B20",
  "hasHeaders": true,
  "seriesOrientation": "columns",
  "categoryIndex": 0,
  "series": [{ "name": "Population", "sourceIndex": 1, "color": "#4DBBD5" }],
  "title": "Population Growth",
  "xAxis": { "gridLines": false, "showLabels": true, "labelAngle": 45, "title": "Year" },
  "yAxis": {
    "gridLines": true, "showLabels": true, "labelAngle": 0,
    "title": "Population",
    "scale": { "type": "log" }
  },
  "legend": { "visible": false, "position": "top" },
  "palette": "default",
  "config": {
    "theme": {
      "background": "#1a1a2e",
      "plotBackground": "#16213e",
      "gridLineColor": "#2a3a5c",
      "axisColor": "#4a5a7c",
      "axisLabelColor": "#8899bb",
      "axisTitleColor": "#aabbdd",
      "titleColor": "#e0e8ff",
      "legendTextColor": "#8899bb"
    }
  },
  "tooltip": { "format": { "value": ",.0f" } }
}
\`\`\`
`);

  return sections.join("\n").trim();
}
