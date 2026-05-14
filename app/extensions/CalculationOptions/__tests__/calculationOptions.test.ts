//! FILENAME: app/extensions/CalculationOptions/__tests__/calculationOptions.test.ts
// PURPOSE: Tests for CalculationOptions logic: applyCellUpdates filtering,
//          syncCalculationMode state management, and mode toggling.
// CONTEXT: Logic from handlers/formulasMenuItemBuilder.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================================
// Replicate pure logic from formulasMenuItemBuilder.ts
// ============================================================================

interface CellUpdate {
  row: number;
  col: number;
  display: string;
  formula?: string | null;
  sheetIndex?: number;
}

interface CellEvent {
  row: number;
  col: number;
  oldValue: undefined;
  newValue: string;
  formula: string | null;
}

/**
 * Replicates applyCellUpdates: filters out cross-sheet cells and emits events
 * for same-sheet cells.
 */
function applyCellUpdates(
  cells: CellUpdate[],
  emit: (event: CellEvent) => void,
): void {
  for (const cell of cells) {
    if (cell.sheetIndex !== undefined) {
      continue;
    }
    emit({
      row: cell.row,
      col: cell.col,
      oldValue: undefined,
      newValue: cell.display,
      formula: cell.formula ?? null,
    });
  }
}

/**
 * Replicates syncCalculationMode logic: takes async results and updates state.
 */
async function syncCalculationMode(
  getMode: () => Promise<string>,
  getIteration: () => Promise<{ enabled: boolean; maxIterations: number; maxChange: number }>,
  getPrecision: () => Promise<boolean>,
  getCalcBeforeSave: () => Promise<boolean>,
): Promise<{
  mode: "automatic" | "manual";
  iterationEnabled: boolean;
  iterationMaxIterations: number;
  iterationMaxChange: number;
  precisionAsDisplayed: boolean;
  calculateBeforeSave: boolean;
}> {
  const state = {
    mode: "automatic" as "automatic" | "manual",
    iterationEnabled: false,
    iterationMaxIterations: 100,
    iterationMaxChange: 0.001,
    precisionAsDisplayed: false,
    calculateBeforeSave: true,
  };

  try {
    const mode = await getMode();
    if (mode === "automatic" || mode === "manual") {
      state.mode = mode;
    }
  } catch {
    // keep default
  }

  try {
    const settings = await getIteration();
    state.iterationEnabled = settings.enabled;
    state.iterationMaxIterations = settings.maxIterations;
    state.iterationMaxChange = settings.maxChange;
  } catch {
    // keep default
  }

  try {
    state.precisionAsDisplayed = await getPrecision();
  } catch {
    // keep default
  }

  try {
    state.calculateBeforeSave = await getCalcBeforeSave();
  } catch {
    // keep default
  }

  return state;
}

// ============================================================================
// Tests
// ============================================================================

describe("CalculationOptions", () => {
  describe("applyCellUpdates", () => {
    let emitSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      emitSpy = vi.fn();
    });

    it("emits events for cells without sheetIndex", () => {
      const cells: CellUpdate[] = [
        { row: 0, col: 0, display: "42" },
        { row: 1, col: 1, display: "hello", formula: "=A1" },
      ];
      applyCellUpdates(cells, emitSpy);
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    it("skips cells with sheetIndex (cross-sheet)", () => {
      const cells: CellUpdate[] = [
        { row: 0, col: 0, display: "42", sheetIndex: 0 },
        { row: 1, col: 1, display: "hello", sheetIndex: 2 },
      ];
      applyCellUpdates(cells, emitSpy);
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("mixes same-sheet and cross-sheet cells correctly", () => {
      const cells: CellUpdate[] = [
        { row: 0, col: 0, display: "A" },
        { row: 1, col: 1, display: "B", sheetIndex: 1 },
        { row: 2, col: 2, display: "C" },
      ];
      applyCellUpdates(cells, emitSpy);
      expect(emitSpy).toHaveBeenCalledTimes(2);
      expect(emitSpy.mock.calls[0][0].newValue).toBe("A");
      expect(emitSpy.mock.calls[1][0].newValue).toBe("C");
    });

    it("converts null/undefined formula to null", () => {
      applyCellUpdates([{ row: 0, col: 0, display: "5" }], emitSpy);
      expect(emitSpy.mock.calls[0][0].formula).toBeNull();

      emitSpy.mockClear();
      applyCellUpdates([{ row: 0, col: 0, display: "5", formula: null }], emitSpy);
      expect(emitSpy.mock.calls[0][0].formula).toBeNull();
    });

    it("preserves formula string when present", () => {
      applyCellUpdates([{ row: 0, col: 0, display: "5", formula: "=2+3" }], emitSpy);
      expect(emitSpy.mock.calls[0][0].formula).toBe("=2+3");
    });

    it("handles empty cells array", () => {
      applyCellUpdates([], emitSpy);
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("always sets oldValue to undefined", () => {
      applyCellUpdates([{ row: 0, col: 0, display: "x" }], emitSpy);
      expect(emitSpy.mock.calls[0][0].oldValue).toBeUndefined();
    });
  });

  describe("syncCalculationMode", () => {
    it("syncs all settings from backend", async () => {
      const state = await syncCalculationMode(
        () => Promise.resolve("manual"),
        () => Promise.resolve({ enabled: true, maxIterations: 50, maxChange: 0.01 }),
        () => Promise.resolve(true),
        () => Promise.resolve(false),
      );

      expect(state.mode).toBe("manual");
      expect(state.iterationEnabled).toBe(true);
      expect(state.iterationMaxIterations).toBe(50);
      expect(state.iterationMaxChange).toBe(0.01);
      expect(state.precisionAsDisplayed).toBe(true);
      expect(state.calculateBeforeSave).toBe(false);
    });

    it("keeps defaults when backend returns invalid mode", async () => {
      const state = await syncCalculationMode(
        () => Promise.resolve("semi-automatic"),
        () => Promise.resolve({ enabled: false, maxIterations: 100, maxChange: 0.001 }),
        () => Promise.resolve(false),
        () => Promise.resolve(true),
      );

      expect(state.mode).toBe("automatic");
    });

    it("keeps defaults when getMode throws", async () => {
      const state = await syncCalculationMode(
        () => Promise.reject(new Error("network error")),
        () => Promise.resolve({ enabled: false, maxIterations: 100, maxChange: 0.001 }),
        () => Promise.resolve(false),
        () => Promise.resolve(true),
      );

      expect(state.mode).toBe("automatic");
    });

    it("keeps iteration defaults when getIteration throws", async () => {
      const state = await syncCalculationMode(
        () => Promise.resolve("automatic"),
        () => Promise.reject(new Error("fail")),
        () => Promise.resolve(false),
        () => Promise.resolve(true),
      );

      expect(state.iterationEnabled).toBe(false);
      expect(state.iterationMaxIterations).toBe(100);
      expect(state.iterationMaxChange).toBe(0.001);
    });

    it("keeps precision default when getPrecision throws", async () => {
      const state = await syncCalculationMode(
        () => Promise.resolve("automatic"),
        () => Promise.resolve({ enabled: false, maxIterations: 100, maxChange: 0.001 }),
        () => Promise.reject(new Error("fail")),
        () => Promise.resolve(true),
      );

      expect(state.precisionAsDisplayed).toBe(false);
    });

    it("handles all backends failing gracefully", async () => {
      const state = await syncCalculationMode(
        () => Promise.reject(new Error("fail")),
        () => Promise.reject(new Error("fail")),
        () => Promise.reject(new Error("fail")),
        () => Promise.reject(new Error("fail")),
      );

      expect(state.mode).toBe("automatic");
      expect(state.iterationEnabled).toBe(false);
      expect(state.precisionAsDisplayed).toBe(false);
      expect(state.calculateBeforeSave).toBe(true);
    });
  });
});
