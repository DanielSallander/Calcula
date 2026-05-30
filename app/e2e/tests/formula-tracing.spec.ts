/**
 * Formula Tracing E2E tests.
 *
 * Tests trace_precedents and trace_dependents Tauri commands to verify
 * the formula dependency graph is correctly reported.
 * Uses cells in columns AG-AH, rows 1-10 to avoid conflicts with other tests.
 */
import { test, expect } from "../fixtures";
import { takeGridScreenshot, softly } from "../helpers/screenshots";

test.describe("Formula Tracing", () => {
  test("trace precedents of a formula cell", async ({ appPage, grid }) => {
    // Set up: AG1=10, AG2=20, AG3=SUM(AG1:AG2)
    await grid.setCellValueDirect("AG1", "10");
    await grid.setCellValueDirect("AG2", "20");
    await grid.setCellValueDirect("AG3", "=AG1+AG2");
    await grid.page.waitForTimeout(300);

    // Verify formula evaluates correctly
    const value = await grid.getCellFormulaBarText("AG3");
    expect(value).toBe("30");

    // Trace precedents of AG3 (row 2, col 32)
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("trace_precedents", { row: 2, col: 32 });
    });
    await grid.page.waitForTimeout(300);

    expect(result).toBeDefined();
    // AG3 depends on AG1 and AG2
    expect(result.cells || result.references).toBeDefined();
    const refs = result.cells || result.references || [];
    expect(refs.length).toBeGreaterThanOrEqual(2);

    await grid.navigateTo("AG1");
    await softly(takeGridScreenshot(appPage, "tracing-precedents"));
  });

  test("trace dependents of a source cell", async ({ grid }) => {
    // Ensure data from prior test exists (self-contained for sampler isolation)
    await grid.setCellValueDirect("AG1", "10");
    await grid.setCellValueDirect("AG2", "20");
    await grid.setCellValueDirect("AG3", "=AG1+AG2");
    await grid.page.waitForTimeout(300);

    // Trace dependents of AG1 (row 0, col 32)
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("trace_dependents", { row: 0, col: 32 });
    });
    await grid.page.waitForTimeout(300);

    expect(result).toBeDefined();
    // AG1 is used by AG3
    const refs = result.cells || result.references || [];
    expect(refs.length).toBeGreaterThanOrEqual(1);

    // At least one dependent should reference row 2 (AG3)
    const hasAG3 = refs.some((r: any) => r.row === 2);
    expect(hasAG3).toBe(true);
  });

  test("trace precedents of a cell with no formula returns empty", async ({ grid }) => {
    // AG5 is a plain constant
    await grid.setCellValueDirect("AG5", "42");
    await grid.page.waitForTimeout(200);

    // Trace precedents of a non-formula cell (row 4, col 32)
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("trace_precedents", { row: 4, col: 32 });
    });
    await grid.page.waitForTimeout(200);

    expect(result).toBeDefined();
    const refs = result.cells || result.references || [];
    expect(refs.length).toBe(0);
  });

  test("trace precedents with range references", async ({ appPage, grid }) => {
    // Set up: AH1=1, AH2=2, AH3=3, AH4=SUM(AH1:AH3)
    await grid.setCellValueDirect("AH1", "1");
    await grid.setCellValueDirect("AH2", "2");
    await grid.setCellValueDirect("AH3", "3");
    await grid.setCellValueDirect("AH4", "=SUM(AH1:AH3)");
    await grid.page.waitForTimeout(300);

    // Verify SUM result
    const value = await grid.getCellFormulaBarText("AH4");
    expect(value).toBe("6");

    // Trace precedents of AH4 (row 3, col 33)
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("trace_precedents", { row: 3, col: 33 });
    });
    await grid.page.waitForTimeout(300);

    expect(result).toBeDefined();
    // Should reference AH1:AH3 (either as individual cells or a range)
    const refs = result.cells || result.references || [];
    expect(refs.length).toBeGreaterThanOrEqual(1);

    await grid.navigateTo("AH1");
    await softly(takeGridScreenshot(appPage, "tracing-range-precedents"));
  });
});
