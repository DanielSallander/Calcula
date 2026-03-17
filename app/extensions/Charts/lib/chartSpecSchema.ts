//! FILENAME: app/extensions/Charts/lib/chartSpecSchema.ts
// PURPOSE: JSON Schema for ChartSpec. Used by Monaco editor for autocomplete,
//          validation, and hover documentation in the chart spec editor.
// CONTEXT: Mirrors the TypeScript ChartSpec interface from types.ts.

/** JSON Schema object for ChartSpec, consumable by Monaco's JSON language service. */
export const chartSpecJsonSchema: object = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ChartSpec",
  description: "Complete, declarative chart specification for Calcula charts.",
  type: "object",
  required: ["mark", "data", "hasHeaders", "seriesOrientation", "categoryIndex", "series", "xAxis", "yAxis", "legend", "palette"],
  properties: {
    mark: {
      type: "string",
      enum: ["bar", "horizontalBar", "line", "area", "scatter", "pie", "donut", "waterfall", "combo", "radar", "bubble", "histogram", "funnel"],
      description: "Chart type. Determines the visual mark used to represent data.",
    },
    data: {
      description: "Data source. Can be a DataRangeRef object (cell coordinates), an A1 reference string (e.g. \"Sheet1!A1:D10\"), or a named range name (e.g. \"SalesData\").",
      oneOf: [
        { $ref: "#/definitions/DataRangeRef" },
        { type: "string", description: "A1 reference (e.g. \"Sheet1!A1:D10\") or named range name." },
      ],
    },
    hasHeaders: {
      type: "boolean",
      description: "Whether the first row (columns orientation) or first column (rows orientation) contains header labels.",
    },
    seriesOrientation: {
      type: "string",
      enum: ["columns", "rows"],
      description: "How series are laid out in the data range. 'columns' = each column is a series, 'rows' = each row is a series.",
    },
    categoryIndex: {
      type: "integer",
      minimum: 0,
      description: "Index of the column (or row, if rows orientation) used for category labels (e.g. X-axis labels for bar chart).",
    },
    series: {
      type: "array",
      description: "Series definitions. Each series maps to a column/row in the data range.",
      items: { $ref: "#/definitions/ChartSeries" },
    },
    title: {
      type: ["string", "null"],
      description: "Chart title displayed above the chart. Use null for no title. Supports cell references like \"=A1\".",
    },
    xAxis: {
      $ref: "#/definitions/AxisSpec",
      description: "X-axis configuration (category axis for most chart types).",
    },
    yAxis: {
      $ref: "#/definitions/AxisSpec",
      description: "Y-axis configuration (value axis for most chart types).",
    },
    legend: {
      $ref: "#/definitions/LegendSpec",
      description: "Legend configuration.",
    },
    palette: {
      type: "string",
      description: "Color palette name. Built-in palettes: 'default', 'pastel', 'vivid', 'earth', 'ocean', 'monochrome'.",
    },
    markOptions: {
      description: "Mark-specific options. The available properties depend on the chart type (mark).",
      oneOf: [
        { $ref: "#/definitions/BarMarkOptions" },
        { $ref: "#/definitions/LineMarkOptions" },
        { $ref: "#/definitions/AreaMarkOptions" },
        { $ref: "#/definitions/ScatterMarkOptions" },
        { $ref: "#/definitions/PieMarkOptions" },
        { $ref: "#/definitions/WaterfallMarkOptions" },
        { $ref: "#/definitions/ComboMarkOptions" },
        { $ref: "#/definitions/RadarMarkOptions" },
        { $ref: "#/definitions/BubbleMarkOptions" },
        { $ref: "#/definitions/HistogramMarkOptions" },
        { $ref: "#/definitions/FunnelMarkOptions" },
      ],
    },
  },
  definitions: {
    DataRangeRef: {
      type: "object",
      description: "Explicit cell range reference with 0-based coordinates.",
      required: ["sheetIndex", "startRow", "startCol", "endRow", "endCol"],
      properties: {
        sheetIndex: { type: "integer", minimum: 0, description: "Sheet index (0-based)." },
        startRow: { type: "integer", minimum: 0, description: "Start row (0-based, inclusive)." },
        startCol: { type: "integer", minimum: 0, description: "Start column (0-based, inclusive)." },
        endRow: { type: "integer", minimum: 0, description: "End row (0-based, inclusive)." },
        endCol: { type: "integer", minimum: 0, description: "End column (0-based, inclusive)." },
      },
      additionalProperties: false,
    },
    ChartSeries: {
      type: "object",
      description: "A single data series within the chart.",
      required: ["name", "sourceIndex", "color"],
      properties: {
        name: {
          type: "string",
          description: "Display name for the series (shown in legend, tooltips). Supports cell references like \"=B1\".",
        },
        sourceIndex: {
          type: "integer",
          minimum: 0,
          description: "Column or row index within the data range that holds this series' values.",
        },
        color: {
          type: ["string", "null"],
          description: "Override color as hex string (e.g. \"#FF5733\"). Use null to use the palette color.",
        },
      },
      additionalProperties: false,
    },
    AxisSpec: {
      type: "object",
      description: "Axis configuration.",
      required: ["gridLines", "showLabels", "labelAngle"],
      properties: {
        title: {
          type: ["string", "null"],
          description: "Axis title text. Use null for no title. Supports cell references like \"=A1\".",
        },
        gridLines: { type: "boolean", description: "Show grid lines extending from this axis." },
        showLabels: { type: "boolean", description: "Show tick labels on this axis." },
        labelAngle: {
          type: "integer",
          enum: [0, 45, 90],
          description: "Label rotation in degrees. 0 = horizontal, 45 = diagonal, 90 = vertical.",
        },
        min: {
          type: ["number", "null"],
          description: "Minimum value for value axis. Use null for auto-scale.",
        },
        max: {
          type: ["number", "null"],
          description: "Maximum value for value axis. Use null for auto-scale.",
        },
      },
      additionalProperties: false,
    },
    LegendSpec: {
      type: "object",
      description: "Legend configuration.",
      required: ["visible", "position"],
      properties: {
        visible: { type: "boolean", description: "Whether to show the legend." },
        position: {
          type: "string",
          enum: ["top", "bottom", "left", "right"],
          description: "Legend position relative to the chart.",
        },
      },
      additionalProperties: false,
    },
    BarMarkOptions: {
      type: "object",
      description: "Options for bar and horizontal bar charts.",
      properties: {
        borderRadius: { type: "number", minimum: 0, description: "Corner radius on bars in pixels. Default: 2." },
        barGap: { type: "number", minimum: 0, description: "Gap between bars in a group in pixels. Default: 2." },
      },
      additionalProperties: false,
    },
    LineMarkOptions: {
      type: "object",
      description: "Options for line charts.",
      properties: {
        interpolation: {
          type: "string",
          enum: ["linear", "smooth", "step"],
          description: "Interpolation mode for connecting data points. Default: \"linear\".",
        },
        lineWidth: { type: "number", minimum: 0.5, description: "Line width in pixels. Default: 2." },
        showMarkers: { type: "boolean", description: "Show point markers at data points. Default: true." },
        markerRadius: { type: "number", minimum: 1, description: "Point marker radius in pixels. Default: 4." },
      },
      additionalProperties: false,
    },
    AreaMarkOptions: {
      type: "object",
      description: "Options for area charts.",
      properties: {
        interpolation: {
          type: "string",
          enum: ["linear", "smooth", "step"],
          description: "Interpolation mode. Default: \"linear\".",
        },
        lineWidth: { type: "number", minimum: 0.5, description: "Line width in pixels. Default: 2." },
        fillOpacity: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Fill opacity (0-1). Default: 0.3.",
        },
        showMarkers: { type: "boolean", description: "Show point markers. Default: false." },
        markerRadius: { type: "number", minimum: 1, description: "Marker radius in pixels. Default: 4." },
        stacked: { type: "boolean", description: "Stack overlapping areas. Default: false." },
      },
      additionalProperties: false,
    },
    ScatterMarkOptions: {
      type: "object",
      description: "Options for scatter charts.",
      properties: {
        pointShape: {
          type: "string",
          enum: ["circle", "square", "diamond", "triangle"],
          description: "Point shape. Default: \"circle\".",
        },
        pointSize: { type: "number", minimum: 1, description: "Point size (radius in pixels). Default: 5." },
      },
      additionalProperties: false,
    },
    PieMarkOptions: {
      type: "object",
      description: "Options for pie and donut charts.",
      properties: {
        innerRadiusRatio: {
          type: "number",
          minimum: 0,
          maximum: 0.95,
          description: "Inner radius as ratio of outer radius. 0 = pie, 0.4-0.7 = donut. Overridden by chart type.",
        },
        startAngle: { type: "number", description: "Start angle in degrees (0 = 12 o'clock). Default: 0." },
        padAngle: { type: "number", minimum: 0, description: "Padding between slices in degrees. Default: 1." },
        showLabels: { type: "boolean", description: "Show value/percentage labels on slices. Default: true." },
        labelFormat: {
          type: "string",
          enum: ["value", "percent", "both"],
          description: "Label format. Default: \"percent\".",
        },
      },
      additionalProperties: false,
    },
    WaterfallMarkOptions: {
      type: "object",
      description: "Options for waterfall charts.",
      properties: {
        showConnectors: { type: "boolean", description: "Show connector lines between bars. Default: true." },
        increaseColor: { type: "string", description: "Color for increasing bars (hex). Default: \"#4CAF50\"." },
        decreaseColor: { type: "string", description: "Color for decreasing bars (hex). Default: \"#E53935\"." },
        totalColor: { type: "string", description: "Color for total bars (hex). Default: \"#5C6BC0\"." },
        totalIndices: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          description: "Category indices that represent totals (running sum resets).",
        },
      },
      additionalProperties: false,
    },
    ComboMarkOptions: {
      type: "object",
      description: "Options for combo charts. Combines bars, lines, and areas on one plot.",
      properties: {
        seriesMarks: {
          type: "object",
          description: "Per-series mark type overrides. Key = series index (as string), value = mark type.",
          additionalProperties: {
            type: "string",
            enum: ["bar", "line", "area"],
          },
        },
        secondaryYAxis: { type: "boolean", description: "Enable secondary (right) Y axis. Default: false." },
        secondaryAxisSeries: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          description: "Series indices that use the secondary Y axis.",
        },
        secondaryAxis: {
          $ref: "#/definitions/AxisSpec",
          description: "Secondary Y axis configuration.",
        },
      },
      additionalProperties: false,
    },
    RadarMarkOptions: {
      type: "object",
      description: "Options for radar (spider) charts.",
      properties: {
        showFill: { type: "boolean", description: "Show filled polygon area. Default: true." },
        fillOpacity: { type: "number", minimum: 0, maximum: 1, description: "Fill opacity (0-1). Default: 0.2." },
        lineWidth: { type: "number", minimum: 0.5, description: "Line width in pixels. Default: 2." },
        showMarkers: { type: "boolean", description: "Show point markers at vertices. Default: true." },
        markerRadius: { type: "number", minimum: 1, description: "Marker radius in pixels. Default: 4." },
      },
      additionalProperties: false,
    },
    BubbleMarkOptions: {
      type: "object",
      description: "Options for bubble charts. Scatter plot with sized bubbles.",
      properties: {
        sizeSeriesIndex: { type: "integer", minimum: 0, description: "Series index used for bubble sizes. Default: last series." },
        minBubbleSize: { type: "number", minimum: 1, description: "Minimum bubble radius in pixels. Default: 4." },
        maxBubbleSize: { type: "number", minimum: 1, description: "Maximum bubble radius in pixels. Default: 30." },
        bubbleOpacity: { type: "number", minimum: 0, maximum: 1, description: "Bubble opacity (0-1). Default: 0.7." },
      },
      additionalProperties: false,
    },
    HistogramMarkOptions: {
      type: "object",
      description: "Options for histogram charts. Auto-bins numeric data.",
      properties: {
        binCount: { type: "integer", minimum: 2, description: "Number of bins. Default: 10." },
        borderRadius: { type: "number", minimum: 0, description: "Corner radius on bars in pixels. Default: 1." },
      },
      additionalProperties: false,
    },
    FunnelMarkOptions: {
      type: "object",
      description: "Options for funnel charts. Progressively narrowing sections.",
      properties: {
        neckWidthRatio: { type: "number", minimum: 0.05, maximum: 0.95, description: "Narrowest width as ratio of widest. Default: 0.3." },
        showLabels: { type: "boolean", description: "Show labels on sections. Default: true." },
        labelFormat: { type: "string", enum: ["value", "percent", "both"], description: "Label format. Default: \"both\"." },
        sectionGap: { type: "number", minimum: 0, description: "Gap between sections in pixels. Default: 2." },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * Generate a human-readable reference document from the schema.
 * Used by the Reference panel in the standalone spec editor.
 */
export function generateSpecReference(): string {
  const lines: string[] = [];

  lines.push("# ChartSpec Reference");
  lines.push("");
  lines.push("## Top-Level Properties");
  lines.push("");
  lines.push("| Property | Type | Description |");
  lines.push("|----------|------|-------------|");
  lines.push("| mark | string | Chart type: bar, horizontalBar, line, area, scatter, pie, donut, waterfall, combo, radar, bubble, histogram, funnel |");
  lines.push("| data | object \\| string | DataRangeRef object, A1 reference string, or named range name |");
  lines.push("| hasHeaders | boolean | First row/column contains header labels |");
  lines.push("| seriesOrientation | string | \"columns\" or \"rows\" |");
  lines.push("| categoryIndex | integer | Column/row index for category labels |");
  lines.push("| series | array | Array of ChartSeries objects |");
  lines.push("| title | string \\| null | Chart title. Supports cell refs like \"=A1\" |");
  lines.push("| xAxis | AxisSpec | X-axis configuration |");
  lines.push("| yAxis | AxisSpec | Y-axis configuration |");
  lines.push("| legend | LegendSpec | Legend configuration |");
  lines.push("| palette | string | Color palette: default, pastel, vivid, earth, ocean, monochrome |");
  lines.push("| markOptions | object | Mark-specific options (varies by chart type) |");
  lines.push("");

  lines.push("## ChartSeries");
  lines.push("");
  lines.push("| Property | Type | Description |");
  lines.push("|----------|------|-------------|");
  lines.push("| name | string | Series display name. Supports cell refs like \"=B1\" |");
  lines.push("| sourceIndex | integer | Column/row index in data range for this series |");
  lines.push("| color | string \\| null | Hex color override (e.g. \"#FF5733\") or null for palette |");
  lines.push("");

  lines.push("## AxisSpec");
  lines.push("");
  lines.push("| Property | Type | Description |");
  lines.push("|----------|------|-------------|");
  lines.push("| title | string \\| null | Axis title. Supports cell refs. null = no title |");
  lines.push("| gridLines | boolean | Show grid lines |");
  lines.push("| showLabels | boolean | Show tick labels |");
  lines.push("| labelAngle | integer | Label rotation: 0, 45, or 90 degrees |");
  lines.push("| min | number \\| null | Min value (null = auto) |");
  lines.push("| max | number \\| null | Max value (null = auto) |");
  lines.push("");

  lines.push("## LegendSpec");
  lines.push("");
  lines.push("| Property | Type | Description |");
  lines.push("|----------|------|-------------|");
  lines.push("| visible | boolean | Show the legend |");
  lines.push("| position | string | top, bottom, left, or right |");
  lines.push("");

  lines.push("## Mark Options by Chart Type");
  lines.push("");

  lines.push("### bar / horizontalBar");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| borderRadius | number | 2 | Corner radius on bars (px) |");
  lines.push("| barGap | number | 2 | Gap between grouped bars (px) |");
  lines.push("");

  lines.push("### line");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| interpolation | string | \"linear\" | linear, smooth, or step |");
  lines.push("| lineWidth | number | 2 | Line width (px) |");
  lines.push("| showMarkers | boolean | true | Show point markers |");
  lines.push("| markerRadius | number | 4 | Marker radius (px) |");
  lines.push("");

  lines.push("### area");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| interpolation | string | \"linear\" | linear, smooth, or step |");
  lines.push("| lineWidth | number | 2 | Line width (px) |");
  lines.push("| fillOpacity | number | 0.3 | Fill opacity (0-1) |");
  lines.push("| showMarkers | boolean | false | Show point markers |");
  lines.push("| markerRadius | number | 4 | Marker radius (px) |");
  lines.push("| stacked | boolean | false | Stack overlapping areas |");
  lines.push("");

  lines.push("### scatter");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| pointShape | string | \"circle\" | circle, square, diamond, triangle |");
  lines.push("| pointSize | number | 5 | Point radius (px) |");
  lines.push("");

  lines.push("### pie / donut");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| innerRadiusRatio | number | 0/0.5 | 0 = pie, 0.4-0.7 = donut |");
  lines.push("| startAngle | number | 0 | Start angle in degrees |");
  lines.push("| padAngle | number | 1 | Padding between slices (deg) |");
  lines.push("| showLabels | boolean | true | Show slice labels |");
  lines.push("| labelFormat | string | \"percent\" | value, percent, or both |");
  lines.push("");

  lines.push("### waterfall");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| showConnectors | boolean | true | Show connector lines |");
  lines.push("| increaseColor | string | \"#4CAF50\" | Increase bar color |");
  lines.push("| decreaseColor | string | \"#E53935\" | Decrease bar color |");
  lines.push("| totalColor | string | \"#5C6BC0\" | Total bar color |");
  lines.push("| totalIndices | number[] | [] | Indices of total categories |");
  lines.push("");

  lines.push("### combo");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| seriesMarks | object | {} | Per-series mark type: { \"0\": \"bar\", \"1\": \"line\" } |");
  lines.push("| secondaryYAxis | boolean | false | Enable right Y axis |");
  lines.push("| secondaryAxisSeries | number[] | [] | Series using secondary axis |");
  lines.push("| secondaryAxis | AxisSpec | - | Secondary axis config |");
  lines.push("");

  lines.push("### radar");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| showFill | boolean | true | Show filled polygon area |");
  lines.push("| fillOpacity | number | 0.2 | Fill opacity (0-1) |");
  lines.push("| lineWidth | number | 2 | Line width (px) |");
  lines.push("| showMarkers | boolean | true | Show point markers |");
  lines.push("| markerRadius | number | 4 | Marker radius (px) |");
  lines.push("");

  lines.push("### bubble");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| sizeSeriesIndex | integer | last | Series index for bubble sizes |");
  lines.push("| minBubbleSize | number | 4 | Min bubble radius (px) |");
  lines.push("| maxBubbleSize | number | 30 | Max bubble radius (px) |");
  lines.push("| bubbleOpacity | number | 0.7 | Bubble opacity (0-1) |");
  lines.push("");

  lines.push("### histogram");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| binCount | integer | 10 | Number of bins |");
  lines.push("| borderRadius | number | 1 | Corner radius on bars (px) |");
  lines.push("");

  lines.push("### funnel");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| neckWidthRatio | number | 0.3 | Narrowest width ratio (0.05-0.95) |");
  lines.push("| showLabels | boolean | true | Show section labels |");
  lines.push("| labelFormat | string | \"both\" | value, percent, or both |");
  lines.push("| sectionGap | number | 2 | Gap between sections (px) |");
  lines.push("");

  lines.push("## Cell References");
  lines.push("");
  lines.push("String fields (title, axis titles, series names) support cell references:");
  lines.push("- \"=A1\" reads the display value from cell A1");
  lines.push("- \"=Sheet1!B5\" reads from a specific sheet");
  lines.push("- \"='My Sheet'!C1\" quote sheet names with spaces");
  lines.push("");

  lines.push("## Data Source Formats");
  lines.push("");
  lines.push("The `data` field accepts three formats:");
  lines.push("1. **DataRangeRef object**: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 9, endCol: 3 }");
  lines.push("2. **A1 reference**: \"Sheet1!A1:D10\" or \"A1:D10\"");
  lines.push("3. **Named range**: \"SalesData\"");

  return lines.join("\n");
}
