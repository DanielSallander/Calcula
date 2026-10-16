//! FILENAME: app/extensions/_shared/lib/__tests__/innerSelectionPaint.test.ts
// PURPOSE: The ONE inner-selection ink (a floating grid's cells, a canvas
//          pivot's cells) and the reference-pick drag preview: what each painter
//          draws, in which colour, and that it leaves the caller's context state
//          as it found it (save/restore, no clip of its own).

import { describe, it, expect } from "vitest";
import {
  INNER_SELECTION_BORDER,
  INNER_SELECTION_FILL,
  PICK_PREVIEW_STROKE,
  paintInnerSelection,
  paintPickPreview,
  type PaintRect,
} from "../innerSelectionPaint";

interface Call {
  name: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: unknown;
  dash: number[];
}

function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Call[]; depth: () => number } {
  const calls: Call[] = [];
  let depth = 0;
  let dash: number[] = [];
  const state: Record<string, unknown> = { fillStyle: "#000", strokeStyle: "#000", lineWidth: 1 };
  const note = (name: string, args: unknown[]) =>
    calls.push({
      name,
      args,
      fillStyle: state.fillStyle,
      strokeStyle: state.strokeStyle,
      lineWidth: state.lineWidth,
      dash: [...dash],
    });
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      switch (prop) {
        case "save":
          return () => {
            depth++;
            note("save", []);
          };
        case "restore":
          return () => {
            depth--;
            note("restore", []);
          };
        case "setLineDash":
          return (d: number[]) => {
            dash = [...d];
          };
        case "beginPath":
        case "rect":
        case "fill":
        case "stroke":
        case "fillRect":
        case "strokeRect":
        case "clip":
          return (...args: unknown[]) => note(prop, args);
        default:
          return target[prop];
      }
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, depth: () => depth };
}

const A: PaintRect = { x: 10, y: 20, width: 100, height: 40 };
const B: PaintRect = { x: 10, y: 60, width: 100, height: 80 };

describe("paintInnerSelection", () => {
  it("fills every piece and the active cell as ONE even-odd path, then borders each piece 2px inside", () => {
    const { ctx, calls, depth } = fakeCtx();
    const active: PaintRect = { x: 10, y: 20, width: 50, height: 20 };
    paintInnerSelection(ctx, [A, B], active);

    const rects = calls.filter((c) => c.name === "rect").map((c) => c.args);
    expect(rects).toEqual([
      [A.x, A.y, A.width, A.height],
      [B.x, B.y, B.width, B.height],
      [active.x, active.y, active.width, active.height],
    ]);
    const fill = calls.find((c) => c.name === "fill")!;
    expect(fill.args).toEqual(["evenodd"]);
    expect(fill.fillStyle).toBe(INNER_SELECTION_FILL);

    const borders = calls.filter((c) => c.name === "strokeRect");
    expect(borders.map((c) => c.args)).toEqual([
      [A.x + 1, A.y + 1, A.width - 2, A.height - 2],
      [B.x + 1, B.y + 1, B.width - 2, B.height - 2],
    ]);
    for (const b of borders) {
      expect(b.strokeStyle).toBe(INNER_SELECTION_BORDER);
      expect(b.lineWidth).toBe(2);
      expect(b.dash).toEqual([]);
    }
    // Balanced, and no clip of its own: the caller clips.
    expect(depth()).toBe(0);
    expect(calls.some((c) => c.name === "clip")).toBe(false);
  });

  it("with no active cell the pieces are filled whole; empty or degenerate pieces paint nothing", () => {
    const { ctx, calls } = fakeCtx();
    paintInnerSelection(ctx, [A], null);
    expect(calls.filter((c) => c.name === "rect")).toHaveLength(1);

    const empty = fakeCtx();
    paintInnerSelection(empty.ctx, [], null);
    paintInnerSelection(empty.ctx, [{ x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: NaN, height: 5 }], A);
    expect(empty.calls).toEqual([]);
  });
});

describe("paintPickPreview", () => {
  it("strokes each piece dashed [4,3] at 1.5px in the pick colour, filling nothing", () => {
    const { ctx, calls, depth } = fakeCtx();
    paintPickPreview(ctx, [A, B]);
    const strokes = calls.filter((c) => c.name === "strokeRect");
    expect(strokes.map((c) => c.args)).toEqual([
      [A.x + 0.75, A.y + 0.75, A.width - 1.5, A.height - 1.5],
      [B.x + 0.75, B.y + 0.75, B.width - 1.5, B.height - 1.5],
    ]);
    for (const s of strokes) {
      expect(s.strokeStyle).toBe(PICK_PREVIEW_STROKE);
      expect(s.lineWidth).toBe(1.5);
      expect(s.dash).toEqual([4, 3]);
    }
    expect(calls.some((c) => c.name === "fill" || c.name === "fillRect")).toBe(false);
    expect(depth()).toBe(0);
  });

  it("is not the selection colour (a pick never reads as a selection)", () => {
    expect(PICK_PREVIEW_STROKE).not.toBe(INNER_SELECTION_BORDER);
  });

  it("paints nothing for no pieces", () => {
    const { ctx, calls } = fakeCtx();
    paintPickPreview(ctx, []);
    expect(calls).toEqual([]);
  });
});
