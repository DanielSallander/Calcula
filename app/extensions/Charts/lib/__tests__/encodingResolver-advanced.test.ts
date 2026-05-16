//! FILENAME: app/extensions/Charts/lib/__tests__/encodingResolver-advanced.test.ts
// PURPOSE: Advanced edge-case tests for conditional encoding resolution.

import { describe, it, expect } from "vitest";
import {
  resolveConditional,
  resolvePointColor,
  resolvePointOpacity,
  resolvePointSize,
} from "../encodingResolver";
import { PALETTES } from "../../rendering/chartTheme";
import type { SeriesEncoding, ConditionalValue, ValueCondition } from "../../types";

// ============================================================================
// Helper to build conditional encodings concisely
// ============================================================================

function cond<T>(condition: ValueCondition, value: T, otherwise: T): ConditionalValue<T> {
  return { condition, value, otherwise };
}

// ============================================================================
// Every operator with $category field
// ============================================================================

describe("resolveConditional — category field with every operator", () => {
  it("gt on category field: non-numeric category returns otherwise", () => {
    const enc = cond({ field: "category", gt: 5 }, "yes", "no");
    // "Jan" is not a number, parseFloat("Jan") => NaN => false
    expect(resolveConditional(enc, 100, "Jan")).toBe("no");
  });

  it("gt on category field: numeric category string is compared", () => {
    const enc = cond({ field: "category", gt: 5 }, "yes", "no");
    expect(resolveConditional(enc, 0, "10")).toBe("yes");
    expect(resolveConditional(enc, 0, "3")).toBe("no");
  });

  it("lt on category field with numeric string", () => {
    const enc = cond({ field: "category", lt: 50 }, "small", "big");
    expect(resolveConditional(enc, 0, "25")).toBe("small");
    expect(resolveConditional(enc, 0, "75")).toBe("big");
  });

  it("gte on category field boundary", () => {
    const enc = cond({ field: "category", gte: 100 }, "high", "low");
    expect(resolveConditional(enc, 0, "100")).toBe("high");
    expect(resolveConditional(enc, 0, "99")).toBe("low");
  });

  it("lte on category field boundary", () => {
    const enc = cond({ field: "category", lte: 0 }, "zero-or-neg", "pos");
    expect(resolveConditional(enc, 0, "0")).toBe("zero-or-neg");
    expect(resolveConditional(enc, 0, "-5")).toBe("zero-or-neg");
    expect(resolveConditional(enc, 0, "1")).toBe("pos");
  });

  it("oneOf on category field with string values", () => {
    const enc = cond({ field: "category", oneOf: ["Q1", "Q3"] }, "selected", "other");
    expect(resolveConditional(enc, 0, "Q1")).toBe("selected");
    expect(resolveConditional(enc, 0, "Q2")).toBe("other");
    expect(resolveConditional(enc, 0, "Q3")).toBe("selected");
  });

  it("oneOf on category field with mixed string/number values", () => {
    const enc = cond({ field: "category", oneOf: [2024, "Special"] }, "match", "none");
    expect(resolveConditional(enc, 0, "Special")).toBe("match");
    expect(resolveConditional(enc, 0, "Other")).toBe("none");
  });
});

// ============================================================================
// Multiple conditions chained (fallthrough simulation)
// ============================================================================

describe("resolveConditional — chained conditions (manual fallthrough)", () => {
  /**
   * Simulate cascading conditionals: if first doesn't match, evaluate second.
   * This is the pattern users would use to achieve multi-level conditions.
   */
  function resolveChained<T>(
    encodings: ConditionalValue<T>[],
    fallback: T,
    value: number,
    category: string,
  ): T {
    for (const enc of encodings) {
      const result = resolveConditional(enc, value, category);
      // If it's a conditional and returned 'otherwise', try next
      if (typeof enc === "object" && enc !== null && "condition" in enc) {
        const condObj = enc as { condition: ValueCondition; value: T; otherwise: T };
        if (result !== condObj.otherwise) return result;
      } else {
        return result; // static value always matches
      }
    }
    return fallback;
  }

  it("first condition matches, second is skipped", () => {
    const chain: ConditionalValue<string>[] = [
      cond({ field: "value", gt: 100 }, "high", "__skip__"),
      cond({ field: "value", lt: 0 }, "negative", "__skip__"),
    ];
    expect(resolveChained(chain, "normal", 150, "Jan")).toBe("high");
  });

  it("first doesn't match, second matches", () => {
    const chain: ConditionalValue<string>[] = [
      cond({ field: "value", gt: 100 }, "high", "__skip__"),
      cond({ field: "value", lt: 0 }, "negative", "__skip__"),
    ];
    expect(resolveChained(chain, "normal", -5, "Jan")).toBe("negative");
  });

  it("neither matches, fallback used", () => {
    const chain: ConditionalValue<string>[] = [
      cond({ field: "value", gt: 100 }, "high", "__skip__"),
      cond({ field: "value", lt: 0 }, "negative", "__skip__"),
    ];
    expect(resolveChained(chain, "normal", 50, "Jan")).toBe("normal");
  });
});

// ============================================================================
// Undefined/null values at every level
// ============================================================================

describe("resolvePointColor — undefined/null edge cases", () => {
  it("undefined encoding + null series override = palette color", () => {
    const result = resolvePointColor(undefined, "default", 2, null, 0, "");
    expect(result).toBe(PALETTES.default[2 % PALETTES.default.length]);
  });

  it("encoding with no color field = falls back to series override", () => {
    const encoding: SeriesEncoding = { opacity: 0.5 };
    const result = resolvePointColor(encoding, "default", 0, "#OVERRIDE", 0, "");
    expect(result).toBe("#OVERRIDE");
  });

  it("encoding with no color field + no series override = palette", () => {
    const encoding: SeriesEncoding = { size: 10 };
    const result = resolvePointColor(encoding, "default", 0, null, 0, "");
    expect(result).toBe(PALETTES.default[0]);
  });

  it("empty encoding object = palette fallback", () => {
    const encoding: SeriesEncoding = {};
    const result = resolvePointColor(encoding, "default", 0, null, 100, "Jan");
    expect(result).toBe(PALETTES.default[0]);
  });
});

describe("resolvePointOpacity — undefined/null edge cases", () => {
  it("empty encoding object returns undefined", () => {
    expect(resolvePointOpacity({}, 100, "Jan")).toBeUndefined();
  });

  it("encoding with only color returns undefined for opacity", () => {
    expect(resolvePointOpacity({ color: "#FF0000" }, 100, "Jan")).toBeUndefined();
  });
});

describe("resolvePointSize — undefined/null edge cases", () => {
  it("empty encoding object returns undefined", () => {
    expect(resolvePointSize({}, 100, "Jan")).toBeUndefined();
  });

  it("encoding with only opacity returns undefined for size", () => {
    expect(resolvePointSize({ opacity: 0.5 }, 100, "Jan")).toBeUndefined();
  });
});

// ============================================================================
// Priority: explicit override > conditional > palette cycling
// ============================================================================

describe("encoding priority order", () => {
  it("encoding color beats series color override", () => {
    const encoding: SeriesEncoding = { color: "#ENCODED" };
    expect(resolvePointColor(encoding, "default", 0, "#SERIES_OVERRIDE", 50, "Jan"))
      .toBe("#ENCODED");
  });

  it("conditional encoding color beats series color override", () => {
    const encoding: SeriesEncoding = {
      color: cond({ field: "value", gt: 0 }, "#COND_TRUE", "#COND_FALSE"),
    };
    expect(resolvePointColor(encoding, "default", 0, "#SERIES_OVERRIDE", 50, "Jan"))
      .toBe("#COND_TRUE");
  });

  it("series color override beats palette", () => {
    expect(resolvePointColor(undefined, "default", 0, "#MY_COLOR", 50, "Jan"))
      .toBe("#MY_COLOR");
  });

  it("palette is the final fallback", () => {
    expect(resolvePointColor(undefined, "default", 0, null, 50, "Jan"))
      .toBe(PALETTES.default[0]);
  });

  it("palette cycles for high series indices", () => {
    const paletteLen = PALETTES.default.length;
    const result = resolvePointColor(undefined, "default", paletteLen + 2, null, 50, "Jan");
    expect(result).toBe(PALETTES.default[2 % paletteLen]);
  });
});

// ============================================================================
// Opacity encoding with boundary values
// ============================================================================

describe("opacity boundary values", () => {
  it("opacity = 0 (fully transparent)", () => {
    expect(resolvePointOpacity({ opacity: 0 }, 100, "Jan")).toBe(0);
  });

  it("opacity = 0.5 (half transparent)", () => {
    expect(resolvePointOpacity({ opacity: 0.5 }, 100, "Jan")).toBe(0.5);
  });

  it("opacity = 1.0 (fully opaque)", () => {
    expect(resolvePointOpacity({ opacity: 1.0 }, 100, "Jan")).toBe(1.0);
  });

  it("conditional opacity resolving to 0", () => {
    const encoding: SeriesEncoding = {
      opacity: cond({ field: "value", lt: 10 }, 0, 1.0),
    };
    expect(resolvePointOpacity(encoding, 5, "Jan")).toBe(0);
    expect(resolvePointOpacity(encoding, 50, "Jan")).toBe(1.0);
  });
});

// ============================================================================
// Size encoding with edge values
// ============================================================================

describe("size encoding edge values", () => {
  it("size = 0", () => {
    expect(resolvePointSize({ size: 0 }, 100, "Jan")).toBe(0);
  });

  it("size with negative value (unconventional but allowed by type)", () => {
    expect(resolvePointSize({ size: -5 }, 100, "Jan")).toBe(-5);
  });

  it("very large size value", () => {
    expect(resolvePointSize({ size: 999999 }, 100, "Jan")).toBe(999999);
  });

  it("conditional size resolving to zero for low values", () => {
    const encoding: SeriesEncoding = {
      size: cond({ field: "value", lte: 0 }, 0, 10),
    };
    expect(resolvePointSize(encoding, 0, "Jan")).toBe(0);
    expect(resolvePointSize(encoding, -1, "Jan")).toBe(0);
    expect(resolvePointSize(encoding, 5, "Jan")).toBe(10);
  });
});

// ============================================================================
// Mixed encoding types (color conditional + opacity static + size conditional)
// ============================================================================

describe("mixed encoding types on a single series", () => {
  const encoding: SeriesEncoding = {
    color: cond({ field: "value", gt: 50 }, "#00FF00", "#FF0000"),
    opacity: 0.8,
    size: cond({ field: "category", oneOf: ["Jan", "Jul"] }, 20, 8),
  };

  it("high value + highlighted category", () => {
    expect(resolvePointColor(encoding, "default", 0, null, 100, "Jan")).toBe("#00FF00");
    expect(resolvePointOpacity(encoding, 100, "Jan")).toBe(0.8);
    expect(resolvePointSize(encoding, 100, "Jan")).toBe(20);
  });

  it("low value + non-highlighted category", () => {
    expect(resolvePointColor(encoding, "default", 0, null, 10, "Mar")).toBe("#FF0000");
    expect(resolvePointOpacity(encoding, 10, "Mar")).toBe(0.8);
    expect(resolvePointSize(encoding, 10, "Mar")).toBe(8);
  });

  it("high value + non-highlighted category", () => {
    expect(resolvePointColor(encoding, "default", 0, null, 80, "Mar")).toBe("#00FF00");
    expect(resolvePointOpacity(encoding, 80, "Mar")).toBe(0.8);
    expect(resolvePointSize(encoding, 80, "Mar")).toBe(8);
  });

  it("low value + highlighted category", () => {
    expect(resolvePointColor(encoding, "default", 0, null, 20, "Jul")).toBe("#FF0000");
    expect(resolvePointOpacity(encoding, 20, "Jul")).toBe(0.8);
    expect(resolvePointSize(encoding, 20, "Jul")).toBe(20);
  });
});

// ============================================================================
// Condition edge: value exactly at boundary
// ============================================================================

describe("resolveConditional — exact boundary values", () => {
  it("gt: value exactly equal does NOT match", () => {
    expect(resolveConditional(cond({ field: "value", gt: 50 }, "y", "n"), 50, "")).toBe("n");
  });

  it("lt: value exactly equal does NOT match", () => {
    expect(resolveConditional(cond({ field: "value", lt: 50 }, "y", "n"), 50, "")).toBe("n");
  });

  it("gte: value exactly equal DOES match", () => {
    expect(resolveConditional(cond({ field: "value", gte: 50 }, "y", "n"), 50, "")).toBe("y");
  });

  it("lte: value exactly equal DOES match", () => {
    expect(resolveConditional(cond({ field: "value", lte: 50 }, "y", "n"), 50, "")).toBe("y");
  });

  it("combined gte + lte range: both boundaries inclusive", () => {
    const enc = cond({ field: "value", gte: 10, lte: 20 }, "in", "out");
    expect(resolveConditional(enc, 10, "")).toBe("in");
    expect(resolveConditional(enc, 20, "")).toBe("in");
    expect(resolveConditional(enc, 15, "")).toBe("in");
    expect(resolveConditional(enc, 9, "")).toBe("out");
    expect(resolveConditional(enc, 21, "")).toBe("out");
  });

  it("NaN value fails all numeric comparisons", () => {
    const enc = cond({ field: "value", gt: 0 }, "y", "n");
    expect(resolveConditional(enc, NaN, "Jan")).toBe("n");
  });

  it("negative zero treated as zero", () => {
    const enc = cond({ field: "value", gte: 0 }, "y", "n");
    expect(resolveConditional(enc, -0, "")).toBe("y");
  });
});
