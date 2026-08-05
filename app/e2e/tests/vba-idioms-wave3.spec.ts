/**
 * WAVE 3 VBA-IDIOM SURFACE — proved live against the real app.
 *
 * Wave 3 shipped the "workbook automation" layer of the VBA-parity work:
 * format WRITE+READ-BACK twins (setRangeFormat/getRangeFormat incl. the three
 * range-edge border keys), conditional-formatting CRUD, cross-sheet structural
 * ops WITHOUT activating (insertRows/sortRange/mergeCells with a sheet slot),
 * data validation, hyperlinks (attach/read/remove, deliberately no follow),
 * calculation control with the restore-on-fault safety net, sheet protection,
 * fillRange/autoFit (drag-handle + double-click parity) and the sandbox-local
 * CSV helpers (api.text). All unit-tested; this file proves each claim through
 * a REAL macro: seeded as a module, opened in the Object Script Editor, its
 * decisive token RETYPED with real keystrokes (live-edit model, no save step),
 * and Run — against the real grid on a real sv-SE locale, with the decisive
 * assertions made on the RENDERED result (canvas pixels, DOM dialogs, tab
 * strip), never only on the backend.
 *
 * THE CLAIMS (one test each, self-contained, cleaned up in a finally):
 *   1. Format round-trip: {bold, textColor, numberFormat, borderOutline} on
 *      W61:X63 read back key-for-key; the outline renders on the RECTANGLE
 *      EDGES and not on interior boundaries (canvas pixel probe).
 *   2. Conditional formatting: a cellValue>100 red-fill rule on W65:W70 turns
 *      W66 (=150) RENDERED red; clearing the rule turns it back.
 *   3. Cross-sheet without activate: insert/sort/merge on a second sheet BY
 *      NAME while Sheet1 stays active the whole run (event-counted); the
 *      results are asserted by switching AFTER the macro finished.
 *   4. Data validation: a list rule on X65 renders the in-cell dropdown
 *      chrome (clicking it opens the real dropdown; picking an entry writes
 *      it) and an invalid manual entry is refused by the validation alert.
 *   5. Hyperlink TOC: a loop over api.getSheets() attaches internalReference
 *      links down column Y with link-look formatting; Ctrl+click navigates.
 *   6. Calculation control: manual mode holds a dependent stale, recalculate
 *      updates it, automatic restored; a macro that sets manual and THROWS
 *      leaves the app back on automatic (the restore-on-fault contract).
 *   7. Protection: protect with password; a USER edit is refused by the
 *      protection dialog; wrong password answers false (not a throw); the
 *      right password releases and the edit works again.
 *   8. fillRange series 1,2 -> 3..10 rendered; autoFitColumns visibly widens
 *      the column holding a long text.
 *   9. CSV: parseCsv on a quoted-field two-liner + toCsv round-trip, computed
 *      in the sandbox, results written to the grid.
 *
 * SHARED APP. One instance drives every functional spec; this spec's private
 * patch is columns W-Z rows 61+ (other specs own K, L, N, P, R, T, U, V; the
 * wave-2 spec also touches T-X rows 61+ but every spec reseeds and clears its
 * own patch and the runner is strictly serial). Scratch sheets: E2EVbaW3*.
 *
 * LOCALE. sv-SE. The only formula typed is "=W75+1" (no argument separators);
 * numbers written by macros are integers or 0.5 via the TYPED write path.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const NAME_PREFIX = "E2EVbaWave3";
const EDITOR_LABEL = "object-script-editor";
const SHEET_X = "E2EVbaW3X";
const SHEET_TOC = "E2EVbaW3Toc";
const SHEET_PROT = "E2EVbaW3Prot";
const PROT_PW = "e2epw";

// Result cells (column Z = 25)
const RES_FMT = { ref: "Z61", row: 60, col: 25 };
const RES_CF = { ref: "Z62", row: 61, col: 25 };
const RES_XS = { ref: "Z63", row: 62, col: 25 };
const RES_DV = { ref: "Z64", row: 63, col: 25 };
const RES_TOC = { ref: "Z65", row: 64, col: 25 };
const RES_CALC = { ref: "Z66", row: 65, col: 25 };
const RES_PROT = { ref: "Z67", row: 66, col: 25 };
const RES_UNPROT = { ref: "Z70", row: 69, col: 25 };
const RES_FILL = { ref: "Z68", row: 67, col: 25 };
const RES_CSV = { ref: "Z69", row: 68, col: 25 };

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

/** Restore every piece of document state this spec can disturb, then clear
 *  the private patch (rows 61-100, cols W..Z) on the ACTIVE sheet. */
async function restoreDocState(page: Page): Promise<void> {
  await page.evaluate(async (pw) => {
    const tauri = (window as any).__TAURI__;
    // Protection first — a protected sheet refuses the clears below.
    try { await tauri.core.invoke("unprotect_sheet", { password: pw }); } catch { /* not protected */ }
    try { await tauri.core.invoke("unprotect_sheet", {}); } catch { /* not protected */ }
    try { await tauri.core.invoke("set_calculation_mode", { mode: "automatic" }); } catch { /* ok */ }
    try {
      await tauri.core.invoke("clear_conditional_formats_in_range", {
        startRow: 60, startCol: 22, endRow: 99, endCol: 25,
      });
    } catch { /* none */ }
    try {
      await tauri.core.invoke("clear_data_validation", {
        startRow: 60, startCol: 22, endRow: 99, endCol: 25, sheetIndex: null,
      });
    } catch { /* none */ }
    for (let r = 60; r <= 80; r++) {
      try { await tauri.core.invoke("remove_hyperlink", { row: r, col: 24 }); } catch { /* none */ }
    }
    // Column width overrides from autoFit (X..Z): 0 removes the override.
    for (const c of [22, 23, 24, 25]) {
      try { await tauri.core.invoke("set_column_width", { col: c, width: 0 }); } catch { /* ok */ }
    }
    try {
      await tauri.core.invoke("clear_range_with_options", {
        params: { startRow: 60, startCol: 22, endRow: 99, endCol: 25, applyTo: "all" },
      });
    } catch { /* ok */ }
    // The Spreadsheet caches dimension overrides — tell it to re-fetch, or the
    // canvas keeps painting the autofit width the backend no longer has.
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  }, PROT_PW);
  await page.waitForTimeout(200);
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
  for (const name of [SHEET_X, SHEET_TOC, SHEET_PROT]) {
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
        if (s.id && s.id.startsWith("e2evba3-")) {
          so.ObjectScriptManager.removeScript(s.id);
        }
      }
    } catch {
      /* manager not loaded */
    }
    try {
      const modules: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
      for (const m of modules) {
        if ((m.name && m.name.startsWith(prefix)) || (m.id && m.id.startsWith("macro-e2evba3"))) {
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
// Canvas pixel probes — the RENDERED-result oracle.
// ---------------------------------------------------------------------------

interface Geom {
  headerW: number;
  headerH: number;
  cellW: number;
  cellH: number;
  scrollX: number;
  scrollY: number;
}

/** The live geometry the canvas paints from (header auto-widening included). */
async function gridGeom(page: Page): Promise<Geom> {
  return page.evaluate(() => {
    const gs = (window as any).__CALCULA_GRID_STATE__;
    return {
      headerW: gs?.config?.rowHeaderWidth ?? 22,
      headerH: gs?.config?.colHeaderHeight ?? 20,
      cellW: gs?.config?.defaultCellWidth ?? 64.29,
      cellH: gs?.config?.defaultCellHeight ?? 20,
      scrollX: gs?.viewport?.scrollX ?? 0,
      scrollY: gs?.viewport?.scrollY ?? 0,
    };
  });
}

function colX(g: Geom, col: number): number {
  return g.headerW + col * g.cellW - g.scrollX;
}
function rowY(g: Geom, row: number): number {
  return g.headerH + row * g.cellH - g.scrollY;
}

/** Read an [r,g,b] pixel list from a css-pixel rect of the grid canvas. */
async function samplePatch(
  page: Page,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<Array<[number, number, number]>> {
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

const isRed = ([r, g, b]: [number, number, number]) => r >= 170 && g <= 90 && b <= 90;
const isBlueish = ([r, g, b]: [number, number, number]) => b >= 140 && b > r + 40 && g <= 170;

function fractionMatching(
  px: Array<[number, number, number]>,
  pred: (p: [number, number, number]) => boolean,
): number {
  if (px.length === 0) return 0;
  return px.filter(pred).length / px.length;
}

// ---------------------------------------------------------------------------
// The Object Script Editor window (same access pattern as vba-idioms-wave2)
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
 * in the stored source.
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

test.describe("Wave 3 VBA idioms (live, through the editor)", () => {
  // =========================================================================
  // CLAIM 1 — format round-trip + range-edge border rendered on edges only
  // =========================================================================

  test("1. setRangeFormat {bold,textColor,numberFormat,borderOutline} on W61:X63 round-trips and renders edge-only", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} format ${stamp}`;
    const macroId = `macro-e2evba3-format-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await restoreDocState(page);

      // The target range is TYPED into Monaco (the seed is a non-address so a
      // stale run can never fake the assertion). The macro itself verifies
      // EVERY key round-trips — including the borderOutline decomposition into
      // per-cell edge sides with interior sides "none" — and writes fmt-ok
      // only when the read-back agrees key for key.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba3Format",
          `  const target = "SEEDRANGE";\n` +
            `  const r = await api.range(target);\n` +
            `  const sr = r.startRow, sc = r.startCol, er = r.endRow, ec = r.endCol;\n` +
            `  await api.setCellValue(sr + 1, sc, 0.5);\n` +
            `  await api.setRangeFormat(sr, sc, er, ec, {\n` +
            `    bold: true,\n` +
            `    textColor: "#1f4e79",\n` +
            `    numberFormat: "0.00%",\n` +
            `    borderOutline: { style: "medium", color: "#ff0000" },\n` +
            `  });\n` +
            `  const f = await api.getRangeFormat(sr, sc, er, ec);\n` +
            `  const bad = [];\n` +
            `  for (let i = 0; i < f.length; i++) {\n` +
            `    for (let j = 0; j < f[i].length; j++) {\n` +
            `      const c = f[i][j];\n` +
            `      if (c.bold !== true) bad.push("bold" + i + j);\n` +
            `      if (c.textColor !== "#1f4e79") bad.push("color" + i + j + "=" + c.textColor);\n` +
            `      if (c.numberFormat !== "Percentage (2 decimals)") bad.push("nf" + i + j + "=" + c.numberFormat);\n` +
            `    }\n` +
            `  }\n` +
            `  if (f[0][0].borderTop.style !== "medium") bad.push("t00");\n` +
            `  if (f[0][0].borderLeft.style !== "medium") bad.push("l00");\n` +
            `  if (f[0][0].borderTop.color !== "#ff0000") bad.push("tc00=" + f[0][0].borderTop.color);\n` +
            `  if (f[0][0].borderRight.style !== "none") bad.push("r00-interior");\n` +
            `  if (f[0][0].borderBottom.style !== "none") bad.push("b00-interior");\n` +
            `  if (f[0][1].borderTop.style !== "medium") bad.push("t01");\n` +
            `  if (f[0][1].borderRight.style !== "medium") bad.push("r01");\n` +
            `  if (f[0][1].borderLeft.style !== "none") bad.push("l01-interior");\n` +
            `  if (f[1][0].borderLeft.style !== "medium") bad.push("l10");\n` +
            `  if (f[1][0].borderTop.style !== "none") bad.push("t10-interior");\n` +
            `  if (f[1][1].borderRight.style !== "medium") bad.push("r11");\n` +
            `  if (f[1][1].borderLeft.style !== "none") bad.push("l11-interior");\n` +
            `  if (f[2][0].borderBottom.style !== "medium") bad.push("b20");\n` +
            `  if (f[2][1].borderBottom.style !== "medium") bad.push("b21");\n` +
            `  if (f[2][1].borderRight.style !== "medium") bad.push("r21");\n` +
            `  await api.setCellValue(${RES_FMT.row}, ${RES_FMT.col}, bad.length === 0 ? "fmt-ok" : "fmt-bad-" + bad.join(","));\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the range and Run: every key round-trips", async () => {
        await retypeAndStore(page, editorPage, macroId, "SEEDRANGE", "W61:X63");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_FMT.row, RES_FMT.col), { timeout: 90_000 })
            .not.toBe("");
        });
        expect(await readActiveCell(page, RES_FMT.row, RES_FMT.col)).toBe("fmt-ok");
      });

      await test.step("RENDERED: bold percent display + edge-only red outline", async () => {
        // The formatted value renders through the number format (sv-SE
        // locale renders the decimal comma: "50,00%").
        expect(await grid.getCellDisplayValue("W62"), "0.5 renders as 50%").toMatch(/^50[.,]00%$/);
        expect(await grid.getCellStyleProp("W61", "bold"), "bold on the range").toBe(true);

        // Bring the block into view WITH margins: navigating to Z75 (below and
        // right of the block) scrolls minimally so rows ~45-75 and columns up
        // to Z are on screen. Then park the selection OUTSIDE the block so no
        // selection tint pollutes the probe.
        await grid.navigateTo("Z75");
        await grid.clickCell("Y68");
        const g = await gridGeom(page);

        // Top outline edge of W61: a red band must be present.
        const topBand = await samplePatch(page, colX(g, 22) + 12, rowY(g, 60) - 2, 40, 5);
        expect(
          fractionMatching(topBand, isRed),
          "red outline pixels on the TOP edge of W61",
        ).toBeGreaterThan(0.15);

        // Right outline edge of X63: red band present.
        const rightBand = await samplePatch(page, colX(g, 24) - 2, rowY(g, 62) + 4, 5, 12);
        expect(
          fractionMatching(rightBand, isRed),
          "red outline pixels on the RIGHT edge of X63",
        ).toBeGreaterThan(0.15);

        // Interior vertical boundary (between W62 and X62): NO red.
        const innerV = await samplePatch(page, colX(g, 23) - 2, rowY(g, 61) + 5, 5, 10);
        expect(
          fractionMatching(innerV, isRed),
          "no outline pixels on the interior vertical boundary",
        ).toBe(0);

        // Interior horizontal boundary (between W61 and W62): NO red.
        const innerH = await samplePatch(page, colX(g, 22) + 12, rowY(g, 61) - 2, 40, 5);
        expect(
          fractionMatching(innerH, isRed),
          "no outline pixels on the interior horizontal boundary",
        ).toBe(0);

        await page.screenshot({ path: "e2e/results/wave3-format-outline.png", fullPage: false });
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 2 — conditional formatting renders, and clearing it un-renders
  // =========================================================================

  test("2. a cellValue>100 red-fill rule on W65:W70 renders on W66=150; clearing removes it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} cf ${stamp}`;
    const macroId = `macro-e2evba3-cf-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await restoreDocState(page);

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba3Cf",
          `  const modes = ["add", "clear"];\n` +
            `  const mode = modes[9];\n` +
            `  if (mode === "add") {\n` +
            `    await api.addConditionalFormat({\n` +
            `      rule: { type: "cellValue", operator: "greaterThan", value1: "100" },\n` +
            `      format: { backgroundColor: "#ff0000" },\n` +
            `      ranges: ["W65:W70"],\n` +
            `    });\n` +
            `    await api.setCellValue(65, 22, 150);\n` +
            `    await api.setCellValue(66, 22, 7);\n` +
            `    await api.setCellValue(${RES_CF.row}, ${RES_CF.col}, "cf-on");\n` +
            `  }\n` +
            `  if (mode === "clear") {\n` +
            `    const res = await api.clearConditionalFormats("W65:W70");\n` +
            `    await api.setCellValue(${RES_CF.row}, ${RES_CF.col}, "cf-off-" + res.count);\n` +
            `  }\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("add the rule + write 150: W66 renders RED, W67 (=7) does not", async () => {
        await retypeAndStore(page, editorPage, macroId, "9", "0", "modes[0]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_CF.row, RES_CF.col), { timeout: 90_000 })
            .toBe("cf-on");
        });

        await grid.navigateTo("Z80");
        await grid.clickCell("Y70");
        const g = await gridGeom(page);
        // Left half of W66 (numbers right-align; sample away from the digits).
        await expect
          .poll(
            async () => {
              const px = await samplePatch(page, colX(g, 22) + 4, rowY(g, 65) + 4, 28, 12);
              return fractionMatching(px, isRed);
            },
            { timeout: 20_000 },
          )
          .toBeGreaterThan(0.5);
        // The rule is CONDITIONAL: W67 holds 7 and stays unfilled.
        const wrong = await samplePatch(page, colX(g, 22) + 4, rowY(g, 66) + 4, 28, 12);
        expect(fractionMatching(wrong, isRed), "W67 (=7) must NOT be red").toBe(0);
        await page.screenshot({ path: "e2e/results/wave3-cf-red.png", fullPage: false });
      });

      await test.step("clear the rule: the red fill un-renders", async () => {
        await releaseTransientDebugMounts(page);
        await retypeAndStore(page, editorPage, macroId, "0", "1", "modes[1]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_CF.row, RES_CF.col), { timeout: 90_000 })
            .toBe("cf-off-1");
        });

        await grid.navigateTo("Z80");
        await grid.clickCell("Y70");
        const g = await gridGeom(page);
        await expect
          .poll(
            async () => {
              const px = await samplePatch(page, colX(g, 22) + 4, rowY(g, 65) + 4, 28, 12);
              return fractionMatching(px, isRed);
            },
            { timeout: 20_000 },
          )
          .toBe(0);
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 3 — cross-sheet structural ops by NAME, without activating
  // =========================================================================

  test("3. insert/sort/merge on a second sheet BY NAME while Sheet1 stays active", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} xsheet ${stamp}`;
    const macroId = `macro-e2evba3-xsheet-${stamp}`;

    const tabWith = (name: string) =>
      page.locator("button[data-sheet-tab]").filter({ hasText: name });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await deleteScratchSheets(page);

    try {
      const xIndex = await ensureSheet(page, SHEET_X);
      // Seed UNSORTED data on the scratch sheet: A61=30, A62=10, A63=20.
      await seedCellsDirect(page, [
        { row: 60, col: 0, value: "30" },
        { row: 61, col: 0, value: "10" },
        { row: 62, col: 0, value: "20" },
      ]);
      await activateSheetTrusted(page, 0);
      await restoreDocState(page);

      // The SHEET NAME is what gets typed — the macro addresses the second
      // sheet by name in every call and never activates it.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba3XSheet",
          `  const target = "SEEDSHEET";\n` +
            `  const before = await api.getActiveSheet();\n` +
            `  await api.insertRows(60, 1, target);\n` +
            `  await api.sortRange(61, 0, 63, 0, [{ key: 0, ascending: true }], {}, target);\n` +
            `  await api.setCellValue(65, 0, "MERGED", target);\n` +
            `  await api.mergeCells(65, 0, 66, 1, target);\n` +
            `  const after = await api.getActiveSheet();\n` +
            `  await api.setCellValue(${RES_XS.row}, ${RES_XS.col}, "xs-" + before + "-" + after);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the sheet name and Run: the active sheet never changes", async () => {
        await retypeAndStore(page, editorPage, macroId, "SEEDSHEET", SHEET_X);
        // Count sheet-change announcements across the run: must stay 0.
        await page.evaluate(() => {
          const w = window as any;
          w.__e2eW3SheetChanges = 0;
          w.__e2eW3Listener = () => { w.__e2eW3SheetChanges++; };
          window.addEventListener("app:sheet-changed", w.__e2eW3Listener);
        });
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_XS.row, RES_XS.col), { timeout: 90_000 })
            .toBe("xs-0-0");
        });
        const changes = await page.evaluate(() => {
          const w = window as any;
          window.removeEventListener("app:sheet-changed", w.__e2eW3Listener);
          return w.__e2eW3SheetChanges as number;
        });
        expect(changes, "no sheet switch was announced during the run").toBe(0);
        const { activeIndex } = await getSheets(page);
        expect(activeIndex, "Sheet1 is still the active sheet").toBe(0);
      });

      await test.step("switch AFTER the run: values in post-insert positions, sorted, merge rendered", async () => {
        await tabWith(SHEET_X).first().click();
        await page.waitForTimeout(600);
        const { activeIndex } = await getSheets(page);
        expect(activeIndex).toBe(xIndex);

        // insertRows(60) pushed the block down one row; sortRange ordered it.
        expect(await grid.getCellFormulaBarText("A62"), "A62 after insert+sort").toBe("10");
        expect(await grid.getCellFormulaBarText("A63"), "A63 after insert+sort").toBe("20");
        expect(await grid.getCellFormulaBarText("A64"), "A64 after insert+sort").toBe("30");
        expect(await grid.getCellFormulaBarText("A61"), "A61 is the inserted blank row").toBe("");

        // The merge renders: clicking a COVERED cell resolves to the master.
        expect(await grid.getCellFormulaBarText("B67"), "covered cell shows the master value").toBe(
          "MERGED",
        );
        const mergeInfo = await page.evaluate(async () => {
          const tauri = (window as any).__TAURI__;
          return tauri.core.invoke("get_merge_info", { row: 66, col: 1 });
        });
        expect(mergeInfo).not.toBeNull();
        expect(mergeInfo.startRow).toBe(65);
        expect(mergeInfo.endRow).toBe(66);
        expect(mergeInfo.startCol).toBe(0);
        expect(mergeInfo.endCol).toBe(1);
        await page.screenshot({ path: "e2e/results/wave3-xsheet-merge.png", fullPage: false });
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await restoreDocState(page).catch(() => {});
      await deleteScratchSheets(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 4 — data validation: dropdown chrome + the app's own refusal UI
  // =========================================================================

  test("4. a list validation on X65 renders dropdown chrome; an invalid entry is refused by the alert", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} dv ${stamp}`;
    const macroId = `macro-e2evba3-dv-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await restoreDocState(page);

      // The first list entry is TYPED into Monaco; the macro reads the rule
      // back (same shape in as out) before reporting dv-ok.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba3Dv",
          `  const first = "SEEDLIST";\n` +
            `  await api.setDataValidation(64, 23, 64, 23, {\n` +
            `    type: "list", values: [first, "Rambutan", "Salak"],\n` +
            `    inCellDropdown: true,\n` +
            `    errorTitle: "Bad pick", errorMessage: "Pick a listed fruit", errorStyle: "stop",\n` +
            `  });\n` +
            `  const back = await api.getDataValidation(64, 23);\n` +
            `  const ok = back && back.type === "list" && back.values && back.values.length === 3 && back.values[0] === first && back.inCellDropdown === true;\n` +
            `  await api.setCellValue(${RES_DV.row}, ${RES_DV.col}, ok ? "dv-ok" : "dv-bad");\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the entry and Run: the rule lands and reads back", async () => {
        await retypeAndStore(page, editorPage, macroId, "SEEDLIST", "Kiwano");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_DV.row, RES_DV.col), { timeout: 90_000 })
            .toBe("dv-ok");
        });
      });

      await test.step("RENDERED chrome: clicking the in-cell chevron opens the real dropdown", async () => {
        await grid.navigateTo("Z75");
        const g = await gridGeom(page);
        // The chevron button sits at the right edge of the cell (18px wide).
        const cx = colX(g, 23) + g.cellW - 9;
        const cy = rowY(g, 64) + g.cellH / 2;
        await grid.canvas.click({ position: { x: cx, y: cy }, force: true });
        await expect(page.getByText("Rambutan", { exact: true }).first()).toBeVisible({
          timeout: 10_000,
        });
        await page.screenshot({ path: "e2e/results/wave3-dv-dropdown.png", fullPage: false });
        // Picking an entry writes it through the product's own path. NOTE:
        // any CLICK on a list-validated cell opens/closes the dropdown (the
        // interceptor claims the whole cell), so the committed value is read
        // through the backend, not by re-clicking the cell.
        await page.getByText("Kiwano", { exact: true }).first().click();
        await expect
          .poll(async () => readActiveCell(page, 64, 23), { timeout: 10_000 })
          .toBe("Kiwano");
      });

      await test.step("an INVALID manual entry is refused by the validation alert", async () => {
        // Select via the Name Box — a canvas click would open the dropdown
        // (see above) and the keystrokes would go to it instead of the editor.
        await grid.navigateTo("X65");
        await page.keyboard.type("Durian", { delay: 40 });
        await page.keyboard.press("Enter");
        const alert = page.locator("[role='alertdialog']").filter({ hasText: "Bad pick" });
        await expect(alert, "the validation error alert appears").toBeVisible({ timeout: 10_000 });
        await expect(alert).toContainText("Pick a listed fruit");
        await page.screenshot({ path: "e2e/results/wave3-dv-refusal.png", fullPage: false });
        await alert.locator("button").filter({ hasText: /^Cancel$/ }).click();
        await expect(alert).toBeHidden({ timeout: 5_000 });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        expect(await grid.getCellDisplayValue("X65"), "the invalid entry was NOT committed").toBe(
          "Kiwano",
        );
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 5 — the classic TOC macro: internalReference links down column Y
  // =========================================================================

  test("5. a getSheets() loop builds a TOC of internalReference links; Ctrl+click navigates", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} toc ${stamp}`;
    const macroId = `macro-e2evba3-toc-${stamp}`;

    const tabWith = (name: string) =>
      page.locator("button[data-sheet-tab]").filter({ hasText: name });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await deleteScratchSheets(page);

    try {
      const tocIndex = await ensureSheet(page, SHEET_TOC);
      await activateSheetTrusted(page, 0);
      await restoreDocState(page);

      // Calcula deliberately has no auto-styling for link cells, so the macro
      // applies the classic link look itself — exactly what the VBA TOC macro
      // did with Font.Underline/Font.Color.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba3Toc",
          `  const jump = "SEEDREF";\n` +
            `  const sheets = await api.getSheets();\n` +
            `  let n = 0;\n` +
            `  for (let i = 0; i < sheets.length; i++) {\n` +
            `    const row = 60 + i;\n` +
            `    await api.setCellValue(row, 24, sheets[i].name);\n` +
            `    await api.addHyperlink(row, 24, {\n` +
            `      type: "internalReference", sheetName: sheets[i].name, cellReference: jump,\n` +
            `    }, { displayText: sheets[i].name, tooltip: "Go to " + sheets[i].name });\n` +
            `    n = n + 1;\n` +
            `  }\n` +
            `  await api.setRangeFormat(60, 24, 60 + sheets.length - 1, 24, { textColor: "#0563c1", underline: "single" });\n` +
            `  await api.setCellValue(${RES_TOC.row}, ${RES_TOC.col}, "toc-" + n);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      const { sheets } = await getSheets(page);
      const sheetCount = sheets.length;
      const tocRow = 60 + sheets.findIndex((s) => s.name === SHEET_TOC);
      const tocRef = `Y${tocRow + 1}`;

      await test.step("type the jump target and Run: one link per sheet", async () => {
        await retypeAndStore(page, editorPage, macroId, "SEEDREF", "A1", `const jump = "A1"`);
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_TOC.row, RES_TOC.col), { timeout: 90_000 })
            .toBe(`toc-${sheetCount}`);
        });
      });

      await test.step("RENDERED link styling on the TOC rows", async () => {
        expect(await grid.getCellFormulaBarText(tocRef), "the TOC row names its sheet").toBe(
          SHEET_TOC,
        );
        expect(await grid.getCellStyleProp(tocRef, "underline"), "underline applied").toBe(true);
        expect(await grid.getCellStyleStringProp(tocRef, "textColor")).toBe("#0563c1");
        const link = await page.evaluate(async (row) => {
          const tauri = (window as any).__TAURI__;
          return tauri.core.invoke("get_hyperlink", { row, col: 24 });
        }, tocRow);
        expect(link).not.toBeNull();
        expect(link.linkType).toBe("internalReference");

        // Blue link pixels really painted (text + underline).
        await grid.navigateTo("Z75");
        await grid.clickCell("W72");
        const g = await gridGeom(page);
        const px = await samplePatch(page, colX(g, 24) + 2, rowY(g, tocRow) + 2, 56, 16);
        expect(
          px.filter(isBlueish).length,
          "blue link pixels rendered in the TOC cell",
        ).toBeGreaterThan(5);
        await page.screenshot({ path: "e2e/results/wave3-toc-links.png", fullPage: false });
      });

      await test.step("Ctrl+click follows the link to its sheet", async () => {
        await grid.navigateTo("Z75");
        const g = await gridGeom(page);
        await grid.canvas.click({
          position: { x: colX(g, 24) + 20, y: rowY(g, tocRow) + g.cellH / 2 },
          modifiers: ["Control"],
          force: true,
        });
        await expect
          .poll(async () => (await getSheets(page)).activeIndex, { timeout: 15_000 })
          .toBe(tocIndex);
        await expect(tabWith(SHEET_TOC).first()).toBeVisible();
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await restoreDocState(page).catch(() => {});
      await deleteScratchSheets(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 6 — calculation control + the restore-on-fault safety net
  // =========================================================================

  test("6. manual mode holds a dependent stale until recalculate; a THROWING macro still restores automatic", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} calc ${stamp}`;
    const macroId = `macro-e2evba3-calc-${stamp}`;

    const backendMode = () =>
      page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("get_calculation_mode");
      });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await restoreDocState(page);
      // W75=1, W76=W75+1 -> 2 (no argument separators, sv-SE-safe).
      await seedCellsDirect(page, [
        { row: 74, col: 22, value: "1" },
        { row: 75, col: 22, value: "=W75+1" },
      ]);
      expect(await readActiveCell(page, 75, 22), "precondition: dependent = 2").toBe("2");
      expect(await backendMode(), "precondition: automatic").toBe("automatic");

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba3Calc",
          `  const modes = ["happy", "fault"];\n` +
            `  const mode = modes[9];\n` +
            `  await api.setCalculationMode("manual");\n` +
            `  await api.setCellValue(74, 22, 5);\n` +
            `  if (mode === "fault") {\n` +
            `    throw new Error("deliberate-fault-e2e");\n` +
            `  }\n` +
            `  const stale = await api.getCellValue(75, 22);\n` +
            `  await api.recalculate({ full: true });\n` +
            `  const fresh = await api.getCellValue(75, 22);\n` +
            `  const restored = await api.setCalculationMode("automatic");\n` +
            `  await api.setCellValue(${RES_CALC.row}, ${RES_CALC.col}, "calc-" + stale + "-" + fresh + "-" + restored);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("happy path: stale under manual, fresh after recalculate, automatic restored", async () => {
        await retypeAndStore(page, editorPage, macroId, "9", "0", "modes[0]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_CALC.row, RES_CALC.col), { timeout: 90_000 })
            .toBe("calc-2-6-automatic");
        });
        expect(await backendMode(), "mode restored by the macro itself").toBe("automatic");
        // W76 is a FORMULA cell: the formula bar shows "=W75+1"; the computed
        // value renders in the cell (display).
        expect(await grid.getCellDisplayValue("W76"), "dependent updated on screen").toBe("6");
        await grid.navigateTo("W76");
        await expect
          .poll(async () => grid.getFormulaBarValue(), { timeout: 10_000 })
          .toBe("=W75+1");
      });

      await test.step("the safety net: a macro that sets manual and THROWS leaves automatic behind", async () => {
        // Reset the input so the fault run demonstrably flips mode itself.
        await seedCellsDirect(page, [{ row: 74, col: 22, value: "1" }]);
        await expect
          .poll(async () => readActiveCell(page, 75, 22), { timeout: 15_000 })
          .toBe("2");

        // Flip the mode digit IN MONACO (live write-through), then run the
        // stored macro through the MACRO LIBRARY's Run — the one-shot
        // mount-run-unmount path every button click uses. (The editor's own
        // Run keeps a thrown run's debug mount alive ON PURPOSE so the author
        // can retry, so it is not the lifecycle the restore contract ends.)
        await retypeAndStore(page, editorPage, macroId, "0", "1", "modes[1]");
        await destroyEditorWindow(page);
        await releaseTransientDebugMounts(page);

        const library = await openMacroLibrary(page, grid);
        const row = library.locator("[data-macro-library-item]").filter({ hasText: macroName });
        await expect(row).toHaveCount(1);
        await row.click();
        const runBtn = library.locator("[data-macro-run-button]");
        await expect(runBtn).toBeEnabled();
        await runBtn.click();

        // The run REALLY threw — the library reports the failure by name...
        await expect(library.locator("[data-macro-error]")).toContainText(
          "deliberate-fault-e2e",
          { timeout: 60_000 },
        );
        await page.screenshot({ path: "e2e/results/wave3-calc-fault.png", fullPage: false });
        await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
        await expect(library).toBeHidden({ timeout: 5_000 });

        // ...and the restore-on-fault contract hands automatic back.
        await expect
          .poll(async () => backendMode(), { timeout: 45_000 })
          .toBe("automatic");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 7 — sheet protection binds the USER; wrong password answers false
  // =========================================================================

  test("7. protectSheet(password): a user edit is refused by the protection dialog; wrong pw answers false; unprotect releases", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} prot ${stamp}`;
    const macroId = `macro-e2evba3-prot-${stamp}`;

    const tabWith = (name: string) =>
      page.locator("button[data-sheet-tab]").filter({ hasText: name });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await deleteScratchSheets(page);

    try {
      // A second sheet to switch to and back — the USER action that refreshes
      // the Protection extension's cached sheet state.
      await ensureSheet(page, SHEET_PROT);
      await activateSheetTrusted(page, 0);
      await restoreDocState(page);
      await seedCellsDirect(page, [{ row: 79, col: 22, value: "before" }]);
      const sheet0Name = (await getSheets(page)).sheets.find((s) => s.index === 0)?.name ?? "Sheet1";

      // mode "protect": unlock the result cells FIRST (scripts are bound by
      // protection exactly like the user — the documented discipline), then
      // protect with a password, then prove a wrong password answers false.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba3Prot",
          `  const modes = ["protect", "release"];\n` +
            `  const mode = modes[9];\n` +
            `  if (mode === "protect") {\n` +
            `    await api.setRangeFormat(${RES_PROT.row}, ${RES_PROT.col}, ${RES_UNPROT.row}, ${RES_UNPROT.col}, { locked: false });\n` +
            `    await api.protectSheet({ password: "${PROT_PW}" });\n` +
            `    const wrong = await api.unprotectSheet("totally-wrong");\n` +
            `    const status = await api.getProtectionStatus();\n` +
            `    await api.setCellValue(${RES_PROT.row}, ${RES_PROT.col}, "prot-" + wrong + "-" + status.protected);\n` +
            `  }\n` +
            `  if (mode === "release") {\n` +
            `    const ok = await api.unprotectSheet("${PROT_PW}");\n` +
            `    const status = await api.getProtectionStatus();\n` +
            `    await api.setCellValue(${RES_UNPROT.row}, ${RES_UNPROT.col}, "unprot-" + ok + "-" + status.protected);\n` +
            `  }\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("protect + wrong-password probe: false, still protected", async () => {
        await retypeAndStore(page, editorPage, macroId, "9", "0", "modes[0]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_PROT.row, RES_PROT.col), { timeout: 90_000 })
            .toBe("prot-false-true");
        });
        const isProt = await page.evaluate(async () => {
          const tauri = (window as any).__TAURI__;
          return tauri.core.invoke("is_sheet_protected", {});
        });
        expect(isProt, "backend agrees: protected").toBe(true);
      });

      await test.step("a USER edit on a locked cell is refused by the protection dialog", async () => {
        // A real user sheet round-trip (tab strip) — the product's own
        // SHEET_CHANGED refresh path for the protection cache.
        await tabWith(SHEET_PROT).first().click();
        await page.waitForTimeout(600);
        await tabWith(sheet0Name).first().click();
        await page.waitForTimeout(600);

        await grid.clickCell("W80");
        await page.keyboard.type("5", { delay: 40 });
        const warn = page.locator("[role='alertdialog']").filter({ hasText: "protected sheet" });
        await expect(warn, "the protection warning dialog appears").toBeVisible({
          timeout: 10_000,
        });
        await page.screenshot({ path: "e2e/results/wave3-protection-refusal.png", fullPage: false });
        await warn.locator("button").filter({ hasText: /^OK$/ }).click();
        await expect(warn).toBeHidden({ timeout: 5_000 });
        await page.keyboard.press("Escape");
        expect(await grid.getCellFormulaBarText("W80"), "the edit did NOT land").toBe("before");
      });

      await test.step("unprotect with the right password: true, and the edit works", async () => {
        await releaseTransientDebugMounts(page);
        await retypeAndStore(page, editorPage, macroId, "0", "1", "modes[1]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_UNPROT.row, RES_UNPROT.col), {
              timeout: 90_000,
            })
            .toBe("unprot-true-false");
        });

        // Refresh the cached state the same user way, then edit for real.
        await tabWith(SHEET_PROT).first().click();
        await page.waitForTimeout(600);
        await tabWith(sheet0Name).first().click();
        await page.waitForTimeout(600);
        // "76" not "77": repeated adjacent digits can drop/double in canvas
        // typing at 30ms (documented E2E gotcha).
        await grid.setCellValue("W80", "76");
        expect(await grid.getCellFormulaBarText("W80"), "the edit lands after unprotect").toBe("76");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await restoreDocState(page).catch(() => {});
      await deleteScratchSheets(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 8 — fillRange series parity + autoFitColumns visibly widens
  // =========================================================================

  test("8. fillRange continues 1,2 -> 3..10 on the grid; autoFitColumns widens the long-text column", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} fill ${stamp}`;
    const macroId = `macro-e2evba3-fill-${stamp}`;

    const readColWidth = () =>
      page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("get_column_width", { col: 23 });
      });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await restoreDocState(page);
      expect(await readColWidth(), "precondition: column X at default width").toBeNull();

      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba3Fill",
          `  const modes = ["go"];\n` +
            `  const mode = modes[9];\n` +
            `  if (mode !== "go") { throw new Error("seeded dead mode"); }\n` +
            `  await api.setCellValue(84, 22, 1);\n` +
            `  await api.setCellValue(85, 22, 2);\n` +
            `  const res = await api.fillRange(84, 22, 93, 22, { type: "series", sourceSize: 2 });\n` +
            `  await api.setCellValue(84, 23, "Autofit measures this deliberately long sentence end to end");\n` +
            `  const fit = await api.autoFitColumns(23, 23);\n` +
            `  await api.setCellValue(${RES_FILL.row}, ${RES_FILL.col}, "fill-" + res.count + "-fit-" + fit.count);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      // A small canvas band across the fill/autofit area, for before/after
      // rendered-change proof. The band is GRID-anchored (recomputed from the
      // live geometry after each navigation) so a scroll difference between
      // the two captures cannot fake a change.
      const captureBand = async (): Promise<string> => {
        await grid.navigateTo("Z95");
        await grid.clickCell("Y95");
        const g = await gridGeom(page);
        const px = await samplePatch(page, colX(g, 22), rowY(g, 84), 220, 40);
        return JSON.stringify(px);
      };
      const beforeBand = await captureBand();

      await test.step("enable the mode digit and Run", async () => {
        await retypeAndStore(page, editorPage, macroId, "9", "0", "modes[0]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_FILL.row, RES_FILL.col), { timeout: 90_000 })
            .toBe("fill-8-fit-1");
        });
      });

      await test.step("the series RENDERED: 3..10 below the two seeds", async () => {
        expect(await grid.getCellFormulaBarText("W87"), "first inferred value").toBe("3");
        expect(await grid.getCellFormulaBarText("W90")).toBe("6");
        expect(await grid.getCellFormulaBarText("W94"), "last inferred value").toBe("10");
      });

      await test.step("the column visibly widened (backend width + repainted canvas)", async () => {
        const width = await readColWidth();
        expect(width, "column X now has a width override").not.toBeNull();
        expect(width as number, "wide enough for the sentence").toBeGreaterThan(150);

        // The same grid-anchored canvas band repainted differently (the
        // series values and the widened column both land inside it).
        const afterBand = await captureBand();
        expect(
          afterBand !== beforeBand,
          "the canvas band repainted with the new column geometry",
        ).toBe(true);
        await page.screenshot({ path: "e2e/results/wave3-fill-autofit.png", fullPage: false });
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 9 — CSV in the sandbox: quoted fields, escaped quotes, round-trip
  // =========================================================================

  test("9. api.text.parseCsv handles a quoted two-liner and toCsv round-trips it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} csv ${stamp}`;
    const macroId = `macro-e2evba3-csv-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await activateSheetTrusted(page, 0);
      await restoreDocState(page);

      // The DELIMITER is what gets typed — with a wrong one the quoted field
      // "Ana;B" cannot parse into two clean columns, so a stale run can never
      // produce the expected marker.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba3Csv",
          `  const delim = "SEEDDELIM";\n` +
            `  const raw = 'name;city\\n"Ana;B";"said ""hi"""';\n` +
            `  const parsed = await api.text.parseCsv(raw, { delimiter: delim });\n` +
            `  const rows = parsed.rows;\n` +
            `  let marker = "csv-bad-" + JSON.stringify(rows);\n` +
            `  if (rows.length === 2 && rows[0].length === 2 && rows[1].length === 2 &&\n` +
            `      rows[0][0] === "name" && rows[0][1] === "city" &&\n` +
            `      rows[1][0] === "Ana;B" && rows[1][1] === 'said "hi"') {\n` +
            `    const out = await api.text.toCsv(rows, { delimiter: delim, lineEnding: "\\n" });\n` +
            `    const re = await api.text.parseCsv(out, { delimiter: delim });\n` +
            `    const same = JSON.stringify(re.rows) === JSON.stringify(rows);\n` +
            `    marker = "csv-" + (rows.length * rows[0].length) + "-" + rows[1][0] + (same ? "-rt" : "-nort");\n` +
            `  }\n` +
            `  await api.setCellValue(${RES_CSV.row}, ${RES_CSV.col}, marker);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the ';' delimiter and Run: count + quoted value + round-trip", async () => {
        await retypeAndStore(page, editorPage, macroId, "SEEDDELIM", ";", `const delim = ";"`);
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_CSV.row, RES_CSV.col), { timeout: 90_000 })
            .toBe("csv-4-Ana;B-rt");
        });
        // Select via the Name Box (precise for right-edge columns) and poll
        // the formula bar — its sync after a run can lag a beat.
        await grid.navigateTo(RES_CSV.ref);
        await expect
          .poll(async () => grid.getFormulaBarValue(), { timeout: 10_000 })
          .toBe("csv-4-Ana;B-rt");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await activateSheetTrusted(page, 0).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });
});
