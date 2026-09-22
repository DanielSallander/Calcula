//! FILENAME: app/extensions/Charts/rendering/__tests__/errorBarHitRects.test.ts
// PURPOSE: The rects recorded for error bars must describe PAINTED pixels.
// CONTEXT: `paintErrorBars` clips its drawing to the plot area and then recorded
//          the UNCLIPPED bounds. A +25% bar on a value of 60 against an auto
//          scale whose maximum IS 60 reaches 75, i.e. above the plot, so the
//          recorded rect carried a NEGATIVE y. A click aimed at that rect lands
//          above the chart's own rectangle — which is a click on the GRID, and
//          the grid DESELECTS the chart. The error bars read as "not
//          selectable", and the live journey had to work around it with an
//          explicit `yAxis: { max: 100 }`.

import { describe, it, expect } from "vitest";
import { paintErrorBars } from "../errorBarPainter";
import { dispatchComputeLayout, dispatchComputeGeometry } from "../chartDispatch";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import { makeRecordingCtx } from "./dispatch-recordingCtx";
import type { ChartSpec, ParsedChartData, ChartLayout } from "../../types";

const W = 600;
const H = 400;
const THEME = DEFAULT_CHART_THEME;

/** The journey's own fixture: the last-but-one bar is the scale maximum. */
const DATA: ParsedChartData = {
  categories: ["A", "B", "C", "D", "E", "F"],
  series: [{ name: "Units", color: null, values: [10, 40, 25, 60, 35, 50] }],
};

function makeSpec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 6, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Units", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    markOptions: { errorBars: { enabled: true, type: "percentage", value: 25, direction: "plus" } },
    ...over,
  } as ChartSpec;
}

function paintAndRecord(spec: ChartSpec): ChartLayout {
  const layout = dispatchComputeLayout(W, H, spec, DATA, THEME);
  const geometry = dispatchComputeGeometry(DATA, spec, layout, THEME)!;
  const { ctx } = makeRecordingCtx(W, H);
  paintErrorBars(ctx, DATA, spec, layout, THEME, geometry);
  return layout;
}

describe("error-bar rects never leave the plot area", () => {
  it("a +25% bar on the scale maximum records a rect INSIDE the plot", () => {
    const layout = paintAndRecord(makeSpec());
    const pa = layout.plotArea;
    const bars = layout.elements!.errorBars!;
    expect(bars.length).toBeGreaterThan(0);

    for (const { rect } of bars) {
      expect(rect.y).toBeGreaterThanOrEqual(pa.y);
      expect(rect.x).toBeGreaterThanOrEqual(pa.x);
      expect(rect.y + rect.height).toBeLessThanOrEqual(pa.y + pa.height);
      expect(rect.x + rect.width).toBeLessThanOrEqual(pa.x + pa.width);
    }
  });

  it("NEGATIVE CONTROL: the unclipped extent really does run off the top", () => {
    // Without this, the test above could pass on a fixture whose bars all fit,
    // and would be proving nothing. The datum is 60 on an auto scale whose max
    // is 60, so its +25% cap is at 75 — a quarter of the plot above the top.
    const layout = paintAndRecord(makeSpec());
    const pa = layout.plotArea;
    const topBar = layout.elements!.errorBars!.find((b) => b.rect.y <= pa.y + 1);
    expect(topBar, "no error bar reaches the top of the plot in this fixture").toBeDefined();
    // Its stem was clipped: the recorded box starts exactly at the plot edge.
    expect(topBar!.rect.y).toBe(pa.y);
  });

  it("with headroom on the axis the rects are untouched", () => {
    // The journey's workaround becomes the control: with yAxis.max = 100 no bar
    // is clipped, so every rect is strictly inside and nothing was lost.
    const layout = paintAndRecord(makeSpec({
      yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: 100 },
    } as Partial<ChartSpec>));
    const pa = layout.plotArea;
    const bars = layout.elements!.errorBars!;
    expect(bars.length).toBe(DATA.categories.length);
    for (const { rect } of bars) {
      expect(rect.y).toBeGreaterThan(pa.y);
      expect(rect.y + rect.height).toBeLessThanOrEqual(pa.y + pa.height);
    }
  });
});
