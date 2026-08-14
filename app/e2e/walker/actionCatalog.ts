//! FILENAME: app/e2e/walker/actionCatalog.ts
// PURPOSE: THE action catalog for the random walker — the soak walk and the
//          invariant walk both generate and replay from this one list.
//
//          There used to be a second, smaller catalog at
//          app/e2e/invariants/actions.ts (27 actions to this one's 59, a
//          strict subset by id). It is DELETED; the two properties that made
//          this one the survivor are:
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
  /**
   * Can this action run in the current state? Re-checked on replay.
   *
   * `params` is present ONLY on the replay path, where the action's parameters
   * were chosen against a different workbook and may no longer be valid. It is
   * absent when the generator is choosing an action, because the parameters do
   * not exist yet.
   *
   * WHY IT TAKES PARAMS AT ALL. The header above promises "preconditions are
   * re-checked on replay", and a precondition that cannot see the parameters
   * cannot re-check them. `sheet.rename` recorded `tabIndex: 2` against a
   * three-sheet workbook; the shrinker then dropped the `sheet.add` that made
   * the third sheet and replayed the rename against two, and the product
   * answered with a NATIVE alert ("Sheet index 2 out of range") that blocked
   * Tauri IPC and hung the walk in silence for its whole timeout (BUG-0039).
   * The action was not "still valid" in any sense the old signature could
   * express.
   */
  precondition: (snapshot: StateSnapshot, params?: P) => boolean;
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
//   validation AM60:AM65 (col 38), CF AN60:AN65 (col 39),
//   floating-range grid refs AW60:AW64 (col 48).

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
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, startRow: 0, startCol: 25, endRow: 2, endCol: 26 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Value", color: "#4472C4" }],
        title,
      };

      // THE PRODUCT'S OWN CREATE, not a raw `save_chart` invoke -- the same
      // lesson `table.delete` below already learned, applied one object over.
      //
      // MEASURED LIVE 2026-08-12, on a running app, and it had been true of
      // every walk ever run: a raw `save_chart` persists the chart and tells
      // the chart STORE nothing. `get_charts` then answered 2 while
      // `__CALCULA_CHARTS__.getAllCharts()` answered 0 -- and the store is what
      // the next two actions read. So `chart.select`, whose entire job is to
      // raise the Chart Design contextual tab, selected nothing and returned
      // successfully; `chart.delete` deleted nothing and returned successfully;
      // and `getCurrentChartId()` stayed null through both. Their preconditions
      // are satisfied from the BACKEND count, so the generator went on issuing
      // them and the walk went on reporting them executed.
      //
      // The consequence is the shape this program keeps deleting: the
      // `contextual-ribbon-tabs` invariant could NEVER observe a chart tab,
      // because nothing in the catalog could raise one. §3cd's matrix lists
      // Chart as "already correct" -- which is a reading of the source, and the
      // walk that would have tested it was structurally unable to.
      //
      // `createChart` is what the Insert > Chart command calls. It pushes into
      // the store AND persists through the same `save_chart`, so the backend
      // sees exactly what it saw before and the store is no longer blind.
      const store = (await (window as any).__calcImport(
        new URL("/extensions/Charts/lib/chartStore.ts", document.baseURI).href,
      )) as {
        createChart?: (spec: unknown, placement: Record<string, unknown>) => { chartId: string };
        syncChartRegions?: () => void;
      };
      if (store?.createChart) {
        store.createChart(spec, {
          sheetIndex: 0,
          x: 400,
          y: 40,
          width: 480,
          height: 300,
          name: title,
        });
        store.syncChartRegions?.();
      } else {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("save_chart", {
          entry: {
            id: crypto.randomUUID(),
            sheetIndex: 0,
            specJson: JSON.stringify(spec),
          },
        });
      }
    }, p.title);
    await page.waitForTimeout(300);
  },
};

// A chart's identity in the STORE is `chartId` (ChartDefinition.chartId); the
// BACKEND's ChartEntry calls the same value `id`. Reading `.id` off a store
// object yields `undefined`, and every function below takes a chart id as its
// only argument, so the whole call becomes a silent no-op.
//
// MEASURED LIVE 2026-08-12, immediately after BUG-0031 taught `chart.create` to
// go through the store: a chart-weighted 75-action walk issued 46 chart
// actions, and afterwards `get_charts` answered NINE while
// `getCurrentChartId()` was still null. Nothing had ever been selected and
// nothing had ever been deleted. BUG-0031 fixed the create half and left the
// select/delete half reading a key that does not exist -- so the walk grew
// charts monotonically, the `contextual-ribbon-tabs` invariant STILL could not
// observe a Chart Design tab, and `deepResetForWalk` (same `.id`) could not
// clear charts between walks either, defeating its entire purpose for this one
// object type.
//
// Filed as BUG-0035. `e2e/tests/walker-actions-are-real.spec.ts` now asserts
// live that each of these actions has an observable effect, so a bridge that
// renames a key cannot quietly turn the walker's chart lifecycle into no-ops
// for a third time. (The id is read INSIDE each `page.evaluate` rather than via
// a shared helper: the callback is serialized into the WebView, where nothing
// from this module exists.)

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
        const id = charts[0].chartId ?? charts[0].id;
        if (id == null) {
          throw new Error(
            "chart.delete: the chart store exposes no id — " +
              `keys were [${Object.keys(charts[0]).join(",")}]`
          );
        }
        chartApi.deleteChart(id);
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
        const id = charts[0].chartId ?? charts[0].id;
        if (id == null) {
          throw new Error(
            "chart.select: the chart store exposes no id — " +
              `keys were [${Object.keys(charts[0]).join(",")}]`
          );
        }
        chartApi.selectChart(id);
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
      // THE PRODUCT'S OWN CREATE, for the reason `table.delete` below already
      // gives about the delete -- and one more.
      //
      // A raw `create_table` invoke leaves the FRONTEND not knowing a table
      // exists: the store's cache is only refilled by `refreshCache`, which
      // nothing on this path calls. Every table action after it then ran
      // against an empty cache, so `table.select-into` could not register the
      // contextual tab and `table.delete` had nothing to take down. That is not
      // a state a user can reach -- Insert > Table goes through
      // `createTableAsync` and then announces TABLE_CREATED -- and it made the
      // walk BLIND to the whole contextual-tab surface unless some UNRELATED
      // action happened to refresh the cache first. BUG-0051 needed a
      // `sheet.rename` wedged into the middle for exactly that reason, and the
      // shrinker faithfully reported the rename as load-bearing when what was
      // really load-bearing was the cache refresh it dragged along.
      const store = (await (window as any).__calcImport(
        new URL("/extensions/Table/lib/tableStore.ts", document.baseURI).href,
      )) as {
        createTableAsync?: (p: {
          sheetIndex: number;
          startRow: number;
          startCol: number;
          endRow: number;
          endCol: number;
          hasHeaders: boolean;
        }) => Promise<{ id: string } | null>;
      };
      if (store?.createTableAsync) {
        // DO NOT ASK FOR A TABLE THAT CANNOT BE MADE.
        //
        // This action always targets the SAME rectangle, so a second create
        // while the first table is still there is refused by the backend with
        // "Table overlaps with existing table". The raw invoke this replaced
        // rejected the promise and the walker swallowed it; the product's route
        // does what a product does with a refusal it was asked for -- it
        // `console.error`s -- and `no-console-errors` fails the walk on a
        // message the app was right to print. Measured: seed 90070001 got to
        // step 143 and failed on exactly that.
        //
        // Checked against the BACKEND rather than a precondition on the
        // walker's snapshot, because the snapshot's table list is not scoped
        // the same way: a table on ANOTHER sheet must not stop this one.
        const active = (await tauri.core.invoke("get_active_sheet", {})) as number;
        const existing = (await tauri.core.invoke("get_all_tables", {})) as Array<{
          sheetIndex?: number;
          startRow: number;
          startCol: number;
          endRow: number;
          endCol: number;
        }>;
        const overlaps = (existing ?? []).some(
          (t) =>
            (t.sheetIndex === undefined || t.sheetIndex === active) &&
            t.startRow <= 2 &&
            t.endRow >= 0 &&
            t.startCol <= 32 &&
            t.endCol >= 30,
        );
        if (overlaps) return;

        const table = await store.createTableAsync({
          sheetIndex: 0,
          startRow: 0,
          startCol: 30,
          endRow: 2,
          endCol: 32,
          hasHeaders: true,
        });
        if (table) {
          // What the Insert > Table dialog emits after the store resolves. It
          // is what puts the contextual tab up, so a walk that skipped it would
          // still be testing a state no user reaches.
          window.dispatchEvent(
            new CustomEvent("app:table-created", { detail: { tableId: table.id } }),
          );
        }
        return;
      }
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
      if (!tables || tables.length === 0) return;
      // THE PRODUCT'S OWN DELETE, not a raw `delete_table` invoke.
      //
      // Deleting a table CASCADES on the backend -- the slicers bound to it go
      // with it (§3bt) -- and the raw command tells the frontend nothing. The
      // Slicer store then keeps a slicer whose backend object is gone, paints
      // it, and answers "Slicer <id> not found" the moment anything clicks it:
      // a `no-console-errors` failure that no user gesture can produce.
      // `deleteTableAsync` is what the Table Design tab's Delete button calls,
      // and it makes the announcement the caches need.
      const store = (await (window as any).__calcImport(
        new URL("/extensions/Table/lib/tableStore.ts", document.baseURI).href,
      )) as { deleteTableAsync?: (id: string) => Promise<boolean> };
      if (store?.deleteTableAsync) {
        await store.deleteTableAsync(tables[0].id);
      } else {
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
  // Only VISIBLE sheets have a tab, so a switch to a hidden index clicks
  // nothing at all — a silent no-op that the coverage line would still count as
  // a sheet action (§14a). Now that `sheet.hide` exists, that is a reachable
  // state rather than a theoretical one.
  precondition: (s, p) => {
    const vis = s.logical.sheetVisibility ?? [];
    const visibleCount = vis.length
      ? vis.filter((v) => v === "visible").length
      : s.logical.sheetCount;
    if (visibleCount < 2) return false;
    if (p?.tabIndex === undefined) return true;
    if (p.tabIndex >= s.logical.sheetCount) return false;
    return vis.length === 0 || vis[p.tabIndex] === "visible";
  },
  pickParams: (rng, s) => {
    const vis = s.logical.sheetVisibility ?? [];
    const visible = vis.length
      ? vis.map((v, i) => (v === "visible" ? i : -1)).filter((i) => i >= 0)
      : Array.from({ length: s.logical.sheetCount }, (_, i) => i);
    return { tabIndex: pick(rng, visible.length ? visible : [0]) };
  },
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
  // The recorded tabIndex must still address a sheet that EXISTS. Replaying it
  // against a smaller workbook raises a native "Sheet index N out of range"
  // alert, which blocks Tauri IPC and hangs the walk — BUG-0039, and the reason
  // `precondition` now receives the params at all.
  //
  // SHEET 0 IS INCLUDED, and a single-sheet workbook is a legal target. Renaming
  // the FIRST sheet is the interesting case and it was the one excluded: a
  // rename rewrites every formula in the workbook, re-keys the cross-sheet
  // dependent map (which is keyed by NAME) and repairs every defined name's
  // `refersTo` — and the walker's own `names.define` points at the active sheet,
  // so renaming it exercises exactly that repair. Restricting this to sheets
  // 1..n meant the walk could only ever rename a sheet nothing referred to.
  precondition: (s, p) =>
    s.logical.sheetCount >= 1 &&
    (p?.tabIndex === undefined || p.tabIndex < s.logical.sheetCount),
  pickParams: (rng, s, seq) => ({
    tabIndex: pickInt(rng, 0, Math.max(0, s.logical.sheetCount - 1)),
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

const sheetDelete: ActionDef<{ tabIndex: number }> = {
  id: "sheet.delete",
  category: "sheet",
  weight: 1,
  // DELETING THE LAST SHEET RENUMBERS NOTHING, and that is what this action used
  // to do — unconditionally, reading the tab count out of the DOM. Every remap
  // in `delete_sheet` (`remap_sheet_keyed_stores`, `cascade_sheet_removed`,
  // `remap_report_sheets`, the cross-sheet dependency re-key, the defined-name
  // re-scope) only moves indices ABOVE the deleted one, so a walk that always
  // deleted the last sheet exercised none of them. BUG-0041 — a sparkline that
  // came back on another sheet after save/reload — lived on exactly that path.
  //
  // Sheet 0 is still spared: it anchors the walk's seeded ranges, and losing it
  // mid-walk turns every later action into a no-op on data that is not there.
  //
  // AND IT MUST LEAVE A VISIBLE SHEET BEHIND. `delete_sheet` refuses a delete
  // that would leave the workbook with none, and a refusal comes back through
  // `executeDeleteSheet`'s `alertAsync` — a NATIVE dialog, which blocks Tauri
  // IPC and is the whole of BUG-0039. Now that `sheet.hide` exists, "the only
  // visible sheet" is a state a walk can actually reach.
  precondition: (s, p) => {
    if (s.logical.sheetCount <= 1) return false;
    const vis = s.logical.sheetVisibility ?? [];
    const visibleAfter = (removing: number) =>
      Array.from({ length: s.logical.sheetCount }, (_, i) => i)
        .filter((i) => i !== removing)
        .filter((i) => (vis.length === 0 ? true : vis[i] === "visible")).length;
    if (p?.tabIndex === undefined) {
      // Generation: some index in 1..n-1 must be deletable.
      return Array.from({ length: s.logical.sheetCount - 1 }, (_, k) => k + 1).some(
        (i) => visibleAfter(i) > 0
      );
    }
    return (
      p.tabIndex >= 1 &&
      p.tabIndex < s.logical.sheetCount &&
      visibleAfter(p.tabIndex) > 0
    );
  },
  pickParams: (rng, s) => {
    const vis = s.logical.sheetVisibility ?? [];
    const visibleAfter = (removing: number) =>
      Array.from({ length: s.logical.sheetCount }, (_, i) => i)
        .filter((i) => i !== removing)
        .filter((i) => (vis.length === 0 ? true : vis[i] === "visible")).length;
    const candidates = Array.from(
      { length: Math.max(0, s.logical.sheetCount - 1) },
      (_, k) => k + 1
    ).filter((i) => visibleAfter(i) > 0);
    return {
      tabIndex: candidates.length
        ? pick(rng, candidates)
        : pickInt(rng, 1, Math.max(1, s.logical.sheetCount - 1)),
    };
  },
  async execute(page, _grid, p) {
    const count = await page.locator("button[data-sheet-tab]").count();
    if (count <= 1) return;
    await page.evaluate((idx: number) => {
      window.dispatchEvent(
        new CustomEvent("sheet:requestDelete", { detail: { index: idx } })
      );
    }, p.tabIndex);
    await page.waitForTimeout(300);
    const deleteBtn = page.locator("button").filter({ hasText: /^Delete$/ });
    if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await deleteBtn.click();
      await page.waitForTimeout(500);
    }
  },
};

// The three sheet operations the catalog never had. `move` and `copy` are the
// other two commands that RENUMBER the workbook (and the register's own oracle
// message has always named all five as history-ending), and `hide` is the one
// that changes which sheet is active without changing the sheet list at all —
// which is where BUG-0046 lived.

const sheetMove: ActionDef<{ fromIndex: number; toIndex: number }> = {
  id: "sheet.move",
  category: "sheet",
  weight: 1,
  // Both ends must still address a sheet that EXISTS on replay — the lesson
  // `sheet.rename` learned as BUG-0039.
  precondition: (s, p) =>
    s.logical.sheetCount > 1 &&
    (p === undefined ||
      (p.fromIndex < s.logical.sheetCount && p.toIndex < s.logical.sheetCount)),
  pickParams: (rng, s) => {
    const last = Math.max(0, s.logical.sheetCount - 1);
    const fromIndex = pickInt(rng, 0, last);
    // Uniform over the OTHER positions: a move onto its own index renumbers
    // nothing and would still end the undo history, which is a walk step spent
    // buying an undecided checkpoint.
    let toIndex = pickInt(rng, 0, Math.max(0, last - 1));
    if (toIndex >= fromIndex) toIndex += 1;
    return { fromIndex, toIndex: Math.min(toIndex, last) };
  },
  async execute(page, _grid, p) {
    await page.evaluate(
      ({ fromIndex, toIndex }) => {
        window.dispatchEvent(
          new CustomEvent("sheet:requestMove", { detail: { fromIndex, toIndex } })
        );
      },
      { fromIndex: p.fromIndex, toIndex: p.toIndex }
    );
    await page.waitForTimeout(500);
  },
};

const sheetCopy: ActionDef<{ tabIndex: number }> = {
  id: "sheet.copy",
  category: "sheet",
  weight: 1,
  precondition: (s, p) =>
    s.logical.sheetCount < 4 &&
    (p?.tabIndex === undefined || p.tabIndex < s.logical.sheetCount),
  pickParams: (rng, s) => ({
    tabIndex: pickInt(rng, 0, Math.max(0, s.logical.sheetCount - 1)),
  }),
  async execute(page, _grid, p) {
    await page.evaluate((index: number) => {
      window.dispatchEvent(
        new CustomEvent("sheet:requestCopy", { detail: { index } })
      );
    }, p.tabIndex);
    await page.waitForTimeout(600);
  },
};

const sheetHide: ActionDef<{ tabIndex: number }> = {
  id: "sheet.hide",
  category: "sheet",
  weight: 1,
  // At least two VISIBLE sheets, or the command refuses ("Cannot hide the last
  // visible sheet") and raises a native alert that blocks Tauri IPC (BUG-0039).
  // The recorded index must still name a visible sheet on replay for the same
  // reason.
  precondition: (s, p) => {
    const visible = (s.logical.sheetVisibility ?? []).filter((v) => v === "visible");
    if (visible.length < 2) return false;
    if (p?.tabIndex === undefined) return true;
    return (s.logical.sheetVisibility ?? [])[p.tabIndex] === "visible";
  },
  pickParams: (rng, s) => {
    const visible = (s.logical.sheetVisibility ?? [])
      .map((v, i) => (v === "visible" ? i : -1))
      .filter((i) => i >= 0);
    return { tabIndex: pick(rng, visible.length ? visible : [0]) };
  },
  async execute(page, _grid, p) {
    await page.evaluate((index: number) => {
      window.dispatchEvent(
        new CustomEvent("sheet:requestHide", { detail: { index } })
      );
    }, p.tabIndex);
    await page.waitForTimeout(500);
  },
};

// The other two operations BUG-0050 made undoable. Until they existed here,
// no walk could put an unhide or a tab colour inside an undo-oracle window at
// all — hide's undo entry was tested and the other two were asserted. Both are
// observable in the sheet shape (visibility / tabColors), so §14a's
// issued-vs-effective accounting covers them from the first walk.

const sheetUnhide: ActionDef<Record<string, never>> = {
  id: "sheet.unhide",
  category: "sheet",
  weight: 1,
  // At least one hidden sheet, or the handler raises a native alert ("No
  // hidden sheets to unhide.") that blocks Tauri IPC — BUG-0039's shape.
  precondition: (s) =>
    (s.logical.sheetVisibility ?? []).some((v) => v === "hidden"),
  pickParams: () => ({}),
  async execute(page) {
    // The real route: context menu > Unhide opens the "Unhide Sheet" dialog
    // with the first hidden sheet pre-selected; OK confirms it. The OK button
    // is only clicked when the dialog's own title is on screen, because the
    // label is generic and a stray OK elsewhere must not be swallowed.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("sheet:requestUnhide", { detail: {} }));
    });
    await page.waitForTimeout(300);
    const title = page.getByText("Unhide Sheet", { exact: true });
    if (await title.isVisible({ timeout: 2000 }).catch(() => false)) {
      const ok = page.locator("button").filter({ hasText: /^OK$/ });
      if (await ok.isVisible({ timeout: 1000 }).catch(() => false)) {
        await ok.click();
      }
      await page.waitForTimeout(500);
    }
  },
};

const TAB_COLOR_PALETTE = ["#C00000", "#00B050", "#4472C4", "#FFC000"];

const sheetTabColor: ActionDef<{ tabIndex: number; color: string }> = {
  id: "sheet.tabColor",
  category: "sheet",
  weight: 1,
  // Any sheet that exists on replay. Recolouring to the colour a sheet
  // already has records no undo entry (a deliberate no-op product-side), so
  // the pick below avoids the sheet's current colour to keep the action
  // effective — an action that CANNOT change anything is not coverage.
  precondition: (s, p) =>
    p?.tabIndex === undefined || p.tabIndex < s.logical.sheetCount,
  pickParams: (rng, s) => {
    const tabIndex = pickInt(rng, 0, Math.max(0, s.logical.sheetCount - 1));
    const current = (s.logical.sheetTabColors ?? [])[tabIndex] ?? "";
    const options = TAB_COLOR_PALETTE.filter((c) => c !== current);
    return { tabIndex, color: pick(rng, options.length ? options : TAB_COLOR_PALETTE) };
  },
  async execute(page, _grid, p) {
    await page.evaluate(
      ({ tabIndex, color }) => {
        window.dispatchEvent(
          new CustomEvent("sheet:requestTabColor", {
            detail: { index: tabIndex, color },
          })
        );
      },
      { tabIndex: p.tabIndex, color: p.color }
    );
    await page.waitForTimeout(400);
  },
};

// ============================================================================
// Named range actions
// ============================================================================

const nameDefine: ActionDef<{ name: string; sheetName: string }> = {
  id: "names.define",
  category: "names",
  weight: 1,
  precondition: () => true,
  // THE SHEET IS READ FROM THE WORKBOOK, not spelled "Sheet1" and hoped for.
  // The literal made the action a silent no-op the moment anything renamed
  // sheet 0 (`create_named_range` rejects a reference to a sheet that does not
  // exist, and the call is `.catch(() => {})`), which is exactly what
  // `sheet.rename` now does. Quoted, so a copied sheet's "Sheet1 (2)" parses.
  pickParams: (_rng, s, seq) => ({
    name: `TestName_${seq}`,
    sheetName:
      s.logical.sheetNames?.[s.logical.activeSheet] ??
      s.logical.sheetNames?.[0] ??
      "Sheet1",
  }),
  async execute(page, _grid, p) {
    await invokeTauri(page, "create_named_range", {
      name: p.name,
      sheetIndex: null,
      refersTo: `='${p.sheetName}'!$A$1:$B$5`,
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
    // EXACT accessible name, not `hasText`, and `Escape` first.
    //
    // MEASURED 2026-08-12 (BUG-0037), and it explains a hang this register had
    // already recorded and never diagnosed. `filter({ hasText: "Home" })` is a
    // SUBSTRING match and `.first()` takes DOM order. Clicking the "View" tab
    // opens the View MENU, whose "Customize Home Tab..." item is a <button>
    // containing the word "Home" and lands at DOM index 22 — ten positions
    // BEFORE the real ribbon tab at 32. So the "return to Home" click opened
    // the Customize Home Tab dialog: a modal at z-index 1050 covering 100% of
    // the viewport.
    //
    // From that step on, every UI action in the walk was clicking into a
    // modal's backdrop. With `actionTimeout: 30_000` each one burns thirty
    // seconds and is TOLERATED, so the walk finishes and reports PASS over a
    // workbook whose UI had been unreachable for half the run. Before that
    // timeout existed it hung forever — which is exactly the unexplained
    // twelve-minute stall at `[step 47/75] ribbon.switch-tab` in the
    // playwright.config.ts note.
    //
    // `getByRole("button", { name, exact: true })` cannot match
    // "Customize Home Tab..." while looking for "Home". The Escape closes any
    // menu or dialog a previous action left open, so the click lands on the
    // ribbon rather than on a backdrop. The `ui-not-blocked` invariant is the
    // backstop: it fails the walk if anything is covering the ribbon after an
    // action, instead of letting the walk continue blind.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);

    const tabBtn = page.getByRole("button", { name: p.tabName, exact: true }).first();
    if (await tabBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await tabBtn.click();
      await page.waitForTimeout(200);
      if (p.tabName !== "Home") {
        const homeBtn = page.getByRole("button", { name: "Home", exact: true }).first();
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
// Scriptable object (worker-realm) actions
//
// These are the only actions that mount object scripts, so they are what makes
// the soak exercise the Phase 3 worker realm at all: each mount spawns a Worker
// that compiles + runs the script and registers a canvas renderer; render
// triggers a worker draw via getShapeBitmap; unmount terminates the worker. The
// walker churns mount/render/unmount over a bounded 4-slot pool so worker
// spawn/teardown, render-blit and event wiring run under sustained random load
// alongside every other action. Scripts mount on SYNTHETIC shape instances (no
// backing control / backend state) so they don't pollute the workbook digest
// the undo/save-reload oracles check.
// ============================================================================

// Bounded pool of script slots. Scripts mount on SYNTHETIC shape instances
// (no backing control, no backend persistence) so the soak exercises the
// worker realm — spawn / compile / setup / render / teardown — WITHOUT writing
// control or script state into the workbook digest. (Creating a real control
// trips the undo/save-reload oracles on the pre-existing "object create not
// undoable" bug — same class as BUG-0001/0002/0006 — which is path-invariant
// and would just truncate every walk, unrelated to the realm.) A non-"control-"
// instanceId also makes buildSnapshot skip its resolve_control_properties call.
const SCRIPT_SHAPE_SLOT_COUNT = 4;

const SCRIPT_SHAPE_COLORS = ["#ff0000", "#1ca31c", "#1f6fff", "#e6a100"] as const;

// Each action's execute reaches ObjectScriptManager + the host blit API via a
// dynamic import (same trick the worker-realm specs use; page.evaluate is a
// classic script, so it needs the Function wrapper + an absolute Vite URL).

const scriptShapeMount: ActionDef<{ slotIndex: number; fill: string }> = {
  id: "script.shape-mount",
  category: "script",
  weight: 4,
  precondition: () => true,
  pickParams: (rng) => ({
    slotIndex: pickInt(rng, 0, SCRIPT_SHAPE_SLOT_COUNT - 1),
    fill: pick(rng, SCRIPT_SHAPE_COLORS),
  }),
  async execute(page, _grid, p) {
    await page.evaluate(
      async (a) => {
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        const mgr = api.ObjectScriptManager;
        const id = `soak-script-${a.slotIndex}`;
        const def = {
          id,
          name: "Soak Shape Renderer",
          objectType: "shape",
          instanceId: `soak-shape-${a.slotIndex}`,
          source:
            "function setup(shape){ shape.render.canvasRenderer(function(ctx,b){ ctx.fillStyle='" +
            a.fill +
            "'; ctx.fillRect(0,0,b.width,b.height); }); }",
          accessLevel: "restricted",
          description: null,
        };
        mgr.registerScript(def);
        if (mgr.isScriptMounted(id)) mgr.unmountScript(id); // remount = teardown + respawn
        // mountScript THROWS on refusal/failure. The walker is a fuzzer, not a
        // mount test: a Script Security decision must not abort the run, but it
        // must be visible in the log rather than mistaken for a clean mount.
        //
        // TIMED, and the time is in the message. The host's mount deadline is
        // ten seconds, so "refused instantly" and "sat on the deadline" are
        // completely different findings that used to produce the same line —
        // which is exactly what made S13 undiagnosable. Note also that the
        // product has ALREADY logged `console.error("[ObjectScriptManager]
        // Failed to mount script ...")` by the time this catch runs, so a
        // failed mount fails the walk's `no-console-errors` invariant whatever
        // this handler does; this line is what tells the reader why.
        const startedAt = performance.now();
        try {
          await mgr.mountScript(id);
          const ms = Math.round(performance.now() - startedAt);
          if (ms > 2000) {
            console.warn(`[walker] script mount "${id}" took ${ms}ms (deadline 10000ms)`);
          }
        } catch (e) {
          const ms = Math.round(performance.now() - startedAt);
          console.warn(
            `[walker] script mount "${id}" refused/failed after ${ms}ms ` +
              `(deadline 10000ms):`,
            e,
          );
        }
      },
      { slotIndex: p.slotIndex, fill: p.fill },
    );
    await page.waitForTimeout(120);
  },
};

const scriptShapeRender: ActionDef<{ slotIndex: number }> = {
  id: "script.shape-render",
  category: "script",
  weight: 3,
  precondition: () => true,
  pickParams: (rng) => ({
    slotIndex: pickInt(rng, 0, SCRIPT_SHAPE_SLOT_COUNT - 1),
  }),
  async execute(page, _grid, p) {
    // Drive the worker render/draw path: getShapeBitmap kicks off an async
    // OffscreenCanvas draw in the worker, then caches the transferred bitmap.
    // No-op if the slot isn't mounted (deterministic given the seed).
    await page.evaluate(
      async (a) => {
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        const id = `soak-script-${a.slotIndex}`;
        if (!api.ObjectScriptManager.isScriptMounted(id)) return;
        const instanceId = `soak-shape-${a.slotIndex}`;
        api.getShapeBitmap(instanceId, 80, 40, 1);
        await new Promise((r) => setTimeout(r, 60));
        api.getShapeBitmap(instanceId, 80, 40, 1);
      },
      { slotIndex: p.slotIndex },
    );
    await page.waitForTimeout(80);
  },
};

const scriptShapeUnmount: ActionDef<{ slotIndex: number }> = {
  id: "script.shape-unmount",
  category: "script",
  weight: 3,
  precondition: () => true,
  pickParams: (rng) => ({
    slotIndex: pickInt(rng, 0, SCRIPT_SHAPE_SLOT_COUNT - 1),
  }),
  async execute(page, _grid, p) {
    await page.evaluate(
      async (a) => {
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        const mgr = api.ObjectScriptManager;
        const id = `soak-script-${a.slotIndex}`;
        try {
          if (mgr.isScriptMounted(id)) mgr.unmountScript(id); // terminate the worker
          mgr.removeScript(id);
        } catch {
          /* not registered */
        }
      },
      { slotIndex: p.slotIndex },
    );
    await page.waitForTimeout(80);
  },
};

// ============================================================================
// Floating-range actions (the 2026-08-13 landings: object-backed sheets,
// `=Float1!A1`). All mutations ride the @api WRAPPER module — the product's
// own announced route (`/src/api/floatingRanges.ts`), which fans out
// MUTATION_REFRESH so the FloatingRange extension reloads and paints. A raw
// invoke would mutate the backend and draw nothing (proven live by the
// floating-range journey's own first run).
//
// UNDO DOCTRINE the oracle must respect (backend-decided, §16):
//   create        keeps the history but is NOT undoable (add_sheet parity)
//                 -> the undo oracle declares such windows undecided via the
//                    baseline's floatingRangeIds (see oracles/undoRoundTrip.ts)
//   rename/delete END the history (sheet machinery) -> clearsTotal catches it
//   resize/move/cell writes are UNDOABLE -> decided windows exercise them
// ============================================================================

/** Cap on concurrently live FRs — a bounded object population keeps walks
 *  exploring lifecycle transitions instead of accumulating hundreds. */
const FR_MAX_OBJECTS = 3;

/** Import the @api wrapper in the page and call one of its functions. */
async function frApiCall(
  page: Page,
  fn: string,
  args: unknown[]
): Promise<unknown> {
  return page.evaluate(
    async ({ fn, args }) => {
      const mod = await (window as any).__calcImport(
        new URL("/src/api/floatingRanges.ts", document.baseURI).href
      );
      return await mod[fn](...args);
    },
    { fn, args }
  );
}

/** Resolve the FR at a snapshot-order index to its live row, or null. */
async function frAt(
  page: Page,
  frIndex: number
): Promise<{ id: string; name: string } | null> {
  return (await page.evaluate(async (idx: number) => {
    const tauri = (window as any).__TAURI__;
    const list = await tauri.core.invoke("list_floating_ranges").catch(() => []);
    const fr = list?.[idx];
    return fr ? { id: fr.id, name: fr.name } : null;
  }, frIndex)) as { id: string; name: string } | null;
}

const frCreate: ActionDef<{ x: number; y: number }> = {
  id: "fr.create",
  category: "floating",
  weight: 4,
  precondition: (s) => (s.logical.floatingRanges ?? []).length < FR_MAX_OBJECTS,
  // Viewport-visible position; name auto-mints ("Float1", "Float2", ...) which
  // is deterministic given the workbook state the replay reconstructs.
  pickParams: (rng) => ({
    x: 150 + pickInt(rng, 0, 12) * 24,
    y: 60 + pickInt(rng, 0, 8) * 20,
  }),
  async execute(page, _grid, p) {
    await frApiCall(page, "createFloatingRange", [p.x, p.y]);
    await page.waitForTimeout(150);
  },
};

const frSetCell: ActionDef<{
  frIndex: number;
  row: number;
  col: number;
  value: string;
}> = {
  id: "fr.setCell",
  category: "floating",
  weight: 5,
  precondition: (s, params) => {
    const frs = s.logical.floatingRanges ?? [];
    if (frs.length === 0) return false;
    if (!params) return true;
    const fr = frs[params.frIndex];
    // Replay/shrink fidelity: the write must still land inside the window, or
    // the backend refuses and the step proves nothing (BUG-0039's lesson).
    return !!fr && params.row < fr.rows && params.col < fr.cols;
  },
  pickParams: (rng, s) => {
    const frs = s.logical.floatingRanges ?? [];
    const frIndex = pickInt(rng, 0, frs.length - 1);
    const fr = frs[frIndex];
    const gridSheet = s.logical.sheetNames?.[0] ?? "Sheet1";
    // Bare refs inside an FR resolve against its OWN backing sheet; the quoted
    // cross-sheet form exercises grid->float (GAP A's class). sv-SE ';'.
    const value = pick(rng, [
      "7",
      "42",
      "-3",
      "=A1*2",
      `='${gridSheet}'!B2*2`,
      "=SUM(A1:A3)",
    ]);
    return {
      frIndex,
      row: pickInt(rng, 0, Math.max(0, (fr?.rows ?? 1) - 1)),
      col: pickInt(rng, 0, Math.max(0, (fr?.cols ?? 1) - 1)),
      value,
    };
  },
  async execute(page, _grid, p) {
    const fr = await frAt(page, p.frIndex);
    if (!fr) return; // raced away — the fr accounting shows the no-op
    await frApiCall(page, "updateFloatingRangeCell", [fr.id, p.row, p.col, p.value]);
    await page.waitForTimeout(100);
  },
};

const frResize: ActionDef<{ frIndex: number; rows: number; cols: number }> = {
  id: "fr.resize",
  category: "floating",
  weight: 3,
  precondition: (s, params) => {
    const frs = s.logical.floatingRanges ?? [];
    if (frs.length === 0) return false;
    return params ? params.frIndex < frs.length : true;
  },
  pickParams: (rng, s) => ({
    frIndex: pickInt(rng, 0, (s.logical.floatingRanges ?? []).length - 1),
    rows: pickInt(rng, 1, 5),
    cols: pickInt(rng, 1, 3),
  }),
  async execute(page, _grid, p) {
    const fr = await frAt(page, p.frIndex);
    if (!fr) return;
    await frApiCall(page, "updateFloatingRange", [
      fr.id,
      { rowCount: p.rows, colCount: p.cols },
    ]);
    await page.waitForTimeout(100);
  },
};

const frRename: ActionDef<{ frIndex: number; name: string }> = {
  id: "fr.rename",
  category: "floating",
  weight: 2,
  precondition: (s, params) => {
    const frs = s.logical.floatingRanges ?? [];
    if (frs.length === 0) return false;
    return params ? params.frIndex < frs.length : true;
  },
  // `seq` keeps the name unique across the walk; the shared sheet namespace
  // refuses collisions, and a refused rename is a wasted step, not coverage.
  pickParams: (rng, s, seq) => ({
    frIndex: pickInt(rng, 0, (s.logical.floatingRanges ?? []).length - 1),
    name: `Fl_${seq}`,
  }),
  async execute(page, _grid, p) {
    const fr = await frAt(page, p.frIndex);
    if (!fr || fr.name === p.name) return;
    await frApiCall(page, "renameFloatingRange", [fr.id, p.name]);
    await page.waitForTimeout(150);
  },
};

const frRefFromGrid: ActionDef<{ frIndex: number; ref: string; offset: number }> = {
  id: "fr.refFromGrid",
  category: "floating",
  weight: 3,
  precondition: (s, params) => {
    const frs = s.logical.floatingRanges ?? [];
    if (frs.length === 0) return false;
    return params ? params.frIndex < frs.length : true;
  },
  // Safe area AW60..AW64 (col 48) — see the safe-areas comment at the top.
  pickParams: (rng, s) => ({
    frIndex: pickInt(rng, 0, (s.logical.floatingRanges ?? []).length - 1),
    ref: `AW${60 + pickInt(rng, 0, 4)}`,
    offset: pickInt(rng, 1, 9),
  }),
  async execute(page, grid, p) {
    const fr = await frAt(page, p.frIndex);
    if (!fr) return;
    // The float->grid direction: a live formula on the ACTIVE sheet against
    // the FR's A1. Rename repair and delete->#REF! both surface exactly here.
    await grid.setCellValueDirect(p.ref, `='${fr.name}'!A1+${p.offset}`);
    await page.waitForTimeout(100);
  },
};

const frDelete: ActionDef<{ frIndex: number }> = {
  id: "fr.delete",
  category: "floating",
  weight: 2,
  precondition: (s, params) => {
    const frs = s.logical.floatingRanges ?? [];
    if (frs.length === 0) return false;
    return params ? params.frIndex < frs.length : true;
  },
  pickParams: (rng, s) => ({
    frIndex: pickInt(rng, 0, (s.logical.floatingRanges ?? []).length - 1),
  }),
  async execute(page, _grid, p) {
    const fr = await frAt(page, p.frIndex);
    if (!fr) return;
    await frApiCall(page, "deleteFloatingRange", [fr.id]);
    await page.waitForTimeout(150);
  },
};

// ============================================================================
// Export: Full Action Catalog
// ============================================================================

/**
 * Actions excluded from GENERATION because a ledgered bug makes every walk
 * that uses them fail the same way, drowning out new findings. They remain
 * in FULL_ACTION_CATALOG so recorded traces (e.g. the bug's own repro) can
 * still be replayed.
 *
 * AN EXCLUSION MUST NOT OUTLIVE ITS BUG, AND ONE DID. This list held
 * `sheet.add` / `sheet.switch` / `sheet.rename` / `sheet.delete` against
 * BUG-0005 — so for the whole programme no walk could create, switch, rename
 * or delete a sheet. BUG-0005 was closed, and the four actions stayed
 * suppressed, because nothing connected the string "BUG-0005" to the ledger
 * entry it names. That is the same failure the register already records twice
 * for the undo oracle's two suppressions: the moment the bug is fixed, the
 * suppression stops protecting the signal and starts hiding it. The sheet
 * surface was rewritten by the BUG-0005/BUG-0034 fixes and the walker still
 * could not touch a line of it.
 *
 * `app/e2e/__tests__/walkerExclusions.test.ts` now reads
 * `tests/regression/bug-ledger.json` and fails when an entry here names a bug
 * that is not open (or that does not exist). The exclusion is therefore
 * self-expiring: closing the bug turns the suppression into a red test.
 */
export const EXCLUDED_UNTIL_FIXED: Array<{ ledgerId: string; actions: AnyActionDef[] }> = [];

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
  // Scriptable objects (worker realm — Phase 3 dual-run gate)
  scriptShapeMount,
  scriptShapeRender,
  scriptShapeUnmount,
  // Floating ranges (object-backed sheets, 2026-08-13)
  frCreate,
  frSetCell,
  frResize,
  frRename,
  frRefFromGrid,
  frDelete,
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
  // Sheets — generated again since BUG-0005/BUG-0034 closed the sheet-unaware
  // undo hole; see EXCLUDED_UNTIL_FIXED above for why the suppression had to
  // become self-expiring.
  sheetAdd,
  sheetSwitch,
  sheetRename,
  sheetDelete,
  sheetMove,
  sheetCopy,
  sheetHide,
  sheetUnhide,
  sheetTabColor,
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
