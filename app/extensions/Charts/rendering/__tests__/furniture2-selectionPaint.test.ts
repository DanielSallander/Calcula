//! FILENAME: app/extensions/Charts/rendering/__tests__/furniture2-selectionPaint.test.ts
// PURPOSE: A selected trendline, error-bar set, data label or data table must be
//          VISIBLE — and each must be painted in ITS OWN SHAPE.
//
// A TRENDLINE IS NOT A BOX, and this is the whole reason it needed a painter of
// its own rather than a sixth caller of the rect painter. Its bounding box is
// useless as chrome for exactly the reason it is useless as a hit target: a fit
// running from the plot's bottom-left to its top-right has a box covering the
// entire plot, so boxing it would say "the whole plot is selected" and would
// draw a frame on top of every bar underneath. The same refusal already settled
// the hit test (distance to the nearest SEGMENT, not `rectContains`) and the
// insight ring (docs/design/insight-overlays.md section 5h).
//
// ERROR BARS ARE MANY BOXES AND ONE OBJECT. Excel has no per-point error bar, so
// selecting one selects the series' whole set, and the chrome has to say so. The
// alternative — a single union box — would span most of the plot and claim the
// empty space between the bars as part of the object.
//
// These are drawing tests over a recording context: what matters is which calls
// are issued and with which numbers.

import { describe, it, expect } from "vitest";
import {
  CHART_SELECTION_COLOR,
  drawElementSelectionHighlight,
  drawErrorBarsSelectionHighlight,
  drawTrendlineSelectionHighlight,
  elementSelectionBox,
  elementSelectionRect,
} from "../selectionHighlight";
import type { ChartElementRect, ChartLayout } from "../../types";
import { makeRecordingCtx } from "./dispatch-recordingCtx";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Series 0 carries TWO trendlines whose polylines run in DIFFERENT directions,
 * so a painter that matched on the series alone paints visibly the wrong line
 * rather than accidentally the right one.
 */
function layout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 30, right: 20, bottom: 40, left: 55 },
    plotArea: { x: 63, y: 39, width: 451, height: 287 },
    elements: {
      family: "cartesian",
      chartArea: { x: 0, y: 0, width: 600, height: 400 },
      trendlines: [
        { seriesIndex: 0, trendlineIndex: 0, points: [{ x: 71, y: 311 }, { x: 509, y: 97 }] },
        { seriesIndex: 0, trendlineIndex: 1, points: [{ x: 71, y: 97 }, { x: 289, y: 203 }, { x: 509, y: 311 }] },
      ],
      errorBars: [
        { seriesIndex: 0, rect: { x: 121, y: 133, width: 7, height: 39 } },
        { seriesIndex: 0, rect: { x: 213, y: 157, width: 7, height: 31 } },
        { seriesIndex: 1, rect: { x: 305, y: 111, width: 7, height: 47 } },
      ],
      dataLabels: [
        { seriesIndex: 0, pointIndex: 0, rect: { x: 113, y: 117, width: 23, height: 11 } },
        { seriesIndex: 0, pointIndex: 1, rect: { x: 205, y: 141, width: 23, height: 11 } },
        { seriesIndex: 1, pointIndex: 0, rect: { x: 297, y: 95, width: 23, height: 11 } },
      ],
      dataTable: { x: 67, y: 331, width: 443, height: 43 },
      measured: [],
    },
  };
}

const borderCall = (rect: ChartElementRect, x = 0, y = 0): string => {
  const box = elementSelectionBox(rect);
  return `strokeRect(${x + box.x + 0.5},${y + box.y + 0.5},${box.width - 1},${box.height - 1})`;
};

// ===========================================================================

describe("a trendline is painted as a LINE", () => {
  it("re-strokes the recorded polyline, never a box around it", () => {
    const lay = layout();
    const r = makeRecordingCtx();
    expect(drawTrendlineSelectionHighlight(r.ctx, 0, 0, lay, 0, 1)).toBe(true);

    const line = lay.elements!.trendlines![1].points;
    expect(r.calls).toContain("beginPath()");
    expect(r.calls).toContain(`moveTo(${line[0].x},${line[0].y})`);
    for (let i = 1; i < line.length; i++) {
      expect(r.calls).toContain(`lineTo(${line[i].x},${line[i].y})`);
    }
    expect(r.calls).toContain("stroke()");
    // THE REFUSAL, asserted rather than merely true: no box, at any size.
    expect(r.calls.filter((c) => c.startsWith("strokeRect("))).toEqual([]);
  });

  it("picks the line by its ORDINAL, so two fits on one series are told apart", () => {
    const lay = layout();
    const a = makeRecordingCtx();
    drawTrendlineSelectionHighlight(a.ctx, 0, 0, lay, 0, 0);
    const b = makeRecordingCtx();
    drawTrendlineSelectionHighlight(b.ctx, 0, 0, lay, 0, 1);
    expect(a.calls).not.toEqual(b.calls);
    // Trendline 0 is a straight two-point fit; trendline 1 has three points.
    expect(a.calls.filter((c) => c.startsWith("lineTo("))).toHaveLength(1);
    expect(b.calls.filter((c) => c.startsWith("lineTo("))).toHaveLength(2);
  });

  it("puts a handle on each END, and only on the ends", () => {
    // A line has two ends and nothing in between to drag. Six squares would be
    // chrome describing a rectangle that is not there.
    const lay = layout();
    const r = makeRecordingCtx();
    drawTrendlineSelectionHighlight(r.ctx, 10, 20, lay, 0, 1);
    const pts = lay.elements!.trendlines![1].points;
    const handles = r.calls.filter((c) => c.startsWith("fillRect("));
    expect(handles).toEqual([
      `fillRect(${10 + pts[0].x - 2.5},${20 + pts[0].y - 2.5},5,5)`,
      `fillRect(${10 + pts[2].x - 2.5},${20 + pts[2].y - 2.5},5,5)`,
    ]);
    expect(r.calls).toContain(`fillStyle=${CHART_SELECTION_COLOR}`);
  });

  it("is offset by the chart origin, like every other highlight", () => {
    const lay = layout();
    const r = makeRecordingCtx();
    drawTrendlineSelectionHighlight(r.ctx, 40, 25, lay, 0, 0);
    expect(r.calls).toContain("moveTo(111,336)");
  });

  it("paints nothing when the trendline was not drawn", () => {
    const bare = layout();
    delete bare.elements!.trendlines;
    const r = makeRecordingCtx();
    expect(drawTrendlineSelectionHighlight(r.ctx, 0, 0, bare, 0, 0)).toBe(false);
    expect(r.calls).toEqual([]);

    // A recorded entry with fewer than two points is not a line.
    const degenerate = layout();
    degenerate.elements!.trendlines = [{ seriesIndex: 0, trendlineIndex: 0, points: [{ x: 1, y: 2 }] }];
    const d = makeRecordingCtx();
    expect(drawTrendlineSelectionHighlight(d.ctx, 0, 0, degenerate, 0, 0)).toBe(false);
  });

  it("saves and restores, so the selection stroke cannot leak into the overlay", () => {
    const r = makeRecordingCtx();
    drawTrendlineSelectionHighlight(r.ctx, 0, 0, layout(), 0, 0);
    expect(r.calls[0]).toBe("save()");
    expect(r.calls[r.calls.length - 1]).toBe("restore()");
  });
});

// ===========================================================================

describe("error bars are MANY boxes and ONE object", () => {
  it("boxes every bar of the selected series, and no other series'", () => {
    const lay = layout();
    const r = makeRecordingCtx();
    expect(drawErrorBarsSelectionHighlight(r.ctx, 0, 0, lay, 0)).toBe(true);
    const bars = lay.elements!.errorBars!;
    expect(r.calls).toContain(borderCall(bars[0].rect));
    expect(r.calls).toContain(borderCall(bars[1].rect));
    expect(r.calls).not.toContain(borderCall(bars[2].rect));
    expect(r.calls.filter((c) => c.startsWith("strokeRect("))).toHaveLength(2);
  });

  it("draws NO handles — no single box is the object", () => {
    const r = makeRecordingCtx();
    drawErrorBarsSelectionHighlight(r.ctx, 0, 0, layout(), 0);
    expect(r.calls.filter((c) => c.startsWith("fillRect("))).toEqual([]);
  });

  it("refuses a rung with no series rather than highlighting every series' bars", () => {
    // An error-bar rung without a series is a rung that was never produced.
    // Highlighting everything for it would invent an object the pane cannot
    // target — the dead-member defect in its other direction.
    const r = makeRecordingCtx();
    expect(drawErrorBarsSelectionHighlight(r.ctx, 0, 0, layout(), undefined)).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it("paints nothing for a series that has no bars", () => {
    const r = makeRecordingCtx();
    expect(drawErrorBarsSelectionHighlight(r.ctx, 0, 0, layout(), 9)).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it("never washes anything", () => {
    // Settled precedent: element selection dims nothing, so there is no flag to
    // get wrong when an insight lens is on the same chart.
    const r = makeRecordingCtx();
    drawErrorBarsSelectionHighlight(r.ctx, 0, 0, layout(), 0);
    expect(r.calls.join("|")).not.toContain("rgba(255, 255, 255, 0.55)");
  });
});

// ===========================================================================

describe("a data label is per POINT", () => {
  it("boxes the measured rect of THAT point's label", () => {
    const lay = layout();
    const r = makeRecordingCtx();
    expect(
      drawElementSelectionHighlight(r.ctx, 0, 0, lay, "dataLabel", 0, { categoryIndex: 1 }),
    ).toBe(true);
    expect(r.calls).toContain(borderCall(lay.elements!.dataLabels![1].rect));
    expect(r.calls).not.toContain(borderCall(lay.elements!.dataLabels![0].rect));
  });

  it("requires BOTH indices — a series alone names no label", () => {
    const lay = layout();
    expect(elementSelectionRect(lay, "dataLabel", 0)).toBeUndefined();
    expect(elementSelectionRect(lay, "dataLabel", undefined, 1)).toBeUndefined();
    expect(elementSelectionRect(lay, "dataLabel", 0, 1)).toEqual(lay.elements!.dataLabels![1].rect);
  });

  it("paints NOTHING when the point has gone, rather than boxing a neighbour", () => {
    // Deliberately unlike a legend entry, which falls back to the whole legend:
    // "some other label of this series" would be a box over a datum the reader
    // never selected, which is worse than silence.
    const r = makeRecordingCtx();
    expect(
      drawElementSelectionHighlight(r.ctx, 0, 0, layout(), "dataLabel", 0, { categoryIndex: 9 }),
    ).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it("tells series 0's label from series 1's at the same point index", () => {
    const lay = layout();
    expect(elementSelectionRect(lay, "dataLabel", 0, 0)).toEqual(lay.elements!.dataLabels![0].rect);
    expect(elementSelectionRect(lay, "dataLabel", 1, 0)).toEqual(lay.elements!.dataLabels![2].rect);
  });
});

// ===========================================================================

describe("the data table", () => {
  it("boxes the recorded grid", () => {
    const lay = layout();
    const r = makeRecordingCtx();
    expect(drawElementSelectionHighlight(r.ctx, 0, 0, lay, "dataTable")).toBe(true);
    expect(r.calls).toContain(borderCall(lay.elements!.dataTable!));
  });

  it("paints nothing when no table was drawn", () => {
    const lay = layout();
    delete lay.elements!.dataTable;
    const r = makeRecordingCtx();
    expect(drawElementSelectionHighlight(r.ctx, 0, 0, lay, "dataTable")).toBe(false);
    expect(r.calls).toEqual([]);
  });
});

// ===========================================================================

describe("the ONE entry point dispatches by shape", () => {
  it("routes trendline and errorBars away from the rect painter", () => {
    // `elementSelectionRect` deliberately answers undefined for these two, so a
    // caller cannot reach the box painter with a polyline. The dispatch inside
    // `drawElementSelectionHighlight` is what keeps them paintable anyway.
    const lay = layout();
    expect(elementSelectionRect(lay, "trendline", 0)).toBeUndefined();
    expect(elementSelectionRect(lay, "errorBars", 0)).toBeUndefined();

    const t = makeRecordingCtx();
    expect(
      drawElementSelectionHighlight(t.ctx, 0, 0, lay, "trendline", 0, { trendlineIndex: 0 }),
    ).toBe(true);
    expect(t.calls).toContain("stroke()");

    const e = makeRecordingCtx();
    expect(drawElementSelectionHighlight(e.ctx, 0, 0, lay, "errorBars", 1)).toBe(true);
    expect(e.calls.filter((c) => c.startsWith("strokeRect("))).toHaveLength(1);
  });

  it("carries the instance indices from the caller, not from the layout's order", () => {
    // If `drawElementSelectionHighlight` dropped `opts.trendlineIndex`, the
    // painter would fall back to the series' FIRST line and the two calls below
    // would be identical — the sabotage this pins.
    const lay = layout();
    const zero = makeRecordingCtx();
    drawElementSelectionHighlight(zero.ctx, 0, 0, lay, "trendline", 0, { trendlineIndex: 0 });
    const one = makeRecordingCtx();
    drawElementSelectionHighlight(one.ctx, 0, 0, lay, "trendline", 0, { trendlineIndex: 1 });
    expect(zero.calls).not.toEqual(one.calls);

    const p0 = makeRecordingCtx();
    drawElementSelectionHighlight(p0.ctx, 0, 0, lay, "dataLabel", 0, { categoryIndex: 0 });
    const p1 = makeRecordingCtx();
    drawElementSelectionHighlight(p1.ctx, 0, 0, lay, "dataLabel", 0, { categoryIndex: 1 });
    expect(p0.calls).not.toEqual(p1.calls);
  });
});
