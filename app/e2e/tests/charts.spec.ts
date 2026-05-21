/**
 * Charts E2E tests (Phase 11).
 *
 * Tests chart creation, retrieval, and deletion via Tauri API.
 * Charts are stored as ChartEntry { id, sheet_index, spec_json }.
 */
import { test, expect } from "../fixtures";

test.describe("Charts", () => {
  let chartId: string;

  test("create a chart via save_chart", async ({ grid }) => {
    // Set up data for the chart
    await grid.setCellValueDirect("Z1", "Month");
    await grid.setCellValueDirect("AA1", "Sales");
    await grid.setCellValueDirect("Z2", "Jan");
    await grid.setCellValueDirect("AA2", "100");
    await grid.setCellValueDirect("Z3", "Feb");
    await grid.setCellValueDirect("AA3", "200");
    await grid.setCellValueDirect("Z4", "Mar");
    await grid.setCellValueDirect("AA4", "150");

    // Create a chart
    // Generate a UUID v4-like string
    chartId = await grid.page.evaluate(() => crypto.randomUUID());
    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, startRow: 0, startCol: 25, endRow: 3, endCol: 26 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Sales", color: "#4472C4" }],
        title: "Test Chart",
      };
      await tauri.core.invoke("save_chart", {
        entry: { id, sheetIndex: 0, specJson: JSON.stringify(spec) },
      });
    }, chartId);
    await grid.page.waitForTimeout(300);

    // Verify chart exists
    const charts = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_charts");
    });
    expect(charts.length).toBeGreaterThanOrEqual(1);
    expect(charts.some((c: any) => c.id === chartId)).toBe(true);
  });

  test("update chart spec", async ({ grid }) => {
    const charts = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_charts");
    });
    if (charts.length === 0) return;

    const chart = charts[0];
    const spec = JSON.parse(chart.specJson);
    spec.title = "Updated Chart";

    await grid.page.evaluate(async (entry: any) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("update_chart", { entry });
    }, { ...chart, specJson: JSON.stringify(spec) });
    await grid.page.waitForTimeout(300);

    // Verify update
    const updated = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_charts");
    });
    const found = updated.find((c: any) => c.id === chart.id);
    expect(found).toBeDefined();
    const updatedSpec = JSON.parse(found.specJson);
    expect(updatedSpec.title).toBe("Updated Chart");
  });

  test("delete chart", async ({ grid }) => {
    const charts = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_charts");
    });
    if (charts.length === 0) return;

    const countBefore = charts.length;
    const idToDelete = charts[0].id;

    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_chart", { id });
    }, idToDelete);
    await grid.page.waitForTimeout(300);

    const chartsAfter = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_charts");
    });
    expect(chartsAfter.length).toBe(countBefore - 1);
  });
});
