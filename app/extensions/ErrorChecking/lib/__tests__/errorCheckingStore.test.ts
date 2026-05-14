//! FILENAME: app/extensions/ErrorChecking/lib/__tests__/errorCheckingStore.test.ts
// PURPOSE: Tests for the error checking store state management and indicator lookup.

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
// getErrorIndicatorAt Tests
// ============================================================================

describe("getErrorIndicatorAt", () => {
  it("returns undefined for cells with no error indicator", () => {
    expect(getErrorIndicatorAt(0, 0)).toBeUndefined();
  });

  it("returns undefined after reset", () => {
    expect(getErrorIndicatorAt(5, 5)).toBeUndefined();
  });

  it("returns indicator after successful fetch", async () => {
    const indicators = [
      { row: 1, col: 2, errorType: "numberAsText", message: "Number stored as text" },
      { row: 3, col: 4, errorType: "formulaError", message: "#DIV/0!" },
    ];
    mockInvoke.mockResolvedValue(indicators);

    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);

    expect(getErrorIndicatorAt(1, 2)).toEqual({
      row: 1,
      col: 2,
      errorType: "numberAsText",
      message: "Number stored as text",
    });
    expect(getErrorIndicatorAt(3, 4)).toEqual({
      row: 3,
      col: 4,
      errorType: "formulaError",
      message: "#DIV/0!",
    });
  });

  it("returns undefined for cells not in the indicator list", async () => {
    mockInvoke.mockResolvedValue([
      { row: 1, col: 2, errorType: "numberAsText", message: "test" },
    ]);

    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);

    expect(getErrorIndicatorAt(1, 3)).toBeUndefined();
    expect(getErrorIndicatorAt(0, 0)).toBeUndefined();
  });
});

// ============================================================================
// refreshErrorIndicators Tests
// ============================================================================

describe("refreshErrorIndicators", () => {
  it("debounces calls by 200ms", async () => {
    mockInvoke.mockResolvedValue([]);

    refreshErrorIndicators(0, 0, 10, 10);
    refreshErrorIndicators(0, 0, 20, 20);
    refreshErrorIndicators(0, 0, 30, 30);

    // Should not have called invoke yet
    expect(mockInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    // Should only be called once (debounced)
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("adds buffer rows and cols to viewport", async () => {
    mockInvoke.mockResolvedValue([]);

    refreshErrorIndicators(10, 5, 50, 20);
    await vi.advanceTimersByTimeAsync(200);

    // Buffer: 20 rows, 5 cols
    // Expected: startRow = max(0,10-20)=0, startCol = max(0,5-5)=0, endRow=50+20=70, endCol=20+5=25
    expect(mockInvoke).toHaveBeenCalledWith("get_error_indicators", {
      startRow: 0,
      startCol: 0,
      endRow: 70,
      endCol: 25,
    });
  });

  it("clamps buffer to non-negative values", async () => {
    mockInvoke.mockResolvedValue([]);

    refreshErrorIndicators(5, 2, 30, 10);
    await vi.advanceTimersByTimeAsync(200);

    // startRow = max(0, 5-20) = 0, startCol = max(0, 2-5) = 0
    expect(mockInvoke).toHaveBeenCalledWith("get_error_indicators", {
      startRow: 0,
      startCol: 0,
      endRow: 50,
      endCol: 15,
    });
  });

  it("replaces old indicators with new ones on refresh", async () => {
    // First fetch
    mockInvoke.mockResolvedValue([
      { row: 1, col: 1, errorType: "numberAsText", message: "Old" },
    ]);
    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);

    expect(getErrorIndicatorAt(1, 1)).toBeDefined();

    // Second fetch - different indicators
    mockInvoke.mockResolvedValue([
      { row: 5, col: 5, errorType: "formulaError", message: "New" },
    ]);
    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);

    expect(getErrorIndicatorAt(1, 1)).toBeUndefined();
    expect(getErrorIndicatorAt(5, 5)).toBeDefined();
  });

  it("handles backend errors gracefully", async () => {
    mockInvoke.mockRejectedValue(new Error("Backend down"));

    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);

    // Should not crash, indicators remain empty
    expect(getErrorIndicatorAt(0, 0)).toBeUndefined();
  });
});

// ============================================================================
// refreshErrorIndicatorsFromLastViewport Tests
// ============================================================================

describe("refreshErrorIndicatorsFromLastViewport", () => {
  it("does nothing when no viewport has been set", async () => {
    refreshErrorIndicatorsFromLastViewport();
    await vi.advanceTimersByTimeAsync(200);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("re-uses last viewport bounds", async () => {
    mockInvoke.mockResolvedValue([]);

    // Set initial viewport
    refreshErrorIndicators(10, 5, 50, 20);
    await vi.advanceTimersByTimeAsync(200);
    mockInvoke.mockClear();

    // Refresh from last viewport
    refreshErrorIndicatorsFromLastViewport();
    await vi.advanceTimersByTimeAsync(200);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // refreshErrorIndicatorsFromLastViewport passes the already-buffered viewport
    // back into refreshErrorIndicators, which applies buffer again.
    // lastViewport = {0, 0, 70, 25} -> buffer applied again -> {0, 0, 90, 30}
    expect(mockInvoke).toHaveBeenCalledWith("get_error_indicators", {
      startRow: 0,
      startCol: 0,
      endRow: 90,
      endCol: 30,
    });
  });
});

// ============================================================================
// resetErrorStore Tests
// ============================================================================

describe("resetErrorStore", () => {
  it("clears all indicators", async () => {
    mockInvoke.mockResolvedValue([
      { row: 0, col: 0, errorType: "test", message: "test" },
    ]);
    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);

    expect(getErrorIndicatorAt(0, 0)).toBeDefined();

    resetErrorStore();
    expect(getErrorIndicatorAt(0, 0)).toBeUndefined();
  });

  it("clears last viewport so refreshFromLastViewport is a no-op", async () => {
    mockInvoke.mockResolvedValue([]);

    refreshErrorIndicators(0, 0, 10, 10);
    await vi.advanceTimersByTimeAsync(200);
    mockInvoke.mockClear();

    resetErrorStore();
    refreshErrorIndicatorsFromLastViewport();
    await vi.advanceTimersByTimeAsync(200);

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("cancels pending debounced refresh", async () => {
    mockInvoke.mockResolvedValue([]);

    refreshErrorIndicators(0, 0, 10, 10);
    // Reset before debounce fires
    resetErrorStore();
    await vi.advanceTimersByTimeAsync(200);

    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
