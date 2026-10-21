// FILENAME: app/extensions/Collaboration/lib/__tests__/writebackPainters.test.ts
// PURPOSE: The writeback grid painters: the state marker sits inside-left of
//          the note triangle and takes its colours from the theme tones; the
//          region frame paints only the active sheet's regions as a SOLID soft
//          line broken by a tiny "w" at the middle of every whole outer cell
//          edge, skipping edges that continue off-screen and walking only the
//          visible rows/columns.

import { describe, it, expect, vi } from "vitest";
import {
  markerKindFor,
  markerGeometry,
  paintWritebackMarker,
  createWritebackDecoration,
  NOTE_TRIANGLE_SIZE,
} from "../writebackDecorations";
import {
  createWritebackOutlinePainter,
  visibleIndices,
  FRAME_GLYPH,
  FRAME_LINE_ALPHA,
  FRAME_GLYPH_ALPHA,
  type OutlineRegion,
} from "../writebackOutline";
import type { GridLayerContext, RangeCanvasRect } from "@api/gridLayers";
import type { CellDecorationContext } from "@api/cellDecorations";

/** A recording 2D context: what was filled/stroked, with which style. */
function recorder() {
  const calls: {
    op: string;
    args: unknown[];
    fillStyle?: unknown;
    strokeStyle?: unknown;
    globalAlpha?: unknown;
  }[] = [];
  const ctx: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
    _dash: [] as number[],
  };
  const rec = (op: string) => (...args: unknown[]) =>
    calls.push({
      op,
      args,
      fillStyle: ctx.fillStyle,
      strokeStyle: ctx.strokeStyle,
      globalAlpha: ctx.globalAlpha,
    });
  for (const op of [
    "save", "restore", "beginPath", "arc", "fill", "stroke", "fillRect", "moveTo", "lineTo", "fillText",
  ]) {
    ctx[op] = rec(op);
  }
  ctx.measureText = () => ({ width: 6 });
  ctx.setLineDash = (d: number[]) => {
    ctx._dash = d;
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D & { _dash: number[] }, calls };
}

const colors = { warn: "WARN", danger: "DANGER", background: "BG" };
const cell = { cellLeft: 100, cellTop: 40, cellRight: 200, cellBottom: 60 };

describe("state marker", () => {
  it("only draft and rejected carry a marker", () => {
    expect(markerKindFor("draft")).toBe("draft");
    expect(markerKindFor("rejected")).toBe("rejected");
    expect(markerKindFor("empty")).toBeNull();
    expect(markerKindFor("submitted")).toBeNull();
    expect(markerKindFor("approved")).toBeNull();
    expect(markerKindFor(null)).toBeNull();
  });

  it("sits inside-left of the note triangle, never over it", () => {
    const g = markerGeometry(cell.cellRight, cell.cellTop);
    expect(g).toEqual({ cx: 191, cy: 45, r: 3 });
    // The disc's right edge reaches the triangle's left edge and no further.
    expect(g.cx + g.r).toBeLessThanOrEqual(cell.cellRight - NOTE_TRIANGLE_SIZE);
    // ...and it is inside the cell.
    expect(g.cy - g.r).toBeGreaterThanOrEqual(cell.cellTop);
  });

  it("paints a draft in the warn tone with a background-coloured ring", () => {
    const { ctx, calls } = recorder();
    paintWritebackMarker(ctx, cell, "draft", colors, 1);
    const arc = calls.find((c) => c.op === "arc")!;
    expect(arc.args.slice(0, 3)).toEqual([191, 45, 3]);
    expect(calls.find((c) => c.op === "fill")!.fillStyle).toBe("WARN");
    expect(calls.find((c) => c.op === "stroke")!.strokeStyle).toBe("BG");
    // No "!" glyph at 100%: it would be a smudge.
    expect(calls.some((c) => c.op === "fillRect")).toBe(false);
  });

  it("paints a draft's '!' only at high DPI", () => {
    const { ctx, calls } = recorder();
    paintWritebackMarker(ctx, cell, "draft", colors, 2);
    const glyph = calls.filter((c) => c.op === "fillRect");
    expect(glyph.length).toBe(2);
    expect(glyph.every((c) => c.fillStyle === "BG")).toBe(true);
  });

  it("paints a rejected value as a SQUARE in the danger tone -- a different shape, not only a colour", () => {
    const { ctx, calls } = recorder();
    paintWritebackMarker(ctx, cell, "rejected", colors, 1);
    expect(calls.some((c) => c.op === "arc")).toBe(false);
    // The square's corners, around the disc's centre (191, 45), side 6.
    const corners = calls.filter((c) => c.op === "moveTo" || c.op === "lineTo").map((c) => c.args);
    expect(corners).toEqual([
      [188, 42],
      [194, 42],
      [194, 48],
      [188, 48],
      [188, 42],
    ]);
    expect(calls.find((c) => c.op === "fill")!.fillStyle).toBe("DANGER");
    expect(calls.find((c) => c.op === "stroke")!.strokeStyle).toBe("BG");
    // At 100% the shape alone says "rejected": no glyph.
    expect(calls.filter((c) => c.op === "stroke").length).toBe(1);
  });

  it("adds an 'x' (not the draft's '!') to a rejected square at high DPI", () => {
    const { ctx, calls } = recorder();
    paintWritebackMarker(ctx, cell, "rejected", colors, 2);
    expect(calls.some((c) => c.op === "fillRect")).toBe(false);
    const strokes = calls.filter((c) => c.op === "stroke");
    expect(strokes.length).toBe(2);
    expect(strokes.every((c) => c.strokeStyle === "BG")).toBe(true);
  });

  it("skips a cell too narrow to hold the disc beside the triangle", () => {
    const { ctx, calls } = recorder();
    paintWritebackMarker(ctx, { ...cell, cellLeft: 190 }, "draft", colors, 1);
    expect(calls.length).toBe(0);
  });

  it("the decoration reads the state and the colours per cell", () => {
    const { ctx, calls } = recorder();
    const tones = vi.fn(() => colors);
    const decorate = createWritebackDecoration({
      cellState: (row) => (row === 3 ? "draft" : row === 4 ? "submitted" : null),
      colors: tones,
      pixelRatio: () => 1,
    });
    const base = { ctx, col: 1, ...cell } as unknown as CellDecorationContext;
    decorate({ ...base, row: 3 });
    decorate({ ...base, row: 4 });
    decorate({ ...base, row: 9 });
    expect(calls.filter((c) => c.op === "arc").length).toBe(1);
    expect(tones).toHaveBeenCalledTimes(1);
  });
});

describe("region frame layer", () => {
  // B3:B5 on a sheet of 100px columns and 20px rows, B at x=100, row 2 at y=60.
  const COL_W = 100;
  const ROW_H = 20;
  const xOf = (c: number) => (c - 1) * COL_W + 100;
  const yOf = (r: number) => (r - 2) * ROW_H + 60;

  function layerContext(
    ctx: CanvasRenderingContext2D,
    viewport = { startRow: 0, startCol: 0, rowCount: 30, colCount: 10, scrollX: 0, scrollY: 0 },
    freezeConfig: { freezeRow: number | null; freezeCol: number | null } | null = null,
  ): GridLayerContext {
    return { ctx, canvasWidth: 800, canvasHeight: 600, viewport, freezeConfig } as unknown as GridLayerContext;
  }

  /** Plain geometry: every range wholly on screen, unless `over` says otherwise. */
  function geometry(
    over: (sr: number, sc: number, er: number, ec: number) => Partial<RangeCanvasRect> = () => ({}),
  ) {
    return vi.fn(
      (_c: GridLayerContext, sr: number, sc: number, er: number, ec: number): RangeCanvasRect | null => ({
        x: xOf(sc),
        y: yOf(sr),
        width: (ec - sc + 1) * COL_W,
        height: (er - sr + 1) * ROW_H,
        clippedLeft: false,
        clippedTop: false,
        clippedRight: false,
        clippedBottom: false,
        ...over(sr, sc, er, ec),
      }),
    );
  }

  const B3_B5: OutlineRegion[] = [{ rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 1 }];
  const colors = () => ({ line: "LINE", glyph: "GLYPH" });

  it("frames B3:B5 with a solid soft line and one 'w' at the middle of every outer cell edge", () => {
    const { ctx, calls } = recorder();
    const paint = createWritebackOutlinePainter({ regions: () => B3_B5, colors, rectOf: geometry() });
    paint(layerContext(ctx));

    // Solid, never the copy marquee's dashes.
    expect((ctx as unknown as { _dash: number[] })._dash).toEqual([]);
    const stroke = calls.find((c) => c.op === "stroke")!;
    expect(stroke.strokeStyle).toBe("LINE");
    expect(stroke.globalAlpha).toBe(FRAME_LINE_ALPHA);

    const glyphs = calls.filter((c) => c.op === "fillText");
    expect(glyphs.every((g) => g.args[0] === FRAME_GLYPH)).toBe(true);
    expect(glyphs.every((g) => g.fillStyle === "GLYPH" && g.globalAlpha === FRAME_GLYPH_ALPHA)).toBe(true);
    const at = glyphs.map((g) => [g.args[1], g.args[2]]);
    // Top and bottom: one cell wide, so one "w" each, centred on B.
    expect(at).toContainEqual([150, 60.5 - 1]);
    expect(at).toContainEqual([150, 119.5 - 1]);
    // Left and right: one per row, centred on each row (y 70, 90, 110).
    for (const y of [70, 90, 110]) {
      expect(at).toContainEqual([100.5, y - 1]);
      expect(at).toContainEqual([199.5, y - 1]);
    }
    expect(glyphs.length).toBe(8);
  });

  it("breaks the line around each 'w' and nowhere else", () => {
    const { ctx, calls } = recorder();
    const paint = createWritebackOutlinePainter({ regions: () => B3_B5, colors, rectOf: geometry() });
    paint(layerContext(ctx));
    // The left edge: x = 100.5, from 60.5 to 119.5, cut around y 70, 90, 110
    // (glyph 9px high + 2px clear each side = 6.5 either side of the centre).
    const pairs: Array<[unknown[], unknown[]]> = [];
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].op === "moveTo" && calls[i + 1]?.op === "lineTo") pairs.push([calls[i].args, calls[i + 1].args]);
    }
    const left = pairs.filter(([a, b]) => a[0] === 100.5 && b[0] === 100.5).map(([a, b]) => [a[1], b[1]]);
    expect(left).toEqual([
      [60.5, 63.5],
      [76.5, 83.5],
      [96.5, 103.5],
      [116.5, 119.5],
    ]);
  });

  it("paints nothing when the active sheet has no regions (another sheet, a canvas page)", () => {
    const { ctx, calls } = recorder();
    const rectOf = geometry();
    const paint = createWritebackOutlinePainter({ regions: () => [], colors, rectOf });
    paint(layerContext(ctx));
    expect(rectOf).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it("skips an edge that continues off-screen, and gives no 'w' to a half-visible cell", () => {
    const { ctx, calls } = recorder();
    // The region runs off the bottom; its last visible row (4) is cut.
    const rectOf = geometry((sr, _sc, er) =>
      sr !== er ? { clippedBottom: true } : sr === 4 ? { clippedBottom: true } : {},
    );
    const paint = createWritebackOutlinePainter({ regions: () => B3_B5, colors, rectOf });
    paint(layerContext(ctx));
    const at = calls.filter((c) => c.op === "fillText").map((g) => [g.args[1], g.args[2]]);
    expect(at).not.toContainEqual([150, 119.5 - 1]); // no bottom edge
    expect(at).not.toContainEqual([100.5, 110 - 1]); // row 4 is cut: no centred "w"
    expect(at).toContainEqual([100.5, 70 - 1]);
    expect(at.length).toBe(1 + 2 + 2); // top + rows 2,3 on both sides
  });

  it("keeps a plain line on a cell too short for a 'w'", () => {
    const { ctx, calls } = recorder();
    const rectOf = vi.fn(
      (_c: GridLayerContext, sr: number, sc: number, er: number, ec: number): RangeCanvasRect => ({
        x: xOf(sc),
        y: (sr - 2) * 10 + 60,
        width: (ec - sc + 1) * COL_W,
        height: (er - sr + 1) * 10,
        clippedLeft: false,
        clippedTop: false,
        clippedRight: false,
        clippedBottom: false,
      }),
    );
    const paint = createWritebackOutlinePainter({ regions: () => B3_B5, colors, rectOf });
    paint(layerContext(ctx));
    const sides = calls.filter((c) => c.op === "fillText" && (c.args[1] === 100.5 || c.args[1] === 199.5));
    expect(sides.length).toBe(0);
    expect(calls.some((c) => c.op === "stroke")).toBe(true);
  });

  it("walks only the visible rows of a huge region", () => {
    const { ctx } = recorder();
    const rectOf = geometry();
    const huge: OutlineRegion[] = [{ rowStart: 0, rowEnd: 999_999, colStart: 1, colEnd: 1 }];
    const paint = createWritebackOutlinePainter({ regions: () => huge, colors, rectOf });
    paint(layerContext(ctx, { startRow: 5000, startCol: 0, rowCount: 30, colCount: 10, scrollX: 0, scrollY: 0 }));
    expect(rectOf.mock.calls.length).toBeLessThan(100);
  });

  it("visibleIndices: frozen ones first, then the scrolling window, clamped to the region", () => {
    expect(visibleIndices(0, 100, 2, 50, 3)).toEqual([0, 1, 50, 51, 52, 53, 54]);
    expect(visibleIndices(10, 12, null, 0, 30)).toEqual([10, 11, 12]);
    expect(visibleIndices(10, 12, 3, 40, 5)).toEqual([]);
  });
});
