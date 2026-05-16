//! FILENAME: app/src/core/lib/gridRenderer/rendering/cells.advanced.test.ts
// PURPOSE: Advanced tests for cell rendering - rich text edge cases, extreme inputs
// CONTEXT: Tests drawTextWithTruncation and drawRichTextRuns with stress/edge scenarios

import { describe, it, expect, vi, beforeEach } from "vitest";
import { drawTextWithTruncation, drawRichTextRuns } from "./cells";
import type { RichTextRun } from "../../../types/types";

// ============================================================================
// Canvas mock factory
// ============================================================================

function makeCtx(opts?: { charWidth?: number }): CanvasRenderingContext2D {
  const charWidth = opts?.charWidth ?? 8;
  return {
    fillText: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clip: vi.fn(),
    rect: vi.fn(),
    setLineDash: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    clearRect: vi.fn(),
    measureText: vi.fn().mockImplementation((text: string) => ({
      width: text.length * charWidth,
    })),
    canvas: { width: 800, height: 600 },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    globalAlpha: 1,
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  } as unknown as CanvasRenderingContext2D;
}

// ============================================================================
// Rich text with 10+ runs (performance and correctness)
// ============================================================================

describe("drawRichTextRuns - many runs", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx({ charWidth: 5 });
  });

  it("renders 10+ runs correctly and returns accurate total width", () => {
    const runs: RichTextRun[] = Array.from({ length: 12 }, (_, i) => ({
      text: `R${i}`,
      bold: i % 2 === 0,
      italic: i % 3 === 0,
      color: i % 2 === 0 ? "#ff0000" : "#0000ff",
    }));

    const totalWidth = drawRichTextRuns(
      ctx, runs, 0, 50, 2000, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    // Each run "R0".."R9" is 2 chars, "R10","R11" are 3 chars => 10*2+2*3 = 26 chars * 5 = 130
    expect(totalWidth).toBe(130);
    expect(ctx.fillText).toHaveBeenCalledTimes(12);
  });

  it("handles 20 runs with truncation at a narrow width", () => {
    const runs: RichTextRun[] = Array.from({ length: 20 }, (_, i) => ({
      text: `Word${i} `,
    }));

    drawRichTextRuns(
      ctx, runs, 0, 50, 60, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const allText = calls.map((c: unknown[]) => c[0]).join("");
    expect(allText).toContain("...");
    // Should not draw all 20 runs since truncation stops early
    expect(calls.length).toBeLessThan(20);
  });

  it("positions all 10 runs sequentially with correct x coordinates", () => {
    const runs: RichTextRun[] = Array.from({ length: 10 }, () => ({
      text: "AB", // 2 chars * 5px = 10px each
    }));

    drawRichTextRuns(
      ctx, runs, 100, 50, 2000, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(calls[i][1]).toBe(100 + i * 10);
    }
  });
});

// ============================================================================
// Text with mixed scripts (Latin + CJK + Arabic)
// ============================================================================

describe("drawRichTextRuns - mixed scripts", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx({ charWidth: 8 });
  });

  it("renders Latin + CJK runs as separate runs", () => {
    const runs: RichTextRun[] = [
      { text: "Hello " },
      { text: "\u4F60\u597D" }, // Chinese characters
      { text: " World" },
    ];

    const totalWidth = drawRichTextRuns(
      ctx, runs, 0, 50, 500, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(3);
    // "Hello " = 6, CJK = 2, " World" = 6 => 14 * 8 = 112
    expect(totalWidth).toBe(112);
  });

  it("renders Arabic text run", () => {
    const runs: RichTextRun[] = [
      { text: "\u0645\u0631\u062D\u0628\u0627" }, // Arabic "marhaba"
    ];

    drawRichTextRuns(
      ctx, runs, 0, 50, 500, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledWith("\u0645\u0631\u062D\u0628\u0627", expect.any(Number), expect.any(Number));
  });

  it("renders mixed Latin + CJK + Arabic in sequence", () => {
    const runs: RichTextRun[] = [
      { text: "Abc", fontFamily: "Arial" },
      { text: "\u6F22\u5B57", fontFamily: "MS Gothic" },
      { text: "\u0639\u0631\u0628\u064A", fontFamily: "Arial" },
    ];

    const fontLog: string[] = [];
    Object.defineProperty(ctx, "font", {
      set(val: string) { fontLog.push(val); },
      get() { return fontLog[fontLog.length - 1] || ""; },
    });

    drawRichTextRuns(
      ctx, runs, 0, 50, 500, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(3);
    expect(fontLog.some(f => f.includes("MS Gothic"))).toBe(true);
  });
});

// ============================================================================
// Very long single-line text (10K chars) truncation
// ============================================================================

describe("drawTextWithTruncation - extreme lengths", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx({ charWidth: 1 });
  });

  it("truncates 10K character text without error", () => {
    const longText = "A".repeat(10000);
    const width = drawTextWithTruncation(ctx, longText, 0, 0, 200);
    expect(width).toBe(10000); // original width returned
    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const drawn = calls[0][0] as string;
    expect(drawn).toContain("...");
    expect(drawn.length).toBeLessThan(10000);
  });

  it("handles 10K text that fits within maxWidth", () => {
    const longText = "A".repeat(10000);
    const width = drawTextWithTruncation(ctx, longText, 0, 0, 20000);
    expect(width).toBe(10000);
    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe(longText);
  });

  it("truncates 50K character text efficiently", () => {
    const hugeText = "X".repeat(50000);
    const start = performance.now();
    drawTextWithTruncation(ctx, hugeText, 0, 0, 100);
    const elapsed = performance.now() - start;
    // Binary search should handle this in O(log n) calls - should be fast
    expect(elapsed).toBeLessThan(1000); // generous bound for CI
    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0] as string).toContain("...");
  });
});

// ============================================================================
// Cell with all style properties set simultaneously
// ============================================================================

describe("drawRichTextRuns - all style properties at once", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx({ charWidth: 8 });
  });

  it("renders a run with bold, italic, underline, strikethrough, color, fontSize, fontFamily", () => {
    const fontLog: string[] = [];
    Object.defineProperty(ctx, "font", {
      set(val: string) { fontLog.push(val); },
      get() { return fontLog[fontLog.length - 1] || ""; },
    });

    const runs: RichTextRun[] = [{
      text: "FullStyle",
      bold: true,
      italic: true,
      underline: "single",
      strikethrough: true,
      color: "#ff6600",
      fontSize: 18,
      fontFamily: "Courier New",
    }];

    drawRichTextRuns(
      ctx, runs, 10, 50, 500, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    expect(ctx.fillStyle).toBe("#ff6600");
    // Font should include bold + italic + 18px + Courier New
    const font = fontLog.find(f => f.includes("bold") && f.includes("italic") && f.includes("18px") && f.includes("Courier New"));
    expect(font).toBeDefined();
    // Underline and strikethrough should both produce stroke calls
    // 2 decorations = 2 beginPath + 2 moveTo + 2 lineTo + 2 stroke
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Superscript + subscript in same cell
// ============================================================================

describe("drawRichTextRuns - superscript and subscript in same cell", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx({ charWidth: 8 });
  });

  it("renders x^2 + H_2 with correct vertical offsets", () => {
    const runs: RichTextRun[] = [
      { text: "x" },
      { text: "2", superscript: true },
      { text: " + H" },
      { text: "2", subscript: true },
    ];

    drawRichTextRuns(
      ctx, runs, 0, 100, 500, "left",
      20, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(4);

    const baseY = calls[0][2]; // "x" baseline
    const superY = calls[1][2]; // "2" superscript
    const midY = calls[2][2]; // " + H" baseline
    const subY = calls[3][2]; // "2" subscript

    // Superscript should be above base (y decreases upward)
    expect(superY).toBeLessThan(baseY);
    // Subscript should be below base
    expect(subY).toBeGreaterThan(midY);
    // Base runs should be at the same y
    expect(baseY).toBe(midY);
    expect(baseY).toBe(100);
  });

  it("uses scaled font for both super and subscript", () => {
    const fontLog: string[] = [];
    Object.defineProperty(ctx, "font", {
      set(val: string) { fontLog.push(val); },
      get() { return fontLog[fontLog.length - 1] || ""; },
    });

    const runs: RichTextRun[] = [
      { text: "a", fontSize: 30 },
      { text: "sup", superscript: true, fontSize: 30 },
      { text: "b", fontSize: 30 },
      { text: "sub", subscript: true, fontSize: 30 },
    ];

    drawRichTextRuns(
      ctx, runs, 0, 50, 1000, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    // 30 * 0.65 = 19.5 -> Math.round = 20
    const hasBase = fontLog.some(f => f.includes("30px"));
    const hasScaled = fontLog.some(f => f.includes("20px"));
    expect(hasBase).toBe(true);
    expect(hasScaled).toBe(true);
  });
});

// ============================================================================
// Empty rich text runs
// ============================================================================

describe("drawRichTextRuns - empty text runs", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx({ charWidth: 8 });
  });

  it("skips fillText for empty string runs", () => {
    const runs: RichTextRun[] = [
      { text: "" },
      { text: "Visible" },
      { text: "" },
    ];

    drawRichTextRuns(
      ctx, runs, 0, 50, 500, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    // Only "Visible" should be drawn (empty runs skip fillText due to length check)
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledWith("Visible", expect.any(Number), expect.any(Number));
  });

  it("does not draw underline for empty runs even with underline enabled", () => {
    const runs: RichTextRun[] = [
      { text: "", underline: "single" },
    ];

    drawRichTextRuns(
      ctx, runs, 0, 50, 500, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it("does not draw strikethrough for empty runs", () => {
    const runs: RichTextRun[] = [
      { text: "", strikethrough: true },
    ];

    drawRichTextRuns(
      ctx, runs, 0, 50, 500, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it("still measures empty runs contributing zero width", () => {
    const runs: RichTextRun[] = [
      { text: "" },
      { text: "A" },
    ];

    const totalWidth = drawRichTextRuns(
      ctx, runs, 0, 50, 500, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    // "" = 0 * 8 = 0, "A" = 1 * 8 = 8
    expect(totalWidth).toBe(8);
  });
});

// ============================================================================
// Font size 0 and very large font sizes
// ============================================================================

describe("drawRichTextRuns - extreme font sizes", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx({ charWidth: 8 });
  });

  it("handles fontSize 0 without crashing", () => {
    const runs: RichTextRun[] = [{ text: "Tiny", fontSize: 0 }];

    expect(() => {
      drawRichTextRuns(
        ctx, runs, 0, 50, 500, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, false, false,
      );
    }).not.toThrow();

    expect(ctx.fillText).toHaveBeenCalledTimes(1);
  });

  it("handles very large fontSize (200)", () => {
    const fontLog: string[] = [];
    Object.defineProperty(ctx, "font", {
      set(val: string) { fontLog.push(val); },
      get() { return fontLog[fontLog.length - 1] || ""; },
    });

    const runs: RichTextRun[] = [{ text: "Huge", fontSize: 200 }];

    drawRichTextRuns(
      ctx, runs, 0, 50, 5000, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    expect(fontLog.some(f => f.includes("200px"))).toBe(true);
  });

  it("handles fontSize 1 (minimum practical)", () => {
    const fontLog: string[] = [];
    Object.defineProperty(ctx, "font", {
      set(val: string) { fontLog.push(val); },
      get() { return fontLog[fontLog.length - 1] || ""; },
    });

    const runs: RichTextRun[] = [{ text: "Small", fontSize: 1 }];

    drawRichTextRuns(
      ctx, runs, 0, 50, 500, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    expect(fontLog.some(f => f.includes("1px"))).toBe(true);
  });

  it("superscript with fontSize 1 produces scaled size via Math.round", () => {
    const fontLog: string[] = [];
    Object.defineProperty(ctx, "font", {
      set(val: string) { fontLog.push(val); },
      get() { return fontLog[fontLog.length - 1] || ""; },
    });

    const runs: RichTextRun[] = [{ text: "s", fontSize: 1, superscript: true }];

    drawRichTextRuns(
      ctx, runs, 0, 50, 500, "left",
      12, "Arial", "normal", "normal", "#000",
      false, false, false, false,
    );

    // 1 * 0.65 = 0.65, Math.round = 1
    expect(fontLog.some(f => f.includes("1px"))).toBe(true);
  });
});
