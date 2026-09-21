//! FILENAME: app/extensions/Charts/rendering/__tests__/elementHitTest-selectionLadder.test.ts
// PURPOSE: The selection ladder over the FULL element taxonomy — a click on the
//          title selects the title, a click on the legend selects the legend,
//          and a second click on the already-selected legend drills into the
//          entry under the cursor.
// CONTEXT: The ladder used to know two things only: "a datum" and "everything
//          else, go back to chart level". The chart's furniture was not
//          addressable at all, because the hit-tester could not name it — the
//          whole left margin answered "axis" and the top and right margins
//          answered nothing. These tests drive the REAL hit-tester over a real
//          layout, so a hit-testing regression fails here too rather than
//          leaving the ladder testing itself against hand-written fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { hitTestGeometry } from "../chartHitTesting";
import type { ChartLayout, HitGeometry } from "../../types";

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

const handler = await import("../../handlers/selectionHandler");

const CHART = "c1";

const LAYOUT: ChartLayout = {
  width: 600,
  height: 400,
  margin: { top: 40, right: 110, bottom: 60, left: 70 },
  plotArea: { x: 70, y: 40, width: 420, height: 300 },
  elements: {
    family: "cartesian",
    chartArea: { x: 0, y: 0, width: 600, height: 400 },
    title: { x: 200, y: 4, width: 200, height: 24 },
    xAxisTitle: { x: 200, y: 372, width: 160, height: 16 },
    yAxisTitle: { x: 4, y: 140, width: 16, height: 120 },
    xAxisBand: { x: 70, y: 340, width: 420, height: 28 },
    yAxisBand: { x: 30, y: 40, width: 40, height: 300 },
    legend: { x: 500, y: 100, width: 90, height: 60 },
    legendItems: [
      { seriesIndex: 0, rect: { x: 504, y: 104, width: 82, height: 20 } },
      { seriesIndex: 1, rect: { x: 504, y: 130, width: 82, height: 20 } },
    ],
    measured: ["title", "legend"],
  },
};

const GEOMETRY: HitGeometry = {
  type: "bars",
  rects: [
    { seriesIndex: 0, categoryIndex: 1, x: 120, y: 80, width: 40, height: 180, value: 500, seriesName: "Sales", categoryName: "Feb" },
    { seriesIndex: 1, categoryIndex: 1, x: 170, y: 120, width: 40, height: 140, value: 300, seriesName: "Costs", categoryName: "Feb" },
  ],
};

/** Click a pixel of the chart: hit-test it for real, then advance the ladder. */
function clickAt(x: number, y: number): void {
  handler.advanceSelection(CHART, hitTestGeometry(x, y, GEOMETRY, LAYOUT));
}

// Pixels, named once. Each is proved to land where it says in the drift test.
const ON_TITLE = [300, 12] as const;
const ON_X_AXIS_TITLE = [260, 380] as const;
const ON_Y_AXIS_TITLE = [10, 200] as const;
const ON_LEGEND_GAP = [540, 156] as const;
const ON_LEGEND_ENTRY_0 = [540, 112] as const;
const ON_LEGEND_ENTRY_1 = [540, 138] as const;
const ON_X_AXIS = [300, 350] as const;
const ON_PLOT_BACKGROUND = [400, 300] as const;
const ON_TOP_RIGHT_MARGIN = [560, 20] as const;
const ON_BAR_S0 = [140, 150] as const;

beforeEach(() => {
  handler.resetSelectionHandlerState();
  handler.selectChart(CHART);
});

describe("the ladder over chart furniture", () => {
  it("selects the title when the title is clicked", () => {
    clickAt(...ON_TITLE);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "title" });
  });

  it("selects each axis title separately — they used to BOTH read as 'axis'", () => {
    clickAt(...ON_X_AXIS_TITLE);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "xAxisTitle" });

    clickAt(...ON_Y_AXIS_TITLE);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "yAxisTitle" });
  });

  it("selects the axis when the tick-label band is clicked", () => {
    clickAt(...ON_X_AXIS);
    expect(handler.getSubSelection()).toEqual({ level: "axis", axisType: "x" });
  });

  it("selects the PLOT AREA on the plot background — it is a rung, not a way out", () => {
    // Excel's model, and the reason the mouse has a route back out at all: the
    // plot background is the Plot Area, the outer margin is the Chart Area.
    // Both pixels used to answer "chart level", which left `plotArea` reachable
    // by keyboard, paintable, nameable and formattable — and unreachable by the
    // primary input device.
    clickAt(...ON_TITLE);
    clickAt(...ON_PLOT_BACKGROUND);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "plotArea" });
  });

  it("drops back to chart level on the outer margin — the mouse's way back out", () => {
    clickAt(...ON_TITLE);
    clickAt(...ON_TOP_RIGHT_MARGIN);
    expect(handler.getSubSelection().level).toBe("chart");

    // And from the plot area itself, which is the gesture a reader who drilled
    // in by clicking the plot background actually makes.
    clickAt(...ON_PLOT_BACKGROUND);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "plotArea" });
    clickAt(...ON_TOP_RIGHT_MARGIN);
    expect(handler.getSubSelection().level).toBe("chart");
  });
});

describe("the legend is selected whole, then by entry", () => {
  it("first click on an entry selects the LEGEND, not the entry", () => {
    clickAt(...ON_LEGEND_ENTRY_0);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "legend" });
  });

  it("second click on the selected legend selects the entry under the cursor", () => {
    clickAt(...ON_LEGEND_ENTRY_1);
    clickAt(...ON_LEGEND_ENTRY_1);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "legendEntry", seriesIndex: 1 });
  });

  it("the entry it drills into is the one under THIS click, not the first one", () => {
    clickAt(...ON_LEGEND_ENTRY_0); // selects the legend
    clickAt(...ON_LEGEND_ENTRY_1); // drills in, on entry 1
    expect(handler.getSubSelection()).toMatchObject({ elementId: "legendEntry", seriesIndex: 1 });
  });

  it("moves between entries once inside the legend", () => {
    clickAt(...ON_LEGEND_ENTRY_0);
    clickAt(...ON_LEGEND_ENTRY_0);
    expect(handler.getSubSelection()).toMatchObject({ elementId: "legendEntry", seriesIndex: 0 });
    clickAt(...ON_LEGEND_ENTRY_1);
    expect(handler.getSubSelection()).toMatchObject({ elementId: "legendEntry", seriesIndex: 1 });
  });

  it("a click in the legend box but on no entry selects the legend, never an entry", () => {
    clickAt(...ON_LEGEND_GAP);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "legend" });
    clickAt(...ON_LEGEND_GAP);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "legend" });
  });

  it("leaving the legend for the title leaves no legend state behind", () => {
    clickAt(...ON_LEGEND_ENTRY_0);
    clickAt(...ON_LEGEND_ENTRY_0);
    clickAt(...ON_TITLE);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "title" });
    // ...and coming back starts at the legend again, not at an entry.
    clickAt(...ON_LEGEND_ENTRY_0);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "legend" });
  });
});

describe("datum clicks still own the click", () => {
  it("a datum beats the furniture it overlaps", () => {
    // The bar sits inside the plot area; the plot area does not win.
    clickAt(...ON_BAR_S0);
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 0 });
  });

  it("enters the datum ladder from an element selection", () => {
    clickAt(...ON_TITLE);
    clickAt(...ON_BAR_S0);
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 0 });
  });

  it("enters the datum ladder from an AXIS selection — this used to do nothing at all", () => {
    clickAt(...ON_X_AXIS);
    expect(handler.getSubSelection().level).toBe("axis");
    clickAt(...ON_BAR_S0);
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 0 });
  });

  it("climbs series -> dataPoint on a second click, as before", () => {
    clickAt(...ON_BAR_S0);
    clickAt(...ON_BAR_S0);
    expect(handler.getSubSelection()).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 });
  });
});
