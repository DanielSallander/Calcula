/**
 * MACRO RECORDER — the whole user journey, against the real application.
 *
 * WHY THIS FILE EXISTS. This feature has now been reported broken twice by a
 * human ("I click Run and nothing happens"; "nothing happens when I click the
 * button I created"), and both times a full green unit suite had already
 * declared it working. Unit tests can only prove that the pieces agree with the
 * shapes the tests imagined for them; they cannot prove that pressing Run in the
 * real app puts values back into real cells. That is the only claim this feature
 * makes, so that is what this spec asserts — through the menus, the dialogs, the
 * canvas and the backend, with nothing stubbed.
 *
 * THE JOURNEY, exactly as the user performed it:
 *   1. Developer > Record Macro..., name it, target the object-script runtime.
 *   2. Edit three cells, one of them a formula.
 *   3. Stop from the status-bar indicator.
 *   4. The recording was AUTO-SAVED and is findable in Developer > Macros...
 *   5. Clear the cells, press Run -> THE VALUES COME BACK.
 *   6. Add Button, clear the cells, CLICK THE BUTTON -> the values come back.
 *   7. Design Mode on -> the same click selects instead of running, and says so.
 *      Design Mode off -> it runs again.
 *
 * Step 5 and step 6 are the assertions that matter. Everything weaker (a dialog
 * opened, a module was listed, a toast appeared) merely restates the bug.
 *
 * LOCALE. The recorded formula is `=B12+B13` — no argument separator — so the
 * spec is identical on a machine whose list separator is ';' (sv-SE) and one
 * where it is ','.
 *
 * SHARED APP. Every functional spec drives ONE app instance, so this one owns a
 * private patch of the grid (B12:B14 for data, D12 for the button) and cleans up
 * after itself both before and after, in a finally.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

// ---------------------------------------------------------------------------
// The patch of grid this spec owns
// ---------------------------------------------------------------------------

const SHEET = 0;

/** The three cells the macro writes. Row/col are 0-based (backend coordinates). */
const CELLS = {
  a: { ref: "B12", row: 11, col: 1, typed: "111", expect: "111" },
  b: { ref: "B13", row: 12, col: 1, typed: "222", expect: "222" },
  sum: { ref: "B14", row: 13, col: 1, typed: "=B12+B13", expect: "333" },
} as const;

/** Where the generated button is placed. */
const BUTTON = { ref: "D12", row: 11, col: 3 } as const;

/** The control id the Controls extension assigns to a button at that anchor. */
const BUTTON_INSTANCE_ID = `control-${SHEET}-${BUTTON.row}-${BUTTON.col}`;
/** The object-script id saveAsButtonScript derives from it. */
const BUTTON_SCRIPT_ID = `macro-${BUTTON_INSTANCE_ID}`;

/** Prefix every macro this spec creates carries, so cleanup can find strays. */
const MACRO_PREFIX = "E2EJourney";

// ---------------------------------------------------------------------------
// Backend readers/writers (setup + assertions, never the thing under test)
// ---------------------------------------------------------------------------

interface Triple {
  a: string;
  b: string;
  sum: string;
}

/** Read the three cells straight from the engine. */
async function readTriple(page: Page): Promise<Triple> {
  return page.evaluate(async (cells) => {
    const tauri = (window as any).__TAURI__;
    const read = async (row: number, col: number): Promise<string> => {
      const cell = await tauri.core.invoke("get_cell", { row, col });
      return String(cell?.display ?? cell?.value ?? "");
    };
    return {
      a: await read(cells.a.row, cells.a.col),
      b: await read(cells.b.row, cells.b.col),
      sum: await read(cells.sum.row, cells.sum.col),
    };
  }, CELLS);
}

/** Empty the three cells (the "clear it and see if the macro brings it back" step). */
async function clearTriple(page: Page): Promise<void> {
  await page.evaluate(async (cells) => {
    const tauri = (window as any).__TAURI__;
    for (const c of [cells.a, cells.b, cells.sum]) {
      await tauri.core.invoke("update_cell", { row: c.row, col: c.col, value: "" });
    }
    window.dispatchEvent(new Event("grid:refresh"));
  }, CELLS);
  await page.waitForTimeout(150);
}

/** Scripts must be allowed to run, or every mount below is refused. */
async function allowScripts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    await tauri.core.invoke("set_script_security_level", { level: "enabled" });
  });
}

/** Read the app-global Design Mode flag from the module the app itself uses. */
async function readDesignMode(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const mod: any = await (window as any).__calcImport(
      new URL("/src/api/designMode.ts", document.baseURI).href,
    );
    return mod.getDesignMode() === true;
  });
}

/**
 * Remove everything this spec creates: the button control, its object script,
 * and any module whose name carries our prefix.
 *
 * Idempotent and failure-tolerant — it runs BEFORE the journey (so a crashed
 * previous run cannot poison this one) and again in a finally.
 */
/**
 * End a recording session left running by a FAILED earlier run of this spec.
 *
 * THE RECORDER IS A SINGLETON WITH A TOGGLED MENU ITEM: one Developer-menu entry
 * whose label is "Record Macro" when idle and "Stop Recording" while armed. So a
 * session that outlives its test does not merely leave junk behind — it RENAMES
 * the entry point this spec starts from, and every later run then fails at
 * `/^Record Macro/` with a timeout that looks like a missing menu item.
 *
 * That is not hypothetical: one genuine failure here left a session armed and
 * the next three runs failed for that reason alone, reporting nothing about the
 * original cause. macro-live-edit.spec.ts has carried this guard since it hit
 * the same wall; this spec needed it too.
 *
 * Stopping through the on-screen indicator — the control a user presses — so it
 * cannot drift from the real stop path.
 */
async function ensureNotRecording(page: Page): Promise<void> {
  const indicator = page.locator("[data-macro-recorder-indicator]");
  if ((await indicator.count()) === 0) return;
  if (!(await indicator.first().isVisible().catch(() => false))) return;

  await indicator
    .locator("button")
    .filter({ hasText: /^Stop$/ })
    .first()
    .click()
    .catch(() => {});

  // Stopping opens the review dialog; the recording it describes is abandoned
  // state, and cleanupArtifacts deletes whatever module it wrote on the way out.
  const result = page.locator("[data-macro-result-dialog]");
  await result.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await result
    .locator("[data-macro-result-close]")
    .first()
    .click()
    .catch(() => {});
  await result.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  // Leave the menu closed so the next openMenu() is not a toggle that shuts it.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(150);
}

async function cleanupArtifacts(page: Page): Promise<void> {
  // FIRST: a live recording renames the menu item this spec starts from.
  await ensureNotRecording(page);
  await page.evaluate(
    async (a) => {
      const tauri = (window as any).__TAURI__;

      // 1. The object script bound to the button.
      await tauri.core.invoke("delete_object_script", { id: a.scriptId }).catch(() => {});
      try {
        const api: any = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        if (api.ObjectScriptManager.isScriptMounted(a.scriptId)) {
          api.ObjectScriptManager.unmountScript(a.scriptId);
        }
        api.ObjectScriptManager.removeScript(a.scriptId);
      } catch {
        /* never registered in this session */
      }

      // 2. The button control itself, through the same seam that created it, so
      //    the floating store and the backend metadata come off together.
      try {
        const svc: any = await (window as any).__calcImport(
          new URL("/src/api/buttonControlService.ts", document.baseURI).href,
        );
        if (svc.hasButtonControlProvider()) {
          await svc.requireButtonControlProvider().removeButton({
            sheetIndex: a.sheet,
            row: a.row,
            col: a.col,
          });
        }
      } catch {
        /* Controls not loaded, or no control there */
      }
      await tauri.core
        .invoke("remove_control_metadata", { sheetIndex: a.sheet, row: a.row, col: a.col })
        .catch(() => {});

      // 3. Any module this spec (or a crashed earlier run of it) left behind.
      try {
        const modules: Array<{ id: string; name: string }> =
          await tauri.core.invoke("list_scripts");
        for (const m of modules) {
          if (m.name && m.name.startsWith(a.prefix)) {
            await tauri.core.invoke("delete_script", { id: m.id }).catch(() => {});
          }
        }
      } catch {
        /* no module store yet */
      }
    },
    {
      scriptId: BUTTON_SCRIPT_ID,
      sheet: SHEET,
      row: BUTTON.row,
      col: BUTTON.col,
      prefix: MACRO_PREFIX,
    },
  );
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
// Canvas geometry for the generated button
// ---------------------------------------------------------------------------

/**
 * The point on the canvas that lands inside the floating button anchored at
 * (row, col).
 *
 * Mirrors createButtonControlAt (Controls) for the control's sheet-space rect
 * and getFloatingCanvasBounds (Core) for the canvas mapping, reading the LIVE
 * grid state rather than assuming defaults — so a spec run after another spec
 * changed a column width or the zoom still clicks the button and not a cell.
 */
async function buttonCanvasPoint(
  page: Page,
  row: number,
  col: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    (a) => {
      const gs = (window as any).__CALCULA_GRID_STATE__;
      if (!gs) throw new Error("__CALCULA_GRID_STATE__ is not exposed — is the app running?");
      const cfg = gs.config ?? {};
      const defaultW = cfg.defaultCellWidth ?? 100;
      const defaultH = cfg.defaultCellHeight ?? 24;
      const widths: Map<number, number> = gs.dimensions?.columnWidths ?? new Map();
      const heights: Map<number, number> = gs.dimensions?.rowHeights ?? new Map();
      const widthOf = (c: number): number => widths.get(c) ?? defaultW;
      const heightOf = (r: number): number => heights.get(r) ?? defaultH;

      let x = 0;
      for (let c = 0; c < a.col; c++) x += widthOf(c);
      let y = 0;
      for (let r = 0; r < a.row; r++) y += heightOf(r);

      const w = Math.max(widthOf(a.col), 80);
      const h = Math.max(heightOf(a.row), 28);
      const rhw = cfg.rowHeaderWidth ?? 50;
      const chh = cfg.colHeaderHeight ?? 24;
      const zoom = gs.zoom || 1;

      // The mouse handler divides by zoom, so the CSS-pixel offset the click
      // needs is the grid-space centre multiplied by it.
      return {
        x: (rhw + x - (gs.viewport?.scrollX ?? 0) + w / 2) * zoom,
        y: (chh + y - (gs.viewport?.scrollY ?? 0) + h / 2) * zoom,
      };
    },
    { row, col },
  );
}

/**
 * Start counting `grid:refresh` events, and return a reader for the count.
 *
 * A script write that never asks the canvas to re-fetch is exactly what "I
 * clicked the button and nothing happened" looked like from the user's chair:
 * the engine had the new values, the pixels did not. Counting the event is how
 * this spec asserts the difference without reading pixels.
 */
async function watchGridRefresh(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__e2eGridRefreshHandler) {
      window.removeEventListener("grid:refresh", w.__e2eGridRefreshHandler);
    }
    w.__e2eGridRefreshCount = 0;
    w.__e2eGridRefreshHandler = () => {
      w.__e2eGridRefreshCount += 1;
    };
    window.addEventListener("grid:refresh", w.__e2eGridRefreshHandler);
  });
  return async () =>
    page.evaluate(() => (window as any).__e2eGridRefreshCount as number);
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

test.describe("Macro Recorder — record, Run, and click the button", () => {
  test("a recorded macro replays from Developer > Macros... AND from its button", async ({
    appPage: page,
    grid,
  }) => {
    // Menus, dialogs, three keyboard cell edits, two worker-realm mounts and a
    // canvas click. Far beyond the 30s default.
    test.setTimeout(300_000);

    const macroName = `${MACRO_PREFIX} ${Date.now().toString(36)}`;
    const canvas = grid.canvas;

    await allowScripts(page);
    await cleanupArtifacts(page);
    await clearTriple(page);

    // Design Mode is app-global and survives between specs; a leftover ON would
    // make every button click below select instead of run.
    if (await readDesignMode(page)) {
      await grid.menuAction("Developer", "Design Mode");
    }
    expect(await readDesignMode(page)).toBe(false);

    try {
      // ---------------------------------------------------------------
      await test.step("1. Developer > Record Macro... starts a session", async () => {
        await grid.openMenu("Developer");
        const item = page.locator("button").filter({ hasText: /^Record Macro/ }).first();
        await item.waitFor({ state: "visible", timeout: 5_000 });
        await item.click();

        const dialog = page.locator("[data-macro-start-dialog]");
        await expect(dialog).toBeVisible({ timeout: 5_000 });

        await dialog.locator("[data-macro-name-input]").fill(macroName);
        // The runtime the user actually chose in the bug report.
        await dialog.locator('[data-macro-target="objectScript"]').check();
        await dialog.locator("[data-macro-start-button]").click();

        await expect(page.locator("[data-macro-recorder-indicator]")).toBeVisible({
          timeout: 5_000,
        });
      });

      // ---------------------------------------------------------------
      await test.step("2. three cell edits (one a formula) are captured", async () => {
        await grid.setCellValue(CELLS.a.ref, CELLS.a.typed);
        await grid.setCellValue(CELLS.b.ref, CELLS.b.typed);
        await grid.setCellValue(CELLS.sum.ref, CELLS.sum.typed);

        // The engine took them (and the formula recalculated).
        const typed = await readTriple(page);
        expect(typed.a).toContain(CELLS.a.expect);
        expect(typed.b).toContain(CELLS.b.expect);
        expect(typed.sum).toContain(CELLS.sum.expect);

        // The recorder saw all three.
        const indicator = page.locator("[data-macro-recorder-indicator]");
        await expect(indicator).toContainText(/\d+ actions/);
        const text = (await indicator.innerText()).replace(/\s+/g, " ");
        const count = Number(/(\d+) action/.exec(text)?.[1] ?? "0");
        expect(count).toBeGreaterThanOrEqual(3);
      });

      // ---------------------------------------------------------------
      await test.step("3. Stop auto-saves the recording as a workbook module", async () => {
        await page
          .locator("[data-macro-recorder-indicator] button")
          .filter({ hasText: /^Stop$/ })
          .click();

        const result = page.locator("[data-macro-result-dialog]");
        await expect(result).toBeVisible({ timeout: 15_000 });

        // Saved, not "would you like to save?" — and NOT the failure banner.
        await expect(result.locator("[data-macro-save-error]")).toHaveCount(0);
        const banner = result.locator("[data-macro-saved-banner]");
        await expect(banner).toBeVisible();
        await expect(banner).toContainText(macroName);

        await result.locator("[data-macro-result-close]").click();
        await expect(result).toBeHidden({ timeout: 5_000 });
      });

      // ---------------------------------------------------------------
      const library = page.locator("[data-macro-library-dialog]");

      await test.step("4. the macro is findable in Developer > Macros...", async () => {
        await grid.openMenu("Developer");
        const item = page.locator("button").filter({ hasText: /^Macros/ }).first();
        await item.waitFor({ state: "visible", timeout: 5_000 });
        await item.click();

        await expect(library).toBeVisible({ timeout: 10_000 });

        const row = library.locator("[data-macro-library-item]").filter({
          hasText: macroName,
        });
        await expect(row).toHaveCount(1);
        // The library knows which runtime it is holding.
        await expect(row).toContainText("Object script");
        await row.click();

        // ...and says so on screen, next to Run, BEFORE it is pressed.
        const route = library.locator("[data-macro-run-route]");
        await expect(route).toHaveAttribute("data-macro-run-route", "objectScript");

        const runBtn = library.locator("[data-macro-run-button]");
        await expect(runBtn).toBeEnabled();
        await expect(runBtn).toHaveText(/Run \(object script\)/);
      });

      // ---------------------------------------------------------------
      await test.step("5. Run puts the cleared values BACK (the reported bug)", async () => {
        await clearTriple(page);
        const cleared = await readTriple(page);
        expect(cleared).toEqual({ a: "", b: "", sum: "" });

        const refreshes = await watchGridRefresh(page);
        await library.locator("[data-macro-run-button]").click();

        await expect
          .poll(async () => (await readTriple(page)).sum, { timeout: 45_000 })
          .toContain(CELLS.sum.expect);

        const after = await readTriple(page);
        expect(after.a).toContain(CELLS.a.expect);
        expect(after.b).toContain(CELLS.b.expect);

        // The dialog reported success, not a failure it swallowed.
        await expect(library.locator("[data-macro-error]")).toHaveCount(0);
        await expect(library.locator("[data-macro-output]")).toContainText("[OK]");
        // And the canvas was told to re-fetch, so the user SEES it.
        expect(await refreshes()).toBeGreaterThan(0);
      });

      // ---------------------------------------------------------------
      await test.step("6. Add Button creates a button that LINKS the macro (no copy)", async () => {
        await library.locator("[data-macro-anchor-input]").fill(BUTTON.ref);
        await library.locator("[data-macro-add-button]").click();

        // A failure is reported in-dialog; there must not be one.
        const toast = page
          .locator("[data-toast]")
          .filter({ hasText: new RegExp(`Button created at ${BUTTON.ref}`) });
        await expect(toast).toBeVisible({ timeout: 20_000 });
        await expect(toast).not.toContainText("is NOT running");

        // THE LINK MODEL (the user's decision): the button carries only a
        // `macroRef` control property = the macro's module id. There is NO
        // per-button object script and NO copied body — the click path resolves
        // and runs the CURRENT macro by id. So assert the control holds a
        // macroRef pointing at a real macro, and that NO object script was bound
        // to the control's instance id (the old copy-model artifact is gone).
        const link = await page.evaluate(
          async (a) => {
            const tauri = (window as any).__TAURI__;
            const meta = await tauri.core.invoke("get_control_metadata", {
              sheetIndex: a.sheet,
              row: a.row,
              col: a.col,
            });
            const macroRef: string | undefined = meta?.properties?.macroRef?.value;
            const scripts: Array<{ id: string; name: string }> =
              await tauri.core.invoke("list_scripts");
            const target = macroRef ? scripts.find((s) => s.id === macroRef) : undefined;

            const api: any = await (window as any).__calcImport(
              new URL("/src/api/index.ts", document.baseURI).href,
            );
            const copyScript = api.ObjectScriptManager.getScript("button", a.instanceId);
            return {
              macroRef: macroRef ?? null,
              targetName: target?.name ?? null,
              hasObjectScriptCopy: !!copyScript,
            };
          },
          { sheet: SHEET, row: BUTTON.row, col: BUTTON.col, instanceId: BUTTON_INSTANCE_ID },
        );
        expect(link.macroRef).not.toBeNull();
        expect(link.targetName).toBe(macroName); // links the macro we recorded
        expect(link.hasObjectScriptCopy).toBe(false); // link, not copy

        // Close the library so its backdrop stops covering the grid.
        await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
        await expect(library).toBeHidden({ timeout: 5_000 });
      });

      // ---------------------------------------------------------------
      const clickPoint = await buttonCanvasPoint(page, BUTTON.row, BUTTON.col);

      await test.step("7. CLICKING THE BUTTON replays the macro (the second reported bug)", async () => {
        await clearTriple(page);
        expect(await readTriple(page)).toEqual({ a: "", b: "", sum: "" });

        const refreshes = await watchGridRefresh(page);
        await canvas.click({ position: clickPoint, force: true });

        await expect
          .poll(async () => (await readTriple(page)).sum, { timeout: 45_000 })
          .toContain(CELLS.sum.expect);

        const after = await readTriple(page);
        expect(after.a).toContain(CELLS.a.expect);
        expect(after.b).toContain(CELLS.b.expect);

        // The write path asked the canvas to re-fetch. Nothing else on this
        // path does, so this is the assertion that the user can see the result.
        expect(await refreshes()).toBeGreaterThan(0);

        // ...and the click diagnosis stayed QUIET. It exists to explain a click
        // that went nowhere; on a click that worked it must say nothing. It used
        // to fire every time, because it asked the host for "button.onClick"
        // while forwarders are keyed "onClick" — so a working macro button
        // accused itself of having no handler on every single click.
        await expect(
          page.locator("[data-toast]").filter({ hasText: /never registered a click/ }),
        ).toHaveCount(0);
        await expect(
          page.locator("[data-toast]").filter({ hasText: /no action bound|is NOT running/ }),
        ).toHaveCount(0);
      });

      // ---------------------------------------------------------------
      await test.step("8. Design Mode ON: the click SELECTS and says so, it does not run", async () => {
        await clearTriple(page);
        await grid.menuAction("Developer", "Design Mode");
        expect(await readDesignMode(page)).toBe(true);

        await canvas.click({ position: clickPoint, force: true });
        // Long enough that a run, had one started, would have landed.
        await page.waitForTimeout(2_500);

        expect(await readTriple(page)).toEqual({ a: "", b: "", sum: "" });
        await expect(
          page.locator("[data-toast]").filter({ hasText: /Design Mode is on/ }),
        ).toBeVisible({ timeout: 5_000 });
      });

      // ---------------------------------------------------------------
      await test.step("9. Design Mode OFF: the same click runs it again", async () => {
        await grid.menuAction("Developer", "Design Mode");
        expect(await readDesignMode(page)).toBe(false);

        // Selecting the control in step 8 opened the Properties pane, which
        // takes width from the grid; re-derive the point from live state.
        await page.evaluate(() => {
          try {
            const store = (window as any).__CALCULA_TASKPANE_STORE__;
            if (store) store.getState().reset();
          } catch {
            /* no task pane store */
          }
        });
        await page.waitForTimeout(400);
        const point = await buttonCanvasPoint(page, BUTTON.row, BUTTON.col);

        await canvas.click({ position: point, force: true });

        await expect
          .poll(async () => (await readTriple(page)).sum, { timeout: 45_000 })
          .toContain(CELLS.sum.expect);
      });
    } finally {
      // Leave the shared app exactly as it was found.
      if (await readDesignMode(page).catch(() => false)) {
        await grid.menuAction("Developer", "Design Mode").catch(() => {});
      }
      await cleanupArtifacts(page).catch(() => {});
      await clearTriple(page).catch(() => {});
    }
  });
});
