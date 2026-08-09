/**
 * REMAINING CORRECTNESS — the 2026-08-08 batch, proved on the RUNNING app.
 *
 * Everything here was fixed and unit-tested (docs/design/open-decisions-2026-08.md
 * §2i, §2l, §2m). Unit tests can prove a Rust function seeds a cascade; they
 * cannot prove the user sees the new number. This spec supplies the other half:
 * every claim is made through the real UI and read back off the RENDERED grid,
 * with no save, no reload and no unrelated edit to nudge the answer.
 *
 * WHY THIS IS A JOURNEY. It calls `new_file`, saves the document to disk,
 * reopens it, and adds sheets. The functional specs share ONE accumulating
 * workbook whose screenshot goldens encode the residue of everything that ran
 * before them, so a spec that wipes or re-identifies the document belongs here.
 *
 * THE TEETH RULE, applied everywhere. "A stale value that happens to equal the
 * fresh one proves nothing", so every recalculation fixture is chosen so the
 * pre-edit and post-edit values DIFFER, and the pre-edit value is asserted
 * first. Where a fixture could pass by accident (a cycle that reports
 * a circular error because everything reports one; a control that is
 * "selectable" because every click selects it) the negative half is asserted
 * next to the positive one.
 *
 * WHY THE PIXEL PROBES ARE DIFFERENCES, NOT GOLDENS. A committed golden is only
 * valid for the exact ordered cold pass that recorded it. Every visual claim
 * here is a DIFFERENCE between two captures taken seconds apart in the same app
 * — "these pixels changed when they had to", "these pixels came back when undo
 * ran" — which needs no baseline and cannot go stale.
 *
 * CROSS-SHEET READS DO NOT MASK THEMSELVES. `get_cell` only ever answers for the
 * ACTIVE sheet, and switching sheets to read the other one runs
 * `set_active_sheet`, which rebuilds the dependency maps — precisely the
 * machinery whose absence these defects were about. Every in-memory cross-sheet
 * assertion therefore reads `get_workbook_state_digest`, a pure read of the
 * stored per-sheet grids. The rendered half is asserted afterwards, by switching
 * and reading what the canvas itself fetched.
 *
 * LOCALE. sv-SE: the formula argument separator is ';', never ','. `SUM(A1:A3)`
 * uses a range and needs none; if a future edit adds a multi-argument call it
 * must use ';'.
 *
 * GRID REAL ESTATE. Every test starts from `new_file`, so no other spec's
 * coordinates can survive into these and vice versa. Columns K, L, N, P, R,
 * T-Z, AA-AD, AW-BD and BF-BL belong to other specs and are untouched here.
 */
import type { Page } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { readGridGeometry, cellRangeRectFrom, parseCellRef } from "../helpers/grid";
import { waitForGridStable } from "../helpers/screenshots";

const SAVE_FILE = path.join(os.tmpdir(), "calcula-remaining-correctness.cala");

// ===========================================================================
// Plumbing
// ===========================================================================

/** Raw backend call — setup and oracles only, never the thing under test. */
async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const t = (
        window as unknown as {
          __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
        }
      ).__TAURI__;
      return t.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

/**
 * Call an exported function of one of the app's OWN modules, in the app's own
 * realm — the production route the UI and the script broker take. This is how a
 * "backend-only" route is exercised without invoking the Rust command directly,
 * which is the bypass several of these defects lived in.
 */
async function callModule<T = unknown>(
  page: Page,
  modulePath: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const m = (await (window as unknown as { __calcImport: (u: string) => Promise<unknown> })
        .__calcImport(new URL(modulePath, document.baseURI).href)) as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      if (typeof m[fn] !== "function") {
        throw new Error(`${modulePath} exports no function "${fn}"`);
      }
      return (await m[fn](...(args as unknown[]))) as unknown;
    },
    { modulePath, fn, args },
  ) as Promise<T>;
}

/**
 * Wipe the workbook through the app's OWN File > New path, not a raw
 * `invoke("new_file")`.
 *
 * The wrapper is what announces the change; the raw command is the bypass.
 * Driving the raw command here would leave this spec's own fixtures describing
 * the previous document — the very defect class under test.
 */
async function newFile(page: Page): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(700);
}

/** The value STORED for a cell of a named sheet, read without activating it. */
async function storedCell(page: Page, sheetName: string, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const digest = await invoke<{
    sheets: Array<{ name: string; cells: Record<string, { v: string }> }>;
  }>(page, "get_workbook_state_digest", { options: { cellsOnly: true } });
  const sheet = digest.sheets.find((s) => s.name === sheetName);
  if (!sheet) {
    throw new Error(
      `sheet "${sheetName}" not in the digest (have: ${digest.sheets
        .map((s) => s.name)
        .join(", ")})`,
    );
  }
  return sheet.cells[`${row}:${col}`]?.v ?? "";
}

/**
 * The display string the CANVAS has for a cell of the ACTIVE sheet.
 * `get_viewport_cells` is the command GridCanvas itself calls for the strings it
 * paints, so this is the rendered text and not a private backend field the UI
 * may never have fetched.
 */
async function renderedCell(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cells = await invoke<Array<{ row: number; col: number; display: string }>>(
    page,
    "get_viewport_cells",
    { startRow: row, startCol: col, endRow: row, endCol: col },
  );
  return String(cells[0]?.display ?? "");
}

/**
 * A RENDERED number as a JS number.
 *
 * The app runs under sv-SE, where the decimal separator is a COMMA and the
 * thousands separator is a space, so `Number("19,9993896484")` is `NaN` and a
 * convergence assertion written the obvious way fails as "expected NaN" while
 * the product is perfectly correct. Measured on this app, not assumed: the
 * iterative fixture below converges to the string `"19,9993896484"`.
 *
 * Integer results render with no separator at all, which is why the exact
 * string comparisons elsewhere in this spec are safe as they stand.
 */
function numeric(display: string): number {
  return Number(display.replace(/[\s  ]/g, "").replace(",", "."));
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Viewport-relative clip of a cell range, from the app's LIVE geometry. */
async function rangeClip(page: Page, from: string, to: string, pad = 0): Promise<Clip> {
  const geo = await readGridGeometry(page);
  const rect = cellRangeRectFrom(from, to, geo);
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("grid canvas has no bounding box");
  return {
    x: box.x + rect.x - pad,
    y: box.y + rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

/**
 * A fixed strip down the LEFT EDGE of the grid canvas — where the outline bar
 * appears, and where the row headers sit until it does.
 *
 * Deliberately NOT sized from `config.outlineBarWidth`: that width is ZERO until
 * a group exists, so a clip derived from it cannot exist for the "before"
 * capture. A fixed strip can be photographed in both states, which is what makes
 * "these pixels changed" a real before/after.
 */
async function leftEdgeClip(page: Page, rows: number): Promise<Clip> {
  const STRIP_WIDTH = 40; // logical px: wider than any outline bar the app draws
  const geom = await page.evaluate(() => {
    const gs = (window as unknown as { __CALCULA_GRID_STATE__: Record<string, never> })
      .__CALCULA_GRID_STATE__ as unknown as {
      config: { colHeaderHeight?: number; defaultCellHeight?: number };
      zoom?: number;
    };
    return {
      colHeaderHeight: gs.config.colHeaderHeight ?? 20,
      defaultCellHeight: gs.config.defaultCellHeight ?? 20,
      zoom: gs.zoom || 1,
    };
  });
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("grid canvas has no bounding box");
  return {
    x: box.x,
    y: box.y + geom.colHeaderHeight * geom.zoom,
    width: STRIP_WIDTH * geom.zoom,
    height: geom.defaultCellHeight * rows * geom.zoom,
  };
}

/** The outline bar's current width, 0 while no group exists on the sheet. */
async function outlineBarWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const gs = (window as unknown as { __CALCULA_GRID_STATE__: Record<string, never> })
      .__CALCULA_GRID_STATE__ as unknown as { config: { outlineBarWidth?: number } };
    return gs.config.outlineBarWidth ?? 0;
  });
}

/** Raw RGBA of a clip, decoded in the page (no image dependency in Node). */
async function pixels(page: Page, clip: Clip): Promise<number[]> {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context for pixel decode");
    ctx.drawImage(bitmap, 0, 0);
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  }, png.toString("base64"));
}

/** Pixels differing by more than a hair between two same-sized captures. */
function diffCount(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`capture sizes differ (${a.length} vs ${b.length}) — the clip moved`);
  }
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > 8 ||
      Math.abs(a[i + 1] - b[i + 1]) > 8 ||
      Math.abs(a[i + 2] - b[i + 2]) > 8
    ) {
      n++;
    }
  }
  return n;
}

type Pixel = [number, number, number];

/** Read a patch straight off the grid canvas, in CANVAS CSS pixels. */
async function samplePatch(
  page: Page,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<Pixel[]> {
  return page.evaluate(
    ({ x, y, w, h }) => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) throw new Error("grid canvas not found");
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const img = ctx.getImageData(
        Math.max(0, Math.round(x * scale)),
        Math.max(0, Math.round(y * scale)),
        Math.max(1, Math.round(w * scale)),
        Math.max(1, Math.round(h * scale)),
      );
      const out: Array<[number, number, number]> = [];
      for (let i = 0; i < img.data.length; i += 4) {
        out.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
      }
      return out;
    },
    { x, y, w, h },
  );
}

function fraction(px: Pixel[], pred: (p: Pixel) => boolean): number {
  return px.length === 0 ? 0 : px.filter(pred).length / px.length;
}

/** The default shape fill, #4472C4 — what `createShapeControlAt` writes. */
const isShapeFill = ([r, g, b]: Pixel): boolean =>
  r >= 50 && r <= 90 && g >= 95 && g <= 135 && b >= 175 && b <= 215;

/**
 * Dark ink. Row numbers and column letters are near-black glyphs; gridlines are
 * light grey and the active-cell chrome is accent BLUE (high b), so `b < 120`
 * excludes both. On an empty sheet with the selection parked away, "dark pixels
 * in the top-left corner" means "the headings are being painted" and nothing
 * else.
 */
const isDarkInk = ([r, g, b]: Pixel): boolean => r < 120 && g < 120 && b < 120;

/**
 * The anchor cell's top-left corner in CANVAS CSS pixels, from LIVE geometry —
 * including whether the ROW/COLUMN HEADINGS are being drawn at all
 * (`readGridGeometry` returns the gutters as PAINTED, via the renderer's own
 * `resolveHeaderSizes`). That last part is exactly what test 7 is about.
 */
async function anchorOrigin(
  page: Page,
  row: number,
  col: number,
): Promise<{ x: number; y: number; zoom: number }> {
  const geo = await readGridGeometry(page);
  const hiddenCols = new Set(geo.hiddenCols);
  const hiddenRows = new Set(geo.hiddenRows);
  let xOffset = 0;
  for (let c = 0; c < col; c++) {
    xOffset += hiddenCols.has(c) ? 0 : geo.columnWidths[c] ?? geo.defaultCellWidth;
  }
  let yOffset = 0;
  for (let r = 0; r < row; r++) {
    yOffset += hiddenRows.has(r) ? 0 : geo.rowHeights[r] ?? geo.defaultCellHeight;
  }
  return {
    x: (geo.rowHeaderWidth + xOffset - geo.scrollX) * geo.zoom,
    y: (geo.colHeaderHeight + yOffset - geo.scrollY) * geo.zoom,
    zoom: geo.zoom,
  };
}

/** The fraction of a patch inside a shape's box that carries the shape's fill. */
async function shapeFillFraction(page: Page, row: number, col: number): Promise<number> {
  const origin = await anchorOrigin(page, row, col);
  const z = origin.zoom;
  return fraction(
    await samplePatch(page, origin.x + 8 * z, origin.y + 5 * z, 100 * z, 14 * z),
    isShapeFill,
  );
}

/** Poll until the shape has painted (create, store sync and repaint are async). */
async function waitForShapePainted(page: Page, row: number, col: number): Promise<number> {
  let best = 0;
  for (let i = 0; i < 25; i++) {
    best = Math.max(best, await shapeFillFraction(page, row, col));
    if (best > 0.95) return best;
    await page.waitForTimeout(300);
  }
  return best;
}

/** Poll until the shape has stopped painting. */
async function waitForShapeGone(page: Page, row: number, col: number): Promise<number> {
  let worst = 1;
  for (let i = 0; i < 25; i++) {
    worst = Math.min(worst, await shapeFillFraction(page, row, col));
    if (worst < 0.02) return worst;
    await page.waitForTimeout(300);
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Sheets, controls, flags
// ---------------------------------------------------------------------------

/** Add a sheet through the REAL tab-bar button and wait for the auto-switch. */
async function addSheetViaUI(page: Page): Promise<void> {
  await page.locator('button[title="Add new sheet"]').click({ force: true });
  await page.waitForTimeout(900);
}

/** Switch sheets through the REAL tab button. */
async function activateSheetViaUI(page: Page, index: number): Promise<void> {
  await page.locator(`button[data-sheet-tab="${index}"]`).click();
  await page.waitForTimeout(900);
}

async function activeSheetIndex(page: Page): Promise<number> {
  const sheets = await invoke<{ activeIndex: number }>(page, "get_sheets");
  return sheets.activeIndex;
}

interface ControlMetadata {
  controlType: string;
  properties: Record<string, { valueType: string; value: string }>;
}

async function controlMeta(
  page: Page,
  row: number,
  col: number,
  sheetIndex = 0,
): Promise<ControlMetadata | null> {
  return invoke<ControlMetadata | null>(page, "get_control_metadata", { sheetIndex, row, col });
}

interface DisplayFlags {
  displayZeros: boolean;
  showFormulas: boolean;
  viewMode: string;
  displayHeadings: boolean;
}

const displayFlags = (page: Page) =>
  invoke<DisplayFlags>(page, "get_sheet_display_flags");

/** What the RENDERER currently believes, not what the backend stores. */
async function renderedHeadings(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const gs = (window as unknown as { __CALCULA_GRID_STATE__?: { displayHeadings?: boolean } })
      .__CALCULA_GRID_STATE__;
    return gs?.displayHeadings !== false;
  });
}

/**
 * Toggle View > Headings through the REAL menu.
 *
 * Located explicitly rather than through `clickMenuItem`: a menu button's
 * textContent CONCATENATES its label with any chevron or shortcut, so anchored
 * `^Label$` patterns match nothing for submenu rows. "Headings" is a leaf with
 * no shortcut, so `^Headings$` is exact and safe.
 */
async function toggleHeadingsViaMenu(page: Page, grid: { openMenu: (m: string) => Promise<void> }) {
  await grid.openMenu("View");
  const item = page.locator("button").filter({ hasText: /^Headings$/ }).first();
  await expect(item, "View > Headings must be reachable").toBeVisible({ timeout: 5000 });
  await item.click({ timeout: 5000 });
  await page.waitForTimeout(700);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
  }
  await waitForGridStable(page);
}

/** Formulas > Calculate > Calculate Now, through the real menu.
 *  (Named as Excel names it; the item used to read "Calculate Workbook" and to
 *  calculate one sheet.) */
async function calculateNowViaMenu(
  page: Page,
  grid: { openMenu: (m: string) => Promise<void> },
) {
  await grid.openMenu("Formulas");
  const calc = page.locator("button").filter({ hasText: /^Calculate/ }).first();
  await expect(calc, "Formulas > Calculate must be reachable").toBeVisible({ timeout: 5000 });
  await calc.hover({ timeout: 5000 });
  await page.waitForTimeout(400);
  const workbook = page.locator("button").filter({ hasText: /^Calculate Now/ }).first();
  await expect(workbook, "Formulas > Calculate > Calculate Now must be reachable").toBeVisible({
    timeout: 5000,
  });
  await workbook.click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
  }
}

/** Formulas > Calculation Options > Enable Iterative Calculation. */
async function toggleIterativeViaMenu(
  page: Page,
  grid: { openMenu: (m: string) => Promise<void> },
) {
  await grid.openMenu("Formulas");
  const opts = page.locator("button").filter({ hasText: /^Calculation Options/ }).first();
  await expect(opts, "Formulas > Calculation Options must be reachable").toBeVisible({
    timeout: 5000,
  });
  await opts.hover({ timeout: 5000 });
  await page.waitForTimeout(400);
  const toggle = page
    .locator("button")
    .filter({ hasText: /^Enable Iterative Calculation/ })
    .first();
  await expect(toggle, "the iterative-calculation toggle must be reachable").toBeVisible({
    timeout: 5000,
  });
  await toggle.click({ timeout: 5000 });
  await page.waitForTimeout(700);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
  }
}

// ===========================================================================

test.describe.serial("Remaining correctness (2026-08-08 batch)", () => {
  test.setTimeout(300_000);

  // =========================================================================
  // 1. BULK REWRITES RECALCULATE (§2m)
  // =========================================================================

  /**
   * `clear_range` erased its cells, dropped their outgoing dependency edges and
   * returned a count — and recalculated NOTHING. `=SUM(A1:A3)` kept its
   * pre-delete total until an unrelated later edit swept it up.
   *
   * TEETH: 60 -> 0 and 40 -> 0. Neither post value can be mistaken for its pre
   * value, and both pre values are asserted before the Delete key is pressed.
   */
  test("1a. the Delete key over a range recalculates its same-sheet AND cross-sheet dependents on the rendered grid", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);

      // Sheet1: A1:A3 the cells to clear, B1 the same-sheet dependent.
      await invoke(page, "update_cell", { row: 0, col: 0, value: "10" });
      await invoke(page, "update_cell", { row: 1, col: 0, value: "20" });
      await invoke(page, "update_cell", { row: 2, col: 0, value: "30" });
      await invoke(page, "update_cell", { row: 0, col: 1, value: "=SUM(A1:A3)" });

      // Sheet2: a dependent reaching back into the cleared block.
      await addSheetViaUI(page);
      const sheets = await invoke<{ sheets: Array<{ name: string }>; activeIndex: number }>(
        page,
        "get_sheets",
      );
      expect(sheets.sheets.length, "the tab-bar button really added a sheet").toBe(2);
      expect(sheets.sheets[1].name).toBe("Sheet2");
      await invoke(page, "update_cell", { row: 0, col: 0, value: "=Sheet1!A2*2" });
      await activateSheetViaUI(page, 0);
      await page.waitForTimeout(300);
      await waitForGridStable(page);

      // ---- BASELINE: the values that must MOVE. ----
      expect(await renderedCell(page, "B1"), "baseline: B1 = SUM(A1:A3)").toBe("60");
      expect(await storedCell(page, "Sheet2", "A1"), "baseline: Sheet2!A1 = Sheet1!A2*2").toBe("40");

      const sheet1Clip = await rangeClip(page, "A1", "B3", 2);
      const beforeSheet1 = await pixels(page, sheet1Clip);

      // ---- THE REAL GESTURE: select A1:A3, press Delete. ----
      await grid.selectRange("A1", "A3");
      await page.keyboard.press("Delete");
      await page.waitForTimeout(900);
      await waitForGridStable(page);

      // Guard the gesture itself, so a dropped keystroke fails HERE.
      expect(await renderedCell(page, "A1"), "the Delete really cleared A1").toBe("");
      expect(await renderedCell(page, "A2"), "the Delete really cleared A2").toBe("");
      expect(await renderedCell(page, "A3"), "the Delete really cleared A3").toBe("");

      // ---- IN MEMORY AND ON THE CANVAS, immediately. ----
      expect(
        await renderedCell(page, "B1"),
        "B1 must recalculate to 0 — 60 is the stale total `clear_range` used to leave behind",
      ).toBe("0");
      expect(
        await storedCell(page, "Sheet2", "A1"),
        "and the CROSS-SHEET dependent must follow — 40 is the stale value",
      ).toBe("0");

      const afterSheet1 = await pixels(page, sheet1Clip);
      expect(
        diffCount(beforeSheet1, afterSheet1),
        "Sheet1 must repaint (the cleared cells and the new total)",
      ).toBeGreaterThan(0);

      // ---- ON SHEET 2's RENDERED GRID. ----
      await activateSheetViaUI(page, 1);
      await waitForGridStable(page);
      expect(
        await renderedCell(page, "A1"),
        "rendered Sheet2!A1 after the clear",
      ).toBe("0");
    } finally {
      await activateSheetViaUI(page, 0).catch(() => {});
      await newFile(page);
    }
  });

  /**
   * The sibling: `replace_all` on the ACTIVE sheet, driven through the real
   * Find and Replace dialog. It was one of the five whose OFF-SHEET twin
   * recalculated correctly while the active-sheet path did not — so the bug
   * only appeared when you operated on the sheet you were looking at.
   *
   * TEETH: 21 -> 6. A stale D2 would read 21.
   */
  test("1b. Replace All through the real Find and Replace dialog recalculates the formulas that read the replaced cells", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: 1, col: 1, value: "7" });
      await invoke(page, "update_cell", { row: 1, col: 3, value: "=B2*3" });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await waitForGridStable(page);

      expect(await renderedCell(page, "B2"), "baseline: B2").toBe("7");
      expect(await renderedCell(page, "D2"), "baseline: D2 = B2*3").toBe("21");

      // Ctrl+H opens Find and Replace (keybindings.ts: core.edit.replace).
      await grid.clickCell("A1");
      await page.keyboard.press("Control+h");
      const search = page.locator('input[placeholder="Search..."]');
      await expect(search, "Ctrl+H opened Find and Replace").toBeVisible({ timeout: 10_000 });
      await search.fill("7");
      await page.waitForTimeout(700);
      const replace = page.locator('input[placeholder="Replace with..."]');
      await expect(replace, "the Replace row is showing").toBeVisible({ timeout: 5000 });
      await replace.fill("2");
      const allBtn = page.locator('button[title="Replace all matches"]');
      await expect(allBtn, "the Replace All button is enabled (a match was found)").toBeEnabled({
        timeout: 10_000,
      });
      await allBtn.click();
      await page.waitForTimeout(1200);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await waitForGridStable(page);

      expect(await renderedCell(page, "B2"), "Replace All really rewrote B2").toBe("2");
      expect(
        await renderedCell(page, "D2"),
        "D2 must recalculate to 6 — 21 is the stale product `replace_all` used to leave behind",
      ).toBe("6");
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
      await newFile(page);
    }
  });

  // =========================================================================
  // 2. CROSS-SHEET CYCLES REPORT A CIRCULAR ERROR (§2m)
  // =========================================================================

  /**
   * `partition_formula_cells` runs Kahn over ONE sheet's local map, built from
   * unprefixed references only, so `Sheet1!A1 = Sheet2!A1` with
   * `Sheet2!A1 = Sheet1!A1` was detected nowhere and terminated with whichever
   * NUMBER the evaluation order left behind.
   *
   * An order-dependent number is why one run cannot distinguish a fix from a
   * lucky ordering, so the cycle is built TWICE with the two formulas entered in
   * OPPOSITE ORDER, and the whole spec is run twice from a cold app.
   *
   * WHERE THE CHECK LIVES, and why the F9 is not a cheat: the EDIT path has no
   * cycle detection at all — not even for same-sheet cycles. The circular error
   * comes from the two FULL-recalculation passes, which is where
   * `partition_formula_cells` lives, and the fix went there on purpose so a
   * cross-sheet cycle is neither stricter nor laxer than a same-sheet one. F9 IS
   * that pass, and it is a real user gesture. The same-sheet control below is
   * entered and calculated identically, so "the check only fires on F9" cannot
   * be mistaken for "the cross-sheet case is special".
   *
   * THE SPELLING — and why this constant moved. Until 2026-08-09 the grid
   * painted `#CIRCULAR`, not the `#CIRCULAR!` every design note and Rust test
   * wrote, because `crate::cell_error_display` (app/src-tauri/src/lib.rs)
   * special-cased only NA/Conflict/Blocked/Limit and let the rest fall through
   * to `format!("#{:?}").to_uppercase()` — the Rust variant NAME, uppercased.
   * That was measured live rather than guessed (`#CIRCULAR` / `#DIV0` /
   * `#NAME` / `#VALUE`), asserted here as what the PRODUCT paints, and recorded
   * as its own register item (§2n) rather than papered over with a loose regex,
   * because a loose regex would also accept a future spelling nobody chose.
   *
   * D7 closed it: `cell_error_display` now forwards to the engine's
   * `CellError::as_literal`, so the grid, the formula bar, error checking, the
   * UDF wire, `.cala` and `.calp` all spell an error the same way. The constant
   * is still an exact string for the same reason it always was.
   */
  /** What the grid paints for a cycle — the engine's canonical literal. */
  const CIRCULAR = "#CIRCULAR!";
  async function buildCrossSheetCycle(page: Page, grid: any, sheet1First: boolean): Promise<void> {
    await newFile(page);
    await addSheetViaUI(page);
    const sheets = await invoke<{ sheets: Array<{ name: string }> }>(page, "get_sheets");
    expect(sheets.sheets.map((s) => s.name)).toEqual(["Sheet1", "Sheet2"]);

    // A same-sheet cycle alongside it, as the CONTROL: whatever the workbook
    // does to a cross-sheet cycle it must already do to this one.
    await activateSheetViaUI(page, 0);
    await grid.setCellValue("C1", "=C2");
    await grid.setCellValue("C2", "=C1");

    if (sheet1First) {
      await activateSheetViaUI(page, 0);
      await grid.setCellValue("A1", "=Sheet2!A1");
      await activateSheetViaUI(page, 1);
      await grid.setCellValue("A1", "=Sheet1!A1");
    } else {
      await activateSheetViaUI(page, 1);
      await grid.setCellValue("A1", "=Sheet1!A1");
      await activateSheetViaUI(page, 0);
      await grid.setCellValue("A1", "=Sheet2!A1");
    }
    await activateSheetViaUI(page, 0);
    await page.waitForTimeout(300);
  }

  for (const [label, sheet1First] of [
    ["Sheet1 first", true],
    ["Sheet2 first", false],
  ] as Array<[string, boolean]>) {
    test(`2. a two-sheet cycle built ${label} renders a circular error on BOTH sheets, not a number`, async ({
      appPage: page,
      grid,
    }) => {
      try {
        await buildCrossSheetCycle(page, grid, sheet1First);

        // A real F9 on the grid: Calculate Now.
        await page.locator("[data-focus-container='spreadsheet']").focus();
        await page.keyboard.press("F9");
        await page.waitForTimeout(1500);
        await waitForGridStable(page);

        const s1 = await renderedCell(page, "A1");
        const s1control = await renderedCell(page, "C1");
        expect(
          s1control,
          `the SAME-SHEET control must report ${CIRCULAR} — if it does not, this app is not detecting cycles at all and the cross-sheet assertion below would be measuring the wrong thing`,
        ).toBe(CIRCULAR);
        expect(
          s1,
          `rendered Sheet1!A1 must be ${CIRCULAR}, not the order-dependent number the bug produced (got "${s1}")`,
        ).toBe(CIRCULAR);
        expect(
          Number.isFinite(numeric(s1)),
          "and it must not be a number under any reading — that is the whole defect",
        ).toBe(false);

        await activateSheetViaUI(page, 1);
        await waitForGridStable(page);
        const s2 = await renderedCell(page, "A1");
        expect(
          s2,
          `rendered Sheet2!A1 must be ${CIRCULAR} too (got "${s2}")`,
        ).toBe(CIRCULAR);

        // TEETH: the workbook does NOT report a circular error for everything. An
        // ordinary layered reference on the same two sheets stays a number —
        // reporting a cycle for a normal workbook would be far worse than the
        // bug being fixed.
        await activateSheetViaUI(page, 0);
        await invoke(page, "update_cell", { row: 4, col: 0, value: "13" });
        await activateSheetViaUI(page, 1);
        await invoke(page, "update_cell", { row: 4, col: 0, value: "=Sheet1!A5+1" });
        await activateSheetViaUI(page, 0);
        await page.locator("[data-focus-container='spreadsheet']").focus();
        await page.keyboard.press("F9");
        await page.waitForTimeout(1500);
        expect(
          await storedCell(page, "Sheet2", "A5"),
          "a LAYERED cross-sheet reference must still be a number — the false-positive guard",
        ).toBe("14");
      } finally {
        await activateSheetViaUI(page, 0).catch(() => {});
        await newFile(page);
      }
    });
  }

  // =========================================================================
  // 3. ITERATIVE CALCULATION STILL CONVERGES (§2m)
  // =========================================================================

  /**
   * The regression the new cycle detection could most easily cause. Cross-sheet
   * members join the SAME `circular_groups` bucket a same-sheet cycle lands in,
   * so they inherit the existing `iteration_enabled` branch: iterate when on,
   * a circular error when off.
   *
   * The disclosed limitation is honoured rather than hidden: a per-sheet pass
   * iterates only the members living on the sheet it evaluates and reads the
   * other sheet's cached value, so a cross-sheet iterative cycle advances one
   * hop per WHOLE-WORKBOOK ROUND. The assertion therefore requires CONVERGENCE,
   * not instantaneity — and requires it to arrive.
   *
   * WHAT A "WHOLE-WORKBOOK ROUND" IS ON THIS APP — and what it USED to be.
   * `calculate_now` — F9, Formulas > Calculate > Calculate Now, and the
   * calculate-before-save step — used to evaluate the ACTIVE SHEET ALONE.
   * Pressing F9 six times on Sheet1 then moved a cross-sheet iterative cycle
   * exactly nowhere: measured on the running app, `Sheet1!B1 = Sheet2!B1*0.5+10`
   * with `Sheet2!B1 = Sheet1!B1` sat at 15 / 10 through six presses and did not
   * budge; switching tabs and pressing F9 on each sheet WAS the round, and the
   * cycle then converged geometrically to 19.999999702 after 25 of them.
   *
   * D1 closed that: **F9 = Calculate Now = the WORKBOOK, Shift+F9 = Calculate
   * Sheet = the active sheet**, which is Excel's model. The whole cycle is now
   * one group of one workbook-wide plan, so a SINGLE F9 converges it. The loop
   * below is kept exactly as written — it drives tab-switching rounds and
   * tolerates up to 40 of them — because it must keep passing under either
   * behaviour: what it asserts is CONVERGENCE, and convergence on round one is
   * still convergence. The one-press claim is pinned where it can be measured
   * rather than waited for, in `calculate_scope_tests.rs`.
   */
  test("3. with iterative calculation ON, a same-sheet and a cross-sheet circular reference both converge to 20 instead of reporting a circular error", async ({
    appPage: page,
    grid,
  }) => {
    let iterativeOn = false;
    try {
      await newFile(page);
      await addSheetViaUI(page);
      await activateSheetViaUI(page, 0);

      // Turn iterative calculation ON through the real Formulas menu.
      await toggleIterativeViaMenu(page, grid);
      iterativeOn = true;
      const settings = await invoke<{ enabled: boolean; maxIterations: number }>(
        page,
        "get_iteration_settings",
      );
      expect(settings.enabled, "the menu really enabled iterative calculation").toBe(true);

      // (a) SAME-SHEET: x = 0.5x + 10 converges to 20 inside one pass.
      await grid.setCellValue("A1", "=A1*0.5+10");
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await page.keyboard.press("F9");
      await page.waitForTimeout(1500);
      const sameSheet = await renderedCell(page, "A1");
      expect(
        sameSheet,
        `a same-sheet circular reference must CONVERGE under iterative calc, not report ${CIRCULAR} (got "${sameSheet}")`,
      ).not.toBe(CIRCULAR);
      expect(
        Math.abs(numeric(sameSheet) - 20),
        `and it must converge to 20 (got "${sameSheet}")`,
      ).toBeLessThan(0.01);

      // (b) CROSS-SHEET: Sheet1!B1 = Sheet2!B1 * 0.5 + 10, Sheet2!B1 = Sheet1!B1.
      await grid.setCellValue("B1", "=Sheet2!B1*0.5+10");
      await activateSheetViaUI(page, 1);
      await grid.setCellValue("B1", "=Sheet1!B1");
      await activateSheetViaUI(page, 0);
      await page.waitForTimeout(300);

      /** One whole-workbook round: F9 on every sheet in turn, through the tabs. */
      const workbookRound = async (): Promise<void> => {
        for (const sheet of [0, 1]) {
          await activateSheetViaUI(page, sheet);
          await page.locator("[data-focus-container='spreadsheet']").focus();
          await page.keyboard.press("F9");
          await page.waitForTimeout(250);
          const here = await renderedCell(page, "B1");
          expect(
            here,
            `a cross-sheet circular reference must never report ${CIRCULAR} while iterative calc is ON (sheet ${sheet + 1})`,
          ).not.toBe(CIRCULAR);
        }
      };

      let crossSheet = "";
      let rounds = 0;
      for (; rounds < 40; rounds++) {
        await workbookRound();
        await activateSheetViaUI(page, 0);
        crossSheet = await renderedCell(page, "B1");
        if (Number.isFinite(numeric(crossSheet)) && Math.abs(numeric(crossSheet) - 20) < 0.01) break;
      }
      expect(
        Math.abs(numeric(crossSheet) - 20),
        `the cross-sheet cycle must CONVERGE to 20 (last value "${crossSheet}" after ${rounds + 1} workbook rounds)`,
      ).toBeLessThan(0.01);
      expect(
        Math.abs(numeric(await storedCell(page, "Sheet2", "B1")) - 20),
        "and the other side of the cycle converges with it",
      ).toBeLessThan(0.01);
    } finally {
      // Turn iterative calculation back OFF. Leaving it on would make every
      // later cycle assertion in this run pass for the wrong reason.
      if (iterativeOn) {
        await toggleIterativeViaMenu(page, grid).catch(() => {});
        await invoke(page, "set_iteration_settings", {
          enabled: false,
          maxIterations: 100,
          maxChange: 0.001,
        }).catch(() => {});
      }
      await activateSheetViaUI(page, 0).catch(() => {});
      await newFile(page);
    }
  });

  // =========================================================================
  // 4. UNDO RESTORES NON-CELL MUTATIONS *AND ANNOUNCES THEM* (§2e / §2i / §1a)
  // =========================================================================

  /**
   * The gutter, not the flag. `renderOutlineBar` returns early while the bar is
   * zero-sized, so "the outline bar is gone" is testable as "the left strip of
   * the canvas is byte-identical to the frame before the group existed" — a
   * before/after difference that needs no golden.
   */
  test("4a. undoing a row group removes the outline gutter from the RENDERED canvas, not just from the backend", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      for (let r = 0; r < 8; r++) {
        await invoke(page, "update_cell", { row: r, col: 0, value: String((r + 1) * 10) });
      }
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await waitForGridStable(page);

      const clip = await leftEdgeClip(page, 12);
      const before = await pixels(page, clip);
      expect(await outlineBarWidth(page), "no outline bar to begin with").toBe(0);

      const result = await callModule<{ success: boolean }>(
        page,
        "/src/core/lib/tauri-api.ts",
        "groupRows",
        [2, 5],
      );
      expect(result.success, "group_rows must have succeeded").toBe(true);
      await page.waitForTimeout(900);
      await waitForGridStable(page);

      expect(
        await outlineBarWidth(page),
        "the grouped state must reach the renderer first — otherwise the undo assertion is vacuous",
      ).toBeGreaterThan(0);
      const grouped = await pixels(page, clip);
      expect(diffCount(before, grouped), "the outline bar must have appeared").toBeGreaterThan(0);

      // ---- THE REAL GESTURE: Ctrl+Z on the grid. Nothing refreshed by hand. ----
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await grid.undo();
      await page.waitForTimeout(1200);
      await waitForGridStable(page);

      expect(
        await outlineBarWidth(page),
        "undo must collapse the outline bar in the RENDERER — a backend-only restore leaves a 36px gutter for a workbook with no groups",
      ).toBe(0);
      const undone = await pixels(page, clip);
      expect(
        diffCount(before, undone),
        "the left strip must be back to exactly what it was before the group existed",
      ).toBe(0);
    } finally {
      await newFile(page);
    }
  });

  /**
   * The RENDERED consequence of a hyperlink is the CURSOR. Adding one changes
   * zero pixels of the cell (the blue-and-underlined look is separate cell
   * formatting the Insert Hyperlink dialog applies); what the extension owns is
   * an `indicatorSet` feeding a cell CURSOR interceptor — and that set is
   * exactly what went stale when nothing announced.
   */
  test("4b. undoing a hyperlink takes the pointer cursor away with it", async ({
    appPage: page,
    grid,
  }) => {
    const cursorOver = async (ref: string): Promise<string> => {
      const clip = await rangeClip(page, ref, ref);
      await page.mouse.move(clip.x + clip.width / 2, clip.y + clip.height / 2);
      await page.waitForTimeout(400);
      return page.evaluate(() => {
        const area = document.querySelector("[data-grid-area]");
        return area ? getComputedStyle(area).cursor : "<no grid area>";
      });
    };

    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: 2, col: 2, value: "Policy" });
      await invoke(page, "update_cell", { row: 2, col: 1, value: "Plain" });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("app:navigate-to-cell", { detail: { row: 12, col: 0, select: true } }),
        ),
      );
      await page.waitForTimeout(400);
      await waitForGridStable(page);

      expect(await cursorOver("C3"), "C3 has no link yet").toBe("cell");

      const added = await callModule<{ success: boolean }>(
        page,
        "/src/api/backend.ts",
        "addHyperlink",
        [
          {
            row: 2,
            col: 2,
            linkType: "url",
            target: "https://example.com/remaining-correctness",
            displayText: "Policy",
          },
        ],
      );
      expect(added.success, "add_hyperlink must have succeeded").toBe(true);
      await page.waitForTimeout(900);
      expect(
        await cursorOver("C3"),
        "the linked cell renders a pointer cursor — otherwise the undo assertion is vacuous",
      ).toBe("pointer");

      // ---- THE REAL GESTURE. ----
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await grid.undo();
      await page.waitForTimeout(1200);

      expect(
        await cursorOver("C3"),
        "undo must retire the link IN THE RENDERER — a backend-only restore leaves the cell pointer-cursored and the Open/Edit context menu live",
      ).toBe("cell");
      expect(
        await cursorOver("B3"),
        "and its neighbour was never linked (the probe is not answering 'cell' for everything by accident)",
      ).toBe("cell");
    } finally {
      await newFile(page);
    }
  });

  /**
   * Shape create -> undo -> redo on the canvas, then the script-inheritance
   * guarantee `record_controls_undo` is built around.
   *
   * THE TWO HALVES ARE DIFFERENT CLAIMS, and running them in the wrong order
   * asserts the wrong thing. This spec first asked for a script to survive
   * create -> undo -> redo and it DID, which is correct behaviour: nobody
   * deleted that script, and a user who undoes and redoes their own work wants
   * it back. The guarantee is about the DELETE path — `deleteFloatingControl`
   * deletes an instance's scripts outright rather than re-keying them, because
   * an instanceId derives from the ANCHOR, so a control later created at the
   * same cell would otherwise inherit code its author never wrote. Undoing that
   * delete must therefore bring back the CONTROL and not a binding to a script
   * row that no longer exists.
   *
   * So: undo/redo of the CREATE first (with no script in play at all), then bind
   * a script, delete through the product's own deletion path, and undo THAT.
   */
  test("4c. a shape created from the real gallery disappears on undo and comes back on redo; deleting it takes its object script, and undoing the delete brings back the control without the dead binding", async ({
    appPage: page,
    grid,
  }) => {
    const ANCHOR = { row: 6, col: 2 }; // C7 — inside a fresh document
    const scriptId = `e2e-remaining-shape-${Date.now().toString(36)}`;
    let instanceId = "";
    try {
      await newFile(page);
      await invoke(page, "set_script_security_level", { level: "enabled" });
      const sheet = await activeSheetIndex(page);
      instanceId = `control-${sheet}-${ANCHOR.row}-${ANCHOR.col}`;

      // Anchor into the body of the viewport so an 80px-tall shape is not
      // clipped by the canvas edge, then select the anchor itself.
      await grid.navigateTo("G19");
      await grid.navigateTo("C7");
      await page.waitForTimeout(300);

      expect(
        await shapeFillFraction(page, ANCHOR.row, ANCHOR.col),
        "nothing is painted at the anchor before the gallery runs",
      ).toBeLessThan(0.02);

      // ---- Insert > Shapes > Rectangle, the real gallery. ----
      await grid.openMenu("Insert");
      const shapesItem = page.locator("button").filter({ hasText: /^Shapes/ }).first();
      await expect(shapesItem, "Insert > Shapes must be reachable").toBeVisible({ timeout: 5000 });
      await shapesItem.hover();
      const rectangle = page.locator("[title='Rectangle']").first();
      await expect(rectangle, "the shape gallery opened").toBeVisible({ timeout: 10_000 });
      await rectangle.click();
      await page.waitForTimeout(900);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(80);
      }

      expect(
        await controlMeta(page, ANCHOR.row, ANCHOR.col, sheet),
        "the gallery placed a control at the selected cell",
      ).not.toBeNull();
      expect(
        await waitForShapePainted(page, ANCHOR.row, ANCHOR.col),
        "and the shape PAINTED",
      ).toBeGreaterThan(0.95);

      // ---- UNDO the CREATE: the shape must go, on the canvas. ----
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await grid.undo();
      await page.waitForTimeout(1500);
      expect(
        await controlMeta(page, ANCHOR.row, ANCHOR.col, sheet),
        "undo removed the control from the document",
      ).toBeNull();
      expect(
        await waitForShapeGone(page, ANCHOR.row, ANCHOR.col),
        "and it stopped PAINTING — a backend-only removal leaves a phantom shape on the canvas",
      ).toBeLessThan(0.02);

      // ---- REDO: it must come back, on the canvas. ----
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await grid.redo();
      await page.waitForTimeout(1500);
      expect(
        await controlMeta(page, ANCHOR.row, ANCHOR.col, sheet),
        "redo put the control back in the document",
      ).not.toBeNull();
      expect(
        await waitForShapePainted(page, ANCHOR.row, ANCHOR.col),
        "and it paints again",
      ).toBeGreaterThan(0.95);
      expect(
        await invoke(page, "get_object_script_by_target", { objectType: "shape", instanceId }),
        "the redone control carries no object script — nothing has bound one yet",
      ).toBeNull();

      // ---- Now the DELETE contract, with teeth: a real binding first. ----
      await invoke(page, "save_object_script", {
        script: {
          id: scriptId,
          name: "E2E remaining-correctness orphan probe",
          objectType: "shape",
          instanceId,
          source: "// REMAINING-ORPHAN-PROBE\nfunction setup(context) { return; }\n",
          accessLevel: "restricted",
          description: null,
          provenance: null,
          packageName: null,
          packageVersion: null,
        },
      });
      const bound = (await invoke<{ source?: string } | null>(
        page,
        "get_object_script_by_target",
        { objectType: "shape", instanceId },
      )) as { source?: string } | null;
      expect(bound, "the script really is bound before the delete").not.toBeNull();
      expect(String(bound?.source ?? "")).toContain("REMAINING-ORPHAN-PROBE");

      // The product's OWN deletion path — `deleteFloatingControl`, which the
      // Delete key, the context menu and the properties pane all funnel into,
      // reached through the registered controls provider rather than through a
      // raw `remove_control_metadata` (the bypass that leaves the frontend store
      // holding a phantom).
      const deleted = await page.evaluate(async (id: string) => {
        const cs = (await (window as unknown as { __calcImport: (u: string) => Promise<unknown> })
          .__calcImport(new URL("/src/api/controlsService.ts", document.baseURI).href)) as {
          getControlsProvider: () => { deleteControl: (i: string) => Promise<boolean> } | null;
        };
        const provider = cs.getControlsProvider();
        if (!provider) throw new Error("no controls provider is registered");
        return provider.deleteControl(id);
      }, instanceId);
      expect(deleted, "the deletion path reported success").toBe(true);
      await page.waitForTimeout(1200);

      expect(
        await controlMeta(page, ANCHOR.row, ANCHOR.col, sheet),
        "the control is gone from the document",
      ).toBeNull();
      expect(
        await waitForShapeGone(page, ANCHOR.row, ANCHOR.col),
        "and off the canvas",
      ).toBeLessThan(0.02);
      expect(
        await invoke(page, "get_object_script_by_target", { objectType: "shape", instanceId }),
        "the object script went WITH the control — the unconditional instance-keyed teardown",
      ).toBeNull();

      // ---- UNDO THE DELETE: the control comes back, the dead binding does not. ----
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await grid.undo();
      await page.waitForTimeout(1500);
      expect(
        await controlMeta(page, ANCHOR.row, ANCHOR.col, sheet),
        "undo restored the control",
      ).not.toBeNull();
      expect(
        await invoke(page, "get_object_script_by_target", { objectType: "shape", instanceId }),
        "and the recreated control inherits NO script — restoring the binding would wire it to a script row that no longer exists, and any control later created at this anchor would find a live-looking binding waiting for it",
      ).toBeNull();
      const remaining = await invoke<Array<{ instanceId: string | null }>>(
        page,
        "list_object_scripts",
      );
      expect(
        remaining.filter((s) => s.instanceId === instanceId),
        "and no script anywhere still names that instance id",
      ).toEqual([]);
    } finally {
      await invoke(page, "delete_object_script", { id: scriptId }).catch(() => {});
      if (instanceId) {
        await invoke(page, "delete_object_scripts_for_instance", { instanceId }).catch(() => {});
      }
      await newFile(page);
    }
  });

  // =========================================================================
  // 5. NAMED-RANGE UNDO RECALCULATES (§2i)
  // =========================================================================

  /**
   * A name is resolved WHILE a formula is evaluated, so no CELL coordinate on
   * any sheet describes the formulas it feeds. `apply_changes` therefore sets
   * `report.workbook_recalc` for a named-range restore and runs the shared
   * cascade over every sheet.
   *
   * WHAT CHANGED HERE, AND WHY THE FIXTURE SHRANK (D2). This test used to need
   * Formulas > "Apply Names..." to have anything to be about: `update_cell`
   * resolved the name AT ENTRY and stored the resolved reference, so typing
   * `=E2E_REMAINING_RATE` into G1 left the cell holding `$D$5` — the name was
   * not in the document, repointing it moved nothing, and the obvious version of
   * this test failed on its own precondition. That is fixed: a typed formula
   * keeps its NAME, exactly as in Excel, and the first assertion below now reads
   * the stored formula straight after typing it to prove so ON THE RUNNING APP.
   *
   * Apply Names is still exercised, and it is no longer scaffolding — it is the
   * IDEMPOTENCE check. It was the only way to get a name into a formula; it is
   * now the repair tool it is in Excel, and running it over a formula that
   * already reads the name must leave that formula alone rather than
   * double-applying anything.
   *
   * TEETH: 111 -> 222 -> 111, asserted on the STORED value and on the CANVAS.
   * The undo target differs from what is on screen when Ctrl+Z is pressed, so a
   * no-op undo cannot pass; and the pixels must move, because values in `grids`
   * are not enough — the frontend repaints only what it is told about.
   */
  test("5. undoing a named-range change restores the value the formula had before it, on the rendered grid", async ({
    appPage: page,
    grid,
  }) => {
    const NAME = "E2E_REMAINING_RATE";
    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: 4, col: 3, value: "111" }); // D5
      await invoke(page, "update_cell", { row: 5, col: 3, value: "222" }); // D6

      const created = await invoke<{ success: boolean; error?: string }>(
        page,
        "create_named_range",
        { name: NAME, sheetIndex: null, refersTo: "$D$5", comment: null, folder: null },
      );
      expect(created.success, `create_named_range failed: ${created.error ?? ""}`).toBe(true);

      // Typed through the real grid. What lands in the cell is the NAME (D2).
      await grid.setCellValue("G1", `=${NAME}`);
      await page.waitForTimeout(500);
      await waitForGridStable(page);
      expect(await renderedCell(page, "G1"), "baseline: G1 resolves the name to D5").toBe("111");
      const typedFormula = await invoke<Array<{ formula: string | null }>>(
        page,
        "get_viewport_cells",
        { startRow: 0, startCol: 6, endRow: 0, endCol: 6 },
      );
      expect(
        typedFormula[0]?.formula,
        "the cell must KEEP the name — storing `=$D$5` here is the pre-resolution defect, and it makes every assertion below about a formula that no longer mentions the name",
      ).toBe(`=${NAME}`);

      // ---- Formulas > Apply Names..., the real menu item. Idempotence: the
      // formula already reads the name, so this must leave it alone. ----
      await grid.openMenu("Formulas");
      const applyNames = page.locator("button").filter({ hasText: /^Apply Names/ }).first();
      await expect(applyNames, "Formulas > Apply Names... must be reachable").toBeVisible({
        timeout: 5000,
      });
      await applyNames.click({ timeout: 5000 });
      await page.waitForTimeout(900);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(60);
      }
      const storedFormula = await invoke<Array<{ formula: string | null }>>(
        page,
        "get_viewport_cells",
        { startRow: 0, startCol: 6, endRow: 0, endCol: 6 },
      );
      expect(
        storedFormula[0]?.formula,
        "Apply Names is idempotent over a formula that already reads the name — it has no `$D$5` text left to match, so it must not touch this cell",
      ).toBe(`=${NAME}`);
      expect(
        await renderedCell(page, "G1"),
        "and the value is unchanged by the rewrite",
      ).toBe("111");

      await grid.navigateTo("A12"); // selection chrome out of the probe
      await page.waitForTimeout(300);
      await waitForGridStable(page);
      const g1Clip = await rangeClip(page, "G1", "G1");
      const before = await pixels(page, g1Clip);

      // ---- Repoint the name, then make the forward state unambiguous. ----
      const updated = await invoke<{ success: boolean; error?: string }>(
        page,
        "update_named_range",
        { name: NAME, sheetIndex: null, refersTo: "$D$6", comment: null, folder: null },
      );
      expect(updated.success, `update_named_range failed: ${updated.error ?? ""}`).toBe(true);
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await page.keyboard.press("F9");
      await page.waitForTimeout(1200);
      await waitForGridStable(page);
      expect(
        await renderedCell(page, "G1"),
        "the name really moved — the undo below has something to undo",
      ).toBe("222");
      const moved = await pixels(page, g1Clip);
      expect(
        diffCount(before, moved),
        "and the canvas really shows 222 — the pixel probe is wired",
      ).toBeGreaterThan(0);

      // ---- THE REAL GESTURE. No F9 after it: the undo has to recalculate. ----
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await grid.undo();
      await page.waitForTimeout(1500);
      await waitForGridStable(page);

      const restored = await invoke<{ refersTo: string } | null>(page, "get_named_range", {
        name: NAME,
      });
      expect(restored?.refersTo, "undo put the definition back").toBe("$D$5");
      expect(
        await renderedCell(page, "G1"),
        "and the FORMULA that uses it shows the pre-change value with nothing recalculated by hand — 222 is the stale answer",
      ).toBe("111");
      expect(
        diffCount(before, await pixels(page, g1Clip)),
        "and the CANVAS is back to the frame it had before the name moved — a correct value the renderer never heard about is still a wrong screen",
      ).toBe(0);
    } finally {
      await invoke(page, "delete_named_range", { name: NAME }).catch(() => {});
      await newFile(page);
    }
  });

  // =========================================================================
  // 6. DISPLAY FLAGS DRIVE THE RENDERER (§2l)
  // =========================================================================

  /**
   * "The headings are painted" is measured as DARK INK in the top-left corner of
   * an EMPTY sheet: column letters and row numbers are near-black glyphs, while
   * gridlines are light grey and the active-cell chrome is accent blue. The
   * selection is parked outside the probe so it cannot contribute.
   */
  async function headingInkFraction(page: Page): Promise<number> {
    const box = await page.locator("canvas").first().boundingBox();
    if (!box) throw new Error("grid canvas has no bounding box");
    return fraction(await samplePatch(page, 0, 0, 120, 120), isDarkInk);
  }

  test("6. View > Headings drives the RENDERER, a backend-only write drives it too, new_file resets it, and it survives save and reload", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      // Park the selection outside the probe so its accent chrome cannot be
      // mistaken for a heading glyph.
      await grid.navigateTo("D10");
      await page.waitForTimeout(300);
      await waitForGridStable(page);

      const topClip = await (async (): Promise<Clip> => {
        const box = await page.locator("canvas").first().boundingBox();
        if (!box) throw new Error("grid canvas has no bounding box");
        return { x: box.x, y: box.y, width: 120, height: 120 };
      })();

      const inkOn = await headingInkFraction(page);
      const framedOn = await pixels(page, topClip);
      expect(
        inkOn,
        "the headings must be painted to begin with — otherwise every assertion below is vacuous",
      ).toBeGreaterThan(0.005);
      expect((await displayFlags(page)).displayHeadings, "and the backend agrees").toBe(true);

      // ---- (i) the real View menu turns them OFF, and the canvas loses the band ----
      await toggleHeadingsViaMenu(page, grid);
      expect(
        (await displayFlags(page)).displayHeadings,
        "View > Headings wrote the backend authority",
      ).toBe(false);
      const geoOff = await readGridGeometry(page);
      expect(geoOff.colHeaderHeight, "the PAINTED column band is gone").toBe(0);
      expect(geoOff.rowHeaderWidth, "the PAINTED row gutter is gone").toBe(0);
      const inkOff = await headingInkFraction(page);
      expect(
        inkOff,
        `the header glyphs must be gone from the canvas (dark-ink fraction ${inkOn} -> ${inkOff})`,
      ).toBeLessThan(0.001);
      expect(
        diffCount(framedOn, await pixels(page, topClip)),
        "and the top-left corner must really have repainted",
      ).toBeGreaterThan(0);

      // ---- (ii) a BACKEND-ONLY write drives the renderer (the §2l(i) fix) ----
      // No app event dispatched by this spec: the Rust setter's own
      // `sheet:display-flags-changed` is the only thing that may make this work.
      await invoke(page, "set_sheet_display_flags", { patch: { displayHeadings: true } });
      await page.waitForTimeout(1200);
      await waitForGridStable(page);
      expect(
        await renderedHeadings(page),
        "the RENDERER learned about a backend-only flag write — it used to keep painting the previous document",
      ).toBe(true);
      expect(
        await headingInkFraction(page),
        "and the header glyphs came back",
      ).toBeGreaterThan(0.005);

      // ---- (iii) new_file resets them (the §2l(ii) fix) ----
      await invoke(page, "set_sheet_display_flags", { patch: { displayHeadings: false } });
      await page.waitForTimeout(900);
      expect(
        await renderedHeadings(page),
        "off again, so the reset below has something to reset",
      ).toBe(false);
      await newFile(page);
      await grid.navigateTo("D10");
      await page.waitForTimeout(300);
      await waitForGridStable(page);
      expect(
        (await displayFlags(page)).displayHeadings,
        "new_file reset the backend flags",
      ).toBe(true);
      expect(
        await renderedHeadings(page),
        "and the FRONTEND heard about it — Rust always reset these; the renderer never knew",
      ).toBe(true);
      expect(
        await headingInkFraction(page),
        "the headings are painted again after File > New",
      ).toBeGreaterThan(0.005);

      // ---- (iv) they survive save and reload (v6 persisted per-sheet state) ----
      await toggleHeadingsViaMenu(page, grid);
      expect((await displayFlags(page)).displayHeadings, "headings off before saving").toBe(false);
      await invoke(page, "save_file", { path: SAVE_FILE });
      await page.waitForTimeout(800);

      await newFile(page); // a document that definitely has them ON
      expect(
        (await displayFlags(page)).displayHeadings,
        "the intermediate new document has them on",
      ).toBe(true);

      await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [SAVE_FILE]);
      await page.waitForTimeout(2000);
      await grid.navigateTo("D10");
      await page.waitForTimeout(300);
      await waitForGridStable(page);
      expect(
        (await displayFlags(page)).displayHeadings,
        "the reopened document brings its headings-off state back",
      ).toBe(false);
      expect(
        await renderedHeadings(page),
        "and the renderer follows the reopened document, not the one before it",
      ).toBe(false);
      expect(
        await headingInkFraction(page),
        "the reopened document paints no heading glyphs",
      ).toBeLessThan(0.001);
    } finally {
      // Leave the session with the headings ON: every later spec's geometry and
      // pixel probes are measured against a normal canvas.
      await invoke(page, "set_sheet_display_flags", { patch: { displayHeadings: true } }).catch(
        () => {},
      );
      await page.waitForTimeout(500);
      await newFile(page);
    }
  });

  // =========================================================================
  // 7. A FLOATING CONTROL IS CLICKABLE WITH HEADINGS OFF (§2l, characterised)
  // =========================================================================

  /**
   * The symptom that was measured but not characterised: a control that "could
   * not be selected at its painted position". The diagnosis is that the painter
   * uses the collapsed gutters (0/0 with the headings off) while
   * `getFloatingCanvasBounds` adds the RAW config gutters (22/20), so the hit
   * rectangle sits 22px right and 20px down of the painted one — and the click
   * that failed was 10px below the painted top edge, i.e. above the hit
   * rectangle.
   *
   * What the USER cares about is whether the control can be selected at all, so
   * that is what is asserted, in BOTH heading states, at the natural gesture:
   * the middle of the shape as painted. The 120x80 rectangle's painted box and
   * its hit box overlap through the centre in both states, so the centre click
   * is the honest "still usable" claim.
   *
   * TEETH: a click well outside the painted box must NOT select, in both states.
   * Without that, "selection works" could be satisfied by an app that selects
   * the shape wherever you click.
   */
  test("7. a shape can be selected by clicking its painted centre with the headings ON and with the headings OFF", async ({
    appPage: page,
    grid,
  }) => {
    const ANCHOR = { row: 6, col: 2 }; // C7
    let headingsOff = false;

    const selectedControl = (): Promise<string | null> =>
      callModule<string | null>(
        page,
        "/extensions/Controls/Button/floatingSelection.ts",
        "getSelectedFloatingControl",
      );

    const deselect = async () => {
      await callModule(
        page,
        "/extensions/Controls/Button/floatingSelection.ts",
        "deselectFloatingControl",
      );
      expect(await selectedControl(), "the selection really was cleared").toBeNull();
    };

    /** Click a point expressed as an offset from the shape's PAINTED origin. */
    const clickPainted = async (dx: number, dy: number) => {
      const origin = await anchorOrigin(page, ANCHOR.row, ANCHOR.col);
      const box = await page.locator("canvas").first().boundingBox();
      if (!box) throw new Error("grid canvas has no bounding box");
      await page.mouse.click(
        box.x + origin.x + dx * origin.zoom,
        box.y + origin.y + dy * origin.zoom,
      );
      await page.waitForTimeout(600);
    };

    try {
      await newFile(page);
      const sheet = await activeSheetIndex(page);
      const instanceId = `control-${sheet}-${ANCHOR.row}-${ANCHOR.col}`;

      await grid.navigateTo("G19");
      await grid.navigateTo("C7");
      await page.waitForTimeout(300);

      await grid.openMenu("Insert");
      const shapesItem = page.locator("button").filter({ hasText: /^Shapes/ }).first();
      await expect(shapesItem, "Insert > Shapes must be reachable").toBeVisible({ timeout: 5000 });
      await shapesItem.hover();
      const rectangle = page.locator("[title='Rectangle']").first();
      await expect(rectangle, "the shape gallery opened").toBeVisible({ timeout: 10_000 });
      await rectangle.click();
      await page.waitForTimeout(900);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(80);
      }
      expect(
        await controlMeta(page, ANCHOR.row, ANCHOR.col, sheet),
        "the gallery placed a shape",
      ).not.toBeNull();
      expect(
        await waitForShapePainted(page, ANCHOR.row, ANCHOR.col),
        "and it painted",
      ).toBeGreaterThan(0.95);

      // ---- HEADINGS ON ----
      expect((await displayFlags(page)).displayHeadings, "starting with the headings on").toBe(true);
      await deselect();
      await clickPainted(60, 40); // the painted centre of a 120x80 rectangle
      expect(
        await selectedControl(),
        "with the headings ON, clicking the shape's painted centre selects it",
      ).toBe(instanceId);

      await deselect();
      await clickPainted(300, 200); // far outside the painted box
      expect(
        await selectedControl(),
        "and a click well outside the shape selects NOTHING — otherwise the assertion above is satisfied by an app that selects on every click",
      ).toBeNull();

      // ---- HEADINGS OFF ----
      await toggleHeadingsViaMenu(page, grid);
      headingsOff = true;
      expect((await displayFlags(page)).displayHeadings, "the headings really went off").toBe(false);
      expect(
        (await readGridGeometry(page)).colHeaderHeight,
        "and the painted geometry collapsed, so `clickPainted` is now aiming at a different place on screen",
      ).toBe(0);
      // The shape must still be painted where the new geometry says it is —
      // if it is not, the click below would be testing the wrong pixels.
      expect(
        await waitForShapePainted(page, ANCHOR.row, ANCHOR.col),
        "the shape is painted at its headings-off position",
      ).toBeGreaterThan(0.95);

      await deselect();
      await clickPainted(60, 40);
      expect(
        await selectedControl(),
        "with the headings OFF, clicking the shape's painted centre must STILL select it — this is the symptom that was reported and never characterised",
      ).toBe(instanceId);

      await deselect();
      await clickPainted(300, 200);
      expect(
        await selectedControl(),
        "and the negative half holds with the headings off too",
      ).toBeNull();
    } finally {
      if (headingsOff) {
        await invoke(page, "set_sheet_display_flags", { patch: { displayHeadings: true } }).catch(
          () => {},
        );
        await page.waitForTimeout(600);
      }
      await callModule(
        page,
        "/extensions/Controls/Button/floatingSelection.ts",
        "deselectFloatingControl",
      ).catch(() => {});
      await newFile(page);
    }
  });
});
