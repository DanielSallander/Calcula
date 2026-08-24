//! FILENAME: app/extensions/Charts/lib/__tests__/ordinalDomainOrder.test.ts
// PURPOSE: An ordinal declaration has to CHANGE something — the domain order of a
//          text category axis, and the axis scale the chart is pinned to.
// CONTEXT: `type: "ordinal"` used to exist only in the type union and the JSON
//          schema: nothing read it, so declaring it was indistinguishable from
//          declaring "nominal" and from saying nothing. It now lowers to a
//          categorical scale, and `customOrder` gives the sort transform the one
//          thing it could not do — order text by a list, so Mon..Sun stops coming
//          out as Fri, Mon, Sat, Sun, Thu, Tue, Wed.

import { describe, it, expect, afterEach } from "vitest";
import { FillListRegistry } from "@api/fillLists";
import { applyTransforms } from "../chartTransforms";
import { lowerEncoding } from "../lowerEncoding";
import { validateChartSpec } from "../chartSpecValidate";
import {
  BUILT_IN_CUSTOM_ORDER_LISTS,
  BUILT_IN_CUSTOM_ORDER_NAMES,
  resolveCustomOrder,
} from "../customOrderLists";
import type { ChartSpec, EncodingSpec, ParsedChartData, TransformDiagnostic } from "../../types";

// ============================================================================
// Test Helpers
// ============================================================================

/** Weekday categories in the order localeCompare produces — the defect's picture. */
function weekdayData(): ParsedChartData {
  return {
    categories: ["Fri", "Mon", "Sat", "Sun", "Thu", "Tue", "Wed"],
    series: [{ name: "Hours", values: [5, 1, 6, 7, 4, 2, 3], color: null }],
  };
}

function specWith(encoding: EncodingSpec, overrides: Partial<ChartSpec> = {}): ChartSpec {
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

const headers = ["Day", "Region", "Hours"];

// ============================================================================
// Custom-order resolution (the list MEMBERS come from the grid, not from Charts)
// ============================================================================

describe("customOrder list resolution", () => {
  afterEach(() => {
    FillListRegistry._reset();
  });

  it("resolves every built-in name to a fill list that still exists", () => {
    // Drift guard: the four names are the Sort dialog's spelling, the ids are the
    // fill-list registry's. Nothing exports either as a shared constant, so a
    // renamed registry id would otherwise silently un-name a built-in list here.
    for (const name of BUILT_IN_CUSTOM_ORDER_NAMES) {
      const items = resolveCustomOrder(name);
      expect(items, `built-in list "${name}" (${BUILT_IN_CUSTOM_ORDER_LISTS[name]})`).not.toBeNull();
      expect(items!.length).toBeGreaterThan(0);
    }
  });

  it("takes the members from the grid's fill lists rather than a private copy", () => {
    expect(resolveCustomOrder("weekdaysShort")).toEqual(
      FillListRegistry.getBuiltInLists().find((l) => l.id === "builtin.weekday.short")!.items,
    );
    expect(resolveCustomOrder("months")).toEqual(
      FillListRegistry.getBuiltInLists().find((l) => l.id === "builtin.month.full")!.items,
    );
  });

  it("resolves a list the user defined, by name", () => {
    FillListRegistry.addList("Priority", ["Critical", "High", "Medium", "Low"]);
    expect(resolveCustomOrder("Priority")).toEqual(["Critical", "High", "Medium", "Low"]);
  });

  it("returns null for a name no list matches, so the caller can report it", () => {
    expect(resolveCustomOrder("nosuchlist")).toBeNull();
    expect(resolveCustomOrder("")).toBeNull();
    expect(resolveCustomOrder([])).toBeNull();
  });

  it("takes an explicit domain array verbatim", () => {
    expect(resolveCustomOrder(["Q3", "Q1", "Q2"])).toEqual(["Q3", "Q1", "Q2"]);
  });
});

// ============================================================================
// Sort transform: ordering text by a list
// ============================================================================

describe("sort transform with a custom list", () => {
  afterEach(() => {
    FillListRegistry._reset();
  });

  it("orders weekday categories by the list instead of alphabetically", async () => {
    const result = await applyTransforms(weekdayData(), [
      { type: "sort", field: "$category", customOrder: "weekdaysShort" },
    ]);
    expect(result.categories).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });

  it("carries every series along with the reordered categories", async () => {
    const result = await applyTransforms(weekdayData(), [
      { type: "sort", field: "$category", customOrder: "weekdaysShort" },
    ]);
    expect(result.series[0].values).toEqual([7, 1, 2, 3, 4, 5, 6]);
  });

  it("orders by an explicit domain array", async () => {
    const data: ParsedChartData = {
      categories: ["Medium", "Critical", "Low"],
      series: [{ name: "Count", values: [2, 1, 3], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "sort", field: "$category", customOrder: ["Critical", "High", "Medium", "Low"] },
    ]);
    expect(result.categories).toEqual(["Critical", "Medium", "Low"]);
  });

  it("matches labels case- and whitespace-insensitively", async () => {
    const data: ParsedChartData = {
      categories: [" tue", "MON", "wed "],
      series: [{ name: "Hours", values: [2, 1, 3], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "sort", field: "$category", customOrder: "weekdaysShort" },
    ]);
    expect(result.categories).toEqual(["MON", " tue", "wed "]);
  });

  it("puts labels the list never mentions after every listed one, in source order", async () => {
    const data: ParsedChartData = {
      categories: ["Total", "Wed", "Unknown", "Mon"],
      series: [{ name: "Hours", values: [10, 3, 0, 1], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "sort", field: "$category", customOrder: "weekdaysShort" },
    ]);
    expect(result.categories).toEqual(["Mon", "Wed", "Total", "Unknown"]);
  });

  it("flips the whole comparison for desc, so unlisted labels lead", async () => {
    // Matches the backend range sort, which ranks an unmatched value usize::MAX
    // and negates the comparison for a descending level.
    const data: ParsedChartData = {
      categories: ["Mon", "Total", "Wed"],
      series: [{ name: "Hours", values: [1, 10, 3], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "sort", field: "$category", order: "desc", customOrder: "weekdaysShort" },
    ]);
    expect(result.categories).toEqual(["Total", "Wed", "Mon"]);
  });

  it("ranks a named series by the text of its value", async () => {
    const data: ParsedChartData = {
      categories: ["a", "b", "c"],
      series: [{ name: "Year", values: [2025, 2023, 2024], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "sort", field: "Year", customOrder: ["2024", "2023", "2025"] },
    ]);
    expect(result.categories).toEqual(["c", "b", "a"]);
  });

  it("reports and falls back to the by-value order when no list matches the name", async () => {
    const diagnostics: TransformDiagnostic[] = [];
    const result = await applyTransforms(weekdayData(), [
      { type: "sort", field: "$category", customOrder: "nosuchlist" },
    ], diagnostics);
    expect(result.categories).toEqual(["Fri", "Mon", "Sat", "Sun", "Thu", "Tue", "Wed"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ transformType: "sort", severity: "warning" });
    expect(diagnostics[0].message).toContain("nosuchlist");
  });

  it("orders by a list the user defined in the grid", async () => {
    FillListRegistry.addList("Priority", ["Critical", "High", "Medium", "Low"]);
    const data: ParsedChartData = {
      categories: ["Low", "Medium", "Critical"],
      series: [{ name: "Count", values: [3, 2, 1], color: null }],
    };
    const result = await applyTransforms(data, [
      { type: "sort", field: "$category", customOrder: "Priority" },
    ]);
    // Alphabetically this would be Critical, Low, Medium — the list is what puts
    // Medium in the middle.
    expect(result.categories).toEqual(["Critical", "Medium", "Low"]);
  });
});

// ============================================================================
// Lowering: what an ordinal channel compiles to
// ============================================================================

describe("lowerEncoding of an ordinal channel", () => {
  it("lowers ordinal and nominal x to a categorical scale", () => {
    expect(lowerEncoding(specWith({ x: { field: "Day", type: "ordinal" }, y: { field: "Hours" } }), headers).xAxis.scale)
      .toEqual({ type: "point" });
    expect(lowerEncoding(specWith({ x: { field: "Day", type: "nominal" }, y: { field: "Hours" } }), headers).xAxis.scale)
      .toEqual({ type: "point" });
  });

  it("picks band over point for the marks whose painter draws bands", () => {
    const bar = lowerEncoding(specWith({ x: { field: "Day", type: "ordinal" }, y: { field: "Hours" } }, { mark: "bar" }), headers);
    expect(bar.xAxis.scale).toEqual({ type: "band" });
  });

  it("picks the scale from the mark the chart ENDS as, not the one it started as", () => {
    // The size channel rewrites the mark to bubble further up; resolving the
    // scale before that would have declared a band for a chart of points.
    const bubble = lowerEncoding(
      specWith({ x: { field: "Day", type: "ordinal" }, y: { field: "Hours" }, size: { field: "Region" } }, { mark: "bar" }),
      headers,
    );
    expect(bubble.mark).toBe("bubble");
    expect(bubble.xAxis.scale).toEqual({ type: "point" });
  });

  it("lets an explicit channel scale win over the declared type", () => {
    const lowered = lowerEncoding(
      specWith({ x: { field: "Day", type: "ordinal", scale: { type: "log" } }, y: { field: "Hours" } }),
      headers,
    );
    expect(lowered.xAxis.scale).toEqual({ type: "log" });
  });

  it("leaves the axis alone when no type is declared", () => {
    expect(lowerEncoding(specWith({ x: { field: "Day" }, y: { field: "Hours" } }), headers).xAxis.scale)
      .toBeUndefined();
  });

  it("compiles a declared domain order into a $category sort", () => {
    const lowered = lowerEncoding(
      specWith({ x: { field: "Day", type: "ordinal", customOrder: "weekdaysShort" }, y: { field: "Hours" } }),
      headers,
    );
    expect(lowered.transform).toEqual([
      { type: "sort", field: "$category", customOrder: "weekdaysShort" },
    ]);
  });

  it("treats a declared domain order as ordinal even without the type", () => {
    const lowered = lowerEncoding(
      specWith({ x: { field: "Day", customOrder: ["Mon", "Tue"] }, y: { field: "Hours" } }),
      headers,
    );
    expect(lowered.xAxis.scale).toEqual({ type: "point" });
    expect(lowered.transform).toEqual([
      { type: "sort", field: "$category", customOrder: ["Mon", "Tue"] },
    ]);
  });

  it("runs the domain sort after a pivot and before the order channel", () => {
    const lowered = lowerEncoding(
      specWith({
        x: { field: "Day", type: "ordinal", customOrder: "weekdaysShort" },
        y: { field: "Hours" },
        color: { field: "Region" },
        order: { field: "Hours", sort: "desc" },
      }),
      headers,
    );
    expect(lowered.transform?.map((t) => t.type)).toEqual(["pivot", "sort", "sort"]);
    expect(lowered.transform?.[1]).toMatchObject({ field: "$category", customOrder: "weekdaysShort" });
    expect(lowered.transform?.[2]).toMatchObject({ field: "Hours", order: "desc" });
  });
});

// ============================================================================
// Schema: the broker validates against it, so an ordinal spec must survive it
// ============================================================================

describe("chart spec validation of the ordinal declaration", () => {
  it("accepts a categorical scale and both spellings of customOrder", () => {
    const spec = specWith(
      {
        x: { field: "Day", type: "ordinal", customOrder: "weekdaysShort" },
        y: { field: "Hours" },
      },
      {
        xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null, scale: { type: "band" } },
        transform: [{ type: "sort", field: "$category", customOrder: ["Mon", "Tue"] }],
      },
    );
    expect(validateChartSpec(spec)).toEqual([]);
  });

  it("still rejects a scale type and a customOrder shape that do not exist", () => {
    const badScale = specWith({ x: { field: "Day" } }, {
      xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null, scale: { type: "ordinal" as never } },
    });
    expect(validateChartSpec(badScale).length).toBeGreaterThan(0);

    const badOrder = specWith({ x: { field: "Day" } }, {
      transform: [{ type: "sort", field: "$category", customOrder: 7 as never }],
    });
    expect(validateChartSpec(badOrder).length).toBeGreaterThan(0);
  });
});

// ============================================================================
// End to end: the lowered spec, run through the pipeline
// ============================================================================

describe("an ordinal encoding, lowered and applied", () => {
  it("puts a weekday chart in weekday order", async () => {
    const lowered = lowerEncoding(
      specWith({ x: { field: "Day", type: "ordinal", customOrder: "weekdaysShort" }, y: { field: "Hours" } }),
      headers,
    );
    const result = await applyTransforms(weekdayData(), lowered.transform ?? []);
    expect(result.categories).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(result.series[0].values).toEqual([7, 1, 2, 3, 4, 5, 6]);
  });
});
