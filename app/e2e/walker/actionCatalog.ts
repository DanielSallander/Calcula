//! FILENAME: app/e2e/walker/actionCatalog.ts
// PURPOSE: Action catalog v2 for the random walker. Differences from the v1
//          catalog (app/e2e/invariants/actions.ts):
//            1. DETERMINISTIC: all randomness flows through an injected rng
//               and a sequence number — no Math.random()/Date.now(). The
//               chosen parameters are JSON-serializable and recorded in the
//               trace, so any walk can be replayed and minimized exactly.
//            2. BROADER: covers merge, fill, sort, autofilter, sheets, named
//               ranges, conditional formatting, data validation, freeze
//               panes, comments/notes/hyperlinks, find/replace, row/col
//               sizing and clipboard — not just object lifecycle.
//
// Locale note (sv-SE): formulas entered through setCellValueDirect go through
// update_cell which DElocalizes input — argument separators must be ';' and
// test data sticks to integers to avoid decimal-separator ambiguity.

import type { Page } from "@playwright/test";
import type { GridHelper } from "../helpers/grid";
import type { StateSnapshot } from "../invariants/stateSnapshot";
import type { ActionInstance } from "./trace";

// ============================================================================
// Types
// ============================================================================

export interface ActionDef<P extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  category: string;
  /** Relative probability of being chosen (higher = more likely) */
  weight: number;
  /** Can this action run in the current state? Re-checked on replay. */
  precondition: (snapshot: StateSnapshot) => boolean;
  /** Choose concrete, JSON-serializable parameters. All randomness MUST come
   *  from `rng`; use `seq` (the step number) for unique names. */
  pickParams: (rng: () => number, snapshot: StateSnapshot, seq: number) => P;
  /** Execute with previously chosen parameters. */
  execute: (page: Page, grid: GridHelper, params: P) => Promise<void>;
}

// Catalog entries are heterogeneous in their param types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDef = ActionDef<any>;

export function findAction(id: string, catalog: AnyActionDef[] = FULL_ACTION_CATALOG): AnyActionDef | undefined {
  return catalog.find((a) => a.id === id);
}

/** Execute a concrete action instance (used by trace replay). */
export async function executeInstance(
  page: Page,
  grid: GridHelper,
  instance: ActionInstance,
  catalog: AnyActionDef[] = FULL_ACTION_CATALOG
): Promise<void> {
  const def = findAction(instance.id, catalog);
  if (!def) throw new Error(`Unknown action id in trace: ${instance.id}`);
  await def.execute(page, grid, instance.params);
}

// ============================================================================
// Helpers
// ============================================================================

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function pickInt(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

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

async function invokeTauri(page: Page, command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return page.evaluate(
    async ({ command, args }) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke(command, args);
    },
    { command, args }
  );
}

// Cell refs used by selection/editing actions (kept from v1).
const CELL_REFS = [
  "A1", "B2", "C3", "D4", "E5", "A10", "B15", "C20", "D1", "E2",
  "F3", "G4", "H5", "A30", "B30",
] as const;

// Formulas use ';' argument separators (sv-SE locale, see header note).
const FORMULAS = [
  "=SUM(A1:A10)",
  "=A1&B2",
  "=IF(A1>0;1;0)",
  "=AVERAGE(B1:B10)",
  "=COUNT(A1:A30)",
  "=MAX(A1:E5)",
] as const;

// Safe areas (0-based coordinates) — keep features from trampling each other:
//   chart data Z1:AA3 (cols 25-26), table AE1:AG3 (cols 30-32),
//   sparkline AP1:AT1 (cols 41-45), structure ops row 50 / col 60,
//   merge A60:F70, fill AH60 (col 33), sort AJ60:AK63 (cols 35-36),
//   validation AM60:AM65 (col 38), CF AN60:AN65 (col 39).

// ============================================================================
// Slicer actions
// ============================================================================

const slicerCreate: ActionDef<{ name: string }> = {
  id: "slicer.create",
  category: "slicer",
  weight: 3,
  precondition: (s) => s.logical.tables.length > 0,
  pickParams: (_rng, _s, seq) => ({ name: `Slicer_${seq}` }),
  async execute(page, _grid, p) {
    const slicerId = await page.evaluate(async (name: string) => {
      const slicerApi = (window as any).__CALCULA_SLICER__;
      if (!slicerApi) return null;
      const tauri = (window as any).__TAURI__;
      const tables = await tauri.core.invoke("get_all_tables", {});
      if (!tables || tables.length === 0) return null;
      const table = tables[0];
      const fieldName = table.columns?.[0]?.name ?? "Column1";
      const slicer = await slicerApi.createSlicerAsync({
        name,
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
    }, p.name);
    if (slicerId != null) {
      await page.evaluate((id: number) => {
        (window as any).__CALCULA_SLICER__?.selectSlicer(id);
      }, slicerId);
      await page.waitForTimeout(300);
    }
  },
};

const slicerDelete: ActionDef<Record<string, never>> = {
  id: "slicer.delete",
  category: "slicer",
  weight: 3,
  precondition: (s) => s.logical.slicers.length > 0,
  pickParams: () => ({}),
  async execute(page) {
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

const slicerClickAway: ActionDef<Record<string, never>> = {
  id: "slicer.click-away",
  category: "deselect",
  weight: 2,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(_page, grid) {
    await grid.clickCell("A1");
    await grid.page.waitForTimeout(200);
  },
};

// ============================================================================
// Chart actions
// ============================================================================

const chartCreate: ActionDef<{ title: string }> = {
  id: "chart.create",
  category: "chart",
  weight: 3,
  precondition: () => true,
  pickParams: (_rng, _s, seq) => ({ title: `Chart_${seq}` }),
  async execute(page, grid, p) {
    await grid.setCellValueDirect("Z1", "Category");
    await grid.setCellValueDirect("AA1", "Value");
    await grid.setCellValueDirect("Z2", "A");
    await grid.setCellValueDirect("AA2", "10");
    await grid.setCellValueDirect("Z3", "B");
    await grid.setCellValueDirect("AA3", "20");

    await page.evaluate(async (title: string) => {
      const tauri = (window as any).__TAURI__;
      const id = crypto.randomUUID();
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, startRow: 0, startCol: 25, endRow: 2, endCol: 26 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Value", color: "#4472C4" }],
        title,
      };
      await tauri.core.invoke("save_chart", {
        entry: { id, sheetIndex: 0, specJson: JSON.stringify(spec) },
      });
    }, p.title);
    await page.waitForTimeout(300);
  },
};

const chartDelete: ActionDef<Record<string, never>> = {
  id: "chart.delete",
  category: "chart",
  weight: 3,
  precondition: (s) => s.logical.charts.length > 0,
  pickParams: () => ({}),
  async execute(page) {
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

const chartSelect: ActionDef<Record<string, never>> = {
  id: "chart.select",
  category: "chart",
  weight: 2,
  precondition: (s) => s.logical.charts.length > 0,
  pickParams: () => ({}),
  async execute(page) {
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

const chartDeselect: ActionDef<Record<string, never>> = {
  id: "chart.deselect",
  category: "deselect",
  weight: 2,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page) {
    await page.evaluate(() => {
      const chartApi = (window as any).__CALCULA_CHARTS__;
      chartApi?.deselectChart();
    });
    await page.waitForTimeout(100);
  },
};

// ============================================================================
// Table actions
// ============================================================================

const tableCreate: ActionDef<Record<string, never>> = {
  id: "table.create",
  category: "table",
  weight: 3,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page, grid) {
    await grid.setCellValueDirect("AE1", "Name");
    await grid.setCellValueDirect("AF1", "Age");
    await grid.setCellValueDirect("AG1", "City");
    await grid.setCellValueDirect("AE2", "Alice");
    await grid.setCellValueDirect("AF2", "30");
    await grid.setCellValueDirect("AG2", "London");
    await grid.setCellValueDirect("AE3", "Bob");
    await grid.setCellValueDirect("AF3", "25");
    await grid.setCellValueDirect("AG3", "Paris");

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

const tableDelete: ActionDef<Record<string, never>> = {
  id: "table.delete",
  category: "table",
  weight: 3,
  precondition: (s) => s.logical.tables.length > 0,
  pickParams: () => ({}),
  async execute(page) {
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

const tableSelectInto: ActionDef<Record<string, never>> = {
  id: "table.select-into",
  category: "table",
  weight: 2,
  precondition: (s) => s.logical.tables.length > 0,
  pickParams: () => ({}),
  async execute(_page, grid) {
    await grid.navigateTo("AE2");
    await grid.page.waitForTimeout(300);
  },
};

const tableSelectAway: ActionDef<Record<string, never>> = {
  id: "table.select-away",
  category: "deselect",
  weight: 2,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(_page, grid) {
    await grid.navigateTo("A1");
    await grid.page.waitForTimeout(200);
  },
};

// ============================================================================
// Sparkline actions
// ============================================================================

const sparklineCreate: ActionDef<Record<string, never>> = {
  id: "sparkline.create",
  category: "sparkline",
  weight: 2,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page, grid) {
    await grid.setCellValueDirect("AP1", "10");
    await grid.setCellValueDirect("AQ1", "20");
    await grid.setCellValueDirect("AR1", "15");
    await grid.setCellValueDirect("AS1", "30");

    await page.evaluate(() => {
      const sparkApi = (window as any).__CALCULA_SPARKLINES__;
      if (!sparkApi) return;
      sparkApi.createSparklineGroup(
        { startRow: 0, startCol: 45, endRow: 0, endCol: 45 },
        { startRow: 0, startCol: 41, endRow: 0, endCol: 44 },
        "line"
      );
    });
    await page.waitForTimeout(300);
  },
};

const sparklineDelete: ActionDef<Record<string, never>> = {
  id: "sparkline.delete",
  category: "sparkline",
  weight: 2,
  precondition: (s) => s.logical.sparklineGroups.length > 0,
  pickParams: () => ({}),
  async execute(page) {
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

const sparklineSelectInto: ActionDef<Record<string, never>> = {
  id: "sparkline.select-into",
  category: "sparkline",
  weight: 2,
  precondition: (s) => s.logical.sparklineGroups.length > 0,
  pickParams: () => ({}),
  async execute(_page, grid) {
    await grid.navigateTo("AT1");
    await grid.page.waitForTimeout(300);
  },
};

// ============================================================================
// Row/Column structure actions
// ============================================================================

const insertRow: ActionDef<{ row: number }> = {
  id: "structure.insert-row",
  category: "structure",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ row: pickInt(rng, 45, 55) }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "insert_rows", { startRow: p.row, count: 1 }).catch(() => {});
    await page.waitForTimeout(200);
  },
};

const deleteRow: ActionDef<{ row: number }> = {
  id: "structure.delete-row",
  category: "structure",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ row: pickInt(rng, 45, 55) }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "delete_rows", { startRow: p.row, count: 1 }).catch(() => {});
    await page.waitForTimeout(200);
  },
};

const insertColumn: ActionDef<{ col: number }> = {
  id: "structure.insert-col",
  category: "structure",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ col: pickInt(rng, 55, 65) }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "insert_columns", { startCol: p.col, count: 1 }).catch(() => {});
    await page.waitForTimeout(200);
  },
};

const deleteColumn: ActionDef<{ col: number }> = {
  id: "structure.delete-col",
  category: "structure",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ col: pickInt(rng, 55, 65) }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "delete_columns", { startCol: p.col, count: 1 }).catch(() => {});
    await page.waitForTimeout(200);
  },
};

const resizeColumn: ActionDef<{ col: number; width: number }> = {
  id: "structure.resize-col",
  category: "structure",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ col: pickInt(rng, 0, 10), width: pickInt(rng, 40, 220) }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "set_column_width", { col: p.col, width: p.width }).catch(() => {});
    await page.waitForTimeout(100);
  },
};

const resizeRow: ActionDef<{ row: number; height: number }> = {
  id: "structure.resize-row",
  category: "structure",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ row: pickInt(rng, 0, 20), height: pickInt(rng, 16, 80) }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "set_row_height", { row: p.row, height: p.height }).catch(() => {});
    await page.waitForTimeout(100);
  },
};

// ============================================================================
// Cell / selection / editing actions
// ============================================================================

const cellClick: ActionDef<{ ref: string }> = {
  id: "cell.click",
  category: "selection",
  weight: 5,
  precondition: () => true,
  pickParams: (rng) => ({ ref: pick(rng, CELL_REFS) }),
  async execute(_page, grid, p) {
    await grid.clickCell(p.ref);
    await grid.page.waitForTimeout(100);
  },
};

const cellEdit: ActionDef<{ ref: string; value: string }> = {
  id: "cell.edit",
  category: "editing",
  weight: 2,
  precondition: () => true,
  pickParams: (rng, _s, seq) => ({ ref: pick(rng, CELL_REFS), value: `Test${seq}` }),
  async execute(_page, grid, p) {
    await grid.setCellValueDirect(p.ref, p.value);
    await grid.page.waitForTimeout(100);
  },
};

const cellEditNumber: ActionDef<{ ref: string; value: string }> = {
  id: "cell.edit-number",
  category: "editing",
  weight: 2,
  precondition: () => true,
  pickParams: (rng) => ({
    ref: pick(rng, CELL_REFS),
    value: String(pickInt(rng, -1000, 1000)),
  }),
  async execute(_page, grid, p) {
    await grid.setCellValueDirect(p.ref, p.value);
    await grid.page.waitForTimeout(100);
  },
};

const cellEditFormula: ActionDef<{ ref: string; formula: string }> = {
  id: "cell.edit-formula",
  category: "editing",
  weight: 2,
  precondition: () => true,
  pickParams: (rng) => ({ ref: pick(rng, ["G10", "H10", "G11", "H11", "G12"]), formula: pick(rng, FORMULAS) }),
  async execute(_page, grid, p) {
    await grid.setCellValueDirect(p.ref, p.formula);
    await grid.page.waitForTimeout(150);
  },
};

const cellClear: ActionDef<{ ref: string }> = {
  id: "cell.clear",
  category: "editing",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ ref: pick(rng, CELL_REFS) }),
  async execute(_page, grid, p) {
    await grid.setCellValueDirect(p.ref, "");
    await grid.page.waitForTimeout(100);
  },
};

const cellEscape: ActionDef<Record<string, never>> = {
  id: "cell.escape",
  category: "editing",
  weight: 2,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
  },
};

// ============================================================================
// Clipboard actions
// ============================================================================

const copyPaste: ActionDef<{ from: string; to: string }> = {
  id: "clipboard.copy-paste",
  category: "clipboard",
  weight: 2,
  precondition: () => true,
  pickParams: (rng) => ({
    from: pick(rng, CELL_REFS),
    to: pick(rng, ["J20", "K20", "J21", "K21"]),
  }),
  async execute(_page, grid, p) {
    await grid.clickCell(p.from);
    await grid.copy();
    await grid.page.waitForTimeout(150);
    await grid.clickCell(p.to);
    await grid.paste();
    await grid.page.waitForTimeout(200);
  },
};

// ============================================================================
// Formatting actions
// ============================================================================

const formatBold: ActionDef<{ ref: string }> = {
  id: "format.bold",
  category: "formatting",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ ref: pick(rng, CELL_REFS) }),
  async execute(page, grid, p) {
    await grid.clickCell(p.ref);
    await dispatchKeyOnGrid(page, "b", true);
    await page.waitForTimeout(100);
  },
};

const formatItalic: ActionDef<{ ref: string }> = {
  id: "format.italic",
  category: "formatting",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ ref: pick(rng, CELL_REFS) }),
  async execute(page, grid, p) {
    await grid.clickCell(p.ref);
    await dispatchKeyOnGrid(page, "i", true);
    await page.waitForTimeout(100);
  },
};

// ============================================================================
// Merge actions
// ============================================================================

const mergeCells: ActionDef<{ startRow: number; startCol: number; rows: number; cols: number }> = {
  id: "merge.merge",
  category: "merge",
  weight: 2,
  precondition: () => true,
  pickParams: (rng) => ({
    startRow: pickInt(rng, 59, 68),
    startCol: pickInt(rng, 0, 4),
    rows: pickInt(rng, 1, 2),
    cols: pickInt(rng, 1, 2),
  }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "merge_cells", {
      startRow: p.startRow,
      startCol: p.startCol,
      endRow: p.startRow + p.rows,
      endCol: p.startCol + p.cols,
    }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

const unmergeCells: ActionDef<Record<string, never>> = {
  id: "merge.unmerge",
  category: "merge",
  weight: 1,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page) {
    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      try {
        const regions = await tauri.core.invoke("get_merged_regions");
        if (Array.isArray(regions) && regions.length > 0) {
          const r = regions[0];
          await tauri.core.invoke("unmerge_cells", {
            row: r.startRow ?? r.start_row,
            col: r.startCol ?? r.start_col,
          });
          window.dispatchEvent(new Event("grid:refresh"));
        }
      } catch {
        // no merged regions — fine
      }
    });
    await page.waitForTimeout(200);
  },
};

// ============================================================================
// Fill action (backend for Ctrl+D / fill handle)
// ============================================================================

const fillDown: ActionDef<{ value: string; count: number }> = {
  id: "fill.down",
  category: "fill",
  weight: 2,
  precondition: () => true,
  pickParams: (rng, _s, seq) => ({ value: `Fill${seq}`, count: pickInt(rng, 2, 4) }),
  async execute(page, grid, p) {
    // Source at AH60 (col 33, row 59), fill down `count` rows.
    await grid.setCellValueDirect("AH60", p.value);
    await invokeTauri(page, "fill_range", {
      sourceStartRow: 59,
      sourceStartCol: 33,
      sourceEndRow: 59,
      sourceEndCol: 33,
      targetStartRow: 60,
      targetStartCol: 33,
      targetEndRow: 59 + p.count,
      targetEndCol: 33,
    }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

// ============================================================================
// Sort action
// ============================================================================

const sortRange: ActionDef<{ ascending: boolean; values: number[] }> = {
  id: "sort.range",
  category: "sort",
  weight: 2,
  precondition: () => true,
  pickParams: (rng) => ({
    ascending: rng() < 0.5,
    values: [pickInt(rng, 1, 99), pickInt(rng, 1, 99), pickInt(rng, 1, 99), pickInt(rng, 1, 99)],
  }),
  async execute(page, grid, p) {
    // Data block AJ60:AJ63 (col 35, rows 59-62)
    for (let i = 0; i < p.values.length; i++) {
      await grid.setCellValueDirect(`AJ${60 + i}`, String(p.values[i]));
    }
    await invokeTauri(page, "sort_range", {
      params: {
        startRow: 59,
        startCol: 35,
        endRow: 59 + p.values.length - 1,
        endCol: 35,
        fields: [{ key: 0, ascending: p.ascending }],
        matchCase: false,
        hasHeaders: false,
        orientation: "rows",
      },
    }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

// ============================================================================
// AutoFilter actions
// ============================================================================

const autoFilterApply: ActionDef<Record<string, never>> = {
  id: "filter.apply",
  category: "filter",
  weight: 2,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page, grid) {
    // Filterable block at AL60:AL64 (col 37): header + values
    await grid.setCellValueDirect("AL60", "Status");
    await grid.setCellValueDirect("AL61", "Open");
    await grid.setCellValueDirect("AL62", "Closed");
    await grid.setCellValueDirect("AL63", "Open");
    await grid.setCellValueDirect("AL64", "Closed");
    await invokeTauri(page, "apply_auto_filter", {
      params: { startRow: 59, startCol: 37, endRow: 63, endCol: 37 },
    }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

const autoFilterValues: ActionDef<{ value: string }> = {
  id: "filter.set-values",
  category: "filter",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ value: pick(rng, ["Open", "Closed"]) }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "set_column_filter_values", {
      columnIndex: 0,
      values: [p.value],
      includeBlanks: false,
    }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

const autoFilterRemove: ActionDef<Record<string, never>> = {
  id: "filter.remove",
  category: "filter",
  weight: 1,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page) {
    await invokeTauri(page, "remove_auto_filter", {}).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

// ============================================================================
// Sheet actions (via UI / frontend events to keep the frontend in sync)
// ============================================================================

const sheetAdd: ActionDef<Record<string, never>> = {
  id: "sheet.add",
  category: "sheet",
  weight: 1,
  precondition: (s) => s.logical.sheetCount < 4,
  pickParams: () => ({}),
  async execute(page) {
    const addBtn = page.locator('button[title="Add new sheet"]');
    if (await addBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await addBtn.click({ force: true });
      await page.waitForTimeout(600);
    }
  },
};

const sheetSwitch: ActionDef<{ tabIndex: number }> = {
  id: "sheet.switch",
  category: "sheet",
  weight: 2,
  precondition: (s) => s.logical.sheetCount > 1,
  pickParams: (rng, s) => ({ tabIndex: pickInt(rng, 0, Math.max(0, s.logical.sheetCount - 1)) }),
  async execute(page, _grid, p) {
    const tab = page.locator(`button[data-sheet-tab="${p.tabIndex}"]`);
    if (await tab.isVisible({ timeout: 500 }).catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(400);
    }
  },
};

const sheetRename: ActionDef<{ tabIndex: number; name: string }> = {
  id: "sheet.rename",
  category: "sheet",
  weight: 1,
  precondition: (s) => s.logical.sheetCount > 1,
  pickParams: (rng, s, seq) => ({
    tabIndex: pickInt(rng, 1, Math.max(1, s.logical.sheetCount - 1)),
    name: `Blad_${seq}`,
  }),
  async execute(page, _grid, p) {
    await page.evaluate(
      ({ idx, name }) => {
        window.dispatchEvent(
          new CustomEvent("sheet:requestRename", { detail: { index: idx, newName: name } })
        );
      },
      { idx: p.tabIndex, name: p.name }
    );
    await page.waitForTimeout(400);
  },
};

const sheetDelete: ActionDef<Record<string, never>> = {
  id: "sheet.delete",
  category: "sheet",
  weight: 1,
  precondition: (s) => s.logical.sheetCount > 1,
  pickParams: () => ({}),
  async execute(page) {
    // Always delete the LAST sheet (never sheet 0, which anchors test data).
    const count = await page.locator("button[data-sheet-tab]").count();
    if (count <= 1) return;
    await page.evaluate((idx: number) => {
      window.dispatchEvent(
        new CustomEvent("sheet:requestDelete", { detail: { index: idx } })
      );
    }, count - 1);
    await page.waitForTimeout(300);
    const deleteBtn = page.locator("button").filter({ hasText: /^Delete$/ });
    if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await deleteBtn.click();
      await page.waitForTimeout(500);
    }
  },
};

// ============================================================================
// Named range actions
// ============================================================================

const nameDefine: ActionDef<{ name: string }> = {
  id: "names.define",
  category: "names",
  weight: 1,
  precondition: () => true,
  pickParams: (_rng, _s, seq) => ({ name: `TestName_${seq}` }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "create_named_range", {
      name: p.name,
      sheetIndex: null,
      refersTo: "=Sheet1!$A$1:$B$5",
      comment: null,
      folder: null,
    }).catch(() => {});
    await page.waitForTimeout(100);
  },
};

const nameDelete: ActionDef<Record<string, never>> = {
  id: "names.delete",
  category: "names",
  weight: 1,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page) {
    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      try {
        const names = await tauri.core.invoke("get_all_named_ranges");
        const list = Array.isArray(names) ? names : (names?.namedRanges ?? []);
        if (list.length > 0) {
          await tauri.core.invoke("delete_named_range", { name: list[0].name });
        }
      } catch {
        // none defined — fine
      }
    });
    await page.waitForTimeout(100);
  },
};

// ============================================================================
// Conditional formatting actions
// ============================================================================

const cfAddRule: ActionDef<{ threshold: number }> = {
  id: "cf.add-rule",
  category: "cf",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ threshold: pickInt(rng, 10, 90) }),
  async execute(page, grid, p) {
    // Numeric block AN60:AN63 (col 39)
    await grid.setCellValueDirect("AN60", "25");
    await grid.setCellValueDirect("AN61", "50");
    await grid.setCellValueDirect("AN62", "75");
    await invokeTauri(page, "add_conditional_format", {
      params: {
        // ConditionalFormatRule is internally tagged: #[serde(tag = "type")]
        rule: { type: "cellValue", operator: "greaterThan", value1: String(p.threshold) },
        format: { backgroundColor: "#FFC7CE", textColor: "#9C0006" },
        ranges: [{ startRow: 59, startCol: 39, endRow: 62, endCol: 39 }],
        stopIfTrue: false,
      },
    }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

const cfDeleteRule: ActionDef<Record<string, never>> = {
  id: "cf.delete-rule",
  category: "cf",
  weight: 1,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page) {
    await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      try {
        const all = await tauri.core.invoke("get_all_conditional_formats");
        const list = Array.isArray(all) ? all : (all?.formats ?? all?.definitions ?? []);
        if (list.length > 0) {
          const id = list[0].id ?? list[0].ruleId;
          if (id !== undefined) {
            await tauri.core.invoke("delete_conditional_format", { ruleId: id });
          }
        }
      } catch {
        // none defined — fine
      }
    });
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

// ============================================================================
// Data validation actions
// ============================================================================

const validationAdd: ActionDef<{ min: number; max: number }> = {
  id: "validation.add",
  category: "validation",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => {
    const min = pickInt(rng, 0, 50);
    return { min, max: min + pickInt(rng, 10, 100) };
  },
  async execute(page, _grid, p) {
    // Validation block AM60:AM65 (col 38)
    await invokeTauri(page, "set_data_validation", {
      startRow: 59,
      startCol: 38,
      endRow: 64,
      endCol: 38,
      validation: {
        rule: {
          wholeNumber: { formula1: p.min, formula2: p.max, operator: "between" },
        },
        errorAlert: { title: "", message: "", style: "stop", showAlert: true },
        prompt: { title: "", message: "", showPrompt: true },
        ignoreBlanks: true,
      },
    }).catch(() => {});
    await page.waitForTimeout(100);
  },
};

const validationClear: ActionDef<Record<string, never>> = {
  id: "validation.clear",
  category: "validation",
  weight: 1,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page) {
    await invokeTauri(page, "clear_data_validation", {
      startRow: 59,
      startCol: 38,
      endRow: 64,
      endCol: 38,
    }).catch(() => {});
    await page.waitForTimeout(100);
  },
};

// ============================================================================
// Freeze panes actions
// ============================================================================

const freezeSet: ActionDef<{ row: number; col: number }> = {
  id: "freeze.set",
  category: "view",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ row: pickInt(rng, 1, 3), col: pickInt(rng, 0, 2) }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "set_freeze_panes", {
      freezeRow: p.row,
      freezeCol: p.col > 0 ? p.col : null,
    }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

const freezeClear: ActionDef<Record<string, never>> = {
  id: "freeze.clear",
  category: "view",
  weight: 1,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page) {
    await invokeTauri(page, "set_freeze_panes", {
      freezeRow: null,
      freezeCol: null,
    }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

// ============================================================================
// Comments / notes / hyperlinks
// ============================================================================

const commentAdd: ActionDef<{ ref: string; text: string; row: number; col: number }> = {
  id: "comment.add",
  category: "annotation",
  weight: 1,
  precondition: () => true,
  pickParams: (rng, _s, seq) => {
    const row = pickInt(rng, 0, 10);
    const col = pickInt(rng, 0, 5);
    return { ref: `r${row}c${col}`, text: `Comment ${seq}`, row, col };
  },
  async execute(page, _grid, p) {
    await invokeTauri(page, "add_comment", {
      params: {
        row: p.row,
        col: p.col,
        content: p.text,
        authorName: "Walker",
        authorEmail: "walker@test.local",
      },
    }).catch(() => {});
    await page.waitForTimeout(100);
  },
};

const noteAdd: ActionDef<{ text: string; row: number; col: number }> = {
  id: "note.add",
  category: "annotation",
  weight: 1,
  precondition: () => true,
  pickParams: (rng, _s, seq) => ({
    text: `Note ${seq}`,
    row: pickInt(rng, 0, 10),
    col: pickInt(rng, 0, 5),
  }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "add_note", {
      params: { row: p.row, col: p.col, content: p.text, authorName: "Walker" },
    }).catch(() => {});
    await page.waitForTimeout(100);
  },
};

const hyperlinkAdd: ActionDef<{ row: number; col: number }> = {
  id: "hyperlink.add",
  category: "annotation",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ row: pickInt(rng, 11, 20), col: pickInt(rng, 0, 5) }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "add_hyperlink", {
      params: {
        row: p.row,
        col: p.col,
        linkType: "url",
        target: "https://example.com",
        displayText: "Example",
      },
    }).catch(() => {});
    await page.waitForTimeout(100);
  },
};

// ============================================================================
// Find/replace action
// ============================================================================

const replaceAll: ActionDef<Record<string, never>> = {
  id: "replace.all",
  category: "editing",
  weight: 1,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(page) {
    await invokeTauri(page, "replace_all", {
      search: "Test",
      replacement: "Tst",
      caseSensitive: true,
      matchEntireCell: false,
    }).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await page.waitForTimeout(200);
  },
};

// ============================================================================
// Undo/redo actions
// ============================================================================

const undoAction: ActionDef<Record<string, never>> = {
  id: "undo",
  category: "undo-redo",
  weight: 2,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(_page, grid) {
    await grid.undo();
    await grid.page.waitForTimeout(200);
  },
};

const redoAction: ActionDef<Record<string, never>> = {
  id: "redo",
  category: "undo-redo",
  weight: 1,
  precondition: () => true,
  pickParams: () => ({}),
  async execute(_page, grid) {
    await grid.redo();
    await grid.page.waitForTimeout(200);
  },
};

// ============================================================================
// Ribbon / navigation actions
// ============================================================================

const STANDARD_TABS = ["Home", "Insert", "Page Layout", "Formulas", "Data", "View"] as const;

const switchRibbonTab: ActionDef<{ tabName: string }> = {
  id: "ribbon.switch-tab",
  category: "ui",
  weight: 2,
  precondition: () => true,
  pickParams: (rng) => ({ tabName: pick(rng, STANDARD_TABS) }),
  async execute(page, _grid, p) {
    const tabBtn = page.locator("button").filter({ hasText: p.tabName }).first();
    if (await tabBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await tabBtn.click();
      await page.waitForTimeout(200);
      if (p.tabName !== "Home") {
        const homeBtn = page.locator("button").filter({ hasText: "Home" }).first();
        if (await homeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await homeBtn.click();
          await page.waitForTimeout(100);
        }
      }
    }
  },
};

const navigateViaNameBox: ActionDef<{ ref: string }> = {
  id: "nav.name-box",
  category: "navigation",
  weight: 1,
  precondition: () => true,
  pickParams: (rng) => ({ ref: pick(rng, ["A1", "A50", "E10", "J1", "A100"]) }),
  async execute(page, _grid, p) {
    const nameBox = page.locator('input[aria-label="Name Box"]');
    await nameBox.click();
    await nameBox.fill(p.ref);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
  },
};

// ============================================================================
// Export: Full Action Catalog
// ============================================================================

/**
 * Actions excluded from GENERATION because a ledgered bug makes every walk
 * that uses them fail the same way, drowning out new findings. They remain
 * in FULL_ACTION_CATALOG so recorded traces (e.g. the bug's own repro) can
 * still be replayed. Re-enable when the referenced bug is fixed, then replay
 * tests/regression/repros/<bug>.trace.json to confirm.
 */
export const EXCLUDED_UNTIL_FIXED: Array<{ ledgerId: string; actions: AnyActionDef[] }> = [
  {
    // Undo is sheet-unaware: undo-all cannot cross a sheet.add boundary
    // (active sheet, sheet list, and cell restorations all diverge).
    ledgerId: "BUG-0005",
    actions: [sheetAdd, sheetSwitch, sheetRename, sheetDelete],
  },
];

const ALL_ACTIONS: AnyActionDef[] = [
  // Object lifecycle (from v1)
  slicerCreate,
  slicerDelete,
  slicerClickAway,
  chartCreate,
  chartDelete,
  chartSelect,
  chartDeselect,
  tableCreate,
  tableDelete,
  tableSelectInto,
  tableSelectAway,
  sparklineCreate,
  sparklineDelete,
  sparklineSelectInto,
  // Structure
  insertRow,
  deleteRow,
  insertColumn,
  deleteColumn,
  resizeColumn,
  resizeRow,
  // Cells & editing
  cellClick,
  cellEdit,
  cellEditNumber,
  cellEditFormula,
  cellClear,
  cellEscape,
  // Clipboard
  copyPaste,
  // Formatting
  formatBold,
  formatItalic,
  // Merge
  mergeCells,
  unmergeCells,
  // Fill / sort / filter
  fillDown,
  sortRange,
  autoFilterApply,
  autoFilterValues,
  autoFilterRemove,
  // Sheets — excluded from generation until BUG-0005 (sheet-unaware undo)
  // is fixed; see EXCLUDED_UNTIL_FIXED above.
  sheetAdd,
  sheetSwitch,
  sheetRename,
  sheetDelete,
  // Names
  nameDefine,
  nameDelete,
  // Conditional formatting
  cfAddRule,
  cfDeleteRule,
  // Validation
  validationAdd,
  validationClear,
  // View
  freezeSet,
  freezeClear,
  // Annotations
  commentAdd,
  noteAdd,
  hyperlinkAdd,
  // Find/replace
  replaceAll,
  // Undo/redo
  undoAction,
  redoAction,
  // UI / navigation
  switchRibbonTab,
  navigateViaNameBox,
];

const EXCLUDED_IDS = new Set(
  EXCLUDED_UNTIL_FIXED.flatMap((e) => e.actions.map((a) => a.id))
);

/** Default GENERATION catalog: everything except actions blocked on
 *  ledgered bugs (EXCLUDED_UNTIL_FIXED). */
export const ACTION_CATALOG: AnyActionDef[] = ALL_ACTIONS.filter(
  (a) => !EXCLUDED_IDS.has(a.id)
);

/** Full catalog including excluded actions — used to RESOLVE actions during
 *  trace replay, so old repro traces always remain replayable. */
export const FULL_ACTION_CATALOG: AnyActionDef[] = ALL_ACTIONS;
