//! FILENAME: app/src/core/lib/__tests__/performance.test.ts
// PURPOSE: Performance regression tests for core operations at scale.
// CONTEXT: Ensures hot-path functions remain fast with large inputs.

import { describe, it, expect } from "vitest";
import { columnToLetter } from "../../types";
import { parseFormulaReferences } from "../formulaRefParser";
import { autoCompleteFormula } from "../formulaCompletion";
import {
  scrollToVisibleRange,
  isCellVisible,
} from "../scrollUtils";
import type { GridConfig, Viewport } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

const EXCEL_MAX_ROW = 1048576;
const EXCEL_MAX_COL = 16384;

function makeConfig(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    defaultCellWidth: 80,
    defaultCellHeight: 24,
    rowHeaderWidth: 50,
    colHeaderHeight: 24,
    totalRows: EXCEL_MAX_ROW,
    totalCols: EXCEL_MAX_COL,
    minColumnWidth: 20,
    minRowHeight: 10,
    outlineBarWidth: 0,
    ...overrides,
  } as GridConfig;
}

function makeViewport(): Viewport {
  return { width: 1920, height: 1080 };
}

// ============================================================================
// scrollToVisibleRange with 1M rows
// ============================================================================

describe("performance: scrollToVisibleRange", () => {
  it("completes 10000 calls under 500ms with 1M row grid", () => {
    const config = makeConfig();
    const viewport = makeViewport();
    const iterations = 10_000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      // Scroll to random positions across the full grid
      const scrollX = (i * 137) % (EXCEL_MAX_COL * 80);
      const scrollY = (i * 251) % (EXCEL_MAX_ROW * 24);
      scrollToVisibleRange(scrollX, scrollY, viewport, config);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1500); // 3x generous headroom over 500ms target
  });
});

// ============================================================================
// columnToLetter for all 16384 columns
// ============================================================================

describe("performance: columnToLetter", () => {
  it("converts all 16384 columns under 100ms", () => {
    const start = performance.now();
    for (let col = 0; col < EXCEL_MAX_COL; col++) {
      columnToLetter(col);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(300); // 3x headroom
  });
});

// ============================================================================
// parseFormulaReferences with 200 refs
// ============================================================================

describe("performance: parseFormulaReferences", () => {
  it("parses a formula with 200 references under 50ms", () => {
    // Build a formula with 200 cell references
    const refs: string[] = [];
    for (let i = 0; i < 200; i++) {
      const col = columnToLetter(i % 100);
      const row = (i % 500) + 1;
      refs.push(`${col}${row}`);
    }
    const formula = `=SUM(${refs.join("+")})`;

    const start = performance.now();
    parseFormulaReferences(formula);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(150); // 3x headroom
  });
});

// ============================================================================
// autoCompleteFormula for 1000 formulas
// ============================================================================

describe("performance: autoCompleteFormula", () => {
  it("auto-completes 1000 formulas under 200ms", () => {
    const formulas: string[] = [];
    for (let i = 0; i < 1000; i++) {
      // Mix of incomplete formulas: missing parens, missing quotes
      if (i % 3 === 0) {
        formulas.push(`=SUM(A${i}:B${i + 10}`);
      } else if (i % 3 === 1) {
        formulas.push(`=IF(A${i}>0,AVERAGE(C${i}:D${i + 5}`);
      } else {
        formulas.push(`=CONCATENATE("hello`);
      }
    }

    const start = performance.now();
    for (const f of formulas) {
      autoCompleteFormula(f);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(600); // 3x headroom
  });
});

// ============================================================================
// CellRange-style address parsing via parseFormulaReferences (5000 addresses)
// ============================================================================

describe("performance: address parsing at scale", () => {
  it("parses 5000 cell addresses via parseFormulaReferences under 200ms", () => {
    // Build 5000 individual formulas with range references
    const addresses: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const col = columnToLetter(i % 200);
      const row = (i % 1000) + 1;
      addresses.push(`=${col}${row}:${col}${row + 10}`);
    }

    const start = performance.now();
    for (const addr of addresses) {
      parseFormulaReferences(addr);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(600); // 3x headroom
  });
});

// ============================================================================
// isCellVisible for 10000 checks
// ============================================================================

describe("performance: isCellVisible", () => {
  it("completes 10000 visibility checks under 100ms", () => {
    const config = makeConfig();
    const viewport = makeViewport();
    const iterations = 10_000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const row = (i * 97) % EXCEL_MAX_ROW;
      const col = (i * 13) % EXCEL_MAX_COL;
      const scrollX = (i * 53) % 10000;
      const scrollY = (i * 71) % 10000;
      isCellVisible(row, col, scrollX, scrollY, viewport, config);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(300); // 3x headroom
  });
});
