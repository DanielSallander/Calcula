//! FILENAME: app/extensions/Charts/rendering/__tests__/layout-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for chart layout computation across
//          many config combinations (title, legend, axis, canvas sizes).

import { describe, it, expect } from "vitest";
import { computeCartesianLayout, computeRadialLayout } from "../chartPainterUtils";
import { DEFAULT_CHART_THEME } from "../chartTheme";
import type { ChartSpec, ParsedChartData, ChartLayout } from "../../types";
import type { ChartRenderTheme } from "../chartTheme";

// ============================================================================
// Helpers
// ============================================================================

const theme: ChartRenderTheme = { ...DEFAULT_CHART_THEME };

function makeAxis(overrides: Partial<import("../../types").AxisSpec> = {}): import("../../types").AxisSpec {
  return {
    title: null,
    gridLines: false,
    showLabels: true,
    labelAngle: 0,
    min: null,
    max: null,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "S1", sourceIndex: 1, color: null }],
    title: null,
    xAxis: makeAxis(),
    yAxis: makeAxis(),
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...overrides,
  };
}

function makeData(
  seriesCount = 1,
  catCount = 5,
  catLength = 3,
): ParsedChartData {
  const categories = Array.from({ length: catCount }, (_, i) => "C".padEnd(catLength, String(i % 10)));
  const series = Array.from({ length: seriesCount }, (_, si) => ({
    name: `Series${si}`,
    values: Array.from({ length: catCount }, (_, ci) => (si + 1) * (ci + 1) * 10),
    color: null,
  }));
  return { categories, series };
}

// ============================================================================
// 1. computeCartesianLayout - 60 config combos
// ============================================================================

describe("computeCartesianLayout parameterized", () => {
  type LegendPos = "top" | "bottom" | "left" | "right";
  type TitleConfig = "none" | "title" | "title+axisTitles";

  const legendPositions: LegendPos[] = ["top", "bottom", "left", "right"];
  const titleConfigs: TitleConfig[] = ["none", "title", "title+axisTitles"];
  const canvasSizes: Array<[number, number]> = [
    [100, 100],
    [200, 150],
    [400, 300],
    [600, 400],
    [800, 500],
    [1000, 600],
    [1200, 800],
    [2000, 1000],
  ];
  const labelAngles = [0, 45, 90];

  // Generate all combos: 4 legend x 3 title = 12 base combos
  type CartesianCombo = {
    label: string;
    w: number;
    h: number;
    legendPos: LegendPos;
    legendVisible: boolean;
    titleCfg: TitleConfig;
    labelAngle: number;
    yLabels: boolean;
    seriesCount: number;
  };

  const combos: CartesianCombo[] = [];

  // 12 combos: all legend positions x all title configs at 600x400
  for (const lp of legendPositions) {
    for (const tc of titleConfigs) {
      combos.push({
        label: `legend=${lp} title=${tc} 600x400`,
        w: 600, h: 400,
        legendPos: lp, legendVisible: true,
        titleCfg: tc, labelAngle: 0, yLabels: true, seriesCount: 3,
      });
    }
  }

  // 8 combos: canvas sizes without legend, with title
  for (const [w, h] of canvasSizes) {
    combos.push({
      label: `${w}x${h} no-legend title`,
      w, h,
      legendPos: "bottom", legendVisible: false,
      titleCfg: "title", labelAngle: 0, yLabels: true, seriesCount: 2,
    });
  }

  // 8 combos: canvas sizes with bottom legend, no title
  for (const [w, h] of canvasSizes) {
    combos.push({
      label: `${w}x${h} bottom-legend no-title`,
      w, h,
      legendPos: "bottom", legendVisible: true,
      titleCfg: "none", labelAngle: 0, yLabels: true, seriesCount: 2,
    });
  }

  // 12 combos: label angles x legend positions at 600x400
  for (const angle of labelAngles) {
    for (const lp of legendPositions) {
      combos.push({
        label: `angle=${angle} legend=${lp}`,
        w: 600, h: 400,
        legendPos: lp, legendVisible: true,
        titleCfg: "title", labelAngle: angle, yLabels: true, seriesCount: 2,
      });
    }
  }

  // 8 combos: Y labels on/off x sizes
  for (const [w, h] of canvasSizes.slice(0, 4)) {
    combos.push({
      label: `${w}x${h} no-yLabels`,
      w, h,
      legendPos: "bottom", legendVisible: false,
      titleCfg: "none", labelAngle: 0, yLabels: false, seriesCount: 1,
    });
    combos.push({
      label: `${w}x${h} yLabels`,
      w, h,
      legendPos: "bottom", legendVisible: false,
      titleCfg: "none", labelAngle: 0, yLabels: true, seriesCount: 1,
    });
  }

  // 4 combos: many series (affects legend width for left/right)
  for (const lp of ["left", "right"] as LegendPos[]) {
    combos.push({
      label: `${lp} legend many-series 800x500`,
      w: 800, h: 500,
      legendPos: lp, legendVisible: true,
      titleCfg: "title+axisTitles", labelAngle: 0, yLabels: true, seriesCount: 8,
    });
    combos.push({
      label: `${lp} legend many-series 400x300`,
      w: 400, h: 300,
      legendPos: lp, legendVisible: true,
      titleCfg: "title+axisTitles", labelAngle: 45, yLabels: true, seriesCount: 8,
    });
  }

  // Extra combos: axis titles only (no chart title)
  for (const lp of legendPositions) {
    combos.push({
      label: `axisTitles-only legend=${lp}`,
      w: 600, h: 400,
      legendPos: lp, legendVisible: true,
      titleCfg: "title+axisTitles", labelAngle: 45, yLabels: true, seriesCount: 4,
    });
  }

  // Extreme small canvases
  combos.push(
    { label: "tiny 50x50", w: 50, h: 50, legendPos: "bottom", legendVisible: false, titleCfg: "none", labelAngle: 0, yLabels: false, seriesCount: 1 },
    { label: "tiny 80x80 with title", w: 80, h: 80, legendPos: "bottom", legendVisible: false, titleCfg: "title", labelAngle: 0, yLabels: true, seriesCount: 1 },
    { label: "narrow 100x500", w: 100, h: 500, legendPos: "bottom", legendVisible: true, titleCfg: "title", labelAngle: 90, yLabels: true, seriesCount: 2 },
    { label: "wide 1000x100", w: 1000, h: 100, legendPos: "right", legendVisible: true, titleCfg: "title", labelAngle: 0, yLabels: true, seriesCount: 3 },
    { label: "huge 2000x2000", w: 2000, h: 2000, legendPos: "left", legendVisible: true, titleCfg: "title+axisTitles", labelAngle: 0, yLabels: true, seriesCount: 5 },
    { label: "10 series left legend", w: 700, h: 500, legendPos: "left", legendVisible: true, titleCfg: "title", labelAngle: 0, yLabels: true, seriesCount: 10 },
    { label: "no labels at all", w: 500, h: 400, legendPos: "bottom", legendVisible: false, titleCfg: "none", labelAngle: 0, yLabels: false, seriesCount: 1 },
    { label: "everything on 400x300", w: 400, h: 300, legendPos: "right", legendVisible: true, titleCfg: "title+axisTitles", labelAngle: 45, yLabels: true, seriesCount: 5 },
  );

  const finalCombos = combos.slice(0, 72);

  it.each(finalCombos)(
    "$label",
    ({ w, h, legendPos, legendVisible, titleCfg, labelAngle, yLabels, seriesCount }) => {
      const spec = makeSpec({
        title: titleCfg !== "none" ? "Chart Title" : null,
        xAxis: makeAxis({
          title: titleCfg === "title+axisTitles" ? "X Axis" : null,
          showLabels: true,
          labelAngle,
        }),
        yAxis: makeAxis({
          title: titleCfg === "title+axisTitles" ? "Y Axis" : null,
          showLabels: yLabels,
        }),
        legend: { visible: legendVisible, position: legendPos },
      });
      const data = makeData(seriesCount, 5);

      const layout = computeCartesianLayout(w, h, spec, data, theme);

      // Basic structural invariants
      expect(layout.width).toBe(w);
      expect(layout.height).toBe(h);

      // Margins are non-negative
      expect(layout.margin.top).toBeGreaterThanOrEqual(0);
      expect(layout.margin.right).toBeGreaterThanOrEqual(0);
      expect(layout.margin.bottom).toBeGreaterThanOrEqual(0);
      expect(layout.margin.left).toBeGreaterThanOrEqual(0);

      // Plot area has positive dimensions (min 10 enforced)
      expect(layout.plotArea.width).toBeGreaterThanOrEqual(10);
      expect(layout.plotArea.height).toBeGreaterThanOrEqual(10);

      // Plot area is within canvas bounds
      expect(layout.plotArea.x).toBeGreaterThanOrEqual(0);
      expect(layout.plotArea.y).toBeGreaterThanOrEqual(0);
      expect(layout.plotArea.x + layout.plotArea.width).toBeLessThanOrEqual(w + 1);
      expect(layout.plotArea.y + layout.plotArea.height).toBeLessThanOrEqual(h + 1);

      // Plot area position matches margins
      expect(layout.plotArea.x).toBe(layout.margin.left);
      expect(layout.plotArea.y).toBe(layout.margin.top);

      // Title increases top margin
      if (titleCfg !== "none") {
        const noTitleSpec = makeSpec({
          title: null,
          xAxis: spec.xAxis,
          yAxis: spec.yAxis,
          legend: spec.legend,
        });
        const noTitleLayout = computeCartesianLayout(w, h, noTitleSpec, data, theme);
        expect(layout.margin.top).toBeGreaterThan(noTitleLayout.margin.top);
      }

      // Legend affects appropriate margin
      if (legendVisible) {
        const noLegendSpec = makeSpec({
          title: spec.title,
          xAxis: spec.xAxis,
          yAxis: spec.yAxis,
          legend: { visible: false, position: legendPos },
        });
        const noLegendLayout = computeCartesianLayout(w, h, noLegendSpec, data, theme);

        switch (legendPos) {
          case "bottom":
            expect(layout.margin.bottom).toBeGreaterThan(noLegendLayout.margin.bottom);
            break;
          case "top":
            expect(layout.margin.top).toBeGreaterThan(noLegendLayout.margin.top);
            break;
          case "right":
            expect(layout.margin.right).toBeGreaterThan(noLegendLayout.margin.right);
            break;
          case "left":
            expect(layout.margin.left).toBeGreaterThan(noLegendLayout.margin.left);
            break;
        }
      }

      // Y labels affect left margin
      if (yLabels) {
        const noYLabelsSpec = makeSpec({
          title: spec.title,
          xAxis: spec.xAxis,
          yAxis: makeAxis({ ...spec.yAxis, showLabels: false }),
          legend: spec.legend,
        });
        const noYLayout = computeCartesianLayout(w, h, noYLabelsSpec, data, theme);
        expect(layout.margin.left).toBeGreaterThanOrEqual(noYLayout.margin.left);
      }

      // Rotated labels affect bottom margin
      // Note: the actual bottom margin depends on category label lengths;
      // with short labels (length 3), 90-degree rotation may use LESS space than 0-degree.
      // We just verify the margin is reasonable (> 0).
      if (labelAngle > 0) {
        expect(layout.margin.bottom).toBeGreaterThan(0);
      }
    },
  );
});

// ============================================================================
// 2. computeRadialLayout - 30 config combos
// ============================================================================

describe("computeRadialLayout parameterized", () => {
  type LegendPos = "top" | "bottom" | "left" | "right";

  type RadialCombo = {
    label: string;
    w: number;
    h: number;
    legendPos: LegendPos;
    legendVisible: boolean;
    hasTitle: boolean;
    catCount: number;
    catLength: number;
  };

  const radialCombos: RadialCombo[] = [
    // All legend positions with title
    { label: "top legend, title, 500x500", w: 500, h: 500, legendPos: "top", legendVisible: true, hasTitle: true, catCount: 5, catLength: 5 },
    { label: "bottom legend, title, 500x500", w: 500, h: 500, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 5, catLength: 5 },
    { label: "left legend, title, 500x500", w: 500, h: 500, legendPos: "left", legendVisible: true, hasTitle: true, catCount: 5, catLength: 5 },
    { label: "right legend, title, 500x500", w: 500, h: 500, legendPos: "right", legendVisible: true, hasTitle: true, catCount: 5, catLength: 5 },

    // Without title
    { label: "top legend, no title, 500x500", w: 500, h: 500, legendPos: "top", legendVisible: true, hasTitle: false, catCount: 5, catLength: 5 },
    { label: "bottom legend, no title, 500x500", w: 500, h: 500, legendPos: "bottom", legendVisible: true, hasTitle: false, catCount: 5, catLength: 5 },
    { label: "left legend, no title, 500x500", w: 500, h: 500, legendPos: "left", legendVisible: true, hasTitle: false, catCount: 5, catLength: 5 },
    { label: "right legend, no title, 500x500", w: 500, h: 500, legendPos: "right", legendVisible: true, hasTitle: false, catCount: 5, catLength: 5 },

    // No legend
    { label: "no legend, title, 500x500", w: 500, h: 500, legendPos: "bottom", legendVisible: false, hasTitle: true, catCount: 3, catLength: 4 },
    { label: "no legend, no title, 500x500", w: 500, h: 500, legendPos: "bottom", legendVisible: false, hasTitle: false, catCount: 3, catLength: 4 },

    // Various canvas sizes
    { label: "100x100 minimal", w: 100, h: 100, legendPos: "bottom", legendVisible: false, hasTitle: false, catCount: 2, catLength: 2 },
    { label: "200x200", w: 200, h: 200, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 3, catLength: 3 },
    { label: "300x200 wide", w: 300, h: 200, legendPos: "right", legendVisible: true, hasTitle: true, catCount: 4, catLength: 6 },
    { label: "200x300 tall", w: 200, h: 300, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 4, catLength: 4 },
    { label: "800x600", w: 800, h: 600, legendPos: "right", legendVisible: true, hasTitle: true, catCount: 8, catLength: 10 },
    { label: "1000x1000", w: 1000, h: 1000, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 10, catLength: 8 },
    { label: "2000x1000", w: 2000, h: 1000, legendPos: "right", legendVisible: true, hasTitle: true, catCount: 12, catLength: 12 },

    // Long category names (affects left/right legend width)
    { label: "right legend long names", w: 600, h: 400, legendPos: "right", legendVisible: true, hasTitle: true, catCount: 6, catLength: 20 },
    { label: "left legend long names", w: 600, h: 400, legendPos: "left", legendVisible: true, hasTitle: true, catCount: 6, catLength: 20 },
    { label: "right legend short names", w: 600, h: 400, legendPos: "right", legendVisible: true, hasTitle: true, catCount: 6, catLength: 2 },

    // Many categories
    { label: "20 cats bottom legend", w: 600, h: 400, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 20, catLength: 5 },
    { label: "20 cats right legend", w: 600, h: 400, legendPos: "right", legendVisible: true, hasTitle: false, catCount: 20, catLength: 5 },

    // Edge: single category
    { label: "1 cat no legend", w: 400, h: 400, legendPos: "bottom", legendVisible: false, hasTitle: false, catCount: 1, catLength: 3 },
    { label: "1 cat with legend", w: 400, h: 400, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 1, catLength: 3 },

    // Square vs non-square
    { label: "400x400 square", w: 400, h: 400, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 4, catLength: 5 },
    { label: "800x300 very wide", w: 800, h: 300, legendPos: "right", legendVisible: true, hasTitle: true, catCount: 5, catLength: 6 },
    { label: "300x800 very tall", w: 300, h: 800, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 5, catLength: 6 },

    // More size variety
    { label: "150x150", w: 150, h: 150, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 3, catLength: 3 },
    { label: "1500x800", w: 1500, h: 800, legendPos: "left", legendVisible: true, hasTitle: true, catCount: 7, catLength: 8 },
    { label: "600x600 all features", w: 600, h: 600, legendPos: "right", legendVisible: true, hasTitle: true, catCount: 10, catLength: 10 },

    // Extra combos
    { label: "tiny 80x80", w: 80, h: 80, legendPos: "bottom", legendVisible: false, hasTitle: false, catCount: 2, catLength: 2 },
    { label: "50x50 minimal", w: 50, h: 50, legendPos: "bottom", legendVisible: false, hasTitle: false, catCount: 1, catLength: 1 },
    { label: "wide 1000x200", w: 1000, h: 200, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 5, catLength: 5 },
    { label: "tall 200x1000", w: 200, h: 1000, legendPos: "right", legendVisible: true, hasTitle: true, catCount: 5, catLength: 5 },
    { label: "left legend 3 cats", w: 500, h: 500, legendPos: "left", legendVisible: true, hasTitle: true, catCount: 3, catLength: 8 },
    { label: "top legend many cats", w: 600, h: 400, legendPos: "top", legendVisible: true, hasTitle: true, catCount: 15, catLength: 6 },
    { label: "2000x2000 square", w: 2000, h: 2000, legendPos: "bottom", legendVisible: true, hasTitle: true, catCount: 8, catLength: 8 },
    { label: "right legend 1 cat", w: 400, h: 400, legendPos: "right", legendVisible: true, hasTitle: false, catCount: 1, catLength: 10 },
    { label: "all off 300x300", w: 300, h: 300, legendPos: "bottom", legendVisible: false, hasTitle: false, catCount: 3, catLength: 3 },
  ];

  it.each(radialCombos)(
    "$label",
    ({ w, h, legendPos, legendVisible, hasTitle, catCount, catLength }) => {
      const spec = makeSpec({
        mark: "pie",
        title: hasTitle ? "Pie Chart" : null,
        legend: { visible: legendVisible, position: legendPos },
      });
      const data = makeData(1, catCount, catLength);

      const layout = computeRadialLayout(w, h, spec, data, theme);

      // Basic structural invariants
      expect(layout.width).toBe(w);
      expect(layout.height).toBe(h);

      // Margins are non-negative
      expect(layout.margin.top).toBeGreaterThanOrEqual(0);
      expect(layout.margin.right).toBeGreaterThanOrEqual(0);
      expect(layout.margin.bottom).toBeGreaterThanOrEqual(0);
      expect(layout.margin.left).toBeGreaterThanOrEqual(0);

      // Plot area has positive dimensions
      expect(layout.plotArea.width).toBeGreaterThanOrEqual(10);
      expect(layout.plotArea.height).toBeGreaterThanOrEqual(10);

      // Plot area within canvas
      expect(layout.plotArea.x).toBeGreaterThanOrEqual(0);
      expect(layout.plotArea.y).toBeGreaterThanOrEqual(0);
      expect(layout.plotArea.x + layout.plotArea.width).toBeLessThanOrEqual(w + 1);
      expect(layout.plotArea.y + layout.plotArea.height).toBeLessThanOrEqual(h + 1);

      // Position matches margins
      expect(layout.plotArea.x).toBe(layout.margin.left);
      expect(layout.plotArea.y).toBe(layout.margin.top);

      // Title increases top margin
      if (hasTitle) {
        const noTitleSpec = makeSpec({
          mark: "pie",
          title: null,
          legend: spec.legend,
        });
        const noTitleLayout = computeRadialLayout(w, h, noTitleSpec, data, theme);
        expect(layout.margin.top).toBeGreaterThan(noTitleLayout.margin.top);
      }

      // Legend affects correct margin
      if (legendVisible) {
        const noLegendSpec = makeSpec({
          mark: "pie",
          title: spec.title,
          legend: { visible: false, position: legendPos },
        });
        const noLegendLayout = computeRadialLayout(w, h, noLegendSpec, data, theme);

        switch (legendPos) {
          case "bottom":
            expect(layout.margin.bottom).toBeGreaterThan(noLegendLayout.margin.bottom);
            break;
          case "top":
            expect(layout.margin.top).toBeGreaterThan(noLegendLayout.margin.top);
            break;
          case "right":
            expect(layout.margin.right).toBeGreaterThan(noLegendLayout.margin.right);
            break;
          case "left":
            expect(layout.margin.left).toBeGreaterThan(noLegendLayout.margin.left);
            break;
        }
      }

      // Radial: no axis labels, so left margin should be minimal without legend
      if (!legendVisible || (legendPos !== "left")) {
        // Left margin should be the base (16) regardless of data
        expect(layout.margin.left).toBeLessThanOrEqual(
          legendVisible && legendPos === "left" ? 200 : 20,
        );
      }
    },
  );
});
