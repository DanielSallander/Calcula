//! FILENAME: app/extensions/Charts/handlers/__tests__/chartKeyboardNav.test.ts
// PURPOSE: CI-10 — Excel's keyboard navigation of a chart, as a pure walk.
// CONTEXT: ACCESSIBILITY, not a nicety. A data point that another mark covers,
//          or that is two pixels wide, cannot be CLICKED. Arrow-walking is the
//          only way to reach it, which is why this is a requirement rather than
//          a convenience.
//
//          Up/Down walk element GROUPS; Left/Right walk MEMBERS inside the
//          group the reader is standing on. Escape steps UP one rung.
//
//          THE TWO SOURCES ARE THE CLICK'S OWN, deliberately:
//            * furniture comes from `layout.elements` (the MEASURED rects), so a
//              title that is not drawn is not in the walk — deriving it from the
//              SPEC instead would put a rung on an element the reader cannot
//              see, which is the dead-hit-result defect CHART_ELEMENT_IDS
//              exists to prevent;
//            * data rungs come from the HitGeometry, the very thing a click is
//              resolved against, so keyboard and mouse cannot disagree about
//              which datum exists. That also means the radial convention is
//              inherited rather than re-decided: `hitTestSliceArcs` reports a
//              slice as seriesIndex === pointIndex === arc.seriesIndex.

import { describe, it, expect } from "vitest";
import type {
  ChartLayout,
  ChartSubSelection,
  HitGeometry,
  BarRect,
  SliceArc,
  PointMarker,
} from "../../types";
import {
  buildChartNavGroups,
  findChartNavPosition,
  navigateChartSelection,
  escapeLevelUp,
  isChartAreaElement,
  CHART_AREA_ELEMENT_IDS,
} from "../selectionHandler";

// ============================================================================
// Fixtures
// ============================================================================

function rect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height };
}

/** A fully furnished cartesian chart: title, legend (2 entries), both axes + titles. */
function fullLayout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 20, right: 30, bottom: 40, left: 50 },
    plotArea: { x: 50, y: 20, width: 500, height: 340 },
    elements: {
      family: "cartesian",
      chartArea: rect(0, 0, 600, 400),
      title: rect(200, 2, 200, 18),
      xAxisTitle: rect(240, 380, 120, 14),
      yAxisTitle: rect(2, 160, 14, 80),
      xAxisBand: rect(50, 360, 500, 18),
      yAxisBand: rect(20, 20, 30, 340),
      legend: rect(480, 30, 100, 40),
      legendItems: [
        { seriesIndex: 0, rect: rect(480, 30, 100, 18) },
        { seriesIndex: 1, rect: rect(480, 50, 100, 18) },
      ],
      measured: [],
    },
  };
}

/** Nothing but the canvas: no title, no legend, no axis bands. */
function bareLayout(): ChartLayout {
  return {
    width: 300,
    height: 200,
    margin: { top: 10, right: 10, bottom: 10, left: 10 },
    plotArea: { x: 10, y: 10, width: 280, height: 180 },
    elements: {
      family: "radial",
      chartArea: rect(0, 0, 300, 200),
      measured: [],
    },
  };
}

function bar(seriesIndex: number, categoryIndex: number): BarRect {
  return {
    seriesIndex,
    categoryIndex,
    x: 10 * categoryIndex,
    y: 10,
    width: 8,
    height: 100,
    value: 1,
    seriesName: `S${seriesIndex}`,
    categoryName: `C${categoryIndex}`,
  };
}

function marker(seriesIndex: number, categoryIndex: number): PointMarker {
  return {
    seriesIndex,
    categoryIndex,
    cx: 10 * categoryIndex,
    cy: 20,
    radius: 4,
    value: 1,
    seriesName: `S${seriesIndex}`,
    categoryName: `C${categoryIndex}`,
  };
}

function arc(index: number): SliceArc {
  return {
    seriesIndex: index,
    startAngle: index,
    endAngle: index + 1,
    innerRadius: 0,
    outerRadius: 50,
    centerX: 100,
    centerY: 100,
    value: 1,
    label: `Slice${index}`,
  };
}

/** Two series of three categories each. */
const BARS: HitGeometry = {
  type: "bars",
  rects: [bar(0, 0), bar(0, 1), bar(0, 2), bar(1, 0), bar(1, 1), bar(1, 2)],
};

const ids = (layout: ChartLayout | null, geometry: HitGeometry | null) =>
  buildChartNavGroups(layout, geometry).map((g) => g.id);

// ============================================================================
// The groups
// ============================================================================

describe("buildChartNavGroups", () => {
  it("lists every present element group in a fixed, learnable order", () => {
    expect(ids(fullLayout(), BARS)).toEqual([
      "chartArea",
      "title",
      "legend",
      "plotArea",
      "xAxis",
      "yAxis",
      "xAxisTitle",
      "yAxisTitle",
      "series:0",
      "series:1",
    ]);
  });

  it("SKIPS furniture that is not drawn — the walk follows the measured rects", () => {
    // The defect this prevents: deriving the walk from the spec would offer a
    // rung on a title the reader cannot see, which is a rung they cannot leave
    // by clicking either.
    expect(ids(bareLayout(), BARS)).toEqual(["chartArea", "plotArea", "series:0", "series:1"]);
  });

  it("still yields the two areas every chart has, even with nothing rendered yet", () => {
    // The chart area and the plot area are unconditional — they are the chart —
    // so the walk always has somewhere to stand, even on the frame before the
    // first render has produced a layout or any geometry.
    expect(ids(null, null)).toEqual(["chartArea", "plotArea"]);
  });

  it("puts the whole thing first and its parts after, inside a group", () => {
    const groups = buildChartNavGroups(fullLayout(), BARS);
    const legend = groups.find((g) => g.id === "legend")!;
    expect(legend.members).toEqual([
      { level: "element", elementId: "legend" },
      { level: "element", elementId: "legendEntry", seriesIndex: 0 },
      { level: "element", elementId: "legendEntry", seriesIndex: 1 },
    ]);

    const series0 = groups.find((g) => g.id === "series:0")!;
    expect(series0.members).toEqual([
      { level: "series", seriesIndex: 0 },
      { level: "dataPoint", seriesIndex: 0, categoryIndex: 0 },
      { level: "dataPoint", seriesIndex: 0, categoryIndex: 1 },
      { level: "dataPoint", seriesIndex: 0, categoryIndex: 2 },
    ]);
  });

  it("reads point geometry the same way it reads bar geometry", () => {
    const points: HitGeometry = { type: "points", markers: [marker(0, 0), marker(0, 1)] };
    const groups = buildChartNavGroups(bareLayout(), points);
    expect(groups.find((g) => g.id === "series:0")!.members).toHaveLength(3);
  });

  it("inherits the radial convention instead of re-deciding it", () => {
    // `hitTestSliceArcs` reports a slice as seriesIndex === pointIndex, so each
    // slice walks as its own single-point series — exactly what CLICKING one
    // does. A different rule here would let the keyboard address a datum the
    // mouse cannot.
    const slices: HitGeometry = { type: "slices", arcs: [arc(0), arc(1), arc(2)] };
    expect(ids(bareLayout(), slices)).toEqual([
      "chartArea",
      "plotArea",
      "series:0",
      "series:1",
      "series:2",
    ]);
    const groups = buildChartNavGroups(bareLayout(), slices);
    expect(groups.find((g) => g.id === "series:1")!.members).toEqual([
      { level: "series", seriesIndex: 1 },
      { level: "dataPoint", seriesIndex: 1, categoryIndex: 1 },
    ]);
  });

  it("flattens a composite geometry into one group per series", () => {
    const composite: HitGeometry = {
      type: "composite",
      groups: [
        { type: "bars", rects: [bar(0, 0), bar(0, 1)] },
        { type: "points", markers: [marker(1, 0), marker(1, 1)] },
      ],
    };
    expect(ids(bareLayout(), composite)).toEqual([
      "chartArea",
      "plotArea",
      "series:0",
      "series:1",
    ]);
  });
});

// ============================================================================
// The walk
// ============================================================================

describe("navigateChartSelection", () => {
  const groups = buildChartNavGroups(fullLayout(), BARS);
  const walk = (from: ChartSubSelection, dir: Parameters<typeof navigateChartSelection>[2]) =>
    navigateChartSelection(groups, from, dir);

  it("Down steps to the next GROUP, entering it at its whole-thing member", () => {
    expect(walk({ level: "chart" }, "nextGroup")).toEqual({ level: "element", elementId: "title" });
    expect(walk({ level: "element", elementId: "title" }, "nextGroup")).toEqual({
      level: "element",
      elementId: "legend",
    });
  });

  it("Down from INSIDE a group leaves the group rather than walking its members", () => {
    expect(walk({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 }, "nextGroup")).toEqual({
      level: "series",
      seriesIndex: 1,
    });
  });

  it("Up steps to the previous group", () => {
    expect(walk({ level: "element", elementId: "legend" }, "prevGroup")).toEqual({
      level: "element",
      elementId: "title",
    });
  });

  it("wraps at both ends, so the keyboard can never strand the reader", () => {
    expect(walk({ level: "chart" }, "prevGroup")).toEqual({ level: "series", seriesIndex: 1 });
    expect(walk({ level: "series", seriesIndex: 1 }, "nextGroup")).toEqual({ level: "chart" });
  });

  it("Right walks the MEMBERS of the current group, and wraps", () => {
    expect(walk({ level: "series", seriesIndex: 0 }, "nextMember")).toEqual({
      level: "dataPoint",
      seriesIndex: 0,
      categoryIndex: 0,
    });
    expect(walk({ level: "dataPoint", seriesIndex: 0, categoryIndex: 2 }, "nextMember")).toEqual({
      level: "series",
      seriesIndex: 0,
    });
  });

  it("Left walks members backwards", () => {
    expect(walk({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 }, "prevMember")).toEqual({
      level: "dataPoint",
      seriesIndex: 0,
      categoryIndex: 0,
    });
    expect(walk({ level: "series", seriesIndex: 0 }, "prevMember")).toEqual({
      level: "dataPoint",
      seriesIndex: 0,
      categoryIndex: 2,
    });
  });

  it("walks legend ENTRIES with the same member rule", () => {
    expect(walk({ level: "element", elementId: "legend" }, "nextMember")).toEqual({
      level: "element",
      elementId: "legendEntry",
      seriesIndex: 0,
    });
    expect(
      walk({ level: "element", elementId: "legendEntry", seriesIndex: 0 }, "nextMember"),
    ).toEqual({ level: "element", elementId: "legendEntry", seriesIndex: 1 });
  });

  it("REACHES A COVERED DATUM: two Rights from a series select its third point", () => {
    // The accessibility claim, made concrete. Nothing here touches pixels, so a
    // bar hidden behind another is reachable on exactly the same terms.
    let at: ChartSubSelection = { level: "series", seriesIndex: 1 };
    at = walk(at, "nextMember")!;
    at = walk(at, "nextMember")!;
    at = walk(at, "nextMember")!;
    expect(at).toEqual({ level: "dataPoint", seriesIndex: 1, categoryIndex: 2 });
  });

  it("answers null for Left/Right inside a ONE-MEMBER group (nothing to walk)", () => {
    expect(walk({ level: "element", elementId: "title" }, "nextMember")).toBeNull();
    expect(walk({ level: "axis", axisType: "x" }, "prevMember")).toBeNull();
    expect(walk({ level: "chart" }, "nextMember")).toBeNull();
  });

  it("ENTERS the walk when the current selection is one it cannot name", () => {
    // Nothing selected, or a rung whose element has stopped being drawn since it
    // was chosen. Refusing would leave a reader with a chart selected and a dead
    // keyboard; entering at the first group always gives them somewhere to be.
    expect(walk({ level: "none" }, "nextGroup")).toEqual({ level: "chart" });
    expect(walk({ level: "series", seriesIndex: 99 }, "nextMember")).toEqual({ level: "chart" });
    expect(
      navigateChartSelection(buildChartNavGroups(bareLayout(), BARS), { level: "element", elementId: "title" }, "nextGroup"),
    ).toEqual({ level: "chart" });
  });

  it("answers null when there is no walk at all", () => {
    expect(navigateChartSelection([], { level: "chart" }, "nextGroup")).toBeNull();
  });

  it("tells two legend entries apart by the series they stand for", () => {
    const pos = findChartNavPosition(groups, {
      level: "element",
      elementId: "legendEntry",
      seriesIndex: 1,
    });
    expect(pos).toEqual({ groupIndex: 2, memberIndex: 2 });
  });

  it("tells two data points apart by BOTH indices", () => {
    expect(findChartNavPosition(groups, { level: "dataPoint", seriesIndex: 1, categoryIndex: 2 }))
      .toEqual({ groupIndex: 9, memberIndex: 3 });
    expect(findChartNavPosition(groups, { level: "dataPoint", seriesIndex: 1, categoryIndex: 9 }))
      .toBeNull();
  });

  it("walks the WHOLE chart with Down alone and returns to where it started", () => {
    let at: ChartSubSelection = { level: "chart" };
    const visited: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      visited.push(JSON.stringify(at));
      at = navigateChartSelection(groups, at, "nextGroup")!;
    }
    expect(new Set(visited).size).toBe(groups.length);
    expect(at).toEqual({ level: "chart" });
  });
});

// ============================================================================
// Delete has to mean something at every rung the walk can reach
// ============================================================================

describe("Delete coverage over the walk", () => {
  it("no furniture rung the keyboard can reach falls through to 'destroy the chart'", async () => {
    // The Delete listener in index.ts branches on the SUBJECT: a text element
    // clears its text, the legend hides itself, a legend ENTRY hides its own
    // row, the two AREAS consume the keystroke and do nothing, and everything
    // else deletes the whole chart. So this asserts the named branches cover
    // every element the walk can stand on.
    //
    // WHAT THIS USED TO BLESS, AND WHY IT WAS WRONG. The previous version
    // handled `plotArea` with the comment "the two areas ARE the chart;
    // deleting them deletes it, as in Excel" — meaning it fell through to the
    // destroy arm on purpose. That put a three-keystroke route from a selected
    // chart (Down, Down, Down, Delete) to no chart at all, on the rung a reader
    // selects precisely in order to FORMAT the plot area. The chart OBJECT is
    // `level: "chart"` — the rung with the border and the handles — and it is
    // the only rung whose Delete is destructive. `isChartAreaElement` is the
    // list the listener itself reads, so this cannot drift from it.
    //
    // Add a furniture group to `buildChartNavGroups` without giving Delete a
    // meaning for it and this goes red, naming the rung.
    const { isChartTextElement } = await import("../chartTextEditing");
    const groups = buildChartNavGroups(fullLayout(), BARS);

    const unhandled: string[] = [];
    for (const group of groups) {
      for (const member of group.members) {
        if (member.level !== "element") continue;
        const id = member.elementId!;
        const handled =
          isChartTextElement(id) ||
          id === "legend" ||
          id === "legendEntry" ||
          // A region has nothing smaller to remove: Delete is consumed and
          // does nothing, as it does in Excel.
          isChartAreaElement(id);
        if (!handled) unhandled.push(`${group.id}/${id}`);
      }
    }
    expect(unhandled).toEqual([]);
  });

  it("names the two areas, and nothing else, as the rungs Delete must not destroy", () => {
    // The coverage test above would still pass if `isChartAreaElement` said yes
    // to everything, so the list is pinned on its own.
    expect(CHART_AREA_ELEMENT_IDS).toEqual(["plotArea", "chartArea"]);
    expect(isChartAreaElement("plotArea")).toBe(true);
    expect(isChartAreaElement("chartArea")).toBe(true);
    expect(isChartAreaElement("legend")).toBe(false);
    expect(isChartAreaElement("title")).toBe(false);
    expect(isChartAreaElement(undefined)).toBe(false);
  });
});

// ============================================================================
// Escape
// ============================================================================

describe("escapeLevelUp", () => {
  it("steps a data point up to its own series", () => {
    expect(escapeLevelUp({ level: "dataPoint", seriesIndex: 2, categoryIndex: 5 })).toEqual({
      level: "series",
      seriesIndex: 2,
    });
  });

  it("steps a series up to the chart", () => {
    expect(escapeLevelUp({ level: "series", seriesIndex: 2 })).toEqual({ level: "chart" });
  });

  it("steps a legend ENTRY up to the whole legend, not straight to the chart", () => {
    expect(escapeLevelUp({ level: "element", elementId: "legendEntry", seriesIndex: 1 })).toEqual({
      level: "element",
      elementId: "legend",
    });
    expect(escapeLevelUp({ level: "element", elementId: "legend" })).toEqual({ level: "chart" });
  });

  it("steps any other element or axis up to the chart", () => {
    expect(escapeLevelUp({ level: "element", elementId: "title" })).toEqual({ level: "chart" });
    expect(escapeLevelUp({ level: "element", elementId: "plotArea" })).toEqual({ level: "chart" });
    expect(escapeLevelUp({ level: "axis", axisType: "y" })).toEqual({ level: "chart" });
  });

  it("answers null at chart level — that rung is 'leave the chart'", () => {
    expect(escapeLevelUp({ level: "chart" })).toBeNull();
    expect(escapeLevelUp({ level: "none" })).toBeNull();
  });

  it("climbs out of the deepest rung one Escape at a time", () => {
    // Three Escapes from a covered point: point -> series -> chart -> sheet.
    let at: ChartSubSelection | null = { level: "dataPoint", seriesIndex: 0, categoryIndex: 2 };
    at = escapeLevelUp(at);
    expect(at).toEqual({ level: "series", seriesIndex: 0 });
    at = escapeLevelUp(at!);
    expect(at).toEqual({ level: "chart" });
    expect(escapeLevelUp(at!)).toBeNull();
  });

  it("does not lose the chart when a data point carries no series index", () => {
    expect(escapeLevelUp({ level: "dataPoint" })).toEqual({ level: "chart" });
  });
});
