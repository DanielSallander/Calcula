//! FILENAME: app/extensions/Charts/handlers/__tests__/furniture2-ladder.test.ts
// PURPOSE: The in-plot furniture — a trendline, a series' error bars, one data
//          label, the data table — is a RUNG of the selection ladder, reachable
//          by click and by keyboard, with an identity fine enough to name ONE of
//          it.
//
// WHAT WAS WRONG, AND WHY IT PASSED REVIEW FOR A WHOLE WAVE. All four were
// hit-testable, carried @api display names and had their rects recorded by their
// own painters. Every one of those facts was true and the product still could
// not SELECT any of them: `advanceSelection` had no branch for them, so they
// fell through to `{ level: "chart" }` — click a trendline, get the chart. That
// is the dead-member defect the element taxonomy exists to prevent, pointing
// outward: the product could SAY what was under the cursor and could not act on
// it. Half-landed work looks finished from every direction except the one that
// matters.
//
// TWO OF THEM COULD NOT EVEN BE EXPRESSED. `ChartSubSelection` carried no
// trendline ordinal, so "the moving average of series 0" and "the linear fit of
// series 0" were the same value; and it documented `categoryIndex` as
// dataPoint-only, so "the label on point 3" had nowhere to live. Those two gaps
// are why this file asserts the INDICES and not merely the element id.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChartLayout, ChartSubSelection, HitGeometry } from "../../types";
import { hitTestGeometry } from "../../rendering/chartHitTesting";

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

const handler = await import("../selectionHandler");
const {
  advanceSelection,
  buildChartNavGroups,
  navigateChartSelection,
  findChartNavPosition,
  escapeLevelUp,
  getSubSelection,
  selectChart,
  deselectChart,
  isChartAreaElement,
  isFurnitureDeleteElement,
  CHART_FURNITURE_DELETE_ELEMENT_IDS,
} = handler;

// ---------------------------------------------------------------------------
// Fixtures — a chart carrying ALL FOUR pieces of furniture at once
// ---------------------------------------------------------------------------

const CHART = "chart-1";

/**
 * Deliberately overlapping nothing. Every probe below lands on the element it
 * is named for, so a hit that resolved to a neighbour would fail by name rather
 * than pass for the wrong reason.
 *
 * Series 0 carries TWO trendlines (a linear fit and a moving average), which is
 * the case the trendline ordinal exists for.
 */
function layout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 40, right: 110, bottom: 60, left: 70 },
    plotArea: { x: 70, y: 40, width: 420, height: 260 },
    elements: {
      family: "cartesian",
      chartArea: { x: 0, y: 0, width: 600, height: 400 },
      title: { x: 200, y: 4, width: 200, height: 24 },
      trendlines: [
        { seriesIndex: 0, trendlineIndex: 0, points: [{ x: 80, y: 60 }, { x: 460, y: 60 }] },
        { seriesIndex: 0, trendlineIndex: 1, points: [{ x: 80, y: 100 }, { x: 460, y: 100 }] },
        { seriesIndex: 1, trendlineIndex: 2, points: [{ x: 80, y: 140 }, { x: 460, y: 140 }] },
      ],
      errorBars: [
        { seriesIndex: 0, rect: { x: 100, y: 180, width: 6, height: 30 } },
        { seriesIndex: 0, rect: { x: 140, y: 180, width: 6, height: 30 } },
        { seriesIndex: 1, rect: { x: 200, y: 180, width: 6, height: 30 } },
      ],
      dataLabels: [
        { seriesIndex: 0, pointIndex: 0, rect: { x: 260, y: 180, width: 24, height: 12 } },
        { seriesIndex: 0, pointIndex: 1, rect: { x: 300, y: 180, width: 24, height: 12 } },
        { seriesIndex: 1, pointIndex: 0, rect: { x: 340, y: 180, width: 24, height: 12 } },
      ],
      dataTable: { x: 70, y: 320, width: 420, height: 40 },
      measured: [],
    },
  };
}

/** One bar, far from every piece of furniture above. */
const GEOMETRY: HitGeometry = {
  type: "bars",
  rects: [
    {
      seriesIndex: 0,
      categoryIndex: 0,
      x: 400,
      y: 240,
      width: 30,
      height: 50,
      value: 7,
      seriesName: "Sales",
      categoryName: "Jan",
    },
  ],
};

/** Click at a pixel, through the REAL hit tester, and read the rung back. */
function clickAt(x: number, y: number): ChartSubSelection {
  const hit = hitTestGeometry(x, y, GEOMETRY, layout());
  advanceSelection(CHART, hit);
  return getSubSelection();
}

beforeEach(() => {
  deselectChart();
  selectChart(CHART);
});

// ===========================================================================

describe("the ladder STOPS at the in-plot furniture", () => {
  it("selects the trendline under the cursor, with its OWN ordinal", () => {
    // Two trendlines on ONE series: the ordinal is the only thing that tells
    // them apart, and without it the pane would edit whichever was declared
    // first no matter which line the reader clicked.
    expect(clickAt(200, 60)).toEqual({
      level: "element",
      elementId: "trendline",
      seriesIndex: 0,
      trendlineIndex: 0,
    });
    expect(clickAt(200, 100)).toEqual({
      level: "element",
      elementId: "trendline",
      seriesIndex: 0,
      trendlineIndex: 1,
    });
  });

  it("selects error bars PER SERIES and carries no point index at all", () => {
    // Excel has no per-point error bar. A categoryIndex here would invent an
    // object the Format pane cannot target — and would make two clicks on the
    // same object compare unequal.
    const sel = clickAt(103, 195);
    expect(sel).toEqual({ level: "element", elementId: "errorBars", seriesIndex: 0 });
    expect(sel.categoryIndex).toBeUndefined();

    // A bar of the OTHER series is a different rung.
    expect(clickAt(203, 195)).toEqual({
      level: "element",
      elementId: "errorBars",
      seriesIndex: 1,
    });
  });

  it("DROPS a point index that reached an errorBars hit, rather than passing it on", () => {
    // Defence in depth, and the reason it is worth having: `ChartSubSelection`
    // documents error bars as series-only, and `@api/chartSelection`'s change
    // test is field-by-field — so a stray `categoryIndex` would make two clicks
    // on the SAME error-bar set compare unequal, republish, and remount the
    // Format pane body (it is keyed on the subject), throwing away whatever the
    // reader had half-typed into a field.
    //
    // The hit tester does not produce one today; that is exactly why the ladder
    // is asked directly here. A guard whose only proof is "nothing currently
    // feeds it" is a guard that can be deleted without a single test going red.
    advanceSelection(CHART, {
      element: "errorBars",
      seriesIndex: 0,
      pointIndex: 2,
      trendlineIndex: 9,
      type: "none",
    });
    expect(getSubSelection()).toEqual({
      level: "element",
      elementId: "errorBars",
      seriesIndex: 0,
    });
  });

  it("DROPS a point index that reached a trendline hit", () => {
    advanceSelection(CHART, {
      element: "trendline",
      seriesIndex: 1,
      pointIndex: 4,
      trendlineIndex: 2,
      type: "none",
    });
    expect(getSubSelection()).toEqual({
      level: "element",
      elementId: "trendline",
      seriesIndex: 1,
      trendlineIndex: 2,
    });
  });

  it("selects ONE data label, naming its point", () => {
    expect(clickAt(310, 186)).toEqual({
      level: "element",
      elementId: "dataLabel",
      seriesIndex: 0,
      categoryIndex: 1,
    });
  });

  it("selects the data table, which has no instance index because there is one of it", () => {
    expect(clickAt(200, 340)).toEqual({ level: "element", elementId: "dataTable" });
  });

  it("does NOT collapse any of them to chart level — the defect this closes", () => {
    for (const [x, y] of [[200, 60], [103, 195], [310, 186], [200, 340]] as const) {
      expect(clickAt(x, y).level, `(${x},${y}) must not fall through to the chart`).toBe("element");
    }
  });

  it("a SECOND click on the same furniture drills no further", () => {
    // A trendline has no parts and a data label is already the finest thing on
    // the chart. The legend's whole-then-part shape exists because a legend
    // genuinely contains rows; inventing one here would be a rung with nothing
    // behind it.
    const first = clickAt(200, 60);
    const second = clickAt(200, 60);
    expect(second).toEqual(first);
  });

  it("leaves the furniture when the next click is a datum", () => {
    clickAt(200, 60);
    expect(clickAt(410, 260)).toEqual({ level: "series", seriesIndex: 0 });
  });
});

// ===========================================================================

describe("identity is per element, so two of the same kind are not the same rung", () => {
  const groups = buildChartNavGroups(layout(), GEOMETRY);
  const at = (sub: ChartSubSelection) => findChartNavPosition(groups, sub);

  it("two trendlines on one series occupy DIFFERENT positions in the walk", () => {
    const a = at({ level: "element", elementId: "trendline", seriesIndex: 0, trendlineIndex: 0 });
    const b = at({ level: "element", elementId: "trendline", seriesIndex: 0, trendlineIndex: 1 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toEqual(b);
  });

  it("two data labels of one series occupy different positions", () => {
    const a = at({ level: "element", elementId: "dataLabel", seriesIndex: 0, categoryIndex: 0 });
    const b = at({ level: "element", elementId: "dataLabel", seriesIndex: 0, categoryIndex: 1 });
    expect(a).not.toEqual(b);
  });

  it("an errorBars rung is matched on the SERIES alone", () => {
    // Matching on a categoryIndex too would make a rung that picked one up
    // anywhere (a copy, a replay, a future field) fail to find itself in the
    // walk, and `navigateChartSelection` would then silently re-enter at the
    // first group.
    expect(at({ level: "element", elementId: "errorBars", seriesIndex: 1 })).not.toBeNull();
  });

  it("the singleton furniture is matched by its id alone", () => {
    expect(at({ level: "element", elementId: "dataTable" })).not.toBeNull();
  });
});

// ===========================================================================

describe("the keyboard walk reaches every piece of furniture that was DRAWN", () => {
  it("adds one group per trendline, per error-bar series, per label series, and the table", () => {
    const ids = buildChartNavGroups(layout(), GEOMETRY).map((g) => g.id);
    expect(ids).toEqual([
      "chartArea",
      "title",
      "plotArea",
      "trendline:0:0",
      "trendline:0:1",
      "trendline:1:2",
      "errorBars:0",
      "errorBars:1",
      "dataLabels:0",
      "dataLabels:1",
      "dataTable",
      "series:0",
    ]);
  });

  it("walks the LABELS of a series with Left/Right, one member per point", () => {
    const groups = buildChartNavGroups(layout(), GEOMETRY);
    const labels = groups.find((g) => g.id === "dataLabels:0")!;
    expect(labels.members).toEqual([
      { level: "element", elementId: "dataLabel", seriesIndex: 0, categoryIndex: 0 },
      { level: "element", elementId: "dataLabel", seriesIndex: 0, categoryIndex: 1 },
    ]);
    expect(navigateChartSelection(groups, labels.members[0], "nextMember")).toEqual(
      labels.members[1],
    );
  });

  it("SKIPS furniture that was not drawn — the walk follows the recorded rects", () => {
    // Deriving the walk from the SPEC would offer a rung on a trendline whose
    // fit produced fewer than two points and was therefore never painted.
    const bare = layout();
    delete bare.elements!.trendlines;
    delete bare.elements!.errorBars;
    delete bare.elements!.dataLabels;
    delete bare.elements!.dataTable;
    const ids = buildChartNavGroups(bare, GEOMETRY).map((g) => g.id);
    expect(ids).toEqual(["chartArea", "title", "plotArea", "series:0"]);
  });
});

// ===========================================================================

describe("Escape steps up to the thing the furniture BELONGS to", () => {
  it("a trendline and a series' error bars step up to that series", () => {
    expect(
      escapeLevelUp({ level: "element", elementId: "trendline", seriesIndex: 2, trendlineIndex: 1 }),
    ).toEqual({ level: "series", seriesIndex: 2 });
    expect(escapeLevelUp({ level: "element", elementId: "errorBars", seriesIndex: 1 })).toEqual({
      level: "series",
      seriesIndex: 1,
    });
  });

  it("a data label steps up to the POINT it labels", () => {
    expect(
      escapeLevelUp({ level: "element", elementId: "dataLabel", seriesIndex: 0, categoryIndex: 3 }),
    ).toEqual({ level: "dataPoint", seriesIndex: 0, categoryIndex: 3 });
  });

  it("the data table belongs to the chart and nothing smaller", () => {
    expect(escapeLevelUp({ level: "element", elementId: "dataTable" })).toEqual({ level: "chart" });
  });

  it("falls back to the series when a label rung has lost its point", () => {
    expect(escapeLevelUp({ level: "element", elementId: "dataLabel", seriesIndex: 0 })).toEqual({
      level: "series",
      seriesIndex: 0,
    });
  });
});

// ===========================================================================

describe("Delete has a meaning for every furniture rung the walk can reach", () => {
  // The index.ts listener branches on the SUBJECT: a text element clears its
  // text, the legend hides itself, a legend ENTRY hides its row, the two AREAS
  // consume the keystroke and do nothing, the four in-plot elements remove
  // themselves, and EVERYTHING ELSE destroys the chart. So a furniture group
  // added to `buildChartNavGroups` without a Delete meaning is a new route from
  // a selected chart to no chart — which is exactly how "Down, Down, Down,
  // Delete" once destroyed a chart from its own plot area.
  //
  // This is the same coverage test chartKeyboardNav.test.ts runs, over a layout
  // that ACTUALLY CARRIES the new furniture. That one's fixture has none of it,
  // so it could not have caught this.
  it("no rung falls through to 'destroy the chart'", async () => {
    const { isChartTextElement } = await import("../chartTextEditing");
    const unhandled: string[] = [];
    for (const group of buildChartNavGroups(layout(), GEOMETRY)) {
      for (const member of group.members) {
        if (member.level !== "element") continue;
        const id = member.elementId!;
        const handled =
          isChartTextElement(id) ||
          id === "legend" ||
          id === "legendEntry" ||
          isChartAreaElement(id) ||
          isFurnitureDeleteElement(id);
        if (!handled) unhandled.push(`${group.id}/${id}`);
      }
    }
    expect(unhandled).toEqual([]);
  });

  it("names exactly the four in-plot elements, and nothing else", () => {
    // The coverage test above would still pass if `isFurnitureDeleteElement`
    // said yes to everything — including `plotArea`, which would restore the
    // destructive route it exists to close. So the list is pinned on its own.
    expect([...CHART_FURNITURE_DELETE_ELEMENT_IDS]).toEqual([
      "trendline",
      "errorBars",
      "dataLabel",
      "dataTable",
    ]);
    expect(isFurnitureDeleteElement("plotArea")).toBe(false);
    expect(isFurnitureDeleteElement("chartArea")).toBe(false);
    expect(isFurnitureDeleteElement("title")).toBe(false);
    expect(isFurnitureDeleteElement(undefined)).toBe(false);
  });
});
