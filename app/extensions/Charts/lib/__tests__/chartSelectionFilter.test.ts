//! FILENAME: app/extensions/Charts/lib/__tests__/chartSelectionFilter.test.ts
// PURPOSE: C5 S4 (selection-as-filter) + S7a (param-driven axis domains) pure
//          helpers: applySelectionKeep, selectionFilterCategories, and
//          applyAxisParamBindings.

import { describe, it, expect } from "vitest";
import { applySelectionKeep } from "../chartFilters";
import { selectionFilterCategories, applyAxisParamBindings } from "../chartParams";
import type { ChartSpec, ParsedChartData, ChartSelectionMap, AxisSpec, ParamSpec } from "../../types";
import type { FormulaValue } from "../chartFormula";

const data: ParsedChartData = {
  categories: ["Jan", "Feb", "Mar"],
  series: [
    { name: "A", values: [1, 2, 3], color: null },
    { name: "B", values: [10, 20, 30], color: null },
  ],
};

describe("applySelectionKeep (S4)", () => {
  it("keeps only the selected categories and aligns every series", () => {
    const out = applySelectionKeep(data, ["Mar", "Jan"]);
    expect(out.categories).toEqual(["Jan", "Mar"]); // preserves data order, not keep order
    expect(out.series[0].values).toEqual([1, 3]);
    expect(out.series[1].values).toEqual([10, 30]);
  });

  it("is a no-op for an empty or undefined keep set (full data)", () => {
    expect(applySelectionKeep(data, [])).toBe(data);
    expect(applySelectionKeep(data, undefined)).toBe(data);
  });

  it("returns the same object when nothing is dropped", () => {
    expect(applySelectionKeep(data, ["Jan", "Feb", "Mar", "Extra"])).toBe(data);
  });

  it("is a no-op (full data) when no kept label exists — never blanks the chart", () => {
    // Stale selection after an edit / a positionally-hidden category.
    expect(applySelectionKeep(data, ["Gone"])).toBe(data);
  });
});

function spec(params: ParamSpec[]): ChartSpec {
  return { params } as unknown as ChartSpec;
}

describe("selectionFilterCategories (S4)", () => {
  const sel: ChartSelectionMap = { picked: { on: "category", values: ["Feb"] } };

  it("returns the keep set only for select+filter+on:category params with a live selection", () => {
    expect(selectionFilterCategories(spec([{ name: "picked", select: "point", filter: true, on: "category" }]), sel)).toEqual(["Feb"]);
  });

  it("returns undefined when the param does not opt into filter", () => {
    expect(selectionFilterCategories(spec([{ name: "picked", select: "point", on: "category" }]), sel)).toBeUndefined();
  });

  it("returns undefined with no selection or no params", () => {
    expect(selectionFilterCategories(spec([{ name: "picked", select: "point", filter: true }]), undefined)).toBeUndefined();
    expect(selectionFilterCategories({} as ChartSpec, sel)).toBeUndefined();
  });

  it("ignores on:series filter params (v1 category-only)", () => {
    const seriesSel: ChartSelectionMap = { p: { on: "series", values: ["A"] } };
    expect(selectionFilterCategories(spec([{ name: "p", select: "point", filter: true, on: "series" }]), seriesSel)).toBeUndefined();
  });
});

describe("applyAxisParamBindings (S7a)", () => {
  const axis = (over: Partial<AxisSpec> = {}): AxisSpec => ({ title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null, ...over });
  const base = (over: Partial<ChartSpec> = {}): ChartSpec => ({ xAxis: axis(), yAxis: axis(), ...over } as unknown as ChartSpec);
  const params = (m: Record<string, FormulaValue>) => new Map(Object.entries(m));

  it("writes a resolved param value into the bound axis min/max", () => {
    const s = base({ yAxis: axis({ maxParam: "[Zoom]" }) });
    const out = applyAxisParamBindings(s, params({ Zoom: 100 }));
    expect(out.yAxis.max).toBe(100);
    expect(out).not.toBe(s);
  });

  it("accepts a bare name as well as [bracketed]", () => {
    const out = applyAxisParamBindings(base({ yAxis: axis({ minParam: "Lo" }) }), params({ Lo: 5 }));
    expect(out.yAxis.min).toBe(5);
  });

  it("falls back to the existing domain when the param is missing or non-numeric", () => {
    const s = base({ yAxis: axis({ min: 7, maxParam: "[Nope]" }) });
    const out = applyAxisParamBindings(s, params({ Other: 1 }));
    expect(out.yAxis.max).toBeNull();
    expect(out.yAxis.min).toBe(7);
    const s2 = base({ yAxis: axis({ maxParam: "[Txt]" }) });
    expect(applyAxisParamBindings(s2, params({ Txt: "abc" })).yAxis.max).toBeNull();
  });

  it("returns the same spec object when no axis binds a param", () => {
    const s = base();
    expect(applyAxisParamBindings(s, params({ Zoom: 1 }))).toBe(s);
  });
});
