//! FILENAME: app/extensions/Charts/lib/chartSnippets.ts
// PURPOSE: Insert-snippet catalog for the Chart Spec editor (B6).
// CONTEXT: Monaco completion items that expand a full, tab-stop-editable property
//          block for each powerful spec feature (transforms, trendlines, layers,
//          params, encoding, composition, overrides). Complements the B7 example
//          gallery: the gallery loads a WHOLE starter spec, snippets insert one
//          feature into the spec you already have. Each `body` is a top-level
//          property fragment ("key": value) in Monaco snippet syntax — drop it
//          between existing properties (the schema validator flags a missing
//          comma immediately). Pure data; MonacoSpecEditor turns it into a scoped
//          completion provider.

/** One insertable snippet. */
export interface ChartSnippet {
  /** What the user sees / types to filter (e.g. "transform: filter"). */
  label: string;
  /** Short right-aligned hint in the suggest list. */
  detail: string;
  /** Markdown shown in the suggestion's details flyout. */
  documentation: string;
  /**
   * Monaco snippet text — a top-level property fragment with ${1:..} tab stops
   * and ${1|a,b|} choices. A literal `$` (e.g. the $category built-in) is escaped
   * as `\$` per Monaco snippet rules.
   */
  body: string;
}

// ============================================================================
// Catalog
// ============================================================================

export const CHART_SNIPPETS: ChartSnippet[] = [
  // ── Transforms (data shaping) ──────────────────────────────────────────────
  {
    label: "transform: filter",
    detail: "Keep rows matching a predicate",
    documentation: "A `filter` transform. The predicate is a full expression over series names and the built-in `value`/`$value`; supports compound `AND`/`OR` and `[Param]` references.",
    body: '"transform": [\n  { "type": "filter", "field": "${1:Revenue}", "predicate": "${2:value > 100}" }\n]',
  },
  {
    label: "transform: calculate",
    detail: "Derive a new series with a formula",
    documentation: "A `calculate` transform adding a computed series. Uses the chart formula language (IF/ROUND/etc.) over existing series names.",
    body: '"transform": [\n  { "type": "calculate", "expr": "${1:IF(Revenue > 0, ROUND((Revenue - Cost) / Revenue * 100, 1), 0)}", "as": "${2:Margin %}" }\n]',
  },
  {
    label: "transform: aggregate",
    detail: "Group rows and summarize",
    documentation: "An `aggregate` transform. Omit `field` to aggregate EVERY series per group (multi-series result); group by `$category` or a subset.",
    body: '"transform": [\n  { "type": "aggregate", "groupBy": ["\\$category"], "op": "${1|sum,mean,median,min,max,count|}" }\n]',
  },
  {
    label: "transform: sort",
    detail: "Order rows by a field",
    documentation: "A `sort` transform. Sort by a series name or `$category`.",
    body: '"transform": [\n  { "type": "sort", "field": "${1:Revenue}", "order": "${2|desc,asc|}" }\n]',
  },
  {
    label: "transform: lookup",
    detail: "Join a series from a second range",
    documentation: "A `lookup` transform that joins additional series from a second range by matching the category label.",
    body: '"transform": [\n  { "type": "lookup", "from": "${1:Targets!A1:B13}", "fields": ["${2:Target}"], "default": ${3:0} }\n]',
  },
  {
    label: "transform: pivot",
    detail: "Reshape long rows into wide series",
    documentation: "A `pivot` transform (long → wide): each distinct `key` value becomes a series across `category`, aggregating `value`. Place it first; reference SOURCE column headers.",
    body: '"transform": [\n  { "type": "pivot", "category": "${1:Region}", "key": "${2:Month}", "value": "${3:Sales}", "op": "${4|sum,mean,median,min,max,count|}" }\n]',
  },

  // ── Trendlines ─────────────────────────────────────────────────────────────
  {
    label: "trendlines",
    detail: "Regression / moving-average line",
    documentation: "A trendline over a series. Types: linear, exponential, polynomial, power, logarithmic, movingAverage.",
    body: '"trendlines": [\n  { "type": "${1|linear,movingAverage,exponential,logarithmic,power,polynomial|}", "seriesIndex": ${2:0}, "showEquation": ${3|false,true|} }\n]',
  },

  // ── Layers (annotations) ───────────────────────────────────────────────────
  {
    label: "layer: target line (rule)",
    detail: "Horizontal/vertical reference line",
    documentation: "A `rule` layer — a reference line at a Y value (or X category index), with an optional dash and label.",
    body: '"layers": [\n  { "mark": "rule", "markOptions": { "y": ${1:500}, "color": "${2:#E15759}", "strokeDash": [6, 3], "label": "${3:Target}" } }\n]',
  },
  {
    label: "layer: text annotation",
    detail: "Text callout at a point",
    documentation: "A `text` layer — an annotation anchored at a category index (x) and value (y). `text` accepts a cell reference like \"=A1\".",
    body: '"layers": [\n  { "mark": "text", "markOptions": { "x": ${1:0}, "y": ${2:500}, "text": "${3:Note}", "anchor": "${4|middle,start,end|}" } }\n]',
  },

  // ── Parameters / interactivity ─────────────────────────────────────────────
  {
    label: "param: cell-bound",
    detail: "Live value from a sheet cell",
    documentation: "A parameter whose value comes from a single same-sheet cell. Reference it in filter/calculate expressions as `[Name]`; it re-evaluates live as the cell changes.",
    body: '"params": [\n  { "name": "${1:Threshold}", "cellRef": "=${2:B1}", "value": ${3:100}, "description": "${4:Minimum to show}" }\n]',
  },
  {
    label: "param: click-to-highlight",
    detail: "Point selection (interactive)",
    documentation: "A `select: \"point\"` parameter. Click a datum to set the selection; reference it from a conditional encoding via `inSelection` to highlight. `on` keys the selection by category or series.",
    body: '"params": [\n  { "name": "${1:picked}", "select": "point", "on": "${2|category,series|}" }\n]',
  },
  {
    label: "param: stepper widget",
    detail: "On-canvas +/- control",
    documentation: "A parameter bound to an on-canvas widget. `stepper` clamps to [min,max]; `cycle` wraps; `segment` shows options. Reference it as `[Name]` in expressions.",
    body: '"params": [\n  { "name": "${1:Threshold}", "value": ${2:100}, "bind": { "input": "${3|stepper,cycle,segment|}", "min": ${4:0}, "max": ${5:1000}, "step": ${6:50} } }\n]',
  },

  // ── Encoding channels ──────────────────────────────────────────────────────
  {
    label: "encoding channels",
    detail: "x / y / color over a long table",
    documentation: "An `encoding` block — a grammar-of-graphics shorthand compiled to the series model. `color` splits into one series per distinct value (a pivot); `y.aggregate` groups.",
    body: '"encoding": {\n  "x": { "field": "${1:Month}" },\n  "y": { "field": "${2:Sales}", "aggregate": "${3|sum,mean,median,min,max,count|}" },\n  "color": { "field": "${4:Region}" }\n}',
  },
  {
    label: "series: conditional color (highlight)",
    detail: "Highlight selected, dim the rest",
    documentation: "A series whose `color` encoding is driven by a `select: \"point\"` param (pair with the \"param: click-to-highlight\" snippet): the matched datum keeps its color, the rest are dimmed. Conditional color lives on a SERIES, so this inserts a `series` entry — merge it into your existing series array.",
    body: '"series": [\n  { "name": "${1:Revenue}", "sourceIndex": ${2:1}, "color": null, "encoding": { "color": { "condition": { "field": "category", "inSelection": "${3:picked}" }, "value": "${4:#4E79A7}", "otherwise": "${5:#d6d6d6}" } } }\n]',
  },

  // ── Composition ────────────────────────────────────────────────────────────
  {
    label: "facet by field",
    detail: "One panel per distinct value",
    documentation: "Facet the chart into one panel per distinct value of a categorical field (small multiples over rows). Panels share Y (and X) for comparability by default.",
    body: '"facet": { "field": "${1:Region}", "columns": ${2:2}, "sharedYScale": ${3|true,false|}, "sharedXScale": ${4|true,false|} }',
  },
  {
    label: "small multiples (repeat)",
    detail: "One panel per series",
    documentation: "Render the chart once per series in a tiled grid. Each panel is a single-series copy sharing one Y scale by default.",
    body: '"repeat": { "columns": ${1:2}, "sharedYScale": ${2|true,false|} }',
  },
  {
    label: "concat panels",
    detail: "Independent charts side by side",
    documentation: "Tile several INDEPENDENT child charts (each with its own data/mark/axes) into a grid. Add full child specs to `charts`.",
    body: '"concat": {\n  "columns": ${1:2},\n  "charts": [\n    ${0}\n  ]\n}',
  },

  // ── Per-point formatting / labels ──────────────────────────────────────────
  {
    label: "data point override",
    detail: "Format one bar/slice/point",
    documentation: "Override the appearance of a single data point by (seriesIndex, categoryIndex) in AUTHORING space. `exploded` pulls a pie slice out.",
    body: '"dataPointOverrides": [\n  { "seriesIndex": ${1:0}, "categoryIndex": ${2:0}, "color": "${3:#E15759}" }\n]',
  },
  {
    label: "data labels",
    detail: "Show values on the marks",
    documentation: "Show labels on data points. `content` can include \"value\", \"category\", \"seriesName\", or \"percent\".",
    body: '"dataLabels": { "enabled": true, "content": ["${1|value,category,seriesName,percent|}"], "position": "${2|auto,above,center,below|}" }',
  },
  {
    label: "data table",
    detail: "Tabular values below the plot",
    documentation: "Show a data table below the plot area with the series values and (optionally) legend color keys.",
    body: '"dataTable": { "enabled": true, "showLegendKeys": ${1|true,false|} }',
  },
];
