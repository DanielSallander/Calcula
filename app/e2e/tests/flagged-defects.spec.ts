/**
 * FLAGGED DEFECTS — PROVED LIVE.
 *
 * One spec per flagged defect from the VBA-idiom parity waves + the hidden-rows
 * data-loss fix, asserted through the REAL UI wherever a UI exists.
 *
 * WHAT MAKES THE SUBTOTAL TESTS DECISIVE. The wrong-answer bug was that
 * SUBTOTAL's 101-111 family behaved exactly like 1-11: both ignored the fact
 * that a row was hidden. Asserting "109 excludes a hidden row" alone would not
 * catch a regression that made BOTH families exclude it. So every hide here is
 * asserted as a PAIR: the 101-111 value MOVES and the 1-11 value STAYS. A single
 * shared "hidden" notion cannot satisfy both halves at once.
 *
 * THE VALUES ARE THE RENDERED ONES. `renderedTotals()` reads `get_viewport_cells`
 * — the exact command `GridCanvas` calls to obtain the `display` strings it
 * paints — not `get_cell`. In addition, the immediacy test diffs real canvas
 * PIXELS across the hide gesture, which is why the formulas live ABOVE the row
 * that gets hidden: rows below a hide shift upward and would change those pixels
 * whatever the values did, making the pixel oracle meaningless. Formulas in rows
 * 2-7 with data in rows 10-14 do not move, so a pixel change there can only be
 * a repaint of a changed number.
 *
 * GRID REAL ESTATE. Other specs own columns D, H, J, K, L, N, O, P, R, T-Z and
 * AA-AD, and the hidden-rows spec owns rows 2-19 of D/H/J. This spec uses
 * E, F, G (aggregates), I and M (clipboard), Q (validation) and S (notes), and
 * every test starts from `new_file`, so nothing here can survive into another
 * spec's coordinates.
 *
 * LOCALE. sv-SE: the formula argument separator is ';', never ','.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";

// --- Geometry: columns this spec owns -------------------------------------
const COL_E = 4; // aggregate DATA
const COL_F = 5; // aggregate FORMULAS
const COL_G = 6; // cross-sheet formulas
const COL_I = 8; // clipboard SOURCE
const COL_M = 12; // clipboard DESTINATION
const COL_Q = 16; // data validation
const COL_S = 18; // notes

/**
 * Aggregate layout. Formulas ABOVE the data on purpose — see the header: a hide
 * below them leaves their pixels alone unless the VALUE changed.
 */
const F_ROWS = { sub9: 1, sub109: 2, sub1: 3, sub101: 4, agg0: 5, agg5: 6 };
const DATA_TOP = 9; // E10 .. E14 (0-based rows 9..13)
const DATA_VALUES = [10, 20, 30, 40, 50];
/** The row hidden in the manual-hide tests: E10, value 10, BELOW every formula. */
const HIDE_ROW = DATA_TOP; // 9

const TMP_DIR = path.join(os.tmpdir(), "calcula-flagged-e2e");

// ---------------------------------------------------------------------------
// Backend plumbing — setup and oracles, never the thing under test
// ---------------------------------------------------------------------------

async function invokeBackend<T>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ cmd, args }) => {
      const tauri = (window as any).__TAURI__;
      return (await tauri.core.invoke(cmd, args)) as unknown;
    },
    { cmd, args },
  ) as Promise<T>;
}

/**
 * Dispatch a grid action through the app's own dispatch bridge — the exact
 * mechanism `AdvancedFilter` uses (`dispatchGridAction(setHiddenRows(...))`).
 *
 * Needed because the FRONTEND's hidden/zoom state is owned by the reducer, not
 * by the backend: `apply_auto_filter` moves Rust's authority (which is all
 * SUBTOTAL needs) but never touches `dimensions.filterHiddenRows`, which is what
 * the clipboard reads. Driving only the backend would make the clipboard tests
 * pass or fail for reasons unrelated to the clipboard.
 */
async function dispatchGrid(page: Page, action: string, arg: unknown): Promise<void> {
  await page.evaluate(
    async ({ action, arg }) => {
      const w = window as any;
      const gd = await w.__calcImport(new URL("/src/api/gridDispatch.ts", document.baseURI).href);
      const ga = await w.__calcImport(
        new URL("/src/core/state/gridActions.ts", document.baseURI).href,
      );
      gd.dispatchGridAction((ga as any)[action](arg));
    },
    { action, arg },
  );
  await page.waitForTimeout(250);
}

/**
 * Run an extension store's own refresh, the way that extension's dialog does.
 *
 * Creating a note or a validation rule through a raw Tauri command moves the
 * BACKEND only. The extension keeps a frontend cache (and, for validation, a set
 * of grid REGIONS) that its own UI refreshes after every edit — and those
 * regions are load-bearing, not cosmetic: `createFillHandleCursorChecker`
 * suppresses the fill handle inside a registered region, and the fill handle's
 * hit box otherwise covers the bottom two-thirds of the 18px chevron. Skipping
 * this step makes the chevron look broken for a reason that has nothing to do
 * with the chevron. (Verified live: without the refresh the list only opens in
 * the top ~5px of the button; with it, everywhere.)
 */
async function refreshExtensionStore(page: Page, modulePath: string, fn: string): Promise<void> {
  await page.evaluate(
    async ({ modulePath, fn }) => {
      const m: any = await (window as any).__calcImport(
        new URL(modulePath, document.baseURI).href,
      );
      await m[fn]();
    },
    { modulePath, fn },
  );
  await page.waitForTimeout(500);
}

/**
 * Force the FRONTEND zoom factor (1 = 100%).
 *
 * Every test here starts by normalising it. Zoom scales the canvas transform, so
 * a stray 1.5 left behind by another test silently moves every cell this spec
 * clicks — a column 16 cell lands past the right edge of the canvas and the
 * click hits nothing at all. That is not hypothetical: the zoom test below
 * reopens a 150%-zoom file, the app hydrates the frontend from it on mount, and
 * without this reset the data-validation and note tests that follow would click
 * empty space.
 */
async function setFrontendZoom(page: Page, factor: number): Promise<void> {
  await dispatchGrid(page, "setZoom", factor);
}

/** Wipe the in-memory workbook and let the reducer catch up. */
async function wipeWorkbook(page: Page): Promise<void> {
  await invokeBackend(page, "new_file", {});
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(800);
}

async function seed(
  page: Page,
  cells: Array<{ row: number; col: number; value: string }>,
): Promise<void> {
  await page.evaluate(async (cells) => {
    const tauri = (window as any).__TAURI__;
    for (const c of cells) {
      await tauri.core.invoke("update_cell", { row: c.row, col: c.col, value: c.value });
    }
    window.dispatchEvent(new Event("grid:refresh"));
  }, cells);
  await page.waitForTimeout(250);
}

/**
 * The values the CANVAS has. `get_viewport_cells` is the command GridCanvas
 * itself calls for the `display` strings it paints, so this is the rendered
 * text, not a private backend field the UI might never have fetched.
 */
async function renderedTotals(page: Page, col: number, rows: number[]): Promise<string[]> {
  const cells = await invokeBackend<Array<{ row: number; col: number; display: string }>>(
    page,
    "get_viewport_cells",
    {
      startRow: Math.min(...rows),
      startCol: col,
      endRow: Math.max(...rows),
      endCol: col,
    },
  );
  const byRow = new Map(cells.map((c) => [c.row, String(c.display ?? "")]));
  return rows.map((r) => byRow.get(r) ?? "");
}

/** The six aggregate cells, in the fixed order sub9, sub109, sub1, sub101, agg0, agg5. */
async function aggregates(page: Page): Promise<Record<keyof typeof F_ROWS, string>> {
  const order = Object.keys(F_ROWS) as Array<keyof typeof F_ROWS>;
  const values = await renderedTotals(
    page,
    COL_F,
    order.map((k) => F_ROWS[k]),
  );
  return Object.fromEntries(order.map((k, i) => [k, values[i]])) as Record<
    keyof typeof F_ROWS,
    string
  >;
}

/** Seed the standard aggregate fixture: formulas rows 2-7, data rows 10-14. */
async function seedAggregateFixture(page: Page): Promise<void> {
  const cells: Array<{ row: number; col: number; value: string }> = [];
  DATA_VALUES.forEach((v, i) =>
    cells.push({ row: DATA_TOP + i, col: COL_E, value: String(v) }),
  );
  const range = `E${DATA_TOP + 1}:E${DATA_TOP + DATA_VALUES.length}`;
  cells.push({ row: F_ROWS.sub9, col: COL_F, value: `=SUBTOTAL(9;${range})` });
  cells.push({ row: F_ROWS.sub109, col: COL_F, value: `=SUBTOTAL(109;${range})` });
  cells.push({ row: F_ROWS.sub1, col: COL_F, value: `=SUBTOTAL(1;${range})` });
  cells.push({ row: F_ROWS.sub101, col: COL_F, value: `=SUBTOTAL(101;${range})` });
  cells.push({ row: F_ROWS.agg0, col: COL_F, value: `=AGGREGATE(9;0;${range})` });
  cells.push({ row: F_ROWS.agg5, col: COL_F, value: `=AGGREGATE(9;5;${range})` });
  await seed(page, cells);
}

// ---------------------------------------------------------------------------
// REAL UI: row header right-click -> Hide / Unhide
// ---------------------------------------------------------------------------

/**
 * A clickable pixel of a row header, found by asking the app's OWN hit-testing
 * which pixel belongs to the line — and skipping the drag-to-resize handles,
 * which `handleMouseDown` tests FIRST and which collide on hidden neighbours.
 */
async function rowHeaderPoint(page: Page, index: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(async (index) => {
    const ht: any = await (window as any).__calcImport(
      new URL("/src/core/lib/gridRenderer/interaction/hitTesting.ts", document.baseURI).href,
    );
    const gs = (window as any).__CALCULA_GRID_STATE__;
    const cfg = gs.config;
    const area = document.querySelector("[data-grid-area]") as HTMLElement | null;
    if (!area) throw new Error("[data-grid-area] not found");
    const rect = area.getBoundingClientRect();

    const outlineW = cfg.outlineBarWidth ?? 0;
    const headerW = cfg.rowHeaderWidth ?? 22;
    const headerH = cfg.colHeaderHeight ?? 20;
    const x = outlineW + (headerW - outlineW) / 2;

    // hitTesting works in LOGICAL (pre-zoom) pixels; a Playwright click position
    // is in CSS pixels. Scan logically, then scale — otherwise every point is
    // off by the zoom factor and the click lands on a different row entirely.
    const zoom = gs.zoom || 1;
    const logicalHeight = rect.height / zoom;

    const clean: number[] = [];
    let seen = false;
    for (let y = Math.ceil(headerH) + 1; y < logicalHeight - 2; y += 1) {
      const onLine = ht.getRowFromHeader(x, y, cfg, gs.viewport, gs.dimensions) === index;
      if (onLine) {
        seen = true;
        if (ht.getRowResizeHandle(x, y, cfg, gs.viewport, gs.dimensions) === null) clean.push(y);
      } else if (seen) break;
    }
    if (clean.length === 0) return null;
    return { x: x * zoom, y: clean[Math.floor(clean.length / 2)] * zoom };
  }, index);
}

/** Left-click a row header to select the whole row (the real gesture). */
async function selectRowViaHeader(page: Page, index: number): Promise<void> {
  const pt = await rowHeaderPoint(page, index);
  if (!pt) throw new Error(`row ${index} has no header pixels — cannot click it`);
  await page.locator("[data-grid-area]").click({ position: pt, force: true });
  await page.waitForTimeout(200);
  const sel = await page.evaluate(
    () => (window as any).__CALCULA_GRID_STATE__?.selection?.type ?? null,
  );
  expect(sel, `header click on row ${index} must select the whole row`).toBe("rows");
}

/** Right-click a row header and click a context-menu item by its EXACT label. */
async function rowHeaderMenuClick(
  page: Page,
  index: number,
  label: "Hide" | "Unhide",
): Promise<void> {
  const pt = await rowHeaderPoint(page, index);
  if (!pt) throw new Error(`row ${index} has no header pixels — cannot right-click it`);
  await page.locator("[data-grid-area]").click({ position: pt, button: "right", force: true });

  const menu = page.locator('[role="menu"][aria-label="Context menu"]');
  await expect(menu, "the grid context menu must open on a header right-click").toBeVisible({
    timeout: 5_000,
  });
  const item = menu.locator('[role="menuitem"]').filter({ hasText: new RegExp(`^${label}$`) });
  await expect(item, `"${label}" must be offered for this row selection`).toHaveCount(1);
  await item.click();
  await expect(menu).toBeHidden({ timeout: 5_000 });
  await page.waitForTimeout(500);
}

/** Hide a row through the real UI: select the header, then right-click > Hide. */
async function hideRowViaUI(page: Page, index: number): Promise<void> {
  await selectRowViaHeader(page, index);
  await rowHeaderMenuClick(page, index, "Hide");
}

/**
 * Unhide a hidden row through the real UI. A hidden row has no header pixels of
 * its own, so the gesture is Excel's: select the rows AROUND it (here: the whole
 * data block via the Name Box) and use Unhide.
 */
async function unhideAllViaUI(page: Page, firstRow: number, lastRow: number): Promise<void> {
  // `firstRow` must be a VISIBLE row above the hidden one: a hidden row has no
  // header pixels of its own, so it cannot be clicked. This is Excel's gesture —
  // select the rows around the gap, then Unhide.
  await selectRowViaHeader(page, firstRow);
  const endPt = await rowHeaderPoint(page, lastRow);
  if (!endPt) throw new Error(`row ${lastRow} has no header pixels`);
  await page.locator("[data-grid-area]").click({ position: endPt, modifiers: ["Shift"], force: true });
  await page.waitForTimeout(200);
  await rowHeaderMenuClick(page, firstRow, "Unhide");
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Apply a real AutoFilter and mirror its hidden rows into the reducer.
 *
 * BOTH halves are needed and they serve different assertions: the backend half
 * is what Rust's SUBTOTAL consults, the reducer half is what the clipboard
 * consults. The mirror is the same call the AutoFilter/AdvancedFilter extensions
 * make, so this is the app's own path, not a test-only shortcut.
 */
async function applyFilterHiding(
  page: Page,
  range: { startRow: number; startCol: number; endRow: number; endCol: number },
  keepValues: string[],
): Promise<number[]> {
  await invokeBackend(page, "apply_auto_filter", { params: range });
  await page.waitForTimeout(300);
  const res = await invokeBackend<{ hiddenRows: number[] }>(page, "set_column_filter_values", {
    columnIndex: 0,
    values: keepValues,
    includeBlanks: false,
  });
  const hidden = res.hiddenRows ?? [];
  await dispatchGrid(page, "setHiddenRows", hidden);
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(400);
  return hidden;
}

async function clearFilter(page: Page): Promise<void> {
  await invokeBackend(page, "remove_auto_filter", {});
  await dispatchGrid(page, "setHiddenRows", []);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function tmpFile(name: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return path.join(TMP_DIR, `${name}-${process.pid}-${Date.now()}.cala`);
}

async function saveTo(page: Page, filePath: string): Promise<void> {
  const err = await page.evaluate(async (p) => {
    const tauri = (window as any).__TAURI__;
    try {
      await tauri.core.invoke("save_file", { path: p });
      return null;
    } catch (e) {
      return String(e);
    }
  }, filePath);
  expect(err, `save_file must succeed for ${filePath}`).toBeNull();
}

/** Reopen the way File > Open does: open_file + a full WebView reload. */
async function openAndReload(page: Page, filePath: string): Promise<void> {
  const err = await page.evaluate(async (p) => {
    const tauri = (window as any).__TAURI__;
    try {
      await tauri.core.invoke("open_file", { path: p });
      return null;
    } catch (e) {
      return String(e);
    }
  }, filePath);
  expect(err, `open_file must succeed for ${filePath}`).toBeNull();

  await page.evaluate(() => window.location.reload());
  await page.waitForSelector("[data-focus-container='spreadsheet']", {
    state: "visible",
    timeout: 60_000,
  });
  await page.waitForTimeout(2_500);
}

// ---------------------------------------------------------------------------
// Shared hygiene
// ---------------------------------------------------------------------------

/**
 * Normalise the zoom before every test. One app instance serves the whole run,
 * and zoom is the one piece of view state that silently invalidates every
 * coordinate this spec computes.
 */
test.beforeEach(async ({ appPage }) => {
  await setFrontendZoom(appPage, 1);
});

// ===========================================================================
// 1. SUBTOTAL 101-111 vs 1-11 — the wrong-answer bug
// ===========================================================================

test.describe("1. SUBTOTAL: manual hide vs filter hide", () => {
  test("manual Hide moves 109/101 and leaves 9/1 alone, immediately", async ({ appPage }) => {
    const page = appPage;
    try {
      await wipeWorkbook(page);
      await seedAggregateFixture(page);

      // --- baseline: nothing hidden ---
      const before = await aggregates(page);
      expect(before.sub9, "SUBTOTAL(9) over 10..50").toBe("150");
      expect(before.sub109, "SUBTOTAL(109) over 10..50").toBe("150");
      expect(before.sub1, "SUBTOTAL(1) = AVERAGE").toBe("30");
      expect(before.sub101, "SUBTOTAL(101) = AVERAGE").toBe("30");

      // Pixels of the formula block before the hide. The block sits ABOVE the
      // row about to be hidden, so it cannot move; only a value change repaints.
      const clip = await page.evaluate(() => {
        const gs = (window as any).__CALCULA_GRID_STATE__;
        const cfg = gs.config;
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        const b = canvas.getBoundingClientRect();
        return {
          x: b.x + cfg.rowHeaderWidth + 5 * cfg.defaultCellWidth,
          y: b.y + cfg.colHeaderHeight + 1 * cfg.defaultCellHeight,
          width: cfg.defaultCellWidth,
          height: 6 * cfg.defaultCellHeight,
        };
      });
      const pixelsBefore = await page.screenshot({ clip });

      // --- the real gesture: right-click the row header, click Hide ---
      await hideRowViaUI(page, HIDE_ROW);

      // No edit, no extra interaction: read straight after the gesture.
      const after = await aggregates(page);
      expect(after.sub109, "SUBTOTAL(109) must DROP the hand-hidden row").toBe("140");
      expect(after.sub101, "SUBTOTAL(101) average must drop it too").toBe("35");
      expect(after.sub9, "SUBTOTAL(9) must STILL COUNT a hand-hidden row").toBe("150");
      expect(after.sub1, "SUBTOTAL(1) average must still count it").toBe("30");

      const pixelsAfter = await page.screenshot({ clip });
      expect(
        Buffer.compare(pixelsBefore, pixelsAfter),
        "the totals must REPAINT on hide — a value that only updates on a later " +
          "unrelated edit is the bug, not the fix",
      ).not.toBe(0);

      // --- unhide through the real UI: everything comes back ---
      // Span the gap from the visible row ABOVE the hide to the last data row.
      await unhideAllViaUI(page, HIDE_ROW - 1, DATA_TOP + DATA_VALUES.length - 1);
      const restored = await aggregates(page);
      expect(restored.sub109, "unhide restores SUBTOTAL(109)").toBe("150");
      expect(restored.sub101, "unhide restores SUBTOTAL(101)").toBe("30");
      expect(restored.sub9).toBe("150");
      expect(restored.sub1).toBe("30");
    } finally {
      await wipeWorkbook(page);
    }
  });

  test("a FILTER hides rows from BOTH families", async ({ appPage }) => {
    const page = appPage;
    try {
      await wipeWorkbook(page);
      await seedAggregateFixture(page);
      // Header cell so the filter range has one.
      await seed(page, [{ row: DATA_TOP - 1, col: COL_E, value: "Val" }]);

      const hidden = await applyFilterHiding(
        page,
        {
          startRow: DATA_TOP - 1,
          startCol: COL_E,
          endRow: DATA_TOP + DATA_VALUES.length - 1,
          endCol: COL_E,
        },
        ["10", "20", "30"],
      );
      // Precondition with teeth: if the filter hid nothing, every assertion
      // below would pass vacuously against the unfiltered totals.
      expect(hidden.slice().sort((a, b) => a - b), "the filter must hide 40 and 50").toEqual([
        DATA_TOP + 3,
        DATA_TOP + 4,
      ]);

      const filtered = await aggregates(page);
      expect(filtered.sub109, "109 excludes filter-hidden").toBe("60");
      expect(filtered.sub9, "9 ALSO excludes filter-hidden — this is the half 1-11 does honour").toBe(
        "60",
      );
      expect(filtered.sub101, "101 average over 10,20,30").toBe("20");
      expect(filtered.sub1, "1 average over 10,20,30").toBe("20");

      await clearFilter(page);
      const cleared = await aggregates(page);
      expect(cleared.sub9).toBe("150");
      expect(cleared.sub109).toBe("150");
      expect(cleared.sub1).toBe("30");
      expect(cleared.sub101).toBe("30");
    } finally {
      await clearFilter(page);
      await wipeWorkbook(page);
    }
  });
});

// ===========================================================================
// 2. Cross-sheet SUBTOTAL — the bug that blocked the naive fix
// ===========================================================================

test.describe("2. Cross-sheet SUBTOTAL", () => {
  test("respects the OTHER sheet's hidden rows, not the active sheet's", async ({ appPage }) => {
    const page = appPage;
    try {
      await wipeWorkbook(page);

      // Sheet2 with its own data, and a DIFFERENT row hidden than Sheet1.
      await invokeBackend(page, "add_sheet", {});
      await page.waitForTimeout(300);
      const sheets = await invokeBackend<any>(page, "get_sheets", {});
      const secondName = String(sheets.sheets[1].name);

      await invokeBackend(page, "set_active_sheet", { index: 1 });
      await page.waitForTimeout(300);
      await seed(
        page,
        [100, 200, 300, 400, 500].map((v, i) => ({
          row: DATA_TOP + i,
          col: COL_E,
          value: String(v),
        })),
      );
      // Hide the THIRD data row on Sheet2 (value 300).
      await invokeBackend(page, "set_rows_hidden", { rows: [DATA_TOP + 2], hidden: true });
      await page.waitForTimeout(300);

      await invokeBackend(page, "set_active_sheet", { index: 0 });
      await page.waitForTimeout(300);
      await seedAggregateFixture(page);
      // Hide the FIRST data row on Sheet1 (value 10) — a different offset.
      await invokeBackend(page, "set_rows_hidden", { rows: [DATA_TOP], hidden: true });
      await page.waitForTimeout(300);

      const range = `E${DATA_TOP + 1}:E${DATA_TOP + 5}`;
      await seed(page, [
        { row: 1, col: COL_G, value: `=SUBTOTAL(109;${secondName}!${range})` },
        { row: 2, col: COL_G, value: `=SUBTOTAL(9;${secondName}!${range})` },
      ]);

      const cross = await renderedTotals(page, COL_G, [1, 2]);
      // 1500 - 300 = 1200. If it wrongly applied SHEET1's hidden row (offset 0)
      // it would read 1500 - 100 = 1400 — the exact naive-fix bug.
      expect(
        cross[0],
        "SUBTOTAL(109, Sheet2!...) must drop SHEET2's hidden row (300), not Sheet1's offset",
      ).toBe("1200");
      expect(cross[1], "SUBTOTAL(9, Sheet2!...) ignores a hand hide on either sheet").toBe("1500");

      // And the local aggregate on Sheet1 is unaffected by Sheet2's hide.
      const local = await aggregates(page);
      expect(local.sub109, "Sheet1's own 109 drops Sheet1's own hidden row").toBe("140");
    } finally {
      await wipeWorkbook(page);
    }
  });
});

// ===========================================================================
// 3. AGGREGATE hidden-row options
// ===========================================================================

test.describe("3. AGGREGATE hidden-row options", () => {
  test("option 5 excludes a hand-hidden row, option 0 does not", async ({ appPage }) => {
    const page = appPage;
    try {
      await wipeWorkbook(page);
      await seedAggregateFixture(page);

      const before = await aggregates(page);
      expect(before.agg0, "AGGREGATE(9,0) baseline").toBe("150");
      expect(before.agg5, "AGGREGATE(9,5) baseline").toBe("150");

      await hideRowViaUI(page, HIDE_ROW);

      const after = await aggregates(page);
      expect(after.agg5, "option 5 = ignore hidden rows -> drops the hand hide").toBe("140");
      expect(after.agg0, "option 0 does NOT ignore hidden rows -> keeps it").toBe("150");
    } finally {
      await wipeWorkbook(page);
    }
  });
});

// ===========================================================================
// 4. Clipboard: copy visible cells vs manual hides
// ===========================================================================

test.describe("4. Copy and hidden rows", () => {
  test("copy over a FILTER takes only visible rows and pastes a contiguous block", async ({
    appPage,
    grid,
  }) => {
    const page = appPage;
    try {
      await wipeWorkbook(page);
      // I1 header, I2..I6 data. Distinct values so the paste proves WHICH rows landed.
      await seed(page, [
        { row: 0, col: COL_I, value: "Tag" },
        { row: 1, col: COL_I, value: "K1" },
        { row: 2, col: COL_I, value: "D2" },
        { row: 3, col: COL_I, value: "K3" },
        { row: 4, col: COL_I, value: "D4" },
        { row: 5, col: COL_I, value: "K5" },
      ]);

      const hidden = await applyFilterHiding(
        page,
        { startRow: 0, startCol: COL_I, endRow: 5, endCol: COL_I },
        ["K1", "K3", "K5"],
      );
      expect(hidden.slice().sort((a, b) => a - b), "the filter must hide the D rows").toEqual([2, 4]);

      await grid.selectRange("I2", "I6");
      await grid.clickFormatButton("copy");
      await grid.clickCell("M1");
      await grid.clickFormatButton("paste");
      await page.waitForTimeout(400);

      const landed = await renderedTotals(page, COL_M, [0, 1, 2, 3, 4]);
      expect(landed[0], "M1").toBe("K1");
      expect(landed[1], "M2 — the collapsed block slides D2 out").toBe("K3");
      expect(landed[2], "M3").toBe("K5");
      expect(landed[3], "M4 must be EMPTY — the pasted block is 3 rows, not 5").toBe("");
      expect(landed[4], "M5 must be EMPTY").toBe("");
    } finally {
      await clearFilter(page);
      await wipeWorkbook(page);
    }
  });

  test("copy over a MANUAL hide includes the hidden row (Excel's rule)", async ({
    appPage,
    grid,
  }) => {
    const page = appPage;
    try {
      await wipeWorkbook(page);
      await seed(page, [
        { row: 1, col: COL_I, value: "V1" },
        { row: 2, col: COL_I, value: "V2" },
        { row: 3, col: COL_I, value: "V3" },
        { row: 4, col: COL_I, value: "V4" },
        { row: 5, col: COL_I, value: "V5" },
      ]);

      // Hand-hide the middle row through the real UI.
      await hideRowViaUI(page, 3);
      const info = await invokeBackend<{ user: number[] }>(page, "get_hidden_rows_info", {});
      expect(info.user, "precondition: row 4 is hand-hidden").toContain(3);

      await grid.selectRange("I2", "I6");
      await grid.clickFormatButton("copy");
      await grid.clickCell("M1");
      await grid.clickFormatButton("paste");
      await page.waitForTimeout(400);

      const landed = await renderedTotals(page, COL_M, [0, 1, 2, 3, 4]);
      expect(
        landed,
        "a hand-hidden row is COPIED — this is why Alt+; (visible cells only) exists",
      ).toEqual(["V1", "V2", "V3", "V4", "V5"]);
    } finally {
      await wipeWorkbook(page);
    }
  });
});

// ===========================================================================
// 5. new_file geometry
// ===========================================================================

test.describe("5. new_file geometry", () => {
  test("File > New produces the SAME row height and column width as launch", async ({
    appPage,
  }) => {
    const page = appPage;
    try {
      // Launch geometry, straight from the running app.
      const atLaunch = await page.evaluate(() => {
        const cfg = (window as any).__CALCULA_GRID_STATE__.config;
        return { w: cfg.defaultCellWidth, h: cfg.defaultCellHeight };
      });

      await wipeWorkbook(page);

      const afterNew = await page.evaluate(() => {
        const cfg = (window as any).__CALCULA_GRID_STATE__.config;
        return { w: cfg.defaultCellWidth, h: cfg.defaultCellHeight };
      });

      expect(afterNew, "new_file must not re-type the grid geometry").toEqual(atLaunch);

      // ...and the BACKEND agrees with the frontend, so the two cannot drift.
      const backend = await invokeBackend<any>(page, "get_default_dimensions", {});
      expect(Number(backend.rowHeight ?? backend.defaultRowHeight), "backend row height").toBe(
        afterNew.h,
      );
      expect(
        Number(backend.columnWidth ?? backend.defaultColumnWidth),
        "backend column width",
      ).toBe(afterNew.w);
    } finally {
      await wipeWorkbook(page);
    }
  });
});

// ===========================================================================
// 6. Zoom persistence (per sheet)
// ===========================================================================

test.describe("6. Zoom persists", () => {
  test("per-sheet zoom survives save + wipe + reopen + reload", async ({ appPage }) => {
    const page = appPage;
    const file = tmpFile("zoom");
    try {
      await wipeWorkbook(page);
      await invokeBackend(page, "add_sheet", {});
      await page.waitForTimeout(300);

      await invokeBackend(page, "set_active_sheet", { index: 0 });
      await invokeBackend(page, "set_sheet_zoom", { zoom: 150 });
      await invokeBackend(page, "set_active_sheet", { index: 1 });
      await invokeBackend(page, "set_sheet_zoom", { zoom: 75 });
      await invokeBackend(page, "set_active_sheet", { index: 0 });
      await page.waitForTimeout(200);
      expect(await invokeBackend<number>(page, "get_sheet_zoom", {})).toBe(150);

      await saveTo(page, file);

      // TEETH: wipe, and PROVE the zoom is gone before reopening. Without this
      // the reload assertion could be satisfied by state that never left memory.
      await wipeWorkbook(page);
      expect(
        await invokeBackend<number>(page, "get_sheet_zoom", {}),
        "new_file must reset zoom — otherwise the restore assertion is vacuous",
      ).toBe(100);

      await openAndReload(page, file);

      await invokeBackend(page, "set_active_sheet", { index: 0 });
      await page.waitForTimeout(200);
      expect(await invokeBackend<number>(page, "get_sheet_zoom", {}), "Sheet1 zoom restored").toBe(
        150,
      );
      await invokeBackend(page, "set_active_sheet", { index: 1 });
      await page.waitForTimeout(200);
      expect(
        await invokeBackend<number>(page, "get_sheet_zoom", {}),
        "Sheet2 keeps ITS OWN zoom — zoom is per sheet",
      ).toBe(75);
    } finally {
      await invokeBackend(page, "set_active_sheet", { index: 0 }).catch(() => {});
      await invokeBackend(page, "set_sheet_zoom", { zoom: 100 }).catch(() => {});
      // The reopen above made the FRONTEND hydrate to 150% on mount. Resetting
      // only the backend would leave every later test clicking scaled
      // coordinates — restore the reducer's zoom too.
      await setFrontendZoom(page, 1).catch(() => {});
      await wipeWorkbook(page);
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    }
  });
});

// ===========================================================================
// 7. Data validation click target
// ===========================================================================

test.describe("7. Data validation click target", () => {
  test("cell body selects; only the chevron opens the list", async ({ appPage, grid }) => {
    const page = appPage;
    try {
      await wipeWorkbook(page);
      await page.evaluate(async (col) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("set_data_validation", {
          startRow: 1,
          startCol: col,
          endRow: 1,
          endCol: col,
          validation: {
            rule: {
              list: {
                source: { values: ["Alfa", "Bravo", "Charlie"] },
                inCellDropdown: true,
              },
            },
            errorAlert: { title: "", message: "", style: "stop", showAlert: false },
            prompt: { title: "", message: "", showPrompt: false },
            ignoreBlanks: true,
          },
        });
      }, COL_Q);
      await page.waitForTimeout(400);
      // Let the extension notice — this registers the chevron's grid region.
      await refreshExtensionStore(
        page,
        "/extensions/DataValidation/lib/validationStore.ts",
        "refreshValidationState",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.waitForTimeout(300);

      const dropdown = page.getByText("Bravo", { exact: true });

      // --- click the cell BODY (left part, well clear of the 18px chevron) ---
      const geo = await grid.readGeometry();
      const centre = await grid.cellCenterFrom("Q2", geo);
      await grid.canvas.click({
        position: { x: centre.x - geo.defaultCellWidth * 0.3 * geo.zoom, y: centre.y },
        force: true,
      });
      await page.waitForTimeout(500);

      expect(await grid.getNameBoxValue(), "a body click must SELECT the cell").toBe("Q2");
      await expect(dropdown, "a body click must NOT open the list").toHaveCount(0);
      // The formula bar is readable/usable — the cell is a normal selected cell.
      await expect(grid.formulaBar).toBeEnabled();

      // --- click the CHEVRON (right edge, inside the 18px button) ---
      // Button spans [right-1-18, right-1] in logical px (chevronGeometry.ts:
      // CHEVRON_BUTTON_SIZE 18, CHEVRON_BUTTON_MARGIN 1), so its centre sits
      // width/2 - 1 - 9 logical px right of the cell centre.
      const chevronX = centre.x + (geo.defaultCellWidth / 2 - 1 - 9) * geo.zoom;
      await grid.canvas.click({ position: { x: chevronX, y: centre.y }, force: true });
      await page.waitForTimeout(600);

      await expect(dropdown, "a chevron click MUST open the list").toHaveCount(1);

      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    } finally {
      await page
        .evaluate(async (col) => {
          const tauri = (window as any).__TAURI__;
          await tauri.core.invoke("clear_data_validation", {
            startRow: 1,
            startCol: col,
            endRow: 1,
            endCol: col,
          });
        }, COL_Q)
        .catch(() => {});
      await wipeWorkbook(page);
    }
  });
});

// ===========================================================================
// 8. Note hover preview
// ===========================================================================

test.describe("8. Note hover", () => {
  test("hovering a noted cell shows the preview; leaving hides it", async ({ appPage, grid }) => {
    const page = appPage;
    const NOTE = "Flagged-defect hover probe";
    try {
      await wipeWorkbook(page);
      await seed(page, [{ row: 1, col: COL_S, value: "Noted" }]);
      await page.evaluate(
        async ({ col, text }) => {
          const tauri = (window as any).__TAURI__;
          await tauri.core.invoke("add_note", {
            params: {
              row: 1,
              col,
              authorName: "E2E",
              content: text,
            },
          });
        },
        { col: COL_S, text: NOTE },
      );
      await page.waitForTimeout(400);
      // The hover handler gates on the extension's OWN indicator cache; a note
      // added through the backend is invisible to it until this refresh runs.
      await refreshExtensionStore(
        page,
        "/extensions/Review/lib/annotationStore.ts",
        "refreshAnnotationState",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.waitForTimeout(500);

      const preview = page.getByText(NOTE, { exact: false });
      await expect(preview, "no preview before hovering").toHaveCount(0);

      // Rest the pointer over the cell. The handler needs a real mousemove on
      // the canvas and a 350ms dwell.
      const box = await grid.canvas.boundingBox();
      if (!box) throw new Error("canvas has no bounding box");
      const centre = await grid.cellCenterScrollAware("S2");
      await page.mouse.move(box.x + centre.x - 12, box.y + centre.y - 6);
      await page.waitForTimeout(80);
      await page.mouse.move(box.x + centre.x, box.y + centre.y);
      await page.waitForTimeout(900);

      await expect(preview, "hovering a noted cell must show the note preview").toHaveCount(1);

      // Leaving the cell hides it again.
      await page.mouse.move(box.x + centre.x, box.y + centre.y + 4 * 20);
      await page.waitForTimeout(600);
      await expect(preview, "the preview must disappear when the pointer leaves").toHaveCount(0);
    } finally {
      await page
        .evaluate(async (col) => {
          const tauri = (window as any).__TAURI__;
          await tauri.core.invoke("delete_note", { row: 1, col });
        }, COL_S)
        .catch(() => {});
      await page.mouse.move(5, 5).catch(() => {});
      await wipeWorkbook(page);
    }
  });
});
