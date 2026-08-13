//! FILENAME: app/src/core/lib/gridRenderer/interaction/paneAwareHitTesting.test.ts
// PURPOSE: Every path that turns a pixel into a CELL must be told about frozen
//          and split panes.
// CONTEXT: getCellFromPixel translates pane coordinates only when it is handed
//          `options.freezeConfig`. Two callers omitted it: the cell-click
//          interceptor dispatch in useSpreadsheetSelection and the grid context
//          menu in Spreadsheet.tsx. With a frozen header row they mapped the
//          pixel as if nothing were frozen, so an extension interceptor (the
//          note editor, a validation dropdown, a hyperlink follow, a button
//          cell) was handed a DIFFERENT cell from the one the same click
//          selected — and acted on it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getCellFromPixel } from "./hitTesting";
import { DEFAULT_GRID_CONFIG, type GridConfig, type Viewport } from "../../../types";

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: 64,
  defaultCellHeight: 20,
  totalRows: 1000,
  totalCols: 100,
};

/** Scrolled well down the sheet, with the top two rows frozen. */
const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 400,
  startRow: 20,
  startCol: 0,
  rowCount: 30,
  colCount: 10,
};

const FREEZE = { freezeRow: 2, freezeCol: 0 };
const DIMENSIONS = { columnWidths: new Map<number, number>(), rowHeights: new Map<number, number>() };

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(resolve(HERE, p), "utf8");

describe("pane translation is not optional", () => {
  // A pixel INSIDE the frozen band, which is where the two answers part
  // company: the frozen rows are pinned at the top of the sheet, while an
  // unaware mapping reads the same pixel through the scroll offset.
  const PIXEL_X = CONFIG.rowHeaderWidth + 10;
  const PIXEL_Y = CONFIG.colHeaderHeight + 10;

  it("the same pixel resolves to DIFFERENT cells with and without the pane options", () => {
    const blind = getCellFromPixel(PIXEL_X, PIXEL_Y, CONFIG, VIEWPORT, DIMENSIONS);
    const aware = getCellFromPixel(PIXEL_X, PIXEL_Y, CONFIG, VIEWPORT, DIMENSIONS, {
      freezeConfig: FREEZE,
    });

    expect(blind).toEqual({ row: 20, col: 0 });   // scrolled: row 21 on screen
    expect(aware).toEqual({ row: 0, col: 0 });    // frozen: the sheet's first row
    // The gap is 20 rows: an interceptor handed `blind` acts on a cell the user
    // is not even pointing at.
    expect(aware!.row).not.toBe(blind!.row);
  });

  it("a frozen COLUMN band diverges the same way", () => {
    const scrolledRight: Viewport = { ...VIEWPORT, scrollX: 320, startCol: 5 };
    const pixelX = CONFIG.rowHeaderWidth + 10;
    const pixelY = CONFIG.colHeaderHeight + 200;

    const blind = getCellFromPixel(pixelX, pixelY, CONFIG, scrolledRight, DIMENSIONS);
    const aware = getCellFromPixel(pixelX, pixelY, CONFIG, scrolledRight, DIMENSIONS, {
      freezeConfig: { freezeRow: 0, freezeCol: 2 },
    });

    expect(blind!.col).toBe(5);
    expect(aware!.col).toBe(0);
  });
});

describe("every pixel-to-cell caller in the interaction paths passes the pane options", () => {
  // A source census rather than a mock: these two call sites live inside React
  // callbacks that a unit test cannot reach without standing up the whole grid,
  // and the defect was precisely an omitted ARGUMENT — which source can see.
  const callsWithOptions = (source: string): { total: number; withOptions: number } => {
    let total = 0;
    let withOptions = 0;
    const re = /getCellFromPixel\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      // Skip imports/re-exports, which are not calls.
      const lineStart = source.lastIndexOf("\n", m.index) + 1;
      const line = source.slice(lineStart, source.indexOf("\n", m.index));
      if (/^\s*(import|export)\b/.test(line)) continue;
      total++;
      // Walk to the matching ")" and look for a freezeConfig in the arguments.
      let depth = 0;
      let i = m.index + "getCellFromPixel".length;
      for (; i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (/freezeConfig/.test(source.slice(m.index, i))) withOptions++;
    }
    return { total, withOptions };
  };

  const FILES = [
    "../../../components/Spreadsheet/useSpreadsheetSelection.ts",
    "../../../components/Spreadsheet/Spreadsheet.tsx",
  ];

  for (const file of FILES) {
    it(`${file.split("/").pop()} maps pixels with the pane options`, () => {
      const { total, withOptions } = callsWithOptions(read(file));
      expect(total, "the call this test is about still exists").toBeGreaterThan(0);
      expect(withOptions).toBe(total);
    });
  }

  it("the census itself fires on a call that omits them", () => {
    const { total, withOptions } = callsWithOptions(
      "const c = getCellFromPixel(x, y, config, viewport, dimensions);\n",
    );
    expect(total).toBe(1);
    expect(withOptions).toBe(0);
  });
});
