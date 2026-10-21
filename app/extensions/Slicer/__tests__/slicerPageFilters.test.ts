//! FILENAME: app/extensions/Slicer/__tests__/slicerPageFilters.test.ts
// PURPOSE: What the Slicer extension PUBLISHES on @api/reportFilters: one
//          filter per MODEL slicer that has a selection, scoped to the slicer's
//          own page BY SHEET ID, with the slicer as its sourceRef, for the
//          model connection it carries -- and nothing else.
// CONTEXT: The chart side merges whatever is published into every
//          design-query chart of that page and model. So a pivot or table
//          slicer that published, or a cleared slicer that kept publishing,
//          would filter charts the user never connected to anything: a number
//          on a Card that is quietly wrong. "No selection" must be the absence
//          of a filter, never a list of every item (a list goes stale the
//          moment the model gains a member, and then hides it).

import { describe, it, expect, vi, afterEach } from "vitest";
import { resolvePageBase } from "@api/reportFilters";
import type { ReportPagesSnapshot } from "@api/reportPages";
import type { Slicer } from "../lib/slicerTypes";

let slicers: Slicer[] = [];
vi.mock("../lib/slicerStore", () => ({
  getAllSlicers: () => slicers,
}));

// The page list: sheet 2 is "page-2" until a test moves it. Listeners are
// kept so a test can announce a page-list change the way @api/reportPages does.
const pages = vi.hoisted(() => ({
  ids: new Map<number, string>([[2, "page-2"]]),
  listeners: new Set<(s: unknown) => void>(),
}));
vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  startReportPages: () => () => {},
  getReportPagesSnapshot: () => ({ pages: [], sheetIdByIndex: pages.ids, activeIndex: 2, version: 1 }),
  onReportPagesChanged: (cb: (s: ReportPagesSnapshot) => void) => {
    pages.listeners.add(cb as (s: unknown) => void);
    return () => pages.listeners.delete(cb as (s: unknown) => void);
  },
}));

const IDS = new Map([[2, "page-2"]]);
const kept = (sheetId = "page-2") => resolvePageBase(sheetId, "conn-a").filters.map((f) => f.includedKeys);

import {
  installSlicerPageFilterPublisher,
  modelSlicerPageFilters,
  publishSlicerPageFilters,
} from "../lib/slicerPageFilters";
import { SlicerEvents } from "../lib/slicerEvents";
import { selectionAfterItemClick } from "../lib/slicerClickSelection";

function slicer(over: Partial<Slicer> = {}): Slicer {
  return {
    id: "s-1",
    name: "Slicer_Region",
    sheetIndex: 2,
    sourceType: "biConnection",
    cacheSourceId: "conn-a",
    fieldName: "Geo.Region",
    selectedItems: ["East"],
    filterLevel: 1,
    connectedSources: [{ sourceType: "biConnection", sourceId: "conn-a" }],
    ...over,
  } as Slicer;
}

afterEach(() => {
  slicers = [];
  pages.ids = new Map([[2, "page-2"]]);
  publishSlicerPageFilters();
});

describe("modelSlicerPageFilters", () => {
  it("publishes a model slicer's selection on its own page and model", () => {
    expect(modelSlicerPageFilters([slicer({ filterLevel: 3 })], IDS)).toEqual([
      {
        sourceId: "s-1",
        sourceName: "Slicer_Region",
        sourceRef: { kind: "slicer", id: "s-1" },
        scope: { kind: "page", sheetId: "page-2" },
        connectionId: "conn-a",
        field: "Geo.Region",
        includedKeys: ["East"],
        filterLevel: 3,
      },
    ]);
  });

  it("publishes nothing for a slicer with no selection (every item)", () => {
    expect(modelSlicerPageFilters([slicer({ selectedItems: null })], IDS)).toEqual([]);
  });

  it("publishes an EMPTY selection as a filter that keeps nothing", () => {
    expect(modelSlicerPageFilters([slicer({ selectedItems: [] })], IDS)[0].includedKeys).toEqual([]);
  });

  it("publishes nothing for a slicer whose sheet has no id in the page list yet (never a guessed page)", () => {
    expect(modelSlicerPageFilters([slicer({ sheetIndex: 5 })], IDS)).toEqual([]);
  });

  it("publishes nothing for a table or pivot slicer -- neither speaks for a model", () => {
    expect(
      modelSlicerPageFilters([
        slicer({ id: "t", sourceType: "table", connectedSources: [{ sourceType: "table", sourceId: "tbl-1" }] }),
        slicer({ id: "p", sourceType: "pivot", connectedSources: [{ sourceType: "pivot", sourceId: "pv-1" }] }),
      ], IDS),
    ).toEqual([]);
  });

  it("one filter per model connection, a repeated connection collapsing", () => {
    const out = modelSlicerPageFilters([
      slicer({
        connectedSources: [
          { sourceType: "biConnection", sourceId: "conn-a" },
          { sourceType: "biConnection", sourceId: "conn-a" },
        ],
      }),
    ], IDS);
    expect(out).toHaveLength(1);
  });

  it("hands the seam a copy of the selection (the store mutates its slicers in place)", () => {
    const s = slicer();
    const [published] = modelSlicerPageFilters([s], IDS);
    s.selectedItems!.push("West");
    expect(published.includedKeys).toEqual(["East"]);
  });
});

describe("page filters speak member KEYS, never labels (P2 S7)", () => {
  it("a click on the item SHOWN as 15.01.2024 publishes includedKeys [\"2024-01-15\"]", () => {
    const items = [
      { key: "2024-01-15", label: "15.01.2024", selected: true, hasData: true },
      { key: "2024-02-01", label: "01.02.2024", selected: true, hasData: true },
      { key: "", label: "(Blank)", selected: true, hasData: true },
    ];
    const s = slicer({ fieldName: "Sales.Date", selectedItems: null });
    // The renderer's hit test names the clicked item by its KEY.
    const selected = selectionAfterItemClick(s, items, items[0].key, false);
    expect(selected).toEqual(["2024-01-15"]);
    const [filter] = modelSlicerPageFilters([slicer({ fieldName: "Sales.Date", selectedItems: selected as string[] })], IDS);
    expect(filter.includedKeys).toEqual(["2024-01-15"]);
    expect(filter.includedKeys).not.toContain("15.01.2024");
  });

  it("the blank member is published as its key \"\"", () => {
    const [filter] = modelSlicerPageFilters([slicer({ selectedItems: ["East", ""] })], IDS);
    expect(filter.includedKeys).toEqual(["East", ""]);
  });
});

describe("installSlicerPageFilterPublisher", () => {
  it("publishes now, follows the store's announcements, and withdraws on cleanup", () => {
    slicers = [slicer()];
    const cleanup = installSlicerPageFilterPublisher();
    expect(kept()).toEqual([["East"]]);

    slicers = [slicer({ selectedItems: ["West"] })];
    window.dispatchEvent(new CustomEvent(SlicerEvents.SLICER_SELECTION_CHANGED, { detail: {} }));
    expect(kept()).toEqual([["West"]]);

    slicers = [slicer({ selectedItems: null })];
    window.dispatchEvent(new Event(SlicerEvents.SLICER_DATA_CHANGED));
    expect(kept()).toEqual([]);

    slicers = [slicer()];
    window.dispatchEvent(new Event(SlicerEvents.SLICER_DATA_CHANGED));
    cleanup();
    expect(kept()).toEqual([]);

    // After cleanup the announcements are no longer heard.
    window.dispatchEvent(new Event(SlicerEvents.SLICER_DATA_CHANGED));
    expect(kept()).toEqual([]);
  });

  it("republishes on a page-list change: a sheet whose id arrives late, or a sheet that MOVED", () => {
    pages.ids = new Map();
    slicers = [slicer()];
    const cleanup = installSlicerPageFilterPublisher();
    // No id for sheet 2 yet: nothing is published under a guessed page.
    expect(kept()).toEqual([]);

    pages.ids = new Map([[2, "page-2"]]);
    for (const l of [...pages.listeners]) l({});
    expect(kept()).toEqual([["East"]]);

    // The sheet moved to index 2 -> a different sheet is now at index 2: the
    // filter follows the SHEET (its id), never the index.
    pages.ids = new Map([[2, "other-sheet"]]);
    for (const l of [...pages.listeners]) l({});
    expect(kept()).toEqual([]);
    expect(kept("other-sheet")).toEqual([["East"]]);

    cleanup();
    expect(pages.listeners.size).toBe(0);
  });
});
