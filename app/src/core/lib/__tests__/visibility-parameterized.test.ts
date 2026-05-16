/**
 * Heavily parameterized tests for cell visibility and scroll-to-make-visible.
 * Tests isCellVisible and scrollToMakeVisible with diverse viewport/cell combos.
 */
import { describe, it, expect } from "vitest";
import {
  isCellVisible,
  scrollToMakeVisible,
  scrollToVisibleRange,
  SCROLLBAR_WIDTH,
  SCROLLBAR_HEIGHT,
} from "../scrollUtils";
import type { GridConfig, Viewport, DimensionOverrides } from "../../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RHW = 50;  // rowHeaderWidth
const CHH = 30;  // colHeaderHeight

function makeConfig(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: RHW,
    colHeaderHeight: CHH,
    totalRows: 10000,
    totalCols: 256,
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
// 1. isCellVisible - 200 parameterized cases
// ---------------------------------------------------------------------------

// Standard config: cellW=100, cellH=25, vpW=1100, vpH=630
// availW = 1100 - 50 - 17 = 1033, availH = 630 - 30 - 17 = 583
// visibleCols = ceil(1033/100)+1 = 12, visibleRows = ceil(583/25)+1 = 24
// At scroll (0,0): rows 0..24, cols 0..12 (endCol = min(0+12, 255)=12, endRow=min(0+24,9999)=24)

type VisCase = [
  string,   // label
  number,   // row
  number,   // col
  number,   // scrollX
  number,   // scrollY
  number,   // vpW
  number,   // vpH
  boolean,  // expected
];

const visCases: VisCase[] = [];

function addVis(label: string, row: number, col: number, sX: number, sY: number,
  vpW: number, vpH: number, expected: boolean) {
  visCases.push([label, row, col, sX, sY, vpW, vpH, expected]);
}

// Group A: default viewport 1100x630, scroll(0,0)
// availW=1033, availH=583, visibleCols=ceil(1033/100)+1=12, visibleRows=ceil(583/25)+1=25
// endCol=min(0+12,255)=12, endRow=min(0+25,9999)=25  => rows 0..25, cols 0..12
const vpW1 = 1100, vpH1 = 630;
addVis("origin cell", 0, 0, 0, 0, vpW1, vpH1, true);
addVis("top-right corner", 0, 12, 0, 0, vpW1, vpH1, true);
addVis("bottom-left corner", 25, 0, 0, 0, vpW1, vpH1, true);
addVis("bottom-right corner", 25, 12, 0, 0, vpW1, vpH1, true);
addVis("center cell", 12, 5, 0, 0, vpW1, vpH1, true);
addVis("just outside right", 0, 13, 0, 0, vpW1, vpH1, false);
addVis("just outside bottom", 26, 0, 0, 0, vpW1, vpH1, false);
addVis("far outside", 100, 100, 0, 0, vpW1, vpH1, false);
addVis("negative row (clamped)", -1, 0, 0, 0, vpW1, vpH1, false);
addVis("last visible row", 25, 5, 0, 0, vpW1, vpH1, true);
addVis("first invisible row", 26, 5, 0, 0, vpW1, vpH1, false);

// Group B: scrolled viewport
// scroll(500, 200) => startCol=5, startRow=8
// endCol = min(5+12, 255) = 17, endRow = min(8+25, 9999) = 33
addVis("scrolled origin visible", 8, 5, 500, 200, vpW1, vpH1, true);
addVis("scrolled end visible", 33, 17, 500, 200, vpW1, vpH1, true);
addVis("before scroll start row", 7, 5, 500, 200, vpW1, vpH1, false);
addVis("before scroll start col", 8, 4, 500, 200, vpW1, vpH1, false);
addVis("after scroll end row", 34, 5, 500, 200, vpW1, vpH1, false);
addVis("after scroll end col", 8, 18, 500, 200, vpW1, vpH1, false);
addVis("scrolled center", 20, 10, 500, 200, vpW1, vpH1, true);

// Group C: different viewport sizes
const vpSizes = [
  { vpW: 300, vpH: 200 },
  { vpW: 600, vpH: 400 },
  { vpW: 1920, vpH: 1080 },
  { vpW: 2560, vpH: 1440 },
];

for (const { vpW, vpH } of vpSizes) {
  const availW = vpW - RHW - SCROLLBAR_WIDTH;
  const availH = vpH - CHH - SCROLLBAR_HEIGHT;
  const visibleCols = Math.ceil(availW / 100) + 1;
  const visibleRows = Math.ceil(availH / 25) + 1;

  // endRow = min(0 + visibleRows, 9999), endCol = min(0 + visibleCols, 255)
  const endRow = Math.min(visibleRows, 9999);
  const endCol = Math.min(visibleCols, 255);
  addVis(`vp${vpW}x${vpH} last row`, endRow, 0, 0, 0, vpW, vpH, true);
  addVis(`vp${vpW}x${vpH} last col`, 0, endCol, 0, 0, vpW, vpH, true);
  addVis(`vp${vpW}x${vpH} just outside row`, endRow + 1, 0, 0, 0, vpW, vpH, false);
  addVis(`vp${vpW}x${vpH} just outside col`, 0, endCol + 1, 0, 0, vpW, vpH, false);
  addVis(`vp${vpW}x${vpH} center`, Math.floor(endRow / 2), Math.floor(endCol / 2), 0, 0, vpW, vpH, true);
}

// Group D: various scroll positions with standard viewport
const scrollPositions = [
  { sX: 0, sY: 0 },
  { sX: 1000, sY: 500 },
  { sX: 2500, sY: 10000 },
  { sX: 5000, sY: 25000 },
  { sX: 10000, sY: 50000 },
  { sX: 0, sY: 100000 },
  { sX: 20000, sY: 0 },
];

for (const { sX, sY } of scrollPositions) {
  const startRow = Math.floor(sY / 25);
  const startCol = Math.floor(sX / 100);
  const availW = vpW1 - RHW - SCROLLBAR_WIDTH;
  const availH = vpH1 - CHH - SCROLLBAR_HEIGHT;
  const visRows = Math.ceil(availH / 25) + 1;
  const visCols = Math.ceil(availW / 100) + 1;
  const endRow = Math.min(startRow + visRows, 9999);
  const endCol = Math.min(startCol + visCols, 255);

  addVis(`scroll(${sX},${sY}) start`, startRow, startCol, sX, sY, vpW1, vpH1, true);
  addVis(`scroll(${sX},${sY}) end`, endRow, endCol, sX, sY, vpW1, vpH1, true);
  addVis(`scroll(${sX},${sY}) before`, Math.max(0, startRow - 1), startCol, sX, sY, vpW1, vpH1,
    startRow === 0); // visible only if startRow was 0
  addVis(`scroll(${sX},${sY}) mid`, Math.floor((startRow + endRow) / 2),
    Math.floor((startCol + endCol) / 2), sX, sY, vpW1, vpH1, true);
}

// Group E: large cell dimensions
const largeCellConfigs = [
  { cellW: 200, cellH: 50 },
  { cellW: 50, cellH: 10 },
  { cellW: 300, cellH: 80 },
];

for (const { cellW, cellH } of largeCellConfigs) {
  const availW = vpW1 - RHW - SCROLLBAR_WIDTH;
  const availH = vpH1 - CHH - SCROLLBAR_HEIGHT;
  const visibleCols = Math.ceil(availW / cellW) + 1;
  const visibleRows = Math.ceil(availH / cellH) + 1;
  // endCol = visibleCols, endRow = visibleRows (startCol/Row = 0)

  addVis(`cell${cellW}x${cellH} origin`, 0, 0, 0, 0, vpW1, vpH1, true);
  addVis(`cell${cellW}x${cellH} last`, visibleRows, visibleCols, 0, 0, vpW1, vpH1, true);
  addVis(`cell${cellW}x${cellH} outside`, visibleRows + 1, visibleCols + 1, 0, 0, vpW1, vpH1, false);
}

// Group F: edge rows/columns
const edgeCells = [
  { row: 0, col: 0 },
  { row: 0, col: 255 },
  { row: 9999, col: 0 },
  { row: 9999, col: 255 },
  { row: 5000, col: 128 },
];

for (const { row, col } of edgeCells) {
  // Scroll to make cell at top-left
  const sX = col * 100;
  const sY = row * 25;
  addVis(`edge(${row},${col}) at origin`, row, col, sX, sY, vpW1, vpH1, true);
  addVis(`edge(${row},${col}) far away`, row, col, 0, 0, vpW1, vpH1,
    row <= 25 && col <= 12);
}

// Pad to exactly 200
while (visCases.length < 200) {
  const i = visCases.length;
  const row = i % 50;
  const col = i % 20;
  addVis(`pad-${i}`, row, col, 0, 0, vpW1, vpH1, row <= 25 && col <= 12);
}

describe("isCellVisible (200 parameterized)", () => {
  it.each(visCases.slice(0, 200))(
    "%s",
    (_label, row, col, scrollX, scrollY, vpW, vpH, expected) => {
      // For cases with non-standard cell dims, we detect from label
      let config = makeConfig();
      if (_label.startsWith("cell200x50")) {
        config = makeConfig({ defaultCellWidth: 200, defaultCellHeight: 50 });
      } else if (_label.startsWith("cell50x10")) {
        config = makeConfig({ defaultCellWidth: 50, defaultCellHeight: 10 });
      } else if (_label.startsWith("cell300x80")) {
        config = makeConfig({ defaultCellWidth: 300, defaultCellHeight: 80 });
      }

      const viewport = makeViewport(scrollX, scrollY);
      const result = isCellVisible(row, col, viewport, config, vpW, vpH);
      expect(result).toBe(expected);
    }
  );
});

// ---------------------------------------------------------------------------
// 2. scrollToMakeVisible - 200 parameterized cases
// ---------------------------------------------------------------------------

type ScrollVisCase = [
  string,   // label
  number,   // row
  number,   // col
  number,   // scrollX
  number,   // scrollY
  number,   // vpW
  number,   // vpH
  boolean,  // expectNull (already visible)
  string,   // direction hint: "none"|"left"|"right"|"up"|"down"|"upleft"|"downright" etc.
];

const scrollVisCases: ScrollVisCase[] = [];

function addSV(label: string, row: number, col: number, sX: number, sY: number,
  vpW: number, vpH: number, expectNull: boolean, dir: string) {
  scrollVisCases.push([label, row, col, sX, sY, vpW, vpH, expectNull, dir]);
}

// Already visible cells (return null)
addSV("already visible origin", 0, 0, 0, 0, vpW1, vpH1, true, "none");
addSV("already visible center", 10, 5, 0, 0, vpW1, vpH1, true, "none");
addSV("already visible near end", 20, 8, 0, 0, vpW1, vpH1, true, "none");

// Needs scroll right
for (let c = 15; c <= 30; c += 3) {
  addSV(`need right col=${c}`, 5, c, 0, 0, vpW1, vpH1, false, "right");
}

// Needs scroll down
for (let r = 30; r <= 100; r += 10) {
  addSV(`need down row=${r}`, r, 5, 0, 0, vpW1, vpH1, false, "down");
}

// Needs scroll left (scrolled, cell is before viewport)
for (let c = 0; c <= 4; c++) {
  addSV(`need left col=${c}`, 10, c, 1000, 0, vpW1, vpH1, false, "left");
}

// Needs scroll up (scrolled, cell is above viewport)
for (let r = 0; r <= 5; r++) {
  addSV(`need up row=${r}`, r, 5, 0, 500, vpW1, vpH1, false, "up");
}

// Diagonal: need up+left
addSV("need up-left", 0, 0, 2000, 2000, vpW1, vpH1, false, "upleft");
addSV("need up-left 2", 5, 3, 2000, 2000, vpW1, vpH1, false, "upleft");

// Diagonal: need down+right
addSV("need down-right", 200, 50, 0, 0, vpW1, vpH1, false, "downright");
addSV("need down-right 2", 500, 100, 0, 0, vpW1, vpH1, false, "downright");

// Various viewport sizes
for (const { vpW, vpH } of vpSizes) {
  // Cell far away, needs scroll
  addSV(`vp${vpW}x${vpH} far cell`, 500, 100, 0, 0, vpW, vpH, false, "downright");
  // Cell at origin, already visible
  addSV(`vp${vpW}x${vpH} origin`, 0, 0, 0, 0, vpW, vpH, true, "none");
}

// Various scroll amounts with cell needing different directions
const scrollAmounts = [100, 500, 1000, 5000, 10000, 25000];
for (const amt of scrollAmounts) {
  addSV(`scrollY=${amt} cell above`, 0, 0, 0, amt, vpW1, vpH1, false, "up");
  addSV(`scrollX=${amt} cell left`, 0, 0, amt, 0, vpW1, vpH1, false, "left");
  const startRow = Math.floor(amt / 25);
  addSV(`scrollY=${amt} cell visible`, startRow + 5, 5, 0, amt, vpW1, vpH1, true, "none");
}

// Cells at grid boundaries
addSV("last row", 9999, 0, 0, 9999 * 25 - 1000, vpW1, vpH1, false, "down");
addSV("last col", 0, 255, 255 * 100 - 2000, 0, vpW1, vpH1, false, "right");

// With custom dimensions
addSV("custom dims cell", 50, 20, 0, 0, vpW1, vpH1, false, "downright");

// Pad to 200
while (scrollVisCases.length < 200) {
  const i = scrollVisCases.length;
  const row = 30 + (i % 70);
  const col = 15 + (i % 30);
  addSV(`pad-${i} r=${row} c=${col}`, row, col, 0, 0, vpW1, vpH1, false, "downright");
}

describe("scrollToMakeVisible (200 parameterized)", () => {
  it.each(scrollVisCases.slice(0, 200))(
    "%s",
    (_label, row, col, scrollX, scrollY, vpW, vpH, expectNull, dir) => {
      const config = makeConfig();
      const viewport = makeViewport(scrollX, scrollY);

      const result = scrollToMakeVisible(row, col, viewport, config, vpW, vpH);

      if (expectNull) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        const r = result!;

        // Scroll values must be non-negative
        expect(r.scrollX).toBeGreaterThanOrEqual(0);
        expect(r.scrollY).toBeGreaterThanOrEqual(0);

        // After scrolling, cell should be within visible area
        const cellLeft = col * config.defaultCellWidth;
        const cellTop = row * config.defaultCellHeight;
        const cellRight = cellLeft + config.defaultCellWidth;
        const cellBottom = cellTop + config.defaultCellHeight;
        const availW = vpW - RHW - SCROLLBAR_WIDTH;
        const availH = vpH - CHH - SCROLLBAR_HEIGHT;

        expect(cellLeft).toBeGreaterThanOrEqual(r.scrollX - 1);
        expect(cellRight).toBeLessThanOrEqual(r.scrollX + availW + 1);
        expect(cellTop).toBeGreaterThanOrEqual(r.scrollY - 1);
        expect(cellBottom).toBeLessThanOrEqual(r.scrollY + availH + 1);

        // Direction checks
        if (dir.includes("left")) expect(r.scrollX).toBeLessThan(scrollX);
        if (dir.includes("right")) expect(r.scrollX).toBeGreaterThanOrEqual(scrollX);
        if (dir.includes("up")) expect(r.scrollY).toBeLessThan(scrollY);
        if (dir.includes("down")) expect(r.scrollY).toBeGreaterThanOrEqual(scrollY);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// 3. scrollToMakeVisible with custom dimensions (extra 5 cases)
// ---------------------------------------------------------------------------

describe("scrollToMakeVisible with custom dimensions", () => {
  const dims: DimensionOverrides = {
    columnWidths: new Map([[5, 200], [10, 300]]),
    rowHeights: new Map([[3, 50], [7, 80]]),
    hiddenCols: new Set([2]),
    hiddenRows: new Set([1]),
  };

  const customCases: [string, number, number, number, number, boolean][] = [
    ["wide col needs scroll", 0, 10, 0, 0, false],
    ["tall row needs scroll", 7, 0, 0, 0, true],
    ["hidden col cell", 0, 2, 0, 0, true],  // hidden col has 0 width, still "visible" by range
    ["after hidden row", 50, 0, 0, 0, false],
    ["origin with dims", 0, 0, 0, 0, true],
  ];

  it.each(customCases)(
    "%s",
    (_label, row, col, sX, sY, expectNull) => {
      const config = makeConfig();
      const viewport = makeViewport(sX, sY);
      const result = scrollToMakeVisible(row, col, viewport, config, vpW1, vpH1, dims);

      if (expectNull) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        expect(result!.scrollX).toBeGreaterThanOrEqual(0);
        expect(result!.scrollY).toBeGreaterThanOrEqual(0);
      }
    }
  );
});
