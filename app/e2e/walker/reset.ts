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
import { sweepNativeDialogs } from "../helpers/nativeDialogs";

/**
 * How long the reset may take before it concludes Tauri IPC is blocked.
 *
 * A full deep reset measured 1-3 seconds across this programme's walks; the
 * slowest observed is well under ten. 90s is far above that and far below the
 * 30-minute spec timeout the hang used to consume.
 */
const RESET_TIMEOUT_MS = 90_000;

export async function deepResetForWalk(page: Page): Promise<void> {
  await runResetOnce(page, "first");
}

/**
 * The reset, bounded, with ONE retry after a dialog sweep.
 *
 * THE HANG WAS HERE, not in the walk. `deepResetForWalk` issues a long chain of
 * `tauri.core.invoke` calls inside a single `page.evaluate`; if one of them
 * never settles, the evaluate never settles, and nothing above it has a
 * timeout. That is where a soak walk sat for its entire 30-minute budget
 * without printing a line (BUG-0039) — behind twelve stacked native dialogs.
 *
 * Note what is NOT claimed: a single native alert does not necessarily block
 * IPC. Measured on the live app, one open alert left `get_charts` answering
 * normally; the pile-up is what stopped `new_file`. So the bound is here for
 * the case the sweep cannot see coming, and the sweep is what actually keeps
 * the pile from forming.
 */
async function runResetOnce(page: Page, attempt: "first" | "retry"): Promise<void> {
  // A NATIVE dialog left standing by the previous walk (or the previous shrink
  // replay) blocks Tauri invokes this reset is about to make, and Escape
  // cannot reach it — it is a separate Win32 window, not part of the page.
  // Sweep before anything else, and SAY SO, because a reset that has to clear
  // dialogs is itself a finding.
  const sweep = sweepNativeDialogs();
  if (sweep.dismissed.length > 0) {
    console.log(
      `  [reset] dismissed ${sweep.dismissed.length} leftover native dialog(s): ` +
        sweep.dismissed.map((t) => `"${t}"`).join("; ")
    );
  }

  const TIMED_OUT = Symbol("reset-timeout");
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    resetBody(page).then(() => "ok" as const),
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), RESET_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (outcome !== TIMED_OUT) return;

  const second = sweepNativeDialogs();
  if (attempt === "first") {
    console.log(
      `  [reset] TIMED OUT after ${RESET_TIMEOUT_MS / 1000}s — Tauri IPC is not ` +
        `answering. Native dialogs found now: ` +
        (second.dismissed.length
          ? second.dismissed.map((t) => `"${t}"`).join("; ")
          : "(none)") +
        `. Retrying once.`
    );
    await runResetOnce(page, "retry");
    return;
  }
  throw new Error(
    `deepResetForWalk: Tauri IPC did not answer within ${RESET_TIMEOUT_MS / 1000}s, ` +
      `twice. Native dialogs dismissed on the way: ` +
      (second.dismissed.length ? second.dismissed.join("; ") : "(none found)") +
      `. This is a REPORTED failure rather than the silent multi-hour hang it ` +
      `used to be (BUG-0039).`
  );
}

async function resetBody(page: Page): Promise<void> {
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
      // `chartId`, not `id` — the store's key. This read `c.id`, which is
      // undefined on a ChartDefinition, so the reset deleted NOTHING and
      // charts accumulated across every walk of a session (BUG-0035). A reset
      // whose whole stated purpose is deterministic replay fidelity was
      // leaking the one object type it appeared to clean.
      const chartApi = w.__CALCULA_CHARTS__;
      for (const c of chartApi?.getAllCharts?.() ?? []) {
        chartApi.deleteChart(c.chartId ?? c.id);
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
      // Floating ranges: the same BUG-0004/BUG-0035 discipline — tear down
      // through the ANNOUNCED @api wrapper so the extension prunes its store,
      // then force one reload so a store already stale from an earlier raw
      // `new_file` re-syncs to the backend truth even when there was nothing
      // left to delete. MEASURED 2026-08-14 (BUG-0056): the reset relied on
      // `new_file` alone, which clears the backend rows and tells the
      // extension nothing (`resetToNewWorkbook` never emits AFTER_NEW — the
      // product's File > New reloads the whole window instead), so the three
      // FRs one walk created poisoned EVERY later walk in the session at
      // step 1 with "[FloatingRange] Failed to fetch cells" console errors.
      const frApi = (await (window as any).__calcImport(
        new URL("/src/api/floatingRanges.ts", document.baseURI).href,
      )) as {
        listFloatingRanges: () => Promise<Array<{ id: string }>>;
        deleteFloatingRange: (id: string) => Promise<void>;
      };
      for (const fr of await frApi.listFloatingRanges().catch(() => [])) {
        await frApi.deleteFloatingRange(fr.id).catch(() => {});
      }
      const frStore = (await (window as any).__calcImport(
        new URL(
          "/extensions/FloatingRange/lib/floatingRangeStore.ts",
          document.baseURI,
        ).href,
      )) as {
        resetFloatingRangeStore?: () => void;
        loadFloatingRangesFromBackend?: () => Promise<void>;
        syncFloatingRangeRegions?: () => void;
      };
      frStore.resetFloatingRangeStore?.();
      await frStore.loadFloatingRangesFromBackend?.();
      frStore.syncFloatingRangeRegions?.();
    } catch { /* extension absent */ }

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
