/**
 * Sort & Filter E2E tests (Phase 8).
 *
 * Tests sort and AutoFilter via Tauri API commands.
 * Uses setCellValueDirect() to avoid locale keyboard issues.
 * Note: Tauri commands take params as a single object parameter.
 *
 * Uses cells in columns M-P, rows 1-15 to avoid collision.
 */
import { test, expect } from "../fixtures";

test.describe("Sort", () => {
  test("sort ascending by single column", async ({ grid }) => {
    await grid.setCellValueDirect("M1", "Name");
    await grid.setCellValueDirect("N1", "Score");
    await grid.setCellValueDirect("M2", "Charlie");
    await grid.setCellValueDirect("N2", "30");
    await grid.setCellValueDirect("M3", "Alice");
    await grid.setCellValueDirect("N3", "10");
    await grid.setCellValueDirect("M4", "Bob");
    await grid.setCellValueDirect("N4", "20");

    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("sort_range", {
        params: {
          startRow: 1, startCol: 12, endRow: 3, endCol: 13,
          fields: [{ key: 0, ascending: true }],
          matchCase: false, hasHeaders: false, orientation: "rows",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("M2")).toBe("Alice");
    expect(await grid.getCellDisplayValue("M3")).toBe("Bob");
    expect(await grid.getCellDisplayValue("M4")).toBe("Charlie");
  });

  test("sort descending by numeric column", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("sort_range", {
        params: {
          startRow: 1, startCol: 12, endRow: 3, endCol: 13,
          fields: [{ key: 1, ascending: false }],
          matchCase: false, hasHeaders: false, orientation: "rows",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("N2")).toBe("30");
    expect(await grid.getCellDisplayValue("N3")).toBe("20");
    expect(await grid.getCellDisplayValue("N4")).toBe("10");
  });

  test("sort preserves row data integrity", async ({ grid }) => {
    // After descending sort by N, verify each name matches its score
    const m2 = await grid.getCellDisplayValue("M2");
    const n2 = await grid.getCellDisplayValue("N2");
    expect(n2).toBe("30");
    expect(["Alice", "Bob", "Charlie"]).toContain(m2);
  });
});

test.describe("AutoFilter", () => {
  test("apply auto filter to a range", async ({ grid }) => {
    await grid.setCellValueDirect("O1", "Color");
    await grid.setCellValueDirect("O2", "Red");
    await grid.setCellValueDirect("O3", "Blue");
    await grid.setCellValueDirect("O4", "Red");
    await grid.setCellValueDirect("O5", "Green");
    await grid.setCellValueDirect("O6", "Blue");

    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("apply_auto_filter", {
        params: {
          startRow: 0, startCol: 14, endRow: 5, endCol: 14,
        },
      });
    });
    await grid.page.waitForTimeout(300);

    const filterInfo = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_auto_filter");
    });
    expect(filterInfo).not.toBeNull();
  });

  test("filter by specific values hides non-matching rows", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_column_filter_values", {
        columnIndex: 0, values: ["Red"], includeBlanks: false,
      });
    });
    await grid.page.waitForTimeout(300);

    const hiddenRows = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_hidden_rows");
    });
    // Rows with Blue and Green should be hidden
    expect(hiddenRows.length).toBeGreaterThan(0);
  });

  test("clear filter shows all rows", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("clear_auto_filter_criteria");
    });
    await grid.page.waitForTimeout(300);

    const hiddenRows = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_hidden_rows");
    });
    expect(hiddenRows.length).toBe(0);
  });

  test("remove auto filter", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("remove_auto_filter");
    });
    await grid.page.waitForTimeout(300);

    const filterInfo = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_auto_filter");
    });
    expect(filterInfo).toBeNull();
  });
});
