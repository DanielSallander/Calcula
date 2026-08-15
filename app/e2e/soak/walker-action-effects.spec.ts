//! FILENAME: app/e2e/soak/walker-action-effects.spec.ts
// PURPOSE: Prove, on a live app, that the walker's object-lifecycle actions
//          ACTUALLY DO SOMETHING.
//
// THIS IS THE THIRD TIME. The walker's value is entirely in what its actions
// do to the product, and an action that silently no-ops is indistinguishable
// from one that works: the walk logs it, the trace records it, the report
// counts it, and every oracle downstream sees an unchanged workbook and passes.
//
//   * `table.delete` called the raw `delete_table` command instead of the
//     product's delete, leaving the Slicer store holding a dead object.
//   * BUG-0031: `chart.create` invoked `save_chart` directly, so the BACKEND
//     had charts and the STORE had none — `chart.select` and `chart.delete`
//     both took their list from the store and did nothing at all, and the
//     `contextual-ribbon-tabs` invariant could never once observe a chart tab.
//   * BUG-0035: with create fixed, `chart.select`/`chart.delete` read
//     `charts[0].id` — but a stored ChartDefinition's key is `chartId`, so the
//     id was `undefined` and both were STILL no-ops. Measured on a live
//     chart-weighted walk: 46 chart actions, 9 charts left behind,
//     `getCurrentChartId()` never once non-null. `deepResetForWalk` read the
//     same wrong key, so charts leaked from every walk into the next.
//
// A unit test cannot catch any of these: the defect is always in the seam
// between the harness and a real running extension. So this spec drives the
// catalog's OWN action objects — not a re-implementation — against a live app
// and asserts the observable effect each one claims.
//
// It lives in the `soak` project rather than `e2e/tests` because it deep-resets
// the workbook, which would shift the functional suite's shared goldens.

import { test, expect } from "../fixtures";
import { FULL_ACTION_CATALOG, deepResetForWalk, findAction } from "../walker";
import { captureSnapshot } from "../invariants/stateSnapshot";
import type { Page } from "@playwright/test";

const act = (id: string) => {
  const def = findAction(id, FULL_ACTION_CATALOG);
  if (!def) throw new Error(`No such action in the catalog: ${id}`);
  return def;
};

/** Backend chart count — the authority the walker's preconditions read. */
async function backendChartCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const charts = await (window as any).__TAURI__.core.invoke("get_charts");
    return Array.isArray(charts) ? charts.length : -1;
  });
}

/** Frontend chart store count — the authority the walker's actions read. */
async function storeChartIds(page: Page): Promise<Array<string | null>> {
  return page.evaluate(() => {
    const api = (window as any).__CALCULA_CHARTS__;
    const charts = api?.getAllCharts?.() ?? [];
    return charts.map((c: any) => c.chartId ?? c.id ?? null);
  });
}

async function currentChartId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (window as any).__CALCULA_CHARTS__?.getCurrentChartId?.() ?? null
  );
}

test.describe("the walker's object actions have real effects", () => {
  test.setTimeout(240_000);

  test("chart lifecycle: create -> select -> deselect -> delete", async ({
    appPage,
    grid,
  }) => {
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(500);

    expect(await backendChartCount(appPage), "reset left charts behind").toBe(0);
    expect(await storeChartIds(appPage), "reset left store charts behind").toEqual([]);

    // --- create ---
    await act("chart.create").execute(appPage, grid, { title: "Effects_1" });
    await appPage.waitForTimeout(400);

    const idsAfterCreate = await storeChartIds(appPage);
    expect(await backendChartCount(appPage), "backend did not gain a chart").toBe(1);
    expect(idsAfterCreate.length, "store did not gain a chart (BUG-0031)").toBe(1);
    expect(
      idsAfterCreate[0],
      "the stored chart exposes no usable id — this is BUG-0035, and it makes " +
        "chart.select and chart.delete silent no-ops"
    ).toBeTruthy();

    // --- select ---
    await act("chart.select").execute(appPage, grid, {});
    await appPage.waitForTimeout(400);
    expect(
      await currentChartId(appPage),
      "chart.select selected nothing — the invariant that watches contextual " +
        "ribbon tabs can never fire on charts while this is true"
    ).toBe(idsAfterCreate[0]);

    // The whole reason `chart.select` exists: it must raise a contextual tab,
    // which is the only chart state the `contextual-ribbon-tabs` invariant can
    // see. A green invariant walk over a surface that cannot raise its tab is
    // a green that means nothing.
    const snapshot = await captureSnapshot(appPage);
    const contextual = snapshot.visual.ribbonTabs.filter((t) => t.accentColor !== null);
    expect(
      contextual.map((t) => t.label),
      "selecting a chart raised no contextual ribbon tab"
    ).toContain("Chart Design");

    // --- deselect ---
    await act("chart.deselect").execute(appPage, grid, {});
    await appPage.waitForTimeout(300);
    expect(await currentChartId(appPage), "chart.deselect deselected nothing").toBeNull();

    // --- delete ---
    await act("chart.select").execute(appPage, grid, {});
    await appPage.waitForTimeout(300);
    await act("chart.delete").execute(appPage, grid, {});
    await appPage.waitForTimeout(600);
    expect(await storeChartIds(appPage), "chart.delete left the store unchanged").toEqual(
      []
    );
    expect(
      await backendChartCount(appPage),
      "chart.delete left the backend unchanged — charts accumulate forever and " +
        "the delete half of the lifecycle is untested"
    ).toBe(0);

    // BUG-0036: deleting the SELECTED chart must clear the selection and drop
    // the contextual tab. It did not, and this is the state the walker caught:
    // a "Chart Design" tab over a workbook with zero charts.
    expect(
      await currentChartId(appPage),
      "the deleted chart is still the selected chart — every Chart Design " +
        "command now aims at an id that no longer exists"
    ).toBeNull();
    const afterDelete = await captureSnapshot(appPage);
    expect(
      afterDelete.visual.ribbonTabs
        .filter((t) => t.accentColor !== null)
        .map((t) => t.label),
      "the Chart Design tab outlived the last chart"
    ).not.toContain("Chart Design");
  });

  test("the SCRIPT/MCP delete route clears the selection too (BUG-0036)", async ({
    appPage,
    grid,
  }) => {
    // The route that was actually broken. `api.deleteChart` (object scripts,
    // MCP tools, the broker) goes through the component-store registry, which
    // carried its OWN copy of the delete recipe — no deselect, no selection
    // announcement, and a cache invalidate where a cache remove was required.
    // The UI's Delete key was correct, so no UI test could ever have found it.
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(400);

    await act("chart.create").execute(appPage, grid, { title: "ScriptRoute_1" });
    await appPage.waitForTimeout(400);
    await act("chart.select").execute(appPage, grid, {});
    await appPage.waitForTimeout(300);

    const selected = await currentChartId(appPage);
    expect(selected, "nothing was selected, so this test proves nothing").toBeTruthy();

    const deleted = await appPage.evaluate(async (chartId: string) => {
      const registry = await (window as any).__calcImport(
        new URL("/src/api/componentStoreRegistry.ts", document.baseURI).href
      );
      const store = registry.getChartStoreService();
      if (!store) throw new Error("no chart store service is registered");
      return store.deleteChart(chartId);
    }, selected as string);
    expect(deleted, "the registry route reported no such chart").toBe(true);
    await appPage.waitForTimeout(500);

    expect(
      await currentChartId(appPage),
      "a script deleted the selected chart and the selection still points at it"
    ).toBeNull();
    expect(await backendChartCount(appPage)).toBe(0);
    const snapshot = await captureSnapshot(appPage);
    expect(
      snapshot.visual.ribbonTabs
        .filter((t) => t.accentColor !== null)
        .map((t) => t.label),
      "a script deleted the last chart and left its contextual tab on screen"
    ).not.toContain("Chart Design");
  });

  test("deleting a chart does NOT deselect a DIFFERENT selected chart", async ({
    appPage,
    grid,
  }) => {
    // The old UI recipe deselected unconditionally. Excel keeps B selected when
    // A is deleted, and the context-menu route could already pass another
    // chart's id — so the single recipe deselects only when the deleted chart
    // IS the selected one. Without this case, "always deselect" would pass the
    // two tests above and quietly break the context menu.
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(400);

    await act("chart.create").execute(appPage, grid, { title: "Keep_A" });
    await appPage.waitForTimeout(350);
    await act("chart.create").execute(appPage, grid, { title: "Keep_B" });
    await appPage.waitForTimeout(350);

    const ids = await storeChartIds(appPage);
    expect(ids.length).toBe(2);

    // Select the SECOND chart, delete the FIRST.
    await appPage.evaluate(
      (id: string) => (window as any).__CALCULA_CHARTS__.selectChart(id),
      ids[1] as string
    );
    await appPage.waitForTimeout(300);
    expect(await currentChartId(appPage)).toBe(ids[1]);

    await appPage.evaluate(
      (id: string) => (window as any).__CALCULA_CHARTS__.deleteChart(id),
      ids[0] as string
    );
    await appPage.waitForTimeout(500);

    expect(
      await currentChartId(appPage),
      "deleting an unrelated chart dropped the user's selection"
    ).toBe(ids[1]);
    expect(await backendChartCount(appPage)).toBe(1);
  });

  test("deepResetForWalk really clears charts between walks", async ({
    appPage,
    grid,
  }) => {
    // Replay fidelity is the reset's whole justification (see reset.ts). It was
    // deleting nothing for charts, so walk N+1 started with walk N's charts and
    // no recorded trace could be replayed faithfully.
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(400);

    for (const title of ["Leak_1", "Leak_2", "Leak_3"]) {
      await act("chart.create").execute(appPage, grid, { title });
      await appPage.waitForTimeout(250);
    }
    expect(await backendChartCount(appPage)).toBe(3);

    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(500);

    expect(await storeChartIds(appPage), "charts leaked past the reset").toEqual([]);
    expect(await backendChartCount(appPage), "charts leaked past the reset").toBe(0);
  });

  test("a chart the store never learned about does not survive the reset (BUG-0075)", async ({
    appPage,
    grid,
  }) => {
    // THE ONE ABOVE CANNOT CATCH THIS, and the difference is the whole bug.
    // It creates charts through the product, so the frontend store and the
    // backend agree and a teardown that enumerates EITHER of them works. This
    // test creates the chart the way a spec does when it takes the shortcut —
    // a raw `save_chart` invoke — which leaves `get_charts` holding a chart
    // `getAllCharts()` has never heard of.
    //
    // Measured on 2026-08-15, that state does not merely survive the reset, it
    // gets WORSE inside it: the reset's own TABLE teardown announces the
    // `objects` domain (ObjectKind::Table -> UiDomain::Objects), the Shell fans
    // that out to `charts:refresh`, and the extension reloads its store from a
    // backend that still holds the outgoing document's chart — 500ms before
    // `new_file` empties that backend. The store keeps the chart, the store is
    // what paints, and a chart with no document behind it was photographed by
    // `scenario-budget-model-title` (173,986 differing pixels).
    //
    // Hence the table: it is not scenery, it is the trigger.
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(400);

    await act("table.create").execute(appPage, grid, {});
    await appPage.waitForTimeout(400);

    await appPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 5, endCol: 1 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Value", color: "#4472C4" }],
        title: "Blind_1",
      };
      await tauri.core.invoke("save_chart", {
        entry: { id: crypto.randomUUID(), sheetIndex: 0, specJson: JSON.stringify(spec) },
      });
    });
    await appPage.waitForTimeout(400);

    // The precondition this test is about. If the product ever starts telling
    // the store about a raw `save_chart`, this expectation fails and the test
    // is no longer testing what it says — which is the right way to find out.
    expect(await backendChartCount(appPage)).toBe(1);
    expect(
      await storeChartIds(appPage),
      "a raw save_chart is supposed to leave the store blind — if it no longer " +
        "does, this test's premise is stale",
    ).toEqual([]);

    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(500);

    expect(await backendChartCount(appPage), "BUG-0075: chart left in the document").toBe(0);
    expect(
      await storeChartIds(appPage),
      "BUG-0075: the chart store holds a chart the document does not contain — " +
        "it PAINTS, so every capture after this point is of a workbook the " +
        "product cannot produce",
    ).toEqual([]);
  });

  test("every object family's create and delete move the count the walker reads", async ({
    appPage,
    grid,
  }) => {
    // The generic net. Preconditions are read off a live snapshot, exactly as
    // the generator reads them, so this asserts the SAME two facts the walker
    // depends on: a create makes the delete's precondition true, and a delete
    // makes it false again. A no-op on either side pins the walk in a state it
    // can never leave — which is how the chart bug showed up as nine charts and
    // a run of eight consecutive `chart.delete`s that deleted nothing.
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(500);

    const families: Array<{
      create: string;
      del: string;
      count: (s: Awaited<ReturnType<typeof captureSnapshot>>) => number;
      /** Actions this family's create needs run first. */
      requires?: string[];
      /** Params for actions whose execute reads them (fr.* resolve by index/
       *  coordinates; the generic title/name object would be undefined x/y). */
      createParams?: Record<string, unknown>;
      delParams?: Record<string, unknown>;
    }> = [
      { create: "chart.create", del: "chart.delete", count: (s) => s.logical.charts.length },
      { create: "table.create", del: "table.delete", count: (s) => s.logical.tables.length },
      {
        create: "slicer.create",
        del: "slicer.delete",
        count: (s) => s.logical.slicers.length,
        requires: ["table.create"],
      },
      {
        create: "sparkline.create",
        del: "sparkline.delete",
        count: (s) => s.logical.sparklineGroups.length,
      },
      {
        // Floating ranges (2026-08-13): the newest object family, added the
        // day its FIRST walk found the reset gap (BUG-0056) — this net is the
        // standing answer to exactly that class.
        create: "fr.create",
        del: "fr.delete",
        count: (s) => (s.logical.floatingRanges ?? []).length,
        createParams: { x: 220, y: 90 },
        delParams: { frIndex: 0 },
      },
    ];

    for (const family of families) {
      await deepResetForWalk(appPage);
      await appPage.waitForTimeout(400);

      for (const prereq of family.requires ?? []) {
        await act(prereq).execute(appPage, grid, {});
        await appPage.waitForTimeout(300);
      }

      const before = family.count(await captureSnapshot(appPage));
      await act(family.create).execute(
        appPage,
        grid,
        family.createParams ?? { title: "Net_1", name: "Net_1" }
      );
      await appPage.waitForTimeout(500);
      const afterCreate = family.count(await captureSnapshot(appPage));
      expect(afterCreate, `${family.create} did not raise the count`).toBeGreaterThan(
        before
      );

      await act(family.del).execute(appPage, grid, family.delParams ?? {});
      await appPage.waitForTimeout(600);
      const afterDelete = family.count(await captureSnapshot(appPage));
      expect(afterDelete, `${family.del} did not lower the count`).toBeLessThan(
        afterCreate
      );
    }

    await deepResetForWalk(appPage);
  });
});
