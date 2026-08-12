/**
 * CASCADE ANNOUNCEMENT — proved LIVE, on the real app, through the real harness.
 *
 * WHAT THIS PROVES AND WHY IT IS A JOURNEY
 * ----------------------------------------
 * BUG-0026 was found by the soak walk and by the invariant walk independently,
 * both reducing to the SAME three actions:
 *
 *     table.create  ->  slicer.create  ->  table.delete
 *
 * The slicer really is deleted (the §3bt backend cascade works). The RIBBON kept
 * offering a "Slicer" contextual tab for a slicer that no longer existed, because
 * `SLICER_DELETED` was dispatched from exactly one place in the tree — the
 * BY-HAND delete — and a backend cascade never passes through it. The fix moved
 * the announcement into the store's own `refreshCache` diff (§3cd), so every
 * route announces, including routes that do not exist yet.
 *
 * §3cd closed it with unit tests and four sabotage checks. What it never did is
 * DRIVE IT. This file does, on a running app, through `WalkRunner` over the exact
 * committed `minimized.trace.json` — the same runner, the same catalog, the same
 * `ALL_INVARIANTS` that reported the violation in the first place. A fix that is
 * only ever checked by the census that was added alongside it is checked by its
 * own author.
 *
 * It lives in `journeys` and not in `tests` for the reason that project exists:
 * it deep-resets the workbook (deleting every table, chart, pivot and slicer the
 * shared instance holds) and it deletes a SHEET. Both would shift the goldens of
 * the ~20 functional specs that run after it alphabetically.
 *
 * EVERY "IT IS GONE" ASSERTION IS PAIRED WITH A POSITIVE CONTROL
 * -------------------------------------------------------------
 * "The Slicer tab is absent" is also what a broken tab reader reports, and what
 * an app with no ribbon at all reports. So each cascade is asserted in TWO
 * states on the same run: the tab must be PRESENT after the object is created,
 * and ABSENT after the cascade. A detector that cannot see the tab fails the
 * first half; a product that does not clean up fails the second. Neither half
 * can pass vacuously while the other holds.
 *
 * Grid area: the walker's own safe areas — chart data Z1:AA3 (cols 25-26) and
 * table AE1:AG3 (cols 30-32). Nothing else in the tree writes there.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import { ALL_INVARIANTS, captureSnapshot } from "../invariants";
import type { StateSnapshot } from "../invariants";
import {
  WalkRunner,
  createTraceSource,
  deepResetForWalk,
  formatWalkReport,
  FULL_ACTION_CATALOG,
} from "../walker";
import type { ActionTrace } from "../walker";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(HERE, "../results/cascade-live");

/**
 * The trace is written out here rather than loaded from the failure bundle it
 * was minimized into. A bundle under `e2e/results/` is a RUN ARTEFACT: it is
 * regenerated, pruned and gitignored, so a spec that reads one is a spec that
 * passes vacuously the first time somebody cleans the directory. These are the
 * three actions the ddmin reduced to, verdict `confirmed` over 20 replays (soak
 * seed 20260812731) and over 30 (invariant seed 20260812914).
 */
const BUG_0026_TRACE: ActionTrace = {
  version: 1,
  seed: 20260812914,
  startedAt: "2026-08-11T21:58:36.481Z",
  actions: [
    { id: "table.create", params: {} },
    { id: "slicer.create", params: { name: "Slicer_51" } },
    { id: "table.delete", params: {} },
  ],
};

/** Contextual tabs carry an accent colour; ordinary tabs do not. */
function contextualTabLabels(snapshot: StateSnapshot): string[] {
  return snapshot.visual.ribbonTabs
    .filter((t) => t.accentColor !== null)
    .map((t) => t.label);
}

test.describe("Cascade announcements reach the UI (BUG-0026)", () => {
  // A deep reset plus three actions plus two snapshots. The project's 300s
  // ceiling is ample; this is stated so a future slowdown reads as a slowdown.
  test.setTimeout(180_000);

  test("BUG-0026: deleting the owning table takes the Slicer tab with it", async ({
    appPage,
    grid,
  }) => {
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(500);

    // --- POSITIVE CONTROL -----------------------------------------------
    // Run the first TWO actions only, and require the tab to be THERE. If the
    // ribbon reader cannot see a contextual tab, or the slicer never gets
    // created, this fails here — and the "it is gone" assertion below is then
    // known not to be passing for the wrong reason.
    const armRunner = new WalkRunner(appPage, grid, {
      source: createTraceSource(
        { ...BUG_0026_TRACE, actions: BUG_0026_TRACE.actions.slice(0, 2) },
        FULL_ACTION_CATALOG
      ),
      invariants: ALL_INVARIANTS,
      oracleBattery: null,
      maxActions: 2,
      settleTimeMs: 300,
      resultsDir: RESULTS_DIR,
      catalog: FULL_ACTION_CATALOG,
    });
    const armed = await armRunner.run();
    expect(
      armed.passed,
      `arming the reproduction must not itself violate an invariant:\n${formatWalkReport(armed)}`
    ).toBe(true);

    const withSlicer = await captureSnapshot(appPage);
    expect(
      withSlicer.logical.tables.length,
      "table.create must have produced a table"
    ).toBeGreaterThan(0);
    expect(
      withSlicer.logical.slicers.length,
      "slicer.create must have produced a slicer"
    ).toBe(1);
    expect(
      contextualTabLabels(withSlicer),
      "POSITIVE CONTROL: a selected slicer must raise its contextual tab — " +
        "without this the absence assertion below proves nothing"
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^Slicer/)]));

    // --- THE CASCADE ------------------------------------------------------
    const killRunner = new WalkRunner(appPage, grid, {
      source: createTraceSource(
        { ...BUG_0026_TRACE, actions: BUG_0026_TRACE.actions.slice(2) },
        FULL_ACTION_CATALOG
      ),
      invariants: ALL_INVARIANTS,
      oracleBattery: null,
      maxActions: 1,
      settleTimeMs: 600,
      resultsDir: RESULTS_DIR,
      catalog: FULL_ACTION_CATALOG,
    });
    const killed = await killRunner.run();

    // The invariant battery is the ORIGINAL reporter of this bug. Asserting on
    // it (rather than only on hand-written checks) is what makes this a
    // reproduction rather than a look-alike.
    expect(
      killed.passed,
      `the three-action reproduction must leave every invariant intact:\n${formatWalkReport(killed)}`
    ).toBe(true);

    const after = await captureSnapshot(appPage);

    expect(
      after.logical.tables.length,
      "table.delete must have removed the table"
    ).toBe(0);
    expect(
      after.logical.slicers.length,
      "the backend cascade must have removed the slicer with its table"
    ).toBe(0);
    expect(
      contextualTabLabels(after).filter((l) => l.startsWith("Slicer")),
      "BUG-0026: a contextual Slicer tab survived the slicer it configures"
    ).toEqual([]);

    // NO WEDGED OVERLAY. The store used to keep painting a slicer whose backend
    // object was gone, and answer "Slicer <id> not found" the moment anything
    // touched it. Both the store's own view and the painted overlay must be
    // empty, and nothing may have been logged.
    const overlay = await appPage.evaluate(() => {
      const w = window as any;
      return {
        storeSlicers: (w.__CALCULA_SLICER__?.getAllSlicers?.() ?? []).length,
        selectedSlicer: w.__CALCULA_SLICER__?.getSelectedSlicerId?.() ?? null,
        overlayNodes: document.querySelectorAll("[data-slicer-id]").length,
      };
    });
    expect(overlay.storeSlicers, "the slicer store must have dropped it too").toBe(0);
    expect(overlay.selectedSlicer, "the selection must not name a dead slicer").toBeNull();
    expect(overlay.overlayNodes, "no orphaned slicer overlay may remain painted").toBe(0);

    expect(after.consoleErrors, "no console error during the cascade").toEqual([]);
    expect(after.jsExceptions, "no uncaught exception during the cascade").toEqual([]);
  });

  /**
   * THE SECOND PAIR, and the one the §3cd transitive walk found silent as
   * ORPHAN #1: `delete_sheet` deletes the CHARTS on the sheet and never ran
   * `cascade_deleted_charts`. The reproduction the walk could not build is the
   * one below, because the catalog's `chart.create` hardcodes `sheetIndex: 0`
   * and its `sheet.delete` always deletes the LAST sheet — so the generator can
   * never put a chart on a sheet it will later delete. Driven by hand here.
   */
  test("a chart on a deleted SHEET takes its contextual tab with it", async ({
    appPage,
  }) => {
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(500);

    const before = await captureSnapshot(appPage);
    const baseSheetCount = before.logical.sheetCount;

    // Add a sheet and put a chart on IT, not on sheet 0.
    await appPage.locator('button[title="Add new sheet"]').click({ force: true });
    await appPage.waitForTimeout(800);

    const added = await captureSnapshot(appPage);
    expect(
      added.logical.sheetCount,
      "the sheet tab bar and the backend must agree that a sheet was added"
    ).toBe(baseSheetCount + 1);
    const targetSheet = added.logical.sheetCount - 1;

    // The snapshot's own `activeSheet` used to be a CONSTANT 0: it read a key
    // (`gridState.activeSheet`) that does not exist and defaulted. Adding a
    // sheet switches to it, so this is the cheapest live proof that the field
    // now tracks the app instead of reporting a default.
    expect(
      added.logical.activeSheet,
      "snapshot.logical.activeSheet must follow the app, not default to 0"
    ).toBe(targetSheet);

    // THROUGH THE STORE'S OWN CREATE. A raw `save_chart` persists the chart and
    // leaves the store empty, so `selectChart` below would be a no-op and the
    // positive control would fail for a reason that has nothing to do with the
    // cascade. That is not a hypothesis: it is what this spec measured on the
    // first run, and it is fixed in the walker's catalog too.
    await appPage.evaluate(async (sheetIndex: number) => {
      const spec = {
        mark: "bar",
        data: { sheetIndex, startRow: 0, startCol: 25, endRow: 2, endCol: 26 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Value", color: "#4472C4" }],
        title: "CascadeOrphanChart",
      };
      const store = (await (window as any).__calcImport(
        new URL("/extensions/Charts/lib/chartStore.ts", document.baseURI).href,
      )) as {
        createChart: (spec: unknown, placement: Record<string, unknown>) => { chartId: string };
        syncChartRegions: () => void;
      };
      store.createChart(spec, {
        sheetIndex,
        x: 400,
        y: 40,
        width: 480,
        height: 300,
        name: "CascadeOrphanChart",
      });
      store.syncChartRegions();
    }, targetSheet);
    await appPage.waitForTimeout(600);

    // Select it, so the contextual tab is raised — the state a user is in when
    // something else deletes the sheet under them.
    await appPage.evaluate(() => {
      const chartApi = (window as any).__CALCULA_CHARTS__;
      const charts = chartApi?.getAllCharts?.() ?? [];
      if (charts.length > 0) chartApi.selectChart(charts[0].id);
    });
    await appPage.waitForTimeout(400);

    // --- POSITIVE CONTROL -------------------------------------------------
    const withChart = await captureSnapshot(appPage);
    expect(withChart.logical.charts.length, "the chart must exist").toBe(1);
    expect(
      withChart.logical.charts[0].sheetIndex,
      "the chart must be on the sheet that is about to be deleted"
    ).toBe(targetSheet);
    expect(
      contextualTabLabels(withChart),
      "POSITIVE CONTROL: a selected chart must raise a chart contextual tab"
    ).toEqual(expect.arrayContaining([expect.stringMatching(/Chart Design|^Design$/)]));

    // --- THE CASCADE ------------------------------------------------------
    await appPage.evaluate((idx: number) => {
      window.dispatchEvent(
        new CustomEvent("sheet:requestDelete", { detail: { index: idx } })
      );
    }, targetSheet);
    await appPage.waitForTimeout(400);
    const confirmDelete = appPage.locator("button").filter({ hasText: /^Delete$/ });
    if (await confirmDelete.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmDelete.click();
    }
    await appPage.waitForTimeout(1200);

    const after = await captureSnapshot(appPage);

    expect(
      after.logical.sheetCount,
      "the sheet must be gone, and the TAB BAR must say so — `sheets:refresh` " +
        "had no listener anywhere in the app before §3cd"
    ).toBe(baseSheetCount);
    expect(
      after.logical.charts.length,
      "deleting a sheet must delete the charts on it"
    ).toBe(0);
    expect(
      contextualTabLabels(after).filter((l) => /Chart Design|^Design$/.test(l)),
      "ORPHAN #1: a chart contextual tab survived the sheet its chart sat on"
    ).toEqual([]);

    // `getCurrentChartId`, NOT `getSelectedChartId` — the latter does not exist
    // on `__CALCULA_CHARTS__`, so reading it would return undefined and this
    // assertion would pass against any product whatsoever. (It did, on the
    // first draft of this file.)
    const chartResidue = await appPage.evaluate(() => {
      const w = window as any;
      const api = w.__CALCULA_CHARTS__;
      if (typeof api?.getCurrentChartId !== "function") {
        throw new Error(
          "__CALCULA_CHARTS__.getCurrentChartId is missing — this assertion " +
            "would be vacuous; fix the probe, do not delete the check",
        );
      }
      return {
        storeCharts: (api.getAllCharts?.() ?? []).length,
        selectedChart: api.getCurrentChartId() ?? null,
      };
    });
    expect(chartResidue.storeCharts, "the chart store must have dropped it too").toBe(0);
    expect(
      chartResidue.selectedChart,
      "the selection must not name a chart on a sheet that no longer exists"
    ).toBeNull();

    expect(after.consoleErrors, "no console error during the sheet cascade").toEqual([]);
    expect(after.jsExceptions, "no uncaught exception during the sheet cascade").toEqual([]);
  });
});
