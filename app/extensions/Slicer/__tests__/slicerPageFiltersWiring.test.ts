//! FILENAME: app/extensions/Slicer/__tests__/slicerPageFiltersWiring.test.ts
// PURPOSE: The REAL `activate()` installs the page-filter publisher (@api/
//          pageFilters) and `deactivate()` withdraws what it published.
// CONTEXT: lib/__tests__-level tests pin WHAT is published; this pins the one
//          line in index.ts that makes it happen at all. Its absence is
//          silent at runtime -- every design-query chart on a canvas would
//          simply stop following the slicer beside it, and the slicer dialog
//          would still say it reaches them. (The press-wiring test is the
//          precedent for driving activate() with a fake host.)

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getPageFilters } from "@api/pageFilters";

function modelSlicerRow() {
  return {
    id: "s-model",
    name: "Slicer_Region",
    sheetIndex: 4,
    x: 0,
    y: 0,
    width: 180,
    height: 240,
    showHeader: true,
    showSelectAll: false,
    arrangement: "vertical",
    columns: 1,
    itemGap: 4,
    itemPadding: 0,
    selectedItems: ["East"],
    selectionMode: "standard",
    sourceType: "biConnection",
    cacheSourceId: "conn-a",
    fieldName: "Geo.Region",
    filterLevel: 1,
    connectedSources: [{ sourceType: "biConnection", sourceId: "conn-a" }],
  };
}

vi.mock("../lib/slicerStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshCache: vi.fn(async () => undefined),
  refreshCacheAndReapplyChangedFilters: vi.fn(async () => undefined),
  getSlicerById: (id: string) => (id === "s-model" ? modelSlicerRow() : undefined),
  getAllSlicers: () => [modelSlicerRow()],
  getCachedItems: () => undefined,
}));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));

import type { ExtensionContext } from "@api/contract";
import extension from "../index";

const context = {
  invokeBackend: vi.fn(async () => null),
  ui: { dialogs: { register: vi.fn() } },
  grid: { overlays: { register: () => () => {} } },
  events: { on: vi.fn(() => () => {}) },
} as unknown as ExtensionContext;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("the Slicer extension publishes its model slicers' page filters", () => {
  it("from activate() until deactivate()", () => {
    expect(getPageFilters(4, "conn-a")).toEqual([]);

    extension.activate(context);
    expect(getPageFilters(4, "conn-a").map((f) => [f.sourceId, f.field, f.includedItems])).toEqual([
      ["s-model", "Geo.Region", ["East"]],
    ]);

    extension.deactivate?.();
    expect(getPageFilters(4, "conn-a")).toEqual([]);
  });
});
