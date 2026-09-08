//! FILENAME: app/extensions/Charts/lib/__tests__/chartDataProvider.test.ts
// PURPOSE: A blank cell reaches an analysis as `null`, never as the zero the
//          chart renderer draws — plus the rest of the `@api/chartData` and
//          `@api/chartContextMenu` contracts Charts now implements.
// CONTEXT: `chartDataReader` parses FORMATTED DISPLAY STRINGS and ends both of
//          its parsers with `values.push(isNaN(num) ? 0 : num)`. That is right
//          for drawing and wrong for computing: a month nobody has typed yet
//          arrives as a real 0, and a downstream fact reports a collapse that
//          never happened. `chartDataProvider` re-reads a plain source range
//          TYPED for exactly that reason, and the first test in this file is
//          the whole justification for the module existing — if it ever goes
//          green with a 0 in place of the null, the feature is a lie again.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { TypedCellData } from "@api/lib";
import type { ChartDefinition, ChartSpec, ParsedChartData } from "../../types";

// ----------------------------------------------------------------------------
// Doubles. Everything the provider touches outside itself is stubbed, so each
// test states one grid + one resolved read and nothing else can influence it.
// ----------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  getRangeCellsTyped: vi.fn(),
  getChartById: vi.fn(),
  getAllCharts: vi.fn(),
  readChartDataResolved: vi.fn(),
  resolveDataSource: vi.fn(),
  getCurrentChartId: vi.fn(),
  emitAppEvent: vi.fn(),
  showDialog: vi.fn(),
}));

vi.mock("@api/lib", () => ({ getRangeCellsTyped: h.getRangeCellsTyped }));
vi.mock("@api", () => ({ emitAppEvent: h.emitAppEvent, showDialog: h.showDialog }));
vi.mock("../chartStore", () => ({
  getChartById: h.getChartById,
  getAllCharts: h.getAllCharts,
}));
vi.mock("../chartDataReader", () => ({ readChartDataResolved: h.readChartDataResolved }));
vi.mock("../dataSourceResolver", () => ({ resolveDataSource: h.resolveDataSource }));
vi.mock("../../handlers/selectionHandler", () => ({ getCurrentChartId: h.getCurrentChartId }));
vi.mock("../../manifest", () => ({ CHART_DIALOG_ID: "chart:createDialog" }));

import { chartDataProvider, strideIndices } from "../chartDataProvider";
import { ChartContextMenu } from "../../components/ChartContextMenu";
import {
  registerChartContextMenuContribution,
  resetChartContextMenuContributions,
} from "@api/chartContextMenu";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

/** A three-month, one-series column-oriented chart over A1:B4 with a header row. */
function monthlySpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "line",
    title: "Monthly revenue",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Revenue", sourceIndex: 1, color: null }],
    xAxis: {},
    yAxis: {},
    ...overrides,
  } as unknown as ChartSpec;
}

function chartWith(spec: ChartSpec): ChartDefinition {
  return {
    chartId: "chart-1",
    name: "Chart 1",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 600,
    height: 400,
    spec,
  };
}

/** What the renderer's own reader produced — display strings already coerced. */
function readerResult(spec: ChartSpec, data: ParsedChartData): unknown {
  return { spec, data, unfilteredData: data, diagnostics: [], params: new Map() };
}

function numberCell(row: number, col: number, value: number): TypedCellData {
  return { row, col, value, display: String(value), formula: null, type: "number" };
}

function textCell(row: number, col: number, value: string): TypedCellData {
  return { row, col, value, display: value, formula: null, type: "text" };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getAllCharts.mockReturnValue([]);
  h.getCurrentChartId.mockReturnValue(null);
  h.resolveDataSource.mockResolvedValue({
    sheetIndex: 0,
    startRow: 0,
    startCol: 0,
    endRow: 3,
    endCol: 1,
  });
});

// ============================================================================
// The reason this module exists
// ============================================================================

describe("resolveSeries over a plain cell range", () => {
  it("reports a blank source cell as null and never as the zero the chart draws", async () => {
    const spec = monthlySpec();
    h.getChartById.mockReturnValue(chartWith(spec));
    // The renderer's reader coerced the blank February cell to 0 — this is the
    // exact value the provider must refuse to pass on.
    h.readChartDataResolved.mockResolvedValue(
      readerResult(spec, {
        categories: ["Jan", "Feb", "Mar"],
        series: [{ name: "Revenue", values: [100, 0, 300], color: null }],
      }),
    );
    // A SPARSE typed read: B3 (row 2) is simply absent, because it is empty.
    h.getRangeCellsTyped.mockResolvedValue([
      textCell(0, 1, "Revenue"),
      numberCell(1, 1, 100),
      numberCell(3, 1, 300),
    ]);

    const snap = await chartDataProvider.resolveSeries("chart-1", 1000);

    expect(snap).not.toBeNull();
    const values = snap!.series[0].values;
    expect(values[1]).toBeNull();
    // Stated twice on purpose: `toBeNull` would also pass for a future change
    // that returned undefined, and 0 is the specific wrong answer we ship to
    // prevent. Both halves must hold.
    expect(values[1]).not.toBe(0);
    expect(values).toEqual([100, null, 300]);
  });

  it("reports a text cell as null, because text is not a quantity", async () => {
    const spec = monthlySpec();
    h.getChartById.mockReturnValue(chartWith(spec));
    h.readChartDataResolved.mockResolvedValue(
      readerResult(spec, {
        categories: ["Jan", "Feb", "Mar"],
        series: [{ name: "Revenue", values: [100, 0, 300], color: null }],
      }),
    );
    h.getRangeCellsTyped.mockResolvedValue([
      numberCell(1, 1, 100),
      textCell(2, 1, "n/a"),
      numberCell(3, 1, 300),
    ]);

    const snap = await chartDataProvider.resolveSeries("chart-1", 1000);

    expect(snap!.series[0].values).toEqual([100, null, 300]);
  });

  it("points a series' evidence at the cells it was read from, header excluded", async () => {
    const spec = monthlySpec();
    h.getChartById.mockReturnValue(chartWith(spec));
    h.readChartDataResolved.mockResolvedValue(
      readerResult(spec, {
        categories: ["Jan", "Feb", "Mar"],
        series: [{ name: "Revenue", values: [100, 200, 300], color: null }],
      }),
    );
    h.getRangeCellsTyped.mockResolvedValue([
      numberCell(1, 1, 100),
      numberCell(2, 1, 200),
      numberCell(3, 1, 300),
    ]);

    const snap = await chartDataProvider.resolveSeries("chart-1", 1000);

    // Column B, rows 2..4 in user terms: the header row is not data.
    expect(snap!.series[0].evidence).toEqual({
      sheetIndex: 0,
      startRow: 1,
      startCol: 1,
      endRow: 3,
      endCol: 1,
    });
    expect(snap!.assumptions).toEqual([]);
  });

  it("keeps values aligned with categories when a filter hid a category", async () => {
    const spec = monthlySpec();
    h.getChartById.mockReturnValue(chartWith(spec));
    // February was hidden by a chart filter: the resolved data records that the
    // two surviving painter slots are authoring categories 0 and 2.
    h.readChartDataResolved.mockResolvedValue(
      readerResult(spec, {
        categories: ["Jan", "Mar"],
        series: [{ name: "Revenue", values: [100, 300], color: null }],
        keptCategoryIndices: [0, 2],
      }),
    );
    h.getRangeCellsTyped.mockResolvedValue([
      numberCell(1, 1, 100),
      numberCell(2, 1, 222),
      numberCell(3, 1, 300),
    ]);

    const snap = await chartDataProvider.resolveSeries("chart-1", 1000);

    // Reading the source in source order would have produced [100, 222] — the
    // hidden month's value shifted into March's slot.
    expect(snap!.series[0].values).toEqual([100, 300]);
  });
});

// ============================================================================
// Sampling
// ============================================================================

describe("stride sampling", () => {
  it("keeps the first and last point and marks the snapshot truncated", async () => {
    // A pivot-backed chart, so no typed re-read interferes with the arithmetic.
    const spec = monthlySpec({ data: { type: "pivot", pivotId: "p1" } as never });
    h.getChartById.mockReturnValue(chartWith(spec));
    h.readChartDataResolved.mockResolvedValue(
      readerResult(spec, {
        categories: ["c0", "c1", "c2", "c3", "c4"],
        series: [{ name: "Revenue", values: [0, 1, 2, 3, 4], color: null }],
        categoryField: { type: "quantitative", values: [10, 11, 12, 13, 14] },
      }),
    );

    const snap = await chartDataProvider.resolveSeries("chart-1", 3);

    expect(snap!.truncated).toBe(true);
    expect(snap!.categories).toEqual(["c0", "c2", "c4"]);
    expect(snap!.series[0].values).toEqual([0, 2, 4]);
    // The typed category positions ride along, or the X axis stops matching.
    expect(snap!.categoryValues).toEqual([10, 12, 14]);
    expect(h.getRangeCellsTyped).not.toHaveBeenCalled();
    // A pivot aggregate cannot be re-read from cells, and the snapshot says so.
    expect(snap!.assumptions.length).toBe(1);
    expect(snap!.assumptions[0]).toMatch(/cannot be re-read typed/);
  });

  it("leaves a series that fits under the cap untouched and untruncated", async () => {
    const spec = monthlySpec({ data: { type: "pivot", pivotId: "p1" } as never });
    h.getChartById.mockReturnValue(chartWith(spec));
    h.readChartDataResolved.mockResolvedValue(
      readerResult(spec, {
        categories: ["c0", "c1", "c2"],
        series: [{ name: "Revenue", values: [0, 1, 2], color: null }],
      }),
    );

    const snap = await chartDataProvider.resolveSeries("chart-1", 3);

    expect(snap!.truncated).toBe(false);
    expect(snap!.categories).toEqual(["c0", "c1", "c2"]);
    expect(snap!.series[0].values).toEqual([0, 1, 2]);
  });

  it("returns strictly increasing indices that start at 0 and end at the last point", () => {
    expect(strideIndices(3, 10)).toBeNull();
    const idx = strideIndices(1000, 7)!;
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(999);
    expect(idx.length).toBe(7);
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });
});

// ============================================================================
// Charts with no single series set
// ============================================================================

describe("charts that cannot be summarised as one series set", () => {
  it("resolves a concat container to null so a caller can ask for a child", async () => {
    const spec = monthlySpec({
      concat: { charts: [monthlySpec(), monthlySpec()] } as never,
    });
    h.getChartById.mockReturnValue(chartWith(spec));

    const snap = await chartDataProvider.resolveSeries("chart-1", 1000);

    expect(snap).toBeNull();
    // Short-circuited before the reader ran: a container has nothing to read.
    expect(h.readChartDataResolved).not.toHaveBeenCalled();
  });

  it("resolves an unknown chart id to null", async () => {
    h.getChartById.mockReturnValue(null);
    expect(await chartDataProvider.resolveSeries("nope", 1000)).toBeNull();
  });
});

// ============================================================================
// Summaries and selection
// ============================================================================

describe("listCharts and getSelectedChartId", () => {
  it("classifies each chart's source and filters by sheet", () => {
    h.getAllCharts.mockReturnValue([
      { ...chartWith(monthlySpec()), chartId: "a", sheetIndex: 0 },
      {
        ...chartWith(monthlySpec({ data: { type: "pivot", pivotId: "p1" } as never })),
        chartId: "b",
        sheetIndex: 1,
      },
    ]);

    expect(chartDataProvider.listCharts().map((c) => c.sourceKind)).toEqual(["range", "pivot"]);
    expect(chartDataProvider.listCharts(1).map((c) => c.chartId)).toEqual(["b"]);
  });

  it("reports the chart the user has selected", () => {
    h.getCurrentChartId.mockReturnValue("chart-7");
    expect(chartDataProvider.getSelectedChartId()).toBe("chart-7");
  });
});

// ============================================================================
// The contribution point on the context menu
// ============================================================================

describe("the chart context menu", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function render(): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(ChartContextMenu, {
          onClose: () => {},
          data: { chartId: "chart-1", screenX: 10, screenY: 10 },
        }),
      );
    });
  }

  beforeEach(() => {
    resetChartContextMenuContributions();
    h.getChartById.mockReturnValue(chartWith(monthlySpec()));
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    resetChartContextMenuContributions();
  });

  it("renders a contributed item and hands its onSelect the chart id", async () => {
    const onSelect = vi.fn();
    registerChartContextMenuContribution({ id: "ai.explainChart", label: "Explain This Chart", onSelect });

    await render();

    const item = [...container.querySelectorAll("div")].find(
      (d) => d.textContent === "Explain This Chart",
    );
    expect(item).toBeTruthy();
    await act(async () => {
      item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("chart-1");
  });

  it("renders a contribution registered AFTER the menu was already open", async () => {
    await render();
    expect(container.textContent).not.toContain("Explain This Chart");

    // If the snapshot were not stable, this render loop would never settle; if
    // it were not subscribed, the new item would never appear.
    await act(async () => {
      registerChartContextMenuContribution({
        id: "ai.explainChart",
        label: "Explain This Chart",
        onSelect: vi.fn(),
      });
    });

    expect(container.textContent).toContain("Explain This Chart");
  });

  it("hides a contribution whose visible() refuses this chart", async () => {
    registerChartContextMenuContribution({
      id: "ai.explainChart",
      label: "Explain This Chart",
      visible: (id) => id === "some-other-chart",
      onSelect: vi.fn(),
    });

    await render();

    expect(container.textContent).not.toContain("Explain This Chart");
    // The built-in items are untouched by a contributor's opinion.
    expect(container.textContent).toContain("Delete Chart");
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
    expect(container.textContent).toContain("Delete Chart");
    warn.mockRestore();
  });
});
