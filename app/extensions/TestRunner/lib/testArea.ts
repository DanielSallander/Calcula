//! FILENAME: app/extensions/TestRunner/lib/testArea.ts
// PURPOSE: Shared constants for the test area location.
// CONTEXT: All test suites (except mockData) use this area to avoid
//          overlapping with real data in rows 0-100.
//          Each suite gets its own row block (50 rows apart) so they can't
//          interfere with each other.

import { columnToLetter } from "../../../src/api";

/**
 * Default test area origin — row 500, col 10 (K501 in spreadsheet notation).
 * Used by the original basic/clipboard/formatting suites.
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

/**
 * Create a test area for a specific suite, offset from the base.
 * Each suite gets 50 rows of space starting at col 10.
 *
 * @param suiteIndex - Suite number (0 = basic, 1 = clipboard, etc.)
 */
export function suiteArea(suiteIndex: number) {
  const row = 500 + suiteIndex * 50;
  const col = 10;
  return {
    row,
    col,
    /** Convert column offset to A1-style letter */
    colLetter: (offset: number = 0) => columnToLetter(col + offset),
    /** 1-based row reference for formulas */
    rowRef: (offset: number = 0) => row + offset + 1,
    /** Build an A1-style cell reference like "K501" */
    ref: (rowOffset: number, colOffset: number) =>
      `${columnToLetter(col + colOffset)}${row + rowOffset + 1}`,
  };
}

// ============================================================================
// Pre-defined suite areas (keep in sync with index.ts registration order)
// ============================================================================

/** Suite 0: Basic Cell Operations (row 500) */
export const AREA_BASIC = suiteArea(0);
/** Suite 1: Clipboard Operations (row 550) */
export const AREA_CLIPBOARD = suiteArea(1);
/** Suite 2: Formatting Operations (row 600) */
export const AREA_FORMATTING = suiteArea(2);
/** Suite 3: Mock Data — uses rows 0-100, no offset needed */
// (no constant — mockData suite reads from fixed locations)
/** Suite 4: Formulas & Calculation (row 700) */
export const AREA_FORMULAS = suiteArea(4);
/** Suite 5: Undo/Redo (row 750) */
export const AREA_UNDO_REDO = suiteArea(5);
/** Suite 6: Sheet Management (row 800) — uses separate sheets, row doesn't matter much */
export const AREA_SHEETS = suiteArea(6);
/** Suite 7: Row & Column Operations (row 850) */
export const AREA_ROW_COL = suiteArea(7);
/** Suite 8: Merge Cells (row 900) */
export const AREA_MERGE = suiteArea(8);

// Phase 2: Data Features
/** Suite 9: Sorting (row 950) */
export const AREA_SORTING = suiteArea(9);
/** Suite 10: AutoFilter (row 1000) */
export const AREA_AUTOFILTER = suiteArea(10);
/** Suite 11: Named Ranges (row 1050) */
export const AREA_NAMED_RANGES = suiteArea(11);
/** Suite 12: Data Validation (row 1100) */
export const AREA_DATA_VALIDATION = suiteArea(12);
/** Suite 13: Remove Duplicates (row 1150) */
export const AREA_REMOVE_DUPLICATES = suiteArea(13);
/** Suite 14: Goal Seek (row 1200) */
export const AREA_GOAL_SEEK = suiteArea(14);
/** Suite 15: Find & Replace (row 1250) */
export const AREA_FIND_REPLACE = suiteArea(15);

// Phase 3: Annotations
/** Suite 16: Comments (row 1300) */
export const AREA_COMMENTS = suiteArea(16);
/** Suite 17: Notes (row 1350) */
export const AREA_NOTES = suiteArea(17);
/** Suite 18: Conditional Formatting (row 1400) */
export const AREA_COND_FORMAT = suiteArea(18);

// Phase 4: Protection & Structure
/** Suite 19: Protection (row 1450) */
export const AREA_PROTECTION = suiteArea(19);
/** Suite 20: Grouping/Outline (row 1500) */
export const AREA_GROUPING = suiteArea(20);
/** Suite 21: Freeze Panes (row 1550) */
export const AREA_FREEZE_PANES = suiteArea(21);
/** Suite 22: Hyperlinks (row 1600) */
export const AREA_HYPERLINKS = suiteArea(22);

// Phase 5: Advanced Features
/** Suite 23: Tracing (row 1650) */
export const AREA_TRACING = suiteArea(23);
/** Suite 24: Page Setup (row 1700) */
export const AREA_PAGE_SETUP = suiteArea(24);
/** Suite 25: Cell Styles (row 1750) */
export const AREA_CELL_STYLES = suiteArea(25);
/** Suite 26: Aggregation (row 1800) */
export const AREA_AGGREGATION = suiteArea(26);

// Phase 6: Tables, Advanced Filters, Sheet Management, Consolidation
/** Suite 27: Tables (row 1850) */
export const AREA_TABLES = suiteArea(27);
/** Suite 28: Advanced Filters (row 1900) */
export const AREA_ADV_FILTERS = suiteArea(28);
/** Suite 29: Sheet Management Extended (row 1950) */
export const AREA_SHEETS_EXT = suiteArea(29);
/** Suite 30: Data Consolidation (row 2000) */
export const AREA_CONSOLIDATION = suiteArea(30);

// Phase 7: Utility Functions, Computed Properties, Formula Eval
/** Suite 31: Utility Functions (row 2050) */
export const AREA_UTILITIES = suiteArea(31);
/** Suite 32: Computed Properties (row 2100) */
export const AREA_COMPUTED_PROPS = suiteArea(32);
/** Suite 33: Formula Evaluation Debugger (row 2150) */
export const AREA_FORMULA_EVAL = suiteArea(33);

// Phase 8: Advanced Annotations
/** Suite 34: Advanced Comments (row 2200) */
export const AREA_ADV_COMMENTS = suiteArea(34);
/** Suite 35: Advanced Notes (row 2250) */
export const AREA_ADV_NOTES = suiteArea(35);
/** Suite 36: Advanced Validation (row 2300) */
export const AREA_ADV_VALIDATION = suiteArea(36);

// Phase 9: Advanced CF, Hyperlinks, Protection, Print
/** Suite 37: Advanced Conditional Formatting (row 2350) */
export const AREA_ADV_CF = suiteArea(37);
/** Suite 38: Advanced Hyperlinks (row 2400) */
export const AREA_ADV_HYPERLINKS = suiteArea(38);
/** Suite 39: Advanced Protection (row 2450) */
export const AREA_ADV_PROTECTION = suiteArea(39);
/** Suite 40: Print (row 2500) */
export const AREA_PRINT = suiteArea(40);

// Phase 10: Cross-Feature Integration
/** Suite 41: Formula + CF (row 2550) */
export const AREA_FORMULA_CF = suiteArea(41);
/** Suite 42: Protection + Validation (row 2600) */
export const AREA_PROTECTION_VALIDATION = suiteArea(42);
/** Suite 43: Undo Multi-Step (row 2650) */
export const AREA_UNDO_MULTISTEP = suiteArea(43);
/** Suite 44: Copy/Paste + Features (row 2700) */
export const AREA_COPYPASTE_FEATURES = suiteArea(44);

// Phase 11: Edge Case / Regression
/** Suite 45: Boundary Values (row 2750) */
export const AREA_BOUNDARY_VALUES = suiteArea(45);
/** Suite 46: Empty/Zero Range Ops (row 2800) */
export const AREA_EMPTY_RANGE_OPS = suiteArea(46);
/** Suite 47: Concurrent Operations (row 2850) */
export const AREA_CONCURRENT_OPS = suiteArea(47);

// Phase 12: Workflow Scenarios
/** Suite 48: Budget Worksheet (row 2900) */
export const AREA_WF_BUDGET = suiteArea(48);
/** Suite 49: Filtered Report (row 2950) */
export const AREA_WF_FILTERED_REPORT = suiteArea(49);
/** Suite 50: Protected Template (row 3000) */
export const AREA_WF_PROTECTED_TEMPLATE = suiteArea(50);

// Phase 13: Multi-Sheet Integration
/** Suite 51: Multi-Sheet Operations (row 3050) */
export const AREA_MULTI_SHEET = suiteArea(51);

// Phase 14: Table Cross-Feature
/** Suite 52: Table + Formulas (row 3100) */
export const AREA_TABLE_FORMULAS = suiteArea(52);
/** Suite 53: Table + Features (row 3150) */
export const AREA_TABLE_FEATURES = suiteArea(53);

// Phase 15: Advanced Data Pipelines
/** Suite 54: Pipeline Filter/Sort/Aggregate (row 3200) */
export const AREA_PIPELINE_FSA = suiteArea(54);
/** Suite 55: Pipeline Data Integrity (row 3250) */
export const AREA_PIPELINE_INTEGRITY = suiteArea(55);

// Phase 16: New Features (LAMBDA, PDF Export)
/** Suite 56: LAMBDA & Helpers (row 3300) */
export const AREA_LAMBDA = suiteArea(56);
/** Suite 57: PDF Export (row 3350) */
export const AREA_PDF_EXPORT = suiteArea(57);
