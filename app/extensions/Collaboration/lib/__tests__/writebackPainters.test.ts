// FILENAME: app/extensions/Collaboration/lib/__tests__/writebackPainters.test.ts
// PURPOSE: The writeback grid painters: the state marker sits inside-left of
//          the note triangle and takes its colours from the theme tones; the
//          region frame paints only the active sheet's regions as a SOLID soft
//          line broken ONCE per edge by a small edit icon at the middle of the
//          edge's visible length, skipping edges that continue off-screen.

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
  drawEditIcon,
  FRAME_ICON_SIZE,
  FRAME_LINE_ALPHA,
  FRAME_ICON_ALPHA,
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
  // B3:B5 on a sheet of 100px columns and 20px rows: x 100..200, y 60..120.
  function layerContext(ctx: CanvasRenderingContext2D): GridLayerContext {
    return { ctx, canvasWidth: 800, canvasHeight: 600 } as unknown as GridLayerContext;
  }

  function rect(over: Partial<RangeCanvasRect> = {}): RangeCanvasRect {
    return {
      x: 100,
      y: 60,
      width: 100,
      height: 60,
      clippedLeft: false,
      clippedTop: false,
      clippedRight: false,
      clippedBottom: false,
      ...over,
    };
  }

  const B3_B5: OutlineRegion[] = [{ rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 1 }];
  const colors = () => ({ line: "LINE", glyph: "GLYPH" });

  /** Each stroke() with the style it was made in. */
  const strokes = (calls: ReturnType<typeof recorder>["calls"]) => calls.filter((c) => c.op === "stroke");

  /** The first moveTo after each beginPath that precedes an icon stroke. */
  function iconAnchors(calls: ReturnType<typeof recorder>["calls"]): unknown[][] {
    const out: unknown[][] = [];
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].op !== "beginPath") continue;
      const end = calls.findIndex((c, j) => j > i && c.op === "stroke");
      if (end < 0 || calls[end].strokeStyle !== "GLYPH") continue;
      const first = calls.find((c, j) => j > i && j < end && c.op === "moveTo");
      if (first) out.push(first.args);
    }
    return out;
  }

  it("frames the region with a solid line and ONE edit icon in the middle of each edge", () => {
    const { ctx, calls } = recorder();
    const paint = createWritebackOutlinePainter({ regions: () => B3_B5, colors, rectOf: () => rect() });
    paint(layerContext(ctx));

    // Solid, never the copy marquee's dashes.
    expect((ctx as unknown as { _dash: number[] })._dash).toEqual([]);
    const s = strokes(calls);
    expect(s[0].strokeStyle).toBe("LINE");
    expect(s[0].globalAlpha).toBe(FRAME_LINE_ALPHA);
    // Then exactly four icons, in the icon colour.
    const icons = s.slice(1);
    expect(icons.length).toBe(4);
    expect(icons.every((c) => c.strokeStyle === "GLYPH" && c.globalAlpha === FRAME_ICON_ALPHA)).toBe(true);
    // Centred on each edge: top/bottom at x 150.5, left/right at y 90.5. The
    // icon's first point is (11, 4) on its 24-unit grid: centre + (-0.5, -4).
    expect(iconAnchors(calls)).toEqual([
      [150, 60.5 - 4],
      [150, 119.5 - 4],
      [100, 90.5 - 4],
      [199, 90.5 - 4],
    ]);
  });

  it("breaks each edge once, around its icon", () => {
    const { ctx, calls } = recorder();
    const paint = createWritebackOutlinePainter({ regions: () => B3_B5, colors, rectOf: () => rect() });
    paint(layerContext(ctx));
    const lineEnd = calls.findIndex((c) => c.op === "stroke");
    const pairs: Array<[unknown[], unknown[]]> = [];
    for (let i = 0; i < lineEnd; i++) {
      if (calls[i].op === "moveTo" && calls[i + 1]?.op === "lineTo") pairs.push([calls[i].args, calls[i + 1].args]);
    }
    // The left edge: x = 100.5 from 60.5 to 119.5, cut 8px (6 + 2) either side of 90.5.
    const left = pairs.filter(([a, b]) => a[0] === 100.5 && b[0] === 100.5).map(([a, b]) => [a[1], b[1]]);
    expect(left).toEqual([
      [60.5, 82.5],
      [98.5, 119.5],
    ]);
    expect(pairs.length).toBe(8); // four edges, two pieces each
  });

  it("paints nothing when the active sheet has no regions (another sheet, a canvas page)", () => {
    const { ctx, calls } = recorder();
    const rectOf = vi.fn(() => rect());
    const paint = createWritebackOutlinePainter({ regions: () => [], colors, rectOf });
    paint(layerContext(ctx));
    expect(rectOf).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it("skips an edge that continues off-screen, and its icon", () => {
    const { ctx, calls } = recorder();
    const paint = createWritebackOutlinePainter({
      regions: () => B3_B5,
      colors,
      rectOf: () => rect({ clippedBottom: true }),
    });
    paint(layerContext(ctx));
    expect(strokes(calls).length).toBe(1 + 3);
    expect(iconAnchors(calls)).not.toContainEqual([150, 119.5 - 4]);
  });

  it("keeps a plain line on an edge too short for the icon (one 20px row)", () => {
    const { ctx, calls } = recorder();
    const paint = createWritebackOutlinePainter({
      regions: () => [{ rowStart: 2, rowEnd: 2, colStart: 1, colEnd: 1 }],
      colors,
      rectOf: () => rect({ height: 20 }),
    });
    paint(layerContext(ctx));
    // Top and bottom keep their icons; the 19px sides do not.
    expect(iconAnchors(calls)).toEqual([
      [150, 60.5 - 4],
      [150, 79.5 - 4],
    ]);
  });

  it("asks for one rectangle per region, however large the region", () => {
    const { ctx } = recorder();
    const rectOf = vi.fn(() => rect());
    const huge: OutlineRegion[] = [{ rowStart: 0, rowEnd: 999_999, colStart: 1, colEnd: 1 }];
    createWritebackOutlinePainter({ regions: () => huge, colors, rectOf })(layerContext(ctx));
    expect(rectOf).toHaveBeenCalledTimes(1);
  });

  it("drawEditIcon stays inside its 12px box", () => {
    const { ctx, calls } = recorder();
    drawEditIcon(ctx, 50, 50);
    const pts = calls.filter((c) => c.op === "moveTo" || c.op === "lineTo").map((c) => c.args as number[]);
    for (const [x, y] of pts) {
      expect(Math.abs(x - 50)).toBeLessThanOrEqual(FRAME_ICON_SIZE / 2);
      expect(Math.abs(y - 50)).toBeLessThanOrEqual(FRAME_ICON_SIZE / 2);
    }
    expect(calls.filter((c) => c.op === "stroke").length).toBe(1);
  });
});
