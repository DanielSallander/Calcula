//! FILENAME: app/src/api/__tests__/conditionalFormatPaint.test.ts
// PURPOSE: The `@api/conditionalFormatPaint` seam: with no painter registered it
//          paints nothing and throws nothing; a registered painter is called
//          with the cell's results AND the caller's rules; unregistering stops
//          it; a throwing painter does not take the paint down. Plus the ONE
//          fold of results into a style override (first match wins).

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  registerConditionalFormatPainter,
  hasConditionalFormatPainters,
  paintConditionalFormat,
  conditionalResultsToOverride,
  type ConditionalFormatPainter,
} from "../conditionalFormatPaint";
import type { CellConditionalFormat, ConditionalFormatDefinition } from "../backend";

const BOX = { x: 10, y: 20, width: 64, height: 20 };

function ctxDouble(): CanvasRenderingContext2D {
  const calls: string[] = [];
  return new Proxy({ calls } as Record<string, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return (..._args: unknown[]) => {
        calls.push(String(prop));
      };
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const RESULTS: CellConditionalFormat[] = [
  { row: 0, col: 0, format: {}, dataBarPercent: 0.5, ruleId: 7 },
];
const RULES = [{ id: 7 } as ConditionalFormatDefinition];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("@api/conditionalFormatPaint registry", () => {
  it("with no painter registered paints nothing and throws nothing", () => {
    expect(hasConditionalFormatPainters()).toBe(false);
    const ctx = ctxDouble();
    expect(() => paintConditionalFormat(ctx, BOX, RESULTS, RULES)).not.toThrow();
    expect((ctx as unknown as { calls: string[] }).calls).toEqual([]);
  });

  it("calls the registered painter with the box, the results and the rules", () => {
    const paint = vi.fn();
    cleanups.push(registerConditionalFormatPainter({ paint }));
    const ctx = ctxDouble();
    paintConditionalFormat(ctx, BOX, RESULTS, RULES);
    expect(paint).toHaveBeenCalledTimes(1);
    const [gotCtx, gotBox, gotResults, gotRules] = paint.mock.calls[0];
    expect(gotCtx).toBe(ctx);
    expect(gotBox).toBe(BOX);
    expect(gotResults).toBe(RESULTS);
    expect(gotRules).toBe(RULES);
  });

  it("does not call a painter for a cell with no results", () => {
    const paint = vi.fn();
    cleanups.push(registerConditionalFormatPainter({ paint }));
    paintConditionalFormat(ctxDouble(), BOX, [], RULES);
    expect(paint).not.toHaveBeenCalled();
  });

  it("unregistering stops the painter", () => {
    const paint = vi.fn();
    const off = registerConditionalFormatPainter({ paint });
    off();
    paintConditionalFormat(ctxDouble(), BOX, RESULTS, RULES);
    expect(paint).not.toHaveBeenCalled();
    expect(hasConditionalFormatPainters()).toBe(false);
  });

  it("a throwing painter is skipped and the next one still paints", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: ConditionalFormatPainter = {
      paint() {
        throw new Error("boom");
      },
    };
    const good = vi.fn();
    cleanups.push(registerConditionalFormatPainter(broken));
    cleanups.push(registerConditionalFormatPainter({ paint: good }));
    expect(() => paintConditionalFormat(ctxDouble(), BOX, RESULTS, RULES)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe("conditionalResultsToOverride", () => {
  it("returns null for no results", () => {
    expect(conditionalResultsToOverride(null)).toBeNull();
    expect(conditionalResultsToOverride([])).toBeNull();
    expect(conditionalResultsToOverride([{ row: 0, col: 0, format: {} }])).toBeNull();
  });

  it("first match wins per property, and a colour scale beats a rule fill", () => {
    const out = conditionalResultsToOverride([
      { row: 0, col: 0, format: { textColor: "#9C0006" }, colorScaleColor: "#63BE7B" },
      { row: 0, col: 0, format: { backgroundColor: "#FFC7CE", textColor: "#000000", bold: true } },
    ]);
    expect(out).toEqual({ backgroundColor: "#63BE7B", textColor: "#9C0006", bold: true });
  });

  it("a border colour brings its style, defaulting to solid", () => {
    const out = conditionalResultsToOverride([
      { row: 0, col: 0, format: { borderTopColor: "#FF0000" } },
    ]);
    expect(out).toEqual({ borderTopColor: "#FF0000", borderTopStyle: "solid" });
  });
});
