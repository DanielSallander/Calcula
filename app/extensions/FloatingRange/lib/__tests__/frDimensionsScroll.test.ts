//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frDimensionsScroll.test.ts
// PURPOSE: The M7 view geometry -- a floating range's cell area as a VIEWPORT
//          onto content that can reach past its window:
//          - the default view IS the pre-M7 window, answer for answer;
//          - offsets over the window land exactly on contentWidth/Height, so an
//            extent that equals the window has a max scroll of exactly 0;
//          - a scrolled point resolves to the scrolled cell, headers included,
//            and clamps to the EXTENT's last row/col, not the window's;
//          - localCellOrigin and localCellFromPoint stay inverses under scroll;
//          - the visible range and the reveal scroll are the minimal ones.

import { describe, it, expect } from "vitest";
import {
  FR_TITLE_H,
  FR_COL_HDR_H,
  FR_ROW_HDR_W,
  FR_DEFAULT_COL_W,
  FR_DEFAULT_ROW_H,
  contentWidth,
  contentHeight,
  frameWidth,
  frameHeight,
  frColOffsets,
  frRowOffsets,
  frMaxScroll,
  clampFrScrollTo,
  frVisibleRange,
  frScrollToReveal,
  localCellOrigin,
  localCellFromPoint,
  windowView,
  type FrView,
} from "../frDimensions";
import type { FloatingRangeEntry } from "../floatingRangeStore";

function entry(overrides: Partial<FloatingRangeEntry> = {}): FloatingRangeEntry {
  return {
    id: "fr-1",
    sheetIndex: 0,
    backingSheetIndex: 1,
    hostSheetId: "host",
    backingSheetId: "backing",
    name: "Float1",
    x: 0,
    y: 0,
    angle: 0,
    pinToGrid: false,
    rows: 4,
    cols: 3,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    ...overrides,
  };
}

/** A view over a 50 x 10 extent at the given scroll. */
function view(scrollLeft: number, scrollTop: number, rows = 50, cols = 10): FrView {
  return { scrollLeft, scrollTop, rows, cols };
}

const CELLS_TOP = FR_TITLE_H + FR_COL_HDR_H;

describe("the default view is the pre-M7 window", () => {
  it("windowView is unscrolled over exactly the window", () => {
    expect(windowView(entry())).toEqual({ scrollLeft: 0, scrollTop: 0, rows: 4, cols: 3 });
  });

  it("answers every in-frame point the same with or without an explicit window view", () => {
    const e = entry({ colWidths: { 1: 90 }, rowHeights: { 2: 33 } });
    for (let dx = 0; dx <= frameWidth(e); dx += 7) {
      for (let dy = 0; dy <= frameHeight(e); dy += 5) {
        expect(localCellFromPoint(e, dx, dy, windowView(e))).toEqual(localCellFromPoint(e, dx, dy));
      }
    }
  });

  it("offsets over the window end EXACTLY at the viewport size, so max scroll is 0", () => {
    const e = entry({ colWidths: { 0: 33.33, 2: 71.07 }, rowHeights: { 1: 17.7 } });
    const colOff = frColOffsets(e, e.cols);
    const rowOff = frRowOffsets(e, e.rows);
    expect(colOff[e.cols]).toBe(contentWidth(e));
    expect(rowOff[e.rows]).toBe(contentHeight(e));
    expect(frMaxScroll(e, e.rows, e.cols)).toEqual({ maxLeft: 0, maxTop: 0 });
  });
});

describe("max scroll over a larger extent", () => {
  it("is the extent's size minus the window's, per axis", () => {
    const e = entry();
    const m = frMaxScroll(e, 10, 5);
    expect(m.maxTop).toBe(Math.ceil(6 * FR_DEFAULT_ROW_H));
    expect(m.maxLeft).toBe(Math.ceil(2 * FR_DEFAULT_COL_W));
  });

  it("clamps a scroll into [0, max] and a non-finite one to 0", () => {
    const e = entry();
    expect(clampFrScrollTo(e, 10, 3, 999, 999)).toEqual({ left: 0, top: 120 });
    expect(clampFrScrollTo(e, 10, 3, -5, Number.NaN)).toEqual({ left: 0, top: 0 });
  });
});

describe("localCellFromPoint under scroll", () => {
  const e = entry();

  it("puts the SCROLLED cell under the viewport's first cell", () => {
    // Two rows and one column scrolled away.
    const v = view(FR_DEFAULT_COL_W, 2 * FR_DEFAULT_ROW_H);
    expect(localCellFromPoint(e, FR_ROW_HDR_W + 3, CELLS_TOP + 3, v)).toEqual({
      zone: "cells",
      row: 2,
      col: 1,
    });
  });

  it("answers the sticky headers with the scrolled index", () => {
    const v = view(2 * FR_DEFAULT_COL_W, 5 * FR_DEFAULT_ROW_H);
    expect(localCellFromPoint(e, FR_ROW_HDR_W + 3, FR_TITLE_H + 4, v)).toEqual({ zone: "colHeader", col: 2 });
    expect(localCellFromPoint(e, 4, CELLS_TOP + 3, v)).toEqual({ zone: "rowHeader", row: 5 });
  });

  it("resolves a part-scrolled cell by the part that shows", () => {
    // Half of row 0 scrolled away: the top 10px of the viewport is still row 0.
    const v = view(0, FR_DEFAULT_ROW_H / 2);
    expect(localCellFromPoint(e, FR_ROW_HDR_W + 3, CELLS_TOP + 5, v)).toEqual({ zone: "cells", row: 0, col: 0 });
    expect(localCellFromPoint(e, FR_ROW_HDR_W + 3, CELLS_TOP + 15, v)).toEqual({ zone: "cells", row: 1, col: 0 });
  });

  it("reaches rows past the WINDOW (the whole point of M7)", () => {
    // The window is 4 rows; scrolled to the last 4 rows of a 50-row extent.
    const v = view(0, 46 * FR_DEFAULT_ROW_H);
    const bottom = localCellFromPoint(e, FR_ROW_HDR_W + 3, frameHeight(e) - 1, v);
    expect(bottom).toEqual({ zone: "cells", row: 49, col: 0 });
  });

  it("clamps to the EXTENT's last row, never past it", () => {
    const v = view(0, 46 * FR_DEFAULT_ROW_H);
    expect(localCellFromPoint(e, FR_ROW_HDR_W + 3, frameHeight(e), v)).toEqual({ zone: "cells", row: 49, col: 0 });
  });

  it("hands a title-less corner box to the TOP VISIBLE row's gutter", () => {
    const bare = entry({ showTitle: false });
    const v = view(0, 7 * FR_DEFAULT_ROW_H);
    expect(localCellFromPoint(bare, 4, 4, v)).toEqual({ zone: "rowHeader", row: 7 });
    expect(localCellFromPoint(bare, 4, 4)).toEqual({ zone: "rowHeader", row: 0 });
  });
});

describe("localCellOrigin under scroll", () => {
  it("moves the cell up/left by exactly the scroll", () => {
    const e = entry();
    const v = view(30, 45);
    const a = localCellOrigin(e, 6, 4);
    const b = localCellOrigin(e, 6, 4, v);
    expect(a.x - b.x).toBe(30);
    expect(a.y - b.y).toBe(45);
  });

  it("is the inverse of localCellFromPoint for every visible cell", () => {
    const e = entry({ colWidths: { 3: 90 }, rowHeights: { 12: 31 } });
    const v = view(FR_DEFAULT_COL_W * 2 + 5, FR_DEFAULT_ROW_H * 10 + 7);
    const range = frVisibleRange(e, v);
    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        const o = localCellOrigin(e, r, c, v);
        // A point just inside the cell's bottom-right corner is always visible
        // when any of the cell is (the viewport clips the top-left first).
        const px = Math.min(o.x + 1, frameWidth(e) - 1);
        const py = Math.min(o.y + 1, frameHeight(e) - 1);
        const inX = o.x + 1 >= FR_ROW_HDR_W;
        const inY = o.y + 1 >= CELLS_TOP;
        if (!inX || !inY) continue;
        expect(localCellFromPoint(e, px, py, v)).toEqual({ zone: "cells", row: r, col: c });
      }
    }
  });
});

describe("frVisibleRange", () => {
  const e = entry();

  it("is the whole window when unscrolled", () => {
    expect(frVisibleRange(e, windowView(e))).toEqual({ startRow: 0, endRow: 3, startCol: 0, endCol: 2 });
  });

  it("includes a row that is only partly scrolled in or out", () => {
    const r = frVisibleRange(e, view(0, 10));
    expect(r.startRow).toBe(0); // half of row 0 still shows
    expect(r.endRow).toBe(4); // and half of row 4 has come in
  });

  it("narrows to the on-canvas part of the viewport", () => {
    // Only the viewport's bottom 20px is on the canvas: one row.
    const r = frVisibleRange(e, view(0, 100), { x0: 0, y0: 60, x1: 999, y1: 80 });
    expect(r.startRow).toBe(8);
    expect(r.endRow).toBe(8);
  });

  it("is empty when the on-canvas part is empty", () => {
    const r = frVisibleRange(e, view(0, 0), { x0: 0, y0: 90, x1: 999, y1: 120 });
    expect(r.endRow).toBeLessThan(r.startRow);
  });
});

describe("frScrollToReveal", () => {
  const e = entry();

  it("leaves a fully visible cell alone", () => {
    expect(frScrollToReveal(e, view(0, 0), 3, 2)).toEqual({ left: 0, top: 0 });
  });

  it("scrolls down just far enough to show a row below the viewport", () => {
    // Row 4 is the first row past a 4-row window: one row of scroll.
    expect(frScrollToReveal(e, view(0, 0), 4, 0)).toEqual({ left: 0, top: FR_DEFAULT_ROW_H });
  });

  it("scrolls up to a row above the viewport's top", () => {
    expect(frScrollToReveal(e, view(0, 400), 3, 0)).toEqual({ left: 0, top: 3 * FR_DEFAULT_ROW_H });
  });

  it("scrolls horizontally too, and clamps to the extent", () => {
    const next = frScrollToReveal(e, view(0, 0, 50, 10), 0, 9);
    expect(next.left).toBeCloseTo(7 * FR_DEFAULT_COL_W, 6);
    expect(next.left).toBeLessThanOrEqual(frMaxScroll(e, 50, 10).maxLeft);
  });

  it("completes a part-scrolled cell", () => {
    expect(frScrollToReveal(e, view(0, 10), 0, 0)).toEqual({ left: 0, top: 0 });
  });
});
