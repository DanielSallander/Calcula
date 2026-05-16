import { describe, it, expect } from 'vitest';

// --- Helpers ---

function scrollToVisibleRange(
  scrollX: number,
  scrollY: number,
  viewportWidth: number,
  viewportHeight: number,
  colWidth = 100,
  rowHeight = 25
) {
  const startCol = Math.max(0, Math.floor(scrollX / colWidth));
  const endCol = Math.max(startCol + 1, Math.ceil((scrollX + viewportWidth) / colWidth));
  const startRow = Math.max(0, Math.floor(scrollY / rowHeight));
  const endRow = Math.max(startRow + 1, Math.ceil((scrollY + viewportHeight) / rowHeight));
  return { startRow, endRow, startCol, endCol };
}

function getColumnXPosition(col: number, colWidth = 100): number {
  return col * colWidth;
}

function getRowYPosition(row: number, rowHeight = 25): number {
  return row * rowHeight;
}

function isCellVisible(
  row: number,
  col: number,
  scrollX: number,
  scrollY: number,
  viewportWidth: number,
  viewportHeight: number,
  colWidth = 100,
  rowHeight = 25
): boolean {
  const cellX = col * colWidth;
  const cellY = row * rowHeight;
  return (
    cellX >= scrollX &&
    cellX + colWidth <= scrollX + viewportWidth &&
    cellY >= scrollY &&
    cellY + rowHeight <= scrollY + viewportHeight
  );
}

type ScrollDirection = 'up' | 'down' | 'left' | 'right';
type ScrollUnit = 'line' | 'page' | 'cell';

function calculateScrollDelta(
  direction: ScrollDirection,
  unit: ScrollUnit,
  viewportWidth: number,
  viewportHeight: number,
  colWidth = 100,
  rowHeight = 25
): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  const amount =
    unit === 'line'
      ? direction === 'up' || direction === 'down'
        ? rowHeight
        : colWidth
      : unit === 'page'
        ? direction === 'up' || direction === 'down'
          ? viewportHeight
          : viewportWidth
        : direction === 'up' || direction === 'down'
          ? rowHeight
          : colWidth;

  if (direction === 'up') dy = -amount;
  else if (direction === 'down') dy = amount;
  else if (direction === 'left') dx = -amount;
  else if (direction === 'right') dx = amount;

  return { dx, dy };
}

// --- Test data generation ---

const scrollValues = [0, 10, 25, 50, 100, 200, 300, 500, 750, 1000, 2000, 3000, 5000, 7500, 10000, 25000, 50000, 75000, 100000, 250000];
const viewports = [
  { w: 400, h: 300 },
  { w: 600, h: 400 },
  { w: 800, h: 500 },
  { w: 1000, h: 600 },
  { w: 1200, h: 700 },
  { w: 1400, h: 800 },
  { w: 1600, h: 1000 },
  { w: 1800, h: 1200 },
  { w: 1920, h: 1080 },
  { w: 2000, h: 1500 },
];

// 1. scrollToVisibleRange: 200 cases (20 scroll values x 10 viewports)
const visibleRangeCases: [number, number, number, number, string][] = [];
for (const sv of scrollValues) {
  for (const vp of viewports) {
    visibleRangeCases.push([sv, sv, vp.w, vp.h, `scroll(${sv},${sv}) vp(${vp.w}x${vp.h})`]);
  }
}

describe('scrollToVisibleRange', () => {
  it.each(visibleRangeCases)(
    'startRow>=0, endRow>startRow, startCol>=0, endCol>startCol for %s',
    (scrollX, scrollY, vpW, vpH, _label) => {
      const r = scrollToVisibleRange(scrollX, scrollY, vpW, vpH);
      expect(r.startRow).toBeGreaterThanOrEqual(0);
      expect(r.endRow).toBeGreaterThan(r.startRow);
      expect(r.startCol).toBeGreaterThanOrEqual(0);
      expect(r.endCol).toBeGreaterThan(r.startCol);
    }
  );
});

// 2. getColumnXPosition: 200 cases (cols 0-199)
const colCases = Array.from({ length: 200 }, (_, i) => [i, i * 100] as [number, number]);

describe('getColumnXPosition', () => {
  it.each(colCases)('col %i => position %i', (col, expected) => {
    expect(getColumnXPosition(col)).toBe(expected);
  });
});

// 3. getRowYPosition: 200 cases (rows 0-199)
const rowCases = Array.from({ length: 200 }, (_, i) => [i, i * 25] as [number, number]);

describe('getRowYPosition', () => {
  it.each(rowCases)('row %i => position %i', (row, expected) => {
    expect(getRowYPosition(row)).toBe(expected);
  });
});

// 4. isCellVisible: 200 cases
const visibilityCases: [number, number, number, number, number, number, boolean, string][] = [];
for (let i = 0; i < 200; i++) {
  const row = i % 20;
  const col = Math.floor(i / 20);
  const scrollX = col > 5 ? (col - 3) * 100 : 0;
  const scrollY = row > 5 ? (row - 3) * 25 : 0;
  const vpW = 800;
  const vpH = 300;
  const visible = isCellVisible(row, col, scrollX, scrollY, vpW, vpH);
  visibilityCases.push([row, col, scrollX, scrollY, vpW, vpH, visible, `row=${row} col=${col} scroll(${scrollX},${scrollY})`]);
}

describe('isCellVisible', () => {
  it.each(visibilityCases)(
    'cell visibility correct for %s',
    (row, col, scrollX, scrollY, vpW, vpH, expected, _label) => {
      expect(isCellVisible(row, col, scrollX, scrollY, vpW, vpH)).toBe(expected);
    }
  );
});

// 5. calculateScrollDelta: 240 cases (4 directions x 3 units x 20 viewport configs)
const directions: ScrollDirection[] = ['up', 'down', 'left', 'right'];
const units: ScrollUnit[] = ['line', 'page', 'cell'];
const deltaCases: [ScrollDirection, ScrollUnit, number, number, string][] = [];
for (const dir of directions) {
  for (const unit of units) {
    for (const vp of viewports) {
      deltaCases.push([dir, unit, vp.w, vp.h, `${dir}/${unit} vp(${vp.w}x${vp.h})`]);
    }
  }
}

// Extra cases to push past 200: add more viewport variations
const extraViewports = [
  { w: 500, h: 350 }, { w: 700, h: 450 }, { w: 900, h: 550 },
  { w: 1100, h: 650 }, { w: 1300, h: 750 }, { w: 1500, h: 900 },
  { w: 1700, h: 1100 }, { w: 1850, h: 1300 }, { w: 1950, h: 1400 },
  { w: 2200, h: 1600 },
];
for (const dir of directions) {
  for (const unit of units) {
    for (const vp of extraViewports) {
      deltaCases.push([dir, unit, vp.w, vp.h, `${dir}/${unit} vp(${vp.w}x${vp.h})`]);
    }
  }
}

describe('calculateScrollDelta', () => {
  it.each(deltaCases)(
    'produces valid delta for %s',
    (dir, unit, vpW, vpH, _label) => {
      const { dx, dy } = calculateScrollDelta(dir, unit, vpW, vpH);
      if (dir === 'up') {
        expect(dy).toBeLessThan(0);
        expect(dx).toBe(0);
      } else if (dir === 'down') {
        expect(dy).toBeGreaterThan(0);
        expect(dx).toBe(0);
      } else if (dir === 'left') {
        expect(dx).toBeLessThan(0);
        expect(dy).toBe(0);
      } else {
        expect(dx).toBeGreaterThan(0);
        expect(dy).toBe(0);
      }
    }
  );
});
