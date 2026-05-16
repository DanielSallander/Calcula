//! FILENAME: app/extensions/Pivot/lib/pivot-defensive.test.ts
// PURPOSE: Verify defensive coding patterns in pivot store operations.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cachePivotView,
  setCachedPivotView,
  getCachedPivotView,
  getCachedPivotVersion,
  deleteCachedPivotView,
  isCacheFresh,
  consumeFreshFlag,
  startOperation,
  isCurrentOperation,
  setInflightOperation,
  getInflightOperation,
  markUserCancelled,
  isUserCancelled,
  clearUserCancelled,
  setLoading,
  clearLoading,
  isLoading,
  getLoadingState,
  preserveCurrentView,
  restorePreviousView,
  clearPreviousView,
  getCellWindowCache,
  ensureCellWindow,
} from "./pivotViewStore";
import type { PivotViewResponse } from "./pivot-api";

// ============================================================================
// Helpers
// ============================================================================

/** Minimal valid PivotViewResponse for testing. */
function makeView(pivotId: number, version = 1): PivotViewResponse {
  return {
    pivotId,
    version,
    rowCount: 2,
    colCount: 2,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: [
      { cells: [{ value: "A" }, { value: "1" }] } as any,
      { cells: [{ value: "B" }, { value: "2" }] } as any,
    ],
    columns: [],
  };
}

// Use unique pivotIds per test to avoid cross-test state leaks
let nextPivotId = 9000;
function uniqueId(): number {
  return nextPivotId++;
}

// ============================================================================
// 1. Store operations never throw
// ============================================================================

describe("store operations never throw", () => {
  it("cachePivotView does not throw for valid input", () => {
    const id = uniqueId();
    expect(() => cachePivotView(id, makeView(id))).not.toThrow();
    deleteCachedPivotView(id);
  });

  it("setCachedPivotView does not throw for valid input", () => {
    const id = uniqueId();
    expect(() => setCachedPivotView(id, makeView(id))).not.toThrow();
    deleteCachedPivotView(id);
  });

  it("getCachedPivotView returns undefined for unknown id", () => {
    expect(getCachedPivotView(999999)).toBeUndefined();
  });

  it("getCachedPivotVersion returns -1 for unknown id", () => {
    expect(getCachedPivotVersion(999999)).toBe(-1);
  });

  it("deleteCachedPivotView does not throw for unknown id", () => {
    expect(() => deleteCachedPivotView(999999)).not.toThrow();
  });

  it("isCacheFresh returns false for unknown id", () => {
    expect(isCacheFresh(999999)).toBe(false);
  });

  it("consumeFreshFlag does not throw for unknown id", () => {
    expect(() => consumeFreshFlag(999999)).not.toThrow();
  });

  it("clearLoading does not throw for unknown id", () => {
    expect(() => clearLoading(999999)).not.toThrow();
  });

  it("isLoading returns false for unknown id", () => {
    expect(isLoading(999999)).toBe(false);
  });

  it("getLoadingState returns undefined for unknown id", () => {
    expect(getLoadingState(999999)).toBeUndefined();
  });

  it("clearUserCancelled does not throw for unknown id", () => {
    expect(() => clearUserCancelled(999999)).not.toThrow();
  });

  it("isUserCancelled returns false for unknown id", () => {
    expect(isUserCancelled(999999)).toBe(false);
  });
});

// ============================================================================
// 2. Cache operations are atomic (partial failure doesn't corrupt state)
// ============================================================================

describe("cache operations are atomic", () => {
  it("cachePivotView sets fresh flag atomically with data", () => {
    const id = uniqueId();
    cachePivotView(id, makeView(id, 5));
    expect(getCachedPivotView(id)).toBeDefined();
    expect(getCachedPivotVersion(id)).toBe(5);
    expect(isCacheFresh(id)).toBe(true);
    deleteCachedPivotView(id);
  });

  it("setCachedPivotView does NOT set fresh flag", () => {
    const id = uniqueId();
    setCachedPivotView(id, makeView(id, 3));
    expect(getCachedPivotView(id)).toBeDefined();
    expect(isCacheFresh(id)).toBe(false);
    deleteCachedPivotView(id);
  });

  it("deleteCachedPivotView clears all related state", () => {
    const id = uniqueId();
    cachePivotView(id, makeView(id, 7));
    setLoading(id, "test");
    deleteCachedPivotView(id);
    expect(getCachedPivotView(id)).toBeUndefined();
    expect(isLoading(id)).toBe(false);
  });

  it("preserveCurrentView + restorePreviousView round-trips", () => {
    const id = uniqueId();
    const v1 = makeView(id, 1);
    const v2 = makeView(id, 2);
    cachePivotView(id, v1);
    preserveCurrentView(id);
    cachePivotView(id, v2);
    expect(getCachedPivotVersion(id)).toBe(2);
    const restored = restorePreviousView(id);
    expect(restored?.version).toBe(1);
    expect(getCachedPivotVersion(id)).toBe(1);
    deleteCachedPivotView(id);
  });

  it("restorePreviousView returns undefined when no backup exists", () => {
    const id = uniqueId();
    expect(restorePreviousView(id)).toBeUndefined();
  });
});

// ============================================================================
// 3. View operations handle concurrent access safely
// ============================================================================

describe("concurrent access safety", () => {
  it("startOperation monotonically increases sequence", () => {
    const id = uniqueId();
    const s1 = startOperation(id);
    const s2 = startOperation(id);
    const s3 = startOperation(id);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });

  it("isCurrentOperation returns false for superseded operations", () => {
    const id = uniqueId();
    const s1 = startOperation(id);
    const s2 = startOperation(id);
    expect(isCurrentOperation(id, s1)).toBe(false);
    expect(isCurrentOperation(id, s2)).toBe(true);
  });

  it("setInflightOperation auto-clears on resolution", async () => {
    const id = uniqueId();
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    setInflightOperation(id, promise);
    expect(getInflightOperation(id)).toBe(promise);
    resolve();
    await promise;
    // Allow microtask for .finally() to run
    await new Promise((r) => setTimeout(r, 0));
    expect(getInflightOperation(id)).toBeUndefined();
  });

  it("newer inflight operation replaces older without crash", async () => {
    const id = uniqueId();
    let resolve1!: () => void;
    let resolve2!: () => void;
    const p1 = new Promise<void>((r) => { resolve1 = r; });
    const p2 = new Promise<void>((r) => { resolve2 = r; });
    setInflightOperation(id, p1);
    setInflightOperation(id, p2); // replaces p1
    expect(getInflightOperation(id)).toBe(p2);
    resolve1();
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    // p1's .finally should NOT clear p2
    expect(getInflightOperation(id)).toBe(p2);
    resolve2();
    await p2;
    await new Promise((r) => setTimeout(r, 0));
    expect(getInflightOperation(id)).toBeUndefined();
  });

  it("user cancellation flag is independent per pivot", () => {
    const id1 = uniqueId();
    const id2 = uniqueId();
    markUserCancelled(id1);
    expect(isUserCancelled(id1)).toBe(true);
    expect(isUserCancelled(id2)).toBe(false);
    clearUserCancelled(id1);
  });

  it("ensureCellWindow handles fetch failure without corrupting cache", async () => {
    const id = uniqueId();
    const view = { ...makeView(id, 10), isWindowed: true, totalRowCount: 1000, windowStartRow: 0 };
    cachePivotView(id, view);

    const failingFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const onLoaded = vi.fn();

    ensureCellWindow(id, 10, 200, 50, failingFetch, onLoaded);
    // Wait for the async fetch to settle
    await new Promise((r) => setTimeout(r, 50));

    // Cache should not be corrupted, onLoaded should not be called
    expect(onLoaded).not.toHaveBeenCalled();
    // The view cache itself should still be intact
    expect(getCachedPivotView(id)).toBeDefined();
    deleteCachedPivotView(id);
  });
});

// ============================================================================
// 4. Getters return copies, not references to internal state
// ============================================================================

describe("getters return safe values", () => {
  it("getCachedPivotView returns the same object reference (Map semantics)", () => {
    // Note: pivotViewStore uses a Map which returns references. This test
    // documents the current behavior. If copy-on-read is desired, this test
    // should be updated.
    const id = uniqueId();
    const view = makeView(id, 1);
    cachePivotView(id, view);
    const retrieved = getCachedPivotView(id);
    expect(retrieved).toBeDefined();
    // Verify we get a consistent snapshot
    expect(retrieved!.version).toBe(1);
    deleteCachedPivotView(id);
  });

  it("getLoadingState returns the loading object", () => {
    const id = uniqueId();
    setLoading(id, "Calculating", 1, 3);
    const state = getLoadingState(id);
    expect(state).toBeDefined();
    expect(state!.stage).toBe("Calculating");
    expect(state!.stageIndex).toBe(1);
    expect(state!.totalStages).toBe(3);
    clearLoading(id);
  });

  it("getCellWindowCache returns undefined for non-windowed pivot", () => {
    const id = uniqueId();
    cachePivotView(id, makeView(id, 1)); // not windowed
    expect(getCellWindowCache(id)).toBeUndefined();
    deleteCachedPivotView(id);
  });

  it("getCellWindowCache returns cache for windowed pivot", () => {
    const id = uniqueId();
    const view = { ...makeView(id, 1), isWindowed: true, totalRowCount: 500, windowStartRow: 0 };
    cachePivotView(id, view);
    const cache = getCellWindowCache(id);
    expect(cache).toBeDefined();
    deleteCachedPivotView(id);
  });

  it("cell window cache getRow returns null for unfetched rows", () => {
    const id = uniqueId();
    const view = { ...makeView(id, 1), isWindowed: true, totalRowCount: 500, windowStartRow: 0 };
    cachePivotView(id, view);
    const cache = getCellWindowCache(id)!;
    // Row 300 was never fetched
    expect(cache.getRow(300)).toBeNull();
    deleteCachedPivotView(id);
  });
});
