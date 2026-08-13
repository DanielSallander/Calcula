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
}

const listFrs = (page: Page) => invoke<FrInfo[]>(page, "list_floating_ranges");

async function createFr(page: Page, name: string): Promise<FrInfo> {
  return invoke<FrInfo>(page, "create_floating_range", { name, x: FR_X, y: FR_Y });
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
      const canvas = document.querySelector(
        "[data-grid-canvas-layer] canvas",
      ) as HTMLCanvasElement | null;
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
  test("create paints a floating frame over the grid; delete unpaints it", async ({ page }) => {
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
      await invoke(page, "delete_floating_range", { id: fr.id });
    }
    await eventually(
      () => patchMean(page, x, y),
      (v) => Math.abs(v - before) <= 6,
      "the frame is still painted after delete",
    );
    expect(await listFrs(page)).toEqual([]);
  });

  test("references live in all three directions, through real edits", async ({ page }) => {
    const a = await createFr(page, "FloatE2E");
    const b = await createFr(page, "FloatE2Eb");
    try {
      // grid -> float
      await setGridCell(page, P.row, P.col, "5");
      await setFrCell(page, a.id, 0, 0, "=CA41*2");
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
        await invoke(page, "delete_floating_range", { id: fr.id });
      }
      await setGridCell(page, P.row, P.col, "");
      await setGridCell(page, P.row + 1, P.col, "");
    }
  });

  test("deleting the range turns its references into #REF!", async ({ page }) => {
    const fr = await createFr(page, "FloatE2E");
    await setFrCell(page, fr.id, 0, 0, "3");
    await setGridCell(page, P.row + 2, P.col, "=FloatE2E!A1");
    await eventually(
      () => gridCell(page, P.row + 2, P.col),
      (v) => v === 3,
      "precondition: the reference evaluated",
    );

    await invoke(page, "delete_floating_range", { id: fr.id });
    await eventually(
      () => gridCell(page, P.row + 2, P.col),
      (v) => typeof v === "string" && v.includes("REF"),
      "a deleted range's references must show #REF!, exactly like a deleted sheet",
    );
    await setGridCell(page, P.row + 2, P.col, "");
  });

  test("a saved, wiped and reopened document still recalculates its floating range (§2z)", async ({
    page,
  }) => {
    const fr = await createFr(page, "FloatE2E");
    let reopened = false;
    try {
      await setGridCell(page, P.row, P.col, "5");
      await setFrCell(page, fr.id, 0, 0, "=CA41*2");
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
          await invoke(page, "delete_floating_range", { id: fr2.id });
        }
        await setGridCell(page, P.row, P.col, "");
      }
    }
  });

  test("undoing a cell edit restores the value without moving the user", async ({ page }) => {
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
        await invoke(page, "delete_floating_range", { id: fr2.id });
      }
    }
  });
});

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
