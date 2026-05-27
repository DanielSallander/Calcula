/**
 * Advanced workflow: Sales dashboard with pivot, chart, and cross-sheet summary.
 *
 * Simulates building a dashboard that combines multiple features:
 * - Raw data entry on one sheet
 * - Pivot table analysis
 * - Chart creation
 * - Cross-sheet summary formulas
 * - Data validation on input cells
 * - Conditional formatting on KPIs
 *
 * Uses rows 470-500 on Sheet1, and creates/cleans up a summary sheet.
 */
import { test, expect } from "../fixtures";

test.describe("Sales dashboard workflow", () => {
  test.describe.configure({ mode: "serial" });

  test("step 1: enter sales data table", async ({ grid }) => {
    // Headers
    await grid.setCellValueDirect("A470", "Region");
    await grid.setCellValueDirect("B470", "Product");
    await grid.setCellValueDirect("C470", "Q1");
    await grid.setCellValueDirect("D470", "Q2");
    await grid.setCellValueDirect("E470", "Total");

    // Bold headers
    await grid.selectRange("A470", "E470");
    await grid.toggleBold();
    await grid.clickFormatButton("alignCenter");

    // Sales data
    const data = [
      ["North", "Widgets",  "1200", "1500"],
      ["North", "Gadgets",  "800",  "950"],
      ["South", "Widgets",  "900",  "1100"],
      ["South", "Gadgets",  "600",  "700"],
      ["East",  "Widgets",  "1400", "1300"],
      ["East",  "Gadgets",  "500",  "650"],
    ];
    for (let i = 0; i < data.length; i++) {
      const row = 471 + i;
      await grid.setCellValueDirect(`A${row}`, data[i][0]);
      await grid.setCellValueDirect(`B${row}`, data[i][1]);
      await grid.setCellValueDirect(`C${row}`, data[i][2]);
      await grid.setCellValueDirect(`D${row}`, data[i][3]);
      await grid.setCellValueDirect(`E${row}`, `=C${row}+D${row}`);
    }

    expect(await grid.getCellDisplayValue("E471")).toBe("2700"); // 1200+1500
    expect(await grid.getCellDisplayValue("A476")).toBe("East");
  });

  test("step 2: add summary statistics", async ({ gridPersistent: grid }) => {
    await grid.setCellValueDirect("A478", "Total Sales:");
    await grid.setCellValueDirect("C478", "=SUM(C471:C476)");
    await grid.setCellValueDirect("D478", "=SUM(D471:D476)");
    await grid.setCellValueDirect("E478", "=SUM(E471:E476)");

    await grid.setCellValueDirect("A479", "Average:");
    await grid.setCellValueDirect("C479", "=AVERAGE(C471:C476)");
    await grid.setCellValueDirect("D479", "=AVERAGE(D471:D476)");

    await grid.setCellValueDirect("A480", "Max Sale:");
    await grid.setCellValueDirect("C480", "=MAX(C471:C476)");
    await grid.setCellValueDirect("D480", "=MAX(D471:D476)");

    // Bold labels
    for (const ref of ["A478", "A479", "A480"]) {
      await grid.clickCell(ref);
      await grid.toggleBold();
    }

    // Total: 1200+800+900+600+1400+500 = 5400 (Q1)
    expect(await grid.getCellDisplayValue("C478")).toBe("5400");
    // Grand total: all Q1 + all Q2
    const grandTotal = await grid.getCellDisplayValue("E478");
    expect(parseFloat(grandTotal.replace(",", "."))).toBe(11600);
  });

  test("step 3: apply number formatting", async ({ gridPersistent: grid }) => {
    await grid.selectRange("C471", "E480");
    await grid.clickFormatButton("commaFormat");

    const fmt = await grid.getCellStyleStringProp("C471", "numberFormat");
    expect(fmt).toContain("separator");
  });

  test("step 4: add data validation for region input", async ({ gridPersistent: grid }) => {
    // Add list validation on the region column
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_data_validation", {
        startRow: 470, startCol: 0, endRow: 476, endCol: 0,
        validation: {
          rule: { list: { source: { values: ["North", "South", "East", "West"] }, inCellDropdown: true } },
          errorAlert: { title: "Invalid Region", message: "Use North, South, East, or West", style: "stop", showAlert: true },
          prompt: { title: "", message: "", showPrompt: false },
          ignoreBlanks: true,
        },
      });
    });
    await grid.page.waitForTimeout(300);

    // Verify validation
    const values = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_validation_list_values", { row: 471, col: 0 });
    });
    expect(values).toContain("West");
  });

  test("step 5: add conditional formatting for high sales", async ({ gridPersistent: grid }) => {
    // Highlight cells > 1000 in green
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("add_conditional_format", {
        params: {
          rule: { type: "cellValue", operator: "greaterThan", value1: "1000" },
          format: { backgroundColor: "#c6efce" },
          ranges: [{ startRow: 470, startCol: 2, endRow: 476, endCol: 4 }],
        },
      });
    });
    await grid.page.waitForTimeout(300);

    const rules = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_all_conditional_formats");
    });
    expect(rules.length).toBeGreaterThan(0);
  });

  test("step 6: create pivot table from sales data", async ({ gridPersistent: grid }) => {
    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("create_pivot_table", {
        request: {
          sourceRange: "A470:E476",
          destinationCell: "G470",
          hasHeaders: true,
        },
      });
    });
    await grid.page.waitForTimeout(500);

    expect(result).toBeDefined();
    expect(result.pivotId).toBeTruthy();

    // Add region as row field, sum of Total as value
    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("update_pivot_fields", {
        request: {
          pivotId: id,
          rowFields: [{ sourceIndex: 0, name: "Region" }],
          valueFields: [{ sourceIndex: 4, name: "Sum of Total", aggregation: "sum" }],
        },
      });
    }, result.pivotId);
    await grid.page.waitForTimeout(500);

    // Get pivot view — should have rows for each region
    const view = await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_pivot_view", { pivotId: id });
    }, result.pivotId);

    expect(view.rowCount).toBeGreaterThan(0);

    // Clean up pivot
    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_pivot_table", { pivotId: id });
    }, result.pivotId);
  });

  test("step 7: create chart from sales data", async ({ gridPersistent: grid }) => {
    const chartId = await grid.page.evaluate(() => crypto.randomUUID());
    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, startRow: 469, startCol: 0, endRow: 476, endCol: 4 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [
          { sourceIndex: 2, name: "Q1", color: "#4472C4" },
          { sourceIndex: 3, name: "Q2", color: "#ED7D31" },
        ],
        title: "Sales by Region",
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
    expect(charts.some((c: any) => c.id === chartId)).toBe(true);

    // Clean up chart
    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_chart", { id });
    }, chartId);
  });

  test.fixme("step 8: modify data and verify all dependent features update", async ({ gridPersistent: grid }) => {
    // Change North Widgets Q1 from 1200 to 2000
    await grid.setCellValueDirect("C471", "2000");
    await grid.page.waitForTimeout(300);

    // Total for that row: 2000 + 1500 = 3500
    const rowTotal = await grid.getCellLiveValue("E471");
    expect(rowTotal).toMatch(/3[\s,.\u00a0]?500/);

    // Grand total Q1: 2000+800+900+600+1400+500 = 6200
    const q1Total = await grid.getCellLiveValue("C478");
    expect(q1Total).toMatch(/6[\s,.\u00a0]?200/);

    // Grand total E column: should have increased by 800
    const grandTotal = await grid.getCellLiveValue("E478");
    const parsed = parseFloat(grandTotal.replace(/[^\d.,]/g, "").replace(",", "."));
    expect(parsed).toBe(12400);
  });
});
