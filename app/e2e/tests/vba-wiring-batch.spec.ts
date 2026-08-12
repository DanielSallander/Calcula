/**
 * THE VBA-PARITY TAIL, proved live against the real app.
 *
 * This is the last batch of the VBA-idiom parity program (waves 1-4 shipped the
 * rest): `api.withUnprotected`, Scenarios, Consolidate, the range sugar
 * (`entireRow`/`rows(i)`/`cells(r,c)`) with multi-area `api.range("..,..")`,
 * the unit options on `setRowHeight`/`setColumnWidth` — and the dirty-flag
 * forcing function that every new Tauri command must honour.
 *
 * Everything here runs as a REAL macro: seeded into the module store, opened in
 * the Object Script Editor, the DECISIVE TOKEN RETYPED with real keystrokes,
 * then Run from the toolbar. The seeded token is always one that makes the
 * macro FAIL (a wrong password, a non-address, an unknown unit), so a stale run
 * or a mis-wired editor can never produce a green result. Assertions are made
 * on the RENDERED outcome — the grid's own cell values, the app's own
 * protection dialog, the dimensions the canvas measures from — never only on
 * the return value of the call under test.
 *
 * THE CLAIMS (one test each, self-contained, cleaned up in a finally):
 *
 *  1. withUnprotected — the SAFETY property, not the happy path.
 *     (a) On a password-protected sheet a macro's plain write is REFUSED and
 *         the same write inside withUnprotected LANDS.
 *     (b) The decisive one: a macro whose `fn` THROWS inside withUnprotected
 *         leaves the sheet PROTECTED AGAIN — proved by the app's own
 *         protection dialog refusing a REAL user edit (typed keystrokes) and
 *         the cell staying empty.
 *     (c) A wrong password never runs `fn` and leaves the sheet protected.
 *  2. Scenarios — add with changing cells, list, show (the RENDERED values
 *     change to the scenario's, and a dependent formula recalculates), delete,
 *     and the list no longer has it.
 *  3. Consolidate — two seeded blocks combined with SUM into a destination;
 *     the RENDERED sums are asserted cell by cell.
 *  4. Sugar + multi-area — cells(r,c)/rows(i)/entireRow() write real values;
 *     a multi-area range fans `format` out to BOTH areas and writes through
 *     `areas[i]`; and the documented unsupported op (`setValues` on the
 *     multi-area facet) FAILS LOUDLY — a TypeError — instead of quietly
 *     hitting area one, which is proved by area one still holding its own
 *     value afterwards.
 *  5. Unit options — a row height in POINTS and a column width in CHARS land
 *     as the documented pixel geometry (px = pt * 96/72, px = chars * 7 + 5),
 *     read back BOTH from the backend and from the dimension maps the canvas
 *     renders from; an unknown unit is REJECTED rather than defaulting to px.
 *  6. Dirty flag — with a control: after a save the document is clean, a macro
 *     that touches no document state leaves it clean, and a macro that only
 *     calls scenarioAdd (which writes no cells at all) makes it DIRTY. That is
 *     the forcing function: a command that forgot its DocumentEffect arm would
 *     leave the document looking saved.
 *
 * SHARED APP. This spec's private patch is columns AW..BD (48-55), rows
 * 120-165 — a fresh area (K, L, N, P, R, T-Z, AA-AD, AE-AV are claimed by
 * other specs). Row 160 and column BC are the only geometry it resizes, both
 * far outside the default viewport every screenshot golden captures, and both
 * restored in the finally.
 *
 * TEST 6 SAVES THE DOCUMENT to a temp path to get a clean baseline. It does not
 * wipe or reopen it — the workbook, its cells and every golden stay exactly as
 * they were — so this file belongs in the functional project, not `journeys`.
 *
 * LOCALE. sv-SE: ';' is the argument separator. The only formula typed here is
 * "=AW131+AW132", which has none.
 */
import type { Page } from "@playwright/test";
import * as os from "os";
import * as path from "path";
import { test, expect } from "../fixtures";
import { liveState, retypeAndStore } from "../helpers/macroEditor";

const NAME_PREFIX = "E2EVbaWiring";
const ID_PREFIX = "macro-e2evbaw-";
const EDITOR_LABEL = "object-script-editor";
const SHEET_PASSWORD = "wiring-batch-2026";
const CLEAN_FILE = path.join(os.tmpdir(), "calcula-vba-wiring-batch.cala");

// Columns: AW=48 AX=49 AY=50 AZ=51 BA=52 BB=53 BC=54 BD=55
const C = { AW: 48, AX: 49, AY: 50, AZ: 51, BA: 52, BB: 53, BC: 54, BD: 55 };
/** The whole private patch, cleared before and after every test. */
const PATCH = { startRow: 119, startCol: 48, endRow: 165, endCol: 55 };
/** The only geometry this spec resizes (both off the default viewport). */
const DIM_ROW = 159; // row 160
const DIM_COL = C.BC;

// ---------------------------------------------------------------------------
// Backend readers/writers — setup + assertions, never the thing under test.
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

/** A cell's DISPLAY text straight from the backend (what the grid paints). */
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

async function allowScripts(page: Page): Promise<void> {
  await invoke(page, "set_script_security_level", { level: "enabled" });
}

async function isSheetProtected(page: Page): Promise<boolean> {
  return invoke<boolean>(page, "is_sheet_protected", {});
}

/** Every scenario name on the active sheet, read from the backend. */
async function scenarioNames(page: Page): Promise<string[]> {
  const res = await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    const sheets: any = await tauri.core.invoke("get_sheets");
    const list: any = await tauri.core.invoke("scenario_list", {
      sheetIndex: sheets.activeIndex,
    });
    return (list?.scenarios ?? []).map((s: any) => String(s.name));
  });
  return res as string[];
}

/** The backend's stored pixel geometry for one row / one column. */
async function backendDimensions(
  page: Page,
  row: number,
  col: number,
): Promise<{ rowHeight: number | null; colWidth: number | null }> {
  return page.evaluate(
    async ({ row, col }) => {
      const tauri = (window as any).__TAURI__;
      const widths: Array<{ index: number; size: number }> =
        await tauri.core.invoke("get_all_column_widths");
      const heights: Array<{ index: number; size: number }> =
        await tauri.core.invoke("get_all_row_heights");
      const w = widths.find((d) => d.index === col);
      const h = heights.find((d) => d.index === row);
      return { rowHeight: h ? h.size : null, colWidth: w ? w.size : null };
    },
    { row, col },
  );
}

/** The dimension maps the CANVAS renders from (core GridState). */
async function renderedDimensions(
  page: Page,
  row: number,
  col: number,
): Promise<{ rowHeight: number | null; colWidth: number | null }> {
  return page.evaluate(
    ({ row, col }) => {
      const gs = (window as any).__CALCULA_GRID_STATE__;
      const rh = gs?.dimensions?.rowHeights;
      const cw = gs?.dimensions?.columnWidths;
      return {
        rowHeight: rh && rh.has(row) ? rh.get(row) : null,
        colWidth: cw && cw.has(col) ? cw.get(col) : null,
      };
    },
    { row, col },
  );
}

/** Restore everything this spec can disturb, then clear its patch. */
async function restoreDocState(page: Page): Promise<void> {
  await page.evaluate(
    async ({ patch, dimRow, dimCol, prefix, password }) => {
      const tauri = (window as any).__TAURI__;
      // Protection FIRST: nothing below can write into a protected sheet.
      try {
        await tauri.core.invoke("unprotect_sheet", { password });
      } catch {
        /* not protected, or no password */
      }
      try {
        await tauri.core.invoke("unprotect_sheet", {});
      } catch {
        /* already open */
      }
      // Scenarios this spec creates.
      try {
        const sheets: any = await tauri.core.invoke("get_sheets");
        const list: any = await tauri.core.invoke("scenario_list", {
          sheetIndex: sheets.activeIndex,
        });
        for (const s of list?.scenarios ?? []) {
          if (String(s.name).startsWith(prefix)) {
            await tauri.core
              .invoke("scenario_delete", {
                params: { name: s.name, sheetIndex: sheets.activeIndex },
              })
              .catch(() => {});
          }
        }
      } catch {
        /* no scenarios */
      }
      // Geometry back to the sheet defaults.
      try {
        const defaults: any = await tauri.core.invoke("get_default_dimensions");
        await tauri.core.invoke("set_row_height", {
          row: dimRow,
          height: defaults.defaultRowHeight,
        });
        await tauri.core.invoke("set_column_width", {
          col: dimCol,
          width: defaults.defaultColumnWidth,
        });
      } catch {
        /* ok */
      }
      try {
        await tauri.core.invoke("clear_range_with_options", {
          params: {
            startRow: patch.startRow,
            startCol: patch.startCol,
            endRow: patch.endRow,
            endCol: patch.endCol,
            applyTo: "all",
          },
        });
      } catch {
        /* ok */
      }
      window.dispatchEvent(new CustomEvent("dimensions:refresh"));
      window.dispatchEvent(new Event("grid:refresh"));
      window.dispatchEvent(new CustomEvent("protection:refresh"));
    },
    {
      patch: PATCH,
      dimRow: DIM_ROW,
      dimCol: DIM_COL,
      prefix: NAME_PREFIX,
      password: SHEET_PASSWORD,
    },
  );
  await page.waitForTimeout(350);
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

/** Remove every module script this spec created. Idempotent. */
async function cleanup(page: Page): Promise<void> {
  await releaseTransientDebugMounts(page);
  await page.evaluate(
    async ({ prefix, idPrefix }) => {
      const tauri = (window as any).__TAURI__;
      try {
        const modules: Array<{ id: string; name: string }> =
          await tauri.core.invoke("list_scripts");
        for (const m of modules) {
          if ((m.name && m.name.startsWith(prefix)) || (m.id && m.id.startsWith(idPrefix))) {
            await tauri.core.invoke("delete_script", { id: m.id }).catch(() => {});
          }
        }
      } catch {
        /* no module store */
      }
    },
    { prefix: NAME_PREFIX, idPrefix: ID_PREFIX },
  );
  await page.waitForTimeout(150);
}

// ---------------------------------------------------------------------------
// The Object Script Editor window (same access pattern as vba-idioms-wave4)
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

function toolbarButton(editorPage: Page, label: "Run" | "Debug" | "Stop") {
  return editorPage
    .locator("button.ose-btn")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first();
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

/** Seed a macro, open it in the editor, retype its decisive token, Run it. */
async function typeAndRun(
  page: Page,
  grid: any,
  opts: { id: string; name: string; from: string; to: string; expectStored?: string },
): Promise<Page> {
  const editorPage = await openMacroInEditor(page, grid, opts.name);
  await expect(documentSelect(editorPage)).toHaveValue(opts.id, { timeout: 20_000 });
  await retypeAndStore(page, editorPage, opts.id, opts.from, opts.to, opts.expectStored);
  await toolbarButton(editorPage, "Run").click();
  return editorPage;
}

// ---------------------------------------------------------------------------
// Sheet protection through the REAL Review ▸ Protect Sheet dialog. Going
// through the product's own door is what keeps the Protection extension's
// cached flag — the thing its edit guard reads — in step with the backend.
// ---------------------------------------------------------------------------

async function protectSheetViaDialog(page: Page, grid: any, password: string): Promise<void> {
  await grid.openMenu("Review");
  const item = page.locator("button").filter({ hasText: /^Protect Sheet/ }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click();
  const dialog = page.locator("[role='dialog']").filter({ hasText: "Protect Sheet" }).first();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const inputs = dialog.locator("input[type='password']");
  await inputs.first().fill(password);
  await expect(inputs).toHaveCount(2, { timeout: 5_000 });
  await inputs.nth(1).fill(password);
  await dialog.locator("button").filter({ hasText: /^OK$/ }).first().click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await page.waitForTimeout(300);
  expect(await isSheetProtected(page), "the sheet really is protected now").toBe(true);
}

// ===========================================================================

test.describe("VBA wiring batch (live, through the editor)", () => {
  // =========================================================================
  // CLAIM 1 — withUnprotected: the safety property
  // =========================================================================

  test("1. withUnprotected lifts and RESTORES: a throwing fn leaves the sheet protected (a real user edit is refused), and a wrong password never runs fn", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(900_000);

    const stamp = Date.now().toString(36);
    const okName = `${NAME_PREFIX} wuok ${stamp}`;
    const okId = `${ID_PREFIX}wuok-${stamp}`;
    const throwName = `${NAME_PREFIX} wuthrow ${stamp}`;
    const throwId = `${ID_PREFIX}wuthrow-${stamp}`;
    const wrongName = `${NAME_PREFIX} wuwrong ${stamp}`;
    const wrongId = `${ID_PREFIX}wuwrong-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);

      // (a) writes outside the lift are refused, inside it they land.
      await seedMacro(page, {
        id: okId,
        name: okName,
        source: macroSource(
          okName,
          "e2eWiringWuOk",
          `  const pw = "SEEDPASSWORD";\n` +
            `  let outside = "allowed";\n` +
            `  try {\n` +
            `    await api.setCellValue(120, ${C.AX}, "outside-write");\n` +
            `  } catch (e) {\n` +
            `    outside = "refused";\n` +
            `  }\n` +
            `  await api.withUnprotected(pw, async () => {\n` +
            `    await api.setCellValue(120, ${C.AW}, "wu-ok");\n` +
            `    await api.setCellValue(120, ${C.AY}, outside);\n` +
            `  });\n`,
        ),
      });
      // (b) fn THROWS inside the lift.
      await seedMacro(page, {
        id: throwId,
        name: throwName,
        source: macroSource(
          throwName,
          "e2eWiringWuThrow",
          `  const pw = "SEEDPASSWORD";\n` +
            `  await api.withUnprotected(pw, async () => {\n` +
            `    await api.setCellValue(120, ${C.AZ}, "throw-inside");\n` +
            `    throw new Error("e2e-wiring-boom");\n` +
            `  });\n`,
        ),
      });
      // (c) a wrong password: fn never runs, the sheet stays protected. The
      //     verdict is reported through a SECOND, correct lift — on a still
      //     protected sheet there is no other way to write it down, which is
      //     itself part of the proof.
      await seedMacro(page, {
        id: wrongId,
        name: wrongName,
        source: macroSource(
          wrongName,
          "e2eWiringWuWrong",
          `  const pw = "SEEDPASSWORD";\n` +
            `  let ran = "no";\n` +
            `  let err = "none";\n` +
            `  try {\n` +
            `    await api.withUnprotected("definitely-not-the-password", async () => {\n` +
            `      ran = "yes";\n` +
            `    });\n` +
            `  } catch (e) {\n` +
            `    err = (e && e.message) ? e.message : String(e);\n` +
            `  }\n` +
            // ScriptProtectionStatus names the flag `protected`, not
            // `isProtected` (that is the @api/lib spelling one layer down).
            `  const st = await api.getProtectionStatus();\n` +
            `  await api.withUnprotected(pw, async () => {\n` +
            `    await api.setCellValue(120, ${C.BA}, "ran:" + ran + "|still:" + st.protected);\n` +
            `    await api.setCellValue(120, ${C.BB}, err);\n` +
            `  });\n`,
        ),
      });

      await protectSheetViaDialog(page, grid, SHEET_PASSWORD);

      await test.step("(a) the write outside the lift is REFUSED; the writes inside it LAND", async () => {
        const editorPage = await typeAndRun(page, grid, {
          id: okId,
          name: okName,
          from: "SEEDPASSWORD",
          to: SHEET_PASSWORD,
          expectStored: `pw = "${SHEET_PASSWORD}"`,
        });
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readCell(page, 120, C.AW), { timeout: 120_000 })
            .toBe("wu-ok");
        });
        expect(await readCell(page, 120, C.AY), "the plain write was refused").toBe("refused");
        expect(await readCell(page, 120, C.AX), "and it really never landed").toBe("");
        expect(await isSheetProtected(page), "the sheet is protected again after the run").toBe(
          true,
        );
        // RENDERED: the value the macro wrote under the lift is on the grid.
        expect(await grid.getCellFormulaBarText("AW121")).toBe("wu-ok");
        await destroyEditorWindow(page);
        await releaseTransientDebugMounts(page);
      });

      await test.step("(b) a THROWING fn still re-protects the sheet", async () => {
        const editorPage = await typeAndRun(page, grid, {
          id: throwId,
          name: throwName,
          from: "SEEDPASSWORD",
          to: SHEET_PASSWORD,
          expectStored: `pw = "${SHEET_PASSWORD}"`,
        });
        // fn really ran with the protection lifted...
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readCell(page, 120, C.AZ), { timeout: 120_000 })
            .toBe("throw-inside");
        });
        // ...and then threw, which the editor says out loud in its DEBUGGER
        // panel. (Not the console: a macro is Run by firing its function as a
        // debug trigger, and over the editor window's remote bridge the fire is
        // one-way — the script's own throw comes back as the state broadcast
        // that feeds this line, which is why the console only ever shows
        // "Running …()". Verified against DebugPanel.tsx, not guessed.)
        await expect
          .poll(
            async () => {
              const line = editorPage.getByText(/^Debugger: /).first();
              return (await line.count()) > 0 ? line.innerText() : "";
            },
            { timeout: 60_000 },
          )
          .toContain("e2e-wiring-boom");
        await destroyEditorWindow(page);
        await releaseTransientDebugMounts(page);
        await page.waitForTimeout(500);

        expect(
          await isSheetProtected(page),
          "the backend flag: protection is BACK after the throw",
        ).toBe(true);
      });

      await test.step("the app's own protection dialog refuses a REAL user edit", async () => {
        await grid.navigateTo("AW122");
        // ONE keystroke, and deliberately NO Enter. Protection refuses at the
        // KEYPRESS (registerEditGuard), Excel-style — the inline editor never
        // opens — and the warning dialog autoFocuses its OK button, so an Enter
        // here would be typed INTO the dialog and dismiss the very thing being
        // asserted. (Measured live: after "u" there is 1 alertdialog and
        // editing===false; after Enter there are 0.)
        await page.keyboard.press("u");
        const warning = page.locator("[role='alertdialog']");
        await expect(warning, "the protection warning is on screen").toBeVisible({
          timeout: 10_000,
        });
        await expect(warning).toContainText("protected sheet");
        expect(
          await page.evaluate(() => Boolean((window as any).__CALCULA_GRID_STATE__?.editing)),
          "the cell never even entered edit mode",
        ).toBe(false);
        await warning.locator("button").filter({ hasText: /^OK$/ }).first().click();
        await expect(warning).toBeHidden({ timeout: 5_000 });
        expect(await readCell(page, 121, C.AW), "the user's edit never committed").toBe("");
      });

      await test.step("(c) a wrong password does not run fn and leaves the sheet protected", async () => {
        const editorPage = await typeAndRun(page, grid, {
          id: wrongId,
          name: wrongName,
          from: "SEEDPASSWORD",
          to: SHEET_PASSWORD,
          expectStored: `pw = "${SHEET_PASSWORD}"`,
        });
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readCell(page, 120, C.BA), { timeout: 120_000 })
            .toBe("ran:no|still:true");
        });
        const msg = await readCell(page, 120, C.BB);
        expect(msg, "the refusal says the password is wrong").toContain("password is wrong");
        expect(msg, "...and that nothing was run").toContain("nothing was run");
        expect(await isSheetProtected(page)).toBe(true);
        await destroyEditorWindow(page);
        await releaseTransientDebugMounts(page);
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 2 — Scenarios: add / list / show / delete
  // =========================================================================

  test("2. a macro adds a scenario, lists it, SHOWS it (the rendered values and a dependent formula change), then deletes it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(900_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} scen ${stamp}`;
    const macroId = `${ID_PREFIX}scen-${stamp}`;
    const scenarioName = `${NAME_PREFIX} Best ${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);
      await seedCells(page, [
        { row: 130, col: C.AW, value: "100" },
        { row: 131, col: C.AW, value: "200" },
        { row: 132, col: C.AW, value: "=AW131+AW132" },
      ]);
      expect(await readCell(page, 132, C.AW), "precondition: the dependent formula").toBe("300");

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eWiringScenarios",
          `  const nm = ${JSON.stringify(scenarioName)};\n` +
            `  await api.scenarioAdd({\n` +
            `    name: nm,\n` +
            `    changingCells: "SEEDADDRESS",\n` +
            `    values: [1000, 2500],\n` +
            `    comment: "e2e wiring batch",\n` +
            `  });\n` +
            `  const listed = (await api.scenarios()).filter((s) => s.name === nm);\n` +
            `  await api.setCellValue(130, ${C.BD},\n` +
            `    "listed:" + listed.length + ":" + (listed[0] ? listed[0].changingCells.length : 0) +\n` +
            `    ":" + (listed[0] ? listed[0].comment : ""));\n` +
            `  const shown = await api.scenarioShow(nm);\n` +
            `  await api.setCellValue(131, ${C.BD}, "shown:" + shown.cellsUpdated);\n` +
            `  const del = await api.scenarioDelete(nm);\n` +
            `  const after = (await api.scenarios()).filter((s) => s.name === nm);\n` +
            `  await api.setCellValue(132, ${C.BD}, "deleted:" + del.deleted + ":" + after.length);\n`,
        ),
      });

      const editorPage = await typeAndRun(page, grid, {
        id: macroId,
        name: macroName,
        from: "SEEDADDRESS",
        to: "AW131:AW132",
      });

      await withEditorConsole(editorPage, async () => {
        await expect
          .poll(async () => readCell(page, 132, C.BD), { timeout: 120_000 })
          .toBe("deleted:true:0");
      });

      expect(
        await readCell(page, 130, C.BD),
        "it was listed, with its 2 changing cells and its comment",
      ).toBe("listed:1:2:e2e wiring batch");
      // THREE, not two: `cellsUpdated` counts what scenario_show actually
      // wrote — both changing cells AND the dependent formula it recalculated
      // (AW133). That is the recalc arriving in the answer, not an off-by-one.
      expect(
        await readCell(page, 131, C.BD),
        "showing it updated both changing cells and recalculated the dependent",
      ).toBe("shown:3");

      // THE RENDERED PROOF: the scenario's values are what the grid now shows,
      // and the dependent formula recalculated to match.
      expect(await grid.getCellFormulaBarText("AW131")).toBe("1000");
      expect(await grid.getCellFormulaBarText("AW132")).toBe("2500");
      expect(await readCell(page, 132, C.AW), "the dependent formula recalculated").toBe("3500");
      expect(
        await grid.getCellFormulaBarText("AW133"),
        "and it is still a formula, not an overwritten constant",
      ).toBe("=AW131+AW132");

      // ...and the backend list agrees it is gone.
      expect(await scenarioNames(page)).not.toContain(scenarioName);

      await destroyEditorWindow(page);
      await releaseTransientDebugMounts(page);
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 3 — Consolidate
  // =========================================================================

  test("3. a macro consolidates two blocks with SUM and the rendered destination holds the sums", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(900_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} cons ${stamp}`;
    const macroId = `${ID_PREFIX}cons-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);
      // Block A: AW141:AX142  Block B: AZ141:BA142 (same shape -> by position)
      await seedCells(page, [
        { row: 140, col: C.AW, value: "1" },
        { row: 140, col: C.AX, value: "2" },
        { row: 141, col: C.AW, value: "3" },
        { row: 141, col: C.AX, value: "4" },
        { row: 140, col: C.AZ, value: "10" },
        { row: 140, col: C.BA, value: "20" },
        { row: 141, col: C.AZ, value: "30" },
        { row: 141, col: C.BA, value: "40" },
      ]);

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eWiringConsolidate",
          `  const dest = "SEEDDESTINATION";\n` +
            `  const r = await api.consolidate({\n` +
            `    function: "sum",\n` +
            `    sources: ["AW141:AX142", "AZ141:BA142"],\n` +
            `    destination: dest,\n` +
            `  });\n` +
            `  await api.setCellValue(144, ${C.BD},\n` +
            `    "cons:" + r.rowsWritten + "x" + r.colsWritten + ":" + r.cellsUpdated);\n`,
        ),
      });

      const editorPage = await typeAndRun(page, grid, {
        id: macroId,
        name: macroName,
        from: "SEEDDESTINATION",
        to: "AW145",
      });

      await withEditorConsole(editorPage, async () => {
        await expect
          .poll(async () => readCell(page, 144, C.BD), { timeout: 120_000 })
          .toBe("cons:2x2:4");
      });

      // THE RENDERED SUMS, cell by cell — the display strings the canvas
      // paints, plus one formula-bar read of the DOM the user actually looks at.
      expect(await readCell(page, 144, C.AW)).toBe("11");
      expect(await readCell(page, 144, C.AX)).toBe("22");
      expect(await readCell(page, 145, C.AW)).toBe("33");
      expect(await readCell(page, 145, C.AX)).toBe("44");
      expect(await grid.getCellFormulaBarText("AX146")).toBe("44");
      // ...and nothing bled outside the 2x2 destination block.
      expect(await readCell(page, 144, C.AY), "no third column").toBe("");
      expect(await readCell(page, 146, C.AW), "no third row").toBe("");

      await destroyEditorWindow(page);
      await releaseTransientDebugMounts(page);
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 4 — the range sugar and the multi-area facet
  // =========================================================================

  test("4. cells(r,c)/rows(i)/entireRow() write real cells, a multi-area range fans format+writes across BOTH areas, and setValues on it fails LOUDLY", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(900_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} sugar ${stamp}`;
    const macroId = `${ID_PREFIX}sugar-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eWiringSugar",
          // The multi-area address is resolved FIRST, so the seeded token
          // aborts the whole macro before a single cell is written.
          `  const areasAddr = "SEEDMULTIAREA";\n` +
            `  const m = await api.range(areasAddr);\n` +
            `  await api.setCellValue(150, ${C.BD},\n` +
            `    "areas:" + m.count + ":" + m.address + ":" + m.cellCount);\n` +
            // --- the sugar: cells(r,c) and rows(i) on a rectangle -------------
            `  const r = await api.range("AW151:AY153");\n` +
            `  await r.cells(0, 0).setValue("c00");\n` +
            `  await r.cells(2, 2).setValue("c22");\n` +
            `  await r.rows(1).setValues([["r10", "r11", "r12"]]);\n` +
            // --- entireRow(): the whole sheet width of row 152 ---------------
            `  const er = (await api.range("AX152")).entireRow();\n` +
            `  await api.setCellValue(151, ${C.BD},\n` +
            `    "er:" + er.address + ":" + er.rowCount + "x" + er.colCount);\n` +
            // --- per-area writes + a fanned-out format -----------------------
            `  for (let i = 0; i < m.areas.length; i++) {\n` +
            `    await m.areas[i].setValues([["a" + i + "-0"], ["a" + i + "-1"]]);\n` +
            `  }\n` +
            `  await m.format({ backgroundColor: "#FFF2CC" });\n` +
            // --- the unsupported op must fail LOUDLY -------------------------
            `  let loud = "silent";\n` +
            `  try {\n` +
            `    await m.setValues([[["x"]]]);\n` +
            `  } catch (e) {\n` +
            `    loud = (e && e.name ? e.name : "Error") + "|" + (e && e.message ? e.message : String(e));\n` +
            `  }\n` +
            `  await api.setCellValue(152, ${C.BD}, "loud:" + loud);\n`,
        ),
      });

      const editorPage = await typeAndRun(page, grid, {
        id: macroId,
        name: macroName,
        from: "SEEDMULTIAREA",
        to: "BA151:BA152,BC151:BC152",
      });

      await withEditorConsole(editorPage, async () => {
        await expect
          .poll(async () => readCell(page, 152, C.BD), { timeout: 120_000 })
          .toContain("loud:");
      });

      await test.step("the sugar wrote the cells it names", async () => {
        expect(await grid.getCellFormulaBarText("AW151")).toBe("c00");
        expect(await grid.getCellFormulaBarText("AY153")).toBe("c22");
        expect(await grid.getCellFormulaBarText("AW152")).toBe("r10");
        expect(await grid.getCellFormulaBarText("AX152")).toBe("r11");
        expect(await grid.getCellFormulaBarText("AY152")).toBe("r12");
        // ...and nothing outside the named cells.
        expect(await readCell(page, 150, C.AX), "cells(0,0) touched one cell only").toBe("");
      });

      await test.step("entireRow() really is the whole sheet width", async () => {
        expect(await readCell(page, 151, C.BD)).toBe("er:A152:XFD152:1x16384");
      });

      await test.step("the multi-area range describes itself and writes through both areas", async () => {
        expect(await readCell(page, 150, C.BD)).toBe(
          "areas:2:BA151:BA152,BC151:BC152:4",
        );
        expect(await grid.getCellFormulaBarText("BA151")).toBe("a0-0");
        expect(await grid.getCellFormulaBarText("BA152")).toBe("a0-1");
        expect(await grid.getCellFormulaBarText("BC151")).toBe("a1-0");
        expect(await grid.getCellFormulaBarText("BC152")).toBe("a1-1");
        // format() fanned out to BOTH areas, not just the first.
        expect(
          (await grid.getCellStyleStringProp("BA152", "backgroundColor")).toUpperCase(),
        ).toBe("#FFF2CC");
        expect(
          (await grid.getCellStyleStringProp("BC151", "backgroundColor")).toUpperCase(),
        ).toBe("#FFF2CC");
      });

      await test.step("setValues on the multi-area facet FAILS LOUDLY, and area one is untouched", async () => {
        const loud = await readCell(page, 152, C.BD);
        expect(loud, "it threw rather than silently doing something").not.toBe("loud:silent");
        expect(loud, "a TypeError: the method is simply not there").toContain("TypeError");
        expect(loud).toContain("setValues");
        // THE POINT: it did not quietly hit area one.
        expect(await grid.getCellFormulaBarText("BA151")).toBe("a0-0");
        expect(await grid.getCellFormulaBarText("BC151")).toBe("a1-0");
      });

      await destroyEditorWindow(page);
      await releaseTransientDebugMounts(page);
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 5 — unit options on setRowHeight / setColumnWidth
  // =========================================================================

  test("5. a row height in POINTS and a column width in CHARS land as the documented pixel geometry, and an unknown unit is refused", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(900_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} units ${stamp}`;
    const macroId = `${ID_PREFIX}units-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eWiringUnits",
          `  const rowUnit = "SEEDUNIT";\n` +
            `  await api.setRowHeight(${DIM_ROW}, 30, { unit: rowUnit });\n` +
            `  await api.setColumnWidth(${DIM_COL}, 8.43, { unit: "chars" });\n` +
            `  let refused = "accepted";\n` +
            `  try {\n` +
            `    await api.setRowHeight(${DIM_ROW}, 30, { unit: "em" });\n` +
            `  } catch (e) {\n` +
            `    refused = (e && e.message) ? e.message : String(e);\n` +
            `  }\n` +
            `  await api.setCellValue(160, ${C.BD}, "units-done");\n` +
            `  await api.setCellValue(161, ${C.BD}, refused);\n`,
        ),
      });

      const editorPage = await typeAndRun(page, grid, {
        id: macroId,
        name: macroName,
        from: "SEEDUNIT",
        to: "pt",
      });

      await withEditorConsole(editorPage, async () => {
        await expect
          .poll(async () => readCell(page, 160, C.BD), { timeout: 120_000 })
          .toBe("units-done");
      });

      await test.step("30pt is 40px and 8.43 chars is 64.01px, in the BACKEND", async () => {
        const dims = await backendDimensions(page, DIM_ROW, DIM_COL);
        expect(dims.rowHeight, "30pt * 96/72").toBeCloseTo(40, 3);
        expect(dims.colWidth, "8.43 chars * 7 + 5").toBeCloseTo(64.01, 3);
      });

      await test.step("...and in the dimension maps the CANVAS renders from", async () => {
        const dims = await renderedDimensions(page, DIM_ROW, DIM_COL);
        expect(dims.rowHeight).toBeCloseTo(40, 3);
        expect(dims.colWidth).toBeCloseTo(64.01, 3);
      });

      await test.step("an unknown unit is REFUSED, not silently treated as pixels", async () => {
        const refused = await readCell(page, 161, C.BD);
        expect(refused, "it threw").not.toBe("accepted");
        expect(refused).toContain("setRowHeight unit must be");
        expect(refused).toContain("em");
        // The refusal changed nothing: the row is still the 40px from the pt call.
        const dims = await backendDimensions(page, DIM_ROW, DIM_COL);
        expect(dims.rowHeight).toBeCloseTo(40, 3);
      });

      await destroyEditorWindow(page);
      await releaseTransientDebugMounts(page);
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 6 — the dirty flag, WITH A CONTROL
  // =========================================================================

  test("6. running a macro does not by itself dirty the document, but a macro that only calls scenarioAdd does", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(900_000);

    const stamp = Date.now().toString(36);
    const controlName = `${NAME_PREFIX} clean ${stamp}`;
    const controlId = `${ID_PREFIX}clean-${stamp}`;
    const dirtyName = `${NAME_PREFIX} dirty ${stamp}`;
    const dirtyId = `${ID_PREFIX}dirty-${stamp}`;
    const scenarioName = `${NAME_PREFIX} Dirt ${stamp}`;

    const isDirty = () => invoke<boolean>(page, "is_file_modified");
    /** Save to a scratch path so the document is CLEAN. Never wipes it. */
    const saveClean = async () => {
      await invoke(page, "save_file", { path: CLEAN_FILE });
      await page.waitForTimeout(600);
      expect(await isDirty(), "the save left the document clean").toBe(false);
    };

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);
      await seedCells(page, [{ row: 130, col: C.AW, value: "100" }]);

      // THE CONTROL: a macro that touches no document state at all. Its only
      // observable is the status bar, which is frontend-only session chrome.
      await seedMacro(page, {
        id: controlId,
        name: controlName,
        source: macroSource(
          controlName,
          "e2eWiringControl",
          `  const marker = "SEEDMARKER";\n` +
            `  await api.setStatusBar(marker);\n` +
            `  await api.sleep(120);\n` +
            `  const v = await api.getCellValue(130, ${C.AW});\n` +
            `  await api.setStatusBar(marker + ":" + v);\n` +
            `  await api.sleep(120);\n` +
            `  await api.setStatusBar(null);\n`,
        ),
      });
      // THE PROBE: scenarioAdd writes NO cells. If scenario_add had forgotten
      // its DocumentEffect arm, the document would still look saved here.
      await seedMacro(page, {
        id: dirtyId,
        name: dirtyName,
        source: macroSource(
          dirtyName,
          "e2eWiringDirty",
          `  await api.scenarioAdd({\n` +
            `    name: ${JSON.stringify(scenarioName)},\n` +
            `    changingCells: "SEEDADDRESS",\n` +
            `    values: [4242],\n` +
            `  });\n`,
        ),
      });

      let controlEditor: Page | null = null;
      await test.step("control: after a save the document is clean and a no-op macro leaves it clean", async () => {
        controlEditor = await openMacroInEditor(page, grid, controlName);
        await expect(documentSelect(controlEditor)).toHaveValue(controlId, { timeout: 20_000 });
        // Retype BEFORE the save: the editor's write-through touches the script
        // store, and the save is what defines the clean baseline.
        await retypeAndStore(page, controlEditor, controlId, "SEEDMARKER", "E2EWiringControl");

        // Sample the status bar so "the macro ran" is observed, not assumed.
        await page.evaluate(async () => {
          const api: any = await (window as any).__calcImport(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          const w = window as any;
          w.__e2eWiringSb = [];
          w.__e2eWiringSbUnsub = api.onAppEvent(
            api.AppEvents.STATUS_BAR_TEXT_CHANGED,
            (d: { text: string | null }) => w.__e2eWiringSb.push(d.text),
          );
        });

        await saveClean();

        await toolbarButton(controlEditor, "Run").click();
        await withEditorConsole(controlEditor, async () => {
          await expect
            .poll(
              async () =>
                page.evaluate(() => ((window as any).__e2eWiringSb ?? []) as Array<string | null>),
              { timeout: 120_000 },
            )
            .toContain("E2EWiringControl:100");
        });
        await page.evaluate(() => {
          const w = window as any;
          w.__e2eWiringSbUnsub?.();
        });
        expect(
          await isDirty(),
          "running a macro is not itself a document mutation",
        ).toBe(false);
      });

      await test.step("probe: a macro whose only act is scenarioAdd DIRTIES the document", async () => {
        if (controlEditor) await destroyEditorWindow(page);
        await releaseTransientDebugMounts(page);

        const editorPage = await openMacroInEditor(page, grid, dirtyName);
        await expect(documentSelect(editorPage)).toHaveValue(dirtyId, { timeout: 20_000 });
        await retypeAndStore(page, editorPage, dirtyId, "SEEDADDRESS", "AW131");
        // Re-clean AFTER the retype: the editor's write-through saves the
        // script, which is itself a document change. From here the macro's
        // scenarioAdd is the ONLY candidate for the dirty mark.
        await saveClean();

        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => scenarioNames(page), { timeout: 120_000 })
            .toContain(scenarioName);
        });
        expect(
          await isDirty(),
          "scenario_add carries a mutating DocumentEffect",
        ).toBe(true);

        await destroyEditorWindow(page);
        await releaseTransientDebugMounts(page);
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });
});
