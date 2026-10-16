//! FILENAME: app/extensions/Charts/lib/__tests__/chartDataTabRouting.test.ts
// PURPOSE: The chart's Data tab in the object pane (WP-C S9c) renders the
//          range editor for a cell-range or defined-name source, the PivotTable
//          tab for a pivot source, and nothing of its own for a design query
//          (Fields / Design are S9b's) -- keyed by the chart, so a retarget to
//          another chart never reuses the previous chart's typed text.

import { describe, it, expect } from "vitest";
import type React from "react";
import { createChartObjectPaneProvider, renderChartDataTab } from "../chartObjectPane";
import { ChartRangeDataTab } from "../../components/pane/ChartRangeDataTab";
import { ChartPivotDataTab } from "../../components/pane/ChartPivotDataTab";
import type { ChartDefinition, ChartSpec } from "../../types";
import type { ObjectPaneTabContext } from "@api/objectPane";

function chart(chartId: string, data: unknown): ChartDefinition {
  return {
    chartId,
    name: `Chart ${chartId}`,
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    spec: { mark: "bar", data, series: [] } as unknown as ChartSpec,
  } as ChartDefinition;
}

const ctx: ObjectPaneTabContext = {
  region: { id: "chart-c1", type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x: 0, y: 0, width: 300, height: 200 }, data: { chartId: "c1" } },
  readOnly: false,
  readOnlyReason: null,
  activeTabId: "data",
};

const deps = { getChart: () => null, openDataEditor: () => {} };

describe("renderChartDataTab", () => {
  it("a range (or a defined name) gets the range editor, keyed by the chart", () => {
    const el = renderChartDataTab(ctx, "c1", chart("c1", { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 1 }), deps) as React.ReactElement;
    expect(el.type).toBe(ChartRangeDataTab);
    expect(el.key).toBe("range-c1");
    const named = renderChartDataTab(ctx, "c2", chart("c2", "TotalSales"), deps) as React.ReactElement;
    expect(named.type).toBe(ChartRangeDataTab);
    expect(named.key).toBe("range-c2");
  });

  it("a PivotTable source gets the PivotTable tab", () => {
    const el = renderChartDataTab(ctx, "c1", chart("c1", { type: "pivot", pivotId: "p-1" }), deps) as React.ReactElement;
    expect(el.type).toBe(ChartPivotDataTab);
    expect(el.key).toBe("pivot-c1");
  });

  it("a design query is not this tab's (null)", () => {
    expect(renderChartDataTab(ctx, "c1", chart("c1", { type: "designQuery", dslText: "VALUES: [x]", connectionId: "1" }), deps)).toBeNull();
    expect(renderChartDataTab(ctx, "c1", null, deps)).toBeNull();
  });

  it("the provider's Data tab renders it", () => {
    const c = chart("c1", { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 1 });
    const provider = createChartObjectPaneProvider({
      getChart: (id) => (id === "c1" ? c : null),
      publishSelection: () => {},
      openDataEditor: () => {},
    });
    const tabs = provider.tabs(ctx.region);
    expect(tabs.map((t) => t.id)).toEqual(["data"]);
    const el = tabs[0].render(ctx) as React.ReactElement;
    expect(el.type).toBe(ChartRangeDataTab);
  });
});
