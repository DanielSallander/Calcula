//! FILENAME: app/extensions/Charts/lib/__tests__/seriesEncodingResolve.test.ts
// PURPOSE: resolveSeriesEncoding (pre-existing bug fix) — name-based encoding
//          lookup so a hidden/reshaped series resolves the RIGHT encoding (the
//          old spec.series[filteredIndex] mis-aligned once a series was hidden).

import { describe, it, expect } from "vitest";
import { resolveSeriesEncoding } from "../encodingResolver";
import type { ChartSpec, SeriesEncoding } from "../../types";

const encA: SeriesEncoding = { color: "#aaa" };
const spec = {
  series: [
    { name: "A", sourceIndex: 1, color: null, encoding: encA },
    { name: "B", sourceIndex: 2, color: null }, // no encoding
    { name: "Dup", sourceIndex: 3, color: null, encoding: { color: "#first" } },
    { name: "Dup", sourceIndex: 4, color: null, encoding: { color: "#second" } },
  ],
} as unknown as ChartSpec;

describe("resolveSeriesEncoding", () => {
  it("resolves a series' encoding by name (survives a positional filter shift)", () => {
    expect(resolveSeriesEncoding(spec, "A")).toBe(encA);
  });

  it("returns undefined for a series without encoding", () => {
    expect(resolveSeriesEncoding(spec, "B")).toBeUndefined();
  });

  it("returns undefined for a name not in the spec (transform-created series)", () => {
    expect(resolveSeriesEncoding(spec, "Total")).toBeUndefined();
  });

  it("returns the first match for duplicate names (documented limitation)", () => {
    expect(resolveSeriesEncoding(spec, "Dup")).toEqual({ color: "#first" });
  });
});
