// FILENAME: app/extensions/Collaboration/lib/__tests__/writebackPainters.test.ts
// PURPOSE: The writeback grid painters: the state marker sits inside-left of
//          the note triangle and takes its colours from the theme tones; the
//          region outline paints only the active sheet's regions, dashed, at
//          70% alpha, skipping edges that continue off-screen.

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
  OUTLINE_ALPHA,
  type OutlineRegion,
} from "../writebackOutline";
import type { GridLayerContext, RangeCanvasRect } from "@api/gridLayers";
import type { CellDecorationContext } from "@api/cellDecorations";

/** A recording 2D context: what was filled/stroked, with which style. */
function recorder() {
  const calls: { op: string; args: unknown[]; fillStyle?: unknown; strokeStyle?: unknown }[] = [];
  const ctx: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
    _dash: [] as number[],
  };
  const rec = (op: string) => (...args: unknown[]) =>
    calls.push({ op, args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle });
  for (const op of ["save", "restore", "beginPath", "arc", "fill", "stroke", "fillRect", "moveTo", "lineTo"]) {
    ctx[op] = rec(op);
  }
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

describe("region outline layer", () => {
  const layerContext = (ctx: CanvasRenderingContext2D) =>
    ({ ctx, canvasWidth: 800, canvasHeight: 600 }) as unknown as GridLayerContext;

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

  it("strokes only the active sheet's regions, dashed 3/2, info tone at 70%", () => {
    const { ctx, calls } = recorder();
    const active: OutlineRegion[] = [{ rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 1 }];
    const rectOf = vi.fn(() => rect());
    const paint = createWritebackOutlinePainter({
      regions: () => active,
      color: () => "INFO",
      rectOf,
    });
    paint(layerContext(ctx));
    expect(rectOf).toHaveBeenCalledTimes(1);
    expect(rectOf.mock.calls[0].slice(1)).toEqual([2, 1, 4, 1]);
    expect((ctx as unknown as { _dash: number[] })._dash).toEqual([3, 2]);
    expect((ctx as unknown as { globalAlpha: number }).globalAlpha).toBe(OUTLINE_ALPHA);
    const stroke = calls.find((c) => c.op === "stroke")!;
    expect(stroke.strokeStyle).toBe("INFO");
    // Four edges on the half-pixel grid.
    expect(calls.filter((c) => c.op === "lineTo").length).toBe(4);
    expect(calls.find((c) => c.op === "moveTo")!.args).toEqual([100.5, 60.5]);
  });

  it("paints nothing when the active sheet has no regions (another sheet, a canvas page)", () => {
    const { ctx, calls } = recorder();
    const rectOf = vi.fn(() => rect());
    const paint = createWritebackOutlinePainter({ regions: () => [], color: () => "INFO", rectOf });
    paint(layerContext(ctx));
    expect(rectOf).not.toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });

  it("skips edges that continue off-screen and regions not on screen", () => {
    const { ctx, calls } = recorder();
    const regions: OutlineRegion[] = [
      { rowStart: 0, rowEnd: 99, colStart: 0, colEnd: 0 },
      { rowStart: 500, rowEnd: 501, colStart: 0, colEnd: 0 },
    ];
    let n = 0;
    const paint = createWritebackOutlinePainter({
      regions: () => regions,
      color: () => "INFO",
      rectOf: () => (n++ === 0 ? rect({ clippedBottom: true }) : null),
    });
    paint(layerContext(ctx));
    expect(calls.filter((c) => c.op === "lineTo").length).toBe(3);
  });
});
