//! FILENAME: app/extensions/Charts/handlers/__tests__/crossFilterClick.test.ts
// PURPOSE: Every row of the cross-filter click grammar (P4 S6,
//          handlers/crossFilterClick.ts), over the REAL @api/reportFilters
//          selections:
//            - a plain click replaces every selection on the page with this
//              source's one tuple (another visual's selection is dropped; a
//              selection on ANOTHER page is kept);
//            - a plain click on the sole selected datum clears this source;
//            - Ctrl+click toggles the tuple within this source and keeps the
//              other sources (AND); the last one out clears it;
//            - a background click on a source with a selection clears it, and on
//              one without does nothing;
//            - a datum without member paths does nothing and says so ONCE;
//            - a tuple over a different field list (a legend entry after a bar)
//              replaces the selection;
//          plus the datum/legend path rule (category + series; a radial mark's
//          slice and legend entry name the CATEGORY).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  getReportPagesSnapshot: () => ({
    pages: [
      { index: 2, sheetId: "sheet-2", name: "Page 1" },
      { index: 3, sheetId: "sheet-3", name: "Page 2" },
    ],
    sheetIdByIndex: new Map([
      [2, "sheet-2"],
      [3, "sheet-3"],
    ]),
    activeIndex: 2,
    version: 1,
  }),
}));

import { clearCrossFilters, getCrossFilters, setCrossFilter } from "@api/reportFilters";
import {
  applyCrossFilterClick,
  memberPathOfHit,
  resetCrossFilterClickNotes,
  type CrossFilterClickInput,
} from "../crossFilterClick";
import type { ChartHitResult, ParsedChartData } from "../../types";

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

function chartOf(id: string, sheetIndex = 2, mark = "bar") {
  return {
    chartId: id,
    name: `Chart ${id}`,
    sheetIndex,
    spec: { mark, data: { type: "designQuery", connectionId: "conn-1", dslText: "" } },
  } as unknown as CrossFilterClickInput["chart"];
}

const bar = (si: number, pi: number): ChartHitResult => ({ element: "datum", type: "bar", seriesIndex: si, pointIndex: pi } as ChartHitResult);
const legend = (si: number): ChartHitResult => ({ element: "legendEntry", seriesIndex: si } as ChartHitResult);
const background: ChartHitResult = { element: "plotArea" } as ChartHitResult;

function click(id: string, hit: ChartHitResult, opts: { ctrl?: boolean; data?: ParsedChartData; sheetIndex?: number; mark?: string } = {}) {
  return applyCrossFilterClick({
    chart: chartOf(id, opts.sheetIndex ?? 2, opts.mark),
    data: opts.data ?? DATA,
    hit,
    ctrl: opts.ctrl ?? false,
  });
}

const selectionOf = (id: string) => getCrossFilters().find((s) => s.source.id === id) ?? null;

beforeEach(() => {
  clearCrossFilters();
  resetCrossFilterClickNotes();
});
afterEach(() => {
  clearCrossFilters();
  vi.restoreAllMocks();
});

describe("the click grammar", () => {
  it("a plain click on a bar selects its one tuple (category + series), keyed, on the chart's page and model", () => {
    expect(click("a", bar(1, 0))).toBe("selected");
    const sel = selectionOf("a");
    expect(sel).toMatchObject({
      source: { kind: "chart", id: "a" },
      sourceName: "Chart a",
      pageSheetId: "sheet-2",
      connectionId: "conn-1",
      fields: [REGION, YEAR],
      tuples: [["East", "2025"]],
    });
  });

  it("a plain click REPLACES every selection on the page -- another visual's too -- and keeps another page's", () => {
    click("b", bar(0, 1));
    click("other-page", bar(0, 0), { sheetIndex: 3 });
    expect(getCrossFilters("sheet-2")).toHaveLength(1);
    click("a", bar(0, 0));
    expect(getCrossFilters("sheet-2").map((s) => s.source.id)).toEqual(["a"]);
    expect(selectionOf("b"), "the other visual's selection survived a plain click").toBeNull();
    expect(selectionOf("other-page"), "a plain click reached another page").not.toBeNull();
  });

  it("a plain click on another datum of the same source replaces its tuple", () => {
    click("a", bar(0, 0));
    expect(click("a", bar(1, 1))).toBe("selected");
    expect(selectionOf("a")?.tuples).toEqual([["West", "2025"]]);
  });

  it("a plain click on the SOLE selected datum clears the source", () => {
    click("a", bar(0, 0));
    expect(click("a", bar(0, 0))).toBe("cleared");
    expect(selectionOf("a")).toBeNull();
  });

  it("a plain click on one of SEVERAL selected datums narrows to it (it is not the sole one)", () => {
    click("a", bar(0, 0));
    click("a", bar(1, 1), { ctrl: true });
    expect(click("a", bar(0, 0))).toBe("selected");
    expect(selectionOf("a")?.tuples).toEqual([["East", "2024"]]);
  });

  it("Ctrl+click toggles within this source and KEEPS the other sources (AND)", () => {
    click("b", bar(0, 1));
    click("a", bar(0, 0), { ctrl: true });
    expect(selectionOf("b"), "Ctrl dropped another source").not.toBeNull();
    expect(click("a", bar(1, 1), { ctrl: true })).toBe("toggled");
    expect(selectionOf("a")?.tuples).toEqual([
      ["East", "2024"],
      ["West", "2025"],
    ]);
    // Toggled out again; the last one out clears the source.
    click("a", bar(0, 0), { ctrl: true });
    expect(selectionOf("a")?.tuples).toEqual([["West", "2025"]]);
    click("a", bar(1, 1), { ctrl: true });
    expect(selectionOf("a")).toBeNull();
    expect(selectionOf("b")).not.toBeNull();
  });

  it("a background click clears a source that has a selection, and does nothing to one without", () => {
    click("b", bar(0, 1));
    expect(click("a", background)).toBe("ignored");
    expect(selectionOf("b"), "a background click on ANOTHER chart cleared b").not.toBeNull();
    click("a", bar(0, 0), { ctrl: true });
    expect(click("a", background)).toBe("cleared");
    expect(selectionOf("a")).toBeNull();
    expect(selectionOf("b")).not.toBeNull();
  });

  it("a datum without member paths does nothing, and says so ONCE per chart", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const noPaths = { categories: ["East"], series: [{ name: "S", values: [1] }] } as ParsedChartData;
    click("b", bar(0, 1));
    expect(click("a", bar(0, 0), { data: noPaths })).toBe("noPaths");
    expect(click("a", bar(0, 0), { data: noPaths, ctrl: true })).toBe("noPaths");
    expect(getCrossFilters().map((s) => s.source.id)).toEqual(["b"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a tuple over a DIFFERENT field list replaces the selection (a legend entry after a bar), plain or Ctrl", () => {
    click("a", bar(0, 0));
    click("a", legend(1), { ctrl: true });
    expect(selectionOf("a")).toMatchObject({ fields: [YEAR], tuples: [["2025"]] });
    click("a", bar(1, 1));
    expect(selectionOf("a")).toMatchObject({ fields: [REGION, YEAR], tuples: [["West", "2025"]] });
  });

  it("a Ctrl+click on a chart without a selection starts one (and keeps the others)", () => {
    click("b", bar(0, 1));
    expect(click("a", bar(0, 1), { ctrl: true })).toBe("toggled");
    expect(selectionOf("a")?.tuples).toEqual([["West", "2024"]]);
    expect(selectionOf("b")).not.toBeNull();
  });

  it("a chart on a sheet with no page id, or with no model connection, does nothing", () => {
    expect(click("a", bar(0, 0), { sheetIndex: 9 })).toBe("ignored");
    const noModel = applyCrossFilterClick({
      chart: { ...chartOf("a"), spec: { mark: "bar", data: "Sheet1!A1:B3" } } as unknown as CrossFilterClickInput["chart"],
      data: DATA,
      hit: bar(0, 0),
      ctrl: false,
    });
    expect(noModel).toBe("ignored");
    expect(getCrossFilters()).toHaveLength(0);
  });

  it("an existing selection held on ANOTHER page by this source is replaced, not toggled into", () => {
    setCrossFilter({
      source: { kind: "chart", id: "a" },
      sourceName: "Chart a",
      pageSheetId: "sheet-3",
      connectionId: "conn-1",
      fields: [REGION, YEAR],
      tuples: [["East", "2024"]],
    });
    click("a", bar(1, 1), { ctrl: true });
    expect(selectionOf("a")).toMatchObject({ pageSheetId: "sheet-2", tuples: [["West", "2025"]] });
  });
});

describe("the path a hit names", () => {
  it("a datum: its category's path, then its series'", () => {
    expect(memberPathOfHit(DATA, bar(1, 0), "bar")).toEqual([
      { field: REGION, key: "East" },
      { field: YEAR, key: "2025" },
    ]);
  });

  it("a legend entry: its series' path only; an EMPTY series path names nothing", () => {
    expect(memberPathOfHit(DATA, legend(0), "bar")).toEqual([{ field: YEAR, key: "2024" }]);
    expect(memberPathOfHit(ONE_SERIES, legend(0), "bar")).toBeNull();
  });

  it("a lone measure's bar: the category alone", () => {
    expect(memberPathOfHit(ONE_SERIES, bar(0, 1), "bar")).toEqual([{ field: REGION, key: "West" }]);
  });

  it("a RADIAL mark's slice and legend entry both name the CATEGORY (the slice's own index)", () => {
    const slice = { element: "datum", type: "slice", seriesIndex: 1, pointIndex: 1 } as ChartHitResult;
    expect(memberPathOfHit(ONE_SERIES, slice, "pie")).toEqual([{ field: REGION, key: "West" }]);
    expect(memberPathOfHit(ONE_SERIES, legend(0), "donut")).toEqual([{ field: REGION, key: "East" }]);
  });

  it("an index outside the paths, or a background hit, names nothing", () => {
    expect(memberPathOfHit(DATA, bar(5, 0), "bar")).toBeNull();
    expect(memberPathOfHit(DATA, bar(0, 7), "bar")).toBeNull();
    expect(memberPathOfHit(DATA, background, "bar")).toBeNull();
  });
});
