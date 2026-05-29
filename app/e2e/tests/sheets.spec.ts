/**
 * Sheet management E2E tests (Phase 5).
 *
 * Tests add/rename/delete/switch sheet operations.
 * Uses the "+" button (title="Add new sheet") for adding sheets,
 * custom events for rename, and Tauri API for delete (to skip confirm dialog).
 */
import { test, expect } from "../fixtures";
import { resetToNewWorkbook } from "../helpers/screenshots";

/** Helper: add a sheet via the "+" button in the sheet tab bar. */
async function addSheetViaButton(page: any) {
  const addBtn = page.locator('button[title="Add new sheet"]');
  await addBtn.click({ force: true });
  await page.waitForTimeout(800);
}

/** Helper: delete a sheet via event + confirmation dialog click. */
async function deleteSheet(page: any, index: number) {
  await page.evaluate((idx: number) => {
    window.dispatchEvent(new CustomEvent("sheet:requestDelete", {
      detail: { index: idx },
    }));
  }, index);
  await page.waitForTimeout(300);
  // Click "Delete" in the confirmation dialog
  const deleteBtn = page.locator("button").filter({ hasText: /^Delete$/ });
  if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await deleteBtn.click();
    await page.waitForTimeout(500);
  }
}

/** Helper: rename a sheet via custom event. */
async function renameSheetViaEvent(page: any, index: number, newName: string) {
  await page.evaluate(({ idx, name }: { idx: number; name: string }) => {
    window.dispatchEvent(new CustomEvent("sheet:requestRename", {
      detail: { index: idx, newName: name },
    }));
  }, { idx: index, name: newName });
  await page.waitForTimeout(500);
}

test.describe("Sheet switching", () => {
  test("sheet tab is visible with correct name", async ({ grid }) => {
    // Reset to clean workbook — prior tests may leave extra sheets/data
    await resetToNewWorkbook(grid.page);

    const tab = grid.page.locator('button[data-sheet-tab="0"]');
    await expect(tab).toBeVisible();
    await expect(tab).toContainText("Sheet1");
  });

  test("adding a sheet via button creates a new tab", async ({ grid }) => {
    const tabsBefore = await grid.page.locator("button[data-sheet-tab]").count();
    await addSheetViaButton(grid.page);

    const tabsAfter = await grid.page.locator("button[data-sheet-tab]").count();
    expect(tabsAfter).toBe(tabsBefore + 1);

    // Clean up via Tauri API
    await deleteSheet(grid.page, tabsAfter - 1);
  });

  test("switching between sheets preserves data", async ({ grid }) => {
    // Enter data on Sheet1
    await grid.clickCell("A1");
    await grid.typeIntoCell("Sheet1Data");

    // Add a new sheet (auto-switches to it)
    await addSheetViaButton(grid.page);

    // Enter data on the new sheet
    await grid.clickCell("A1");
    await grid.typeIntoCell("Sheet2Data");

    // Switch back to Sheet1
    const tab1 = grid.page.locator('button[data-sheet-tab="0"]');
    await tab1.click();
    await grid.page.waitForTimeout(500);

    // Verify Sheet1 data
    await grid.clickCell("A1");
    const val = await grid.getFormulaBarValue();
    expect(val).toBe("Sheet1Data");

    // Clean up
    const tabs = await grid.page.locator("button[data-sheet-tab]").count();
    if (tabs > 1) {
      await deleteSheet(grid.page, tabs - 1);
    }
  });
});

test.describe("Sheet rename", () => {
  test("rename sheet via event", async ({ grid }) => {
    await renameSheetViaEvent(grid.page, 0, "MySheet");

    const tab = grid.page.locator('button[data-sheet-tab="0"]');
    await expect(tab).toContainText("MySheet");

    // Rename back
    await renameSheetViaEvent(grid.page, 0, "Sheet1");
    await expect(tab).toContainText("Sheet1");
  });
});

test.describe("Sheet add and delete", () => {
  test("add and delete sheet via UI and API", async ({ grid }) => {
    const tabsBefore = await grid.page.locator("button[data-sheet-tab]").count();

    // Add via button
    await addSheetViaButton(grid.page);
    const tabsAfterAdd = await grid.page.locator("button[data-sheet-tab]").count();
    expect(tabsAfterAdd).toBe(tabsBefore + 1);

    // Delete via Tauri API (skip confirmation dialog)
    await deleteSheet(grid.page, tabsAfterAdd - 1);

    // Wait for UI update
    await grid.page.waitForTimeout(500);
    const tabsAfterDelete = await grid.page.locator("button[data-sheet-tab]").count();
    expect(tabsAfterDelete).toBe(tabsBefore);
  });
});

test.describe("Cross-sheet references", () => {
  test("formula referencing another sheet", async ({ grid }) => {
    // Add a second sheet
    await addSheetViaButton(grid.page);

    // We're now on the new sheet - enter a value
    await grid.clickCell("A1");
    await grid.typeIntoCell("100");

    // Get the new sheet's name from the active tab
    const tabs = grid.page.locator("button[data-sheet-tab]");
    const tabCount = await tabs.count();
    const newSheetName = (await tabs.nth(tabCount - 1).innerText()).trim();

    // Switch back to Sheet1
    const tab1 = grid.page.locator('button[data-sheet-tab="0"]');
    await tab1.click();
    await grid.page.waitForTimeout(500);

    // Enter a cross-sheet formula
    await grid.setCellValue("A60", `=${newSheetName}!A1`);
    const display = await grid.getCellDisplayValue("A60");
    expect(display).toBe("100");

    // Clean up
    await deleteSheet(grid.page, tabCount - 1);
  });
});
