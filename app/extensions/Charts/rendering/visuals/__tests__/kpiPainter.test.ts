//! FILENAME: app/extensions/Charts/rendering/visuals/__tests__/kpiPainter.test.ts
// PURPOSE: The KPI visual draws Power BI's KPI: the indicator for the LATEST
//          trend period in large type, a status (good / bad / no goal) that
//          follows the direction setting, a trend area behind it, and the goal
//          with its distance.

import { describe, it, expect } from "vitest";
import { visualSpec, seriesData, paintVisual, textsOf, textAt, fontPx } from "./visualTestKit";
import { getChartMarkMeta } from "@api/chartMarks";
import { KPI_DEFAULT_COLORS, kpiStatus } from "../kpiPainter";

const MONTHS = ["Jan", "Feb", "Mar", "Apr"];

function kpiData(indicator: number[], goal?: number[]) {
  const series = [{ name: "Revenue", values: indicator }];
  if (goal) series.push({ name: "Target", values: goal });
  return seriesData(MONTHS, series);
}

describe("kpiStatus", () => {
  it("higher is better: at or above the goal is good, below is bad", () => {
    expect(kpiStatus(120, 100, "higherIsBetter")).toBe("good");
    expect(kpiStatus(100, 100, "higherIsBetter")).toBe("good");
    expect(kpiStatus(80, 100, "higherIsBetter")).toBe("bad");
  });
  it("lower is better flips it", () => {
    expect(kpiStatus(80, 100, "lowerIsBetter")).toBe("good");
    expect(kpiStatus(120, 100, "lowerIsBetter")).toBe("bad");
  });
  it("no goal is neutral", () => {
    expect(kpiStatus(80, null, "higherIsBetter")).toBe("neutral");
  });
});

describe("kpi", () => {
  it("is registered as a title-only tile", () => {
    expect(getChartMarkMeta("kpi")).toMatchObject({ label: "KPI", layoutFamily: "other", furniture: "titleOnly" });
  });

  it("shows the LATEST period's indicator, large, and the goal with its distance", () => {
    const { calls } = paintVisual("kpi", visualSpec("kpi"), kpiData([90, 95, 105, 11000], [100, 100, 100, 10000]));
    const texts = textsOf(calls);
    expect(texts).toContain("11K");
    expect(texts).toContain("Goal: 10K (+10%)");
    const value = textAt(calls, "11K")!;
    expect(fontPx(value.font)).toBeGreaterThanOrEqual(24);
    expect(textAt(calls, "Goal: 10K (+10%)")!.y).toBeGreaterThan(value.y);
  });

  it("colours the trend and the distance by status: good when higher is better and above goal", () => {
    const { calls } = paintVisual("kpi", visualSpec("kpi"), kpiData([1, 2, 3, 120], [100, 100, 100, 100]));
    expect(calls).toContain(`strokeStyle=${KPI_DEFAULT_COLORS.good}`);
    expect(calls).not.toContain(`strokeStyle=${KPI_DEFAULT_COLORS.bad}`);
  });

  it("the same numbers are BAD when lower is better", () => {
    const spec = visualSpec("kpi", { markOptions: { direction: "lowerIsBetter" } } as never);
    const { calls } = paintVisual("kpi", spec, kpiData([1, 2, 3, 120], [100, 100, 100, 100]));
    expect(calls).toContain(`strokeStyle=${KPI_DEFAULT_COLORS.bad}`);
    expect(textsOf(calls)).toContain("Goal: 100 (+20%)");
  });

  it("a fixed goal option stands in when the data has no goal series", () => {
    const spec = visualSpec("kpi", { markOptions: { goal: 200 } } as never);
    const { calls } = paintVisual("kpi", spec, kpiData([1, 2, 3, 150]));
    expect(textsOf(calls)).toContain("Goal: 200 (-25%)");
    expect(calls).toContain(`strokeStyle=${KPI_DEFAULT_COLORS.bad}`);
  });

  it("with no goal at all the status is neutral and no goal line is written", () => {
    const { calls } = paintVisual("kpi", visualSpec("kpi"), kpiData([1, 2, 3, 4]));
    expect(calls).toContain(`strokeStyle=${KPI_DEFAULT_COLORS.neutral}`);
    expect(textsOf(calls).some((t) => t.startsWith("Goal:"))).toBe(false);
  });

  it("draws the trend as an area over every period, below the value", () => {
    const { calls, geometry } = paintVisual("kpi", visualSpec("kpi"), kpiData([10, 30, 20, 40], [25, 25, 25, 25]));
    expect(geometry.type).toBe("points");
    if (geometry.type !== "points") return;
    expect(geometry.markers.map((m) => m.categoryIndex)).toEqual([0, 1, 2, 3]);
    // Higher values sit higher on the canvas.
    expect(geometry.markers[3].cy).toBeLessThan(geometry.markers[0].cy);
    // The area is filled (one fill after a path through the four points).
    expect(calls.filter((c) => c === "fill()").length).toBeGreaterThan(0);
    const valueY = textAt(calls, "40")!.y;
    expect(Math.min(...geometry.markers.map((m) => m.cy))).toBeGreaterThan(valueY);
  });

  it("the trend can be switched off", () => {
    const spec = visualSpec("kpi", { markOptions: { showTrend: false } } as never);
    const { calls } = paintVisual("kpi", spec, kpiData([10, 30, 20, 40], [25, 25, 25, 25]));
    expect(calls.some((c) => c.startsWith("strokeStyle=") && c.includes(KPI_DEFAULT_COLORS.good))).toBe(false);
  });

  it("a per-point override on the latest period colours the indicator; on another period it marks that point", () => {
    const onLatest = visualSpec("kpi", { dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 3, color: "#FFCC00" }] });
    expect(textAt(paintVisual("kpi", onLatest, kpiData([1, 2, 3, 4])).calls, "4")!.fill).toBe("#FFCC00");
    const onFeb = visualSpec("kpi", { dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 1, color: "#FFCC00" }] });
    const p = paintVisual("kpi", onFeb, kpiData([1, 2, 3, 4]));
    expect(p.calls).toContain("fillStyle=#FFCC00");
    expect(textAt(p.calls, "4")!.fill).not.toBe("#FFCC00");
  });

  it("an empty trend shows (Blank)", () => {
    const { calls } = paintVisual("kpi", visualSpec("kpi"), seriesData([], [{ name: "Revenue", values: [] }]));
    expect(textsOf(calls)).toContain("(Blank)");
  });
});
