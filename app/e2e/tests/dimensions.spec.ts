/**
 * Column Width & Row Height E2E tests.
 *
 * Covers resizing columns/rows via Tauri API, verifying that cell data
 * remains correct after resize, and visual regression of resized grids.
 *
 * NOTE: Column Width / Row Height are not available as top-level Format menu
 * items. They are context-menu items or Tauri API calls. Tests use the Tauri
 * API directly to set dimensions.
 */
import { test, expect } from "../fixtures";
import {
  takeGridScreenshot,
  waitForGridStable,
  resetToNewWorkbook,
  softly,
} from "../helpers/screenshots";

test.describe("Column Width & Row Height", () => {
  // These tests mutate global grid geometry (column widths / row heights) via
  // the Tauri API. The GridHelper computes click coordinates from the DEFAULT
  // geometry (100px columns, 24px rows), so any leaked resize would make
  // clickCell() target the wrong cell in every subsequent test file.
  // Reset the columns/rows touched here back to defaults after each test —
  // mirrors the cleanup already done in column-row-ops.spec.ts.
  test.afterEach(async ({ sharedPage }) => {
    await sharedPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      for (const col of [0, 1, 2]) {
        await tauri.core.invoke("set_column_width", { col, width: 100.0 });
      }
      await tauri.core.invoke("set_row_height", { row: 0, height: 24.0 });
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
      window.dispatchEvent(new Event("grid:refresh"));
    });
  });

  test("column width can be set via API and data remains intact", async ({
    appPage,
    grid,
  }) => {
    // Start from a clean grid so data from prior test files doesn't leak
    // into the screenshot comparison.
    await resetToNewWorkbook(appPage);
    // Put data in cells
    await grid.setCellValue("A1", "This is a long text value for width test");
    await grid.setCellValue("A2", "Short");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-before-width"));

    // Set column A width via Tauri API
    await appPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_column_width", { col: 0, width: 300 });
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    });
    await appPage.waitForTimeout(300);
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-after-set-col-width"));

    // Verify data is still intact
    await grid.expectFormulaBar("A1", "This is a long text value for width test");
    await grid.expectFormulaBar("A2", "Short");
  });

  test("row height can be set via API", async ({ appPage, grid }) => {
    await grid.setCellValue("A1", "Row height test");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-before-row-height"));

    // Set row 0 height via Tauri API
    await appPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_row_height", { row: 0, height: 40 });
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    });
    await appPage.waitForTimeout(300);
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-after-row-height"));

    // Data should still be there
    await grid.expectFormulaBar("A1", "Row height test");
  });

  test("column width adjusts via API", async ({ appPage, grid }) => {
    // This test's screenshot compares against a golden baseline, so it must
    // start from a clean grid — data leaked from earlier test files would
    // otherwise appear in the capture and make the comparison flaky.
    await resetToNewWorkbook(appPage);
    await grid.setCellValue("B1", "Width");
    await waitForGridStable(appPage);

    // Set column B (col=1) width via Tauri API
    await appPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_column_width", { col: 1, width: 200 });
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    });
    await appPage.waitForTimeout(300);
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-after-col-width"));

    await grid.expectFormulaBar("B1", "Width");
  });

  test("multiple columns with different widths render correctly", async ({
    appPage,
    grid,
  }) => {
    await grid.setCellValue("A1", "Narrow");
    await grid.setCellValue("B1", "This column should be wider");
    await grid.setCellValue("C1", "Medium length text");

    // Set different widths for columns B and C via Tauri API
    await appPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_column_width", { col: 1, width: 250 });
      await tauri.core.invoke("set_column_width", { col: 2, width: 180 });
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    });
    await appPage.waitForTimeout(300);

    await grid.clickCell("A1");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-mixed-widths"));
  });
});
