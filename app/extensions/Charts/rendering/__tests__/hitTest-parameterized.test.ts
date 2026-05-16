import { describe, it, expect } from "vitest";
import {
  hitTestBarChart,
  hitTestPoints,
  hitTestSlices,
} from "../chartHitTesting";
import type { BarRect, PointMarker, SliceArc, ChartLayout } from "../../types";

// ============================================================================
// Shared layout for bar/point tests
// ============================================================================

const layout: ChartLayout = {
  width: 600,
  height: 400,
  margin: { top: 30, right: 20, bottom: 40, left: 50 },
  plotArea: { x: 50, y: 30, width: 530, height: 330 },
};

// ============================================================================
// 1. hitTestBarChart — 100 coordinate combos
// ============================================================================

describe("hitTestBarChart parameterized", () => {
  // Define 5 bars in a grid-like layout
  const bars: BarRect[] = [
    { seriesIndex: 0, categoryIndex: 0, x: 60, y: 100, width: 80, height: 200, value: 50, seriesName: "S0", categoryName: "A" },
    { seriesIndex: 0, categoryIndex: 1, x: 160, y: 150, width: 80, height: 150, value: 40, seriesName: "S0", categoryName: "B" },
    { seriesIndex: 0, categoryIndex: 2, x: 260, y: 80, width: 80, height: 220, value: 60, seriesName: "S0", categoryName: "C" },
    { seriesIndex: 1, categoryIndex: 0, x: 360, y: 120, width: 80, height: 180, value: 45, seriesName: "S1", categoryName: "A" },
    { seriesIndex: 1, categoryIndex: 1, x: 460, y: 200, width: 80, height: 100, value: 30, seriesName: "S1", categoryName: "B" },
  ];

  // --- Hits: points clearly inside each bar ---
  const hitCases: Array<[string, number, number, number, number, string]> = [];
  for (const bar of bars) {
    // Center of bar
    hitCases.push([
      `center of bar S${bar.seriesIndex}/C${bar.categoryIndex}`,
      bar.x + bar.width / 2, bar.y + bar.height / 2,
      bar.seriesIndex, bar.categoryIndex, bar.categoryName,
    ]);
    // Top-left corner (just inside)
    hitCases.push([
      `top-left of bar S${bar.seriesIndex}/C${bar.categoryIndex}`,
      bar.x + 1, bar.y + 1,
      bar.seriesIndex, bar.categoryIndex, bar.categoryName,
    ]);
    // Bottom-right corner (just inside)
    hitCases.push([
      `bottom-right of bar S${bar.seriesIndex}/C${bar.categoryIndex}`,
      bar.x + bar.width - 1, bar.y + bar.height - 1,
      bar.seriesIndex, bar.categoryIndex, bar.categoryName,
    ]);
    // Left edge
    hitCases.push([
      `left-edge of bar S${bar.seriesIndex}/C${bar.categoryIndex}`,
      bar.x, bar.y + bar.height / 2,
      bar.seriesIndex, bar.categoryIndex, bar.categoryName,
    ]);
  }

  it.each(hitCases)(
    "hit: %s",
    (_label, x, y, expectedSeries, expectedCategory, expectedCatName) => {
      const result = hitTestBarChart(x, y, bars, layout);
      expect(result.type).toBe("bar");
      expect(result.seriesIndex).toBe(expectedSeries);
      expect(result.categoryIndex).toBe(expectedCategory);
      expect(result.categoryName).toBe(expectedCatName);
    },
  );

  // --- Misses: points between bars and outside ---
  const missCases: Array<[string, number, number]> = [
    // Between bars
    ["between bar 0 and 1", 145, 200],
    ["between bar 1 and 2", 245, 200],
    ["between bar 2 and 3", 345, 200],
    ["between bar 3 and 4", 445, 200],
    // Above all bars
    ["above all bars", 100, 50],
    ["above all bars 2", 200, 50],
    ["above all bars 3", 300, 50],
    // Below all bars (still in plot area)
    ["below all bars", 100, 350],
    ["below all bars 2", 300, 350],
    // Far left
    ["far left", 20, 200],
    // Far right
    ["far right", 570, 200],
    // Corners of chart
    ["top-left corner", 0, 0],
    ["top-right corner", 600, 0],
    ["bottom-right corner", 600, 400],
    // Just outside each bar
    ["just left of bar 0", 59, 200],
    ["just right of bar 0", 141, 200],
    ["just above bar 0", 100, 99],
    ["just below bar 0", 100, 301],
    ["just left of bar 4", 459, 250],
    ["just right of bar 4", 541, 250],
  ];

  it.each(missCases)(
    "miss: %s",
    (_label, x, y) => {
      const result = hitTestBarChart(x, y, bars, layout);
      expect(result.type).not.toBe("bar");
    },
  );

  // --- Edge boundary tests: exact edges of bars ---
  const edgeCases: Array<[string, number, number, boolean]> = [];
  for (const bar of bars) {
    // Exact edges should hit (inclusive)
    edgeCases.push([`exact x=${bar.x},y=${bar.y} (top-left edge)`, bar.x, bar.y, true]);
    edgeCases.push([`exact x=${bar.x + bar.width},y=${bar.y + bar.height} (bottom-right edge)`, bar.x + bar.width, bar.y + bar.height, true]);
    // One pixel outside
    edgeCases.push([`x=${bar.x - 1} (just outside left)`, bar.x - 1, bar.y + bar.height / 2, false]);
    edgeCases.push([`y=${bar.y - 1} (just outside top)`, bar.x + bar.width / 2, bar.y - 1, false]);
  }

  it.each(edgeCases)(
    "edge: %s => hit=%s",
    (_label, x, y, shouldHit) => {
      const result = hitTestBarChart(x, y, bars, layout);
      if (shouldHit) {
        expect(result.type).toBe("bar");
      } else {
        expect(result.type).not.toBe("bar");
      }
    },
  );

  // --- Last-drawn-wins (reverse order priority) ---
  const overlappingBars: BarRect[] = [
    { seriesIndex: 0, categoryIndex: 0, x: 100, y: 100, width: 100, height: 100, value: 10, seriesName: "S0", categoryName: "X" },
    { seriesIndex: 1, categoryIndex: 0, x: 120, y: 120, width: 100, height: 100, value: 20, seriesName: "S1", categoryName: "X" },
  ];

  it("overlapping bars: last drawn wins", () => {
    // Point in overlap region
    const result = hitTestBarChart(150, 150, overlappingBars, layout);
    expect(result.type).toBe("bar");
    expect(result.seriesIndex).toBe(1); // last bar wins
  });
});

// ============================================================================
// 2. hitTestPoints — 80 coordinate combos
// ============================================================================

describe("hitTestPoints parameterized", () => {
  const markers: PointMarker[] = [
    { seriesIndex: 0, categoryIndex: 0, cx: 100, cy: 200, radius: 5, value: 10, seriesName: "S0", categoryName: "A" },
    { seriesIndex: 0, categoryIndex: 1, cx: 200, cy: 150, radius: 5, value: 20, seriesName: "S0", categoryName: "B" },
    { seriesIndex: 0, categoryIndex: 2, cx: 300, cy: 250, radius: 5, value: 15, seriesName: "S0", categoryName: "C" },
    { seriesIndex: 1, categoryIndex: 0, cx: 100, cy: 300, radius: 4, value: 8, seriesName: "S1", categoryName: "A" },
    { seriesIndex: 1, categoryIndex: 1, cx: 200, cy: 280, radius: 4, value: 12, seriesName: "S1", categoryName: "B" },
    { seriesIndex: 1, categoryIndex: 2, cx: 300, cy: 180, radius: 6, value: 25, seriesName: "S1", categoryName: "C" },
    { seriesIndex: 2, categoryIndex: 0, cx: 400, cy: 100, radius: 5, value: 30, seriesName: "S2", categoryName: "D" },
    { seriesIndex: 2, categoryIndex: 1, cx: 500, cy: 220, radius: 5, value: 18, seriesName: "S2", categoryName: "E" },
  ];

  const hitRadiusBonus = 3; // matches implementation

  // --- Direct hits: at marker center ---
  const centerHits: Array<[string, number, number, number, number]> = markers.map(m => [
    `center of S${m.seriesIndex}/C${m.categoryIndex}`,
    m.cx, m.cy, m.seriesIndex, m.categoryIndex,
  ]);

  it.each(centerHits)(
    "hit center: %s",
    (_label, x, y, expectedSeries, expectedCategory) => {
      const result = hitTestPoints(x, y, markers, layout);
      expect(result.type).toBe("point");
      expect(result.seriesIndex).toBe(expectedSeries);
      expect(result.categoryIndex).toBe(expectedCategory);
    },
  );

  // --- Hits at edge of hit radius ---
  const edgeHits: Array<[string, number, number, number, number]> = [];
  for (const m of markers) {
    const hitR = m.radius + hitRadiusBonus - 0.5; // just inside
    // Right edge
    edgeHits.push([`right edge S${m.seriesIndex}/C${m.categoryIndex}`, m.cx + hitR, m.cy, m.seriesIndex, m.categoryIndex]);
    // Top edge
    edgeHits.push([`top edge S${m.seriesIndex}/C${m.categoryIndex}`, m.cx, m.cy - hitR, m.seriesIndex, m.categoryIndex]);
  }

  it.each(edgeHits)(
    "hit edge: %s",
    (_label, x, y, expectedSeries, expectedCategory) => {
      const result = hitTestPoints(x, y, markers, layout);
      expect(result.type).toBe("point");
      expect(result.seriesIndex).toBe(expectedSeries);
      expect(result.categoryIndex).toBe(expectedCategory);
    },
  );

  // --- Misses: well outside all markers ---
  const missOffsets = [20, 30, 50];
  const missCases: Array<[string, number, number]> = [];
  for (const m of markers) {
    for (const off of missOffsets) {
      missCases.push([`${off}px right of S${m.seriesIndex}/C${m.categoryIndex}`, m.cx + off, m.cy]);
    }
  }
  // Add points far from all markers
  missCases.push(["empty space top-left", 55, 35]);
  missCases.push(["empty space bottom-right", 550, 350]);

  it.each(missCases)(
    "miss: %s",
    (_label, x, y) => {
      const result = hitTestPoints(x, y, markers, layout);
      expect(result.type).not.toBe("point");
    },
  );

  // --- Diagonal approach to each marker ---
  const diagonalCases: Array<[string, number, number, boolean]> = [];
  for (const m of markers) {
    const hitR = m.radius + hitRadiusBonus;
    // Diagonal at 45 degrees, just inside
    const insideDist = (hitR - 0.5) / Math.SQRT2;
    diagonalCases.push([
      `diagonal inside S${m.seriesIndex}/C${m.categoryIndex}`,
      m.cx + insideDist, m.cy + insideDist, true,
    ]);
    // Diagonal at 45 degrees, just outside
    const outsideDist = (hitR + 2) / Math.SQRT2;
    diagonalCases.push([
      `diagonal outside S${m.seriesIndex}/C${m.categoryIndex}`,
      m.cx + outsideDist, m.cy + outsideDist, false,
    ]);
  }

  it.each(diagonalCases)(
    "diagonal: %s => hit=%s",
    (_label, x, y, shouldHit) => {
      const result = hitTestPoints(x, y, markers, layout);
      if (shouldHit) {
        expect(result.type).toBe("point");
      } else {
        expect(result.type).not.toBe("point");
      }
    },
  );
});

// ============================================================================
// 3. hitTestSlices — 70 angle/radius combos
// ============================================================================

describe("hitTestSlices parameterized", () => {
  const cx = 300;
  const cy = 200;
  const innerRadius = 0; // pie (not donut)
  const outerRadius = 150;

  // Create 4 equal slices (each 90 degrees = PI/2 radians)
  // Starting from -PI/2 (12 o'clock), going clockwise
  const slices: SliceArc[] = [
    { seriesIndex: 0, startAngle: -Math.PI / 2, endAngle: 0, innerRadius, outerRadius, centerX: cx, centerY: cy, value: 25, label: "Q1", percent: 25 },
    { seriesIndex: 1, startAngle: 0, endAngle: Math.PI / 2, innerRadius, outerRadius, centerX: cx, centerY: cy, value: 25, label: "Q2", percent: 25 },
    { seriesIndex: 2, startAngle: Math.PI / 2, endAngle: Math.PI, innerRadius, outerRadius, centerX: cx, centerY: cy, value: 25, label: "Q3", percent: 25 },
    { seriesIndex: 3, startAngle: Math.PI, endAngle: 3 * Math.PI / 2, innerRadius, outerRadius, centerX: cx, centerY: cy, value: 25, label: "Q4", percent: 25 },
  ];

  // --- Hits at known angles and radii ---
  // Each slice covers a quadrant. Test at various radii and angles within each.
  const radii = [10, 50, 100, 140];
  const sliceAngles: Array<{ sliceIdx: number; angle: number; label: string }> = [
    // Q1: -PI/2 to 0 => atan2 range: top-right
    { sliceIdx: 0, angle: -Math.PI / 4, label: "Q1 mid" },
    { sliceIdx: 0, angle: -Math.PI * 3 / 8, label: "Q1 upper" },
    { sliceIdx: 0, angle: -Math.PI / 8, label: "Q1 lower" },
    // Q2: 0 to PI/2 => right-bottom
    { sliceIdx: 1, angle: Math.PI / 4, label: "Q2 mid" },
    { sliceIdx: 1, angle: Math.PI / 8, label: "Q2 upper" },
    { sliceIdx: 1, angle: Math.PI * 3 / 8, label: "Q2 lower" },
    // Q3: PI/2 to PI => bottom-left
    { sliceIdx: 2, angle: Math.PI * 3 / 4, label: "Q3 mid" },
    { sliceIdx: 2, angle: Math.PI * 5 / 8, label: "Q3 upper" },
    // Q4: PI to 3PI/2 => left-top
    { sliceIdx: 3, angle: Math.PI * 5 / 4, label: "Q4 mid" },
    { sliceIdx: 3, angle: Math.PI * 9 / 8, label: "Q4 upper" },
  ];

  const hitCases: Array<[string, number, number, number]> = [];
  for (const sa of sliceAngles) {
    for (const r of radii) {
      const x = cx + r * Math.cos(sa.angle);
      const y = cy + r * Math.sin(sa.angle);
      hitCases.push([`${sa.label}, r=${r}`, x, y, sa.sliceIdx]);
    }
  }

  it.each(hitCases)(
    "hit: %s => slice %d",
    (_label, x, y, expectedSlice) => {
      const result = hitTestSlices(x, y, slices, layout);
      expect(result.type).toBe("slice");
      expect(result.seriesIndex).toBe(expectedSlice);
    },
  );

  // --- Misses: outside the pie ---
  const missRadii = [151, 200, 300];
  const missAngles = [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 4];

  const missCases: Array<[string, number, number]> = [];
  for (const r of missRadii) {
    for (const a of missAngles) {
      missCases.push([
        `outside r=${r}, angle=${(a * 180 / Math.PI).toFixed(0)}deg`,
        cx + r * Math.cos(a),
        cy + r * Math.sin(a),
      ]);
    }
  }

  it.each(missCases)(
    "miss: %s",
    (_label, x, y) => {
      const result = hitTestSlices(x, y, slices, layout);
      expect(result.type).not.toBe("slice");
    },
  );

  // --- Donut: inner hole should miss ---
  const donutSlices: SliceArc[] = slices.map(s => ({ ...s, innerRadius: 60 }));

  const donutHoleCases: Array<[string, number, number]> = [];
  for (const a of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 4]) {
    for (const r of [5, 20, 40, 55]) {
      donutHoleCases.push([
        `donut hole r=${r}, angle=${(a * 180 / Math.PI).toFixed(0)}deg`,
        cx + r * Math.cos(a),
        cy + r * Math.sin(a),
      ]);
    }
  }

  it.each(donutHoleCases)(
    "donut miss: %s",
    (_label, x, y) => {
      const result = hitTestSlices(x, y, donutSlices, layout);
      expect(result.type).not.toBe("slice");
    },
  );

  // --- Donut: ring area should hit ---
  const donutRingCases: Array<[string, number, number, number]> = [];
  for (const sa of sliceAngles) {
    for (const r of [80, 110, 140]) {
      const x = cx + r * Math.cos(sa.angle);
      const y = cy + r * Math.sin(sa.angle);
      donutRingCases.push([`donut ring ${sa.label}, r=${r}`, x, y, sa.sliceIdx]);
    }
  }

  it.each(donutRingCases)(
    "donut hit: %s => slice %d",
    (_label, x, y, expectedSlice) => {
      const result = hitTestSlices(x, y, donutSlices, layout);
      expect(result.type).toBe("slice");
      expect(result.seriesIndex).toBe(expectedSlice);
    },
  );

  // --- Empty slices ---
  it("empty arcs returns none", () => {
    const result = hitTestSlices(cx, cy, [], layout);
    expect(result.type).toBe("none");
  });
});
