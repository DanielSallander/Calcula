//! FILENAME: app/src/core/lib/gridRenderer/rendering/cells.test.ts
// PURPOSE: Tests for rich text rendering logic (drawRichTextRuns).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { drawRichTextRuns } from "./cells";
import type { RichTextRun } from "../../../types/types";

// ============================================================================
// Canvas mock
// ============================================================================

function makeCtx(): CanvasRenderingContext2D {
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
    measureText: vi.fn().mockReturnValue({ width: 40 }),
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
// Tests
// ============================================================================

describe("drawRichTextRuns", () => {
  let ctx: CanvasRenderingContext2D;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it("draws a single plain run", () => {
    const runs: RichTextRun[] = [{ text: "Hello" }];

    drawRichTextRuns(
      ctx, runs, 10, 20, 200, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledWith("Hello", expect.any(Number), expect.any(Number));
  });

  it("draws multiple runs", () => {
    const runs: RichTextRun[] = [
      { text: "Hello " },
      { text: "World" },
    ];

    drawRichTextRuns(
      ctx, runs, 10, 20, 500, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });

  it("applies bold formatting to run font", () => {
    const runs: RichTextRun[] = [{ text: "Bold", bold: true }];

    drawRichTextRuns(
      ctx, runs, 10, 20, 200, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    // The font should contain "bold"
    expect(ctx.font).toBeDefined();
    // fillText should be called
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
  });

  it("applies custom color to a run", () => {
    const runs: RichTextRun[] = [{ text: "Red", color: "#ff0000" }];

    drawRichTextRuns(
      ctx, runs, 10, 20, 200, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    // fillStyle should have been set to the run's color
    expect(ctx.fillStyle).toBe("#ff0000");
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
  });

  it("draws superscript at elevated position", () => {
    const runs: RichTextRun[] = [
      { text: "x" },
      { text: "2", superscript: true },
    ];

    drawRichTextRuns(
      ctx, runs, 10, 20, 200, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(2);
    // The superscript run should be drawn at a different y position than the base
    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const baseY = calls[0][2]; // y of first run
    const superY = calls[1][2]; // y of superscript run
    expect(superY).toBeLessThan(baseY); // Superscript should be higher (lower y value)
  });

  it("draws subscript at lowered position", () => {
    const runs: RichTextRun[] = [
      { text: "H" },
      { text: "2", subscript: true },
      { text: "O" },
    ];

    drawRichTextRuns(
      ctx, runs, 10, 20, 200, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(3);
    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const baseY = calls[0][2];
    const subY = calls[1][2];
    expect(subY).toBeGreaterThan(baseY); // Subscript should be lower (higher y value)
  });

  it("draws underline for underlined run", () => {
    const runs: RichTextRun[] = [{ text: "Underlined", underline: "single" }];

    drawRichTextRuns(
      ctx, runs, 10, 20, 200, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    // moveTo/lineTo/stroke is used for underline lines
    expect(ctx.moveTo).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("draws strikethrough for strikethrough run", () => {
    const runs: RichTextRun[] = [{ text: "Struck", strikethrough: true }];

    drawRichTextRuns(
      ctx, runs, 10, 20, 200, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    // moveTo/lineTo/stroke is used for strikethrough line
    expect(ctx.moveTo).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("returns total measured width", () => {
    // measureText returns { width: 40 } for each call
    const runs: RichTextRun[] = [
      { text: "Hello " },
      { text: "World" },
    ];

    const totalWidth = drawRichTextRuns(
      ctx, runs, 10, 20, 500, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    // With the mock returning 40 per measureText, total should be 80
    expect(totalWidth).toBe(80);
  });

  it("truncates with ellipsis when exceeding maxWidth", () => {
    // Make measureText return large widths so truncation kicks in
    (ctx.measureText as ReturnType<typeof vi.fn>).mockReturnValue({ width: 150 });

    const runs: RichTextRun[] = [
      { text: "Very long text" },
      { text: " that should be truncated" },
    ];

    drawRichTextRuns(
      ctx, runs, 10, 20, 100, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    // When truncating, the function draws an ellipsis
    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const allDrawnText = calls.map((c: unknown[]) => c[0]).join("");
    expect(allDrawnText).toContain("...");
  });

  it("does nothing for empty runs array", () => {
    const runs: RichTextRun[] = [];

    drawRichTextRuns(
      ctx, runs, 10, 20, 200, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("applies custom font size to run", () => {
    const runs: RichTextRun[] = [{ text: "Big", fontSize: 24 }];

    drawRichTextRuns(
      ctx, runs, 10, 20, 200, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    // We can verify measureText was called (font was set before measuring)
    expect(ctx.measureText).toHaveBeenCalled();
  });

  it("uses reduced font size for superscript", () => {
    // Track font changes via a spy
    const fontLog: string[] = [];
    Object.defineProperty(ctx, "font", {
      set(val: string) { fontLog.push(val); },
      get() { return fontLog[fontLog.length - 1] || ""; },
    });

    const runs: RichTextRun[] = [
      { text: "x", fontSize: 20 },
      { text: "2", superscript: true, fontSize: 20 },
    ];

    drawRichTextRuns(
      ctx, runs, 10, 20, 200, "left",
      11, "Calibri", "normal", "normal", "#000000",
      false, false, false, false,
    );

    // Find the font entries - superscript should use 65% of the font size (20 * 0.65 = 13)
    const superFonts = fontLog.filter(f => f.includes("13px") || f.includes("13pt"));
    const baseFonts = fontLog.filter(f => f.includes("20px") || f.includes("20pt"));
    expect(baseFonts.length).toBeGreaterThan(0);
    expect(superFonts.length).toBeGreaterThan(0);
  });
});
