//! FILENAME: app/extensions/Charts/lib/__tests__/lowerEncoding.test.ts
// PURPOSE: Tests for the encoding -> series-model compiler (C1).

import { describe, it, expect } from "vitest";
import { lowerEncoding } from "../lowerEncoding";
import type { ChartSpec, EncodingSpec } from "../../types";

function specWith(encoding: EncodingSpec | undefined, overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "line",
    data: "Sheet1!A1:C10",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    encoding,
    ...overrides,
  };
}

const headers = ["Date", "Region", "Sales"];

describe("lowerEncoding", () => {
  it("returns the spec unchanged when there is no encoding", () => {
    const spec = specWith(undefined);
    expect(lowerEncoding(spec, headers)).toBe(spec);
  });

  it("strips the encoding key from the lowered spec", () => {
    const lowered = lowerEncoding(specWith({ x: { field: "Date" }, y: { field: "Sales" } }), headers);
    expect(lowered.encoding).toBeUndefined();
  });

  it("compiles a single value series (x + y), resolving fields to indices", () => {
    const lowered = lowerEncoding(specWith({ x: { field: "Date" }, y: { field: "Sales" } }), headers);
    expect(lowered.categoryIndex).toBe(0); // "Date"
    expect(lowered.series).toEqual([{ name: "Sales", sourceIndex: 2, color: null }]);
    expect(lowered.transform).toBeUndefined();
  });

  it("compiles color into a pivot (one series per color value)", () => {
    const lowered = lowerEncoding(
      specWith({ x: { field: "Date" }, y: { field: "Sales", aggregate: "sum" }, color: { field: "Region" } }),
      headers,
    );
    expect(lowered.series).toEqual([]);
    expect(lowered.transform).toEqual([
      { type: "pivot", category: "Date", key: "Region", value: "Sales", op: "sum" },
    ]);
  });

  it("prepends the pivot before existing transforms", () => {
    const lowered = lowerEncoding(
      specWith(
        { x: { field: "Date" }, y: { field: "Sales" }, color: { field: "Region" } },
        { transform: [{ type: "sort", field: "Sales", order: "desc" }] },
      ),
      headers,
    );
    expect(lowered.transform?.[0]).toMatchObject({ type: "pivot" });
    expect(lowered.transform?.[1]).toMatchObject({ type: "sort" });
  });

  it("adds an aggregate transform for a single series with y.aggregate", () => {
    const lowered = lowerEncoding(specWith({ x: { field: "Date" }, y: { field: "Sales", aggregate: "mean" } }), headers);
    expect(lowered.transform).toEqual([
      { type: "aggregate", groupBy: ["$category"], op: "mean", field: "Sales", as: "Sales" },
    ]);
  });

  it("maps x.type temporal/quantitative and explicit scales to axis scales", () => {
    expect(lowerEncoding(specWith({ x: { field: "Date", type: "temporal" }, y: { field: "Sales" } }), headers).xAxis.scale)
      .toEqual({ type: "time" });
    expect(lowerEncoding(specWith({ x: { field: "Date", type: "quantitative" }, y: { field: "Sales" } }), headers).xAxis.scale)
      .toEqual({ type: "linear" });
    expect(lowerEncoding(specWith({ x: { field: "Date", scale: { type: "log" } }, y: { field: "Sales" } }), headers).xAxis.scale)
      .toEqual({ type: "log" });
  });

  it("maps channel titles to axis titles", () => {
    const lowered = lowerEncoding(specWith({ x: { field: "Date", title: "When" }, y: { field: "Sales", title: "Revenue" } }), headers);
    expect(lowered.xAxis.title).toBe("When");
    expect(lowered.yAxis.title).toBe("Revenue");
  });

  it("falls back to the existing categoryIndex/series when fields are unknown", () => {
    const base = specWith({ x: { field: "Missing" }, y: { field: "Nope" } }, { categoryIndex: 1, series: [{ name: "X", sourceIndex: 3, color: null }] });
    const lowered = lowerEncoding(base, headers);
    expect(lowered.categoryIndex).toBe(1);
    expect(lowered.series).toEqual([{ name: "X", sourceIndex: 3, color: null }]);
  });

  it("compiles the order channel into a sort transform (appended last)", () => {
    const lowered = lowerEncoding(specWith({ x: { field: "Date" }, y: { field: "Sales" }, order: { field: "Sales", sort: "desc" } }), headers);
    expect(lowered.transform).toEqual([
      { type: "sort", field: "Sales", order: "desc" },
    ]);
  });

  it("orders after an aggregate", () => {
    const lowered = lowerEncoding(specWith({ x: { field: "Date" }, y: { field: "Sales", aggregate: "sum" }, order: { field: "Sales" } }), headers);
    expect(lowered.transform).toEqual([
      { type: "aggregate", groupBy: ["$category"], op: "sum", field: "Sales", as: "Sales" },
      { type: "sort", field: "Sales", order: "asc" },
    ]);
  });

  it("compiles the size channel into a bubble with a size series", () => {
    const lowered = lowerEncoding(specWith({ x: { field: "Date" }, y: { field: "Sales" }, size: { field: "Region" } }), headers);
    expect(lowered.mark).toBe("bubble");
    expect(lowered.series).toEqual([
      { name: "Sales", sourceIndex: 2, color: null },
      { name: "Region", sourceIndex: 1, color: null },
    ]);
    expect((lowered.markOptions as { sizeSeriesIndex?: number })?.sizeSeriesIndex).toBe(1);
  });

  it("appends order after a color pivot", () => {
    const lowered = lowerEncoding(
      specWith({ x: { field: "Date" }, y: { field: "Sales" }, color: { field: "Region" }, order: { field: "$category" } }),
      headers,
    );
    expect(lowered.transform?.[0]).toMatchObject({ type: "pivot" });
    expect(lowered.transform?.[lowered.transform.length - 1]).toMatchObject({ type: "sort", field: "$category" });
  });
});
