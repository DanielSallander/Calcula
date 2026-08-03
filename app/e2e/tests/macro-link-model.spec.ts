/**
 * MACRO LINK MODEL — the VBA model, proved against the real application.
 *
 * WHY THIS FILE EXISTS. The macro recorder was rebuilt so a macro lives ONCE (a
 * module in the workbook script store) and a button LINKS it by id — it does not
 * carry a copy of the body. Two human bug reports and three "green unit suite,
 * still broken" cycles are the reason this spec drives the REAL app, through the
 * menus, dialogs, the canvas, the separate Object Script Editor window and the
 * backend, with nothing stubbed. Unit tests proved the pieces agree with each
 * other; only this proves that clicking an EDITED macro's button writes the new
 * value into a real cell.
 *
 * THE FOUR DECISIVE JOURNEYS (one test each, self-contained, cleaned up):
 *   1. LINK PROOF — record a macro, add a button, EDIT the macro, click the
 *      button, and see the NEW value. A stale copy would still write the old one.
 *   2. RUN-AT-CURSOR — open a macro in the Object Script Editor, press Run, and
 *      see cells change, instead of idling at "Waiting for a trigger".
 *   3. NAVIGATION — double-click a macro in Developer > Macros... opens the
 *      Object Script Editor on that macro.
 *   4. ORPHAN — deleting a macro a button links WARNS by name; clicking the
 *      orphaned button then says so out loud, never a silent no-op.
 *
 * SHARED APP. One app instance drives every functional spec, so this one owns a
 * private patch of the grid (rows 16/18/20 in columns B and D) and cleans up
 * both before and after each test, in a finally.
 *
 * LOCALE. Every recorded/seeded value is an integer with no separators, so the
 * spec is identical whether the machine's list separator is ';' (sv-SE) or ','.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const SHEET = 0;

/** Every macro name this spec creates carries this, so cleanup can sweep strays. */
const NAME_PREFIX = "E2ELinkModel";

// ---------------------------------------------------------------------------
// Backend readers/writers — setup + assertions, never the thing under test.
// ---------------------------------------------------------------------------

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

async function clearCell(page: Page, row: number, col: number): Promise<void> {
  await page.evaluate(
    async ({ row, col }) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("update_cell", { row, col, value: "" });
      window.dispatchEvent(new Event("grid:refresh"));
    },
    { row, col },
  );
  await page.waitForTimeout(120);
}

/** Scripts must be allowed to run, or every mount below is refused. */
async function allowScripts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    await tauri.core.invoke("set_script_security_level", { level: "enabled" });
  });
}

async function readDesignMode(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const mod: any = await (window as any).__calcImport(
      new URL("/src/api/designMode.ts", document.baseURI).href,
    );
    return mod.getDesignMode() === true;
  });
}

/**
 * Seed a macro module straight into the workbook script store, marked for the
 * OBJECT-SCRIPT runtime (`api.*`). Recording itself is proved by journey 1 and
 * the sibling macro-recorder-journey spec; the run/navigate/orphan journeys only
 * need a macro to exist, so they seed one and stay fast and deterministic.
 *
 * The source writes ONE distinctive cell through a single named function, which
 * is exactly the shape run-at-cursor falls back to (the sole non-`setup`
 * function) and a button click runs.
 */
async function seedObjectScriptMacro(
  page: Page,
  opts: { id: string; name: string; fnName: string; row: number; col: number; value: string },
): Promise<void> {
  const source =
    `// Macro: ${opts.name}\n` +
    `async function ${opts.fnName}(api) {\n` +
    `  await api.setCellValue(${opts.row}, ${opts.col}, "${opts.value}");\n` +
    `}\n\n` +
    `function setup(context) {\n` +
    `  if (!context.api) { context.notify("needs an unlocked script", "error"); return; }\n` +
    `  if (typeof context.onClick === "function") {\n` +
    `    context.onClick(async () => { await ${opts.fnName}(context.api); });\n` +
    `    return;\n` +
    `  }\n` +
    `  return ${opts.fnName}(context.api);\n` +
    `}\n`;
  const description = `Recorded macro · runtime=objectScript · 1 action · recorded ${new Date().toISOString()}`;
  await page.evaluate(
    async ({ id, name, description, source }) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("save_script", {
        script: { id, name, description, source, scope: { type: "workbook" } },
      });
    },
    { id: opts.id, name: opts.name, description, source },
  );
}

/** Find a stored macro id by exact name. */
async function macroIdByName(page: Page, name: string): Promise<string | null> {
  return page.evaluate(async (name) => {
    const tauri = (window as any).__TAURI__;
    const scripts: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
    return scripts.find((s) => s.name === name)?.id ?? null;
  }, name);
}

/**
 * Remove everything a test can leave behind: every module whose name carries the
 * spec prefix, and the button controls at the anchors the spec uses. Idempotent
 * and failure-tolerant — runs before AND after each test.
 */
async function cleanup(page: Page, buttonAnchors: Array<{ row: number; col: number }>): Promise<void> {
  await page.evaluate(
    async ({ prefix, sheet, anchors }) => {
      const tauri = (window as any).__TAURI__;
      // 1. Buttons this spec placed, through the same seam that created them.
      try {
        const svc: any = await (window as any).__calcImport(
          new URL("/src/api/buttonControlService.ts", document.baseURI).href,
        );
        if (svc.hasButtonControlProvider()) {
          for (const a of anchors) {
            await svc
              .requireButtonControlProvider()
              .removeButton({ sheetIndex: sheet, row: a.row, col: a.col })
              .catch(() => {});
          }
        }
      } catch {
        /* Controls not loaded */
      }
      for (const a of anchors) {
        await tauri.core
          .invoke("remove_control_metadata", { sheetIndex: sheet, row: a.row, col: a.col })
          .catch(() => {});
      }
      // 2. Every module this spec (or a crashed earlier run) left behind.
      try {
        const modules: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
        for (const m of modules) {
          if (m.name && m.name.startsWith(prefix)) {
            await tauri.core.invoke("delete_script", { id: m.id }).catch(() => {});
          }
        }
      } catch {
        /* no module store */
      }
    },
    { prefix: NAME_PREFIX, sheet: SHEET, anchors: buttonAnchors },
  );
  await page.waitForTimeout(150);
}

/**
 * The CSS-pixel point on the canvas that lands inside a floating button anchored
 * at (row, col). Mirrors createButtonControlAt for the control rect and
 * getFloatingCanvasBounds for the mapping, reading LIVE grid state so a prior
 * column-width or zoom change still hits the button and not a cell.
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
      return {
        x: (rhw + x - (gs.viewport?.scrollX ?? 0) + w / 2) * zoom,
        y: (chh + y - (gs.viewport?.scrollY ?? 0) + h / 2) * zoom,
      };
    },
    { row, col },
  );
}

/** Turn Design Mode off if a previous spec left it on (a click would select,
 *  not run). */
async function ensureDesignModeOff(page: Page, grid: any): Promise<void> {
  if (await readDesignMode(page)) {
    await grid.menuAction("Developer", "Design Mode");
  }
  expect(await readDesignMode(page)).toBe(false);
}

/** Open Developer > Macros... and return the library dialog locator. */
async function openMacroLibrary(page: Page, grid: any) {
  await grid.openMenu("Developer");
  const item = page.locator("button").filter({ hasText: /^Macros/ }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click();
  const library = page.locator("[data-macro-library-dialog]");
  await expect(library).toBeVisible({ timeout: 10_000 });
  return library;
}

// ===========================================================================
// JOURNEY 1 — THE LINK PROOF (record, add button, EDIT macro, click, NEW value)
// ===========================================================================

test.describe("Macro link model", () => {
  test("1. a button runs the CURRENT macro after it is edited (link, not copy)", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);

    const macroName = `${NAME_PREFIX} link ${Date.now().toString(36)}`;
    const DATA = { ref: "B16", row: 15, col: 1 };
    const BUTTON = { ref: "D16", row: 15, col: 3 };
    const ORIGINAL = "17171";
    const EDITED = "28282";
    const anchors = [{ row: BUTTON.row, col: BUTTON.col }];

    await allowScripts(page);
    await cleanup(page, anchors);
    await clearCell(page, DATA.row, DATA.col);
    await ensureDesignModeOff(page, grid);

    try {
      // -- record a one-cell macro against the object-script runtime ----------
      await test.step("record a macro that writes the ORIGINAL value", async () => {
        await grid.openMenu("Developer");
        const rec = page.locator("button").filter({ hasText: /^Record Macro/ }).first();
        await rec.waitFor({ state: "visible", timeout: 5_000 });
        await rec.click();

        const dialog = page.locator("[data-macro-start-dialog]");
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        await dialog.locator("[data-macro-name-input]").fill(macroName);
        await dialog.locator('[data-macro-target="objectScript"]').check();
        await dialog.locator("[data-macro-start-button]").click();
        await expect(page.locator("[data-macro-recorder-indicator]")).toBeVisible({ timeout: 5_000 });

        await grid.setCellValue(DATA.ref, ORIGINAL);
        expect(await readCell(page, DATA.row, DATA.col)).toContain(ORIGINAL);

        await page
          .locator("[data-macro-recorder-indicator] button")
          .filter({ hasText: /^Stop$/ })
          .click();
        const result = page.locator("[data-macro-result-dialog]");
        await expect(result).toBeVisible({ timeout: 15_000 });
        await expect(result.locator("[data-macro-save-error]")).toHaveCount(0);
        await expect(result.locator("[data-macro-saved-banner]")).toContainText(macroName);
        await result.locator("[data-macro-result-close]").click();
        await expect(result).toBeHidden({ timeout: 5_000 });
      });

      // -- add a button that LINKS the macro ---------------------------------
      await test.step("add a button linking the macro", async () => {
        const library = await openMacroLibrary(page, grid);
        const row = library.locator("[data-macro-library-item]").filter({ hasText: macroName });
        await expect(row).toHaveCount(1);
        await row.click();
        await library.locator("[data-macro-anchor-input]").fill(BUTTON.ref);
        await library.locator("[data-macro-add-button]").click();
        await expect(
          page.locator("[data-toast]").filter({ hasText: new RegExp(`Button created at ${BUTTON.ref}`) }),
        ).toBeVisible({ timeout: 20_000 });
        await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
        await expect(library).toBeHidden({ timeout: 5_000 });
      });

      const clickPoint = await buttonCanvasPoint(page, BUTTON.row, BUTTON.col);

      // -- baseline: the button runs the macro at all ------------------------
      await test.step("clicking the button runs the ORIGINAL macro", async () => {
        await clearCell(page, DATA.row, DATA.col);
        expect(await readCell(page, DATA.row, DATA.col)).toBe("");
        await grid.canvas.click({ position: clickPoint, force: true });
        await expect
          .poll(async () => readCell(page, DATA.row, DATA.col), { timeout: 45_000 })
          .toContain(ORIGINAL);
      });

      // -- EDIT the one canonical macro, in place ----------------------------
      await test.step("edit the macro's written value in Developer > Macros...", async () => {
        const library = await openMacroLibrary(page, grid);
        const row = library.locator("[data-macro-library-item]").filter({ hasText: macroName });
        await row.click();
        const textarea = library.locator("textarea");
        await expect(textarea).toBeVisible({ timeout: 5_000 });
        const before = await textarea.inputValue();
        expect(before).toContain(ORIGINAL);
        const after = before.replace(ORIGINAL, EDITED);
        expect(after).toContain(EDITED);
        expect(after).not.toContain(ORIGINAL);
        await textarea.fill(after);
        await library.locator("button").filter({ hasText: /^Save$/ }).first().click();
        await expect(
          page.locator("[data-toast]").filter({ hasText: /Saved/ }),
        ).toBeVisible({ timeout: 10_000 });
        await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
        await expect(library).toBeHidden({ timeout: 5_000 });
      });

      // -- THE PROOF: the SAME button now writes the EDITED value ------------
      await test.step("clicking the SAME button now writes the EDITED value", async () => {
        await clearCell(page, DATA.row, DATA.col);
        expect(await readCell(page, DATA.row, DATA.col)).toBe("");
        const point = await buttonCanvasPoint(page, BUTTON.row, BUTTON.col);
        await grid.canvas.click({ position: point, force: true });
        await expect
          .poll(async () => readCell(page, DATA.row, DATA.col), { timeout: 45_000 })
          .toContain(EDITED);
        // And decisively NOT the stale original — the copy-model bug.
        expect(await readCell(page, DATA.row, DATA.col)).not.toContain(ORIGINAL);
      });
    } finally {
      await cleanup(page, anchors).catch(() => {});
      await clearCell(page, DATA.row, DATA.col).catch(() => {});
    }
  });

  // =========================================================================
  // JOURNEYS 2 + 3 — the Object Script Editor window: open-by-double-click
  //                  (navigation) and Run-at-cursor.
  // =========================================================================

  test("2+3. double-click opens the editor on the macro, and Run executes it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);

    const macroName = `${NAME_PREFIX} editor ${Date.now().toString(36)}`;
    const macroId = `macro-e2e-editor-${Date.now().toString(36)}`;
    const fnName = "e2eEditorMacro";
    const DATA = { row: 17, col: 1 }; // B18
    const VALUE = "31313";

    await allowScripts(page);
    await cleanup(page, []);
    await clearCell(page, DATA.row, DATA.col);

    const ctx = page.context();
    let editorPage: Page | null = null;

    // DESTROY (not just close) any editor window left by a previous run. The
    // Object Script Editor is a single Tauri window with a fixed label; a stale
    // one makes a fresh create fail (duplicate label). Destroying it at the Tauri
    // level frees the label AND avoids the zombie a bare `page.close()` leaves
    // (webview gone, window shell still claiming the label).
    async function destroyEditorWindow(): Promise<void> {
      await page
        .evaluate(async () => {
          const T = (window as any).__TAURI__;
          const WebviewWindow = T?.webviewWindow?.WebviewWindow;
          if (!WebviewWindow) return;
          const existing = await WebviewWindow.getByLabel("object-script-editor");
          if (existing) await existing.destroy();
        })
        .catch(() => {});
      await page.waitForTimeout(400);
    }
    /** The editor page (freshly opened or reused), once it has finished loading. */
    async function findEditorPage(timeoutMs: number): Promise<Page> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ed = ctx.pages().find((p) => p !== page && p.url().includes("objectScript.html"));
        if (ed) {
          await ed.waitForLoadState("domcontentloaded").catch(() => {});
          return ed;
        }
        await page.waitForTimeout(250);
      }
      throw new Error("Object Script Editor window never appeared");
    }

    try {
      await destroyEditorWindow();
      await seedObjectScriptMacro(page, {
        id: macroId,
        name: macroName,
        fnName,
        row: DATA.row,
        col: DATA.col,
        value: VALUE,
      });

      // -- NAVIGATION: double-click the row opens the editor window ----------
      const library = await openMacroLibrary(page, grid);
      const row = library.locator("[data-macro-library-item]").filter({ hasText: macroName });
      await expect(row).toHaveCount(1);

      await row.dblclick();
      editorPage = await findEditorPage(30_000);

      await test.step("3. the editor window opened on THIS macro", async () => {
        // Macro mode is unmistakable: the Save button reads "Save Macro" and the
        // document dropdown shows the macro under its name.
        await expect(
          editorPage!.locator("button").filter({ hasText: /^Save Macro$/ }),
        ).toBeVisible({ timeout: 30_000 });
        // The macro is the loaded document: it appears as the "MACRO — <name>"
        // option, keyed by its module id. (An <option> is not "visible" to
        // Playwright when the select is collapsed, so assert presence + value.)
        await expect(
          editorPage!.locator(`option[value="${macroId}"]`),
        ).toHaveCount(1, { timeout: 10_000 });
        await expect(editorPage!.locator(`option[value="${macroId}"]`)).toContainText(
          macroName,
        );
      });

      // Close the library so its backdrop is not covering the main grid.
      await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
      await expect(library).toBeHidden({ timeout: 5_000 });

      // -- RUN-AT-CURSOR: press Run; the macro function executes -------------
      await test.step("2. Run executes the macro (values change, not idle)", async () => {
        // Wait for Monaco to mount — Run reads the editor cursor + saved source.
        await editorPage!.waitForSelector(".monaco-editor", { state: "visible", timeout: 30_000 });
        await editorPage!.waitForTimeout(800);

        await clearCell(page, DATA.row, DATA.col);
        expect(await readCell(page, DATA.row, DATA.col)).toBe("");

        const runBtn = editorPage!.locator("button").filter({ hasText: /^Run$/ }).first();
        await expect(runBtn).toBeVisible({ timeout: 10_000 });
        await expect(runBtn).toBeEnabled();
        await runBtn.click();

        // The cursor sits in the header/`setup`, so run-at-cursor falls back to
        // the sole non-`setup` function and runs it in the main window's realm.
        await expect
          .poll(async () => readCell(page, DATA.row, DATA.col), { timeout: 45_000 })
          .toContain(VALUE);
      });
    } finally {
      await destroyEditorWindow().catch(() => {});
      await cleanup(page, []).catch(() => {});
      await clearCell(page, DATA.row, DATA.col).catch(() => {});
    }
  });

  // =========================================================================
  // JOURNEY 4 — ORPHAN: delete-warns-by-name, then the click says so.
  // =========================================================================

  test("4. deleting a linked macro warns, and the orphaned button says so", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);

    const macroName = `${NAME_PREFIX} orphan ${Date.now().toString(36)}`;
    const macroId = `macro-e2e-orphan-${Date.now().toString(36)}`;
    const DATA = { row: 19, col: 1 }; // B20
    const BUTTON = { ref: "D20", row: 19, col: 3 };
    const VALUE = "49494";
    const anchors = [{ row: BUTTON.row, col: BUTTON.col }];

    await allowScripts(page);
    await cleanup(page, anchors);
    await clearCell(page, DATA.row, DATA.col);
    await ensureDesignModeOff(page, grid);

    // Under Tauri `window.confirm` is overridden to show a NATIVE dialog and
    // return a Promise<boolean>; Playwright cannot drive a native OS dialog. So
    // we replace it in-page with a recorder that returns a value WE choose — this
    // proves both that the app raises the warning with the right text AND that it
    // now AWAITS the choice (Cancel must actually cancel).
    async function setConfirmBehavior(answer: boolean): Promise<void> {
      await page.evaluate((answer) => {
        const w = window as any;
        if (!w.__origConfirm) w.__origConfirm = w.confirm;
        w.__confirmMessages = [];
        w.confirm = (message?: string) => {
          w.__confirmMessages.push(String(message ?? ""));
          return Promise.resolve(answer);
        };
      }, answer);
    }
    async function lastConfirmMessage(): Promise<string> {
      return page.evaluate(() => {
        const list = (window as any).__confirmMessages as string[] | undefined;
        return list && list.length ? list[list.length - 1] : "";
      });
    }

    try {
      await seedObjectScriptMacro(page, {
        id: macroId,
        name: macroName,
        fnName: "e2eOrphanMacro",
        row: DATA.row,
        col: DATA.col,
        value: VALUE,
      });
      const seededId = await macroIdByName(page, macroName);
      expect(seededId).toBe(macroId);

      // -- link a button to it (through the real Add Button flow) -----------
      {
        const library = await openMacroLibrary(page, grid);
        const row = library.locator("[data-macro-library-item]").filter({ hasText: macroName });
        await expect(row).toHaveCount(1);
        await row.click();
        await library.locator("[data-macro-anchor-input]").fill(BUTTON.ref);
        await library.locator("[data-macro-add-button]").click();
        await expect(
          page.locator("[data-toast]").filter({ hasText: new RegExp(`Button created at ${BUTTON.ref}`) }),
        ).toBeVisible({ timeout: 20_000 });

        // -- CANCEL first: the warning must NAME the button AND actually gate ---
        await test.step("delete warns by naming the linking button, and Cancel cancels", async () => {
          await setConfirmBehavior(false); // user clicks Cancel
          await library.locator("button").filter({ hasText: /^Delete$/ }).first().click();
          await expect.poll(() => lastConfirmMessage(), { timeout: 10_000 }).not.toBe("");
          const msg = await lastConfirmMessage();
          expect(msg).toContain("links the macro");
          expect(msg).toContain(BUTTON.ref); // e.g. Sheet1!D20
          // Cancel was honoured: the macro is still here (before the fix, the
          // synchronous `!window.confirm(...)` ignored Cancel and deleted anyway).
          await page.waitForTimeout(500);
          expect(await macroIdByName(page, macroName)).toBe(macroId);
          await expect(
            library.locator("[data-macro-library-item]").filter({ hasText: macroName }),
          ).toHaveCount(1);
        });

        // -- CONFIRM: now the delete goes through ------------------------------
        await test.step("confirming the warning deletes the macro", async () => {
          await setConfirmBehavior(true); // user clicks OK
          await library.locator("button").filter({ hasText: /^Delete$/ }).first().click();
          await expect(
            library.locator("[data-macro-library-item]").filter({ hasText: macroName }),
          ).toHaveCount(0, { timeout: 10_000 });
        });
        await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
        await expect(library).toBeHidden({ timeout: 5_000 });
      }

      // The macro really is gone from the store.
      expect(await macroIdByName(page, macroName)).toBeNull();

      // -- CLICK the orphaned button; it must SAY the macro is gone ----------
      await test.step("clicking the orphaned button says the macro is gone", async () => {
        await clearCell(page, DATA.row, DATA.col);
        const point = await buttonCanvasPoint(page, BUTTON.row, BUTTON.col);
        await page.mouse.move(0, 0);
        await grid.canvas.click({ position: point, force: true });

        await expect(
          page.locator("[data-toast]").filter({ hasText: /no longer exists in this workbook/ }),
        ).toBeVisible({ timeout: 15_000 });

        // ...and it stayed a no-write: the deleted body did not run from a copy.
        await page.waitForTimeout(1_500);
        expect(await readCell(page, DATA.row, DATA.col)).toBe("");
      });
    } finally {
      await page
        .evaluate(() => {
          const w = window as any;
          if (w.__origConfirm) {
            w.confirm = w.__origConfirm;
            delete w.__origConfirm;
          }
        })
        .catch(() => {});
      await cleanup(page, anchors).catch(() => {});
      await clearCell(page, DATA.row, DATA.col).catch(() => {});
    }
  });
});
