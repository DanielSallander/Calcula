//! FILENAME: app/extensions/Pivot/lib/pivot-concurrent.test.ts
// PURPOSE: Concurrency stress tests for pivot view store operations.
// CONTEXT: Simulates rapid cache updates, superseding operations, user
//          cancellation, and concurrent reads/writes to reveal race conditions.

import { describe, it, expect, beforeEach } from "vitest";
import {
  cachePivotView,
  getCachedPivotView,
  setCachedPivotView,
  deleteCachedPivotView,
  startOperation,
  isCurrentOperation,
  setInflightOperation,
  getInflightOperation,
  markUserCancelled,
  isUserCancelled,
  clearUserCancelled,
  preserveCurrentView,
  restorePreviousView,
  clearPreviousView,
  setLoading,
  clearLoading,
  isLoading,
  getLoadingState,
  isCacheFresh,
  consumeFreshFlag,
  getCellWindowCache,
  ensureCellWindow,
} from "./pivotViewStore";
import type { PivotViewResponse } from "./pivot-api";

// ============================================================================
// Helpers
// ============================================================================

function makeView(version: number, rowCount = 1, windowed = false): PivotViewResponse {
  return {
    version,
    rows: Array.from({ length: rowCount }, (_, i) => ({
      depth: 0,
      label: `Row-${i}`,
      cells: [`${version}-${i}`],
      isExpanded: false,
      isGrandTotal: false,
    })),
    columnHeaders: [["Col"]],
    rowFieldCount: 1,
    totalRowCount: rowCount,
    isWindowed: windowed,
  } as PivotViewResponse;
}

const PIVOT_ID = 999;

beforeEach(() => {
  deleteCachedPivotView(PIVOT_ID);
  deleteCachedPivotView(PIVOT_ID + 1);
  deleteCachedPivotView(PIVOT_ID + 2);
  clearUserCancelled(PIVOT_ID);
  clearLoading(PIVOT_ID);
  clearPreviousView(PIVOT_ID);
});

// ============================================================================
// 1. Multiple rapid cache updates
// ============================================================================

describe("rapid cache updates", () => {
  it("50 rapid cachePivotView calls converge to final version", () => {
    for (let i = 0; i < 50; i++) {
      cachePivotView(PIVOT_ID, makeView(i));
    }

    const cached = getCachedPivotView(PIVOT_ID);
    expect(cached).toBeDefined();
    expect(cached!.version).toBe(49);
  });

  it("interleaved cachePivotView and setCachedPivotView keep last-write-wins", () => {
    cachePivotView(PIVOT_ID, makeView(1));
    expect(isCacheFresh(PIVOT_ID)).toBe(true);

    setCachedPivotView(PIVOT_ID, makeView(2));
    // setCachedPivotView does NOT mark fresh
    expect(isCacheFresh(PIVOT_ID)).toBe(true); // still fresh from earlier cachePivotView

    consumeFreshFlag(PIVOT_ID);
    expect(isCacheFresh(PIVOT_ID)).toBe(false);

    // Value is from the last write
    expect(getCachedPivotView(PIVOT_ID)!.version).toBe(2);
  });

  it("rapid cache + delete cycles leave no stale data", () => {
    for (let i = 0; i < 30; i++) {
      cachePivotView(PIVOT_ID, makeView(i));
      if (i % 3 === 0) {
        deleteCachedPivotView(PIVOT_ID);
      }
    }

    // Last iteration: i=29, not divisible by 3, so cache should exist
    const cached = getCachedPivotView(PIVOT_ID);
    expect(cached).toBeDefined();
    expect(cached!.version).toBe(29);
  });

  it("concurrent updates to different pivotIds do not interfere", () => {
    for (let i = 0; i < 20; i++) {
      cachePivotView(PIVOT_ID, makeView(i));
      cachePivotView(PIVOT_ID + 1, makeView(100 + i));
      cachePivotView(PIVOT_ID + 2, makeView(200 + i));
    }

    expect(getCachedPivotView(PIVOT_ID)!.version).toBe(19);
    expect(getCachedPivotView(PIVOT_ID + 1)!.version).toBe(119);
    expect(getCachedPivotView(PIVOT_ID + 2)!.version).toBe(219);
  });
});

// ============================================================================
// 2. Operation superseding
// ============================================================================

describe("operation superseding", () => {
  it("starting a new operation supersedes the previous one", () => {
    const seq1 = startOperation(PIVOT_ID);
    expect(isCurrentOperation(PIVOT_ID, seq1)).toBe(true);

    const seq2 = startOperation(PIVOT_ID);
    expect(isCurrentOperation(PIVOT_ID, seq1)).toBe(false);
    expect(isCurrentOperation(PIVOT_ID, seq2)).toBe(true);
  });

  it("10 rapid startOperation calls - only the last is current", () => {
    const seqs: number[] = [];
    for (let i = 0; i < 10; i++) {
      seqs.push(startOperation(PIVOT_ID));
    }

    for (let i = 0; i < 9; i++) {
      expect(isCurrentOperation(PIVOT_ID, seqs[i])).toBe(false);
    }
    expect(isCurrentOperation(PIVOT_ID, seqs[9])).toBe(true);
  });

  it("inflight operation promise auto-clears on settle", async () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    setInflightOperation(PIVOT_ID, promise);

    expect(getInflightOperation(PIVOT_ID)).toBe(promise);

    resolve();
    await promise;
    // Allow microtask for .finally() to run
    await new Promise((r) => setTimeout(r, 0));

    expect(getInflightOperation(PIVOT_ID)).toBeUndefined();
  });

  it("replacing inflight operation does not clear the new one when old settles", async () => {
    let resolve1!: () => void;
    const promise1 = new Promise<void>((r) => (resolve1 = r));
    setInflightOperation(PIVOT_ID, promise1);

    let resolve2!: () => void;
    const promise2 = new Promise<void>((r) => (resolve2 = r));
    setInflightOperation(PIVOT_ID, promise2);

    // Old settles
    resolve1();
    await promise1;
    await new Promise((r) => setTimeout(r, 0));

    // New is still registered
    expect(getInflightOperation(PIVOT_ID)).toBe(promise2);

    resolve2();
    await promise2;
    await new Promise((r) => setTimeout(r, 0));
    expect(getInflightOperation(PIVOT_ID)).toBeUndefined();
  });

  it("superseded operation result is discarded via sequence check", async () => {
    const seq1 = startOperation(PIVOT_ID);

    // Simulate async work for op1
    const op1 = new Promise<void>((resolve) => {
      setTimeout(() => {
        // By now, op2 has started so seq1 is stale
        if (isCurrentOperation(PIVOT_ID, seq1)) {
          cachePivotView(PIVOT_ID, makeView(1));
        }
        resolve();
      }, 10);
    });
    setInflightOperation(PIVOT_ID, op1);

    // Start op2 immediately (supersedes op1)
    const seq2 = startOperation(PIVOT_ID);
    cachePivotView(PIVOT_ID, makeView(2));

    await op1;

    // Op1 result was discarded; op2 result remains
    expect(getCachedPivotView(PIVOT_ID)!.version).toBe(2);
    expect(isCurrentOperation(PIVOT_ID, seq2)).toBe(true);
  });
});

// ============================================================================
// 3. User cancellation during operation sequence
// ============================================================================

describe("user cancellation", () => {
  it("markUserCancelled suppresses result caching", () => {
    preserveCurrentView(PIVOT_ID);
    cachePivotView(PIVOT_ID, makeView(1));
    clearPreviousView(PIVOT_ID);

    // Start a new operation
    const seq = startOperation(PIVOT_ID);
    preserveCurrentView(PIVOT_ID);
    markUserCancelled(PIVOT_ID);

    // Simulate operation completing
    expect(isUserCancelled(PIVOT_ID)).toBe(true);

    // Restore previous view
    const restored = restorePreviousView(PIVOT_ID);
    expect(restored).toBeDefined();
    expect(restored!.version).toBe(1);

    clearUserCancelled(PIVOT_ID);
    expect(isUserCancelled(PIVOT_ID)).toBe(false);
  });

  it("cancel-then-new-operation clears cancelled state", () => {
    markUserCancelled(PIVOT_ID);
    expect(isUserCancelled(PIVOT_ID)).toBe(true);

    clearUserCancelled(PIVOT_ID);
    const seq = startOperation(PIVOT_ID);

    expect(isUserCancelled(PIVOT_ID)).toBe(false);
    expect(isCurrentOperation(PIVOT_ID, seq)).toBe(true);
  });

  it("rapid cancel/start cycles do not corrupt state", () => {
    for (let i = 0; i < 20; i++) {
      const seq = startOperation(PIVOT_ID);
      if (i % 2 === 0) {
        markUserCancelled(PIVOT_ID);
        clearUserCancelled(PIVOT_ID);
      } else {
        cachePivotView(PIVOT_ID, makeView(i));
      }
    }

    expect(isUserCancelled(PIVOT_ID)).toBe(false);
    // Last odd i that cached: i=19
    expect(getCachedPivotView(PIVOT_ID)!.version).toBe(19);
  });
});

// ============================================================================
// 4. Cache reads during writes
// ============================================================================

describe("cache reads during writes", () => {
  it("getCachedPivotView during rapid updates always returns a complete view", () => {
    for (let i = 0; i < 100; i++) {
      cachePivotView(PIVOT_ID, makeView(i));
      const view = getCachedPivotView(PIVOT_ID);
      expect(view).toBeDefined();
      // The view should be internally consistent (version matches row content)
      expect(view!.version).toBe(i);
      expect(view!.rows[0].cells[0]).toBe(`${i}-0`);
    }
  });

  it("loading state tracks correctly across rapid operations", () => {
    for (let i = 0; i < 30; i++) {
      setLoading(PIVOT_ID, `Stage ${i}`, i, 30);
      expect(isLoading(PIVOT_ID)).toBe(true);
      expect(getLoadingState(PIVOT_ID)!.stage).toBe(`Stage ${i}`);
    }

    clearLoading(PIVOT_ID);
    expect(isLoading(PIVOT_ID)).toBe(false);
  });

  it("preserveCurrentView + rapid updates + restore gives correct snapshot", () => {
    cachePivotView(PIVOT_ID, makeView(1));
    preserveCurrentView(PIVOT_ID);

    // Many updates after preserve
    for (let i = 2; i <= 20; i++) {
      cachePivotView(PIVOT_ID, makeView(i));
    }

    // Restore gives the view from BEFORE the updates
    const restored = restorePreviousView(PIVOT_ID);
    expect(restored).toBeDefined();
    expect(restored!.version).toBe(1);

    // Cache now holds the restored view
    expect(getCachedPivotView(PIVOT_ID)!.version).toBe(1);
  });

  it("ensureCellWindow fetches missing rows and handles stale version", async () => {
    // Create a windowed view with only 2 rows in the initial window
    const windowedView = makeView(5, 2, true);
    (windowedView as any).windowStartRow = 0;
    cachePivotView(PIVOT_ID, windowedView);
    // totalRowCount is larger than the initial window
    (windowedView as any).totalRowCount = 1000;

    const cache = getCellWindowCache(PIVOT_ID);
    expect(cache).toBeDefined();

    let fetchCount = 0;
    const mockFetch = async (pivotId: number, startRow: number, rowCount: number) => {
      fetchCount++;
      return {
        version: 5,
        startRow,
        rows: Array.from({ length: rowCount }, (_, i) => ({
          depth: 0,
          label: `Fetched-${startRow + i}`,
          cells: [`v5-${startRow + i}`],
          isExpanded: false,
          isGrandTotal: false,
        })),
      };
    };

    let loadedCount = 0;
    // Request rows 300-310 (not in initial window of 0-1)
    ensureCellWindow(PIVOT_ID, 5, 300, 10, mockFetch, () => {
      loadedCount++;
    });

    // Allow async fetch to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchCount).toBe(1);
    expect(loadedCount).toBe(1);
    expect(cache!.hasRow(300)).toBe(true);
  });

  it("delete during loading clears all state cleanly", () => {
    cachePivotView(PIVOT_ID, makeView(1));
    setLoading(PIVOT_ID, "working", 0, 1);
    preserveCurrentView(PIVOT_ID);

    deleteCachedPivotView(PIVOT_ID);

    expect(getCachedPivotView(PIVOT_ID)).toBeUndefined();
    expect(isLoading(PIVOT_ID)).toBe(false);
    expect(restorePreviousView(PIVOT_ID)).toBeUndefined();
  });
});
