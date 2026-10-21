//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotCrossFilterView.test.ts
// PURPOSE: A canvas BI pivot box as a cross-filter TARGET (P4 S7,
//          lib/pivotCrossFilterView.ts), over the REAL @api/reportFilters seam
//          and the box catalogue the region sync feeds:
//            - no selection on the page: no filtered view is asked for;
//            - another visual's selection: `run_bi_pivot_filtered_view` is
//              invoked with the selection's KEYS (split against the model's
//              table names, a dotted table included), the box SHOWS the
//              filtered view and "Filtered by <source>", and the REAL view in
//              pivotViewStore is untouched;
//            - a non-rectangular selection travels as a tuple filter;
//            - an interaction pair set to None: nothing is asked;
//            - the box's OWN selection never filters it;
//            - a refusal keeps the REAL view and shows "Not filtered by ...";
//            - a new REAL view re-fetches; the same question is never re-sent;
//            - clearing the selection drops the filtered view;
//            - a pivot delete clears the box's own selection;
//            - the @api/modelVisuals provider lists the box with its roles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const toast = vi.hoisted(() => vi.fn());
const appLocale = vi.hoisted(() => ({ id: "en-US" }));

vi.mock("@api/locale", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/locale")>();
  return { ...real, getAppLocale: () => ({ ...real.getAppLocale(), localeId: appLocale.id }) };
});

vi.mock("@api", () => ({ showToast: toast }));

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ zoom: 1, surface: "canvas", sheetContext: { activeSheetIndex: 2 } }),
}));

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  startReportPages: () => () => {},
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

import {
  clearCrossFilters,
  getCrossFilters,
  publishPageInteractions,
  setCrossFilter,
  type CrossFilterSelection,
} from "@api/reportFilters";
import { listModelVisuals } from "@api/modelVisuals";
import { AppEvents } from "@api/events";
import { pivotBackend } from "../pivotBackend";
import { deleteCachedPivotView, getCachedPivotView, setCachedPivotView } from "../pivotViewStore";
import {
  PIVOT_FILTERED_VIEW_COMMAND,
  buildFilteredViewRequest,
  filteredViewNote,
  getDisplayedPivotView,
  getPivotCrossFilterBadge,
  installPivotCrossFilter,
  isShowingFilteredView,
  notePivotDeleted,
  resetPivotCrossFilterViews,
} from "../pivotCrossFilterView";
import { RANGE_PIVOT_REASON } from "../pivotModelVisuals";
import { PivotEvents } from "../../../_shared/lib/pivotEvents";
import type { PivotRegionData, PivotViewResponse } from "../pivot-api";

const REGION = "Geo.Region";
const YEAR = "Sales.Fact.Year";

const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();

function view(version: number, label: string): PivotViewResponse {
  return {
    pivotId: "p1",
    version,
    rowCount: 1,
    colCount: 1,
    rowLabelColCount: 1,
    columnHeaderRowCount: 0,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: [{ viewRow: 0, rowType: "Data", depth: 0, visible: true, cells: [{ cellType: "RowHeader", value: label, backgroundStyle: "Normal" }] }],
    columns: [],
  } as unknown as PivotViewResponse;
}

const REAL = view(1, "real");
const FILTERED = view(1, "filtered");

const boxRegion = (pivotId: string, isModel = true): PivotRegionData =>
  ({
    pivotId,
    name: `Pivot ${pivotId}`,
    startRow: 0,
    startCol: 1024,
    endRow: 9,
    endCol: 1027,
    isEmpty: false,
    isModel,
    canvasFrame: { x: 0, y: 0, width: 300, height: 200 },
  }) as PivotRegionData;

function announce(regions: PivotRegionData[]): void {
  window.dispatchEvent(new CustomEvent(PivotEvents.PIVOT_REGIONS_UPDATED, { detail: { regions } }));
}

function chartSelection(tuples: string[][], fields: string[] = [REGION], id = "c1"): CrossFilterSelection {
  return {
    source: { kind: "chart", id },
    sourceName: `Chart ${id}`,
    pageSheetId: "sheet-2",
    connectionId: "conn-1",
    fields,
    tuples,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const filteredCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === PIVOT_FILTERED_VIEW_COMMAND);

let cleanups: Array<() => void> = [];

beforeEach(async () => {
  invoke.mockReset();
  toast.mockReset();
  invoke.mockImplementation(async (command) => {
    if (command === "get_pivot_bi_metadata") {
      return { connectionId: "conn-1", tables: [{ name: "Geo", columns: [] }, { name: "Sales.Fact", columns: [] }], measures: [] };
    }
    if (command === PIVOT_FILTERED_VIEW_COMMAND) return FILTERED;
    throw new Error(`unexpected ${command}`);
  });
  pivotBackend.set(invoke as never);
  clearCrossFilters();
  publishPageInteractions("sheet-2", null);
  resetPivotCrossFilterViews();
  setCachedPivotView("p1", REAL);
  cleanups = installPivotCrossFilter();
  announce([boxRegion("p1")]);
  await settle();
});

afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  clearCrossFilters();
  publishPageInteractions("sheet-2", null);
  deleteCachedPivotView("p1");
});

describe("no selection", () => {
  it("asks for no filtered view, and the box shows its real view", () => {
    expect(filteredCalls()).toEqual([]);
    expect(isShowingFilteredView("p1")).toBe(false);
    expect(getDisplayedPivotView("p1")).toBe(REAL);
    expect(getPivotCrossFilterBadge("p1")).toBeNull();
  });
});

describe("another visual's selection", () => {
  it("invokes the paint-only command with the selection's KEYS and shows the filtered view", async () => {
    setCrossFilter(chartSelection([["East"], [""]]));
    await settle();
    expect(filteredCalls()).toEqual([
      [
        PIVOT_FILTERED_VIEW_COMMAND,
        {
          request: {
            pivotId: "p1",
            pageFilterFields: [{ table: "Geo", column: "Region", includedItems: ["East", ""] }],
            tupleFilters: [],
          },
        },
      ],
    ]);
    expect(isShowingFilteredView("p1")).toBe(true);
    expect(getDisplayedPivotView("p1")).toBe(FILTERED);
    // The REAL view is untouched: everything that acts on the pivot reads it.
    expect(getCachedPivotView("p1")).toBe(REAL);
    expect(getPivotCrossFilterBadge("p1")).toEqual({ kind: "filtered", text: "Filtered by Chart c1" });
    expect(filteredViewNote("p1")).toBe("Filtered by Chart c1 -- clear the selection to change this PivotTable here");
  });

  it("a non-rectangular selection travels as a TUPLE filter, a dotted table split against the model", async () => {
    setCrossFilter(
      chartSelection(
        [
          ["East", "2024"],
          ["West", "2025"],
        ],
        [REGION, YEAR],
      ),
    );
    await settle();
    expect(filteredCalls()[0][1]).toEqual({
      request: {
        pivotId: "p1",
        pageFilterFields: [],
        tupleFilters: [
          {
            fields: [
              { table: "Geo", column: "Region" },
              { table: "Sales.Fact", column: "Year" },
            ],
            tuples: [
              ["East", "2024"],
              ["West", "2025"],
            ],
          },
        ],
      },
    });
  });

  it("an interaction pair set to None asks for nothing", async () => {
    publishPageInteractions("sheet-2", {
      pairs: [{ source: { kind: "chart", id: "c1" }, target: { kind: "pivot", id: "p1" }, mode: "none" }],
    });
    setCrossFilter(chartSelection([["East"]]));
    await settle();
    expect(filteredCalls()).toEqual([]);
    expect(isShowingFilteredView("p1")).toBe(false);
  });

  it("the box's OWN selection never filters it", async () => {
    setCrossFilter({ ...chartSelection([["East"]]), source: { kind: "pivot", id: "p1" }, sourceName: "Pivot p1" });
    await settle();
    expect(filteredCalls()).toEqual([]);
  });

  it("a selection on another page or model asks for nothing", async () => {
    setCrossFilter({ ...chartSelection([["East"]]), pageSheetId: "sheet-3" });
    setCrossFilter({ ...chartSelection([["East"]], [REGION], "c2"), connectionId: "conn-9" });
    await settle();
    expect(filteredCalls()).toEqual([]);
  });

  it("a refusal keeps the REAL view and shows the reason on the badge", async () => {
    invoke.mockImplementation(async (command) => {
      if (command === "get_pivot_bi_metadata") return { connectionId: "conn-1", tables: [{ name: "Geo", columns: [] }], measures: [] };
      throw "This PivotTable uses hierarchies, which a visual's selection cannot filter yet.";
    });
    setCrossFilter(chartSelection([["East"]]));
    await settle();
    expect(filteredCalls()).toHaveLength(1);
    expect(isShowingFilteredView("p1")).toBe(false);
    expect(getDisplayedPivotView("p1")).toBe(REAL);
    expect(getPivotCrossFilterBadge("p1")).toEqual({
      kind: "notFiltered",
      text: "Not filtered by Chart c1: This PivotTable uses hierarchies, which a visual's selection cannot filter yet.",
    });
  });

  it("a new REAL view re-fetches; the same question is never sent twice", async () => {
    setCrossFilter(chartSelection([["East"]]));
    await settle();
    expect(filteredCalls()).toHaveLength(1);
    // The same view announced again: same signature, nothing sent.
    window.dispatchEvent(new CustomEvent(PivotEvents.PIVOT_VIEW_UPDATED, { detail: { pivotId: "p1", version: 1 } }));
    await settle();
    expect(filteredCalls()).toHaveLength(1);
    // A new real view (a field change, a refresh): asked again.
    setCachedPivotView("p1", view(2, "real v2"));
    await settle();
    expect(filteredCalls()).toHaveLength(2);
  });

  it("a locale switch re-reads the filtered view (its text is written in the app locale)", async () => {
    setCrossFilter(chartSelection([["East"]]));
    await settle();
    expect(filteredCalls()).toHaveLength(1);
    appLocale.id = "de-DE";
    try {
      window.dispatchEvent(new CustomEvent(AppEvents.LOCALE_CHANGED, { detail: { localeId: "de-DE" } }));
      await settle();
      expect(filteredCalls(), "the box kept the old locale's filtered view").toHaveLength(2);
      // The real view re-fetched after the switch (same version): the question
      // is now the de-DE one, already answered, so nothing is sent again.
      window.dispatchEvent(new CustomEvent(PivotEvents.PIVOT_VIEW_UPDATED, { detail: { pivotId: "p1", version: 1 } }));
      await settle();
      expect(filteredCalls()).toHaveLength(2);
    } finally {
      appLocale.id = "en-US";
    }
  });

  it("a real view re-announced after a locale switch re-asks in the new locale", async () => {
    setCrossFilter(chartSelection([["East"]]));
    await settle();
    expect(filteredCalls()).toHaveLength(1);
    appLocale.id = "sv-SE";
    try {
      window.dispatchEvent(new CustomEvent(PivotEvents.PIVOT_VIEW_UPDATED, { detail: { pivotId: "p1", version: 1 } }));
      await settle();
      expect(filteredCalls(), "the signature ignores the locale: the old-locale view was kept").toHaveLength(2);
    } finally {
      appLocale.id = "en-US";
    }
  });

  it("clearing the selection drops the filtered view", async () => {
    setCrossFilter(chartSelection([["East"]]));
    await settle();
    expect(isShowingFilteredView("p1")).toBe(true);
    clearCrossFilters("sheet-2");
    await settle();
    expect(isShowingFilteredView("p1")).toBe(false);
    expect(getPivotCrossFilterBadge("p1")).toBeNull();
    expect(getDisplayedPivotView("p1")).toBe(REAL);
  });

  it("a range pivot box is never filtered and is listed with its reason", async () => {
    announce([boxRegion("p1"), boxRegion("p2", false)]);
    setCrossFilter(chartSelection([["East"]]));
    await settle();
    expect(filteredCalls().map(([, a]) => (a as { request: { pivotId: string } }).request.pivotId)).toEqual(["p1"]);
    const p2 = listModelVisuals().find((v) => v.ref.id === "p2");
    expect(p2).toMatchObject({ connectionId: null, role: { source: false, target: false, reason: RANGE_PIVOT_REASON } });
  });
});

describe("the provider and delete", () => {
  it("a pivot box gone from its page by any route (undo, a script) loses its selection; other pages keep theirs", async () => {
    const own = (id: string, page: string): CrossFilterSelection => ({
      source: { kind: "pivot", id },
      sourceName: `Pivot ${id}`,
      pageSheetId: page,
      connectionId: "conn-1",
      fields: [REGION],
      tuples: [["East"]],
    });
    setCrossFilter(own("p1", "sheet-2"));
    setCrossFilter(own("p9", "sheet-3"));
    setCrossFilter(chartSelection([["West"]]));
    await settle();
    // Ctrl+Z undid p1's creation: the region sync of its page no longer has it.
    announce([]);
    await settle();
    expect(
      getCrossFilters().map((s) => `${s.source.kind}:${s.source.id}`),
      "the page is still filtered by a pivot box that is gone",
    ).toEqual(["chart:c1", "pivot:p9"]);
  });

  it("lists a BI box as a source and target that cannot highlight, on its page", () => {
    const p1 = listModelVisuals({ sheetId: "sheet-2" }).find((v) => v.ref.kind === "pivot" && v.ref.id === "p1");
    expect(p1).toEqual({
      ref: { kind: "pivot", id: "p1" },
      name: "Pivot p1",
      sheetIndex: 2,
      sheetId: "sheet-2",
      connectionId: "conn-1",
      role: { source: true, target: true, canHighlight: false, reason: null },
      label: "PivotTable",
    });
  });

  it("a pivot delete clears the box's own selection and its filtered view", async () => {
    setCrossFilter({ ...chartSelection([["East"]]), source: { kind: "pivot", id: "p1" }, sourceName: "Pivot p1" });
    expect(getCrossFilters()).toHaveLength(1);
    notePivotDeleted("p1");
    expect(getCrossFilters()).toHaveLength(0);
    expect(listModelVisuals().some((v) => v.ref.id === "p1")).toBe(false);
  });
});

describe("buildFilteredViewRequest", () => {
  it("skips a field whose table the model does not have, and keeps a pinned level", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = buildFilteredViewRequest(
      "p1",
      {
        filters: [
          { field: "Gone.Thing", includedKeys: ["x"], level: 1, from: "A" },
          { field: REGION, includedKeys: ["East"], level: 3, from: "B" },
        ],
        tupleFilters: [{ fields: [REGION, "Gone.Thing"], tuples: [["East", "x"]], from: "C" }],
      },
      ["Geo"],
    );
    expect(req).toEqual({
      pivotId: "p1",
      pageFilterFields: [{ table: "Geo", column: "Region", includedItems: ["East"], level: 3 }],
      tupleFilters: [],
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(buildFilteredViewRequest("p1", { filters: [], tupleFilters: [] }, ["Geo"])).toBeNull();
    warn.mockRestore();
  });
});
