/**
 * Structured Tables E2E tests.
 *
 * Tests table creation, renaming, deletion, totals row, and column ops
 * via Tauri API commands. Uses cells in columns R-T, rows 1-15.
 */
import { test, expect } from "../fixtures";
import { takeGridRegionScreenshot } from "../helpers/screenshots";
import type { Page } from "@playwright/test";

/**
 * Tell the frontend that table definitions changed.
 *
 * These tests create tables by invoking the RUST command directly, which is a
 * backend-only mutation: no TypeScript code hears about it. The Table
 * extension keeps the drawn table region (drawTableBorder, registered as a grid
 * overlay) in sync via `refreshCache()`, which it runs on the
 * TABLE_DEFINITIONS_UPDATED / TABLE_CREATED window events. That is the same
 * path the backend's own out-of-band "tables:refresh" Tauri event is bridged
 * onto for MCP-created tables, so it is the documented hook for exactly this
 * case — not a test-only backdoor.
 *
 * Without it the overlay cache stays empty and NO table chrome is ever drawn.
 * VERIFIED before this was added: `grid-tables-before-create.png` and
 * `grid-tables-after-create.png` were BYTE-IDENTICAL (sha256
 * f1e50575...), i.e. the pair asserted that creating a table changes nothing.
 */
async function announceTablesChanged(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("app:table-created"));
    window.dispatchEvent(new Event("app:table-definitions-updated"));
  });
  // refreshCache() is an async backend round-trip; the repaint it drives only
  // lands once it resolves.
  await page.waitForTimeout(800);
}

test.describe("Structured Tables", () => {
  test("create a table with headers", async ({ appPage, grid }) => {
    // Set up data
    await grid.setCellValueDirect("R1", "Product");
    await grid.setCellValueDirect("S1", "Price");
    await grid.setCellValueDirect("T1", "Qty");
    await grid.setCellValueDirect("R2", "Apple");
    await grid.setCellValueDirect("S2", "1.50");
    await grid.setCellValueDirect("T2", "10");
    await grid.setCellValueDirect("R3", "Banana");
    await grid.setCellValueDirect("S3", "0.75");
    await grid.setCellValueDirect("T3", "20");
    await grid.setCellValueDirect("R4", "Cherry");
    await grid.setCellValueDirect("S4", "3.00");
    await grid.setCellValueDirect("T4", "5");
    await grid.page.waitForTimeout(300);

    await grid.navigateTo("R1");
    await takeGridRegionScreenshot(appPage, "tables-before-create", { from: "R1", to: "T4" });

    // Create a table via Tauri API
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("create_table", {
        params: {
          name: "",
          startRow: 0,
          startCol: 17,
          endRow: 3,
          endCol: 19,
          hasHeaders: true,
        },
      });
    });
    await grid.page.waitForTimeout(500);

    expect(result.success).toBe(true);
    expect(result.table).toBeDefined();
    expect(result.table.name).toBeTruthy();

    await announceTablesChanged(grid.page);
    await grid.navigateTo("R1");
    await takeGridRegionScreenshot(appPage, "tables-after-create", { from: "R1", to: "T4" });
  });

  test("rename a table", async ({ grid }) => {
    // First create a table
    const createResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      // Set up data
      await tauri.core.invoke("update_cell", { row: 0, col: 21, value: "X" });
      await tauri.core.invoke("update_cell", { row: 0, col: 22, value: "Y" });
      await tauri.core.invoke("update_cell", { row: 1, col: 21, value: "1" });
      await tauri.core.invoke("update_cell", { row: 1, col: 22, value: "2" });
      return tauri.core.invoke("create_table", {
        params: {
          name: "",
          startRow: 0,
          startCol: 21,
          endRow: 1,
          endCol: 22,
          hasHeaders: true,
        },
      });
    });
    await grid.page.waitForTimeout(300);
    expect(createResult.success).toBe(true);

    const tableId = createResult.table.id;

    // Rename the table
    const renameResult: any = await grid.page.evaluate(
      async (id: number) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("rename_table", {
          tableId: id,
          newName: "SalesData",
        });
      },
      tableId
    );
    await grid.page.waitForTimeout(300);

    expect(renameResult.success).toBe(true);
    expect(renameResult.table.name).toBe("SalesData");
  });

  test("toggle totals row and set function", async ({ appPage, grid }) => {
    // Create a table with numeric data
    const createResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("update_cell", { row: 6, col: 17, value: "Item" });
      await tauri.core.invoke("update_cell", { row: 6, col: 18, value: "Amount" });
      await tauri.core.invoke("update_cell", { row: 7, col: 17, value: "A" });
      await tauri.core.invoke("update_cell", { row: 7, col: 18, value: "100" });
      await tauri.core.invoke("update_cell", { row: 8, col: 17, value: "B" });
      await tauri.core.invoke("update_cell", { row: 8, col: 18, value: "200" });
      await tauri.core.invoke("update_cell", { row: 9, col: 17, value: "C" });
      await tauri.core.invoke("update_cell", { row: 9, col: 18, value: "300" });
      return tauri.core.invoke("create_table", {
        params: {
          name: "TotalsTest",
          startRow: 6,
          startCol: 17,
          endRow: 9,
          endCol: 18,
          hasHeaders: true,
          styleOptions: { totalRow: true, headerRow: true, bandedRows: true, bandedColumns: false, firstColumn: false, lastColumn: false, showFilterButton: true },
        },
      });
    });
    await grid.page.waitForTimeout(500);
    expect(createResult.success).toBe(true);

    const tableId = createResult.table.id;

    // Set totals row function to Sum
    const totalsResult: any = await grid.page.evaluate(
      async (id: number) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("set_totals_row_function", {
          params: {
            tableId: id,
            columnName: "Amount",
            function: "sum",
          },
        });
      },
      tableId
    );
    await grid.page.waitForTimeout(300);

    expect(totalsResult.success).toBe(true);

    await grid.navigateTo("R7");
    // R7:S11 = the TotalsTest table (rows 6-9) plus the totals row below it.
    await takeGridRegionScreenshot(appPage, "tables-totals-row-sum", {
      from: "R7",
      to: "S11",
    });
  });

  test("delete a table converts back to range", async ({ grid }) => {
    // Create a small table
    const createResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("update_cell", { row: 12, col: 17, value: "Col1" });
      await tauri.core.invoke("update_cell", { row: 12, col: 18, value: "Col2" });
      await tauri.core.invoke("update_cell", { row: 13, col: 17, value: "X" });
      await tauri.core.invoke("update_cell", { row: 13, col: 18, value: "Y" });
      return tauri.core.invoke("create_table", {
        params: {
          name: "",
          startRow: 12,
          startCol: 17,
          endRow: 13,
          endCol: 18,
          hasHeaders: true,
        },
      });
    });
    await grid.page.waitForTimeout(300);
    expect(createResult.success).toBe(true);

    const tableId = createResult.table.id;

    // Delete the table
    const deleteResult: any = await grid.page.evaluate(
      async (id: number) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("delete_table", { tableId: id });
      },
      tableId
    );
    await grid.page.waitForTimeout(300);

    expect(deleteResult.success).toBe(true);

    // Verify data is still there but table is gone
    const cellValue = await grid.getCellDisplayValue("R13");
    expect(cellValue).toBe("Col1");
  });
});
