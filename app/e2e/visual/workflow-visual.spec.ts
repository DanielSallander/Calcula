/**
 * Visual regression tests for cross-cutting user workflows.
 *
 * Each test simulates a real user scenario that exercises multiple features
 * together, taking screenshots at key checkpoints. This catches regressions
 * in feature interactions that isolated tests miss.
 */
import { test, expect } from "../fixtures";
import {
  takeCheckpoint,
  takeGridScreenshot,
  takeDialogScreenshot,
} from "../helpers/screenshots";

test.describe("Workflow: Data Entry & Formatting", () => {
  test("build a formatted data table", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // Step 1: Enter headers
    await grid.setCellValue("A1", "Product");
    await grid.setCellValue("B1", "Q1");
    await grid.setCellValue("C1", "Q2");
    await grid.setCellValue("D1", "Total");

    // Step 2: Bold the headers
    await grid.selectRange("A1", "D1");
    await grid.toggleBold();

    await takeGridScreenshot(appPage, "workflow-table-headers-bold");

    // Step 3: Enter data
    await grid.setCellValue("A2", "Widget A");
    await grid.setCellValue("B2", "1500");
    await grid.setCellValue("C2", "2300");
    await grid.setCellValue("D2", "=B2+C2");
    await grid.setCellValue("A3", "Widget B");
    await grid.setCellValue("B3", "800");
    await grid.setCellValue("C3", "1200");
    await grid.setCellValue("D3", "=B3+C3");
    await grid.setCellValue("A4", "Widget C");
    await grid.setCellValue("B4", "3200");
    await grid.setCellValue("C4", "950");
    await grid.setCellValue("D4", "=B4+C4");

    // Step 4: Add totals row
    await grid.setCellValue("A5", "Total");
    await grid.setCellValue("B5", "=SUM(B2:B4)");
    await grid.setCellValue("C5", "=SUM(C2:C4)");
    await grid.setCellValue("D5", "=SUM(D2:D4)");

    // Bold the totals row
    await grid.selectRange("A5", "D5");
    await grid.toggleBold();

    // Deselect
    await grid.clickCell("F1");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "workflow-table-complete");
  });
});

test.describe("Workflow: Formula Chain", () => {
  test("dependent formulas update correctly", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // Build a formula chain: A1 -> B1 -> C1 -> D1
    await grid.setCellValue("A1", "10");
    await grid.setCellValue("B1", "=A1*2");
    await grid.setCellValue("C1", "=B1+5");
    await grid.setCellValue("D1", "=C1^2");

    await grid.clickCell("A1");
    await appPage.waitForTimeout(500);
    await takeGridScreenshot(appPage, "workflow-formula-chain-initial");

    // Change the source value via keyboard (triggers full recalc pipeline)
    await grid.setCellValue("A1", "20");
    await appPage.waitForTimeout(1000);

    await grid.clickCell("D1");
    await appPage.waitForTimeout(500);
    await takeGridScreenshot(appPage, "workflow-formula-chain-updated");

    // Verify D1 = (20*2+5)^2 = 45^2 = 2025
    // Read the computed value by invoking get_viewport_cells which returns
    // freshly recalculated display values, unlike get_cell's cached display.
    const value = await appPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const cells = await tauri.core.invoke("get_viewport_cells", {
        startRow: 0, endRow: 1, startCol: 3, endCol: 4,
      });
      return cells?.[0]?.display ?? "";
    });
    expect(value).toBe("2025");
  });
});

test.describe("Workflow: Undo/Redo Chain", () => {
  test("undo restores previous visual state", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // Step 1: Enter data
    await grid.setCellValue("A1", "Before");
    await grid.clickCell("B1");
    await appPage.waitForTimeout(300);
    await takeGridScreenshot(appPage, "workflow-undo-step1");

    // Step 2: Overwrite with new data
    await grid.setCellValue("A1", "After");
    await grid.clickCell("B1");
    await appPage.waitForTimeout(300);
    await takeGridScreenshot(appPage, "workflow-undo-step2");

    // Step 3: Undo should restore "Before"
    await grid.undo();
    await grid.clickCell("B1");
    await appPage.waitForTimeout(300);
    await takeGridScreenshot(appPage, "workflow-undo-step3-restored");

    // Step 4: Redo should restore "After"
    await grid.redo();
    await grid.clickCell("B1");
    await appPage.waitForTimeout(300);
    await takeGridScreenshot(appPage, "workflow-undo-step4-redone");
  });
});

test.describe("Workflow: Multi-Sheet", () => {
  test("data entry across sheets", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // Enter data on first sheet
    await grid.setCellValue("A1", "Sheet1 Data");
    await grid.setCellValue("A2", "100");

    await takeCheckpoint(appPage, "workflow-multisheet-sheet1");

    // Note: Creating new sheets and cross-sheet formulas would require
    // more specific UI interaction helpers. This is a placeholder for
    // when sheet creation E2E helpers are available.
  });
});

test.describe("Workflow: Copy-Paste Roundtrip", () => {
  test("copy formatted cells and paste", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // Enter and format source data
    await grid.setCellValue("A1", "Source");
    await grid.clickCell("A1");
    await grid.toggleBold();

    await grid.setCellValue("A2", "123");
    await grid.setCellValue("A3", "456");

    // Copy range A1:A3
    await grid.selectRange("A1", "A3");
    await grid.copy();

    // Paste to C1
    await grid.clickCell("C1");
    await grid.paste();
    await appPage.waitForTimeout(500);

    // Deselect
    await grid.clickCell("E1");
    await appPage.waitForTimeout(300);

    await takeGridScreenshot(appPage, "workflow-copy-paste-result");
  });
});

test.describe("Workflow: Keyboard-Only Data Entry", () => {
  test("enter data using only keyboard", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // Type in A1, Enter moves to A2, etc.
    await grid.typeAndEnter("Name");
    await grid.typeAndEnter("Alice");
    await grid.typeAndEnter("Bob");
    await grid.typeAndEnter("Charlie");

    // Navigate to B1 via Ctrl+Home then Right
    await appPage.keyboard.press("Control+Home");
    await grid.pressArrow("ArrowRight");

    await grid.typeAndEnter("Score");
    await grid.typeAndEnter("85");
    await grid.typeAndEnter("92");
    await grid.typeAndEnter("78");

    // Click away
    await grid.clickCell("D1");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "workflow-keyboard-entry");
  });
});
