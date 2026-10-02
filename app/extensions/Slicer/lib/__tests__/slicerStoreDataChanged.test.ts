//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerStoreDataChanged.test.ts
// PURPOSE: The slicer store says when what it holds CHANGED -- the slicer list
//          or a slicer's items -- by `SlicerEvents.SLICER_DATA_CHANGED`, fired
//          AFTER the cache holds the new state. The keyboard inside a slicer
//          (lib/slicerKeys.ts) listens, so a refresh that leaves its focus
//          nothing to stand on ends the focus at once -- announced -- instead
//          of silently at the next key (M8 review, findings 4 and 9).
// CONTEXT: Driven through the real store; only the backend is a double (the
//          slicerStoreGrip.test.ts harness).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Slicer, SlicerItem } from "../slicerTypes";

const backend = vi.hoisted(() => ({
  slicers: [] as Array<Record<string, unknown>>,
  items: [] as Array<{ value: string; selected: boolean; hasData: boolean }>,
  /** Reading a slicer's items fails (a backend error that is not the BI fallback's). */
  failItems: false,
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("../slicer-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAllSlicers: async () => backend.slicers,
  getSlicerItems: async () => {
    if (backend.failItems) throw new Error("items unavailable");
    return backend.items;
  },
}));

import * as store from "../slicerStore";
import { SlicerEvents } from "../slicerEvents";

function slicer(id: string): Partial<Slicer> {
  return {
    id,
    name: `Slicer ${id}`,
    sheetIndex: 0,
    x: 40,
    y: 40,
    width: 160,
    height: 176,
    sourceType: "pivot",
    cacheSourceId: "pivot-1",
    fieldName: "Product",
    selectedItems: null,
    showHeader: true,
  };
}

/** What the store held at each SLICER_DATA_CHANGED: the slicer ids and a's item values. */
let seen: Array<{ ids: string[]; items: string[] | null }> = [];
const onChanged = (): void => {
  seen.push({
    ids: store.getAllSlicers().map((s) => s.id),
    items: store.getCachedItems("a")?.map((i: SlicerItem) => i.value) ?? null,
  });
};

beforeEach(() => {
  store.resetStore();
  backend.slicers = [slicer("a")];
  backend.items = [{ value: "North", selected: true, hasData: true }];
  backend.failItems = false;
  seen = [];
  window.addEventListener(SlicerEvents.SLICER_DATA_CHANGED, onChanged);
});

afterEach(() => {
  window.removeEventListener(SlicerEvents.SLICER_DATA_CHANGED, onChanged);
  vi.restoreAllMocks();
});

describe("the slicer store announces every change of what it holds", () => {
  it("a re-read of a slicer's ITEMS fires once, after the cache holds them", async () => {
    await store.refreshCache();
    seen = [];
    backend.items = [];
    await store.refreshSlicerItems("a");
    expect(seen, "the items changed and nobody was told: a keyboard focus on them goes stale silently").toEqual([
      { ids: ["a"], items: [] },
    ]);
  });

  it("a re-read of the slicer LIST fires with the new list already in place", async () => {
    await store.refreshCache();
    seen = [];
    backend.slicers = [slicer("a"), slicer("b")];
    await store.refreshCache();
    expect(seen.length, "a refresh of the slicer list fired nothing").toBeGreaterThan(0);
    expect(seen[0].ids, "the event fired BEFORE the cache held the new list").toEqual(["a", "b"]);
  });

  it("the LIST re-read announces itself: even when every items read FAILS, the new list is announced", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await store.refreshCache();
    seen = [];
    backend.slicers = [slicer("a"), slicer("b")];
    backend.failItems = true;
    await store.refreshCache();
    expect(seen, "the list changed and nobody was told (only an items read announced, and none succeeded)").toEqual([
      { ids: ["a", "b"], items: ["North"] },
    ]);
  });

  it("resetting the store (a new document) fires too", () => {
    store.resetStore();
    expect(seen).toEqual([{ ids: [], items: null }]);
  });
});
