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

/**
 * Assert a value is not null/undefined.
 */
export function expectNotNull<T>(value: T | null | undefined, message: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(`Expected non-null: ${message}`);
  }
}

/**
 * Assert a cell is not empty (exists and has a non-empty display).
 */
export function expectCellNotEmpty(cell: CellData | null, cellRef: string): void {
  if (cell === null || cell.display === "") {
    throw new Error(`Cell ${cellRef}: expected non-empty, got "${cell?.display ?? "null"}"`);
  }
}

/**
 * Assert a cell's display value contains a substring.
 */
export function expectCellContains(cell: CellData | null, substring: string, cellRef: string): void {
  const display = cell?.display ?? "";
  if (!display.includes(substring)) {
    throw new Error(`Cell ${cellRef}: expected display to contain "${substring}", got "${display}"`);
  }
}

/**
 * Assert an array has the expected length.
 */
export function expectArrayLength(arr: unknown[], expected: number, message?: string): void {
  if (arr.length !== expected) {
    const prefix = message ? `${message}: ` : "";
    throw new Error(`${prefix}expected array length ${expected}, got ${arr.length}`);
  }
}

/**
 * Assert that an async function throws an error.
 */
export async function expectThrows(fn: () => Promise<unknown>, message: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(`Expected to throw: ${message}`);
  }
}
