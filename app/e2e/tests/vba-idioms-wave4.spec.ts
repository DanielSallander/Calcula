/**
 * WAVE 4 VBA-IDIOM SURFACE — proved live against the real app.
 *
 * Wave 4 shipped the "application breadth" layer of the VBA-parity work:
 * Application.StatusBar with restore-on-fault, Application.Run with the
 * chain guard, sticky notes, table structure aspects, View/Window state
 * (gridlines + zoom), Goal Seek, Remove Duplicates, cancellable
 * Workbook_SheetBeforeDoubleClick, Application.OnTime's one-shot half
 * (schedule.once) and PageSetup. All unit-tested; this file proves each claim
 * through a REAL macro run through the Object Script Editor (live-edit model:
 * the decisive token is RETYPED with real keystrokes, then Run), with the
 * decisive assertions made on the RENDERED result — canvas pixels, the real
 * status-bar DOM, real double-clicks — never only on the backend.
 *
 * Two claims deliberately do NOT go through the module-macro door, because the
 * product design places them on standing OBJECT-SCRIPT mounts:
 *   - claim 8 (double-click veto): onBeforeDoubleClick is a SheetContext hook,
 *     so the veto is mounted as a real sheet object script via the production
 *     ObjectScriptManager path (the task allows exactly this).
 *   - claim 9 (schedule.once): the `schedule` capability rides the R19
 *     declared-capability ceiling, which module macros structurally do not
 *     carry (hostStartModuleScriptDebugSession / runObjectScriptOnce build
 *     their mount definitions without declaredCapabilities — a transient
 *     mount cannot outlive its run, and a schedule needs a standing mount to
 *     fire: Rust `due` only hands out jobs whose script is mounted). The
 *     one-shot is therefore proved on a real workbook object script — the
 *     surface the scheduler UI (CodeInThisFilePanel) actually serves.
 *
 * THE CLAIMS (one test each, self-contained, cleaned up in a finally):
 *   1. StatusBar LIVE: a macro loops 5 iterations of api.setStatusBar with
 *      sleeps; the real status-bar span VISIBLY cycles through the messages
 *      mid-run (in-page DOM sampler + event log) and returns to "Ready"; a
 *      macro that sets the bar and THROWS leaves "Ready" behind (the
 *      restore-on-fault contract, run through the macro library's one-shot
 *      mount like a button).
 *   2. api.runMacro: A writes a cell then runs B by name; both land. A macro
 *      that reaches itself through api.runMacro is refused with an error that
 *      NAMES THE CHAIN.
 *   3. Notes: set/get/list round-trip; the red note triangle renders on the
 *      cell corner (canvas probe) and clicking the cell opens the note
 *      editor with the note text (the product's inspection surface — the
 *      mousemove hover preview is unwired dead code, see the step comment).
 *   4. Table aspects: createTable on seeded data, addColumn("Margin"),
 *      setTotalsRow(true); the rendered chrome gains the new column and the
 *      totals row (grid-anchored canvas band diff) and the backend table
 *      agrees (3 columns, endRow/endCol grown, totalRow on).
 *   5. View options: gridlines OFF un-renders the grid lines (pixel proof) and
 *      ON restores them; setZoom(150) visibly rescales (zoom state + canvas
 *      diff observed mid-run) and getZoom answers percent; 100 restored.
 *   6. Goal Seek: AC62 = AC61*3, goal 30 -> the converged solution 10 is
 *      RENDERED in AC61 and AC62 shows the target (tolerance).
 *   7. removeDuplicates on AA80:AA86 (7 values, 3 dupes) -> removedCount 3 and
 *      the rendered rows close up to 5,3,7,9.
 *   8. A sheet script's onBeforeDoubleClick veto: a REAL double-click on AA61
 *      does NOT enter edit mode, on AB65 DOES; after unmount the veto is gone.
 *   9. schedule.once ~6s out: the marker cell fills within the pump's next
 *      ticks and the job self-removes from the list after firing.
 *  10. Page setup: landscape + print area AA61:AB70 read back exactly; then
 *      portrait + clearPrintArea read back empty.
 *
 * SHARED APP. This spec's private patch is columns AA-AD rows 61+ (other
 * specs own K, L, N, P, R, T-Z; every spec reseeds and clears its own patch
 * and the runner is strictly serial).
 *
 * LOCALE. sv-SE. The only formula typed is "=AC61*3" (no argument
 * separators); numbers written by macros are integers via the TYPED path.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const NAME_PREFIX = "E2EVbaWave4";
const EDITOR_LABEL = "object-script-editor";

// Result cells (column AD = 29)
const RES_SB = { ref: "AD61", row: 60, col: 29 };
const RES_CHAIN = { ref: "AD62", row: 61, col: 29 };
const RES_NOTE = { ref: "AD63", row: 62, col: 29 };
const RES_TBL = { ref: "AD64", row: 63, col: 29 };
const RES_VIEW = { ref: "AD65", row: 64, col: 29 };
const RES_GS = { ref: "AD66", row: 65, col: 29 };
const RES_DD = { ref: "AD67", row: 66, col: 29 };
const RES_PS1 = { ref: "AD68", row: 67, col: 29 };
const RES_PS2 = { ref: "AD69", row: 68, col: 29 };

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

/** Restore every piece of document/app state this spec can disturb, then
 *  clear the private patch (rows 61-100, cols AA..AD) on the ACTIVE sheet. */
async function restoreDocState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    const grid: any = await (window as any).__calcImport(
      new URL("/src/api/grid.ts", document.baseURI).href,
    );
    const api: any = await (window as any).__calcImport(
      new URL("/src/api/index.ts", document.baseURI).href,
    );
    // App-level chrome the status-bar / view tests can leave behind.
    try { grid.clearStatusBarText(); } catch { /* ok */ }
    try { grid.setZoomLevel(100); } catch { /* ok */ }
    try { grid.changeViewMode("normal"); } catch { /* ok */ }
    try {
      api.emitAppEvent(api.AppEvents.DISPLAY_GRIDLINES_TOGGLED, { displayGridlines: true });
    } catch { /* ok */ }
    // Notes this spec sets (AA61 only).
    try {
      const note: any = await tauri.core.invoke("get_note", { row: 60, col: 26 });
      if (note?.id) await tauri.core.invoke("delete_note", { noteId: note.id });
    } catch { /* none */ }
    // Tables this spec creates.
    try {
      const tables: any[] = await tauri.core.invoke("get_all_tables");
      for (const t of tables) {
        if (String(t.name ?? "").startsWith("E2EW4")) {
          await tauri.core.invoke("delete_table", { tableId: t.id }).catch(() => {});
        }
      }
    } catch { /* none */ }
    // Page setup.
    try { await tauri.core.invoke("clear_print_area"); } catch { /* ok */ }
    try {
      const ps: any = await tauri.core.invoke("get_page_setup");
      if (ps && ps.orientation !== "portrait") {
        ps.orientation = "portrait";
        await tauri.core.invoke("set_page_setup", { setup: ps });
      }
    } catch { /* ok */ }
    // Scheduler jobs owned by this spec's scripts.
    try {
      const jobs: any[] = await tauri.core.invoke("script_scheduler", { request: { op: "list" } });
      for (const j of jobs) {
        if (String(j.scriptId ?? "").startsWith("e2evba4-")) {
          await tauri.core
            .invoke("script_scheduler", { request: { op: "cancel", jobId: j.id } })
            .catch(() => {});
        }
      }
    } catch { /* ok */ }
    try {
      await tauri.core.invoke("clear_range_with_options", {
        params: { startRow: 60, startCol: 26, endRow: 99, endCol: 29, applyTo: "all" },
      });
    } catch { /* ok */ }
    // The Table and Review extensions paint their chrome from FRONTEND caches
    // that a backend delete_table / delete_note invoke never invalidates —
    // without a refresh the deleted table's chrome and the note triangle keep
    // rendering as ghosts (and poison this spec's canvas-diff oracles). Their
    // refreshers listen on SHEET_CHANGED / ANNOTATIONS_CHANGED.
    try {
      const sheets: any = await tauri.core.invoke("get_sheets");
      const active = sheets.sheets.find((s: any) => s.index === sheets.activeIndex);
      api.emitAppEvent(api.AppEvents.SHEET_CHANGED, {
        sheetIndex: sheets.activeIndex,
        sheetName: active?.name ?? "",
      });
      api.emitAppEvent(api.AppEvents.ANNOTATIONS_CHANGED, {});
    } catch { /* ok */ }
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(350);
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
        if (s.id && s.id.startsWith("e2evba4-")) {
          try { so.ObjectScriptManager.unmountScript(s.id); } catch { /* not mounted */ }
          so.ObjectScriptManager.removeScript(s.id);
        }
      }
    } catch {
      /* manager not loaded */
    }
    try {
      const modules: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
      for (const m of modules) {
        if ((m.name && m.name.startsWith(prefix)) || (m.id && m.id.startsWith("macro-e2evba4"))) {
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

function fractionMatching(
  px: Array<[number, number, number]>,
  pred: (p: [number, number, number]) => boolean,
): number {
  if (px.length === 0) return 0;
  return px.filter(pred).length / px.length;
}

/** Fraction of pixels that differ from the patch's FIRST pixel by more than a
 *  small tolerance in any channel — 0 for a uniform (gridline-free) area. */
function fractionNonUniform(px: Array<[number, number, number]>): number {
  if (px.length === 0) return 0;
  const [r0, g0, b0] = px[0];
  const diff = px.filter(
    ([r, g, b]) => Math.abs(r - r0) > 6 || Math.abs(g - g0) > 6 || Math.abs(b - b0) > 6,
  );
  return diff.length / px.length;
}

/** Whether the grid is currently in cell edit mode (InlineEditor open). */
async function isEditing(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const gs = (window as any).__CALCULA_GRID_STATE__;
    return Boolean(gs?.editing);
  });
}

// ---------------------------------------------------------------------------
// The Object Script Editor window (same access pattern as vba-idioms-wave3)
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
  // POLL the store rather than reading it once: the idle write-through can
  // flush MID-TYPING (e.g. "3" of "350"), turn the chip Live, and only then
  // flush the rest — a single read races that second flush.
  await expect
    .poll(
      async () =>
        page.evaluate(async (id) => {
          const tauri = (window as any).__TAURI__;
          const script: any = await tauri.core.invoke("get_script", { id });
          return String(script?.source ?? "");
        }, macroId),
      { timeout: 30_000 },
    )
    .toContain(expectStored ?? to);
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

test.describe("Wave 4 VBA idioms (live, through the editor)", () => {
  // =========================================================================
  // CLAIM 1 — Application.StatusBar: live progress + restore-on-fault
  // =========================================================================

  test("1. setStatusBar cycles LIVE during a looping macro, clears to Ready, and a THROWING macro cannot pin it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} statusbar ${stamp}`;
    const macroId = `macro-e2evba4-sb-${stamp}`;
    const faultName = `${NAME_PREFIX} sbfault ${stamp}`;
    const faultId = `macro-e2evba4-sbfault-${stamp}`;

    const statusBarText = () =>
      page.evaluate(() => {
        const bars = document.querySelectorAll("div");
        for (const bar of bars) {
          if (window.getComputedStyle(bar).backgroundColor === "rgb(33, 115, 70)") {
            const span = bar.querySelector("span");
            return span?.textContent ?? "";
          }
        }
        return "";
      });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);
      expect(await statusBarText(), "precondition: the bar reads Ready").toBe("Ready");

      // The step delay is what gets TYPED — with the seeded 9ms the messages
      // would flash by faster than the sampler can see; the typed 350ms is
      // what makes the cycling VISIBLE, so a stale run cannot fake the pass.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba4StatusBar",
          `  const stepMs = 9;\n` +
            `  for (let i = 1; i <= 5; i++) {\n` +
            `    await api.setStatusBar("Wave4 row " + i);\n` +
            `    await api.sleep(stepMs);\n` +
            `  }\n` +
            `  await api.setStatusBar(null);\n` +
            `  await api.setCellValue(${RES_SB.row}, ${RES_SB.col}, "sb-done");\n`,
        ),
      });
      await seedMacro(page, {
        id: faultId,
        name: faultName,
        source: macroSource(
          faultName,
          "e2eVba4SbFault",
          `  await api.setStatusBar("Wave4 stuck");\n` +
            `  throw new Error("wave4-sb-fault");\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("the bar VISIBLY cycles through the loop's messages mid-run", async () => {
        await retypeAndStore(page, editorPage, macroId, "9", "350", "stepMs = 350");

        // In-page samplers BEFORE Run: an event log (every text change) and a
        // DOM poller (what a user actually sees on the bar).
        await page.evaluate(async () => {
          const api: any = await (window as any).__calcImport(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          const w = window as any;
          w.__e2eW4SbEvents = [];
          w.__e2eW4SbUnsub = api.onAppEvent(
            api.AppEvents.STATUS_BAR_TEXT_CHANGED,
            (d: { text: string | null }) => w.__e2eW4SbEvents.push(d.text),
          );
          w.__e2eW4SbDom = [];
          const bar = [...document.querySelectorAll("div")].find(
            (d) => window.getComputedStyle(d).backgroundColor === "rgb(33, 115, 70)",
          );
          w.__e2eW4SbTimer = setInterval(() => {
            const span = bar?.querySelector("span");
            const t = span?.textContent ?? "";
            const log = w.__e2eW4SbDom;
            if (log.length === 0 || log[log.length - 1] !== t) log.push(t);
          }, 60);
        });

        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_SB.row, RES_SB.col), { timeout: 90_000 })
            .toBe("sb-done");
        });

        const { events, domSamples } = await page.evaluate(() => {
          const w = window as any;
          clearInterval(w.__e2eW4SbTimer);
          w.__e2eW4SbUnsub?.();
          return {
            events: w.__e2eW4SbEvents as Array<string | null>,
            domSamples: w.__e2eW4SbDom as string[],
          };
        });

        // Every message travelled the event seam, in order, ending in a clear.
        const rowEvents = events.filter((t) => typeof t === "string" && /^Wave4 row \d$/.test(t));
        expect(rowEvents, "all five messages hit the status-bar seam").toEqual([
          "Wave4 row 1", "Wave4 row 2", "Wave4 row 3", "Wave4 row 4", "Wave4 row 5",
        ]);
        expect(events[events.length - 1], "the macro's final setStatusBar(null)").toBeNull();
        // ...and the DOM the user watches really CHANGED mid-run: at least
        // three distinct "Wave4 row N" texts were rendered, and the bar came
        // back to Ready afterwards.
        const domRows = [...new Set(domSamples.filter((t) => /^Wave4 row \d$/.test(t)))];
        expect(
          domRows.length,
          `the rendered bar visibly cycled (saw: ${JSON.stringify(domSamples)})`,
        ).toBeGreaterThanOrEqual(3);
        expect(await statusBarText(), "the bar is back to Ready").toBe("Ready");
      });

      await test.step("restore-on-fault: a THROWING macro cannot pin its message", async () => {
        // Run the fault macro through the MACRO LIBRARY (the one-shot
        // mount-run-unmount every button click uses — the lifecycle the
        // restore contract ends on; the editor's Run keeps a thrown run's
        // mount alive on purpose so the author can retry).
        const library = await openMacroLibrary(page, grid);
        const row = library.locator("[data-macro-library-item]").filter({ hasText: faultName });
        await expect(row).toHaveCount(1);
        await row.click();
        const runBtn = library.locator("[data-macro-run-button]");
        await expect(runBtn).toBeEnabled();
        await runBtn.click();

        await expect(library.locator("[data-macro-error]")).toContainText("wave4-sb-fault", {
          timeout: 60_000,
        });
        await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
        await expect(library).toBeHidden({ timeout: 5_000 });

        await expect
          .poll(async () => statusBarText(), { timeout: 20_000 })
          .toBe("Ready");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 2 — Application.Run: A -> B lands both; a cycle is refused by name
  // =========================================================================

  test("2. api.runMacro chains A -> B (both write), and a macro reaching itself is refused naming the chain", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const aName = `${NAME_PREFIX} chainA ${stamp}`;
    const aId = `macro-e2evba4-chaina-${stamp}`;
    const bName = `${NAME_PREFIX} chainB ${stamp}`;
    const bId = `macro-e2evba4-chainb-${stamp}`;
    const cName = `${NAME_PREFIX} cycle ${stamp}`;
    const cId = `macro-e2evba4-cycle-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);

      // B: the callee — writes its own marker.
      await seedMacro(page, {
        id: bId,
        name: bName,
        source: macroSource(
          bName,
          "e2eVba4ChainB",
          `  await api.setCellValue(60, 27, "B-ran");\n`,
        ),
      });
      // A: writes, then runs B BY NAME. The name is what gets TYPED — with
      // the seeded name no macro resolves and the run fails, so a stale run
      // can never produce the chain marker.
      await seedMacro(page, {
        id: aId,
        name: aName,
        source: macroSource(
          aName,
          "e2eVba4ChainA",
          `  const target = "SEEDCALLEE";\n` +
            `  await api.setCellValue(60, 26, "A-ran");\n` +
            `  const r = await api.runMacro(target);\n` +
            `  await api.setCellValue(${RES_CHAIN.row}, ${RES_CHAIN.col}, "chain-" + r.name);\n`,
        ),
      });
      // C: reaches ITSELF through api.runMacro and reports the refusal.
      await seedMacro(page, {
        id: cId,
        name: cName,
        source: macroSource(
          cName,
          "e2eVba4Cycle",
          `  const existing = await api.getCellValue(60, 28);\n` +
            `  try {\n` +
            `    await api.runMacro("${cName}");\n` +
            `  } catch (e) {\n` +
            `    if (existing === "") {\n` +
            `      await api.setCellValue(60, 28, "cycle:" + (e && e.message ? e.message : String(e)));\n` +
            `    }\n` +
            `  }\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, aName);
      await expect(documentSelect(editorPage)).toHaveValue(aId, { timeout: 20_000 });

      await test.step("type B's name into A and Run: both macros' writes landed", async () => {
        await retypeAndStore(page, editorPage, aId, "SEEDCALLEE", bName);
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_CHAIN.row, RES_CHAIN.col), {
              timeout: 90_000,
            })
            .toBe(`chain-${bName}`);
        });
        expect(await readActiveCell(page, 60, 26), "A's own write").toBe("A-ran");
        expect(await readActiveCell(page, 60, 27), "B's write, driven by A").toBe("B-ran");
        // RENDERED: both markers on the grid.
        expect(await grid.getCellFormulaBarText("AA61")).toBe("A-ran");
        expect(await grid.getCellFormulaBarText("AB61")).toBe("B-ran");
      });

      await test.step("a self-call is refused with the chain in the message", async () => {
        await destroyEditorWindow(page);
        await releaseTransientDebugMounts(page);
        const library = await openMacroLibrary(page, grid);
        const row = library.locator("[data-macro-library-item]").filter({ hasText: cName });
        await expect(row).toHaveCount(1);
        await row.click();
        const runBtn = library.locator("[data-macro-run-button]");
        await expect(runBtn).toBeEnabled();
        await runBtn.click();
        // The OUTER library run itself succeeds: the refusal happened one
        // level down and C caught it — poll the cell it reported into.
        await expect
          .poll(async () => readActiveCell(page, 60, 28), { timeout: 90_000 })
          .toContain("already running");
        const msg = await readActiveCell(page, 60, 28);
        expect(msg, "the refusal names the chain").toContain("call chain");
        expect(msg, "the chain names the macro twice (C -> C)").toContain(`${cName} -> ${cName}`);
        await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
        await expect(library).toBeHidden({ timeout: 5_000 });
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 3 — notes: round-trip + rendered triangle + hover preview
  // =========================================================================

  test("3. setNote/getNote/listNotes round-trip; the red triangle renders and clicking the cell shows the text", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} notes ${stamp}`;
    const macroId = `macro-e2evba4-notes-${stamp}`;
    const NOTE_TEXT = "Wave4 sticky note";

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);

      // The note TEXT is what gets typed — the macro reads it back and lists
      // it, so a stale run cannot produce the marker with the typed text.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba4Notes",
          `  const text = "SEEDNOTE";\n` +
            `  const r = await api.setNote(60, 26, text);\n` +
            `  const back = await api.getNote(60, 26);\n` +
            `  const list = await api.listNotes();\n` +
            `  const mine = list.filter(function (n) { return n.row === 60 && n.col === 26 && n.text === text; });\n` +
            `  const ok = r && r.id && back === text && mine.length === 1;\n` +
            `  await api.setCellValue(${RES_NOTE.row}, ${RES_NOTE.col}, ok ? "note-ok" : "note-bad-" + back + "-" + mine.length);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the note text and Run: set -> get -> list agree", async () => {
        await retypeAndStore(page, editorPage, macroId, "SEEDNOTE", NOTE_TEXT);
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_NOTE.row, RES_NOTE.col), { timeout: 90_000 })
            .toBe("note-ok");
        });
      });

      await test.step("RENDERED: the red note triangle sits on AA61's top-right corner", async () => {
        await grid.navigateTo("AD75");
        await grid.clickCell("AC70");
        const g = await gridGeom(page);
        // The triangle is drawn INSIDE the cell against its right edge.
        const patch = await samplePatch(page, colX(g, 27) - 8, rowY(g, 60) + 1, 7, 7);
        expect(
          fractionMatching(patch, isRed),
          "red triangle pixels at the note corner",
        ).toBeGreaterThan(0.1);
        // Control: the same corner of the (note-free) cell below is clean.
        const control = await samplePatch(page, colX(g, 27) - 8, rowY(g, 61) + 1, 7, 7);
        expect(fractionMatching(control, isRed), "no triangle on AA62").toBe(0);
        await page.screenshot({ path: "e2e/results/wave4-note-triangle.png", fullPage: false });
      });

      await test.step("clicking the annotated cell opens the note editor with the text", async () => {
        // The product's inspection surface for a note is CLICKING the
        // annotated cell: the Review extension's cell-click interceptor opens
        // the note-editor overlay pre-loaded with the note's content. (The
        // mousemove hover preview in hoverHandler.ts is unwired dead code —
        // initHoverHandler has no caller — so a hover shows nothing; click is
        // what a user actually does.)
        const g = await gridGeom(page);
        await grid.canvas.click({
          position: { x: colX(g, 26) + 30, y: rowY(g, 60) + g.cellH / 2 },
          force: true,
        });
        // A textarea's VALUE is not text content, so match on inputValue.
        const noteBox = page.locator("textarea:visible").first();
        await expect(noteBox, "the note editor opened").toBeVisible({ timeout: 10_000 });
        await expect(noteBox, "the note editor shows the script's text").toHaveValue(
          new RegExp(NOTE_TEXT),
          { timeout: 10_000 },
        );
        await page.screenshot({ path: "e2e/results/wave4-note-inspect.png", fullPage: false });
        // Close the overlay by moving the selection (the Review extension's
        // own selection handler hides it) so it cannot linger over later tests.
        await grid.navigateTo("AD75");
        await expect(noteBox).toBeHidden({ timeout: 10_000 });
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 4 — table structure aspects: addColumn + setTotalsRow, rendered
  // =========================================================================

  test("4. createTable + addColumn('Margin') + setTotalsRow(true): the rendered table gains both", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} table ${stamp}`;
    const macroId = `macro-e2evba4-table-${stamp}`;
    const tableName = `E2EW4T${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);
      // Seed AA65:AB70 — a header row and five data rows.
      await seedCellsDirect(page, [
        { row: 64, col: 26, value: "Item" },
        { row: 64, col: 27, value: "Price" },
        { row: 65, col: 26, value: "Alpha" },
        { row: 65, col: 27, value: "10" },
        { row: 66, col: 26, value: "Beta" },
        { row: 66, col: 27, value: "20" },
        { row: 67, col: 26, value: "Gamma" },
        { row: 67, col: 27, value: "30" },
        { row: 68, col: 26, value: "Delta" },
        { row: 68, col: 27, value: "40" },
        { row: 69, col: 26, value: "Epsilon" },
        { row: 69, col: 27, value: "50" },
      ]);

      // The added COLUMN NAME is what gets typed.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba4Table",
          `  const newCol = "SEEDCOLUMN";\n` +
            `  const ref = await api.createTable(64, 26, 69, 27, { name: "${tableName}", hasHeaders: true });\n` +
            `  const t = api.table(ref.id);\n` +
            `  await t.addColumn(newCol);\n` +
            `  await t.setTotalsRow(true);\n` +
            `  const all = await api.tables();\n` +
            `  const mine = all.find(function (x) { return x.id === ref.id; });\n` +
            `  await api.setCellValue(${RES_TBL.row}, ${RES_TBL.col}, "tbl-" + (mine ? mine.range : "gone") + "-" + (mine ? mine.columnCount : 0));\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      // Grid-anchored canvas band across the table's would-be new column and
      // totals row, captured BEFORE the run for the rendered-change proof.
      const captureBand = async (): Promise<string> => {
        await grid.navigateTo("AD75");
        await grid.clickCell("AD74");
        const g = await gridGeom(page);
        const px = await samplePatch(page, colX(g, 28), rowY(g, 64), 60, 8 * g.cellH);
        return JSON.stringify(px);
      };
      // PRECONDITION for the diff oracle: no table (backend or ghost chrome)
      // may be standing on the patch before the run.
      const preTables = await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        const all: any[] = await tauri.core.invoke("get_all_tables");
        return all.filter((t) => t.endRow >= 60 && t.startRow <= 99 && t.endCol >= 26);
      });
      expect(preTables, "no table stands on the patch before the run").toEqual([]);
      const beforeBand = await captureBand();

      await test.step("type the column name and Run: the table reports its grown shape", async () => {
        await retypeAndStore(page, editorPage, macroId, "SEEDCOLUMN", "Margin");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_TBL.row, RES_TBL.col), { timeout: 90_000 })
            .toMatch(/^tbl-/);
        });
        const marker = await readActiveCell(page, RES_TBL.row, RES_TBL.col);
        // AA65:AB70 + one column (AC) + one totals row (71), 3 columns.
        expect(marker, "the enumerated table spans the new column and totals row").toContain("AC71");
        expect(marker, "three columns after addColumn").toMatch(/-3$/);
      });

      await test.step("backend truth: Margin column + totals row + grown rectangle", async () => {
        const table = await page.evaluate(async (name) => {
          const tauri = (window as any).__TAURI__;
          const all: any[] = await tauri.core.invoke("get_all_tables");
          return all.find((t) => t.name === name) ?? null;
        }, tableName);
        expect(table, "the table exists in the backend").not.toBeNull();
        expect(table.columns.map((c: any) => c.name)).toEqual(["Item", "Price", "Margin"]);
        expect(table.endCol, "endCol grew to AC (28)").toBe(28);
        expect(table.endRow, "endRow grew to 71 (totals)").toBe(70);
        expect(table.styleOptions.totalRow, "totals row on").toBe(true);
      });

      await test.step("RENDERED: the chrome repainted over the new column + totals row", async () => {
        const afterBand = await captureBand();
        expect(
          afterBand !== beforeBand,
          "the canvas band over AC65:AC72 repainted with the table chrome",
        ).toBe(true);
        await page.screenshot({ path: "e2e/results/wave4-table-aspects.png", fullPage: false });
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 5 — view options: gridlines un-render / re-render; zoom rescales
  // =========================================================================

  test("5. setViewOption('gridlines') visibly toggles the grid; setZoom(150) rescales and getZoom answers percent", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} view ${stamp}`;
    const macroId = `macro-e2evba4-view-${stamp}`;

    const zoomState = () =>
      page.evaluate(() => (window as any).__CALCULA_GRID_STATE__?.zoom ?? 1);
    const gridlinesState = () =>
      page.evaluate(() => (window as any).__CALCULA_GRID_STATE__?.displayGridlines ?? true);

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);
      expect(await zoomState(), "precondition: zoom 100%").toBe(1);
      expect(await gridlinesState(), "precondition: gridlines on").toBe(true);

      // Three modes, selected by the TYPED digit: gridlines off, gridlines
      // on, then a zoom excursion that HOLDS 150% long enough to observe
      // before restoring 100% itself.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba4View",
          `  const modes = ["gloff", "glon", "zoom"];\n` +
            `  const mode = modes[9];\n` +
            `  if (mode === "gloff") {\n` +
            `    await api.setViewOption("gridlines", false);\n` +
            `    const gl = await api.getViewOption("gridlines");\n` +
            `    await api.setCellValue(${RES_VIEW.row}, ${RES_VIEW.col}, "view-off-" + gl);\n` +
            `  }\n` +
            `  if (mode === "glon") {\n` +
            `    await api.setViewOption("gridlines", true);\n` +
            `    const gl = await api.getViewOption("gridlines");\n` +
            `    await api.setCellValue(${RES_VIEW.row}, ${RES_VIEW.col}, "view-on-" + gl);\n` +
            `  }\n` +
            `  if (mode === "zoom") {\n` +
            `    await api.setZoom(150);\n` +
            `    const z1 = await api.getZoom();\n` +
            `    await api.sleep(3000);\n` +
            `    await api.setZoom(100);\n` +
            `    const z2 = await api.getZoom();\n` +
            `    await api.setCellValue(${RES_VIEW.row}, ${RES_VIEW.col}, "zoom-" + z1 + "-" + z2);\n` +
            `  }\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      // An empty grid patch spanning cell boundaries (AA61:AB63 area).
      const sampleGridlinePatch = async () => {
        await grid.navigateTo("AD75");
        await grid.clickCell("AD74");
        const g = await gridGeom(page);
        return samplePatch(page, colX(g, 26) + 4, rowY(g, 60) + 3, 120, 36);
      };

      await test.step("gridlines OFF: the lines un-render", async () => {
        const before = await sampleGridlinePatch();
        expect(
          fractionNonUniform(before),
          "precondition: gridline pixels present in the empty patch",
        ).toBeGreaterThan(0.01);

        await retypeAndStore(page, editorPage, macroId, "9", "0", "modes[0]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_VIEW.row, RES_VIEW.col), { timeout: 90_000 })
            .toBe("view-off-false");
        });
        expect(await gridlinesState(), "core state: gridlines off").toBe(false);
        await expect
          .poll(async () => fractionNonUniform(await sampleGridlinePatch()), { timeout: 20_000 })
          .toBeLessThan(0.002);
        await page.screenshot({ path: "e2e/results/wave4-gridlines-off.png", fullPage: false });
      });

      await test.step("gridlines ON: the lines re-render", async () => {
        await releaseTransientDebugMounts(page);
        await retypeAndStore(page, editorPage, macroId, "0", "1", "modes[1]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_VIEW.row, RES_VIEW.col), { timeout: 90_000 })
            .toBe("view-on-true");
        });
        expect(await gridlinesState(), "core state: gridlines back on").toBe(true);
        await expect
          .poll(async () => fractionNonUniform(await sampleGridlinePatch()), { timeout: 20_000 })
          .toBeGreaterThan(0.01);
      });

      await test.step("zoom 150 rescales the render, getZoom answers percent, 100 restored", async () => {
        await releaseTransientDebugMounts(page);
        // A stable canvas band, captured at 100% for the rescale-diff.
        await grid.navigateTo("AD75");
        await grid.clickCell("AD74");
        const g0 = await gridGeom(page);
        const bandAt100 = JSON.stringify(
          await samplePatch(page, colX(g0, 26), rowY(g0, 60), 160, 40),
        );

        await retypeAndStore(page, editorPage, macroId, "1", "2", "modes[2]");
        await toolbarButton(editorPage, "Run").click();

        // MID-RUN: the macro holds 150% for ~3s — observe the rendered scale.
        await expect.poll(async () => zoomState(), { timeout: 30_000 }).toBe(1.5);
        const bandAt150 = JSON.stringify(
          await samplePatch(page, colX(g0, 26), rowY(g0, 60), 160, 40),
        );
        expect(bandAt150 !== bandAt100, "the canvas visibly rescaled at 150%").toBe(true);
        await page.screenshot({ path: "e2e/results/wave4-zoom-150.png", fullPage: false });

        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_VIEW.row, RES_VIEW.col), { timeout: 90_000 })
            .toBe("zoom-150-100");
        });
        expect(await zoomState(), "zoom restored to 100%").toBe(1);
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 6 — Goal Seek: the converged solution renders in the variable cell
  // =========================================================================

  test("6. goalSeek drives AC62 (=AC61*3) to 30: AC61 renders the solution 10", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} goalseek ${stamp}`;
    const macroId = `macro-e2evba4-gs-${stamp}`;

    const asNumber = (s: string) => Number(String(s).replace(",", "."));

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);
      // AC61 = 2 (the variable), AC62 = AC61*3 (the target formula; no
      // argument separators — sv-SE-safe).
      await seedCellsDirect(page, [
        { row: 60, col: 28, value: "2" },
        { row: 61, col: 28, value: "=AC61*3" },
      ]);
      expect(await readActiveCell(page, 61, 28), "precondition: formula = 6").toBe("6");

      // The GOAL is what gets typed: with the seeded 900 the solution would
      // be 300, so a stale run cannot fake the 10 the assertions demand.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba4GoalSeek",
          `  const goal = 900;\n` +
            `  const r = await api.goalSeek({\n` +
            `    targetRow: 61, targetCol: 28, targetValue: goal,\n` +
            `    variableRow: 60, variableCol: 28,\n` +
            `  });\n` +
            `  await api.setCellValue(${RES_GS.row}, ${RES_GS.col}, "gs-" + r.converged + "-" + Math.round(r.solution * 1000));\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the goal 30 and Run: converged with solution 10", async () => {
        await retypeAndStore(page, editorPage, macroId, "900", "30", "goal = 30");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_GS.row, RES_GS.col), { timeout: 90_000 })
            .toMatch(/^gs-true-/);
        });
        const marker = await readActiveCell(page, RES_GS.row, RES_GS.col);
        const scaled = Number(marker.replace(/^gs-true-/, ""));
        expect(Math.abs(scaled - 10_000), "solution within 1e-3 of 10").toBeLessThanOrEqual(10);
      });

      await test.step("RENDERED: the variable cell shows 10 and the formula cell the target", async () => {
        const variable = asNumber(await grid.getCellDisplayValue("AC61"));
        expect(Math.abs(variable - 10), "AC61 renders the converged input").toBeLessThan(0.001);
        const target = asNumber(await grid.getCellDisplayValue("AC62"));
        expect(Math.abs(target - 30), "AC62 renders the goal").toBeLessThan(0.01);
        // The formula survived goal seek (only the INPUT was adjusted).
        await grid.navigateTo("AC62");
        await expect
          .poll(async () => grid.getFormulaBarValue(), { timeout: 10_000 })
          .toBe("=AC61*3");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 7 — removeDuplicates: removedCount + the rows close up on screen
  // =========================================================================

  test("7. removeDuplicates on AA80:AA86 removes the 3 repeats and the rendered rows close up", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} dedupe ${stamp}`;
    const macroId = `macro-e2evba4-dd-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);
      // 5,3,5,7,3,5,9 -> first occurrences 5,3,7,9 (3 removed).
      await seedCellsDirect(page, [
        { row: 79, col: 26, value: "5" },
        { row: 80, col: 26, value: "3" },
        { row: 81, col: 26, value: "5" },
        { row: 82, col: 26, value: "7" },
        { row: 83, col: 26, value: "3" },
        { row: 84, col: 26, value: "5" },
        { row: 85, col: 26, value: "9" },
      ]);

      // The range END is what gets typed: the seeded 985 is far past the
      // data, so a stale run would dedupe a different (mostly empty) range
      // and report a different shape.
      await seedMacro(page, {
        id: macroId,
        name: macroName,
        source: macroSource(
          macroName,
          "e2eVba4Dedupe",
          `  const endRow = 985;\n` +
            `  const r = await api.removeDuplicates(79, 26, endRow, 26);\n` +
            `  await api.setCellValue(${RES_DD.row}, ${RES_DD.col}, "dd-" + r.removedCount);\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type the true end row and Run: removedCount = 3", async () => {
        await retypeAndStore(page, editorPage, macroId, "985", "85", "endRow = 85");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_DD.row, RES_DD.col), { timeout: 90_000 })
            .toBe("dd-3");
        });
      });

      await test.step("RENDERED: 5,3,7,9 then blanks", async () => {
        expect(await grid.getCellFormulaBarText("AA80")).toBe("5");
        expect(await grid.getCellFormulaBarText("AA81")).toBe("3");
        expect(await grid.getCellFormulaBarText("AA82")).toBe("7");
        expect(await grid.getCellFormulaBarText("AA83")).toBe("9");
        expect(await grid.getCellFormulaBarText("AA84"), "closed up").toBe("");
        expect(await grid.getCellFormulaBarText("AA85"), "closed up").toBe("");
        expect(await grid.getCellFormulaBarText("AA86"), "closed up").toBe("");
        await page.screenshot({ path: "e2e/results/wave4-dedupe.png", fullPage: false });
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 8 — cancellable double-click: the veto is real and dies with the mount
  // =========================================================================

  test("8. a sheet script's onBeforeDoubleClick veto keeps AA61 out of edit mode; elsewhere edits; unmount lifts it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const scriptId = `e2evba4-dblclick-${stamp}`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);
      await grid.navigateTo("AD75");

      await test.step("mount the veto as a real sheet object script", async () => {
        const mountedOk = await page.evaluate(async (id) => {
          const api: any = await (window as any).__calcImport(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          const { ObjectScriptManager } = api;
          ObjectScriptManager.registerScript({
            id,
            name: "E2E Wave4 dblclick veto",
            objectType: "sheet",
            instanceId: null,
            source:
              'function setup(sheet) {\n' +
              '  sheet.onBeforeDoubleClick(function (d) {\n' +
              '    if (d.address === "AA61") return { cancel: true };\n' +
              '  });\n' +
              '}\n',
            accessLevel: "restricted",
            description: null,
          });
          await ObjectScriptManager.mountScript(id);
          return ObjectScriptManager.isScriptMounted(id);
        }, scriptId);
        expect(mountedOk, "the sheet script mounted").toBe(true);
        // The worker registers its replying hook asynchronously after mount.
        await page.waitForTimeout(1_500);
      });

      await test.step("a REAL double-click on AA61 does NOT enter edit mode", async () => {
        expect(await isEditing(page), "precondition: not editing").toBe(false);
        await grid.doubleClickCell("AA61");
        // The interceptor verdict is asynchronous — give it the full deadline
        // window and a margin, then require the editor NEVER opened.
        await page.waitForTimeout(2_200);
        expect(await isEditing(page), "the veto kept AA61 out of edit mode").toBe(false);
        await page.screenshot({ path: "e2e/results/wave4-dblclick-veto.png", fullPage: false });
      });

      await test.step("a double-click elsewhere DOES enter edit mode", async () => {
        await grid.doubleClickCell("AB65");
        await expect
          .poll(async () => isEditing(page), { timeout: 10_000 })
          .toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(async () => isEditing(page), { timeout: 5_000 }).toBe(false);
      });

      await test.step("after unmount the veto is gone", async () => {
        await page.evaluate(async (id) => {
          const api: any = await (window as any).__calcImport(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          api.ObjectScriptManager.unmountScript(id);
          api.ObjectScriptManager.removeScript(id);
        }, scriptId);
        await page.waitForTimeout(500);
        await grid.doubleClickCell("AA61");
        await expect
          .poll(async () => isEditing(page), { timeout: 10_000 })
          .toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(async () => isEditing(page), { timeout: 5_000 }).toBe(false);
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 9 — schedule.once: persists, fires once, removes itself
  // =========================================================================

  test("9. schedule.once ~6s out fires the exposed handler (marker lands) and the job self-removes from the list", async ({
    appPage: page,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const scriptId = `e2evba4-schedule-${stamp}`;
    const MARKER = `w4-fired-${stamp}`;

    const listJobs = () =>
      page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        return (await tauri.core.invoke("script_scheduler", {
          request: { op: "list" },
        })) as Array<{ id: string; scriptId: string; cadence: string }>;
      });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await restoreDocState(page);

      let jobId = "";
      await test.step("mount the workbook script, grant `schedule`, register the one-shot", async () => {
        // Mount a REAL workbook object script (the standing-mount surface the
        // scheduler serves — a transient module macro carries no R19 ceiling
        // and would be unmounted before the job could ever fire).
        const setupOk = await page.evaluate(async (a) => {
          const api: any = await (window as any).__calcImport(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          const { ObjectScriptManager, recordCapabilityGrant } = api;
          ObjectScriptManager.registerScript({
            id: a.scriptId,
            name: "E2E Wave4 schedule once",
            objectType: "workbook",
            instanceId: null,
            source:
              "// @capability schedule\n" +
              "function setup(context) {\n" +
              `  context.expose("e2eW4Fire", async function () {\n` +
              `    await context.api.setCellValue(74, 26, ${JSON.stringify(a.marker)});\n` +
              "  });\n" +
              '  context.expose("e2eW4Once", async function (delayMs) {\n' +
              "    const job = await context.caps.schedule.once(Date.now() + delayMs, \"e2eW4Fire\");\n" +
              "    return job.id;\n" +
              "  });\n" +
              "}\n",
            accessLevel: "unlocked",
            declaredCapabilities: ["schedule"],
            description: null,
          });
          await ObjectScriptManager.mountScript(a.scriptId);
          // Grant `schedule` on BOTH sides of the gate: the frontend broker
          // (session grant) and the authoritative Rust store the scheduler
          // re-checks on registration AND on every firing.
          recordCapabilityGrant(a.scriptId, "schedule");
          const tauri = (window as any).__TAURI__;
          await tauri.core.invoke("grant_script_capability", {
            scriptId: a.scriptId,
            capability: "schedule",
          });
          return ObjectScriptManager.isScriptMounted(a.scriptId);
        }, { scriptId, marker: MARKER });
        expect(setupOk, "the workbook script mounted").toBe(true);

        // Wait for setup() to have exposed the methods, then register the job.
        jobId = await page.evaluate(async () => {
          const api: any = await (window as any).__calcImport(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const list = api.listExposedMethods() as Array<{
              objectType: string; instanceId: string | null; methodName: string;
            }>;
            if (list.some((m) => m.objectType === "workbook" && m.methodName === "e2eW4Once")) {
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          return (await api.callExposedMethod("workbook", null, "e2eW4Once", 6_000)) as string;
        });
        expect(jobId, "the one-shot registered and answered a job id").toBeTruthy();
      });

      await test.step("the job is LISTED before firing (cadence once)", async () => {
        const jobs = await listJobs();
        const mine = jobs.find((j) => j.id === jobId);
        expect(mine, "the job is in the workbook's schedule list").toBeTruthy();
        expect(mine!.scriptId).toBe(scriptId);
        expect(mine!.cadence).toBe("once");
      });

      await test.step("the marker lands when the pump fires the job", async () => {
        // Due at +6s; the renderer pump ticks every 10s — allow a full margin.
        await expect
          .poll(async () => readActiveCell(page, 74, 26), { timeout: 30_000, intervals: [500] })
          .toBe(MARKER);
      });

      await test.step("the job removed itself after firing", async () => {
        await expect
          .poll(
            async () => {
              const jobs = await listJobs();
              return jobs.some((j) => j.id === jobId);
            },
            { timeout: 15_000 },
          )
          .toBe(false);
      });
    } finally {
      await page
        .evaluate(async (id) => {
          const api: any = await (window as any).__calcImport(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          try { api.ObjectScriptManager.unmountScript(id); } catch { /* ok */ }
          try { api.ObjectScriptManager.removeScript(id); } catch { /* ok */ }
        }, scriptId)
        .catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 10 — page setup: landscape + print area round-trip, then cleared
  // =========================================================================

  test("10. setPageSetup(landscape) + setPrintArea read back exactly; portrait + clearPrintArea read back empty", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} pagesetup ${stamp}`;
    const macroId = `macro-e2evba4-ps-${stamp}`;

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
          "e2eVba4PageSetup",
          `  const modes = ["set", "clear"];\n` +
            `  const mode = modes[9];\n` +
            `  if (mode === "set") {\n` +
            `    await api.setPageSetup({ orientation: "landscape" });\n` +
            `    const set = await api.setPrintArea(60, 26, 69, 27);\n` +
            `    const ps = await api.getPageSetup();\n` +
            `    const match = set.area === ps.printArea;\n` +
            `    await api.setCellValue(${RES_PS1.row}, ${RES_PS1.col}, "ps-" + ps.orientation + "-" + ps.printArea + "-" + match);\n` +
            `  }\n` +
            `  if (mode === "clear") {\n` +
            `    await api.setPageSetup({ orientation: "portrait" });\n` +
            `    await api.clearPrintArea();\n` +
            `    const ps = await api.getPageSetup();\n` +
            `    await api.setCellValue(${RES_PS2.row}, ${RES_PS2.col}, "ps2-" + ps.orientation + "-" + (ps.printArea === "" ? "none" : ps.printArea));\n` +
            `  }\n`,
        ),
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("set: landscape + AA61:AB70, read back key for key", async () => {
        await retypeAndStore(page, editorPage, macroId, "9", "0", "modes[0]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_PS1.row, RES_PS1.col), { timeout: 90_000 })
            .toBe("ps-landscape-AA61:AB70-true");
        });
        // Backend agrees (the same store Print/Export read from).
        const ps = await page.evaluate(async () => {
          const tauri = (window as any).__TAURI__;
          return tauri.core.invoke("get_page_setup");
        });
        expect(ps.orientation).toBe("landscape");
        expect(ps.printArea).toBe("AA61:AB70");
      });

      await test.step("clear: portrait again, print area empty", async () => {
        await releaseTransientDebugMounts(page);
        await retypeAndStore(page, editorPage, macroId, "0", "1", "modes[1]");
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readActiveCell(page, RES_PS2.row, RES_PS2.col), { timeout: 90_000 })
            .toBe("ps2-portrait-none");
        });
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await restoreDocState(page).catch(() => {});
    }
  });
});
