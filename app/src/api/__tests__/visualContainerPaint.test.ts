//! FILENAME: app/src/api/__tests__/visualContainerPaint.test.ts
// PURPOSE: The Canvas2D half of the visual container, on a RECORDING context:
//          the under-paint (shadow, then background), the over-paint (title,
//          subtitle, divider, then border), the paint split ("family" paints
//          nothing of that part here), alpha from transparency, the content
//          clip, and THE layout cache that keeps paint == hit.

import { describe, it, expect, beforeEach } from "vitest";
import {
  BASE_CONTAINER_DEFAULTS,
  layoutVisualContainer,
  type ResolvedVisualContainer,
} from "../visualContainer";
import {
  containerLayoutSignature,
  measureVisualContainerLayout,
  paintVisualContainerOver,
  paintVisualContainerUnder,
  recordPaintedContainerLayout,
  resetPaintedContainerLayouts,
  shadowOffsetFor,
  traceContainerOuter,
  visualColorWithAlpha,
  visualContainerLayoutFor,
  visualContentRect,
  visualContentRectFor,
  withContainerContentClip,
  wrapVisualText,
  type ContainerRegion,
} from "../visualContainerPaint";

// ----------------------------------------------------------------------------
// A recording 2D context: every method call and every property write, in order.
// ----------------------------------------------------------------------------

type Op = { op: string; args: unknown[] };

const RECORDED_PROPS = [
  "fillStyle", "strokeStyle", "globalAlpha", "lineWidth", "font", "textAlign", "textBaseline",
  "shadowColor", "shadowBlur", "shadowOffsetX", "shadowOffsetY",
] as const;

function recordingCtx(opts: { charWidth?: number; scale?: number } = {}) {
  const ops: Op[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const stack: Array<Record<string, unknown>> = [];
  const charWidth = opts.charWidth ?? 7;
  const scale = opts.scale ?? 1;
  const rec = (op: string) => (...args: unknown[]) => {
    ops.push({ op, args });
  };
  const ctx: Record<string, unknown> = {
    save: () => { ops.push({ op: "save", args: [] }); stack.push({ ...state }); },
    restore: () => { ops.push({ op: "restore", args: [] }); Object.assign(state, stack.pop() ?? {}); },
    beginPath: rec("beginPath"), closePath: rec("closePath"), rect: rec("rect"), moveTo: rec("moveTo"),
    lineTo: rec("lineTo"), arcTo: rec("arcTo"), clip: rec("clip"), fill: rec("fill"), stroke: rec("stroke"),
    fillRect: rec("fillRect"), fillText: rec("fillText"), setLineDash: rec("setLineDash"),
    measureText: (s: string) => ({ width: s.length * charWidth }),
    getTransform: () => ({ a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }),
    createLinearGradient: (...args: unknown[]) => {
      ops.push({ op: "createLinearGradient", args });
      return { addColorStop: (...a: unknown[]) => ops.push({ op: "addColorStop", args: a }) };
    },
    createRadialGradient: (...args: unknown[]) => {
      ops.push({ op: "createRadialGradient", args });
      return { addColorStop: (...a: unknown[]) => ops.push({ op: "addColorStop", args: a }) };
    },
  };
  for (const p of RECORDED_PROPS) {
    Object.defineProperty(ctx, p, {
      get: () => state[p],
      set: (v: unknown) => { state[p] = v; ops.push({ op: `set:${p}`, args: [v] }); },
    });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops, state };
}

const names = (ops: Op[]) => ops.map((o) => o.op);
const indexOfOp = (ops: Op[], op: string, from = 0) => ops.findIndex((o, i) => i >= from && o.op === op);
const sets = (ops: Op[], prop: string) => ops.filter((o) => o.op === `set:${prop}`).map((o) => o.args[0]);

function container(over: Partial<ResolvedVisualContainer> = {}): ResolvedVisualContainer {
  return { ...structuredClone(BASE_CONTAINER_DEFAULTS), ...over };
}

const outer = { x: 100, y: 40, width: 300, height: 200 };
const origin = { dx: 50, dy: 20 }; // the canvas position of outer's top-left

// ============================================================================

describe("paintVisualContainerUnder: shadow, then background", () => {
  it("an outside shadow is painted BEFORE the background, both on the outer rect at the origin", () => {
    const c = container({
      shadow: { ...BASE_CONTAINER_DEFAULTS.shadow, show: true, alpha: 0.5, color: "#000000", blur: 6, distance: 4, position: "bottom" },
      background: { show: true, color: "#ffeecc", alpha: 1, gradient: null },
    });
    const { ctx, ops } = recordingCtx();
    paintVisualContainerUnder(ctx, layoutVisualContainer(outer, c), c, origin);
    const shadowAt = indexOfOp(ops, "set:shadowColor");
    const bgFillStyle = ops.findIndex((o) => o.op === "set:fillStyle" && o.args[0] === "#ffeecc");
    expect(shadowAt).toBeGreaterThan(-1);
    expect(bgFillStyle).toBeGreaterThan(shadowAt);
    expect(sets(ops, "shadowColor")).toEqual(["rgba(0, 0, 0, 0.5)"]);
    expect(sets(ops, "shadowOffsetX")).toEqual([0]);
    expect(sets(ops, "shadowOffsetY")).toEqual([4]);
    expect(sets(ops, "shadowBlur")).toEqual([6]);
    // The outside shadow is clipped to the area OUTSIDE the shape (evenodd), so the casting shape never shows.
    expect(ops.some((o) => o.op === "clip" && o.args[0] === "evenodd")).toBe(true);
    // The background fills the outer rect at the canvas origin.
    const rects = ops.filter((o) => o.op === "rect").map((o) => o.args);
    expect(rects).toContainEqual([50, 20, 300, 200]);
    // Balanced save/restore.
    expect(names(ops).filter((n) => n === "save").length).toBe(names(ops).filter((n) => n === "restore").length);
  });

  it("alpha = 1 - transparency / 100 reaches globalAlpha (resolved by the schema)", () => {
    const c = container({ background: { show: true, color: "#ffffff", alpha: 0.75, gradient: null } });
    const { ctx, ops } = recordingCtx();
    paintVisualContainerUnder(ctx, layoutVisualContainer(outer, c), c, origin);
    expect(sets(ops, "globalAlpha")).toEqual([0.75]);
    expect(visualColorWithAlpha("#00000080", 0.5)).toBe("rgba(0, 0, 0, 0.251)");
    expect(visualColorWithAlpha("#abc", 1)).toBe("rgba(170, 187, 204, 1)");
    expect(visualColorWithAlpha("red", 1)).toBeNull();
  });

  it("paint.background / paint.shadow 'family' / 'none' paint nothing of that part here", () => {
    const c = container({
      shadow: { ...BASE_CONTAINER_DEFAULTS.shadow, show: true },
      paint: { background: "family", border: "core", title: "core", shadow: "none" },
    });
    const { ctx, ops } = recordingCtx();
    paintVisualContainerUnder(ctx, layoutVisualContainer(outer, c), c, origin);
    expect(ops).toEqual([]);
  });

  it("hidden, fully transparent or colourless backgrounds paint nothing", () => {
    for (const background of [
      { show: false, color: "#ffffff", alpha: 1, gradient: null },
      { show: true, color: "#ffffff", alpha: 0, gradient: null },
      { show: true, color: "", alpha: 1, gradient: null },
    ]) {
      const c = container({ background });
      const { ctx, ops } = recordingCtx();
      paintVisualContainerUnder(ctx, layoutVisualContainer(outer, c), c, origin);
      expect(ops, JSON.stringify(background)).toEqual([]);
    }
  });

  it("a gradient background is a canvas gradient over the outer rect (chart direction table)", () => {
    const c = container({
      background: {
        show: true, color: "#ffffff", alpha: 1,
        gradient: { type: "linear", direction: "leftToRight", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] },
      },
    });
    const { ctx, ops } = recordingCtx();
    paintVisualContainerUnder(ctx, layoutVisualContainer(outer, c), c, origin);
    const g = ops.find((o) => o.op === "createLinearGradient")!;
    expect(g.args).toEqual([50, 120, 350, 120]);
    expect(ops.filter((o) => o.op === "addColorStop").map((o) => o.args)).toEqual([[0, "#000"], [1, "#fff"]]);
  });

  it("an inside shadow is painted AFTER the background (it falls on it)", () => {
    const c = container({ shadow: { ...BASE_CONTAINER_DEFAULTS.shadow, show: true, offset: "inside" } });
    const { ctx, ops } = recordingCtx();
    paintVisualContainerUnder(ctx, layoutVisualContainer(outer, c), c, origin);
    const bg = ops.findIndex((o) => o.op === "set:fillStyle" && o.args[0] === "#ffffff");
    expect(indexOfOp(ops, "set:shadowColor")).toBeGreaterThan(bg);
    expect(ops.some((o) => o.op === "fill" && o.args[0] === "evenodd")).toBe(true);
  });

  it("shadow blur and offset follow the context's scale (canvas shadows ignore the transform)", () => {
    const c = container({ shadow: { ...BASE_CONTAINER_DEFAULTS.shadow, show: true, position: "right", distance: 5, blur: 3 } });
    const { ctx, ops } = recordingCtx({ scale: 2 });
    paintVisualContainerUnder(ctx, layoutVisualContainer(outer, c), c, origin);
    expect(sets(ops, "shadowOffsetX")).toEqual([10]);
    expect(sets(ops, "shadowBlur")).toEqual([6]);
    const diag = shadowOffsetFor("bottomRight", Math.SQRT2);
    expect(diag.x).toBeCloseTo(1);
    expect(diag.y).toBeCloseTo(1);
    expect(shadowOffsetFor("center", 10)).toEqual({ x: 0, y: 0 });
  });
});

describe("paintVisualContainerOver: title, subtitle, divider, then border", () => {
  const full = () =>
    container({
      title: { ...BASE_CONTAINER_DEFAULTS.title, show: true, text: "Sales", color: "#111111", background: "#eeeeee" },
      subtitle: { ...BASE_CONTAINER_DEFAULTS.subtitle, show: true, text: "FY26", color: "#222222" },
      divider: { show: true, color: "#333333", style: "dashed", width: 2, ignorePadding: false },
      border: { show: true, color: "#444444", width: 2, radius: 8 },
    });

  it("paints in that order", () => {
    const c = full();
    const { ctx, ops } = recordingCtx();
    paintVisualContainerOver(ctx, layoutVisualContainer(outer, c), c, origin);
    const texts = ops.filter((o) => o.op === "fillText").map((o) => o.args[0]);
    expect(texts).toEqual(["Sales", "FY26"]);
    const titleAt = ops.findIndex((o) => o.op === "fillText" && o.args[0] === "Sales");
    const subtitleAt = ops.findIndex((o) => o.op === "fillText" && o.args[0] === "FY26");
    const dividerAt = ops.findIndex((o) => o.op === "set:strokeStyle" && o.args[0] === "#333333");
    const borderAt = ops.findIndex((o) => o.op === "set:strokeStyle" && o.args[0] === "#444444");
    expect(titleAt).toBeLessThan(subtitleAt);
    expect(subtitleAt).toBeLessThan(dividerAt);
    expect(dividerAt).toBeLessThan(borderAt);
    expect(ops.find((o) => o.op === "setLineDash")!.args[0]).toEqual([8, 4]);
    // The title band background is filled before the title text.
    const band = ops.findIndex((o) => o.op === "set:fillStyle" && o.args[0] === "#eeeeee");
    expect(band).toBeGreaterThan(-1);
    expect(band).toBeLessThan(titleAt);
    // The border is stroked on the half-inset rounded rect, inside the outer rect.
    expect(ops.find((o) => o.op === "moveTo" && (o.args[0] as number) === 50 + 1 + 7)).toBeDefined();
    expect(names(ops).filter((n) => n === "save").length).toBe(names(ops).filter((n) => n === "restore").length);
  });

  it("the title lands at the layout's title band (origin + band - outer)", () => {
    const c = full();
    const layout = layoutVisualContainer(outer, c);
    const { ctx, ops } = recordingCtx();
    paintVisualContainerOver(ctx, layout, c, origin);
    const title = ops.find((o) => o.op === "fillText" && o.args[0] === "Sales")!;
    const band = layout.titleRect!;
    expect(title.args[1]).toBe(origin.dx + (band.x - outer.x));
    const lh = Math.ceil(c.title.fontSize * 1.25);
    expect(title.args[2]).toBe(origin.dy + (band.y - outer.y) + (lh - c.title.fontSize) / 2);
  });

  it("paint.title 'family' / 'none' and paint.border 'family' paint nothing of those parts", () => {
    for (const title of ["family", "none"] as const) {
      const c = { ...full(), paint: { background: "core", border: "family", title, shadow: "core" } as const };
      const { ctx, ops } = recordingCtx();
      paintVisualContainerOver(ctx, layoutVisualContainer(outer, c), c, origin);
      expect(ops, title).toEqual([]);
    }
  });

  it("a hidden border paints nothing; a shown one with paint 'core' strokes once", () => {
    const hidden = container({ border: { show: false, color: "#000", width: 2, radius: 0 } });
    const r1 = recordingCtx();
    paintVisualContainerOver(r1.ctx, layoutVisualContainer(outer, hidden), hidden, origin);
    expect(r1.ops).toEqual([]);
    const shown = container({ border: { show: true, color: "#000", width: 2, radius: 0 } });
    const r2 = recordingCtx();
    paintVisualContainerOver(r2.ctx, layoutVisualContainer(outer, shown), shown, origin);
    expect(r2.ops.filter((o) => o.op === "stroke").length).toBe(1);
    expect(r2.ops.find((o) => o.op === "rect")!.args).toEqual([51, 21, 298, 198]);
  });

  it("wrapped titles paint the measured lines", () => {
    const c = container({
      title: { ...BASE_CONTAINER_DEFAULTS.title, show: true, text: "one two three four", fontSize: 10 },
    });
    // 7 px per char: "one two" = 49, "one two three" = 91 > 60.
    const { ctx, ops } = recordingCtx();
    const narrow = { x: 0, y: 0, width: 60, height: 200 };
    const layout = measureVisualContainerLayout(ctx, narrow, c);
    expect(layout.titleLines).toBe(3);
    expect(layout.titleRect!.height).toBe(3 * Math.ceil(12.5));
    ops.length = 0;
    paintVisualContainerOver(ctx, layout, c, { dx: 0, dy: 0 });
    expect(ops.filter((o) => o.op === "fillText").map((o) => o.args[0])).toEqual(["one two", "three", "four"]);
    expect(wrapVisualText(ctx, "", 60)).toEqual([""]);
    expect(wrapVisualText(ctx, "a\nb", 60)).toEqual(["a", "b"]);
    expect(wrapVisualText(ctx, "unbreakablelongword x", 20)).toEqual(["unbreakablelongword", "x"]);
  });

  it("measure leaves the context as it was (save/restore around the font)", () => {
    const c = container({ title: { ...BASE_CONTAINER_DEFAULTS.title, show: true, text: "x" } });
    const { ctx, ops } = recordingCtx();
    measureVisualContainerLayout(ctx, outer, c);
    expect(ops[0].op).toBe("save");
    expect(ops[ops.length - 1].op).toBe("restore");
  });
});

describe("withContainerContentClip", () => {
  const canvasOuter = { x: 10, y: 20, width: 200, height: 100 };
  const canvasContent = { x: 18, y: 40, width: 184, height: 72 };
  const region = (radius: number | null): ContainerRegion => ({
    id: "r1", type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
    ...(radius === null ? {} : { container: container({ border: { show: false, color: "#000", width: 1, radius } }) }),
  });

  it("radius 0 (or no container): one rect clip, the callback once inside save/restore", () => {
    for (const r of [0, null]) {
      const { ctx, ops } = recordingCtx();
      let calls = 0;
      withContainerContentClip(ctx, region(r), canvasOuter, canvasContent, () => {
        calls++;
        ops.push({ op: "PAINT", args: [] });
      });
      expect(calls).toBe(1);
      expect(names(ops)).toEqual(["save", "beginPath", "rect", "clip", "PAINT", "restore"]);
      expect(ops[2].args).toEqual([18, 40, 184, 72]);
    }
  });

  it("radius 12: the content rect AND the rounded outer path", () => {
    const { ctx, ops } = recordingCtx();
    withContainerContentClip(ctx, region(12), canvasOuter, canvasContent, () => ops.push({ op: "PAINT", args: [] }));
    const n = names(ops);
    expect(n[0]).toBe("save");
    expect(n.filter((x) => x === "clip").length).toBe(2);
    expect(n.filter((x) => x === "arcTo").length).toBe(4);
    expect(ops.filter((o) => o.op === "arcTo").every((o) => o.args[4] === 12)).toBe(true);
    expect(n.indexOf("PAINT")).toBeGreaterThan(n.lastIndexOf("clip"));
    expect(n[n.length - 1]).toBe("restore");
  });

  it("restores even when the callback throws", () => {
    const { ctx, ops } = recordingCtx();
    expect(() =>
      withContainerContentClip(ctx, region(0), canvasOuter, canvasContent, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(ops[ops.length - 1].op).toBe("restore");
  });

  it("traceContainerOuter traces the outer rounded rect at the origin", () => {
    const c = container({ border: { show: false, color: "#000", width: 1, radius: 500 } });
    const { ctx, ops } = recordingCtx();
    traceContainerOuter(ctx, layoutVisualContainer(outer, c), c, origin);
    expect(ops[0].op).toBe("beginPath");
    // The radius is clamped to half the short side (100).
    expect(ops.filter((o) => o.op === "arcTo").every((o) => o.args[4] === 100)).toBe(true);
    expect(ops[1]).toEqual({ op: "moveTo", args: [150, 20] });
  });
});

describe("the layout cache (paint == hit)", () => {
  beforeEach(() => resetPaintedContainerLayouts());

  const titled = () =>
    container({
      padding: { top: 5, right: 5, bottom: 5, left: 5 },
      title: { ...BASE_CONTAINER_DEFAULTS.title, show: true, text: "long title", fontSize: 16 },
    });

  it("no recorded layout: the pure 1-line layout", () => {
    const c = titled();
    expect(visualContentRectFor("chart-1", outer, c)).toEqual(layoutVisualContainer(outer, c).content);
  });

  it("a recorded layout answers while its signature matches (signature hit)", () => {
    const c = titled();
    const measured = layoutVisualContainer(outer, c, { title: 3, subtitle: 1 });
    recordPaintedContainerLayout("chart-1", containerLayoutSignature(outer, c), measured);
    expect(visualContentRectFor("chart-1", outer, c)).toEqual(measured.content);
    expect(visualContentRectFor("chart-1", outer, c)).not.toEqual(layoutVisualContainer(outer, c).content);
    // Another region id does not see it.
    expect(visualContentRectFor("chart-2", outer, c)).toEqual(layoutVisualContainer(outer, c).content);
  });

  it("a moved object keeps its measured layout, translated (the signature ignores position)", () => {
    const c = titled();
    const measured = layoutVisualContainer(outer, c, { title: 3, subtitle: 1 });
    recordPaintedContainerLayout("chart-1", containerLayoutSignature(outer, c), measured);
    const moved = { ...outer, x: outer.x + 30, y: outer.y - 10 };
    expect(containerLayoutSignature(moved, c)).toBe(containerLayoutSignature(outer, c));
    expect(visualContentRectFor("chart-1", moved, c)).toEqual({
      ...measured.content, x: measured.content.x + 30, y: measured.content.y - 10,
    });
    const l = visualContainerLayoutFor("chart-1", moved, c);
    expect(l.titleRect!.x).toBe(measured.titleRect!.x + 30);
    expect(l.titleLines).toBe(3);
  });

  it("a changed size / text / padding misses and falls back to the 1-line layout (signature miss)", () => {
    const c = titled();
    const measured = layoutVisualContainer(outer, c, { title: 3, subtitle: 1 });
    recordPaintedContainerLayout("chart-1", containerLayoutSignature(outer, c), measured);
    const resized = { ...outer, width: outer.width + 1 };
    expect(visualContentRectFor("chart-1", resized, c)).toEqual(layoutVisualContainer(resized, c).content);
    const retitled = { ...c, title: { ...c.title, text: "other" } };
    expect(containerLayoutSignature(outer, retitled)).not.toBe(containerLayoutSignature(outer, c));
    expect(visualContentRectFor("chart-1", outer, retitled)).toEqual(layoutVisualContainer(outer, retitled).content);
    const padded = { ...c, padding: { ...c.padding, left: 9 } };
    expect(containerLayoutSignature(outer, padded)).not.toBe(containerLayoutSignature(outer, c));
    // Colours do not change the layout, so they keep the hit.
    const recoloured = { ...c, title: { ...c.title, color: "#ff0000" } };
    expect(containerLayoutSignature(outer, recoloured)).toBe(containerLayoutSignature(outer, c));
  });

  it("no container: content == outer; a published region reads its floating rect + container", () => {
    expect(visualContentRectFor("x", outer, undefined)).toEqual(outer);
    const c = titled();
    const region: ContainerRegion = {
      id: "chart-1", type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0, container: c,
    };
    region.floating = { ...outer };
    expect(visualContentRect(region)).toEqual(layoutVisualContainer(outer, c).content);
    const cellAnchored: ContainerRegion = { id: "p", type: "pivot", startRow: 0, startCol: 0, endRow: 3, endCol: 3 };
    expect(visualContentRect(cellAnchored)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("reset forgets every recorded layout", () => {
    const c = titled();
    const measured = layoutVisualContainer(outer, c, { title: 4, subtitle: 1 });
    recordPaintedContainerLayout("chart-1", containerLayoutSignature(outer, c), measured);
    resetPaintedContainerLayouts();
    expect(visualContentRectFor("chart-1", outer, c)).toEqual(layoutVisualContainer(outer, c).content);
  });
});
