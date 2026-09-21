//! FILENAME: app/extensions/Charts/rendering/__tests__/elementHitTest-drift.test.ts
// PURPOSE: The element taxonomy declared in types.ts and the elements
//          chartHitTesting.ts actually PRODUCES must be the same set, in both
//          directions.
//
// WHY THIS EXISTS: `ChartHitResult.type` declared "title" and "legend" and a
// repo-wide grep found zero producers of either. They sat dead because the only
// test over the union counted its members ("expect(hitTypes).toHaveLength(9)")
// — a count that a dead member satisfies perfectly. This test does not read the
// union and count it; it RUNS the hit-tester over real geometry and collects
// what comes back, then holds that against the declaration.
//
// DERIVE, NEVER RETYPE: the expected list is imported from `CHART_ELEMENT_IDS`,
// the array `ChartElementId` is itself derived from. There is no second copy of
// the names in this file, so a rename cannot be "fixed" by editing the test.
//
// BOTH DIRECTIONS matter and they fail for opposite reasons:
//   declared \ produced -> a DEAD member (the defect this replaces)
//   produced \ declared -> a hit result the type system says cannot happen,
//                          which every exhaustive `switch` over the union would
//                          silently fall out of.

import { describe, it, expect } from "vitest";
import {
  hitTestGeometry,
  hitTestChartElements,
  hitTestFilterButtons,
  chartElementOf,
} from "../chartHitTesting";
import { CHART_ELEMENT_IDS } from "../../types";
import type {
  ChartElementId,
  ChartLayout,
  HitGeometry,
  PivotChartFieldButton,
} from "../../types";

// ============================================================================
// A chart that has EVERY element, so every producer has something to answer
// ============================================================================

const BAR = {
  seriesIndex: 0,
  categoryIndex: 1,
  x: 120,
  y: 80,
  width: 40,
  height: 180,
  value: 500,
  seriesName: "Sales",
  categoryName: "Feb",
};

const GEOMETRY: HitGeometry = { type: "bars", rects: [BAR] };

/**
 * A cartesian layout whose furniture rects are all present — the shape a real
 * painted chart has once the layout stage and the paint stage have both run.
 * 600x400 canvas; the legend is a right-hand column with two entries.
 */
function fullLayout(): ChartLayout {
  return {
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
      displayUnitLabel: { x: 70, y: 24, width: 60, height: 14 },
      // The in-plot furniture the painters record (CI-12). A trendline is a
      // POLYLINE, not a rect, because its bounding box would cover the plot.
      trendlines: [
        { seriesIndex: 0, trendlineIndex: 0, points: [{ x: 90, y: 300 }, { x: 460, y: 90 }] },
      ],
      errorBars: [
        { seriesIndex: 0, rect: { x: 137, y: 60, width: 6, height: 40 } },
      ],
      dataLabels: [
        { seriesIndex: 0, pointIndex: 1, rect: { x: 126, y: 44, width: 28, height: 10 } },
      ],
      // Clear of the x tick-label band (y 340..368) and of the x axis title
      // (x 200..360): a probe must land on the element it is named for, and an
      // overlapping fixture would make the drift set pass for the wrong reason.
      dataTable: { x: 70, y: 376, width: 120, height: 20 },
      measured: ["title", "legend"],
    },
  };
}

const BUTTONS: PivotChartFieldButton[] = [
  {
    field: { area: "filter", fieldIndex: 0, name: "Region", isFiltered: false },
    x: 8,
    y: 8,
    width: 90,
    height: 20,
  },
];

// ============================================================================
// Every probe below is a REAL call; nothing is asserted by name
// ============================================================================

/**
 * One probe per element, labelled only so a failure says which pixel produced
 * nothing. The labels are documentation — the SET is what the test compares,
 * and it is collected from the return values, never from these strings.
 */
const PROBES: Array<{ where: string; run: () => ChartElementId }> = [
  { where: "inside the bar", run: () => chartElementOf(hitTestGeometry(140, 150, GEOMETRY, fullLayout())) },
  { where: "plot background", run: () => chartElementOf(hitTestGeometry(300, 200, GEOMETRY, fullLayout())) },
  { where: "the chart title", run: () => chartElementOf(hitTestGeometry(300, 12, GEOMETRY, fullLayout())) },
  { where: "the x axis title", run: () => chartElementOf(hitTestGeometry(260, 380, GEOMETRY, fullLayout())) },
  { where: "the y axis title", run: () => chartElementOf(hitTestGeometry(10, 200, GEOMETRY, fullLayout())) },
  { where: "the x tick-label band", run: () => chartElementOf(hitTestGeometry(300, 350, GEOMETRY, fullLayout())) },
  { where: "the y tick-label band", run: () => chartElementOf(hitTestGeometry(50, 200, GEOMETRY, fullLayout())) },
  { where: "a legend entry", run: () => chartElementOf(hitTestGeometry(540, 112, GEOMETRY, fullLayout())) },
  { where: "on the trendline stroke", run: () => chartElementOf(hitTestGeometry(275, 195, GEOMETRY, fullLayout())) },
  { where: "a data label above the bar", run: () => chartElementOf(hitTestGeometry(140, 49, GEOMETRY, fullLayout())) },
  { where: "an error bar's stem", run: () => chartElementOf(hitTestGeometry(140, 70, GEOMETRY, fullLayout())) },
  { where: "the data table", run: () => chartElementOf(hitTestGeometry(100, 386, GEOMETRY, fullLayout())) },
  { where: "the legend, between entries", run: () => chartElementOf(hitTestGeometry(540, 156, GEOMETRY, fullLayout())) },
  { where: "the top-right margin", run: () => chartElementOf(hitTestGeometry(560, 20, GEOMETRY, fullLayout())) },
  { where: "outside the object", run: () => chartElementOf(hitTestGeometry(-40, -40, GEOMETRY, fullLayout())) },
  { where: "a pivot filter button", run: () => chartElementOf(hitTestFilterButtons(20, 14, BUTTONS)) },
];

describe("chart element taxonomy drift", () => {
  it("produces every declared ChartElementId", () => {
    const produced = new Set(PROBES.map((p) => p.run()));
    const declared = new Set<string>(CHART_ELEMENT_IDS);
    const dead = [...declared].filter((id) => !produced.has(id as ChartElementId));
    expect(
      dead,
      `declared in CHART_ELEMENT_IDS but produced by nothing in chartHitTesting.ts: ${dead.join(", ")}`,
    ).toEqual([]);
  });

  it("produces nothing the taxonomy does not declare", () => {
    const declared = new Set<string>(CHART_ELEMENT_IDS);
    const undeclared = [...new Set(PROBES.map((p) => p.run()))].filter((id) => !declared.has(id));
    expect(
      undeclared,
      `produced by chartHitTesting.ts but absent from CHART_ELEMENT_IDS: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });

  it("every producer SETS element — it is optional on the type only for chartRenderer's last literal", () => {
    // `ChartElementId` is optional on `ChartHitResult` while chartRenderer
    // still builds one result of its own, and `chartElementOf` derives it from
    // the legacy mirror when it is absent. That derivation must never be what
    // this module relies on: a producer here that forgot `element` would still
    // answer plausibly through the mirror, and the drift assertions above
    // would pass on the fallback.
    const layout = fullLayout();
    const results = [
      hitTestGeometry(140, 150, GEOMETRY, layout),
      hitTestGeometry(300, 12, GEOMETRY, layout),
      hitTestGeometry(540, 112, GEOMETRY, layout),
      hitTestGeometry(300, 350, GEOMETRY, layout),
      hitTestGeometry(560, 20, GEOMETRY, layout),
      hitTestGeometry(-40, -40, GEOMETRY, layout),
      hitTestChartElements(300, 200, layout),
      hitTestFilterButtons(20, 14, BUTTONS)!,
    ];
    for (const r of results) expect(r.element).toBeDefined();
  });

  it("each probe lands on a DISTINCT element (no probe is a duplicate standing in for a dead one)", () => {
    // Without this, a probe that quietly resolves to `chartArea` could make the
    // first assertion pass for the wrong reason as soon as another probe
    // happens to cover its element.
    const produced = PROBES.map((p) => p.run());
    expect(new Set(produced).size).toBe(PROBES.length);
  });

  it("names each element at the pixel it belongs to", () => {
    // The set assertion above cannot tell "the title probe produced title" from
    // "some probe produced title". This pins the mapping.
    const layout = fullLayout();
    const at = (x: number, y: number) => chartElementOf(hitTestGeometry(x, y, GEOMETRY, layout));
    expect(at(140, 150)).toBe("datum");
    expect(at(300, 200)).toBe("plotArea");
    expect(at(300, 12)).toBe("title");
    expect(at(260, 380)).toBe("xAxisTitle");
    expect(at(10, 200)).toBe("yAxisTitle");
    expect(at(300, 350)).toBe("xAxis");
    expect(at(50, 200)).toBe("yAxis");
    expect(at(540, 112)).toBe("legendEntry");
    expect(at(540, 156)).toBe("legend");
    expect(at(275, 195)).toBe("trendline");
    expect(at(140, 49)).toBe("dataLabel");
    expect(at(140, 70)).toBe("errorBars");
    expect(at(100, 386)).toBe("dataTable");
    expect(at(560, 20)).toBe("chartArea");
    expect(at(-40, -40)).toBe("none");
    expect(chartElementOf(hitTestFilterButtons(20, 14, BUTTONS))).toBe("filterButton");
  });

  it("hitTestChartElements alone produces the furniture, without any geometry", () => {
    // The furniture half has to stand on its own: hover asks it for a chart
    // whose datum test already missed, and the drift guard must cover that
    // entry point too rather than only the dispatch above it.
    const layout = fullLayout();
    const at = (x: number, y: number) => hitTestChartElements(x, y, layout).element;
    expect(at(300, 12)).toBe("title");
    expect(at(540, 112)).toBe("legendEntry");
    expect(at(140, 150)).toBe("plotArea"); // the bar's pixel, with no bar to claim it
  });
});
