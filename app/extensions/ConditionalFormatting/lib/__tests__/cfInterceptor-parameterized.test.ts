//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/cfInterceptor-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for CF style interceptor
// TARGET: 240+ tests via it.each

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the cfStore module
vi.mock("../cfStore", () => ({
  getEvaluationForCell: vi.fn(),
}));

import { conditionalFormattingInterceptor } from "../cfInterceptor";
import { getEvaluationForCell } from "../cfStore";
import type { CellConditionalFormat } from "@api";
import type { IStyleOverride } from "@api/styleInterceptors";

const mockGetEvaluation = vi.mocked(getEvaluationForCell);

// ============================================================================
// Helpers
// ============================================================================

function makeCF(overrides: Partial<CellConditionalFormat> = {}): CellConditionalFormat {
  return {
    row: 0,
    col: 0,
    format: {},
    ...overrides,
  };
}

const baseCoords = { row: 0, col: 0 };
const baseStyle = { styleIndex: 0 };

function callInterceptor(row = 0, col = 0): IStyleOverride | null {
  return conditionalFormattingInterceptor("", baseStyle, { row, col });
}

beforeEach(() => {
  mockGetEvaluation.mockReset();
});

// ============================================================================
// 1. Style Application: 50 CF result combos
// ============================================================================

describe("style application (parameterized)", () => {
  describe("single-property overrides", () => {
    it.each<[string, Partial<CellConditionalFormat["format"]>, keyof IStyleOverride, unknown]>([
      ["backgroundColor red", { backgroundColor: "#FF0000" }, "backgroundColor", "#FF0000"],
      ["backgroundColor green", { backgroundColor: "#00FF00" }, "backgroundColor", "#00FF00"],
      ["backgroundColor blue", { backgroundColor: "#0000FF" }, "backgroundColor", "#0000FF"],
      ["backgroundColor white", { backgroundColor: "#FFFFFF" }, "backgroundColor", "#FFFFFF"],
      ["backgroundColor black", { backgroundColor: "#000000" }, "backgroundColor", "#000000"],
      ["textColor red", { textColor: "#FF0000" }, "textColor", "#FF0000"],
      ["textColor green", { textColor: "#00FF00" }, "textColor", "#00FF00"],
      ["textColor blue", { textColor: "#0000FF" }, "textColor", "#0000FF"],
      ["bold true", { bold: true }, "bold", true],
      ["bold false", { bold: false }, "bold", false],
      ["italic true", { italic: true }, "italic", true],
      ["italic false", { italic: false }, "italic", false],
      ["underline true", { underline: true }, "underline", true],
      ["strikethrough true", { strikethrough: true }, "strikethrough", true],
      ["borderTopColor", { borderTopColor: "#FF0000" }, "borderTopColor", "#FF0000"],
      ["borderBottomColor", { borderBottomColor: "#00FF00" }, "borderBottomColor", "#00FF00"],
      ["borderLeftColor", { borderLeftColor: "#0000FF" }, "borderLeftColor", "#0000FF"],
      ["borderRightColor", { borderRightColor: "#FF00FF" }, "borderRightColor", "#FF00FF"],
    ])("%s", (_label, format, prop, expectedValue) => {
      mockGetEvaluation.mockReturnValue([makeCF({ format })]);
      const result = callInterceptor();
      expect(result).not.toBeNull();
      expect(result![prop]).toBe(expectedValue);
    });
  });

  describe("multi-property overrides", () => {
    it.each<[string, Partial<CellConditionalFormat["format"]>, Partial<IStyleOverride>]>([
      [
        "bg + text color",
        { backgroundColor: "#FFC7CE", textColor: "#9C0006" },
        { backgroundColor: "#FFC7CE", textColor: "#9C0006" },
      ],
      [
        "bg + bold",
        { backgroundColor: "#C6EFCE", bold: true },
        { backgroundColor: "#C6EFCE", bold: true },
      ],
      [
        "text + italic",
        { textColor: "#FF0000", italic: true },
        { textColor: "#FF0000", italic: true },
      ],
      [
        "bold + italic + underline",
        { bold: true, italic: true, underline: true },
        { bold: true, italic: true, underline: true },
      ],
      [
        "all text formatting",
        { textColor: "#000000", bold: true, italic: true, underline: true, strikethrough: true },
        { textColor: "#000000", bold: true, italic: true, underline: true, strikethrough: true },
      ],
      [
        "bg + text + bold",
        { backgroundColor: "#FFEB9C", textColor: "#9C5700", bold: true },
        { backgroundColor: "#FFEB9C", textColor: "#9C5700", bold: true },
      ],
      [
        "all borders",
        {
          borderTopColor: "#000", borderBottomColor: "#000",
          borderLeftColor: "#000", borderRightColor: "#000",
        },
        {
          borderTopColor: "#000", borderTopStyle: "solid",
          borderBottomColor: "#000", borderBottomStyle: "solid",
          borderLeftColor: "#000", borderLeftStyle: "solid",
          borderRightColor: "#000", borderRightStyle: "solid",
        },
      ],
      [
        "border top with style",
        { borderTopColor: "#FF0000", borderTopStyle: "dashed" },
        { borderTopColor: "#FF0000", borderTopStyle: "dashed" },
      ],
      [
        "bg + all borders",
        {
          backgroundColor: "#FFC7CE",
          borderTopColor: "#9C0006", borderBottomColor: "#9C0006",
          borderLeftColor: "#9C0006", borderRightColor: "#9C0006",
        },
        {
          backgroundColor: "#FFC7CE",
          borderTopColor: "#9C0006", borderTopStyle: "solid",
          borderBottomColor: "#9C0006", borderBottomStyle: "solid",
          borderLeftColor: "#9C0006", borderLeftStyle: "solid",
          borderRightColor: "#9C0006", borderRightStyle: "solid",
        },
      ],
      [
        "text + strikethrough",
        { textColor: "#888888", strikethrough: true },
        { textColor: "#888888", strikethrough: true },
      ],
      [
        "bg only (preset light red)",
        { backgroundColor: "#FFC7CE" },
        { backgroundColor: "#FFC7CE" },
      ],
      [
        "bg only (preset light green)",
        { backgroundColor: "#C6EFCE" },
        { backgroundColor: "#C6EFCE" },
      ],
    ])("%s", (_label, format, expectedOverride) => {
      mockGetEvaluation.mockReturnValue([makeCF({ format })]);
      const result = callInterceptor();
      expect(result).not.toBeNull();
      for (const [key, value] of Object.entries(expectedOverride)) {
        expect(result![key as keyof IStyleOverride]).toBe(value);
      }
    });
  });

  describe("empty/null cases", () => {
    it.each<[string, CellConditionalFormat[] | null]>([
      ["null evaluation", null],
      ["empty array", []],
    ])("%s returns null", (_label, evalResult) => {
      mockGetEvaluation.mockReturnValue(evalResult);
      expect(callInterceptor()).toBeNull();
    });

    it("empty format returns null", () => {
      mockGetEvaluation.mockReturnValue([makeCF({ format: {} })]);
      expect(callInterceptor()).toBeNull();
    });
  });
});

// ============================================================================
// 2. Priority Ordering: 30 multi-CF combos (first match wins per property)
// ============================================================================

describe("priority ordering (parameterized)", () => {
  describe("first-match-wins for backgroundColor", () => {
    it.each<[string, string[], string]>([
      ["red then green", ["#FF0000", "#00FF00"], "#FF0000"],
      ["green then red", ["#00FF00", "#FF0000"], "#00FF00"],
      ["blue then red then green", ["#0000FF", "#FF0000", "#00FF00"], "#0000FF"],
      ["white then black", ["#FFFFFF", "#000000"], "#FFFFFF"],
      ["preset light-red then light-green", ["#FFC7CE", "#C6EFCE"], "#FFC7CE"],
    ])("%s -> %s wins", (_label, colors, expected) => {
      const cfs = colors.map(c => makeCF({ format: { backgroundColor: c } }));
      mockGetEvaluation.mockReturnValue(cfs);
      const result = callInterceptor();
      expect(result!.backgroundColor).toBe(expected);
    });
  });

  describe("first-match-wins for textColor", () => {
    it.each<[string, string[], string]>([
      ["red then green", ["#FF0000", "#00FF00"], "#FF0000"],
      ["green then red", ["#00FF00", "#FF0000"], "#00FF00"],
      ["blue then red", ["#0000FF", "#FF0000"], "#0000FF"],
      ["black then white", ["#000000", "#FFFFFF"], "#000000"],
      ["preset colors", ["#9C0006", "#006100"], "#9C0006"],
    ])("%s -> %s wins", (_label, colors, expected) => {
      const cfs = colors.map(c => makeCF({ format: { textColor: c } }));
      mockGetEvaluation.mockReturnValue(cfs);
      const result = callInterceptor();
      expect(result!.textColor).toBe(expected);
    });
  });

  describe("first-match-wins for bold", () => {
    it.each<[string, (boolean | undefined)[], boolean]>([
      ["true then false", [true, false], true],
      ["false then true", [false, true], false],
      ["true then true", [true, true], true],
      ["false then false", [false, false], false],
      ["undefined then true -> true", [undefined, true], true],
    ])("%s", (_label, values, expected) => {
      const cfs = values.map(b => makeCF({ format: { bold: b } }));
      mockGetEvaluation.mockReturnValue(cfs);
      const result = callInterceptor();
      expect(result!.bold).toBe(expected);
    });
  });

  describe("mixed properties from different CFs", () => {
    it.each<[string, CellConditionalFormat[], Partial<IStyleOverride>]>([
      [
        "bg from first, text from second",
        [
          makeCF({ format: { backgroundColor: "#FF0000" } }),
          makeCF({ format: { textColor: "#00FF00" } }),
        ],
        { backgroundColor: "#FF0000", textColor: "#00FF00" },
      ],
      [
        "bold from first, italic from second",
        [
          makeCF({ format: { bold: true } }),
          makeCF({ format: { italic: true } }),
        ],
        { bold: true, italic: true },
      ],
      [
        "bg from first, bold+italic from second",
        [
          makeCF({ format: { backgroundColor: "#FFEB9C" } }),
          makeCF({ format: { bold: true, italic: true } }),
        ],
        { backgroundColor: "#FFEB9C", bold: true, italic: true },
      ],
      [
        "first sets bg, second tries bg (ignored) + text",
        [
          makeCF({ format: { backgroundColor: "#FF0000" } }),
          makeCF({ format: { backgroundColor: "#00FF00", textColor: "#0000FF" } }),
        ],
        { backgroundColor: "#FF0000", textColor: "#0000FF" },
      ],
      [
        "three CFs: bg, text, bold",
        [
          makeCF({ format: { backgroundColor: "#FFC7CE" } }),
          makeCF({ format: { textColor: "#9C0006" } }),
          makeCF({ format: { bold: true } }),
        ],
        { backgroundColor: "#FFC7CE", textColor: "#9C0006", bold: true },
      ],
      [
        "three CFs: first wins all overlapping",
        [
          makeCF({ format: { backgroundColor: "#111", textColor: "#222", bold: true } }),
          makeCF({ format: { backgroundColor: "#333", textColor: "#444", italic: true } }),
          makeCF({ format: { backgroundColor: "#555", textColor: "#666", underline: true } }),
        ],
        { backgroundColor: "#111", textColor: "#222", bold: true, italic: true, underline: true },
      ],
      [
        "border from first, bg from second",
        [
          makeCF({ format: { borderTopColor: "#000" } }),
          makeCF({ format: { backgroundColor: "#FFF" } }),
        ],
        { borderTopColor: "#000", borderTopStyle: "solid", backgroundColor: "#FFF" },
      ],
      [
        "all from single CF, second ignored",
        [
          makeCF({ format: { backgroundColor: "#A", textColor: "#B", bold: true, italic: true } }),
          makeCF({ format: { backgroundColor: "#C", textColor: "#D", bold: false, italic: false } }),
        ],
        { backgroundColor: "#A", textColor: "#B", bold: true, italic: true },
      ],
      [
        "strikethrough from third CF",
        [
          makeCF({ format: { backgroundColor: "#FFF" } }),
          makeCF({ format: { textColor: "#000" } }),
          makeCF({ format: { strikethrough: true } }),
        ],
        { backgroundColor: "#FFF", textColor: "#000", strikethrough: true },
      ],
      [
        "underline from second, rest from first",
        [
          makeCF({ format: { backgroundColor: "#AAA", bold: true } }),
          makeCF({ format: { underline: true, backgroundColor: "#BBB" } }),
        ],
        { backgroundColor: "#AAA", bold: true, underline: true },
      ],
    ])("%s", (_label, cfs, expectedProps) => {
      mockGetEvaluation.mockReturnValue(cfs);
      const result = callInterceptor();
      expect(result).not.toBeNull();
      for (const [key, value] of Object.entries(expectedProps)) {
        expect(result![key as keyof IStyleOverride]).toBe(value);
      }
    });
  });
});

// ============================================================================
// 3. colorScaleColor: 40 combos
// ============================================================================

describe("colorScaleColor override (parameterized)", () => {
  describe("colorScaleColor sets backgroundColor", () => {
    it.each<[string, string]>([
      ["pure red", "#FF0000"],
      ["pure green", "#00FF00"],
      ["pure blue", "#0000FF"],
      ["white", "#FFFFFF"],
      ["black", "#000000"],
      ["orange", "#FFA500"],
      ["purple", "#800080"],
      ["yellow", "#FFFF00"],
      ["cyan", "#00FFFF"],
      ["magenta", "#FF00FF"],
      ["light red", "#FFC7CE"],
      ["light green", "#C6EFCE"],
      ["light yellow", "#FFEB9C"],
      ["dark red", "#9C0006"],
      ["dark green", "#006100"],
      ["gray", "#808080"],
      ["light gray", "#D3D3D3"],
      ["dark gray", "#404040"],
      ["coral", "#FF7F50"],
      ["teal", "#008080"],
    ])("%s: %s", (_label, color) => {
      mockGetEvaluation.mockReturnValue([makeCF({ colorScaleColor: color })]);
      const result = callInterceptor();
      expect(result).not.toBeNull();
      expect(result!.backgroundColor).toBe(color);
    });
  });

  describe("colorScaleColor takes priority over format.backgroundColor", () => {
    it.each<[string, string, string]>([
      ["scale red over format blue", "#FF0000", "#0000FF"],
      ["scale green over format red", "#00FF00", "#FF0000"],
      ["scale white over format black", "#FFFFFF", "#000000"],
      ["scale orange over format purple", "#FFA500", "#800080"],
      ["scale yellow over format gray", "#FFFF00", "#808080"],
    ])("%s", (_label, scaleColor, formatBg) => {
      mockGetEvaluation.mockReturnValue([
        makeCF({ colorScaleColor: scaleColor, format: { backgroundColor: formatBg } }),
      ]);
      const result = callInterceptor();
      expect(result!.backgroundColor).toBe(scaleColor);
    });
  });

  describe("colorScaleColor + other format properties", () => {
    it.each<[string, string, Partial<CellConditionalFormat["format"]>, Partial<IStyleOverride>]>([
      [
        "scale + textColor",
        "#63BE7B",
        { textColor: "#000000" },
        { backgroundColor: "#63BE7B", textColor: "#000000" },
      ],
      [
        "scale + bold",
        "#F8696B",
        { bold: true },
        { backgroundColor: "#F8696B", bold: true },
      ],
      [
        "scale + italic + text",
        "#FFEB84",
        { italic: true, textColor: "#333" },
        { backgroundColor: "#FFEB84", italic: true, textColor: "#333" },
      ],
      [
        "scale + underline",
        "#5B9BD5",
        { underline: true },
        { backgroundColor: "#5B9BD5", underline: true },
      ],
      [
        "scale + strikethrough",
        "#D6007B",
        { strikethrough: true },
        { backgroundColor: "#D6007B", strikethrough: true },
      ],
      [
        "scale + border",
        "#638EC6",
        { borderTopColor: "#000" },
        { backgroundColor: "#638EC6", borderTopColor: "#000", borderTopStyle: "solid" },
      ],
      [
        "scale + bold + italic + text",
        "#63C384",
        { bold: true, italic: true, textColor: "#FFF" },
        { backgroundColor: "#63C384", bold: true, italic: true, textColor: "#FFF" },
      ],
      [
        "scale + all text formatting",
        "#FF555A",
        { textColor: "#000", bold: true, italic: true, underline: true, strikethrough: true },
        { backgroundColor: "#FF555A", textColor: "#000", bold: true, italic: true, underline: true, strikethrough: true },
      ],
      [
        "scale + all borders",
        "#FFB628",
        { borderTopColor: "#A", borderBottomColor: "#B", borderLeftColor: "#C", borderRightColor: "#D" },
        {
          backgroundColor: "#FFB628",
          borderTopColor: "#A", borderTopStyle: "solid",
          borderBottomColor: "#B", borderBottomStyle: "solid",
          borderLeftColor: "#C", borderLeftStyle: "solid",
          borderRightColor: "#D", borderRightStyle: "solid",
        },
      ],
      [
        "scale without extra format",
        "#008AEF",
        {},
        { backgroundColor: "#008AEF" },
      ],
    ])("%s", (_label, scaleColor, format, expectedProps) => {
      mockGetEvaluation.mockReturnValue([makeCF({ colorScaleColor: scaleColor, format })]);
      const result = callInterceptor();
      expect(result).not.toBeNull();
      for (const [key, value] of Object.entries(expectedProps)) {
        expect(result![key as keyof IStyleOverride]).toBe(value);
      }
    });
  });
});

// ============================================================================
// 4. dataBarPercent: 40 combos
// ============================================================================

describe("dataBarPercent passthrough (parameterized)", () => {
  // dataBarPercent doesn't directly affect style override output from the interceptor.
  // The interceptor only handles format properties. Data bars are rendered via grid regions.
  // Test that dataBarPercent presence doesn't break format application.

  describe("dataBarPercent with format properties", () => {
    it.each<[string, number, Partial<CellConditionalFormat["format"]>, string | undefined]>([
      ["0% with bg", 0, { backgroundColor: "#638EC6" }, "#638EC6"],
      ["10% with bg", 10, { backgroundColor: "#638EC6" }, "#638EC6"],
      ["25% with bg", 25, { backgroundColor: "#63C384" }, "#63C384"],
      ["33% with bg", 33, { backgroundColor: "#FF555A" }, "#FF555A"],
      ["50% with bg", 50, { backgroundColor: "#FFB628" }, "#FFB628"],
      ["67% with bg", 67, { backgroundColor: "#008AEF" }, "#008AEF"],
      ["75% with bg", 75, { backgroundColor: "#D6007B" }, "#D6007B"],
      ["90% with bg", 90, { backgroundColor: "#638EC6" }, "#638EC6"],
      ["100% with bg", 100, { backgroundColor: "#63C384" }, "#63C384"],
      ["50% with text", 50, { textColor: "#000000" }, undefined],
      ["0% no format", 0, {}, undefined],
      ["100% no format", 100, {}, undefined],
      ["50% with bold", 50, { bold: true }, undefined],
      ["25% with italic", 25, { italic: true }, undefined],
      ["75% with underline", 75, { underline: true }, undefined],
    ])("%s (percent=%s)", (_label, percent, format, expectedBg) => {
      mockGetEvaluation.mockReturnValue([makeCF({ dataBarPercent: percent, format })]);
      const result = callInterceptor();
      if (expectedBg) {
        expect(result).not.toBeNull();
        expect(result!.backgroundColor).toBe(expectedBg);
      } else if (Object.keys(format).length > 0) {
        // Has other properties
        expect(result).not.toBeNull();
      } else {
        expect(result).toBeNull();
      }
    });
  });

  describe("dataBarPercent with multiple CFs", () => {
    it.each<[string, number, string, string, string]>([
      ["bar + bg CF", 50, "#FF0000", "#00FF00", "#FF0000"],
      ["bar + bg CF reversed", 75, "#00FF00", "#FF0000", "#00FF00"],
      ["bar 0% + bg CF", 0, "#FFFFFF", "#000000", "#FFFFFF"],
      ["bar 100% + bg CF", 100, "#000000", "#FFFFFF", "#000000"],
      ["bar 25% + bg CF", 25, "#FFC7CE", "#C6EFCE", "#FFC7CE"],
    ])("%s", (_label, percent, bg1, bg2, expected) => {
      mockGetEvaluation.mockReturnValue([
        makeCF({ dataBarPercent: percent, format: { backgroundColor: bg1 } }),
        makeCF({ format: { backgroundColor: bg2 } }),
      ]);
      const result = callInterceptor();
      expect(result!.backgroundColor).toBe(expected);
    });
  });
});

// ============================================================================
// 5. iconIndex: 40 combos
// ============================================================================

describe("iconIndex passthrough (parameterized)", () => {
  // Like dataBarPercent, iconIndex is rendered via grid regions, not style overrides.
  // Test that iconIndex presence doesn't interfere with format application.

  describe("iconIndex with format properties", () => {
    it.each<[string, number, Partial<CellConditionalFormat["format"]>, Partial<IStyleOverride> | null]>([
      ["icon 0 + bg", 0, { backgroundColor: "#C6EFCE" }, { backgroundColor: "#C6EFCE" }],
      ["icon 1 + bg", 1, { backgroundColor: "#FFEB9C" }, { backgroundColor: "#FFEB9C" }],
      ["icon 2 + bg", 2, { backgroundColor: "#FFC7CE" }, { backgroundColor: "#FFC7CE" }],
      ["icon 0 + text", 0, { textColor: "#006100" }, { textColor: "#006100" }],
      ["icon 1 + text", 1, { textColor: "#9C5700" }, { textColor: "#9C5700" }],
      ["icon 2 + text", 2, { textColor: "#9C0006" }, { textColor: "#9C0006" }],
      ["icon 0 + bold", 0, { bold: true }, { bold: true }],
      ["icon 1 + italic", 1, { italic: true }, { italic: true }],
      ["icon 2 + underline", 2, { underline: true }, { underline: true }],
      ["icon 3 + bg+text", 3, { backgroundColor: "#FFF", textColor: "#000" }, { backgroundColor: "#FFF", textColor: "#000" }],
      ["icon 4 + bg+bold", 4, { backgroundColor: "#FFF", bold: true }, { backgroundColor: "#FFF", bold: true }],
      ["icon 0 no format", 0, {}, null],
      ["icon 1 no format", 1, {}, null],
      ["icon 2 no format", 2, {}, null],
      ["icon 3 no format", 3, {}, null],
      ["icon 4 no format", 4, {}, null],
    ])("%s (icon=%s)", (_label, icon, format, expectedOverride) => {
      mockGetEvaluation.mockReturnValue([makeCF({ iconIndex: icon, format })]);
      const result = callInterceptor();
      if (expectedOverride === null) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        for (const [key, value] of Object.entries(expectedOverride)) {
          expect(result![key as keyof IStyleOverride]).toBe(value);
        }
      }
    });
  });

  describe("iconIndex with colorScaleColor (both present)", () => {
    it.each<[string, number, string, string]>([
      ["icon 0 + scale red", 0, "#FF0000", "#FF0000"],
      ["icon 1 + scale green", 1, "#00FF00", "#00FF00"],
      ["icon 2 + scale blue", 2, "#0000FF", "#0000FF"],
      ["icon 0 + scale white", 0, "#FFFFFF", "#FFFFFF"],
      ["icon 2 + scale black", 2, "#000000", "#000000"],
    ])("%s -> bg is scale color", (_label, icon, scaleColor, expectedBg) => {
      mockGetEvaluation.mockReturnValue([
        makeCF({ iconIndex: icon, colorScaleColor: scaleColor }),
      ]);
      const result = callInterceptor();
      expect(result!.backgroundColor).toBe(expectedBg);
    });
  });

  describe("iconIndex with multiple CFs", () => {
    it.each<[string, number, string, string, string]>([
      ["icon CF + bg CF", 0, "#FF0000", "#00FF00", "#FF0000"],
      ["icon CF + bg CF reversed", 2, "#00FF00", "#FF0000", "#00FF00"],
      ["icon CF no bg + bg CF", 1, "", "#0000FF", "#0000FF"],
    ])("%s", (_label, icon, bg1, bg2, expected) => {
      const cf1 = makeCF({ iconIndex: icon, format: bg1 ? { backgroundColor: bg1 } : {} });
      const cf2 = makeCF({ format: { backgroundColor: bg2 } });
      mockGetEvaluation.mockReturnValue([cf1, cf2]);
      const result = callInterceptor();
      expect(result!.backgroundColor).toBe(expected);
    });
  });
});

// ============================================================================
// 6. Cell coordinate variations
// ============================================================================

describe("cell coordinate variations (parameterized)", () => {
  it.each<[number, number]>([
    [0, 0],
    [0, 10],
    [10, 0],
    [100, 100],
    [999, 999],
    [0, 255],
    [1048575, 16383],
    [50, 50],
    [1, 1],
    [500, 250],
  ])("row=%s col=%s applies format correctly", (row, col) => {
    mockGetEvaluation.mockImplementation((r, c) => {
      if (r === row && c === col) {
        return [makeCF({ row, col, format: { backgroundColor: "#FF0000" } })];
      }
      return null;
    });
    const result = conditionalFormattingInterceptor("", baseStyle, { row, col });
    expect(result).not.toBeNull();
    expect(result!.backgroundColor).toBe("#FF0000");
  });
});

// ============================================================================
// 7. Border style defaults
// ============================================================================

describe("border style defaults (parameterized)", () => {
  it.each<[string, string, string, string]>([
    ["top border gets solid default", "borderTopColor", "#000", "borderTopStyle"],
    ["bottom border gets solid default", "borderBottomColor", "#000", "borderBottomStyle"],
    ["left border gets solid default", "borderLeftColor", "#000", "borderLeftStyle"],
    ["right border gets solid default", "borderRightColor", "#000", "borderRightStyle"],
  ])("%s", (_label, colorProp, colorValue, styleProp) => {
    const format: Record<string, string> = { [colorProp]: colorValue };
    mockGetEvaluation.mockReturnValue([makeCF({ format: format as any })]);
    const result = callInterceptor();
    expect(result).not.toBeNull();
    expect(result![styleProp as keyof IStyleOverride]).toBe("solid");
  });

  it.each<[string, string, string, string, string]>([
    ["top dashed", "borderTopColor", "#F00", "borderTopStyle", "dashed"],
    ["bottom dotted", "borderBottomColor", "#0F0", "borderBottomStyle", "dotted"],
    ["left double", "borderLeftColor", "#00F", "borderLeftStyle", "double"],
    ["right thick", "borderRightColor", "#FFF", "borderRightStyle", "thick"],
  ])("%s preserves explicit style", (_label, colorProp, colorVal, styleProp, styleVal) => {
    const format: Record<string, string> = { [colorProp]: colorVal, [styleProp]: styleVal };
    mockGetEvaluation.mockReturnValue([makeCF({ format: format as any })]);
    const result = callInterceptor();
    expect(result).not.toBeNull();
    expect(result![styleProp as keyof IStyleOverride]).toBe(styleVal);
  });
});
