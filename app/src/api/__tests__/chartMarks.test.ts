//! FILENAME: app/src/api/__tests__/chartMarks.test.ts
// PURPOSE: The public @api chart-mark registry (B9 slice 2) — the extension
//          point a third-party chart type registers through.

import { describe, it, expect } from "vitest";
import {
  registerChartMark,
  getChartMark,
  getChartMarkMeta,
  isChartMarkRegistered,
  listChartMarks,
  type ChartMarkDefinition,
} from "../chartMarks";

function fakeDef(label: string, layoutFamily: "cartesian" | "radial" | "other"): ChartMarkDefinition {
  return {
    meta: { label, layoutFamily },
    paint: () => {},
    computeLayout: () => ({}),
    computeGeometry: () => ({}),
  };
}

describe("@api chartMarks registry", () => {
  it("registers, looks up, and lists a mark by id", () => {
    expect(isChartMarkRegistered("__api_test__")).toBe(false);

    const def = fakeDef("API Test", "radial");
    registerChartMark("__api_test__", def);

    expect(isChartMarkRegistered("__api_test__")).toBe(true);
    expect(getChartMark("__api_test__")).toBe(def);
    expect(getChartMarkMeta("__api_test__")).toEqual({ label: "API Test", layoutFamily: "radial" });
    expect(listChartMarks()).toContain("__api_test__");
  });

  it("returns undefined for unregistered marks", () => {
    expect(getChartMark("__not_registered__")).toBeUndefined();
    expect(getChartMarkMeta("__not_registered__")).toBeUndefined();
    expect(isChartMarkRegistered("__not_registered__")).toBe(false);
  });

  it("override replaces an existing registration", () => {
    registerChartMark("__api_override__", fakeDef("First", "cartesian"));
    registerChartMark("__api_override__", fakeDef("Second", "other"));
    expect(getChartMarkMeta("__api_override__")?.label).toBe("Second");
  });
});
