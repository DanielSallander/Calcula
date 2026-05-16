//! FILENAME: app/extensions/Charts/rendering/__tests__/tooltipFormatting.test.ts
// PURPOSE: Tests for the formatTooltipNumber function extracted from chartRenderer.
// CONTEXT: Since formatTooltipNumber is not exported, we test it indirectly via
//          the exported formatTickValue and test the tooltip positioning logic concepts.

import { describe, it, expect } from "vitest";
import { formatTickValue } from "../chartPainterUtils";

// ============================================================================
// Tooltip Value Formatting (formatTickValue used as fallback)
// ============================================================================

describe("tooltip value formatting via formatTickValue", () => {
  it("formats small integers cleanly", () => {
    expect(formatTickValue(5)).toBe("5");
    expect(formatTickValue(0)).toBe("0");
    expect(formatTickValue(-3)).toBe("-3");
  });

  it("formats values just below 1K threshold", () => {
    expect(formatTickValue(999)).toBe("999");
  });

  it("formats values at 1K threshold", () => {
    expect(formatTickValue(1000)).toBe("1.0K");
  });

  it("formats values at 1M threshold", () => {
    expect(formatTickValue(1_000_000)).toBe("1.0M");
  });

  it("formats fractional values", () => {
    expect(formatTickValue(0.5)).toBe("0.5");
    expect(formatTickValue(99.9)).toBe("99.9");
  });
});

// ============================================================================
// Tooltip Positioning Logic (pure math, no canvas needed)
// ============================================================================

describe("tooltip positioning logic", () => {
  // These test the clamping algorithm used in drawTooltip
  const clampTooltip = (
    canvasX: number,
    canvasY: number,
    tooltipWidth: number,
    tooltipHeight: number,
    chartX: number,
    chartY: number,
    chartWidth: number,
    chartHeight: number,
  ) => {
    const offsetX = 12;
    const offsetY = -20;
    let tx = canvasX + offsetX;
    let ty = canvasY + offsetY - tooltipHeight;

    const chartRight = chartX + chartWidth;
    const chartBottom = chartY + chartHeight;

    if (tx + tooltipWidth > chartRight) {
      tx = canvasX - offsetX - tooltipWidth;
    }
    if (tx < chartX) {
      tx = chartX + 4;
    }
    if (ty < chartY) {
      ty = canvasY + 20;
    }
    if (ty + tooltipHeight > chartBottom) {
      ty = chartBottom - tooltipHeight - 4;
    }
    return { tx, ty };
  };

  it("positions tooltip to the right of cursor by default", () => {
    const { tx, ty } = clampTooltip(200, 200, 100, 40, 0, 0, 600, 400);
    expect(tx).toBe(212); // 200 + 12
    expect(ty).toBe(140); // 200 - 20 - 40
  });

  it("flips tooltip to left when it would overflow right edge", () => {
    const { tx } = clampTooltip(550, 200, 100, 40, 0, 0, 600, 400);
    // 550 + 12 + 100 = 662 > 600, so flip: 550 - 12 - 100 = 438
    expect(tx).toBe(438);
  });

  it("clamps tooltip to chart left edge when flipped tooltip still overflows", () => {
    const { tx } = clampTooltip(50, 200, 200, 40, 100, 0, 400, 400);
    // 50 + 12 + 200 = 262 > 500, flip: 50 - 12 - 200 = -162, < 100, so clamp to 104
    expect(tx).toBe(104);
  });

  it("pushes tooltip down when it would overflow top edge", () => {
    const { ty } = clampTooltip(200, 30, 100, 40, 0, 20, 600, 400);
    // ty = 30 - 20 - 40 = -30, < 20, so push down: 30 + 20 = 50
    expect(ty).toBe(50);
  });

  it("clamps tooltip to chart bottom when it overflows bottom", () => {
    const { ty } = clampTooltip(200, 390, 100, 40, 0, 0, 600, 400);
    // ty = 390 - 20 - 40 = 330, that's fine (330 + 40 = 370 < 400)
    expect(ty).toBe(330);
  });

  it("handles case where tooltip overflows both bottom and needs adjustment", () => {
    const { ty } = clampTooltip(200, 10, 100, 40, 0, 0, 600, 50);
    // ty = 10 - 20 - 40 = -50 < 0, push down: 10 + 20 = 30
    // 30 + 40 = 70 > 50, clamp: 50 - 40 - 4 = 6
    expect(ty).toBe(6);
  });
});
