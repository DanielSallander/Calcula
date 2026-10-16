//! FILENAME: app/extensions/Controls/PageNavigator/__tests__/navigatorCache.test.ts
// PURPOSE: The Page Navigator's settings cache (WP-B S5): stale-while-refetch,
//          the fresh flag the renderer refetches on, the BUG-0268 geometry rule,
//          and the ONE invalidation entry point shared with the button cache.

import { describe, it, expect, beforeEach, vi } from "vitest";

const backend = vi.hoisted(() => ({
  resolve: vi.fn<(s: number, r: number, c: number) => Promise<Record<string, string>>>(),
  redraw: vi.fn(),
}));

vi.mock("../../lib/controlApi", () => ({
  resolveControlProperties: (s: number, r: number, c: number) => backend.resolve(s, r, c),
}));
vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestOverlayRedraw: () => backend.redraw(),
}));

import {
  fetchPageNavigatorProps,
  getPageNavigatorProps,
  invalidateAllPageNavigatorCaches,
  invalidatePageNavigatorCache,
  isPageNavigatorCacheFresh,
  isPageNavigatorFetchPending,
  resetPageNavigatorCache,
} from "../navigatorCache";
import { invalidateAllFloatingButtonCaches, invalidateFloatingButtonCache } from "../../Button/floatingRenderer";
import { noteControlGeometryChanged, resetControlGeometryWriteOrder } from "../../lib/geometryWriteOrder";
import { addFloatingControl, getFloatingControl, resetFloatingStore } from "../../lib/floatingStore";

const ID = "control-0-2-3";
const ANCHOR = { sheetIndex: 0, row: 2, col: 3 };

/** A backend answer the test delivers by hand. */
function heldAnswer(): { promise: Promise<Record<string, string>>; deliver: (v: Record<string, string>) => void } {
  let deliver: (v: Record<string, string>) => void = () => {};
  const promise = new Promise<Record<string, string>>((resolve) => {
    deliver = resolve;
  });
  return { promise, deliver };
}

const tick = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  resetPageNavigatorCache();
  resetControlGeometryWriteOrder();
  resetFloatingStore();
  backend.resolve.mockReset();
  backend.redraw.mockReset();
});

describe("fetch and fresh flag", () => {
  it("a landed read fills the cache, marks it fresh and requests a redraw", async () => {
    backend.resolve.mockResolvedValue({ fill: "#123456", gap: "4" });
    expect(getPageNavigatorProps(ID)).toBeUndefined();
    expect(isPageNavigatorCacheFresh(ID)).toBe(false);
    await fetchPageNavigatorProps(ID, 0, 2, 3);
    expect(backend.resolve).toHaveBeenCalledWith(0, 2, 3);
    expect(getPageNavigatorProps(ID)).toMatchObject({ fill: "#123456", gap: 4 });
    expect(isPageNavigatorCacheFresh(ID)).toBe(true);
    expect(backend.redraw).toHaveBeenCalledTimes(1);
  });

  it("a second fetch while one is on its way makes no second read", async () => {
    const answer = heldAnswer();
    backend.resolve.mockReturnValue(answer.promise);
    const first = fetchPageNavigatorProps(ID, 0, 2, 3);
    void fetchPageNavigatorProps(ID, 0, 2, 3);
    await tick();
    expect(backend.resolve).toHaveBeenCalledTimes(1);
    expect(isPageNavigatorFetchPending(ID)).toBe(true);
    answer.deliver({ fill: "#000000" });
    await first;
    expect(isPageNavigatorFetchPending(ID)).toBe(false);
  });
});

describe("stale while refetching", () => {
  it("an invalidation keeps the old settings visible but not fresh, until the next read lands", async () => {
    backend.resolve.mockResolvedValueOnce({ fill: "#111111" });
    await fetchPageNavigatorProps(ID, 0, 2, 3);
    invalidatePageNavigatorCache(ID);
    expect(getPageNavigatorProps(ID)?.fill).toBe("#111111");
    expect(isPageNavigatorCacheFresh(ID)).toBe(false);
    backend.resolve.mockResolvedValueOnce({ fill: "#222222" });
    await fetchPageNavigatorProps(ID, 0, 2, 3);
    expect(getPageNavigatorProps(ID)?.fill).toBe("#222222");
    expect(isPageNavigatorCacheFresh(ID)).toBe(true);
  });

  it("a read that started BEFORE an invalidation is dropped when it lands", async () => {
    backend.resolve.mockResolvedValueOnce({ fill: "#111111" });
    await fetchPageNavigatorProps(ID, 0, 2, 3);
    const old = heldAnswer();
    backend.resolve.mockReturnValueOnce(old.promise);
    const oldRead = fetchPageNavigatorProps(ID, 0, 2, 3);
    await tick();
    invalidatePageNavigatorCache(ID);
    expect(isPageNavigatorFetchPending(ID), "the invalidation lets a new read start").toBe(false);
    old.deliver({ fill: "#999999" });
    await oldRead;
    expect(getPageNavigatorProps(ID)?.fill).toBe("#111111");
    expect(isPageNavigatorCacheFresh(ID)).toBe(false);
  });

  it("the button cache's entry points invalidate the navigator too", async () => {
    backend.resolve.mockResolvedValue({ fill: "#111111" });
    await fetchPageNavigatorProps(ID, 0, 2, 3);
    invalidateFloatingButtonCache(ID);
    expect(isPageNavigatorCacheFresh(ID)).toBe(false);
    await fetchPageNavigatorProps(ID, 0, 2, 3);
    expect(isPageNavigatorCacheFresh(ID)).toBe(true);
    invalidateAllFloatingButtonCaches();
    expect(isPageNavigatorCacheFresh(ID)).toBe(false);
    await fetchPageNavigatorProps(ID, 0, 2, 3);
    invalidateAllPageNavigatorCaches();
    expect(isPageNavigatorCacheFresh(ID)).toBe(false);
    expect(getPageNavigatorProps(ID)?.fill).toBe("#111111");
  });
});

describe("the geometry rule (BUG-0268)", () => {
  function addNavigator(): void {
    addFloatingControl({
      id: ID,
      sheetIndex: 0,
      row: 2,
      col: 3,
      x: 10,
      y: 20,
      width: 472,
      height: 32,
      controlType: "pageNavigator",
    } as Parameters<typeof addFloatingControl>[0]);
  }

  it("a current read writes the resolved size back into the store", async () => {
    addNavigator();
    backend.resolve.mockResolvedValue({ width: "300", height: "40" });
    await fetchPageNavigatorProps(ID, 0, 2, 3);
    expect(getFloatingControl(ID)).toMatchObject({ width: 300, height: 40 });
    expect(isPageNavigatorCacheFresh(ID)).toBe(true);
  });

  it("a read the geometry changed under is SUPERSEDED: the size is not applied and the settings stay not fresh", async () => {
    addNavigator();
    const answer = heldAnswer();
    backend.resolve.mockReturnValue(answer.promise);
    const read = fetchPageNavigatorProps(ID, 0, 2, 3);
    await tick();
    noteControlGeometryChanged(ANCHOR);
    answer.deliver({ width: "300", height: "40", fill: "#abcdef" });
    await read;
    expect(getFloatingControl(ID)).toMatchObject({ width: 472, height: 32 });
    expect(getPageNavigatorProps(ID)?.fill).toBe("#abcdef");
    expect(isPageNavigatorCacheFresh(ID)).toBe(false);
  });
});
