//! FILENAME: app/e2e/invariants/actions.ts
// PURPOSE: Catalog of actions the monkey runner can execute. Each action has a
//          precondition (is it valid to run now?), an execute function, and a
//          weight for random selection.

import type { Page } from "@playwright/test";
import type { GridHelper } from "../helpers/grid";
import type { StateSnapshot } from "./stateSnapshot";

// ============================================================================
// Types
// ============================================================================

export interface Action {
  id: string;
  category: string;
  /** Relative probability of being chosen (higher = more likely) */
  weight: number;
  /** Can this action run in the current state? */
  precondition: (snapshot: StateSnapshot) => boolean;
  /** Execute the action */
  execute: (page: Page, grid: GridHelper) => Promise<void>;
}

// ============================================================================
// Helper: dispatch key on spreadsheet grid
// ============================================================================

async function dispatchKeyOnGrid(page: Page, key: string, ctrlKey = false) {
  const spreadsheet = page.locator("[data-focus-container='spreadsheet']");
  await spreadsheet.focus();
  await spreadsheet.evaluate(
    (el, opts) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: opts.key,
          ctrlKey: opts.ctrlKey,
          bubbles: true,
          cancelable: true,
        })
      );
    },
    { key, ctrlKey }
  );
}

// ============================================================================
// Slicer Actions
// ============================================================================

const slicerCreate: Action = {
  id: "slicer.create",
  category: "slicer",
  weight: 3,
  precondition: (s) => s.logical.tables.length > 0,
  async execute(page, _grid) {
    const slicerId = await page.evaluate(async () => {
      const slicerApi = (window as any).__CALCULA_SLICER__;
      if (!slicerApi) return null;
      const tauri = (window as any).__TAURI__;
      const tables = await tauri.core.invoke("get_all_tables", {});
      if (!tables || tables.length === 0) return null;
      const table = tables[0];
      const fieldName = table.columns?.[0]?.name ?? "Column1";
      const slicer = await slicerApi.createSlicerAsync({
        name: `Slicer_${Date.now()}`,
        sheetIndex: 0,
        x: 500,
        y: 50,
        width: 200,
        height: 250,
        sourceType: "table",
        cacheSourceId: table.id,
        fieldName,
        connectedSources: [{ sourceType: "table", sourceId: table.id }],
        columns: 1,
      });
      return slicer?.id ?? null;
    });
    if (slicerId != null) {
      await page.evaluate((id: number) => {
        (window as any).__CALCULA_SLICER__?.selectSlicer(id);
      }, slicerId);
      await page.waitForTimeout(300);
    }
  },
};

const slicerDelete: Action = {
  id: "slicer.delete",
  category: "slicer",
  weight: 3,
  precondition: (s) => s.logical.slicers.length > 0,
  async execute(page, _grid) {
    await page.evaluate(async () => {
      const slicerApi = (window as any).__CALCULA_SLICER__;
      if (!slicerApi) return;
      const slicers = slicerApi.getAllSlicers();
      if (!slicers || slicers.length === 0) return;
      await slicerApi.deleteSlicerAsync(slicers[0].id);
    });
    await page.waitForTimeout(300);
  },
};

const slicerClickAway: Action = {
  id: "slicer.click-away",
  category: "deselect",
  weight: 2,
  precondition: () => true,
  async execute(_page, grid) {
    await grid.clickCell("A1");
    await grid.page.waitForTimeout(200);
  },
};

// ============================================================================
// Chart Actions
// ============================================================================

const chartCreate: Action = {
  id: "chart.create",
  category: "chart",
  weight: 3,
  precondition: () => true,
  async execute(page, grid) {
    await grid.setCellValueDirect("Z1", "Category");
    await grid.setCellValueDirect("AA1", "Value");
    await grid.setCellValueDirect("Z2", "A");
    await grid.setCellValueDirect("AA2", "10");
    await grid.setCellValueDirect("Z3", "B");
    await grid.setCellValueDirect("AA3", "20");

    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const id = crypto.randomUUID();
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, startRow: 0, startCol: 25, endRow: 2, endCol: 26 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Value", color: "#4472C4" }],
        title: `Chart_${Date.now()}`,
      };
      await tauri.core.invoke("save_chart", {
        entry: { id, sheetIndex: 0, specJson: JSON.stringify(spec) },
      });
    });
    await page.waitForTimeout(300);
  },
};

const chartDelete: Action = {
  id: "chart.delete",
  category: "chart",
  weight: 3,
  precondition: (s) => s.logical.charts.length > 0,
  async execute(page, _grid) {
    // Use the frontend store's deleteChart which handles cleanup
    await page.evaluate(() => {
      const chartApi = (window as any).__CALCULA_CHARTS__;
      if (!chartApi) return;
      const charts = chartApi.getAllCharts();
      if (charts && charts.length > 0) {
        chartApi.deleteChart(charts[0].id);
        chartApi.syncChartRegions();
      }
    });
    await page.waitForTimeout(300);
  },
};

const chartSelect: Action = {
  id: "chart.select",
  category: "chart",
  weight: 2,
  precondition: (s) => s.logical.charts.length > 0,
  async execute(page, _grid) {
    await page.evaluate(() => {
      const chartApi = (window as any).__CALCULA_CHARTS__;
      if (!chartApi) return;
      const charts = chartApi.getAllCharts();
      if (charts && charts.length > 0) {
        chartApi.selectChart(charts[0].id);
      }
    });
    await page.waitForTimeout(200);
  },
};

const chartDeselect: Action = {
  id: "chart.deselect",
  category: "deselect",
  weight: 2,
  precondition: () => true,
  async execute(page, _grid) {
    await page.evaluate(() => {
      const chartApi = (window as any).__CALCULA_CHARTS__;
      chartApi?.deselectChart();
    });
    await page.waitForTimeout(100);
  },
};

// ============================================================================
// Table Actions
// ============================================================================

const tableCreate: Action = {
  id: "table.create",
  category: "table",
  weight: 3,
  precondition: () => true,
  async execute(page, grid) {
    const col = "AE";
    const col2 = "AF";
    const col3 = "AG";
    await grid.setCellValueDirect(`${col}1`, "Name");
    await grid.setCellValueDirect(`${col2}1`, "Age");
    await grid.setCellValueDirect(`${col3}1`, "City");
    await grid.setCellValueDirect(`${col}2`, "Alice");
    await grid.setCellValueDirect(`${col2}2`, "30");
    await grid.setCellValueDirect(`${col3}2`, "London");
    await grid.setCellValueDirect(`${col}3`, "Bob");
    await grid.setCellValueDirect(`${col2}3`, "25");
    await grid.setCellValueDirect(`${col3}3`, "Paris");

    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("create_table", {
        params: {
          name: "",
          startRow: 0,
          startCol: 30,
          endRow: 2,
          endCol: 32,
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
    });
    await page.waitForTimeout(300);
  },
};

const tableDelete: Action = {
  id: "table.delete",
  category: "table",
  weight: 3,
  precondition: (s) => s.logical.tables.length > 0,
  async execute(page, _grid) {
    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const tables = await tauri.core.invoke("get_all_tables", {});
      if (tables && tables.length > 0) {
        await tauri.core.invoke("delete_table", { tableId: tables[0].id });
      }
    });
    await page.waitForTimeout(300);
  },
};

const tableSelectInto: Action = {
  id: "table.select-into",
  category: "table",
  weight: 2,
  precondition: (s) => s.logical.tables.length > 0,
  async execute(_page, grid) {
    // Navigate into the table area to trigger the Table Design tab
    await grid.navigateTo("AE2");
    await grid.page.waitForTimeout(300);
  },
};

const tableSelectAway: Action = {
  id: "table.select-away",
  category: "deselect",
  weight: 2,
  precondition: () => true,
  async execute(_page, grid) {
    // Navigate away from any table to dismiss the Table Design tab
    await grid.navigateTo("A1");
    await grid.page.waitForTimeout(200);
  },
};

// ============================================================================
// Sparkline Actions
// ============================================================================

const sparklineCreate: Action = {
  id: "sparkline.create",
  category: "sparkline",
  weight: 2,
  precondition: () => true,
  async execute(page, grid) {
    // Ensure some data exists for the sparkline
    await grid.setCellValueDirect("AP1", "10");
    await grid.setCellValueDirect("AQ1", "20");
    await grid.setCellValueDirect("AR1", "15");
    await grid.setCellValueDirect("AS1", "30");

    await page.evaluate(() => {
      const sparkApi = (window as any).__CALCULA_SPARKLINES__;
      if (!sparkApi) return;
      // Create a sparkline in AT1 with data from AP1:AS1
      sparkApi.createSparklineGroup(
        { startRow: 0, startCol: 45, endRow: 0, endCol: 45 }, // location: AT1
        { startRow: 0, startCol: 41, endRow: 0, endCol: 44 }, // data: AP1:AS1
        "line"
      );
    });
    await page.waitForTimeout(300);
  },
};

const sparklineDelete: Action = {
  id: "sparkline.delete",
  category: "sparkline",
  weight: 2,
  precondition: (s) => s.logical.sparklineGroups.length > 0,
  async execute(page, _grid) {
    await page.evaluate(() => {
      const sparkApi = (window as any).__CALCULA_SPARKLINES__;
      if (!sparkApi) return;
      const groups = sparkApi.getAllGroups();
      if (groups && groups.length > 0) {
        sparkApi.removeSparklineGroup(groups[0].id);
      }
    });
    await page.waitForTimeout(200);
  },
};

const sparklineSelectInto: Action = {
  id: "sparkline.select-into",
  category: "sparkline",
  weight: 2,
  precondition: (s) => s.logical.sparklineGroups.length > 0,
  async execute(_page, grid) {
    // Navigate to sparkline cell to trigger the Sparkline Design tab
    await grid.navigateTo("AT1");
    await grid.page.waitForTimeout(300);
  },
};

// ============================================================================
// Row/Column Structure Actions
// ============================================================================

const insertRow: Action = {
  id: "structure.insert-row",
  category: "structure",
  weight: 1,
  precondition: () => true,
  async execute(page, grid) {
    // Insert a row at a safe position (row 50, far from test data)
    await grid.navigateTo("A50");
    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("insert_rows", { startRow: 49, count: 1 }).catch(() => {});
    });
    await page.waitForTimeout(200);
  },
};

const deleteRow: Action = {
  id: "structure.delete-row",
  category: "structure",
  weight: 1,
  precondition: () => true,
  async execute(page, grid) {
    // Delete a row at a safe position (row 50)
    await grid.navigateTo("A50");
    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_rows", { startRow: 49, count: 1 }).catch(() => {});
    });
    await page.waitForTimeout(200);
  },
};

const insertColumn: Action = {
  id: "structure.insert-col",
  category: "structure",
  weight: 1,
  precondition: () => true,
  async execute(page, _grid) {
    // Insert a column at a safe position (col 60, far from test data)
    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("insert_columns", { startCol: 59, count: 1 }).catch(() => {});
    });
    await page.waitForTimeout(200);
  },
};

const deleteColumn: Action = {
  id: "structure.delete-col",
  category: "structure",
  weight: 1,
  precondition: () => true,
  async execute(page, _grid) {
    // Delete a column at a safe position (col 60)
    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_columns", { startCol: 59, count: 1 }).catch(() => {});
    });
    await page.waitForTimeout(200);
  },
};

// ============================================================================
// Cell / Selection Actions
// ============================================================================

const CELL_REFS = [
  "A1", "B2", "C3", "D4", "E5", "A10", "B15", "C20", "D1", "E2",
  "F3", "G4", "H5", "A30", "B30",
];

const cellClick: Action = {
  id: "cell.click",
  category: "selection",
  weight: 5,
  precondition: () => true,
  async execute(_page, grid) {
    const ref = CELL_REFS[Math.floor(Math.random() * CELL_REFS.length)];
    await grid.clickCell(ref);
    await grid.page.waitForTimeout(100);
  },
};

const cellEdit: Action = {
  id: "cell.edit",
  category: "editing",
  weight: 2,
  precondition: () => true,
  async execute(_page, grid) {
    const ref = CELL_REFS[Math.floor(Math.random() * CELL_REFS.length)];
    await grid.setCellValueDirect(ref, `Test${Date.now()}`);
    await grid.page.waitForTimeout(100);
  },
};

const cellEscape: Action = {
  id: "cell.escape",
  category: "editing",
  weight: 2,
  precondition: () => true,
  async execute(page, _grid) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
  },
};

// ============================================================================
// Formatting Actions
// ============================================================================

const formatBold: Action = {
  id: "format.bold",
  category: "formatting",
  weight: 1,
  precondition: () => true,
  async execute(page, grid) {
    await grid.clickCell("A1");
    await dispatchKeyOnGrid(page, "b", true);
    await page.waitForTimeout(100);
  },
};

const formatItalic: Action = {
  id: "format.italic",
  category: "formatting",
  weight: 1,
  precondition: () => true,
  async execute(page, grid) {
    await grid.clickCell("A1");
    await dispatchKeyOnGrid(page, "i", true);
    await page.waitForTimeout(100);
  },
};

// ============================================================================
// Undo/Redo Actions
// ============================================================================

const undo: Action = {
  id: "undo",
  category: "undo-redo",
  weight: 2,
  precondition: () => true,
  async execute(_page, grid) {
    await grid.undo();
    await grid.page.waitForTimeout(200);
  },
};

const redo: Action = {
  id: "redo",
  category: "undo-redo",
  weight: 1,
  precondition: () => true,
  async execute(_page, grid) {
    await grid.redo();
    await grid.page.waitForTimeout(200);
  },
};

// ============================================================================
// Ribbon Tab Switching Actions
// ============================================================================

const STANDARD_TABS = ["Home", "Insert", "Page Layout", "Formulas", "Data", "View"];

const switchRibbonTab: Action = {
  id: "ribbon.switch-tab",
  category: "ui",
  weight: 2,
  precondition: () => true,
  async execute(page, _grid) {
    const tabName = STANDARD_TABS[Math.floor(Math.random() * STANDARD_TABS.length)];
    const tabBtn = page.locator("button").filter({ hasText: tabName }).first();
    if (await tabBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await tabBtn.click();
      await page.waitForTimeout(200);
      if (tabName !== "Home") {
        const homeBtn = page.locator("button").filter({ hasText: "Home" }).first();
        if (await homeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await homeBtn.click();
          await page.waitForTimeout(100);
        }
      }
    }
  },
};

// ============================================================================
// Navigation Actions
// ============================================================================

const navigateViaNameBox: Action = {
  id: "nav.name-box",
  category: "navigation",
  weight: 1,
  precondition: () => true,
  async execute(page, _grid) {
    const refs = ["A1", "A50", "E10", "J1", "A100"];
    const ref = refs[Math.floor(Math.random() * refs.length)];
    const nameBox = page.locator('input[aria-label="Name Box"]');
    await nameBox.click();
    await nameBox.fill(ref);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
  },
};

// ============================================================================
// Export: Full Action Catalog
// ============================================================================

export const ACTION_CATALOG: Action[] = [
  // Slicer lifecycle
  slicerCreate,
  slicerDelete,
  slicerClickAway,
  // Chart lifecycle
  chartCreate,
  chartDelete,
  chartSelect,
  chartDeselect,
  // Table lifecycle
  tableCreate,
  tableDelete,
  tableSelectInto,
  tableSelectAway,
  // Sparkline lifecycle
  sparklineCreate,
  sparklineDelete,
  sparklineSelectInto,
  // Row/Column structure
  insertRow,
  deleteRow,
  insertColumn,
  deleteColumn,
  // Selection
  cellClick,
  cellEdit,
  cellEscape,
  // Formatting
  formatBold,
  formatItalic,
  // Undo/Redo
  undo,
  redo,
  // UI
  switchRibbonTab,
  // Navigation
  navigateViaNameBox,
];
