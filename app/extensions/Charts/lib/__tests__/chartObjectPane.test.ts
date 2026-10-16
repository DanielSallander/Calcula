//! FILENAME: app/extensions/Charts/lib/__tests__/chartObjectPane.test.ts
// PURPOSE: The chart's @api/objectPane provider (WP-C S9a, D-PANE): the build
//          tabs follow the DATA SOURCE (design query: Fields | Design; cell
//          range and PivotTable: Data), a press lands on the data, a command on
//          Format, the header names the chart, and a format door publishes the
//          ladder's rung first (`beforeShowFormat`). Plus the context menu's
//          "Edit data..." target tab.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OBJECT_PANE_FORMAT_TAB, objectPaneMenuEntry, registerObjectPaneHost, registerObjectPaneProvider, resetObjectPane } from "@api/objectPane";
import type { GridRegion } from "@api/gridOverlays";
import {
  CHART_PANE_TAB_DATA,
  CHART_PANE_TAB_DESIGN,
  CHART_PANE_TAB_FIELDS,
  chartEditDataTab,
  chartPaneSourceKind,
  chartPaneTabIds,
  createChartObjectPaneProvider,
} from "../chartObjectPane";
import type { ChartDefinition, ChartSpec } from "../../types";
import { ChartDesignQueryBuild } from "../../components/pane/ChartDesignQueryBuild";

const range = { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 1 };
const designQuery = { type: "designQuery", dslText: "VALUES: [Sales]", connectionId: "1" };
const pivot = { type: "pivot", pivotId: "p1" };

function def(data: unknown, chartId = "c1"): ChartDefinition {
  return {
    chartId,
    name: "Sales by Region",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    spec: { mark: "bar", data, title: null } as unknown as ChartSpec,
  };
}

function region(chartId = "c1"): GridRegion {
  return {
    id: `chart-${chartId}`,
    type: "chart",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: 200, height: 120 },
    data: { chartId },
  };
}

let current: ChartDefinition | null = null;
const publish = vi.fn();
const openDataEditor = vi.fn();
const provider = createChartObjectPaneProvider({
  getChart: (id) => (current && current.chartId === id ? current : null),
  publishSelection: publish,
  openDataEditor,
});

beforeEach(() => {
  resetObjectPane();
  publish.mockClear();
  openDataEditor.mockClear();
});

describe("the tab set follows the data source (D-PANE)", () => {
  it("design query -> Fields | Design; range -> Data; PivotTable -> Data", () => {
    for (const [data, ids, kind] of [
      [designQuery, [CHART_PANE_TAB_FIELDS, CHART_PANE_TAB_DESIGN], "designQuery"],
      [range, [CHART_PANE_TAB_DATA], "range"],
      ["Sheet1!A1:B4", [CHART_PANE_TAB_DATA], "range"],
      [pivot, [CHART_PANE_TAB_DATA], "pivot"],
    ] as const) {
      current = def(data);
      expect(provider.tabs(region()).map((t) => t.id)).toEqual(ids);
      expect(chartPaneTabIds(current.spec)).toEqual(ids);
      expect(chartPaneSourceKind(current.spec.data)).toBe(kind);
    }
  });

  it("never offers Format itself (the host adds it), and a missing chart offers nothing", () => {
    current = def(designQuery);
    expect(provider.tabs(region()).some((t) => t.id === OBJECT_PANE_FORMAT_TAB)).toBe(false);
    current = null;
    expect(provider.tabs(region())).toEqual([]);
  });

  it("every build tab renders the SAME component type (one instance across the tabs)", () => {
    current = def(designQuery);
    const ctx = { region: region(), readOnly: false, readOnlyReason: null, activeTabId: "fields" };
    const [a, b] = provider.tabs(region()).map((t) => t.render(ctx) as { type: unknown });
    expect(a.type).toBe(b.type);
  });

  it("a design query's Fields and Design are the S9b build body, ONE keyed instance (not the placeholder)", () => {
    current = def(designQuery);
    const ctx = { region: region(), readOnly: false, readOnlyReason: null, activeTabId: "design" };
    const [a, b] = provider.tabs(region()).map((t) => t.render(ctx) as { type: unknown; key: unknown });
    expect(a.type).toBe(ChartDesignQueryBuild);
    expect(b.type).toBe(ChartDesignQueryBuild);
    expect(a.key).toBe(b.key);
    expect(a.key).toBe("design-query-c1");
  });

  it("\"Edit data...\" targets Fields for a design query, Data otherwise", () => {
    expect(chartEditDataTab(def(designQuery).spec)).toBe(CHART_PANE_TAB_FIELDS);
    expect(chartEditDataTab(def(range).spec)).toBe(CHART_PANE_TAB_DATA);
    expect(chartEditDataTab(def(pivot).spec)).toBe(CHART_PANE_TAB_DATA);
  });
});

describe("where an open lands, and what the header says", () => {
  it("a press or follow lands on the data; a command without a tab lands on Format", () => {
    current = def(designQuery);
    expect(provider.defaultTab!(region(), "press")).toBe(CHART_PANE_TAB_FIELDS);
    expect(provider.defaultTab!(region(), "follow")).toBe(CHART_PANE_TAB_FIELDS);
    expect(provider.defaultTab!(region(), "command")).toBe(OBJECT_PANE_FORMAT_TAB);
    current = def(range);
    expect(provider.defaultTab!(region(), "press")).toBe(CHART_PANE_TAB_DATA);
  });

  it("the header names the chart", () => {
    current = def(range);
    expect(provider.headerOf!(region())).toBe("Chart - Sales by Region");
  });

  it("a format door publishes the ladder's rung first", () => {
    current = def(range);
    provider.beforeShowFormat!(region());
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("the context menu rows", () => {
  it("Format... and Edit data... are live once the pane can open; Edit data names the chart's own tab", () => {
    current = def(designQuery);
    const opened: unknown[] = [];
    registerObjectPaneProvider(provider);
    registerObjectPaneHost({
      open: (req) => {
        opened.push(req);
        return true;
      },
      close: () => {},
      state: () => ({ open: false, regionId: null, regionType: null, tabId: null }),
    });
    const format = objectPaneMenuEntry(region());
    expect(format.disabled).toBe(false);
    const edit = objectPaneMenuEntry(region(), chartEditDataTab(current.spec));
    expect(edit.disabled).toBe(false);
    edit.run();
    expect(opened).toEqual([{ region: region(), tab: CHART_PANE_TAB_FIELDS, reason: "command" }]);
    // A range chart has no Fields tab: that row would be disabled, which is
    // why the menu asks chartEditDataTab rather than naming a tab itself.
    current = def(range);
    expect(objectPaneMenuEntry(region(), CHART_PANE_TAB_FIELDS).disabled).toBe(true);
  });
});
