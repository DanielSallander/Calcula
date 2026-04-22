//! FILENAME: app/extensions/TestRunner/lib/suites/excelGapFeatures.ts
// PURPOSE: Tests for Excel gap features (PRODUCT, database functions, UsedRange,
//          DisplayZeros, MoveAfterReturn, hyperlinks follow, dirty state,
//          underline variants, cell change event, navigateToCell, locked/formulaHidden,
//          CF formula thresholds).
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
} from "@api/backend";
import { applyFormatting, getStyle } from "@api/lib";
import { navigateToCell, AppEvents, onAppEvent, emitAppEvent } from "@api";
import type { CellValuesChangedPayload } from "@api";
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
    "Tests PRODUCT, database functions, UsedRange, DisplayZeros, MoveAfterReturn, hyperlinks, dirty state, underline variants, cell change event, navigateToCell, locked/formulaHidden, and CF formula thresholds.",

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
  ],
};
