/**
 * STRUCTURAL RECALCULATION (D8 / §2s, and §2v's row-visibility guard) — proved
 * on the RUNNING app, through the real row/column-header context menu.
 *
 * WHAT D8 FIXED. `insert_rows` / `insert_columns` / `delete_rows` /
 * `delete_columns` used to re-point every reference and move every cached value
 * with its cell, and re-evaluate nothing. `=ROWS(A1:A5)` became `=ROWS(A1:A6)`
 * on an insert inside the range and went on displaying 5. The fix seeds the
 * shared cascade (`recalc_after_active_sheet_bulk_rewrite`) with three kinds of
 * seed — rewritten ASTs, every MOVED FORMULA cell, and one seed per affected
 * column/row when a stripe reference exists — plus two off-coordinate triggers
 * (`recalc_after_off_sheet_write` for re-pointed sheets, `recalc_after_name_change`
 * for re-pointed names).
 *
 * WHY THIS SPEC EXISTS. Every claim above was established by Rust unit tests and
 * by the recalculation census. Both are blind to the same thing: the census only
 * checks that a function recalculates, and a unit test drives `insert_rows_impl`
 * directly. Neither proves that the gesture a USER makes — right-click a row
 * header, "Insert Row" — reaches that code and lands on the painted grid. That
 * is the half this spec supplies, with no test double anywhere in the path.
 *
 * WHAT IS ASSERTED
 *   1. THE HEADLINE. `=ROWS(...)` displays 5; a real menu insert inside the
 *      range rewrites it to `=ROWS(...A6)` AND the rendered cell says 6.
 *   2. POSITION-SENSITIVITY WITH NO REWRITTEN REFERENCE. `=ROW()` / `=COLUMN()`
 *      have no argument to rewrite, so the register's recommended seed set
 *      (option 1: rewritten ASTs only) would never have seeded them. They are
 *      reached as MOVED FORMULA cells.
 *   3. DELETE, not just insert — the mirror of 1 and 2 for a row delete and a
 *      column delete.
 *   4. CROSS-SHEET. A reader on Sheet2 pointing into Sheet1's edited range
 *      follows. No active-sheet coordinate seed can reach it; it is the
 *      `recalc_after_off_sheet_write` trigger that does.
 *   5. UNDO AND REDO of the structural edit, rendered, both directions.
 *   6. NO REGRESSION ON THE COMMON CASE. A plain `=A+B` and a 33-formula block
 *      still hold correct values after an insert — the risk of replacing a
 *      "move the cached value" path with a seeded recalculation is that it
 *      misses something the old path got right for free.
 *   7. §2v. `=SUBTOTAL(109;...)` (ignore-hidden) over a range containing a
 *      HIDDEN row keeps ignoring it after a structural edit re-evaluates it.
 *      Before §2v the shared cascade installed no row-visibility pass, so it
 *      recomputed every such cell as if nothing were hidden and STORED the
 *      wrong answer over the right one. Here that is 120 vs 150; the register's
 *      §2v reads 130 vs 150 because its fixture hides a different value.
 *
 * VACUOUS-PASS DISCIPLINE. Every "must be X after the edit" is preceded by the
 * pre-edit assertion of the STALE value on the same cell, so no assertion can
 * pass on a value that never moved. Test 1 additionally proves the CANVAS
 * repainted (pixels differ), not merely the backend.
 *
 * THE GESTURE IS REAL. `insertRowViaHeaderMenu` left-clicks the row header
 * (asserting the selection really became `rows`), right-clicks it, waits for
 * `[role="menu"][aria-label="Context menu"]`, and clicks the menu item whose
 * text is exactly "Insert Row". No `invoke("insert_rows")` anywhere except in
 * the *oracles*, never in the thing under test.
 *
 * WHY A JOURNEY. It calls `new_file` and it adds a second sheet. The functional
 * specs share one accumulating workbook whose goldens encode the residue of
 * everything before them.
 *
 * LOCALE. sv-SE: the formula argument separator is ';', never ','.
 *
 * GRID REAL ESTATE. Columns E..J and rows 1..30. Every test starts from
 * `new_file`, so nothing else's coordinates survive into these; E..J is
 * nonetheless outside every column another spec claims, and it is far enough
 * left that the COLUMN HEADERS are on screen without horizontal scrolling —
 * which a spec that must right-click a column header needs.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import {
  readGridGeometry,
  cellRangeRectFrom,
  parseCellRef,
  type GridHelper,
} from "../helpers/grid";
import { waitForGridStable } from "../helpers/screenshots";

// ===========================================================================
// Plumbing — setup and ORACLES only. Never the thing under test.
// ===========================================================================

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

/** Call an exported function of one of the app's OWN modules, in its own realm. */
async function callModule<T = unknown>(
  page: Page,
  modulePath: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const m = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL(modulePath, document.baseURI).href)) as Record<
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
 * Wipe the workbook through the app's OWN File > New path. The raw
 * `invoke("new_file")` is the bypass; the wrapper is what announces the change.
 */
async function newFile(page: Page): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(700);
}

/**
 * The display string the CANVAS has for a cell of the ACTIVE sheet.
 * `get_viewport_cells` is the command GridCanvas itself calls for the strings
 * it paints, so this is the rendered text and not a private backend field the
 * UI may never have fetched.
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
 * The value STORED for a cell of a named sheet, read WITHOUT activating it.
 * `set_active_sheet` syncs the grid mirror and rebuilds the dependency maps —
 * exactly the machinery a stale cross-sheet value would be hidden by — so the
 * cross-sheet claim is made here FIRST, with Sheet1 still in front, and only
 * then on the rendered Sheet2.
 */
async function storedCell(page: Page, sheetName: string, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const digest = await invoke<{
    sheets: Array<{ name: string; cells: Record<string, { v: string }> }>;
  }>(page, "get_workbook_state_digest", { options: { cellsOnly: true } });
  const sheet = digest.sheets.find((s) => s.name === sheetName);
  if (!sheet) {
    throw new Error(
      `sheet "${sheetName}" not in the digest (have: ${digest.sheets.map((s) => s.name).join(", ")})`,
    );
  }
  return sheet.cells[`${row}:${col}`]?.v ?? "";
}

/** Seed cells straight into the backend — fixture setup, never the gesture. */
async function seed(page: Page, cells: Array<{ ref: string; value: string }>): Promise<void> {
  for (const { ref, value } of cells) {
    const { row, col } = parseCellRef(ref);
    await invoke(page, "update_cell", { row, col, value });
  }
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(300);
}

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

/**
 * The formula bar text for a cell, reached through the NAME BOX rather than a
 * click. `clickCell` is documented to leave a flaky ambient selection; the name
 * box is deterministic and works for a cell that has scrolled off.
 */
async function formulaOf(grid: GridHelper, ref: string): Promise<string> {
  await grid.navigateTo(ref);
  await grid.page.waitForTimeout(150);
  return grid.getFormulaBarValue();
}

// ---------------------------------------------------------------------------
// THE REAL GESTURE: row / column header context menus
// ---------------------------------------------------------------------------

/**
 * A clickable pixel of a ROW header, found by asking the app's OWN hit-testing
 * which pixel belongs to the line — and skipping the drag-to-resize handles,
 * which `handleMouseDown` tests FIRST.
 */
async function rowHeaderPoint(page: Page, index: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(async (index) => {
    const ht = (await (
      window as unknown as { __calcImport: (u: string) => Promise<unknown> }
    ).__calcImport(
      new URL("/src/core/lib/gridRenderer/interaction/hitTesting.ts", document.baseURI).href,
    )) as {
      getRowFromHeader: (...a: unknown[]) => number | null;
      getRowResizeHandle: (...a: unknown[]) => number | null;
    };
    const gs = (window as unknown as { __CALCULA_GRID_STATE__: any }).__CALCULA_GRID_STATE__;
    const cfg = gs.config;
    const area = document.querySelector("[data-grid-area]") as HTMLElement | null;
    if (!area) throw new Error("[data-grid-area] not found");
    const rect = area.getBoundingClientRect();

    const outlineW = cfg.outlineBarWidth ?? 0;
    const headerW = cfg.rowHeaderWidth ?? 22;
    const headerH = cfg.colHeaderHeight ?? 20;
    const x = outlineW + (headerW - outlineW) / 2;

    // hitTesting works in LOGICAL (pre-zoom) pixels; a Playwright click position
    // is in CSS pixels. Scan logically, then scale.
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

/**
 * A clickable pixel of a COLUMN header. Same shape as `rowHeaderPoint`: ask the
 * app's own hit-testing which pixel belongs to the column, and skip the resize
 * handles.
 */
async function colHeaderPoint(page: Page, index: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(async (index) => {
    const ht = (await (
      window as unknown as { __calcImport: (u: string) => Promise<unknown> }
    ).__calcImport(
      new URL("/src/core/lib/gridRenderer/interaction/hitTesting.ts", document.baseURI).href,
    )) as {
      getColumnFromHeader: (...a: unknown[]) => number | null;
      getColumnResizeHandle: (...a: unknown[]) => number | null;
    };
    const gs = (window as unknown as { __CALCULA_GRID_STATE__: any }).__CALCULA_GRID_STATE__;
    const cfg = gs.config;
    const area = document.querySelector("[data-grid-area]") as HTMLElement | null;
    if (!area) throw new Error("[data-grid-area] not found");
    const rect = area.getBoundingClientRect();

    const outlineH = cfg.outlineBarHeight ?? 0;
    const headerH = cfg.colHeaderHeight ?? 20;
    const headerW = cfg.rowHeaderWidth ?? 22;
    const y = outlineH + (headerH - outlineH) / 2;

    const zoom = gs.zoom || 1;
    const logicalWidth = rect.width / zoom;

    const clean: number[] = [];
    let seen = false;
    for (let x = Math.ceil(headerW) + 1; x < logicalWidth - 2; x += 1) {
      const onLine = ht.getColumnFromHeader(x, y, cfg, gs.viewport, gs.dimensions) === index;
      if (onLine) {
        seen = true;
        if (ht.getColumnResizeHandle(x, y, cfg, gs.viewport, gs.dimensions) === null) clean.push(x);
      } else if (seen) break;
    }
    if (clean.length === 0) return null;
    return { x: clean[Math.floor(clean.length / 2)] * zoom, y: y * zoom };
  }, index);
}

type HeaderMenuLabel = "Insert Row" | "Delete Row" | "Insert Column" | "Delete Column";

/**
 * Select a whole row/column by left-clicking its header (the real gesture),
 * then right-click the same pixel and click the menu item by its EXACT label.
 */
async function headerMenu(
  page: Page,
  axis: "row" | "col",
  index: number,
  label: HeaderMenuLabel,
): Promise<void> {
  const pt = axis === "row" ? await rowHeaderPoint(page, index) : await colHeaderPoint(page, index);
  if (!pt) {
    throw new Error(`${axis} ${index} has no header pixels on screen — cannot click it`);
  }
  const area = page.locator("[data-grid-area]");

  await area.click({ position: pt, force: true });
  await page.waitForTimeout(250);
  const selType = await page.evaluate(
    () =>
      (window as unknown as { __CALCULA_GRID_STATE__?: { selection?: { type?: string } } })
        .__CALCULA_GRID_STATE__?.selection?.type ?? null,
  );
  expect(selType, `a header click on ${axis} ${index} must select the whole ${axis}`).toBe(
    axis === "row" ? "rows" : "columns",
  );

  await area.click({ position: pt, button: "right", force: true });
  const menu = page.locator('[role="menu"][aria-label="Context menu"]');
  await expect(menu, "the grid context menu must open on a header right-click").toBeVisible({
    timeout: 5_000,
  });
  const item = menu.locator('[role="menuitem"]').filter({ hasText: new RegExp(`^${label}$`) });
  await expect(item, `"${label}" must be offered for this ${axis} selection`).toHaveCount(1);
  await item.click();
  await expect(menu).toBeHidden({ timeout: 5_000 });
  // The handler awaits the backend, refreshes dimensions and runs a 200 ms
  // insertion animation before the redraw.
  await page.waitForTimeout(900);
  await waitForGridStable(page);
}

/** Insert one row ABOVE the 1-based row number `n`, through the real menu. */
async function insertRowAt(page: Page, n: number): Promise<void> {
  await headerMenu(page, "row", n - 1, "Insert Row");
}

/** Delete the 1-based row `n`, through the real menu. */
async function deleteRowAt(page: Page, n: number): Promise<void> {
  await headerMenu(page, "row", n - 1, "Delete Row");
}

function colIndex(letter: string): number {
  let idx = 0;
  for (const ch of letter.toUpperCase()) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

/** Insert one column to the LEFT of `letter`, through the real menu. */
async function insertColAt(page: Page, letter: string): Promise<void> {
  await headerMenu(page, "col", colIndex(letter), "Insert Column");
}

/** Delete column `letter`, through the real menu. */
async function deleteColAt(page: Page, letter: string): Promise<void> {
  await headerMenu(page, "col", colIndex(letter), "Delete Column");
}

// ---------------------------------------------------------------------------
// Pixels — the canvas really repainted, not just the backend
// ---------------------------------------------------------------------------

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function rangeClip(page: Page, from: string, to: string): Promise<Clip> {
  const geo = await readGridGeometry(page);
  const rect = cellRangeRectFrom(from, to, geo);
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("grid canvas has no bounding box");
  return { x: box.x + rect.x, y: box.y + rect.y, width: rect.width, height: rect.height };
}

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

// ===========================================================================

test.describe.serial("Structural edits recalculate (D8 / §2s) — on the running app", () => {
  test.setTimeout(280_000);

  /** Park the viewport at the origin so every header pixel is on screen. */
  async function home(grid: GridHelper): Promise<void> {
    await grid.navigateTo("A1");
    await grid.page.waitForTimeout(200);
  }

  // =========================================================================
  // 1. THE HEADLINE
  // =========================================================================

  test("1. =ROWS(E1:E5) shows 5; a real 'Insert Row' inside the range rewrites it to E6 AND the rendered cell says 6", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seed(page, [
        { ref: "E1", value: "10" },
        { ref: "E2", value: "20" },
        { ref: "E3", value: "30" },
        { ref: "E4", value: "40" },
        { ref: "E5", value: "50" },
        // The reader sits in row 1, ABOVE the insertion point, so it does not
        // move. Only its reference is rewritten — this is D8's "rewritten AST"
        // seed kind in isolation, with no moved-cell seed to mask it.
        { ref: "G1", value: "=ROWS(E1:E5)" },
        { ref: "H1", value: "=SUM(E1:E5)" },
      ]);
      await home(grid);

      // --- TEETH: the STALE value is asserted FIRST. If the fixture never
      // showed 5, "now 6" would be a value that was always 6.
      expect(await renderedCell(page, "G1"), "before the insert, =ROWS(E1:E5) renders 5").toBe("5");
      expect(await formulaOf(grid, "G1"), "and its stored formula names E5").toBe("=ROWS(E1:E5)");
      expect(await renderedCell(page, "H1"), "control: the SUM over the same range").toBe("150");
      await home(grid);

      const before = await pixels(page, await rangeClip(page, "G1", "G1"));

      // --- THE REAL GESTURE ---
      await insertRowAt(page, 3);

      // The reference really was re-pointed by the structural edit...
      expect(
        await formulaOf(grid, "G1"),
        "the insert must re-point the range: =ROWS(E1:E6)",
      ).toBe("=ROWS(E1:E6)");
      await home(grid);

      // ...and THIS is D8: the displayed value followed it.
      expect(
        await renderedCell(page, "G1"),
        "D8: the rendered cell must now display 6, not the stale 5",
      ).toBe("6");
      // A blank row inside a SUM adds nothing, so H1 is the control that says
      // the insert did not simply corrupt everything it touched.
      expect(await renderedCell(page, "H1"), "control: SUM over the grown range is unchanged").toBe(
        "150",
      );

      // --- The CANVAS repainted, not just the backend model. ---
      const after = await pixels(page, await rangeClip(page, "G1", "G1"));
      expect(
        diffCount(before, after),
        "the painted G1 must differ — a '5' and a '6' are different ink",
      ).toBeGreaterThan(3);
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // 2. POSITION-SENSITIVITY WITH NO REWRITTEN REFERENCE
  // =========================================================================

  test("2. =ROW() has no argument to rewrite — it goes stale purely by MOVING, and the rendered value follows its new position", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seed(page, [
        { ref: "E10", value: "=ROW()" },
        { ref: "F10", value: "=ADDRESS(ROW();COLUMN())" },
        { ref: "G10", value: "=COLUMN()" },
      ]);
      await home(grid);

      // TEETH: the pre-insert values, on the pre-insert coordinates.
      expect(await renderedCell(page, "E10"), "=ROW() in row 10 renders 10").toBe("10");
      expect(await renderedCell(page, "F10"), "=ADDRESS(ROW();COLUMN()) in F10").toBe("$F$10");
      expect(await renderedCell(page, "G10"), "=COLUMN() in column G renders 7").toBe("7");

      // --- Insert ABOVE the formulas. Nothing they reference changes; they
      // simply move. Option 1 (seed only rewritten ASTs) reaches none of them.
      await insertRowAt(page, 5);

      expect(
        await formulaOf(grid, "E11"),
        "the formula itself is untouched — there was nothing to rewrite",
      ).toBe("=ROW()");
      await home(grid);

      expect(
        await renderedCell(page, "E11"),
        "D8, the case option 1 misses: =ROW() moved to row 11 and must render 11",
      ).toBe("11");
      expect(
        await renderedCell(page, "F11"),
        "=ADDRESS(ROW();COLUMN()) must follow the move to $F$11",
      ).toBe("$F$11");
      // The COLUMN of a row-moved cell does NOT change — the control that says
      // the seeding is re-evaluating rather than blindly incrementing.
      expect(await renderedCell(page, "G11"), "=COLUMN() is unaffected by a ROW insert").toBe("7");

      // The old coordinates are now empty/shifted — proof the cells really moved.
      expect(await renderedCell(page, "E10"), "row 10 now holds the row that shifted down").toBe("");
    } finally {
      await newFile(page);
    }
  });

  test("2b. =COLUMN() follows a real 'Insert Column' the same way", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seed(page, [
        { ref: "H5", value: "=COLUMN()" },
        { ref: "H6", value: "=ADDRESS(ROW();COLUMN())" },
      ]);
      await home(grid);

      expect(await renderedCell(page, "H5"), "=COLUMN() in column H renders 8").toBe("8");
      expect(await renderedCell(page, "H6"), "=ADDRESS in H6").toBe("$H$6");

      await insertColAt(page, "F");

      expect(await formulaOf(grid, "I5"), "nothing to rewrite").toBe("=COLUMN()");
      await home(grid);
      expect(
        await renderedCell(page, "I5"),
        "=COLUMN() moved to column I and must render 9",
      ).toBe("9");
      expect(await renderedCell(page, "I6"), "=ADDRESS must follow to $I$6").toBe("$I$6");
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // 3. DELETE, NOT JUST INSERT
  // =========================================================================

  test("3a. Row DELETE: =ROWS shrinks and re-renders, =SUM loses the deleted row, =ROW() moves up", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seed(page, [
        { ref: "E1", value: "10" },
        { ref: "E2", value: "20" },
        { ref: "E3", value: "30" },
        { ref: "E4", value: "40" },
        { ref: "E5", value: "50" },
        { ref: "G1", value: "=ROWS(E1:E5)" },
        { ref: "H1", value: "=SUM(E1:E5)" },
        { ref: "E12", value: "=ROW()" },
      ]);
      await home(grid);

      expect(await renderedCell(page, "G1"), "before the delete: 5").toBe("5");
      expect(await renderedCell(page, "H1"), "before the delete: 150").toBe("150");
      expect(await renderedCell(page, "E12"), "before the delete: =ROW() is 12").toBe("12");

      // --- Delete row 3 (the 30). ---
      await deleteRowAt(page, 3);

      expect(await formulaOf(grid, "G1"), "the range shrank").toBe("=ROWS(E1:E4)");
      await home(grid);
      expect(await renderedCell(page, "G1"), "D8: rendered ROWS is now 4").toBe("4");
      expect(
        await renderedCell(page, "H1"),
        "D8: the SUM lost the deleted 30 — this one is stale WITHOUT the fix",
      ).toBe("120");
      expect(
        await renderedCell(page, "E11"),
        "=ROW() moved up to row 11 and must render 11",
      ).toBe("11");
    } finally {
      await newFile(page);
    }
  });

  test("3b. Column DELETE: =COLUMNS shrinks and re-renders, and =COLUMN() moves left", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seed(page, [
        { ref: "E1", value: "1" },
        { ref: "F1", value: "2" },
        { ref: "G1", value: "3" },
        { ref: "H1", value: "4" },
        // The reader is in column E, LEFT of the deletion, so it does not move.
        { ref: "E3", value: "=COLUMNS(E1:H1)" },
        { ref: "E4", value: "=SUM(E1:H1)" },
        { ref: "J5", value: "=COLUMN()" },
      ]);
      await home(grid);

      expect(await renderedCell(page, "E3"), "before the delete: 4 columns").toBe("4");
      expect(await renderedCell(page, "E4"), "before the delete: 1+2+3+4 = 10").toBe("10");
      expect(await renderedCell(page, "J5"), "before the delete: =COLUMN() in J is 10").toBe("10");

      await deleteColAt(page, "F");

      expect(await formulaOf(grid, "E3"), "the range shrank").toBe("=COLUMNS(E1:G1)");
      await home(grid);
      expect(await renderedCell(page, "E3"), "D8: rendered COLUMNS is now 3").toBe("3");
      expect(await renderedCell(page, "E4"), "D8: the SUM lost the deleted 2").toBe("8");
      expect(
        await renderedCell(page, "I5"),
        "=COLUMN() moved left to column I and must render 9",
      ).toBe("9");
    } finally {
      await newFile(page);
    }
  });

  test("3c. Column INSERT: =COLUMNS grows and re-renders", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await seed(page, [
        { ref: "E1", value: "1" },
        { ref: "F1", value: "2" },
        { ref: "G1", value: "3" },
        { ref: "H1", value: "4" },
        { ref: "E3", value: "=COLUMNS(E1:H1)" },
      ]);
      await home(grid);

      expect(await renderedCell(page, "E3"), "before the insert: 4").toBe("4");

      await insertColAt(page, "G");

      expect(await formulaOf(grid, "E3"), "the range grew").toBe("=COLUMNS(E1:I1)");
      await home(grid);
      expect(await renderedCell(page, "E3"), "D8: rendered COLUMNS is now 5").toBe("5");
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // 4. CROSS-SHEET
  // =========================================================================

  test("4. a reader on Sheet2 pointing into Sheet1's edited range follows — the off-sheet trigger, which no active-sheet seed can reach", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seed(page, [
        { ref: "E1", value: "10" },
        { ref: "E2", value: "20" },
        { ref: "E3", value: "30" },
        { ref: "E4", value: "40" },
        { ref: "E5", value: "50" },
      ]);

      await addSheetViaUI(page);
      const sheets = await invoke<{ sheets: Array<{ name: string }>; activeIndex: number }>(
        page,
        "get_sheets",
      );
      expect(sheets.sheets.length, "the tab-bar button must really have added a sheet").toBe(2);
      expect(sheets.sheets[1].name, "the new sheet is the one the digest reads").toBe("Sheet2");
      await seed(page, [
        { ref: "E1", value: "=ROWS(Sheet1!E1:E5)" },
        { ref: "E2", value: "=SUM(Sheet1!E1:E5)" },
      ]);

      // The stored form of the reference BEFORE the edit. Asserted so that the
      // post-edit check below is a real transition, and so that a change in how
      // the reference is spelled cannot be mistaken for the edit's doing.
      //
      // NOTE ON CASE. The app stores the sheet name UPPERCASED — a cell entered
      // as `=ROWS(Sheet1!E1:E5)` reads back `=ROWS(SHEET1!E1:E5)` immediately,
      // before any structural edit exists. Probed directly on the running app:
      // the stored formula is already `ROWS(SHEET1!E1:E5)` at entry, on both
      // sheets, so this is entry-time normalisation and is orthogonal to D8.
      // The assertion therefore pins the part under test — which ROW the range
      // ends at — and is deliberately case-insensitive about the sheet name so
      // it does not silently encode an unrelated quirk as a requirement.
      const beforeFormula = await formulaOf(grid, "E1");
      expect(
        beforeFormula.toUpperCase(),
        "before: Sheet2's reference ends at row 5",
      ).toBe("=ROWS(SHEET1!E1:E5)");

      // Back to Sheet1, which is where the gesture happens.
      await activateSheetViaUI(page, 0);
      await home(grid);

      // TEETH, read without activating Sheet2 (see `storedCell`).
      expect(await storedCell(page, "Sheet2", "E1"), "before: Sheet2 ROWS = 5").toBe("5");
      expect(await storedCell(page, "Sheet2", "E2"), "before: Sheet2 SUM = 150").toBe("150");

      await insertRowAt(page, 3);

      // The non-masking read first — no sheet switch has happened yet.
      expect(
        await storedCell(page, "Sheet2", "E1"),
        "D8 off-sheet trigger: STORED Sheet2!E1 must be 6, with Sheet1 still in front",
      ).toBe("6");
      expect(await storedCell(page, "Sheet2", "E2"), "STORED Sheet2!E2 stays 150").toBe("150");

      // Then the rendered claim.
      await activateSheetViaUI(page, 1);
      await waitForGridStable(page);
      expect(await renderedCell(page, "E1"), "RENDERED Sheet2!E1 = 6").toBe("6");
      expect(
        (await formulaOf(grid, "E1")).toUpperCase(),
        "and the reference was re-pointed from row 5 to row 6",
      ).toBe("=ROWS(SHEET1!E1:E6)");
      await activateSheetViaUI(page, 0);
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // 5. UNDO AND REDO
  // =========================================================================

  test("5. Ctrl+Z puts the values back RENDERED and Ctrl+Y follows forward again — for the insert AND the delete", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seed(page, [
        { ref: "E1", value: "10" },
        { ref: "E2", value: "20" },
        { ref: "E3", value: "30" },
        { ref: "E4", value: "40" },
        { ref: "E5", value: "50" },
        { ref: "G1", value: "=ROWS(E1:E5)" },
        { ref: "H1", value: "=SUM(E1:E5)" },
        { ref: "E12", value: "=ROW()" },
      ]);
      await home(grid);

      const assertBefore = async (label: string) => {
        expect(await renderedCell(page, "G1"), `${label}: ROWS = 5`).toBe("5");
        expect(await renderedCell(page, "H1"), `${label}: SUM = 150`).toBe("150");
        expect(await renderedCell(page, "E12"), `${label}: =ROW() = 12`).toBe("12");
      };
      const assertAfterInsert = async (label: string) => {
        expect(await renderedCell(page, "G1"), `${label}: ROWS = 6`).toBe("6");
        expect(await renderedCell(page, "H1"), `${label}: SUM = 150`).toBe("150");
        expect(await renderedCell(page, "E13"), `${label}: =ROW() = 13`).toBe("13");
      };

      await assertBefore("baseline");
      await insertRowAt(page, 3);
      await assertAfterInsert("after the real insert");

      // --- UNDO. Ctrl+Z on the real grid. ---
      await grid.undo();
      await page.waitForTimeout(900);
      await waitForGridStable(page);
      expect(await formulaOf(grid, "G1"), "undo restores the reference").toBe("=ROWS(E1:E5)");
      await home(grid);
      await assertBefore("after Ctrl+Z");

      // --- REDO. Ctrl+Y on the real grid. ---
      await grid.redo();
      await page.waitForTimeout(900);
      await waitForGridStable(page);
      await assertAfterInsert("after Ctrl+Y");

      // --- Now the DELETE arm, undone and redone from the same fixture. ---
      await grid.undo();
      await page.waitForTimeout(900);
      await waitForGridStable(page);
      await assertBefore("back to baseline before the delete arm");

      await deleteRowAt(page, 3);
      const assertAfterDelete = async (label: string) => {
        expect(await renderedCell(page, "G1"), `${label}: ROWS = 4`).toBe("4");
        expect(await renderedCell(page, "H1"), `${label}: SUM = 120`).toBe("120");
        expect(await renderedCell(page, "E11"), `${label}: =ROW() = 11`).toBe("11");
      };
      await assertAfterDelete("after the real delete");

      await grid.undo();
      await page.waitForTimeout(900);
      await waitForGridStable(page);
      await assertBefore("after Ctrl+Z on the delete");

      await grid.redo();
      await page.waitForTimeout(900);
      await waitForGridStable(page);
      await assertAfterDelete("after Ctrl+Y on the delete");
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // 6. NO REGRESSION ON THE COMMON CASE
  // =========================================================================

  test("6. an ordinary block of formulas still holds correct values after an insert — the thing the old move-the-cached-value path got right for free", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      // 11 literal rows, and three formula columns per row: a doubling, a
      // same-row sum, and a second hop off the first formula column.
      const cells: Array<{ ref: string; value: string }> = [];
      for (let i = 0; i < 11; i++) {
        const r = 10 + i;
        cells.push({ ref: `E${r}`, value: String((i + 1) * 3) });
        cells.push({ ref: `F${r}`, value: `=E${r}*2` });
        cells.push({ ref: `G${r}`, value: `=E${r}+F${r}` });
        cells.push({ ref: `H${r}`, value: `=G${r}-E${r}` });
      }
      // Two plain `=A+B` sums over the SAME operands, straddling the insertion
      // point at row 6:
      //   G2 is ABOVE it — neither the cell nor its references move (control).
      //   G8 is BELOW it — the CELL moves but its references do not, which is
      //     the awkward direction: a seeding change that re-points a moved
      //     formula's references "because it moved" would break exactly this.
      cells.push({ ref: "E2", value: "7" });
      cells.push({ ref: "E3", value: "5" });
      cells.push({ ref: "G2", value: "=E2+E3" });
      cells.push({ ref: "G8", value: "=E2+E3" });
      await seed(page, cells);
      await home(grid);

      const expectBlock = async (topRow: number, label: string) => {
        for (let i = 0; i < 11; i++) {
          const r = topRow + i;
          const v = (i + 1) * 3;
          expect(await renderedCell(page, `E${r}`), `${label}: E${r}`).toBe(String(v));
          expect(await renderedCell(page, `F${r}`), `${label}: F${r} = E*2`).toBe(String(v * 2));
          expect(await renderedCell(page, `G${r}`), `${label}: G${r} = E+F`).toBe(String(v * 3));
          expect(await renderedCell(page, `H${r}`), `${label}: H${r} = G-E`).toBe(String(v * 2));
        }
      };

      await expectBlock(10, "baseline");
      expect(await renderedCell(page, "G2"), "baseline: the plain =E2+E3 above the cut").toBe("12");
      expect(await renderedCell(page, "G8"), "baseline: the plain =E2+E3 below the cut").toBe("12");

      // Insert at row 6: 44 formulas move, none of their references leaves the
      // block, and every value must survive the seeded recalculation.
      await insertRowAt(page, 6);

      await expectBlock(11, "after the insert (block moved down one row)");
      expect(
        await renderedCell(page, "G2"),
        "the sum ABOVE the insertion point did not move and still holds 12",
      ).toBe("12");
      expect(
        await renderedCell(page, "G9"),
        "the sum BELOW it moved to G9, its references did NOT move, and it still holds 12",
      ).toBe("12");
      expect(
        await formulaOf(grid, "G9"),
        "a moved formula whose operands stayed put must keep pointing at them",
      ).toBe("=E2+E3");
      await home(grid);

      // And the same after a delete that puts everything back.
      await deleteRowAt(page, 6);
      await expectBlock(10, "after the delete (block back where it started)");
      expect(await renderedCell(page, "G2"), "the control sum is still 12").toBe("12");
      expect(await renderedCell(page, "G8"), "and the moved sum is back at G8 with 12").toBe("12");
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // 7. §2v — the row-visibility guard the integration pass added
  // =========================================================================

  test("7. §2v: a HIDDEN row stays ignored by SUBTOTAL(109) when a structural edit re-evaluates it", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seed(page, [
        { ref: "E1", value: "10" },
        { ref: "E2", value: "20" },
        { ref: "E3", value: "30" },
        { ref: "E4", value: "40" },
        { ref: "E5", value: "50" },
        { ref: "G1", value: "=SUBTOTAL(109;E1:E5)" },
        { ref: "H1", value: "=SUBTOTAL(9;E1:E5)" },
      ]);
      await home(grid);

      expect(await renderedCell(page, "G1"), "nothing hidden yet: 150").toBe("150");

      // Hide row 3 (the 30) through the real header menu.
      const pt = await rowHeaderPoint(page, 2);
      if (!pt) throw new Error("row 3 has no header pixels");
      const area = page.locator("[data-grid-area]");
      await area.click({ position: pt, force: true });
      await page.waitForTimeout(250);
      await area.click({ position: pt, button: "right", force: true });
      const menu = page.locator('[role="menu"][aria-label="Context menu"]');
      await expect(menu).toBeVisible({ timeout: 5_000 });
      await menu.locator('[role="menuitem"]').filter({ hasText: /^Hide$/ }).click();
      await expect(menu).toBeHidden({ timeout: 5_000 });
      await page.waitForTimeout(700);

      // TEETH: 109 ignores the hidden row, 9 does not. The two MUST differ here
      // or the fixture never had the property under test. (Row 3 holds 30, so
      // the ignore-hidden answer is 150 - 30 = 120. §2v's own example reads
      // 130 because its fixture hid a different value.)
      expect(await renderedCell(page, "G1"), "SUBTOTAL(109) ignores the hidden 30: 120").toBe(
        "120",
      );
      expect(await renderedCell(page, "H1"), "SUBTOTAL(9) counts it: 150").toBe("150");

      // Now the structural edit that re-evaluates them. Insert BELOW the range
      // so the hidden row keeps its identity and the range simply grows.
      await insertRowAt(page, 5);

      expect(
        await renderedCell(page, "G1"),
        "§2v: the cascade must know row 3 is hidden — 120, not the 150 it wrote before the guard",
      ).toBe("120");
      expect(await renderedCell(page, "H1"), "and SUBTOTAL(9) is still 150").toBe("150");
    } finally {
      await newFile(page);
    }
  });
});
