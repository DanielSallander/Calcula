//! FILENAME: app/extensions/Pivot/lib/pivot-lifecycle.test.ts
// PURPOSE: Detect memory leaks in pivot view store lifecycle patterns.
// CONTEXT: Verifies cache create/delete cycles, operation start/cancel cleanup,
//          and loading state management.

import { describe, it, expect, beforeEach } from "vitest";
import {
  cachePivotView,
  getCachedPivotView,
  deleteCachedPivotView,
  setCachedPivotView,
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
  getCachedPivotVersion,
  getCellWindowCache,
} from "./pivotViewStore";
import type { PivotViewResponse } from "./pivot-api";

// ============================================================================
// Helpers
// ============================================================================

function makePivotView(pivotId: number, version = 1): PivotViewResponse {
  return {
    pivotId,
    version,
    columns: [],
    rows: [],
    totalRowCount: 0,
    isWindowed: false,
  } as unknown as PivotViewResponse;
}

// ============================================================================
// Cache Create/Delete Lifecycle
// ============================================================================

describe("Pivot cache create/delete lifecycle", () => {
  it("create then delete 100 pivot caches leaves no residual state", () => {
    // Create 100 cached views
    for (let i = 1; i <= 100; i++) {
      cachePivotView(i, makePivotView(i, 1));
    }

    // Verify all are cached
    for (let i = 1; i <= 100; i++) {
      expect(getCachedPivotView(i)).toBeDefined();
      expect(getCachedPivotVersion(i)).toBe(1);
    }

    // Delete all
    for (let i = 1; i <= 100; i++) {
      deleteCachedPivotView(i);
    }

    // Verify all are gone
    for (let i = 1; i <= 100; i++) {
      expect(getCachedPivotView(i)).toBeUndefined();
      expect(getCachedPivotVersion(i)).toBe(-1);
      expect(getCellWindowCache(i)).toBeUndefined();
      expect(isLoading(i)).toBe(false);
    }
  });

  it("freshness flags are cleaned by consumeFreshFlag", () => {
    for (let i = 1; i <= 50; i++) {
      cachePivotView(i, makePivotView(i));
      expect(isCacheFresh(i)).toBe(true);
    }

    for (let i = 1; i <= 50; i++) {
      consumeFreshFlag(i);
      expect(isCacheFresh(i)).toBe(false);
    }
  });

  it("setCachedPivotView does not set fresh flag", () => {
    setCachedPivotView(999, makePivotView(999));
    expect(isCacheFresh(999)).toBe(false);
    expect(getCachedPivotView(999)).toBeDefined();
    deleteCachedPivotView(999);
  });

  it("deleting non-existent cache is safe", () => {
    deleteCachedPivotView(77777);
    expect(getCachedPivotView(77777)).toBeUndefined();
  });
});

// ============================================================================
// Operation Start/Cancel Lifecycle
// ============================================================================

describe("Pivot operation start/cancel lifecycle", () => {
  it("startOperation 500 times for same pivot increments sequence", () => {
    const pivotId = 1;

    for (let i = 1; i <= 500; i++) {
      const seq = startOperation(pivotId);
      expect(seq).toBe(i);
    }

    // Only the latest operation should be current
    expect(isCurrentOperation(pivotId, 500)).toBe(true);
    expect(isCurrentOperation(pivotId, 1)).toBe(false);
    expect(isCurrentOperation(pivotId, 499)).toBe(false);
  });

  it("inflight operations auto-clear on settlement", async () => {
    const pivotId = 2;

    let resolveOp!: () => void;
    const op = new Promise<void>((resolve) => { resolveOp = resolve; });
    setInflightOperation(pivotId, op);

    expect(getInflightOperation(pivotId)).toBe(op);

    resolveOp();
    await op;
    // Allow microtask (.finally) to run
    await new Promise((r) => setTimeout(r, 0));

    expect(getInflightOperation(pivotId)).toBeUndefined();
  });

  it("newer inflight operation replaces older one; old does not clear new", async () => {
    const pivotId = 3;

    let resolve1!: () => void;
    const op1 = new Promise<void>((r) => { resolve1 = r; });
    setInflightOperation(pivotId, op1);

    let resolve2!: () => void;
    const op2 = new Promise<void>((r) => { resolve2 = r; });
    setInflightOperation(pivotId, op2);

    expect(getInflightOperation(pivotId)).toBe(op2);

    // Resolve old operation - should NOT clear the new one
    resolve1();
    await op1;
    await new Promise((r) => setTimeout(r, 0));

    expect(getInflightOperation(pivotId)).toBe(op2);

    // Resolve new operation
    resolve2();
    await op2;
    await new Promise((r) => setTimeout(r, 0));

    expect(getInflightOperation(pivotId)).toBeUndefined();
  });

  it("user cancellation flags are properly scoped", () => {
    for (let i = 1; i <= 100; i++) {
      markUserCancelled(i);
    }

    for (let i = 1; i <= 100; i++) {
      expect(isUserCancelled(i)).toBe(true);
    }

    for (let i = 1; i <= 100; i++) {
      clearUserCancelled(i);
    }

    for (let i = 1; i <= 100; i++) {
      expect(isUserCancelled(i)).toBe(false);
    }
  });
});

// ============================================================================
// Loading State Lifecycle
// ============================================================================

describe("Pivot loading state lifecycle", () => {
  it("loading state fully cleared after operations", () => {
    for (let i = 1; i <= 200; i++) {
      setLoading(i, "Calculating...", 0, 1);
    }

    for (let i = 1; i <= 200; i++) {
      expect(isLoading(i)).toBe(true);
      expect(getLoadingState(i)).toBeDefined();
      expect(getLoadingState(i)!.stage).toBe("Calculating...");
    }

    for (let i = 1; i <= 200; i++) {
      clearLoading(i);
    }

    for (let i = 1; i <= 200; i++) {
      expect(isLoading(i)).toBe(false);
      expect(getLoadingState(i)).toBeUndefined();
    }
  });

  it("setLoading updates existing state without creating new entry", () => {
    setLoading(1, "Step 1", 0, 3);
    const state1 = getLoadingState(1);
    expect(state1!.stage).toBe("Step 1");

    setLoading(1, "Step 2", 1, 3);
    const state2 = getLoadingState(1);
    expect(state2!.stage).toBe("Step 2");
    // startedAt should be preserved (same object)
    expect(state2!.startedAt).toBe(state1!.startedAt);

    clearLoading(1);
  });

  it("clearLoading on non-loading pivot is safe", () => {
    clearLoading(99999);
    expect(isLoading(99999)).toBe(false);
  });

  it("deleteCachedPivotView also clears loading state", () => {
    cachePivotView(42, makePivotView(42));
    setLoading(42, "Working...");

    deleteCachedPivotView(42);

    expect(isLoading(42)).toBe(false);
    expect(getCachedPivotView(42)).toBeUndefined();
  });
});

// ============================================================================
// Previous View Preservation
// ============================================================================

describe("Pivot previous view preservation", () => {
  it("preserve then restore cycle works correctly", () => {
    const view = makePivotView(1, 5);
    cachePivotView(1, view);

    preserveCurrentView(1);

    // Overwrite with new view
    cachePivotView(1, makePivotView(1, 6));
    expect(getCachedPivotVersion(1)).toBe(6);

    // Restore
    const restored = restorePreviousView(1);
    expect(restored).toBeDefined();
    expect(restored!.version).toBe(5);
    expect(getCachedPivotVersion(1)).toBe(5);

    // Previous view backup should be cleared after restore
    const again = restorePreviousView(1);
    expect(again).toBeUndefined();

    deleteCachedPivotView(1);
  });

  it("clearPreviousView removes backup without restoring", () => {
    cachePivotView(2, makePivotView(2, 1));
    preserveCurrentView(2);
    cachePivotView(2, makePivotView(2, 2));

    clearPreviousView(2);

    // Restore should return undefined
    expect(restorePreviousView(2)).toBeUndefined();
    // Current should still be v2
    expect(getCachedPivotVersion(2)).toBe(2);

    deleteCachedPivotView(2);
  });

  it("deleteCachedPivotView clears previous view backup", () => {
    cachePivotView(3, makePivotView(3, 1));
    preserveCurrentView(3);

    deleteCachedPivotView(3);

    expect(restorePreviousView(3)).toBeUndefined();
  });
});
