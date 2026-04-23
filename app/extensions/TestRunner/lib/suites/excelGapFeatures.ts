//! FILENAME: app/extensions/TestRunner/lib/suites/excelGapFeatures.ts
// PURPOSE: Tests for Excel gap features (PRODUCT, database functions, UsedRange,
//          DisplayZeros, MoveAfterReturn, hyperlinks follow, dirty state,
//          underline variants, cell change event, navigateToCell, locked/formulaHidden,
//          CF formula thresholds, inside borders, formula extension API,
//          error checking indicators, iterative calculation, named styles,
//          default dimensions, Range API, fill commands, CurrentRegion, BorderAround,
//          hyperbolic trig, rounding variants, math functions, ENCODEURL).
// CONTEXT: Verifies newly implemented features that close gaps with Excel.

import type { TestSuite } from "../types";
import { assertEqual, assertTrue, expectNotNull, expectCellValue } from "../assertions";
import { AREA_EXCEL_GAP } from "../testArea";
import {
  addHyperlink,
  getHyperlink,
  getHyperlinkIndicators,
  clearHyperlinksInRange,
  invokeBackend,
  addConditionalFormat,
  deleteConditionalFormat,
  sortRange,
} from "@api/backend";
import type { SortField } from "@api/backend";
import {
  applyFormatting,
  getStyle,
  applyBorderPreset,
  getIterationSettings,
  setIterationSettings,
  getDefaultDimensions,
  setDefaultRowHeight,
  setDefaultColumnWidth,
  getNamedStyles,
  createNamedStyle,
  deleteNamedStyle,
  applyNamedStyle,
  getCurrentRegion,
  getAutoRecoverSettings,
  setAutoRecoverSettings,
  getWorkbookProperties,
  setWorkbookProperties,
  getSheets,
  addSheet,
  deleteSheet,
  hideSheet,
  unhideSheet,
  nextSheet,
  previousSheet,
  setScrollArea,
  getScrollArea,
  getCalculationState,
  getPrecisionAsDisplayed,
  setPrecisionAsDisplayed,
  getCalculateBeforeSave,
  setCalculateBeforeSave,
} from "@api/lib";
import {
  registerFormulaFunction,
  getCustomFunction,
  getAllCustomFunctions,
} from "@api";
import type { CustomFunctionDef } from "@api";
import {
  navigateToCell,
  AppEvents,
  onAppEvent,
  emitAppEvent,
  fillDown,
  borderAround,
  getZoom,
  setZoomLevel,
  setStatusBarText,
  clearStatusBarText,
  getViewMode,
  changeViewMode,
  getReferenceStyle,
  changeReferenceStyle,
  convertFormulaStyle,
} from "@api";
import type { CellValuesChangedPayload } from "@api";
import { CellRange } from "@api";
import {
  getMoveAfterReturn,
  getMoveDirection,
  setMoveAfterReturn,
  setMoveDirection,
} from "@api/editingPreferences";

const A = AREA_EXCEL_GAP;

export const excelGapFeaturesSuite: TestSuite = {
  name: "Excel Gap Features",
  description:
    "Tests PRODUCT, database functions, UsedRange, DisplayZeros, MoveAfterReturn, hyperlinks, dirty state, underline variants, cell change event, navigateToCell, locked/formulaHidden, CF formula thresholds, inside borders, formula extension API, error checking indicators, iterative calculation, named styles, default dimensions, and Range API.",

  afterEach: async (ctx) => {
    // Clean up test area cells
    const updates = [];
    for (let r = 0; r < 30; r++) {
      for (let c = 0; c < 6; c++) {
        updates.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(updates);

    // Clean up hyperlinks in test area
    try {
      await clearHyperlinksInRange(A.row, A.col, A.row + 30, A.col + 6);
    } catch {
      /* ignore */
    }

    // Reset editing preferences to defaults
    setMoveAfterReturn(true);
    setMoveDirection("down");

    // Reset default dimensions to standard values
    try {
      await setDefaultRowHeight(24);
      await setDefaultColumnWidth(100);
    } catch {
      /* ignore */
    }

    // Reset view/calc settings added in Batch 7-11
    try {
      changeViewMode("normal");
    } catch {
      /* ignore */
    }
    try {
      await changeReferenceStyle("A1");
    } catch {
      /* ignore */
    }
    try {
      await setScrollArea(null);
    } catch {
      /* ignore */
    }
    try {
      await setPrecisionAsDisplayed(false);
      await setCalculateBeforeSave(true);
    } catch {
      /* ignore */
    }

    await ctx.settle();
  },

  tests: [
    // ======================================================================
    // 1. PRODUCT function
    // ======================================================================
    {
      name: "PRODUCT: basic multiplication",
      description: "PRODUCT of a range returns the product of all numbers.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "2" },
          { row: A.row + 1, col: A.col, value: "3" },
          { row: A.row + 2, col: A.col, value: "4" },
          { row: A.row + 3, col: A.col, value: "5" },
          { row: A.row + 4, col: A.col, value: "6" },
          {
            row: A.row + 5,
            col: A.col,
            value: `=PRODUCT(${A.ref(0, 0)}:${A.ref(4, 0)})`,
          },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 5, A.col);
        // 2 * 3 * 4 * 5 * 6 = 720
        expectCellValue(cell, "720", A.ref(5, 0));
      },
    },
    {
      name: "PRODUCT: with empty cells returns 0",
      description: "PRODUCT of a range containing only empty cells returns 0.",
      async run(ctx) {
        // Leave A.row..A.row+2 empty, put formula in row+3
        await ctx.setCells([
          {
            row: A.row + 3,
            col: A.col,
            value: `=PRODUCT(${A.ref(0, 0)}:${A.ref(2, 0)})`,
          },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 3, A.col);
        expectCellValue(cell, "0", A.ref(3, 0));
      },
    },
    {
      name: "PRODUCT: mixed text and numbers (text ignored)",
      description: "PRODUCT ignores text values and multiplies only numbers.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "3" },
          { row: A.row + 1, col: A.col, value: "hello" },
          { row: A.row + 2, col: A.col, value: "7" },
          {
            row: A.row + 3,
            col: A.col,
            value: `=PRODUCT(${A.ref(0, 0)}:${A.ref(2, 0)})`,
          },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 3, A.col);
        // 3 * 7 = 21 (text ignored)
        expectCellValue(cell, "21", A.ref(3, 0));
      },
    },

    // ======================================================================
    // 2. Database functions (DSUM, DAVERAGE, DCOUNT, DGET)
    // ======================================================================
    {
      name: "DSUM: sum salary by department",
      description: "DSUM sums matching rows based on criteria.",
      async run(ctx) {
        // Database: headers in row 0, data in rows 1-5
        // Col 0: Name, Col 1: Department, Col 2: Salary
        await ctx.setCells([
          // Headers
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Department" },
          { row: A.row, col: A.col + 2, value: "Salary" },
          // Data
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "Sales" },
          { row: A.row + 1, col: A.col + 2, value: "50000" },
          { row: A.row + 2, col: A.col, value: "Bob" },
          { row: A.row + 2, col: A.col + 1, value: "Engineering" },
          { row: A.row + 2, col: A.col + 2, value: "70000" },
          { row: A.row + 3, col: A.col, value: "Carol" },
          { row: A.row + 3, col: A.col + 1, value: "Sales" },
          { row: A.row + 3, col: A.col + 2, value: "55000" },
          { row: A.row + 4, col: A.col, value: "Dave" },
          { row: A.row + 4, col: A.col + 1, value: "Engineering" },
          { row: A.row + 4, col: A.col + 2, value: "65000" },
          { row: A.row + 5, col: A.col, value: "Eve" },
          { row: A.row + 5, col: A.col + 1, value: "Sales" },
          { row: A.row + 5, col: A.col + 2, value: "60000" },
          // Criteria range (col+4..col+5): Department = "Sales"
          { row: A.row, col: A.col + 4, value: "Department" },
          { row: A.row + 1, col: A.col + 4, value: "Sales" },
          // Formula
          {
            row: A.row + 8,
            col: A.col,
            value: `=DSUM(${A.ref(0, 0)}:${A.ref(5, 2)},"Salary",${A.ref(0, 4)}:${A.ref(1, 4)})`,
          },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 8, A.col);
        // Alice 50000 + Carol 55000 + Eve 60000 = 165000
        expectCellValue(cell, "165000", A.ref(8, 0));
      },
    },
    {
      name: "DAVERAGE: average salary by department",
      description: "DAVERAGE returns the average of matching rows.",
      async run(ctx) {
        // Same database layout
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Department" },
          { row: A.row, col: A.col + 2, value: "Salary" },
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "Sales" },
          { row: A.row + 1, col: A.col + 2, value: "50000" },
          { row: A.row + 2, col: A.col, value: "Bob" },
          { row: A.row + 2, col: A.col + 1, value: "Engineering" },
          { row: A.row + 2, col: A.col + 2, value: "70000" },
          { row: A.row + 3, col: A.col, value: "Carol" },
          { row: A.row + 3, col: A.col + 1, value: "Sales" },
          { row: A.row + 3, col: A.col + 2, value: "55000" },
          // Criteria: Sales
          { row: A.row, col: A.col + 4, value: "Department" },
          { row: A.row + 1, col: A.col + 4, value: "Sales" },
          // Formula
          {
            row: A.row + 8,
            col: A.col,
            value: `=DAVERAGE(${A.ref(0, 0)}:${A.ref(3, 2)},"Salary",${A.ref(0, 4)}:${A.ref(1, 4)})`,
          },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 8, A.col);
        // (50000 + 55000) / 2 = 52500
        expectCellValue(cell, "52500", A.ref(8, 0));
      },
    },
    {
      name: "DCOUNT: count numeric values by criteria",
      description: "DCOUNT counts numeric cells matching criteria.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Department" },
          { row: A.row, col: A.col + 2, value: "Salary" },
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "Sales" },
          { row: A.row + 1, col: A.col + 2, value: "50000" },
          { row: A.row + 2, col: A.col, value: "Bob" },
          { row: A.row + 2, col: A.col + 1, value: "Engineering" },
          { row: A.row + 2, col: A.col + 2, value: "70000" },
          { row: A.row + 3, col: A.col, value: "Carol" },
          { row: A.row + 3, col: A.col + 1, value: "Sales" },
          { row: A.row + 3, col: A.col + 2, value: "55000" },
          { row: A.row + 4, col: A.col, value: "Dave" },
          { row: A.row + 4, col: A.col + 1, value: "Engineering" },
          { row: A.row + 4, col: A.col + 2, value: "65000" },
          // Criteria: Engineering
          { row: A.row, col: A.col + 4, value: "Department" },
          { row: A.row + 1, col: A.col + 4, value: "Engineering" },
          // Formula
          {
            row: A.row + 8,
            col: A.col,
            value: `=DCOUNT(${A.ref(0, 0)}:${A.ref(4, 2)},"Salary",${A.ref(0, 4)}:${A.ref(1, 4)})`,
          },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 8, A.col);
        // Bob + Dave = 2 engineering salaries
        expectCellValue(cell, "2", A.ref(8, 0));
      },
    },
    {
      name: "DGET: retrieve single matching value",
      description: "DGET returns the single value matching criteria.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Department" },
          { row: A.row, col: A.col + 2, value: "Salary" },
          { row: A.row + 1, col: A.col, value: "Alice" },
          { row: A.row + 1, col: A.col + 1, value: "Sales" },
          { row: A.row + 1, col: A.col + 2, value: "50000" },
          { row: A.row + 2, col: A.col, value: "Bob" },
          { row: A.row + 2, col: A.col + 1, value: "Engineering" },
          { row: A.row + 2, col: A.col + 2, value: "70000" },
          { row: A.row + 3, col: A.col, value: "Carol" },
          { row: A.row + 3, col: A.col + 1, value: "HR" },
          { row: A.row + 3, col: A.col + 2, value: "55000" },
          // Criteria: Name = "Bob" (unique match)
          { row: A.row, col: A.col + 4, value: "Name" },
          { row: A.row + 1, col: A.col + 4, value: "Bob" },
          // Formula
          {
            row: A.row + 8,
            col: A.col,
            value: `=DGET(${A.ref(0, 0)}:${A.ref(3, 2)},"Salary",${A.ref(0, 4)}:${A.ref(1, 4)})`,
          },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 8, A.col);
        expectCellValue(cell, "70000", A.ref(8, 0));
      },
    },

    // ======================================================================
    // 3. UsedRange
    // ======================================================================
    {
      name: "UsedRange: reflects written cells",
      description: "getUsedRange returns bounds encompassing written cells.",
      async run(ctx) {
        // Write some cells at known positions
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A" },
          { row: A.row + 5, col: A.col + 3, value: "B" },
        ]);
        await ctx.settle();

        const range = await invokeBackend<{
          startRow: number;
          startCol: number;
          endRow: number;
          endCol: number;
          empty: boolean;
        }>("get_used_range");

        assertTrue(!range.empty, "used range should not be empty");
        // The used range should encompass at least our test cells
        assertTrue(range.startRow <= A.row, `startRow ${range.startRow} should be <= ${A.row}`);
        assertTrue(range.startCol <= A.col, `startCol ${range.startCol} should be <= ${A.col}`);
        assertTrue(
          range.endRow >= A.row + 5,
          `endRow ${range.endRow} should be >= ${A.row + 5}`
        );
        assertTrue(
          range.endCol >= A.col + 3,
          `endCol ${range.endCol} should be >= ${A.col + 3}`
        );
      },
    },

    // ======================================================================
    // 4. DisplayZeros toggle
    // ======================================================================
    {
      name: "DisplayZeros: toggle state via command",
      description: "Toggling displayZeros changes the grid state.",
      async run(ctx) {
        // Set a cell to 0 for context
        await ctx.setCells([{ row: A.row, col: A.col, value: "0" }]);
        await ctx.settle();

        // Verify cell displays "0" before toggle
        const before = await ctx.getCell(A.row, A.col);
        expectCellValue(before, "0", A.ref(0, 0));

        // Toggle displayZeros off
        await ctx.executeCommand("view.toggleDisplayZeros");
        await ctx.settle();

        // Toggle it back on (cleanup)
        await ctx.executeCommand("view.toggleDisplayZeros");
        await ctx.settle();

        // Cell should still be "0" with displayZeros back on
        const after = await ctx.getCell(A.row, A.col);
        expectCellValue(after, "0", A.ref(0, 0));
      },
    },

    // ======================================================================
    // 5. MoveAfterReturn
    // ======================================================================
    {
      name: "MoveAfterReturn: default is true",
      description: "getMoveAfterReturn returns true by default.",
      async run(_ctx) {
        // Reset to ensure clean state
        setMoveAfterReturn(true);

        const result = getMoveAfterReturn();
        assertEqual(result, true, "default moveAfterReturn");
      },
    },
    {
      name: "MoveAfterReturn: setMoveDirection changes direction",
      description: "setMoveDirection('right') changes the move direction.",
      async run(_ctx) {
        setMoveDirection("right");
        const dir = getMoveDirection();
        assertEqual(dir, "right", "direction should be right");

        setMoveDirection("up");
        const dir2 = getMoveDirection();
        assertEqual(dir2, "up", "direction should be up");
      },
    },
    {
      name: "MoveAfterReturn: toggle off and on",
      description: "setMoveAfterReturn(false) then true round-trips correctly.",
      async run(_ctx) {
        setMoveAfterReturn(false);
        assertEqual(getMoveAfterReturn(), false, "should be false after set");

        setMoveAfterReturn(true);
        assertEqual(getMoveAfterReturn(), true, "should be true after reset");
      },
    },

    // ======================================================================
    // 6. Hyperlinks follow
    // ======================================================================
    {
      name: "Hyperlinks: add and retrieve",
      description: "addHyperlink creates a link, getHyperlink retrieves it.",
      async run(ctx) {
        const result = await addHyperlink({
          row: A.row,
          col: A.col,
          linkType: "url",
          target: "https://example.com",
          displayText: "Example Link",
          tooltip: "Visit example",
        });
        assertTrue(result.success, "addHyperlink should succeed");

        const link = await getHyperlink(A.row, A.col);
        expectNotNull(link, "hyperlink should exist");
        assertEqual(link!.linkType, "url", "type should be url");
        assertEqual(link!.target, "https://example.com", "target should match");
      },
    },
    {
      name: "Hyperlinks: indicators include cell",
      description: "getHyperlinkIndicators returns the hyperlinked cell.",
      async run(ctx) {
        await addHyperlink({
          row: A.row,
          col: A.col,
          linkType: "url",
          target: "https://indicator-test.com",
        });

        const indicators = await getHyperlinkIndicators();
        const found = indicators.some(
          (ind) => ind.row === A.row && ind.col === A.col
        );
        assertTrue(found, "indicators should include our hyperlink cell");
      },
    },
    {
      name: "Hyperlinks: clearHyperlinksInRange removes links",
      description: "After clearing, getHyperlink returns null.",
      async run(ctx) {
        await addHyperlink({
          row: A.row,
          col: A.col,
          linkType: "url",
          target: "https://to-be-cleared.com",
        });

        const beforeClear = await getHyperlink(A.row, A.col);
        expectNotNull(beforeClear, "hyperlink should exist before clear");

        await clearHyperlinksInRange(A.row, A.col, A.row, A.col);
        await ctx.settle();

        const afterClear = await getHyperlink(A.row, A.col);
        assertTrue(afterClear === null, "hyperlink should be null after clear");
      },
    },

    // ======================================================================
    // 7. Dirty/saved state
    // ======================================================================
    {
      name: "Dirty state: modification marks dirty",
      description: "After modifying a cell, the workbook should be dirty.",
      async run(ctx) {
        // Modify a cell to trigger dirty state
        await ctx.setCells([{ row: A.row, col: A.col, value: "dirty-test" }]);
        await ctx.settle();

        // The cell should have our value, confirming the modification happened
        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "dirty-test", A.ref(0, 0));

        // After a modification the backend should report dirty
        // (mark_file_modified is called by setCells internally)
        const isDirty = await invokeBackend<boolean>("is_file_modified");
        assertTrue(isDirty, "workbook should be dirty after modification");
      },
    },

    // ======================================================================
    // 8. Underline variants (H9)
    // ======================================================================
    {
      name: "Underline: single underline",
      description: "Apply underline='single' and verify via StyleData.",
      async run(ctx) {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Underline test" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { underline: "single" });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertEqual(style.underline, "single", "underline should be single");
      },
    },
    {
      name: "Underline: double underline",
      description: "Apply underline='double' and verify via StyleData.",
      async run(ctx) {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Double underline" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { underline: "double" });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertEqual(style.underline, "double", "underline should be double");
      },
    },
    {
      name: "Underline: reset to none",
      description: "Apply underline='none' and verify it resets.",
      async run(ctx) {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Reset underline" }]);
        await ctx.settle();

        // First apply single underline
        await applyFormatting([A.row], [A.col], { underline: "single" });
        await ctx.settle();

        // Then reset to none
        const result = await applyFormatting([A.row], [A.col], { underline: "none" });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertEqual(style.underline, "none", "underline should be none after reset");
      },
    },

    // ======================================================================
    // 9. Cell Change event (H22)
    // ======================================================================
    {
      name: "CellValuesChanged: event type is registered",
      description: "Verifies the CELL_VALUES_CHANGED event constant exists and a listener can be attached.",
      async run(ctx) {
        // The CELL_VALUES_CHANGED event fires from the UI editing flow (cellEvents emitter),
        // not from direct Tauri API calls like setCells/updateCellsBatch.
        // So we test that the event infrastructure is wired up correctly.
        assertEqual(AppEvents.CELL_VALUES_CHANGED, "app:cell-values-changed", "event name");

        // Verify we can subscribe and unsubscribe without error
        let called = false;
        const cleanup = onAppEvent<CellValuesChangedPayload>(
          AppEvents.CELL_VALUES_CHANGED,
          () => { called = true; }
        );

        // Manually dispatch to verify the listener works
        const testPayload: CellValuesChangedPayload = {
          changes: [{ row: 0, col: 0, newValue: "test" }],
          source: "api",
        };
        emitAppEvent(AppEvents.CELL_VALUES_CHANGED, testPayload);
        await ctx.settle();

        assertTrue(called, "listener should have been called on manual dispatch");
        cleanup();
      },
    },

    // ======================================================================
    // 10. ScrollIntoView / navigateToCell (H23)
    // ======================================================================
    {
      name: "NavigateToCell: function exists and does not throw",
      description: "Calling navigateToCell with valid coordinates does not throw.",
      async run(ctx) {
        // Navigate to a distant cell
        navigateToCell(A.row + 20, A.col + 5);
        await ctx.settle();

        // Navigate back to the test area origin
        navigateToCell(A.row, A.col);
        await ctx.settle();

        // If we got here without throwing, the test passes.
        assertTrue(true, "navigateToCell should not throw");
      },
    },

    // ======================================================================
    // 11. Locked / FormulaHidden on CellStyle (H12)
    // ======================================================================
    {
      name: "Locked: set locked=false and verify",
      description: "Apply locked=false and read back from StyleData.",
      async run(ctx) {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Lock test" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { locked: false });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertEqual(style.locked, false, "locked should be false");
      },
    },
    {
      name: "FormulaHidden: set formulaHidden=true and verify",
      description: "Apply formulaHidden=true and read back from StyleData.",
      async run(ctx) {
        await ctx.setCells([{ row: A.row, col: A.col, value: "=1+1" }]);
        await ctx.settle();

        const result = await applyFormatting([A.row], [A.col], { formulaHidden: true });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertEqual(style.formulaHidden, true, "formulaHidden should be true");
      },
    },
    {
      name: "Locked/FormulaHidden: reset to defaults",
      description: "Reset locked=true and formulaHidden=false (Excel defaults).",
      async run(ctx) {
        await ctx.setCells([{ row: A.row, col: A.col, value: "Reset test" }]);
        await ctx.settle();

        // First set non-default values
        await applyFormatting([A.row], [A.col], { locked: false, formulaHidden: true });
        await ctx.settle();

        // Reset to defaults
        const result = await applyFormatting([A.row], [A.col], { locked: true, formulaHidden: false });
        const cell = result.cells.find(c => c.row === A.row && c.col === A.col);
        expectNotNull(cell, "cell should be in result");
        const style = await getStyle(cell!.styleIndex);
        assertEqual(style.locked, true, "locked should be true (default)");
        assertEqual(style.formulaHidden, false, "formulaHidden should be false (default)");
      },
    },

    // ======================================================================
    // 12. CF formula thresholds (H18)
    // ======================================================================
    {
      name: "CF formula thresholds: create color scale with formula points",
      description: "Create a conditional format color scale using formula-based thresholds.",
      async run(ctx) {
        // Set up some data for the CF range
        await ctx.setCells([
          { row: A.row, col: A.col, value: "10" },
          { row: A.row + 1, col: A.col, value: "50" },
          { row: A.row + 2, col: A.col, value: "90" },
        ]);
        await ctx.settle();

        // Create a color scale with formula-based thresholds
        const result = await addConditionalFormat({
          rule: {
            type: "colorScale",
            minPoint: {
              valueType: "formula",
              formula: "=MIN(" + A.ref(0, 0) + ":" + A.ref(2, 0) + ")",
              color: "#FF0000",
            },
            maxPoint: {
              valueType: "formula",
              formula: "=MAX(" + A.ref(0, 0) + ":" + A.ref(2, 0) + ")",
              color: "#00FF00",
            },
          },
          format: {},
          ranges: [
            {
              startRow: A.row,
              startCol: A.col,
              endRow: A.row + 2,
              endCol: A.col,
            },
          ],
        });

        assertTrue(result.success, "addConditionalFormat should succeed");
        expectNotNull(result.rule, "result should contain the created rule");
        assertTrue(result.rule!.id >= 0, "should return a valid rule id");

        // Clean up the CF rule
        await deleteConditionalFormat(result.rule!.id);
        await ctx.settle();
      },
    },

    // ======================================================================
    // 13. Inside borders (H11)
    // ======================================================================
    {
      name: "Borders: allBorders preset applies borders to all cells",
      description: "Apply allBorders preset to a 3x3 range and verify interior cells have borders on all 4 sides.",
      async run(ctx) {
        // Set up a 3x3 range of cells with values
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A1" },
          { row: A.row, col: A.col + 1, value: "B1" },
          { row: A.row, col: A.col + 2, value: "C1" },
          { row: A.row + 1, col: A.col, value: "A2" },
          { row: A.row + 1, col: A.col + 1, value: "B2" },
          { row: A.row + 1, col: A.col + 2, value: "C2" },
          { row: A.row + 2, col: A.col, value: "A3" },
          { row: A.row + 2, col: A.col + 1, value: "B3" },
          { row: A.row + 2, col: A.col + 2, value: "C3" },
        ]);
        await ctx.settle();

        // Apply allBorders preset
        const result = await applyBorderPreset(
          A.row, A.col, A.row + 2, A.col + 2,
          "allBorders", "solid", "#000000", 1
        );
        await ctx.settle();

        // Check interior cell (center of 3x3) has borders on all 4 sides
        const centerCell = result.cells.find(
          (c) => c.row === A.row + 1 && c.col === A.col + 1
        );
        expectNotNull(centerCell, "center cell should be in result");
        const centerStyle = await getStyle(centerCell!.styleIndex);

        assertTrue(centerStyle.borderTop.width > 0, "center cell should have top border");
        assertTrue(centerStyle.borderBottom.width > 0, "center cell should have bottom border");
        assertTrue(centerStyle.borderLeft.width > 0, "center cell should have left border");
        assertTrue(centerStyle.borderRight.width > 0, "center cell should have right border");

        // Check a corner cell (top-left) also has borders
        const cornerCell = result.cells.find(
          (c) => c.row === A.row && c.col === A.col
        );
        expectNotNull(cornerCell, "corner cell should be in result");
        const cornerStyle = await getStyle(cornerCell!.styleIndex);
        assertTrue(cornerStyle.borderTop.width > 0, "corner cell should have top border");
        assertTrue(cornerStyle.borderLeft.width > 0, "corner cell should have left border");
      },
    },
    {
      name: "Borders: none preset clears all borders",
      description: "After applying allBorders, clearing with none preset should remove borders.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "X1" },
          { row: A.row, col: A.col + 1, value: "X2" },
          { row: A.row + 1, col: A.col, value: "X3" },
          { row: A.row + 1, col: A.col + 1, value: "X4" },
        ]);
        await ctx.settle();

        // Apply borders first
        await applyBorderPreset(
          A.row, A.col, A.row + 1, A.col + 1,
          "allBorders", "solid", "#000000", 1
        );
        await ctx.settle();

        // Clear borders
        const cleared = await applyBorderPreset(
          A.row, A.col, A.row + 1, A.col + 1,
          "none", "solid", "#000000", 0
        );
        await ctx.settle();

        // Verify borders are cleared on all cells
        for (const cell of cleared.cells) {
          const style = await getStyle(cell.styleIndex);
          assertEqual(style.borderTop.width, 0, `cell (${cell.row},${cell.col}) top border should be cleared`);
          assertEqual(style.borderBottom.width, 0, `cell (${cell.row},${cell.col}) bottom border should be cleared`);
          assertEqual(style.borderLeft.width, 0, `cell (${cell.row},${cell.col}) left border should be cleared`);
          assertEqual(style.borderRight.width, 0, `cell (${cell.row},${cell.col}) right border should be cleared`);
        }
      },
    },

    // ======================================================================
    // 14. Formula extension API (H14)
    // ======================================================================
    {
      name: "Formula API: register and retrieve custom function",
      description: "Register a custom function, verify it can be retrieved, then unregister.",
      async run(_ctx) {
        const def: CustomFunctionDef = {
          name: "TESTCUSTOM",
          description: "A test custom function",
          syntax: "TESTCUSTOM(value)",
          category: "Custom",
          minArgs: 1,
          maxArgs: 1,
          implementation: (val: unknown) => val,
        };

        const unregister = registerFormulaFunction(def);

        // Verify getCustomFunction returns the definition
        const retrieved = getCustomFunction("TESTCUSTOM");
        expectNotNull(retrieved, "TESTCUSTOM should be retrievable after registration");
        assertEqual(retrieved!.name, "TESTCUSTOM", "function name should match");
        assertEqual(retrieved!.description, "A test custom function", "description should match");
        assertEqual(retrieved!.category, "Custom", "category should match");

        // Verify getAllCustomFunctions includes it
        const all = getAllCustomFunctions();
        const found = all.some((f) => f.name === "TESTCUSTOM");
        assertTrue(found, "getAllCustomFunctions should include TESTCUSTOM");

        // Unregister
        unregister();

        // Verify it's gone
        const afterUnregister = getCustomFunction("TESTCUSTOM");
        assertTrue(
          afterUnregister === undefined,
          "TESTCUSTOM should be undefined after unregister"
        );
      },
    },
    {
      name: "Formula API: case-insensitive lookup",
      description: "Custom function lookup should be case-insensitive.",
      async run(_ctx) {
        const def: CustomFunctionDef = {
          name: "TestLookup",
          description: "Case test",
          syntax: "TESTLOOKUP()",
          category: "Custom",
          minArgs: 0,
          maxArgs: 0,
          implementation: () => 42,
        };

        const unregister = registerFormulaFunction(def);

        // Lookup with different cases
        const lower = getCustomFunction("testlookup");
        expectNotNull(lower, "lowercase lookup should work");

        const upper = getCustomFunction("TESTLOOKUP");
        expectNotNull(upper, "uppercase lookup should work");

        const mixed = getCustomFunction("TestLookup");
        expectNotNull(mixed, "mixed case lookup should work");

        unregister();
      },
    },

    // ======================================================================
    // 15. Error checking indicators (H25)
    // ======================================================================
    {
      name: "Error indicators: command exists and returns array",
      description: "get_error_indicators command should exist and return an array.",
      async run(ctx) {
        // Set up a cell with some value
        await ctx.setCells([
          { row: A.row, col: A.col, value: "123" },
        ]);
        await ctx.settle();

        // Call the backend command - verify it exists and returns an array
        const indicators = await invokeBackend<unknown[]>("get_error_indicators", {
          startRow: A.row,
          startCol: A.col,
          endRow: A.row,
          endCol: A.col,
        });

        assertTrue(
          Array.isArray(indicators),
          "get_error_indicators should return an array"
        );
      },
    },

    // ======================================================================
    // 16. Iterative calculation (H20)
    // ======================================================================
    {
      name: "Iterative calc: default settings",
      description: "Default iteration settings should be enabled=false, maxIterations=100, maxChange=0.001.",
      async run(ctx) {
        // Reset to defaults first
        await setIterationSettings(false, 100, 0.001);
        await ctx.settle();

        const settings = await getIterationSettings();
        assertEqual(settings.enabled, false, "default enabled should be false");
        assertEqual(settings.maxIterations, 100, "default maxIterations should be 100");
        assertEqual(settings.maxChange, 0.001, "default maxChange should be 0.001");
      },
    },
    {
      name: "Iterative calc: change and read back settings",
      description: "setIterationSettings updates values, getIterationSettings reads them back.",
      async run(ctx) {
        // Change settings
        const updated = await setIterationSettings(true, 50, 0.01);
        await ctx.settle();

        assertEqual(updated.enabled, true, "returned enabled should be true");
        assertEqual(updated.maxIterations, 50, "returned maxIterations should be 50");
        assertEqual(updated.maxChange, 0.01, "returned maxChange should be 0.01");

        // Read back to confirm persistence
        const readBack = await getIterationSettings();
        assertEqual(readBack.enabled, true, "readBack enabled should be true");
        assertEqual(readBack.maxIterations, 50, "readBack maxIterations should be 50");
        assertEqual(readBack.maxChange, 0.01, "readBack maxChange should be 0.01");

        // Reset to defaults
        await setIterationSettings(false, 100, 0.001);
        await ctx.settle();
      },
    },
    {
      name: "Iterative calc: reset to defaults",
      description: "After changing settings, resetting returns original defaults.",
      async run(ctx) {
        // Set non-default values
        await setIterationSettings(true, 200, 0.0001);
        await ctx.settle();

        // Reset to defaults
        const reset = await setIterationSettings(false, 100, 0.001);
        await ctx.settle();

        assertEqual(reset.enabled, false, "reset enabled should be false");
        assertEqual(reset.maxIterations, 100, "reset maxIterations should be 100");
        assertEqual(reset.maxChange, 0.001, "reset maxChange should be 0.001");
      },
    },

    // ======================================================================
    // 17. Named Styles (H10)
    // ======================================================================
    {
      name: "Named Styles: get built-in styles returns non-empty list",
      description: "getNamedStyles returns a non-empty array of built-in styles.",
      async run(ctx) {
        const styles = await getNamedStyles();
        await ctx.settle();

        assertTrue(Array.isArray(styles), "result should be an array");
        assertTrue(styles.length > 0, "should have at least one built-in style");

        // Built-in styles should be marked as builtIn
        const builtIn = styles.filter((s) => s.builtIn);
        assertTrue(builtIn.length > 0, "should have at least one builtIn style");
      },
    },
    {
      name: "Named Styles: create, verify, and delete custom style",
      description: "Create a custom named style, verify it appears, then delete it.",
      async run(ctx) {
        // Use styleIndex 0 (default style) as the base
        const created = await createNamedStyle("TestCustomStyle", 0, "Custom");
        await ctx.settle();

        assertEqual(created.name, "TestCustomStyle", "created style name should match");
        assertEqual(created.builtIn, false, "custom style should not be builtIn");

        // Verify it appears in the list
        const styles = await getNamedStyles();
        const found = styles.some((s) => s.name === "TestCustomStyle");
        assertTrue(found, "custom style should appear in getNamedStyles list");

        // Delete the custom style
        await deleteNamedStyle("TestCustomStyle");
        await ctx.settle();

        // Verify it is gone
        const stylesAfter = await getNamedStyles();
        const foundAfter = stylesAfter.some((s) => s.name === "TestCustomStyle");
        assertTrue(!foundAfter, "custom style should be removed after deletion");
      },
    },

    // ======================================================================
    // 18. Default Dimensions (H8)
    // ======================================================================
    {
      name: "Default Dimensions: initial values are 24 and 100",
      description: "getDefaultDimensions returns defaultRowHeight=24 and defaultColumnWidth=100.",
      async run(ctx) {
        // Ensure defaults are set
        await setDefaultRowHeight(24);
        await setDefaultColumnWidth(100);
        await ctx.settle();

        const dims = await getDefaultDimensions();
        assertEqual(dims.defaultRowHeight, 24, "default row height");
        assertEqual(dims.defaultColumnWidth, 100, "default column width");
      },
    },
    {
      name: "Default Dimensions: set custom height and read back",
      description: "setDefaultRowHeight changes the value, read back verifies.",
      async run(ctx) {
        const result = await setDefaultRowHeight(30);
        await ctx.settle();

        assertEqual(result.defaultRowHeight, 30, "returned row height should be 30");

        // Read back to confirm
        const dims = await getDefaultDimensions();
        assertEqual(dims.defaultRowHeight, 30, "readBack row height should be 30");

        // Reset (afterEach also resets, but be explicit)
        await setDefaultRowHeight(24);
        await ctx.settle();
      },
    },
    {
      name: "Default Dimensions: set custom width and read back",
      description: "setDefaultColumnWidth changes the value, read back verifies.",
      async run(ctx) {
        const result = await setDefaultColumnWidth(150);
        await ctx.settle();

        assertEqual(result.defaultColumnWidth, 150, "returned column width should be 150");

        // Read back to confirm
        const dims = await getDefaultDimensions();
        assertEqual(dims.defaultColumnWidth, 150, "readBack column width should be 150");

        // Reset
        await setDefaultColumnWidth(100);
        await ctx.settle();
      },
    },

    // ======================================================================
    // 19. Range API (H26)
    // ======================================================================
    {
      name: "Range API: fromCell creates single-cell range",
      description: "CellRange.fromCell(5, 3) has correct properties.",
      async run(_ctx) {
        const range = CellRange.fromCell(5, 3);
        assertEqual(range.startRow, 5, "startRow");
        assertEqual(range.startCol, 3, "startCol");
        assertEqual(range.endRow, 5, "endRow");
        assertEqual(range.endCol, 3, "endCol");
        assertTrue(range.isSingleCell, "should be a single cell");
      },
    },
    {
      name: "Range API: fromAddress parses A1:C5 correctly",
      description: "CellRange.fromAddress('A1:C5') parses to correct row/col bounds.",
      async run(_ctx) {
        const range = CellRange.fromAddress("A1:C5");
        assertEqual(range.startRow, 0, "startRow should be 0 (A1 is row 0)");
        assertEqual(range.startCol, 0, "startCol should be 0 (A is col 0)");
        assertEqual(range.endRow, 4, "endRow should be 4 (row 5 is index 4)");
        assertEqual(range.endCol, 2, "endCol should be 2 (C is col 2)");
        assertEqual(range.rowCount, 5, "rowCount");
        assertEqual(range.colCount, 3, "colCount");
      },
    },
    {
      name: "Range API: offset returns correctly shifted range",
      description: "offset() shifts start and end by the given amounts.",
      async run(_ctx) {
        const range = CellRange.fromAddress("B2:D4");
        const shifted = range.offset(3, 2);
        assertEqual(shifted.startRow, range.startRow + 3, "startRow shifted by 3");
        assertEqual(shifted.startCol, range.startCol + 2, "startCol shifted by 2");
        assertEqual(shifted.endRow, range.endRow + 3, "endRow shifted by 3");
        assertEqual(shifted.endCol, range.endCol + 2, "endCol shifted by 2");
        // Shape should be preserved
        assertEqual(shifted.rowCount, range.rowCount, "rowCount preserved");
        assertEqual(shifted.colCount, range.colCount, "colCount preserved");
      },
    },
    {
      name: "Range API: contains returns true/false correctly",
      description: "contains() returns true for cells inside and false for cells outside.",
      async run(_ctx) {
        const range = CellRange.fromAddress("B2:D4");
        // Inside: B2 is (1,1), C3 is (2,2), D4 is (3,3)
        assertTrue(range.contains(1, 1), "B2 (1,1) should be inside");
        assertTrue(range.contains(2, 2), "C3 (2,2) should be inside");
        assertTrue(range.contains(3, 3), "D4 (3,3) should be inside");
        // Outside
        assertTrue(!range.contains(0, 0), "A1 (0,0) should be outside");
        assertTrue(!range.contains(4, 1), "row 4 should be outside");
        assertTrue(!range.contains(1, 4), "col 4 should be outside");
      },
    },

    // ======================================================================
    // 20. Fill Commands (Batch 5)
    // ======================================================================
    {
      name: "Fill Down: copies top row values to rows below",
      description: "fillDown replicates the first row of a selection into subsequent rows.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Fill1" },
          { row: A.row, col: A.col + 1, value: "Fill2" },
        ]);
        await ctx.settle();

        // Fill down from row A.row to A.row+2 (single column)
        await fillDown(A.row, A.col, A.row + 2, A.col);
        await ctx.settle();

        const cell1 = await ctx.getCell(A.row + 1, A.col);
        expectCellValue(cell1, "Fill1", A.ref(1, 0));

        const cell2 = await ctx.getCell(A.row + 2, A.col);
        expectCellValue(cell2, "Fill1", A.ref(2, 0));
      },
    },

    // ======================================================================
    // 21. CurrentRegion (Batch 5)
    // ======================================================================
    {
      name: "CurrentRegion: detects contiguous data block",
      description: "getCurrentRegion returns the bounding rectangle of a contiguous data block.",
      async run(ctx) {
        // Set up a 3x3 block of data at test area
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A1" },
          { row: A.row, col: A.col + 1, value: "B1" },
          { row: A.row, col: A.col + 2, value: "C1" },
          { row: A.row + 1, col: A.col, value: "A2" },
          { row: A.row + 1, col: A.col + 1, value: "B2" },
          { row: A.row + 1, col: A.col + 2, value: "C2" },
          { row: A.row + 2, col: A.col, value: "A3" },
          { row: A.row + 2, col: A.col + 1, value: "B3" },
          { row: A.row + 2, col: A.col + 2, value: "C3" },
        ]);
        await ctx.settle();

        const region = await getCurrentRegion(A.row, A.col);

        assertTrue(!region.empty, "region should not be empty");
        assertTrue(region.startRow <= A.row, `startRow ${region.startRow} should be <= ${A.row}`);
        assertTrue(region.startCol <= A.col, `startCol ${region.startCol} should be <= ${A.col}`);
        assertTrue(region.endRow >= A.row + 2, `endRow ${region.endRow} should be >= ${A.row + 2}`);
        assertTrue(region.endCol >= A.col + 2, `endCol ${region.endCol} should be >= ${A.col + 2}`);
      },
    },

    // ======================================================================
    // 22. BorderAround (Batch 5)
    // ======================================================================
    {
      name: "BorderAround: applies outside borders to a range",
      description: "borderAround applies borders to the outside edges of a 2x2 range.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "TL" },
          { row: A.row, col: A.col + 1, value: "TR" },
          { row: A.row + 1, col: A.col, value: "BL" },
          { row: A.row + 1, col: A.col + 1, value: "BR" },
        ]);
        await ctx.settle();

        const result = await borderAround(A.row, A.col, A.row + 1, A.col + 1);
        await ctx.settle();

        // Check top-left corner cell has top and left borders
        const tlCell = result.cells.find(
          (c) => c.row === A.row && c.col === A.col
        );
        expectNotNull(tlCell, "top-left cell should be in result");
        const tlStyle = await getStyle(tlCell!.styleIndex);
        assertTrue(tlStyle.borderTop.width > 0, "top-left cell should have top border");
        assertTrue(tlStyle.borderLeft.width > 0, "top-left cell should have left border");
      },
    },

    // ======================================================================
    // 23. Hyperbolic Trig Functions (Batch 6)
    // ======================================================================
    {
      name: "SINH: returns hyperbolic sine",
      description: "SINH(1) returns approximately 1.1752.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=SINH(1)" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        const val = parseFloat(cell.display.replace(",", "."));
        assertTrue(
          Math.abs(val - 1.1752) < 0.001,
          `SINH(1) should be ~1.1752, got ${cell.display}`
        );
      },
    },
    {
      name: "COSH: returns hyperbolic cosine",
      description: "COSH(0) returns 1.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=COSH(0)" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "1", A.ref(0, 0));
      },
    },
    {
      name: "TANH: returns hyperbolic tangent",
      description: "TANH(0) returns 0.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=TANH(0)" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "0", A.ref(0, 0));
      },
    },

    // ======================================================================
    // 24. Rounding Variants (Batch 6)
    // ======================================================================
    {
      name: "CEILING.MATH: rounds up to nearest multiple",
      description: "CEILING.MATH(6.3, 5) returns 10.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=CEILING.MATH(6.3, 5)" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "10", A.ref(0, 0));
      },
    },
    {
      name: "FLOOR.MATH: rounds down to nearest multiple",
      description: "FLOOR.MATH(6.7, 5) returns 5.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=FLOOR.MATH(6.7, 5)" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "5", A.ref(0, 0));
      },
    },

    // ======================================================================
    // 25. Math Functions (Batch 6)
    // ======================================================================
    {
      name: "SQRTPI: returns square root of pi times argument",
      description: "SQRTPI(1) returns approximately 1.7724.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=SQRTPI(1)" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        const val = parseFloat(cell.display.replace(",", "."));
        assertTrue(
          Math.abs(val - 1.7724) < 0.001,
          `SQRTPI(1) should be ~1.7724, got ${cell.display}`
        );
      },
    },
    {
      name: "FACTDOUBLE: returns double factorial",
      description: "FACTDOUBLE(5) returns 15 (5*3*1).",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=FACTDOUBLE(5)" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "15", A.ref(0, 0));
      },
    },
    {
      name: "COMBINA: returns combinations with repetitions",
      description: "COMBINA(4,2) returns 10.",
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "=COMBINA(4,2)" },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "10", A.ref(0, 0));
      },
    },

    // ======================================================================
    // 26. ENCODEURL (Batch 6)
    // ======================================================================
    {
      name: "ENCODEURL: encodes spaces as %20",
      description: 'ENCODEURL("hello world") returns "hello%20world".',
      async run(ctx) {
        await ctx.setCells([
          { row: A.row, col: A.col, value: '=ENCODEURL("hello world")' },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row, A.col);
        expectCellValue(cell, "hello%20world", A.ref(0, 0));
      },
    },

    // ======================================================================
    // 27. Custom Sort Lists (Batch 2)
    // ======================================================================
    {
      name: "Custom sort: weekdays order",
      description: "Sort using customOrder='weekdays' orders Mon, Wed, Fri correctly.",
      async run(ctx) {
        // Set up cells: Wed, Mon, Fri in a column
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Wed" },
          { row: A.row + 1, col: A.col, value: "Mon" },
          { row: A.row + 2, col: A.col, value: "Fri" },
        ]);
        await ctx.settle();

        // Sort using customOrder weekdays
        const fields: SortField[] = [
          { key: 0, ascending: true, customOrder: "weekdaysShort" },
        ];
        await sortRange(
          A.row, A.col, A.row + 2, A.col,
          fields,
          { hasHeaders: false }
        );
        await ctx.settle();

        // Verify order becomes Mon, Wed, Fri
        const cell0 = await ctx.getCell(A.row, A.col);
        expectCellValue(cell0, "Mon", A.ref(0, 0));

        const cell1 = await ctx.getCell(A.row + 1, A.col);
        expectCellValue(cell1, "Wed", A.ref(1, 0));

        const cell2 = await ctx.getCell(A.row + 2, A.col);
        expectCellValue(cell2, "Fri", A.ref(2, 0));
      },
    },

    // ======================================================================
    // 28. AutoRecover Settings (Batch 3)
    // ======================================================================
    {
      name: "AutoRecover: default settings",
      description: "Default auto-recover settings are enabled=true, intervalMs=300000.",
      async run(ctx) {
        // Reset to defaults first
        await setAutoRecoverSettings(true, 300000);
        await ctx.settle();

        const settings = await getAutoRecoverSettings();
        assertEqual(settings.enabled, true, "default enabled should be true");
        assertEqual(settings.intervalMs, 300000, "default intervalMs should be 300000");
      },
    },
    {
      name: "AutoRecover: change and read back",
      description: "Changing auto-recover settings persists correctly.",
      async run(ctx) {
        // Change settings
        const updated = await setAutoRecoverSettings(false, 60000);
        await ctx.settle();

        assertEqual(updated.enabled, false, "returned enabled should be false");
        assertEqual(updated.intervalMs, 60000, "returned intervalMs should be 60000");

        // Read back to confirm
        const readBack = await getAutoRecoverSettings();
        assertEqual(readBack.enabled, false, "readBack enabled should be false");
        assertEqual(readBack.intervalMs, 60000, "readBack intervalMs should be 60000");

        // Reset to defaults
        await setAutoRecoverSettings(true, 300000);
        await ctx.settle();
      },
    },

    // ======================================================================
    // 29. Display Toggles: Gridlines and Headings (Batch 7)
    // ======================================================================
    {
      name: "Display toggles: gridlines event infrastructure",
      description: "Emit DISPLAY_GRIDLINES_TOGGLED event and verify listener fires.",
      async run(ctx) {
        let received = false;
        const cleanup = onAppEvent(
          AppEvents.DISPLAY_GRIDLINES_TOGGLED,
          () => { received = true; }
        );

        // Emit gridlines off
        emitAppEvent(AppEvents.DISPLAY_GRIDLINES_TOGGLED, { displayGridlines: false });
        await ctx.settle();

        assertTrue(received, "listener should have been called for gridlines toggle off");

        // Reset: emit gridlines on
        received = false;
        emitAppEvent(AppEvents.DISPLAY_GRIDLINES_TOGGLED, { displayGridlines: true });
        await ctx.settle();

        assertTrue(received, "listener should have been called for gridlines toggle on");
        cleanup();
      },
    },
    {
      name: "Display toggles: headings event infrastructure",
      description: "Emit DISPLAY_HEADINGS_TOGGLED event and verify listener fires.",
      async run(ctx) {
        let received = false;
        const cleanup = onAppEvent(
          AppEvents.DISPLAY_HEADINGS_TOGGLED,
          () => { received = true; }
        );

        // Emit headings off
        emitAppEvent(AppEvents.DISPLAY_HEADINGS_TOGGLED, { displayHeadings: false });
        await ctx.settle();

        assertTrue(received, "listener should have been called for headings toggle off");

        // Reset: emit headings on
        emitAppEvent(AppEvents.DISPLAY_HEADINGS_TOGGLED, { displayHeadings: true });
        await ctx.settle();

        cleanup();
      },
    },

    // ======================================================================
    // 30. SUMX Functions (Batch 6)
    // ======================================================================
    {
      name: "SUMXMY2: sum of squared differences",
      description: "SUMXMY2({1,2,3},{4,5,6}) returns 27.",
      async run(ctx) {
        // Set up two columns of data
        await ctx.setCells([
          { row: A.row, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col, value: "2" },
          { row: A.row + 2, col: A.col, value: "3" },
          { row: A.row, col: A.col + 1, value: "4" },
          { row: A.row + 1, col: A.col + 1, value: "5" },
          { row: A.row + 2, col: A.col + 1, value: "6" },
          {
            row: A.row + 4,
            col: A.col,
            value: `=SUMXMY2(${A.ref(0, 0)}:${A.ref(2, 0)},${A.ref(0, 1)}:${A.ref(2, 1)})`,
          },
        ]);
        await ctx.settle();

        const cell = await ctx.getCell(A.row + 4, A.col);
        // (1-4)^2 + (2-5)^2 + (3-6)^2 = 9 + 9 + 9 = 27
        expectCellValue(cell, "27", A.ref(4, 0));
      },
    },

    // ======================================================================
    // 31. Zoom API (Batch 7)
    // ======================================================================
    {
      name: "Zoom API: get, set, and reset zoom level",
      description: "Set zoom to 150, verify, then reset to original.",
      async run(ctx) {
        const original = getZoom();

        setZoomLevel(150);
        await ctx.settle();

        const updated = getZoom();
        assertEqual(updated, 150, "zoom should be 150 after set");

        // Reset to original
        setZoomLevel(original);
        await ctx.settle();

        const restored = getZoom();
        assertEqual(restored, original, "zoom should be restored to original");
      },
    },

    // ======================================================================
    // 32. StatusBar API (Batch 7)
    // ======================================================================
    {
      name: "StatusBar API: set and clear without errors",
      description: "setStatusBarText and clearStatusBarText should not throw.",
      async run(ctx) {
        // Set status bar text
        setStatusBarText("test message");
        await ctx.settle();

        // Clear status bar text
        clearStatusBarText();
        await ctx.settle();

        // If we got here without throwing, the test passes
        assertTrue(true, "statusBar API should not throw");
      },
    },

    // ======================================================================
    // 33. Workbook Properties (Batch 8)
    // ======================================================================
    {
      name: "Workbook properties: get, set title, and reset",
      description: "Set workbook title, read back, verify, then reset.",
      async run(ctx) {
        const original = await getWorkbookProperties();
        await ctx.settle();

        // Set title
        const updated = await setWorkbookProperties({
          ...original,
          title: "Test Title",
        });
        await ctx.settle();

        assertEqual(updated.title, "Test Title", "title should be 'Test Title' after set");

        // Read back to confirm
        const readBack = await getWorkbookProperties();
        assertEqual(readBack.title, "Test Title", "readBack title should match");

        // Reset title to empty
        await setWorkbookProperties({
          ...readBack,
          title: "",
        });
        await ctx.settle();
      },
    },

    // ======================================================================
    // 34. Sheet Visibility (Batch 8)
    // ======================================================================
    {
      name: "Sheet visibility: hide and unhide with veryHidden",
      description: "Add sheet, hide as veryHidden, verify visibility, unhide, delete.",
      async run(ctx) {
        // Add a new sheet
        const added = await addSheet("VisibilityTest");
        await ctx.settle();

        const newIndex = added.sheets.findIndex(s => s.name === "VisibilityTest");
        assertTrue(newIndex >= 0, "new sheet should exist");

        // Hide with veryHidden
        const hidden = await hideSheet(newIndex, "veryHidden");
        await ctx.settle();

        const hiddenSheet = hidden.sheets.find(s => s.name === "VisibilityTest");
        expectNotNull(hiddenSheet, "hidden sheet should still exist in list");
        assertEqual(hiddenSheet!.visibility, "veryHidden", "visibility should be veryHidden");

        // Unhide
        const unhidden = await unhideSheet(newIndex);
        await ctx.settle();

        const unhiddenSheet = unhidden.sheets.find(s => s.name === "VisibilityTest");
        expectNotNull(unhiddenSheet, "unhidden sheet should exist");
        assertEqual(unhiddenSheet!.visibility, "visible", "visibility should be visible after unhide");

        // Clean up: delete the sheet
        await deleteSheet(newIndex);
        await ctx.settle();
      },
    },

    // ======================================================================
    // 35. Next/Previous Sheet (Batch 8)
    // ======================================================================
    {
      name: "Next/Previous sheet: navigate between sheets",
      description: "Add 2 sheets, navigate with nextSheet/previousSheet, verify active changes.",
      async run(ctx) {
        // Add 2 extra sheets
        await addSheet("NavTest1");
        const added2 = await addSheet("NavTest2");
        await ctx.settle();

        // Navigate with nextSheet
        const afterNext = await nextSheet();
        await ctx.settle();
        assertTrue(
          afterNext.activeIndex !== added2.activeIndex,
          "active sheet should change after nextSheet"
        );

        // Navigate with previousSheet
        const afterPrev = await previousSheet();
        await ctx.settle();
        assertTrue(
          afterPrev.activeIndex !== afterNext.activeIndex,
          "active sheet should change after previousSheet"
        );

        // Clean up: find and delete the added sheets
        const sheetsNow = await getSheets();
        const idx1 = sheetsNow.sheets.findIndex(s => s.name === "NavTest2");
        if (idx1 >= 0) await deleteSheet(idx1);
        const sheetsAfter1 = await getSheets();
        const idx2 = sheetsAfter1.sheets.findIndex(s => s.name === "NavTest1");
        if (idx2 >= 0) await deleteSheet(idx2);
        await ctx.settle();
      },
    },

    // ======================================================================
    // 36. View Mode (Batch 8)
    // ======================================================================
    {
      name: "View mode: default is normal, change to pageBreakPreview and back",
      description: "Verify default view mode, change it, verify, and reset.",
      async run(ctx) {
        const defaultMode = getViewMode();
        assertEqual(defaultMode, "normal", "default view mode should be 'normal'");

        changeViewMode("pageBreakPreview");
        await ctx.settle();

        const changed = getViewMode();
        assertEqual(changed, "pageBreakPreview", "view mode should be 'pageBreakPreview'");

        // Reset to normal
        changeViewMode("normal");
        await ctx.settle();

        const reset = getViewMode();
        assertEqual(reset, "normal", "view mode should be 'normal' after reset");
      },
    },

    // ======================================================================
    // 37. R1C1 Reference Style (Batch 11)
    // ======================================================================
    {
      name: "R1C1 reference style: toggle and convert formula",
      description: "Verify default A1 style, switch to R1C1, convert formula, and reset.",
      async run(ctx) {
        // Verify default is A1
        const defaultStyle = await getReferenceStyle();
        assertEqual(defaultStyle, "A1", "default reference style should be A1");

        // Change to R1C1
        await changeReferenceStyle("R1C1");
        await ctx.settle();

        const changed = await getReferenceStyle();
        assertEqual(changed, "R1C1", "reference style should be R1C1 after change");

        // Convert formula from A1 to R1C1
        const converted = await convertFormulaStyle("=A1+B2", "A1", "R1C1", 0, 0);
        assertTrue(
          converted.includes("R") && converted.includes("C"),
          `converted formula should contain R and C, got: ${converted}`
        );

        // Reset to A1
        await changeReferenceStyle("A1");
        await ctx.settle();

        const reset = await getReferenceStyle();
        assertEqual(reset, "A1", "reference style should be A1 after reset");
      },
    },

    // ======================================================================
    // 38. ScrollArea (Batch 10)
    // ======================================================================
    {
      name: "ScrollArea: set, get, and clear",
      description: "Set scroll area to A1:Z100, read back, then clear with null.",
      async run(ctx) {
        // Set scroll area
        await setScrollArea("A1:Z100");
        await ctx.settle();

        const area = await getScrollArea();
        assertEqual(area, "A1:Z100", "scroll area should be A1:Z100");

        // Clear with null
        await setScrollArea(null);
        await ctx.settle();

        const cleared = await getScrollArea();
        assertTrue(cleared === null, "scroll area should be null after clearing");
      },
    },

    // ======================================================================
    // 39. CalculationState (Batch 10)
    // ======================================================================
    {
      name: "CalculationState: returns done",
      description: "getCalculationState should return 'done' when idle.",
      async run(ctx) {
        const state = await getCalculationState();
        assertEqual(state, "done", "calculation state should be 'done'");
      },
    },

    // ======================================================================
    // 40. Print/Calc Settings (Batch 9)
    // ======================================================================
    {
      name: "PrecisionAsDisplayed: default is false, toggle and reset",
      description: "Verify default, toggle to true, read back, reset.",
      async run(ctx) {
        // Reset to default first
        await setPrecisionAsDisplayed(false);
        await ctx.settle();

        const defaultVal = await getPrecisionAsDisplayed();
        assertEqual(defaultVal, false, "default precisionAsDisplayed should be false");

        // Toggle to true
        const toggled = await setPrecisionAsDisplayed(true);
        await ctx.settle();
        assertEqual(toggled, true, "precisionAsDisplayed should be true after toggle");

        // Read back
        const readBack = await getPrecisionAsDisplayed();
        assertEqual(readBack, true, "readBack precisionAsDisplayed should be true");

        // Reset
        await setPrecisionAsDisplayed(false);
        await ctx.settle();
      },
    },
    {
      name: "CalculateBeforeSave: default is true, toggle and reset",
      description: "Verify default, toggle to false, read back, reset.",
      async run(ctx) {
        // Reset to default first
        await setCalculateBeforeSave(true);
        await ctx.settle();

        const defaultVal = await getCalculateBeforeSave();
        assertEqual(defaultVal, true, "default calculateBeforeSave should be true");

        // Toggle to false
        const toggled = await setCalculateBeforeSave(false);
        await ctx.settle();
        assertEqual(toggled, false, "calculateBeforeSave should be false after toggle");

        // Read back
        const readBack = await getCalculateBeforeSave();
        assertEqual(readBack, false, "readBack calculateBeforeSave should be false");

        // Reset
        await setCalculateBeforeSave(true);
        await ctx.settle();
      },
    },
  ],
};
