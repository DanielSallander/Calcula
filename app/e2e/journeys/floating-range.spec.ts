/**
 * FLOATING RANGES — proved live.
 *
 * The feature shipped 2026-08-13 across backend M1–M4 (object-backed sheets,
 * the recalc program, persistence) and the FloatingRange extension (overlay,
 * DOM editor, quantized resize), verified until now by ~50 unit tests and the
 * type/boundary gates. This journey drives the PRODUCT: the real backend
 * commands the UI and the script surface share, the real overlay painting into
 * the real canvas, the real save / new / reopen path.
 *
 * THE PROBES, AND WHY THEY HAVE TEETH
 *
 *   "did the object PAINT?"     -> a canvas patch inset into the floating
 *                                  frame's own box (title bar + opaque cell
 *                                  area), sampled through the app's LIVE
 *                                  geometry, asserted in BOTH directions:
 *                                  different from the empty grid after create,
 *                                  back to the grid after delete.
 *   "do references LIVE?"       -> values read back through the typed cell
 *                                  reads AFTER editing the precedent, in all
 *                                  three directions (grid→float, float→grid,
 *                                  float→float). A formula that evaluated once
 *                                  and went stale is precisely the defect class
 *                                  (GAP A/B) the backend work closed.
 *   "does a reopened document
 *    still recalculate?"        -> save, wipe with newFile, reopen, then edit
 *                                  the precedent WITHOUT touching the range —
 *                                  the §2z "present and dead" trap. The value
 *                                  must move.
 *
 * SHARED APP. This spec's private patch is columns CA..CF (78..83), rows 41..81
 * (1-based); the floating object itself paints at sheet pixels (420,180) and is
 * deleted in a `finally`. No formula uses ',' — sv-SE ';' separators are used
 * throughout.
 */
import type { Page } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";

const SAVED_DOC = path.join(os.tmpdir(), "calcula-floating-range.cala");

/** Private cell patch (0-based): CA41..CF81. */
const P = { row: 40, col: 78 };

/** Where the object floats, in sheet pixels from A1. Inside the initial
 *  viewport so the pixel probe needs no scrolling. */
const FR_X = 420;
const FR_Y = 180;

// ---------------------------------------------------------------------------
// Backend plumbing (the same commands the UI and the script rows share)
// ---------------------------------------------------------------------------

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

interface FrInfo {
  id: string;
  name: string;
  backingSheetIndex: number;
  hostSheetIndex: number;
  rowCount: number;
  colCount: number;
  x: number;
  y: number;
  showTitle: boolean;
  showColumnHeaders: boolean;
  showRowHeaders: boolean;
  colWidths: Record<number, number>;
  rowHeights: Record<number, number>;
}

const listFrs = (page: Page) => invoke<FrInfo[]>(page, "list_floating_ranges");

/** Mutations go through the @api WRAPPER module — the product's own route,
 *  which announces the change so the extension reloads and PAINTS. A raw
 *  invoke would mutate the backend and draw nothing (proven live by this
 *  spec's own first run). */
async function frApi<T = unknown>(page: Page, fn: string, args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ fn, args }) => {
      const mod = await (window as unknown as {
        __calcImport: (u: string) => Promise<Record<string, (...a: unknown[]) => Promise<unknown>>>;
      }).__calcImport(new URL("/src/api/floatingRanges.ts", document.baseURI).href);
      return (await mod[fn](...args)) as unknown;
    },
    { fn, args },
  ) as Promise<T>;
}

async function createFr(page: Page, name: string): Promise<FrInfo> {
  return frApi<FrInfo>(page, "createFloatingRange", [FR_X, FR_Y, name]);
}

async function deleteFr(page: Page, id: string): Promise<void> {
  await frApi(page, "deleteFloatingRange", [id]);
}

async function setFrCell(page: Page, id: string, row: number, col: number, value: string) {
  await invoke(page, "update_floating_range_cell", { id, row, col, value, invariant: true });
}

interface TypedCell {
  row: number;
  col: number;
  value: unknown;
}

async function frCell(page: Page, id: string, row: number, col: number): Promise<unknown> {
  const cells = await invoke<TypedCell[]>(page, "get_floating_range_cells", {
    id,
    startRow: row,
    startCol: col,
    endRow: row,
    endCol: col,
  });
  return cells.find((c) => c.row === row && c.col === col)?.value;
}

async function gridCell(page: Page, row: number, col: number): Promise<unknown> {
  const cells = await invoke<TypedCell[]>(page, "get_range_cells_typed", {
    startRow: row,
    startCol: col,
    endRow: row,
    endCol: col,
  });
  return cells.find((c) => c.row === row && c.col === col)?.value;
}

async function setGridCell(page: Page, row: number, col: number, value: string) {
  await invoke(page, "update_cell", { row, col, value });
}

/** Poll until `probe` returns a value satisfying `ok` (repaints/recalcs are
 *  event-driven; a one-shot read races them). */
async function eventually<T>(
  probe: () => Promise<T>,
  ok: (v: T) => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = undefined as T;
  while (Date.now() < deadline) {
    last = await probe();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label}: still ${JSON.stringify(last)} after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// The pixel probe: a patch inside the floating frame's own box
// ---------------------------------------------------------------------------

/** Mean RGB of a small patch of the grid canvas at CANVAS coords. */
async function patchMean(page: Page, x: number, y: number, w = 24, h = 12): Promise<number> {
  return page.evaluate(
    ({ x, y, w, h }) => {
      // The FIRST canvas is the grid (the shapes-hometab probe's idiom — the
      // canvas layer wrapper carries no data attribute of its own).
      const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) throw new Error("grid canvas not found");
      const ctx = canvas.getContext("2d")!;
      const dpr = window.devicePixelRatio || 1;
      const data = ctx.getImageData(x * dpr, y * dpr, Math.max(1, w * dpr), Math.max(1, h * dpr)).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      return sum / (data.length / 4);
    },
    { x, y, w, h },
  );
}

/** Canvas position of the floating frame's title bar (its most opaque, most
 *  distinctive band), derived through the live geometry. */
async function frTitlePatch(page: Page): Promise<{ x: number; y: number }> {
  const geom = await readGridGeometry(page);
  // Sheet pixels -> canvas: header gutters minus scroll (the overlay's own
  // formula). The title bar starts at the frame origin.
  return {
    x: geom.rowHeaderWidth + FR_X - geom.scrollX + 30,
    y: geom.colHeaderHeight + FR_Y - geom.scrollY + 6,
  };
}

// ---------------------------------------------------------------------------
// The journeys
// ---------------------------------------------------------------------------

test.describe.serial("floating ranges, live", () => {
  test("create paints a floating frame over the grid; delete unpaints it", async ({ appPage: page }) => {
    const { x, y } = await frTitlePatch(page);
    const before = await patchMean(page, x, y);

    const fr = await createFr(page, "FloatE2E");
    try {
      await eventually(
        () => patchMean(page, x, y),
        (v) => Math.abs(v - before) > 6,
        "the floating frame never painted (patch unchanged)",
      );
    } finally {
      await deleteFr(page, fr.id);
    }
    await eventually(
      () => patchMean(page, x, y),
      (v) => Math.abs(v - before) <= 6,
      "the frame is still painted after delete",
    );
    expect(await listFrs(page)).toEqual([]);
  });

  test("references live in all three directions, through real edits", async ({ appPage: page }) => {
    const a = await createFr(page, "FloatE2E");
    const b = await createFr(page, "FloatE2Eb");
    try {
      // grid -> float
      await setGridCell(page, P.row, P.col, "5");
      await setFrCell(page, a.id, 0, 0, "=Sheet1!CA41*2");
      await eventually(
        () => frCell(page, a.id, 0, 0),
        (v) => v === 10,
        "float formula did not evaluate from its grid precedent",
      );
      await setGridCell(page, P.row, P.col, "7");
      await eventually(
        () => frCell(page, a.id, 0, 0),
        (v) => v === 14,
        "float formula went STALE when its grid precedent changed (GAP A)",
      );

      // float -> grid
      await setGridCell(page, P.row + 1, P.col, "=FloatE2E!A1+1");
      await eventually(
        () => gridCell(page, P.row + 1, P.col),
        (v) => v === 15,
        "grid formula did not follow the floating range",
      );

      // float -> float
      await setFrCell(page, b.id, 0, 0, "=FloatE2E!A1*10");
      await eventually(
        () => frCell(page, b.id, 0, 0),
        (v) => v === 140,
        "float→float reference did not evaluate",
      );
      await setGridCell(page, P.row, P.col, "9");
      await eventually(
        () => frCell(page, b.id, 0, 0),
        (v) => v === 180,
        "the two-hop chain (grid→floatA→floatB) went stale",
      );
    } finally {
      for (const fr of await listFrs(page)) {
        await deleteFr(page, fr.id);
      }
      await setGridCell(page, P.row, P.col, "");
      await setGridCell(page, P.row + 1, P.col, "");
    }
  });

  test("deleting the range turns its references into #REF!", async ({ appPage: page }) => {
    const fr = await createFr(page, "FloatE2E");
    await setFrCell(page, fr.id, 0, 0, "3");
    await setGridCell(page, P.row + 2, P.col, "=FloatE2E!A1");
    await eventually(
      () => gridCell(page, P.row + 2, P.col),
      (v) => v === 3,
      "precondition: the reference evaluated",
    );

    await deleteFr(page, fr.id);
    await eventually(
      () => gridCell(page, P.row + 2, P.col),
      (v) => typeof v === "string" && v.includes("REF"),
      "a deleted range's references must show #REF!, exactly like a deleted sheet",
    );
    await setGridCell(page, P.row + 2, P.col, "");
  });

  test("a saved, wiped and reopened document still recalculates its floating range (§2z)", async ({
    appPage: page,
  }) => {
    const fr = await createFr(page, "FloatE2E");
    let reopened = false;
    try {
      await setGridCell(page, P.row, P.col, "5");
      await setFrCell(page, fr.id, 0, 0, "=Sheet1!CA41*2");
      await eventually(() => frCell(page, fr.id, 0, 0), (v) => v === 10, "precondition");

      await invoke(page, "save_file", { path: SAVED_DOC });
      await page.waitForTimeout(500);
      await fileApi(page, "newFile");
      expect(await listFrs(page)).toEqual([]);

      await fileApi(page, "openFileAtPath", SAVED_DOC);
      reopened = true;
      const restored = await eventually(
        () => listFrs(page),
        (rows) => rows.length === 1 && rows[0].name === "FloatE2E",
        "the floating range did not survive the round trip",
      );

      // THE TRAP: edit the precedent WITHOUT touching the range. A backing
      // sheet is never active, so nothing lazily rebuilds its edges — only the
      // load-path installer (GAP B) keeps this alive.
      await setGridCell(page, P.row, P.col, "8");
      await eventually(
        () => frCell(page, restored[0].id, 0, 0),
        (v) => v === 16,
        "the reopened range is PRESENT AND DEAD — its cross-sheet edges were not reinstalled on load",
      );
    } finally {
      if (reopened) {
        for (const fr2 of await listFrs(page)) {
          await deleteFr(page, fr2.id);
        }
        await setGridCell(page, P.row, P.col, "");
      }
    }
  });

  test("undoing a cell edit restores the value without moving the user", async ({ appPage: page }) => {
    const fr = await createFr(page, "FloatE2E");
    try {
      await setFrCell(page, fr.id, 0, 0, "3");
      await setFrCell(page, fr.id, 0, 0, "9");
      await eventually(() => frCell(page, fr.id, 0, 0), (v) => v === 9, "precondition");

      const activeBefore = await invoke<{ activeIndex: number }>(page, "get_sheets");
      await page.keyboard.press("Control+z");
      await eventually(
        () => frCell(page, fr.id, 0, 0),
        (v) => v === 3,
        "Ctrl+Z did not restore the floating range cell",
      );
      const activeAfter = await invoke<{ activeIndex: number }>(page, "get_sheets");
      expect(activeAfter.activeIndex).toBe(activeBefore.activeIndex);
    } finally {
      for (const fr2 of await listFrs(page)) {
        await deleteFr(page, fr2.id);
      }
    }
  });

  // -------------------------------------------------------------------------
  // The object right-click menu (2026-08-28)
  //
  // Core refuses to open the grid's CELL menu over a floating object and
  // expects the owning extension to show its own. The FR registered its items
  // into the grid registry instead, so nothing rendered them: the menu was
  // registered, ordered, gated — and unreachable. Nothing caught it because
  // the menu had no test of any kind, which is why this one asserts in BOTH
  // directions (design mode shows it, run mode does not).
  // -------------------------------------------------------------------------

  test("right-clicking the object opens its own menu in Design Mode, and nothing in run mode", async ({
    appPage: page,
  }) => {
    const fr = await createFr(page, "FloatE2E");
    try {
      // Run mode first: the negative control has to fail for the right reason,
      // so it runs BEFORE the toggle rather than after it.
      await setDesignMode(page, false);
      await rightClickFr(page, 40, 8);
      await page.waitForTimeout(300);
      expect(await page.locator("[data-fr-context-menu]").count()).toBe(0);

      await setDesignMode(page, true);
      await rightClickFr(page, 40, 8);
      const menu = page.locator("[data-fr-context-menu]");
      await expect(menu).toBeVisible({ timeout: 3000 });
      await expect(menu).toContainText("FloatE2E");
      await expect(
        menu.locator('[data-fr-menu-item="floatingRange.properties"]'),
      ).toBeVisible();

      // A 1x1 range cannot lose its last row or column, so those two entries
      // must be absent — the gate is evaluated at OPEN time against the live
      // window, not baked in at registration.
      await expect(
        menu.locator('[data-fr-menu-item="floatingRange.deleteLastRow"]'),
      ).toHaveCount(0);

      await menu.locator('[data-fr-menu-item="floatingRange.properties"]').click();
      await expect(page.locator("[data-fr-properties-dialog]")).toBeVisible({
        timeout: 3000,
      });
      await page.locator("[data-fr-properties-dialog] button", { hasText: "Cancel" }).click();
      await expect(page.locator("[data-fr-properties-dialog]")).toHaveCount(0);
    } finally {
      await setDesignMode(page, false);
      await deleteFr(page, fr.id);
    }
  });

  test("the properties dialog hides chrome, and the choice survives save/reopen", async ({
    appPage: page,
  }) => {
    const fr = await createFr(page, "FloatE2E");
    let reopened = false;
    try {
      const before = await listFrs(page);
      expect(before[0].showTitle).toBe(true);
      expect(before[0].showColumnHeaders).toBe(true);
      expect(before[0].showRowHeaders).toBe(true);

      await setDesignMode(page, true);
      await rightClickFr(page, 40, 8);
      await page
        .locator('[data-fr-menu-item="floatingRange.properties"]')
        .click({ timeout: 3000 });
      const dialog = page.locator("[data-fr-properties-dialog]");
      await expect(dialog).toBeVisible({ timeout: 3000 });

      // A MIXED combination on purpose: all-false would also pass if the flags
      // were dropped and re-derived from a bool's `false` default.
      await dialog.locator("[data-fr-show-title]").uncheck();
      await dialog.locator("[data-fr-show-row-headers]").uncheck();
      await dialog.locator("[data-fr-apply-button]").click();
      await expect(dialog).toHaveCount(0);

      const applied = await eventually(
        () => listFrs(page),
        (rows) => rows.length === 1 && rows[0].showTitle === false,
        "hiding the title bar never reached the backend row",
      );
      expect(applied[0].showRowHeaders).toBe(false);
      expect(applied[0].showColumnHeaders).toBe(true);

      // .cala carries no format-version link for these, so the round trip is
      // the only thing standing between "hidden" and "back next Monday".
      await invoke(page, "save_file", { path: SAVED_DOC });
      await page.waitForTimeout(500);
      await fileApi(page, "newFile");
      expect(await listFrs(page)).toEqual([]);

      await fileApi(page, "openFileAtPath", SAVED_DOC);
      reopened = true;
      const restored = await eventually(
        () => listFrs(page),
        (rows) => rows.length === 1,
        "the floating range did not survive the round trip",
      );
      expect(restored[0].showTitle).toBe(false);
      expect(restored[0].showColumnHeaders).toBe(true);
      expect(restored[0].showRowHeaders).toBe(false);
    } finally {
      await setDesignMode(page, false);
      if (reopened) {
        for (const fr2 of await listFrs(page)) await deleteFr(page, fr2.id);
      } else {
        await deleteFr(page, fr.id);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Edit mode (2026-08-28)
  //
  // Core preventDefault()s the mousedown on a floating overlay body, so the
  // FR editor's textarea never blurs and its deferred blur-commit never runs.
  // The selection walked to the clicked cell while the FIRST cell stayed in
  // edit mode — two cells apparently active at once.
  // -------------------------------------------------------------------------

  test("clicking another cell while editing commits the edit and closes the editor", async ({
    appPage: page,
  }) => {
    const fr = await createFr(page, "FloatE2E");
    try {
      await frApi(page, "updateFloatingRange", [fr.id, { rowCount: 2, colCount: 2 }]);
      await page.waitForTimeout(300);

      const editor = page.locator("[data-fr-editor]");
      await dblClickFrCell(page, 0, 0);
      await expect(editor).toBeVisible({ timeout: 3000 });
      await page.keyboard.type("42");

      // The click under test: a DIFFERENT cell of the same range.
      await clickFrCell(page, 0, 1);

      await expect(editor).toBeHidden({ timeout: 3000 });
      await eventually(
        () => frCell(page, fr.id, 0, 0),
        (v) => v === 42,
        "the edit was abandoned instead of committed",
      );

      // And the click that lands on the cell being edited must NOT commit —
      // that is the user reaching into their own editor to move the caret.
      await dblClickFrCell(page, 1, 0);
      await expect(editor).toBeVisible({ timeout: 3000 });
      await page.keyboard.type("7");
      await clickFrCell(page, 1, 0);
      await page.waitForTimeout(400);
      await expect(editor).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden({ timeout: 3000 });
    } finally {
      await deleteFr(page, fr.id);
    }
  });

  // -------------------------------------------------------------------------
  // Edge handles (2026-08-29)
  //
  // The corner handles change the row/column COUNTS. These change the cell
  // SIZES. The interesting part is not the arithmetic (unit-tested) but that
  // the gesture survives at all: Core consults claimsBodyDrag and then
  // dispatches bodyDragStart synchronously, and that second handler used to
  // tear the edge drag down before its first mousemove.
  // -------------------------------------------------------------------------

  test("dragging an edge handle scales the cells without changing the counts", async ({
    appPage: page,
  }) => {
    const fr = await createFr(page, "FloatE2E");
    try {
      await frApi(page, "updateFloatingRange", [fr.id, { rowCount: 2, colCount: 2 }]);
      await page.waitForTimeout(300);
      await setDesignMode(page, true);

      // Select it: the handles are only painted and grabbable on a selected,
      // design-mode object. A click on a cell selects the object.
      await clickFrCell(page, 0, 0);
      await page.waitForTimeout(150);

      const before = (await listFrs(page))[0];
      expect(before.rowCount).toBe(2);
      expect(before.colCount).toBe(2);

      // The right edge midpoint, dragged 60px further right. Default column
      // width is 64.29, so two columns span 128.58 and the frame is
      // 28 (row gutter) + 128.58 wide; the midpoint sits on the border.
      const geom = await readGridGeometry(page);
      const frameW = 28 + 2 * 64.29;
      const frameH = 20 + 16 + 2 * 20;
      const start = await frFramePoint(page, frameW, frameH / 2);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 30 * geom.zoom, start.y, { steps: 4 });
      await page.mouse.move(start.x + 60 * geom.zoom, start.y, { steps: 4 });
      await page.mouse.up();

      const after = await eventually(
        () => listFrs(page),
        (rows) => rows.length === 1 && Object.keys(rows[0].colWidths ?? {}).length > 0,
        "the edge drag never reached the backend (colWidths still empty)",
      );

      // COUNTS untouched — that is the whole distinction from the corner handle.
      expect(after[0].rowCount).toBe(2);
      expect(after[0].colCount).toBe(2);

      // Columns grew, proportionally, and the rows were left alone.
      const widths = after[0].colWidths;
      expect(widths[0]).toBeGreaterThan(64.29);
      expect(widths[1]).toBeCloseTo(widths[0], 2);
      expect(Object.keys(after[0].rowHeights ?? {})).toHaveLength(0);

      // The content grew by roughly the drag distance (the scale is measured
      // against the CONTENT extent, so this is the round trip of the gesture).
      const grew = widths[0] + widths[1] - 2 * 64.29;
      expect(grew).toBeGreaterThan(40);
      expect(grew).toBeLessThan(80);

      // One undo step for the whole gesture, and it restores the old sizes.
      await page.keyboard.press("Control+z");
      await eventually(
        () => listFrs(page),
        (rows) => Object.keys(rows[0]?.colWidths ?? {}).length === 0,
        "undo did not restore the cell sizes in one step",
      );
    } finally {
      await setDesignMode(page, false);
      await deleteFr(page, fr.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Interaction helpers — client coordinates for a point INSIDE the frame
// ---------------------------------------------------------------------------

/** Design Mode is a frontend session flag; drive it through its @api module. */
async function setDesignMode(page: Page, on: boolean): Promise<void> {
  await page.evaluate(async (value) => {
    const mod = await (window as unknown as {
      __calcImport: (u: string) => Promise<{ setDesignMode: (v: boolean) => void }>;
    }).__calcImport(new URL("/src/api/designMode.ts", document.baseURI).href);
    mod.setDesignMode(value);
  }, on);
  await page.waitForTimeout(150);
}

/**
 * Client coordinates for a point `dx`/`dy` logical pixels into the floating
 * frame. Sheet pixels -> canvas is the overlay's own formula (header gutters
 * minus scroll); canvas -> client is the canvas LAYER's rect, which is the
 * basis the extension itself converts against.
 */
async function frFramePoint(
  page: Page,
  dx: number,
  dy: number,
): Promise<{ x: number; y: number }> {
  const geom = await readGridGeometry(page);
  const canvasX = geom.rowHeaderWidth + FR_X - geom.scrollX + dx;
  const canvasY = geom.colHeaderHeight + FR_Y - geom.scrollY + dy;
  return page.evaluate(
    ({ canvasX, canvasY, zoom }) => {
      const layer = document.querySelector("[data-grid-canvas-layer]");
      if (!layer) throw new Error("grid canvas layer not found");
      const rect = layer.getBoundingClientRect();
      return { x: rect.left + canvasX * zoom, y: rect.top + canvasY * zoom };
    },
    { canvasX, canvasY, zoom: geom.zoom },
  );
}

async function rightClickFr(page: Page, dx: number, dy: number): Promise<void> {
  const p = await frFramePoint(page, dx, dy);
  await page.mouse.click(p.x, p.y, { button: "right" });
}

/** Frame-relative centre of a local cell, using the DEFAULT chrome + sizes
 *  (these journeys never hide chrome before clicking). */
function frCellOffset(row: number, col: number): { dx: number; dy: number } {
  const ROW_HDR_W = 28;
  const TITLE_H = 20;
  const COL_HDR_H = 16;
  const COL_W = 64.29;
  const ROW_H = 20;
  return {
    dx: ROW_HDR_W + col * COL_W + COL_W / 2,
    dy: TITLE_H + COL_HDR_H + row * ROW_H + ROW_H / 2,
  };
}

async function clickFrCell(page: Page, row: number, col: number): Promise<void> {
  const o = frCellOffset(row, col);
  const p = await frFramePoint(page, o.dx, o.dy);
  await page.mouse.click(p.x, p.y);
}

async function dblClickFrCell(page: Page, row: number, col: number): Promise<void> {
  const o = frCellOffset(row, col);
  const p = await frFramePoint(page, o.dx, o.dy);
  await page.mouse.dblclick(p.x, p.y);
}

// The file-api helper (newFile / openFileAtPath), same idiom as
// shapes-hometab.spec.ts.
async function fileApi<T = unknown>(page: Page, fn: string, arg?: string): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const mod = await (window as unknown as {
        __calcImport: (u: string) => Promise<Record<string, (a?: unknown) => Promise<unknown>>>;
      }).__calcImport(new URL("/src/core/lib/file-api.ts", document.baseURI).href);
      return (await mod[fn](arg)) as unknown;
    },
    { fn, arg },
  ) as Promise<T>;
}
