//! FILENAME: app/extensions/Charts/components/__tests__/ChartContextMenu.test.tsx
// PURPOSE: The chart context menu acts on the element that was RIGHT-clicked,
//          and says which rung of the ladder that element is on.
// CONTEXT: The filed defect (open-items.md, "Right-click does not move the
//          chart's selection") is that every item acted on the LEFT-click
//          selection: right-clicking bar B while bar A was selected formatted
//          A. The menu no longer consults the selection at all — its subject is
//          the record `@api/chartData` holds for the right-click that opened it
//          — so the proof is that the dialog it opens carries the RIGHT-CLICKED
//          datum's indices, and that a record belonging to another chart is
//          refused rather than used.
//
//          The second thing under test is the teaching signal: singular on a
//          point, plural on a series. It is the clearest cue the UI gives about
//          which rung the reader is on, so it is pinned rather than eyeballed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// React 18+ only honours `act` when the environment declares itself an act
// environment; without it every render logs a warning that buries a real one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { ChartSpec, DataPointOverride } from "../../types";

// ----------------------------------------------------------------------------
// Doubles. Everything outside the menu is stubbed so each test states one chart
// spec and one recorded right-click and nothing else can influence the result.
// ----------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  getChartById: vi.fn(),
  updateChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
  invalidateChartCache: vi.fn(),
  showDialog: vi.fn(),
  emitAppEvent: vi.fn(),
}));

vi.mock("@api", () => ({ showDialog: h.showDialog }));
vi.mock("@api/events", () => ({
  emitAppEvent: h.emitAppEvent,
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
}));
vi.mock("../../lib/chartStore", () => ({
  getChartById: h.getChartById,
  updateChartSpec: h.updateChartSpec,
  syncChartRegions: h.syncChartRegions,
}));
vi.mock("../../rendering/chartRenderer", () => ({
  invalidateChartCache: h.invalidateChartCache,
}));
vi.mock("../../manifest", () => ({ CHART_DIALOG_ID: "chart:createDialog" }));

import {
  ChartContextMenu,
  subjectFor,
  resetToMatchStylePatch,
  dataLabelRow,
  type MenuSubject,
} from "../ChartContextMenu";
import {
  CHART_TARGET_ELEMENTS,
  setChartRightClickTarget,
  getChartRightClickTarget,
  type ChartRightClickTarget,
  type ChartTargetElement,
} from "@api/chartData";
import {
  registerChartContextMenuContribution,
  resetChartContextMenuContributions,
} from "@api/chartContextMenu";
import { CHART_ELEMENT_IDS, DATA_POINT_KEY_SEPARATOR, type ChartElementId } from "../../types";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

function baseSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    title: "Monthly revenue",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Revenue", sourceIndex: 1, color: null },
      { name: "Cost", sourceIndex: 2, color: null },
    ],
    xAxis: {},
    yAxis: {},
    legend: { visible: true, position: "right" },
    palette: "default",
    ...overrides,
  } as ChartSpec;
}

function chartWith(spec: ChartSpec) {
  return { chartId: "chart-1", name: "Chart 1", sheetIndex: 0, spec };
}

/** A right-click on the SECOND series' THIRD point — "bar B". */
function barB(over: Partial<ChartRightClickTarget> = {}): ChartRightClickTarget {
  return {
    chartId: "chart-1",
    element: "datum",
    seriesIndex: 1,
    pointIndex: 2,
    seriesName: "Cost",
    categoryName: "Mar",
    value: 42,
    ...over,
  };
}

// ----------------------------------------------------------------------------
// Rendering harness
// ----------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root | null = null;
const closes: number[] = [];
const order: string[] = [];

async function render(data?: Record<string, unknown>): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(ChartContextMenu, {
        onClose: () => {
          closes.push(order.length);
          order.push("close");
        },
        data: data ?? { chartId: "chart-1", screenX: 10, screenY: 10 },
      }),
    );
  });
}

function itemIds(): string[] {
  return [...container.querySelectorAll("[data-chart-menu-item]")].map(
    (el) => el.getAttribute("data-chart-menu-item")!,
  );
}

function labelOf(id: string): string | null {
  const el = container.querySelector(`[data-chart-menu-item="${id}"]`);
  return el ? el.textContent : null;
}

async function click(id: string): Promise<void> {
  const el = container.querySelector(`[data-chart-menu-item="${id}"]`);
  if (!el) throw new Error(`No menu item "${id}". Present: ${itemIds().join(", ")}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  closes.length = 0;
  order.length = 0;
  resetChartContextMenuContributions();
  setChartRightClickTarget(null);
  h.getChartById.mockReturnValue(chartWith(baseSpec()));
});

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = null;
  }
  container?.remove();
  resetChartContextMenuContributions();
  setChartRightClickTarget(null);
});

// ============================================================================
// The taxonomy copy in @api is pinned to the extension's own list
// ============================================================================

describe("the @api element list", () => {
  it("is the same set as CHART_ELEMENT_IDS, in both directions", () => {
    // @api must never import from app/extensions, so `CHART_TARGET_ELEMENTS` is
    // a second spelling of `CHART_ELEMENT_IDS` by architectural necessity. This
    // is what stops it being a second SOURCE OF TRUTH: a member added to either
    // list alone fails here, naming which side is missing it.
    const api = new Set<string>(CHART_TARGET_ELEMENTS);
    const charts = new Set<string>(CHART_ELEMENT_IDS);
    expect([...charts].filter((e) => !api.has(e))).toEqual([]);
    expect([...api].filter((e) => !charts.has(e))).toEqual([]);
  });

  it("is assignable in both directions at compile time", () => {
    // A rename that kept the SET equal would still be caught here, because
    // these two assignments only compile while the unions are identical.
    const fromCharts: ChartTargetElement = "datum" as ChartElementId;
    const fromApi: ChartElementId = "datum" as ChartTargetElement;
    expect(fromCharts).toBe("datum");
    expect(fromApi).toBe("datum");
  });
});

// ============================================================================
// The defect: the menu's subject is the RIGHT-clicked element
// ============================================================================

describe("the right-clicked subject", () => {
  it("formats the bar that was right-clicked, not the one that was selected", async () => {
    // The left-click selection is deliberately absent from this test: the menu
    // never reads it. What it reads is the record the right-click wrote.
    setChartRightClickTarget(barB());
    await render();

    expect(labelOf("formatElement")).toBe("Format Data Point...");
    await click("formatElement");

    expect(h.showDialog).toHaveBeenCalledWith("chart:dataPointFormat", {
      chartId: "chart-1",
      seriesIndex: 1,
      categoryIndex: 2,
      categoryName: "Mar",
      isPieOrDonut: false,
    });
  });

  it("prefers the AUTHORING pair, because dataPointOverrides are keyed there", async () => {
    // Painter (post-filter) 1/2 is authoring 3/5 with a hidden series and two
    // hidden categories. Writing the painter pair would format a different bar.
    setChartRightClickTarget(barB({ authoring: { seriesIndex: 3, pointIndex: 5 } }));
    await render();
    await click("formatElement");

    expect(h.showDialog).toHaveBeenCalledWith(
      "chart:dataPointFormat",
      expect.objectContaining({ seriesIndex: 3, categoryIndex: 5 }),
    );
  });

  it("refuses a target recorded on a DIFFERENT chart", async () => {
    setChartRightClickTarget(barB({ chartId: "chart-2" }));
    await render();

    // Falls back to the object as a whole rather than formatting chart-1's bar
    // at chart-2's indices.
    expect(labelOf("formatElement")).toBe("Format Chart Area...");
    expect(getChartRightClickTarget("chart-1")).toBeNull();
    expect(getChartRightClickTarget("chart-2")).not.toBeNull();
  });

  it("falls back to the chart when no right-click was recorded", async () => {
    await render();
    expect(labelOf("formatElement")).toBe("Format Chart Area...");
    expect(container.querySelector("[data-chart-menu-subject]")).toBeNull();
  });

  it("names the subject in the menu so the reader can see what it will act on", async () => {
    setChartRightClickTarget(barB());
    await render();
    const subject = container.querySelector("[data-chart-menu-subject]");
    expect(subject?.getAttribute("data-chart-menu-subject")).toBe("datum");
    expect(subject?.textContent).toBe("Data Point: Cost — Mar");
  });
});

// ============================================================================
// Singular vs plural — the rung the reader is on
// ============================================================================

describe("singular vs plural", () => {
  it("offers point verbs on a POINT", async () => {
    setChartRightClickTarget(barB());
    await render();

    expect(labelOf("formatElement")).toBe("Format Data Point...");
    const ids = itemIds();
    expect(ids).not.toContain("addDataLabels");
    expect(ids).not.toContain("addTrendline");
  });

  it("offers series verbs on a SERIES", async () => {
    // A datum target with NO pointIndex is Excel's PointIndex = -1: the whole
    // series. That one absent field is what moves the menu up a rung.
    setChartRightClickTarget(barB({ pointIndex: undefined }));
    await render();

    expect(labelOf("formatElement")).toBe("Format Data Series...");
    expect(labelOf("addDataLabels")).toBe("Add Data Labels");
    expect(labelOf("addTrendline")).toBe("Add Trendline");
  });

  it("names the series, not the point, in the subject line", async () => {
    setChartRightClickTarget(barB({ pointIndex: undefined }));
    await render();
    expect(container.querySelector("[data-chart-menu-subject]")?.textContent).toBe(
      "Data Series: Cost",
    );
  });
});

// ============================================================================
// Shape: the shared block, then element verbs, then Format ... LAST
// ============================================================================

describe("menu shape", () => {
  it("opens with the shared block", async () => {
    setChartRightClickTarget(barB({ pointIndex: undefined }));
    await render();
    expect(itemIds().slice(0, 3)).toEqual(["deleteChart", "changeChartType", "selectData"]);
  });

  it("puts Format <element>... last, after the contributions", async () => {
    registerChartContextMenuContribution({
      id: "ai.explainChart",
      label: "Explain This Chart",
      onSelect: vi.fn(),
    });
    setChartRightClickTarget(barB());
    await render();

    const ids = itemIds();
    expect(ids[ids.length - 1]).toBe("formatElement");
    expect(ids[ids.length - 2]).toBe("contribution:ai.explainChart");
  });

  it("routes a non-datum element's Format to the chart dialog's design tab", async () => {
    setChartRightClickTarget({ chartId: "chart-1", element: "title" });
    await render();

    expect(labelOf("formatElement")).toBe("Format Chart Title...");
    await click("formatElement");
    expect(h.showDialog).toHaveBeenCalledWith("chart:createDialog", {
      editChartId: "chart-1",
      initialTab: "design",
    });
  });

  it("routes an axis Format to the Format Axis dialog with the axis it was on", async () => {
    setChartRightClickTarget({ chartId: "chart-1", element: "yAxis", axisType: "y" });
    await render();

    expect(labelOf("formatElement")).toBe("Format Vertical (Value) Axis...");
    await click("formatElement");
    expect(h.showDialog).toHaveBeenCalledWith("chart:formatAxisDialog", {
      chartId: "chart-1",
      axisType: "y",
    });
  });

  it("spells a legend ENTRY's Format as Excel does, on the legend", async () => {
    setChartRightClickTarget({
      chartId: "chart-1",
      element: "legendEntry",
      seriesIndex: 1,
      seriesName: "Cost",
    });
    await render();
    expect(labelOf("formatElement")).toBe("Format Legend...");
    expect(container.querySelector("[data-chart-menu-subject]")?.textContent).toBe(
      "Legend Entry: Cost",
    );
  });
});

// ============================================================================
// Element verbs
// ============================================================================

describe("element verbs", () => {
  it("deletes the TITLE, not the chart, from a title right-click", async () => {
    setChartRightClickTarget({ chartId: "chart-1", element: "title" });
    await render();

    await click("deleteTitle");
    expect(h.updateChartSpec).toHaveBeenCalledWith("chart-1", { title: null });
    // The full repaint choreography, or the chart keeps drawing the old title.
    expect(h.invalidateChartCache).toHaveBeenCalledWith("chart-1");
    expect(h.syncChartRegions).toHaveBeenCalled();
    expect(h.emitAppEvent).toHaveBeenCalledWith("app:grid-refresh");
  });

  it("does not offer Delete Title on a chart that has none", async () => {
    h.getChartById.mockReturnValue(chartWith(baseSpec({ title: null })));
    setChartRightClickTarget({ chartId: "chart-1", element: "title" });
    await render();
    expect(itemIds()).not.toContain("deleteTitle");
  });

  it("hides the legend from a legend right-click and not otherwise", async () => {
    setChartRightClickTarget({ chartId: "chart-1", element: "legend" });
    await render();
    await click("deleteLegend");
    expect(h.updateChartSpec).toHaveBeenCalledWith("chart-1", {
      legend: { visible: false, position: "right" },
    });
  });

  it("clears the axis title from an axis-title right-click", async () => {
    h.getChartById.mockReturnValue(chartWith(baseSpec({ xAxis: { title: "Month" } })));
    setChartRightClickTarget({ chartId: "chart-1", element: "xAxisTitle" });
    await render();
    await click("deleteAxisTitle");
    expect(h.updateChartSpec).toHaveBeenCalledWith("chart-1", { xAxis: { title: null } });
  });

  it("adds a linear trendline for the right-clicked series only", async () => {
    setChartRightClickTarget(barB({ pointIndex: undefined }));
    await render();
    await click("addTrendline");
    expect(h.updateChartSpec).toHaveBeenCalledWith("chart-1", {
      trendlines: [{ type: "linear", seriesIndex: 1 }],
    });
  });

  it("offers Remove Trendline once that series has one", async () => {
    h.getChartById.mockReturnValue(
      chartWith(baseSpec({ trendlines: [{ type: "linear", seriesIndex: 1 }] })),
    );
    setChartRightClickTarget(barB({ pointIndex: undefined }));
    await render();
    await click("removeTrendline");
    expect(h.updateChartSpec).toHaveBeenCalledWith("chart-1", { trendlines: undefined });
  });

  it("offers no trendline at all on a mark whose painter cannot draw one", async () => {
    h.getChartById.mockReturnValue(chartWith(baseSpec({ mark: "pie" })));
    setChartRightClickTarget(barB({ pointIndex: undefined }));
    await render();
    const ids = itemIds();
    expect(ids).not.toContain("addTrendline");
    expect(ids).not.toContain("removeTrendline");
  });
});

// ============================================================================
// Data labels (pure helper — every branch, including the one it refuses)
// ============================================================================

describe("dataLabelRow", () => {
  it("switches labels on for one series", () => {
    expect(dataLabelRow(baseSpec(), 1)).toEqual({
      id: "addDataLabels",
      label: "Add Data Labels",
      patch: { dataLabels: { enabled: true, seriesFilter: [1] } },
    });
  });

  it("adds to an existing filter rather than replacing it", () => {
    const spec = baseSpec({ dataLabels: { enabled: true, seriesFilter: [0] } });
    expect(dataLabelRow(spec, 1)?.patch.dataLabels?.seriesFilter).toEqual([0, 1]);
  });

  it("ignores a stale filter left on a DISABLED label spec", () => {
    // enabled:false + seriesFilter:[0] must not switch series 1 on and then
    // immediately exclude it.
    const spec = baseSpec({ dataLabels: { enabled: false, seriesFilter: [0] } });
    expect(dataLabelRow(spec, 1)?.patch.dataLabels?.seriesFilter).toEqual([1]);
  });

  it("removes one series from the filter and disables when it was the last", () => {
    const two = baseSpec({ dataLabels: { enabled: true, seriesFilter: [0, 1] } });
    expect(dataLabelRow(two, 1)?.patch.dataLabels).toEqual({
      enabled: true,
      seriesFilter: [0],
    });

    const one = baseSpec({ dataLabels: { enabled: true, seriesFilter: [1] } });
    expect(dataLabelRow(one, 1)?.patch.dataLabels).toEqual({
      enabled: false,
      seriesFilter: null,
    });
  });

  it("names the OTHER series when labels were on chart-wide", () => {
    const spec = baseSpec({ dataLabels: { enabled: true } });
    expect(dataLabelRow(spec, 1)?.patch.dataLabels).toEqual({ enabled: true, seriesFilter: [0] });
  });

  it("refuses the row when 'every series except this one' cannot be expressed", () => {
    // A pivot / design-query chart enumerates no series in its spec, so a
    // chart-wide label toggle cannot be narrowed to one series. Offering
    // "Remove Data Labels" there would strip them from every series — the menu
    // says nothing rather than doing something else.
    const spec = baseSpec({ series: [], dataLabels: { enabled: true } });
    expect(dataLabelRow(spec, 0)).toBeNull();
  });
});

// ============================================================================
// Reset to Match Style
// ============================================================================

describe("resetToMatchStylePatch", () => {
  const key = (s: string, c: string) => `${s}${DATA_POINT_KEY_SEPARATOR}${c}`;
  const overrides: DataPointOverride[] = [
    { seriesIndex: 1, categoryIndex: 2, key: key("Cost", "Mar"), color: "#f00" },
    { seriesIndex: 0, categoryIndex: 0, key: key("Revenue", "Jan"), color: "#0f0" },
  ];
  const point: MenuSubject = subjectFor(barB());
  const series: MenuSubject = subjectFor(barB({ pointIndex: undefined }));

  it("drops only the right-clicked point's override, matched by identity key", () => {
    const patch = resetToMatchStylePatch(baseSpec({ dataPointOverrides: overrides }), point);
    expect(patch?.dataPointOverrides).toEqual([overrides[1]]);
  });

  it("matches by index pair when the override predates keys", () => {
    const legacy: DataPointOverride[] = [{ seriesIndex: 1, categoryIndex: 2, color: "#f00" }];
    const patch = resetToMatchStylePatch(baseSpec({ dataPointOverrides: legacy }), point);
    expect(patch?.dataPointOverrides).toBeUndefined();
  });

  it("drops the whole series' overrides and its colour at series level", () => {
    const patch = resetToMatchStylePatch(
      baseSpec({ dataPointOverrides: overrides, seriesColors: { Cost: "#123456", Revenue: "#abc" } }),
      series,
    );
    expect(patch?.dataPointOverrides).toEqual([overrides[1]]);
    expect(patch?.seriesColors).toEqual({ Revenue: "#abc" });
  });

  it("drops everything manual at chart level", () => {
    const patch = resetToMatchStylePatch(
      baseSpec({ dataPointOverrides: overrides, seriesColors: { Cost: "#123456" } }),
      subjectFor(null),
    );
    expect(patch?.dataPointOverrides).toBeUndefined();
    expect(patch?.seriesColors).toBeUndefined();
  });

  it("returns null when there is nothing manual to reset", () => {
    expect(resetToMatchStylePatch(baseSpec(), point)).toBeNull();
    expect(resetToMatchStylePatch(baseSpec(), subjectFor(null))).toBeNull();
  });

  it("keeps the item off the menu when it would do nothing", async () => {
    setChartRightClickTarget(barB());
    await render();
    expect(itemIds()).not.toContain("resetToMatchStyle");
  });

  it("shows and applies the item when the point carries an override", async () => {
    h.getChartById.mockReturnValue(chartWith(baseSpec({ dataPointOverrides: overrides })));
    setChartRightClickTarget(barB());
    await render();

    await click("resetToMatchStyle");
    expect(h.updateChartSpec).toHaveBeenCalledWith("chart-1", {
      dataPointOverrides: [overrides[1]],
    });
  });
});

// ============================================================================
// The hardening this file already had — none of it may regress
// ============================================================================

describe("existing hardening", () => {
  it("renders a contributed item and hands its onSelect the chart id", async () => {
    const onSelect = vi.fn();
    registerChartContextMenuContribution({ id: "ai.explainChart", label: "Explain This Chart", onSelect });
    await render();

    await click("contribution:ai.explainChart");
    expect(onSelect).toHaveBeenCalledWith("chart-1");
  });

  it("renders a contribution registered AFTER the menu was already open", async () => {
    await render();
    expect(container.textContent).not.toContain("Explain This Chart");

    // If the snapshot were not referentially stable this render loop would
    // never settle; if it were not subscribed the item would never appear.
    await act(async () => {
      registerChartContextMenuContribution({
        id: "ai.explainChart",
        label: "Explain This Chart",
        onSelect: vi.fn(),
      });
    });

    expect(container.textContent).toContain("Explain This Chart");
  });

  it("keeps the built-in items when a contribution's visible() throws", async () => {
    registerChartContextMenuContribution({
      id: "bad",
      label: "Bad Item",
      visible: () => {
        throw new Error("contributor blew up");
      },
      onSelect: vi.fn(),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await render();

    expect(container.textContent).not.toContain("Bad Item");
    expect(itemIds()).toContain("deleteChart");
    expect(itemIds()).toContain("formatElement");
    warn.mockRestore();
  });

  it("runs onClose BEFORE the item's action, for built-ins as well", async () => {
    h.showDialog.mockImplementation(() => order.push("action"));
    setChartRightClickTarget(barB());
    await render();

    await click("formatElement");
    expect(order).toEqual(["close", "action"]);
  });

  it("does not clear the right-click record on unmount", async () => {
    // onClose() runs before a contribution's onSelect, so the menu is already
    // unmounted by the time foreign code asks what was right-clicked. Clearing
    // on unmount would hand every contribution a null subject.
    setChartRightClickTarget(barB());
    await render();
    const r = root!;
    await act(async () => r.unmount());
    root = null;
    expect(getChartRightClickTarget("chart-1")).not.toBeNull();
  });

  it("renders nothing without a chart", async () => {
    h.getChartById.mockReturnValue(undefined);
    await render();
    expect(container.textContent).toBe("");
  });
});
