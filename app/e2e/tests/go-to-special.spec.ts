/**
 * Go To Special E2E tests.
 *
 * Tests the go_to_special Tauri command for finding cells by type.
 * Uses cells in columns AC-AD, rows 1-15 to avoid conflicts with other tests.
 */
import { test, expect } from "../fixtures";
import {
  takeGridScreenshot,
  softly,
} from "../helpers/screenshots";

test.describe("Go To Special", () => {
  test("find blank cells in a range", async ({ appPage, grid }) => {
    // Set up data with some blanks: AC1=1, AC2=(blank), AC3=3, AC4=(blank), AC5=5
    await grid.setCellValueDirect("AC1", "1");
    await grid.setCellValueDirect("AC3", "3");
    await grid.setCellValueDirect("AC5", "5");
    await grid.page.waitForTimeout(200);

    // Use go_to_special to find blank cells in range AC1:AC5 (0-based: row 0-4, col 28)
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("go_to_special", {
        criteria: "blanks",
        searchRange: [0, 28, 4, 28],
      });
    });
    await grid.page.waitForTimeout(300);

    expect(result.cells).toBeDefined();
    expect(result.cells.length).toBe(2);

    // Should find AC2 (row 1) and AC4 (row 3)
    const rows = result.cells.map((c: any) => c.row).sort();
    expect(rows).toEqual([1, 3]);

    await grid.navigateTo("AC1");
    await softly(takeGridScreenshot(appPage, "go-to-special-blanks"));
  });

  test("find cells with constants", async ({ grid }) => {
    // Set up: AD1=100, AD2="text", AD3=formula, AD4=200
    await grid.setCellValueDirect("AD1", "100");
    await grid.setCellValueDirect("AD2", "text");
    await grid.setCellValueDirect("AD3", "=1+1");
    await grid.setCellValueDirect("AD4", "200");
    await grid.page.waitForTimeout(200);

    // Find constants (non-formula values) in range AD1:AD4 (0-based: row 0-3, col 29)
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("go_to_special", {
        criteria: "constants",
        searchRange: [0, 29, 3, 29],
      });
    });
    await grid.page.waitForTimeout(300);

    expect(result.cells).toBeDefined();
    // AD1 (100), AD2 (text), AD4 (200) are constants; AD3 is a formula
    expect(result.cells.length).toBe(3);

    const rows = result.cells.map((c: any) => c.row).sort();
    expect(rows).toEqual([0, 1, 3]);
  });

  test("find cells with formulas", async ({ grid }) => {
    // Set up: AD6=10, AD7="=AD6*2", AD8=30, AD9="=AD6+AD8"
    await grid.setCellValueDirect("AD6", "10");
    await grid.setCellValueDirect("AD7", "=AD6*2");
    await grid.setCellValueDirect("AD8", "30");
    await grid.setCellValueDirect("AD9", "=AD6+AD8");
    await grid.page.waitForTimeout(300);

    // Find formulas in range AD6:AD9 (0-based: row 5-8, col 29)
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("go_to_special", {
        criteria: "formulas",
        searchRange: [5, 29, 8, 29],
      });
    });
    await grid.page.waitForTimeout(300);

    expect(result.cells).toBeDefined();
    // AD7 and AD9 are formulas
    expect(result.cells.length).toBe(2);

    const rows = result.cells.map((c: any) => c.row).sort();
    expect(rows).toEqual([6, 8]);
  });

  test("search entire sheet when no range specified", async ({
    appPage,
    grid,
  }) => {
    // Set up at least two formulas so the test is self-contained and does not
    // rely on data left behind by prior tests (the regression sampler may run
    // this test in isolation).
    await grid.setCellValueDirect("AD7", "=AD6*2");
    await grid.setCellValueDirect("AD9", "=AD6+AD8");
    await grid.page.waitForTimeout(200);

    // Search for formulas across the whole sheet (null searchRange).
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("go_to_special", {
        criteria: "formulas",
        searchRange: null,
      });
    });
    await grid.page.waitForTimeout(300);

    expect(result.cells).toBeDefined();
    // Should find at least the formulas we set up in prior tests
    expect(result.cells.length).toBeGreaterThanOrEqual(2);

    await grid.navigateTo("A1");
    await softly(takeGridScreenshot(appPage, "go-to-special-formulas-sheet"));
  });
});
