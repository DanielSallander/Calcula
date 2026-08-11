//! FILENAME: app/e2e/walker/reset.ts
// PURPOSE: Thorough workbook reset for walks and trace replays.
//
// Plain resetToNewWorkbook (Tauri new_file) is NOT sufficient: new_file
// leaves sparkline groups behind and frontend object stores are not
// notified, so contextual ribbon tabs and object caches leak into the next
// walk (ledgered as BUG-0004). Leaked state breaks replay fidelity — the
// generator's context-aware weighting and trace replays both depend on a
// deterministic starting state — so walks explicitly tear down all objects
// through their own APIs first, then new_file, then clear undo history.

import type { Page } from "@playwright/test";
import { resetToNewWorkbook } from "../helpers/screenshots";

export async function deepResetForWalk(page: Page): Promise<void> {
  // Close any dialogs/menus first so deletes don't get swallowed.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
  }

  // Tear down objects via their own APIs (frontend stores stay in sync).
  await page.evaluate(async () => {
    const w = window as any;
    const tauri = w.__TAURI__;

    try {
      const slicerApi = w.__CALCULA_SLICER__;
      for (const s of slicerApi?.getAllSlicers?.() ?? []) {
        await slicerApi.deleteSlicerAsync(s.id).catch(() => {});
      }
    } catch { /* extension absent */ }

    try {
      const chartApi = w.__CALCULA_CHARTS__;
      for (const c of chartApi?.getAllCharts?.() ?? []) {
        chartApi.deleteChart(c.id);
      }
      chartApi?.syncChartRegions?.();
    } catch { /* extension absent */ }

    try {
      const sparkApi = w.__CALCULA_SPARKLINES__;
      for (const g of sparkApi?.getAllGroups?.() ?? []) {
        sparkApi.removeSparklineGroup(g.id);
      }
    } catch { /* extension absent */ }

    try {
      const pivots = await tauri.core.invoke("get_all_pivot_tables").catch(() => []);
      for (const p of (pivots as any[]) ?? []) {
        const id = p.pivotId ?? p.id;
        if (id !== undefined) {
          await tauri.core.invoke("delete_pivot_table", { pivotId: id }).catch(() => {});
        }
      }
    } catch { /* none */ }

    try {
      // THROUGH THE EXTENSION'S OWN DELETE, like every other teardown here.
      // A raw `delete_table` invoke removes the table from the backend and
      // tells the frontend nothing: the Table store keeps its cache, the
      // contextual Table Design tab stays registered, and the walk starts in a
      // state the product cannot reach. That is what seed 20260810 failed on --
      // at STEP 1, with an unrelated action, because the violation was already
      // true before the walk began.
      const store = (await (window as any).__calcImport(
        new URL("/extensions/Table/lib/tableStore.ts", document.baseURI).href,
      )) as {
        getAllTables?: () => Array<{ id: string }>;
        deleteTableAsync?: (id: string) => Promise<boolean>;
      };
      const tables = await tauri.core.invoke("get_all_tables", {}).catch(() => []);
      for (const t of (tables as any[]) ?? []) {
        if (store?.deleteTableAsync) {
          await store.deleteTableAsync(t.id).catch(() => {});
        } else {
          await tauri.core.invoke("delete_table", { tableId: t.id }).catch(() => {});
        }
      }
    } catch { /* none */ }

    try {
      await tauri.core.invoke("remove_auto_filter", {}).catch(() => {});
    } catch { /* none */ }

    // Worker-realm soak actions mount scripts on synthetic instances via the
    // frontend manager only (no backend control/script state), so terminating
    // any leaked workers + clearing the registry gives each walk/replay a
    // deterministic empty realm.
    try {
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      ).catch(() => null);
      await api?.resetObjectScriptManager?.();
    } catch { /* none */ }
  });
  await page.waitForTimeout(300);

  // Fresh workbook + UI reset (new_file, grid:refresh, Escape, Ctrl+Home).
  //
  // This is ALSO what gives walks a clean undo stack, and it is the only thing
  // that does. There used to be a `clear_undo_history` invoke here; the command
  // is gone (it had no product caller and no product route — see
  // `undo_commands.rs`), and it was already redundant, because `new_file` runs
  // `reset_document_scoped_stores`, which empties the stack. Nothing between
  // that call and here pushes a transaction: Escape and Ctrl+Home navigate.
  await resetToNewWorkbook(page);
  await page.waitForTimeout(200);
}
