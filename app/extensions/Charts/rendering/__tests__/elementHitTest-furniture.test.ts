//! FILENAME: app/extensions/Charts/rendering/__tests__/elementHitTest-furniture.test.ts
// PURPOSE: The defect this work item names, pinned: a legend, an axis title and
//          a tick-label band are told APART, instead of the whole left and
//          bottom margins answering "axis" while the top and right margins
//          answered nothing at all.
// CONTEXT: `layout.elements` (Wave B) is consulted first; the old margin bands
//          survive only as the per-axis fallback for a layout that never
//          described itself — which is every hand-built layout in the existing
//          tests, so their behaviour is unchanged by construction.
//
// Z-ORDER is settled precedent (docs/design/insight-overlays.md §5h): a datum
// beats furniture that overlaps it, and the ladder keeps the click. The tests
// below pin that direction, not a re-argument of it.

import { describe, it, expect } from "vitest";
import {
  hitTestChartElements,
  hitTestGeometry,
  hitTestFilterButtons,
} from "../chartHitTesting";
import type { ChartLayout, HitGeometry, PivotChartFieldButton } from "../../types";

// ============================================================================
// Layouts
// ============================================================================

/** The pre-Wave-B shape: four margin scalars and a plot area, nothing else. */
function bareLayout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 20, right: 30, bottom: 40, left: 50 },
    plotArea: { x: 50, y: 20, width: 500, height: 340 },
  };
}

/**
 * A cartesian chart with a BOTTOM legend: the legend and the x tick-label band
 * share the bottom margin. This is the exact configuration the old code could
 * not express — it answered "axis" for both.
 */
function bottomLegendLayout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 20, right: 20, bottom: 90, left: 50 },
    plotArea: { x: 50, y: 20, width: 530, height: 260 },
    elements: {
      family: "cartesian",
      chartArea: { x: 0, y: 0, width: 600, height: 400 },
      xAxisBand: { x: 50, y: 280, width: 530, height: 26 },
      yAxisBand: { x: 20, y: 20, width: 30, height: 260 },
      legend: { x: 180, y: 330, width: 240, height: 30 },
      legendItems: [
        { seriesIndex: 0, rect: { x: 184, y: 334, width: 110, height: 22 } },
        { seriesIndex: 1, rect: { x: 300, y: 334, width: 110, height: 22 } },
      ],
      measured: ["legend"],
    },
  };
}

/** A pie: it has a legend and a title, and it has NO axes whatsoever. */
function radialLayout(): ChartLayout {
  return {
    width: 400,
    height: 400,
    margin: { top: 40, right: 100, bottom: 20, left: 20 },
    plotArea: { x: 20, y: 40, width: 260, height: 340 },
    elements: {
      family: "radial",
      chartArea: { x: 0, y: 0, width: 400, height: 400 },
      title: { x: 120, y: 4, width: 160, height: 24 },
      legend: { x: 300, y: 120, width: 90, height: 60 },
      legendItems: [{ seriesIndex: 0, rect: { x: 304, y: 124, width: 82, height: 20 } }],
      measured: ["title"],
    },
  };
}

// ============================================================================
// The defect
// ============================================================================

describe("the bottom margin is no longer one undifferentiated 'axis'", () => {
  const layout = bottomLegendLayout();
  const at = (x: number, y: number) => hitTestChartElements(x, y, layout).element;

  it("names the tick-label band as the x axis", () => {
    expect(at(300, 292)).toBe("xAxis");
  });

  it("names the legend below it as the legend", () => {
    expect(at(250, 345)).toBe("legendEntry");
    expect(at(430, 345)).toBe("chartArea"); // beside the legend, still in the margin
  });

  it("tells each legend entry apart by series", () => {
    expect(hitTestChartElements(200, 345, layout).seriesIndex).toBe(0);
    expect(hitTestChartElements(350, 345, layout).seriesIndex).toBe(1);
  });

  it("stops calling the left margin 'the y axis' beyond the tick-label band", () => {
    expect(at(30, 150)).toBe("yAxis"); // inside the measured band (x 20..50)
    expect(at(5, 150)).toBe("chartArea"); // left of it — used to answer "axis"
  });

  it("gives the top and right margins an answer at all", () => {
    expect(at(300, 8)).toBe("chartArea");
    expect(at(592, 150)).toBe("chartArea");
  });

  it("reserves 'none' for pixels outside the chart object", () => {
    expect(at(-1, 150)).toBe("none");
    expect(at(601, 150)).toBe("none");
    expect(at(300, 401)).toBe("none");
  });
});

describe("a radial chart has no axes", () => {
  const layout = radialLayout();
  const at = (x: number, y: number) => hitTestChartElements(x, y, layout).element;

  it("does not answer 'yAxis' for the left margin of a pie", () => {
    expect(at(10, 200)).toBe("chartArea");
  });

  it("does not answer 'xAxis' for the bottom margin of a pie", () => {
    expect(at(150, 390)).toBe("chartArea");
  });

  it("still names its title and its legend", () => {
    expect(at(200, 12)).toBe("title");
    expect(at(340, 132)).toBe("legendEntry");
    expect(at(340, 170)).toBe("legend");
  });
});

// ============================================================================
// Precedence
// ============================================================================

describe("furniture precedence", () => {
  it("a legend ENTRY beats the legend box that contains it", () => {
    const layout = bottomLegendLayout();
    expect(hitTestChartElements(200, 345, layout).element).toBe("legendEntry");
    expect(hitTestChartElements(420, 345, layout).element).toBe("legend"); // in the box, on no entry
  });

  it("a DATUM beats furniture that overlaps it (insight-overlays §5h)", () => {
    // Place a legend rect ON TOP of a bar. The bar wins: the ladder keeps the
    // click, and a ring or a legend swatch is not a thing the reader selects
    // INSTEAD of the datum under it.
    const layout = bareLayout();
    layout.elements = {
      family: "cartesian",
      chartArea: { x: 0, y: 0, width: 600, height: 400 },
      legend: { x: 100, y: 100, width: 200, height: 200 },
      legendItems: [{ seriesIndex: 0, rect: { x: 110, y: 110, width: 180, height: 180 } }],
      measured: [],
    };
    const geometry: HitGeometry = {
      type: "bars",
      rects: [{ seriesIndex: 3, categoryIndex: 2, x: 150, y: 150, width: 40, height: 100, value: 9, seriesName: "S", categoryName: "C" }],
    };
    const onBar = hitTestGeometry(170, 200, geometry, layout);
    expect(onBar.element).toBe("datum");
    expect(onBar.seriesIndex).toBe(3);
    // ...and one pixel off the bar, the legend does get it.
    expect(hitTestGeometry(140, 200, geometry, layout).element).toBe("legendEntry");
  });

  it("the plot area loses to furniture drawn over it", () => {
    const layout = bareLayout();
    layout.elements = {
      family: "cartesian",
      chartArea: { x: 0, y: 0, width: 600, height: 400 },
      title: { x: 200, y: 100, width: 100, height: 40 }, // deliberately inside the plot area
      measured: ["title"],
    };
    expect(hitTestChartElements(250, 120, layout).element).toBe("title");
    expect(hitTestChartElements(350, 120, layout).element).toBe("plotArea");
  });
});

// ============================================================================
// The margin fallback (a layout that never described itself)
// ============================================================================

describe("a layout with no `elements` behaves exactly as it did before", () => {
  const layout = bareLayout();
  const at = (x: number, y: number) => hitTestChartElements(x, y, layout).element;

  it("keeps the x margin band", () => {
    expect(at(300, 370)).toBe("xAxis");
    expect(at(300, 401)).toBe("none"); // past the margin AND past the canvas
  });

  it("keeps the y margin band", () => {
    expect(at(30, 200)).toBe("yAxis");
  });

  it("keeps the plot area", () => {
    expect(at(300, 200)).toBe("plotArea");
  });

  it("is per-axis: a measured X band does not switch OFF the Y fallback", () => {
    const partly: ChartLayout = {
      ...bareLayout(),
      elements: {
        family: "cartesian",
        chartArea: { x: 0, y: 0, width: 600, height: 400 },
        xAxisBand: { x: 50, y: 360, width: 500, height: 20 },
        measured: [],
      },
    };
    expect(hitTestChartElements(30, 200, partly).element).toBe("yAxis"); // fallback still live
    expect(hitTestChartElements(300, 370, partly).element).toBe("xAxis"); // measured band
    expect(hitTestChartElements(300, 385, partly).element).toBe("chartArea"); // below the band
  });
});

// ============================================================================
// Pivot filter buttons
// ============================================================================

describe("filter buttons", () => {
  const buttons: PivotChartFieldButton[] = [
    { field: { area: "filter", fieldIndex: 0, name: "Region", isFiltered: false }, x: 8, y: 8, width: 90, height: 20 },
    { field: { area: "row", fieldIndex: 1, name: "Product", isFiltered: true }, x: 104, y: 8, width: 90, height: 20 },
  ];

  it("names the button and carries the field", () => {
    const hit = hitTestFilterButtons(120, 14, buttons);
    expect(hit?.element).toBe("filterButton");
    expect(hit?.fieldButton?.field.name).toBe("Product");
  });

  it("answers null off the buttons, so the caller keeps looking", () => {
    expect(hitTestFilterButtons(300, 200, buttons)).toBeNull();
    expect(hitTestFilterButtons(10, 14, [])).toBeNull();
    expect(hitTestFilterButtons(10, 14, undefined)).toBeNull();
  });
});
