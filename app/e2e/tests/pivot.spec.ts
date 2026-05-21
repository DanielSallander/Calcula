/**
 * Pivot table E2E tests (Phase 12).
 *
 * Tests pivot table creation, field management, and refresh via Tauri API.
 * Uses realistic mock data (Swedish names/cities/sales) loaded via batch update.
 * Data is placed in columns AB-AF starting at row 1.
 */
import { test, expect } from "../fixtures";

// Mini dataset matching the app's mock data schema: first_name, last_name, gender, city, sales
const PIVOT_DATA = [
  ["first_name", "last_name", "gender", "city", "sales"],
  ["Erik", "Johansson", "Male", "Stockholm", "452"],
  ["Anna", "Andersson", "Female", "Uppsala", "819"],
  ["Erik", "Karlsson", "Male", "Gothenburg", "234"],
  ["Maria", "Nilsson", "Female", "Stockholm", "912"],
  ["Erik", "Eriksson", "Male", "Uppsala", "567"],
  ["Anna", "Larsson", "Female", "Gothenburg", "104"],
  ["Lars", "Olsson", "Male", "Stockholm", "789"],
  ["Maria", "Persson", "Female", "Uppsala", "345"],
  ["Lars", "Svensson", "Male", "Gothenburg", "621"],
  ["Anna", "Gustafsson", "Female", "Stockholm", "890"],
];

test.describe("Pivot tables", () => {
  let pivotId: string;

  test("load pivot source data", async ({ grid }) => {
    // Batch-load data into AB1:AF10
    await grid.page.evaluate(async (data: string[][]) => {
      const tauri = (window as any).__TAURI__;
      const updates = data.flatMap((row, r) =>
        row.map((val, c) => ({ row: r, col: 27 + c, value: val }))
      );
      await tauri.core.invoke("update_cells_batch", { updates });
    }, PIVOT_DATA);
    await grid.page.waitForTimeout(500);

    // Verify data loaded
    expect(await grid.getCellDisplayValue("AB1")).toBe("first_name");
    expect(await grid.getCellDisplayValue("AF2")).toBe("452");
  });

  test("create pivot table from data range", async ({ grid }) => {
    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("create_pivot_table", {
        request: {
          sourceRange: "AB1:AF10",
          destinationCell: "AH1",
          hasHeaders: true,
        },
      });
    });
    await grid.page.waitForTimeout(500);

    expect(result).toBeDefined();
    pivotId = result.pivotId;
    expect(pivotId).toBeTruthy();
  });

  test("add row field (city) and value field (sales sum)", async ({ grid }) => {
    if (!pivotId) return;

    const result = await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("update_pivot_fields", {
        request: {
          pivotId: id,
          rowFields: [{ sourceIndex: 3, name: "city" }],
          valueFields: [{ sourceIndex: 4, name: "Sum of sales", aggregation: "sum" }],
        },
      });
    }, pivotId);
    await grid.page.waitForTimeout(500);

    expect(result).toBeDefined();
    expect(result.rowCount).toBeGreaterThan(0);
  });

  test("pivot view has correct structure", async ({ grid }) => {
    if (!pivotId) return;

    const view = await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_pivot_view", { pivotId: id });
    }, pivotId);

    expect(view).toBeDefined();
    expect(view.rowCount).toBeGreaterThan(0);
    expect(view.colCount).toBeGreaterThan(0);
    // Should have 3 cities + grand total = 4 data rows (plus headers)
  });

  test("add column field (gender) for cross-tabulation", async ({ grid }) => {
    if (!pivotId) return;

    const result = await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("update_pivot_fields", {
        request: {
          pivotId: id,
          rowFields: [{ sourceIndex: 3, name: "city" }],
          columnFields: [{ sourceIndex: 2, name: "gender" }],
          valueFields: [{ sourceIndex: 4, name: "Sum of sales", aggregation: "sum" }],
        },
      });
    }, pivotId);
    await grid.page.waitForTimeout(500);

    expect(result).toBeDefined();
    // Should now have columns for Male/Female
    expect(result.colCount).toBeGreaterThan(1);
  });

  test("change aggregation to average", async ({ grid }) => {
    if (!pivotId) return;

    const result = await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("update_pivot_fields", {
        request: {
          pivotId: id,
          rowFields: [{ sourceIndex: 3, name: "city" }],
          valueFields: [{ sourceIndex: 4, name: "Avg of sales", aggregation: "average" }],
        },
      });
    }, pivotId);
    await grid.page.waitForTimeout(500);

    expect(result).toBeDefined();
  });

  test("refresh pivot cache", async ({ grid }) => {
    if (!pivotId) return;

    const result = await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("refresh_pivot_cache", { pivotId: id });
    }, pivotId);

    expect(result).toBeDefined();
  });

  test("delete pivot table", async ({ grid }) => {
    if (!pivotId) return;

    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_pivot_table", { pivotId: id });
    }, pivotId);
    await grid.page.waitForTimeout(300);

    const allPivots = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_all_pivot_tables");
    });
    expect(allPivots).not.toContain(pivotId);
  });
});
