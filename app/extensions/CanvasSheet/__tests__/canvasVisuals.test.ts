//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasVisuals.test.ts
// PURPOSE: The Visuals catalogue (CONTRACT-CANVAS section 2): every visual the
//          contract names is offered, in Power BI's order, under its heading,
//          with the picture the icon lanes drew for it, and each one asks the
//          OWNING family for the right thing -- a chart preset the Charts lane
//          named, the Table preset the Pivot dialog takes, a slicer, a timeline.
//          The two band rows are Power BI's first two pane rows.

import { describe, it, expect, vi, beforeEach } from "vitest";

const insertOnCanvas = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../lib/insertOnCanvas", () => ({
  insertOnCanvas: (...a: unknown[]) => insertOnCanvas(...a),
}));

import { RibbonIcon } from "@api/ribbonIcons";
import { TABLE_VISUAL_PIVOT_PRESET } from "@api/pivotPresets";
import {
  CANVAS_VISUALS,
  CANVAS_VISUAL_GROUPS,
  CANVAS_VISUAL_ROWS,
  canvasVisual,
  insertCanvasVisual,
  type CanvasVisualId,
} from "../lib/canvasVisuals";

beforeEach(() => insertOnCanvas.mockClear());

/** CONTRACT-CANVAS section 2, in its order. */
const CONTRACT_IDS: readonly CanvasVisualId[] = [
  "stackedBar", "stackedColumn", "clusteredBar", "clusteredColumn", "stackedBar100", "stackedColumn100",
  "line", "area", "stackedArea", "stackedArea100", "lineStackedColumn", "lineClusteredColumn",
  "waterfall", "funnel", "scatter", "pie", "donut", "treemap", "gauge",
  "card", "multiRowCard", "kpi",
  "matrix", "table", "slicer", "timeline",
  "radar", "bubble", "histogram", "stock", "boxPlot", "sunburst", "pareto",
];

describe("the catalogue", () => {
  it("offers every visual of the contract, once, in its order", () => {
    expect(CANVAS_VISUALS.map((v) => v.id)).toEqual(CONTRACT_IDS);
  });

  it("groups them under the contract's headings, each heading once and in order", () => {
    const seen: string[] = [];
    for (const v of CANVAS_VISUALS) if (seen[seen.length - 1] !== v.group) seen.push(v.group);
    expect(seen).toEqual([...CANVAS_VISUAL_GROUPS]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("the two band rows are Power BI's first two pane rows", () => {
    expect(CANVAS_VISUAL_ROWS).toEqual([
      ["stackedBar", "stackedColumn", "clusteredBar", "clusteredColumn", "line", "lineClusteredColumn"],
      ["pie", "donut", "matrix", "card", "kpi", "slicer"],
    ]);
  });

  it("each visual draws a real RibbonIcon, and no two visuals share one", () => {
    const keys = CANVAS_VISUALS.map((v) => v.icon);
    for (const k of keys) expect(RibbonIcon[k], `${k} is not a RibbonIcon key`).toBeDefined();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses the icon lanes' pictures for the new variants and visuals", () => {
    const icon = (id: CanvasVisualId) => canvasVisual(id).icon;
    expect(icon("stackedBar")).toBe("ChartBarStacked");
    expect(icon("stackedColumn")).toBe("Stacked");
    expect(icon("clusteredBar")).toBe("ChartBar");
    expect(icon("clusteredColumn")).toBe("ChartColumn");
    expect(icon("stackedBar100")).toBe("ChartBarStacked100");
    expect(icon("stackedColumn100")).toBe("Stacked100");
    expect(icon("stackedArea")).toBe("ChartAreaStacked");
    expect(icon("stackedArea100")).toBe("ChartAreaStacked100");
    expect(icon("lineStackedColumn")).toBe("ChartComboStacked");
    expect(icon("lineClusteredColumn")).toBe("ChartCombo");
    expect(icon("card")).toBe("ChartCard");
    expect(icon("multiRowCard")).toBe("ChartMultiRowCard");
    expect(icon("kpi")).toBe("ChartKpi");
    expect(icon("gauge")).toBe("ChartGauge");
    expect(icon("matrix")).toBe("Matrix");
    expect(icon("table")).toBe("Table");
  });

  it("no visual is labelled exactly 'Canvas' (the E2E helpers find the tab by that word)", () => {
    for (const v of CANVAS_VISUALS) expect(v.label).not.toBe("Canvas");
  });
});

describe("what each visual asks its owner for", () => {
  // The Charts lane's preset table (reports-canvas/charts.md, "For other
  // lanes"). Clustered presets write stackMode "none" EXPLICITLY: the chart
  // store deep-merges, so leaving it out would let a later type switch carry
  // an old "stacked" along.
  const CHART_PRESETS: ReadonlyArray<[CanvasVisualId, string, Record<string, unknown> | undefined]> = [
    ["stackedBar", "horizontalBar", { stackMode: "stacked" }],
    ["stackedColumn", "bar", { stackMode: "stacked" }],
    ["clusteredBar", "horizontalBar", { stackMode: "none" }],
    ["clusteredColumn", "bar", { stackMode: "none" }],
    ["stackedBar100", "horizontalBar", { stackMode: "percentStacked" }],
    ["stackedColumn100", "bar", { stackMode: "percentStacked" }],
    ["line", "line", undefined],
    ["area", "area", undefined],
    ["stackedArea", "area", { stackMode: "stacked", stacked: true }],
    ["stackedArea100", "area", { stackMode: "percentStacked", stacked: true }],
    ["lineStackedColumn", "combo", { stackMode: "stacked" }],
    ["lineClusteredColumn", "combo", { stackMode: "none" }],
    ["waterfall", "waterfall", undefined],
    ["funnel", "funnel", undefined],
    ["scatter", "scatter", undefined],
    ["pie", "pie", undefined],
    ["donut", "donut", undefined],
    ["treemap", "treemap", undefined],
    ["gauge", "gauge", undefined],
    ["card", "card", undefined],
    ["multiRowCard", "multiRowCard", undefined],
    ["kpi", "kpi", undefined],
    ["radar", "radar", undefined],
    ["bubble", "bubble", undefined],
    ["histogram", "histogram", undefined],
    ["stock", "stock", undefined],
    ["boxPlot", "boxPlot", undefined],
    ["sunburst", "sunburst", undefined],
    ["pareto", "pareto", undefined],
  ];

  it.each(CHART_PRESETS)("%s: the chart dialog, preset to %s %j", async (id, mark, markOptions) => {
    await insertCanvasVisual(id);
    expect(insertOnCanvas).toHaveBeenCalledTimes(1);
    const [kind, options] = insertOnCanvas.mock.calls[0] as [string, Record<string, unknown>];
    expect(kind).toBe("chart");
    expect(options.mark).toBe(mark);
    if (markOptions) expect(options.markOptions).toEqual(markOptions);
    else expect(options.markOptions).toBeUndefined();
  });

  it("each insert hands over its OWN copy of the options (a dialog that edits them cannot change the catalogue)", async () => {
    await insertCanvasVisual("stackedColumn");
    const first = (insertOnCanvas.mock.calls[0][1] as { markOptions: Record<string, unknown> }).markOptions;
    first.stackMode = "none";
    await insertCanvasVisual("stackedColumn");
    expect((insertOnCanvas.mock.calls[1][1] as { markOptions: Record<string, unknown> }).markOptions).toEqual({
      stackMode: "stacked",
    });
  });

  it("matrix: a PivotTable (no preset); table: a PivotTable with the Table preset", async () => {
    await insertCanvasVisual("matrix");
    await insertCanvasVisual("table");
    expect(insertOnCanvas.mock.calls[0]).toEqual(["pivot", {}]);
    expect(insertOnCanvas.mock.calls[1]).toEqual(["pivot", { preset: TABLE_VISUAL_PIVOT_PRESET }]);
  });

  it("slicer and timeline: their own inserts", async () => {
    await insertCanvasVisual("slicer");
    await insertCanvasVisual("timeline");
    expect(insertOnCanvas.mock.calls.map((c) => c[0])).toEqual(["slicer", "timeline"]);
  });
});
