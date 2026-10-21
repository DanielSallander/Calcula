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
import { paintDataBar, findDataBarRule, DEFAULT_DATA_BAR_COLOR } from "../dataBarRenderer";
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

function dataBarRule(id: number, fillColor: string, gradientFill: boolean): ConditionalFormatDefinition {
  const rule: DataBarRule = {
    type: "dataBar",
    minValueType: "automaticMin" as DataBarRule["minValueType"],
    maxValueType: "automaticMax" as DataBarRule["maxValueType"],
    fillColor,
    axisPosition: "automatic",
    direction: "context" as DataBarRule["direction"],
    showValue: true,
    gradientFill,
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
    conditionalFormatGlyphPainter.paint(ctx, BOX, results, [dataBarRule(3, "#FF0000", false)]);
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
