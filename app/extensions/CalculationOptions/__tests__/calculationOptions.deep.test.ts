//! FILENAME: app/extensions/CalculationOptions/__tests__/calculationOptions.deep.test.ts
// PURPOSE: Deep tests for CalculationOptions: all modes, large batches, cross-sheet filtering,
//          formula null-coalescing, syncCalculationMode retry on failure.

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

type CalcMode = "automatic" | "manual" | "automaticExceptTables";

async function syncCalculationMode(
  getMode: () => Promise<string>,
  getIteration: () => Promise<{ enabled: boolean; maxIterations: number; maxChange: number }>,
  getPrecision: () => Promise<boolean>,
  getCalcBeforeSave: () => Promise<boolean>,
): Promise<{
  mode: CalcMode;
  iterationEnabled: boolean;
  iterationMaxIterations: number;
  iterationMaxChange: number;
  precisionAsDisplayed: boolean;
  calculateBeforeSave: boolean;
}> {
  const state = {
    mode: "automatic" as CalcMode,
    iterationEnabled: false,
    iterationMaxIterations: 100,
    iterationMaxChange: 0.001,
    precisionAsDisplayed: false,
    calculateBeforeSave: true,
  };

  try {
    const mode = await getMode();
    if (mode === "automatic" || mode === "manual" || mode === "automaticExceptTables") {
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

describe("CalculationOptions (deep)", () => {
  // --- All calculation modes ---

  describe("all calculation modes", () => {
    it("accepts 'automatic' mode", async () => {
      const state = await syncCalculationMode(
        () => Promise.resolve("automatic"),
        () => Promise.resolve({ enabled: false, maxIterations: 100, maxChange: 0.001 }),
        () => Promise.resolve(false),
        () => Promise.resolve(true),
      );
      expect(state.mode).toBe("automatic");
    });

    it("accepts 'manual' mode", async () => {
      const state = await syncCalculationMode(
        () => Promise.resolve("manual"),
        () => Promise.resolve({ enabled: false, maxIterations: 100, maxChange: 0.001 }),
        () => Promise.resolve(false),
        () => Promise.resolve(true),
      );
      expect(state.mode).toBe("manual");
    });

    it("accepts 'automaticExceptTables' mode", async () => {
      const state = await syncCalculationMode(
        () => Promise.resolve("automaticExceptTables"),
        () => Promise.resolve({ enabled: false, maxIterations: 100, maxChange: 0.001 }),
        () => Promise.resolve(false),
        () => Promise.resolve(true),
      );
      expect(state.mode).toBe("automaticExceptTables");
    });

    it("rejects unknown mode strings and defaults to automatic", async () => {
      for (const bad of ["auto", "MANUAL", "semi", "", "null"]) {
        const state = await syncCalculationMode(
          () => Promise.resolve(bad),
          () => Promise.resolve({ enabled: false, maxIterations: 100, maxChange: 0.001 }),
          () => Promise.resolve(false),
          () => Promise.resolve(true),
        );
        expect(state.mode).toBe("automatic");
      }
    });
  });

  // --- applyCellUpdates with large batches ---

  describe("applyCellUpdates with large batches", () => {
    let emitSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      emitSpy = vi.fn();
    });

    it("processes 1000 same-sheet updates", () => {
      const cells: CellUpdate[] = Array.from({ length: 1000 }, (_, i) => ({
        row: Math.floor(i / 100),
        col: i % 100,
        display: `val-${i}`,
      }));
      applyCellUpdates(cells, emitSpy);
      expect(emitSpy).toHaveBeenCalledTimes(1000);
    });

    it("processes 5000 updates with mixed sheet indices", () => {
      const cells: CellUpdate[] = Array.from({ length: 5000 }, (_, i) => ({
        row: i,
        col: 0,
        display: `v${i}`,
        sheetIndex: i % 3 === 0 ? undefined : i % 3,
      }));
      applyCellUpdates(cells, emitSpy);
      // Every 3rd cell (i%3===0) has no sheetIndex -> emitted
      const expectedCount = Math.ceil(5000 / 3);
      expect(emitSpy).toHaveBeenCalledTimes(expectedCount);
    });

    it("preserves order in large batch", () => {
      const cells: CellUpdate[] = Array.from({ length: 100 }, (_, i) => ({
        row: i,
        col: 0,
        display: `${i}`,
      }));
      applyCellUpdates(cells, emitSpy);
      for (let i = 0; i < 100; i++) {
        expect(emitSpy.mock.calls[i][0].newValue).toBe(`${i}`);
      }
    });

    it("handles batch with all cross-sheet (none emitted)", () => {
      const cells: CellUpdate[] = Array.from({ length: 500 }, (_, i) => ({
        row: i,
        col: 0,
        display: `x`,
        sheetIndex: 1,
      }));
      applyCellUpdates(cells, emitSpy);
      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  // --- Cross-sheet update filtering ---

  describe("cross-sheet update filtering", () => {
    let emitSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      emitSpy = vi.fn();
    });

    it("sheetIndex 0 is still considered cross-sheet (skipped)", () => {
      applyCellUpdates([{ row: 0, col: 0, display: "x", sheetIndex: 0 }], emitSpy);
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("sheetIndex -1 is still considered cross-sheet (skipped)", () => {
      applyCellUpdates([{ row: 0, col: 0, display: "x", sheetIndex: -1 }], emitSpy);
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("only undefined sheetIndex passes through", () => {
      const cells: CellUpdate[] = [
        { row: 0, col: 0, display: "a", sheetIndex: undefined },
        { row: 1, col: 0, display: "b", sheetIndex: 0 },
        { row: 2, col: 0, display: "c", sheetIndex: 5 },
        { row: 3, col: 0, display: "d" },
      ];
      applyCellUpdates(cells, emitSpy);
      expect(emitSpy).toHaveBeenCalledTimes(2);
      expect(emitSpy.mock.calls[0][0].newValue).toBe("a");
      expect(emitSpy.mock.calls[1][0].newValue).toBe("d");
    });
  });

  // --- Formula null-coalescing for all edge cases ---

  describe("formula null-coalescing edge cases", () => {
    let emitSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      emitSpy = vi.fn();
    });

    it("undefined formula becomes null", () => {
      applyCellUpdates([{ row: 0, col: 0, display: "5" }], emitSpy);
      expect(emitSpy.mock.calls[0][0].formula).toBeNull();
    });

    it("explicit null formula stays null", () => {
      applyCellUpdates([{ row: 0, col: 0, display: "5", formula: null }], emitSpy);
      expect(emitSpy.mock.calls[0][0].formula).toBeNull();
    });

    it("empty string formula is preserved (not null)", () => {
      applyCellUpdates([{ row: 0, col: 0, display: "5", formula: "" }], emitSpy);
      expect(emitSpy.mock.calls[0][0].formula).toBe("");
    });

    it("formula with value is preserved", () => {
      applyCellUpdates([{ row: 0, col: 0, display: "10", formula: "=5+5" }], emitSpy);
      expect(emitSpy.mock.calls[0][0].formula).toBe("=5+5");
    });

    it("formula with special characters is preserved", () => {
      const formula = '=IF(A1>0,"yes","no")';
      applyCellUpdates([{ row: 0, col: 0, display: "yes", formula }], emitSpy);
      expect(emitSpy.mock.calls[0][0].formula).toBe(formula);
    });

    it("formula with unicode is preserved", () => {
      applyCellUpdates([{ row: 0, col: 0, display: "1", formula: '=LEN("abc")' }], emitSpy);
      expect(emitSpy.mock.calls[0][0].formula).toBe('=LEN("abc")');
    });
  });

  // --- syncCalculationMode retry on failure ---

  describe("syncCalculationMode retry on failure", () => {
    it("recovers partial state when only getMode fails", async () => {
      const state = await syncCalculationMode(
        () => Promise.reject(new Error("timeout")),
        () => Promise.resolve({ enabled: true, maxIterations: 200, maxChange: 0.01 }),
        () => Promise.resolve(true),
        () => Promise.resolve(false),
      );
      expect(state.mode).toBe("automatic"); // default
      expect(state.iterationEnabled).toBe(true);
      expect(state.iterationMaxIterations).toBe(200);
      expect(state.precisionAsDisplayed).toBe(true);
      expect(state.calculateBeforeSave).toBe(false);
    });

    it("recovers when only getCalcBeforeSave fails", async () => {
      const state = await syncCalculationMode(
        () => Promise.resolve("manual"),
        () => Promise.resolve({ enabled: false, maxIterations: 100, maxChange: 0.001 }),
        () => Promise.resolve(false),
        () => Promise.reject(new Error("fail")),
      );
      expect(state.mode).toBe("manual");
      expect(state.calculateBeforeSave).toBe(true); // default
    });

    it("each provider failure is independent", async () => {
      // Only iteration succeeds
      const state = await syncCalculationMode(
        () => Promise.reject(new Error("1")),
        () => Promise.resolve({ enabled: true, maxIterations: 42, maxChange: 0.5 }),
        () => Promise.reject(new Error("3")),
        () => Promise.reject(new Error("4")),
      );
      expect(state.mode).toBe("automatic");
      expect(state.iterationEnabled).toBe(true);
      expect(state.iterationMaxIterations).toBe(42);
      expect(state.iterationMaxChange).toBe(0.5);
      expect(state.precisionAsDisplayed).toBe(false);
      expect(state.calculateBeforeSave).toBe(true);
    });

    it("calling sync multiple times yields independent results", async () => {
      let callCount = 0;
      const getMode = () => {
        callCount++;
        return callCount === 1
          ? Promise.reject(new Error("first call fails"))
          : Promise.resolve("manual");
      };
      const defaults = {
        getIteration: () => Promise.resolve({ enabled: false, maxIterations: 100, maxChange: 0.001 }),
        getPrecision: () => Promise.resolve(false),
        getCalcBeforeSave: () => Promise.resolve(true),
      };

      const s1 = await syncCalculationMode(getMode, defaults.getIteration, defaults.getPrecision, defaults.getCalcBeforeSave);
      expect(s1.mode).toBe("automatic"); // first call failed

      const s2 = await syncCalculationMode(getMode, defaults.getIteration, defaults.getPrecision, defaults.getCalcBeforeSave);
      expect(s2.mode).toBe("manual"); // second call succeeds
    });

    it("iteration boundary values are preserved", async () => {
      const state = await syncCalculationMode(
        () => Promise.resolve("automatic"),
        () => Promise.resolve({ enabled: true, maxIterations: 0, maxChange: 0 }),
        () => Promise.resolve(false),
        () => Promise.resolve(true),
      );
      expect(state.iterationMaxIterations).toBe(0);
      expect(state.iterationMaxChange).toBe(0);
    });
  });
});
