//! FILENAME: app/extensions/Charts/rendering/__tests__/elementSelectionPaintWiring.test.ts
// PURPOSE: Prove the element highlight is actually REACHED. A painter nobody
//          calls is the exact defect this work item exists to close — the
//          element ladder was correct, queryable and formattable for a whole
//          wave while `renderChart` step 3 had only two branches and drew
//          nothing at all for a selected title, axis title, legend or legend
//          entry.
// CONTEXT: `renderChart` itself is unreachable from a unit test (private
//          OffscreenCanvas caches, a live grid, a scroll offset), so the whole
//          of step 3 was lifted into `paintSelectionChrome`, which takes its
//          cached data, its sub-selection and the two environment facts as
//          plain arguments. This file drives THAT function, so "the branch
//          exists and passes the measured rects" is a behavioural assertion
//          rather than a grep over the source.
//
//          It also re-pins the lens rule across the extraction: at datum level
//          the 55% wash is SKIPPED while cues are visible, because it would
//          pale the very bars the lens exists to point at
//          (docs/design/insight-overlays.md section 5h).

import { describe, it, expect } from "vitest";
import { paintSelectionChrome } from "../chartRenderer";
import { elementSelectionBox } from "../selectionHighlight";
import type {
  BarRect,
  ChartLayout,
  ChartSpec,
  ChartSubSelection,
  HitGeometry,
} from "../../types";
import { makeRecordingCtx } from "./dispatch-recordingCtx";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function bars(): BarRect[] {
  const out: BarRect[] = [];
  for (let s = 0; s < 2; s++) {
    for (let c = 0; c < 3; c++) {
      out.push({
        seriesIndex: s,
        categoryIndex: c,
        x: 70 + c * 60 + s * 20,
        y: 120,
        width: 18,
        height: 160,
        value: 10 * c + s,
        seriesName: s === 0 ? "Sales" : "Cost",
        categoryName: `C${c}`,
      });
    }
  }
  return out;
}

function cached(): { hitGeometry: HitGeometry; layout: ChartLayout } {
  return {
    hitGeometry: { type: "bars", rects: bars() },
    layout: {
      width: 600,
      height: 400,
      margin: { top: 30, right: 20, bottom: 40, left: 55 },
      plotArea: { x: 63, y: 39, width: 451, height: 287 },
      elements: {
        family: "cartesian",
        chartArea: { x: 0, y: 0, width: 600, height: 400 },
        // Deliberately not where any margin arithmetic would put it.
        title: { x: 173, y: 9, width: 181, height: 23 },
        xAxisTitle: { x: 241, y: 371, width: 103, height: 15 },
        yAxisTitle: { x: 7, y: 137, width: 15, height: 121 },
        xAxisBand: { x: 61, y: 341, width: 517, height: 27 },
        yAxisBand: { x: 9, y: 41, width: 51, height: 299 },
        legend: { x: 471, y: 43, width: 113, height: 61 },
        legendItems: [
          { seriesIndex: 0, rect: { x: 475, y: 47, width: 101, height: 17 } },
          { seriesIndex: 1, rect: { x: 475, y: 69, width: 101, height: 17 } },
        ],
        measured: ["title", "legend"],
      },
    },
  };
}

const SPEC = { type: "bar" } as unknown as ChartSpec;

const CALM = { lensOn: false, textEditing: false };

function paint(
  sub: ChartSubSelection,
  opts: { lensOn: boolean; textEditing: boolean } = CALM,
  chartX = 0,
  chartY = 0,
): string[] {
  const r = makeRecordingCtx();
  paintSelectionChrome(r.ctx, chartX, chartY, cached(), SPEC, sub, opts);
  return r.calls;
}

function borderCall(
  rect: { x: number; y: number; width: number; height: number },
  chartX = 0,
  chartY = 0,
): string {
  const box = elementSelectionBox(rect);
  return `strokeRect(${chartX + box.x + 0.5},${chartY + box.y + 0.5},${box.width - 1},${box.height - 1})`;
}

// ---------------------------------------------------------------------------

describe("the element branch is reached from the renderer's step 3", () => {
  const el = cached().layout.elements!;

  it("boxes a selected title at its MEASURED rect", () => {
    const calls = paint({ level: "element", elementId: "title" }, CALM, 40, 25);
    expect(calls).toContain(borderCall(el.title!, 40, 25));
    expect(calls.filter((c) => c.startsWith("fillRect("))).toHaveLength(6);
  });

  it("boxes each of the other selectable elements at its own rect", () => {
    expect(paint({ level: "element", elementId: "xAxisTitle" })).toContain(borderCall(el.xAxisTitle!));
    expect(paint({ level: "element", elementId: "yAxisTitle" })).toContain(borderCall(el.yAxisTitle!));
    expect(paint({ level: "element", elementId: "legend" })).toContain(borderCall(el.legend!));
    expect(paint({ level: "element", elementId: "plotArea" })).toContain(borderCall(cached().layout.plotArea));
  });

  it("boxes the entry the ladder drilled into, and a different one per series", () => {
    const zero = paint({ level: "element", elementId: "legendEntry", seriesIndex: 0 });
    const one = paint({ level: "element", elementId: "legendEntry", seriesIndex: 1 });
    expect(zero).toContain(borderCall(el.legendItems![0].rect));
    expect(one).toContain(borderCall(el.legendItems![1].rect));
    expect(zero).not.toEqual(one);
  });

  it("draws nothing for an element level with no elementId", () => {
    expect(paint({ level: "element" })).toEqual([]);
  });

  it("stands down behind the open text editor, but only for the text elements", () => {
    const editing = { lensOn: false, textEditing: true };
    expect(paint({ level: "element", elementId: "title" }, editing)).toEqual([]);
    expect(paint({ level: "element", elementId: "xAxisTitle" }, editing)).toEqual([]);
    expect(paint({ level: "element", elementId: "yAxisTitle" }, editing)).toEqual([]);
    expect(paint({ level: "element", elementId: "legend" }, editing)).toContain(borderCall(el.legend!));
  });

  it("never washes the bars for an element selection", () => {
    // Selecting a title says nothing about the data, so nothing is dimmed —
    // which is also why the element branch can never collide with the lens.
    for (const elementId of ["title", "legend", "plotArea"] as const) {
      const calls = paint({ level: "element", elementId });
      expect(calls.join("|"), elementId).not.toContain("rgba(255, 255, 255, 0.55)");
    }
  });
});

describe("the other branches still do what they did", () => {
  it("washes the unselected bars at dataPoint level", () => {
    const calls = paint({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 });
    expect(calls).toContain("fillStyle=rgba(255, 255, 255, 0.55)");
    // Five bars washed, plus the six handle squares on the selected one.
    expect(calls.filter((c) => c.startsWith("fillRect("))).toHaveLength(5 + 6);
    expect(calls.filter((c) => c.startsWith("strokeRect("))).toHaveLength(1);
  });

  it("SKIPS the wash while an insight lens is on the chart — settled precedent", () => {
    const calls = paint({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 }, { lensOn: true, textEditing: false });
    expect(calls.join("|")).not.toContain("rgba(255, 255, 255, 0.55)");
    // The outline alone, plus the handles: unmistakable, and no marked bar is paled.
    expect(calls.filter((c) => c.startsWith("strokeRect("))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("fillRect("))).toHaveLength(6);
  });

  it("draws the dashed axis band at axis level", () => {
    const calls = paint({ level: "axis", axisType: "x" });
    expect(calls).toContain("setLineDash([4 3])");
    expect(calls).toContain("fillStyle=rgba(14, 99, 156, 0.08)");
  });

  it("draws nothing at chart level or none level", () => {
    expect(paint({ level: "chart" })).toEqual([]);
    expect(paint({ level: "none" })).toEqual([]);
  });
});
