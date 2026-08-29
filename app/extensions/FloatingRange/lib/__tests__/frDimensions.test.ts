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
  FR_EDGE_HANDLE_MIN_SPAN,
  FR_EDGE_HANDLE_HIT_R,
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
  frEdgeHandles,
  frEdgeHandleAt,
  edgeAxis,
  edgeMovesOrigin,
  clampScaleFactor,
  scaledColWidths,
  scaledRowHeights,
  trackedColIndices,
  trackedRowIndices,
  contentWidth,
  contentHeight,
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

// ============================================================================
// Edge handles — the CELL resize
// ============================================================================

describe("frEdgeHandles", () => {
  it("puts one at the middle of each edge", () => {
    const e = entry();
    const w = frameWidth(e);
    const h = frameHeight(e);
    const byEdge = Object.fromEntries(frEdgeHandles(e).map((x) => [x.edge, x]));
    expect(byEdge.left).toEqual({ edge: "left", x: 0, y: h / 2 });
    expect(byEdge.right).toEqual({ edge: "right", x: w, y: h / 2 });
    expect(byEdge.top).toEqual({ edge: "top", x: w / 2, y: 0 });
    expect(byEdge.bottom).toEqual({ edge: "bottom", x: w / 2, y: h });
  });

  it("withholds the handles on an edge too short to own the click", () => {
    // Core's corner boxes are 10px and win the mousedown. A left/right handle
    // sits at h/2 from both corners, so on a short frame it would be INSIDE a
    // corner box: grabbing the yellow ball would resize the counts instead.
    // The rule is to not offer it at all.
    const short = entry({ rows: 1, ...BARE, rowHeights: { 0: 20 } });
    expect(frameHeight(short)).toBe(20);
    expect(frameHeight(short)).toBeLessThan(FR_EDGE_HANDLE_MIN_SPAN);
    expect(frEdgeHandles(short).map((x) => x.edge).sort()).toEqual([
      "bottom",
      "top",
    ]);

    const narrow = entry({ cols: 1, ...BARE, colWidths: { 0: 20 } });
    expect(frameWidth(narrow)).toBe(20);
    expect(frEdgeHandles(narrow).map((x) => x.edge).sort()).toEqual([
      "left",
      "right",
    ]);
  });

  it("keeps every offered handle's WHOLE hit circle clear of Core's corner box", () => {
    // The property FR_EDGE_HANDLE_MIN_SPAN exists to guarantee, asserted
    // against Core's own number rather than against the constant — so raising
    // the constant carelessly cannot make this pass vacuously. It is the hit
    // CIRCLE that has to clear the box, not just the centre: Core runs at a
    // higher mousedown priority, so any overlap is a click that silently does
    // a count resize instead of a cell resize.
    const CORE_CORNER_HIT = 10; // HANDLE_HIT_SIZE, overlayResizeHandlers.ts
    for (const e of [
      entry(),
      entry(BARE),
      entry({ rows: 2, cols: 1 }),
      entry({ rows: 1, cols: 4, ...BARE }),
      entry({ rows: 3, cols: 3, colWidths: { 0: 12, 1: 12, 2: 12 } }),
      entry({ rows: 2, cols: 2, ...BARE, rowHeights: { 0: 18, 1: 18 } }),
    ]) {
      const w = frameWidth(e);
      const h = frameHeight(e);
      for (const handle of frEdgeHandles(e)) {
        for (const [cx, cy] of [
          [0, 0],
          [w, 0],
          [0, h],
          [w, h],
        ]) {
          // Nearest point of the circle to the corner, per axis.
          const nearestX = Math.max(0, Math.abs(handle.x - cx) - FR_EDGE_HANDLE_HIT_R);
          const nearestY = Math.max(0, Math.abs(handle.y - cy) - FR_EDGE_HANDLE_HIT_R);
          const overlapsCornerBox =
            nearestX <= CORE_CORNER_HIT && nearestY <= CORE_CORNER_HIT;
          expect(overlapsCornerBox).toBe(false);
        }
      }
    }
  });
});

describe("frEdgeHandleAt", () => {
  it("grabs a handle from either side of the border", () => {
    const e = entry();
    const w = frameWidth(e);
    const h = frameHeight(e);
    expect(frEdgeHandleAt(e, w, h / 2)).toBe("right");
    // The OUTER half matters: the ball straddles the border, so a click a few
    // pixels outside the frame is still on it.
    expect(frEdgeHandleAt(e, w + FR_EDGE_HANDLE_HIT_R - 1, h / 2)).toBe("right");
    expect(frEdgeHandleAt(e, -FR_EDGE_HANDLE_HIT_R + 1, h / 2)).toBe("left");
    expect(frEdgeHandleAt(e, w / 2, -FR_EDGE_HANDLE_HIT_R + 1)).toBe("top");
    expect(frEdgeHandleAt(e, w / 2, h + FR_EDGE_HANDLE_HIT_R - 1)).toBe("bottom");
  });

  it("misses everywhere else", () => {
    const e = entry();
    const w = frameWidth(e);
    const h = frameHeight(e);
    expect(frEdgeHandleAt(e, w / 2, h / 2)).toBeNull();
    expect(frEdgeHandleAt(e, w, h / 2 + FR_EDGE_HANDLE_HIT_R + 2)).toBeNull();
    expect(frEdgeHandleAt(e, 0, 0)).toBeNull();
  });

  it("maps edges to the axis they stretch", () => {
    expect(edgeAxis("left")).toBe("cols");
    expect(edgeAxis("right")).toBe("cols");
    expect(edgeAxis("top")).toBe("rows");
    expect(edgeAxis("bottom")).toBe("rows");
    expect(edgeMovesOrigin("left")).toBe(true);
    expect(edgeMovesOrigin("top")).toBe(true);
    expect(edgeMovesOrigin("right")).toBe(false);
    expect(edgeMovesOrigin("bottom")).toBe(false);
  });
});

describe("proportional scaling", () => {
  it("tracks the visible window AND overrides that outlive it", () => {
    // Shrinking the window hides columns without deleting them. Scaling only
    // the visible ones would skew the object the moment it grew back.
    const e = entry({ cols: 2, colWidths: { 0: 40, 1: 50, 7: 90 } });
    expect(trackedColIndices(e)).toEqual([0, 1, 7]);
    const e2 = entry({ rows: 1, rowHeights: { 4: 33 } });
    expect(trackedRowIndices(e2)).toEqual([0, 4]);
  });

  it("materializes defaults for columns that had no override", () => {
    const e = entry({ cols: 3 });
    expect(Object.keys(e.colWidths)).toHaveLength(0);
    const scaled = scaledColWidths(e, 2);
    expect(scaled).toEqual({
      0: FR_DEFAULT_COL_W * 2,
      1: FR_DEFAULT_COL_W * 2,
      2: FR_DEFAULT_COL_W * 2,
    });
  });

  it("preserves RELATIVE sizes exactly", () => {
    const e = entry({ cols: 2, colWidths: { 0: 30, 1: 90 } });
    const scaled = scaledColWidths(e, 1.5);
    expect(scaled[1] / scaled[0]).toBeCloseTo(3, 10);
    expect(scaled[0]).toBeCloseTo(45, 10);
  });

  it("scales the CONTENT extent by the factor, within the storage rounding", () => {
    // Sizes are stored to 1/100 px (see roundSize), so the extent can be off
    // by at most half a hundredth PER CELL. The tolerance is derived from that
    // rather than picked, so a change to the rounding fails here rather than
    // quietly widening what "proportional" means.
    const HALF_ULP = 0.005;
    const e = entry({ cols: 3, rows: 2 });
    const w0 = contentWidth(e);
    const h0 = contentHeight(e);
    const scaledE = {
      ...e,
      colWidths: scaledColWidths(e, 1.25),
      rowHeights: scaledRowHeights(e, 0.5),
    };
    expect(Math.abs(contentWidth(scaledE) - w0 * 1.25)).toBeLessThanOrEqual(
      HALF_ULP * e.cols,
    );
    expect(Math.abs(contentHeight(scaledE) - h0 * 0.5)).toBeLessThanOrEqual(
      HALF_ULP * e.rows,
    );
  });

  it("stores sizes at 1/100 px so a drag cannot bloat the document", () => {
    const e = entry({ cols: 2, colWidths: { 0: 64.29, 1: 33.333 } });
    for (const v of Object.values(scaledColWidths(e, 1.0374123456789))) {
      expect(Math.round(v * 100)).toBe(v * 100);
    }
  });

  describe("clampScaleFactor", () => {
    it("passes a factor that keeps everything in range", () => {
      expect(clampScaleFactor([40, 80], 1.5, 8, 1000)).toBe(1.5);
    });

    it("clamps on the SMALLEST size, not per column", () => {
      // 10 * 0.1 = 1, below the floor of 8. The floor is reached at 0.8, and
      // the BIG column must shrink by the same 0.8 — clamping per column would
      // have squashed only the small one and skewed the object.
      const s = clampScaleFactor([10, 100], 0.1, 8, 1000);
      expect(s).toBeCloseTo(0.8, 10);
      expect(10 * s).toBeCloseTo(8, 10);
      expect(100 * s).toBeCloseTo(80, 10);
    });

    it("clamps on the LARGEST size at the ceiling", () => {
      const s = clampScaleFactor([10, 500], 10, 8, 1000);
      expect(s).toBeCloseTo(2, 10);
    });

    it("refuses to move when the bounds cannot both hold", () => {
      // Already spanning more than the legal range: any scale breaks one end.
      expect(clampScaleFactor([8, 1000], 1.5, 8, 1000)).toBe(1);
      expect(clampScaleFactor([4, 2000], 0.9, 8, 1000)).toBe(1);
    });

    it("is inert on an empty set or a nonsense factor", () => {
      // A non-finite factor can only come from a divide-by-zero upstream (a
      // zero-extent object). Clamping it to the ceiling would turn an internal
      // arithmetic accident into a giant visible resize; staying put makes the
      // bug look like "the drag did nothing", which is the honest symptom.
      expect(clampScaleFactor([], 3, 8, 1000)).toBe(1);
      expect(clampScaleFactor([40], Number.NaN, 8, 1000)).toBe(1);
      expect(clampScaleFactor([40], Number.POSITIVE_INFINITY, 8, 1000)).toBe(1);
    });

    it("never lets a scaled size escape the bounds, over a sweep", () => {
      const sizes = [12, 40, 64.29, 300];
      for (let desired = 0.01; desired < 30; desired *= 1.35) {
        const s = clampScaleFactor(sizes, desired, 8, 1000);
        for (const size of sizes) {
          expect(size * s).toBeGreaterThanOrEqual(8 - 1e-9);
          expect(size * s).toBeLessThanOrEqual(1000 + 1e-9);
        }
      }
    });
  });
});
