//! FILENAME: app/extensions/CanvasSheet/lib/canvasVisuals.ts
// PURPOSE: The VISUALS catalogue of the Canvas tab (CONTRACT-CANVAS section 2):
//          every visual a report page can hold, in Power BI's Visualizations
//          pane order, each with its picture, its heading in the All Visuals
//          gallery, and what it asks the OWNING family for.
// CONTEXT: Pure data plus one dispatcher. The band's two rows, the All Visuals
//          card and the sidebar gallery all read THIS list, so a visual can
//          never be offered in one place and missing (or differently preset)
//          in another.
//
//          WHAT A VISUAL IS. Not a new object kind: every chart-like visual is
//          a Charts MARK with options (Card, KPI, Gauge... are built-in marks
//          since 2026-10-08), the Matrix is a PivotTable, the Table is a
//          PivotTable in the Table preset (@api/pivotPresets), and Slicer and
//          Timeline are their own families. So inserting a visual is an
//          `insertOnCanvas` call with the preset below, and the canvas, the
//          selection, undo, persistence and scripts come with each family.
//
//          THE PRESETS are the Charts lane's table (reports-canvas/charts.md):
//          clustered presets write `stackMode: "none"` EXPLICITLY, because the
//          chart store deep-merges a spec update -- a missing key would let a
//          later type switch carry an old "stacked" along. The stacked area
//          presets also set the legacy `stacked` flag the area painter still
//          reads beside the stack mode.
//
//          LEFT OUT on purpose (owner decision 0.3): maps, Q&A, Key influencers,
//          Decomposition tree, Smart narrative, Metrics, Paginated report,
//          R/Python visuals, Power Apps/Automate, the Ribbon chart and the
//          Text slicer -- none is shown, none is shown disabled.

import type { RibbonIconKey } from "@api/ribbonIcons";
import { TABLE_VISUAL_PIVOT_PRESET, type PivotCreatePreset } from "@api/pivotPresets";
import { insertOnCanvas } from "./insertOnCanvas";

/** Every visual's id (the `canvas-visual-<id>` test-id suffix). */
export type CanvasVisualId =
  | "stackedBar"
  | "stackedColumn"
  | "clusteredBar"
  | "clusteredColumn"
  | "stackedBar100"
  | "stackedColumn100"
  | "line"
  | "area"
  | "stackedArea"
  | "stackedArea100"
  | "lineStackedColumn"
  | "lineClusteredColumn"
  | "waterfall"
  | "funnel"
  | "scatter"
  | "pie"
  | "donut"
  | "treemap"
  | "gauge"
  | "card"
  | "multiRowCard"
  | "kpi"
  | "matrix"
  | "table"
  | "slicer"
  | "timeline"
  | "radar"
  | "bubble"
  | "histogram"
  | "stock"
  | "boxPlot"
  | "sunburst"
  | "pareto";

/** What inserting a visual asks for. */
export type CanvasVisualInsert =
  | { kind: "chart"; mark: string; markOptions?: Readonly<Record<string, unknown>> }
  | { kind: "pivot"; preset?: PivotCreatePreset }
  | { kind: "slicer" }
  | { kind: "timeline" };

export interface CanvasVisual {
  id: CanvasVisualId;
  /** Power BI's name for it -- the tooltip, the aria-label, the tile's name. */
  label: string;
  /** The All Visuals heading it is listed under (one of CANVAS_VISUAL_GROUPS). */
  group: CanvasVisualGroup;
  /** Its picture (the icon lanes' keys, ICONS.md section 4). */
  icon: RibbonIconKey;
  insert: CanvasVisualInsert;
}

/** The All Visuals headings, in order (contract section 2). */
export const CANVAS_VISUAL_GROUPS = [
  "Bar & column",
  "Line & area",
  "Other charts",
  "Cards",
  "Tables & filters",
  "More charts",
] as const;

export type CanvasVisualGroup = (typeof CANVAS_VISUAL_GROUPS)[number];

const chart = (mark: string, markOptions?: Record<string, unknown>): CanvasVisualInsert =>
  markOptions ? { kind: "chart", mark, markOptions: Object.freeze({ ...markOptions }) } : { kind: "chart", mark };

/** The catalogue, in Power BI's pane order (contract section 2). */
export const CANVAS_VISUALS: readonly CanvasVisual[] = Object.freeze([
  // Bar & column -- Power BI's first pane row.
  { id: "stackedBar", label: "Stacked bar chart", group: "Bar & column", icon: "ChartBarStacked", insert: chart("horizontalBar", { stackMode: "stacked" }) },
  { id: "stackedColumn", label: "Stacked column chart", group: "Bar & column", icon: "Stacked", insert: chart("bar", { stackMode: "stacked" }) },
  { id: "clusteredBar", label: "Clustered bar chart", group: "Bar & column", icon: "ChartBar", insert: chart("horizontalBar", { stackMode: "none" }) },
  { id: "clusteredColumn", label: "Clustered column chart", group: "Bar & column", icon: "ChartColumn", insert: chart("bar", { stackMode: "none" }) },
  { id: "stackedBar100", label: "100% stacked bar chart", group: "Bar & column", icon: "ChartBarStacked100", insert: chart("horizontalBar", { stackMode: "percentStacked" }) },
  { id: "stackedColumn100", label: "100% stacked column chart", group: "Bar & column", icon: "Stacked100", insert: chart("bar", { stackMode: "percentStacked" }) },
  // Line & area -- the second pane row.
  { id: "line", label: "Line chart", group: "Line & area", icon: "ChartLine", insert: chart("line") },
  { id: "area", label: "Area chart", group: "Line & area", icon: "ChartArea", insert: chart("area") },
  { id: "stackedArea", label: "Stacked area chart", group: "Line & area", icon: "ChartAreaStacked", insert: chart("area", { stackMode: "stacked", stacked: true }) },
  { id: "stackedArea100", label: "100% stacked area chart", group: "Line & area", icon: "ChartAreaStacked100", insert: chart("area", { stackMode: "percentStacked", stacked: true }) },
  { id: "lineStackedColumn", label: "Line and stacked column chart", group: "Line & area", icon: "ChartComboStacked", insert: chart("combo", { stackMode: "stacked" }) },
  { id: "lineClusteredColumn", label: "Line and clustered column chart", group: "Line & area", icon: "ChartCombo", insert: chart("combo", { stackMode: "none" }) },
  // Other charts.
  { id: "waterfall", label: "Waterfall chart", group: "Other charts", icon: "ChartWaterfall", insert: chart("waterfall") },
  { id: "funnel", label: "Funnel", group: "Other charts", icon: "ChartFunnel", insert: chart("funnel") },
  { id: "scatter", label: "Scatter chart", group: "Other charts", icon: "ChartScatter", insert: chart("scatter") },
  { id: "pie", label: "Pie chart", group: "Other charts", icon: "ChartPie", insert: chart("pie") },
  { id: "donut", label: "Donut chart", group: "Other charts", icon: "ChartDonut", insert: chart("donut") },
  { id: "treemap", label: "Treemap", group: "Other charts", icon: "ChartTreemap", insert: chart("treemap") },
  { id: "gauge", label: "Gauge", group: "Other charts", icon: "ChartGauge", insert: chart("gauge") },
  // Cards.
  { id: "card", label: "Card", group: "Cards", icon: "ChartCard", insert: chart("card") },
  { id: "multiRowCard", label: "Multi-row card", group: "Cards", icon: "ChartMultiRowCard", insert: chart("multiRowCard") },
  { id: "kpi", label: "KPI", group: "Cards", icon: "ChartKpi", insert: chart("kpi") },
  // Tables & filters.
  { id: "matrix", label: "Matrix", group: "Tables & filters", icon: "Matrix", insert: { kind: "pivot" } },
  { id: "table", label: "Table", group: "Tables & filters", icon: "Table", insert: { kind: "pivot", preset: TABLE_VISUAL_PIVOT_PRESET } },
  { id: "slicer", label: "Slicer", group: "Tables & filters", icon: "Slicer", insert: { kind: "slicer" } },
  { id: "timeline", label: "Timeline", group: "Tables & filters", icon: "Timeline", insert: { kind: "timeline" } },
  // Calcula's own charts, which Power BI has no visual for.
  { id: "radar", label: "Radar chart", group: "More charts", icon: "ChartRadar", insert: chart("radar") },
  { id: "bubble", label: "Bubble chart", group: "More charts", icon: "ChartBubble", insert: chart("bubble") },
  { id: "histogram", label: "Histogram", group: "More charts", icon: "ChartHistogram", insert: chart("histogram") },
  { id: "stock", label: "Stock chart", group: "More charts", icon: "ChartStock", insert: chart("stock") },
  { id: "boxPlot", label: "Box & Whisker", group: "More charts", icon: "ChartBoxPlot", insert: chart("boxPlot") },
  { id: "sunburst", label: "Sunburst", group: "More charts", icon: "ChartSunburst", insert: chart("sunburst") },
  { id: "pareto", label: "Pareto", group: "More charts", icon: "ChartPareto", insert: chart("pareto") },
] satisfies CanvasVisual[]);

/** The band's two rows: Power BI's pane rows 1 and 2, as the contract names them. */
export const CANVAS_VISUAL_ROWS: readonly (readonly CanvasVisualId[])[] = [
  ["stackedBar", "stackedColumn", "clusteredBar", "clusteredColumn", "line", "lineClusteredColumn"],
  ["pie", "donut", "matrix", "card", "kpi", "slicer"],
];

/**
 * A band row button's test id: `canvas-visual-<id>`, except the two rows that
 * ARE the old Insert heroes and keep their ids -- Matrix (`canvas-insert-pivot`)
 * and Slicer (`canvas-insert-slicer`), which live E2E specs press.
 */
export function visualRowTestId(id: CanvasVisualId): string {
  if (id === "matrix") return "canvas-insert-pivot";
  if (id === "slicer") return "canvas-insert-slicer";
  return `canvas-visual-${id}`;
}

/**
 * The All Visuals gallery's test id, and the prefix of its tiles
 * (`canvas-visual-gallery-<id>`, Chart Design's "chart-type-gallery"
 * precedent): a row and its tile never share an id while the card is open.
 */
export const VISUAL_GALLERY_TEST_ID = "canvas-visual-gallery";

const BY_ID = new Map(CANVAS_VISUALS.map((v) => [v.id, v]));

/** The visual with this id (a programming error to ask for another). */
export function canvasVisual(id: CanvasVisualId): CanvasVisual {
  const v = BY_ID.get(id);
  if (!v) throw new Error(`no canvas visual "${id}"`);
  return v;
}

/** Insert one visual on the active canvas, through its owner (see the header). */
export async function insertCanvasVisual(id: CanvasVisualId): Promise<void> {
  const { insert } = canvasVisual(id);
  switch (insert.kind) {
    case "chart":
      await insertOnCanvas("chart", {
        mark: insert.mark,
        ...(insert.markOptions ? { markOptions: { ...insert.markOptions } } : {}),
      });
      return;
    case "pivot":
      await insertOnCanvas("pivot", insert.preset ? { preset: insert.preset } : {});
      return;
    case "slicer":
      await insertOnCanvas("slicer");
      return;
    case "timeline":
      await insertOnCanvas("timeline");
      return;
  }
}
