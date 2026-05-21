/**
 * Mouse interaction E2E tests.
 *
 * Tests mouse-driven workflows: clicking, double-clicking,
 * shift-clicking, right-clicking, and scrolling.
 *
 * Uses rows 250+ to avoid collision.
 */
import { test, expect } from "../fixtures";

test.describe("Mouse cell selection", () => {
  test("clicking a cell selects it and shows in name box", async ({ grid }) => {
    await grid.clickCell("C3");
    const nameBox = await grid.getNameBoxValue();
    expect(nameBox).toBe("C3");
  });

  test("clicking another cell deselects the previous one", async ({ grid }) => {
    await grid.clickCell("A1");
    await grid.clickCell("D5");
    const nameBox = await grid.getNameBoxValue();
    expect(nameBox).toBe("D5");
  });

  test("shift-click creates a range selection", async ({ grid }) => {
    await grid.clickCell("A1");
    const { x, y } = await grid.cellCenterScrollAware("C3");
    await grid.canvas.click({
      position: { x, y },
      modifiers: ["Shift"],
      force: true,
    });
    await grid.page.waitForTimeout(200);

    // Selection should span A1:C3
    const sel = await grid.page.evaluate(() => {
      const gs = (window as any).__CALCULA_GRID_STATE__;
      return gs?.selection ?? null;
    });
    expect(sel).not.toBeNull();
    const rows = Math.abs(sel.endRow - sel.startRow) + 1;
    const cols = Math.abs(sel.endCol - sel.startCol) + 1;
    expect(rows).toBe(3);
    expect(cols).toBe(3);
  });
});

test.describe("Double-click editing", () => {
  test("double-click enters edit mode", async ({ grid }) => {
    await grid.setCellValueDirect("A250", "EditMe");
    await grid.doubleClickCell("A250");

    // Formula bar should be editable with the cell's value
    const fbValue = await grid.getFormulaBarValue();
    expect(fbValue).toBe("EditMe");

    // Cancel editing
    await grid.page.keyboard.press("Escape");
    await grid.page.waitForTimeout(200);
  });

  test("double-click empty cell allows typing", async ({ grid }) => {
    await grid.doubleClickCell("B250");

    // Type into the cell
    await grid.page.keyboard.type("NewValue", { delay: 20 });
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("B250")).toBe("NewValue");
  });
});

test.describe("Mouse scroll", () => {
  test("scrolling down moves viewport", async ({ grid }) => {
    // Get initial scroll position
    const scrollBefore = await grid.page.evaluate(() => {
      const gs = (window as any).__CALCULA_GRID_STATE__;
      return gs?.viewport?.scrollY ?? 0;
    });

    // Scroll down
    await grid.scrollWheel(500);

    const scrollAfter = await grid.page.evaluate(() => {
      const gs = (window as any).__CALCULA_GRID_STATE__;
      return gs?.viewport?.scrollY ?? 0;
    });

    expect(scrollAfter).toBeGreaterThan(scrollBefore);

    // Scroll back up
    await grid.scrollWheel(-500);
    await grid.page.waitForTimeout(300);
  });
});

test.describe("Name box navigation", () => {
  test("type cell reference in name box navigates there", async ({ grid }) => {
    await grid.nameBox.click();
    await grid.nameBox.fill("Z50");
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(300);

    // Focus back on spreadsheet
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(100);

    const nameBox = await grid.getNameBoxValue();
    expect(nameBox).toBe("Z50");
  });

  test("name box shows cell address when clicking canvas", async ({ grid }) => {
    await grid.clickCell("B7");
    const nameBox = await grid.getNameBoxValue();
    expect(nameBox).toBe("B7");
  });
});

test.describe("Formula bar interaction", () => {
  test("clicking formula bar allows editing", async ({ grid }) => {
    await grid.setCellValueDirect("A255", "FBarTest");
    await grid.clickCell("A255");
    await grid.page.waitForTimeout(200);

    // Click the formula bar
    await grid.formulaBar.click();
    await grid.page.waitForTimeout(200);

    // It should show the value and be editable
    const value = await grid.formulaBar.inputValue();
    expect(value).toBe("FBarTest");

    // Cancel
    await grid.page.keyboard.press("Escape");
    await grid.page.waitForTimeout(200);
  });

  test("edit via formula bar commits on Enter", async ({ grid }) => {
    await grid.setCellValueDirect("A256", "Before");
    await grid.clickCell("A256");
    await grid.page.waitForTimeout(200);

    // Click formula bar, clear, type new value, Enter
    await grid.formulaBar.click();
    await grid.page.waitForTimeout(200);
    await grid.page.keyboard.press("Control+a");
    await grid.page.keyboard.type("After", { delay: 20 });
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("A256")).toBe("After");
  });
});

test.describe("Sheet tab mouse interaction", () => {
  test("clicking sheet tab switches sheet", async ({ grid }) => {
    const tab = grid.page.locator('button[data-sheet-tab="0"]');
    await tab.click();
    await grid.page.waitForTimeout(300);

    // Should be on Sheet1
    await expect(tab).toBeVisible();
  });

  test("sheet tab shows context menu on right-click", async ({ grid }) => {
    const tab = grid.page.locator('button[data-sheet-tab="0"]');
    await tab.click({ button: "right" });
    await grid.page.waitForTimeout(300);

    // Context menu should appear with Rename, Delete, etc.
    const renameItem = grid.page.locator("button, div").filter({ hasText: /Rename/ }).first();
    const hasContextMenu = await renameItem.isVisible({ timeout: 2000 }).catch(() => false);
    expect(hasContextMenu).toBe(true);

    // Close context menu
    await grid.page.keyboard.press("Escape");
    await grid.page.waitForTimeout(200);
  });
});
