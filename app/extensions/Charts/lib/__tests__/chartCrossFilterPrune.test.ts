//! FILENAME: app/extensions/Charts/lib/__tests__/chartCrossFilterPrune.test.ts
// PURPOSE: A chart removed by any route other than the Delete command (undo
//          of its creation, a script/MCP/AI removal, a sheet delete) takes its
//          cross-filter selection with it (DECISIONS2 P4). Those routes reach
//          the frontend as the "objects" store reload, so:
//            - pruneVanishedChartSelections clears the selection of every chart
//              the store no longer holds, over the REAL @api/reportFilters seam;
//            - reloadCharts (index.ts) calls it after every store swap.
// CONTEXT: Before this, reloadCharts swapped the store and cleared point
//          selections, widget values and cues, but never the cross-filter
//          selection: the page stayed filtered and the pivot box beside it
//          refused every gesture "Filtered by Chart A" with Chart A gone.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const h = vi.hoisted(() => ({ charts: [] as Array<{ chartId: string }> }));

vi.mock("../chartStore", () => ({ getAllCharts: () => h.charts.map((c) => ({ ...c })) }));

import { clearCrossFilters, getCrossFilters, setCrossFilter } from "@api/reportFilters";
import { pruneVanishedChartSelections } from "../chartCrossFilterPrune";

function chartSelection(id: string) {
  return {
    source: { kind: "chart" as const, id },
    sourceName: `Chart ${id}`,
    pageSheetId: "sheet-2",
    connectionId: "conn-1",
    fields: ["Geo.Region"],
    tuples: [["East"]],
  };
}

beforeEach(() => {
  clearCrossFilters();
});

describe("a chart that vanished from the store", () => {
  it("loses its cross-filter selection; a chart still there keeps its own", () => {
    setCrossFilter(chartSelection("A"));
    setCrossFilter(chartSelection("B"));
    // Ctrl+Z undid A's creation: the reload swapped A out of the store.
    h.charts = [{ chartId: "B" }];
    pruneVanishedChartSelections();
    expect(getCrossFilters().map((s) => s.source.id), "the page is still filtered by a chart that is gone").toEqual([
      "B",
    ]);
  });
});

describe("reloadCharts prunes after every store swap", () => {
  it("calls pruneVanishedChartSelections between the reload and the repaint", () => {
    const source = readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8").split("\r\n").join("\n");
    const start = source.indexOf("const reloadCharts = async (req: ChartReloadRequest) => {");
    expect(start, "test out of date: reloadCharts moved").toBeGreaterThan(-1);
    const end = source.indexOf("syncChartRegions();", start);
    const body = source
      .slice(start, end)
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    const load = body.indexOf("await loadChartsFromBackend();");
    const prune = body.indexOf("pruneVanishedChartSelections();");
    expect(prune, "reloadCharts never clears a vanished chart's cross-filter selection").toBeGreaterThan(-1);
    expect(prune, "the prune must run AFTER the store swap").toBeGreaterThan(load);
  });
});
