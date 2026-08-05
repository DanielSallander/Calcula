/**
 * WAVE 1 VBA-IDIOM ADDRESSING — proved live against the real application.
 *
 * WHY THIS FILE EXISTS. Wave 1 shipped the addressing foundation the VBA-parity
 * audit called the API's biggest gap: sheets addressed by NAME or index
 * everywhere, a top-level api.range("Sheet!A1") entry, typed cell writes
 * (42 lands as the number 42), the own-write echo guard on data-change hooks,
 * and the textRotation round-trip. All of it is unit-tested; every live run of
 * this feature so far has caught something the unit tests could not see — real
 * Monaco, a real separate editor window, real worker realms, the real grid on
 * a real sv-SE locale. So each claim here is exercised through a REAL macro:
 * seeded as a module, opened in the Object Script Editor, its decisive token
 * RETYPED with real keystrokes (the live-edit model: no save step), and Run.
 *
 * THE CLAIMS (one test each, self-contained, cleaned up in a finally):
 *   1. api.setActiveSheet("<name>") activates the named sheet (proved on the
 *      RENDERED grid: the visible sheet's cells, not just the backend index);
 *      an unknown name REJECTS with an error that lists every sheet, and that
 *      error is on the editor's own surface.
 *   2. api.range("Sheet1!R61").setValue(42) — a NUMBER through a sheet-PREFIXED
 *      address while ANOTHER sheet is active — lands on Sheet1 R61, typed:
 *      getData() reports a number, and a pre-seeded =R61*2 neighbour computes
 *      84. Rendered-grid assertion after switching back, never only backend.
 *   3. The flat api.setCellValue(row, col, value, "<sheet name>") writes the
 *      NAMED sheet, not the active one.
 *   4. Own-write echo guard: a sheet script's onDataChange fires for a USER
 *      edit but is never re-fired by its own marker write (no runaway).
 *   5. setRangeFormat({ textRotation: "rotate90" }) round-trips: the stored
 *      style says rotate90, not none.
 *
 * SHARED APP. One app instance drives every functional spec; this one owns a
 * private patch of the grid no other macro spec touches — columns R/S/U,
 * rows 61+ — plus one temporary sheet ("E2EVbaTwo"), and cleans up before AND
 * after each test.
 *
 * LOCALE. sv-SE. Values are bare integers and the one formula (=R61*2) uses no
 * argument separators, so the spec reads identically under sv-SE and en-US.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const NAME_PREFIX = "E2EVbaIdioms";
const EDITOR_LABEL = "object-script-editor";
const EXTRA_SHEET = "E2EVbaTwo";

// This spec's private patch — no other macro spec touches columns R/S/U.
const HOP_CELL = { ref: "R61", row: 60, col: 17 }; // claim 1 sentinel (on EXTRA sheet)
const RANGE_CELL = { ref: "R61", row: 60, col: 17 }; // claim 2 target (on BASE sheet)
const FORMULA_CELL = { ref: "S61", row: 60, col: 18 }; // claim 2 neighbour =R61*2
const TYPE_CELL = { ref: "U61", row: 60, col: 20 }; // claim 2 type report (active sheet)
const FLAT_CELL = { ref: "R63", row: 62, col: 17 }; // claim 3 target
const MARKER_CELL = { ref: "R65", row: 64, col: 17 }; // claim 4 marker
const EDIT_CELL_1 = { ref: "R67", row: 66, col: 17 }; // claim 4 user edit #1
const EDIT_CELL_2 = { ref: "R68", row: 67, col: 17 }; // claim 4 user edit #2
const ROT_CELL = { ref: "R69", row: 68, col: 17 }; // claim 5

// ---------------------------------------------------------------------------
// Backend readers/writers — setup + assertions, never the thing under test.
// ---------------------------------------------------------------------------

async function readActiveCell(page: Page, row: number, col: number): Promise<string> {
  return page.evaluate(
    async ({ row, col }) => {
      const tauri = (window as any).__TAURI__;
      const cell = await tauri.core.invoke("get_cell", { row, col });
      return String(cell?.display ?? cell?.value ?? "");
    },
    { row, col },
  );
}

async function clearActiveCells(
  page: Page,
  cells: Array<{ row: number; col: number }>,
): Promise<void> {
  await page.evaluate(async (cells) => {
    const tauri = (window as any).__TAURI__;
    for (const c of cells) {
      await tauri.core.invoke("update_cell", { row: c.row, col: c.col, value: "" });
    }
    window.dispatchEvent(new Event("grid:refresh"));
  }, cells);
  await page.waitForTimeout(150);
}

async function allowScripts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    await tauri.core.invoke("set_script_security_level", { level: "enabled" });
  });
}

interface SheetsShape {
  sheets: Array<{ index: number; name: string }>;
  activeIndex: number;
}

async function getSheets(page: Page): Promise<SheetsShape> {
  return page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    return tauri.core.invoke("get_sheets");
  });
}

/**
 * Tell the tab bar the sheet list / active sheet moved under it. Every REAL
 * caller that changes sheets programmatically announces SHEET_CHANGED (the tab
 * bar reloads on "app:sheet-changed"; see announceSheetsChanged in host.ts) —
 * a first run of this spec skipped the announcement and the tab bar's stale
 * local activeIndex swallowed the next tab click as a no-op.
 */
async function announceSheetsFromTest(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api: any = await (window as any).__calcImport(
      new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
    );
    const result = await api.getSheets();
    const active = result.sheets.find((s: any) => s.index === result.activeIndex);
    window.dispatchEvent(
      new CustomEvent("app:sheet-changed", {
        detail: { sheetIndex: result.activeIndex, sheetName: active?.name ?? "" },
      }),
    );
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(400);
}

/** Activate a sheet through the trusted wrapper AND announce it, exactly as
 *  the product's programmatic switchers do. */
async function activateSheetTrusted(page: Page, index: number): Promise<void> {
  await page.evaluate(async (index) => {
    const api: any = await (window as any).__calcImport(
      new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
    );
    await api.setActiveSheet(index);
  }, index);
  await announceSheetsFromTest(page);
}

/** Create the extra sheet if missing (trusted wrapper: announces SHEET_ADDED).
 *  Returns its index. add_sheet ACTIVATES the new sheet — callers re-activate. */
async function ensureExtraSheet(page: Page): Promise<number> {
  const before = await getSheets(page);
  const existing = before.sheets.find((s) => s.name === EXTRA_SHEET);
  if (existing) return existing.index;
  await page.evaluate(async (name) => {
    const api: any = await (window as any).__calcImport(
      new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
    );
    await api.addSheet(name);
  }, EXTRA_SHEET);
  await announceSheetsFromTest(page);
  const after = await getSheets(page);
  const added = after.sheets.find((s) => s.name === EXTRA_SHEET);
  if (!added) throw new Error(`sheet "${EXTRA_SHEET}" was not created`);
  return added.index;
}

async function deleteExtraSheet(page: Page): Promise<void> {
  const { sheets } = await getSheets(page);
  const extra = sheets.find((s) => s.name === EXTRA_SHEET);
  if (!extra) return;
  await page.evaluate(async (index) => {
    const api: any = await (window as any).__calcImport(
      new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
    );
    await api.setActiveSheet(0);
    await api.deleteSheet(index);
  }, extra.index);
  await announceSheetsFromTest(page);
}

async function macroIdByName(page: Page, name: string): Promise<string | null> {
  return page.evaluate(async (name) => {
    const tauri = (window as any).__TAURI__;
    const scripts: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
    return scripts.find((s) => s.name === name)?.id ?? null;
  }, name);
}

async function seedMacro(
  page: Page,
  opts: { id: string; name: string; source: string },
): Promise<void> {
  const description = `Recorded macro · runtime=objectScript · 1 action · recorded ${new Date().toISOString()}`;
  await page.evaluate(
    async ({ id, name, description, source }) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("save_script", {
        script: { id, name, description, source, scope: { type: "workbook" } },
      });
    },
    { id: opts.id, name: opts.name, description, source: opts.source },
  );
}

async function releaseTransientDebugMounts(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const host: any = await (window as any).__calcImport(
        new URL("/src/api/scriptHost/host.ts", document.baseURI).href,
      );
      await host.hostStopTransientDebugSessions();
    })
    .catch(() => {});
}

/** What the main window's host believes about a script's debug session. */
async function hostSessionActivityError(page: Page, scriptId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const host: any = await (window as any).__calcImport(
      new URL("/src/api/scriptHost/host.ts", document.baseURI).href,
    );
    const session: any = host.getDebugSession(id);
    const err = session?.lastActivity?.error ?? session?.error ?? null;
    return err ? String(err) : null;
  }, scriptId);
}

/** Remove every module + object script this spec created. Idempotent. */
async function cleanup(page: Page): Promise<void> {
  await releaseTransientDebugMounts(page);
  await page.evaluate(async (prefix) => {
    const tauri = (window as any).__TAURI__;
    // Object scripts (claim 4): unmount + deregister through the real manager.
    try {
      const so: any = await (window as any).__calcImport(
        new URL("/src/api/scriptableObjects.ts", document.baseURI).href,
      );
      for (const s of so.ObjectScriptManager.getAllScripts()) {
        if (s.id && s.id.startsWith("e2evba-")) {
          so.ObjectScriptManager.removeScript(s.id);
        }
      }
    } catch {
      /* manager not loaded */
    }
    try {
      const modules: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
      for (const m of modules) {
        if ((m.name && m.name.startsWith(prefix)) || (m.id && m.id.startsWith("macro-e2evba"))) {
          await tauri.core.invoke("delete_script", { id: m.id }).catch(() => {});
        }
      }
    } catch {
      /* no module store */
    }
  }, NAME_PREFIX);
  await page.waitForTimeout(150);
}

// ---------------------------------------------------------------------------
// The Object Script Editor window (same access pattern as macro-live-edit)
// ---------------------------------------------------------------------------

async function destroyEditorWindow(page: Page): Promise<void> {
  await page
    .evaluate(async (label) => {
      const T = (window as any).__TAURI__;
      const WebviewWindow = T?.webviewWindow?.WebviewWindow;
      if (!WebviewWindow) return;
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) await existing.destroy();
    }, EDITOR_LABEL)
    .catch(() => {});
  await page.waitForTimeout(600);
}

async function findEditorPage(page: Page, timeoutMs: number): Promise<Page> {
  const ctx = page.context();
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

async function openMacroLibrary(page: Page, grid: any) {
  await grid.openMenu("Developer");
  const item = page.locator("button").filter({ hasText: /^Macros/ }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click();
  const library = page.locator("[data-macro-library-dialog]");
  await expect(library).toBeVisible({ timeout: 10_000 });
  return library;
}

async function openMacroInEditor(page: Page, grid: any, macroName: string): Promise<Page> {
  const library = await openMacroLibrary(page, grid);
  const row = library.locator("[data-macro-library-item]").filter({ hasText: macroName });
  await expect(row).toHaveCount(1);
  await row.dblclick();
  const editorPage = await findEditorPage(page, 45_000);
  await editorPage.waitForSelector(".monaco-editor", { state: "visible", timeout: 45_000 });
  await editorPage.waitForTimeout(1_500);
  await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
  await expect(library).toBeHidden({ timeout: 5_000 });
  return editorPage;
}

function documentSelect(editorPage: Page) {
  return editorPage.locator("select.ose-select").first();
}

async function consoleText(editorPage: Page): Promise<string> {
  const lines = await editorPage.locator(".ose-console-line").allInnerTexts();
  return lines.join("\n");
}

/** Console PLUS debug panel — everything the editor window is saying. */
async function editorSurfaceText(editorPage: Page): Promise<string> {
  return editorPage.evaluate(() => document.body.innerText ?? "");
}

async function liveState(editorPage: Page): Promise<string | null> {
  const el = editorPage.locator("[data-testid='module-live-indicator']");
  if ((await el.count()) === 0) return null;
  return el.first().getAttribute("data-live-state");
}

function toolbarButton(editorPage: Page, label: "Run" | "Debug" | "Stop") {
  return editorPage.locator("button.ose-btn").filter({ hasText: new RegExp(`^${label}$`) }).first();
}

/** Retype a value the way a person would: double-click the token, type over it. */
async function retypeToken(editorPage: Page, from: string, to: string): Promise<void> {
  const token = editorPage
    .locator(".monaco-editor .view-lines span")
    .filter({ hasText: new RegExp(`^["']?${from}["']?$`) })
    .first();
  await expect(token, `the token ${from} is on screen to be edited`).toBeVisible({
    timeout: 20_000,
  });
  await token.dblclick();
  await editorPage.waitForTimeout(120);
  await editorPage.keyboard.type(to, { delay: 40 });
}

/** Retype + wait for the idle write-through, so what runs is what was typed. */
async function retypeAndStore(
  page: Page,
  editorPage: Page,
  macroId: string,
  from: string,
  to: string,
): Promise<void> {
  await retypeToken(editorPage, from, to);
  await expect.poll(async () => liveState(editorPage), { timeout: 30_000 }).toBe("live");
  const stored = await page.evaluate(async (id) => {
    const tauri = (window as any).__TAURI__;
    const script: any = await tauri.core.invoke("get_script", { id });
    return String(script?.source ?? "");
  }, macroId);
  expect(stored, "the module store holds the typed edit").toContain(to);
}

async function withEditorConsole<T>(editorPage: Page, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const text = await consoleText(editorPage).catch(() => "(console unavailable)");
    const live = await liveState(editorPage).catch(() => null);
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        `--- live state: ${live}\n--- editor console ---\n${text}`,
    );
  }
}

/** Quote a sheet name for an address prefix the way Excel does. */
function sheetPrefix(name: string): string {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** The recorded-macro shape: one worker function plus `setup`. */
function macroSource(name: string, fnName: string, body: string): string {
  return (
    `// Macro: ${name}\n` +
    `// Target runtime: object script (unlocked)\n` +
    `async function ${fnName}(api) {\n` +
    body +
    `}\n` +
    `\n` +
    `function setup(context) {\n` +
    `  if (!context.api) {\n` +
    `    context.notify("needs an UNLOCKED script", "error");\n` +
    `    return;\n` +
    `  }\n` +
    `  return ${fnName}(context.api);\n` +
    `}\n`
  );
}

/** Click a sheet tab — the user's own gesture, so the switch is RENDERED —
 *  and WAIT until the backend agrees, so reads never race the switch. */
async function clickSheetTab(page: Page, index: number): Promise<void> {
  await page.locator(`button[data-sheet-tab="${index}"]`).click();
  await expect
    .poll(async () => (await getSheets(page)).activeIndex, { timeout: 15_000 })
    .toBe(index);
  await page.waitForTimeout(300);
}

// ===========================================================================

test.describe("Wave 1 VBA idioms (live, through the editor)", () => {
  // =========================================================================
  // CLAIM 1 — setActiveSheet by NAME; unknown name rejects listing the sheets
  // =========================================================================

  test("1. api.setActiveSheet(name) activates by NAME; a miss lists every sheet", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} hop ${stamp}`;
    const macroId = `macro-e2evba-hop-${stamp}`;
    const SEED_NAME = "E2EVbaSeedName";
    const BAD_NAME = "NoSuchSheet123";

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      const baseSheets = await getSheets(page);
      const baseName = baseSheets.sheets[0].name;
      const extraIdx = await ensureExtraSheet(page);
      // add_sheet activates the new sheet; claim 1 must do the switching itself.
      await activateSheetTrusted(page, 0);
      await clearActiveCells(page, [HOP_CELL]);
      await activateSheetTrusted(page, extraIdx);
      await clearActiveCells(page, [HOP_CELL]);
      await activateSheetTrusted(page, 0);

      // The macro is seeded with a WRONG name token and the real one is TYPED
      // into Monaco — the live-edit model, no save step anywhere.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVbaHop",
          `  await api.setActiveSheet("${SEED_NAME}");\n` +
            `  await api.setCellValue(${HOP_CELL.row}, ${HOP_CELL.col}, "hopped");\n`,
        ),
      });
      expect(await macroIdByName(page, macroName)).toBe(macroId);

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the sheet NAME and Run: the named sheet activates", async () => {
        await retypeAndStore(page, editorPage, macroId, SEED_NAME, EXTRA_SHEET);
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => (await getSheets(page)).activeIndex, { timeout: 90_000 })
            .toBe(extraIdx);
        });
      });

      await test.step("the switch is RENDERED: the visible grid is the new sheet", async () => {
        // The write AFTER the switch landed on the newly-active sheet, and the
        // canvas the user is looking at shows that sheet: reading through the
        // UI (click cell -> formula bar) must see the sentinel.
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => grid.getCellFormulaBarText(HOP_CELL.ref), { timeout: 60_000 })
            .toBe("hopped");
        });
        // ...and the sheet tab strip renders the named tab.
        await expect(page.locator(`button[data-sheet-tab="${extraIdx}"]`)).toHaveText(
          EXTRA_SHEET,
        );
        // The BASE sheet did not get the write (switch really happened first).
        await activateSheetTrusted(page, 0);
        expect(await readActiveCell(page, HOP_CELL.row, HOP_CELL.col)).toBe("");
      });

      await test.step("an unknown name REJECTS, listing every sheet, on the editor surface", async () => {
        await releaseTransientDebugMounts(page);
        await retypeAndStore(page, editorPage, macroId, EXTRA_SHEET, BAD_NAME);
        await toolbarButton(editorPage, "Run").click();

        // The rejection must be shown to the author — console or debug panel.
        await expect
          .poll(async () => editorSurfaceText(editorPage), { timeout: 90_000 })
          .toMatch(new RegExp(`no sheet named "${BAD_NAME}"`));
        const surface = await editorSurfaceText(editorPage);
        const errLine = surface
          .split("\n")
          .find((l) => l.includes(`no sheet named "${BAD_NAME}"`))!;
        expect(errLine, "the error LISTS the sheets").toContain("(sheets:");
        expect(errLine, "…including the base sheet").toContain(`"${baseName}" (0)`);
        expect(errLine, "…and the extra sheet").toContain(`"${EXTRA_SHEET}" (${extraIdx})`);
        // The host session agrees (belt to the UI's suspenders).
        const hostErr = await hostSessionActivityError(page, macroId);
        if (hostErr !== null) {
          expect(hostErr).toContain(`no sheet named "${BAD_NAME}"`);
        }
      });

      await test.step("the failed Run changed NOTHING: active sheet + cells untouched", async () => {
        expect((await getSheets(page)).activeIndex, "active sheet is still the base").toBe(0);
        expect(await readActiveCell(page, HOP_CELL.row, HOP_CELL.col)).toBe("");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await clearActiveCells(page, [HOP_CELL]).catch(() => {});
      await deleteExtraSheet(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 2 — api.range("Sheet!R61").setValue(42): typed, sheet-prefixed,
  //           while ANOTHER sheet is active
  // =========================================================================

  test("2. api.range with a sheet prefix writes a typed NUMBER to the named sheet", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} range ${stamp}`;
    const macroId = `macro-e2evba-range-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      const baseName = (await getSheets(page)).sheets[0].name;
      await activateSheetTrusted(page, 0);
      await clearActiveCells(page, [RANGE_CELL, FORMULA_CELL, TYPE_CELL]);
      // The typed-write oracle: a formula neighbour that only computes 84 if
      // R61 landed as the NUMBER 42 (text would make it a #VALUE!/0 story).
      await grid.setCellValueDirect(FORMULA_CELL.ref, "=R61*2");

      const extraIdx = await ensureExtraSheet(page);
      await activateSheetTrusted(page, extraIdx);
      await clearActiveCells(page, [RANGE_CELL, TYPE_CELL]);

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVbaRangeWrite",
          `  const r = await api.range("${sheetPrefix(baseName)}!${RANGE_CELL.ref}");\n` +
            `  await r.setValue(41);\n` +
            `  const d = (await r.getData())[0][0];\n` +
            `  await api.setCellValue(${TYPE_CELL.row}, ${TYPE_CELL.col}, d.type + ":" + typeof d.value);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type 42 (a NUMBER literal) and Run while the OTHER sheet is active", async () => {
        expect((await getSheets(page)).activeIndex, "another sheet is active").toBe(extraIdx);
        await retypeAndStore(page, editorPage, macroId, "41", "42");
        await toolbarButton(editorPage, "Run").click();
        // The type report lands on the ACTIVE (other) sheet — poll it first.
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, TYPE_CELL.row, TYPE_CELL.col), {
              timeout: 90_000,
            })
            .toBe("number:number");
        });
      });

      await test.step("the write did NOT land on the active sheet", async () => {
        expect(await readActiveCell(page, RANGE_CELL.row, RANGE_CELL.col)).toBe("");
      });

      await test.step("switch back (a real tab click): the RENDERED grid holds 42 and =R61*2 = 84", async () => {
        await clickSheetTab(page, 0);
        // Rendered reads: click the cell, read the formula bar the user sees.
        expect(await grid.getCellFormulaBarText(RANGE_CELL.ref), "R61 shows the number").toBe(
          "42",
        );
        expect(
          await grid.getCellFormulaBarText(FORMULA_CELL.ref),
          "S61 still holds its formula",
        ).toBe("=R61*2");
        // The decisive typed-write proof: the formula COMPUTED over the number.
        await expect
          .poll(async () => readActiveCell(page, FORMULA_CELL.row, FORMULA_CELL.col), {
            timeout: 30_000,
          })
          .toBe("84");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await clearActiveCells(page, [RANGE_CELL, FORMULA_CELL, TYPE_CELL]).catch(() => {});
      await deleteExtraSheet(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 3 — the flat api.setCellValue(row, col, value, "<name>") writes the
  //           NAMED sheet
  // =========================================================================

  test("3. flat api.setCellValue with a sheet NAME writes the named sheet", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} flat ${stamp}`;
    const macroId = `macro-e2evba-flat-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      const baseName = (await getSheets(page)).sheets[0].name;
      await activateSheetTrusted(page, 0);
      await clearActiveCells(page, [FLAT_CELL]);
      const extraIdx = await ensureExtraSheet(page);
      await activateSheetTrusted(page, extraIdx);
      await clearActiveCells(page, [FLAT_CELL]);

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVbaFlat",
          `  await api.setCellValue(${FLAT_CELL.row}, ${FLAT_CELL.col}, "flatseed", ${JSON.stringify(
            baseName,
          )});\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the value and Run while the OTHER sheet is active", async () => {
        expect((await getSheets(page)).activeIndex).toBe(extraIdx);
        await retypeAndStore(page, editorPage, macroId, "flatseed", "flatname");
        await toolbarButton(editorPage, "Run").click();
        // The NAMED (base) sheet must receive the value. The macro runs a
        // moment after Run (mount + fire); with the sheet ref honoured the
        // destination is deterministic regardless of which sheet is active
        // when it lands — so the rendered proof doubles as the wait: switch
        // to the base sheet like a user and poll the formula bar.
        await withEditorConsole(editorPage, async () => {
          await clickSheetTab(page, 0);
          await expect
            .poll(async () => grid.getCellFormulaBarText(FLAT_CELL.ref), { timeout: 90_000 })
            .toBe("flatname");
        });
      });

      await test.step("…and the other sheet's cell is still empty (no wrong-sheet write)", async () => {
        // The macro finished (the base-sheet value proved it) — now the other
        // sheet must NOT hold the value, now or after a settle.
        await clickSheetTab(page, extraIdx);
        await page.waitForTimeout(1_000);
        expect(await readActiveCell(page, FLAT_CELL.row, FLAT_CELL.col)).toBe("");
        await clickSheetTab(page, 0);
        expect(await grid.getCellFormulaBarText(FLAT_CELL.ref)).toBe("flatname");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await clearActiveCells(page, [FLAT_CELL]).catch(() => {});
      await deleteExtraSheet(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 4 — own-write echo guard on sheet.onDataChange
  // =========================================================================
  //
  // A macro mounts as a WORKBOOK script and workbook scripts have no
  // onDataChange (by design — that hook belongs to the sheet object), so this
  // claim runs on a real SHEET script mounted through the same public
  // ObjectScriptManager door the Object Scripts pane uses: a real worker
  // realm, the real host forwarders, the real grid. The handler writes a
  // marker cell INSIDE its own watch region — the canonical VBA timestamp
  // macro — so a broken echo guard would re-enter itself forever and the
  // marker would count past 1.

  test("4. onDataChange fires for USER edits but never for the script's own write", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const scriptId = `e2evba-echo-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await clearActiveCells(page, [MARKER_CELL, EDIT_CELL_1, EDIT_CELL_2]);

      const source =
        `function setup(context) {\n` +
        `  let count = 0;\n` +
        `  context.onDataChange(async (payload) => {\n` +
        `    for (const ch of payload.changes) {\n` +
        `      if (ch.col === ${MARKER_CELL.col} && ch.row >= 60 && ch.row <= 79) {\n` +
        `        count = count + 1;\n` +
        `        await context.api.setCellValue(${MARKER_CELL.row}, ${MARKER_CELL.col}, "M" + count);\n` +
        `        return;\n` +
        `      }\n` +
        `    }\n` +
        `  });\n` +
        `}\n`;

      await test.step("mount a real sheet script that watches column R", async () => {
        await page.evaluate(
          async ({ scriptId, source }) => {
            const so: any = await (window as any).__calcImport(
              new URL("/src/api/scriptableObjects.ts", document.baseURI).href,
            );
            so.ObjectScriptManager.registerScript({
              id: scriptId,
              name: "E2EVbaIdioms echo guard",
              objectType: "sheet",
              instanceId: null,
              source,
              accessLevel: "unlocked",
              provenance: "local",
            });
            await so.ObjectScriptManager.mountScript(scriptId);
          },
          { scriptId, source },
        );
        // Let the worker realm finish setup + hook registration.
        await page.waitForTimeout(1_500);
      });

      await test.step("a USER edit fires the handler exactly once", async () => {
        await grid.setCellValue(EDIT_CELL_1.ref, "77");
        await expect
          .poll(async () => readActiveCell(page, MARKER_CELL.row, MARKER_CELL.col), {
            timeout: 30_000,
          })
          .toBe("M1");
      });

      await test.step("the marker write does NOT re-trigger the handler (no runaway)", async () => {
        // The marker cell is inside the watch region: if the echo guard were
        // broken the handler would have re-fired on its own write and the
        // count would keep climbing. Sample across a settle window.
        const deadline = Date.now() + 4_000;
        let samples = 0;
        while (Date.now() < deadline) {
          const v = await readActiveCell(page, MARKER_CELL.row, MARKER_CELL.col);
          samples++;
          expect(v, `own-write echo re-fired the handler (sample ${samples})`).toBe("M1");
          await page.waitForTimeout(250);
        }
        expect(samples).toBeGreaterThan(3);
      });

      await test.step("a SECOND user edit still fires (the guard is not a mute)", async () => {
        await grid.setCellValue(EDIT_CELL_2.ref, "78");
        await expect
          .poll(async () => readActiveCell(page, MARKER_CELL.row, MARKER_CELL.col), {
            timeout: 30_000,
          })
          .toBe("M2");
        // ...and settles again.
        await page.waitForTimeout(2_000);
        expect(await readActiveCell(page, MARKER_CELL.row, MARKER_CELL.col)).toBe("M2");
      });
    } finally {
      await page
        .evaluate(async (scriptId) => {
          const so: any = await (window as any).__calcImport(
            new URL("/src/api/scriptableObjects.ts", document.baseURI).href,
          );
          so.ObjectScriptManager.removeScript(scriptId);
        }, scriptId)
        .catch(() => {});
      await cleanup(page).catch(() => {});
      await clearActiveCells(page, [MARKER_CELL, EDIT_CELL_1, EDIT_CELL_2]).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 5 — textRotation round-trips through setRangeFormat
  // =========================================================================

  test("5. setRangeFormat textRotation=rotate90 is APPLIED, not dropped", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} rot ${stamp}`;
    const macroId = `macro-e2evba-rot-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await clearActiveCells(page, [ROT_CELL]);
      await grid.setCellValueDirect(ROT_CELL.ref, "tilt");
      expect(
        await grid.getCellStyleStringProp(ROT_CELL.ref, "textRotation"),
        "the cell starts unrotated",
      ).toBe("none");

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVbaRotate",
          `  await api.setRangeFormat(${ROT_CELL.row}, ${ROT_CELL.col}, ${ROT_CELL.row}, ${ROT_CELL.col}, { textRotation: "rotate270" });\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type rotate90 over the seeded token and Run", async () => {
        await retypeAndStore(page, editorPage, macroId, "rotate270", "rotate90");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(
              async () => grid.getCellStyleStringProp(ROT_CELL.ref, "textRotation"),
              { timeout: 90_000 },
            )
            .toBe("rotate90");
        });
      });

      await test.step("the value survived the formatting", async () => {
        expect(await readActiveCell(page, ROT_CELL.row, ROT_CELL.col)).toBe("tilt");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearActiveCells(page, [ROT_CELL]).catch(() => {});
    }
  });
});
