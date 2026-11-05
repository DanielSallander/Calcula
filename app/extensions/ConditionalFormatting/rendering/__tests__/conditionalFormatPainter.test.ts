//! FILENAME: app/extensions/ConditionalFormatting/rendering/__tests__/conditionalFormatPainter.test.ts
// PURPOSE: The data-bar / icon-set painter this extension registers with
//          `@api/conditionalFormatPaint` takes its colours from the rules the
//          CALLER hands over (a floating grid's backing sheet) -- never from this
//          extension's active-sheet store (`getRules()`), which would give every
//          floating-grid bar the default blue.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/cfStore", () => ({
  getRules: vi.fn(() => []),
  getEvaluationForCell: vi.fn(() => null),
}));

import { getRules } from "../../lib/cfStore";
import { conditionalFormatGlyphPainter } from "../conditionalFormatPainter";
import {
  paintDataBar,
  findDataBarRule,
  layoutDataBar,
  DEFAULT_DATA_BAR_COLOR,
  DEFAULT_NEGATIVE_BAR_COLOR,
} from "../dataBarRenderer";
import type { CellConditionalFormat, ConditionalFormatDefinition, DataBarRule } from "@api";

interface Op {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
}

function makeCtx(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  const api: Record<string, unknown> = { fillStyle: "#000000", strokeStyle: "#000000", lineWidth: 1, globalAlpha: 1 };
  const rec = (op: string) => (...args: unknown[]) => {
    ops.push({ op, args, fillStyle: api.fillStyle, strokeStyle: api.strokeStyle });
  };
  for (const name of [
    "save", "restore", "beginPath", "moveTo", "lineTo", "closePath", "arc", "fill", "stroke",
    "fillRect", "strokeRect", "rect", "clip", "translate", "rotate", "scale", "quadraticCurveTo",
    "bezierCurveTo", "ellipse", "fillText", "setLineDash",
  ]) {
    api[name] = rec(name);
  }
  api.measureText = (t: string) => ({ width: t.length * 6 });
  api.createLinearGradient = () => ({ addColorStop() {} });
  return { ctx: api as unknown as CanvasRenderingContext2D, ops };
}

const BOX = { x: 40, y: 60, width: 100, height: 20 };

function dataBarRule(id: number, fillColor: string, gradientFill: boolean, extra: Partial<DataBarRule> = {}): ConditionalFormatDefinition {
  const rule: DataBarRule = {
    type: "dataBar",
    minValueType: "automaticMin" as DataBarRule["minValueType"],
    maxValueType: "automaticMax" as DataBarRule["maxValueType"],
    fillColor,
    axisPosition: "automatic",
    direction: "context" as DataBarRule["direction"],
    showValue: true,
    gradientFill,
    ...extra,
  };
  return { id, priority: 1, rule, format: {}, ranges: [], stopIfTrue: false, enabled: true };
}

describe("conditionalFormatGlyphPainter", () => {
  beforeEach(() => {
    vi.mocked(getRules).mockClear();
  });

  it("paints a data bar in the colour of the rule passed in `rules`", () => {
    const { ctx, ops } = makeCtx();
    const results: CellConditionalFormat[] = [{ row: 0, col: 0, format: {}, dataBarPercent: 0.5, ruleId: 3 }];
    conditionalFormatGlyphPainter.paint(ctx, BOX, results, [dataBarRule(3, "#FF0000", false, { borderColor: "#FF0000" })]);
    const bar = ops.find((o) => o.op === "fillRect");
    expect(bar).toBeDefined();
    expect(bar!.fillStyle).toBe("#FF0000");
    // Inset 2px, half of the 96px inner width.
    expect(bar!.args).toEqual([BOX.x + 2, BOX.y + 2, 48, BOX.height - 4]);
    const outline = ops.find((o) => o.op === "strokeRect");
    expect(outline!.strokeStyle).toBe("#FF0000");
  });

  it("never asks the active-sheet rule store", () => {
    const { ctx } = makeCtx();
    const results: CellConditionalFormat[] = [{ row: 0, col: 0, format: {}, dataBarPercent: 1, ruleId: 3 }];
    conditionalFormatGlyphPainter.paint(ctx, BOX, results, [dataBarRule(3, "#FF0000", false)]);
    expect(getRules).not.toHaveBeenCalled();
  });

  it("a rule id missing from `rules` paints the default bar, not another sheet's colour", () => {
    vi.mocked(getRules).mockReturnValue([dataBarRule(3, "#00FF00", false)]);
    const { ctx, ops } = makeCtx();
    const results: CellConditionalFormat[] = [{ row: 0, col: 0, format: {}, dataBarPercent: 0.5, ruleId: 3 }];
    conditionalFormatGlyphPainter.paint(ctx, BOX, results, []);
    const outline = ops.find((o) => o.op === "strokeRect");
    expect(outline!.strokeStyle).toBe(DEFAULT_DATA_BAR_COLOR);
    expect(getRules).not.toHaveBeenCalled();
  });

  it("paints an icon from the result's resolved set", () => {
    const { ctx, ops } = makeCtx();
    const results: CellConditionalFormat[] = [
      { row: 0, col: 0, format: {}, iconIndex: 0, iconSet: "threeTrafficLights1", ruleId: 9 },
    ];
    conditionalFormatGlyphPainter.paint(ctx, BOX, results, []);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.some((o) => o.op === "fill" || o.op === "fillRect" || o.op === "stroke")).toBe(true);
  });

  it("an index without a set paints nothing (BUG-0107: never guessed)", () => {
    const { ctx, ops } = makeCtx();
    conditionalFormatGlyphPainter.paint(ctx, BOX, [{ row: 0, col: 0, format: {}, iconIndex: 1 }], []);
    expect(ops).toHaveLength(0);
  });
});

describe("paintDataBar / findDataBarRule", () => {
  it("clamps the bar to the box", () => {
    const { ctx, ops } = makeCtx();
    paintDataBar(ctx, BOX, 1.7, { fillColor: "#112233", gradientFill: false });
    expect(ops.find((o) => o.op === "fillRect")!.args[2]).toBe(BOX.width - 4);
  });

  it("finds only a data-bar rule with the id", () => {
    const rules = [dataBarRule(1, "#AA0000", true)];
    expect(findDataBarRule(rules, 1)).toMatchObject({ fillColor: "#AA0000", gradientFill: true });
    expect(findDataBarRule(rules, 2)).toBeNull();
    expect(findDataBarRule(rules, undefined)).toBeNull();
  });
});

// ============================================================================
// The rule's options (BUG-0511). Excel's geometry was measured [LIVE]
// 2026-11-04 from a PDF export (see data_bar_geometry, conditional_formatting.rs):
// an automatic axis one third into a -5 / 10 range, -5 a red bar running LEFT
// from it, right-to-left mirroring it all, opaque bars, no border on solid fill.
// ============================================================================

describe("layoutDataBar: Excel's geometry", () => {
  // Bar area: x 42..138 (96 wide), y 62..78.
  const AREA = { x: BOX.x + 2, w: BOX.width - 4 };

  it("no axis: from the left edge, `percent` long", () => {
    const l = layoutDataBar(BOX, { percent: 0.5 })!;
    expect(l.bar).toEqual({ x: AREA.x, y: BOX.y + 2, width: 48, height: BOX.height - 4 });
    expect(l.axisX).toBeNull();
  });

  it("a NEGATIVE value runs from the axis toward the left edge", () => {
    const l = layoutDataBar(BOX, { percent: 0.25, axis: 0.5, negative: true })!;
    expect(l.bar!.x).toBeCloseTo(AREA.x + 24, 9);
    expect(l.bar!.width).toBeCloseTo(24, 9);
    expect(l.axisX).toBeCloseTo(AREA.x + 48, 9);
    expect(l.negative).toBe(true);
  });

  it("a positive value runs from the axis toward the right edge", () => {
    const l = layoutDataBar(BOX, { percent: 0.25, axis: 0.5 })!;
    expect(l.bar!.x).toBeCloseTo(AREA.x + 48, 9);
    expect(l.bar!.width).toBeCloseTo(24, 9);
  });

  it("right-to-left mirrors the bar and the axis", () => {
    const ltr = layoutDataBar(BOX, { percent: 0.25, axis: 1 / 3, negative: true })!;
    const rtl = layoutDataBar(BOX, { percent: 0.25, axis: 1 / 3, negative: true }, "rightToLeft")!;
    expect(rtl.axisX).toBeCloseTo(AREA.x + AREA.w - (ltr.axisX! - AREA.x), 9);
    // The negative bar is now RIGHT of the axis.
    expect(rtl.bar!.x).toBeCloseTo(rtl.axisX!, 9);
    const plain = layoutDataBar(BOX, { percent: 0.5 }, "rightToLeft")!;
    expect(plain.bar!.x).toBeCloseTo(AREA.x + 48, 9);
  });

  it("an axis at the far edge (all values negative) draws no axis line", () => {
    const l = layoutDataBar(BOX, { percent: 0.5, axis: 1, negative: true })!;
    expect(l.axisX).toBeNull();
    expect(l.bar!.x + l.bar!.width).toBeCloseTo(AREA.x + AREA.w, 9);
  });
});

describe("paintDataBar: the rule's colours, border and axis", () => {
  const RULE = {
    fillColor: "#638EC6",
    gradientFill: false,
    negativeFillColor: "#00AA00",
    axisColor: "#123456",
  };

  it("a negative bar is painted in the NEGATIVE fill colour, and the axis in the axis colour", () => {
    const { ctx, ops } = makeCtx();
    paintDataBar(ctx, BOX, { percent: 0.2, axis: 0.4, negative: true }, RULE);
    expect(ops.find((o) => o.op === "fillRect")!.fillStyle).toBe("#00AA00");
    expect(ops.find((o) => o.op === "setLineDash" && (o.args[0] as number[]).length > 0)).toBeTruthy();
    expect(ops.find((o) => o.op === "stroke")!.strokeStyle).toBe("#123456");
  });

  it("without a negative colour a negative bar is Excel's red, never the positive colour", () => {
    const { ctx, ops } = makeCtx();
    paintDataBar(ctx, BOX, { percent: 0.2, axis: 0.4, negative: true }, { fillColor: "#638EC6", gradientFill: false });
    expect(ops.find((o) => o.op === "fillRect")!.fillStyle).toBe(DEFAULT_NEGATIVE_BAR_COLOR);
  });

  it("a rule without a border paints none (Excel's solid presets); with one, in its colour", () => {
    const none = makeCtx();
    paintDataBar(none.ctx, BOX, 0.5, RULE);
    expect(none.ops.some((o) => o.op === "strokeRect")).toBe(false);
    const bordered = makeCtx();
    paintDataBar(bordered.ctx, BOX, 0.5, { ...RULE, borderColor: "#0000FF" });
    expect(bordered.ops.find((o) => o.op === "strokeRect")!.strokeStyle).toBe("#0000FF");
  });

  it("is opaque (Excel's PDF fill alpha is 1; it used to be 35%)", () => {
    const api: Record<string, unknown> = {};
    const { ctx } = makeCtx();
    let alphaAtFill = -1;
    const proxy = new Proxy(ctx as unknown as Record<string, unknown>, {
      get(target, key) {
        if (key === "fillRect") return () => { alphaAtFill = (api.globalAlpha as number) ?? 1; };
        return target[key as string];
      },
      set(target, key, value) {
        if (key === "globalAlpha") api.globalAlpha = value;
        target[key as string] = value;
        return true;
      },
    });
    paintDataBar(proxy as unknown as CanvasRenderingContext2D, BOX, 0.5, RULE);
    expect(alphaAtFill === -1 ? 1 : alphaAtFill).toBe(1);
  });

  it("the glyph painter hands the backend's axis and sign to the bar", () => {
    const { ctx, ops } = makeCtx();
    conditionalFormatGlyphPainter.paint(
      ctx,
      BOX,
      [{ row: 0, col: 0, format: {}, dataBarPercent: 0.25, dataBarAxis: 0.5, dataBarNegative: true, ruleId: 3 }],
      [dataBarRule(3, "#638EC6", false, { negativeFillColor: "#00AA00" })],
    );
    const bar = ops.find((o) => o.op === "fillRect")!;
    expect(bar.fillStyle).toBe("#00AA00");
    expect(bar.args[0]).toBeCloseTo(BOX.x + 2 + 24, 9);
  });
});
