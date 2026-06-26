//! FILENAME: app/src/api/__tests__/chartTransforms.test.ts
// PURPOSE: The public @api custom-transform registry — the extension point a
//          third-party chart data transform registers through (symmetric to the
//          chart-mark registry).

import { describe, it, expect } from "vitest";
import {
  registerChartTransform,
  unregisterChartTransform,
  getChartTransform,
  isChartTransformRegistered,
  listChartTransforms,
  isBuiltinTransformType,
  type ChartTransformDefinition,
} from "../chartTransforms";

const def = (): ChartTransformDefinition => ({ apply: (d) => d });

describe("@api chartTransforms registry", () => {
  it("registers, looks up, lists, and unregisters a custom transform", () => {
    expect(isChartTransformRegistered("__t_test__")).toBe(false);
    const d = def();
    registerChartTransform("__t_test__", d);
    expect(isChartTransformRegistered("__t_test__")).toBe(true);
    expect(getChartTransform("__t_test__")).toBe(d);
    expect(listChartTransforms()).toContain("__t_test__");

    unregisterChartTransform("__t_test__");
    expect(isChartTransformRegistered("__t_test__")).toBe(false);
    expect(getChartTransform("__t_test__")).toBeUndefined();
    // no-op for an unknown id
    expect(() => unregisterChartTransform("__never__")).not.toThrow();
  });

  it("refuses to register a built-in transform type", () => {
    for (const t of ["filter", "sort", "aggregate", "calculate", "window", "bin", "lookup", "pivot"]) {
      expect(() => registerChartTransform(t, def())).toThrow(/built-in/);
      expect(isChartTransformRegistered(t)).toBe(false);
    }
  });

  it("isBuiltinTransformType identifies the eight built-ins", () => {
    expect(isBuiltinTransformType("filter")).toBe(true);
    expect(isBuiltinTransformType("pivot")).toBe(true);
    expect(isBuiltinTransformType("myCustom")).toBe(false);
  });
});
