//! FILENAME: app/src/api/__tests__/reportFilters.resolve.test.ts
// PURPOSE: The report-filter seam (@api/reportFilters, P4): publishers
//          REPLACE their lists, ONE resolver answers what a target on a page
//          reads, and the change event names exactly what moved -- and stays
//          SILENT when a republish moved nothing.
// CONTEXT: Ports every case of the deleted pageFilters.test.ts (diffing,
//          ordering, withdraw, an empty list keeps nothing, listener
//          isolation) to sheet-id pages, then pins the resolver's rules: the
//          scope matrix, interactions (none drops a source for one target,
//          a ribbon filter ignores them), the own-selection drop, highlight
//          forced to filter where it cannot paint, defaultMode for visual
//          sources only, rectangular vs tuple routing, include
//          "visualSelectionsOnly", the File > New reset and change events that
//          name only moved pages and targets.

import { describe, it, expect, afterEach } from "vitest";
import {
  addToCrossFilter,
  clearCrossFilter,
  clearCrossFilters,
  getCrossFilters,
  getReportFilters,
  interactionFor,
  isCrossFilterSource,
  isRectangular,
  onReportFiltersChange,
  pruneCrossFilter,
  publishPageInteractions,
  publishReportFilters,
  resolveFiltersFor,
  resolvePageBase,
  setCrossFilter,
  startReportFilters,
  type CrossFilterSelection,
  type ReportFilterInput,
  type ReportFiltersChange,
  type ResolveTarget,
  type VisualRef,
} from "../reportFilters";
import { AppEvents, emitAppEvent } from "../events";

const PUBLISHERS = ["slicer", "timeline", "ribbon"];
const PAGES = ["p1", "p2", "p3"];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  for (const p of PUBLISHERS) publishReportFilters(p, []);
  clearCrossFilters();
  for (const p of PAGES) publishPageInteractions(p, null);
});

function listen(): ReportFiltersChange[] {
  const seen: ReportFiltersChange[] = [];
  cleanups.push(onReportFiltersChange((c) => seen.push(c)));
  return seen;
}

const chart = (id: string): VisualRef => ({ kind: "chart", id });
const slicerRef = (id: string): VisualRef => ({ kind: "slicer", id });
const pivot = (id: string): VisualRef => ({ kind: "pivot", id });
const target = (ref: VisualRef, canHighlight = true): ResolveTarget => ({ ref, canHighlight });

/** A model slicer's filter on page p1 of conn-a (the Slicer extension's shape). */
function filter(over: Partial<ReportFilterInput> = {}): ReportFilterInput {
  return {
    sourceId: "s-1",
    sourceName: "Slicer_Region",
    sourceRef: slicerRef("s-1"),
    scope: { kind: "page", sheetId: "p1" },
    connectionId: "conn-a",
    field: "Geo.Region",
    includedKeys: ["East"],
    ...over,
  };
}

/** A ribbon filter (no object on the page) with the given scope. */
function ribbon(scope: ReportFilterInput["scope"], over: Partial<ReportFilterInput> = {}): ReportFilterInput {
  return filter({ sourceId: "rf-1", sourceName: "Year", sourceRef: null, field: "Time.Year", includedKeys: ["2024"], scope, ...over });
}

function selection(over: Partial<CrossFilterSelection> = {}): CrossFilterSelection {
  return {
    source: chart("bar"),
    sourceName: "Revenue by region",
    pageSheetId: "p1",
    connectionId: "conn-a",
    fields: ["Geo.Region"],
    tuples: [["East"]],
    ...over,
  };
}

const fieldsOf = (r: ReturnType<typeof resolveFiltersFor>) => r.filters.map((f) => `${f.field}=${f.includedKeys.join("|")}`);

// ---------------------------------------------------------------------------
// Ported from pageFilters.test.ts
// ---------------------------------------------------------------------------

describe("@api/reportFilters -- the publisher half (ported)", () => {
  it("a page's base holds its own filters for one model connection only", () => {
    publishReportFilters("slicer", [
      filter(),
      filter({ sourceId: "s-2", connectionId: "conn-b" }),
      filter({ sourceId: "s-3", scope: { kind: "page", sheetId: "p2" } }),
    ]);

    const base = resolvePageBase("p1", "conn-a");
    expect(base.filters).toEqual([{ field: "Geo.Region", includedKeys: ["East"], level: 1, from: "Slicer_Region" }]);
    expect(base.sources).toEqual([{ name: "Slicer_Region", ref: slicerRef("s-1"), mode: "filter" }]);
    expect(resolvePageBase("p1", "conn-b").filters).toHaveLength(1);
    expect(resolvePageBase("p2", "conn-a").filters).toHaveLength(1);
    expect(resolvePageBase("p3", "conn-a").filters).toEqual([]);
    expect(getReportFilters().map((f) => [f.publisher, f.sourceId, f.filterLevel])).toEqual([
      ["slicer", "s-1", 1],
      ["slicer", "s-2", 1],
      ["slicer", "s-3", 1],
    ]);
  });

  it("names exactly the (page, model) pairs whose filters changed", () => {
    publishReportFilters("slicer", [filter(), filter({ sourceId: "s-3", scope: { kind: "page", sheetId: "p2" } })]);
    const seen = listen();

    publishReportFilters("slicer", [
      filter({ includedKeys: ["West"] }),
      filter({ sourceId: "s-3", scope: { kind: "page", sheetId: "p2" } }),
    ]);

    expect(seen).toEqual([{ pages: [{ sheetId: "p1", connectionId: "conn-a" }], targets: [] }]);
  });

  it("is silent when a republish changed nothing, whatever the order of filters or keys", () => {
    publishReportFilters("slicer", [
      filter({ includedKeys: ["East", "West"] }),
      filter({ sourceId: "s-2", field: "Time.Year", includedKeys: ["2024"] }),
    ]);
    const seen = listen();

    publishReportFilters("slicer", [
      filter({ sourceId: "s-2", field: "Time.Year", includedKeys: ["2024"] }),
      filter({ includedKeys: ["West", "East"] }),
    ]);

    expect(seen).toEqual([]);
  });

  it("announces a CLEAR (the publisher withdrew its filter) for the page it left", () => {
    publishReportFilters("slicer", [filter()]);
    const seen = listen();

    publishReportFilters("slicer", []);

    expect(seen).toEqual([{ pages: [{ sheetId: "p1", connectionId: "conn-a" }], targets: [] }]);
    expect(resolvePageBase("p1", "conn-a").filters).toEqual([]);
  });

  it("keeps each publisher's filters: one publisher's republish never drops another's", () => {
    publishReportFilters("slicer", [filter()]);
    publishReportFilters("timeline", [filter({ sourceId: "t-1", sourceRef: null, field: "Time.Date", includedKeys: ["2024-01-01"] })]);

    publishReportFilters("slicer", []);

    expect(resolvePageBase("p1", "conn-a").filters.map((f) => f.field)).toEqual(["Time.Date"]);
  });

  it("an EMPTY kept list is a filter (nothing passes), not the absence of one", () => {
    const seen = listen();
    publishReportFilters("slicer", [filter({ includedKeys: [] })]);

    expect(resolvePageBase("p1", "conn-a").filters).toEqual([
      { field: "Geo.Region", includedKeys: [], level: 1, from: "Slicer_Region" },
    ]);
    expect(seen).toHaveLength(1);
  });

  it("holds a copy: a publisher mutating its array afterwards changes nothing", () => {
    const keys = ["East"];
    publishReportFilters("slicer", [filter({ includedKeys: keys })]);
    keys.push("West");

    expect(resolvePageBase("p1", "conn-a").filters[0].includedKeys).toEqual(["East"]);
  });

  it("drops a filter that cannot be addressed rather than holding a filter nothing can match", () => {
    publishReportFilters("slicer", [
      filter({ scope: { kind: "page", sheetId: "" } }),
      filter({ sourceId: "s-2", connectionId: "" }),
      filter({ sourceId: "s-3", field: "" }),
      filter({ sourceId: "s-4", scope: { kind: "pages", sheetIds: [] } }),
      filter({ sourceId: "s-5", scope: { kind: "visuals", targets: [] } }),
      filter({ sourceId: "s-6", scope: { kind: "visuals", targets: [{ kind: "control" as "chart", id: "x" }] } }),
    ]);

    expect(getReportFilters()).toEqual([]);
  });

  it("a throwing listener does not keep the next one stale; unsubscribe stops delivery", () => {
    cleanups.push(
      onReportFiltersChange(() => {
        throw new Error("boom");
      }),
    );
    const seen: ReportFiltersChange[] = [];
    const off = onReportFiltersChange((c) => seen.push(c));
    const warn = console.warn;
    console.warn = () => {};
    try {
      publishReportFilters("slicer", [filter()]);
      off();
      publishReportFilters("slicer", []);
    } finally {
      console.warn = warn;
    }

    expect(seen).toHaveLength(1);
  });

  it("orders the answer by publisher, then source id, then field (a query is the same text every time)", () => {
    publishReportFilters("timeline", [filter({ sourceId: "t-1", sourceRef: null, field: "Time.Date", includedKeys: ["d"] })]);
    publishReportFilters("slicer", [
      filter({ sourceId: "s-2", sourceRef: slicerRef("s-2"), field: "Geo.City", includedKeys: ["c"] }),
      filter({ sourceId: "s-1", field: "Geo.Region", includedKeys: ["r"] }),
      filter({ sourceId: "s-1", field: "Geo.Country", includedKeys: ["k"] }),
    ]);

    expect(fieldsOf(resolveFiltersFor("p1", target(chart("c")), "conn-a"))).toEqual([
      "Geo.Country=k",
      "Geo.Region=r",
      "Geo.City=c",
      "Time.Date=d",
    ]);
  });

  it("carries a pinned level through", () => {
    publishReportFilters("slicer", [filter({ filterLevel: 3 })]);
    expect(resolveFiltersFor("p1", target(chart("c")), "conn-a").filters[0].level).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The scope matrix: page / pages / all / visuals x target
// ---------------------------------------------------------------------------

describe("the scope matrix", () => {
  const cases: Array<[string, ReportFilterInput["scope"], Array<[string, VisualRef, boolean]>]> = [
    ["page", { kind: "page", sheetId: "p1" }, [["p1", chart("a"), true], ["p2", chart("b"), false]]],
    [
      "pages",
      { kind: "pages", sheetIds: ["p1", "p3"] },
      [["p1", chart("a"), true], ["p2", chart("b"), false], ["p3", pivot("c"), true]],
    ],
    ["all", { kind: "all" }, [["p1", chart("a"), true], ["p2", slicerRef("x"), true], ["p3", pivot("c"), true]]],
    [
      "visuals",
      { kind: "visuals", targets: [chart("a"), pivot("c")] },
      [["p1", chart("a"), true], ["p1", chart("b"), false], ["p3", pivot("c"), true], ["p3", chart("c"), false]],
    ],
  ];

  for (const [name, scope, rows] of cases) {
    it(`${name} scope reaches exactly its targets`, () => {
      publishReportFilters("ribbon", [ribbon(scope)]);
      for (const [page, ref, reached] of rows) {
        expect(fieldsOf(resolveFiltersFor(page, target(ref), "conn-a")), `${page} ${ref.kind}:${ref.id}`).toEqual(
          reached ? ["Time.Year=2024"] : [],
        );
        // Another model is never reached.
        expect(resolveFiltersFor(page, target(ref), "conn-b").filters).toEqual([]);
      }
    });
  }

  it("the page base holds page / pages / all scopes and never a visuals scope", () => {
    publishReportFilters("ribbon", [
      ribbon({ kind: "visuals", targets: [chart("a")] }, { sourceId: "rf-v", field: "T.V" }),
      ribbon({ kind: "all" }, { sourceId: "rf-all", field: "T.A" }),
      ribbon({ kind: "pages", sheetIds: ["p1"] }, { sourceId: "rf-p", field: "T.P" }),
    ]);
    expect(resolvePageBase("p1", "conn-a").filters.map((f) => f.field)).toEqual(["T.A", "T.P"]);
    expect(resolvePageBase("p2", "conn-a").filters.map((f) => f.field)).toEqual(["T.A"]);
  });

  it("an all-pages change is announced as page \"*\"; a visuals change names its targets", () => {
    const seen = listen();
    publishReportFilters("ribbon", [ribbon({ kind: "all" })]);
    publishReportFilters("ribbon", [ribbon({ kind: "visuals", targets: [chart("a")] })]);
    expect(seen).toEqual([
      { pages: [{ sheetId: "*", connectionId: "conn-a" }], targets: [] },
      { pages: [{ sheetId: "*", connectionId: "conn-a" }], targets: [chart("a")] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

describe("interactions", () => {
  it("a ribbon filter (sourceRef null) ignores interactions", () => {
    publishReportFilters("ribbon", [ribbon({ kind: "page", sheetId: "p1" })]);
    publishPageInteractions("p1", {
      defaultMode: "filter",
      pairs: [{ source: slicerRef("rf-1"), target: chart("a"), mode: "none" }],
    });
    expect(fieldsOf(resolveFiltersFor("p1", target(chart("a")), "conn-a"))).toEqual(["Time.Year=2024"]);
    expect(interactionFor("p1", null, target(chart("a")), false)).toBe("filter");
  });

  it("a slicer with an explicit none pair is dropped for THAT target only", () => {
    publishReportFilters("slicer", [filter()]);
    publishPageInteractions("p1", { pairs: [{ source: slicerRef("s-1"), target: chart("a"), mode: "none" }] });

    expect(resolveFiltersFor("p1", target(chart("a")), "conn-a").filters).toEqual([]);
    expect(fieldsOf(resolveFiltersFor("p1", target(chart("b")), "conn-a"))).toEqual(["Geo.Region=East"]);
    // The page base is target-free: it still holds the slicer.
    expect(resolvePageBase("p1", "conn-a").filters).toHaveLength(1);
  });

  it("a slicer never highlights: an explicit highlight pair is a filter", () => {
    publishReportFilters("slicer", [filter()]);
    publishPageInteractions("p1", { pairs: [{ source: slicerRef("s-1"), target: chart("a"), mode: "highlight" }] });
    const r = resolveFiltersFor("p1", target(chart("a")), "conn-a");
    expect(fieldsOf(r)).toEqual(["Geo.Region=East"]);
    expect(r.highlights).toBeNull();
  });

  it("a filter never reaches its own source object", () => {
    publishReportFilters("slicer", [filter()]);
    expect(resolveFiltersFor("p1", target(slicerRef("s-1"), false), "conn-a").filters).toEqual([]);
  });

  it("defaults: explicit pair wins; slicer filters; visual gives defaultMode ?? highlight; defaultMode never yields none", () => {
    const t = target(chart("a"));
    expect(interactionFor("p1", chart("bar"), t, false)).toBe("highlight");
    expect(interactionFor("p1", slicerRef("s"), t, true)).toBe("filter");

    publishPageInteractions("p1", { defaultMode: "filter", pairs: [] });
    expect(interactionFor("p1", chart("bar"), t, false)).toBe("filter");
    // defaultMode applies to VISUAL sources only: a slicer filters anyway.
    expect(interactionFor("p1", slicerRef("s"), t, true)).toBe("filter");

    publishPageInteractions("p1", { defaultMode: "none" as "filter", pairs: [] });
    expect(interactionFor("p1", chart("bar"), t, false)).toBe("highlight");

    publishPageInteractions("p1", {
      defaultMode: "filter",
      pairs: [{ source: chart("bar"), target: chart("a"), mode: "highlight" }],
    });
    expect(interactionFor("p1", chart("bar"), t, false)).toBe("highlight");
    // ...on another page the pair does not exist.
    expect(interactionFor("p2", chart("bar"), t, false)).toBe("highlight");
  });

  it("highlight is forced to filter for a target that cannot highlight", () => {
    const flat = target(chart("card"), false);
    expect(interactionFor("p1", chart("bar"), flat, false)).toBe("filter");
    publishPageInteractions("p1", { pairs: [{ source: chart("bar"), target: chart("card"), mode: "highlight" }] });
    expect(interactionFor("p1", chart("bar"), flat, false)).toBe("filter");

    setCrossFilter(selection());
    const r = resolveFiltersFor("p1", flat, "conn-a");
    expect(fieldsOf(r)).toEqual(["Geo.Region=East"]);
    expect(r.highlights).toBeNull();
    expect(r.sources).toEqual([{ name: "Revenue by region", ref: chart("bar"), mode: "filter" }]);
  });

  it("pairs are canonical: self pairs and bad modes dropped, the LAST duplicate wins", () => {
    publishPageInteractions("p1", {
      pairs: [
        { source: chart("bar"), target: chart("a"), mode: "none" },
        { source: chart("a"), target: chart("a"), mode: "none" },
        { source: chart("bar"), target: chart("b"), mode: "sideways" as "none" },
        { source: chart("bar"), target: chart("a"), mode: "filter" },
      ],
    });
    expect(interactionFor("p1", chart("bar"), target(chart("a")), false)).toBe("filter");
    expect(interactionFor("p1", chart("bar"), target(chart("b")), false)).toBe("highlight");
  });
});

// ---------------------------------------------------------------------------
// Cross-filter selections
// ---------------------------------------------------------------------------

describe("cross-filter selections", () => {
  it("the target's OWN selection is dropped", () => {
    setCrossFilter(selection());
    expect(resolveFiltersFor("p1", target(chart("bar")), "conn-a")).toEqual({
      filters: [],
      tupleFilters: [],
      highlights: null,
      sources: [],
    });
    expect(resolveFiltersFor("p1", target(chart("other")), "conn-a").highlights?.filters).toEqual([
      { field: "Geo.Region", includedKeys: ["East"], level: 1, from: "Revenue by region" },
    ]);
  });

  it("only the selection's own page and connection", () => {
    setCrossFilter(selection());
    expect(resolveFiltersFor("p2", target(chart("x")), "conn-a").highlights).toBeNull();
    expect(resolveFiltersFor("p1", target(chart("x")), "conn-b").highlights).toBeNull();
  });

  it("highlight-mode selections go to highlights; filter-mode to filters; none drops", () => {
    setCrossFilter(selection());
    setCrossFilter(selection({ source: chart("pie"), sourceName: "Share", fields: ["Time.Year"], tuples: [["2024"]] }));
    publishPageInteractions("p1", {
      pairs: [
        { source: chart("pie"), target: chart("x"), mode: "filter" },
        { source: chart("bar"), target: chart("y"), mode: "none" },
      ],
    });

    const x = resolveFiltersFor("p1", target(chart("x")), "conn-a");
    expect(fieldsOf(x)).toEqual(["Time.Year=2024"]);
    expect(x.highlights?.filters.map((f) => f.field)).toEqual(["Geo.Region"]);
    expect(x.sources.map((s) => `${s.name}:${s.mode}`)).toEqual(["Revenue by region:highlight", "Share:filter"]);

    const y = resolveFiltersFor("p1", target(chart("y")), "conn-a");
    expect(y.filters).toEqual([]);
    expect(y.highlights?.filters.map((f) => f.field)).toEqual(["Time.Year"]);
  });

  it("defaultMode \"filter\" turns a visual source's default into a filter (never none)", () => {
    setCrossFilter(selection());
    publishPageInteractions("p1", { defaultMode: "filter", pairs: [] });
    const r = resolveFiltersFor("p1", target(chart("x")), "conn-a");
    expect(fieldsOf(r)).toEqual(["Geo.Region=East"]);
    expect(r.highlights).toBeNull();
  });

  it("a slicer-kind selection source filters (slicers never highlight)", () => {
    setCrossFilter(selection({ source: slicerRef("sl"), sourceName: "Slicer" }));
    const r = resolveFiltersFor("p1", target(chart("x")), "conn-a");
    expect(fieldsOf(r)).toEqual(["Geo.Region=East"]);
    expect(r.highlights).toBeNull();
  });

  it("a RECTANGULAR multi-field selection is one IN filter per field", () => {
    setCrossFilter(
      selection({
        fields: ["Geo.Region", "Time.Year"],
        tuples: [
          ["East", "2023"],
          ["East", "2024"],
          ["West", "2023"],
          ["West", "2024"],
        ],
      }),
    );
    publishPageInteractions("p1", { defaultMode: "filter", pairs: [] });
    const r = resolveFiltersFor("p1", target(chart("x")), "conn-a");
    expect(fieldsOf(r)).toEqual(["Geo.Region=East|West", "Time.Year=2023|2024"]);
    expect(r.tupleFilters).toEqual([]);
  });

  it("a NON-rectangular selection is one tuple filter (exact OR-of-AND)", () => {
    setCrossFilter(
      selection({
        fields: ["Geo.Region", "Time.Year"],
        tuples: [
          ["East", "2023"],
          ["West", "2024"],
        ],
      }),
    );
    publishPageInteractions("p1", { defaultMode: "filter", pairs: [] });
    const r = resolveFiltersFor("p1", target(chart("x")), "conn-a");
    expect(r.filters).toEqual([]);
    expect(r.tupleFilters).toEqual([
      {
        fields: ["Geo.Region", "Time.Year"],
        tuples: [
          ["East", "2023"],
          ["West", "2024"],
        ],
        from: "Revenue by region",
      },
    ]);
    // As a highlight it lands in highlights.tupleFilters.
    publishPageInteractions("p1", null);
    expect(resolveFiltersFor("p1", target(chart("x")), "conn-a").highlights?.tupleFilters).toHaveLength(1);
  });

  it("isRectangular", () => {
    expect(isRectangular({ fields: ["a"], tuples: [["1"], ["2"]] })).toBe(true);
    expect(isRectangular({ fields: ["a", "b"], tuples: [["1", "x"]] })).toBe(true);
    expect(isRectangular({ fields: ["a", "b"], tuples: [["1", "x"], ["2", "y"]] })).toBe(false);
    expect(
      isRectangular({
        fields: ["a", "b"],
        tuples: [
          ["1", "x"],
          ["1", "y"],
          ["2", "x"],
        ],
      }),
    ).toBe(false);
    // A repeated tuple does not fake a full product.
    expect(
      isRectangular({
        fields: ["a", "b"],
        tuples: [
          ["1", "x"],
          ["1", "x"],
          ["2", "y"],
          ["2", "y"],
        ],
      }),
    ).toBe(false);
  });

  it("include \"visualSelectionsOnly\" leaves page and ribbon filters to the backend route", () => {
    publishReportFilters("slicer", [filter()]);
    publishReportFilters("ribbon", [ribbon({ kind: "all" })]);
    setCrossFilter(selection({ source: chart("pie"), fields: ["Time.Quarter"], tuples: [["Q1"]] }));
    const r = resolveFiltersFor("p1", target(pivot("pv"), false), "conn-a", { include: "visualSelectionsOnly" });
    expect(fieldsOf(r)).toEqual(["Time.Quarter=Q1"]);
    expect(r.sources.map((s) => s.name)).toEqual(["Revenue by region"]);
  });

  it("the blank member is key \"\" and travels as such", () => {
    setCrossFilter(selection({ tuples: [[""], ["East"]] }));
    publishPageInteractions("p1", { defaultMode: "filter", pairs: [] });
    expect(resolveFiltersFor("p1", target(chart("x")), "conn-a").filters[0].includedKeys).toEqual(["", "East"]);
  });

  it("Ctrl toggles a datum in and out; the last one out clears the selection", () => {
    setCrossFilter(selection({ fields: ["Geo.Region", "Time.Year"], tuples: [["East", "2024"]] }));
    // Coordinates in any order are aligned to the selection's fields.
    addToCrossFilter(chart("bar"), [
      { field: "Time.Year", key: "2023" },
      { field: "Geo.Region", key: "West" },
    ]);
    expect(getCrossFilters("p1")[0].tuples).toEqual([
      ["East", "2024"],
      ["West", "2023"],
    ]);
    addToCrossFilter(chart("bar"), [
      { field: "Geo.Region", key: "East" },
      { field: "Time.Year", key: "2024" },
    ]);
    expect(getCrossFilters("p1")[0].tuples).toEqual([["West", "2023"]]);
    addToCrossFilter(chart("bar"), [
      { field: "Geo.Region", key: "West" },
      { field: "Time.Year", key: "2023" },
    ]);
    expect(isCrossFilterSource(chart("bar"))).toBe(false);
  });

  it("Ctrl over a different field set replaces the selection; with no selection it does nothing", () => {
    setCrossFilter(selection());
    addToCrossFilter(chart("bar"), [{ field: "Time.Year", key: "2024" }]);
    expect(getCrossFilters("p1")).toEqual([selection({ fields: ["Time.Year"], tuples: [["2024"]] })]);
    addToCrossFilter(chart("nobody"), [{ field: "Time.Year", key: "2024" }]);
    expect(isCrossFilterSource(chart("nobody"))).toBe(false);
  });

  it("a malformed selection is refused, never half-held", () => {
    expect(() => setCrossFilter(selection({ tuples: [["East", "extra"]] }))).toThrow(/one member key per field/);
    expect(() => setCrossFilter(selection({ pageSheetId: "" }))).toThrow(/sheet id/);
    expect(() => setCrossFilter(selection({ fields: ["a", "a"], tuples: [["1", "2"]] }))).toThrow(/twice/);
    expect(() => setCrossFilter(selection({ source: { kind: "control" as "chart", id: "x" } }))).toThrow(/source visual/);
    expect(getCrossFilters()).toEqual([]);
  });

  it("an empty tuple list clears; duplicates collapse", () => {
    setCrossFilter(selection({ tuples: [["East"], ["East"], ["West"]] }));
    expect(getCrossFilters()[0].tuples).toEqual([["East"], ["West"]]);
    setCrossFilter(selection({ tuples: [] }));
    expect(getCrossFilters()).toEqual([]);
  });

  it("prune keeps live tuples; clear by source and by page", () => {
    setCrossFilter(selection({ tuples: [["East"], ["Gone"]] }));
    setCrossFilter(selection({ source: chart("other"), pageSheetId: "p2" }));
    pruneCrossFilter(chart("bar"), (_fields, t) => t[0] !== "Gone");
    expect(getCrossFilters("p1")[0].tuples).toEqual([["East"]]);
    pruneCrossFilter(chart("bar"), () => false);
    expect(getCrossFilters("p1")).toEqual([]);

    setCrossFilter(selection());
    clearCrossFilters("p1");
    expect(getCrossFilters().map((s) => s.source.id)).toEqual(["other"]);
    clearCrossFilter(chart("other"));
    expect(getCrossFilters()).toEqual([]);
  });

  it("File > New and File > Open clear every selection (through startReportFilters)", () => {
    const stop = startReportFilters();
    cleanups.push(stop);
    setCrossFilter(selection());
    emitAppEvent(AppEvents.AFTER_NEW);
    expect(getCrossFilters()).toEqual([]);
    setCrossFilter(selection());
    emitAppEvent(AppEvents.AFTER_OPEN);
    expect(getCrossFilters()).toEqual([]);
    // Published filters are NOT view state: a publisher owns them.
    publishReportFilters("slicer", [filter()]);
    emitAppEvent(AppEvents.AFTER_NEW);
    expect(getReportFilters()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Change events name only moved pages and targets
// ---------------------------------------------------------------------------

describe("change events", () => {
  it("a selection moves its page; a same selection again is silent", () => {
    const seen = listen();
    setCrossFilter(selection());
    setCrossFilter(selection({ tuples: [["East"]] }));
    expect(seen).toEqual([{ pages: [{ sheetId: "p1", connectionId: "conn-a" }], targets: [] }]);
  });

  it("a pair for a source with nothing selected moves nothing; with a selection it names its target", () => {
    const seen = listen();
    publishPageInteractions("p1", { pairs: [{ source: chart("bar"), target: chart("a"), mode: "none" }] });
    expect(seen).toEqual([]);

    setCrossFilter(selection());
    seen.length = 0;
    publishPageInteractions("p1", { pairs: [{ source: chart("bar"), target: chart("a"), mode: "filter" }] });
    expect(seen).toEqual([{ pages: [], targets: [chart("a")] }]);
  });

  it("a slicer's pair names its target (the slicer is an active source by publishing)", () => {
    publishReportFilters("slicer", [filter()]);
    const seen = listen();
    publishPageInteractions("p1", { pairs: [{ source: slicerRef("s-1"), target: chart("a"), mode: "none" }] });
    expect(seen).toEqual([{ pages: [], targets: [chart("a")] }]);
  });

  it("a defaultMode change moves the pages holding selections, and nothing on a page without any", () => {
    const seen = listen();
    publishPageInteractions("p2", { defaultMode: "filter", pairs: [] });
    expect(seen).toEqual([]);
    setCrossFilter(selection());
    seen.length = 0;
    publishPageInteractions("p1", { defaultMode: "filter", pairs: [] });
    expect(seen).toEqual([{ pages: [{ sheetId: "p1", connectionId: "conn-a" }], targets: [] }]);
  });

  it("clearing nothing is silent", () => {
    const seen = listen();
    clearCrossFilters();
    clearCrossFilter(chart("none"));
    publishReportFilters("slicer", []);
    publishPageInteractions("p3", null);
    expect(seen).toEqual([]);
  });
});
