//! FILENAME: app/extensions/Controls/__tests__/shapeRendererNoFill.test.ts
// PURPOSE: A text box paints NOTHING but its text (WP-C 2.10.1): a `fill` of
//          "none" (or "transparent" / "") paints no fill op, and a
//          `strokeWidth` of "0" paints no stroke. It used to be
//          `parseFloat(strokeWidth) || 1`, which turned "0" into a 1 px outline
//          round every text box, and every fill was painted, "none" included.
//          Also: the shape lays out in its CONTENT RECT (the container's
//          padding moves the path and the text, not the selection box).
// CONTEXT: The renderer's real async read (`fetchShapeData`) fills its cache
//          from a doubled `resolveControlProperties`; the context records every
//          2D call, so "no fill" is the absence of a `fill` op.
//          SABOTAGE (run once, then restored): `strokeWidth:
//          parseStrokeWidth(...)` -> `parseFloat(resolved.strokeWidth ?? "1") || 1`
//          in fetchShapeData -> the "0" case goes red (a stroke op appears).

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  props: {} as Record<string, string>,
}));

vi.mock("@api/gridOverlays", () => ({
  overlayGetRowHeaderWidth: () => 0,
  overlayGetColHeaderHeight: () => 0,
  overlaySheetToCanvas: (_c: unknown, x: number, y: number) => ({ canvasX: x, canvasY: y }),
  requestOverlayRedraw: () => undefined,
  replaceGridRegionsByType: () => undefined,
  removeGridRegionsByType: () => undefined,
  onPointModeViewChanged: () => () => undefined,
}));
vi.mock("@api", () => ({
  getShapeBitmap: () => null,
  hasShapeBitmapRenderer: () => false,
}));
vi.mock("@api/events", () => ({ emitAppEvent: () => undefined }));
vi.mock("../lib/controlApi", () => ({ resolveControlProperties: async () => ({ ...h.props }) }));
vi.mock("../Button/floatingSelection", () => ({
  isFloatingControlSelected: () => false,
  getSelectedFloatingControls: () => [] as string[],
}));

import { renderFloatingShape, invalidateShapeCache } from "../Shape/shapeRenderer";
import { getControlContainer, resetControlContainers } from "../lib/controlContainer";
import { BACKGROUND_TRANSPARENCY_KEY, TEXT_BOX_RECIPE_PAINT, backgroundAlphaOf } from "../Shape/shapeRecipe";
import { controlContainerKey } from "@api/visualContainer";

const ID = "control-0-2-1";
const BOX = { x: 100, y: 60, width: 200, height: 120 };

let ops: string[];
let ctx: CanvasRenderingContext2D;
let moves: Array<[number, number]>;
let texts: Array<{ text: string; x: number; y: number }>;
/** `globalAlpha` at every fill / stroke op, in order. */
let alphas: Array<{ op: string; alpha: number }>;

function recordingCtx(): CanvasRenderingContext2D {
  const target: Record<string, unknown> = { canvas: document.createElement("canvas"), globalAlpha: 1 };
  return new Proxy(target, {
    get: (obj, prop) => {
      if (prop in obj) return obj[prop as string];
      return (...args: unknown[]) => {
        ops.push(String(prop));
        if (prop === "fill" || prop === "stroke") alphas.push({ op: String(prop), alpha: obj.globalAlpha as number });
        if (prop === "moveTo") moves.push([args[0] as number, args[1] as number]);
        if (prop === "fillText") texts.push({ text: String(args[0]), x: args[1] as number, y: args[2] as number });
        if (prop === "measureText") return { width: 10 };
        return undefined;
      };
    },
    set: (obj, prop, value) => {
      obj[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function paint(container?: unknown): void {
  renderFloatingShape({
    ctx,
    canvasWidth: 800,
    canvasHeight: 600,
    region: {
      id: ID,
      floating: { ...BOX },
      data: { controlType: "shape", sheetIndex: 0, row: 2, col: 1 },
      ...(container ? { container } : {}),
    },
  } as never);
}

/** Paint once (starts the read), let the read land, then paint what it read. */
async function paintRead(props: Record<string, string>, container?: unknown): Promise<void> {
  h.props = props;
  invalidateShapeCache(ID);
  paint(container);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  ops = [];
  moves = [];
  texts = [];
  alphas = [];
  paint(container);
}

beforeEach(() => {
  ops = [];
  moves = [];
  texts = [];
  alphas = [];
  ctx = recordingCtx();
  resetControlContainers();
});

describe("a text box paints its text and nothing else", () => {
  it("fill \"none\" paints no fill op; strokeWidth \"0\" paints no stroke", async () => {
    await paintRead({ shapeType: "rectangle", ...TEXT_BOX_RECIPE_PAINT, text: "Hello" });
    expect(ops).not.toContain("fill");
    expect(ops).not.toContain("stroke");
    expect(texts.map((t) => t.text)).toEqual(["Hello"]);
  });

  it("strokeWidth \"0\" with a real stroke colour is still NO outline", async () => {
    await paintRead({ shapeType: "rectangle", fill: "#ffffff", stroke: "#000000", strokeWidth: "0" });
    expect(ops).toContain("fill");
    expect(ops).not.toContain("stroke");
  });

  it("\"transparent\" and \"\" fills paint nothing either", async () => {
    await paintRead({ shapeType: "rectangle", fill: "transparent", stroke: "none", strokeWidth: "1" });
    expect(ops).not.toContain("fill");
    expect(ops).not.toContain("stroke");
    await paintRead({ shapeType: "rectangle", fill: "", stroke: "#000000", strokeWidth: "2" });
    expect(ops).not.toContain("fill");
    expect(ops).toContain("stroke");
  });

  it("positive control: the default recipe still fills and strokes", async () => {
    await paintRead({ shapeType: "rectangle", fill: "#4472C4", stroke: "#2F528F", strokeWidth: "1" });
    expect(ops).toContain("fill");
    expect(ops).toContain("stroke");
  });

  it("the same read publishes the text box's container: no background, no border", async () => {
    await paintRead({ shapeType: "textBox", ...TEXT_BOX_RECIPE_PAINT });
    const c = getControlContainer(ID)!;
    expect(c.background.show).toBe(false);
    expect(c.border.show).toBe(false);
    expect(c.paint.background).toBe("family");
  });
});

describe("the shape lays out in its content rect", () => {
  it("padding 10 moves the path's first point and the text inside the box by 10", async () => {
    const props = { shapeType: "rectangle", fill: "#ffffff", stroke: "none", strokeWidth: "0", text: "T", textAlign: "left" };
    await paintRead(props);
    const plain = { move: moves[0], text: texts[0] };
    await paintRead({ ...props, containerPaddingLeft: "10", containerPaddingTop: "10" });
    const container = getControlContainer(ID);
    expect(container?.padding.left).toBe(10);
    ops = [];
    moves = [];
    texts = [];
    paint(container);
    expect(moves[0][0]).toBe(plain.move[0] + 10);
    expect(moves[0][1]).toBe(plain.move[1] + 10);
    expect(texts[0].x).toBe(plain.text.x + 10);
  });
});

describe("Effects > Background > Transparency fades the shape's fill only", () => {
  // SABOTAGE (confirmed): drop the `ctx.globalAlpha = shapeAlpha * fillAlpha`
  // line in renderFloatingShape -> the fill is painted at alpha 1.
  it("containerBackgroundTransparency 40 fills at 0.6; the outline stays opaque", async () => {
    await paintRead({
      shapeType: "rectangle",
      fill: "#4472C4",
      stroke: "#2F528F",
      strokeWidth: "1",
      [BACKGROUND_TRANSPARENCY_KEY]: "40",
    });
    expect(alphas.find((a) => a.op === "fill")?.alpha).toBeCloseTo(0.6, 9);
    expect(alphas.find((a) => a.op === "stroke")?.alpha).toBe(1);
  });

  it("the whole-shape opacity multiplies in; 100 % transparent paints no fill at all", async () => {
    await paintRead({ shapeType: "rectangle", fill: "#4472C4", stroke: "none", strokeWidth: "0", opacity: "0.5", [BACKGROUND_TRANSPARENCY_KEY]: "50" });
    expect(alphas.find((a) => a.op === "fill")?.alpha).toBeCloseTo(0.25, 9);
    await paintRead({ shapeType: "rectangle", fill: "#4472C4", stroke: "#000000", strokeWidth: "1", [BACKGROUND_TRANSPARENCY_KEY]: "100" });
    expect(ops).not.toContain("fill");
    expect(ops).toContain("stroke");
  });

  it("absent, empty or unreadable is opaque; the key is the one @api spells", async () => {
    expect(BACKGROUND_TRANSPARENCY_KEY).toBe(controlContainerKey("textBox", "background.transparency"));
    expect(backgroundAlphaOf(undefined)).toBe(1);
    expect(backgroundAlphaOf("")).toBe(1);
    expect(backgroundAlphaOf("abc")).toBe(1);
    expect(backgroundAlphaOf("150")).toBe(0);
    expect(backgroundAlphaOf("-5")).toBe(1);
    await paintRead({ shapeType: "rectangle", fill: "#4472C4", stroke: "none", strokeWidth: "0" });
    expect(alphas.find((a) => a.op === "fill")?.alpha).toBe(1);
  });
});
