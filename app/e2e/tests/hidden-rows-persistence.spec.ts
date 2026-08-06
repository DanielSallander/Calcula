/**
 * HIDE/UNHIDE IS DURABLE — the data-loss fix, proved live against the real app.
 *
 * THE BUG. Hiding a row or a column used to be frontend-only session state: the
 * right-click Hide dispatched a window CustomEvent (`grid:set-manually-hidden-rows`)
 * straight into the grid reducer and stopped there. Nothing reached Rust. The
 * consequences, all silent:
 *   - the hide was NOT written to the .cala, so it vanished on save/reload;
 *   - the document was never marked modified, so a user could close without
 *     even being prompted;
 *   - it was not undoable, did not shift with an insert, and was not per-sheet;
 *   - `getSpecialCells("visible")` had to union a frontend set for the ACTIVE
 *     sheet and let background sheets pass through (silently wrong).
 *
 * The fix moved the authority to Rust: `set_rows_hidden`/`set_cols_hidden` own a
 * per-sheet user-hidden set, persisted in the .cala (format_version 4) and the
 * .xlsx, recorded on the undo stack, shifted by structural edits, and composed
 * with the derived sources by ONE rule on each side:
 *
 *     effectiveHidden(row) = userHidden OR filterHidden OR outlineHidden
 *
 * WHAT THIS FILE PROVES, through the REAL UI wherever a UI exists — the row and
 * column headers are right-clicked and the real "Hide"/"Unhide" context-menu
 * items are clicked, never the command behind them:
 *
 *   1. THE BUG IS DEAD. Hide a row and a column by right-click; they are gone
 *      from the RENDERED grid (the app's own hit-testing lands on the next
 *      visible line, and the renderer's own getRowHeight/getColumnWidth answer
 *      0). Save, wipe the whole in-memory workbook with new_file, reopen the
 *      file and RELOAD THE WEBVIEW the way File > Open does — still hidden, and
 *      the values underneath are intact.
 *   2. Hiding marks the document modified (backend is_file_modified AND the
 *      window title's "*").
 *   3. Per-sheet: hiding row 5 on Sheet1 leaves Sheet2's row 5 alone, before
 *      and after a save/reload cycle.
 *   4. Composition: a filter-hidden row and a hand-hidden row do not clobber
 *      each other in either direction.
 *   5. Shift: an insert above a hidden row/column moves the hide with the data.
 *   6. Undo restores visibility; redo hides again.
 *   7. Script API: setRowsHidden by sheet NAME, and getSpecialCells("visible")
 *      on a NON-ACTIVE sheet (impossible before — see the test's own comment).
 *   8. xlsx round-trip keeps hidden rows and columns hidden.
 *
 * TEETH. Test 1 does not merely re-read state the frontend already held. It
 * calls `new_file` between the save and the open and asserts that NOTHING is
 * hidden at that moment, then reloads the WebView after opening — so the
 * frontend has no memory at all. After that point the only channel the hidden
 * state can arrive through is the saved file. The pre-fix code wrote nothing to
 * that file (the identifiers did not exist anywhere under core/ or src-tauri/),
 * so this assertion could not have passed.
 *
 * SHARED APP. Every test starts from `new_file` and ends with an `afterEach`
 * that unhides EVERYTHING on every sheet and drops any sheet it added: hiding is
 * whole-line by nature, so one leaked hide would move every later spec's
 * coordinates. The new workbook is also what makes the header maths knowable,
 * which is why the lines used here stay well inside the on-screen band —
 * columns D (3) and H (7), rows 2-19.
 *
 * LOCALE. sv-SE. No formulas with argument separators are typed here.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";

// --- Geometry -------------------------------------------------------------
// Every test starts from a new workbook on the suite's default geometry
// (64.29px columns, 20px rows), which in the E2E window puts columns 0-18 and
// rows 0-26 on screen. A header can only be right-clicked if it HAS pixels, so
// this spec keeps its lines well inside that band — the point is to exercise the
// real menu, not to exercise scrolling.
const COL_D = 3; //  D — data column for the row tests
const COL_H = 7; //  H — the column that gets hidden
const RES_COL = 9; // J — where macros park their results

const TMP_DIR = path.join(os.tmpdir(), "calcula-hidden-e2e");

// ---------------------------------------------------------------------------
// Backend readers/writers — setup and assertions, never the thing under test.
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

interface HiddenLinesInfo {
  user: number[];
  effective: number[];
}

/** The backend's authoritative split for a sheet (defaults to the active one). */
async function hiddenRowsInfo(page: Page, sheetIndex?: number): Promise<HiddenLinesInfo> {
  return invokeBackend<HiddenLinesInfo>(page, "get_hidden_rows_info", { sheetIndex });
}
async function hiddenColsInfo(page: Page, sheetIndex?: number): Promise<HiddenLinesInfo> {
  return invokeBackend<HiddenLinesInfo>(page, "get_hidden_cols_info", { sheetIndex });
}

async function readCell(page: Page, row: number, col: number): Promise<string> {
  return page.evaluate(
    async ({ row, col }) => {
      const tauri = (window as any).__TAURI__;
      const cell = await tauri.core.invoke("get_cell", { row, col });
      return String(cell?.display ?? cell?.value ?? "");
    },
    { row, col },
  );
}

async function seedCells(
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
  await page.waitForTimeout(200);
}

/** The FRONTEND's composed effective sets — what the renderer actually consumes. */
async function frontendHidden(page: Page): Promise<{
  hiddenRows: number[];
  hiddenCols: number[];
  userRows: number[];
  userCols: number[];
  filterRows: number[];
}> {
  return page.evaluate(() => {
    const d = (window as any).__CALCULA_GRID_STATE__?.dimensions ?? {};
    const arr = (s: unknown) => (s instanceof Set ? [...s].sort((a, b) => a - b) : []);
    return {
      hiddenRows: arr(d.hiddenRows),
      hiddenCols: arr(d.hiddenCols),
      userRows: arr(d.manuallyHiddenRows),
      userCols: arr(d.manuallyHiddenCols),
      filterRows: arr(d.filterHiddenRows),
    };
  });
}

/**
 * The RENDERER's own answer: the height/width the paint pipeline would use for
 * this line, obtained by calling the very functions the canvas calls. Zero means
 * the line occupies no pixels — it is not on screen.
 */
async function renderedSize(page: Page, kind: "row" | "col", index: number): Promise<number> {
  return page.evaluate(
    async ({ kind, index }) => {
      const dims: any = await (window as any).__calcImport(
        new URL("/src/core/lib/gridRenderer/layout/dimensions.ts", document.baseURI).href,
      );
      const gs = (window as any).__CALCULA_GRID_STATE__;
      return kind === "row"
        ? dims.getRowHeight(index, gs.config, gs.dimensions)
        : dims.getColumnWidth(index, gs.config, gs.dimensions);
    },
    { kind, index },
  );
}

/**
 * The app's own hit-testing, asked which cell occupies a pixel. Used as the
 * "is it visually gone?" oracle: when a row is hidden, the pixel band it used to
 * own belongs to the next visible row.
 */
async function cellAtNominalPosition(
  page: Page,
  nominalRow: number,
  nominalCol: number,
): Promise<{ row: number; col: number } | null> {
  return page.evaluate(
    async ({ nominalRow, nominalCol }) => {
      const ht: any = await (window as any).__calcImport(
        new URL("/src/core/lib/gridRenderer/interaction/hitTesting.ts", document.baseURI).href,
      );
      const gs = (window as any).__CALCULA_GRID_STATE__;
      const cfg = gs.config;
      // The pixel a line WOULD occupy if nothing were hidden and nothing resized.
      const x =
        (cfg.rowHeaderWidth ?? 22) +
        nominalCol * (cfg.defaultCellWidth ?? 64.29) +
        (cfg.defaultCellWidth ?? 64.29) / 2 -
        (gs.viewport?.scrollX ?? 0);
      const y =
        (cfg.colHeaderHeight ?? 20) +
        nominalRow * (cfg.defaultCellHeight ?? 20) +
        (cfg.defaultCellHeight ?? 20) / 2 -
        (gs.viewport?.scrollY ?? 0);
      return ht.getCellFromPixel(x, y, cfg, gs.viewport, gs.dimensions);
    },
    { nominalRow, nominalCol },
  );
}

// ---------------------------------------------------------------------------
// REAL UI: header click + right-click + context menu
// ---------------------------------------------------------------------------

/**
 * The on-screen point of a row/column HEADER, found by asking the app's own
 * hit-testing which pixel belongs to the line. Scanning rather than computing is
 * what makes this correct in the presence of scroll, hidden lines, lines other
 * specs have resized, and the outline bar — and it returns null when the line
 * genuinely has no pixels, which is itself a fact worth asserting.
 *
 * It also SKIPS the drag-to-resize handles. `handleMouseDown` checks for a
 * resize handle FIRST, so a pixel that is both "this column's header" and "a
 * boundary between two others" starts a drag-resize and never selects anything —
 * observed live before this guard existed. Zero-width (hidden) neighbours make
 * that collision routine, since several boundaries then land on the same pixel,
 * and hidden neighbours are exactly what these tests create. So the point is
 * chosen from the pixels that belong to the line and to no handle.
 */
async function headerPoint(
  page: Page,
  kind: "row" | "col",
  index: number,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    async ({ kind, index }) => {
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

      const clean: number[] = [];
      let seen = false;
      if (kind === "row") {
        // Fixed x inside the row-number strip (past any outline bar).
        const x = outlineW + (headerW - outlineW) / 2;
        for (let y = Math.ceil(headerH) + 1; y < rect.height - 2; y += 1) {
          const onLine = ht.getRowFromHeader(x, y, cfg, gs.viewport, gs.dimensions) === index;
          if (onLine) {
            seen = true;
            if (ht.getRowResizeHandle(x, y, cfg, gs.viewport, gs.dimensions) === null) clean.push(y);
          } else if (seen) break;
        }
        if (clean.length === 0) return null;
        return { x, y: clean[Math.floor(clean.length / 2)] };
      }
      const y = headerH / 2;
      for (let x = Math.ceil(headerW) + 1; x < rect.width - 2; x += 1) {
        const onLine = ht.getColumnFromHeader(x, y, cfg, gs.viewport, gs.dimensions) === index;
        if (onLine) {
          seen = true;
          if (ht.getColumnResizeHandle(x, y, cfg, gs.viewport, gs.dimensions) === null) clean.push(x);
        } else if (seen) break;
      }
      if (clean.length === 0) return null;
      return { x: clean[Math.floor(clean.length / 2)], y };
    },
    { kind, index },
  );
}

/** 0-based column index -> Excel letters (12 -> "M"). */
function colLetters(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Scroll a line into view so its header has pixels to click.
 *
 * Two hops on purpose: the Name Box scrolls MINIMALLY, so a single jump to a
 * line below the viewport parks it on the LAST visible row — and a later
 * Shift+click on a line a few below it would then be off-screen. Jumping past
 * the target first and coming back leaves the target near the TOP with room
 * underneath for the extend gestures.
 */
async function revealLine(page: Page, kind: "row" | "col", index: number): Promise<void> {
  const nameBox = page.locator('input[aria-label="Name Box"]');
  const refs =
    kind === "row"
      ? [`${colLetters(COL_D)}${index + 1 + 25}`, `${colLetters(COL_D)}${index + 1}`]
      : [`${colLetters(index + 6)}1`, `${colLetters(index)}1`];
  for (const ref of refs) {
    await nameBox.click();
    await nameBox.fill(ref);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  }
  await page.locator("[data-focus-container='spreadsheet']").focus();
  await page.waitForTimeout(150);
}

/** Left-click the header to select the whole line (the real gesture). */
async function selectLineViaHeader(page: Page, kind: "row" | "col", index: number): Promise<void> {
  if (!(await headerPoint(page, kind, index))) await revealLine(page, kind, index);
  const pt = await headerPoint(page, kind, index);
  if (!pt) throw new Error(`${kind} ${index} has no header pixels — cannot click it`);
  const area = page.locator("[data-grid-area]");
  await area.click({ position: pt, force: true });
  await page.waitForTimeout(200);

  const sel = await page.evaluate(() => {
    const s = (window as any).__CALCULA_GRID_STATE__?.selection;
    return s ? { type: s.type, startRow: s.startRow, endRow: s.endRow, startCol: s.startCol, endCol: s.endCol } : null;
  });
  const want = kind === "row" ? "rows" : "columns";
  expect(sel?.type, `header click on ${kind} ${index} must select the whole ${kind}`).toBe(want);
}

/**
 * Extend the header selection to a second line with Shift (real gesture).
 *
 * Never reveals through the Name Box: that would REPLACE the anchor selection
 * this gesture is extending. If the line is below the fold, scroll with the
 * wheel, which leaves the selection alone.
 */
async function extendLineViaHeader(page: Page, kind: "row" | "col", index: number): Promise<void> {
  for (let i = 0; i < 6 && !(await headerPoint(page, kind, index)); i++) {
    await page.locator("[data-grid-area]").hover();
    await page.mouse.wheel(kind === "row" ? 0 : 120, kind === "row" ? 120 : 0);
    await page.waitForTimeout(250);
  }
  const pt = await headerPoint(page, kind, index);
  if (!pt) throw new Error(`${kind} ${index} has no header pixels — cannot shift-click it`);
  const area = page.locator("[data-grid-area]");
  await area.click({ position: pt, modifiers: ["Shift"], force: true });
  await page.waitForTimeout(200);
}

/** Right-click the header and click a context-menu item by its EXACT label. */
async function headerContextMenuClick(
  page: Page,
  kind: "row" | "col",
  index: number,
  label: "Hide" | "Unhide",
): Promise<void> {
  const pt = await headerPoint(page, kind, index);
  if (!pt) throw new Error(`${kind} ${index} has no header pixels — cannot right-click it`);
  const area = page.locator("[data-grid-area]");
  await area.click({ position: pt, button: "right", force: true });

  const menu = page.locator('[role="menu"][aria-label="Context menu"]');
  await expect(menu, "the grid context menu must open on a header right-click").toBeVisible({
    timeout: 5_000,
  });
  const item = menu.locator('[role="menuitem"]').filter({ hasText: new RegExp(`^${label}$`) });
  await expect(item, `"${label}" must be offered for this ${kind} selection`).toHaveCount(1);
  await item.click();
  await expect(menu).toBeHidden({ timeout: 5_000 });
  // The handler awaits a backend round-trip before dispatching the mirror.
  await page.waitForTimeout(500);
}

/** Whether a label is offered at all in the header context menu (then close it). */
async function headerMenuOffers(
  page: Page,
  kind: "row" | "col",
  index: number,
  label: string,
): Promise<boolean> {
  const pt = await headerPoint(page, kind, index);
  // No reveal here on purpose: this is asked immediately after a selection
  // gesture, and revealing would replace the selection the menu reports on.
  if (!pt) throw new Error(`${kind} ${index} has no header pixels`);
  await page.locator("[data-grid-area]").click({ position: pt, button: "right", force: true });
  const menu = page.locator('[role="menu"][aria-label="Context menu"]');
  await expect(menu).toBeVisible({ timeout: 5_000 });
  const count = await menu
    .locator('[role="menuitem"]')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .count();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden({ timeout: 5_000 });
  return count > 0;
}

// ---------------------------------------------------------------------------
// File round-trip through the app's own path
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

/**
 * Reopen a file the way File > Open does: `open_file`, then a full WebView
 * reload (fileOpen() in StandardMenus/FileMenu.ts calls window.location.reload()
 * after a successful open). The reload is the point — it leaves the frontend
 * with NO memory whatsoever, so anything still hidden afterwards came from the
 * backend, which in turn was populated from the file.
 */
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
  // The initial refreshDimensions()/refreshUserHidden() runs on mount; give the
  // async backend reads time to land in the reducer before asserting.
  await page.waitForTimeout(2_500);
}

/** Wipe the in-memory workbook. Nothing may be hidden after this. */
async function wipeWorkbook(page: Page): Promise<void> {
  await invokeBackend(page, "new_file", {});
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(800);
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

async function sheetInfo(page: Page): Promise<{ names: string[]; activeIndex: number }> {
  const res = await invokeBackend<any>(page, "get_sheets", {});
  return {
    names: (res.sheets ?? []).map((s: any) => String(s.name)),
    activeIndex: Number(res.activeIndex ?? 0),
  };
}

/** Switch sheets through the real tab bar (this is what fires sheet:normalSwitch). */
async function clickSheetTab(page: Page, index: number): Promise<void> {
  const tab = page.locator(`button[data-sheet-tab="${index}"]`);
  await expect(tab).toBeVisible({ timeout: 5_000 });
  await tab.click();
  await page.waitForTimeout(900);
}

async function addSheetViaButton(page: Page): Promise<void> {
  await page.locator('button[title="Add new sheet"]').click({ force: true });
  await page.waitForTimeout(1_000);
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

async function allowScripts(page: Page): Promise<void> {
  await invokeBackend(page, "set_script_security_level", { level: "enabled" });
}

/**
 * Run object-script source once in a real hardened worker realm, through the
 * production @api primitive the macro library's Run button uses. Returns the
 * script's own error message when setup() throws, else null.
 */
async function runMacro(page: Page, name: string, source: string): Promise<string | null> {
  return page.evaluate(
    async ({ name, source }) => {
      const api: any = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      try {
        await api.runObjectScriptOnce({ name, source });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    { name, source },
  );
}

/**
 * Read a value a macro parked in a RESULT CELL. Object scripts run in a
 * hardened worker realm — there is no `window` to hang a result on, and that is
 * the point of the sandbox — so a macro reports by writing a cell, exactly as
 * the other VBA-idiom specs do.
 */
async function macroResult(page: Page, row: number): Promise<string> {
  return readCell(page, row, RES_COL);
}

// ---------------------------------------------------------------------------
// Cleanup — a leaked hide would break every later spec's coordinates.
// ---------------------------------------------------------------------------

async function unhideEverything(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    const sheets: any = await tauri.core.invoke("get_sheets", {});
    const active = Number(sheets.activeIndex ?? 0);
    const count = (sheets.sheets ?? []).length;
    for (let i = 0; i < count; i++) {
      await tauri.core.invoke("set_active_sheet", { index: i }).catch(() => {});
      const rows: number[] = await tauri.core.invoke("get_user_hidden_rows").catch(() => []);
      if (rows.length > 0) {
        await tauri.core.invoke("set_rows_hidden", { rows, hidden: false }).catch(() => {});
      }
      const cols: number[] = await tauri.core.invoke("get_user_hidden_cols").catch(() => []);
      if (cols.length > 0) {
        await tauri.core.invoke("set_cols_hidden", { cols, hidden: false }).catch(() => {});
      }
    }
    await tauri.core.invoke("set_active_sheet", { index: Math.min(active, count - 1) }).catch(() => {});
  });
}

/**
 * Drop every sheet past the first, through the SheetTabs delete path
 * (`sheet:requestDelete`) rather than the raw backend command — the tab bar
 * keeps its own React copy of the sheet list, and a backend-only delete leaves
 * it showing tabs that no longer exist for every later spec in this worker.
 */
async function removeExtraSheets(page: Page): Promise<void> {
  for (let guard = 0; guard < 6; guard++) {
    const count = await page.locator("button[data-sheet-tab]").count();
    if (count <= 1) return;
    await page.evaluate((idx) => {
      window.dispatchEvent(new CustomEvent("sheet:requestDelete", { detail: { index: idx } }));
    }, count - 1);
    await page.waitForTimeout(400);
    const confirmBtn = page.locator("button").filter({ hasText: /^Delete$/ }).first();
    if (await confirmBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(300);
  }
}

async function fullCleanup(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      // Any AutoFilter this spec left behind (it hides rows too).
      try {
        await tauri.core.invoke("remove_auto_filter");
      } catch {
        /* none */
      }
    })
    .catch(() => {});
  // Back to Sheet1 through the real tab, then drop the extras.
  if ((await page.locator("button[data-sheet-tab]").count()) > 1) {
    await clickSheetTab(page, 0).catch(() => {});
    await removeExtraSheets(page).catch(() => {});
  }
  await page
    .evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      // This spec's patch: columns D..J (3..9), rows 1..30. Deliberately NOT
      // wider — clearing columns another spec owns would be this file causing
      // exactly the kind of cross-spec damage it is here to rule out.
      try {
        await tauri.core.invoke("clear_range_with_options", {
          params: { startRow: 0, startCol: 3, endRow: 30, endCol: 9, applyTo: "all" },
        });
      } catch {
        /* ok */
      }
    })
    .catch(() => {});
  await unhideEverything(page).catch(() => {});
  // Hand over a PRISTINE untitled workbook.
  //
  // Tests here open .cala/.xlsx files and then delete them, which would leave
  // the app bound to a path that no longer exists, on whatever geometry that
  // file carried, with this spec's scripts still registered. `new_file` drops
  // all of it — path, data, object scripts, notebooks — and the geometry restore
  // immediately after undoes new_file's own side effect (see its comment). The
  // next spec then starts from the same state a freshly launched app gives it.
  await invokeBackend(page, "new_file", {}).catch(() => {});
  await restoreDefaultGeometry(page).catch(() => {});
  await page
    .evaluate(() => {
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
      window.dispatchEvent(new Event("grid:refresh"));
    })
    .catch(() => {});
  await page.waitForTimeout(600);
}

/**
 * The app's default cell geometry — 64.29 x 20, Excel's defaults.
 *
 * HISTORY (both halves are fixed now, and this stays as a cheap guard):
 *   - `new_file` used to reset the backend defaults to 100 x 24 while app
 *     launch was 64.29 x 20, so any spec that reset the workbook silently
 *     re-scaled the grid for every spec after it. That cost 26 failures across
 *     the macro/VBA specs. `new_file` and `AppState` now read ONE constant
 *     (`persistence::DEFAULT_ROW_HEIGHT_PX` / `DEFAULT_COLUMN_WIDTH_PX`).
 *   - `GridHelper.clickCell` used to compute pixel coordinates from hardcoded
 *     constants, so it was only ever right by luck. It now reads the running
 *     app's live geometry (`GridHelper.readGeometry`).
 *
 * What remains: this spec clicks real HEADER pixels, so it still wants a KNOWN
 * geometry — an earlier spec that changed the workbook defaults would move
 * every header. Restoring them here makes this file independent of run order
 * rather than papering over a defect.
 */
const DEFAULT_COL_WIDTH = 64.29;
const DEFAULT_ROW_HEIGHT = 20;

/** Put the shared app's default cell geometry back the way it was found. */
async function restoreDefaultGeometry(page: Page): Promise<void> {
  await invokeBackend(page, "set_default_column_width", { width: DEFAULT_COL_WIDTH });
  await invokeBackend(page, "set_default_row_height", { height: DEFAULT_ROW_HEIGHT });
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(300);
}

/**
 * Start every test from a brand-new workbook.
 *
 * Not fastidiousness — necessity. This spec clicks real HEADER PIXELS, so it
 * needs the grid's geometry to be known: an earlier spec that widened a column
 * or left one hidden moves every header, and a zero-width neighbour collapses
 * two drag-resize boundaries onto the same pixel, where a click resizes instead
 * of selecting. `new_file` gives that blank slate — it also clears the
 * user-hidden sets — and `restoreDefaultGeometry` immediately undoes the one
 * side effect that would leak out of this file (see its comment).
 */
async function prepareGrid(page: Page): Promise<void> {
  await invokeBackend(page, "new_file", {});
  await restoreDefaultGeometry(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(900);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
  }
  const nameBox = page.locator('input[aria-label="Name Box"]');
  await nameBox.click();
  await nameBox.fill("A1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.locator("[data-focus-container='spreadsheet']").focus();
  await page.waitForTimeout(200);
}

// ===========================================================================

test.describe("Hidden rows/columns are durable document state", () => {
  test.beforeEach(async ({ appPage }) => {
    await prepareGrid(appPage);
  });

  test.afterEach(async ({ sharedPage }) => {
    await fullCleanup(sharedPage);
  });

  // -----------------------------------------------------------------------
  test("1. a right-click Hide survives save, a full workbook wipe and reopen", async ({
    appPage: page,
  }) => {
    const file = tmpFile("hidden-survives");
    try {
      await seedCells(page, [
        { row: 2, col: COL_D, value: "D3-KEEP" },
        { row: 3, col: COL_D, value: "ROW-SECRET" },
        { row: 4, col: COL_D, value: "D5-KEEP" },
        { row: 2, col: COL_H, value: "COL-SECRET" },
      ]);

      // --- the real gesture: select the row header, right-click, Hide ---
      await selectLineViaHeader(page, "row", 3);
      await headerContextMenuClick(page, "row", 3, "Hide");

      await selectLineViaHeader(page, "col", COL_H);
      await headerContextMenuClick(page, "col", COL_H, "Hide");

      // --- VISUALLY GONE: the renderer gives them no pixels at all ---
      expect(await renderedSize(page, "row", 3), "hidden row must render 0px tall").toBe(0);
      expect(await renderedSize(page, "col", COL_H), "hidden column must render 0px wide").toBe(0);
      // ...and the app's own hit-testing says the band row 4 used to own now
      // belongs to row 5 (0-based 4) — the row below has moved up over it.
      expect(await cellAtNominalPosition(page, 3, COL_D)).toMatchObject({ row: 4 });
      expect((await cellAtNominalPosition(page, 2, COL_H))?.col).toBe(COL_H + 1);
      // The header itself has no pixels either: you cannot click a hidden line.
      expect(await headerPoint(page, "row", 3)).toBeNull();
      expect(await headerPoint(page, "col", COL_H)).toBeNull();

      // Backend + frontend agree on WHY it is hidden (user, not filter/outline).
      expect((await hiddenRowsInfo(page)).user).toContain(3);
      expect((await hiddenColsInfo(page)).user).toContain(COL_H);
      const fe = await frontendHidden(page);
      expect(fe.userRows).toContain(3);
      expect(fe.hiddenRows).toContain(3);
      expect(fe.userCols).toContain(COL_H);
      expect(fe.hiddenCols).toContain(COL_H);

      // --- save ---
      await saveTo(page, file);

      // A real file on disk is what the reopen below will read back. (Its
      // entries are deflated, so the interesting proof is the round-trip, not a
      // substring search — see the wipe + reload that follow.)
      expect(fs.statSync(file).size, "the saved .cala must exist and be non-empty").toBeGreaterThan(
        0,
      );

      // --- wipe: no frontend or backend memory of the hide may remain ---
      await wipeWorkbook(page);
      expect(
        (await hiddenRowsInfo(page)).effective,
        "new_file must leave nothing hidden — otherwise the reopen proves nothing",
      ).toEqual([]);
      expect((await hiddenColsInfo(page)).effective).toEqual([]);
      expect(await readCell(page, 3, COL_D), "new_file must clear the data too").toBe("");

      // --- reopen the way File > Open does, INCLUDING the WebView reload ---
      await openAndReload(page, file);

      // THE DECISIVE ASSERTIONS. Everything below could only have come from the
      // file: the workbook was wiped and the frontend was reloaded from zero.
      expect(
        (await hiddenRowsInfo(page)).user,
        "the hand-hidden ROW must still be hidden after save/wipe/reopen/reload",
      ).toContain(3);
      expect(
        (await hiddenColsInfo(page)).user,
        "the hand-hidden COLUMN must still be hidden after save/wipe/reopen/reload",
      ).toContain(COL_H);

      const feAfter = await frontendHidden(page);
      expect(feAfter.hiddenRows, "the reloaded renderer must hide the row").toContain(3);
      expect(feAfter.hiddenCols, "the reloaded renderer must hide the column").toContain(COL_H);
      expect(await renderedSize(page, "row", 3)).toBe(0);
      expect(await renderedSize(page, "col", COL_H)).toBe(0);
      expect(await cellAtNominalPosition(page, 3, COL_D)).toMatchObject({ row: 4 });

      // ...and the values underneath survived intact.
      expect(await readCell(page, 3, COL_D)).toBe("ROW-SECRET");
      expect(await readCell(page, 2, COL_H)).toBe("COL-SECRET");
      expect(await readCell(page, 2, COL_D)).toBe("D3-KEEP");
      expect(await readCell(page, 4, COL_D)).toBe("D5-KEEP");
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* leave for forensics */
      }
    }
  });

  // -----------------------------------------------------------------------
  /**
   * CONTROL — proves test 1's assertions have teeth.
   *
   * The claim "the hide now survives a reload" is only worth something if the
   * oracle can tell the two behaviours apart. So this test performs the OLD,
   * pre-fix gesture verbatim — write the reducer mirror and nothing else, which
   * is exactly what `grid:set-manually-hidden-rows` did — and runs the SAME
   * save/wipe/reopen/reload sequence test 1 runs.
   *
   * It asserts the data loss: the row looks hidden, the document is not even
   * dirty, the backend never hears about it, and the hide is gone after the
   * round-trip. Every one of these expectations is the negation of an assertion
   * in test 1, on the same oracle — so test 1 cannot be passing vacuously.
   *
   * (This is a re-enactment, not a regression risk: the production gesture
   * cannot reach this code path any more. `hiddenRowsCols.applyRowsHidden` is
   * the only caller of the mirror action, and it calls the backend first.)
   */
  test("1b. CONTROL: the pre-fix frontend-only gesture loses the hide (bug re-enacted)", async ({
    appPage: page,
  }) => {
    const file = tmpFile("prefix-control");
    try {
      await seedCells(page, [
        { row: 2, col: COL_D, value: "D3-KEEP" },
        { row: 3, col: COL_D, value: "ROW-SECRET" },
        { row: 4, col: COL_D, value: "D5-KEEP" },
      ]);
      // Zero the dirty flag so the next assertion means something.
      await saveTo(page, file);
      expect(await invokeBackend<boolean>(page, "is_file_modified")).toBe(false);

      // THE OLD GESTURE: the reducer mirror, and nothing else.
      await page.evaluate(async () => {
        const grid: any = await (window as any).__calcImport(
          new URL("/src/api/grid.ts", document.baseURI).href,
        );
        const disp: any = await (window as any).__calcImport(
          new URL("/src/api/gridDispatch.ts", document.baseURI).href,
        );
        disp.dispatchGridAction(grid.setManuallyHiddenRows([3]));
        window.dispatchEvent(new Event("grid:refresh"));
      });
      await page.waitForTimeout(400);

      // It LOOKS right — which is precisely why the bug survived so long.
      expect(
        await renderedSize(page, "row", 3),
        "the old gesture did hide the row on screen — that is what made it convincing",
      ).toBe(0);
      expect((await frontendHidden(page)).hiddenRows).toContain(3);

      // ...but nothing else knows. These three are the bug.
      expect(
        (await hiddenRowsInfo(page)).user,
        "the pre-fix gesture never reached the backend authority",
      ).not.toContain(3);
      expect(
        await invokeBackend<boolean>(page, "is_file_modified"),
        "the pre-fix gesture did not even mark the document modified",
      ).toBe(false);

      // Same oracle as test 1 — save, wipe, reopen, reload.
      await saveTo(page, file);
      await wipeWorkbook(page);
      await openAndReload(page, file);

      expect(
        (await hiddenRowsInfo(page)).effective,
        "THE DATA LOSS: the pre-fix hide is gone after the round-trip",
      ).not.toContain(3);
      expect(
        (await frontendHidden(page)).hiddenRows,
        "...and the reloaded grid shows the row again",
      ).not.toContain(3);
      expect(await renderedSize(page, "row", 3)).toBeGreaterThan(0);
      // The VALUES were never at risk — only the visibility was, which is what
      // made this quiet enough to ship.
      expect(await readCell(page, 3, COL_D)).toBe("ROW-SECRET");
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ok */
      }
    }
  });

  // -----------------------------------------------------------------------
  test("2. hiding marks the document modified (backend flag and the title's *)", async ({
    appPage: page,
  }) => {
    const file = tmpFile("dirty-marking");
    try {
      await seedCells(page, [{ row: 15, col: COL_D, value: "DIRTY-PROBE" }]);

      // Saving is the only thing that clears the flag; start from a clean slate.
      await saveTo(page, file);
      await page.evaluate(async () => {
        const fa: any = await (window as any).__calcImport(
          new URL("/src/core/lib/file-api.ts", document.baseURI).href,
        );
        await fa.updateWindowTitle();
      });
      expect(
        await invokeBackend<boolean>(page, "is_file_modified"),
        "a freshly saved document must not be modified",
      ).toBe(false);
      expect(await page.title()).not.toContain("*");

      // The gesture under test.
      await selectLineViaHeader(page, "row", 15);
      await headerContextMenuClick(page, "row", 15, "Hide");

      expect(
        await invokeBackend<boolean>(page, "is_file_modified"),
        "hiding a row must mark the document modified — otherwise the user is " +
          "never prompted on close and loses the hide silently",
      ).toBe(true);

      // The user-visible half of the same fact: the window title's asterisk.
      // (Layout.tsx refreshes the title on DIRTY_STATE_CHANGED, which the hide
      // gesture emits.)
      await expect
        .poll(async () => await page.title(), { timeout: 5_000 })
        .toContain("*");

      // Same for a column, from a clean baseline.
      await saveTo(page, file);
      expect(await invokeBackend<boolean>(page, "is_file_modified")).toBe(false);
      await selectLineViaHeader(page, "col", COL_H);
      await headerContextMenuClick(page, "col", COL_H, "Hide");
      expect(
        await invokeBackend<boolean>(page, "is_file_modified"),
        "hiding a column must mark the document modified",
      ).toBe(true);

      // And UNhiding is a change too.
      await saveTo(page, file);
      expect(await invokeBackend<boolean>(page, "is_file_modified")).toBe(false);
      await selectLineViaHeader(page, "row", 14);
      await extendLineViaHeader(page, "row", 16);
      await headerContextMenuClick(page, "row", 16, "Unhide");
      expect(
        await invokeBackend<boolean>(page, "is_file_modified"),
        "unhiding must mark the document modified too",
      ).toBe(true);
      expect((await hiddenRowsInfo(page)).user).not.toContain(15);
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ok */
      }
    }
  });

  // -----------------------------------------------------------------------
  test("3. a hide is per-sheet, before and after a save/reload cycle", async ({
    appPage: page,
  }) => {
    const file = tmpFile("per-sheet");
    try {
      await seedCells(page, [{ row: 4, col: COL_D, value: "S1-ROW5" }]);
      await addSheetViaButton(page); // auto-switches to the new sheet
      const info = await sheetInfo(page);
      expect(info.names.length, "this test needs two sheets").toBeGreaterThanOrEqual(2);
      await seedCells(page, [{ row: 4, col: COL_D, value: "S2-ROW5" }]);

      // Hide row 5 on SHEET 1 only.
      await clickSheetTab(page, 0);
      await selectLineViaHeader(page, "row", 4);
      await headerContextMenuClick(page, "row", 4, "Hide");

      expect((await hiddenRowsInfo(page, 0)).user).toContain(4);
      expect(
        (await hiddenRowsInfo(page, 1)).effective,
        "Sheet2's row 5 must be untouched by a hide on Sheet1",
      ).not.toContain(4);

      // Switch to Sheet2 through the real tab bar: its row 5 is visible there.
      await clickSheetTab(page, 1);
      expect((await frontendHidden(page)).hiddenRows).not.toContain(4);
      expect(await renderedSize(page, "row", 4)).toBeGreaterThan(0);
      expect(await readCell(page, 4, COL_D)).toBe("S2-ROW5");

      // Back to Sheet1: still hidden there.
      await clickSheetTab(page, 0);
      expect((await frontendHidden(page)).hiddenRows).toContain(4);
      expect(await renderedSize(page, "row", 4)).toBe(0);

      // --- and it survives the round-trip per sheet ---
      await saveTo(page, file);
      await wipeWorkbook(page);
      await openAndReload(page, file);

      expect((await hiddenRowsInfo(page, 0)).user, "Sheet1 keeps its hide").toContain(4);
      expect(
        (await hiddenRowsInfo(page, 1)).effective,
        "Sheet2 must not acquire one across the round-trip",
      ).not.toContain(4);
      expect(await readCell(page, 4, COL_D)).toBe("S1-ROW5");
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ok */
      }
    }
  });

  // -----------------------------------------------------------------------
  test("4. filter-hidden and hand-hidden rows do not clobber each other", async ({
    appPage: page,
  }) => {
    // A 5-row filter table in column D (header row 9 + 4 data rows), and a
    // hand-hidden row two below it.
    await seedCells(page, [
      { row: 8, col: COL_D, value: "Colour" },
      { row: 9, col: COL_D, value: "Red" },
      { row: 10, col: COL_D, value: "Blue" },
      { row: 11, col: COL_D, value: "Red" },
      { row: 12, col: COL_D, value: "Green" },
      { row: 14, col: COL_D, value: "HAND-HIDDEN" },
    ]);

    // Drive the filter through the production AutoFilter controller — the same
    // object the ribbon and the dropdown use, so the reducer's filter source is
    // updated exactly as it is in the app.
    const applied = await page.evaluate(
      async ({ startRow, endRow, col }) => {
        const svc: any = await (window as any).__calcImport(
          new URL("/src/api/autoFilterService.ts", document.baseURI).href,
        );
        const c = svc.requireAutoFilterController();
        await c.apply(startRow, col, endRow, col);
        const snap = await c.setColumn(0, { kind: "values", values: ["Red"], includeBlanks: false });
        return snap.hiddenRows ?? [];
      },
      { startRow: 8, endRow: 12, col: COL_D },
    );
    await page.waitForTimeout(400);
    expect(applied, "the filter must hide the non-Red rows").toEqual(
      expect.arrayContaining([10, 12]),
    );

    // Now hand-hide row 15 (0-based 14) with the real right-click.
    await selectLineViaHeader(page, "row", 14);
    await headerContextMenuClick(page, "row", 14, "Hide");

    // COMPOSITION: user = {14} only; effective = user OR filter.
    let rows = await hiddenRowsInfo(page);
    expect(rows.user, "the filter must not leak into the USER set").toEqual([14]);
    expect(rows.effective).toEqual(expect.arrayContaining([10, 12, 14]));
    let fe = await frontendHidden(page);
    expect(fe.userRows).toEqual([14]);
    expect(fe.filterRows).toEqual(expect.arrayContaining([10, 12]));
    expect(fe.hiddenRows).toEqual(expect.arrayContaining([10, 12, 14]));

    // (a) Unhide across a span covering BOTH kinds must free only the user one.
    await selectLineViaHeader(page, "row", 9);
    await extendLineViaHeader(page, "row", 15);
    await headerContextMenuClick(page, "row", 15, "Unhide");
    rows = await hiddenRowsInfo(page);
    expect(rows.user, "Unhide must clear the hand hide").not.toContain(14);
    expect(
      rows.effective,
      "Unhide must NOT resurrect filter-hidden rows — clearing the filter is what does that",
    ).toEqual(expect.arrayContaining([10, 12]));
    expect(await renderedSize(page, "row", 14)).toBeGreaterThan(0);
    expect(await renderedSize(page, "row", 10)).toBe(0);

    // The MENU tells the same truth: with no user hides left, a span that
    // contains only filter-hidden rows offers no "Unhide" at all — clearing the
    // filter is what reveals those, and the item would be a lie.
    expect((await hiddenRowsInfo(page)).user).toEqual([]);
    await selectLineViaHeader(page, "row", 9);
    await extendLineViaHeader(page, "row", 13);
    expect(
      await headerMenuOffers(page, "row", 13, "Unhide"),
      "Unhide must not be offered for rows only the FILTER is hiding",
    ).toBe(false);

    // Re-hide by hand for the other direction.
    await selectLineViaHeader(page, "row", 14);
    await headerContextMenuClick(page, "row", 14, "Hide");
    expect((await hiddenRowsInfo(page)).user).toEqual([14]);

    // (b) Clearing the FILTER must leave the hand hide standing.
    await page.evaluate(async () => {
      const svc: any = await (window as any).__calcImport(
        new URL("/src/api/autoFilterService.ts", document.baseURI).href,
      );
      await svc.requireAutoFilterController().clear(null);
    });
    await page.waitForTimeout(400);

    rows = await hiddenRowsInfo(page);
    expect(rows.effective, "clearing the filter must reveal the filtered rows").not.toContain(10);
    expect(rows.effective, "...and must NOT reveal the hand-hidden row").toContain(14);
    expect(rows.user).toEqual([14]);
    fe = await frontendHidden(page);
    expect(fe.hiddenRows).not.toContain(10);
    expect(fe.hiddenRows).toContain(14);
    expect(await renderedSize(page, "row", 10)).toBeGreaterThan(0);
    expect(await renderedSize(page, "row", 14)).toBe(0);

    await page.evaluate(async () => {
      const svc: any = await (window as any).__calcImport(
        new URL("/src/api/autoFilterService.ts", document.baseURI).href,
      );
      await svc.requireAutoFilterController().remove();
    });
    await page.waitForTimeout(300);
  });

  // -----------------------------------------------------------------------
  test("5. an insert above a hidden line moves the hide with the data", async ({
    appPage: page,
  }) => {
    await seedCells(page, [
      { row: 16, col: COL_D, value: "SHIFT-ROW" },
      { row: 18, col: COL_H, value: "SHIFT-COL" },
    ]);

    // --- rows: hide row 17, then insert a row well above it ---
    await selectLineViaHeader(page, "row", 16);
    await headerContextMenuClick(page, "row", 16, "Hide");
    expect((await hiddenRowsInfo(page)).user).toContain(16);

    await invokeBackend(page, "insert_rows", { row: 4, count: 1, sheetIndex: null });
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await page.waitForTimeout(800);

    expect(await readCell(page, 17, COL_D), "the data moved down one row").toBe("SHIFT-ROW");
    expect(
      (await hiddenRowsInfo(page)).user,
      "the hide must follow the data, not stay on the old index",
    ).toContain(17);
    expect((await hiddenRowsInfo(page)).user).not.toContain(16);
    expect((await frontendHidden(page)).hiddenRows).toContain(17);
    expect(await renderedSize(page, "row", 17)).toBe(0);
    expect(await renderedSize(page, "row", 16)).toBeGreaterThan(0);

    // --- columns (SHIFT-COL moved down to row 19 with the row insert) ---
    await selectLineViaHeader(page, "col", COL_H);
    await headerContextMenuClick(page, "col", COL_H, "Hide");
    expect((await hiddenColsInfo(page)).user).toContain(COL_H);

    await invokeBackend(page, "insert_columns", { col: 1, count: 1, sheetIndex: null });
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await page.waitForTimeout(800);

    expect(await readCell(page, 19, COL_H + 1), "the data moved right one column").toBe("SHIFT-COL");
    expect(
      (await hiddenColsInfo(page)).user,
      "the column hide must follow the data",
    ).toContain(COL_H + 1);
    expect((await hiddenColsInfo(page)).user).not.toContain(COL_H);
    expect((await frontendHidden(page)).hiddenCols).toContain(COL_H + 1);
    expect(await renderedSize(page, "col", COL_H + 1)).toBe(0);
    expect(await renderedSize(page, "col", COL_H)).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  test("6. Ctrl+Z restores visibility and Ctrl+Y hides again", async ({ appPage: page, grid }) => {
    await seedCells(page, [{ row: 12, col: COL_D, value: "UNDO-PROBE" }]);

    await selectLineViaHeader(page, "row", 12);
    await headerContextMenuClick(page, "row", 12, "Hide");
    expect((await hiddenRowsInfo(page)).user).toContain(12);
    expect(await renderedSize(page, "row", 12)).toBe(0);

    await grid.undo();
    await page.waitForTimeout(600);
    expect(
      (await hiddenRowsInfo(page)).user,
      "undo must remove the hide from the backend authority",
    ).not.toContain(12);
    expect(
      (await frontendHidden(page)).hiddenRows,
      "undo must re-read the mirror — a hide/unhide changes no cell values, so " +
        "without the hiddenChanged re-read the row stays hidden on screen",
    ).not.toContain(12);
    expect(await renderedSize(page, "row", 12)).toBeGreaterThan(0);
    expect(await readCell(page, 12, COL_D), "undo must not touch the data").toBe("UNDO-PROBE");

    await grid.redo();
    await page.waitForTimeout(600);
    expect((await hiddenRowsInfo(page)).user, "redo must re-hide").toContain(12);
    expect((await frontendHidden(page)).hiddenRows).toContain(12);
    expect(await renderedSize(page, "row", 12)).toBe(0);
  });

  // -----------------------------------------------------------------------
  test("7. scripts: setRowsHidden by sheet NAME, and 'visible' on a NON-active sheet", async ({
    appPage: page,
  }) => {
    await allowScripts(page);
    await seedCells(page, [
      { row: 5, col: COL_D, value: "A" },
      { row: 6, col: COL_D, value: "B" },
      { row: 7, col: COL_D, value: "C" },
    ]);
    await addSheetViaButton(page); // switches to Sheet2
    await seedCells(page, [
      { row: 5, col: COL_D, value: "S2-A" },
      { row: 6, col: COL_D, value: "S2-B" },
      { row: 7, col: COL_D, value: "S2-C" },
    ]);

    const names = (await sheetInfo(page)).names;
    const sheet1 = names[0];
    const sheet2 = names[1];

    // --- (a) by NAME on the ACTIVE sheet: hides ---
    const errActive = await runMacro(
      page,
      "E2EHiddenByName",
      `async function setup(context) {
         await context.api.setRowsHidden(6, 6, true, ${JSON.stringify(sheet2)});
       }`,
    );
    expect(errActive, "setRowsHidden by the ACTIVE sheet's NAME must succeed").toBeNull();
    await page.waitForTimeout(400);
    expect((await hiddenRowsInfo(page, 1)).user).toContain(6);
    expect(
      (await frontendHidden(page)).hiddenRows,
      "the script's hide must reach the grid the user is looking at",
    ).toContain(6);
    expect(await renderedSize(page, "row", 6)).toBe(0);

    // --- (b) by NAME on a NON-active sheet: REFUSED, not silently misapplied ---
    // set_rows_hidden takes no sheet parameter, so the host refuses rather than
    // redirecting the write to the active sheet. A refusal the script can see is
    // the honest answer; silently hiding the WRONG sheet's row would be the
    // data-loss-class bug this whole change exists to remove.
    const before1 = (await hiddenRowsInfo(page, 0)).user;
    const before2 = (await hiddenRowsInfo(page, 1)).user;
    const errOther = await runMacro(
      page,
      "E2EHiddenOtherSheet",
      `async function setup(context) {
         await context.api.setRowsHidden(5, 5, true, ${JSON.stringify(sheet1)});
       }`,
    );
    expect(errOther, "hiding on a non-active sheet must be refused, not silent").not.toBeNull();
    expect(String(errOther)).toMatch(/setRowsHidden/i);
    expect(
      (await hiddenRowsInfo(page, 0)).user,
      "the refused call must not have touched the other sheet",
    ).toEqual(before1);
    expect(
      (await hiddenRowsInfo(page, 1)).user,
      "...nor silently redirected the write to the active sheet",
    ).toEqual(before2);

    // --- (c) getSpecialCells("visible") on a NON-ACTIVE sheet ---
    // Hide row 7 (0-based 6) on Sheet1 too, then go back to Sheet2 and ask about Sheet1.
    // Before the fix this was impossible: user hide lived only in frontend
    // state for the ACTIVE sheet, so a background sheet's answer was passed
    // through unfiltered — it would have listed the hidden row as visible.
    await clickSheetTab(page, 0);
    await selectLineViaHeader(page, "row", 6);
    await headerContextMenuClick(page, "row", 6, "Hide");
    expect((await hiddenRowsInfo(page, 0)).user).toContain(6);
    await clickSheetTab(page, 1);
    expect((await sheetInfo(page)).activeIndex, "Sheet2 must be the active sheet now").toBe(1);

    const errVisible = await runMacro(
      page,
      "E2EHiddenVisibleOffSheet",
      `async function setup(context) {
         const off = await context.api.getSpecialCells(5, ${COL_D}, 7, ${COL_D}, "visible", ${JSON.stringify(sheet1)});
         const here = await context.api.getSpecialCells(5, ${COL_D}, 7, ${COL_D}, "visible");
         const lines = await context.api.getHiddenRows(${JSON.stringify(sheet1)});
         await context.api.setCellValue(16, ${RES_COL}, off.cells.map(c => c.row).join("|"));
         await context.api.setCellValue(17, ${RES_COL}, here.cells.map(c => c.row).join("|"));
         await context.api.setCellValue(18, ${RES_COL}, lines.user.join("|"));
         await context.api.setCellValue(19, ${RES_COL}, lines.effective.join("|"));
       }`,
    );
    expect(errVisible, "the off-sheet visibility query must not throw").toBeNull();
    await page.waitForTimeout(400);

    const offSheetRows = (await macroResult(page, 16)).split("|").filter(Boolean);
    expect(
      offSheetRows,
      "'visible' on the NON-ACTIVE sheet must exclude the row hidden there",
    ).not.toContain("6");
    expect(offSheetRows, "...while still listing the rows that are visible there").toEqual(
      expect.arrayContaining(["5", "7"]),
    );
    expect(
      (await macroResult(page, 18)).split("|"),
      "getHiddenRows on the non-active sheet must report the hand hide",
    ).toContain("6");
    expect(
      (await macroResult(page, 17)).split("|").filter(Boolean),
      "the ACTIVE sheet's own answer must exclude its own hidden row",
    ).not.toContain("6");
  });

  // -----------------------------------------------------------------------
  test("8. an xlsx round-trip keeps hidden rows and columns hidden", async ({
    appPage: page,
  }) => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const file = path.join(TMP_DIR, `hidden-xlsx-${process.pid}-${Date.now()}.xlsx`);
    try {
      await seedCells(page, [
        { row: 13, col: COL_D, value: "XLSX-ROW" },
        { row: 14, col: COL_H, value: "XLSX-COL" },
      ]);

      await selectLineViaHeader(page, "row", 13);
      await headerContextMenuClick(page, "row", 13, "Hide");
      await selectLineViaHeader(page, "col", COL_H);
      await headerContextMenuClick(page, "col", COL_H, "Hide");
      expect((await hiddenRowsInfo(page)).user).toContain(13);
      expect((await hiddenColsInfo(page)).user).toContain(COL_H);

      await saveTo(page, file);
      expect(fs.existsSync(file), "the .xlsx must be written").toBe(true);

      await wipeWorkbook(page);
      expect((await hiddenRowsInfo(page)).effective).toEqual([]);

      await openAndReload(page, file);

      expect(
        (await hiddenRowsInfo(page)).effective,
        "the row must still be hidden after an xlsx round-trip",
      ).toContain(13);
      expect(
        (await hiddenColsInfo(page)).effective,
        "the column must still be hidden after an xlsx round-trip",
      ).toContain(COL_H);
      expect(await renderedSize(page, "row", 13)).toBe(0);
      expect(await renderedSize(page, "col", COL_H)).toBe(0);
      expect(await readCell(page, 13, COL_D)).toBe("XLSX-ROW");
      expect(await readCell(page, 14, COL_H)).toBe("XLSX-COL");
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ok */
      }
    }
  });
});
