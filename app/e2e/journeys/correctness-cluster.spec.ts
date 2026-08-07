/**
 * CORRECTNESS CLUSTER — the 2026-08-07 defect batch, proved on the RUNNING app.
 *
 * Five defects were fixed in one pass (docs/design/open-decisions-2026-08.md
 * §2b-§2f). Each was found by a unit test or by reading; this spec is the
 * half that no unit test can supply — that the user-visible consequence really
 * follows, in the real WebView, with no test double anywhere in the path.
 *
 * WHY THIS IS A JOURNEY AND NOT A FUNCTIONAL SPEC. It calls `new_file`, it
 * saves the document to disk, and it adds a second sheet. The functional specs
 * share ONE accumulating workbook whose screenshot goldens encode the residue
 * of everything that ran before them, so a spec that wipes or re-identifies the
 * document belongs here, where it is explicit to invoke and harmless to
 * `yarn e2e`.
 *
 * HOW THE CROSS-SHEET ASSERTIONS AVOID MASKING THEMSELVES. `get_cell` only
 * ever answers for the ACTIVE sheet, so "Sheet2!A1" cannot be expressed with it
 * while Sheet1 is in front — and switching to Sheet2 in order to read it would
 * run `set_active_sheet`, which syncs the grid mirror and rebuilds the
 * dependency maps: precisely the machinery whose absence BUG-0019 was about.
 * Every in-memory assertion here therefore reads `get_workbook_state_digest`,
 * a pure read of the stored per-sheet grids — no mirror, no recalculation, no
 * dependency rebuild. The rendered half is asserted afterwards, and only
 * afterwards, by switching to Sheet2 and diffing real canvas pixels.
 *
 * WHY THE PIXEL PROBES ARE DIFFERENCES AND NOT GOLDENS. A committed golden is
 * only valid for the exact ordered cold pass that recorded it. Every visual
 * claim here is instead a DIFFERENCE between two captures taken seconds apart
 * in the same app — "these pixels changed when they had to" or "these pixels
 * did not change when they must not" — which needs no baseline and cannot go
 * stale.
 *
 * LOCALE. sv-SE: the formula argument separator is ';', never ','. Nothing here
 * needs one, but a future edit will.
 *
 * GRID REAL ESTATE. Every test starts from `new_file`, so no other spec's
 * coordinates can survive into these and vice versa.
 */
import type { Page } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { readGridGeometry, cellRangeRectFrom, parseCellRef } from "../helpers/grid";
import { waitForGridStable } from "../helpers/screenshots";

const SAVE_FILE = path.join(os.tmpdir(), "calcula-correctness-cluster.cala");

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
 * realm — the production route an extension or the script broker takes.
 * This is how the previously-broken routes are exercised: not by invoking the
 * Rust command directly (which is the bypass the defect lived in) but through
 * the IPC wrapper that is now responsible for announcing the change.
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
 * the previous document — which is exactly the defect class under test, and it
 * bit: after 3a grouped rows, a raw `new_file` left a 36 px outline gutter for
 * a workbook with no groups, so 3b started dirty.
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
 * The value STORED for a cell of a named sheet, read without activating it.
 * See the file header: this is the only non-masking cross-sheet read.
 */
async function storedCell(
  page: Page,
  sheetName: string,
  ref: string,
): Promise<string> {
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
 * Deliberately NOT sized from `config.outlineBarWidth`: that width is ZERO
 * until a group exists (`renderOutlineBar` returns early while the bar is
 * zero-sized), so a clip derived from it cannot exist for the "before"
 * capture. A fixed strip can be photographed in both states, which is what
 * makes "these pixels changed" a real before/after.
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

// ---------------------------------------------------------------------------
// Sheets
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

/**
 * Sheet1: A1 source, A2 = A1*2 (the RECALCULATED cell — hop 0).
 * Sheet2: A1 = Sheet1!A2 (hop 1, rooted on a recalculated cell — cause 1),
 *         A2 = A1 + 1   (hop 2, a NON-ACTIVE sheet's own dependent — cause 2),
 *         B1 = Sheet1!A1 * 3 (the ONE-HOP control: a direct dependent of the
 *         EDITED cell, which worked even against the broken code and so proves
 *         the fixture is wired, not that the bug is fixed).
 */
async function seedCrossSheetChain(page: Page, sourceValue: string): Promise<void> {
  await newFile(page);
  await invoke(page, "update_cell", { row: 0, col: 0, value: sourceValue });
  await invoke(page, "update_cell", { row: 1, col: 0, value: "=A1*2" });

  await addSheetViaUI(page);
  const sheets = await invoke<{ sheets: Array<{ name: string }>; activeIndex: number }>(
    page,
    "get_sheets",
  );
  expect(sheets.sheets.length, "the tab-bar button must really have added a sheet").toBe(2);
  expect(sheets.activeIndex, "the new sheet must be the active one").toBe(1);
  expect(sheets.sheets[1].name, "the new sheet is the one the digest reads").toBe("Sheet2");

  await invoke(page, "update_cell", { row: 0, col: 0, value: "=Sheet1!A2" });
  await invoke(page, "update_cell", { row: 1, col: 0, value: "=A1+1" });
  await invoke(page, "update_cell", { row: 0, col: 1, value: "=Sheet1!A1*3" });

  await activateSheetViaUI(page, 0);
  await page.waitForTimeout(300);
}

/** The four values the chain must hold for a given source number. */
function expectedChain(source: number): {
  sheet1A2: string;
  sheet2A1: string;
  sheet2A2: string;
  sheet2B1: string;
} {
  return {
    sheet1A2: String(source * 2),
    sheet2A1: String(source * 2),
    sheet2A2: String(source * 2 + 1),
    sheet2B1: String(source * 3),
  };
}

/**
 * Assert the whole chain IN MEMORY, with no save, no reload, no
 * `calculate_now` and no sheet switch between the edit and the read.
 */
async function assertChainInMemory(page: Page, source: number, label: string): Promise<void> {
  const want = expectedChain(source);
  expect(await renderedCell(page, "A2"), `${label}: Sheet1!A2 (same-sheet)`).toBe(want.sheet1A2);
  expect(await storedCell(page, "Sheet2", "B1"), `${label}: Sheet2!B1 (ONE hop)`).toBe(
    want.sheet2B1,
  );
  expect(await storedCell(page, "Sheet2", "A1"), `${label}: Sheet2!A1 (hop 1 of 2)`).toBe(
    want.sheet2A1,
  );
  expect(await storedCell(page, "Sheet2", "A2"), `${label}: Sheet2!A2 (hop 2 of 2)`).toBe(
    want.sheet2A2,
  );
}

// ===========================================================================

test.describe.serial("Correctness cluster (2026-08-07 defect batch)", () => {
  test.setTimeout(180_000);

  // =========================================================================
  // 1. CROSS-SHEET RECALCULATION (§2c / BUG-0019)
  // =========================================================================

  test("1a. a typed edit propagates two hops across a sheet boundary, and the rendered grid shows it", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await seedCrossSheetChain(page, "100");
      await assertChainInMemory(page, 100, "baseline");

      // What Sheet2 looks like BEFORE the edit — captured while it is visible,
      // so the "after" capture can be compared against a real rendered frame.
      await activateSheetViaUI(page, 1);
      await waitForGridStable(page);
      const sheet2Clip = await rangeClip(page, "A1", "B2", 2);
      const before = await pixels(page, sheet2Clip);
      await activateSheetViaUI(page, 0);

      // --- THE REAL GESTURE: click the cell, type, press Enter. ---
      await grid.setCellValue("A1", "250");
      await page.waitForTimeout(600);
      // Guard the gesture itself: a dropped keystroke must fail HERE, saying so,
      // rather than downstream where it would masquerade as a recalc defect.
      expect(await renderedCell(page, "A1"), "the typed edit must have landed intact").toBe("250");

      // --- IN MEMORY, immediately. No save, no reload, no calculate_now. ---
      await assertChainInMemory(page, 250, "after typed edit");

      // --- ON THE RENDERED GRID. ---
      await activateSheetViaUI(page, 1);
      await waitForGridStable(page);
      const want = expectedChain(250);
      expect(await renderedCell(page, "A1"), "rendered Sheet2!A1").toBe(want.sheet2A1);
      expect(await renderedCell(page, "A2"), "rendered Sheet2!A2").toBe(want.sheet2A2);
      expect(await renderedCell(page, "B1"), "rendered Sheet2!B1").toBe(want.sheet2B1);

      const after = await pixels(page, sheet2Clip);
      expect(
        diffCount(before, after),
        "Sheet2 must REPAINT — identical pixels mean the summary sheet still shows the stale numbers",
      ).toBeGreaterThan(0);
    } finally {
      await newFile(page);
    }
  });

  test("1b. a SCRIPT write propagates the same two hops", async ({ appPage: page }) => {
    try {
      await seedCrossSheetChain(page, "100");
      await assertChainInMemory(page, 100, "baseline");

      await invoke(page, "set_script_security_level", { level: "enabled" });
      await invoke(page, "run_script", {
        request: {
          source: "Calcula.setCellValue(0, 0, '300');",
          filename: "correctness-cluster-crosssheet.js",
        },
      });
      await page.waitForTimeout(600);

      await assertChainInMemory(page, 300, "after script write");
    } finally {
      await newFile(page);
    }
  });

  test("1c. a PASTE propagates the same two hops", async ({ appPage: page, grid }) => {
    try {
      await seedCrossSheetChain(page, "100");
      await assertChainInMemory(page, 100, "baseline");

      // Park a new source value out of the chain's way, then copy it onto A1
      // through the ribbon's own Copy/Paste commands.
      await invoke(page, "update_cell", { row: 0, col: 4, value: "400" });
      await page.waitForTimeout(200);
      await grid.clickCell("E1");
      await grid.clickFormatButton("copy");
      await grid.clickCell("A1");
      await grid.clickFormatButton("paste");
      await page.waitForTimeout(700);

      expect(await renderedCell(page, "A1"), "the paste must really have landed").toBe("400");
      await assertChainInMemory(page, 400, "after paste");
    } finally {
      // Cancel the copy marquee. Marching ants animate forever, and `new_file`
      // does not dismiss them — a live marquee left on the grid makes every
      // later "these pixels did not move" assertion fail for the wrong reason.
      await page.keyboard.press("Escape");
      await newFile(page);
    }
  });

  // =========================================================================
  // 2. PIVOT PROGRESS OVERLAY (§2b)
  // =========================================================================

  test("2. a finished pivot refresh leaves no progress overlay, and a second refresh still shows one", async ({
    appPage: page,
  }) => {
    const PIVOT_DATA = [
      ["city", "sales"],
      ["Stockholm", "452"],
      ["Uppsala", "819"],
      ["Gothenburg", "234"],
      ["Stockholm", "912"],
      ["Uppsala", "567"],
    ];
    try {
      await newFile(page);
      await page.evaluate(async (data: string[][]) => {
        const tauri = (window as unknown as {
          __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } };
        }).__TAURI__;
        const updates = data.flatMap((row, r) =>
          row.map((val, c) => ({ row: r, col: c, value: val })),
        );
        await tauri.core.invoke("update_cells_batch", { updates });
      }, PIVOT_DATA);
      await page.waitForTimeout(400);

      const created = await invoke<{ pivotId: string }>(page, "create_pivot_table", {
        request: { sourceRange: "A1:B6", destinationCell: "D1", hasHeaders: true },
      });
      const pivotId = created.pivotId;
      expect(pivotId, "the pivot must exist before it can be refreshed").toBeTruthy();

      await invoke(page, "update_pivot_fields", {
        request: {
          pivotId,
          rowFields: [{ sourceIndex: 0, name: "city" }],
          valueFields: [{ sourceIndex: 1, name: "Sum of sales", aggregation: "sum" }],
        },
      });
      await page.waitForTimeout(600);
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.keyboard.press("Escape"); // no stray clipboard marquee
      await waitForGridStable(page);

      // ---- PRECONDITION. The overlay is CANVAS-drawn and its progress bar
      //      re-renders every animation frame while it lives, so "no overlay"
      //      is testable as "these pixels do not move". Establish that the
      //      region is quiet BEFORE the refresh: otherwise a failure after it
      //      could equally be the pivot-field update's own leftover overlay,
      //      or anything else on the grid that animates. ----
      const pivotClip = await rangeClip(page, "D1", "E5", 2);
      const quiet1 = await pixels(page, pivotClip);
      await page.waitForTimeout(1100);
      const quiet2 = await pixels(page, pivotClip);
      expect(
        diffCount(quiet1, quiet2),
        "the pivot region must already be static before the refresh — if it is not, something OTHER than refreshPivotCache is animating and the assertion below would be meaningless",
      ).toBe(0);

      // ---- THE DEFECT: refresh through the extension's own production path,
      //      the one the ribbon's Refresh and the context menu both call. ----
      await callModule(page, "/extensions/Pivot/lib/pivot-api.ts", "refreshPivotCache", [pivotId]);
      await page.waitForTimeout(1500);

      const stillLoading = await callModule<boolean>(
        page,
        "/extensions/Pivot/lib/pivotViewStore.ts",
        "isLoading",
        [pivotId],
      );
      expect(
        stillLoading,
        'the loading indicator must be gone after the refresh returns — it used to stick at "Updating grid... (4/4)" with a Cancel button over the grid',
      ).toBe(false);

      // Same measurement as the precondition, now after the refresh: a stuck
      // overlay cannot hold still, so two byte-identical captures ~1s apart
      // prove nothing is painting over the pivot.
      const frame1 = await pixels(page, pivotClip);
      await page.waitForTimeout(1100);
      const frame2 = await pixels(page, pivotClip);
      expect(
        diffCount(frame1, frame2),
        "the pivot region must be STATIC after the refresh — a moving pixel is the indeterminate progress bar still animating",
      ).toBe(0);

      // ---- THE GUARD MUST NOT HAVE KILLED THE FEATURE: a second refresh
      //      still raises the indicator, and a live progress event still
      //      reaches it.
      //
      // Sampled from INSIDE the page. A five-row pivot refreshes in a few
      // milliseconds, so polling over CDP (~30 ms per round trip) can miss the
      // whole window and report "no indicator" for a refresh that showed one
      // perfectly — a false red that would look exactly like the guard having
      // suppressed it. A 2 ms in-page sampler running in the same realm as the
      // store cannot miss it. ----
      const second = await page.evaluate(async (id: string) => {
        const imp = (window as unknown as { __calcImport: (u: string) => Promise<unknown> })
          .__calcImport;
        const api = (await imp(
          new URL("/extensions/Pivot/lib/pivot-api.ts", document.baseURI).href,
        )) as { refreshPivotCache: (i: string) => Promise<unknown> };
        const store = (await imp(
          new URL("/extensions/Pivot/lib/pivotViewStore.ts", document.baseURI).href,
        )) as {
          isLoading: (i: string) => boolean;
          getLoadingState: (i: string) => { stage: string; totalStages: number } | undefined;
          applyBackendProgress: (i: string, s: string, a?: number, b?: number) => boolean;
        };

        const stages = new Set<string>();
        let sawLoading = false;
        const sample = (): void => {
          const st = store.getLoadingState(id);
          if (st) {
            sawLoading = true;
            stages.add(`${st.stage}|${st.totalStages}`);
          }
        };
        const timer = setInterval(sample, 2);
        const promise = api.refreshPivotCache(id);
        sample(); // the synchronous setLoading that precedes the IPC
        await promise;
        sample();
        clearInterval(timer);

        // The guard's own contract, exercised on the LIVE store: a backend
        // progress event may UPDATE a running operation and must never START
        // one. Checked here, with the operation genuinely finished, so
        // "trailing event is dropped" is a fact about this app and not about a
        // mock.
        const droppedWhenIdle = store.applyBackendProgress(id, "Updating grid...", 3, 4);
        return {
          sawLoading,
          stages: Array.from(stages),
          loadingAfter: store.isLoading(id),
          droppedWhenIdle,
        };
      }, pivotId);

      expect(
        second.sawLoading,
        `a SECOND refresh must still raise the progress indicator — a guard that suppressed it would have traded a stuck spinner for no spinner at all (stages seen: ${JSON.stringify(second.stages)})`,
      ).toBe(true);
      expect(
        second.loadingAfter,
        "and the second refresh must clear it too",
      ).toBe(false);
      expect(
        second.droppedWhenIdle,
        "a trailing backend progress event arriving after the operation finished must be DROPPED, not re-arm an indicator nothing will clear — that is the whole fix",
      ).toBe(false);

      // Belt and braces on the pixels: still nothing animating.
      const frame3 = await pixels(page, pivotClip);
      await page.waitForTimeout(1100);
      expect(
        diffCount(frame3, await pixels(page, pivotClip)),
        "the pivot region must be static after the SECOND refresh too",
      ).toBe(0);
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // 3. BACKEND MUTATIONS REACHING THE SCREEN (§2e)
  // =========================================================================

  test("3a. grouping through the IPC wrapper repaints the outline bar", async ({
    appPage: page,
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

      // The route that used to change 0 pixels: @api's own outline mutator,
      // NOT the Grouping extension's internal perform* helper.
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
        "the FRONTEND must have learned about the group — a zero-width bar is the defect (renderOutlineBar returns early and nothing re-fetches)",
      ).toBeGreaterThan(0);
      const after = await pixels(page, clip);
      expect(
        diffCount(before, after),
        "the outline bar must appear — this route used to move the backend and change 0 pixels",
      ).toBeGreaterThan(0);
    } finally {
      await newFile(page);
    }
  });

  test("3b. grouping through the real Data menu repaints the outline bar", async ({
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

      // Data > Outline > Group.
      //
      // Located explicitly rather than through `grid.hoverMenuItem`, for two
      // reasons that both cost a 3-minute hang to learn: `Group` is a SUBMENU
      // item, and a menu button's textContent CONCATENATES its label with its
      // chevron or shortcut — the Outline row reads "Outline▸" and the Group
      // row reads "GroupAlt+Shift+Right", so anchored `^Label$` patterns match
      // nothing. Playwright has no default action timeout, so a locator that
      // matches nothing waits until the test times out; every step here carries
      // an explicit one and a visibility assertion, so a menu that moves fails
      // in seconds and says where.
      await grid.selectRange("A3", "A6");
      await grid.openMenu("Data");
      const outlineItem = page
        .locator("button")
        .filter({ hasText: /^Outline/ })
        .first();
      await expect(outlineItem, "Data > Outline must be reachable").toBeVisible({ timeout: 5000 });
      await outlineItem.hover({ timeout: 5000 });
      await page.waitForTimeout(400);

      const groupItem = page
        .locator("button")
        .filter({ hasText: /^Group/ })
        .filter({ hasNotText: /Settings/ }) // "Group Settings..." is a sibling
        .first();
      await expect(groupItem, "Data > Outline > Group must be reachable").toBeVisible({
        timeout: 5000,
      });
      await groupItem.click({ timeout: 5000 });
      await page.waitForTimeout(1000);
      await waitForGridStable(page);

      expect(await outlineBarWidth(page), "Data > Group must raise the outline bar").toBeGreaterThan(
        0,
      );
      const after = await pixels(page, clip);
      expect(
        diffCount(before, after),
        "Data > Group must draw an outline bar",
      ).toBeGreaterThan(0);
    } finally {
      await newFile(page);
    }
  });

  /**
   * The RENDERED consequence of a hyperlink is the CURSOR, not the cell paint.
   *
   * Measured on the running app before this test was written: adding a
   * hyperlink to a cell changes zero pixels of that cell, and that is correct
   * by construction — the blue-and-underlined look is cell FORMATTING that the
   * Insert Hyperlink dialog applies separately, and the Hyperlinks extension
   * itself paints nothing at all. What it owns is an `indicatorSet` that feeds
   * a cell CURSOR interceptor (and the Open/Edit/Remove context-menu items),
   * and that set is exactly what went stale when nothing announced.
   *
   * So the honest live oracle is: hover the cell with a real mouse and read the
   * cursor the grid renders. `pointer` over the linked cell and `cell` over its
   * neighbour is a user-visible difference that only exists if the frontend
   * cache heard about a backend-only write.
   */
  test("3c. a hyperlink added through the IPC wrapper reaches the rendered cursor", async ({
    appPage: page,
  }) => {
    /** Move the real mouse to a cell centre and read the cursor the grid renders. */
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

      const result = await callModule<{ success: boolean }>(
        page,
        "/src/api/backend.ts",
        "addHyperlink",
        [
          {
            row: 2,
            col: 2,
            linkType: "url",
            target: "https://example.com/correctness",
            displayText: "Policy",
          },
        ],
      );
      expect(result.success, "add_hyperlink must have succeeded").toBe(true);
      // Deliberately NO grid:refresh and no extension-store refresh: the
      // announcement from the IPC wrapper is the only thing that may make this
      // work. Before it existed, this stayed "cell" until something unrelated
      // happened to refresh the cache.
      await page.waitForTimeout(900);

      expect(
        await cursorOver("C3"),
        "the linked cell must render a pointer cursor with nothing refreshed by hand",
      ).toBe("pointer");
      expect(
        await cursorOver("B3"),
        "and its unlinked neighbour must NOT — otherwise the assertion above would pass on a grid that pointer-cursors everything",
      ).toBe("cell");
    } finally {
      await newFile(page);
    }
  });

  test("3d. trace precedents through the tracingService seam draws arrows", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: 0, col: 0, value: "10" });
      await invoke(page, "update_cell", { row: 1, col: 0, value: "20" });
      await invoke(page, "update_cell", { row: 3, col: 0, value: "=A1+A2" });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("app:navigate-to-cell", { detail: { row: 12, col: 4, select: true } }),
        ),
      );
      await page.waitForTimeout(400);
      await waitForGridStable(page);

      const clip = await rangeClip(page, "A1", "B4", 2);
      const before = await pixels(page, clip);

      const traced = await page.evaluate(async () => {
        const svc = (await (window as unknown as { __calcImport: (u: string) => Promise<unknown> })
          .__calcImport(new URL("/src/api/tracingService.ts", document.baseURI).href)) as {
          requireTracingController: () => { tracePrecedents: (r: number, c: number) => Promise<{ arrowCount: number }> };
        };
        return svc.requireTracingController().tracePrecedents(3, 0);
      });
      expect(traced.arrowCount, "the seam must report arrows").toBeGreaterThan(0);
      await page.waitForTimeout(700);
      await waitForGridStable(page);

      const after = await pixels(page, clip);
      expect(
        diffCount(before, after),
        "trace arrows must actually be painted",
      ).toBeGreaterThan(0);

      await page.evaluate(async () => {
        const svc = (await (window as unknown as { __calcImport: (u: string) => Promise<unknown> })
          .__calcImport(new URL("/src/api/tracingService.ts", document.baseURI).href)) as {
          requireTracingController: () => { removeAllArrows: () => void };
        };
        svc.requireTracingController().removeAllArrows();
      });
      await page.waitForTimeout(500);
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // 4. THE DIRTY INDICATOR (§2f)
  // =========================================================================

  /**
   * The title as the USER sees it. `updateWindowTitle()` renders
   * "name * - Calcula" when the document is dirty.
   *
   * NOTHING is dispatched by this spec to provoke the update. That is the
   * whole point: the pre-fix behaviour was a correct FLAG with a stale
   * INDICATOR, and a test that hand-fires `app:dirty-state-changed` first
   * asserts the indicator's value, not its liveness.
   */
  async function titleShowsDirty(page: Page): Promise<boolean> {
    return page.evaluate(() => / \* - Calcula$/.test(document.title));
  }

  test("4. a backend-only mutation raises the dirty asterisk by itself, and saving clears it", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: 0, col: 0, value: "seed" });
      await invoke(page, "save_file", { path: SAVE_FILE });
      await page.waitForTimeout(700);

      expect(await invoke<boolean>(page, "is_file_modified"), "saved => flag clean").toBe(false);
      expect(await titleShowsDirty(page), "saved => no asterisk").toBe(false);

      // ---- CONTROL: a genuinely read-only action must not dirty anything.
      //      Without this the headline could pass on a document that was
      //      already dirty, or on an indicator stuck showing an asterisk. ----
      const readBack = await invoke<{ display?: string } | null>(page, "get_cell", {
        row: 0,
        col: 0,
      });
      expect(String(readBack?.display ?? "")).toBe("seed");
      await page.waitForTimeout(600);
      expect(await invoke<boolean>(page, "is_file_modified"), "read => flag still clean").toBe(
        false,
      );
      expect(await titleShowsDirty(page), "read => still no asterisk").toBe(false);

      // ---- THE HEADLINE: a mutation with NO frontend refresh path at all.
      //      Page setup is invisible to every grid event; before the fix the
      //      flag went true and the title stayed clean. ----
      const setup = await invoke<Record<string, unknown>>(page, "get_page_setup");
      setup.orientation = setup.orientation === "landscape" ? "portrait" : "landscape";
      await invoke(page, "set_page_setup", { setup });
      await page.waitForTimeout(800);

      expect(await invoke<boolean>(page, "is_file_modified"), "backend mutation => flag dirty").toBe(
        true,
      );
      expect(
        await titleShowsDirty(page),
        "backend mutation => the ASTERISK must appear with nothing dispatched by the test",
      ).toBe(true);

      // ---- And it clears again on save. ----
      await invoke(page, "save_file", { path: SAVE_FILE });
      await page.waitForTimeout(800);
      expect(await invoke<boolean>(page, "is_file_modified"), "saved again => flag clean").toBe(
        false,
      );
      expect(await titleShowsDirty(page), "saved again => asterisk gone").toBe(false);
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // 5. DECORATIONS UNDER THE SELECTION CHROME (§2d)
  // =========================================================================

  /**
   * The defect's own measurement, reproduced live.
   *
   * "Indicator pixels" is the count of pixels that differ between the frame
   * WITH the note and the identical frame WITHOUT it. Measured twice: once
   * with the selection parked elsewhere, once with the cell itself selected.
   * Both captures in a pair share the same selection state, so the selection
   * border cancels out of the difference and what remains is the indicator.
   *
   * The defect report measured 15 and 0 on its clip; this one clips the whole
   * cell and measures ~65 either way. A/B-verified rather than assumed: flipping
   * Review's decoration anchor back to `"under-selection"` and re-running gives
   * 65 unselected against 10 selected, and this test goes red.
   */
  test("5. a note indicator survives being selected", async ({ appPage: page }) => {
    const NOTE_ROW = 4;
    const NOTE_COL = 2; // C5
    const park = async (): Promise<void> => {
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("app:navigate-to-cell", { detail: { row: 14, col: 0, select: true } }),
        ),
      );
      await page.waitForTimeout(400);
    };
    const selectNoteCell = async (): Promise<void> => {
      await page.evaluate(
        ({ row, col }) =>
          window.dispatchEvent(
            new CustomEvent("app:navigate-to-cell", { detail: { row, col, select: true } }),
          ),
        { row: NOTE_ROW, col: NOTE_COL },
      );
      await page.waitForTimeout(400);
    };
    const addNote = async (): Promise<void> => {
      const res = await callModule<{ success: boolean }>(
        page,
        "/src/core/lib/tauri-api.ts",
        "addNote",
        [{ row: NOTE_ROW, col: NOTE_COL, authorName: "E2E", content: "correctness cluster" }],
      );
      expect(res.success, "add_note must have succeeded").toBe(true);
      await page.waitForTimeout(800);
      await waitForGridStable(page);
    };
    const removeNotes = async (): Promise<void> => {
      const notes = await invoke<Array<{ id: string }>>(page, "get_all_notes");
      for (const n of notes) {
        await callModule(page, "/src/core/lib/tauri-api.ts", "deleteNote", [n.id]);
      }
      await page.waitForTimeout(800);
      await waitForGridStable(page);
    };

    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: NOTE_ROW, col: NOTE_COL, value: "5" });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await waitForGridStable(page);

      const clip = await rangeClip(page, "C5", "C5");

      // --- Pair 1: selection parked elsewhere (the case that always worked). ---
      await park();
      const bareUnselected = await pixels(page, clip);
      await addNote();
      await park();
      const notedUnselected = await pixels(page, clip);
      const unselectedIndicatorPx = diffCount(bareUnselected, notedUnselected);
      expect(
        unselectedIndicatorPx,
        "with the selection elsewhere the note indicator must be visible at all",
      ).toBeGreaterThan(0);

      // --- Pair 2: the note cell is the ACTIVE cell (the defect). ---
      await selectNoteCell();
      const notedSelected = await pixels(page, clip);
      await removeNotes();
      await selectNoteCell();
      const bareSelected = await pixels(page, clip);
      const selectedIndicatorPx = diffCount(notedSelected, bareSelected);

      expect(
        selectedIndicatorPx,
        `the indicator must survive the active-cell chrome — it measured 0 px selected against ` +
          `${unselectedIndicatorPx} px unselected before the z-anchor fix`,
      ).toBeGreaterThan(0);
      expect(
        selectedIndicatorPx,
        `selected (${selectedIndicatorPx} px) must be within a hair of unselected ` +
          `(${unselectedIndicatorPx} px) — a partially-covered triangle is still the bug`,
      ).toBeGreaterThanOrEqual(Math.floor(unselectedIndicatorPx * 0.8));
    } finally {
      await invoke(page, "get_all_notes")
        .then(async (notes) => {
          for (const n of notes as Array<{ id: string }>) {
            await invoke(page, "delete_note", { noteId: n.id }).catch(() => undefined);
          }
        })
        .catch(() => undefined);
      await newFile(page);
    }
  });
});
