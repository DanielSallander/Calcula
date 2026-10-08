//! FILENAME: app/extensions/Slicer/__tests__/slicerPageFilters.test.ts
// PURPOSE: What the Slicer extension PUBLISHES on @api/pageFilters: one filter
//          per MODEL slicer that has a selection, on the slicer's own page,
//          for the model connection it carries -- and nothing else.
// CONTEXT: The chart side merges whatever is published into every
//          design-query chart of that page and model. So a pivot or table
//          slicer that published, or a cleared slicer that kept publishing,
//          would filter charts the user never connected to anything: a number
//          on a Card that is quietly wrong. "No selection" must be the absence
//          of a filter, never a list of every item (a list goes stale the
//          moment the model gains a member, and then hides it).

import { describe, it, expect, vi, afterEach } from "vitest";
import { getPageFilters } from "@api/pageFilters";
import type { Slicer } from "../lib/slicerTypes";

let slicers: Slicer[] = [];
vi.mock("../lib/slicerStore", () => ({
  getAllSlicers: () => slicers,
}));

import {
  installSlicerPageFilterPublisher,
  modelSlicerPageFilters,
  publishSlicerPageFilters,
} from "../lib/slicerPageFilters";
import { SlicerEvents } from "../lib/slicerEvents";

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
  publishSlicerPageFilters();
});

describe("modelSlicerPageFilters", () => {
  it("publishes a model slicer's selection on its own page and model", () => {
    expect(modelSlicerPageFilters([slicer({ filterLevel: 3 })])).toEqual([
      {
        sourceId: "s-1",
        sourceName: "Slicer_Region",
        sheetIndex: 2,
        connectionId: "conn-a",
        field: "Geo.Region",
        includedItems: ["East"],
        filterLevel: 3,
      },
    ]);
  });

  it("publishes nothing for a slicer with no selection (every item)", () => {
    expect(modelSlicerPageFilters([slicer({ selectedItems: null })])).toEqual([]);
  });

  it("publishes an EMPTY selection as a filter that keeps nothing", () => {
    expect(modelSlicerPageFilters([slicer({ selectedItems: [] })])[0].includedItems).toEqual([]);
  });

  it("publishes nothing for a table or pivot slicer -- neither speaks for a model", () => {
    expect(
      modelSlicerPageFilters([
        slicer({ id: "t", sourceType: "table", connectedSources: [{ sourceType: "table", sourceId: "tbl-1" }] }),
        slicer({ id: "p", sourceType: "pivot", connectedSources: [{ sourceType: "pivot", sourceId: "pv-1" }] }),
      ]),
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
    ]);
    expect(out).toHaveLength(1);
  });

  it("hands the seam a copy of the selection (the store mutates its slicers in place)", () => {
    const s = slicer();
    const [published] = modelSlicerPageFilters([s]);
    s.selectedItems!.push("West");
    expect(published.includedItems).toEqual(["East"]);
  });
});

describe("installSlicerPageFilterPublisher", () => {
  it("publishes now, follows the store's announcements, and withdraws on cleanup", () => {
    slicers = [slicer()];
    const cleanup = installSlicerPageFilterPublisher();
    expect(getPageFilters(2, "conn-a").map((f) => f.includedItems)).toEqual([["East"]]);

    slicers = [slicer({ selectedItems: ["West"] })];
    window.dispatchEvent(new CustomEvent(SlicerEvents.SLICER_SELECTION_CHANGED, { detail: {} }));
    expect(getPageFilters(2, "conn-a").map((f) => f.includedItems)).toEqual([["West"]]);

    slicers = [slicer({ selectedItems: null })];
    window.dispatchEvent(new Event(SlicerEvents.SLICER_DATA_CHANGED));
    expect(getPageFilters(2, "conn-a")).toEqual([]);

    slicers = [slicer()];
    window.dispatchEvent(new Event(SlicerEvents.SLICER_DATA_CHANGED));
    cleanup();
    expect(getPageFilters(2, "conn-a")).toEqual([]);

    // After cleanup the announcements are no longer heard.
    window.dispatchEvent(new Event(SlicerEvents.SLICER_DATA_CHANGED));
    expect(getPageFilters(2, "conn-a")).toEqual([]);
  });
});
