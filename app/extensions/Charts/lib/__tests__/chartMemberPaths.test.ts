//! FILENAME: app/extensions/Charts/lib/__tests__/chartMemberPaths.test.ts
// PURPOSE: WHO each datum of a model chart is (P4, G4, S5): the member-KEY
//          paths `extractChartData` reads from a view's `groupMembers` and its
//          cells' `groupPath`, and the helpers that use them (alignment by
//          key, the own-selection marks, the "is this tuple still here" test).
// CONTEXT: A path is read from KEYS, never from the joined " > " label, which
//          is app-locale display text. A path that cannot be resolved
//          completely leaves the whole list absent (fail closed): a partial
//          list would let a click filter on another datum's member.

import { describe, it, expect } from "vitest";
import type { PivotViewResponse } from "@api/pivot";
import { extractChartData } from "../pivotChartDataReader";
import {
  alignHighlightValues,
  crossFilterSelfOf,
  memberPathKey,
  pathMatchesTuple,
  tupleIsLive,
} from "../chartMemberPaths";
import { applyChartFilters, applySelectionKeep } from "../chartFilters";
import type { ParsedChartData } from "../../types";

// ---------------------------------------------------------------------------
// A view: ROWS Geo.Region > Geo.City, COLUMNS Time.Year, one measure, with a
// Region subtotal row and a grand-total column.
// Field indices: Region 0, City 1, Year 2.
// ---------------------------------------------------------------------------

type Path = Array<[number, number]>;

const GROUP_MEMBERS = [
  { fieldIndex: 0, fieldKey: "Geo.Region", members: [[1, "East"], [2, ""]] },
  { fieldIndex: 1, fieldKey: "Geo.City", members: [[1, "Boston"], [2, "Albany"], [3, "Dallas"]] },
  { fieldIndex: 2, fieldKey: "Time.Year", members: [[1, "2024"], [2, "2025"]] },
];

function cell(cellType: string, value: unknown, groupPath?: Path) {
  return { cellType, value, ...(groupPath ? { groupPath } : {}) };
}

/** One body row: its row coordinates, then a value per Year column and the row's grand total. */
function bodyRow(viewRow: number, rowType: "Data" | "Subtotal", label: string, rowPath: Path, values: [number, number, number]) {
  return {
    viewRow,
    rowType,
    depth: 0,
    visible: true,
    cells: [
      cell("RowHeader", label, rowPath),
      cell("Data", values[0], [...rowPath, [2, 1]]),
      cell("Data", values[1], [...rowPath, [2, 2]]),
      cell("GrandTotal", values[2], rowPath),
    ],
  };
}

function view(over: Partial<PivotViewResponse> = {}): PivotViewResponse {
  const header = {
    viewRow: 0,
    rowType: "ColumnHeader",
    depth: 0,
    visible: true,
    cells: [cell("Corner", ""), cell("ColumnHeader", "2024", [[2, 1]]), cell("ColumnHeader", "2025", [[2, 2]]), cell("ColumnHeader", "Grand Total")],
  };
  const rows = [
    header,
    bodyRow(1, "Data", "Boston", [[0, 1], [1, 1]], [10, 11, 21]),
    bodyRow(2, "Data", "Albany", [[0, 1], [1, 2]], [20, 22, 42]),
    bodyRow(3, "Subtotal", "East Total", [[0, 1]], [30, 33, 63]),
    // The BLANK region's city: its key is "" (ruling Q8), its label "(Blank)".
    bodyRow(4, "Data", "Dallas", [[0, 2], [1, 3]], [5, 6, 11]),
  ];
  return {
    pivotId: "dq",
    version: 1,
    rowCount: rows.length,
    colCount: 4,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [{ fieldIndex: 0 }, { fieldIndex: 1 }],
    columnFieldSummaries: [{ fieldIndex: 2 }],
    rows,
    columns: [
      { viewCol: 0, colType: "RowLabel", depth: 0 },
      { viewCol: 1, colType: "Data", depth: 0 },
      { viewCol: 2, colType: "Data", depth: 0 },
      { viewCol: 3, colType: "GrandTotal", depth: 0 },
    ],
    groupMembers: GROUP_MEMBERS,
    ...over,
  } as unknown as PivotViewResponse;
}

const east = { field: "Geo.Region", key: "East" };
const blank = { field: "Geo.Region", key: "" };
const boston = { field: "Geo.City", key: "Boston" };
const albany = { field: "Geo.City", key: "Albany" };
const dallas = { field: "Geo.City", key: "Dallas" };
const y2024 = { field: "Time.Year", key: "2024" };
const y2025 = { field: "Time.Year", key: "2025" };

describe("extractChartData: member paths from groupMembers + groupPath", () => {
  it("the subtotal-free path: each category is its row fields' keys, each series its column fields' keys", () => {
    const data = extractChartData(view(), { includeSubtotals: false, includeGrandTotal: false });
    expect(data.categories).toHaveLength(3);
    expect(data.categoryMembers).toEqual([
      [east, boston],
      [east, albany],
      [blank, dallas],
    ]);
    // The grand-total column is narrowed by no column field: the empty path.
    expect(data.seriesMembers).toEqual([[y2024], [y2025], []]);
  });

  it("with subtotals the subtotal row's path is its row field alone", () => {
    const data = extractChartData(view(), { includeSubtotals: true, includeGrandTotal: false });
    expect(data.categoryMembers).toEqual([[east, boston], [east, albany], [east], [blank, dallas]]);
  });

  it("no groupMembers (a range-backed pivot, an older backend): no member paths at all", () => {
    const data = extractChartData(view({ groupMembers: undefined }), { includeSubtotals: false, includeGrandTotal: false });
    expect(data.categoryMembers).toBeUndefined();
    expect(data.seriesMembers).toBeUndefined();
  });

  it("FAIL CLOSED: one coordinate with no key leaves the whole list absent", () => {
    const partial = GROUP_MEMBERS.map((g) =>
      g.fieldIndex === 1 ? { ...g, members: g.members.filter(([id]) => id !== 3) } : g,
    );
    const data = extractChartData(view({ groupMembers: partial } as Partial<PivotViewResponse>), {
      includeSubtotals: false,
      includeGrandTotal: false,
    });
    expect(data.categoryMembers).toBeUndefined();
    expect(data.seriesMembers).toBeUndefined();
  });

  it("the paths never come from the label: a renamed label leaves the keys as they were", () => {
    const v = view();
    (v.rows[1].cells[0] as { value: unknown }).value = "BOSTON (renamed)";
    const data = extractChartData(v, { includeSubtotals: false, includeGrandTotal: false });
    expect(data.categoryMembers?.[0]).toEqual([east, boston]);
  });
});

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

function parsed(categories: string[], seriesNames: string[], values: number[][], cm: ParsedChartData["categoryMembers"], sm: ParsedChartData["seriesMembers"]): ParsedChartData {
  return {
    categories,
    series: seriesNames.map((name, i) => ({ name, values: values[i], color: null })),
    categoryMembers: cm,
    seriesMembers: sm,
  };
}

describe("alignHighlightValues", () => {
  it("two series under ONE column member (two measures) are told apart by their order, never merged", () => {
    const base = parsed(["East", "West"], ["Sales", "Cost"], [[100, 200], [40, 80]], [[east], [{ field: "Geo.Region", key: "West" }]], [[], []]);
    const hi = parsed(["West"], ["Sales", "Cost"], [[20], [8]], [[{ field: "Geo.Region", key: "West" }]], [[], []]);
    expect(alignHighlightValues(base, hi)).toEqual([
      [0, 20],
      [0, 8],
    ]);
  });

  it("either side without paths: null (no highlight beats a misaligned one)", () => {
    const base = parsed(["East"], ["S"], [[1]], [[east]], [[]]);
    expect(alignHighlightValues(base, { categories: ["East"], series: [{ name: "S", values: [1], color: null }] })).toBeNull();
  });
});

describe("pathMatchesTuple / tupleIsLive / crossFilterSelfOf", () => {
  const data = extractChartData(view(), { includeSubtotals: false, includeGrandTotal: false });

  it("a tuple matches a path carrying every one of its fields with the tuple's key", () => {
    expect(pathMatchesTuple([east, boston, y2024], ["Geo.City", "Time.Year"], ["Boston", "2024"])).toBe(true);
    expect(pathMatchesTuple([east, boston, y2024], ["Geo.City", "Time.Year"], ["Boston", "2025"])).toBe(false);
    // A field the path does not carry never matches.
    expect(pathMatchesTuple([east], ["Geo.City"], ["Boston"])).toBe(false);
  });

  it("a tuple is live while some datum still names it", () => {
    expect(tupleIsLive(data, ["Geo.Region"], [""])).toBe(true);
    expect(tupleIsLive(data, ["Geo.City", "Time.Year"], ["Albany", "2025"])).toBe(true);
    expect(tupleIsLive(data, ["Geo.City"], ["Gone"])).toBe(false);
  });

  it("the own selection marks exactly its datums; a legend-style series tuple marks a whole series", () => {
    const self = crossFilterSelfOf(data, { fields: ["Geo.City", "Time.Year"], tuples: [["Albany", "2025"]] });
    expect(self?.datums).toEqual([
      [false, false, false],
      [false, true, false],
      [false, false, false],
    ]);
    expect(self?.categories).toEqual([false, true, false]);
    expect(self?.series).toEqual([false, true, false]);

    const year = crossFilterSelfOf(data, { fields: ["Time.Year"], tuples: [["2024"]] });
    expect(year?.datums[0]).toEqual([true, true, true]);
    expect(year?.datums[1]).toEqual([false, false, false]);
  });

  it("memberPathKey tells field from key (no join that two members could share)", () => {
    expect(memberPathKey([{ field: "a.b", key: "c" }])).not.toBe(memberPathKey([{ field: "a", key: "b.c" }]));
  });
});

describe("the chart filters narrow the identity fields exactly as the numbers", () => {
  const data: ParsedChartData = {
    ...parsed(
      ["East", "West", "North"],
      ["Sales", "Cost"],
      [[100, 200, 50], [40, 80, 30]],
      [[east], [{ field: "Geo.Region", key: "West" }], [{ field: "Geo.Region", key: "North" }]],
      [[], []],
    ),
    highlightValues: [[10, 20, 30], [1, 2, 3]],
    crossFilterSelf: { categories: [false, true, false], datums: [[false, true, false], [false, true, false]] },
  };

  it("a hidden category and a hidden series take their member paths, highlight values and own marks with them", () => {
    const out = applyChartFilters(data, { hiddenSeries: [0], hiddenCategories: [1] });
    expect(out.categories).toEqual(["East", "North"]);
    expect(out.categoryMembers).toEqual([[east], [{ field: "Geo.Region", key: "North" }]]);
    expect(out.seriesMembers).toEqual([[]]);
    expect(out.highlightValues).toEqual([[1, 3]]);
    expect(out.crossFilterSelf).toEqual({ categories: [false, false], datums: [[false, false]] });
  });

  it("the selection keep (by label) narrows them the same way", () => {
    const out = applySelectionKeep(data, ["North", "West"]);
    expect(out.categories).toEqual(["West", "North"]);
    expect(out.categoryMembers?.map((p) => p[0].key)).toEqual(["West", "North"]);
    expect(out.highlightValues).toEqual([[20, 30], [2, 3]]);
  });
});
