//! FILENAME: app/e2e/scenarios/monthly-report.scenario.ts
// PURPOSE: Real-user workflow — building a monthly sales report:
//          enter data -> formulas -> sort -> table -> pivot -> chart ->
//          conditional formatting -> freeze panes.
//          The oracle battery (undo round-trip, save/reload, recalc) runs
//          after every phase; this is where feature INTERACTIONS get tested.

import { expect } from "../fixtures";
import { defineScenario, loadBlock, invokeTauri } from "./lib/scenario";

const SALES_DATA = [
  ["Month", "Region", "Sales", "Target"],
  ["Jan", "North", "4200", "4000"],
  ["Jan", "South", "3100", "3500"],
  ["Feb", "North", "4800", "4000"],
  ["Feb", "South", "2900", "3500"],
  ["Mar", "North", "5100", "4500"],
  ["Mar", "South", "3600", "3500"],
  ["Apr", "North", "4400", "4500"],
  ["Apr", "South", "3900", "3500"],
  ["May", "North", "5600", "5000"],
  ["May", "South", "4100", "4000"],
  ["Jun", "North", "6000", "5000"],
  ["Jun", "South", "4500", "4000"],
];

defineScenario("monthly-report", [
  {
    name: "enter sales data",
    behaviors: ["edit.bulk-entry"],
    async run({ page }) {
      await loadBlock(page, 0, 0, SALES_DATA); // A1:D13
    },
    async assertions({ grid }) {
      expect(await grid.getCellDisplayValue("A1")).toBe("Month");
      expect(await grid.getCellDisplayValue("C13")).toBe("4500");
    },
  },
  {
    name: "add variance formulas and totals",
    behaviors: ["recalc.formula-entry"],
    async run({ grid }) {
      // Variance column (formulas use ';' separators — sv-SE locale)
      await grid.setCellValueDirect("E1", "Variance");
      for (let row = 2; row <= 13; row++) {
        await grid.setCellValueDirect(`E${row}`, `=C${row}-D${row}`);
      }
      // Totals row
      await grid.setCellValueDirect("B15", "Total");
      await grid.setCellValueDirect("C15", "=SUM(C2:C13)");
      await grid.setCellValueDirect("D15", "=SUM(D2:D13)");
      await grid.setCellValueDirect("E15", "=IF(C15>D15;C15-D15;0)");
    },
    async assertions({ grid }) {
      expect(await grid.getCellDisplayValue("E2")).toBe("200");
      expect(await grid.getCellDisplayValue("C15")).toBe("52200");
      // Targets sum to 49000, so the IF yields 52200-49000.
      expect(await grid.getCellDisplayValue("E15")).toBe("3200");
    },
  },
  {
    name: "sort data by sales descending",
    behaviors: ["filter.sort-range", "recalc.sort-preserves-formulas"],
    async run({ page }) {
      // Sort the data block (not the header, not the totals row).
      await invokeTauri(page, "sort_range", {
        params: {
          startRow: 1,
          startCol: 0,
          endRow: 12,
          endCol: 4,
          fields: [{ key: 2, ascending: false }],
          matchCase: false,
          hasHeaders: false,
          orientation: "rows",
        },
      });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    },
    async assertions({ grid }) {
      // Highest sales (Jun North 6000) is now the first data row.
      expect(await grid.getCellDisplayValue("C2")).toBe("6000");
      expect(await grid.getCellDisplayValue("A2")).toBe("Jun");
      // Totals are unchanged by sorting.
      expect(await grid.getCellDisplayValue("C15")).toBe("52200");
    },
  },
  {
    name: "create a table over the data",
    behaviors: ["table.create-from-range"],
    async run({ page }) {
      await invokeTauri(page, "create_table", {
        params: {
          name: "SalesTable",
          startRow: 0,
          startCol: 0,
          endRow: 12,
          endCol: 4,
          hasHeaders: true,
          styleOptions: {
            totalRow: false,
            headerRow: true,
            bandedRows: true,
            bandedColumns: false,
            firstColumn: false,
            lastColumn: false,
            showFilterButton: true,
          },
        },
      });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    },
    async assertions({ page }) {
      const tables = (await invokeTauri(page, "get_all_tables", {})) as unknown[];
      expect(tables.length).toBe(1);
    },
    screenshot: "scenario-monthly-report-table",
  },
  {
    name: "build a pivot by region",
    behaviors: ["pivot.create-from-range", "undo.pivot-filter"],
    async run({ page }) {
      const result = (await invokeTauri(page, "create_pivot_table", {
        request: {
          sourceRange: "A1:E13",
          destinationCell: "H1",
          hasHeaders: true,
        },
      })) as { pivotId: string };
      expect(result.pivotId).toBeTruthy();

      await invokeTauri(page, "update_pivot_fields", {
        request: {
          pivotId: result.pivotId,
          rowFields: [{ sourceIndex: 1, name: "Region" }],
          valueFields: [{ sourceIndex: 2, name: "Sum of Sales", aggregation: "sum" }],
        },
      });
      await page.waitForTimeout(500);
    },
    async assertions({ page }) {
      const pivots = (await invokeTauri(page, "get_all_pivot_tables")) as unknown[];
      expect(pivots.length).toBeGreaterThan(0);
    },
  },
  {
    name: "add a sales chart",
    behaviors: ["chart.create-from-range", "undo.chart-lifecycle"],
    async run({ page }) {
      await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        const spec = {
          mark: "bar",
          data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 12, endCol: 2 },
          hasHeaders: true,
          seriesOrientation: "columns",
          categoryIndex: 0,
          series: [{ sourceIndex: 2, name: "Sales", color: "#4472C4" }],
          title: "Monthly Sales",
        };
        await tauri.core.invoke("save_chart", {
          entry: { id: crypto.randomUUID(), sheetIndex: 0, specJson: JSON.stringify(spec) },
        });
      });
      await page.waitForTimeout(400);
    },
    async assertions({ page }) {
      const charts = (await invokeTauri(page, "get_charts")) as unknown[];
      expect(charts.length).toBe(1);
    },
  },
  {
    name: "highlight above-target sales with conditional formatting",
    behaviors: ["cf.cell-value-rule"],
    async run({ page }) {
      await invokeTauri(page, "add_conditional_format", {
        params: {
          rule: { type: "cellValue", operator: "greaterThan", value1: "5000" },
          format: { backgroundColor: "#C6EFCE", textColor: "#006100" },
          ranges: [{ startRow: 1, startCol: 2, endRow: 12, endCol: 2 }],
          stopIfTrue: false,
        },
      });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    },
    async assertions({ page }) {
      const all = (await invokeTauri(page, "get_all_conditional_formats")) as unknown[];
      expect(Array.isArray(all) ? all.length : 1).toBeGreaterThan(0);
    },
  },
  {
    name: "freeze the header row",
    behaviors: ["ui.freeze-panes"],
    async run({ page }) {
      await invokeTauri(page, "set_freeze_panes", { freezeRow: 1, freezeCol: null });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    },
    screenshot: "scenario-monthly-report-final",
  },
]);
