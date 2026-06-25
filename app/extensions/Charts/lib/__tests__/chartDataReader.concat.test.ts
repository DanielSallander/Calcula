//! FILENAME: app/extensions/Charts/lib/__tests__/chartDataReader.concat.test.ts
// PURPOSE: Unit tests for the concat fan-out (assembleConcat) and the
//          hasRenderableData guard helper. assembleConcat takes an injected
//          child reader, so it is tested without any grid IO.

import { describe, it, expect } from "vitest";
import { assembleConcat, MAX_CONCAT_PANELS } from "../chartDataReader";
import { hasRenderableData } from "../../types";
import type { ChartSpec, ParsedChartData, TransformDiagnostic } from "../../types";

function child(title: string): ChartSpec {
  return { title } as ChartSpec;
}
function dataFor(title: string): ParsedChartData {
  return { categories: [title], series: [{ name: title, values: [1], color: null }] };
}
const okReader = (c: ChartSpec) =>
  Promise.resolve({ spec: c, data: dataFor(c.title ?? ""), diagnostics: [] as TransformDiagnostic[] });

describe("assembleConcat", () => {
  it("reads one panel per child, preserving each child's spec + data", async () => {
    const panels = await assembleConcat([child("A"), child("B")], okReader, []);
    expect(panels.map((p) => p.spec.title)).toEqual(["A", "B"]);
    expect(panels[0].data.categories).toEqual(["A"]);
    expect(panels[1].data.categories).toEqual(["B"]);
  });

  it("aggregates child diagnostics onto the shared sink", async () => {
    const diags: TransformDiagnostic[] = [];
    const reader = (c: ChartSpec) =>
      Promise.resolve({
        spec: c,
        data: dataFor(c.title ?? ""),
        diagnostics: [{ index: 0, transformType: "filter", severity: "warning", message: `d:${c.title}` } as TransformDiagnostic],
      });
    await assembleConcat([child("A"), child("B")], reader, diags);
    expect(diags.map((d) => d.message)).toEqual(["d:A", "d:B"]);
  });

  it("caps panels at MAX_CONCAT_PANELS", async () => {
    const many = Array.from({ length: MAX_CONCAT_PANELS + 5 }, (_, i) => child(`C${i}`));
    const panels = await assembleConcat(many, okReader, []);
    expect(panels).toHaveLength(MAX_CONCAT_PANELS);
  });

  it("drops a failing child but keeps the rest (one bad panel can't blank the dashboard)", async () => {
    const reader = (c: ChartSpec) => (c.title === "BAD" ? Promise.reject(new Error("bad range")) : okReader(c));
    const panels = await assembleConcat([child("A"), child("BAD"), child("B")], reader, []);
    expect(panels.map((p) => p.spec.title)).toEqual(["A", "B"]);
  });

  it("returns [] (no throw) when every child fails", async () => {
    const reader = () => Promise.reject(new Error("nope"));
    await expect(assembleConcat([child("A"), child("B")], reader, [])).resolves.toEqual([]);
  });
});

describe("hasRenderableData", () => {
  it("is false for null and empty series", () => {
    expect(hasRenderableData(null)).toBe(false);
    expect(hasRenderableData(undefined)).toBe(false);
    expect(hasRenderableData({ categories: [], series: [] })).toBe(false);
  });

  it("is true for direct series or composition panels (concat/facet)", () => {
    expect(hasRenderableData({ categories: ["a"], series: [{ name: "s", values: [1], color: null }] })).toBe(true);
    expect(hasRenderableData({ categories: [], series: [], concat: [{ spec: child("A"), data: dataFor("A") }] })).toBe(true);
    expect(hasRenderableData({ categories: [], series: [], facets: [{ value: "f", data: dataFor("A") }] })).toBe(true);
  });
});
