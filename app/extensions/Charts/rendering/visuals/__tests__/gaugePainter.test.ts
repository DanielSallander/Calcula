//! FILENAME: app/extensions/Charts/rendering/visuals/__tests__/gaugePainter.test.ts
// PURPOSE: The Gauge visual draws Power BI's radial gauge: a 180-degree arc
//          shaded from the minimum to the value, a needle at the TARGET, the
//          value in the middle, min and max at the ends — with Power BI's
//          defaults (minimum 0, maximum double the value).

import { describe, it, expect } from "vitest";
import { visualSpec, seriesData, paintVisual, textsOf, textAt } from "./visualTestKit";
import { getChartMarkMeta } from "@api/chartMarks";
import { resolveGaugeScale } from "../gaugePainter";

/** Every arc(cx,cy,r,start,end[,ccw]) call, parsed. */
function arcs(calls: string[]): Array<{ cx: number; cy: number; r: number; start: number; end: number }> {
  return calls
    .filter((c) => c.startsWith("arc("))
    .map((c) => {
      const [cx, cy, r, start, end] = c.slice(4, -1).split(",").map(Number);
      return { cx, cy, r, start, end };
    });
}

describe("resolveGaugeScale: Power BI's defaults", () => {
  it("min 0 and max double the value, so the value sits half way", () => {
    expect(resolveGaugeScale(60, {}, null, null, null)).toEqual({ min: 0, max: 120, target: null });
  });
  it("fixed options win, then series, then the defaults", () => {
    expect(resolveGaugeScale(60, { min: 10, max: 90, target: 70 }, 0, 200, 50)).toEqual({ min: 10, max: 90, target: 70 });
    expect(resolveGaugeScale(60, {}, 5, 100, 80)).toEqual({ min: 5, max: 100, target: 80 });
  });
  it("a zero value still has a range; a negative value swings the range below zero", () => {
    expect(resolveGaugeScale(0, {}, null, null, null)).toEqual({ min: 0, max: 1, target: null });
    expect(resolveGaugeScale(-40, {}, null, null, null)).toEqual({ min: -80, max: 0, target: null });
  });
});

describe("gauge", () => {
  it("is registered as a title-only tile", () => {
    expect(getChartMarkMeta("gauge")).toMatchObject({ label: "Gauge", layoutFamily: "other", furniture: "titleOnly" });
  });

  it("draws the track over 180 degrees and the progress up to the value (half way by default)", () => {
    const { calls } = paintVisual("gauge", visualSpec("gauge"), seriesData(["t"], [{ name: "Score", values: [60] }]));
    const a = arcs(calls);
    // track: PI -> 2PI; progress: PI -> 1.5PI (60 of 0..120)
    const track = a.find((x) => Math.abs(x.start - Math.PI) < 1e-3 && Math.abs(x.end - 2 * Math.PI) < 1e-3);
    const progress = a.find((x) => Math.abs(x.start - Math.PI) < 1e-3 && Math.abs(x.end - 1.5 * Math.PI) < 1e-3);
    expect(track).toBeDefined();
    expect(progress).toBeDefined();
    expect(textsOf(calls)).toEqual(expect.arrayContaining(["60", "0", "120"]));
  });

  it("puts the needle at the TARGET (series 1), and labels it", () => {
    const { calls } = paintVisual(
      "gauge",
      visualSpec("gauge"),
      seriesData(["t"], [{ name: "Score", values: [60] }, { name: "Target", values: [90] }]),
    );
    // Target 90 of 0..120 = 3/4 of the arc: angle PI + 0.75 PI. The needle is a
    // line through that angle from inside the track to outside it.
    const a = arcs(calls).find((x) => Math.abs(x.end - 2 * Math.PI) < 1e-3)!;
    const angle = Math.PI + 0.75 * Math.PI;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const moves = calls.filter((c) => c.startsWith("moveTo(") || c.startsWith("lineTo("));
    const onNeedle = moves.filter((c) => {
      const [x, y] = c.slice(c.indexOf("(") + 1, -1).split(",").map(Number);
      const dx = x - a.cx;
      const dy = y - a.cy;
      const len = Math.hypot(dx, dy);
      return len > 0 && Math.abs(dx / len - ux) < 0.01 && Math.abs(dy / len - uy) < 0.01;
    });
    expect(onNeedle.length).toBeGreaterThanOrEqual(2);
    expect(textsOf(calls)).toContain("90");
  });

  it("the progress arc takes the series colour; a per-point override wins", () => {
    const tinted = paintVisual("gauge", visualSpec("gauge"), seriesData(["t"], [{ name: "S", values: [5], color: "#FF00AA" }]));
    expect(tinted.calls).toContain("fillStyle=#FF00AA");
    const spec = visualSpec("gauge", { dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 0, color: "#FFCC00" }] });
    const over = paintVisual("gauge", spec, seriesData(["t"], [{ name: "S", values: [5] }]));
    expect(over.calls).toContain("fillStyle=#FFCC00");
  });

  it("a value past the maximum fills the arc and no further", () => {
    const spec = visualSpec("gauge", { markOptions: { max: 50 } } as never);
    const { calls } = paintVisual("gauge", spec, seriesData(["t"], [{ name: "S", values: [80] }]));
    const ends = arcs(calls).map((x) => x.end);
    // The recorder rounds to 4 decimals, so "no further than 2 PI" is to 1e-3.
    expect(Math.max(...ends)).toBeLessThanOrEqual(2 * Math.PI + 1e-3);
    expect(Math.max(...ends)).toBeGreaterThan(2 * Math.PI - 1e-3);
    expect(textsOf(calls)).toContain("80");
  });

  it("hit-tests the gauge as one datum covering the arc", () => {
    const { geometry, layout } = paintVisual("gauge", visualSpec("gauge"), seriesData(["t"], [{ name: "S", values: [5] }]));
    expect(geometry.type).toBe("bars");
    if (geometry.type !== "bars") return;
    expect(geometry.rects).toHaveLength(1);
    const r = geometry.rects[0];
    expect([r.seriesIndex, r.categoryIndex, r.value]).toEqual([0, 0, 5]);
    expect(r.x).toBeGreaterThanOrEqual(layout.plotArea.x);
    expect(r.x + r.width).toBeLessThanOrEqual(layout.plotArea.x + layout.plotArea.width + 0.001);
  });

  it("min / max labels can be hidden", () => {
    const spec = visualSpec("gauge", { markOptions: { showMinMax: false } } as never);
    const { calls } = paintVisual("gauge", spec, seriesData(["t"], [{ name: "S", values: [60] }]));
    expect(textsOf(calls)).toEqual(["60"]);
  });

  it("the callout is the value as the source wrote it (units none)", () => {
    const spec = visualSpec("gauge", { markOptions: { displayUnits: "none" } } as never);
    const { calls } = paintVisual("gauge", spec, seriesData(["t"], [{ name: "S", values: [0.6] }], [["60%"]]));
    expect(textAt(calls, "60%")).not.toBeNull();
  });
});
