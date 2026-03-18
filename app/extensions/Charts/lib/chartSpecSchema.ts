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
        { $ref: "#/definitions/RuleMarkOptions" },
        { $ref: "#/definitions/TextMarkOptions" },
      ],
    },
    layers: {
      type: "array",
      description: "Additional layers overlaid on the primary chart. Each layer can be a chart type, a rule (reference line), or a text annotation.",
      items: { $ref: "#/definitions/LayerSpec" },
    },
    transform: {
      type: "array",
      description: "Data transform pipeline applied after reading data, before rendering. Transforms execute in order.",
      items: { $ref: "#/definitions/TransformSpec" },
    },
    config: {
      $ref: "#/definitions/ChartConfig",
      description: "Chart-level configuration (theme overrides).",
    },
    tooltip: {
      $ref: "#/definitions/TooltipSpec",
      description: "Tooltip display configuration.",
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
        encoding: {
          $ref: "#/definitions/SeriesEncoding",
          description: "Per-data-point visual encoding (conditional color, opacity, size).",
        },
      },
      additionalProperties: false,
    },
    SeriesEncoding: {
      type: "object",
      description: "Per-data-point visual encoding. Allows conditional color, opacity, or size based on value or category.",
      properties: {
        color: {
          description: "Point color. Static string or conditional.",
          oneOf: [
            { type: "string", description: "Static color override (hex or CSS)." },
            { $ref: "#/definitions/ConditionalColor" },
          ],
        },
        opacity: {
          description: "Point opacity (0-1). Static number or conditional.",
          oneOf: [
            { type: "number", minimum: 0, maximum: 1, description: "Static opacity." },
            { $ref: "#/definitions/ConditionalNumber" },
          ],
        },
        size: {
          description: "Point size (scatter/bubble). Static number or conditional.",
          oneOf: [
            { type: "number", minimum: 0, description: "Static size override." },
            { $ref: "#/definitions/ConditionalNumber" },
          ],
        },
        strokeDash: {
          type: "array",
          items: { type: "number" },
          description: "Dash pattern for the series line (e.g. [6, 3]).",
        },
        strokeWidth: {
          type: "number",
          minimum: 0,
          description: "Stroke width override for the series.",
        },
      },
      additionalProperties: false,
    },
    ConditionalColor: {
      type: "object",
      description: "Conditional color: applies 'value' when condition is true, 'otherwise' when false.",
      required: ["condition", "value", "otherwise"],
      properties: {
        condition: { $ref: "#/definitions/ValueCondition" },
        value: { type: "string", description: "Color when condition is true." },
        otherwise: { type: "string", description: "Color when condition is false." },
      },
      additionalProperties: false,
    },
    ConditionalNumber: {
      type: "object",
      description: "Conditional number: applies 'value' when condition is true, 'otherwise' when false.",
      required: ["condition", "value", "otherwise"],
      properties: {
        condition: { $ref: "#/definitions/ValueCondition" },
        value: { type: "number", description: "Number when condition is true." },
        otherwise: { type: "number", description: "Number when condition is false." },
      },
      additionalProperties: false,
    },
    ValueCondition: {
      type: "object",
      description: "Condition evaluated per data point. Tests the 'value' (numeric) or 'category' (string) field.",
      required: ["field"],
      properties: {
        field: {
          type: "string",
          enum: ["value", "category"],
          description: "Which datum field to test: 'value' for the numeric value, 'category' for the category label.",
        },
        gt: { type: "number", description: "Greater than." },
        lt: { type: "number", description: "Less than." },
        gte: { type: "number", description: "Greater than or equal to." },
        lte: { type: "number", description: "Less than or equal to." },
        oneOf: {
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "number" }] },
          description: "Match if value/category is one of these values.",
        },
      },
      additionalProperties: false,
    },
    ScaleSpec: {
      type: "object",
      description: "Scale configuration for a value axis. Controls how data values map to pixel positions.",
      properties: {
        type: {
          type: "string",
          enum: ["linear", "log", "pow", "sqrt"],
          description: "Scale type. Default: \"linear\". Use \"log\" for exponential data, \"sqrt\" for area-proportional.",
        },
        domain: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description: "Override data extent as [min, max]. Default: auto from data.",
        },
        zero: {
          type: "boolean",
          description: "Include zero in the domain. Default: true for bar, false for line/scatter.",
        },
        nice: {
          type: "boolean",
          description: "Extend domain to nice round numbers. Default: true.",
        },
        reverse: {
          type: "boolean",
          description: "Reverse the scale direction (flip axis). Default: false.",
        },
        exponent: {
          type: "number",
          minimum: 0.1,
          description: "Exponent for \"pow\" scale type. Default: 2.",
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
        scale: {
          $ref: "#/definitions/ScaleSpec",
          description: "Scale configuration (type, domain override, log/pow/sqrt). Default: linear.",
        },
        tickCount: {
          type: "integer",
          minimum: 2,
          description: "Desired number of tick marks. Default: 5.",
        },
        tickFormat: {
          type: "string",
          description: "Number format string for tick labels (e.g. \",.2f\", \"$,.0f\", \"%\").",
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
    RuleMarkOptions: {
      type: "object",
      description: "Options for rule marks (reference lines). Used in layers.",
      properties: {
        y: { type: "number", description: "Y value for a horizontal reference line." },
        x: { type: "number", description: "X category index for a vertical reference line." },
        color: { type: "string", description: "Line color (hex or CSS). Default: \"#999999\"." },
        strokeWidth: { type: "number", minimum: 0.5, description: "Stroke width in pixels. Default: 1." },
        strokeDash: {
          type: "array",
          items: { type: "number" },
          description: "Dash pattern (e.g. [6, 3] for dashed). Default: [] (solid).",
        },
        label: { type: "string", description: "Label text displayed near the line." },
      },
      additionalProperties: false,
    },
    TextMarkOptions: {
      type: "object",
      description: "Options for text annotations. Used in layers.",
      required: ["text"],
      properties: {
        x: { type: "number", description: "X position as category index." },
        y: { type: "number", description: "Y position as data value." },
        text: { type: "string", description: "Text content. Supports cell references like \"=A1\"." },
        fontSize: { type: "number", minimum: 6, description: "Font size in pixels. Default: 11." },
        color: { type: "string", description: "Text color. Default: \"#333333\"." },
        anchor: { type: "string", enum: ["start", "middle", "end"], description: "Horizontal anchor. Default: \"middle\"." },
        baseline: { type: "string", enum: ["top", "middle", "bottom"], description: "Vertical baseline. Default: \"middle\"." },
      },
      additionalProperties: false,
    },
    LayerSpec: {
      type: "object",
      description: "A layer overlaid on the primary chart. Can be another chart type, a rule (reference line), or text annotation.",
      required: ["mark"],
      properties: {
        mark: {
          type: "string",
          enum: ["bar", "horizontalBar", "line", "area", "scatter", "pie", "donut", "waterfall", "combo", "radar", "bubble", "histogram", "funnel", "rule", "text"],
          description: "Mark type for this layer. Use \"rule\" for reference lines, \"text\" for annotations.",
        },
        data: {
          description: "Layer data source. If omitted, shares the parent chart's data.",
          oneOf: [
            { $ref: "#/definitions/DataRangeRef" },
            { type: "string" },
          ],
        },
        series: {
          type: "array",
          items: { $ref: "#/definitions/ChartSeries" },
          description: "Series definitions for this layer. If omitted, uses parent's series.",
        },
        markOptions: {
          description: "Mark-specific options for this layer.",
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
            { $ref: "#/definitions/RuleMarkOptions" },
            { $ref: "#/definitions/TextMarkOptions" },
          ],
        },
        opacity: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Layer opacity (0-1). Default: 1.",
        },
      },
      additionalProperties: false,
    },
    ChartConfig: {
      type: "object",
      description: "Chart-level configuration for theming and defaults.",
      properties: {
        theme: {
          $ref: "#/definitions/ThemeOverrides",
          description: "Override any built-in theme property.",
        },
      },
      additionalProperties: false,
    },
    ThemeOverrides: {
      type: "object",
      description: "Override any property of the built-in chart render theme. All fields are optional.",
      properties: {
        background: { type: "string", description: "Chart background color. Default: \"#ffffff\"." },
        plotBackground: { type: "string", description: "Plot area background color. Default: \"#fafafa\"." },
        gridLineColor: { type: "string", description: "Grid line color. Default: \"#e8e8e8\"." },
        gridLineWidth: { type: "number", minimum: 0, description: "Grid line width (px). Default: 1." },
        axisColor: { type: "string", description: "Axis line color. Default: \"#999999\"." },
        axisLabelColor: { type: "string", description: "Axis label text color. Default: \"#666666\"." },
        axisTitleColor: { type: "string", description: "Axis title text color. Default: \"#444444\"." },
        titleColor: { type: "string", description: "Chart title color. Default: \"#333333\"." },
        legendTextColor: { type: "string", description: "Legend text color. Default: \"#555555\"." },
        fontFamily: { type: "string", description: "Font family for all text. Default: \"'Segoe UI', system-ui, sans-serif\"." },
        titleFontSize: { type: "number", minimum: 8, description: "Title font size (px). Default: 14." },
        axisTitleFontSize: { type: "number", minimum: 6, description: "Axis title font size (px). Default: 11." },
        labelFontSize: { type: "number", minimum: 6, description: "Axis label font size (px). Default: 10." },
        legendFontSize: { type: "number", minimum: 6, description: "Legend font size (px). Default: 10." },
        barBorderRadius: { type: "number", minimum: 0, description: "Bar corner radius (px). Default: 2." },
        barGap: { type: "number", minimum: 0, description: "Gap between grouped bars (px). Default: 2." },
      },
      additionalProperties: false,
    },
    TooltipSpec: {
      type: "object",
      description: "Tooltip display configuration.",
      properties: {
        enabled: { type: "boolean", description: "Whether tooltips are shown on hover. Default: true." },
        fields: {
          type: "array",
          items: { type: "string", enum: ["series", "category", "value"] },
          description: "Which fields to display. Default: [\"series\", \"category\", \"value\"].",
        },
        format: {
          type: "object",
          description: "Number format overrides per field (e.g. { \"value\": \"$,.2f\" }).",
          additionalProperties: { type: "string" },
        },
      },
      additionalProperties: false,
    },
    TransformSpec: {
      description: "A data transform step. Applied in sequence before rendering.",
      oneOf: [
        { $ref: "#/definitions/FilterTransform" },
        { $ref: "#/definitions/SortTransform" },
        { $ref: "#/definitions/AggregateTransform" },
        { $ref: "#/definitions/CalculateTransform" },
        { $ref: "#/definitions/WindowTransform" },
        { $ref: "#/definitions/BinTransform" },
      ],
    },
    FilterTransform: {
      type: "object",
      description: "Remove data points where the predicate is false.",
      required: ["type", "field", "predicate"],
      properties: {
        type: { type: "string", const: "filter" },
        field: { type: "string", description: "Series name to evaluate. Use \"$category\" for category labels." },
        predicate: { type: "string", description: "Predicate: \"> 100\", \"!= 0\", \"<= 50\", \"= text\". Ops: >, <, >=, <=, =, !=" },
      },
      additionalProperties: false,
    },
    SortTransform: {
      type: "object",
      description: "Reorder data points by a field's values.",
      required: ["type", "field"],
      properties: {
        type: { type: "string", const: "sort" },
        field: { type: "string", description: "Series name to sort by. Use \"$category\" for alphabetical sort." },
        order: { type: "string", enum: ["asc", "desc"], description: "Sort order. Default: \"asc\"." },
      },
      additionalProperties: false,
    },
    AggregateTransform: {
      type: "object",
      description: "Group by categories and aggregate series values.",
      required: ["type", "groupBy", "op", "field", "as"],
      properties: {
        type: { type: "string", const: "aggregate" },
        groupBy: { type: "array", items: { type: "string" }, description: "Fields to group by. Use \"$category\" for category labels." },
        op: { type: "string", enum: ["sum", "mean", "median", "min", "max", "count"], description: "Aggregation operation." },
        field: { type: "string", description: "Series name whose values to aggregate." },
        as: { type: "string", description: "Name for the resulting series." },
      },
      additionalProperties: false,
    },
    CalculateTransform: {
      type: "object",
      description: "Create a new series from an arithmetic expression referencing other series.",
      required: ["type", "expr", "as"],
      properties: {
        type: { type: "string", const: "calculate" },
        expr: { type: "string", description: "Expression: \"Revenue * 1.1\", \"Revenue - Cost\". Variables: series names, $index, $category." },
        as: { type: "string", description: "Name for the resulting series." },
      },
      additionalProperties: false,
    },
    WindowTransform: {
      type: "object",
      description: "Compute a running value over a series (cumulative sum, mean, or rank).",
      required: ["type", "op", "field", "as"],
      properties: {
        type: { type: "string", const: "window" },
        op: { type: "string", enum: ["running_sum", "running_mean", "rank"], description: "Window operation." },
        field: { type: "string", description: "Series name to compute over." },
        as: { type: "string", description: "Name for the resulting series." },
      },
      additionalProperties: false,
    },
    BinTransform: {
      type: "object",
      description: "Group numeric values into bins (histogram-style).",
      required: ["type", "field", "as"],
      properties: {
        type: { type: "string", const: "bin" },
        field: { type: "string", description: "Series name whose values to bin." },
        binCount: { type: "integer", minimum: 2, description: "Number of bins. Default: 10." },
        as: { type: "string", description: "Name for the binned category output." },
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
  lines.push("| layers | LayerSpec[] | Additional layers overlaid on the chart (annotations, overlays) |");
  lines.push("| transform | TransformSpec[] | Data transform pipeline (filter, sort, aggregate, etc.) |");
  lines.push("| config | ChartConfig | Theme overrides (colors, fonts, spacing) |");
  lines.push("| tooltip | TooltipSpec | Tooltip display configuration |");
  lines.push("");

  lines.push("## ChartSeries");
  lines.push("");
  lines.push("| Property | Type | Description |");
  lines.push("|----------|------|-------------|");
  lines.push("| name | string | Series display name. Supports cell refs like \"=B1\" |");
  lines.push("| sourceIndex | integer | Column/row index in data range for this series |");
  lines.push("| color | string \\| null | Hex color override (e.g. \"#FF5733\") or null for palette |");
  lines.push("| encoding | SeriesEncoding | Per-data-point visual encoding (conditional color, opacity, size) |");
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
  lines.push("| scale | ScaleSpec | Scale configuration (type, domain, reverse) |");
  lines.push("| tickCount | integer | Desired number of tick marks. Default: 5 |");
  lines.push("| tickFormat | string | Number format for tick labels |");
  lines.push("");

  lines.push("## ScaleSpec");
  lines.push("");
  lines.push("Controls how data values map to pixel positions on an axis.");
  lines.push("");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| type | string | \"linear\" | linear, log, pow, or sqrt |");
  lines.push("| domain | [number, number] | auto | Override data extent [min, max] |");
  lines.push("| zero | boolean | varies | Include zero in domain |");
  lines.push("| nice | boolean | true | Round domain to nice values |");
  lines.push("| reverse | boolean | false | Flip axis direction |");
  lines.push("| exponent | number | 2 | Exponent for pow scale |");
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

  lines.push("### rule (reference line)");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| y | number | - | Y value for horizontal line |");
  lines.push("| x | number | - | X category index for vertical line |");
  lines.push("| color | string | \"#999999\" | Line color |");
  lines.push("| strokeWidth | number | 1 | Stroke width (px) |");
  lines.push("| strokeDash | number[] | [] | Dash pattern (e.g. [6, 3]) |");
  lines.push("| label | string | - | Label near the line |");
  lines.push("");

  lines.push("### text (annotation)");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| x | number | 0 | X position (category index) |");
  lines.push("| y | number | 0 | Y position (data value) |");
  lines.push("| text | string | required | Text content. Supports cell refs |");
  lines.push("| fontSize | number | 11 | Font size (px) |");
  lines.push("| color | string | \"#333333\" | Text color |");
  lines.push("| anchor | string | \"middle\" | start, middle, or end |");
  lines.push("| baseline | string | \"middle\" | top, middle, or bottom |");
  lines.push("");

  lines.push("## Layers");
  lines.push("");
  lines.push("Layers add overlays to the primary chart. Each layer has its own mark type and options.");
  lines.push("Layer marks share the parent chart's scales and layout.");
  lines.push("");
  lines.push("| Property | Type | Required | Description |");
  lines.push("|----------|------|----------|-------------|");
  lines.push("| mark | string | yes | Chart type, \"rule\", or \"text\" |");
  lines.push("| data | DataSource | no | Override data (omit to share parent) |");
  lines.push("| series | ChartSeries[] | no | Override series (omit to share parent) |");
  lines.push("| markOptions | object | no | Mark-specific options for this layer |");
  lines.push("| opacity | number | no | Layer opacity (0-1). Default: 1 |");
  lines.push("");
  lines.push("Example: Add a target line to a bar chart:");
  lines.push("  \"layers\": [{ \"mark\": \"rule\", \"markOptions\": { \"y\": 1000, \"strokeDash\": [6, 3], \"label\": \"Target\" } }]");
  lines.push("");

  lines.push("## Data Transforms");
  lines.push("");
  lines.push("Transforms are applied in order after data is read, before rendering.");
  lines.push("Each transform takes the current data and produces new data.");
  lines.push("Use \"$category\" to reference category labels in field parameters.");
  lines.push("");
  lines.push("### filter");
  lines.push("Remove data points where a condition is false.");
  lines.push("| Property | Type | Required | Description |");
  lines.push("|----------|------|----------|-------------|");
  lines.push("| type | \"filter\" | yes | |");
  lines.push("| field | string | yes | Series name or \"$category\" |");
  lines.push("| predicate | string | yes | \"> 100\", \"!= 0\", \"<= 50\", \"= text\" |");
  lines.push("");
  lines.push("### sort");
  lines.push("Reorder data points by a field.");
  lines.push("| Property | Type | Required | Description |");
  lines.push("|----------|------|----------|-------------|");
  lines.push("| type | \"sort\" | yes | |");
  lines.push("| field | string | yes | Series name or \"$category\" |");
  lines.push("| order | string | no | \"asc\" (default) or \"desc\" |");
  lines.push("");
  lines.push("### aggregate");
  lines.push("Group and reduce data.");
  lines.push("| Property | Type | Required | Description |");
  lines.push("|----------|------|----------|-------------|");
  lines.push("| type | \"aggregate\" | yes | |");
  lines.push("| groupBy | string[] | yes | [\"$category\"] or series names |");
  lines.push("| op | string | yes | sum, mean, median, min, max, count |");
  lines.push("| field | string | yes | Series to aggregate |");
  lines.push("| as | string | yes | Output series name |");
  lines.push("");
  lines.push("### calculate");
  lines.push("Create a new series from an expression.");
  lines.push("| Property | Type | Required | Description |");
  lines.push("|----------|------|----------|-------------|");
  lines.push("| type | \"calculate\" | yes | |");
  lines.push("| expr | string | yes | e.g. \"Revenue - Cost\", \"Revenue * 1.1\" |");
  lines.push("| as | string | yes | Output series name |");
  lines.push("");
  lines.push("### window");
  lines.push("Compute running values.");
  lines.push("| Property | Type | Required | Description |");
  lines.push("|----------|------|----------|-------------|");
  lines.push("| type | \"window\" | yes | |");
  lines.push("| op | string | yes | running_sum, running_mean, rank |");
  lines.push("| field | string | yes | Source series name |");
  lines.push("| as | string | yes | Output series name |");
  lines.push("");
  lines.push("### bin");
  lines.push("Group numeric values into bins.");
  lines.push("| Property | Type | Required | Description |");
  lines.push("|----------|------|----------|-------------|");
  lines.push("| type | \"bin\" | yes | |");
  lines.push("| field | string | yes | Series to bin |");
  lines.push("| binCount | integer | no | Number of bins (default: 10) |");
  lines.push("| as | string | yes | Output series name |");
  lines.push("");
  lines.push("Example: Filter and sort a bar chart:");
  lines.push("```json");
  lines.push("\"transform\": [");
  lines.push("  { \"type\": \"filter\", \"field\": \"Revenue\", \"predicate\": \"> 100\" },");
  lines.push("  { \"type\": \"sort\", \"field\": \"Revenue\", \"order\": \"desc\" }");
  lines.push("]");
  lines.push("```");
  lines.push("");
  lines.push("Example: Add a cumulative sum overlay:");
  lines.push("```json");
  lines.push("\"transform\": [");
  lines.push("  { \"type\": \"window\", \"op\": \"running_sum\", \"field\": \"Revenue\", \"as\": \"Cumulative\" }");
  lines.push("]");
  lines.push("```");
  lines.push("");

  lines.push("## Conditional Encoding");
  lines.push("");
  lines.push("Add per-data-point visual properties to any series via the `encoding` field.");
  lines.push("Each encoding property can be a static value or a conditional object.");
  lines.push("");
  lines.push("### SeriesEncoding");
  lines.push("| Property | Type | Description |");
  lines.push("|----------|------|-------------|");
  lines.push("| color | string \\| Conditional | Point color (hex/CSS or conditional) |");
  lines.push("| opacity | number \\| Conditional | Point opacity 0-1 (static or conditional) |");
  lines.push("| size | number \\| Conditional | Point size for scatter/bubble (static or conditional) |");
  lines.push("| strokeDash | number[] | Dash pattern for the series line |");
  lines.push("| strokeWidth | number | Stroke width override |");
  lines.push("");
  lines.push("### Conditional Value");
  lines.push("```json");
  lines.push("{ \"condition\": { \"field\": \"value\", \"lt\": 0 }, \"value\": \"#E15759\", \"otherwise\": \"#4E79A7\" }");
  lines.push("```");
  lines.push("");
  lines.push("### ValueCondition");
  lines.push("| Property | Type | Description |");
  lines.push("|----------|------|-------------|");
  lines.push("| field | string | \"value\" (numeric) or \"category\" (string) |");
  lines.push("| gt | number | Greater than |");
  lines.push("| lt | number | Less than |");
  lines.push("| gte | number | Greater than or equal |");
  lines.push("| lte | number | Less than or equal |");
  lines.push("| oneOf | array | Match if value/category is in list |");
  lines.push("");
  lines.push("Example: Color bars red for negative values, blue for positive:");
  lines.push("```json");
  lines.push("\"series\": [{ \"name\": \"Profit\", \"sourceIndex\": 1, \"color\": null,");
  lines.push("  \"encoding\": { \"color\": { \"condition\": { \"field\": \"value\", \"lt\": 0 },");
  lines.push("    \"value\": \"#E15759\", \"otherwise\": \"#4E79A7\" } } }]");
  lines.push("```");
  lines.push("");

  lines.push("## Deep Theming");
  lines.push("");
  lines.push("Override any visual property via `config.theme`.");
  lines.push("Only specified properties override defaults — unset properties keep the built-in values.");
  lines.push("");
  lines.push("### ThemeOverrides");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| background | string | \"#ffffff\" | Chart background |");
  lines.push("| plotBackground | string | \"#fafafa\" | Plot area background |");
  lines.push("| gridLineColor | string | \"#e8e8e8\" | Grid line color |");
  lines.push("| gridLineWidth | number | 1 | Grid line width (px) |");
  lines.push("| axisColor | string | \"#999999\" | Axis line color |");
  lines.push("| axisLabelColor | string | \"#666666\" | Axis label color |");
  lines.push("| axisTitleColor | string | \"#444444\" | Axis title color |");
  lines.push("| titleColor | string | \"#333333\" | Chart title color |");
  lines.push("| legendTextColor | string | \"#555555\" | Legend text color |");
  lines.push("| fontFamily | string | Segoe UI | Font family |");
  lines.push("| titleFontSize | number | 14 | Title font size (px) |");
  lines.push("| axisTitleFontSize | number | 11 | Axis title size (px) |");
  lines.push("| labelFontSize | number | 10 | Axis label size (px) |");
  lines.push("| legendFontSize | number | 10 | Legend font size (px) |");
  lines.push("| barBorderRadius | number | 2 | Bar corner radius (px) |");
  lines.push("| barGap | number | 2 | Gap between bars (px) |");
  lines.push("");
  lines.push("Example: Dark theme with larger fonts:");
  lines.push("```json");
  lines.push("\"config\": { \"theme\": {");
  lines.push("  \"background\": \"#1e1e1e\", \"plotBackground\": \"#2d2d2d\",");
  lines.push("  \"gridLineColor\": \"#444\", \"axisColor\": \"#666\",");
  lines.push("  \"axisLabelColor\": \"#aaa\", \"titleColor\": \"#eee\",");
  lines.push("  \"titleFontSize\": 16, \"labelFontSize\": 12");
  lines.push("} }");
  lines.push("```");
  lines.push("");
  lines.push("## Tooltip Configuration");
  lines.push("");
  lines.push("| Property | Type | Default | Description |");
  lines.push("|----------|------|---------|-------------|");
  lines.push("| enabled | boolean | true | Show tooltips on hover |");
  lines.push("| fields | string[] | [\"series\",\"category\",\"value\"] | Fields to display |");
  lines.push("| format | object | {} | Number format per field, e.g. { \"value\": \"$,.2f\" } |");
  lines.push("");
  lines.push("Format patterns: \"$,.2f\" (currency), \",.0f\" (integer with commas), \"%\" (percentage).");
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
