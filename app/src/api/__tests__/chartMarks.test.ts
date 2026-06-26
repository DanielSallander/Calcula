//! FILENAME: app/src/api/__tests__/chartMarks.test.ts
// PURPOSE: The public @api chart-mark registry (B9 slice 2) — the extension
//          point a third-party chart type registers through.

import { describe, it, expect } from "vitest";
import {
  registerChartMark,
  unregisterChartMark,
  getChartMark,
  getChartMarkMeta,
  isChartMarkRegistered,
  listChartMarks,
  type ChartMarkDefinition,
  type ChartMarkMeta,
} from "../chartMarks";

function fakeDef(label: string, layoutFamily: "cartesian" | "radial" | "other", extra?: Partial<ChartMarkMeta>): ChartMarkDefinition {
  return {
    meta: { label, layoutFamily, ...extra },
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

  it("override replaces an existing (non-built-in) registration", () => {
    registerChartMark("__api_override__", fakeDef("First", "cartesian"));
    registerChartMark("__api_override__", fakeDef("Second", "other"));
    expect(getChartMarkMeta("__api_override__")?.label).toBe("Second");
  });

  it("unregisterChartMark removes a (non-built-in) mark", () => {
    registerChartMark("__api_remove__", fakeDef("Removable", "cartesian"));
    expect(isChartMarkRegistered("__api_remove__")).toBe(true);
    unregisterChartMark("__api_remove__");
    expect(isChartMarkRegistered("__api_remove__")).toBe(false);
    expect(getChartMark("__api_remove__")).toBeUndefined();
    // no-op for an unknown id (must not throw)
    expect(() => unregisterChartMark("__never_existed__")).not.toThrow();
  });

  it("refuses to OVERWRITE a built-in mark (no shadowing bar/pie/etc.)", () => {
    registerChartMark("__api_builtin__", fakeDef("Builtin", "cartesian", { builtin: true }));
    expect(() => registerChartMark("__api_builtin__", fakeDef("Evil", "cartesian"))).toThrow(/built-in/);
    expect(getChartMarkMeta("__api_builtin__")?.label).toBe("Builtin");
  });

  it("refuses to UNREGISTER a built-in mark", () => {
    registerChartMark("__api_builtin2__", fakeDef("Builtin2", "cartesian", { builtin: true }));
    unregisterChartMark("__api_builtin2__");
    expect(isChartMarkRegistered("__api_builtin2__")).toBe(true);
  });
});
