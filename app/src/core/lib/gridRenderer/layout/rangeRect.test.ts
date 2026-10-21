//! FILENAME: app/src/core/lib/gridRenderer/layout/rangeRect.test.ts
// PURPOSE: The freeze-pane-aware range rectangle behind @api rangeToCanvasRect
//          (and Core's spill border): plain scrolling, frozen rows/columns, a
//          range scrolled under the frozen panes, a range spanning the freeze
//          line, the split bar, clipping flags and hidden lines.

import { describe, it, expect } from "vitest";
import { rangeToCanvasRect, columnXWithFreeze, rowYWithFreeze } from "./rangeRect";
import type { GridConfig, Viewport, DimensionOverrides, FreezeConfig } from "../../../types";
import { createEmptyDimensionOverrides } from "../../../types";

function makeConfig(): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 20,
    rowHeaderWidth: 50,
    colHeaderHeight: 24,
    totalRows: 1000,
    totalCols: 100,
    minColumnWidth: 20,
    minRowHeight: 10,
    outlineBarWidth: 0,
    outlineBarHeight: 0,
  } as GridConfig;
}
const dims = (): DimensionOverrides => createEmptyDimensionOverrides();
const vp = (scrollX = 0, scrollY = 0) => ({ scrollX, scrollY }) as Viewport;
const W = 800;
const H = 600;
const range = (startRow: number, startCol: number, endRow: number, endCol: number) => ({
  startRow,
  startCol,
  endRow,
  endCol,
});

describe("rangeToCanvasRect without panes", () => {
  it("places B3:B5 after the headers", () => {
    const r = rangeToCanvasRect(range(2, 1, 4, 1), makeConfig(), dims(), vp(), W, H, null);
    expect(r).toEqual({
      x: 150,
      y: 64,
      width: 100,
      height: 60,
      clippedLeft: false,
      clippedTop: false,
      clippedRight: false,
      clippedBottom: false,
    });
  });

  it("accepts the corners in any order", () => {
    const a = rangeToCanvasRect(range(4, 1, 2, 1), makeConfig(), dims(), vp(), W, H, null);
    const b = rangeToCanvasRect(range(2, 1, 4, 1), makeConfig(), dims(), vp(), W, H, null);
    expect(a).toEqual(b);
  });

  it("clips a range scrolled partly under the column header and flags the cut edge", () => {
    const r = rangeToCanvasRect(range(2, 1, 4, 1), makeConfig(), dims(), vp(0, 50), W, H, null)!;
    expect(r.y).toBe(24);
    expect(r.height).toBe(64 + 60 - 50 - 24);
    expect(r.clippedTop).toBe(true);
    expect(r.clippedBottom).toBe(false);
  });

  it("is null when scrolled entirely away", () => {
    expect(rangeToCanvasRect(range(2, 1, 4, 1), makeConfig(), dims(), vp(0, 5000), W, H, null)).toBeNull();
  });

  it("flags the right edge when the range runs off the canvas", () => {
    const r = rangeToCanvasRect(range(0, 5, 0, 20), makeConfig(), dims(), vp(), W, H, null)!;
    expect(r.x + r.width).toBe(W);
    expect(r.clippedRight).toBe(true);
  });

  it("is null when every row of the range is hidden", () => {
    const d = dims();
    d.hiddenRows = new Set([2, 3, 4]);
    expect(rangeToCanvasRect(range(2, 1, 4, 1), makeConfig(), d, vp(), W, H, null)).toBeNull();
  });
});

describe("rangeToCanvasRect with frozen panes", () => {
  const freeze: FreezeConfig = { freezeRow: 2, freezeCol: 1 };

  it("a range in the frozen rows does not move when the sheet scrolls", () => {
    const a = rangeToCanvasRect(range(0, 0, 1, 0), makeConfig(), dims(), vp(300, 300), W, H, freeze)!;
    expect(a.x).toBe(50);
    expect(a.y).toBe(24);
    expect(a.height).toBe(40);
  });

  it("a range in the scrolling part never paints over the frozen rows", () => {
    // Rows 2..4 start at 24 + 40 = 64 unscrolled; scrolled by 30 they would sit at 34.
    const r = rangeToCanvasRect(range(2, 1, 4, 1), makeConfig(), dims(), vp(0, 30), W, H, freeze)!;
    expect(r.y).toBe(64);
    expect(r.clippedTop).toBe(true);
    expect(r.height).toBe(64 + 60 - 30 - 64);
  });

  it("the overlay-style math (scroll subtracted from every row) would have been wrong", () => {
    // A FROZEN row stays put; the naive math would scroll it under the header.
    const naiveY = 24 + 1 * 20 - 30;
    expect(rowYWithFreeze(1, makeConfig(), dims(), vp(0, 30), freeze)).not.toBe(naiveY);
    expect(rowYWithFreeze(1, makeConfig(), dims(), vp(0, 30), freeze)).toBe(44);
  });

  it("a range spanning the freeze line keeps its frozen piece when the rest scrolled away", () => {
    const r = rangeToCanvasRect(range(0, 0, 3, 0), makeConfig(), dims(), vp(0, 400), W, H, freeze)!;
    expect(r.y).toBe(24);
    expect(r.y + r.height).toBe(64);
    expect(r.clippedBottom).toBe(true);
  });

  it("the split bar offsets the scrolling pane", () => {
    expect(columnXWithFreeze(1, makeConfig(), dims(), vp(), freeze, 4)).toBe(50 + 100 + 4);
    const r = rangeToCanvasRect(range(2, 1, 2, 1), makeConfig(), dims(), vp(), W, H, freeze, 4)!;
    expect(r.x).toBe(154);
    expect(r.y).toBe(68);
  });
});
