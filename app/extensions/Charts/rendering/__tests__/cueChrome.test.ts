//! FILENAME: app/extensions/Charts/rendering/__tests__/cueChrome.test.ts
// PURPOSE: The stepper pill's geometry and hit zones, and the comment boxes:
//          an attached comment hangs off its datum, a moved one says where
//          from, an unattached one goes to the tray and never onto a bar.

import { describe, it, expect } from "vitest";
import { dispatchComputeGeometry } from "../chartDispatch";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import {
  computeCueStepper,
  hitTestCueStepper,
  drawCueStepper,
  paintChartComments,
  hitTestCommentBoxes,
  COMMENT_TOP_RESERVED,
  type ChromePaintContext,
} from "../cueChrome";
import type { ChartCue, ChartCueComment } from "@api/chartCues";
import type { ParsedChartData, ChartSpec, ChartLayout } from "../../types";

const data: ParsedChartData = {
  categories: ["Jan", "Feb", "Mar", "Apr", "May"],
  series: [{ name: "Sales", values: [100, 200, 300, 150, 250], color: null }],
};
const spec = {
  mark: "bar", data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 2 }, hasHeaders: true,
  seriesOrientation: "columns", categoryIndex: 0, series: [], title: null,
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: true, position: "bottom" }, stacking: "none", transforms: [], encodings: {},
  annotations: [], dataPointOverrides: [], filters: [], gradientFill: null, stylePreset: null,
} as unknown as ChartSpec;
const layout: ChartLayout = { width: 600, height: 400, margin: { top: 40, right: 20, bottom: 40, left: 60 }, plotArea: { x: 60, y: 40, width: 520, height: 320 } };
const geometry = dispatchComputeGeometry(data, spec, layout, DEFAULT_CHART_THEME);

function ctxStub(): { ctx: ChromePaintContext; texts: string[]; calls: string[] } {
  const texts: string[] = [];
  const calls: string[] = [];
  const rec = (n: string) => (...a: unknown[]) => { calls.push(n); if (n === "fillText") texts.push(String(a[0])); };
  const ctx = {
    save: rec("save"), restore: rec("restore"), beginPath: rec("beginPath"), ellipse: rec("ellipse"), arc: rec("arc"),
    stroke: rec("stroke"), fill: rec("fill"), fillRect: rec("fillRect"), fillText: rec("fillText"), setLineDash: rec("setLineDash"),
    moveTo: rec("moveTo"), lineTo: rec("lineTo"), closePath: rec("closePath"), strokeRect: rec("strokeRect"),
    measureText: () => ({ width: 10 }),
    lineWidth: 0, globalAlpha: 1, fillStyle: "", strokeStyle: "", font: "", textAlign: "left", textBaseline: "alphabetic",
  } as unknown as ChromePaintContext;
  return { ctx, texts, calls };
}

describe("the stepper pill", () => {
  it("sits in the chart's top-right, says which step it is on, and has four zones in order", () => {
    const c = computeCueStepper("c1", 100, 50, 400, ["Highest Sales", "Lowest Sales", "Sales rising"], 1)!;
    expect(c).not.toBeNull();
    expect(c.counter).toBe("2 of 3");
    expect(c.description).toBe("Lowest Sales");
    expect(c.x + c.width).toBe(100 + 400 - 8);
    expect(c.y).toBe(58);
    expect(c.zones.map((z) => z.action)).toEqual(["prev", "step", "next", "all"]);
    // Zones tile the pill left to right without gaps.
    for (let i = 1; i < c.zones.length; i++) expect(c.zones[i].x).toBeCloseTo(c.zones[i - 1].x + c.zones[i - 1].width, 6);
    expect(c.zones[3].x + c.zones[3].width).toBeCloseTo(c.x + c.width, 6);
  });

  it("says 'all N' with no description when showing all, and is null with no steps", () => {
    const c = computeCueStepper("c1", 0, 0, 400, ["a", "b"], "all")!;
    expect(c.counter).toBe("all 2");
    expect(c.description).toBe("");
    expect(computeCueStepper("c1", 0, 0, 400, [], 0)).toBeNull();
  });

  it("hit-tests each zone and nothing outside", () => {
    const c = computeCueStepper("c1", 100, 50, 400, ["a", "b"], 0)!;
    const mid = (z: { x: number; y: number; width: number; height: number }) => [z.x + z.width / 2, z.y + z.height / 2] as const;
    expect(hitTestCueStepper(...mid(c.zones[0]), c)).toBe("prev");
    expect(hitTestCueStepper(...mid(c.zones[1]), c)).toBe("step");
    expect(hitTestCueStepper(...mid(c.zones[2]), c)).toBe("next");
    expect(hitTestCueStepper(...mid(c.zones[3]), c)).toBe("all");
    expect(hitTestCueStepper(c.x - 1, c.y, c)).toBeNull();
    expect(hitTestCueStepper(c.x, c.y + 30, c)).toBeNull();
    expect(hitTestCueStepper(0, 0, null)).toBeNull();
  });

  it("draws the counter and the description as text", () => {
    const c = computeCueStepper("c1", 100, 50, 400, ["Highest Sales"], 0)!;
    const { ctx, texts } = ctxStub();
    drawCueStepper(ctx, c, false);
    expect(texts).toContain("1 of 1  Highest Sales");
    expect(texts).toContain("all");
  });
});

describe("comments", () => {
  const ext = "extremes:x";
  const cues = new Map<string, ChartCue>([[ext, { factId: ext, kind: "ring", polarity: "bad", anchor: { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" } }]]);

  it("hangs an attached comment off its datum, inside the chart, and hit-tests it", () => {
    const comments: ChartCueComment[] = [{ id: "k1", factId: ext, text: "Launch month", anchor: { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" } }];
    const { ctx, texts } = ctxStub();
    const boxes = paintChartComments(ctx, 100, 50, 600, 400, geometry, data, comments, cues);
    expect(boxes).toHaveLength(1);
    expect(texts).toContain("Launch month");
    const b = boxes[0];
    expect(b.x).toBeGreaterThanOrEqual(100);
    expect(b.x + b.width).toBeLessThanOrEqual(700);
    expect(b.y).toBeGreaterThanOrEqual(50);
    expect(hitTestCommentBoxes(b.x + 2, b.y + 2, boxes)).toBe("k1");
    expect(hitTestCommentBoxes(0, 0, boxes)).toBeNull();
  });

  it("a comment on a bar that reaches the chart's top hangs BELOW its attach point, out of the pill's strip", () => {
    // Mar (300) is the tallest bar: its top is at the plot's top, so a box
    // above it would sit under the stepper pill (found by the live proof).
    const comments: ChartCueComment[] = [{ id: "k1", factId: ext, text: "Launch month", anchor: { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" } }];
    const { ctx } = ctxStub();
    const boxes = paintChartComments(ctx, 100, 50, 600, 400, geometry, data, comments, cues);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].y).toBeGreaterThanOrEqual(50 + COMMENT_TOP_RESERVED);
    const tallest = (geometry as { rects: Array<{ categoryIndex: number; y: number }> }).rects.find((r) => r.categoryIndex === 2)!;
    expect(boxes[0].y).toBeGreaterThan(50 + tallest.y); // below the bar's top, not above it

    // A short bar keeps the box ABOVE its top.
    const low: ChartCueComment[] = [{ id: "k2", factId: ext, text: "Low", anchor: { type: "datum", series: "Sales", categoryIndex: 0, categoryLabel: "Jan" } }];
    const short = (geometry as { rects: Array<{ categoryIndex: number; y: number }> }).rects.find((r) => r.categoryIndex === 0)!;
    const lowBoxes = paintChartComments(ctxStub().ctx, 100, 50, 600, 400, geometry, data, low, cues);
    expect(lowBoxes[0].y + lowBoxes[0].height).toBeLessThan(50 + short.y);
  });

  it("writes the 'was Mar' badge on a comment that followed its fact", () => {
    const comments: ChartCueComment[] = [{ id: "k1", factId: ext, text: "Launch month", movedFrom: "Mar", anchor: { type: "datum", series: "Sales", categoryIndex: 4, categoryLabel: "May" } }];
    const { ctx, texts } = ctxStub();
    paintChartComments(ctx, 0, 0, 600, 400, geometry, data, comments, cues);
    expect(texts).toContain("was Mar");
  });

  it("puts an unattached comment, and one whose anchor no longer resolves, in the tray at the bottom", () => {
    const comments: ChartCueComment[] = [
      { id: "k1", factId: "gone", text: "old note", anchor: null, movedFrom: "Mar" },
      { id: "k2", factId: ext, text: "stale", anchor: { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "March" } },
    ];
    const { ctx, texts, calls } = ctxStub();
    const boxes = paintChartComments(ctx, 0, 0, 600, 400, geometry, data, comments, cues);
    expect(texts.some((t) => t.startsWith("2 comments no longer point"))).toBe(true);
    expect(texts).toContain("old note (was Mar)");
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(b.y).toBeGreaterThan(300); // the tray, not the plot
    // No leader line was drawn for a tray entry.
    expect(calls.filter((c) => c === "moveTo").length).toBeLessThanOrEqual(2 * 4); // rounded rects only
  });

  it("draws nothing and returns no boxes for no comments", () => {
    const { ctx, calls } = ctxStub();
    expect(paintChartComments(ctx, 0, 0, 600, 400, geometry, data, [], cues)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
