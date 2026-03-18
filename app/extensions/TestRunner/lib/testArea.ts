//! FILENAME: app/extensions/TestRunner/lib/testArea.ts
// PURPOSE: Shared constants for the test area location.
// CONTEXT: All test suites (except mockData) use this area to avoid
//          overlapping with real data in rows 0-100.

/**
 * Test area origin — row 500, col 10 (K501 in spreadsheet notation).
 * Far enough from typical user data and mock data to avoid conflicts.
 */
export const TEST_AREA = {
  /** 0-based row index */
  row: 500,
  /** 0-based column index */
  col: 10,
  /** Column letter for col 10 = "K" (for formula references) */
  colLetter: "K",
  /** Column letter for col 11 = "L" */
  colLetter2: "L",
  /** Column letter for col 12 = "M" */
  colLetter3: "M",
  /** 1-based row number for formulas (row 500 -> row 501 in A1 notation) */
  rowRef: 501,
} as const;
