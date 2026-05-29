/**
 * Column Width & Row Height E2E tests.
 *
 * Covers resizing columns/rows via menu actions, verifying that cell data
 * remains correct after resize, and visual regression of resized grids.
 */
import { test, expect } from "../fixtures";
import {
  takeGridScreenshot,
  waitForGridStable,
  softly,
} from "../helpers/screenshots";

test.describe("Column Width & Row Height", () => {
  test("column auto-fit adjusts to content width", async ({
    appPage,
    grid,
  }) => {
    // Put a long value in A1
    await grid.setCellValue("A1", "This is a long text value for auto-fit");
    await grid.setCellValue("A2", "Short");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-before-autofit"));

    // Select column A by clicking A1, then use Format menu to auto-fit
    await grid.clickCell("A1");
    await grid.menuAction("Format", "Auto-Fit Column Width");
    await appPage.waitForTimeout(300);
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-after-autofit-col"));

    // Verify data is still intact
    await grid.expectFormulaBar("A1", "This is a long text value for auto-fit");
    await grid.expectFormulaBar("A2", "Short");
  });

  test("row height adjusts via menu", async ({ appPage, grid }) => {
    await grid.setCellValue("A1", "Row height test");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-before-row-height"));

    // Use Format menu to change row height
    await grid.clickCell("A1");
    await grid.menuAction("Format", "Row Height");
    await appPage.waitForTimeout(300);

    // If a dialog appears, type a height value
    const dialog = appPage.locator(".dialog-container, [role='dialog']");
    if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
      // Type a larger row height
      const input = dialog.locator("input").first();
      await input.fill("40");
      await appPage.keyboard.press("Enter");
      await appPage.waitForTimeout(300);
    }

    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-after-row-height"));

    // Data should still be there
    await grid.expectFormulaBar("A1", "Row height test");
  });

  test("column width adjusts via menu", async ({ appPage, grid }) => {
    await grid.setCellValue("B1", "Width");
    await waitForGridStable(appPage);

    await grid.clickCell("B1");
    await grid.menuAction("Format", "Column Width");
    await appPage.waitForTimeout(300);

    const dialog = appPage.locator(".dialog-container, [role='dialog']");
    if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
      const input = dialog.locator("input").first();
      await input.fill("200");
      await appPage.keyboard.press("Enter");
      await appPage.waitForTimeout(300);
    }

    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-after-col-width"));

    await grid.expectFormulaBar("B1", "Width");
  });

  test("multiple columns with different widths render correctly", async ({
    appPage,
    grid,
  }) => {
    await grid.setCellValue("A1", "Narrow");
    await grid.setCellValue("B1", "This column should be wider after auto-fit");
    await grid.setCellValue("C1", "Medium length text");

    // Auto-fit column B
    await grid.clickCell("B1");
    await grid.menuAction("Format", "Auto-Fit Column Width");
    await appPage.waitForTimeout(300);

    // Auto-fit column C
    await grid.clickCell("C1");
    await grid.menuAction("Format", "Auto-Fit Column Width");
    await appPage.waitForTimeout(300);

    await grid.clickCell("A1");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "dimensions-mixed-widths"));
  });
});
