/**
 * Heavily parameterized tests for scrollbar metric calculations.
 * Tests calculateScrollbarMetrics, thumbPositionToScroll, and round-trip consistency.
 */
import { describe, it, expect } from "vitest";
import {
  calculateScrollbarMetrics,
  thumbPositionToScroll,
  SCROLLBAR_WIDTH,
  SCROLLBAR_HEIGHT,
} from "../scrollUtils";
import type { GridConfig, Viewport } from "../../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 30,
    totalRows: 1000,
    totalCols: 100,
    minColumnWidth: 20,
    minRowHeight: 10,
    maxColumnWidth: 500,
    maxRowHeight: 500,
    ...overrides,
  } as GridConfig;
}

function makeViewport(scrollX: number, scrollY: number): Viewport {
  return {
    startRow: 0,
    startCol: 0,
    rowCount: 20,
    colCount: 10,
    scrollX,
    scrollY,
  };
}

// ---------------------------------------------------------------------------
// 1. calculateScrollbarMetrics - 200 combos
// ---------------------------------------------------------------------------

type MetricsCase = [
  string,   // label
  number,   // totalRows
  number,   // totalCols
  number,   // cellW
  number,   // cellH
  number,   // vpW
  number,   // vpH
  number,   // scrollX
  number,   // scrollY
];

const viewportSizes = [
  { vpW: 200, vpH: 300 },
  { vpW: 500, vpH: 600 },
  { vpW: 800, vpH: 700 },
  { vpW: 1200, vpH: 900 },
  { vpW: 1920, vpH: 1080 },
  { vpW: 2560, vpH: 1440 },
  { vpW: 3840, vpH: 2160 },
  { vpW: 4000, vpH: 3000 },
];

const contentConfigs = [
  { totalRows: 50, totalCols: 10, cellW: 80, cellH: 20 },
  { totalRows: 200, totalCols: 26, cellW: 100, cellH: 25 },
  { totalRows: 1000, totalCols: 50, cellW: 120, cellH: 30 },
  { totalRows: 10000, totalCols: 100, cellW: 100, cellH: 25 },
  { totalRows: 100000, totalCols: 256, cellW: 80, cellH: 20 },
];

const scrollFractions = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];

// Build 200 cases
const metricsCases: MetricsCase[] = [];
let caseIdx = 0;
for (const cc of contentConfigs) {
  for (const vp of viewportSizes) {
    for (const frac of scrollFractions) {
      if (caseIdx >= 200) break;
      const contentW = cc.totalCols * cc.cellW;
      const contentH = cc.totalRows * cc.cellH;
      const availW = vp.vpW - 50 - SCROLLBAR_WIDTH;
      const availH = vp.vpH - 30 - SCROLLBAR_HEIGHT;
      const maxSX = Math.max(0, contentW - availW);
      const maxSY = Math.max(0, contentH - availH);
      const sX = Math.round(maxSX * frac);
      const sY = Math.round(maxSY * frac);
      metricsCases.push([
        `r=${cc.totalRows} c=${cc.totalCols} vp=${vp.vpW}x${vp.vpH} f=${frac}`,
        cc.totalRows, cc.totalCols, cc.cellW, cc.cellH,
        vp.vpW, vp.vpH, sX, sY,
      ]);
      caseIdx++;
    }
  }
}
// Pad to 200 if needed
while (metricsCases.length < 200) {
  const i = metricsCases.length;
  metricsCases.push([
    `extra-${i}`,
    500 + i, 30, 100, 25, 1000, 800,
    Math.round(i * 10), Math.round(i * 5),
  ]);
}

describe("calculateScrollbarMetrics (200 parameterized)", () => {
  it.each(metricsCases)(
    "%s",
    (_label, totalRows, totalCols, cellW, cellH, vpW, vpH, scrollX, scrollY) => {
      const config = makeConfig({
        totalRows,
        totalCols,
        defaultCellWidth: cellW,
        defaultCellHeight: cellH,
      });
      const viewport = makeViewport(scrollX, scrollY);
      const m = calculateScrollbarMetrics(config, viewport, vpW, vpH);

      // Track sizes equal available viewport dims
      const expectedHTrack = vpW - 50 - SCROLLBAR_WIDTH;
      const expectedVTrack = vpH - 30 - SCROLLBAR_HEIGHT;
      expect(m.horizontal.trackSize).toBe(expectedHTrack);
      expect(m.vertical.trackSize).toBe(expectedVTrack);

      // Thumb sizes: minimum 30 (may exceed track when viewport > content)
      expect(m.horizontal.thumbSize).toBeGreaterThanOrEqual(30);
      expect(m.vertical.thumbSize).toBeGreaterThanOrEqual(30);

      // When content > viewport, thumb should not exceed track
      const contentW = totalCols * cellW;
      const contentH = totalRows * cellH;
      if (contentW > expectedHTrack) {
        expect(m.horizontal.thumbSize).toBeLessThanOrEqual(expectedHTrack);
      }
      if (contentH > expectedVTrack) {
        expect(m.vertical.thumbSize).toBeLessThanOrEqual(expectedVTrack);
      }

      // Thumb position: non-negative
      expect(m.horizontal.thumbPosition).toBeGreaterThanOrEqual(0);
      expect(m.vertical.thumbPosition).toBeGreaterThanOrEqual(0);

      // When content exceeds viewport, thumb position within thumb range
      if (contentW > expectedHTrack) {
        expect(m.horizontal.thumbPosition).toBeLessThanOrEqual(
          m.horizontal.trackSize - m.horizontal.thumbSize + 0.01
        );
      }
      if (contentH > expectedVTrack) {
        expect(m.vertical.thumbPosition).toBeLessThanOrEqual(
          m.vertical.trackSize - m.vertical.thumbSize + 0.01
        );
      }

      // At scroll=0, thumb should be at 0
      if (scrollX === 0) {
        expect(m.horizontal.thumbPosition).toBe(0);
      }
      if (scrollY === 0) {
        expect(m.vertical.thumbPosition).toBe(0);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// 2. thumbPositionToScroll - 100 combos
// ---------------------------------------------------------------------------

type ThumbCase = [
  string,   // label
  number,   // thumbPosition
  number,   // thumbSize
  number,   // trackSize
  number,   // contentSize
  number,   // viewportSize
];

const thumbCases: ThumbCase[] = [];

const trackSizes = [100, 200, 400, 600, 800, 1000, 1500, 2000];
const contentSizes = [500, 1000, 5000, 10000, 50000, 100000];
const thumbFractions = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];

let tIdx = 0;
for (const track of trackSizes) {
  for (const content of contentSizes) {
    // viewportSize must be less than content for scrolling to exist
    const vpSize = Math.min(track, content - 1);
    if (vpSize <= 0) continue;
    const thumbSz = Math.max(30, (vpSize / content) * track);
    const thumbRange = track - thumbSz;
    for (const frac of thumbFractions) {
      if (tIdx >= 100) break;
      const pos = thumbRange > 0 ? frac * thumbRange : 0;
      thumbCases.push([
        `track=${track} content=${content} frac=${frac}`,
        pos, thumbSz, track, content, vpSize,
      ]);
      tIdx++;
    }
    if (tIdx >= 100) break;
  }
  if (tIdx >= 100) break;
}

while (thumbCases.length < 100) {
  const i = thumbCases.length;
  thumbCases.push([`extra-${i}`, i * 2, 40, 500, 5000, 400]);
}

describe("thumbPositionToScroll (100 parameterized)", () => {
  it.each(thumbCases)(
    "%s",
    (_label, thumbPosition, thumbSize, trackSize, contentSize, viewportSize) => {
      const scroll = thumbPositionToScroll(
        thumbPosition, thumbSize, trackSize, contentSize, viewportSize
      );

      const scrollRange = contentSize - viewportSize;
      const thumbRange = trackSize - thumbSize;

      // Result must be in valid range
      expect(scroll).toBeGreaterThanOrEqual(0);
      if (scrollRange > 0 && thumbRange > 0) {
        expect(scroll).toBeLessThanOrEqual(scrollRange + 0.01);
      }

      // At position 0, scroll should be 0
      if (thumbPosition === 0) {
        expect(scroll).toBe(0);
      }

      // At max position, scroll should equal scrollRange
      if (thumbRange > 0 && Math.abs(thumbPosition - thumbRange) < 0.01) {
        expect(scroll).toBeCloseTo(scrollRange, 0);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Round-trip: scroll -> metrics -> thumbPositionToScroll -> scroll (100 combos)
// ---------------------------------------------------------------------------

type RoundTripCase = [
  string,   // label
  number,   // totalRows
  number,   // totalCols
  number,   // cellW
  number,   // cellH
  number,   // vpW
  number,   // vpH
  number,   // scrollX
  number,   // scrollY
];

const rtCases: RoundTripCase[] = [];
let rtIdx = 0;
for (const cc of contentConfigs) {
  for (const vp of viewportSizes) {
    for (const frac of [0, 0.25, 0.5, 0.75, 1.0]) {
      if (rtIdx >= 100) break;
      const contentW = cc.totalCols * cc.cellW;
      const contentH = cc.totalRows * cc.cellH;
      const availW = vp.vpW - 50 - SCROLLBAR_WIDTH;
      const availH = vp.vpH - 30 - SCROLLBAR_HEIGHT;
      const maxSX = Math.max(0, contentW - availW);
      const maxSY = Math.max(0, contentH - availH);
      // Skip if viewport larger than content (no scrolling)
      if (maxSX <= 0 && maxSY <= 0) continue;
      const sX = Math.round(maxSX * frac);
      const sY = Math.round(maxSY * frac);
      rtCases.push([
        `rt r=${cc.totalRows} c=${cc.totalCols} vp=${vp.vpW}x${vp.vpH} f=${frac}`,
        cc.totalRows, cc.totalCols, cc.cellW, cc.cellH,
        vp.vpW, vp.vpH, sX, sY,
      ]);
      rtIdx++;
    }
    if (rtIdx >= 100) break;
  }
  if (rtIdx >= 100) break;
}

while (rtCases.length < 100) {
  const i = rtCases.length;
  rtCases.push([
    `rt-extra-${i}`, 2000, 50, 100, 25, 1200, 900,
    i * 100, i * 50,
  ]);
}

describe("Round-trip scroll -> thumb -> scroll (100 parameterized)", () => {
  it.each(rtCases)(
    "%s",
    (_label, totalRows, totalCols, cellW, cellH, vpW, vpH, scrollX, scrollY) => {
      const config = makeConfig({
        totalRows, totalCols,
        defaultCellWidth: cellW,
        defaultCellHeight: cellH,
      });
      const viewport = makeViewport(scrollX, scrollY);
      const m = calculateScrollbarMetrics(config, viewport, vpW, vpH);

      const contentW = totalCols * cellW;
      const contentH = totalRows * cellH;
      const availW = vpW - 50 - SCROLLBAR_WIDTH;
      const availH = vpH - 30 - SCROLLBAR_HEIGHT;

      // Reconstruct scroll from horizontal thumb
      if (contentW > availW) {
        const recoveredX = thumbPositionToScroll(
          m.horizontal.thumbPosition,
          m.horizontal.thumbSize,
          m.horizontal.trackSize,
          contentW,
          availW
        );
        expect(recoveredX).toBeCloseTo(scrollX, 0);
      }

      // Reconstruct scroll from vertical thumb
      if (contentH > availH) {
        const recoveredY = thumbPositionToScroll(
          m.vertical.thumbPosition,
          m.vertical.thumbSize,
          m.vertical.trackSize,
          contentH,
          availH
        );
        expect(recoveredY).toBeCloseTo(scrollY, 0);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Extra: edge cases for thumbPositionToScroll (degenerate inputs)
// ---------------------------------------------------------------------------

describe("thumbPositionToScroll edge cases", () => {
  const edgeCases: [string, number, number, number, number, number, number][] = [
    ["zero thumbRange", 0, 500, 500, 1000, 500, 0],
    ["zero scrollRange", 0, 30, 500, 500, 500, 0],
    ["both zero", 0, 500, 500, 500, 500, 0],
    ["very small track", 0, 30, 31, 10000, 30, 0],
    ["thumb equals track", 0, 100, 100, 100, 100, 0],
  ];

  it.each(edgeCases)(
    "%s",
    (_label, thumbPos, thumbSz, trackSz, contentSz, vpSz, expected) => {
      const result = thumbPositionToScroll(thumbPos, thumbSz, trackSz, contentSz, vpSz);
      expect(result).toBe(expected);
    }
  );
});
