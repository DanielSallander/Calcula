//! FILENAME: app/extensions/TestRunner/lib/assertions.ts
// PURPOSE: Assertion helpers for test macros.
// CONTEXT: Convenience wrappers that throw descriptive errors on failure.

import type { CellData } from "../../../src/api/types";

/**
 * Assert a cell's display value matches the expected string.
 */
export function expectCellValue(cell: CellData | null, expected: string, cellRef: string): void {
  const actual = cell?.display ?? null;
  if (actual !== expected) {
    throw new Error(`Cell ${cellRef}: expected display "${expected}", got "${actual}"`);
  }
}

/**
 * Assert a cell is empty (null or empty display string).
 */
export function expectCellEmpty(cell: CellData | null, cellRef: string): void {
  if (cell !== null && cell.display !== "") {
    throw new Error(`Cell ${cellRef}: expected empty, got "${cell.display}"`);
  }
}

/**
 * Assert a cell contains a specific formula.
 */
export function expectCellFormula(cell: CellData | null, expected: string, cellRef: string): void {
  const actual = cell?.formula ?? null;
  if (actual !== expected) {
    throw new Error(`Cell ${cellRef}: expected formula "${expected}", got "${actual}"`);
  }
}

/**
 * Assert selection matches expected bounds.
 */
export function expectSelection(
  actual: { startRow: number; startCol: number; endRow: number; endCol: number } | null,
  expected: { startRow: number; startCol: number; endRow: number; endCol: number }
): void {
  if (!actual) {
    throw new Error(`Expected selection ${JSON.stringify(expected)}, got null`);
  }
  if (
    actual.startRow !== expected.startRow ||
    actual.startCol !== expected.startCol ||
    actual.endRow !== expected.endRow ||
    actual.endCol !== expected.endCol
  ) {
    throw new Error(
      `Selection mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify({
        startRow: actual.startRow,
        startCol: actual.startCol,
        endRow: actual.endRow,
        endCol: actual.endCol,
      })}`
    );
  }
}

/**
 * Assert two values are strictly equal.
 */
export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    const prefix = message ? `${message}: ` : "";
    throw new Error(`${prefix}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Assert a condition is truthy.
 */
export function assertTrue(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
