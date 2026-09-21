//! FILENAME: app/extensions/Charts/rendering/__tests__/selectionHighlight.test.ts
// PURPOSE: The wash rule — "this one, not those" must not pale the very
//          elements a lens on the same chart exists to point at.
// CONTEXT: The overlay is painted AFTER the selection highlight, so with the
//          wash on, selecting one marked bar leaves every OTHER marked bar
//          pale with its ring still drawn over the ghost. The reader clicked a
//          bar; the answer must not be "three rings, one round a bar and two
//          round ghosts". With a lens on the chart the selection is an outline
//          alone.
//
//          These are drawing tests over a recording context: what matters is
//          which calls are issued, not what they look like.

import { describe, it, expect } from "vitest";
import {
  drawBarSelectionHighlights,
  drawPointSelectionHighlights,
  drawSliceSelectionHighlights,
} from "../selectionHighlight";
import type { BarRect, PointMarker, SliceArc } from "../../types";

interface Call {
  fn: string;
  args: unknown[];
}

function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (fn: string) => (...args: unknown[]) => { calls.push({ fn, args }); };
  const ctx = {
    save: rec("save"), restore: rec("restore"), beginPath: rec("beginPath"),
    closePath: rec("closePath"), arc: rec("arc"), ellipse: rec("ellipse"),
    moveTo: rec("moveTo"), lineTo: rec("lineTo"),
    stroke: rec("stroke"), fill: rec("fill"),
    strokeRect: rec("strokeRect"), fillRect: rec("fillRect"),
    setLineDash: rec("setLineDash"),
    strokeStyle: "", fillStyle: "", lineWidth: 0,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function bars(): BarRect[] {
  return [0, 1, 2, 3].map((categoryIndex) => ({
    x: categoryIndex * 30, y: 10, width: 20, height: 80,
    seriesIndex: 0, categoryIndex, seriesName: "Sales",
    categoryName: `C${categoryIndex}`, value: 10 * categoryIndex,
  })) as unknown as BarRect[];
}

function markers(): PointMarker[] {
  return [0, 1, 2].map((categoryIndex) => ({
    cx: categoryIndex * 30, cy: 50, radius: 4,
    seriesIndex: 0, categoryIndex, seriesName: "Sales",
    categoryName: `C${categoryIndex}`, value: 1,
  })) as unknown as PointMarker[];
}

function arcs(): SliceArc[] {
  return [0, 1, 2].map((seriesIndex) => ({
    centerX: 50, centerY: 50, outerRadius: 40, innerRadius: 0,
    startAngle: seriesIndex, endAngle: seriesIndex + 1,
    seriesIndex, seriesName: `S${seriesIndex}`, categoryIndex: 0,
    categoryName: "C0", value: 1,
  })) as unknown as SliceArc[];
}

/** The white wash over a non-selected element. */
function washes(calls: Call[]): Call[] {
  return calls.filter((c) => (c.fn === "fillRect" || c.fn === "fill"));
}

describe("the wash over non-selected elements", () => {
  it("dims the other bars by default, and outlines the selected one either way", () => {
    const { ctx, calls } = recordingCtx();
    drawBarSelectionHighlights(ctx, 0, 0, bars(), "dataPoint", 0, 1);

    expect(calls.filter((c) => c.fn === "strokeRect"), "the selected bar is outlined").toHaveLength(1);
    // Three unselected bars washed, plus the six handle squares on the selected one.
    expect(calls.filter((c) => c.fn === "fillRect")).toHaveLength(3 + 6);
  });

  // The regression the lens makes visible: a marked bar can now be selected,
  // and without this rule every OTHER marked bar goes pale under its ring.
  it("draws NO wash when a lens is on the chart, and still outlines the selection", () => {
    const { ctx, calls } = recordingCtx();
    drawBarSelectionHighlights(ctx, 0, 0, bars(), "dataPoint", 0, 1, false);

    expect(calls.filter((c) => c.fn === "strokeRect"), "the selection is still unmistakable").toHaveLength(1);
    // Only the six handle squares remain; no bar is washed.
    expect(calls.filter((c) => c.fn === "fillRect")).toHaveLength(6);
  });

  it("applies the same rule at SERIES level, where the whole series is the subject", () => {
    // Two series, so there is something to dim: series 0 is selected, series 1 is not.
    const twoSeries = [...bars(), ...bars().map((b) => ({ ...b, seriesIndex: 1, seriesName: "Cost" }))] as BarRect[];

    const withWash = recordingCtx();
    drawBarSelectionHighlights(withWash.ctx, 0, 0, twoSeries, "series", 0, undefined);
    expect(withWash.calls.filter((c) => c.fn === "fillRect"), "the other series is washed").toHaveLength(4);

    const without = recordingCtx();
    drawBarSelectionHighlights(without.ctx, 0, 0, twoSeries, "series", 0, undefined, false);
    expect(without.calls.filter((c) => c.fn === "fillRect")).toHaveLength(0);
    expect(without.calls.filter((c) => c.fn === "strokeRect")).toHaveLength(4); // every bar of the selected series
  });

  it("holds for line and scatter points too", () => {
    const withWash = recordingCtx();
    drawPointSelectionHighlights(withWash.ctx, 0, 0, markers(), "dataPoint", 0, 1);
    expect(washes(withWash.calls)).toHaveLength(2);

    const without = recordingCtx();
    drawPointSelectionHighlights(without.ctx, 0, 0, markers(), "dataPoint", 0, 1, false);
    expect(washes(without.calls)).toHaveLength(0);
    expect(without.calls.filter((c) => c.fn === "stroke")).toHaveLength(1);
  });

  it("holds for pie slices too", () => {
    const withWash = recordingCtx();
    drawSliceSelectionHighlights(withWash.ctx, 0, 0, arcs(), "dataPoint", 1);
    expect(washes(withWash.calls)).toHaveLength(2);

    const without = recordingCtx();
    drawSliceSelectionHighlights(without.ctx, 0, 0, arcs(), "dataPoint", 1, false);
    expect(washes(without.calls)).toHaveLength(0);
    expect(without.calls.filter((c) => c.fn === "stroke")).toHaveLength(1);
  });

  it("draws nothing at all for an empty geometry", () => {
    const b = recordingCtx();
    drawBarSelectionHighlights(b.ctx, 0, 0, [], "dataPoint", 0, 0, false);
    expect(b.calls).toEqual([]);
    const p = recordingCtx();
    drawPointSelectionHighlights(p.ctx, 0, 0, [], "dataPoint", 0, 0, false);
    expect(p.calls).toEqual([]);
  });
});
