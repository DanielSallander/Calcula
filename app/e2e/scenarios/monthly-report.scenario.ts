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
      // THE PRODUCT'S OWN CREATE, not a raw `save_chart` invoke. This is the
      // same lesson the walker's `chart.create` learned as BUG-0031 and it is
      // the ROOT CAUSE of BUG-0075, measured end to end on 2026-08-15:
      //
      //   `save_chart` persists the chart and tells the chart STORE nothing, so
      //   the run ends with `get_charts` answering 1 while
      //   `__CALCULA_CHARTS__.getAllCharts()` answers 0. The NEXT scenario's
      //   `deepResetForWalk` tears charts down by enumerating that store, finds
      //   it empty, and deletes nothing — so the backend chart survives the
      //   teardown. Moments later, still inside the same reset, deleting this
      //   scenario's TABLE announces the `objects` domain (ObjectKind::Table ->
      //   UiDomain::Objects), the Shell fans it out to `charts:refresh`, and
      //   the extension reloads its store from a backend that STILL HOLDS this
      //   chart. `new_file` then clears the backend and nothing re-syncs the
      //   store, so a chart with no document behind it paints over the NEXT
      //   scenario's sheet and was photographed by `scenario-budget-model-title`
      //   (173,986 differing pixels).
      //
      // `createChart` is what Insert > Chart calls: it pushes into the store AND
      // persists through the same `save_chart`, so the backend sees exactly what
      // it saw before and the store is no longer blind.
      await page.evaluate(async () => {
        const spec = {
          mark: "bar",
          data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 12, endCol: 2 },
          hasHeaders: true,
          seriesOrientation: "columns",
          categoryIndex: 0,
          series: [{ sourceIndex: 2, name: "Sales", color: "#4472C4" }],
          title: "Monthly Sales",
        };
        const store = (await (window as any).__calcImport(
          new URL("/extensions/Charts/lib/chartStore.ts", document.baseURI).href,
        )) as {
          createChart?: (spec: unknown, placement: Record<string, unknown>) => { chartId: string };
          syncChartRegions?: () => void;
        };
        if (!store?.createChart) {
          throw new Error(
            "monthly-report: the chart store exposes no createChart — refusing to " +
              "fall back to a raw save_chart invoke, which is what BUG-0075 was.",
          );
        }
        store.createChart(spec, {
          sheetIndex: 0,
          x: 100,
          y: 100,
          width: 600,
          height: 400,
          name: "Monthly Sales",
        });
        store.syncChartRegions?.();
      });
      await page.waitForTimeout(400);
    },
    async assertions({ page }) {
      const charts = (await invokeTauri(page, "get_charts")) as unknown[];
      expect(charts.length).toBe(1);
      // THE TWO STORES MUST AGREE, and this is the assertion that keeps the
      // raw-invoke shortcut from coming back: a backend chart the frontend
      // store has never heard of is precisely the state BUG-0075 needed.
      const storeCount = await page.evaluate(
        () => ((window as any).__CALCULA_CHARTS__?.getAllCharts?.() ?? []).length,
      );
      expect(
        storeCount,
        "the frontend chart store must know about the chart the backend just persisted",
      ).toBe(1);
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
    // SCREENSHOT DISABLED — blocked on a product bug, not on a stale baseline.
    //
    // This phase runs after phase 05 builds a pivot, and the pivot's progress
    // indicator ("Updating grid... (4/4)" plus a Cancel button) is still painted
    // over the grid here, permanently. Cause: the backend emits its final
    // pivot:progress event immediately before the command returns
    // (src-tauri/src/pivot/commands.rs:786), Tauri events and command responses
    // travel on separate channels, and the frontend listener
    // (extensions/Pivot/index.ts:1976) calls setLoading() unconditionally. So the
    // last progress event can land AFTER the command resolved and the pivot-api
    // `finally { clearLoading }` already ran, re-arming the indicator with
    // nothing left to clear it.
    //
    // Verified stuck, not racing: identical across two independent cold runs and
    // unchanged by a 6s waitForVisualStability. Recording this golden would
    // enshrine the defect permanently, so the capture stays off until the
    // listener ignores progress for a pivot with no in-flight operation.
    // Re-enable by restoring: screenshot: "scenario-monthly-report-final",
  },
]);
