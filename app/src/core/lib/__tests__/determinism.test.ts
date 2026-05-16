//! FILENAME: app/src/core/lib/__tests__/determinism.test.ts
// PURPOSE: Verify output determinism - calling the same pure function multiple
//          times with identical input always produces identical output.

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types/types";
import { parseFormulaReferences } from "../formulaRefParser";
import { autoCompleteFormula } from "../formulaCompletion";
import { toggleReferenceAtCursor } from "../formulaRefToggle";
import {
  scrollToVisibleRange,
  isCellVisible,
  cellToScroll,
  getColumnXPosition,
  getRowYPosition,
  calculateScrollbarMetrics,
} from "../scrollUtils";
import type { GridConfig, Viewport, DimensionOverrides } from "../../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ITERATIONS = 100;

function makeConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 25,
    totalRows: 1000,
    totalCols: 100,
    minColumnWidth: 20,
    minRowHeight: 10,
    ...overrides,
  };
}

function makeDimensions(overrides?: Partial<DimensionOverrides>): DimensionOverrides {
  return {
    columnWidths: new Map(),
    rowHeights: new Map(),
    hiddenRows: new Set(),
    hiddenCols: new Set(),
    ...overrides,
  };
}

function makeViewport(): Viewport {
  return { width: 1200, height: 800 };
}

/** Run fn N times and assert all outputs are identical via JSON.stringify. */
function assertDeterministic<T>(fn: () => T, n = ITERATIONS): T {
  const first = fn();
  const firstJson = JSON.stringify(first);
  for (let i = 1; i < n; i++) {
    const result = fn();
    expect(JSON.stringify(result)).toBe(firstJson);
  }
  return first;
}

// ===========================================================================
// columnToLetter
// ===========================================================================

describe("determinism: columnToLetter", () => {
  it("column 0 (A) is deterministic over 100 runs", () => {
    assertDeterministic(() => columnToLetter(0));
  });

  it("column 25 (Z) is deterministic", () => {
    assertDeterministic(() => columnToLetter(25));
  });

  it("column 26 (AA) is deterministic", () => {
    assertDeterministic(() => columnToLetter(26));
  });

  it("column 701 (ZZ) is deterministic", () => {
    assertDeterministic(() => columnToLetter(701));
  });
});

// ===========================================================================
// letterToColumn
// ===========================================================================

describe("determinism: letterToColumn", () => {
  it("A -> 0 is deterministic over 100 runs", () => {
    assertDeterministic(() => letterToColumn("A"));
  });

  it("ZZ is deterministic", () => {
    assertDeterministic(() => letterToColumn("ZZ"));
  });

  it("AAA is deterministic", () => {
    assertDeterministic(() => letterToColumn("AAA"));
  });
});

// ===========================================================================
// parseFormulaReferences
// ===========================================================================

describe("determinism: parseFormulaReferences", () => {
  it("simple cell reference", () => {
    assertDeterministic(() => parseFormulaReferences("=A1+B2"));
  });

  it("complex formula with ranges and functions", () => {
    assertDeterministic(() =>
      parseFormulaReferences("=SUM(A1:B10)+VLOOKUP(C3,D1:F20,2,FALSE)"),
    );
  });

  it("mixed absolute and relative references", () => {
    assertDeterministic(() => parseFormulaReferences("=$A$1+B2+$C3+D$4"));
  });
});

// ===========================================================================
// autoCompleteFormula
// ===========================================================================

describe("determinism: autoCompleteFormula", () => {
  it("unmatched parentheses", () => {
    assertDeterministic(() => autoCompleteFormula("=SUM(A1:A10"));
  });

  it("nested functions with missing parens", () => {
    assertDeterministic(() => autoCompleteFormula("=IF(A1>0,SUM(B1:B10"));
  });

  it("already complete formula", () => {
    assertDeterministic(() => autoCompleteFormula("=A1+B2"));
  });
});

// ===========================================================================
// toggleReferenceAtCursor
// ===========================================================================

describe("determinism: toggleReferenceAtCursor", () => {
  it("cursor on simple reference", () => {
    assertDeterministic(() => toggleReferenceAtCursor("=A1+B2", 2));
  });

  it("cursor on absolute reference", () => {
    assertDeterministic(() => toggleReferenceAtCursor("=$A$1+B2", 4));
  });

  it("cursor at end of formula", () => {
    assertDeterministic(() => toggleReferenceAtCursor("=SUM(C3:D5)", 11));
  });
});

// ===========================================================================
// scrollToVisibleRange
// ===========================================================================

describe("determinism: scrollToVisibleRange", () => {
  it("default config with no overrides", () => {
    const config = makeConfig();
    const dims = makeDimensions();
    const vp = makeViewport();
    assertDeterministic(() => scrollToVisibleRange(0, 0, config, dims, vp));
  });

  it("scrolled position with custom dimensions", () => {
    const config = makeConfig();
    const dims = makeDimensions({
      columnWidths: new Map([[2, 200], [5, 50]]),
      rowHeights: new Map([[10, 40]]),
    });
    const vp = makeViewport();
    assertDeterministic(() => scrollToVisibleRange(500, 300, config, dims, vp));
  });
});

// ===========================================================================
// calculateScrollbarMetrics
// ===========================================================================

describe("determinism: calculateScrollbarMetrics", () => {
  it("standard grid", () => {
    const config = makeConfig();
    const dims = makeDimensions();
    const vp = makeViewport();
    assertDeterministic(() => calculateScrollbarMetrics(config, dims, vp, 0, 0));
  });

  it("grid with hidden rows and cols", () => {
    const config = makeConfig();
    const dims = makeDimensions({
      hiddenRows: new Set([1, 5, 10, 20]),
      hiddenCols: new Set([3, 7]),
    });
    const vp = makeViewport();
    assertDeterministic(() => calculateScrollbarMetrics(config, dims, vp, 200, 100));
  });
});

// ===========================================================================
// isCellVisible
// ===========================================================================

describe("determinism: isCellVisible", () => {
  it("cell at origin", () => {
    const config = makeConfig();
    const dims = makeDimensions();
    const vp = makeViewport();
    assertDeterministic(() => isCellVisible(0, 0, 0, 0, config, dims, vp));
  });

  it("cell far from viewport", () => {
    const config = makeConfig();
    const dims = makeDimensions();
    const vp = makeViewport();
    assertDeterministic(() => isCellVisible(500, 200, 0, 0, config, dims, vp));
  });
});

// ===========================================================================
// cellToScroll
// ===========================================================================

describe("determinism: cellToScroll", () => {
  it("scroll to cell (0,0)", () => {
    const config = makeConfig();
    const dims = makeDimensions();
    assertDeterministic(() => cellToScroll(0, 0, config, dims));
  });

  it("scroll to cell (50, 30)", () => {
    const config = makeConfig();
    const dims = makeDimensions({
      columnWidths: new Map([[10, 150], [20, 200]]),
    });
    assertDeterministic(() => cellToScroll(50, 30, config, dims));
  });
});

// ===========================================================================
// getColumnXPosition / getRowYPosition
// ===========================================================================

describe("determinism: getColumnXPosition", () => {
  it("column 0 with default widths", () => {
    const config = makeConfig();
    const dims = makeDimensions();
    assertDeterministic(() => getColumnXPosition(0, config, dims));
  });

  it("column 50 with custom widths", () => {
    const config = makeConfig();
    const dims = makeDimensions({
      columnWidths: new Map([[5, 200], [25, 50]]),
      hiddenCols: new Set([10]),
    });
    assertDeterministic(() => getColumnXPosition(50, config, dims));
  });
});

describe("determinism: getRowYPosition", () => {
  it("row 0 with default heights", () => {
    const config = makeConfig();
    const dims = makeDimensions();
    assertDeterministic(() => getRowYPosition(0, config, dims));
  });

  it("row 100 with custom heights and hidden rows", () => {
    const config = makeConfig();
    const dims = makeDimensions({
      rowHeights: new Map([[10, 50], [50, 40]]),
      hiddenRows: new Set([20, 30, 40]),
    });
    assertDeterministic(() => getRowYPosition(100, config, dims));
  });
});
