//! FILENAME: app/e2e/scenarios/data-cleanup.scenario.ts
// PURPOSE: Real-user workflow — cleaning up imported data:
//          messy import -> find/replace cleanup -> formula column extended
//          with fill -> sort -> autofilter with a value filter -> clear
//          filter. Exercises bulk edits + structure under the oracles.

import { expect } from "../fixtures";
import { defineScenario, loadBlock, invokeTauri } from "./lib/scenario";

const MESSY_DATA = [
  ["Id", "Product", "Qty", "Price"],
  ["1", "raw_Widget", "4", "25"],
  ["2", "raw_Gadget", "2", "120"],
  ["3", "raw_Widget", "7", "25"],
  ["4", "raw_Doohickey", "1", "310"],
  ["5", "raw_Gadget", "5", "120"],
  ["6", "raw_Widget", "3", "25"],
  ["7", "raw_Doohickey", "2", "310"],
  ["8", "raw_Gadget", "6", "120"],
];

defineScenario("data-cleanup", [
  {
    name: "import messy data",
    behaviors: ["edit.bulk-entry"],
    async run({ page }) {
      await loadBlock(page, 0, 0, MESSY_DATA); // A1:D9
    },
    async assertions({ grid }) {
      expect(await grid.getCellDisplayValue("B2")).toBe("raw_Widget");
      expect(await grid.getCellDisplayValue("D9")).toBe("120");
    },
  },
  {
    name: "clean prefixes with replace-all",
    behaviors: ["edit.replace-all"],
    async run({ page }) {
      await invokeTauri(page, "replace_all", {
        search: "raw_",
        replacement: "",
        caseSensitive: true,
        matchEntireCell: false,
      });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    },
    async assertions({ grid }) {
      expect(await grid.getCellDisplayValue("B2")).toBe("Widget");
      expect(await grid.getCellDisplayValue("B5")).toBe("Doohickey");
    },
  },
  {
    name: "add a line-total formula and fill it down",
    behaviors: ["edit.fill-down", "recalc.formula-entry"],
    async run({ page, grid }) {
      await grid.setCellValueDirect("E1", "Total");
      await grid.setCellValueDirect("E2", "=C2*D2");
      // Fill E2 down to E9 via the fill backend (Ctrl+D equivalent).
      await invokeTauri(page, "fill_range", {
        sourceStartRow: 1,
        sourceStartCol: 4,
        sourceEndRow: 1,
        sourceEndCol: 4,
        targetStartRow: 2,
        targetStartCol: 4,
        targetEndRow: 8,
        targetEndCol: 4,
      });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.waitForTimeout(300);
    },
    async assertions({ grid }) {
      expect(await grid.getCellDisplayValue("E2")).toBe("100");
      // Row 5: Doohickey 1 * 310 — the filled formula must have shifted.
      expect(await grid.getCellDisplayValue("E5")).toBe("310");
      expect(await grid.getCellDisplayValue("E9")).toBe("720");
    },
  },
  {
    name: "sort by line total descending",
    behaviors: ["filter.sort-range", "recalc.sort-preserves-formulas"],
    async run({ page }) {
      await invokeTauri(page, "sort_range", {
        params: {
          startRow: 1,
          startCol: 0,
          endRow: 8,
          endCol: 4,
          fields: [{ key: 4, ascending: false }],
          matchCase: false,
          hasHeaders: false,
          orientation: "rows",
        },
      });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    },
    async assertions({ grid }) {
      // Highest total first: Gadget 8 -> 6*120 = 720
      expect(await grid.getCellDisplayValue("E2")).toBe("720");
    },
  },
  {
    name: "filter to a single product",
    behaviors: ["filter.autofilter-values"],
    async run({ page }) {
      await invokeTauri(page, "apply_auto_filter", {
        params: { startRow: 0, startCol: 0, endRow: 8, endCol: 4 },
      });
      await invokeTauri(page, "set_column_filter_values", {
        columnIndex: 1,
        values: ["Widget"],
        includeBlanks: false,
      });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.waitForTimeout(300);
    },
    async assertions({ page }) {
      const hidden = (await invokeTauri(page, "get_hidden_rows")) as number[];
      // 5 non-Widget data rows must be hidden.
      expect(Array.isArray(hidden) ? hidden.length : 0).toBe(5);
    },
    screenshot: "scenario-data-cleanup-filtered",
  },
  {
    name: "clear the filter",
    behaviors: ["filter.remove"],
    async run({ page }) {
      await invokeTauri(page, "remove_auto_filter", {});
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.waitForTimeout(300);
    },
    async assertions({ page }) {
      const hidden = (await invokeTauri(page, "get_hidden_rows")) as number[];
      expect(Array.isArray(hidden) ? hidden.length : 0).toBe(0);
    },
  },
]);
