/**
 * WAVE 2 VBA-IDIOM NAVIGATION + SELECTION — proved live against the real app.
 *
 * Wave 2 shipped the discovery/selection layer of the VBA-parity work:
 * Range.End (the last-row idiom), CurrentRegion, UsedRange, Selection
 * read/write (api.select / getSelection / selection() / activeCell()), rich
 * worksheet handles (api.workbook.sheet -> rename/visibility/delete), the
 * clearRange trio (all|contents|formats) and pure range algebra
 * (contains/intersect/boundingUnion). All unit-tested; this file proves each
 * claim through a REAL macro: seeded as a module, opened in the Object Script
 * Editor, its decisive token RETYPED with real keystrokes (live-edit model,
 * no save step), and Run — against the real grid on a real sv-SE locale.
 *
 * THE CLAIMS (one test each, self-contained, cleaned up in a finally):
 *   1. THE LAST-ROW IDIOM: with T61:T70 seeded and T71+ empty,
 *      api.range("T1048576").end("up") lands on T70, and end("down") from T61
 *      stops at T70 — both proved on the RENDERED grid via result cells.
 *   2. currentRegion() on a bordered-by-blanks block reports the block's
 *      exact address and dims; sheet.usedRange() COVERS the seeded block
 *      (proved with the shipped intersect() algebra, worker-side).
 *   3. api.select("U65:V70") renders as the visible selection (grid-state
 *      probe of the state the canvas paints from + screenshot), getSelection()
 *      reads the same shape back, and activeCell() is the cell a keystroke
 *      would land in (this product's convention: the selection END cell —
 *      useEditing guards key entry on selection.endRow/endCol).
 *   4. Worksheet facet: ws = api.workbook.sheet(name); ws.rename() shows on
 *      the TAB STRIP, ws.setVisibility("hidden") removes the tab (and
 *      restores), ws.delete() removes the sheet.
 *   5. clearRange: applyTo "contents" clears values but keeps formats;
 *      applyTo "all" clears both.
 *   6. Intersect guard: an onDataChange handler guarded by
 *      guard.intersect(changedCell) fires for a user edit INSIDE U80:U85,
 *      exactly once, and never for an edit outside.
 *
 * SHARED APP. One instance drives every functional spec; this spec's private
 * patch is columns T/V/W/X rows 61+ and U rows 65+ (wave 1 owns R/S/U61;
 * other specs own K, L, N, P). One temporary sheet family: E2EVbaW2A/B.
 *
 * LOCALE. sv-SE. No formulas are typed anywhere in this spec and all values
 * are bare integers, so no argument-separator concerns.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const NAME_PREFIX = "E2EVbaWave2";
const EDITOR_LABEL = "object-script-editor";
const SHEET_A = "E2EVbaW2A";
const SHEET_B = "E2EVbaW2B";

// Result cells (column X = 23)
const RES1 = { ref: "X61", row: 60, col: 23 };
const RES2 = { ref: "X62", row: 61, col: 23 };
const RES3 = { ref: "X64", row: 63, col: 23 };

// Claim 1: seeded column T61:T70 (rows 60-69, col 19)
const SEED_COL = 19;
// Claim 2: bordered-by-blanks block T75:V78 (rows 74-77, cols 19-21)
// Claim 3: selection U65:V70 (rows 64-69, cols 20-21)
// Claim 5: clear patch T90:U91 (rows 89-90, cols 19-20)
const CLR = { startRow: 89, startCol: 19, endRow: 90, endCol: 20 };
// Claim 6: guard region U80:U85 (rows 79-84, col 20); marker W80 (79, 22)
const GUARD_MARKER = { ref: "W80", row: 79, col: 22 };
const EDIT_INSIDE = { ref: "U82", row: 81, col: 20 };
const EDIT_OUTSIDE = { ref: "T82", row: 81, col: 19 };

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

/** Clear values AND formats of this spec's whole private patch on the ACTIVE
 *  sheet — rows 61-100, cols T..X — in one backend call. */
async function clearPatch(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    await tauri.core.invoke("clear_range_with_options", {
      params: { startRow: 60, startCol: 19, endRow: 99, endCol: 23, applyTo: "all" },
    });
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(150);
}

async function seedCellsDirect(
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
  await page.waitForTimeout(150);
}

async function allowScripts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    await tauri.core.invoke("set_script_security_level", { level: "enabled" });
  });
}

interface SheetsShape {
  sheets: Array<{ index: number; name: string; visibility?: string }>;
  activeIndex: number;
}

async function getSheets(page: Page): Promise<SheetsShape> {
  return page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    return tauri.core.invoke("get_sheets");
  });
}

/** Announce sheet-list changes exactly like the product's programmatic
 *  switchers do (the tab bar reloads on "app:sheet-changed"). */
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

async function activateSheetTrusted(page: Page, index: number): Promise<void> {
  await page.evaluate(async (index) => {
    const api: any = await (window as any).__calcImport(
      new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
    );
    await api.setActiveSheet(index);
  }, index);
  await announceSheetsFromTest(page);
}

/** Create a scratch sheet if missing (add_sheet ACTIVATES it — callers
 *  re-activate). Returns its index. */
async function ensureSheet(page: Page, name: string): Promise<number> {
  const before = await getSheets(page);
  const existing = before.sheets.find((s) => s.name === name);
  if (existing) return existing.index;
  await page.evaluate(async (name) => {
    const api: any = await (window as any).__calcImport(
      new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
    );
    await api.addSheet(name);
  }, name);
  await announceSheetsFromTest(page);
  const after = await getSheets(page);
  const added = after.sheets.find((s) => s.name === name);
  if (!added) throw new Error(`sheet "${name}" was not created`);
  return added.index;
}

/** Delete every scratch sheet this spec may have left behind. Idempotent. */
async function deleteScratchSheets(page: Page): Promise<void> {
  for (const name of [SHEET_A, SHEET_B]) {
    const { sheets } = await getSheets(page);
    const hit = sheets.find((s) => s.name === name);
    if (!hit) continue;
    await page.evaluate(async (index) => {
      const api: any = await (window as any).__calcImport(
        new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
      );
      await api.setActiveSheet(0);
      await api.deleteSheet(index);
    }, hit.index);
    await announceSheetsFromTest(page);
  }
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

/** Remove every module + object script this spec created. Idempotent. */
async function cleanup(page: Page): Promise<void> {
  await releaseTransientDebugMounts(page);
  await page.evaluate(async (prefix) => {
    const tauri = (window as any).__TAURI__;
    try {
      const so: any = await (window as any).__calcImport(
        new URL("/src/api/scriptableObjects.ts", document.baseURI).href,
      );
      for (const s of so.ObjectScriptManager.getAllScripts()) {
        if (s.id && s.id.startsWith("e2evba2-")) {
          so.ObjectScriptManager.removeScript(s.id);
        }
      }
    } catch {
      /* manager not loaded */
    }
    try {
      const modules: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
      for (const m of modules) {
        if ((m.name && m.name.startsWith(prefix)) || (m.id && m.id.startsWith("macro-e2evba2"))) {
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
// The Object Script Editor window (same access pattern as vba-idioms-wave1)
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

/**
 * Retype + wait for the idle write-through, so what runs is what was typed.
 * `expectStored` (default: the typed token) is the substring that must appear
 * in the stored source — pass something sharper than the raw token whenever
 * the token is a substring of text already present ("up" in "setup", digits).
 */
async function retypeAndStore(
  page: Page,
  editorPage: Page,
  macroId: string,
  from: string,
  to: string,
  expectStored?: string,
): Promise<void> {
  await retypeToken(editorPage, from, to);
  await expect.poll(async () => liveState(editorPage), { timeout: 30_000 }).toBe("live");
  const stored = await page.evaluate(async (id) => {
    const tauri = (window as any).__TAURI__;
    const script: any = await tauri.core.invoke("get_script", { id });
    return String(script?.source ?? "");
  }, macroId);
  expect(stored, "the module store holds the typed edit").toContain(expectStored ?? to);
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

// ===========================================================================

test.describe("Wave 2 VBA idioms (live, through the editor)", () => {
  // =========================================================================
  // CLAIM 1 — Range.End: the last-row idiom, both directions
  // =========================================================================

  test("1. end('up') from T1048576 finds the last row; end('down') from T61 stops at T70", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} lastrow ${stamp}`;
    const macroId = `macro-e2evba2-lastrow-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await clearPatch(page);
      // Seed T61:T70 with 1..10; T71+ stays empty.
      await seedCellsDirect(
        page,
        Array.from({ length: 10 }, (_, i) => ({ row: 60 + i, col: SEED_COL, value: String(i + 1) })),
      );

      // Seeded with the WRONG direction; "up" is TYPED into Monaco.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba2LastRow",
          `  const bottom = await api.range("T1048576");\n` +
            `  const last = await bottom.end("left");\n` +
            `  await api.setCellValue(${RES1.row}, ${RES1.col}, "last-" + (last.startRow + 1));\n` +
            `  const top = await api.range("T61");\n` +
            `  const down = await top.end("down");\n` +
            `  await api.setCellValue(${RES2.row}, ${RES2.col}, "down-" + (down.startRow + 1));\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type 'up' over the seeded direction and Run", async () => {
        await retypeAndStore(page, editorPage, macroId, "left", "up", `end("up")`);
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES2.row, RES2.col), { timeout: 90_000 })
            .toBe("down-70");
        });
      });

      await test.step("RENDERED grid: the last-row idiom answered 70, both directions", async () => {
        expect(await grid.getCellFormulaBarText(RES1.ref), "end('up') from the column floor").toBe(
          "last-70",
        );
        expect(await grid.getCellFormulaBarText(RES2.ref), "end('down') from the block top").toBe(
          "down-70",
        );
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await clearPatch(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 2 — currentRegion() + sheet.usedRange() (+ intersect algebra)
  // =========================================================================

  test("2. currentRegion() reports the bordered block; usedRange() covers it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} region ${stamp}`;
    const macroId = `macro-e2evba2-region-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await clearPatch(page);
      // A 4x3 block T75:V78, bordered by blanks on every side.
      const seeds: Array<{ row: number; col: number; value: string }> = [];
      for (let r = 74; r <= 77; r++) {
        for (let c = 19; c <= 21; c++) seeds.push({ row: r, col: c, value: String(r + c) });
      }
      await seedCellsDirect(page, seeds);

      // Seeded pointing at an EMPTY cell; the block cell is TYPED in.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba2Region",
          `  const seedCell = await api.range("T99");\n` +
            `  const region = await seedCell.currentRegion();\n` +
            `  await api.setCellValue(${RES1.row}, ${RES1.col}, region.address + "=" + region.rowCount + "x" + region.colCount);\n` +
            `  const ws = await api.workbook.activeSheet();\n` +
            `  const used = await ws.usedRange();\n` +
            `  const seeded = await api.range("T75:V78");\n` +
            `  const inter = used ? used.intersect(seeded) : null;\n` +
            `  const covers = inter !== null && inter.address === seeded.address;\n` +
            `  await api.setCellValue(${RES2.row}, ${RES2.col}, covers ? "covers" : "miss-" + (used ? used.address : "empty"));\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the block's cell and Run", async () => {
        await retypeAndStore(page, editorPage, macroId, "T99", "T75", `range("T75")`);
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES2.row, RES2.col), { timeout: 90_000 })
            .not.toBe("");
        });
      });

      await test.step("RENDERED grid: region = T75:V78 (4x3), usedRange covers it", async () => {
        expect(
          await grid.getCellFormulaBarText(RES1.ref),
          "currentRegion found exactly the bordered block",
        ).toBe("T75:V78=4x3");
        expect(
          await grid.getCellFormulaBarText(RES2.ref),
          "usedRange().intersect(seeded) equals the seeded block",
        ).toBe("covers");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await clearPatch(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 3 — api.select renders; getSelection()/selection()/activeCell() agree
  // =========================================================================

  test("3. api.select('U65:V70') renders the selection; readback + activeCell agree", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} select ${stamp}`;
    const macroId = `macro-e2evba2-select-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await clearPatch(page);

      // The target address is TYPED into Monaco (seed is a non-address so a
      // stale run can never fake the assertion).
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba2Select",
          `  const target = "SEEDTARGET";\n` +
            `  await api.select(target);\n` +
            `  const selR = await api.selection();\n` +
            `  const sel = await api.getSelection();\n` +
            `  const ac = await api.activeCell();\n` +
            `  await api.setCellValue(${RES1.row}, ${RES1.col}, "sel-" + selR.address);\n` +
            `  await api.setCellValue(${RES2.row}, ${RES2.col}, "ac-" + ac.address + "-s" + sel.sheetIndex + "-n" + sel.areas.length);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the address and Run: the macro selects U65:V70", async () => {
        await retypeAndStore(page, editorPage, macroId, "SEEDTARGET", "U65:V70");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES2.row, RES2.col), { timeout: 90_000 })
            .not.toBe("");
        });
      });

      await test.step("the RENDERED selection is U65:V70 (the state the canvas paints from)", async () => {
        // Probe BEFORE any test-side click moves the selection. This is the
        // exact state object the canvas renderer draws the selection from.
        const rendered = await page.evaluate(() => {
          const s = (window as any).__CALCULA_GRID_STATE__?.selection;
          return s
            ? {
                startRow: s.startRow, startCol: s.startCol,
                endRow: s.endRow, endCol: s.endCol,
                type: s.type, extra: (s.additionalRanges ?? []).length,
              }
            : null;
        });
        expect(rendered, "the grid holds a selection").not.toBeNull();
        expect(rendered).toEqual({
          startRow: 64, startCol: 20, endRow: 69, endCol: 21, type: "cells", extra: 0,
        });
        // The block is scrolled into view and visibly marked — keep the pixels.
        await page.screenshot({
          path: "e2e/results/wave2-selection-rendered.png",
          fullPage: false,
        });
      });

      await test.step("readback + activeCell (the keystroke cell = selection end, V70)", async () => {
        // NOTE the product convention: Core's Selection treats END as the
        // active cell (useEditing guards typing on selection.endRow/endCol),
        // so after Range.Select the ActiveCell is the block's LAST cell —
        // deliberately self-consistent with the keyboard, unlike VBA's
        // top-left convention.
        expect(await grid.getCellFormulaBarText(RES1.ref), "selection() readback").toBe(
          "sel-U65:V70",
        );
        expect(
          await grid.getCellFormulaBarText(RES2.ref),
          "activeCell + sheet + area count",
        ).toBe("ac-V70-s0-n1");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await clearPatch(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 4 — the worksheet facet: rename / hide / show / delete, on the tab strip
  // =========================================================================

  test("4. ws = workbook.sheet(name): rename shows on the tab strip, hide removes it, delete removes the sheet", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} facet ${stamp}`;
    const macroId = `macro-e2evba2-facet-${stamp}`;

    const tabWith = (name: string) =>
      page.locator("button[data-sheet-tab]").filter({ hasText: name });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await deleteScratchSheets(page);

    try {
      await ensureSheet(page, SHEET_A);
      await activateSheetTrusted(page, 0);
      await clearPatch(page);

      // One macro, four modes; the MODE INDEX is what gets retyped between
      // runs (index 9 = seeded dead state; distinct digits everywhere else).
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba2Facet",
          `  const modes = ["rename", "hide", "show", "drop"];\n` +
            `  const mode = modes[9];\n` +
            `  let ws = await api.workbook.sheet("${SHEET_B}");\n` +
            `  if (!ws) ws = await api.workbook.sheet("${SHEET_A}");\n` +
            `  if (!ws) throw new Error("scratch sheet missing");\n` +
            `  if (mode === "rename") await ws.rename("${SHEET_B}");\n` +
            `  if (mode === "hide") await ws.setVisibility("hidden");\n` +
            `  if (mode === "show") await ws.setVisibility("visible");\n` +
            `  if (mode === "drop") await ws.delete();\n` +
            `  await api.setCellValue(${RES3.row}, ${RES3.col}, "done-" + mode);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("rename: the TAB STRIP shows the new name", async () => {
        await retypeAndStore(page, editorPage, macroId, "9", "0", "modes[0]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES3.row, RES3.col), { timeout: 90_000 })
            .toBe("done-rename");
        });
        await expect(tabWith(SHEET_B)).toHaveCount(1, { timeout: 15_000 });
        await expect(tabWith(SHEET_A)).toHaveCount(0);
      });

      await test.step("hide: the tab disappears (backend agrees: hidden)", async () => {
        await releaseTransientDebugMounts(page);
        await retypeAndStore(page, editorPage, macroId, "0", "1", "modes[1]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES3.row, RES3.col), { timeout: 90_000 })
            .toBe("done-hide");
        });
        await expect(tabWith(SHEET_B)).toHaveCount(0, { timeout: 15_000 });
        const { sheets } = await getSheets(page);
        expect(sheets.find((s) => s.name === SHEET_B)?.visibility).toBe("hidden");
      });

      await test.step("show: the tab comes back", async () => {
        await releaseTransientDebugMounts(page);
        await retypeAndStore(page, editorPage, macroId, "1", "2", "modes[2]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES3.row, RES3.col), { timeout: 90_000 })
            .toBe("done-show");
        });
        await expect(tabWith(SHEET_B)).toHaveCount(1, { timeout: 15_000 });
      });

      await test.step("delete: the sheet is gone (tab strip AND backend)", async () => {
        await releaseTransientDebugMounts(page);
        await retypeAndStore(page, editorPage, macroId, "2", "3", "modes[3]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES3.row, RES3.col), { timeout: 90_000 })
            .toBe("done-drop");
        });
        await expect(tabWith(SHEET_B)).toHaveCount(0, { timeout: 15_000 });
        const { sheets } = await getSheets(page);
        expect(sheets.some((s) => s.name === SHEET_B || s.name === SHEET_A)).toBe(false);
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await clearPatch(page).catch(() => {});
      await deleteScratchSheets(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 5 — clearRange: contents keeps formats; all clears both
  // =========================================================================

  test("5. clearRange 'contents' clears values but KEEPS formats; 'all' clears both", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} clear ${stamp}`;
    const macroId = `macro-e2evba2-clear-${stamp}`;
    const CELL = { ref: "T90", row: CLR.startRow, col: CLR.startCol };

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await clearPatch(page);
      // Values + BOLD on T90:U91 through the product's own formatting entry.
      await seedCellsDirect(page, [
        { row: 89, col: 19, value: "7" },
        { row: 89, col: 20, value: "8" },
        { row: 90, col: 19, value: "7" },
        { row: 90, col: 20, value: "8" },
      ]);
      await page.evaluate(async () => {
        const api: any = await (window as any).__calcImport(
          new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
        );
        await api.applyFormatting([89, 90], [19, 20], { bold: true });
        window.dispatchEvent(new Event("grid:refresh"));
      });
      await page.waitForTimeout(200);
      expect(await grid.getCellStyleProp(CELL.ref, "bold"), "precondition: bold seeded").toBe(true);
      expect(await readActiveCell(page, CELL.row, CELL.col), "precondition: value seeded").toBe("7");

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba2Clear",
          `  const modes = ["contents", "all"];\n` +
            `  const mode = modes[9];\n` +
            `  await api.clearRange(${CLR.startRow}, ${CLR.startCol}, ${CLR.endRow}, ${CLR.endCol}, { applyTo: mode });\n` +
            `  await api.setCellValue(${RES3.row}, ${RES3.col}, "cleared-" + mode);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("clearContents: values gone, FORMATS INTACT", async () => {
        await retypeAndStore(page, editorPage, macroId, "9", "0", "modes[0]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES3.row, RES3.col), { timeout: 90_000 })
            .toBe("cleared-contents");
        });
        expect(await readActiveCell(page, CELL.row, CELL.col), "value cleared").toBe("");
        expect(await readActiveCell(page, 90, 20), "whole range cleared").toBe("");
        expect(
          await grid.getCellStyleProp(CELL.ref, "bold"),
          "bold SURVIVED the contents clear",
        ).toBe(true);
        // Rendered proof formats live on: retype a value, the grid shows it bold.
        await grid.setCellValueDirect(CELL.ref, "9");
        expect(await grid.getCellStyleProp(CELL.ref, "bold")).toBe(true);
        expect(await grid.getCellFormulaBarText(CELL.ref)).toBe("9");
      });

      await test.step("clear all: value AND format gone", async () => {
        await releaseTransientDebugMounts(page);
        await retypeAndStore(page, editorPage, macroId, "0", "1", "modes[1]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES3.row, RES3.col), { timeout: 90_000 })
            .toBe("cleared-all");
        });
        expect(await readActiveCell(page, CELL.row, CELL.col), "value cleared again").toBe("");
        expect(
          await grid.getCellStyleProp(CELL.ref, "bold"),
          "bold cleared by applyTo 'all'",
        ).toBe(false);
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await clearPatch(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 6 — intersect() as an onDataChange guard: fires inside, never outside
  // =========================================================================

  test("6. an intersect(U80:U85) guard fires exactly once for an inside edit, never outside", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const scriptId = `e2evba2-guard-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await clearPatch(page);

      // A real SHEET script (onDataChange belongs to the sheet object),
      // mounted through the public ObjectScriptManager door. The guard is the
      // shipped worker-side range algebra: build the watch range once, then
      // intersect() it with each changed cell.
      const source =
        `function setup(context) {\n` +
        `  let fired = 0;\n` +
        `  let guardPromise = null;\n` +
        `  context.onDataChange(async (payload) => {\n` +
        `    if (!guardPromise) guardPromise = context.api.range("U80:U85");\n` +
        `    const guard = await guardPromise;\n` +
        `    let hit = false;\n` +
        `    for (const ch of payload.changes) {\n` +
        `      const cell = { startRow: ch.row, startCol: ch.col, endRow: ch.row, endCol: ch.col };\n` +
        `      if (guard.intersect(cell) !== null) hit = true;\n` +
        `    }\n` +
        `    if (hit) {\n` +
        `      fired = fired + 1;\n` +
        `      await context.api.setCellValue(${GUARD_MARKER.row}, ${GUARD_MARKER.col}, "hit" + fired);\n` +
        `    }\n` +
        `  });\n` +
        `}\n`;

      await test.step("mount the guarded sheet script", async () => {
        await page.evaluate(
          async ({ scriptId, source }) => {
            const so: any = await (window as any).__calcImport(
              new URL("/src/api/scriptableObjects.ts", document.baseURI).href,
            );
            so.ObjectScriptManager.registerScript({
              id: scriptId,
              name: "E2EVbaWave2 intersect guard",
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
        await page.waitForTimeout(1_500);
      });

      await test.step("a USER edit INSIDE U80:U85 fires the guard exactly once", async () => {
        await grid.setCellValue(EDIT_INSIDE.ref, "5");
        await expect
          .poll(async () => readActiveCell(page, GUARD_MARKER.row, GUARD_MARKER.col), {
            timeout: 30_000,
          })
          .toBe("hit1");
        // Settle window: neither the marker write nor anything else re-fires.
        const deadline = Date.now() + 4_000;
        let samples = 0;
        while (Date.now() < deadline) {
          const v = await readActiveCell(page, GUARD_MARKER.row, GUARD_MARKER.col);
          samples++;
          expect(v, `guard fired more than once (sample ${samples})`).toBe("hit1");
          await page.waitForTimeout(250);
        }
        expect(samples).toBeGreaterThan(3);
      });

      await test.step("a USER edit OUTSIDE the guard never fires it", async () => {
        await grid.setCellValue(EDIT_OUTSIDE.ref, "7");
        // The edit itself lands (so the pipeline ran)...
        await expect
          .poll(async () => readActiveCell(page, EDIT_OUTSIDE.row, EDIT_OUTSIDE.col), {
            timeout: 30_000,
          })
          .toBe("7");
        // ...and across a settle window the marker never moves.
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
          expect(await readActiveCell(page, GUARD_MARKER.row, GUARD_MARKER.col)).toBe("hit1");
          await page.waitForTimeout(250);
        }
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
      await activateSheetTrusted(page, 0).catch(() => {});
      await clearPatch(page).catch(() => {});
    }
  });
});
