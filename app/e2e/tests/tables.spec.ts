/**
 * Structured Tables E2E tests.
 *
 * Tests table creation, renaming, deletion, totals row, and column ops
 * via Tauri API commands. Uses cells in columns R-T, rows 1-15.
 */
import { test, expect } from "../fixtures";
import {
  takeGridScreenshot,
  takeCheckpoint,
} from "../helpers/screenshots";

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
    await takeGridScreenshot(appPage, "tables-before-create");

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

    await grid.navigateTo("R1");
    await takeGridScreenshot(appPage, "tables-after-create");
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
    await takeGridScreenshot(appPage, "tables-totals-row-sum");
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
