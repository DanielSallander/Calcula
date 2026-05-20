/**
 * Cell editing E2E tests.
 *
 * Covers the editing lifecycle: activate, type, commit (Enter/Tab),
 * cancel (Escape), overwrite, clear (Delete), and undo/redo.
 */
import { test, expect } from "../fixtures";

test.describe("Basic cell editing", () => {
  test("type a number and commit with Enter", async ({ grid }) => {
    await grid.clickCell("A1");
    await grid.typeIntoCell("123");

    await grid.expectFormulaBar("A1", "123");
  });

  test("type text and commit with Enter", async ({ grid }) => {
    await grid.setCellValue("A2", "Hello");
    await grid.expectFormulaBar("A2", "Hello");
  });

  test("type and commit with Tab moves to next column", async ({ grid }) => {
    await grid.clickCell("A3");
    await grid.page.keyboard.type("TabTest", { delay: 20 });
    await grid.page.keyboard.press("Tab");
    await grid.page.waitForTimeout(200);

    // Active cell should now be B3
    const nameBox = await grid.getNameBoxValue();
    expect(nameBox).toBe("B3");

    // A3 should have the value
    await grid.expectFormulaBar("A3", "TabTest");
  });

  test("Escape cancels editing and reverts", async ({ grid }) => {
    await grid.setCellValue("A4", "Original");

    // Start editing, type something new, then Escape
    await grid.doubleClickCell("A4");
    await grid.page.keyboard.press("Control+a");
    await grid.page.keyboard.type("Changed", { delay: 20 });
    await grid.page.keyboard.press("Escape");
    await grid.page.waitForTimeout(200);

    // Should still show "Original"
    await grid.expectFormulaBar("A4", "Original");
  });

  test("overwrite a cell value", async ({ grid }) => {
    await grid.setCellValue("A5", "First");
    await grid.setCellValue("A5", "Second");

    await grid.expectFormulaBar("A5", "Second");
  });

  test("Delete key clears cell contents", async ({ grid }) => {
    await grid.setCellValue("A6", "ToDelete");
    await grid.clickCell("A6");
    await grid.delete();

    const text = await grid.getCellFormulaBarText("A6");
    expect(text).toBe("");
  });
});

test.describe("Edit mode entry methods", () => {
  test("F2 enters edit mode on selected cell", async ({ grid }) => {
    await grid.setCellValue("B1", "EditMe");
    await grid.clickCell("B1");
    await grid.page.keyboard.press("F2");
    await grid.page.waitForTimeout(200);

    // Formula bar should show the value in edit mode
    const text = await grid.getFormulaBarValue();
    expect(text).toBe("EditMe");

    await grid.page.keyboard.press("Escape");
  });

  test.fixme("double-click enters edit mode", async ({ grid }) => {
    await grid.setCellValue("B2", "DblClick");
    // Navigate away to ensure B2 is not in edit mode
    await grid.clickCell("B4");
    await grid.page.waitForTimeout(500);

    // Double-click B2 to enter edit mode
    await grid.doubleClickCell("B2");
    await grid.page.waitForTimeout(500);

    const text = await grid.getFormulaBarValue();
    expect(text).toBe("DblClick");

    await grid.page.keyboard.press("Escape");
    await grid.page.waitForTimeout(200);
  });

  test.fixme("typing directly on selected cell starts editing", async ({ grid }) => {
    await grid.clickCell("B3");
    await grid.page.keyboard.type("DirectType", { delay: 20 });
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(200);

    await grid.expectFormulaBar("B3", "DirectType");
  });
});

test.describe("Undo and Redo", () => {
  // FIXME: Ctrl+Z via CDP does not reach the grid's onKeyDown handler.
  // WebView2 may intercept it before it reaches the app. Needs investigation
  // outside of Playwright — works fine when tested manually.
  test.fixme("undo reverts the last cell edit", async ({ grid }) => {
    await grid.setCellValue("C1", "Before");
    await grid.setCellValue("C1", "After");

    await grid.undo();
    await grid.expectFormulaBar("C1", "Before");
  });

  test.fixme("redo re-applies the undone edit", async ({ grid }) => {
    await grid.setCellValue("C2", "Step1");
    await grid.setCellValue("C2", "Step2");

    await grid.undo();
    await grid.expectFormulaBar("C2", "Step1");

    await grid.redo();
    await grid.expectFormulaBar("C2", "Step2");
  });

  test.fixme("undo a Delete operation", async ({ grid }) => {
    await grid.setCellValue("C3", "Preserved");
    await grid.clickCell("C3");
    await grid.delete();

    // Cell should be empty
    const empty = await grid.getCellFormulaBarText("C3");
    expect(empty).toBe("");

    // Undo should restore
    await grid.undo();
    await grid.expectFormulaBar("C3", "Preserved");
  });
});

test.describe("Data types", () => {
  test("integer input", async ({ grid }) => {
    await grid.setCellValue("D1", "42");
    const text = await grid.getCellFormulaBarText("D1");
    expect(text).toBe("42");
  });

  test("decimal input", async ({ grid }) => {
    await grid.setCellValue("D2", "3.14");
    const text = await grid.getCellFormulaBarText("D2");
    // Accept both "3.14" (dot locale) and "3,14" (comma locale)
    expect(text.replace(",", ".")).toContain("3.14");
  });

  test("negative number input", async ({ grid }) => {
    await grid.setCellValue("D3", "-100");
    const text = await grid.getCellFormulaBarText("D3");
    expect(text).toContain("-100");
  });

  test("boolean TRUE", async ({ grid }) => {
    await grid.setCellValue("D4", "TRUE");
    const text = await grid.getCellFormulaBarText("D4");
    expect(text.toUpperCase()).toContain("TRUE");
  });

  test("long text input", async ({ grid }) => {
    const longText = "A".repeat(200);
    await grid.setCellValue("D5", longText);
    const text = await grid.getCellFormulaBarText("D5");
    expect(text).toBe(longText);
  });
});
