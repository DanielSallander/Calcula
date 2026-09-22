//! FILENAME: app/extensions/Charts/rendering/__tests__/axisTitleBandFonts.test.ts
// PURPOSE: The x-axis title clears whatever is above it AT ANY FONT SIZE.
// CONTEXT: The drop from the plot's bottom edge to the title's baseline was a
//          pixel literal — 30 with tick labels, 16 without, and a hand-copied
//          `(showLabels ? 26 : 16)` in drawHorizontalAxes — while the band above
//          it is `theme.labelFontSize + 8` and the title's own box is
//          `theme.axisTitleFontSize` tall. BOTH of those are writable from the
//          Format pane (ChartFormatPane commits `theme.labelFontSize` on the X
//          axis and `theme.axisTitleFontSize` on the axis title), so:
//
//            - tick labels at 24px occupy plotBottom+4..+28 while the title box
//              was plotBottom+18..+30 — painted THROUGH the labels;
//            - a 20px title under a data table started at tableBottom + 16 - 20
//              = tableBottom - 4, i.e. INSIDE the table's last series row, and
//              `computeCartesianElementRects` recorded that overlapping box as
//              the hit rect.
//
//          This is the same two-formulas-one-band shape the data-table work
//          removed for the table itself and left standing for the title. The
//          tests below are parameterised over the font sizes because a single
//          default-sized case is exactly what let the literals survive.

import { describe, it, expect } from "vitest";
import { computeCartesianLayout, rectContains } from "../chartPainterUtils";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartRenderTheme } from "../chartTheme";
import type { ChartSpec, ParsedChartData } from "../../types";

const W = 600;
const H = 400;

const DATA: ParsedChartData = {
  categories: ["2023", "2024", "2025", "2026"],
  series: [
    { name: "Revenue", color: null, values: [100, 150, 130, 180] },
    { name: "Trend", color: null, values: [110, 125, 140, 160] },
  ],
};

function makeSpec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [
      { name: "Revenue", sourceIndex: 1, color: null },
      { name: "Trend", sourceIndex: 2, color: null },
    ],
    title: null,
    xAxis: { title: "Quarter", gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

function themeWith(over: Partial<ChartRenderTheme>): ChartRenderTheme {
  return { ...DEFAULT_CHART_THEME, ...over };
}

/**
 * The box the PAINTED tick labels occupy: `drawCartesianAxes` draws them at
 * plotBottom + 4 with a "top" baseline, so they run one font-size down from
 * there. Written out rather than taken from the helper, because a test that
 * asks the helper both questions proves only that the helper is consistent
 * with itself.
 */
function paintedTickLabelBand(plotBottom: number, theme: ChartRenderTheme): { top: number; bottom: number } {
  return { top: plotBottom + 4, bottom: plotBottom + 4 + theme.labelFontSize };
}

const LABEL_SIZES = [8, 11, 16, 24, 36];
const TITLE_SIZES = [8, 12, 20, 28];

describe("the x-axis title clears the tick labels at every font size", () => {
  for (const labelFontSize of LABEL_SIZES) {
    it(`labels at ${labelFontSize}px: the title's glyph box starts BELOW the last label pixel`, () => {
      const theme = themeWith({ labelFontSize });
      const layout = computeCartesianLayout(W, H, makeSpec(), DATA, theme);
      const plotBottom = layout.plotArea.y + layout.plotArea.height;
      const labels = paintedTickLabelBand(plotBottom, theme);
      const title = layout.elements!.xAxisTitle!;

      expect(title.y).toBeGreaterThanOrEqual(labels.bottom);
      // ...and it is still inside the band the layout reserved for it.
      expect(title.y + title.height).toBeLessThanOrEqual(H);
    });
  }

  for (const axisTitleFontSize of TITLE_SIZES) {
    it(`a ${axisTitleFontSize}px title still clears a default tick-label band`, () => {
      const theme = themeWith({ axisTitleFontSize });
      const layout = computeCartesianLayout(W, H, makeSpec(), DATA, theme);
      const plotBottom = layout.plotArea.y + layout.plotArea.height;
      const labels = paintedTickLabelBand(plotBottom, theme);
      const title = layout.elements!.xAxisTitle!;

      expect(title.height).toBe(axisTitleFontSize);
      expect(title.y).toBeGreaterThanOrEqual(labels.bottom);
    });
  }

  it("with the labels HIDDEN the title comes straight up to the plot edge", () => {
    const spec = makeSpec({
      xAxis: { title: "Quarter", gridLines: false, showLabels: false, labelAngle: 0, min: null, max: null },
    } as Partial<ChartSpec>);
    const layout = computeCartesianLayout(W, H, spec, DATA, DEFAULT_CHART_THEME);
    const plotBottom = layout.plotArea.y + layout.plotArea.height;
    expect(layout.elements!.xAxisTitle!.y).toBe(plotBottom + 4);
  });

  it("ROTATED labels push the title down too", () => {
    // 90-degree labels take a band as tall as the longest label is long, and
    // the fixed 30 did not know about that either.
    const straight = computeCartesianLayout(W, H, makeSpec(), DATA, DEFAULT_CHART_THEME);
    const rotated = computeCartesianLayout(
      W, H,
      makeSpec({
        xAxis: { title: "Quarter", gridLines: false, showLabels: true, labelAngle: 90, min: null, max: null },
      } as Partial<ChartSpec>),
      DATA,
      DEFAULT_CHART_THEME,
    );
    const dropOf = (l: typeof straight): number =>
      l.elements!.xAxisTitle!.y - (l.plotArea.y + l.plotArea.height);
    expect(dropOf(rotated)).toBeGreaterThan(dropOf(straight));
  });
});

describe("with a data table, the title clears the TABLE at every title size", () => {
  const withTable = (over: Partial<ChartSpec> = {}): ChartSpec =>
    makeSpec({ dataTable: { enabled: true }, ...over } as Partial<ChartSpec>);

  for (const axisTitleFontSize of TITLE_SIZES) {
    it(`a ${axisTitleFontSize}px title does not overlap the table's last row`, () => {
      const theme = themeWith({ axisTitleFontSize });
      const layout = computeCartesianLayout(W, H, withTable(), DATA, theme, DATA);
      const table = layout.elements!.dataTable!;
      const title = layout.elements!.xAxisTitle!;

      expect(title.y).toBeGreaterThanOrEqual(table.y + table.height);
      // The recorded hit box is the one the reader clicks, so the overlap has
      // to be absent from the RECT, not merely from the pixels.
      expect(rectContains(table, title.x + title.width / 2, title.y + 1)).toBe(false);
    });
  }
});
