/**
 * Column/row operations E2E tests.
 *
 * Tests insert/delete rows and columns, resize, hide/unhide.
 */
import { test, expect } from "../fixtures";

test.describe("Column width", () => {
  test("set column width via Tauri API", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_column_width", { col: 0, width: 200.0 });
    });
    await grid.page.waitForTimeout(300);

    const width = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_column_width", { col: 0 });
    });
    expect(width).toBe(200);

    // Reset to default
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_column_width", { col: 0, width: 100.0 });
    });
  });
});

test.describe("Row height", () => {
  test("set row height via Tauri API", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_row_height", { row: 0, height: 48.0 });
    });
    await grid.page.waitForTimeout(300);

    const height = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_row_height", { row: 0 });
    });
    expect(height).toBe(48);

    // Reset
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_row_height", { row: 0, height: 24.0 });
    });
  });
});

test.describe("Insert and delete rows", () => {
  test("insert row shifts data down", async ({ grid }) => {
    // Set up data in a clean column
    await grid.setCellValueDirect("AR1", "First");
    await grid.setCellValueDirect("AR2", "Second");

    // Insert a row at row 1 (0-based)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("insert_rows", { row: 1, count: 1 });
    });
    await grid.page.waitForTimeout(300);

    // AR1 should still be "First"
    expect(await grid.getCellDisplayValue("AR1")).toBe("First");
    // AR2 should now be empty (inserted row)
    const ar2 = await grid.getCellDisplayValue("AR2");
    expect(ar2).toBe("");
    // AR3 should be "Second" (shifted down)
    expect(await grid.getCellDisplayValue("AR3")).toBe("Second");

    // Clean up: delete the inserted row
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_rows", { row: 1, count: 1 });
    });
  });

  test("insert column shifts data right", async ({ grid }) => {
    await grid.setCellValueDirect("AS1", "Col1");
    await grid.setCellValueDirect("AT1", "Col2");

    // Insert column at col 44 (AS = col 44)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("insert_columns", { col: 44, count: 1 });
    });
    await grid.page.waitForTimeout(300);

    // AS1 should be empty (inserted col), AT1 should be "Col1"
    const as1 = await grid.getCellDisplayValue("AS1");
    expect(as1).toBe("");
    expect(await grid.getCellDisplayValue("AT1")).toBe("Col1");

    // Clean up
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_columns", { col: 44, count: 1 });
    });
  });
});

test.describe("Grid bounds", () => {
  test("get grid bounds returns valid data", async ({ grid }) => {
    const bounds = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_grid_bounds");
    });
    expect(bounds).toBeDefined();
    // Bounds should be an object with some dimension info
    expect(typeof bounds).toBe("object");
  });

  test("get used range returns valid data", async ({ grid }) => {
    const range = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_used_range");
    });
    expect(range).toBeDefined();
  });
});
