//! FILENAME: app/src/core/lib/gridRenderer/rendering/cells.deeptest.ts
// PURPOSE: Deep tests for cell rendering logic - truncation, alignment, rich text
// CONTEXT: Tests drawTextWithTruncation and drawRichTextRuns with comprehensive scenarios

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
// drawTextWithTruncation
// ============================================================================

describe("drawTextWithTruncation", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx({ charWidth: 8 });
  });

  describe("text fits within maxWidth", () => {
    it("draws text at x for left alignment", () => {
      // "Hello" = 5 chars * 8 = 40px, maxWidth = 200
      const width = drawTextWithTruncation(ctx, "Hello", 10, 20, 200, "left");
      expect(ctx.fillText).toHaveBeenCalledWith("Hello", 10, 20);
      expect(width).toBe(40);
    });

    it("draws text right-aligned", () => {
      // "Hi" = 2 chars * 8 = 16px, maxWidth = 100
      drawTextWithTruncation(ctx, "Hi", 10, 20, 100, "right");
      // drawX = 10 + 100 - 16 = 94
      expect(ctx.fillText).toHaveBeenCalledWith("Hi", 94, 20);
    });

    it("draws text center-aligned", () => {
      // "Hi" = 16px, maxWidth = 100
      drawTextWithTruncation(ctx, "Hi", 10, 20, 100, "center");
      // drawX = 10 + (100 - 16) / 2 = 10 + 42 = 52
      expect(ctx.fillText).toHaveBeenCalledWith("Hi", 52, 20);
    });

    it("defaults to left alignment", () => {
      drawTextWithTruncation(ctx, "Hi", 10, 20, 100);
      expect(ctx.fillText).toHaveBeenCalledWith("Hi", 10, 20);
    });
  });

  describe("text exceeds maxWidth - truncation", () => {
    it("truncates with ellipsis when text is too wide", () => {
      // "Hello World!!" = 13 chars * 8 = 104px, maxWidth = 50
      drawTextWithTruncation(ctx, "Hello World!!", 10, 20, 50);
      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      const drawnText = calls[0][0] as string;
      expect(drawnText).toContain("...");
      expect(drawnText.length).toBeLessThan("Hello World!!".length + 3);
    });

    it("returns original text width even when truncated", () => {
      // Original width should be returned regardless of truncation
      const width = drawTextWithTruncation(ctx, "Hello World!!", 10, 20, 50);
      expect(width).toBe(13 * 8); // 104
    });

    it("draws just ellipsis when maxWidth is very small", () => {
      // maxWidth smaller than ellipsis width
      // "..." = 3 chars * 8 = 24px, available = 5 - 24 = negative
      drawTextWithTruncation(ctx, "Hello", 10, 20, 5);
      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe("...");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      const width = drawTextWithTruncation(ctx, "", 10, 20, 100);
      expect(width).toBe(0);
      expect(ctx.fillText).toHaveBeenCalledWith("", 10, 20);
    });

    it("handles single character that fits", () => {
      const width = drawTextWithTruncation(ctx, "A", 0, 0, 100);
      expect(width).toBe(8);
      expect(ctx.fillText).toHaveBeenCalledWith("A", 0, 0);
    });

    it("handles text exactly at maxWidth", () => {
      // "12345" = 5 * 8 = 40px, maxWidth = 40
      drawTextWithTruncation(ctx, "12345", 0, 0, 40);
      expect(ctx.fillText).toHaveBeenCalledWith("12345", 0, 0);
    });
  });
});

// ============================================================================
// drawRichTextRuns - deep tests
// ============================================================================

describe("drawRichTextRuns - deep tests", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx({ charWidth: 8 });
  });

  describe("alignment with multiple runs", () => {
    it("right-aligns multiple runs", () => {
      const runs: RichTextRun[] = [
        { text: "AB" },  // 16px
        { text: "CD" },  // 16px
      ];
      // totalWidth = 32, maxWidth = 100
      drawRichTextRuns(
        ctx, runs, 10, 20, 100, "right",
        11, "Calibri", "normal", "normal", "#000",
        false, false, false, false,
      );
      // drawX = 10 + 100 - 32 = 78
      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][1]).toBe(78); // first run at 78
      expect(calls[1][1]).toBe(78 + 16); // second run at 94
    });

    it("center-aligns multiple runs", () => {
      const runs: RichTextRun[] = [
        { text: "AB" },  // 16px
        { text: "CD" },  // 16px
      ];
      drawRichTextRuns(
        ctx, runs, 10, 20, 100, "center",
        11, "Calibri", "normal", "normal", "#000",
        false, false, false, false,
      );
      // drawX = 10 + (100 - 32) / 2 = 10 + 34 = 44
      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][1]).toBe(44);
      expect(calls[1][1]).toBe(44 + 16);
    });
  });

  describe("font inheritance from base", () => {
    it("inherits bold from base when run does not specify", () => {
      const fontLog: string[] = [];
      Object.defineProperty(ctx, "font", {
        set(val: string) { fontLog.push(val); },
        get() { return fontLog[fontLog.length - 1] || ""; },
      });

      const runs: RichTextRun[] = [{ text: "Hello" }];
      drawRichTextRuns(
        ctx, runs, 0, 0, 200, "left",
        12, "Arial", "normal", "normal", "#000",
        true, false, false, false, // baseBold = true
      );

      // Run should inherit bold from base
      const drawFont = fontLog.find(f => f.includes("bold"));
      expect(drawFont).toBeDefined();
    });

    it("inherits italic from base when run does not specify", () => {
      const fontLog: string[] = [];
      Object.defineProperty(ctx, "font", {
        set(val: string) { fontLog.push(val); },
        get() { return fontLog[fontLog.length - 1] || ""; },
      });

      const runs: RichTextRun[] = [{ text: "Hello" }];
      drawRichTextRuns(
        ctx, runs, 0, 0, 200, "left",
        12, "Arial", "normal", "normal", "#000",
        false, true, false, false, // baseItalic = true
      );

      const drawFont = fontLog.find(f => f.includes("italic"));
      expect(drawFont).toBeDefined();
    });

    it("run bold overrides base non-bold", () => {
      const fontLog: string[] = [];
      Object.defineProperty(ctx, "font", {
        set(val: string) { fontLog.push(val); },
        get() { return fontLog[fontLog.length - 1] || ""; },
      });

      const runs: RichTextRun[] = [{ text: "Bold", bold: true }];
      drawRichTextRuns(
        ctx, runs, 0, 0, 200, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, false, false,
      );

      const hasBold = fontLog.some(f => f.includes("bold"));
      expect(hasBold).toBe(true);
    });
  });

  describe("underline and strikethrough", () => {
    it("draws underline when base underline is true", () => {
      const runs: RichTextRun[] = [{ text: "Test" }];
      drawRichTextRuns(
        ctx, runs, 0, 0, 200, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, true, false, // baseUnderline = true
      );

      expect(ctx.moveTo).toHaveBeenCalled();
      expect(ctx.lineTo).toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
    });

    it("draws strikethrough when base strikethrough is true", () => {
      const runs: RichTextRun[] = [{ text: "Test" }];
      drawRichTextRuns(
        ctx, runs, 0, 0, 200, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, false, true, // baseStrikethrough = true
      );

      expect(ctx.moveTo).toHaveBeenCalled();
      expect(ctx.lineTo).toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
    });

    it("does not draw underline for empty text run", () => {
      const runs: RichTextRun[] = [{ text: "" }];
      drawRichTextRuns(
        ctx, runs, 0, 0, 200, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, true, false,
      );

      // Empty text should not trigger stroke calls
      expect(ctx.stroke).not.toHaveBeenCalled();
    });
  });

  describe("superscript and subscript", () => {
    it("superscript and subscript use scaled font size", () => {
      const fontLog: string[] = [];
      Object.defineProperty(ctx, "font", {
        set(val: string) { fontLog.push(val); },
        get() { return fontLog[fontLog.length - 1] || ""; },
      });

      const runs: RichTextRun[] = [
        { text: "H", fontSize: 20 },
        { text: "2", subscript: true, fontSize: 20 },
        { text: "O", fontSize: 20 },
      ];
      drawRichTextRuns(
        ctx, runs, 0, 0, 500, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, false, false,
      );

      // 20 * 0.65 = 13
      const has20 = fontLog.some(f => f.includes("20px"));
      const has13 = fontLog.some(f => f.includes("13px"));
      expect(has20).toBe(true);
      expect(has13).toBe(true);
    });

    it("superscript y-position is above base", () => {
      const runs: RichTextRun[] = [
        { text: "x" },
        { text: "2", superscript: true },
      ];
      drawRichTextRuns(
        ctx, runs, 0, 100, 500, "left",
        20, "Arial", "normal", "normal", "#000",
        false, false, false, false,
      );

      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
      const baseY = calls[0][2];
      const superY = calls[1][2];
      // Superscript offset = baseFontSize * -0.35 = 20 * -0.35 = -7
      expect(superY).toBe(baseY + 20 * (-0.35));
    });

    it("subscript y-position is below base", () => {
      const runs: RichTextRun[] = [
        { text: "x" },
        { text: "2", subscript: true },
      ];
      drawRichTextRuns(
        ctx, runs, 0, 100, 500, "left",
        20, "Arial", "normal", "normal", "#000",
        false, false, false, false,
      );

      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
      const baseY = calls[0][2];
      const subY = calls[1][2];
      expect(subY).toBe(baseY + 20 * 0.2);
    });
  });

  describe("truncation with rich text", () => {
    it("adds ellipsis when total run width exceeds maxWidth", () => {
      // Each run measures to 8 * length. Two runs of 20 chars each = 320px
      const runs: RichTextRun[] = [
        { text: "12345678901234567890" }, // 160px
        { text: "12345678901234567890" }, // 160px
      ];
      drawRichTextRuns(
        ctx, runs, 0, 0, 100, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, false, false,
      );

      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
      const allText = calls.map((c: unknown[]) => c[0]).join("");
      expect(allText).toContain("...");
    });

    it("returns total width even when truncated", () => {
      const runs: RichTextRun[] = [
        { text: "12345678901234567890" }, // 160px
      ];
      const totalWidth = drawRichTextRuns(
        ctx, runs, 0, 0, 50, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, false, false,
      );
      expect(totalWidth).toBe(160);
    });

    it("draws only ellipsis when maxWidth is tiny", () => {
      // "..." = 24px. If maxWidth < 24, should just draw ellipsis
      const runs: RichTextRun[] = [
        { text: "Hello World" },
      ];
      drawRichTextRuns(
        ctx, runs, 0, 0, 10, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, false, false,
      );

      const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe("...");
    });
  });

  describe("color handling", () => {
    it("uses run color when specified", () => {
      const runs: RichTextRun[] = [
        { text: "Red", color: "#ff0000" },
        { text: "Blue", color: "#0000ff" },
      ];
      drawRichTextRuns(
        ctx, runs, 0, 0, 500, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, false, false,
      );

      // After drawing second run, fillStyle should be the last run's color
      expect(ctx.fillStyle).toBe("#0000ff");
    });

    it("uses base color when run has no color", () => {
      const runs: RichTextRun[] = [{ text: "Default" }];
      drawRichTextRuns(
        ctx, runs, 0, 0, 500, "left",
        12, "Arial", "normal", "normal", "#333333",
        false, false, false, false,
      );
      expect(ctx.fillStyle).toBe("#333333");
    });
  });

  describe("font family override", () => {
    it("uses run fontFamily when specified", () => {
      const fontLog: string[] = [];
      Object.defineProperty(ctx, "font", {
        set(val: string) { fontLog.push(val); },
        get() { return fontLog[fontLog.length - 1] || ""; },
      });

      const runs: RichTextRun[] = [
        { text: "Mono", fontFamily: "Courier New" },
      ];
      drawRichTextRuns(
        ctx, runs, 0, 0, 500, "left",
        12, "Arial", "normal", "normal", "#000",
        false, false, false, false,
      );

      const hasCourier = fontLog.some(f => f.includes("Courier New"));
      expect(hasCourier).toBe(true);
    });
  });
});
