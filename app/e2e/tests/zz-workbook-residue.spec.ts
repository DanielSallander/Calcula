/**
 * THE RESIDUE GUARD — the last spec in the functional run, on purpose.
 *
 * WHY IT EXISTS (docs/design/open-decisions-2026-08.md §3b). The functional
 * specs share one accumulating workbook. That has always been described as a
 * screenshot-golden problem, and it is worse than that: an object left floating
 * over the grid is HIT-TESTABLE. `animation.spec.ts` — the fourth spec in the
 * run — left a playback driver loaded, so Animation's play pill sat over A1:C2
 * for the remaining eighty-nine spec files and swallowed every
 * `grid.clickCell("A1")`. Cell writes went wherever the selection happened to
 * be and cell reads came back as some earlier spec's text. Roughly thirty
 * "failures" across nine files were that one object, and every one of them
 * looked like a defect in the feature under test.
 *
 * That particular pill was fixed at the source (D4): it is viewport-pinned DOM
 * chrome now and registers no grid region at all. `"animation-play"` stays in
 * the list below anyway — a guard's list is cheap and the point of this file is
 * that nobody could SEE the class until it was named. If a future change puts a
 * transport back into cell coordinates, this fails on the same line it failed
 * on the first time.
 *
 * Nothing in the suite could see it. `resetGrid` clears cells; `new_file`
 * clears the document but NOT the frontend's floating-object layer (proved:
 * `dimensions.spec.ts` calls `resetToNewWorkbook` and the pill and the chart
 * both survived it). So the leak was invisible to every existing mechanism and
 * was only found by reading a failure screenshot.
 *
 * This spec makes it visible. It asserts nothing about any feature: it asserts
 * that the RUN left the workbook in the state the next run's goldens were
 * recorded against. A failure here does not mean this file is broken — it means
 * some spec earlier in the run created an object and did not remove it, and the
 * message says which kind. Fix it where it was created (a `test.afterAll` that
 * deletes what the file made), never here.
 *
 * It runs last because the file name sorts last. Do not rename it.
 */
import { test, expect } from "../fixtures";

/** Floating region types a spec is expected to clean up after itself. */
const OWNED_REGION_TYPES = [
  "chart",
  "animation-play",
  "shape",
  "image",
  "control",
  "sparkline",
];

test.describe("Workbook residue guard (runs last)", () => {
  test("no spec left a floating object on the grid", async ({ appPage }) => {
    // Read through the handle the SHELL publishes, never through the dev
    // `__calcImport` bridge. That bridge performs a real dynamic import, so for
    // a stateful module it returns a SECOND instance — `getGridRegions()` on it
    // answers `[]` no matter what is painted. The first version of this guard
    // did exactly that and would have passed forever while the grid was covered
    // in leaked objects. A guard that cannot fail is worse than no guard.
    const leftovers = await appPage.evaluate(() => {
      const reg = (window as unknown as {
        __CALCULA_GRID_OVERLAYS__?: { getGridRegions: () => Array<{ id: string; type: string }> };
      }).__CALCULA_GRID_OVERLAYS__;
      if (!reg) return null;
      return reg.getGridRegions().map((r) => ({ id: r.id, type: r.type }));
    });

    expect(
      leftovers,
      "window.__CALCULA_GRID_OVERLAYS__ is missing — it is published by shell/bootstrap.ts " +
        "and is the only truthful reading of the live overlay registry.",
    ).not.toBeNull();

    const owned = (leftovers ?? []).filter((r) => OWNED_REGION_TYPES.includes(r.type));
    expect(
      owned,
      "A spec created a floating object and did not delete it. It has been sitting " +
        "over the grid — and eating clicks — for every spec that ran after it. Add a " +
        "test.afterAll to the spec that created it; see e2e/tests/animation.spec.ts.",
    ).toEqual([]);
  });

  test("no spec left a chart in the backend", async ({ appPage }) => {
    const charts = await appPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const list: Array<{ id: string }> = await tauri.core.invoke("get_charts");
      return list.map((c) => c.id);
    });
    expect(
      charts,
      "A spec persisted a chart through save_chart and never deleted it. Charts " +
        "survive resetGrid AND new_file, and reappear in the frontend on the next " +
        "charts:refresh — see e2e/tests/charts.spec.ts for the cleanup shape.",
    ).toEqual([]);
  });

  /**
   * THE FOURTH RESIDUE CLASS, and the one that cost three goldens (BUG-0074).
   *
   * A table is not a floating object and it is not cell state, so neither guard
   * above could see it and no reset in the suite removes it: `resetGrid` clears
   * cells, `clear_range_with_options` clears cells, and a table is a DEFINITION
   * the Table extension's style interceptor repaints from on every frame.
   * `tables.spec.ts` built one over V1:W2 — inside `comments-notes.spec.ts`'s
   * declared W-X ground — and never deleted it, so on the SECOND and every later
   * run against the same app process, `comments-notes`' three captures
   * photographed an Excel TableStyleMedium2 header (#4472C4, white bold text)
   * and a banded row (#D9E2F3) that no test in their file creates.
   *
   * Measured after one full cold functional run before the fix: `get_all_tables`
   * returned Table1 (R1:T4), SalesData (V1:W2) and TotalsTest (R7:S10) — three
   * tables, from three tests, none of them cleaned up.
   *
   * It never showed up in the run that caused it, because `tables` sorts after
   * `comments-notes`. That is exactly the shape a guard is for.
   */
  test("no spec left a table in the backend", async ({ appPage }) => {
    const tables = await appPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const list: Array<{ name: string; startRow: number; startCol: number; endRow: number; endCol: number }> =
        await tauri.core.invoke("get_all_tables", {});
      return list.map(
        (t) => `${t.name} r${t.startRow}-${t.endRow} c${t.startCol}-${t.endCol}`,
      );
    });
    expect(
      tables,
      "A spec created a table and never deleted it. A table survives resetGrid AND " +
        "clear_range_with_options — the chrome is repainted from the DEFINITION by " +
        "Table's style interceptor, so it will recolour every cell in its range for " +
        "every spec that runs after it AND for every later run against this app " +
        "process. Add a test.afterAll that deletes it; see e2e/tests/tables.spec.ts.",
    ).toEqual([]);
  });

  test("no spec left a side panel open, shrinking the grid area", async ({ appPage }) => {
    // The third residue class, and the cheapest one to miss: an open sidebar
    // panel takes ~320px off `[data-grid-area]`, so every later grid golden
    // fails on SIZE before a single pixel is compared — "Expected an image
    // 1232px by 556px, received 912px by 556px". `panel-placement.spec.ts`
    // opened the Animation panel and restored only the PLACEMENT, so
    // `paste-special` and `protection` failed four results between them, none of
    // them about pasting or protection.
    //
    // Asserted as a fraction of the window rather than an absolute width, so it
    // does not become a second golden that has to be maintained.
    const geom = await appPage.evaluate(() => {
      const area = document.querySelector("[data-grid-area]") as HTMLElement | null;
      return area ? { grid: area.getBoundingClientRect().width, window: window.innerWidth } : null;
    });
    expect(geom, "[data-grid-area] not found").not.toBeNull();
    const ratio = geom!.grid / geom!.window;
    expect(
      ratio > 0.8,
      `The grid area is ${Math.round(geom!.grid)}px of a ${geom!.window}px window ` +
        `(${(ratio * 100).toFixed(0)}%). A spec left a side panel open. Close it in a ` +
        `finally/afterAll in the spec that opened it — every grid golden after it is ` +
        `being compared at the wrong SIZE.`,
    ).toBe(true);
  });

  /**
   * REPORTS the accumulated used range. Deliberately NOT an assertion.
   *
   * The first version of this test asserted "nothing outside A1:Z1000" and it
   * failed on the suite's own deliberate convention: specs park their fixtures
   * in far columns to avoid colliding with each other (`status-bar` in R:S,
   * `edge-cases` in AE:AH, `evaluate-formula` in AI, `scrolling` out at row
   * 5000). That convention is what makes those specs independent in CELL terms
   * and it is not going to be given up for a guard.
   *
   * But the used range is NOT free of consequences, and this is the honest
   * statement of what it costs: it sets the horizontal and vertical SCROLLBAR
   * THUMB, which is on-screen in every `[data-grid-area]` golden. So a spec that
   * parks data at column AL changes the picture every later spec captures, even
   * though the data itself is off-screen. That is the residual §3b class — see
   * the register — and closing it is a decision about the goldens (reset before
   * capture, and re-record), not something a guard can enforce.
   *
   * Printing the number gives whoever picks that up a starting measurement.
   */
  test("REPORT: the accumulated used range (scrollbar thumbs are a function of it)", async ({
    appPage,
  }) => {
    const used = await appPage.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return (await tauri.core.invoke("get_used_range", {})) as {
        startRow: number; startCol: number; endRow: number; endCol: number; empty: boolean;
      };
    });
    console.log(
      `[residue] used range after the whole run: ` +
        (used.empty
          ? "empty"
          : `r0..${used.endRow} c0..${used.endCol} ` +
            `(beyond A1:Z1000 by ${Math.max(0, used.endRow - 999)} rows / ` +
            `${Math.max(0, used.endCol - 25)} cols)`),
    );
    expect(used).toBeTruthy();
  });
});
