//! FILENAME: app/extensions/ErrorChecking/lib/__tests__/errorCheckingStore.deep.test.ts
// PURPOSE: Deep tests for error checking store: scale, timing, edge cases, and concurrency.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Tauri invoke function
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import {
  refreshErrorIndicators,
  refreshErrorIndicatorsFromLastViewport,
  getErrorIndicatorAt,
  resetErrorStore,
} from "../errorCheckingStore";

import type { CellErrorIndicator } from "../errorCheckingStore";

import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetErrorStore();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// Helpers
// ============================================================================

function makeIndicator(
  row: number,
  col: number,
  errorType: string,
  message: string,
): CellErrorIndicator {
  return { row, col, errorType, message };
}

function makeIndicators(count: number, errorType = "formulaError"): CellErrorIndicator[] {
  const result: CellErrorIndicator[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 50);
    const col = i % 50;
    result.push(makeIndicator(row, col, errorType, `Error at ${row},${col}`));
  }
  return result;
}

// ============================================================================
// 500+ error indicators across viewport
// ============================================================================

describe("large-scale indicator sets", () => {
  it("handles 500 indicators loaded at once", async () => {
    const indicators = makeIndicators(500);
    mockInvoke.mockResolvedValue(indicators);

    refreshErrorIndicators(0, 0, 50, 50);
    await vi.advanceTimersByTimeAsync(200);

    // Verify all 500 are accessible
    let found = 0;
    for (const ind of indicators) {
      if (getErrorIndicatorAt(ind.row, ind.col) !== undefined) found++;
    }
    expect(found).toBe(500);
  });

  it("handles 1000 indicators without issue", async () => {
    const indicators = makeIndicators(1000);
    mockInvoke.mockResolvedValue(indicators);

    refreshErrorIndicators(0, 0, 100, 100);
    await vi.advanceTimersByTimeAsync(200);

    // Spot-check first, middle, and last
    expect(getErrorIndicatorAt(0, 0)).toBeDefined();
    expect(getErrorIndicatorAt(10, 0)).toBeDefined();
    expect(getErrorIndicatorAt(19, 49)).toBeDefined();
  });

  it("replaces 500 old indicators with 500 new indicators completely", async () => {
    // First batch: rows 0-9, cols 0-49
    const batch1 = makeIndicators(500, "numberAsText");
    mockInvoke.mockResolvedValue(batch1);
    refreshErrorIndicators(0, 0, 50, 50);
    await vi.advanceTimersByTimeAsync(200);

    // Second batch: rows 100-109, cols 0-49
    const batch2: CellErrorIndicator[] = [];
    for (let i = 0; i < 500; i++) {
      batch2.push(makeIndicator(100 + Math.floor(i / 50), i % 50, "formulaError", "new"));
    }
    mockInvoke.mockResolvedValue(batch2);
    refreshErrorIndicators(100, 0, 150, 50);
    await vi.advanceTimersByTimeAsync(200);

    // Old batch should be gone
    expect(getErrorIndicatorAt(0, 0)).toBeUndefined();
    // New batch should be present
    expect(getErrorIndicatorAt(100, 0)).toBeDefined();
    expect(getErrorIndicatorAt(100, 0)!.errorType).toBe("formulaError");
  });
});

// ============================================================================
// All error types
// ============================================================================

describe("all error types", () => {
  const errorTypes = [
    { errorType: "formulaError", message: "#VALUE!" },
    { errorType: "formulaError", message: "#REF!" },
    { errorType: "formulaError", message: "#NAME?" },
    { errorType: "formulaError", message: "#DIV/0!" },
    { errorType: "formulaError", message: "#NULL!" },
    { errorType: "formulaError", message: "#N/A" },
    { errorType: "formulaError", message: "#NUM!" },
    { errorType: "numberAsText", message: "Number stored as text" },
    { errorType: "inconsistentFormula", message: "Inconsistent formula" },
  ];

  it("stores and retrieves all error types correctly", async () => {
    const indicators = errorTypes.map((e, i) =>
      makeIndicator(i, 0, e.errorType, e.message),
    );
    mockInvoke.mockResolvedValue(indicators);

    refreshErrorIndicators(0, 0, 20, 10);
    await vi.advanceTimersByTimeAsync(200);

    for (let i = 0; i < errorTypes.length; i++) {
      const ind = getErrorIndicatorAt(i, 0);
      expect(ind).toBeDefined();
      expect(ind!.message).toBe(errorTypes[i].message);
      expect(ind!.errorType).toBe(errorTypes[i].errorType);
    }
  });

  it("distinguishes cells with different error types at same column", async () => {
    const indicators = [
      makeIndicator(0, 5, "formulaError", "#DIV/0!"),
      makeIndicator(1, 5, "numberAsText", "Number stored as text"),
    ];
    mockInvoke.mockResolvedValue(indicators);

    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);

    expect(getErrorIndicatorAt(0, 5)!.message).toBe("#DIV/0!");
    expect(getErrorIndicatorAt(1, 5)!.message).toBe("Number stored as text");
  });
});

// ============================================================================
// Rapid viewport scrolling (10 scroll events in quick succession)
// ============================================================================

describe("rapid viewport scrolling", () => {
  it("coalesces 10 rapid scroll events into a single fetch", async () => {
    mockInvoke.mockResolvedValue([]);

    for (let i = 0; i < 10; i++) {
      refreshErrorIndicators(i * 10, 0, i * 10 + 50, 20);
    }

    // No calls yet during debounce
    expect(mockInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    // Only the last viewport should trigger a fetch
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // Last call was refreshErrorIndicators(90, 0, 140, 20) -> with buffer
    expect(mockInvoke).toHaveBeenCalledWith("get_error_indicators", {
      startRow: 70, // max(0, 90-20)
      startCol: 0,
      endRow: 160, // 140+20
      endCol: 25, // 20+5
    });
  });

  it("fires a second fetch after debounce resets between bursts", async () => {
    mockInvoke.mockResolvedValue([]);

    // First burst
    refreshErrorIndicators(0, 0, 50, 20);
    refreshErrorIndicators(10, 0, 60, 20);
    await vi.advanceTimersByTimeAsync(200);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Second burst after debounce
    refreshErrorIndicators(100, 0, 150, 20);
    refreshErrorIndicators(110, 0, 160, 20);
    await vi.advanceTimersByTimeAsync(200);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Debounce verification with precise timing
// ============================================================================

describe("debounce timing precision", () => {
  it("does not fire at 199ms", async () => {
    mockInvoke.mockResolvedValue([]);
    refreshErrorIndicators(0, 0, 10, 10);

    await vi.advanceTimersByTimeAsync(199);
    expect(mockInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("resets debounce timer on each call", async () => {
    mockInvoke.mockResolvedValue([]);

    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(150);
    expect(mockInvoke).not.toHaveBeenCalled();

    // Another call resets the 200ms window
    refreshErrorIndicators(0, 0, 20, 20);
    await vi.advanceTimersByTimeAsync(150);
    expect(mockInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("three sequential calls with 100ms gaps result in one fetch at 400ms", async () => {
    mockInvoke.mockResolvedValue([]);

    refreshErrorIndicators(0, 0, 10, 10); // t=0
    await vi.advanceTimersByTimeAsync(100);

    refreshErrorIndicators(0, 0, 20, 20); // t=100
    await vi.advanceTimersByTimeAsync(100);

    refreshErrorIndicators(0, 0, 30, 30); // t=200
    await vi.advanceTimersByTimeAsync(199);
    expect(mockInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1); // t=400
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Error indicators at cell boundaries
// ============================================================================

describe("error indicators at cell boundaries", () => {
  it("handles indicators at row 0, col 0", async () => {
    mockInvoke.mockResolvedValue([makeIndicator(0, 0, "formulaError", "#REF!")]);
    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);
    expect(getErrorIndicatorAt(0, 0)!.message).toBe("#REF!");
  });

  it("handles indicators at very large row/col indices", async () => {
    mockInvoke.mockResolvedValue([
      makeIndicator(999999, 16383, "formulaError", "#VALUE!"),
    ]);
    refreshErrorIndicators(999990, 16380, 1000000, 16384);
    await vi.advanceTimersByTimeAsync(200);
    expect(getErrorIndicatorAt(999999, 16383)!.message).toBe("#VALUE!");
  });

  it("adjacent cells have independent indicators", async () => {
    mockInvoke.mockResolvedValue([
      makeIndicator(5, 5, "formulaError", "#DIV/0!"),
      makeIndicator(5, 6, "numberAsText", "Number as text"),
      makeIndicator(6, 5, "formulaError", "#NAME?"),
      makeIndicator(6, 6, "formulaError", "#N/A"),
    ]);
    refreshErrorIndicators(0, 0, 20, 20);
    await vi.advanceTimersByTimeAsync(200);

    expect(getErrorIndicatorAt(5, 5)!.message).toBe("#DIV/0!");
    expect(getErrorIndicatorAt(5, 6)!.message).toBe("Number as text");
    expect(getErrorIndicatorAt(6, 5)!.message).toBe("#NAME?");
    expect(getErrorIndicatorAt(6, 6)!.message).toBe("#N/A");
  });
});

// ============================================================================
// Indicator lookup performance with many indicators
// ============================================================================

describe("indicator lookup performance", () => {
  it("O(1) lookup time with 500+ indicators", async () => {
    const indicators = makeIndicators(500);
    mockInvoke.mockResolvedValue(indicators);
    refreshErrorIndicators(0, 0, 50, 50);
    await vi.advanceTimersByTimeAsync(200);

    // Perform 1000 lookups (both hits and misses)
    const start = performance.now();
    for (let i = 0; i < 500; i++) {
      getErrorIndicatorAt(Math.floor(i / 50), i % 50);
    }
    for (let i = 0; i < 500; i++) {
      getErrorIndicatorAt(200 + i, 200 + i); // misses
    }
    const elapsed = performance.now() - start;

    // 1000 Map lookups should be well under 50ms
    expect(elapsed).toBeLessThan(50);
  });
});

// ============================================================================
// Reset during pending fetch
// ============================================================================

describe("reset during pending fetch", () => {
  it("reset cancels debounced fetch, indicators stay empty", async () => {
    mockInvoke.mockResolvedValue([makeIndicator(1, 1, "formulaError", "#REF!")]);

    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(100); // halfway through debounce
    resetErrorStore();
    await vi.advanceTimersByTimeAsync(200); // past original debounce time

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(getErrorIndicatorAt(1, 1)).toBeUndefined();
  });

  it("reset during in-flight fetch does not crash", async () => {
    // Simulate a slow fetch
    let resolveInvoke: (v: CellErrorIndicator[]) => void;
    mockInvoke.mockReturnValue(
      new Promise<CellErrorIndicator[]>((r) => { resolveInvoke = r; }) as any,
    );

    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200); // debounce fires, fetch starts

    // Reset while fetch is in-flight
    resetErrorStore();

    // Resolve the in-flight fetch
    resolveInvoke!([makeIndicator(1, 1, "formulaError", "#REF!")]);
    await vi.advanceTimersByTimeAsync(0);

    // The indicators from the late-arriving response will still be set
    // (the store doesn't track in-flight requests, but reset clears the map)
    // After resolve, doFetch rebuilds the map. This is expected behavior.
  });

  it("reset followed by new refresh works correctly", async () => {
    // First fetch
    mockInvoke.mockResolvedValue([makeIndicator(1, 1, "formulaError", "old")]);
    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);
    expect(getErrorIndicatorAt(1, 1)).toBeDefined();

    // Reset
    resetErrorStore();
    expect(getErrorIndicatorAt(1, 1)).toBeUndefined();

    // New fetch with different data
    mockInvoke.mockResolvedValue([makeIndicator(5, 5, "numberAsText", "new")]);
    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);

    expect(getErrorIndicatorAt(1, 1)).toBeUndefined();
    expect(getErrorIndicatorAt(5, 5)!.message).toBe("new");
  });
});

// ============================================================================
// Multiple refresh calls coalescing
// ============================================================================

describe("multiple refresh calls coalescing", () => {
  it("only the last viewport wins when multiple refreshes overlap", async () => {
    mockInvoke.mockResolvedValue([]);

    refreshErrorIndicators(0, 0, 10, 10);
    refreshErrorIndicators(50, 0, 60, 10);
    refreshErrorIndicators(100, 0, 110, 10);

    await vi.advanceTimersByTimeAsync(200);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // Last call: startRow=100, endRow=110 with buffer
    expect(mockInvoke).toHaveBeenCalledWith("get_error_indicators", {
      startRow: 80, // max(0, 100-20)
      startCol: 0,
      endRow: 130, // 110+20
      endCol: 15, // 10+5
    });
  });

  it("refreshFromLastViewport after coalesced refresh uses final viewport", async () => {
    mockInvoke.mockResolvedValue([]);

    refreshErrorIndicators(0, 0, 10, 10);
    refreshErrorIndicators(50, 0, 60, 10);
    await vi.advanceTimersByTimeAsync(200);
    mockInvoke.mockClear();

    refreshErrorIndicatorsFromLastViewport();
    await vi.advanceTimersByTimeAsync(200);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // lastViewport was set to the buffered version of (50,0,60,10) = {30,0,80,15}
    // refreshFromLastViewport passes those back into refreshErrorIndicators which buffers again
    expect(mockInvoke).toHaveBeenCalledWith("get_error_indicators", {
      startRow: 10, // max(0, 30-20)
      startCol: 0,
      endRow: 100, // 80+20
      endCol: 20, // 15+5
    });
  });

  it("backend error on coalesced fetch does not prevent subsequent fetches", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("backend error"));

    refreshErrorIndicators(0, 0, 10, 10);
    refreshErrorIndicators(5, 0, 15, 10);
    await vi.advanceTimersByTimeAsync(200);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Next fetch should work fine
    mockInvoke.mockResolvedValue([makeIndicator(0, 0, "formulaError", "ok")]);
    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(getErrorIndicatorAt(0, 0)!.message).toBe("ok");
  });

  it("empty indicator response clears previous indicators", async () => {
    mockInvoke.mockResolvedValue([makeIndicator(3, 3, "formulaError", "#N/A")]);
    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);
    expect(getErrorIndicatorAt(3, 3)).toBeDefined();

    mockInvoke.mockResolvedValue([]);
    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);
    expect(getErrorIndicatorAt(3, 3)).toBeUndefined();
  });
});
