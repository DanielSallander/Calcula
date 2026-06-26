//! FILENAME: app/extensions/Charts/lib/__tests__/chartTransformRegistry.test.ts
// PURPOSE: The transform pipeline dispatches an UNKNOWN transform type to the
//          @api custom-transform registry: a registered transform runs (and its
//          output flows on), an unregistered one warns, and a throwing / invalid-
//          returning one degrades to a diagnostic + the input data (never crashes).

import { describe, it, expect, afterEach } from "vitest";
import { applyTransforms } from "../chartTransforms";
import { registerChartTransform, unregisterChartTransform } from "@api/chartTransforms";
import type { ParsedChartData, TransformDiagnostic } from "../../types";

const baseData = (): ParsedChartData => ({
  categories: ["a", "b"],
  series: [{ name: "S", values: [1, 2], color: null }],
});

// applyTransforms is typed TransformSpec[]; custom transform objects are valid at
// runtime (the dispatch default routes them to the registry) — cast for the test.
const custom = (type: string, extra: Record<string, unknown> = {}): never =>
  ({ type, ...extra } as never);

afterEach(() => {
  for (const t of ["t:double", "t:throws", "t:bad", "t:params"]) unregisterChartTransform(t);
});

describe("custom transform dispatch (registry)", () => {
  it("runs a registered custom transform and flows its output on", () => {
    registerChartTransform("t:double", {
      apply: (data) => {
        const d = data as ParsedChartData;
        return { ...d, series: d.series.map((s) => ({ ...s, values: s.values.map((v) => v * 2) })) };
      },
    });
    const out = applyTransforms(baseData(), [custom("t:double")]);
    expect(out.series[0].values).toEqual([2, 4]);
  });

  it("warns (and leaves data unchanged) for an unregistered transform type", () => {
    const diags: TransformDiagnostic[] = [];
    const out = applyTransforms(baseData(), [custom("t:unregistered")], diags);
    expect(out.series[0].values).toEqual([1, 2]);
    expect(diags.some((d) => d.severity === "warning" && d.message.includes("Unknown transform"))).toBe(true);
  });

  it("degrades to a diagnostic + input data when a custom transform throws", () => {
    registerChartTransform("t:throws", { apply: () => { throw new Error("boom"); } });
    const diags: TransformDiagnostic[] = [];
    const out = applyTransforms(baseData(), [custom("t:throws")], diags);
    expect(out.series[0].values).toEqual([1, 2]); // unchanged
    expect(diags.some((d) => d.severity === "error" && d.message.includes("boom"))).toBe(true);
  });

  it("degrades when a custom transform returns a non-ParsedChartData value", () => {
    registerChartTransform("t:bad", { apply: () => ({ nope: true }) as unknown as ParsedChartData });
    const diags: TransformDiagnostic[] = [];
    const out = applyTransforms(baseData(), [custom("t:bad")], diags);
    expect(out.series[0].values).toEqual([1, 2]); // unchanged
    expect(diags.some((d) => d.severity === "error" && d.message.includes("invalid chart data"))).toBe(true);
  });

  it("rejects a series array whose elements lack values[] (would crash a downstream step)", () => {
    // arrays present but a series item is missing `values` — the shallow guard
    // used to accept this, then the NEXT transform's s.values.filter threw OUTSIDE
    // the try/catch. The deep guard rejects it -> input data, no crash.
    registerChartTransform("t:bad", {
      apply: () => ({ categories: ["a", "b"], series: [{ name: "x" }] }) as unknown as ParsedChartData,
    });
    const diags: TransformDiagnostic[] = [];
    const out = applyTransforms(baseData(), [custom("t:bad"), { type: "sort", field: "S", order: "asc" }], diags);
    expect(out.series[0].values).toEqual([1, 2]); // unchanged; pipeline did not crash
    expect(diags.some((d) => d.severity === "error" && d.message.includes("invalid chart data"))).toBe(true);
  });

  it("passes resolved params through to the custom transform context", () => {
    let seen: unknown;
    registerChartTransform("t:params", {
      apply: (data, _spec, ctx) => { seen = ctx.params?.get("Threshold"); return data as ParsedChartData; },
    });
    applyTransforms(baseData(), [custom("t:params")], undefined, undefined, undefined, new Map([["Threshold", 42]]));
    expect(seen).toBe(42);
  });

  it("a custom type does NOT short-circuit built-in transforms in the same pipeline", () => {
    registerChartTransform("t:double", {
      apply: (data) => {
        const d = data as ParsedChartData;
        return { ...d, series: d.series.map((s) => ({ ...s, values: s.values.map((v) => v * 2) })) };
      },
    });
    // sort desc by S, then double: built-in + custom compose in order.
    const out = applyTransforms(baseData(), [
      { type: "sort", field: "S", order: "desc" },
      custom("t:double"),
    ]);
    expect(out.categories).toEqual(["b", "a"]);
    expect(out.series[0].values).toEqual([4, 2]);
  });
});
