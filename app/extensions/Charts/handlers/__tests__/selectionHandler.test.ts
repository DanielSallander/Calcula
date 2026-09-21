//! FILENAME: app/extensions/Charts/handlers/__tests__/selectionHandler.test.ts
// PURPOSE: The chart's selection ladder — that it climbs on EVERY geometry, that
//          a tremor between press and release does not cancel it, and that a
//          data refresh does not throw it away — plus the one thing it owes the
//          overlay: a ring must never outlive the selection that chose it.
// CONTEXT: The ladder is chart -> series -> dataPoint, and it is the ONLY
//          selection a chart has. The overlay's "selected cue" is not a second
//          selection the reader makes; it is a note of which ring sits on the
//          datum they just clicked. So when the reader leaves the chart, the
//          note goes with it — otherwise the context menu still offers to act
//          on a point of interest nobody is looking at, which is the defect
//          the owner reported in its other form (a comment written onto a bar
//          they had already clicked away from).
//
//          The ladder itself was broken three ways and nothing pinned it:
//          (a) the click path hit-tested a bars-only cache field while HOVER
//              used the unified geometry, so hover and click disagreed about
//              the same pixel and a pie, donut, line, area, scatter, radar or
//              bubble chart had no selectable data points at all;
//          (b) Core fires `floatingObject:movePreview` on every mousemove once
//              a move drag is live and Charts cancelled the pending click on
//              all of them, so one pixel of hand jitter ate the advance;
//          (c) every CELLS_UPDATED dropped the reader back to chart level, so
//              typing in a source cell threw away "this one bar" mid-task.
//          The tests below are the pins for all three.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { hitTestGeometry } from "../../rendering/chartHitTesting";
import type { BarRect, PointMarker, SliceArc, ChartLayout, HitGeometry } from "../../types";

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

const handler = await import("../selectionHandler");
const cues = await import("@api/chartCues");

function ring(factId: string, categoryIndex: number, ordinal = 0) {
  return {
    cueId: `${factId}#${ordinal}`,
    factId,
    kind: "ring" as const,
    polarity: "neutral" as const,
    anchor: { type: "datum" as const, series: "Sales", categoryIndex, categoryLabel: `C${categoryIndex}` },
  };
}

const LAYOUT: ChartLayout = {
  width: 600,
  height: 400,
  plotArea: { x: 50, y: 20, width: 500, height: 340 },
  margin: { top: 20, right: 30, bottom: 40, left: 50 },
};

function bar(seriesIndex: number, categoryIndex: number, x: number): BarRect {
  return {
    seriesIndex,
    categoryIndex,
    x,
    y: 100,
    width: 30,
    height: 200,
    value: 10,
    seriesName: `S${seriesIndex}`,
    categoryName: `C${categoryIndex}`,
  };
}

function marker(seriesIndex: number, categoryIndex: number, cx: number): PointMarker {
  return {
    seriesIndex,
    categoryIndex,
    cx,
    cy: 150,
    radius: 5,
    value: 10,
    seriesName: `S${seriesIndex}`,
    categoryName: `C${categoryIndex}`,
  };
}

/** A quarter-turn slice. `seriesIndex` walks CATEGORIES for radial marks. */
function slice(seriesIndex: number, startAngle: number): SliceArc {
  return {
    seriesIndex,
    startAngle,
    endAngle: startAngle + Math.PI / 2,
    innerRadius: 0,
    outerRadius: 100,
    centerX: 300,
    centerY: 200,
    value: 25,
    label: `C${seriesIndex}`,
    percent: 25,
  };
}

beforeEach(() => {
  handler.resetSelectionHandlerState();
  cues.clearAllChartCues();
});

describe("the selection ladder", () => {
  it("climbs chart -> series -> dataPoint on repeated clicks of one bar", () => {
    handler.selectChart("c1");
    expect(handler.getSubSelection().level).toBe("chart");

    handler.advanceSelection("c1", { type: "bar", seriesIndex: 0, categoryIndex: 3 } as never);
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 0 });

    handler.advanceSelection("c1", { type: "bar", seriesIndex: 0, categoryIndex: 3 } as never);
    expect(handler.getSubSelection()).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: 3 });
  });

  it("leaves the datum ladder for the PLOT AREA's own rung, not for chart level", () => {
    // The plot background is a selectable element in its own right (Excel's
    // "Plot Area"), and it used to funnel into `{ level: "chart" }` — which is
    // why the keyboard could stand on a rung the mouse could never produce.
    handler.selectChart("c1");
    handler.advanceSelection("c1", { type: "bar", seriesIndex: 0, categoryIndex: 3 } as never);
    handler.advanceSelection("c1", { type: "plotArea" } as never);
    expect(handler.getSubSelection()).toEqual({ level: "element", elementId: "plotArea" });
  });

  it("drops back to chart level on the CHART AREA — the mouse's way back out", () => {
    handler.selectChart("c1");
    handler.advanceSelection("c1", { type: "bar", seriesIndex: 0, categoryIndex: 3 } as never);
    handler.advanceSelection("c1", { element: "chartArea" } as never);
    expect(handler.getSubSelection().level).toBe("chart");
  });
});

// ============================================================================
// (a) The ladder climbs on EVERY geometry, not only on bars
// ============================================================================

describe("the ladder climbs whatever the reader actually clicked", () => {
  /**
   * The pixel is hit-tested through the SAME unified entry point hover uses,
   * so these cases are the ones a reader gets. Before the fix the click path
   * ran a bars-only hit test against a bars-only cache field that was [] for
   * points and slices: the hit came back `plotArea`/`none` and the ladder
   * dropped to chart level on every click of a pie wedge or a line marker.
   */
  const cases: Array<{ name: string; geometry: HitGeometry; x: number; y: number; series: number; category: number }> = [
    {
      name: "bars",
      geometry: { type: "bars", rects: [bar(0, 0, 100), bar(1, 0, 135), bar(0, 1, 200)] },
      x: 145,
      y: 150,
      series: 1,
      category: 0,
    },
    {
      name: "points",
      geometry: { type: "points", markers: [marker(0, 0, 120), marker(0, 1, 220), marker(1, 1, 320)] },
      x: 220,
      y: 150,
      series: 0,
      category: 1,
    },
    {
      name: "slices",
      // Radial: a slice IS its category, so the hit reports categoryIndex = seriesIndex.
      geometry: { type: "slices", arcs: [slice(0, 0), slice(1, Math.PI / 2), slice(2, Math.PI)] },
      // Up and to the left of the centre: atan2(-20, -60) normalises to ~3.46
      // rad, inside the third quarter-turn [PI, 3PI/2].
      x: 240,
      y: 180,
      series: 2,
      category: 2,
    },
    {
      name: "composite (a faceted/repeated chart's panels)",
      geometry: {
        type: "composite",
        groups: [
          { type: "bars", rects: [bar(0, 0, 100)] },
          { type: "bars", rects: [bar(0, 1, 300)] },
        ],
      },
      x: 315,
      y: 150,
      series: 0,
      category: 1,
    },
  ];

  for (const c of cases) {
    it(`climbs chart -> series -> dataPoint on ${c.name}`, () => {
      handler.selectChart("chart-geo");
      expect(handler.getSubSelection().level).toBe("chart");

      const hit = hitTestGeometry(c.x, c.y, c.geometry, LAYOUT);
      expect(hit.type, "the pixel must resolve to a datum, not the plot background").not.toBe("plotArea");
      expect(hit.type).not.toBe("none");

      handler.advanceSelection("chart-geo", hit);
      expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: c.series });

      handler.advanceSelection("chart-geo", hitTestGeometry(c.x, c.y, c.geometry, LAYOUT));
      expect(handler.getSubSelection()).toMatchObject({
        level: "dataPoint",
        seriesIndex: c.series,
        categoryIndex: c.category,
      });
    });
  }

  it("switches series rather than advancing when the second click is a different series", () => {
    const geometry: HitGeometry = { type: "bars", rects: [bar(0, 0, 100), bar(1, 0, 135)] };
    handler.selectChart("chart-geo");
    handler.advanceSelection("chart-geo", hitTestGeometry(110, 150, geometry, LAYOUT));
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 0 });
    handler.advanceSelection("chart-geo", hitTestGeometry(145, 150, geometry, LAYOUT));
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 1 });
  });
});

// ============================================================================
// (b) One pixel of jitter must not cancel the click
// ============================================================================

describe("a tremor between press and release is not a drag", () => {
  it("keeps the pending click for a move preview inside Core's own dead zone", () => {
    handler.selectChart("c1");
    handler.notePressOrigin("c1", 400, 300);
    handler.setPendingClick("c1", 410, 310);

    // Core fires a preview on EVERY mousemove once the drag is live.
    expect(handler.noteMovePreview("c1", 401, 300)).toBe(false);
    expect(handler.noteMovePreview("c1", 403, 297)).toBe(false);

    expect(
      handler.consumePendingClick(),
      "a press that Core itself does not consider a move must still read as a click",
    ).toMatchObject({ chartId: "c1" });
  });

  it("cancels the pending click once the press leaves the dead zone", () => {
    handler.selectChart("c1");
    handler.notePressOrigin("c1", 400, 300);
    handler.setPendingClick("c1", 410, 310);

    expect(handler.noteMovePreview("c1", 402, 302)).toBe(false);
    expect(handler.noteMovePreview("c1", 404, 300)).toBe(true);

    expect(handler.consumePendingClick(), "a real drag must not end in a ladder advance").toBeNull();
  });

  it("treats exactly the threshold as jitter and one pixel past it as a move", () => {
    handler.notePressOrigin("c1", 0, 0);
    expect(handler.MOVE_JITTER_THRESHOLD_PX).toBe(3);
    expect(handler.noteMovePreview("c1", 3, -3)).toBe(false);
    expect(handler.noteMovePreview("c1", 0, -4)).toBe(true);
  });

  it("stays a drag after coming back inside the dead zone, exactly as Core's hasMoved does", () => {
    handler.selectChart("c1");
    handler.notePressOrigin("c1", 400, 300);
    handler.setPendingClick("c1", 410, 310);

    expect(handler.noteMovePreview("c1", 460, 300)).toBe(true);
    handler.setPendingClick("c1", 410, 310); // as if something re-armed it
    expect(handler.noteMovePreview("c1", 401, 301)).toBe(true);
    expect(handler.consumePendingClick()).toBeNull();
  });

  it("takes an unrecorded press at face value (a programmatic move is a move)", () => {
    handler.selectChart("c1");
    handler.setPendingClick("c1", 410, 310);
    expect(handler.noteMovePreview("c1", 400, 300)).toBe(true);
    expect(handler.consumePendingClick()).toBeNull();
  });
});

// ============================================================================
// (c) A data refresh must not throw the selection away
// ============================================================================

describe("surviving a data refresh", () => {
  const OLD: HitGeometry = { type: "bars", rects: [bar(0, 0, 100), bar(0, 1, 140), bar(0, 2, 180)] };

  function selectPoint(chartId: string, seriesIndex: number, categoryIndex: number) {
    handler.selectChart(chartId);
    handler.advanceSelection(chartId, { type: "bar", seriesIndex, categoryIndex } as never);
    handler.advanceSelection(chartId, { type: "bar", seriesIndex, categoryIndex } as never);
  }

  it("keeps the data point when its datum still exists in the refreshed geometry", () => {
    selectPoint("c1", 0, 2);
    const oldCache = { hitGeometry: OLD };
    handler.markSubSelectionStale(oldCache);

    const newCache = { hitGeometry: { type: "bars", rects: [bar(0, 0, 100), bar(0, 1, 140), bar(0, 2, 180)] } as HitGeometry };
    expect(handler.revalidateSubSelection("c1", newCache, newCache.hitGeometry)).toBe(false);
    expect(handler.getSubSelection()).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: 2 });
    expect(handler.isSubSelectionStale()).toBe(false);
  });

  it("drops to chart level when the pivot's category set SHRANK under it", () => {
    selectPoint("c1", 0, 2);
    const oldCache = { hitGeometry: OLD };
    handler.markSubSelectionStale(oldCache);

    const newCache = { hitGeometry: { type: "bars", rects: [bar(0, 0, 100), bar(0, 1, 140)] } as HitGeometry };
    expect(handler.revalidateSubSelection("c1", newCache, newCache.hitGeometry)).toBe(true);
    expect(handler.getSubSelection().level).toBe("chart");
  });

  it("decides NOTHING while the cache is still the pre-edit one", () => {
    // The re-read is async: at the moment the edit lands the data cache still
    // holds the old geometry. Checking against it would pass and clear the
    // flag, and the short data that arrives a frame later would never be seen.
    selectPoint("c1", 0, 2);
    const oldCache = { hitGeometry: OLD };
    handler.markSubSelectionStale(oldCache);

    expect(handler.revalidateSubSelection("c1", oldCache, OLD)).toBe(false);
    expect(handler.isSubSelectionStale(), "the check must still be pending").toBe(true);

    const newCache = { hitGeometry: { type: "bars", rects: [bar(0, 0, 100), bar(0, 1, 140)] } as HitGeometry };
    expect(handler.revalidateSubSelection("c1", newCache, newCache.hitGeometry)).toBe(true);
    expect(handler.getSubSelection().level).toBe("chart");
  });

  it("keeps a SERIES selection while any datum of that series survives", () => {
    handler.selectChart("c1");
    handler.advanceSelection("c1", { type: "bar", seriesIndex: 1, categoryIndex: 0 } as never);
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 1 });

    const oldCache = { hitGeometry: OLD };
    handler.markSubSelectionStale(oldCache);
    const newCache = { hitGeometry: { type: "bars", rects: [bar(1, 0, 100)] } as HitGeometry };
    expect(handler.revalidateSubSelection("c1", newCache, newCache.hitGeometry)).toBe(false);
    expect(handler.getSubSelection()).toMatchObject({ level: "series", seriesIndex: 1 });
  });

  it("drops a SERIES selection when the series itself is gone", () => {
    handler.selectChart("c1");
    handler.advanceSelection("c1", { type: "bar", seriesIndex: 1, categoryIndex: 0 } as never);

    const oldCache = { hitGeometry: OLD };
    handler.markSubSelectionStale(oldCache);
    const newCache = { hitGeometry: OLD };
    expect(handler.revalidateSubSelection("c1", newCache, newCache.hitGeometry)).toBe(true);
    expect(handler.getSubSelection().level).toBe("chart");
  });

  it("drops to chart level when the chart has no geometry at all any more", () => {
    selectPoint("c1", 0, 2);
    handler.markSubSelectionStale({ hitGeometry: OLD });
    expect(handler.revalidateSubSelection("c1", null, null)).toBe(true);
    expect(handler.getSubSelection().level).toBe("chart");
  });

  it("never marks a chart-level or axis selection stale — there are no indices to lose", () => {
    handler.selectChart("c1");
    handler.markSubSelectionStale({});
    expect(handler.isSubSelectionStale()).toBe(false);

    handler.advanceSelection("c1", { type: "axis", axisType: "x" } as never);
    handler.markSubSelectionStale({});
    expect(handler.isSubSelectionStale()).toBe(false);
  });

  it("ignores a re-validation aimed at some other chart", () => {
    selectPoint("c1", 0, 2);
    const oldCache = { hitGeometry: OLD };
    handler.markSubSelectionStale(oldCache);

    const empty: HitGeometry = { type: "bars", rects: [] };
    expect(handler.revalidateSubSelection("c2", { hitGeometry: empty }, empty)).toBe(false);
    expect(handler.getSubSelection()).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: 2 });
    expect(handler.isSubSelectionStale(), "c1's pending check is still c1's").toBe(true);
  });

  it("validates a pie selection against the SLICES, where a slice is its own category", () => {
    handler.selectChart("pie");
    handler.advanceSelection("pie", { type: "slice", seriesIndex: 2, categoryIndex: 2 } as never);
    handler.advanceSelection("pie", { type: "slice", seriesIndex: 2, categoryIndex: 2 } as never);
    expect(handler.getSubSelection()).toMatchObject({ level: "dataPoint", seriesIndex: 2, categoryIndex: 2 });

    const three: HitGeometry = { type: "slices", arcs: [slice(0, 0), slice(1, Math.PI / 2), slice(2, Math.PI)] };
    handler.markSubSelectionStale({ hitGeometry: three });

    const stillThree: HitGeometry = { type: "slices", arcs: [slice(0, 0), slice(1, Math.PI / 2), slice(2, Math.PI)] };
    expect(handler.revalidateSubSelection("pie", { g: stillThree }, stillThree)).toBe(false);
    expect(handler.getSubSelection()).toMatchObject({ level: "dataPoint", seriesIndex: 2 });

    handler.markSubSelectionStale({ hitGeometry: stillThree });
    const two: HitGeometry = { type: "slices", arcs: [slice(0, 0), slice(1, Math.PI / 2)] };
    expect(handler.revalidateSubSelection("pie", { g: two }, two)).toBe(true);
    expect(handler.getSubSelection().level).toBe("chart");
  });

  it("looks inside a composite geometry's panels", () => {
    selectPoint("c1", 0, 1);
    handler.markSubSelectionStale({ hitGeometry: OLD });
    const composite: HitGeometry = {
      type: "composite",
      groups: [
        { type: "bars", rects: [bar(0, 0, 100)] },
        { type: "points", markers: [marker(0, 1, 300)] },
      ],
    };
    expect(handler.revalidateSubSelection("c1", { g: composite }, composite)).toBe(false);
    expect(handler.getSubSelection()).toMatchObject({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 });
  });

  it("forgets a pending check when the reader leaves the chart", () => {
    selectPoint("c1", 0, 2);
    handler.markSubSelectionStale({ hitGeometry: OLD });
    handler.deselectChart();
    expect(handler.isSubSelectionStale()).toBe(false);
  });
});

describe("leaving a chart", () => {
  it("takes the selected ring with it", () => {
    cues.setChartCues("c1", [ring("extremes", 4), ring("extremes", 2, 1)]);
    cues.setSelectedChartCue("c1", "extremes#1");
    handler.selectChart("c1");
    expect(cues.getSelectedChartCue("c1")).not.toBeNull();

    handler.deselectChart();

    expect(cues.getSelectedChartCue("c1"), "a ring must not outlive the chart's selection").toBeNull();
    // The cues themselves stay: the lens is still on, the reader just stepped away.
    expect(cues.getChartCues("c1")).toHaveLength(2);
  });

  it("does nothing when no chart was selected", () => {
    cues.setChartCues("c1", [ring("extremes", 4)]);
    cues.setSelectedChartCue("c1", "extremes#0");

    handler.deselectChart(); // never selected c1

    expect(cues.getSelectedChartCue("c1")?.cueId).toBe("extremes#0");
  });

  it("clears the ring of the chart being LEFT, not of some other chart", () => {
    cues.setChartCues("c1", [ring("extremes", 4)]);
    cues.setChartCues("c2", [ring("extremes", 1)]);
    cues.setSelectedChartCue("c1", "extremes#0");
    cues.setSelectedChartCue("c2", "extremes#0");

    handler.selectChart("c1");
    handler.deselectChart();

    expect(cues.getSelectedChartCue("c1")).toBeNull();
    expect(cues.getSelectedChartCue("c2")?.cueId, "another chart's ring is none of its business").toBe("extremes#0");
  });
});
