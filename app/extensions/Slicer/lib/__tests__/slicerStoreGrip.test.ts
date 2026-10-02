//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerStoreGrip.test.ts
// PURPOSE: A slicer asks Core for its six-dot HOVER GRIP exactly when its header
//          is HIDDEN (BUG-0258 design phase 5): with the header gone its items
//          are content and only a thin border band and the padding are frame,
//          so Core shows the grip (core/lib/floatingGrip.ts) while the slicer is
//          hovered or selected -- on a region that publishes `grip: "hover"`.
//          A slicer WITH its header moves by it and publishes no grip flag.
// CONTEXT: Driven through the real store (`refreshCache` -> `syncSlicerRegions`)
//          and the real published region list; only the backend is a double.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Slicer } from "../slicerTypes";

const backend = vi.hoisted(() => ({ slicers: [] as Array<Record<string, unknown>> }));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0 } }),
}));
vi.mock("../slicer-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAllSlicers: async () => backend.slicers,
  getSlicerItems: async () => [],
}));

import { getGridRegions, setGridRegions } from "@api/gridOverlays";
import * as store from "../slicerStore";

function slicer(id: string, showHeader: boolean): Partial<Slicer> {
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
    showHeader,
  };
}

const dataOf = (id: string) => getGridRegions().find((r) => r.id === `slicer-${id}`)?.data;

beforeEach(async () => {
  setGridRegions([]);
  store.resetStore();
});

describe("a slicer's grip flag follows its header", () => {
  it("header SHOWN: no grip flag; header HIDDEN: grip 'hover'", async () => {
    backend.slicers = [slicer("a", true), slicer("b", false)];
    await store.refreshCache();
    expect(dataOf("a"), "precondition: slicer a is published").toBeDefined();
    expect(dataOf("a"), "a slicer WITH its header asks for a grip").not.toHaveProperty("grip");
    expect(dataOf("b")).toMatchObject({ slicerId: "b", grip: "hover" });
  });

  it("re-published when the header is toggled (the region follows the cache)", async () => {
    backend.slicers = [slicer("a", true)];
    await store.refreshCache();
    expect(dataOf("a")).not.toHaveProperty("grip");
    backend.slicers = [slicer("a", false)];
    await store.refreshCache();
    expect(dataOf("a")?.grip).toBe("hover");
  });
});
