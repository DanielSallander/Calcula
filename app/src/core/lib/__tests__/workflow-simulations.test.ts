//! FILENAME: app/src/core/lib/__tests__/workflow-simulations.test.ts
// PURPOSE: Complex real-world user workflow simulations exercising multiple
//          core modules in sequence: formula parsing, reference toggling,
//          fill lists, scroll utilities, and formula completion.

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  buildCellReference,
  buildRangeReference,
  updateFormulaReference,
} from "../formulaRefParser";
import {
  toggleReferenceAtCursor,
  getReferenceAtCursor,
} from "../formulaRefToggle";
import { FillListRegistry } from "../fillLists";
import { autoCompleteFormula, isIncompleteFormula } from "../formulaCompletion";
import { columnToLetter, letterToColumn } from "../../types";
import {
  scrollToVisibleRange,
  cellToScroll,
  cellToCenteredScroll,
  clampScroll,
  isCellVisible,
  scrollToMakeVisible,
  calculateScrollbarMetrics,
  thumbPositionToScroll,
  calculateScrollDelta,
  SCROLLBAR_WIDTH,
  SCROLLBAR_HEIGHT,
} from "../scrollUtils";
import type { GridConfig, Viewport } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function createConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 30,
    totalRows: 1_000_000,
    totalCols: 16384,
    minColumnWidth: 20,
    minRowHeight: 10,
    ...overrides,
  } as GridConfig;
}

function createViewport(overrides?: Partial<Viewport>): Viewport {
  return {
    startRow: 0,
    startCol: 0,
    rowCount: 20,
    colCount: 10,
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  };
}

// ============================================================================
// Workflow 1: Build a budget spreadsheet
// ============================================================================

describe("Build a budget spreadsheet", () => {
  beforeEach(() => {
    FillListRegistry._reset();
  });

  it("creates month headers via fill lists then builds SUM formulas referencing them", () => {
    // User types "Jan" in B1, then drags to fill the rest of the year
    const match = FillListRegistry.matchValues(["Jan"]);
    expect(match).not.toBeNull();

    const months: string[] = ["Jan"];
    for (let i = 1; i < 12; i++) {
      months.push(FillListRegistry.generateValue(match!, 0, i));
    }
    expect(months).toEqual([
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]);

    // Build a SUM formula for the total column (M2) summing B2:L2 (cols 1..12)
    const rangeRef = buildRangeReference(1, 1, 1, 12, false, false, false, false);
    const formula = `=SUM(${rangeRef})`;
    expect(formula).toBe("=SUM(B2:M2)");

    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ startRow: 1, startCol: 1, endRow: 1, endCol: 12 });
  });

  it("creates expense category labels via custom fill list and builds AVERAGE formula", () => {
    FillListRegistry.addList("Expenses", [
      "Rent", "Utilities", "Salaries", "Marketing", "Insurance", "Supplies",
    ]);

    const match = FillListRegistry.matchValues(["Rent"]);
    expect(match).not.toBeNull();
    expect(match!.list.builtIn).toBe(false);

    const categories: string[] = [];
    for (let i = 0; i < 6; i++) {
      categories.push(FillListRegistry.generateValue(match!, 0, i));
    }
    // generateValue with startIndex=0 and offset=0 gives item at index 0 (Rent wraps)
    expect(categories).toEqual([
      "Rent", "Utilities", "Salaries", "Marketing", "Insurance", "Supplies",
    ]);

    // Build AVERAGE formula for Rent row (row 2) across Jan-Dec (B2:M2)
    const formula = `=AVERAGE(${buildRangeReference(1, 1, 1, 12, false, false, false, false)})`;
    const refs = parseFormulaReferences(formula);
    expect(refs[0]).toMatchObject({ startRow: 1, startCol: 1, endRow: 1, endCol: 12 });
  });

  it("builds a quarterly SUM formula and locks the header row with absolute refs", () => {
    // Q1 sum: =SUM(B2:D2)
    let formula = `=SUM(${buildRangeReference(1, 1, 1, 3, false, false, false, false)})`;
    expect(formula).toBe("=SUM(B2:D2)");

    // User presses F4 to lock the row (for copying across expense rows)
    // Toggle at cursor on B2 (position 5)
    let toggled = toggleReferenceAtCursor(formula, 6);
    // First toggle: $B$2:D2
    expect(toggled.formula).toContain("$B$2");

    // Toggle three more times to get to B$2 (row locked)
    toggled = toggleReferenceAtCursor(toggled.formula, 6);
    toggled = toggleReferenceAtCursor(toggled.formula, 6);
    // After 3 toggles from relative: $B$2 -> B$2 -> $B2 -> B2 cycle
    // But we want row-only lock: B$2 (2nd toggle)
    // Let's re-do from the start: toggle twice
    formula = "=SUM(B2:D2)";
    const t1 = toggleReferenceAtCursor(formula, 6); // -> $B$2
    const t2 = toggleReferenceAtCursor(t1.formula, 6); // -> B$2
    expect(t2.formula).toContain("B$2");

    const refs = parseFormulaReferencesWithPositions(t2.formula);
    const firstRef = refs[0];
    expect(firstRef.isStartColAbsolute).toBe(false);
    expect(firstRef.isStartRowAbsolute).toBe(true);
  });

  it("builds a year-total formula referencing quarterly subtotals with mixed refs", () => {
    // Quarterly subtotals are in E2, I2, M2, Q2 (every 4th column)
    // Year total: =E2+I2+M2+Q2
    const cols = [4, 8, 12, 16];
    const cellRefs = cols.map((c) => buildCellReference(1, c, false, false));
    let formula = `=${cellRefs.join("+")}`;
    expect(formula).toBe("=E2+I2+M2+Q2");

    // Lock all row references for copying down
    for (let i = 0; i < 4; i++) {
      const refs = parseFormulaReferencesWithPositions(formula);
      // Toggle to $X$2 then to X$2
      const t1 = toggleReferenceAtCursor(formula, refs[i].textStartIndex + 1);
      const t2 = toggleReferenceAtCursor(t1.formula, refs[i].textStartIndex + 1);
      formula = t2.formula;
    }

    // All refs should have row locked, col relative
    const finalRefs = parseFormulaReferencesWithPositions(formula);
    for (const ref of finalRefs) {
      expect(ref.isStartRowAbsolute).toBe(true);
      expect(ref.isStartColAbsolute).toBe(false);
    }
  });

  it("auto-completes an incomplete budget formula and verifies refs", () => {
    // User types formula but forgets closing parens
    const incomplete = "=SUM(AVERAGE(B2:B13";
    expect(isIncompleteFormula(incomplete)).toBe(true);

    const completed = autoCompleteFormula(incomplete);
    expect(completed).toBe("=SUM(AVERAGE(B2:B13))");
    expect(isIncompleteFormula(completed)).toBe(false);

    // Verify the reference is still correct after completion
    const refs = parseFormulaReferences(completed);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ startRow: 1, startCol: 1, endRow: 12, endCol: 1 });
  });

  it("constructs multi-sheet budget with cross-sheet references", () => {
    // Revenue sheet reference
    const revenueRange = buildRangeReference(1, 1, 12, 1, false, false, false, false, "Revenue");
    const expenseRange = buildRangeReference(1, 1, 12, 1, false, false, false, false, "Expenses");
    const formula = `=SUM(${revenueRange})-SUM(${expenseRange})`;

    const refs = parseFormulaReferences(formula);
    expect(refs).toHaveLength(2);
    expect(refs[0].sheetName).toBe("Revenue");
    expect(refs[1].sheetName).toBe("Expenses");
    expect(refs[0]).toMatchObject({ startRow: 1, startCol: 1, endRow: 12, endCol: 1 });
  });
});

// ============================================================================
// Workflow 2: Navigate a large dataset (1M rows)
// ============================================================================

describe("Navigate large dataset", () => {
  const config = createConfig();
  const vpWidth = 1920;
  const vpHeight = 1080;

  it("scrolls to the top-left and verifies cell A1 is visible", () => {
    const vp = createViewport();
    const visible = isCellVisible(0, 0, vp, config, vpWidth, vpHeight);
    expect(visible).toBe(true);
  });

  it("scrolls to row 500,000 and verifies visibility range", () => {
    const targetRow = 500_000;
    const scroll = cellToScroll(targetRow, 0, config);
    expect(scroll.scrollY).toBe(targetRow * config.defaultCellHeight);

    const range = scrollToVisibleRange(scroll.scrollX, scroll.scrollY, config, vpWidth, vpHeight);
    expect(range.startRow).toBe(targetRow);
    expect(range.endRow).toBeGreaterThan(targetRow);
    // Should show roughly (1080-30-17)/25 = ~41 rows
    expect(range.endRow - range.startRow).toBeGreaterThanOrEqual(40);
  });

  it("scrolls to the last row and column of a 1M-row grid", () => {
    const lastRow = config.totalRows - 1;
    const lastCol = config.totalCols - 1;
    const scroll = cellToScroll(lastRow, lastCol, config);

    // Clamp to valid bounds
    const clamped = clampScroll(scroll.scrollX, scroll.scrollY, config, vpWidth, vpHeight);
    expect(clamped.scrollX).toBeGreaterThan(0);
    expect(clamped.scrollY).toBeGreaterThan(0);

    // The visible range should include the last row
    const range = scrollToVisibleRange(clamped.scrollX, clamped.scrollY, config, vpWidth, vpHeight);
    expect(range.endRow).toBe(lastRow);
  });

  it("centers on a specific cell and verifies it is in the visible range", () => {
    const targetRow = 250_000;
    const targetCol = 50;
    const scroll = cellToCenteredScroll(targetRow, targetCol, config, vpWidth, vpHeight);
    const clamped = clampScroll(scroll.scrollX, scroll.scrollY, config, vpWidth, vpHeight);

    const range = scrollToVisibleRange(clamped.scrollX, clamped.scrollY, config, vpWidth, vpHeight);
    expect(targetRow).toBeGreaterThanOrEqual(range.startRow);
    expect(targetRow).toBeLessThanOrEqual(range.endRow);
    expect(targetCol).toBeGreaterThanOrEqual(range.startCol);
    expect(targetCol).toBeLessThanOrEqual(range.endCol);
  });

  it("calculates scrollbar thumb position at various scroll points", () => {
    const positions = [0, 0.25, 0.5, 0.75, 1.0];
    let lastThumbPos = -1;

    for (const frac of positions) {
      const maxScroll = config.totalRows * config.defaultCellHeight - (vpHeight - config.colHeaderHeight - SCROLLBAR_HEIGHT);
      const scrollY = frac * maxScroll;
      const vp = createViewport({ scrollY, scrollX: 0 });
      const metrics = calculateScrollbarMetrics(config, vp, vpWidth, vpHeight);

      expect(metrics.vertical.thumbPosition).toBeGreaterThanOrEqual(lastThumbPos);
      lastThumbPos = metrics.vertical.thumbPosition;

      // Thumb size should be small for 1M rows
      expect(metrics.vertical.thumbSize).toBe(30); // clamped to min 30
    }
  });

  it("round-trips scrollbar thumb position to scroll offset", () => {
    const vp = createViewport({ scrollY: 5000 * 25, scrollX: 0 });
    const metrics = calculateScrollbarMetrics(config, vp, vpWidth, vpHeight);

    // Convert thumb position back to scroll
    const contentHeight = config.totalRows * config.defaultCellHeight;
    const viewHeight = vpHeight - config.colHeaderHeight - SCROLLBAR_HEIGHT;
    const recovered = thumbPositionToScroll(
      metrics.vertical.thumbPosition,
      metrics.vertical.thumbSize,
      metrics.vertical.trackSize,
      contentHeight,
      viewHeight,
    );
    expect(recovered).toBeCloseTo(5000 * 25, -1);
  });

  it("page-scrolls down and verifies non-overlapping ranges", () => {
    const vp = createViewport({ scrollY: 0, scrollX: 0 });
    const delta = calculateScrollDelta("down", "page", config, vp, vpWidth, vpHeight);
    expect(delta.deltaY).toBeGreaterThan(0);

    const range1 = scrollToVisibleRange(0, 0, config, vpWidth, vpHeight);
    const range2 = scrollToVisibleRange(0, delta.deltaY, config, vpWidth, vpHeight);

    // Page scroll leaves 1 row of context, so next page starts near previous end
    expect(range2.startRow).toBeGreaterThan(range1.startRow);
    expect(range2.startRow).toBeLessThanOrEqual(range1.endRow);
  });

  it("scrollToMakeVisible returns null for already-visible cell", () => {
    const vp = createViewport({ scrollY: 0, scrollX: 0 });
    const result = scrollToMakeVisible(5, 3, vp, config, vpWidth, vpHeight);
    expect(result).toBeNull();
  });

  it("scrollToMakeVisible scrolls to off-screen cell", () => {
    const vp = createViewport({ scrollY: 0, scrollX: 0 });
    const result = scrollToMakeVisible(1000, 200, vp, config, vpWidth, vpHeight);
    expect(result).not.toBeNull();
    expect(result!.scrollY).toBeGreaterThan(0);
    expect(result!.scrollX).toBeGreaterThan(0);
  });

  it("navigates to a named cell reference like XFD1000000", () => {
    // XFD is the last column (16383), row 1000000
    const col = letterToColumn("XFD");
    expect(col).toBe(16383);
    const row = 999_999; // 0-indexed

    const ref = buildCellReference(row, col, false, false);
    expect(ref).toBe("XFD1000000");

    const parsed = parseFormulaReferences(`=${ref}`);
    expect(parsed[0]).toMatchObject({ startRow: row, startCol: col });

    // Verify we can scroll to it
    const scroll = cellToScroll(row, col, config);
    expect(scroll.scrollY).toBe(row * config.defaultCellHeight);
  });
});

// ============================================================================
// Workflow 3: Edit formulas with F4 reference toggling
// ============================================================================

describe("Edit formulas with F4", () => {
  it("types a VLOOKUP formula and toggles the lookup range to absolute", () => {
    let formula = "=VLOOKUP(A2,D1:E100,2,FALSE)";

    // Place cursor on D1 in the range ref
    const refs = parseFormulaReferencesWithPositions(formula);
    const rangeRef = refs.find((r) => r.startCol === 3 && r.endCol === 4);
    expect(rangeRef).toBeDefined();

    // Toggle to $D$1:E100
    const t1 = toggleReferenceAtCursor(formula, rangeRef!.textStartIndex + 1);
    expect(t1.formula).toContain("$D$1");

    // Now toggle the end part (E100) - find it in updated formula
    const refs2 = parseFormulaReferencesWithPositions(t1.formula);
    const rangeRef2 = refs2.find((r) => r.startCol === 3);
    expect(rangeRef2).toBeDefined();
    // The end portion: place cursor on E100
    const endPos = t1.formula.indexOf("E100");
    const t2 = toggleReferenceAtCursor(t1.formula, endPos + 1);
    // End ref should now be absolute too
    expect(t2.formula).toContain("$E$100");

    // Verify final formula has fully locked range
    const finalRefs = parseFormulaReferencesWithPositions(t2.formula);
    const lockedRange = finalRefs.find((r) => r.startCol === 3);
    expect(lockedRange!.isStartColAbsolute).toBe(true);
    expect(lockedRange!.isStartRowAbsolute).toBe(true);
    expect(lockedRange!.isEndColAbsolute).toBe(true);
    expect(lockedRange!.isEndRowAbsolute).toBe(true);
  });

  it("toggles all four states on a cell reference within IF formula", () => {
    const states: string[] = [];
    let formula = "=IF(A1>10,B2,C3)";

    // Toggle B2 through all 4 states
    for (let i = 0; i < 4; i++) {
      const refs = parseFormulaReferencesWithPositions(formula);
      const b2Ref = refs.find((r) => r.startCol === 1 && r.startRow === 1);
      expect(b2Ref).toBeDefined();
      const toggled = toggleReferenceAtCursor(formula, b2Ref!.textStartIndex + 1);
      formula = toggled.formula;
      states.push(toggled.formula);
    }

    expect(states[0]).toContain("$B$2"); // absolute
    expect(states[1]).toContain("B$2");  // row absolute
    expect(states[2]).toContain("$B2");  // col absolute
    expect(states[3]).toContain(",B2,"); // relative (back to start)
  });

  it("auto-completes a partial formula with nested functions then toggles refs", () => {
    const partial = "=IF(SUM(A1:A10)>100,AVERAGE(B1:B10";
    const completed = autoCompleteFormula(partial);
    expect(completed).toBe("=IF(SUM(A1:A10)>100,AVERAGE(B1:B10))");

    // Toggle the A1:A10 range to absolute
    const refs = parseFormulaReferencesWithPositions(completed);
    const sumRange = refs.find((r) => r.startCol === 0 && r.endCol === 0);
    expect(sumRange).toBeDefined();

    const toggled = toggleReferenceAtCursor(completed, sumRange!.textStartIndex + 1);
    expect(toggled.formula).toContain("$A$1");

    // Verify B1:B10 is still relative
    const newRefs = parseFormulaReferencesWithPositions(toggled.formula);
    const avgRange = newRefs.find((r) => r.startCol === 1);
    expect(avgRange!.isStartColAbsolute).toBe(false);
    expect(avgRange!.isStartRowAbsolute).toBe(false);
  });

  it("moves a reference within a complex formula and re-verifies", () => {
    let formula = "=A1*B2+SUM(C3:D4)-E5/F6";
    const refs = parseFormulaReferencesWithPositions(formula);
    expect(refs).toHaveLength(5); // A1, B2, C3:D4, E5, F6

    // Move E5 to G10
    const e5Ref = refs.find((r) => r.startCol === 4 && r.startRow === 4);
    expect(e5Ref).toBeDefined();
    const updated = updateFormulaReference(formula, e5Ref!, 9, 6);
    expect(updated).toContain("G10");

    // Toggle F6 to absolute
    const refs2 = parseFormulaReferencesWithPositions(updated);
    const f6Ref = refs2.find((r) => r.startCol === 5);
    expect(f6Ref).toBeDefined();
    const toggled = toggleReferenceAtCursor(updated, f6Ref!.textStartIndex + 1);

    // Verify all refs are intact
    const finalRefs = parseFormulaReferences(toggled.formula);
    expect(finalRefs).toHaveLength(5);
    expect(finalRefs.find((r) => r.startCol === 6 && r.startRow === 9)).toBeDefined(); // G10
    expect(finalRefs.find((r) => r.startCol === 5 && r.startRow === 5)).toBeDefined(); // $F$6
  });

  it("handles cursor at various positions in a formula with multiple refs", () => {
    const formula = "=A1+BB200+CCC3000";

    // Cursor on A1
    const ref1 = getReferenceAtCursor(formula, 2);
    expect(ref1).not.toBeNull();
    expect(ref1!.ref).toBe("A1");

    // Cursor on BB200
    const ref2 = getReferenceAtCursor(formula, 5);
    expect(ref2).not.toBeNull();
    expect(ref2!.ref).toBe("BB200");

    // Cursor on CCC3000
    const ref3 = getReferenceAtCursor(formula, 12);
    expect(ref3).not.toBeNull();
    expect(ref3!.ref).toBe("CCC3000");

    // Column conversions
    expect(letterToColumn("BB")).toBe(53);
    expect(letterToColumn("CCC")).toBe(2108);
    expect(columnToLetter(53)).toBe("BB");
    expect(columnToLetter(2108)).toBe("CCC");
  });

  it("builds a formula from scratch, auto-completes, toggles, and verifies round-trip", () => {
    // User types: =SUM(A1:A10,B1:B10
    const typed = "=SUM(A1:A10,B1:B10";
    expect(isIncompleteFormula(typed)).toBe(true);

    // Auto-complete adds closing paren
    let formula = autoCompleteFormula(typed);
    expect(formula).toBe("=SUM(A1:A10,B1:B10)");

    // Toggle first range to absolute
    const refs = parseFormulaReferencesWithPositions(formula);
    const t = toggleReferenceAtCursor(formula, refs[0].textStartIndex + 1);
    formula = t.formula;

    // Parse final formula and verify column letters round-trip
    const finalRefs = parseFormulaReferencesWithPositions(formula);
    expect(finalRefs[0].isStartColAbsolute).toBe(true);
    expect(columnToLetter(finalRefs[0].startCol)).toBe("A");
    expect(columnToLetter(finalRefs[1].startCol)).toBe("B");
  });
});
