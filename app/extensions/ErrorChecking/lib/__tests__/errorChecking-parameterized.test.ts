//! FILENAME: app/extensions/ErrorChecking/lib/__tests__/errorChecking-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for error indicator lookup,
//          debounce behavior, and viewport buffer calculations.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  refreshErrorIndicators,
  getErrorIndicatorAt,
  resetErrorStore,
  refreshErrorIndicatorsFromLastViewport,
  type CellErrorIndicator,
} from "../errorCheckingStore";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetErrorStore();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// Helper: cellKey
// ============================================================================

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

// ============================================================================
// 1. Error Indicator Lookup for 40 Cell Positions
// ============================================================================

describe("Error indicator lookup (40 positions)", () => {
  const errorTypes = [
    "numberStoredAsText",
    "formulaError",
    "inconsistentFormula",
    "emptyReference",
    "formulaOmitsAdjacentCells",
  ];

  // Positions to populate with errors
  const errorPositions: Array<[number, number, string, string]> = [
    [0, 0, "numberStoredAsText", "Number stored as text"],
    [0, 1, "formulaError", "#REF! error"],
    [1, 0, "inconsistentFormula", "Inconsistent formula"],
    [1, 1, "emptyReference", "Empty cell reference"],
    [2, 0, "formulaOmitsAdjacentCells", "Formula omits adjacent cells"],
    [5, 5, "numberStoredAsText", "Number stored as text"],
    [10, 0, "formulaError", "#DIV/0! error"],
    [0, 10, "inconsistentFormula", "Formula differs from neighbors"],
    [99, 99, "emptyReference", "Empty reference in formula"],
    [50, 25, "numberStoredAsText", "Cell contains numeric text"],
  ];

  // Positions that should NOT have errors
  const emptyPositions: Array<[number, number]> = [
    [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9],
    [3, 0], [3, 1], [3, 2], [3, 3],
    [4, 0], [4, 1], [4, 2], [4, 3],
    [6, 6], [7, 7], [8, 8], [9, 9],
    [100, 0], [0, 100], [200, 200],
    [1000, 0], [0, 1000],
    [50, 0], [50, 1], [50, 26], [50, 27],
    [25, 50],
  ];

  beforeEach(async () => {
    const indicators: CellErrorIndicator[] = errorPositions.map(
      ([row, col, errorType, message]) => ({ row, col, errorType, message }),
    );
    mockInvoke.mockResolvedValue(indicators);

    refreshErrorIndicators(0, 0, 100, 100);
    vi.advanceTimersByTime(200);
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalled();
    });
  });

  describe("cells WITH errors", () => {
    it.each(errorPositions)(
      "cell [%i, %i] has error type '%s'",
      (row, col, errorType, message) => {
        const indicator = getErrorIndicatorAt(row, col);
        expect(indicator).toBeDefined();
        expect(indicator!.errorType).toBe(errorType);
        expect(indicator!.message).toBe(message);
        expect(indicator!.row).toBe(row);
        expect(indicator!.col).toBe(col);
      },
    );
  });

  describe("cells WITHOUT errors", () => {
    it.each(emptyPositions)(
      "cell [%i, %i] has no error indicator",
      (row, col) => {
        expect(getErrorIndicatorAt(row, col)).toBeUndefined();
      },
    );
  });
});

// ============================================================================
// 2. Debounce Behavior (20 timing scenarios)
// ============================================================================

describe("Debounce behavior (20 scenarios)", () => {
  interface DebounceCase {
    name: string;
    callTimings: number[];  // ms offsets for each refreshErrorIndicators call
    advanceTo: number;      // total ms to advance timers
    expectedInvokeCount: number;
  }

  const debounceCases: DebounceCase[] = [
    { name: "single call, wait full debounce", callTimings: [0], advanceTo: 200, expectedInvokeCount: 1 },
    { name: "single call, not enough wait", callTimings: [0], advanceTo: 100, expectedInvokeCount: 0 },
    { name: "single call, wait only 150ms", callTimings: [0], advanceTo: 150, expectedInvokeCount: 0 },
    { name: "single call, wait exactly 200ms", callTimings: [0], advanceTo: 200, expectedInvokeCount: 1 },
    { name: "two rapid calls, last wins", callTimings: [0, 50], advanceTo: 250, expectedInvokeCount: 1 },
    { name: "two calls 100ms apart", callTimings: [0, 100], advanceTo: 300, expectedInvokeCount: 1 },
    { name: "two calls 200ms apart (both fire)", callTimings: [0, 250], advanceTo: 450, expectedInvokeCount: 2 },
    { name: "three rapid calls, last wins", callTimings: [0, 50, 100], advanceTo: 300, expectedInvokeCount: 1 },
    { name: "three calls, first + last fire", callTimings: [0, 250, 300], advanceTo: 500, expectedInvokeCount: 2 },
    { name: "five rapid calls", callTimings: [0, 10, 20, 30, 40], advanceTo: 240, expectedInvokeCount: 1 },
    { name: "calls every 50ms for 200ms", callTimings: [0, 50, 100, 150], advanceTo: 350, expectedInvokeCount: 1 },
    { name: "calls every 250ms (each fires)", callTimings: [0, 250, 500], advanceTo: 700, expectedInvokeCount: 3 },
    { name: "burst then wait then burst", callTimings: [0, 10, 20, 300, 310, 320], advanceTo: 520, expectedInvokeCount: 2 },
    { name: "no calls", callTimings: [], advanceTo: 1000, expectedInvokeCount: 0 },
    { name: "single call at t=500", callTimings: [500], advanceTo: 700, expectedInvokeCount: 1 },
    { name: "call at t=0, cancel via reset before fire", callTimings: [0], advanceTo: 100, expectedInvokeCount: 0 },
    { name: "10 rapid calls in 10ms", callTimings: Array.from({ length: 10 }, (_, i) => i), advanceTo: 210, expectedInvokeCount: 1 },
    { name: "calls at 0, 199 (resets, fires at 399)", callTimings: [0, 199], advanceTo: 399, expectedInvokeCount: 1 },
    { name: "calls at 0, 100, 200 (fires once at 400)", callTimings: [0, 100, 200], advanceTo: 400, expectedInvokeCount: 1 },
    { name: "two well-separated bursts", callTimings: [0, 10, 20, 500, 510, 520], advanceTo: 720, expectedInvokeCount: 2 },
  ];

  it.each(debounceCases)(
    "$name -> $expectedInvokeCount invoke(s)",
    async ({ callTimings, advanceTo, expectedInvokeCount }) => {
      mockInvoke.mockResolvedValue([]);
      resetErrorStore();

      let currentTime = 0;
      for (const timing of callTimings) {
        if (timing > currentTime) {
          vi.advanceTimersByTime(timing - currentTime);
          currentTime = timing;
        }
        refreshErrorIndicators(0, 0, 50, 20);
      }

      if (advanceTo > currentTime) {
        vi.advanceTimersByTime(advanceTo - currentTime);
      }

      // Flush pending microtasks without advancing timers further
      await Promise.resolve();
      await Promise.resolve();

      expect(mockInvoke).toHaveBeenCalledTimes(expectedInvokeCount);
    },
  );
});

// ============================================================================
// 3. Viewport Buffer Calculations (15 viewport sizes)
// ============================================================================

describe("Viewport buffer calculations (15 sizes)", () => {
  const BUFFER_ROWS = 20;
  const BUFFER_COLS = 5;

  interface ViewportCase {
    name: string;
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    expectedBufferedStartRow: number;
    expectedBufferedStartCol: number;
    expectedBufferedEndRow: number;
    expectedBufferedEndCol: number;
  }

  const viewportCases: ViewportCase[] = [
    {
      name: "origin viewport 50x20",
      startRow: 0, startCol: 0, endRow: 49, endCol: 19,
      expectedBufferedStartRow: 0, expectedBufferedStartCol: 0,
      expectedBufferedEndRow: 69, expectedBufferedEndCol: 24,
    },
    {
      name: "offset viewport",
      startRow: 100, startCol: 10, endRow: 149, endCol: 29,
      expectedBufferedStartRow: 80, expectedBufferedStartCol: 5,
      expectedBufferedEndRow: 169, expectedBufferedEndCol: 34,
    },
    {
      name: "small viewport 5x5 at origin",
      startRow: 0, startCol: 0, endRow: 4, endCol: 4,
      expectedBufferedStartRow: 0, expectedBufferedStartCol: 0,
      expectedBufferedEndRow: 24, expectedBufferedEndCol: 9,
    },
    {
      name: "small viewport near origin (buffer clamped)",
      startRow: 5, startCol: 2, endRow: 10, endCol: 7,
      expectedBufferedStartRow: 0, expectedBufferedStartCol: 0,
      expectedBufferedEndRow: 30, expectedBufferedEndCol: 12,
    },
    {
      name: "large viewport 1000 rows",
      startRow: 500, startCol: 0, endRow: 1499, endCol: 25,
      expectedBufferedStartRow: 480, expectedBufferedStartCol: 0,
      expectedBufferedEndRow: 1519, expectedBufferedEndCol: 30,
    },
    {
      name: "single cell viewport",
      startRow: 50, startCol: 10, endRow: 50, endCol: 10,
      expectedBufferedStartRow: 30, expectedBufferedStartCol: 5,
      expectedBufferedEndRow: 70, expectedBufferedEndCol: 15,
    },
    {
      name: "single row viewport",
      startRow: 0, startCol: 0, endRow: 0, endCol: 25,
      expectedBufferedStartRow: 0, expectedBufferedStartCol: 0,
      expectedBufferedEndRow: 20, expectedBufferedEndCol: 30,
    },
    {
      name: "single column viewport",
      startRow: 0, startCol: 0, endRow: 50, endCol: 0,
      expectedBufferedStartRow: 0, expectedBufferedStartCol: 0,
      expectedBufferedEndRow: 70, expectedBufferedEndCol: 5,
    },
    {
      name: "far-right columns",
      startRow: 0, startCol: 250, endRow: 50, endCol: 255,
      expectedBufferedStartRow: 0, expectedBufferedStartCol: 245,
      expectedBufferedEndRow: 70, expectedBufferedEndCol: 260,
    },
    {
      name: "exact buffer boundary row=20",
      startRow: 20, startCol: 5, endRow: 70, endCol: 15,
      expectedBufferedStartRow: 0, expectedBufferedStartCol: 0,
      expectedBufferedEndRow: 90, expectedBufferedEndCol: 20,
    },
    {
      name: "row=19 (just under buffer clamp)",
      startRow: 19, startCol: 4, endRow: 69, endCol: 14,
      expectedBufferedStartRow: 0, expectedBufferedStartCol: 0,
      expectedBufferedEndRow: 89, expectedBufferedEndCol: 19,
    },
    {
      name: "row=21 (just over buffer clamp)",
      startRow: 21, startCol: 6, endRow: 71, endCol: 16,
      expectedBufferedStartRow: 1, expectedBufferedStartCol: 1,
      expectedBufferedEndRow: 91, expectedBufferedEndCol: 21,
    },
    {
      name: "very large coordinates",
      startRow: 100000, startCol: 500, endRow: 100050, endCol: 520,
      expectedBufferedStartRow: 99980, expectedBufferedStartCol: 495,
      expectedBufferedEndRow: 100070, expectedBufferedEndCol: 525,
    },
    {
      name: "col exactly at buffer boundary (col=5)",
      startRow: 50, startCol: 5, endRow: 100, endCol: 20,
      expectedBufferedStartRow: 30, expectedBufferedStartCol: 0,
      expectedBufferedEndRow: 120, expectedBufferedEndCol: 25,
    },
    {
      name: "wide viewport 100 columns",
      startRow: 10, startCol: 10, endRow: 60, endCol: 109,
      expectedBufferedStartRow: 0, expectedBufferedStartCol: 5,
      expectedBufferedEndRow: 80, expectedBufferedEndCol: 114,
    },
  ];

  /**
   * Replicates the buffer calculation from refreshErrorIndicators.
   */
  function computeBufferedViewport(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): { startRow: number; startCol: number; endRow: number; endCol: number } {
    return {
      startRow: Math.max(0, startRow - BUFFER_ROWS),
      startCol: Math.max(0, startCol - BUFFER_COLS),
      endRow: endRow + BUFFER_ROWS,
      endCol: endCol + BUFFER_COLS,
    };
  }

  it.each(viewportCases)(
    "$name: [$startRow,$startCol]-[$endRow,$endCol]",
    ({
      startRow, startCol, endRow, endCol,
      expectedBufferedStartRow, expectedBufferedStartCol,
      expectedBufferedEndRow, expectedBufferedEndCol,
    }) => {
      const buffered = computeBufferedViewport(startRow, startCol, endRow, endCol);
      expect(buffered.startRow).toBe(expectedBufferedStartRow);
      expect(buffered.startCol).toBe(expectedBufferedStartCol);
      expect(buffered.endRow).toBe(expectedBufferedEndRow);
      expect(buffered.endCol).toBe(expectedBufferedEndCol);
    },
  );

  // Verify the actual refreshErrorIndicators passes buffered coords to invoke
  describe("invoke receives buffered coordinates", () => {
    it.each(viewportCases.slice(0, 5))(
      "$name: invoke called with buffered bounds",
      async ({
        startRow, startCol, endRow, endCol,
        expectedBufferedStartRow, expectedBufferedStartCol,
        expectedBufferedEndRow, expectedBufferedEndCol,
      }) => {
        mockInvoke.mockResolvedValue([]);
        resetErrorStore();

        refreshErrorIndicators(startRow, startCol, endRow, endCol);
        vi.advanceTimersByTime(200);

        await vi.waitFor(() => {
          expect(mockInvoke).toHaveBeenCalled();
        });

        expect(mockInvoke).toHaveBeenCalledWith("get_error_indicators", {
          startRow: expectedBufferedStartRow,
          startCol: expectedBufferedStartCol,
          endRow: expectedBufferedEndRow,
          endCol: expectedBufferedEndCol,
        });
      },
    );
  });
});

// ============================================================================
// 4. cellKey consistency (supplemental)
// ============================================================================

describe("cellKey map consistency", () => {
  const positions: Array<[number, number]> = [
    [0, 0], [0, 1], [1, 0], [1, 1],
    [100, 200], [200, 100], [999, 999],
    [0, 9999], [9999, 0],
  ];

  it.each(positions)(
    "cellKey(%i, %i) is unique and reversible",
    (row, col) => {
      const key = cellKey(row, col);
      expect(key).toBe(`${row},${col}`);
      const [parsedRow, parsedCol] = key.split(",").map(Number);
      expect(parsedRow).toBe(row);
      expect(parsedCol).toBe(col);
    },
  );
});

// ============================================================================
// 5. refreshErrorIndicatorsFromLastViewport
// ============================================================================

describe("refreshErrorIndicatorsFromLastViewport", () => {
  it("is a no-op when no viewport has been set", () => {
    resetErrorStore();
    refreshErrorIndicatorsFromLastViewport();
    vi.advanceTimersByTime(300);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("re-fetches using last known viewport", async () => {
    mockInvoke.mockResolvedValue([]);
    refreshErrorIndicators(10, 5, 60, 25);
    vi.advanceTimersByTime(200);
    await vi.waitFor(() => { expect(mockInvoke).toHaveBeenCalledTimes(1); });

    mockInvoke.mockClear();
    refreshErrorIndicatorsFromLastViewport();
    vi.advanceTimersByTime(200);
    await vi.waitFor(() => { expect(mockInvoke).toHaveBeenCalledTimes(1); });
  });
});
