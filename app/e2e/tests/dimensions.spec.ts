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
  // the Tauri API. A leaked 300px column would otherwise show up in the goldens
  // of every subsequent screenshot-bearing spec.
  //
  // The restore values are READ FROM THE BACKEND, never hardcoded. They used to
  // be literal 100.0 / 24.0 labelled "back to defaults" — values that stopped
  // being the defaults when they moved to 20.0 / 64.29
  // (persistence::DEFAULT_ROW_HEIGHT_PX / DEFAULT_COLUMN_WIDTH_PX). That stale
  // pair wrote a real override on top of a clean grid, so goldens recorded after
  // this spec encoded 100px columns the app never actually defaults to.
  // CONTENT is cleared once, at the END of the file, not per test.
  //
  // Per test would be wrong twice over. The screenshots inside this describe are
  // taken BEFORE the hook runs, so an afterEach cannot help them; and two of these
  // tests legitimately read the grid the previous one left (row-height reuses A1),
  // so clearing between them would rewrite goldens that are not the problem.
  //
  // The problem is what escapes the FILE. `resetGrid` clears the used range but
  // specs downstream do not all call it, and this file left "This column should
  // be wider" in B1 for the rest of the run -- which is the string editing.spec.ts
  // read where it expected "EditMe" (open-decisions-2026-08.md sec 3a). The
  // widths were already restored per test; the text was not restored at all.
  test.afterAll(async ({ sharedPage }) => {
    await sharedPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      if (!tauri?.core?.invoke) return;
      await tauri.core
        .invoke("clear_range_with_options", {
          params: { startRow: 0, startCol: 0, endRow: 1, endCol: 2, applyTo: "All" },
        })
        .catch(() => {});
      window.dispatchEvent(new Event("grid:refresh"));
    });
  });
  test.afterEach(async ({ sharedPage }) => {
    await sharedPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const defaults = await tauri.core.invoke("get_default_dimensions");
      for (const col of [0, 1, 2]) {
        await tauri.core.invoke("set_column_width", {
          col,
          width: defaults.defaultColumnWidth,
        });
      }
      await tauri.core.invoke("set_row_height", {
        row: 0,
        height: defaults.defaultRowHeight,
      });
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
    await grid.navigateTo("A1");
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
    await grid.navigateTo("A1");
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
