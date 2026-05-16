//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/cfInterceptorDeep.test.ts
// PURPOSE: Deep tests for CF interceptor: style stacking, priority ordering,
//          performance with many rules.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the cfStore module
vi.mock("../cfStore", () => ({
  getEvaluationForCell: vi.fn(),
}));

import { conditionalFormattingInterceptor } from "../cfInterceptor";
import { getEvaluationForCell } from "../cfStore";
import type { CellConditionalFormat } from "@api";

const mockGetEvaluation = vi.mocked(getEvaluationForCell);

function makeCF(
  overrides: Partial<CellConditionalFormat> = {}
): CellConditionalFormat {
  return {
    row: 0,
    col: 0,
    format: {},
    ...overrides,
  };
}

beforeEach(() => {
  mockGetEvaluation.mockReset();
});

// ============================================================================
// Style Stacking When Multiple Rules Match
// ============================================================================

describe("style stacking with multiple matching rules", () => {
  it("merges non-overlapping properties from multiple CFs", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { backgroundColor: "#FF0000" } }),
      makeCF({ format: { textColor: "#00FF00" } }),
      makeCF({ format: { bold: true } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result).not.toBeNull();
    expect(result!.backgroundColor).toBe("#FF0000");
    expect(result!.textColor).toBe("#00FF00");
    expect(result!.bold).toBe(true);
  });

  it("first CF wins for overlapping backgroundColor", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { backgroundColor: "#111111" } }),
      makeCF({ format: { backgroundColor: "#222222" } }),
      makeCF({ format: { backgroundColor: "#333333" } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.backgroundColor).toBe("#111111");
  });

  it("first CF wins for overlapping textColor", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { textColor: "#AAA" } }),
      makeCF({ format: { textColor: "#BBB" } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.textColor).toBe("#AAA");
  });

  it("colorScaleColor beats format.backgroundColor even in later CF", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ colorScaleColor: "#SCALE1" }),
      makeCF({ format: { backgroundColor: "#FORMAT1" } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.backgroundColor).toBe("#SCALE1");
  });

  it("format.backgroundColor from first CF beats colorScaleColor from second CF", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { backgroundColor: "#FORMAT1" } }),
      makeCF({ colorScaleColor: "#SCALE2" }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.backgroundColor).toBe("#FORMAT1");
  });

  it("stacks italic from second CF when first only sets bold", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { bold: true } }),
      makeCF({ format: { italic: true } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.bold).toBe(true);
    expect(result!.italic).toBe(true);
  });

  it("stacks underline and strikethrough from different CFs", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { underline: true } }),
      makeCF({ format: { strikethrough: true } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.underline).toBe(true);
    expect(result!.strikethrough).toBe(true);
  });

  it("stacks borders from different CFs", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { borderTopColor: "#AA0000" } }),
      makeCF({ format: { borderBottomColor: "#00AA00" } }),
      makeCF({ format: { borderLeftColor: "#0000AA", borderRightColor: "#AA00AA" } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.borderTopColor).toBe("#AA0000");
    expect(result!.borderBottomColor).toBe("#00AA00");
    expect(result!.borderLeftColor).toBe("#0000AA");
    expect(result!.borderRightColor).toBe("#AA00AA");
  });

  it("first CF border wins when multiple set same border", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { borderTopColor: "#FIRST", borderTopStyle: "dashed" } }),
      makeCF({ format: { borderTopColor: "#SECOND", borderTopStyle: "dotted" } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.borderTopColor).toBe("#FIRST");
    expect(result!.borderTopStyle).toBe("dashed");
  });
});

// ============================================================================
// Priority Ordering (Evaluation Order)
// ============================================================================

describe("priority ordering", () => {
  it("results array order determines priority (index 0 = highest)", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { backgroundColor: "#HIGH_PRIORITY" } }),
      makeCF({ format: { backgroundColor: "#LOW_PRIORITY" } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.backgroundColor).toBe("#HIGH_PRIORITY");
  });

  it("lower priority CF fills gaps left by higher priority CF", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { backgroundColor: "#BG1" } }),
      makeCF({ format: { backgroundColor: "#BG2", textColor: "#TXT2", bold: true } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.backgroundColor).toBe("#BG1"); // from first
    expect(result!.textColor).toBe("#TXT2"); // gap filled by second
    expect(result!.bold).toBe(true); // gap filled by second
  });

  it("single CF with all properties - nothing from later CFs", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({
        format: {
          backgroundColor: "#BG",
          textColor: "#TXT",
          bold: true,
          italic: true,
          underline: true,
          strikethrough: true,
        },
      }),
      makeCF({
        format: {
          backgroundColor: "#IGNORED",
          textColor: "#IGNORED",
          bold: false,
          italic: false,
          underline: false,
          strikethrough: false,
        },
      }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.backgroundColor).toBe("#BG");
    expect(result!.textColor).toBe("#TXT");
    expect(result!.bold).toBe(true);
    expect(result!.italic).toBe(true);
    expect(result!.underline).toBe(true);
    expect(result!.strikethrough).toBe(true);
  });
});

// ============================================================================
// Performance with Many Rules (50+)
// ============================================================================

describe("performance with many rules", () => {
  it("handles 50 CFs without error", () => {
    const cfs: CellConditionalFormat[] = [];
    for (let i = 0; i < 50; i++) {
      cfs.push(makeCF({ format: { bold: i === 0 ? true : undefined } }));
    }
    mockGetEvaluation.mockReturnValue(cfs);

    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result).not.toBeNull();
    expect(result!.bold).toBe(true);
  });

  it("handles 100 CFs efficiently", () => {
    const cfs: CellConditionalFormat[] = [];
    for (let i = 0; i < 100; i++) {
      cfs.push(
        makeCF({
          format: i === 99 ? { textColor: "#LAST" } : {},
        })
      );
    }
    mockGetEvaluation.mockReturnValue(cfs);

    const start = performance.now();
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    const elapsed = performance.now() - start;

    expect(result).not.toBeNull();
    expect(result!.textColor).toBe("#LAST");
    // Should complete in well under 50ms even with 100 CFs
    expect(elapsed).toBeLessThan(50);
  });

  it("first CF sets everything, remaining 99 are effectively skipped", () => {
    const cfs: CellConditionalFormat[] = [
      makeCF({
        format: {
          backgroundColor: "#BG",
          textColor: "#TXT",
          bold: true,
          italic: true,
          underline: true,
          strikethrough: true,
          borderTopColor: "#BT",
          borderBottomColor: "#BB",
          borderLeftColor: "#BL",
          borderRightColor: "#BR",
        },
      }),
    ];
    for (let i = 0; i < 99; i++) {
      cfs.push(makeCF({ format: { backgroundColor: "#IGNORED" } }));
    }
    mockGetEvaluation.mockReturnValue(cfs);

    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.backgroundColor).toBe("#BG");
  });

  it("each property filled by different CF among many", () => {
    const cfs: CellConditionalFormat[] = [];
    // 50 empty CFs, then specific properties scattered
    for (let i = 0; i < 50; i++) {
      cfs.push(makeCF({ format: {} }));
    }
    cfs.push(makeCF({ format: { backgroundColor: "#BG_51" } }));
    cfs.push(makeCF({ format: { textColor: "#TXT_52" } }));
    cfs.push(makeCF({ format: { bold: true } }));

    mockGetEvaluation.mockReturnValue(cfs);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result!.backgroundColor).toBe("#BG_51");
    expect(result!.textColor).toBe("#TXT_52");
    expect(result!.bold).toBe(true);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  it("CF with only colorScaleColor and no format properties", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ colorScaleColor: "#ABCDEF", format: {} }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result).not.toBeNull();
    expect(result!.backgroundColor).toBe("#ABCDEF");
  });

  it("CF with dataBarPercent does not affect style override", () => {
    // dataBarPercent is used for overlay rendering, not style
    mockGetEvaluation.mockReturnValue([
      makeCF({ dataBarPercent: 75, format: {} }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    // No style properties set, so null
    expect(result).toBeNull();
  });

  it("CF with iconIndex does not affect style override", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ iconIndex: 2, format: {} }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result).toBeNull();
  });

  it("multiple CFs: one with dataBar, one with format - format applies", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ dataBarPercent: 50, format: {} }),
      makeCF({ format: { textColor: "#FF0000" } }),
    ]);
    const result = conditionalFormattingInterceptor("x", { styleIndex: 0 }, { row: 0, col: 0 });
    expect(result).not.toBeNull();
    expect(result!.textColor).toBe("#FF0000");
  });
});
