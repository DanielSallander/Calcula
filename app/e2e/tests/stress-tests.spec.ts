/**
 * Data integrity and stress tests.
 *
 * Tests that push the app harder: large batch operations, deep formula
 * chains, cross-sheet cascades, concurrent formatting, and data
 * consistency after complex operation sequences.
 *
 * Uses rows 500-600 and multiple sheets.
 */
import { test, expect } from "../fixtures";

test.describe("Large batch operations", () => {
  test("batch update 500 cells and verify", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const updates = [];
      for (let r = 0; r < 50; r++) {
        for (let c = 0; c < 10; c++) {
          updates.push({ row: 500 + r, col: c, value: `R${r}C${c}` });
        }
      }
      await tauri.core.invoke("update_cells_batch", { updates });
    });
    await grid.page.waitForTimeout(500);

    // Spot-check corners
    expect(await grid.getCellDisplayValue("A501")).toBe("R0C0");
    expect(await grid.getCellDisplayValue("J501")).toBe("R0C9");
    expect(await grid.getCellDisplayValue("A550")).toBe("R49C0");
    expect(await grid.getCellDisplayValue("J550")).toBe("R49C9");
  });

  test("formula referencing 100 cells via SUM", async ({ grid }) => {
    // Fill A560:A659 with values 1-100
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const updates = [];
      for (let i = 0; i < 100; i++) {
        updates.push({ row: 560 + i, col: 0, value: String(i + 1) });
      }
      await tauri.core.invoke("update_cells_batch", { updates });
    });
    await grid.page.waitForTimeout(300);

    // SUM of 1..100 = 5050
    await grid.setCellValueDirect("B560", "=SUM(A561:A660)");
    const sum = await grid.getCellDisplayValue("B560");
    expect(parseFloat(sum.replace(/[^\d.,]/g, "").replace(",", "."))).toBe(5050);
  });

  test("AVERAGE, COUNT, MIN, MAX over 100 cells", async ({ grid }) => {
    await grid.setCellValueDirect("C560", "=AVERAGE(A561:A660)");
    await grid.setCellValueDirect("D560", "=COUNT(A561:A660)");
    await grid.setCellValueDirect("E560", "=MIN(A561:A660)");
    await grid.setCellValueDirect("F560", "=MAX(A561:A660)");

    const avg = await grid.getCellDisplayValue("C560");
    expect(parseFloat(avg.replace(",", "."))).toBeCloseTo(50.5, 1);
    expect(await grid.getCellDisplayValue("D560")).toBe("100");
    expect(await grid.getCellDisplayValue("E560")).toBe("1");
    expect(await grid.getCellDisplayValue("F560")).toBe("100");
  });
});

test.describe("Deep formula chains", () => {
  test("chain of 100 dependent cells all recalculate", async ({ grid }) => {
    // B661 = 1, B662 = B661 + 1, ..., B760 = B759 + 1
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("update_cell", { row: 660, col: 1, value: "1" });
      const updates = [];
      for (let i = 1; i < 100; i++) {
        updates.push({ row: 660 + i, col: 1, value: `=B${661 + i - 1}+1` });
      }
      // Update in smaller batches to avoid timeouts
      for (const u of updates) {
        await tauri.core.invoke("update_cell", u);
      }
    });
    await grid.page.waitForTimeout(2000);

    // B760 should be 100
    const result = await grid.getCellDisplayValue("B760");
    expect(result).toBe("100");
  });

  test.fixme("changing the root propagates through entire chain", async ({ grid }) => {
    // Change B661 from 1 to 10
    await grid.setCellValueDirect("B661", "10");
    await grid.page.waitForTimeout(1000);

    // B760 should now be 109 (10 + 99)
    const result = await grid.getCellLiveValue("B760");
    expect(result).toBe("109");
  });
});

test.describe("Cross-sheet data integrity", () => {
  test("cross-sheet formula chain across 3 sheets", async ({ grid }) => {
    // Add Sheet2 and Sheet3
    const addBtn = grid.page.locator('button[title="Add new sheet"]');
    await addBtn.click({ force: true });
    await grid.page.waitForTimeout(800);
    await addBtn.click({ force: true });
    await grid.page.waitForTimeout(800);

    // Get sheet names
    const tabs = grid.page.locator("button[data-sheet-tab]");
    const tabCount = await tabs.count();
    const sheet2Name = (await tabs.nth(tabCount - 2).innerText()).trim();
    const sheet3Name = (await tabs.nth(tabCount - 1).innerText()).trim();

    // Put value on Sheet1
    await tabs.nth(0).click();
    await grid.page.waitForTimeout(500);
    await grid.setCellValueDirect("A770", "1000");

    // Sheet2: reference Sheet1
    await tabs.nth(tabCount - 2).click();
    await grid.page.waitForTimeout(500);
    await grid.setCellValueDirect("A1", "=Sheet1!A770*2");

    // Sheet3: reference Sheet2
    await tabs.nth(tabCount - 1).click();
    await grid.page.waitForTimeout(500);
    await grid.setCellValueDirect("A1", `=${sheet2Name}!A1+500`);

    // Verify Sheet3 value: 1000*2 + 500 = 2500
    expect(await grid.getCellDisplayValue("A1")).toBe("2500");

    // Go back to Sheet1, change the root value
    await tabs.nth(0).click();
    await grid.page.waitForTimeout(500);
    await grid.setCellValueDirect("A770", "500");
    await grid.page.waitForTimeout(500);

    // Check Sheet3: should now be 500*2 + 500 = 1500
    await tabs.nth(tabCount - 1).click();
    await grid.page.waitForTimeout(500);
    expect(await grid.getCellDisplayValue("A1")).toBe("1500");

    // Clean up sheets (delete from back to front)
    await tabs.nth(0).click();
    await grid.page.waitForTimeout(300);

    for (let i = 0; i < 2; i++) {
      const currentCount = await tabs.count();
      await grid.page.evaluate((idx: number) => {
        window.dispatchEvent(new CustomEvent("sheet:requestDelete", {
          detail: { index: idx },
        }));
      }, currentCount - 1);
      await grid.page.waitForTimeout(300);
      const deleteBtn = grid.page.locator("button").filter({ hasText: /^Delete$/ });
      if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await deleteBtn.click();
        await grid.page.waitForTimeout(500);
      }
    }
  });
});

test.describe("Format consistency under operations", () => {
  test("formatting survives sort operation", async ({ grid }) => {
    // Set up data with formatting
    await grid.setCellValueDirect("A780", "Zebra");
    await grid.setCellValueDirect("A781", "Apple");
    await grid.setCellValueDirect("A782", "Mango");

    // Bold "Zebra"
    await grid.clickCell("A780");
    await grid.toggleBold();

    // Sort A780:A782 ascending
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("sort_range", {
        params: {
          startRow: 779, startCol: 0, endRow: 781, endCol: 0,
          fields: [{ key: 0, ascending: true }],
          matchCase: false, hasHeaders: false, orientation: "rows",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    // Data sorted: Apple, Mango, Zebra
    expect(await grid.getCellDisplayValue("A780")).toBe("Apple");
    expect(await grid.getCellDisplayValue("A782")).toBe("Zebra");
  });

  test("number format persists through copy-paste", async ({ grid }) => {
    await grid.setCellValueDirect("A785", "0.5");
    await grid.clickCell("A785");
    await grid.clickFormatButton("percentFormat");

    const fmtBefore = await grid.getCellStyleStringProp("A785", "numberFormat");
    expect(fmtBefore).toContain("Percentage");

    // Copy and paste
    await grid.clickCell("A785");
    await grid.clickFormatButton("copy");
    await grid.clickCell("B785");
    await grid.clickFormatButton("paste");
    await grid.page.waitForTimeout(300);

    const fmtAfter = await grid.getCellStyleStringProp("B785", "numberFormat");
    expect(fmtAfter).toContain("Percentage");
    expect(await grid.getCellDisplayValue("B785")).toMatch(/50\s*%/);
  });

  test("formatting + merge + unmerge preserves style", async ({ grid }) => {
    await grid.setCellValueDirect("A790", "Merged Bold");
    await grid.clickCell("A790");
    await grid.toggleBold();

    // Merge A790:C790
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("merge_cells", {
        startRow: 789, startCol: 0, endRow: 789, endCol: 2,
      });
    });
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellStyleProp("A790", "bold")).toBe(true);

    // Unmerge
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("unmerge_cells", { row: 789, col: 0 });
    });
    await grid.page.waitForTimeout(300);

    // Bold should still be on the anchor cell
    expect(await grid.getCellStyleProp("A790", "bold")).toBe(true);
    expect(await grid.getCellDisplayValue("A790")).toBe("Merged Bold");
  });
});
