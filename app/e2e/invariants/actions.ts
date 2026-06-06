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
// Helper: Tauri invoke from page context
// ============================================================================

async function tauriInvoke(page: Page, command: string, args: Record<string, unknown> = {}): Promise<any> {
  return page.evaluate(
    async ([cmd, a]) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke(cmd, a);
    },
    [command, args] as const
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
    // Use the frontend store's createSlicerAsync which handles overlay
    // registration, item fetching, and event dispatch — the full UI lifecycle.
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
      // Select the slicer — this registers the contextual ribbon tab,
      // which is the behavior we want to test.
      await page.evaluate((id: number) => {
        const slicerApi = (window as any).__CALCULA_SLICER__;
        slicerApi?.selectSlicer(id);
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
    // Use the frontend store's deleteSlicerAsync which dispatches
    // SLICER_DELETED — triggering the cleanup we're testing.
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
  category: "slicer",
  weight: 2,
  precondition: () => true,
  async execute(_page, grid) {
    // Click on a neutral cell to deselect any slicer
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
    // First ensure there's some data for the chart
    await grid.setCellValueDirect("Z1", "Category");
    await grid.setCellValueDirect("AA1", "Value");
    await grid.setCellValueDirect("Z2", "A");
    await grid.setCellValueDirect("AA2", "10");
    await grid.setCellValueDirect("Z3", "B");
    await grid.setCellValueDirect("AA3", "20");

    const chartId = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const id = crypto.randomUUID();
      const spec = {
        mark: "bar",
        data: {
          sheetIndex: 0,
          startRow: 0,
          startCol: 25,
          endRow: 2,
          endCol: 26,
        },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Value", color: "#4472C4" }],
        title: `Chart_${Date.now()}`,
      };
      await tauri.core.invoke("save_chart", {
        entry: { id, sheetIndex: 0, specJson: JSON.stringify(spec) },
      });
      return id;
    });
    if (chartId) {
      await page.waitForTimeout(300);
    }
  },
};

const chartDelete: Action = {
  id: "chart.delete",
  category: "chart",
  weight: 3,
  precondition: (s) => s.logical.charts.length > 0,
  async execute(page, _grid) {
    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const charts = await tauri.core.invoke("get_charts");
      if (charts && charts.length > 0) {
        await tauri.core.invoke("delete_chart", { id: charts[0].id });
      }
    });
    await page.waitForTimeout(300);
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
    // Put some data in a fresh area for the table
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
          startCol: 30, // Column AE = 30
          endRow: 2,
          endCol: 32, // Column AG = 32
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

// ============================================================================
// Cell / Selection Actions
// ============================================================================

/** Random cell references for click targets */
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
    // Use keyboard shortcut dispatched directly on the grid element.
    // Clicking the ribbon button can be blocked by overlapping ribbon tab
    // content (e.g. "Page Break Preview" from the View tab).
    const spreadsheet = page.locator("[data-focus-container='spreadsheet']");
    await spreadsheet.focus();
    await spreadsheet.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent("keydown", {
        key: "b", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
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
    const spreadsheet = page.locator("[data-focus-container='spreadsheet']");
    await spreadsheet.focus();
    await spreadsheet.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent("keydown", {
        key: "i", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
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
      // Switch back to Home to avoid leaving ribbon content from View/Page Layout
      // that can overlap and block clicks on other ribbon elements.
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
  // Table lifecycle
  tableCreate,
  tableDelete,
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
