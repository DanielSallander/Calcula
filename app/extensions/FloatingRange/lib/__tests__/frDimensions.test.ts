//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frDimensions.test.ts
// PURPOSE: The floating range's frame anatomy — chrome extents, derived frame
//          size, cell origins, the hit-zone router and the quantized resize —
//          with and without each of the three chrome strips.
// CONTEXT: This module had NO tests, which is why the chrome flags land with
//          their own file. The interesting property is not that a hidden strip
//          paints nothing (a renderer concern); it is that a hidden strip has
//          ZERO EXTENT, so every derived coordinate moves with it and no zone
//          survives that the user can no longer see. A conditional that got
//          missed shows up here as a hit landing in the wrong place.

import { describe, it, expect } from "vitest";
import {
  FR_TITLE_H,
  FR_COL_HDR_H,
  FR_ROW_HDR_W,
  FR_DEFAULT_COL_W,
  FR_DEFAULT_ROW_H,
  frTitleH,
  frColHdrH,
  frRowHdrW,
  frCellsTop,
  frameWidth,
  frameHeight,
  frameSizeForCounts,
  localCellOrigin,
  localCellFromPoint,
  bestCountsForSize,
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
    rows: 3,
    cols: 2,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    ...overrides,
  };
}

const BARE = { showTitle: false, showColumnHeaders: false, showRowHeaders: false };

// ============================================================================
// Chrome extents
// ============================================================================

describe("chrome extents", () => {
  it("are the constants when shown and ZERO when hidden", () => {
    const shown = entry();
    expect(frTitleH(shown)).toBe(FR_TITLE_H);
    expect(frColHdrH(shown)).toBe(FR_COL_HDR_H);
    expect(frRowHdrW(shown)).toBe(FR_ROW_HDR_W);
    expect(frCellsTop(shown)).toBe(FR_TITLE_H + FR_COL_HDR_H);

    const bare = entry(BARE);
    expect(frTitleH(bare)).toBe(0);
    expect(frColHdrH(bare)).toBe(0);
    expect(frRowHdrW(bare)).toBe(0);
    expect(frCellsTop(bare)).toBe(0);
  });

  it("are independent — hiding one strip leaves the others alone", () => {
    const noTitle = entry({ showTitle: false });
    expect(frTitleH(noTitle)).toBe(0);
    expect(frColHdrH(noTitle)).toBe(FR_COL_HDR_H);
    expect(frRowHdrW(noTitle)).toBe(FR_ROW_HDR_W);
    expect(frCellsTop(noTitle)).toBe(FR_COL_HDR_H);
  });
});

// ============================================================================
// Derived frame size
// ============================================================================

describe("frame size", () => {
  it("is counts x sizes + whatever chrome is shown", () => {
    const e = entry();
    expect(frameWidth(e)).toBeCloseTo(FR_ROW_HDR_W + 2 * FR_DEFAULT_COL_W, 5);
    expect(frameHeight(e)).toBeCloseTo(
      FR_TITLE_H + FR_COL_HDR_H + 3 * FR_DEFAULT_ROW_H,
      5,
    );
  });

  it("collapses to pure content when every strip is hidden", () => {
    const e = entry(BARE);
    expect(frameWidth(e)).toBeCloseTo(2 * FR_DEFAULT_COL_W, 5);
    expect(frameHeight(e)).toBeCloseTo(3 * FR_DEFAULT_ROW_H, 5);
  });

  it("frameSizeForCounts agrees with frameWidth/Height at the live counts", () => {
    for (const e of [entry(), entry(BARE), entry({ showRowHeaders: false })]) {
      const s = frameSizeForCounts(e, e.rows, e.cols);
      expect(s.width).toBeCloseTo(frameWidth(e), 5);
      expect(s.height).toBeCloseTo(frameHeight(e), 5);
    }
  });
});

// ============================================================================
// Cell origins
// ============================================================================

describe("localCellOrigin", () => {
  it("starts the cell area after the chrome that is shown", () => {
    expect(localCellOrigin(entry(), 0, 0)).toEqual({
      x: FR_ROW_HDR_W,
      y: FR_TITLE_H + FR_COL_HDR_H,
    });
  });

  it("starts at the frame corner when there is no chrome", () => {
    expect(localCellOrigin(entry(BARE), 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("keeps per-cell offsets independent of the chrome", () => {
    const shown = entry();
    const bare = entry(BARE);
    const a = localCellOrigin(shown, 2, 1);
    const b = localCellOrigin(bare, 2, 1);
    expect(a.x - localCellOrigin(shown, 0, 0).x).toBeCloseTo(
      b.x - localCellOrigin(bare, 0, 0).x,
      5,
    );
    expect(a.y - localCellOrigin(shown, 0, 0).y).toBeCloseTo(
      b.y - localCellOrigin(bare, 0, 0).y,
      5,
    );
  });
});

// ============================================================================
// The hit-zone router — where a missed conditional actually bites
// ============================================================================

describe("localCellFromPoint with full chrome", () => {
  const e = entry();

  it("reads the top band as the title bar", () => {
    expect(localCellFromPoint(e, 40, 4)).toEqual({ zone: "title" });
  });

  it("reads the letter strip as the column header", () => {
    expect(localCellFromPoint(e, FR_ROW_HDR_W + 5, FR_TITLE_H + 4)).toEqual({
      zone: "colHeader",
      col: 0,
    });
  });

  it("reads the gutter as the row header", () => {
    expect(
      localCellFromPoint(e, 4, FR_TITLE_H + FR_COL_HDR_H + FR_DEFAULT_ROW_H + 2),
    ).toEqual({ zone: "rowHeader", row: 1 });
  });

  it("reads the corner box as chrome, not as a cell", () => {
    expect(localCellFromPoint(e, 4, FR_TITLE_H + 4)).toEqual({ zone: "title" });
  });

  it("resolves cells relative to the chrome", () => {
    expect(
      localCellFromPoint(
        e,
        FR_ROW_HDR_W + FR_DEFAULT_COL_W + 3,
        FR_TITLE_H + FR_COL_HDR_H + 3,
      ),
    ).toEqual({ zone: "cells", row: 0, col: 1 });
  });
});

describe("localCellFromPoint with the chrome hidden", () => {
  it("gives the frame's top-left to cell (0,0) when nothing is shown", () => {
    // The whole point: with no chrome there is no band left that could answer
    // "title" or "header", so the very first pixel is a cell.
    expect(localCellFromPoint(entry(BARE), 1, 1)).toEqual({
      zone: "cells",
      row: 0,
      col: 0,
    });
  });

  it("never answers title when the title bar is hidden", () => {
    const e = entry({ showTitle: false });
    for (let dy = 0; dy < frameHeight(e); dy += 2) {
      for (const dx of [1, FR_ROW_HDR_W + 1, frameWidth(e) - 1]) {
        expect(localCellFromPoint(e, dx, dy).zone).not.toBe("title");
      }
    }
  });

  it("never answers rowHeader when the gutter is hidden", () => {
    const e = entry({ showRowHeaders: false });
    for (let dy = 0; dy < frameHeight(e); dy += 2) {
      expect(localCellFromPoint(e, 0.5, dy).zone).not.toBe("rowHeader");
    }
  });

  it("never answers colHeader when the letters are hidden", () => {
    const e = entry({ showColumnHeaders: false });
    for (let dx = 0; dx < frameWidth(e); dx += 2) {
      expect(localCellFromPoint(e, dx, FR_TITLE_H + 0.5).zone).not.toBe(
        "colHeader",
      );
    }
  });

  it("hands the corner box to the row gutter when only the title is hidden", () => {
    // With a title bar the corner is a move grab zone. Without one there is
    // nothing to grab, so it belongs to the strip it sits above.
    const e = entry({ showTitle: false });
    expect(localCellFromPoint(e, 4, 4)).toEqual({ zone: "rowHeader", row: 0 });
  });

  it("still reports outside beyond the (now smaller) frame", () => {
    const e = entry(BARE);
    expect(localCellFromPoint(e, frameWidth(e) + 1, 1).zone).toBe("outside");
    expect(localCellFromPoint(e, 1, frameHeight(e) + 1).zone).toBe("outside");
  });

  it("puts every in-frame point in a zone the user can see", () => {
    for (const e of [
      entry(),
      entry(BARE),
      entry({ showTitle: false }),
      entry({ showColumnHeaders: false }),
      entry({ showRowHeaders: false }),
    ]) {
      for (let dy = 0.5; dy < frameHeight(e); dy += 3) {
        for (let dx = 0.5; dx < frameWidth(e); dx += 7) {
          const zone = localCellFromPoint(e, dx, dy).zone;
          expect(zone).not.toBe("outside");
          if (!e.showTitle) expect(zone).not.toBe("title");
          if (!e.showColumnHeaders) expect(zone).not.toBe("colHeader");
          if (!e.showRowHeaders) expect(zone).not.toBe("rowHeader");
        }
      }
    }
  });
});

// ============================================================================
// Quantized resize
// ============================================================================

describe("bestCountsForSize", () => {
  it("round-trips the frame size back to its own counts, chrome or not", () => {
    for (const e of [
      entry(),
      entry(BARE),
      entry({ showTitle: false }),
      entry({ showRowHeaders: false }),
    ]) {
      const size = frameSizeForCounts(e, 4, 3);
      expect(bestCountsForSize(e, size.width, size.height)).toEqual({
        rows: 4,
        cols: 3,
      });
    }
  });

  it("never returns less than one row or column", () => {
    const e = entry(BARE);
    expect(bestCountsForSize(e, 0, 0)).toEqual({ rows: 1, cols: 1 });
  });
});
