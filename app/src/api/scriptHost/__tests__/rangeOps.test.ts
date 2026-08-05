//! FILENAME: app/src/api/scriptHost/__tests__/rangeOps.test.ts
// PURPOSE: Wave 4, RANGE-OPS cluster — the executors behind the new range
//          rows and the range clamp on find/replace:
//            - executeFindAll clamps matches to the `range` option (Box or A1)
//              and re-counts AFTER the clamp;
//            - executeReplaceAll's range path mirrors the Rust value
//              transform (computeRangeReplacement twin of
//              compute_replacement_value), skips formulas, and writes ONE
//              guarded batch;
//            - executeRemoveDuplicates converts RANGE-START OFFSETS to the
//              absolute key columns the backend takes (default: every
//              column), and is ACTIVE SHEET only;
//            - executeGetSpecialCells passes the resolved sheet through;
//            - executeGoalSeek is ACTIVE SHEET only and maps
//              foundSolution/variableValue to converged/solution;
//            - executeTextToColumns REFUSES without a registered provider
//              (the @api/textToColumnsService seam) and attributes every
//              written cell when one is registered.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const gridMock = {
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
  // null = "no grid mounted" (headless): the manual-hide union passes through.
  // Individual tests override this to model manually hidden rows/cols.
  getGridStateSnapshot: vi.fn((): unknown => null),
};
vi.mock("../../grid", () => gridMock);
const cellEventsMock = { emitBatch: vi.fn() };
vi.mock("../../../core/lib/cellEvents", () => ({
  cellEvents: cellEventsMock,
  cellToChange: vi.fn((c: unknown) => c),
}));
// The writeback draft gate is Rust-authoritative; here every write is plain.
vi.mock("../writebackWriteGuard", () => ({
  captureWritebackWrite: vi.fn(async () => false),
  captureWritebackWrites: vi.fn(
    async (_scriptId: string, writes: Array<{ sheetIndex: number; row: number; col: number; value: string }>) => ({
      plain: writes,
      drafted: [],
    }),
  ),
  workbookHasWritebackRegions: vi.fn(() => false),
}));

import {
  executeFindAll,
  executeReplaceAll,
  executeRemoveDuplicates,
  executeGetSpecialCells,
  executeGoalSeek,
  executeTextToColumns,
  computeRangeReplacement,
  replaceCaseInsensitiveAll,
  resolveScriptRangeSpec,
} from "../host";
import {
  registerTextToColumnsController,
  resetTextToColumnsController,
  type TextToColumnsRequest,
} from "../../textToColumnsService";
import type { ScriptCell } from "../../scriptableObjects";

// Sheet list: active = 0 ("Main"); "Data" (1) is the off-sheet target.
const SHEETS = [
  { index: 0, name: "Main" },
  { index: 1, name: "Data" },
];

/** A typed cell in readTypedRange's dense-grid shape. */
function cell(
  value: string | number | boolean | null,
  type: ScriptCell["type"],
  formula?: string,
): ScriptCell {
  const c: ScriptCell = { value, display: String(value ?? ""), type };
  if (formula) c.formula = formula;
  return c;
}

function makeLib() {
  return {
    getActiveSheet: vi.fn(async () => 0),
    getSheets: vi.fn(async () => ({ sheets: SHEETS, activeIndex: 0 })),
    findAll: vi.fn(async () => ({
      matches: [[0, 0], [2, 3], [7, 1], [50, 50]] as Array<[number, number]>,
      totalCount: 4,
    })),
    replaceAll: vi.fn(async () => ({ updatedCells: [], replacementCount: 4 })),
    // 2x2 rectangle used by the range-replace tests (B2:C3 -> 1,1..2,2).
    getRangeCellsTyped: vi.fn(async () => [
      { row: 1, col: 1, value: "alpha beta", display: "alpha beta", type: "text" },
      { row: 1, col: 2, value: 42, display: "42", type: "number" },
      { row: 2, col: 1, value: "beta", display: "beta", type: "text", formula: "=X1" },
      { row: 2, col: 2, value: "BETA", display: "BETA", type: "text" },
    ]),
    updateCellsBatch: vi.fn(async () => []),
    updateCell: vi.fn(async () => ({ cells: [] })),
    updateCellOnSheets: vi.fn(async () => [1]),
    recalculateSheetsAfterScriptWrite: vi.fn(async () => undefined),
    getUndoState: vi.fn(async () => ({ transactionOpen: false })),
    beginUndoTransaction: vi.fn(async () => undefined),
    commitUndoTransaction: vi.fn(async () => undefined),
    cancelUndoTransaction: vi.fn(async () => undefined),
    removeDuplicates: vi.fn(async () => ({
      success: true,
      duplicatesRemoved: 3,
      uniqueRemaining: 7,
      updatedCells: [{ row: 1, col: 0 }],
      error: null as string | null,
    })),
    getSpecialCells: vi.fn(async () => ({
      cells: [{ row: 1, col: 0 }, { row: 3, col: 2 }],
      truncated: false,
    })),
    goalSeek: vi.fn(async () => ({
      foundSolution: true,
      variableValue: 123.5,
      targetResult: 250000.0001,
      iterations: 17,
      originalVariableValue: 100,
      updatedCells: [{ row: 1, col: 1 }, { row: 9, col: 1 }],
      error: null as string | null,
    })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

beforeEach(() => {
  vi.clearAllMocks();
  resetTextToColumnsController();
});

afterEach(() => {
  resetTextToColumnsController();
});

// ============================================================================
// resolveScriptRangeSpec: the range option's two spellings
// ============================================================================

describe("resolveScriptRangeSpec", () => {
  it("parses an A1 spelling to a normalized box", () => {
    expect(resolveScriptRangeSpec("B2:D10", "findAll")).toEqual({
      startRow: 1, startCol: 1, endRow: 9, endCol: 3,
    });
    expect(resolveScriptRangeSpec("C5", "findAll")).toEqual({
      startRow: 4, startCol: 2, endRow: 4, endCol: 2,
    });
  });

  it("normalizes a swapped box", () => {
    expect(
      resolveScriptRangeSpec({ startRow: 9, startCol: 3, endRow: 1, endCol: 1 }, "findAll"),
    ).toEqual({ startRow: 1, startCol: 1, endRow: 9, endCol: 3 });
  });

  it("refuses a sheet-prefixed A1 spelling (the sheet slot is sheetIndex)", () => {
    expect(() => resolveScriptRangeSpec("Data!A1:B2", "findAll")).toThrow(/options\.sheetIndex/);
  });

  it("refuses a non-A1 string", () => {
    expect(() => resolveScriptRangeSpec("not a range", "findAll")).toThrow(/A1 range/);
  });
});

// ============================================================================
// executeFindAll: the range clamp
// ============================================================================

describe("executeFindAll with a range", () => {
  it("clamps matches to the box and re-counts AFTER the clamp", async () => {
    const lib = makeLib();
    const result = await executeFindAll(asLib(lib), "x", {
      range: { startRow: 1, startCol: 0, endRow: 10, endCol: 5 },
    });
    // (0,0) is above the box, (50,50) outside it; (2,3) and (7,1) survive.
    expect(result.matches).toEqual([{ row: 2, col: 3 }, { row: 7, col: 1 }]);
    expect(result.totalCount).toBe(2);
  });

  it("accepts the A1 spelling of the same box", async () => {
    const lib = makeLib();
    const result = await executeFindAll(asLib(lib), "x", { range: "A2:F11" });
    expect(result.totalCount).toBe(2);
  });

  it("without a range, the whole-sheet answer is untouched", async () => {
    const lib = makeLib();
    const result = await executeFindAll(asLib(lib), "x", {});
    expect(result.totalCount).toBe(4);
  });

  it("a malformed A1 range fails BEFORE the backend search runs", async () => {
    const lib = makeLib();
    await expect(executeFindAll(asLib(lib), "x", { range: "%%" })).rejects.toThrow(/A1 range/);
    expect(lib.findAll).not.toHaveBeenCalled();
  });
});

// ============================================================================
// computeRangeReplacement: TWIN of compute_replacement_value (search.rs)
// ============================================================================

describe("computeRangeReplacement", () => {
  it("replaces every occurrence in a text cell", () => {
    expect(computeRangeReplacement(cell("beta beta", "text"), "beta", "x", true, false))
      .toEqual({ value: "x x", invariant: false });
  });

  it("is case-insensitive unless asked otherwise", () => {
    expect(computeRangeReplacement(cell("BETA", "text"), "beta", "x", false, false))
      .toEqual({ value: "x", invariant: false });
    expect(computeRangeReplacement(cell("BETA", "text"), "beta", "x", true, false)).toBeNull();
  });

  it("entire-cell mode requires the whole text to be the match", () => {
    expect(computeRangeReplacement(cell("beta", "text"), "beta", "x", true, true))
      .toEqual({ value: "x", invariant: false });
    expect(computeRangeReplacement(cell("beta!", "text"), "beta", "x", true, true)).toBeNull();
  });

  it("never rewrites a formula cell", () => {
    expect(computeRangeReplacement(cell("beta", "text", "=X1"), "beta", "x", true, false)).toBeNull();
  });

  it("a digit swap in a number stays a NUMBER (invariant write)", () => {
    expect(computeRangeReplacement(cell(42, "number"), "2", "3", true, false))
      .toEqual({ value: "43", invariant: true });
  });

  it("a number rewritten to non-numeric text lands as text", () => {
    expect(computeRangeReplacement(cell(42, "number"), "2", "x", true, false))
      .toEqual({ value: "4x", invariant: false });
  });

  it("booleans, errors and empties are left alone", () => {
    expect(computeRangeReplacement(cell(true, "boolean"), "TRUE", "x", true, false)).toBeNull();
    expect(computeRangeReplacement(cell("#DIV/0!", "error"), "DIV", "x", true, false)).toBeNull();
    expect(computeRangeReplacement(cell(null, "empty"), "a", "x", true, false)).toBeNull();
  });

  it("replaceCaseInsensitiveAll mirrors the Rust walk", () => {
    expect(replaceCaseInsensitiveAll("aBcABC", "abc", "-")).toBe("--");
    expect(replaceCaseInsensitiveAll("xyz", "abc", "-")).toBe("xyz");
    expect(replaceCaseInsensitiveAll("aaa", "", "-")).toBe("aaa");
  });
});

// ============================================================================
// executeReplaceAll: the range path
// ============================================================================

describe("executeReplaceAll with a range", () => {
  it("typed-reads the box, transforms, and writes ONE guarded batch", async () => {
    const lib = makeLib();
    const result = await executeReplaceAll(asLib(lib), "s1", "beta", "x", {
      range: { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
    });
    // "alpha beta" -> "alpha x"; "BETA" (case-insensitive) -> "x";
    // the formula cell and the number 42 are untouched.
    expect(result.replacementCount).toBe(2);
    expect(lib.replaceAll).not.toHaveBeenCalled(); // range path never calls the sheet-wide command
    expect(lib.getRangeCellsTyped).toHaveBeenCalledWith(1, 1, 2, 2, undefined);
    expect(lib.updateCellsBatch).toHaveBeenCalledTimes(1);
    expect(lib.updateCellsBatch).toHaveBeenCalledWith([
      { row: 1, col: 1, value: "alpha x", invariant: undefined },
      { row: 2, col: 2, value: "x", invariant: undefined },
    ]);
  });

  it("honours caseSensitive inside the range", async () => {
    const lib = makeLib();
    const result = await executeReplaceAll(asLib(lib), "s1", "beta", "x", {
      caseSensitive: true,
      range: { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
    });
    // Only "alpha beta" matches case-sensitively (the formula cell is skipped).
    expect(result.replacementCount).toBe(1);
  });

  it("without a range, the sheet-wide backend command still runs", async () => {
    const lib = makeLib();
    const result = await executeReplaceAll(asLib(lib), "s1", "a", "b", {});
    expect(result.replacementCount).toBe(4);
    expect(lib.replaceAll).toHaveBeenCalledTimes(1);
    expect(lib.getRangeCellsTyped).not.toHaveBeenCalled();
  });

  it("resolves the sheet ref for the typed read (off-sheet range replace)", async () => {
    const lib = makeLib();
    await executeReplaceAll(asLib(lib), "s1", "beta", "x", {
      sheetIndex: "Data",
      range: "B2:C3",
    });
    expect(lib.getRangeCellsTyped).toHaveBeenCalledWith(1, 1, 2, 2, 1);
    // Off-sheet writes go through the per-cell transactional path, not the
    // active-sheet batch.
    expect(lib.updateCellsBatch).not.toHaveBeenCalled();
    expect(lib.updateCellOnSheets).toHaveBeenCalled();
    expect(lib.recalculateSheetsAfterScriptWrite).toHaveBeenCalledWith([1]);
  });
});

// ============================================================================
// executeRemoveDuplicates
// ============================================================================

describe("executeRemoveDuplicates", () => {
  it("converts range-start offsets to absolute key columns", async () => {
    const lib = makeLib();
    const result = await executeRemoveDuplicates(
      asLib(lib), "s1", 0, 2, 9, 5, { columns: [0, 2], hasHeaders: true },
    );
    expect(result).toEqual({ removedCount: 3 });
    expect(lib.removeDuplicates).toHaveBeenCalledWith(0, 2, 9, 5, [2, 4], true);
  });

  it("defaults to EVERY column of the range and no headers", async () => {
    const lib = makeLib();
    await executeRemoveDuplicates(asLib(lib), "s1", 0, 3, 9, 5);
    expect(lib.removeDuplicates).toHaveBeenCalledWith(0, 3, 9, 5, [3, 4, 5], false);
  });

  it("is ACTIVE SHEET only: another sheet is refused, never redirected", async () => {
    const lib = makeLib();
    await expect(
      executeRemoveDuplicates(asLib(lib), "s1", 0, 0, 9, 3, undefined, "Data"),
    ).rejects.toThrow(/active sheet/);
    expect(lib.removeDuplicates).not.toHaveBeenCalled();
  });

  it("surfaces the backend's refusal", async () => {
    const lib = makeLib();
    lib.removeDuplicates.mockResolvedValueOnce({
      success: false, duplicatesRemoved: 0, uniqueRemaining: 0, updatedCells: [],
      error: "Range overlaps a protected region",
    });
    await expect(executeRemoveDuplicates(asLib(lib), "s1", 0, 0, 9, 3)).rejects.toThrow(
      /protected region/,
    );
  });
});

// ============================================================================
// executeGetSpecialCells
// ============================================================================

describe("executeGetSpecialCells", () => {
  it("passes the resolved sheet through and answers coordinates + truncated", async () => {
    const lib = makeLib();
    const result = await executeGetSpecialCells(asLib(lib), 0, 0, 99, 9, "visible", "Data");
    expect(lib.getSpecialCells).toHaveBeenCalledWith(0, 0, 99, 9, "visible", 1);
    expect(result).toEqual({
      cells: [{ row: 1, col: 0 }, { row: 3, col: 2 }],
      truncated: false,
    });
  });

  it("omitted sheet = the active sheet (undefined crosses to the backend)", async () => {
    const lib = makeLib();
    await executeGetSpecialCells(asLib(lib), 0, 0, 9, 9, "blanks");
    expect(lib.getSpecialCells).toHaveBeenCalledWith(0, 0, 9, 9, "blanks", undefined);
  });

  // The backend's "visible" authority covers filter + outline hides only —
  // rows/cols hidden BY HAND live in frontend Core state (manuallyHiddenRows/
  // Cols), so the executor must union them for the active sheet (the Rust
  // get_special_cells contract says exactly that) and must NOT pretend to
  // know them for a background sheet.
  it('"visible" also drops manually hidden rows/cols on the ACTIVE sheet', async () => {
    const lib = makeLib();
    lib.getSpecialCells.mockResolvedValueOnce({
      cells: [
        { row: 1, col: 0 },
        { row: 3, col: 2 },
        { row: 5, col: 0 },
        { row: 6, col: 4 },
      ],
      truncated: false,
    });
    gridMock.getGridStateSnapshot.mockReturnValueOnce({
      sheetContext: { activeSheetIndex: 0 },
      dimensions: {
        manuallyHiddenRows: new Set([3]),
        manuallyHiddenCols: new Set([4]),
      },
    });
    const result = await executeGetSpecialCells(asLib(lib), 0, 0, 99, 9, "visible");
    expect(result.cells).toEqual([{ row: 1, col: 0 }, { row: 5, col: 0 }]);
  });

  it('"visible" on a BACKGROUND sheet passes through (no manual-hide state exists for it)', async () => {
    const lib = makeLib();
    gridMock.getGridStateSnapshot.mockReturnValueOnce({
      sheetContext: { activeSheetIndex: 0 },
      dimensions: { manuallyHiddenRows: new Set([1, 3]) },
    });
    const result = await executeGetSpecialCells(asLib(lib), 0, 0, 99, 9, "visible", "Data");
    expect(result.cells).toEqual([{ row: 1, col: 0 }, { row: 3, col: 2 }]);
  });

  it('non-"visible" kinds never consult the grid snapshot', async () => {
    const lib = makeLib();
    await executeGetSpecialCells(asLib(lib), 0, 0, 9, 9, "constants");
    expect(gridMock.getGridStateSnapshot).not.toHaveBeenCalled();
  });
});

// ============================================================================
// executeGoalSeek
// ============================================================================

describe("executeGoalSeek", () => {
  const params = {
    targetRow: 9, targetCol: 1, targetValue: 250000,
    variableRow: 1, variableCol: 1,
  };

  it("maps the backend result to { converged, solution, iterations }", async () => {
    const lib = makeLib();
    const result = await executeGoalSeek(asLib(lib), "s1", params);
    expect(result).toEqual({ converged: true, solution: 123.5, iterations: 17 });
    expect(lib.goalSeek).toHaveBeenCalledWith({
      targetRow: 9, targetCol: 1, targetValue: 250000,
      variableRow: 1, variableCol: 1,
      maxIterations: undefined, tolerance: undefined,
    });
  });

  it("converged: false is an ANSWER, not an error", async () => {
    const lib = makeLib();
    lib.goalSeek.mockResolvedValueOnce({
      foundSolution: false, variableValue: 99, targetResult: 1, iterations: 100,
      originalVariableValue: 100, updatedCells: [], error: null,
    });
    const result = await executeGoalSeek(asLib(lib), "s1", params);
    expect(result).toEqual({ converged: false, solution: 99, iterations: 100 });
  });

  it("a validation error from the backend rejects", async () => {
    const lib = makeLib();
    lib.goalSeek.mockResolvedValueOnce({
      foundSolution: false, variableValue: 0, targetResult: 0, iterations: 0,
      originalVariableValue: 0, updatedCells: [],
      error: "Target cell must contain a formula",
    });
    await expect(executeGoalSeek(asLib(lib), "s1", params)).rejects.toThrow(/must contain a formula/);
  });

  it("is ACTIVE SHEET only", async () => {
    const lib = makeLib();
    await expect(
      executeGoalSeek(asLib(lib), "s1", { ...params, sheetIndex: "Data" }),
    ).rejects.toThrow(/active sheet/);
    expect(lib.goalSeek).not.toHaveBeenCalled();
  });
});

// ============================================================================
// executeTextToColumns: the @api seam
// ============================================================================

describe("executeTextToColumns", () => {
  it("REFUSES when no provider is registered (extension disabled)", async () => {
    const lib = makeLib();
    await expect(
      executeTextToColumns(asLib(lib), "s1", 0, 0, 9, 0, { delimiters: [";"] }),
    ).rejects.toThrow(/no provider is registered/);
  });

  it("runs the registered provider and returns the counts", async () => {
    const lib = makeLib();
    const split = vi.fn(async (request: TextToColumnsRequest) => ({
      rowsProcessed: request.endRow - request.startRow + 1,
      columnsProduced: 3,
      cellsWritten: 30,
      writtenCells: [{ row: 0, col: 0 }, { row: 0, col: 1 }],
    }));
    const unregister = registerTextToColumnsController({ split });
    try {
      const result = await executeTextToColumns(asLib(lib), "s1", 0, 0, 9, 0, {
        delimiters: [";"], consecutiveAsOne: true, destination: { row: 0, col: 5 },
      });
      expect(result).toEqual({ rowsProcessed: 10, columnsProduced: 3, cellsWritten: 30 });
      expect(split).toHaveBeenCalledWith({
        startRow: 0, startCol: 0, endRow: 9, endCol: 0,
        delimiters: [";"], consecutiveAsOne: true, destination: { row: 0, col: 5 },
      });
    } finally {
      unregister();
    }
  });

  it("is ACTIVE SHEET only: options.sheetIndex naming another sheet refuses", async () => {
    const lib = makeLib();
    const split = vi.fn(async () => ({
      rowsProcessed: 0, columnsProduced: 0, cellsWritten: 0, writtenCells: [],
    }));
    const unregister = registerTextToColumnsController({ split });
    try {
      await expect(
        executeTextToColumns(asLib(lib), "s1", 0, 0, 9, 0, { sheetIndex: "Data" }),
      ).rejects.toThrow(/active sheet/);
      expect(split).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("naming the ACTIVE sheet by name is fine", async () => {
    const lib = makeLib();
    const split = vi.fn(async () => ({
      rowsProcessed: 1, columnsProduced: 1, cellsWritten: 1, writtenCells: [],
    }));
    const unregister = registerTextToColumnsController({ split });
    try {
      const result = await executeTextToColumns(asLib(lib), "s1", 0, 0, 0, 0, {
        sheetIndex: "Main",
      });
      expect(result.cellsWritten).toBe(1);
    } finally {
      unregister();
    }
  });
});
