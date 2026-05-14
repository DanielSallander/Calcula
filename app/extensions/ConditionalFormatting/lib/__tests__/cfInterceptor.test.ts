//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/cfInterceptor.test.ts
// PURPOSE: Tests for the conditional formatting style interceptor.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the cfStore module
vi.mock("../cfStore", () => ({
  getEvaluationForCell: vi.fn(),
}));

import { conditionalFormattingInterceptor } from "../cfInterceptor";
import { getEvaluationForCell } from "../cfStore";
import type { CellConditionalFormat } from "@api";

const mockGetEvaluation = vi.mocked(getEvaluationForCell);

// ============================================================================
// Helpers
// ============================================================================

function makeCF(
  overrides: Partial<CellConditionalFormat> = {},
): CellConditionalFormat {
  return {
    row: 0,
    col: 0,
    format: {},
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  mockGetEvaluation.mockReset();
});

describe("conditionalFormattingInterceptor", () => {
  it("returns null when no evaluation results exist", () => {
    mockGetEvaluation.mockReturnValue(null);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result).toBeNull();
  });

  it("returns null when evaluation results are empty", () => {
    mockGetEvaluation.mockReturnValue([]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result).toBeNull();
  });

  it("applies backgroundColor from format", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { backgroundColor: "#FF0000" } }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 1, col: 2 },
    );
    expect(result).not.toBeNull();
    expect(result!.backgroundColor).toBe("#FF0000");
  });

  it("applies textColor from format", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { textColor: "#00FF00" } }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result).not.toBeNull();
    expect(result!.textColor).toBe("#00FF00");
  });

  it("applies bold from format", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { bold: true } }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result).not.toBeNull();
    expect(result!.bold).toBe(true);
  });

  it("applies italic from format", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { italic: true } }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result!.italic).toBe(true);
  });

  it("applies underline from format", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { underline: true } }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result!.underline).toBe(true);
  });

  it("applies strikethrough from format", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { strikethrough: true } }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result!.strikethrough).toBe(true);
  });

  it("applies colorScaleColor as backgroundColor (takes priority over format bg)", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({
        colorScaleColor: "#AABBCC",
        format: { backgroundColor: "#FF0000" },
      }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result!.backgroundColor).toBe("#AABBCC");
  });

  it("first match wins for each property across multiple CFs", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { backgroundColor: "#111111", textColor: "#222222" } }),
      makeCF({ format: { backgroundColor: "#333333", textColor: "#444444", bold: true } }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result!.backgroundColor).toBe("#111111");
    expect(result!.textColor).toBe("#222222");
    // bold is only set in the second CF, so it comes from there
    expect(result!.bold).toBe(true);
  });

  it("applies border properties with default solid style", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({
        format: {
          borderTopColor: "#FF0000",
          borderBottomColor: "#00FF00",
          borderLeftColor: "#0000FF",
          borderRightColor: "#FF00FF",
        },
      }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result!.borderTopColor).toBe("#FF0000");
    expect(result!.borderTopStyle).toBe("solid");
    expect(result!.borderBottomColor).toBe("#00FF00");
    expect(result!.borderBottomStyle).toBe("solid");
    expect(result!.borderLeftColor).toBe("#0000FF");
    expect(result!.borderLeftStyle).toBe("solid");
    expect(result!.borderRightColor).toBe("#FF00FF");
    expect(result!.borderRightStyle).toBe("solid");
  });

  it("applies border properties with explicit style", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({
        format: {
          borderTopColor: "#FF0000",
          borderTopStyle: "dashed",
        },
      }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result!.borderTopColor).toBe("#FF0000");
    expect(result!.borderTopStyle).toBe("dashed");
  });

  it("returns null when format has no applicable properties", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: {} }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result).toBeNull();
  });

  it("combines multiple style properties from a single CF", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({
        format: {
          backgroundColor: "#FFC7CE",
          textColor: "#9C0006",
          bold: true,
          italic: false,
        },
      }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result!.backgroundColor).toBe("#FFC7CE");
    expect(result!.textColor).toBe("#9C0006");
    expect(result!.bold).toBe(true);
    expect(result!.italic).toBe(false);
  });

  it("does not override backgroundColor if colorScaleColor is set first and format bg comes second", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ colorScaleColor: "#AABBCC" }),
      makeCF({ format: { backgroundColor: "#FF0000" } }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    // colorScaleColor from first CF sets backgroundColor, second CF's bg is ignored
    expect(result!.backgroundColor).toBe("#AABBCC");
  });

  it("calls getEvaluationForCell with correct coordinates", () => {
    mockGetEvaluation.mockReturnValue(null);
    conditionalFormattingInterceptor(
      "value",
      { styleIndex: 5 },
      { row: 10, col: 20 },
    );
    expect(mockGetEvaluation).toHaveBeenCalledWith(10, 20);
  });

  it("handles bold=false override correctly", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { bold: false } }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result).not.toBeNull();
    expect(result!.bold).toBe(false);
  });

  it("first CF sets bold=false, second CF bold=true - first wins", () => {
    mockGetEvaluation.mockReturnValue([
      makeCF({ format: { bold: false } }),
      makeCF({ format: { bold: true } }),
    ]);
    const result = conditionalFormattingInterceptor(
      "test",
      { styleIndex: 0 },
      { row: 0, col: 0 },
    );
    expect(result!.bold).toBe(false);
  });
});
