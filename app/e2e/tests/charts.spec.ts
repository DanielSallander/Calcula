/**
 * Charts E2E tests (Phase 11).
 *
 * Tests chart creation, retrieval, and deletion via Tauri API.
 * Charts are stored as ChartEntry { id, sheet_index, spec_json }.
 *
 * SELF-CONTAINMENT (see docs/design/open-decisions-2026-08.md §3b). This file
 * used to leak two things into the shared workbook that no reset reached:
 *
 *   1. A CHART. "delete chart" deleted `charts[0]` — whichever chart that
 *      happened to be — and only one of them, so the chart this file created
 *      could outlive the file. Every test now names the chart it made.
 *   2. CELL DATA IN COLUMN AA. `resetGrid` clears A1:Z1000, i.e. columns 0-25.
 *      AA is column 26. The four values seeded here survived every subsequent
 *      spec's reset for the rest of the run.
 *
 * The chart spec written below is deliberately the MINIMAL one — no axes, no
 * legend, no palette — because that is what a caller of `save_chart` actually
 * sends: the command takes an opaque JSON blob, and scripts, the MCP tools and
 * XLSX import all send exactly this shape. It is the store's job to complete it
 * (chartSpecNormalize.ts). Filling it in here would delete the regression
 * witness for a chart that painted its own exception into the grid.
 */
import { test, expect } from "../fixtures";

test.describe("Charts", () => {
  let chartId: string;

  test.afterAll(async ({ sharedPage }) => {
    await sharedPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      if (!tauri?.core?.invoke) return;
      // Every chart this file could have created, whether or not the delete
      // test ran or reached its assertion.
      const charts: Array<{ id: string }> = await tauri.core.invoke("get_charts");
      for (const c of charts) {
        await tauri.core.invoke("delete_chart", { id: c.id }).catch(() => {});
      }
      // Columns Z and AA, rows 1-4 — the seeded data, cleared through the same
      // command the reset helper uses.
      await tauri.core
        .invoke("clear_range_with_options", {
          params: { startRow: 0, startCol: 25, endRow: 3, endCol: 26, applyTo: "All" },
        })
        .catch(() => {});
      // BOTH events, and the order matters. `delete_chart` removes the chart
      // from the BACKEND; the frontend store keeps its own copy and only
      // re-reads it on "charts:refresh". Dispatching "grid:refresh" alone
      // repaints a chart the backend has already forgotten — which is exactly
      // what happened on the first attempt at this cleanup, and the chart went
      // on appearing in goldens for the rest of the run.
      window.dispatchEvent(new Event("charts:refresh"));
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await sharedPage.waitForTimeout(400);
  });

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
    // THIS file's chart, not "whatever chart is first". The previous version
    // read charts[0], so it asserted about someone else's object as soon as the
    // workbook held more than one chart.
    const chart = await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      const charts: any[] = await tauri.core.invoke("get_charts");
      return charts.find((c) => c.id === id) ?? null;
    }, chartId);
    expect(chart, "the chart created by the previous test must still exist").not.toBeNull();

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
    const found = updated.find((c: any) => c.id === chartId);
    expect(found).toBeDefined();
    const updatedSpec = JSON.parse(found.specJson);
    expect(updatedSpec.title).toBe("Updated Chart");
  });

  test("delete chart", async ({ grid }) => {
    const countBefore = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return (await tauri.core.invoke("get_charts")).length as number;
    });
    expect(countBefore).toBeGreaterThan(0);

    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_chart", { id });
    }, chartId);
    await grid.page.waitForTimeout(300);

    const chartsAfter = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_charts");
    });
    expect(chartsAfter.length).toBe(countBefore - 1);
    expect(chartsAfter.some((c: any) => c.id === chartId)).toBe(false);
  });
});
