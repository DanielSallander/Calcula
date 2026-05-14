//! FILENAME: app/extensions/Charts/lib/__tests__/encodingResolver.test.ts
// PURPOSE: Tests for conditional encoding resolution (color, opacity, size per data point).

import { describe, it, expect } from "vitest";
import {
  resolveConditional,
  resolvePointColor,
  resolvePointOpacity,
  resolvePointSize,
} from "../encodingResolver";
import { PALETTES } from "../../rendering/chartTheme";
import type { SeriesEncoding } from "../../types";

// ============================================================================
// resolveConditional
// ============================================================================

describe("resolveConditional", () => {
  it("returns static value directly (string)", () => {
    expect(resolveConditional("#FF0000", 50, "Jan")).toBe("#FF0000");
  });

  it("returns static value directly (number)", () => {
    expect(resolveConditional(0.8, 50, "Jan")).toBe(0.8);
  });

  it("returns condition value when condition is met (gt)", () => {
    const encoding = {
      condition: { field: "value" as const, gt: 100 },
      value: "#00FF00",
      otherwise: "#FF0000",
    };
    expect(resolveConditional(encoding, 150, "Jan")).toBe("#00FF00");
  });

  it("returns otherwise when condition is not met (gt)", () => {
    const encoding = {
      condition: { field: "value" as const, gt: 100 },
      value: "#00FF00",
      otherwise: "#FF0000",
    };
    expect(resolveConditional(encoding, 50, "Jan")).toBe("#FF0000");
  });

  it("evaluates lt condition", () => {
    const encoding = {
      condition: { field: "value" as const, lt: 50 },
      value: "small",
      otherwise: "big",
    };
    expect(resolveConditional(encoding, 30, "Jan")).toBe("small");
    expect(resolveConditional(encoding, 80, "Jan")).toBe("big");
  });

  it("evaluates gte condition", () => {
    const encoding = {
      condition: { field: "value" as const, gte: 100 },
      value: "high",
      otherwise: "low",
    };
    expect(resolveConditional(encoding, 100, "Jan")).toBe("high");
    expect(resolveConditional(encoding, 99, "Jan")).toBe("low");
  });

  it("evaluates lte condition", () => {
    const encoding = {
      condition: { field: "value" as const, lte: 100 },
      value: "low",
      otherwise: "high",
    };
    expect(resolveConditional(encoding, 100, "Jan")).toBe("low");
    expect(resolveConditional(encoding, 101, "Jan")).toBe("high");
  });

  it("evaluates oneOf condition with value field", () => {
    const encoding = {
      condition: { field: "value" as const, oneOf: [10, 20, 30] },
      value: "match",
      otherwise: "no-match",
    };
    expect(resolveConditional(encoding, 20, "Jan")).toBe("match");
    expect(resolveConditional(encoding, 25, "Jan")).toBe("no-match");
  });

  it("evaluates oneOf condition with category field", () => {
    const encoding = {
      condition: { field: "category" as const, oneOf: ["Jan", "Feb"] },
      value: "#00FF00",
      otherwise: "#999999",
    };
    expect(resolveConditional(encoding, 100, "Jan")).toBe("#00FF00");
    expect(resolveConditional(encoding, 100, "Mar")).toBe("#999999");
  });

  it("combines gt and lt conditions (range check)", () => {
    const encoding = {
      condition: { field: "value" as const, gt: 10, lt: 50 },
      value: "in-range",
      otherwise: "out-of-range",
    };
    expect(resolveConditional(encoding, 25, "Jan")).toBe("in-range");
    expect(resolveConditional(encoding, 5, "Jan")).toBe("out-of-range");
    expect(resolveConditional(encoding, 60, "Jan")).toBe("out-of-range");
  });
});

// ============================================================================
// resolvePointColor
// ============================================================================

describe("resolvePointColor", () => {
  it("returns palette color when no encoding", () => {
    const result = resolvePointColor(undefined, "default", 0, null, 100, "Jan");
    expect(result).toBe(PALETTES.default[0]);
  });

  it("returns series color override when set", () => {
    const result = resolvePointColor(undefined, "default", 0, "#CUSTOM", 100, "Jan");
    expect(result).toBe("#CUSTOM");
  });

  it("returns encoding color when set (static)", () => {
    const encoding: SeriesEncoding = { color: "#AABBCC" };
    const result = resolvePointColor(encoding, "default", 0, null, 100, "Jan");
    expect(result).toBe("#AABBCC");
  });

  it("returns conditional encoding color when condition is met", () => {
    const encoding: SeriesEncoding = {
      color: {
        condition: { field: "value", gt: 50 },
        value: "#00FF00",
        otherwise: "#FF0000",
      },
    };
    expect(resolvePointColor(encoding, "default", 0, null, 100, "Jan")).toBe("#00FF00");
    expect(resolvePointColor(encoding, "default", 0, null, 30, "Jan")).toBe("#FF0000");
  });

  it("encoding takes priority over series color override", () => {
    const encoding: SeriesEncoding = { color: "#ENCODED" };
    const result = resolvePointColor(encoding, "default", 0, "#OVERRIDE", 100, "Jan");
    expect(result).toBe("#ENCODED");
  });
});

// ============================================================================
// resolvePointOpacity
// ============================================================================

describe("resolvePointOpacity", () => {
  it("returns undefined when no encoding", () => {
    expect(resolvePointOpacity(undefined, 100, "Jan")).toBeUndefined();
  });

  it("returns undefined when encoding has no opacity", () => {
    const encoding: SeriesEncoding = { color: "#FF0000" };
    expect(resolvePointOpacity(encoding, 100, "Jan")).toBeUndefined();
  });

  it("returns static opacity value", () => {
    const encoding: SeriesEncoding = { opacity: 0.5 };
    expect(resolvePointOpacity(encoding, 100, "Jan")).toBe(0.5);
  });

  it("returns conditional opacity", () => {
    const encoding: SeriesEncoding = {
      opacity: {
        condition: { field: "value", gt: 50 },
        value: 1.0,
        otherwise: 0.3,
      },
    };
    expect(resolvePointOpacity(encoding, 100, "Jan")).toBe(1.0);
    expect(resolvePointOpacity(encoding, 20, "Jan")).toBe(0.3);
  });
});

// ============================================================================
// resolvePointSize
// ============================================================================

describe("resolvePointSize", () => {
  it("returns undefined when no encoding", () => {
    expect(resolvePointSize(undefined, 100, "Jan")).toBeUndefined();
  });

  it("returns undefined when encoding has no size", () => {
    const encoding: SeriesEncoding = { color: "#FF0000" };
    expect(resolvePointSize(encoding, 100, "Jan")).toBeUndefined();
  });

  it("returns static size value", () => {
    const encoding: SeriesEncoding = { size: 12 };
    expect(resolvePointSize(encoding, 100, "Jan")).toBe(12);
  });

  it("returns conditional size", () => {
    const encoding: SeriesEncoding = {
      size: {
        condition: { field: "category", oneOf: ["Jan", "Feb"] },
        value: 20,
        otherwise: 8,
      },
    };
    expect(resolvePointSize(encoding, 100, "Jan")).toBe(20);
    expect(resolvePointSize(encoding, 100, "Mar")).toBe(8);
  });
});
