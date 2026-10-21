//! FILENAME: app/extensions/ControlsPane/lib/__tests__/filterReportPublisher.test.ts
// PURPOSE: A ribbon filter publishes ONCE on @api/reportFilters with the scope
//          its Report connections give it -- All pages, Selected pages (sheet
//          INDICES mapped to sheet ids), Selected visuals (pivots + other
//          visuals) -- publishes nothing without a selection, withdraws on
//          deactivate, and never publishes a selection the store has not yet
//          SAID (the optimistic value of a gesture still landing).
// CONTEXT: The real seam runs; the store and the page list are doubles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  filters: [] as Array<Record<string, unknown>>,
  landing: false,
  sheetIdByIndex: new Map<number, string>(),
  pageListeners: [] as Array<(s: unknown) => void>,
}));

vi.mock("../filterPaneStore", () => ({
  getAllFilters: () => mocks.filters,
  isRibbonFilterChangeLanding: () => mocks.landing,
}));

vi.mock("@api/reportPages", () => {
  const snapshot = () => ({ pages: [], sheetIdByIndex: mocks.sheetIdByIndex, activeIndex: 0, version: 1 });
  return {
    startReportPages: () => () => undefined,
    getReportPagesSnapshot: snapshot,
    onReportPagesChanged: (l: (s: unknown) => void) => {
      mocks.pageListeners.push(l);
      return () => {
        const at = mocks.pageListeners.indexOf(l);
        if (at >= 0) mocks.pageListeners.splice(at, 1);
      };
    },
    sheetIdAt: (s: { sheetIdByIndex: Map<number, string> }, i: number) => s.sheetIdByIndex.get(i) ?? null,
  };
});

import { getReportFilters } from "@api/reportFilters";
import {
  RIBBON_FILTER_PUBLISHER,
  installRibbonFilterReportPublisher,
  ribbonFilterReportFilters,
  ribbonFilterScope,
} from "../filterReportPublisher";
import { FilterPaneEvents } from "../filterPaneEvents";

function filter(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "f1",
    name: "Region",
    connectionId: "c1",
    fieldName: "Customers.Region",
    connectionMode: "workbook",
    connectedPivots: [],
    connectedSheets: [],
    selectedItems: ["East"],
    filterLevel: 1,
    order: 0,
    ...over,
  };
}

function ribbonHeld() {
  return getReportFilters().filter((f) => f.publisher === RIBBON_FILTER_PUBLISHER);
}

let stop: (() => void) | null = null;

beforeEach(() => {
  mocks.filters = [];
  mocks.landing = false;
  mocks.sheetIdByIndex = new Map([
    [0, "sheet-a"],
    [1, "sheet-b"],
  ]);
  mocks.pageListeners.length = 0;
});

afterEach(() => {
  stop?.();
  stop = null;
});

describe("ribbonFilterScope: one scope per connection mode", () => {
  const ids = new Map([
    [0, "sheet-a"],
    [2, "sheet-c"],
  ]);

  it("All pages is the 'all' scope", () => {
    expect(ribbonFilterScope({ connectionMode: "workbook", connectedPivots: ["P"], connectedSheets: [0] }, ids)).toEqual({
      kind: "all",
    });
  });

  it("Selected pages maps the persisted sheet INDICES to sheet ids, leaving out an index with no id yet", () => {
    expect(
      ribbonFilterScope({ connectionMode: "bySheet", connectedPivots: [], connectedSheets: [2, 1, 0, 2] }, ids),
    ).toEqual({ kind: "pages", sheetIds: ["sheet-c", "sheet-a"] });
  });

  it("Selected visuals names the pivots as pivot refs, then the other visuals", () => {
    expect(
      ribbonFilterScope(
        {
          connectionMode: "manual",
          connectedPivots: ["P1", "P2"],
          connectedSheets: [0],
          connectedVisuals: [{ kind: "chart", id: "7" }],
        },
        ids,
      ),
    ).toEqual({
      kind: "visuals",
      targets: [
        { kind: "pivot", id: "P1" },
        { kind: "pivot", id: "P2" },
        { kind: "chart", id: "7" },
      ],
    });
  });
});

describe("ribbonFilterReportFilters", () => {
  it("publishes ONE filter per filter with a selection, sourceRef null, its level, member keys", () => {
    const out = ribbonFilterReportFilters(
      [
        filter({ id: "f1", selectedItems: ["East", ""], filterLevel: 3 }) as never,
        filter({ id: "f2", selectedItems: null }) as never,
      ],
      new Map(),
    );
    expect(out).toEqual([
      {
        sourceId: "f1",
        sourceName: "Region",
        sourceRef: null,
        scope: { kind: "all" },
        connectionId: "c1",
        field: "Customers.Region",
        includedKeys: ["East", ""],
        filterLevel: 3,
      },
    ]);
  });

  it("an empty selection is held (keeps nothing), never dropped as 'every item'", () => {
    const out = ribbonFilterReportFilters([filter({ selectedItems: [] }) as never], new Map());
    expect(out.map((f) => f.includedKeys)).toEqual([[]]);
  });
});

describe("installRibbonFilterReportPublisher", () => {
  it("publishes each mode's scope on the seam, bySheet by sheet id", () => {
    mocks.filters = [
      filter({ id: "all", connectionMode: "workbook" }),
      filter({ id: "pages", connectionMode: "bySheet", connectedSheets: [1] }),
      filter({ id: "visuals", connectionMode: "manual", connectedPivots: ["P"], connectedVisuals: [{ kind: "chart", id: "9" }] }),
    ];
    stop = installRibbonFilterReportPublisher();
    const held = new Map(ribbonHeld().map((f) => [f.sourceId, f.scope]));
    expect(held.get("all")).toEqual({ kind: "all" });
    expect(held.get("pages")).toEqual({ kind: "pages", sheetIds: ["sheet-b"] });
    expect(held.get("visuals")).toEqual({
      kind: "visuals",
      targets: [
        { kind: "pivot", id: "P" },
        { kind: "chart", id: "9" },
      ],
    });
  });

  it("a filter with no selection publishes nothing", () => {
    mocks.filters = [filter({ selectedItems: null })];
    stop = installRibbonFilterReportPublisher();
    expect(ribbonHeld()).toEqual([]);
  });

  it("deactivate WITHDRAWS everything it published", () => {
    mocks.filters = [filter()];
    stop = installRibbonFilterReportPublisher();
    expect(ribbonHeld()).toHaveLength(1);
    stop();
    stop = null;
    expect(ribbonHeld()).toEqual([]);
  });

  it("a page whose id is not known yet is published on the next page-list change", () => {
    mocks.sheetIdByIndex = new Map();
    mocks.filters = [filter({ connectionMode: "bySheet", connectedSheets: [0] })];
    stop = installRibbonFilterReportPublisher();
    // A "pages" scope naming no page is dropped by the seam: never a guessed id.
    expect(ribbonHeld()).toEqual([]);
    mocks.sheetIdByIndex = new Map([[0, "sheet-a"]]);
    for (const l of [...mocks.pageListeners]) l({});
    expect(ribbonHeld().map((f) => f.scope)).toEqual([{ kind: "pages", sheetIds: ["sheet-a"] }]);
  });

  it("nothing is published before the selection event: a landing gesture's optimistic value is held back", () => {
    const f = filter({ selectedItems: null });
    mocks.filters = [f];
    stop = installRibbonFilterReportPublisher();
    expect(ribbonHeld()).toEqual([]);

    // The gesture sets the store optimistically and is still landing; any
    // store-wide event or page change meanwhile must not publish it.
    mocks.landing = true;
    f.selectedItems = ["West"];
    window.dispatchEvent(new CustomEvent(FilterPaneEvents.FILTER_UPDATED, { detail: f }));
    window.dispatchEvent(new CustomEvent(FilterPaneEvents.FILTERS_REFRESHED));
    for (const l of [...mocks.pageListeners]) l({});
    expect(ribbonHeld()).toEqual([]);

    // The backend step resolved: the store says it.
    mocks.landing = false;
    window.dispatchEvent(
      new CustomEvent(FilterPaneEvents.FILTER_SELECTION_CHANGED, { detail: { filterId: "f1", selectedItems: ["West"] } }),
    );
    expect(ribbonHeld().map((h) => h.includedKeys)).toEqual([["West"]]);
  });

  it("a refused gesture (rolled back without an event) never reaches the seam", () => {
    const f = filter({ selectedItems: ["East"] });
    mocks.filters = [f];
    stop = installRibbonFilterReportPublisher();
    mocks.landing = true;
    f.selectedItems = ["West"];
    for (const l of [...mocks.pageListeners]) l({});
    // Rolled back by the store's catch: no event.
    f.selectedItems = ["East"];
    mocks.landing = false;
    for (const l of [...mocks.pageListeners]) l({});
    expect(ribbonHeld().map((h) => h.includedKeys)).toEqual([["East"]]);
  });

  it("a store refresh (undo, File > New) re-reads selections and drops deleted filters", () => {
    const f = filter({ selectedItems: ["East"] });
    mocks.filters = [f];
    stop = installRibbonFilterReportPublisher();
    f.selectedItems = null; // an undo restored "every item"
    window.dispatchEvent(new CustomEvent(FilterPaneEvents.FILTERS_REFRESHED));
    expect(ribbonHeld()).toEqual([]);
    f.selectedItems = ["North"];
    window.dispatchEvent(new CustomEvent(FilterPaneEvents.FILTERS_REFRESHED));
    expect(ribbonHeld().map((h) => h.includedKeys)).toEqual([["North"]]);
    mocks.filters = [];
    window.dispatchEvent(new CustomEvent(FilterPaneEvents.FILTER_DELETED, { detail: { filterId: "f1" } }));
    expect(ribbonHeld()).toEqual([]);
  });

  it("a bare selection event (the connections Save, id only) reads the settled store", () => {
    const f = filter({ connectionMode: "workbook" });
    mocks.filters = [f];
    stop = installRibbonFilterReportPublisher();
    f.connectionMode = "manual";
    f.connectedPivots = ["P"];
    window.dispatchEvent(new CustomEvent(FilterPaneEvents.FILTER_SELECTION_CHANGED, { detail: { filterId: "f1" } }));
    expect(ribbonHeld().map((h) => h.scope)).toEqual([{ kind: "visuals", targets: [{ kind: "pivot", id: "P" }] }]);
  });
});
