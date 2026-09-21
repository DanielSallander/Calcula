//! FILENAME: app/extensions/Charts/rendering/__tests__/elementSelectionPaint.test.ts
// PURPOSE: A selected chart title, axis title, legend, legend entry or plot
//          area must be VISIBLE. The ladder, the query surface and the format
//          pane were all correct while nothing drew a single pixel, which made
//          the slow-two-click route into the title editor undiscoverable: the
//          first click gave no feedback at all, so nobody ever tried a second
//          one.
//
// WHAT THESE TESTS ARE ACTUALLY GUARDING
// --------------------------------------
// 1. A DISTINCT call stream per element id. One shared "draw a box" that always
//    boxed the same rect would satisfy a weaker test ("something painted") and
//    still show the reader the title's box when they selected the legend.
// 2. The rect painted is the MEASURED rect out of the layout, never a box
//    re-derived from the margins. Every rect in `layout.elements` except
//    `chartArea` and `title` is a function of `margin`/`plotArea`, and several
//    stages edit those AFTER layout (the data table, the pivot field buttons,
//    the secondary axis, the horizontal-bar relayout) — a re-derived box would
//    be right on a plain chart and silently wrong on every one of those. The
//    fixture's rects are therefore deliberately INCONSISTENT with its margins,
//    so a painter that computed its own box would disagree with every assertion
//    here rather than accidentally agreeing with one.
// 3. Nothing paints when `layout.elements` is absent. A hand-built layout in a
//    test is allowed to omit it, and so is a chart type whose painter has not
//    recorded rects yet; the answer is silence, not a box at 0,0. `plotArea` is
//    the stated exception and has its own test — it is read off `layout` itself,
//    because that is the only place it exists.
// 4. No 55% white wash, ever — the rule the insight lens settled
//    (docs/design/insight-overlays.md section 5h) is respected here by having
//    nothing to dim in the first place, and that absence is asserted rather
//    than merely true.
//
// These are drawing tests over a recording context: what matters is which calls
// are issued and with which numbers, not what it looks like.

import { describe, it, expect } from "vitest";
import {
  CHART_ELEMENT_SELECTION_PAD,
  CHART_SELECTABLE_ELEMENT_IDS,
  CHART_SELECTION_COLOR,
  drawElementSelectionHighlight,
  elementSelectionBox,
  elementSelectionRect,
  isSelectableChartElement,
  type SelectableChartElementId,
} from "../selectionHighlight";
import {
  CHART_ELEMENT_IDS,
  type ChartElementId,
  type ChartElementRects,
  type ChartLayout,
} from "../../types";
import { makeRecordingCtx } from "./dispatch-recordingCtx";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * A measured element set. Every rect is an odd, asymmetric number that NO
 * margin arithmetic would produce — the title is not centred, the legend is not
 * flush with anything, the y-axis title is not at the vertical midpoint. A
 * painter that re-derived its box from `margin`/`plotArea` would fail every
 * coordinate assertion below instead of accidentally agreeing with one.
 */
function elements(): ChartElementRects {
  return {
    family: "cartesian",
    chartArea: { x: 0, y: 0, width: 600, height: 400 },
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
    displayUnitLabel: { x: 9, y: 21, width: 63, height: 13 },
    measured: ["title", "legend"],
  };
}

/** A layout whose margins do NOT agree with the element rects above. */
function layout(): ChartLayout {
  return {
    width: 600,
    height: 400,
    margin: { top: 30, right: 20, bottom: 40, left: 55 },
    plotArea: { x: 63, y: 39, width: 451, height: 287 },
    elements: elements(),
  };
}

/** The exact `strokeRect(...)` entry the recording context writes for a box. */
function expectedBorderCall(
  rect: { x: number; y: number; width: number; height: number },
  chartX: number,
  chartY: number,
): string {
  const box = elementSelectionBox(rect);
  return `strokeRect(${chartX + box.x + 0.5},${chartY + box.y + 0.5},${box.width - 1},${box.height - 1})`;
}

const ALL_SELECTABLE = [...CHART_SELECTABLE_ELEMENT_IDS] as SelectableChartElementId[];

// ---------------------------------------------------------------------------

describe("which elements get a selection box at all", () => {
  // A new ChartElementId must be a deliberate decision, not a silent omission:
  // the taxonomy is the drift-guarded one in types.ts, and every member must be
  // either painted here or listed below with the reason it is not. This test
  // has already earned its keep once — it went red the day the furniture wave
  // (trendline / errorBars / dataLabel / dataTable) widened the union.
  it("partitions the whole ChartElementId taxonomy, so a new id fails this test", () => {
    const notBoxedHere = [
      "chartArea", // renderChart step 5 already draws the chart's own border + handles
      "datum", // drawSelectionHighlights (bars / points / slices)
      "xAxis", // drawAxisSelectionHighlight
      "yAxis", // drawAxisSelectionHighlight
      "filterButton", // its own pressed state
      "none", // nothing was hit
      // Hit-testable, but with no element-level ladder route yet — and two of
      // them could not be named by a ChartSubSelection if they had one (no
      // pointIndex for an element, no trendlineIndex). A trendline is recorded
      // as a POLYLINE, so it needs a painter of its own rather than a box.
      "dataLabel",
      "dataTable",
      "errorBars",
      "trendline",
    ];
    expect([...ALL_SELECTABLE, ...notBoxedHere].sort()).toEqual([...CHART_ELEMENT_IDS].sort());
  });

  it("refuses every element that is painted elsewhere, and `undefined`", () => {
    const refused: Array<ChartElementId | undefined> = [
      "chartArea",
      "datum",
      "xAxis",
      "yAxis",
      "filterButton",
      "none",
      "dataLabel",
      "dataTable",
      "errorBars",
      "trendline",
      undefined,
    ];
    for (const id of refused) {
      expect(isSelectableChartElement(id), `${String(id)} must not be boxed here`).toBe(false);
      const r = makeRecordingCtx();
      expect(drawElementSelectionHighlight(r.ctx, 0, 0, layout(), id, 0)).toBe(false);
      expect(r.calls, `${String(id)} must paint nothing`).toEqual([]);
    }
  });
});

describe("a distinct call stream per element id", () => {
  it("paints a different thing for every selectable element", () => {
    const streams = new Map<string, string>();
    for (const id of ALL_SELECTABLE) {
      const r = makeRecordingCtx();
      expect(drawElementSelectionHighlight(r.ctx, 0, 0, layout(), id, 1)).toBe(true);
      expect(r.calls.filter((c) => c.startsWith("strokeRect(")), `${id} draws one border`).toHaveLength(1);
      streams.set(id, r.calls.join("|"));
    }
    expect(
      new Set(streams.values()).size,
      `two elements painted the SAME thing: ${JSON.stringify([...streams])}`,
    ).toBe(ALL_SELECTABLE.length);
  });

  it("uses the repo's existing selection colour and a hairline border", () => {
    const r = makeRecordingCtx();
    drawElementSelectionHighlight(r.ctx, 0, 0, layout(), "title");
    expect(r.calls).toContain(`strokeStyle=${CHART_SELECTION_COLOR}`);
    expect(r.calls).toContain("lineWidth=1");
    expect(r.calls).toContain("setLineDash([])");
    // Saved and restored, so the border's style cannot leak into the insight
    // overlay painted straight after it.
    expect(r.calls[0]).toBe("save()");
    expect(r.calls[r.calls.length - 1]).toBe("restore()");
  });

  it("draws the handles that say the element can be moved", () => {
    const r = makeRecordingCtx();
    drawElementSelectionHighlight(r.ctx, 0, 0, layout(), "title");
    const handles = r.calls.filter((c) => c.startsWith("fillRect("));
    // The same six squares the datum highlight uses: four corners plus the top
    // and bottom midpoints.
    expect(handles).toHaveLength(6);
    for (const h of handles) expect(h).toMatch(/^fillRect\(-?[\d.]+,-?[\d.]+,5,5\)$/);
    expect(r.calls).toContain(`fillStyle=${CHART_SELECTION_COLOR}`);
  });
});

describe("the rect painted is the MEASURED rect", () => {
  it("boxes each element's own rect out of the layout, offset by the chart origin", () => {
    const lay = layout();
    const el = lay.elements!;
    const cases: Array<[SelectableChartElementId, { x: number; y: number; width: number; height: number }]> = [
      ["title", el.title!],
      ["xAxisTitle", el.xAxisTitle!],
      ["yAxisTitle", el.yAxisTitle!],
      ["legend", el.legend!],
      ["plotArea", lay.plotArea],
    ];
    for (const [id, rect] of cases) {
      const r = makeRecordingCtx();
      drawElementSelectionHighlight(r.ctx, 40, 25, lay, id);
      expect(r.calls, `${id} must box its measured rect`).toContain(expectedBorderCall(rect, 40, 25));
    }
  });

  it("follows a measured rect that CONTRADICTS the margins", () => {
    // The title is measured at the BOTTOM-RIGHT of the canvas. No margin
    // arithmetic produces that, so a painter that re-derived the title box from
    // `margin.top` and the canvas width cannot pass this.
    const lay = layout();
    lay.elements!.title = { x: 431, y: 352, width: 97, height: 19 };
    const r = makeRecordingCtx();
    drawElementSelectionHighlight(r.ctx, 0, 0, lay, "title");
    expect(r.calls).toContain(expectedBorderCall(lay.elements!.title, 0, 0));
  });

  it("moves by exactly the amount the measured rect moved", () => {
    const before = makeRecordingCtx();
    drawElementSelectionHighlight(before.ctx, 0, 0, layout(), "title");

    const shifted = layout();
    const t = shifted.elements!.title!;
    shifted.elements!.title = { ...t, x: t.x + 37, y: t.y - 11 };
    const after = makeRecordingCtx();
    drawElementSelectionHighlight(after.ctx, 0, 0, shifted, "title");

    const borderOf = (calls: string[]) => calls.find((c) => c.startsWith("strokeRect("))!;
    const nums = (call: string) => call.slice("strokeRect(".length, -1).split(",").map(Number);
    const a = nums(borderOf(before.calls));
    const b = nums(borderOf(after.calls));
    expect(b[0] - a[0]).toBe(37);
    expect(b[1] - a[1]).toBe(-11);
    expect(b[2]).toBe(a[2]);
    expect(b[3]).toBe(a[3]);
  });

  it("outsets by the pad on every side, so the box is not a strikethrough", () => {
    const rect = { x: 100, y: 50, width: 80, height: 20 };
    expect(elementSelectionBox(rect)).toEqual({
      x: 100 - CHART_ELEMENT_SELECTION_PAD,
      y: 50 - CHART_ELEMENT_SELECTION_PAD,
      width: 80 + CHART_ELEMENT_SELECTION_PAD * 2,
      height: 20 + CHART_ELEMENT_SELECTION_PAD * 2,
    });
  });
});

describe("a legend entry is a rect of its own", () => {
  it("boxes the clicked entry, not the whole legend", () => {
    const lay = layout();
    const r = makeRecordingCtx();
    drawElementSelectionHighlight(r.ctx, 0, 0, lay, "legendEntry", 1);
    expect(r.calls).toContain(expectedBorderCall(lay.elements!.legendItems![1].rect, 0, 0));
    expect(r.calls).not.toContain(expectedBorderCall(lay.elements!.legend!, 0, 0));
  });

  it("boxes a DIFFERENT rect for entry 0 than for entry 1", () => {
    const lay = layout();
    const zero = makeRecordingCtx();
    drawElementSelectionHighlight(zero.ctx, 0, 0, lay, "legendEntry", 0);
    const one = makeRecordingCtx();
    drawElementSelectionHighlight(one.ctx, 0, 0, lay, "legendEntry", 1);
    expect(zero.calls).not.toEqual(one.calls);
    expect(elementSelectionRect(lay, "legendEntry", 0)).toEqual(lay.elements!.legendItems![0].rect);
    expect(elementSelectionRect(lay, "legendEntry", 1)).toEqual(lay.elements!.legendItems![1].rect);
  });

  it("falls back to the whole legend box when the entry is gone, rather than going silent", () => {
    // The series the ladder drilled into no longer has an entry (the data
    // reshaped under a live selection). Painting nothing is the defect this
    // whole file exists to close, so the honest answer is "the legend".
    const lay = layout();
    for (const missing of [undefined, 7]) {
      const r = makeRecordingCtx();
      expect(drawElementSelectionHighlight(r.ctx, 0, 0, lay, "legendEntry", missing)).toBe(true);
      expect(r.calls).toContain(expectedBorderCall(lay.elements!.legend!, 0, 0));
    }
  });

  it("paints nothing when there is no legend to fall back to either", () => {
    const lay = layout();
    delete lay.elements!.legend;
    delete lay.elements!.legendItems;
    const r = makeRecordingCtx();
    expect(drawElementSelectionHighlight(r.ctx, 0, 0, lay, "legendEntry", 0)).toBe(false);
    expect(r.calls).toEqual([]);
  });
});

describe("nothing to paint", () => {
  it("paints nothing when layout.elements is absent", () => {
    const bare: ChartLayout = { ...layout(), elements: undefined };
    for (const id of ALL_SELECTABLE.filter((i) => i !== "plotArea")) {
      const r = makeRecordingCtx();
      expect(drawElementSelectionHighlight(r.ctx, 0, 0, bare, id, 0), id).toBe(false);
      expect(r.calls, `${id} must paint nothing without measured rects`).toEqual([]);
    }
  });

  it("still boxes the plot area without `elements`, because it is read off the layout", () => {
    // Stated, not accidental: `ChartElementRects` has no `plotArea` member, and
    // a second copy of a rect every painter already reads is how two spellings
    // of one fact start drifting.
    const bare: ChartLayout = { ...layout(), elements: undefined };
    const r = makeRecordingCtx();
    expect(drawElementSelectionHighlight(r.ctx, 0, 0, bare, "plotArea")).toBe(true);
    expect(r.calls).toContain(expectedBorderCall(bare.plotArea, 0, 0));
  });

  it("paints nothing when the layout itself is missing", () => {
    const r = makeRecordingCtx();
    expect(drawElementSelectionHighlight(r.ctx, 0, 0, undefined, "title")).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it("paints nothing when the element has no rect (a chart with no title)", () => {
    const lay = layout();
    delete lay.elements!.title;
    const r = makeRecordingCtx();
    expect(drawElementSelectionHighlight(r.ctx, 0, 0, lay, "title")).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it("paints nothing for a zero-area rect, which is a layout that has not measured yet", () => {
    for (const rect of [
      { x: 10, y: 10, width: 0, height: 18 },
      { x: 10, y: 10, width: 120, height: 0 },
    ]) {
      const lay = layout();
      lay.elements!.title = rect;
      const r = makeRecordingCtx();
      expect(drawElementSelectionHighlight(r.ctx, 0, 0, lay, "title")).toBe(false);
      expect(r.calls).toEqual([]);
    }
  });
});

describe("the wash rule the insight lens settled", () => {
  // Settled precedent, not re-litigated here: at datum level the OTHER elements
  // get a 55% white wash, and that wash is SKIPPED while the chart carries
  // visible cues, because it would pale the very bars the lens exists to point
  // at. Element selection sidesteps the collision entirely — selecting a title
  // says nothing about the bars, so nothing is dimmed and there is no flag to
  // get wrong. The absence is asserted so that adding a wash here cannot pass
  // review without also inheriting the lens rule.
  it("never washes anything, for any element", () => {
    for (const id of ALL_SELECTABLE) {
      const r = makeRecordingCtx();
      drawElementSelectionHighlight(r.ctx, 0, 0, layout(), id, 0);
      expect(r.calls.join("|"), `${id} must not dim anything`).not.toContain("rgba(255, 255, 255, 0.55)");
      // The only fills are the six 5x5 handle squares.
      expect(r.calls.filter((c) => c.startsWith("fillRect(")), `${id} fills only handles`).toHaveLength(6);
      expect(r.calls.filter((c) => c === "fill()"), `${id} fills no path`).toHaveLength(0);
    }
  });
});

describe("while the element is being TEXT-EDITED", () => {
  // The in-place editor is a real <textarea> mounted over the canvas, grown
  // from the SAME measured rect by a larger padding. A selection border behind
  // it shows as a second frame a few pixels inside the editor: two boxes around
  // one title, neither of them wrong. The editor is the "this is selected"
  // signal while it is up, so the painter stands down.
  it("draws nothing behind the editor for every editable text element", () => {
    for (const id of ["title", "xAxisTitle", "yAxisTitle"] as SelectableChartElementId[]) {
      const r = makeRecordingCtx();
      expect(drawElementSelectionHighlight(r.ctx, 0, 0, layout(), id, undefined, { textEditing: true })).toBe(false);
      expect(r.calls, `${id} must not fight the editor`).toEqual([]);
    }
  });

  it("still paints the non-text furniture, because an editor open elsewhere is not about it", () => {
    // The suppression is deliberately narrow: at most one overlay editor is
    // live at a time anywhere in the app, and a caption being typed on some
    // other object must not blank this chart's selected legend.
    for (const id of ["legend", "legendEntry", "plotArea"] as SelectableChartElementId[]) {
      const r = makeRecordingCtx();
      expect(drawElementSelectionHighlight(r.ctx, 0, 0, layout(), id, 0, { textEditing: true })).toBe(true);
      expect(r.calls.filter((c) => c.startsWith("strokeRect("))).toHaveLength(1);
    }
  });

  it("paints the title again the moment the editor closes", () => {
    const r = makeRecordingCtx();
    expect(drawElementSelectionHighlight(r.ctx, 0, 0, layout(), "title", undefined, { textEditing: false })).toBe(true);
    expect(r.calls).toContain(expectedBorderCall(elements().title!, 0, 0));
  });
});
