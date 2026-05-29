/**
 * Visual regression tests for core grid features.
 *
 * These tests take screenshots at defined checkpoints and compare them
 * against golden baselines. On first run, baselines are created automatically.
 * On subsequent runs, pixel differences are detected and flagged.
 *
 * Update baselines: yarn playwright test --update-snapshots e2e/visual/
 */
import { test, expect } from "../fixtures";
import {
  resetToNewWorkbook,
  takeCheckpoint,
  takeGridScreenshot,
  takeRibbonScreenshot,
  takeStatusBarScreenshot,
} from "../helpers/screenshots";

test.describe("Core Visual Regression", () => {
  test("empty grid - default state", async ({ appPage }) => {
    // Reset to a clean workbook — prior functional tests leave data behind
    await resetToNewWorkbook(appPage);
    // Navigate to A1 to ensure consistent starting position
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(500);

    await takeCheckpoint(appPage, "core-empty-grid");
    await takeGridScreenshot(appPage, "core-empty-canvas");
    await takeRibbonScreenshot(appPage, "core-default-ribbon");
    await takeStatusBarScreenshot(appPage, "core-default-statusbar");
  });

  test("grid with data - basic cell content", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // Enter some sample data
    await grid.setCellValue("A1", "Name");
    await grid.setCellValue("B1", "Value");
    await grid.setCellValue("C1", "Total");
    await grid.setCellValue("A2", "Alpha");
    await grid.setCellValue("B2", "100");
    await grid.setCellValue("C2", "=B2*2");
    await grid.setCellValue("A3", "Beta");
    await grid.setCellValue("B3", "200");
    await grid.setCellValue("C3", "=B3*2");
    await grid.setCellValue("A4", "Gamma");
    await grid.setCellValue("B4", "300");
    await grid.setCellValue("C4", "=SUM(B2:B4)");

    // Click A1 to deselect editing state
    await grid.clickCell("A1");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "core-data-entry");
  });

  test("cell selection highlight", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // Single cell selection
    await grid.clickCell("C3");
    await appPage.waitForTimeout(300);
    await takeGridScreenshot(appPage, "core-selection-single");

    // Range selection
    await grid.selectRange("A1", "C4");
    await appPage.waitForTimeout(300);
    await takeGridScreenshot(appPage, "core-selection-range");
  });

  test("formula bar shows formula", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.setCellValue("A1", "10");
    await grid.setCellValue("A2", "=A1+5");

    // Click the formula cell to show formula in bar
    await grid.clickCell("A2");
    await appPage.waitForTimeout(500);

    await takeCheckpoint(appPage, "core-formula-bar-display");
  });

  test("editing mode - inline editor visible", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.setCellValue("A1", "Hello World");
    await grid.clickCell("A1");
    // Enter edit mode
    await appPage.keyboard.press("F2");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "core-editing-mode");

    // Exit edit mode
    await appPage.keyboard.press("Escape");
  });
});

test.describe("Formatting Visual Regression", () => {
  test("bold/italic/underline rendering", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.setCellValue("A1", "Normal");
    await grid.setCellValue("A2", "Bold");
    await grid.setCellValue("A3", "Italic");
    await grid.setCellValue("A4", "Underline");

    // Apply bold to A2
    await grid.clickCell("A2");
    await grid.toggleBold();

    // Apply italic to A3
    await grid.clickCell("A3");
    await grid.toggleItalic();

    // Apply underline to A4
    await grid.clickCell("A4");
    await grid.toggleUnderline();

    // Deselect to see clean rendering
    await grid.clickCell("B1");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "fmt-bold-italic-underline");
  });

  test("number format rendering", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.setCellValue("A1", "Format");
    await grid.setCellValue("B1", "Value");
    await grid.setCellValue("A2", "Number");
    await grid.setCellValueDirect("B2", "1234.5678");
    await grid.setCellValue("A3", "Percent");
    await grid.setCellValueDirect("B3", "0.75");
    await grid.setCellValue("A4", "Date");
    await grid.setCellValueDirect("B4", "45000");
    await grid.setCellValue("A5", "Negative");
    await grid.setCellValueDirect("B5", "-500");

    await grid.clickCell("A1");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "fmt-number-formats");
  });

  test("alignment rendering", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.setCellValue("A1", "Left");
    await grid.setCellValue("B1", "Center");
    await grid.setCellValue("C1", "Right");

    // Apply center to B1
    await grid.clickCell("B1");
    const centerBtn = appPage.locator("[data-testid='fmt-alignCenter']");
    if (await centerBtn.count() > 0) {
      await centerBtn.click();
      await appPage.waitForTimeout(300);
    }

    // Apply right to C1
    await grid.clickCell("C1");
    const rightBtn = appPage.locator("[data-testid='fmt-alignRight']");
    if (await rightBtn.count() > 0) {
      await rightBtn.click();
      await appPage.waitForTimeout(300);
    }

    await grid.clickCell("D1");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "fmt-alignment");
  });
});

test.describe("Sheet Tab Visual Regression", () => {
  test("sheet tabs - default state", async ({ appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // Screenshot the bottom of the page where sheet tabs live
    await takeCheckpoint(appPage, "sheets-default-tabs");
  });
});

test.describe("Menu Visual Regression", () => {
  test("file menu open visual", async ({ grid, appPage }) => {
    await resetToNewWorkbook(appPage);
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.openMenu("File");
    await appPage.waitForTimeout(500);

    await takeCheckpoint(appPage, "menu-file-open");

    await grid.closeMenu();
  });

  test("edit menu open", async ({ grid, appPage }) => {
    await resetToNewWorkbook(appPage);
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.openMenu("Edit");
    await appPage.waitForTimeout(500);

    await takeCheckpoint(appPage, "menu-edit-open");

    await grid.closeMenu();
  });

  test("data menu open visual", async ({ grid, appPage }) => {
    await resetToNewWorkbook(appPage);
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.openMenu("Data");
    await appPage.waitForTimeout(500);

    await takeCheckpoint(appPage, "menu-data-open");

    await grid.closeMenu();
  });
});
