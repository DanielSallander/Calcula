//! FILENAME: app/extensions/Charts/lib/__tests__/datumStyleResolver.test.ts
// PURPOSE: Pin resolveDatumStyle — the ONE path from a painted datum to its
//          per-point formatting — and in particular key-then-index matching.
// CONTEXT: An index pair is not an identity. Insert a row into the plotted
//          range and every category index below it shifts by one, so an
//          override written for "Mar" silently reappears on "Apr". Calcula had
//          already solved the FILTER half (toAuthoringIndices maps painter
//          space to authoring space); this closes the DATA half. The index
//          stays as the fallback so specs written before `key` keep working.

import { describe, it, expect } from "vitest";
import {
  resolveDatumStyle,
  resolveDatumOverride,
  buildOverrideIndex,
  dataPointKey,
  dataPointKeyForDatum,
} from "../dataPointOverrides";
import { INVERTED_FILL_COLOR } from "../../types";
import type { ChartSpec, ParsedChartData, DataPointOverride } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeSpec(overrides: DataPointOverride[] | undefined): ChartSpec {
  return {
    mark: "bar",
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Revenue", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    dataPointOverrides: overrides,
  };
}

/** One series ("Revenue") over the given category labels. */
function makeData(categories: string[], values?: number[], extra: Partial<ParsedChartData> = {}): ParsedChartData {
  return {
    categories,
    series: [{ name: "Revenue", values: values ?? categories.map((_, i) => i + 1), color: null }],
    ...extra,
  };
}

const BASE = { fill: "#4E79A7" };

// ============================================================================
// Keys
// ============================================================================

describe("dataPointKey", () => {
  it("joins the series name and the category label with a unit separator", () => {
    expect(dataPointKey("Revenue", "Mar")).toBe("RevenueMar");
  });

  it("cannot be forged by a label containing ordinary punctuation", () => {
    // "A" + "B,C" and "A,B" + "C" would collide under a comma separator.
    expect(dataPointKey("A", "B,C")).not.toBe(dataPointKey("A,B", "C"));
    expect(dataPointKey("A", "B|C")).not.toBe(dataPointKey("A|B", "C"));
  });

  it("reads a datum's key off the parsed data, and refuses an out-of-range datum", () => {
    const data = makeData(["Jan", "Feb"]);
    expect(dataPointKeyForDatum(data, 0, 1)).toBe("RevenueFeb");
    expect(dataPointKeyForDatum(data, 0, 9)).toBeUndefined();
    expect(dataPointKeyForDatum(data, 9, 0)).toBeUndefined();
  });
});

// ============================================================================
// Key beats index
// ============================================================================

describe("key-then-index resolution", () => {
  it("follows the datum when a row is inserted above it", () => {
    // Authored against Jan/Feb/Mar: "Mar" is coloured, at index 2.
    const override: DataPointOverride = {
      seriesIndex: 0, categoryIndex: 2, key: dataPointKey("Revenue", "Mar"), color: "#FFD700",
    };
    const spec = makeSpec([override]);

    const before = makeData(["Jan", "Feb", "Mar"]);
    expect(resolveDatumStyle(spec, before, 0, 2, BASE).fill).toBe("#FFD700");

    // A row is inserted at the top: "Mar" is now index 3.
    const after = makeData(["NEW", "Jan", "Feb", "Mar"]);
    expect(resolveDatumStyle(spec, after, 0, 3, BASE).fill).toBe("#FFD700");
    expect(resolveDatumStyle(spec, after, 0, 3, BASE).matchedBy).toBe("key");
    // ...and the datum that INHERITED index 2 ("Feb") is NOT coloured. Without
    // the key this is exactly where the colour used to slide to.
    expect(resolveDatumStyle(spec, after, 0, 2, BASE).fill).toBe(BASE.fill);
    expect(resolveDatumStyle(spec, after, 0, 2, BASE).matchedBy).toBe("none");
  });

  it("falls back to the index when the override carries no key", () => {
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 1, color: "#FF0000" }]);
    const data = makeData(["Jan", "Feb", "Mar"]);
    const r = resolveDatumStyle(spec, data, 0, 1, BASE);
    expect(r.fill).toBe("#FF0000");
    expect(r.matchedBy).toBe("index");
  });

  it("falls back to the index when the key names a datum that no longer exists", () => {
    // The series was renamed, so the key matches nothing. Degrading to the old
    // index behaviour is better than dropping the user's formatting entirely.
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 1, key: dataPointKey("Turnover", "Feb"), color: "#00FF00" },
    ]);
    const data = makeData(["Jan", "Feb", "Mar"]);
    const r = resolveDatumStyle(spec, data, 0, 1, BASE);
    expect(r.fill).toBe("#00FF00");
    expect(r.matchedBy).toBe("index");
  });

  it("a key-matched override does NOT also fire at its stale index", () => {
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 0, key: dataPointKey("Revenue", "Mar"), color: "#FFD700" },
    ]);
    const data = makeData(["Jan", "Feb", "Mar"]);
    expect(resolveDatumStyle(spec, data, 0, 2, BASE).fill).toBe("#FFD700"); // key wins
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).fill).toBe(BASE.fill); // stale index does not
  });

  it("a keyed and an index-only override can coexist on different datums", () => {
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 99, key: dataPointKey("Revenue", "Mar"), color: "#AAA111" },
      { seriesIndex: 0, categoryIndex: 0, color: "#BBB222" },
    ]);
    const data = makeData(["Jan", "Feb", "Mar"]);
    expect(resolveDatumStyle(spec, data, 0, 2, BASE).fill).toBe("#AAA111");
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).fill).toBe("#BBB222");
    expect(resolveDatumStyle(spec, data, 0, 1, BASE).fill).toBe(BASE.fill);
  });
});

// ============================================================================
// The duplicate-label tie-break
// ============================================================================

describe("duplicate category label tie-break", () => {
  it("gives the override to the FIRST match in authoring order", () => {
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 3, key: dataPointKey("Revenue", "North"), color: "#FFD700" },
    ]);
    // "North" appears twice: authoring categories 1 and 3.
    const data = makeData(["East", "North", "West", "North"]);
    expect(resolveDatumStyle(spec, data, 0, 1, BASE).fill).toBe("#FFD700");
    expect(resolveDatumStyle(spec, data, 0, 1, BASE).matchedBy).toBe("key");
    // The SECOND "North" does not also turn gold — one override formats one point.
    expect(resolveDatumStyle(spec, data, 0, 3, BASE).fill).toBe(BASE.fill);
    expect(resolveDatumStyle(spec, data, 0, 3, BASE).matchedBy).toBe("none");
  });

  it("orders by AUTHORING index, not painter index, when a filter hides the first one", () => {
    // Authoring categories: East(0) North(1) West(2) North(3).
    // The category filter drops East AND the first North, so painter index 0 is
    // "West" (authoring 2) and painter index 1 is "North" (authoring 3).
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 1, key: dataPointKey("Revenue", "North"), color: "#FFD700" },
    ]);
    const data = makeData(["West", "North"], [3, 4], { keptCategoryIndices: [2, 3] });
    // The only painted "North" is authoring 3, so it is the first match among
    // the datums that exist, and it gets the override.
    expect(resolveDatumStyle(spec, data, 0, 1, BASE).fill).toBe("#FFD700");
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).fill).toBe(BASE.fill);
  });

  it("breaks a cross-series tie by series first, then category", () => {
    const spec = makeSpec([
      { seriesIndex: 5, categoryIndex: 5, key: dataPointKey("Same", "North"), color: "#FFD700" },
    ]);
    const data: ParsedChartData = {
      categories: ["North", "South"],
      series: [
        { name: "Same", values: [1, 2], color: null },
        { name: "Same", values: [3, 4], color: null },
      ],
    };
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).fill).toBe("#FFD700");
    expect(resolveDatumStyle(spec, data, 1, 0, BASE).fill).toBe(BASE.fill);
  });

  it("the FIRST override in spec order wins a contested datum", () => {
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 0, key: dataPointKey("Revenue", "Jan"), color: "#111111" },
      { seriesIndex: 0, categoryIndex: 0, key: dataPointKey("Revenue", "Jan"), color: "#222222" },
    ]);
    const data = makeData(["Jan", "Feb"]);
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).fill).toBe("#111111");
  });
});

// ============================================================================
// Painter-space translation stays inside the resolver
// ============================================================================

describe("filter translation", () => {
  it("translates painter indices to authoring space for an index-keyed override", () => {
    // Series 0 hidden: painter series 0 is authoring series 1.
    const spec = makeSpec([{ seriesIndex: 1, categoryIndex: 0, color: "#FF0000" }]);
    const data: ParsedChartData = {
      categories: ["Jan"],
      series: [{ name: "Cost", values: [5], color: null }],
      keptSeriesIndices: [1],
    };
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).fill).toBe("#FF0000");
  });

  it("does not alias the override onto the wrong datum when a category is hidden", () => {
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 0, color: "#FF0000" }]);
    // Category 0 hidden: painter 0 is authoring 1, painter 1 is authoring 2.
    const data = makeData(["Feb", "Mar"], [2, 3], { keptCategoryIndices: [1, 2] });
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).fill).toBe(BASE.fill);
    expect(resolveDatumStyle(spec, data, 0, 1, BASE).fill).toBe(BASE.fill);
  });
});

// ============================================================================
// The widened style
// ============================================================================

describe("resolveDatumStyle resolved fields", () => {
  const data = makeData(["Jan", "Feb", "Mar"], [10, -20, 30]);

  it("returns the base style untouched when nothing overrides the datum", () => {
    const r = resolveDatumStyle(makeSpec(undefined), data, 0, 0, {
      fill: "#4E79A7", opacity: 0.5, borderColor: "#000", borderWidth: 2,
    });
    expect(r).toMatchObject({
      fill: "#4E79A7", opacity: 0.5, borderColor: "#000", borderWidth: 2,
      gradientFill: null, patternFill: null, explodeOffset: 0, inverted: false, matchedBy: "none",
    });
    expect(r.override).toBeUndefined();
  });

  it("resolves the marker fields for a single point", () => {
    const spec = makeSpec([{
      seriesIndex: 0, categoryIndex: 0,
      markerStyle: "diamond", markerSize: 7, markerFill: "#FF0000",
      markerBorderColor: "#000000", markerBorderWidth: 2,
    }]);
    const r = resolveDatumStyle(spec, data, 0, 0, BASE);
    expect(r).toMatchObject({
      markerStyle: "diamond", markerSize: 7, markerFill: "#FF0000",
      markerBorderColor: "#000000", markerBorderWidth: 2,
    });
  });

  it("falls the marker fill back to the resolved datum fill", () => {
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 0, color: "#123456" }]);
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).markerFill).toBe("#123456");
  });

  it("carries the pattern fill through", () => {
    const spec = makeSpec([{
      seriesIndex: 0, categoryIndex: 0,
      patternFill: { type: "diagonalUp", foreground: "#333333", background: "#ffffff", size: 6 },
    }]);
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).patternFill).toEqual({
      type: "diagonalUp", foreground: "#333333", background: "#ffffff", size: 6,
    });
  });

  it("inverts only a NEGATIVE value, and drops the gradient when it does", () => {
    const gradient = { type: "linear" as const, stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }] };
    const spec = makeSpec([
      { seriesIndex: 0, categoryIndex: 0, invertIfNegative: true, color: "#008000", gradientFill: gradient },
      { seriesIndex: 0, categoryIndex: 1, invertIfNegative: true, color: "#008000", gradientFill: gradient },
    ]);
    // Jan = +10: not inverted.
    const positive = resolveDatumStyle(spec, data, 0, 0, BASE);
    expect(positive.inverted).toBe(false);
    expect(positive.fill).toBe("#008000");
    expect(positive.gradientFill).toEqual(gradient);
    // Feb = -20: inverted, and the gradient would have painted over it.
    const negative = resolveDatumStyle(spec, data, 0, 1, BASE);
    expect(negative.inverted).toBe(true);
    expect(negative.fill).toBe(INVERTED_FILL_COLOR);
    expect(negative.gradientFill).toBeNull();
  });

  it("does not invert when invertIfNegative is off", () => {
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 1, color: "#008000" }]);
    const r = resolveDatumStyle(spec, data, 0, 1, BASE);
    expect(r.inverted).toBe(false);
    expect(r.fill).toBe("#008000");
  });

  it("reports the explode offset so the pie painter never re-derives it", () => {
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 2, exploded: 15 }]);
    expect(resolveDatumStyle(spec, data, 0, 2, BASE).explodeOffset).toBe(15);
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).explodeOffset).toBe(0);
  });

  it("tolerates an empty base and an empty spec", () => {
    const r = resolveDatumStyle(makeSpec([]), data, 0, 0);
    expect(r.fill).toBe("");
    expect(r.markerFill).toBeNull();
    expect(r.matchedBy).toBe("none");
  });
});

// ============================================================================
// Index construction + caching
// ============================================================================

describe("buildOverrideIndex", () => {
  it("is empty when the spec has no overrides", () => {
    expect(buildOverrideIndex(makeSpec(undefined), makeData(["A"])).byDatum.size).toBe(0);
    expect(buildOverrideIndex(makeSpec([]), makeData(["A"])).byDatum.size).toBe(0);
  });

  it("keys the map in AUTHORING space", () => {
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 2, key: dataPointKey("Revenue", "Mar") }]);
    const data = makeData(["Feb", "Mar"], [2, 3], { keptCategoryIndices: [1, 2] });
    const idx = buildOverrideIndex(spec, data);
    expect([...idx.byDatum.keys()]).toEqual(["0,2"]);
  });

  it("re-resolves after the overrides array is replaced on the same spec object", () => {
    const spec = makeSpec([{ seriesIndex: 0, categoryIndex: 0, color: "#111111" }]);
    const data = makeData(["Jan", "Feb"]);
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).fill).toBe("#111111");
    spec.dataPointOverrides = [{ seriesIndex: 0, categoryIndex: 0, color: "#222222" }];
    expect(resolveDatumStyle(spec, data, 0, 0, BASE).fill).toBe("#222222");
  });

  it("resolveDatumOverride returns the winning override object itself", () => {
    const o: DataPointOverride = { seriesIndex: 0, categoryIndex: 1, color: "#ABCDEF" };
    const spec = makeSpec([o]);
    const hit = resolveDatumOverride(spec, makeData(["Jan", "Feb"]), 0, 1);
    expect(hit.override).toBe(o);
    expect(hit.matchedBy).toBe("index");
  });
});
