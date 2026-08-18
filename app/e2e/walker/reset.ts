//! FILENAME: app/e2e/walker/reset.ts
// PURPOSE: Thorough workbook reset for walks and trace replays.
//
// Plain resetToNewWorkbook (Tauri new_file) is NOT sufficient — the conclusion
// is right and the MECHANISM in the original sentence was not, so it is restated
// here rather than deleted (corrected 2026-08-17).
//
// `new_file` DOES clear the backend, sparklines included
// (`reset_document_scoped_stores`). What it does not do is ANNOUNCE, so every
// FRONTEND object store keeps the outgoing document's objects — and worse, the
// teardown ABOVE announces `objects` / `slicer` / `ribbonFilter` a few hundred ms
// BEFORE new_file, so four stores are actively repopulated from the outgoing
// document and then stranded when the backend empties (BUG-0075, and BUG-0004
// before it). Contextual ribbon tabs and object caches therefore leak into the
// next walk.
//
// Leaked state breaks replay fidelity — the generator's context-aware weighting
// and trace replays both depend on a deterministic starting state — so walks tear
// down all objects through their own APIs first, then new_file, then RE-SYNC the
// frontend stores against the new document (the last read must be taken against
// the NEW document or the race is only narrowed), then clear undo history.

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
      // AND FROM THE BACKEND'S OWN LIST, because the store is not a census of
      // the document (BUG-0075). Anything that persists a chart WITHOUT going
      // through the store — a raw `save_chart` invoke from a spec, an import, a
      // script — leaves `get_charts` holding a chart `getAllCharts()` has never
      // heard of, and a teardown that enumerates only the store deletes NOTHING
      // and reports success. Measured 2026-08-15: 1 chart in the backend, 0 in
      // the store, at the start of every scenario run.
      const entries = (await tauri.core.invoke("get_charts").catch(() => [])) as Array<{
        id?: string;
      }>;
      for (const entry of entries ?? []) {
        if (entry?.id) {
          await tauri.core.invoke("delete_chart", { id: entry.id }).catch(() => {});
        }
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

  await resyncChartStoreToBackend(page);
  await resyncObjectStoresToBackend(page);
}

/**
 * Make the FRONTEND chart store agree with the document that now exists — and
 * FAIL if it will not.
 *
 * THE TEARDOWN ABOVE IS NOT ENOUGH, AND THE REASON IS ORDERING, NOT COVERAGE.
 * Measured end to end on 2026-08-15 with an in-page instrument (BUG-0075):
 *
 *     +0ms       backend=1 store=0   the residue a raw `save_chart` leaves
 *     +10251ms   charts:refresh      the TABLE teardown a few lines above
 *                                    announces the `objects` domain, and the
 *                                    Shell fans that out to `charts:refresh`
 *     +10331ms   backend=1 store=1   the extension reloads its store from a
 *                                    backend that still holds the OUTGOING
 *                                    document's chart
 *     +10794ms   backend=0 store=1   `new_file` cleared the backend; NOTHING
 *                                    re-syncs the store
 *
 * The store is what paints, so from here a chart with no document behind it
 * rides through the whole next scenario. It was photographed by
 * `scenario-budget-model-title` — 173,986 differing pixels — and the frame is
 * unreachable in the product: File > New and File > Open both
 * `window.location.reload()` after the backend switch (`FileMenu.ts`), and even
 * the non-reloading `file-api.ts` path emits AFTER_NEW / AFTER_OPEN, which the
 * Charts extension answers by reloading the store from the backend. Only this
 * harness replaces a document with a raw `new_file` invoke, which announces
 * nothing — so only this harness owes the re-sync.
 *
 * It is done AFTER `new_file` on purpose: the last read of the backend has to be
 * the one taken against the NEW document, or the race is merely narrowed. The
 * FloatingRange block above forces the same re-sync for the same reason
 * (BUG-0056); this is that discipline applied to the object type that had it
 * only halfway.
 *
 * AND IT IS ASSERTED. A reset that cannot reach a clean state is a finding, not
 * something to leave for the next capture to discover.
 */
async function resyncChartStoreToBackend(page: Page): Promise<void> {
  const DEADLINE_MS = 5_000;
  const started = Date.now();
  let last = { backend: -1, store: -1 };

  while (Date.now() - started < DEADLINE_MS) {
    last = await page.evaluate(async () => {
      const w = window as any;
      // The product's own re-sync path: the same event the undo handler and the
      // `objects` domain translator use, so the harness stays on public surfaces.
      window.dispatchEvent(new Event("charts:refresh"));
      await new Promise((resolve) => setTimeout(resolve, 250));
      let backend = -1;
      try {
        backend = ((await w.__TAURI__.core.invoke("get_charts")) as unknown[]).length;
      } catch {
        /* no Tauri runtime — leave it at -1 */
      }
      const store = (w.__CALCULA_CHARTS__?.getAllCharts?.() ?? []).length;
      w.__CALCULA_CHARTS__?.syncChartRegions?.();
      return { backend, store };
    });
    if (last.store === 0 && last.backend <= 0) return;
    await page.waitForTimeout(150);
  }

  throw new Error(
    `deepResetForWalk: the chart store still holds ${last.store} chart(s) after ` +
      `new_file (backend reports ${last.backend}) and ${DEADLINE_MS / 1000}s of ` +
      `re-syncing. That is the BUG-0075 state: a chart with no document behind it, ` +
      `which PAINTS, so every screenshot taken after this point is of a workbook ` +
      `the product cannot produce.`,
  );
}

/**
 * THE SAME DEFECT, THREE MORE OBJECT TYPES.
 *
 * `resyncChartStoreToBackend` above documents the mechanism (BUG-0075). It is not
 * specific to charts: the reset's OWN table teardown, a few lines above, calls
 * `deleteTableAsync`, which announces the `objects`, `slicer` and `ribbonFilter`
 * domains — and the Shell fans `objects` out to `sparklines:refresh` as well as
 * `charts:refresh`, and `slicer` out to BOTH `slicers:refresh` and
 * `timelineslicers:refresh`. So four more frontend stores are repopulated from the
 * OUTGOING document ~500 ms before `new_file` empties the backend, by exactly the
 * mechanism the chart comment describes. Only charts were re-synced afterwards.
 *
 * WHY SPARKLINES ARE THE WORST OF THEM, and why this is not merely cosmetic:
 * `stateSnapshot.ts` reads sparkline groups from the STORE while it reads charts
 * and slicers from the BACKEND. So a stale sparkline store does not just paint —
 * it satisfies the walker's `sparkline.delete` and `sparkline.select-into`
 * preconditions, and `removeSparklineGroup` then calls `saveToBackend`, WRITING
 * THE PREVIOUS DOCUMENT'S GROUPS INTO THE NEW ONE. That is corruption authored by
 * the harness, reported as a product finding.
 *
 * PANE CONTROLS ARE A LEAK RATHER THAN A RACE: nothing in the reset reaches them
 * at all. Their only other trigger is a `sheet:activated` listener that no code in
 * `app/` dispatches — recorded in open-items as a product question, because if
 * that listener is genuinely dead then a pane control's cached value can outlive a
 * sheet switch in the PRODUCT, not only in this harness.
 */
async function resyncObjectStoresToBackend(page: Page): Promise<void> {
  await resyncOneStore(page, {
    label: "sparkline",
    event: "sparklines:refresh",
    invoke: "get_sparklines",
    // The walker reads sparkline groups from the STORE, so a stale one is not
    // cosmetic: it makes delete/select-into act on the previous document.
    countStore: `(window.__CALCULA_SPARKLINES__?.getAllGroups?.() ?? []).length`,
    consequence:
      "the walker reads sparkline groups from the STORE, so a stale one satisfies " +
      "sparkline.delete / select-into and saveToBackend then writes the PREVIOUS " +
      "document's groups into the new one",
  });

  await resyncOneStore(page, {
    label: "slicer",
    event: "slicers:refresh",
    invoke: "get_all_slicers",
    countStore: `(window.__CALCULA_SLICER__?.getAllSlicers?.() ?? []).length`,
    // `refreshCache` is the ANNOUNCER: it diffs, prunes itemsCache, emits
    // SLICER_DELETED per vanished slicer and calls syncSlicerRegions, which is
    // what actually takes the ghost overlay off the grid. Do NOT shortcut it with
    // a resetStore() — that clears the cache without the diff, so nothing tells
    // the ribbon its contextual tab is dead, which is the BUG-0026 shape.
    consequence:
      "a stale slicer paints a ghost overlay and keeps its contextual ribbon tab " +
      "alive over a document that has no slicer",
  });

  // Timeline slicers share the `slicer` domain but are a SECOND extension with a
  // SECOND cache, which is why the domain fans out to two events.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("timelineslicers:refresh"));
  });

  // Pane controls: no window bridge exists for this extension, so there is no
  // store to count. Dispatch the product's own INPUT event and let its
  // `refreshControlsCache` re-read the backend and diff.
  //
  // THE NAME IS A TRAP. The input is "controlspane:controls-refreshed"; the
  // extension's own `ControlsPaneEvents.CONTROLS_REFRESHED` is
  // "paneControl:refreshed", which is what `refreshControlsCache` EMITS. They
  // differ by one word, and dispatching the output name is a silent no-op.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("controlspane:controls-refreshed"));
  });
  await page.waitForTimeout(150);
}

/** One store's re-sync: dispatch the product's refresh event, poll, assert. */
async function resyncOneStore(
  page: Page,
  spec: {
    label: string;
    event: string;
    invoke: string;
    countStore: string;
    consequence: string;
  },
): Promise<void> {
  const DEADLINE_MS = 5_000;
  const started = Date.now();
  let last = { backend: -1, store: -1 };

  while (Date.now() - started < DEADLINE_MS) {
    last = await page.evaluate(
      async (s: { event: string; invoke: string; countStore: string }) => {
        const w = window as any;
        window.dispatchEvent(new Event(s.event));
        await new Promise((resolve) => setTimeout(resolve, 250));
        let backend = -1;
        try {
          backend = ((await w.__TAURI__.core.invoke(s.invoke)) as unknown[]).length;
        } catch {
          /* no Tauri runtime — leave it at -1 */
        }
        let store = -1;
        try {
          // eslint-disable-next-line no-eval
          store = Number(eval(s.countStore));
        } catch {
          store = -1;
        }
        return { backend, store };
      },
      { event: spec.event, invoke: spec.invoke, countStore: spec.countStore },
    );
    // store === -1 means the extension exposes no bridge in this build; that is
    // not a failure, it is an absence of evidence, and the dispatch still ran.
    if ((last.store === 0 || last.store === -1) && last.backend <= 0) return;
    await page.waitForTimeout(150);
  }

  throw new Error(
    `deepResetForWalk: the ${spec.label} store still holds ${last.store} item(s) ` +
      `after new_file (backend reports ${last.backend}) and ${DEADLINE_MS / 1000}s ` +
      `of re-syncing. Consequence: ${spec.consequence}. This is the BUG-0075 shape ` +
      `for ${spec.label}s — the reset's own table teardown repopulates the store ` +
      `from the OUTGOING document before new_file empties the backend.`,
  );
}

