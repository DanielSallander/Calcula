/**
 * Realistic workflow E2E tests.
 *
 * End-to-end scenarios that simulate real user tasks combining
 * keyboard, mouse, menus, and formatting in natural sequences.
 *
 * Uses rows 300+ to avoid collision.
 */
import { test, expect } from "../fixtures";

test.describe("Build a budget table", () => {
  test("create header row with formatting", async ({ grid }) => {
    // Click A300, type headers using Tab
    await grid.navigateTo("A300");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(400);

    await grid.typeAndTab("Category");
    await grid.typeAndTab("Budget");
    await grid.typeAndEnter("Actual");

    // Select header range and bold it
    await grid.clickCell("A300");
    await grid.shiftArrowSelect(0, 2); // select A300:C300
    await grid.toggleBold();

    // Verify headers and formatting
    expect(await grid.getCellDisplayValue("A300")).toBe("Category");
    expect(await grid.getCellDisplayValue("B300")).toBe("Budget");
    expect(await grid.getCellDisplayValue("C300")).toBe("Actual");
    expect(await grid.getCellStyleProp("A300", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("C300", "bold")).toBe(true);
  });

  test("fill in data rows", async ({ grid }) => {
    // Row 1
    await grid.navigateTo("A301");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(400);
    await grid.typeAndTab("Rent");
    await grid.typeAndTab("1000");
    await grid.typeAndEnter("950");

    // Row 2
    await grid.navigateTo("A302");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(400);
    await grid.typeAndTab("Food");
    await grid.typeAndTab("500");
    await grid.typeAndEnter("620");

    // Row 3
    await grid.navigateTo("A303");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(400);
    await grid.typeAndTab("Transport");
    await grid.typeAndTab("200");
    await grid.typeAndEnter("180");

    expect(await grid.getCellDisplayValue("A301")).toBe("Rent");
    expect(await grid.getCellDisplayValue("B302")).toBe("500");
  });

  test("add SUM formulas at bottom", async ({ grid }) => {
    // Set up data rows (each test is independent)
    await grid.setCellValueDirect("B301", "1000");
    await grid.setCellValueDirect("C301", "950");
    await grid.setCellValueDirect("B302", "500");
    await grid.setCellValueDirect("C302", "620");
    await grid.setCellValueDirect("B303", "200");
    await grid.setCellValueDirect("C303", "180");

    await grid.setCellValueDirect("A304", "Total");
    await grid.setCellValueDirect("B304", "=SUM(B301:B303)");
    await grid.setCellValueDirect("C304", "=SUM(C301:C303)");

    expect(await grid.getCellDisplayValue("B304")).toBe("1700");
    expect(await grid.getCellDisplayValue("C304")).toBe("1750");
  });

  test("apply comma format to numbers", async ({ grid }) => {
    await grid.selectRange("B301", "C304");
    await grid.clickFormatButton("commaFormat");

    const fmt = await grid.getCellStyleStringProp("B301", "numberFormat");
    expect(fmt).toContain("separator");
  });

  test("bold the total row", async ({ grid }) => {
    await grid.clickCell("A304");
    await grid.shiftArrowSelect(0, 2);
    await grid.toggleBold();

    expect(await grid.getCellStyleProp("A304", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("C304", "bold")).toBe(true);
  });
});

test.describe("Data cleanup workflow", () => {
  test("enter messy data then find and replace", async ({ grid }) => {
    await grid.setCellValueDirect("A310", "USA");
    await grid.setCellValueDirect("A311", "US");
    await grid.setCellValueDirect("A312", "USA");
    await grid.setCellValueDirect("A313", "US");

    // Use find_all to confirm inconsistency
    const findUS = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("find_all", {
        query: "US", caseSensitive: false,
        matchEntireCell: true, searchFormulas: false,
      });
    });

    // Replace "US" with "USA" (exact match)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("replace_all", {
        search: "US", replacement: "USA",
        caseSensitive: false, matchEntireCell: true,
      });
    });
    await grid.page.waitForTimeout(300);

    // All cells should now be "USA"
    expect(await grid.getCellDisplayValue("A311")).toBe("USA");
    expect(await grid.getCellDisplayValue("A313")).toBe("USA");
  });

  test("sort data alphabetically", async ({ grid }) => {
    await grid.setCellValueDirect("A315", "Zebra");
    await grid.setCellValueDirect("A316", "Apple");
    await grid.setCellValueDirect("A317", "Mango");

    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("sort_range", {
        params: {
          startRow: 314, startCol: 0, endRow: 316, endCol: 0,
          fields: [{ key: 0, ascending: true }],
          matchCase: false, hasHeaders: false, orientation: "rows",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("A315")).toBe("Apple");
    expect(await grid.getCellDisplayValue("A316")).toBe("Mango");
    expect(await grid.getCellDisplayValue("A317")).toBe("Zebra");
  });
});

test.describe("Multi-sheet workflow", () => {
  test("create summary sheet referencing data sheet", async ({ grid }) => {
    // Enter data on Sheet1
    await grid.setCellValueDirect("A320", "Q1 Sales");
    await grid.setCellValueDirect("B320", "5000");

    // Add a summary sheet
    const addBtn = grid.page.locator('button[title="Add new sheet"]');
    await addBtn.click({ force: true });
    await grid.page.waitForTimeout(800);

    // On the new sheet, reference Sheet1 data
    await grid.setCellValueDirect("A1", "Summary");
    await grid.setCellValueDirect("B1", "=Sheet1!B320");

    expect(await grid.getCellDisplayValue("B1")).toBe("5000");

    // Switch back to Sheet1
    const tab1 = grid.page.locator('button[data-sheet-tab="0"]');
    await tab1.click();
    await grid.page.waitForTimeout(500);

    // Update the source data
    await grid.setCellValueDirect("B320", "6000");
    await grid.page.waitForTimeout(300);

    // Switch to summary and verify it updated
    const tabs = grid.page.locator("button[data-sheet-tab]");
    const tabCount = await tabs.count();
    await tabs.nth(tabCount - 1).click();
    await grid.page.waitForTimeout(500);

    expect(await grid.getCellDisplayValue("B1")).toBe("6000");

    // Clean up: delete added sheet, switch back
    await grid.page.evaluate((idx: number) => {
      window.dispatchEvent(new CustomEvent("sheet:requestDelete", {
        detail: { index: idx },
      }));
    }, tabCount - 1);
    await grid.page.waitForTimeout(300);
    const deleteBtn = grid.page.locator("button").filter({ hasText: /^Delete$/ });
    if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await deleteBtn.click();
      await grid.page.waitForTimeout(500);
    }
  });
});

test.describe("Copy-paste formatting workflow", () => {
  test("format one cell then copy style to others", async ({ grid }) => {
    // Create a styled cell
    await grid.setCellValueDirect("A325", "Styled");
    await grid.clickCell("A325");
    await grid.toggleBold();
    await grid.toggleItalic();

    // Verify styling
    expect(await grid.getCellStyleProp("A325", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("A325", "italic")).toBe(true);

    // Copy the cell
    await grid.clickCell("A325");
    await grid.clickFormatButton("copy");

    // Paste to a range of cells
    await grid.setCellValueDirect("A326", "Copy1");
    await grid.setCellValueDirect("A327", "Copy2");

    await grid.clickCell("A326");
    await grid.clickFormatButton("paste");

    await grid.clickCell("A327");
    await grid.clickFormatButton("paste");

    // Both should have the same formatting
    expect(await grid.getCellStyleProp("A326", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("A327", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("A326", "italic")).toBe(true);
  });
});
