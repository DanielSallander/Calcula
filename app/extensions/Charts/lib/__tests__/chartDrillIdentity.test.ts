//! FILENAME: app/extensions/Charts/lib/__tests__/chartDrillIdentity.test.ts
// PURPOSE: The right-click RECORD site's drill identity (lib/chartDrillIdentity.ts,
//          docs/design/model-drillthrough.md 2.3): a datum is a PATH (member keys
//          from the hit, labels beside them), MEASURE-ONLY (a Card's one category
//          has the empty path) or NONE (a transformed or composed chart, a chart
//          that has not painted, a missing key) with the reason the menu shows;
//          and the two readers of the record -- the runner's KEY filters and the
//          row's subject text.
// CONTEXT: The fixtures are crossFilterClick.test.ts's (two categories x two
//          series under column members; a lone measure), so the path here is
//          proved equal to `memberPathOfHit`'s rather than re-derived.

import { describe, it, expect } from "vitest";

import { memberPathOfHit } from "../../handlers/crossFilterClick";
import { TRANSFORMED_SOURCE_REASON } from "../chartModelVisuals";
import {
  DRILL_COMPOSED_REASON,
  DRILL_MEASURE_LEGEND_REASON,
  DRILL_NO_CACHE_REASON,
  DRILL_NO_MEMBER_REASON,
  chartDrillIdentity,
  drillIdentityFields,
  drillSpecsOf,
  drillSubjectText,
} from "../chartDrillIdentity";
import type { ChartHitResult, ChartSpec, ParsedChartData } from "../../types";

const REGION = "Geo.Region";
const YEAR = "Date.Year";

/** Two categories (East, West) x two series under column members (2024, 2025). */
const DATA: ParsedChartData = {
  categories: ["East", "West"],
  series: [
    { name: "2024", values: [1, 2] },
    { name: "2025", values: [3, 4] },
  ],
  categoryMembers: [[{ field: REGION, key: "East" }], [{ field: REGION, key: "West" }]],
  seriesMembers: [[{ field: YEAR, key: "2024" }], [{ field: YEAR, key: "2025" }]],
} as ParsedChartData;

/** One series, no column field (a lone measure): its series path is empty. */
const ONE_SERIES: ParsedChartData = {
  categories: ["East", "West"],
  series: [{ name: "Sales", values: [1, 2] }],
  categoryMembers: [[{ field: REGION, key: "East" }], [{ field: REGION, key: "West" }]],
  seriesMembers: [[]],
} as ParsedChartData;

/** A Card: one measure, no grouping -- its one category has the EMPTY path. */
const MEASURE_ONLY: ParsedChartData = {
  categories: ["Sales"],
  series: [{ name: "Sales", values: [42] }],
  categoryMembers: [[]],
  seriesMembers: [[]],
} as ParsedChartData;

/** A two-field category (Region > Color) with a lone measure. */
const TWO_FIELD_CATEGORY: ParsedChartData = {
  categories: ["East > Red", "East > Blue"],
  series: [{ name: "Sales", values: [1, 2] }],
  categoryMembers: [
    [
      { field: REGION, key: "East" },
      { field: "Product.Color", key: "Red" },
    ],
    [
      { field: REGION, key: "East" },
      { field: "Product.Color", key: "Blue" },
    ],
  ],
  seriesMembers: [[]],
} as ParsedChartData;

/** No member paths at all (the view carried no groupMembers). */
const NO_PATHS: ParsedChartData = {
  categories: ["East", "West"],
  series: [{ name: "Sales", values: [1, 2] }],
} as ParsedChartData;

function designQuerySpec(mark = "bar", extra: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
    data: { type: "designQuery", dslText: "ROWS: Geo.Region\nVALUES: [Revenue]", connectionId: "conn-1" },
    series: [],
    ...extra,
  } as unknown as ChartSpec;
}

const RANGE_SPEC = {
  mark: "bar",
  data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
  series: [],
} as unknown as ChartSpec;

const bar = (si: number, pi: number, names: { categoryName?: string; seriesName?: string } = {}): ChartHitResult =>
  ({ element: "datum", type: "bar", seriesIndex: si, pointIndex: pi, ...names }) as ChartHitResult;
const legend = (si: number, seriesName?: string): ChartHitResult =>
  ({ element: "legendEntry", seriesIndex: si, seriesName }) as ChartHitResult;
const title: ChartHitResult = { element: "title" } as ChartHitResult;

describe("chartDrillIdentity: when the question does not arise", () => {
  it("answers null for a chart that reads cells (no model member to name)", () => {
    expect(chartDrillIdentity(RANGE_SPEC, DATA, bar(0, 0))).toBeNull();
  });

  it("answers null for a hit that is not a datum or a legend entry, and for no hit or no spec", () => {
    expect(chartDrillIdentity(designQuerySpec(), DATA, title)).toBeNull();
    expect(chartDrillIdentity(designQuerySpec(), DATA, null)).toBeNull();
    expect(chartDrillIdentity(undefined, DATA, bar(0, 0))).toBeNull();
  });
});

describe("chartDrillIdentity: a PATH", () => {
  it("names the clicked bar's category AND series by KEY, equal to memberPathOfHit, with the drawn labels beside them", () => {
    const hit = bar(1, 1, { categoryName: "West", seriesName: "2025" });
    const identity = chartDrillIdentity(designQuerySpec(), DATA, hit);
    expect(identity).toEqual({
      kind: "path",
      path: [
        { field: REGION, key: "West" },
        { field: YEAR, key: "2025" },
      ],
      labels: ["West", "2025"],
    });
    expect(identity?.path).toEqual(memberPathOfHit(DATA, hit, "bar"));
  });

  it("takes the point from the HIT: a first right-click selects the series, but the identity is the bar's", () => {
    // The record site's `painterPoint` is withheld while the ladder is on the
    // series rung; the hit always names the point.
    const identity = chartDrillIdentity(designQuerySpec(), DATA, bar(0, 1, { categoryName: "West", seriesName: "2024" }));
    expect(identity?.path).toEqual([
      { field: REGION, key: "West" },
      { field: YEAR, key: "2024" },
    ]);
  });

  it("a lone measure's bar names the category only, labelled by the category", () => {
    const identity = chartDrillIdentity(designQuerySpec(), ONE_SERIES, bar(0, 0, { categoryName: "East", seriesName: "Sales" }));
    expect(identity).toEqual({ kind: "path", path: [{ field: REGION, key: "East" }], labels: ["East"] });
  });

  it("a cartesian legend entry names its SERIES member, labelled by the entry", () => {
    const identity = chartDrillIdentity(designQuerySpec(), DATA, legend(1, "2025"));
    expect(identity).toEqual({ kind: "path", path: [{ field: YEAR, key: "2025" }], labels: ["2025"] });
  });

  it("a radial slice and its legend entry name the CATEGORY (the hit's series index is the category on a pie)", () => {
    const slice = chartDrillIdentity(designQuerySpec("pie"), ONE_SERIES, bar(0, 1, { categoryName: "West", seriesName: "Sales" }));
    expect(slice).toEqual({ kind: "path", path: [{ field: REGION, key: "West" }], labels: ["West"] });
    // A pie's legend lists categories; the entry's drawn text is the category.
    const entry = chartDrillIdentity(designQuerySpec("pie"), ONE_SERIES, legend(1, "West"));
    expect(entry).toEqual({ kind: "path", path: [{ field: REGION, key: "West" }], labels: ["West"] });
  });

  it("a two-field category gets KEYS for both coordinates and a label for neither (one drawn label, two members)", () => {
    const identity = chartDrillIdentity(designQuerySpec(), TWO_FIELD_CATEGORY, bar(0, 0, { categoryName: "East > Red", seriesName: "Sales" }));
    expect(identity?.kind).toBe("path");
    expect(identity?.path).toEqual([
      { field: REGION, key: "East" },
      { field: "Product.Color", key: "Red" },
    ]);
    expect(identity?.labels).toEqual([null, null]);
  });
});

describe("chartDrillIdentity: MEASURE-ONLY and NONE", () => {
  it("a Card's datum is measure-only: categoryMembers is exactly [[]]", () => {
    expect(chartDrillIdentity(designQuerySpec("card"), MEASURE_ONLY, bar(0, 0))).toEqual({ kind: "measureOnly", path: null, labels: [] });
  });

  it("a lone measure's legend entry has no identity, with its own reason", () => {
    expect(chartDrillIdentity(designQuerySpec(), ONE_SERIES, legend(0, "Sales"))).toEqual({
      kind: "none",
      path: null,
      labels: [],
      reason: DRILL_MEASURE_LEGEND_REASON,
    });
  });

  it("a transformed chart's points name no member -- the cross-filter's own reason text", () => {
    const spec = designQuerySpec("bar", { transform: [{ type: "sort", field: "Sales" }] } as unknown as Partial<ChartSpec>);
    expect(chartDrillIdentity(spec, DATA, bar(0, 0))).toEqual({ kind: "none", path: null, labels: [], reason: TRANSFORMED_SOURCE_REASON });
  });

  it("a composed chart (concat / facet / repeat) has no identity", () => {
    const concat = designQuerySpec("bar", { concat: { charts: [] } } as unknown as Partial<ChartSpec>);
    expect(chartDrillIdentity(concat, DATA, bar(0, 0))?.reason).toBe(DRILL_COMPOSED_REASON);
    const facet = designQuerySpec("bar", { facet: { field: "Region" } } as unknown as Partial<ChartSpec>);
    expect(chartDrillIdentity(facet, DATA, bar(0, 0))?.reason).toBe(DRILL_COMPOSED_REASON);
    const repeat = designQuerySpec("bar", { repeat: { columns: 2 } } as unknown as Partial<ChartSpec>);
    expect(chartDrillIdentity(repeat, DATA, bar(0, 0))?.reason).toBe(DRILL_COMPOSED_REASON);
  });

  it("a chart that has never painted (no render cache) has no identity yet", () => {
    expect(chartDrillIdentity(designQuerySpec(), null, bar(0, 0))?.reason).toBe(DRILL_NO_CACHE_REASON);
  });

  it("data without member paths, or an index outside them, names no member", () => {
    expect(chartDrillIdentity(designQuerySpec(), NO_PATHS, bar(0, 0))).toEqual({ kind: "none", path: null, labels: [], reason: DRILL_NO_MEMBER_REASON });
    expect(chartDrillIdentity(designQuerySpec(), DATA, bar(0, 7))?.reason).toBe(DRILL_NO_MEMBER_REASON);
  });

  it("a transform is told before a missing cache: the spec's own fault comes first", () => {
    const spec = designQuerySpec("bar", { transform: [{ type: "sort", field: "Sales" }] } as unknown as Partial<ChartSpec>);
    expect(chartDrillIdentity(spec, null, bar(0, 0))?.reason).toBe(TRANSFORMED_SOURCE_REASON);
  });
});

describe("the record fields", () => {
  it("writes memberPath / memberLabels / drillIdentity (and the reason only for none); nothing for null", () => {
    expect(drillIdentityFields(null)).toEqual({});
    const path = chartDrillIdentity(designQuerySpec(), DATA, bar(1, 1, { categoryName: "West", seriesName: "2025" }));
    expect(drillIdentityFields(path)).toEqual({
      memberPath: [
        { field: REGION, key: "West" },
        { field: YEAR, key: "2025" },
      ],
      memberLabels: ["West", "2025"],
      drillIdentity: "path",
    });
    expect(drillIdentityFields(chartDrillIdentity(designQuerySpec(), null, bar(0, 0)))).toEqual({
      memberPath: null,
      memberLabels: [],
      drillIdentity: "none",
      drillIdentityReason: DRILL_NO_CACHE_REASON,
    });
  });
});

describe("drillSpecsOf: the runner's KEY filters", () => {
  it("writes one spec per coordinate with its key and, when known, its label", () => {
    expect(
      drillSpecsOf({
        memberPath: [
          { field: REGION, key: "West" },
          { field: YEAR, key: "2025" },
        ],
        memberLabels: ["West", "2025"],
      }),
    ).toEqual([
      { field: REGION, includedKeys: ["West"], labels: ["West"] },
      { field: YEAR, includedKeys: ["2025"], labels: ["2025"] },
    ]);
  });

  it("leaves `labels` off a coordinate with no label, and spells the blank member's label (Blank) whatever was drawn", () => {
    expect(
      drillSpecsOf({
        memberPath: [
          { field: REGION, key: "" },
          { field: "Product.Color", key: "Red" },
        ],
        memberLabels: ["", null],
      }),
    ).toEqual([
      { field: REGION, includedKeys: [""], labels: ["(Blank)"] },
      { field: "Product.Color", includedKeys: ["Red"] },
    ]);
  });

  it("is empty for a measure-only datum (null path) and for no record", () => {
    expect(drillSpecsOf({ memberPath: null, memberLabels: [] })).toEqual([]);
    expect(drillSpecsOf(null)).toEqual([]);
    expect(drillSpecsOf({})).toEqual([]);
  });
});

describe("drillSubjectText: how the run row names the point", () => {
  it("joins every coordinate's label in path order", () => {
    expect(
      drillSubjectText({
        memberPath: [
          { field: REGION, key: "West" },
          { field: YEAR, key: "2025" },
        ],
        memberLabels: ["West", "2025"],
      }),
    ).toBe("West, 2025");
  });

  it("spells the blank member (Blank), and answers null when some coordinate has no label or there is no path", () => {
    expect(drillSubjectText({ memberPath: [{ field: REGION, key: "" }], memberLabels: [""] })).toBe("(Blank)");
    expect(
      drillSubjectText({
        memberPath: [
          { field: REGION, key: "East" },
          { field: "Product.Color", key: "Red" },
        ],
        memberLabels: [null, null],
      }),
    ).toBeNull();
    expect(drillSubjectText({ memberPath: null, memberLabels: [] })).toBeNull();
    expect(drillSubjectText(null)).toBeNull();
  });
});
