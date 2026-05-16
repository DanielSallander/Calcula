import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerEditGuard,
  checkEditGuards,
  registerRangeGuard,
  checkRangeGuards,
  type EditGuardFn,
  type RangeGuardFn,
} from "../editGuards";
import {
  registerCommitGuard,
  checkCommitGuards,
  type CommitGuardFn,
} from "../commitGuards";
import {
  registerCellClickInterceptor,
  checkCellClickInterceptors,
  registerCellCursorInterceptor,
  getCellCursorOverride,
  type CellClickInterceptorFn,
  type CellCursorInterceptorFn,
} from "../cellClickInterceptors";
import {
  registerCellDoubleClickInterceptor,
  checkCellDoubleClickInterceptors,
  type CellDoubleClickInterceptorFn,
} from "../cellDoubleClickInterceptors";
import {
  registerFormulaReferenceInterceptor,
  checkFormulaReferenceInterceptors,
  type FormulaReferenceInterceptorFn,
} from "../formulaReferenceInterceptors";

// ============================================================================
// Helpers
// ============================================================================

// Each registry uses a module-level Set, so we track cleanups manually.
let cleanups: (() => void)[] = [];

beforeEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function track(cleanup: () => void) {
  cleanups.push(cleanup);
  return cleanup;
}

// ============================================================================
// 1. Edit Guard - 50 cell position combos
// ============================================================================

describe("Edit guard (parameterized)", () => {
  const allowCases = Array.from({ length: 20 }, (_, i) => ({
    label: `allow-${i}`,
    row: i * 2,
    col: i * 3,
    result: null as null,
    expectBlocked: false,
  }));

  const blockCases = Array.from({ length: 20 }, (_, i) => ({
    label: `block-${i}`,
    row: i + 100,
    col: i + 50,
    result: { blocked: true, message: `Blocked at ${i + 100},${i + 50}` },
    expectBlocked: true,
  }));

  const errorCases = Array.from({ length: 10 }, (_, i) => ({
    label: `error-${i}`,
    row: i + 200,
    col: i + 200,
  }));

  describe("allow cases", () => {
    it.each(allowCases)(
      "$label: row=$row col=$col is allowed",
      async ({ row, col }) => {
        const guard: EditGuardFn = async () => null;
        track(registerEditGuard(guard));
        const result = await checkEditGuards(row, col);
        expect(result).toBeNull();
      }
    );
  });

  describe("block cases", () => {
    it.each(blockCases)(
      "$label: row=$row col=$col is blocked",
      async ({ row, col, result: guardResult }) => {
        const guard: EditGuardFn = async (r, c) => {
          if (r === row && c === col) return guardResult;
          return null;
        };
        track(registerEditGuard(guard));
        const result = await checkEditGuards(row, col);
        expect(result).not.toBeNull();
        expect(result!.blocked).toBe(true);
        expect(result!.message).toContain(String(row));
      }
    );
  });

  describe("error cases (guard throws)", () => {
    it.each(errorCases)(
      "$label: row=$row col=$col - guard error is caught",
      async ({ row, col }) => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const guard: EditGuardFn = async () => {
          throw new Error("Guard exploded");
        };
        track(registerEditGuard(guard));
        const result = await checkEditGuards(row, col);
        expect(result).toBeNull(); // Errors don't block
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
      }
    );
  });
});

// ============================================================================
// 2. Commit Guard - 30 value combos
// ============================================================================

describe("Commit guard (parameterized)", () => {
  const allowCases = Array.from({ length: 10 }, (_, i) => ({
    label: `allow-${i}`,
    row: i,
    col: i + 1,
    value: `valid-${i}`,
    action: "allow" as const,
  }));

  const blockCases = Array.from({ length: 10 }, (_, i) => ({
    label: `block-${i}`,
    row: i + 50,
    col: i + 10,
    value: `invalid-${i}`,
    action: "block" as const,
  }));

  const retryCases = Array.from({ length: 10 }, (_, i) => ({
    label: `retry-${i}`,
    row: i + 100,
    col: i + 20,
    value: `retry-${i}`,
    action: "retry" as const,
  }));

  describe("allow cases", () => {
    it.each(allowCases)(
      "$label: value=$value is allowed",
      async ({ row, col, value }) => {
        const guard: CommitGuardFn = async () => null;
        track(registerCommitGuard(guard));
        const result = await checkCommitGuards(row, col, value);
        expect(result).toBeNull();
      }
    );
  });

  describe("block cases", () => {
    it.each(blockCases)(
      "$label: value=$value is blocked",
      async ({ row, col, value }) => {
        const guard: CommitGuardFn = async (_r, _c, v) => {
          if (v === value) return { action: "block" };
          return null;
        };
        track(registerCommitGuard(guard));
        const result = await checkCommitGuards(row, col, value);
        expect(result).not.toBeNull();
        expect(result!.action).toBe("block");
      }
    );
  });

  describe("retry cases", () => {
    it.each(retryCases)(
      "$label: value=$value triggers retry",
      async ({ row, col, value }) => {
        const guard: CommitGuardFn = async (_r, _c, v) => {
          if (v === value) return { action: "retry" };
          return null;
        };
        track(registerCommitGuard(guard));
        const result = await checkCommitGuards(row, col, value);
        expect(result).not.toBeNull();
        expect(result!.action).toBe("retry");
      }
    );
  });
});

// ============================================================================
// 3. Range Guard - 40 range combos
// ============================================================================

describe("Range guard (parameterized)", () => {
  const allowRanges = Array.from({ length: 20 }, (_, i) => ({
    label: `allow-range-${i}`,
    startRow: i,
    startCol: i,
    endRow: i + 5,
    endCol: i + 3,
    expectBlocked: false,
  }));

  const blockRanges = Array.from({ length: 20 }, (_, i) => ({
    label: `block-range-${i}`,
    startRow: i + 1000,
    startCol: i + 1000,
    endRow: i + 1010,
    endCol: i + 1005,
    expectBlocked: true,
  }));

  describe("allow ranges", () => {
    it.each(allowRanges)(
      "$label: ($startRow,$startCol)-($endRow,$endCol) is allowed",
      ({ startRow, startCol, endRow, endCol }) => {
        const guard: RangeGuardFn = () => null;
        track(registerRangeGuard(guard));
        const result = checkRangeGuards(startRow, startCol, endRow, endCol);
        expect(result).toBeNull();
      }
    );
  });

  describe("block ranges", () => {
    it.each(blockRanges)(
      "$label: ($startRow,$startCol)-($endRow,$endCol) is blocked",
      ({ startRow, startCol, endRow, endCol }) => {
        const guard: RangeGuardFn = (sr, sc, er, ec) => {
          if (sr >= 1000) return { blocked: true, message: `Protected range ${sr},${sc}-${er},${ec}` };
          return null;
        };
        track(registerRangeGuard(guard));
        const result = checkRangeGuards(startRow, startCol, endRow, endCol);
        expect(result).not.toBeNull();
        expect(result!.blocked).toBe(true);
      }
    );
  });
});

// ============================================================================
// 4. Click Interceptor - 30 click position combos
// ============================================================================

describe("Cell click interceptor (parameterized)", () => {
  const handledCases = Array.from({ length: 15 }, (_, i) => ({
    label: `handled-${i}`,
    row: i * 2,
    col: i * 3,
    clientX: 100 + i * 10,
    clientY: 200 + i * 10,
    ctrlKey: i % 2 === 0,
    handled: true,
  }));

  const passedCases = Array.from({ length: 15 }, (_, i) => ({
    label: `passed-${i}`,
    row: i + 500,
    col: i + 500,
    clientX: 50 + i,
    clientY: 50 + i,
    ctrlKey: false,
    handled: false,
  }));

  describe("handled clicks", () => {
    it.each(handledCases)(
      "$label: click at ($row,$col) is handled",
      async ({ row, col, clientX, clientY, ctrlKey }) => {
        const interceptor: CellClickInterceptorFn = async (r, c) => {
          return r === row && c === col;
        };
        track(registerCellClickInterceptor(interceptor));
        const result = await checkCellClickInterceptors(row, col, { clientX, clientY, ctrlKey });
        expect(result).toBe(true);
      }
    );
  });

  describe("passed-through clicks", () => {
    it.each(passedCases)(
      "$label: click at ($row,$col) passes through",
      async ({ row, col, clientX, clientY }) => {
        const interceptor: CellClickInterceptorFn = async () => false;
        track(registerCellClickInterceptor(interceptor));
        const result = await checkCellClickInterceptors(row, col, { clientX, clientY });
        expect(result).toBe(false);
      }
    );
  });
});

// ============================================================================
// 5. Double-Click Interceptor - 20 position combos
// ============================================================================

describe("Cell double-click interceptor (parameterized)", () => {
  const handledCases = Array.from({ length: 10 }, (_, i) => ({
    label: `dblclick-handled-${i}`,
    row: i * 4,
    col: i * 2,
    clientX: 150 + i * 5,
    clientY: 250 + i * 5,
    handled: true,
  }));

  const passedCases = Array.from({ length: 10 }, (_, i) => ({
    label: `dblclick-passed-${i}`,
    row: i + 800,
    col: i + 800,
    clientX: 10 + i,
    clientY: 10 + i,
    handled: false,
  }));

  describe("handled double-clicks", () => {
    it.each(handledCases)(
      "$label: dblclick at ($row,$col) is handled",
      async ({ row, col, clientX, clientY }) => {
        const interceptor: CellDoubleClickInterceptorFn = async (r, c) => {
          return r === row && c === col;
        };
        track(registerCellDoubleClickInterceptor(interceptor));
        const result = await checkCellDoubleClickInterceptors(row, col, { clientX, clientY });
        expect(result).toBe(true);
      }
    );
  });

  describe("passed-through double-clicks", () => {
    it.each(passedCases)(
      "$label: dblclick at ($row,$col) passes through",
      async ({ row, col, clientX, clientY }) => {
        const interceptor: CellDoubleClickInterceptorFn = async () => false;
        track(registerCellDoubleClickInterceptor(interceptor));
        const result = await checkCellDoubleClickInterceptors(row, col, { clientX, clientY });
        expect(result).toBe(false);
      }
    );
  });
});

// ============================================================================
// 6. Formula Reference Interceptor - 20 ref combos
// ============================================================================

describe("Formula reference interceptor (parameterized)", () => {
  const overrideCases = Array.from({ length: 10 }, (_, i) => ({
    label: `override-${i}`,
    row: i * 5,
    col: i * 3,
    text: `GETPIVOTDATA("Measure${i}",A${i + 1})`,
    highlightRow: i * 5,
    highlightCol: i * 3,
  }));

  const passthruCases = Array.from({ length: 10 }, (_, i) => ({
    label: `passthru-${i}`,
    row: i + 600,
    col: i + 600,
  }));

  describe("override cases", () => {
    it.each(overrideCases)(
      "$label: ref at ($row,$col) overridden to custom text",
      async ({ row, col, text, highlightRow, highlightCol }) => {
        const interceptor: FormulaReferenceInterceptorFn = async (r, c) => {
          if (r === row && c === col) return { text, highlightRow, highlightCol };
          return null;
        };
        track(registerFormulaReferenceInterceptor(interceptor));
        const result = await checkFormulaReferenceInterceptors(row, col);
        expect(result).not.toBeNull();
        expect(result!.text).toBe(text);
        expect(result!.highlightRow).toBe(highlightRow);
      }
    );
  });

  describe("pass-through cases", () => {
    it.each(passthruCases)(
      "$label: ref at ($row,$col) passes through",
      async ({ row, col }) => {
        const interceptor: FormulaReferenceInterceptorFn = async () => null;
        track(registerFormulaReferenceInterceptor(interceptor));
        const result = await checkFormulaReferenceInterceptors(row, col);
        expect(result).toBeNull();
      }
    );
  });
});

// ============================================================================
// 7. Cursor Interceptor - 20 cell combos
// ============================================================================

describe("Cell cursor interceptor (parameterized)", () => {
  const cursorTypes = ["pointer", "crosshair", "move", "grab", "not-allowed", "help", "wait", "text", "cell", "copy"];

  const overrideCases = Array.from({ length: 10 }, (_, i) => ({
    label: `cursor-override-${i}`,
    row: i * 10,
    col: i * 5,
    cursor: cursorTypes[i % cursorTypes.length],
  }));

  const defaultCases = Array.from({ length: 10 }, (_, i) => ({
    label: `cursor-default-${i}`,
    row: i + 900,
    col: i + 900,
  }));

  describe("cursor override cases", () => {
    it.each(overrideCases)(
      "$label: cell ($row,$col) returns $cursor",
      ({ row, col, cursor }) => {
        const interceptor: CellCursorInterceptorFn = (r, c) => {
          if (r === row && c === col) return cursor;
          return null;
        };
        track(registerCellCursorInterceptor(interceptor));
        const result = getCellCursorOverride(row, col);
        expect(result).toBe(cursor);
      }
    );
  });

  describe("default cursor cases", () => {
    it.each(defaultCases)(
      "$label: cell ($row,$col) returns null (default)",
      ({ row, col }) => {
        const interceptor: CellCursorInterceptorFn = () => null;
        track(registerCellCursorInterceptor(interceptor));
        const result = getCellCursorOverride(row, col);
        expect(result).toBeNull();
      }
    );
  });
});
