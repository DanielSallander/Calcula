/**
 * LIVE MACRO EDITING — the VBE model, proved against the real application.
 *
 * WHAT THE USER ASKED FOR. They edited a recorded macro in the Object Script
 * Editor and found Run and Debug DISABLED until they pressed "Save Macro":
 * "I would prefer that we emulate Excel, so that it is immediately changed and
 * runnable." In the VBE there is no per-module save step — the module IS the
 * live code, F5 runs what you are looking at, and Ctrl+S saves the WORKBOOK.
 *
 * WHY THIS FILE EXISTS. The change (an idle write-through plus a flush in front
 * of every gesture) is covered by unit tests, but every live run of this feature
 * has caught something the jsdom harness could not see: real Monaco, a real
 * separate Tauri window, real worker realms, the real module store and a real
 * grid. Nothing here is stubbed, and every edit is made with real keystrokes
 * into Monaco — double-click the value, type the new one — because "what the
 * editor does when you type" is the whole subject.
 *
 * THE CLAIMS (one test each, self-contained, cleaned up in a finally):
 *   1+2. EDIT THEN RUN, NO SAVE. Record a macro that writes a known value, retype
 *      that value, and press Run WITHOUT touching any save control: the grid gets
 *      the NEW value. Run and Debug are sampled every 25 ms across the whole
 *      dirty window and must never once be disabled. Proved twice — after the
 *      idle write-through has settled, and again with Run pressed immediately
 *      after the last keystroke (the flush-in-front-of-Run path). The store must
 *      also hold the new source with no gesture at all, the workbook must be
 *      marked modified, and reopening the macro must show the new text.
 *   3. A LINKED BUTTON PICKS UP THE EDIT. A real button on the canvas, linked to
 *      the macro, clicked after the edit, writes the NEW value — the single-
 *      source link model must still hold when the source is edited live.
 *   4. UNPARSEABLE SOURCE FAILS LOUDLY AND CLOBBERS NOTHING. Deliberately broken
 *      text is refused by the gate: the indicator turns red, the compiler error
 *      is on screen, the stored bytes are IDENTICAL to before, and Run refuses
 *      rather than silently running the stale stored copy.
 *   5. AN OPEN DEBUG SESSION IS NOT HOT-SWAPPED. With a session paused mid-macro,
 *      an edit is stored but the session keeps its instrumented snapshot: still
 *      alive, still paused on the same line, with a banner saying so; Run refuses
 *      while paused, and after Stop the next Run picks the edit up.
 *   6. THE INDICATOR MUST NOT LIE THE OTHER WAY. Type something that cannot be
 *      stored and delete it again: the buffer is once more byte-identical to the
 *      store, so the chip must say "Live". A chip stuck on "Saving…" reports
 *      unsaved work that does not exist — the exact confusion this feature
 *      exists to remove.
 *
 * SHARED APP. One app instance drives every functional spec, so this one owns a
 * private patch of the grid (column N, rows 61-69, plus a button in column P)
 * and cleans up before AND after each test.
 *
 * LOCALE. Every value written is a bare integer — no decimals, no list
 * separators — so the spec reads identically under sv-SE and en-US.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const SHEET = 0;

/** Every macro/module this spec creates carries this, so cleanup sweeps strays. */
const NAME_PREFIX = "E2ELiveEdit";

/** The Object Script Editor's fixed Tauri window label. */
const EDITOR_LABEL = "object-script-editor";

/** This spec's private patch of the grid — no other macro spec touches column N. */
const RUN_CELL = { ref: "N61", row: 60, col: 13 }; // claims 1+2
const BTN_OUT_CELL = { ref: "N63", row: 62, col: 13 }; // claim 3 — what the macro writes
const BTN_CTRL = { ref: "P63", row: 62, col: 15 }; // claim 3 — the button control
const BROKEN_CELL = { ref: "N65", row: 64, col: 13 }; // claim 4
const DEBUG_CELL = { ref: "N67", row: 66, col: 13 }; // claim 5
const CHIP_CELL = { ref: "N69", row: 68, col: 13 }; // claim 6

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

async function clearCells(page: Page, cells: Array<{ row: number; col: number }>): Promise<void> {
  await page.evaluate(async (cells) => {
    const tauri = (window as any).__TAURI__;
    for (const c of cells) {
      await tauri.core.invoke("update_cell", { row: c.row, col: c.col, value: "" });
    }
    window.dispatchEvent(new Event("grid:refresh"));
  }, cells);
  await page.waitForTimeout(150);
}

/** Scripts must be allowed to run, or every mount below is refused. */
async function allowScripts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    await tauri.core.invoke("set_script_security_level", { level: "enabled" });
  });
}

/** Find a stored module id by exact name. */
async function macroIdByName(page: Page, name: string): Promise<string | null> {
  return page.evaluate(async (name) => {
    const tauri = (window as any).__TAURI__;
    const scripts: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
    return scripts.find((s) => s.name === name)?.id ?? null;
  }, name);
}

/**
 * THE STORE'S OWN ANSWER to "what would run right now" — read straight from the
 * backend module store, never from the editor. Every persistence claim in this
 * file is decided here.
 */
async function storedSource(page: Page, id: string): Promise<string> {
  return page.evaluate(async (id) => {
    const tauri = (window as any).__TAURI__;
    const script: any = await tauri.core.invoke("get_script", { id });
    return String(script?.source ?? "");
  }, id);
}

/** Whether the backend considers the workbook to have unsaved changes. */
async function isFileModified(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    return (await tauri.core.invoke("is_file_modified")) === true;
  });
}

/** Seed a macro module straight into the workbook script store. */
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

/** The shape a recorded macro has: exactly one worker function plus `setup`. */
function macroSource(opts: {
  name: string;
  fnName: string;
  row: number;
  col: number;
  value: string;
}): string {
  return (
    `// Macro: ${opts.name}\n` +
    `// Target runtime: object script (unlocked)\n` +
    `async function ${opts.fnName}(api) {\n` +
    // A STRING, exactly as the recorder emits it. The sandboxed
    // `api.setCellValue` refuses a number outright ("value must be a string
    // (max 1 MB)"), so a bare numeric literal here would run to completion,
    // throw inside the realm and write nothing — a failure that looks exactly
    // like "the live edit never reached the grid" and is nothing of the kind.
    `  await api.setCellValue(${opts.row}, ${opts.col}, "${opts.value}");\n` +
    `}\n` +
    `\n` +
    `function setup(context) {\n` +
    `  if (!context.api) {\n` +
    `    context.notify("needs an UNLOCKED script", "error");\n` +
    `    return;\n` +
    `  }\n` +
    `  if (typeof context.onClick === "function") {\n` +
    `    context.onClick(async () => { await ${opts.fnName}(context.api); });\n` +
    `    return;\n` +
    `  }\n` +
    `  return ${opts.fnName}(context.api);\n` +
    `}\n`
  );
}

/** What the main window's SCRIPT HOST believes about a script id. */
async function hostDebugState(
  page: Page,
  scriptId: string,
): Promise<{
  sameModuleInstance: boolean;
  mounted: boolean;
  transientIds: string[];
  hasSession: boolean;
  status: string | null;
  pausedLine: number | null;
  lastActivity: string | null;
  lastActivityError: string | null;
  error: string | null;
}> {
  return page.evaluate(async (id) => {
    const host: any = await (window as any).__calcImport(
      new URL("/src/api/scriptHost/host.ts", document.baseURI).href,
    );
    const api: any = await (window as any).__calcImport(
      new URL("/src/api/index.ts", document.baseURI).href,
    );
    const session: any = host.getDebugSession(id);
    return {
      sameModuleInstance: host.hostIsMounted === api.hostIsMounted,
      mounted: host.hostIsMounted(id) === true,
      transientIds: (host.hostTransientDebugMountIds() as string[]) ?? [],
      hasSession: !!session,
      status: session ? String(session.status) : null,
      pausedLine: typeof session?.paused?.line === "number" ? Number(session.paused.line) : null,
      lastActivity: session?.lastActivity ? String(session.lastActivity.label) : null,
      lastActivityError: session?.lastActivity?.error ? String(session.lastActivity.error) : null,
      error: session?.error ? String(session.error) : null,
    };
  }, scriptId);
}

/** Release any debugger-owned mount this spec (or a crashed run) left behind. */
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

/** Remove every module + button this spec created. Idempotent; before AND after. */
/**
 * End a recording session left running by an earlier test or a crashed run.
 *
 * THE RECORDER IS A SINGLETON WITH A TOGGLED MENU ITEM. It registers exactly ONE
 * Developer-menu item whose label is derived from `subscribeToRecorder` — "Record
 * Macro" when idle, "Stop Recording" while armed. So a session that outlives its
 * test does not merely leave junk behind: it renames the entry point, and every
 * later run fails at `/^Record Macro/` with a timeout that looks like a missing
 * menu item rather than like leftover state. That is exactly how this spec failed
 * after a Playwright worker died mid-recording (0xC0000409): the app was healthy,
 * the feature worked, and three separate runs still failed at the first step.
 *
 * Stopping through the on-screen indicator — the same control a user presses, and
 * the one the other macro specs use — rather than by reaching into the recorder
 * module, so this cannot drift from the real stop path.
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

  // Stopping opens the review dialog. Close it however it came up — the
  // recording it describes is abandoned state, and `cleanup` deletes whatever
  // module it may have written on the way out.
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

async function cleanup(
  page: Page,
  buttonAnchors: Array<{ row: number; col: number }> = [],
): Promise<void> {
  // FIRST: a live recording renames the menu item every test starts from.
  await ensureNotRecording(page);
  await releaseTransientDebugMounts(page);
  await page.evaluate(
    async ({ prefix, sheet, anchors }) => {
      const tauri = (window as any).__TAURI__;
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
      try {
        const modules: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
        for (const m of modules) {
          if (
            (m.name && m.name.startsWith(prefix)) ||
            (m.id && m.id.startsWith("macro-e2eliveedit"))
          ) {
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

// ---------------------------------------------------------------------------
// The Object Script Editor window
// ---------------------------------------------------------------------------

/** DESTROY (not merely close) any editor window a previous run left behind. */
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

/** The editor page, once it exists and has loaded. */
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

/** Double-click a macro row and hand back the editor window, Monaco mounted. */
async function openMacroInEditor(page: Page, grid: any, macroName: string): Promise<Page> {
  const library = await openMacroLibrary(page, grid);
  const row = library.locator("[data-macro-library-item]").filter({ hasText: macroName });
  await expect(row).toHaveCount(1);
  await row.dblclick();
  const editorPage = await findEditorPage(page, 45_000);
  await editorPage.waitForSelector(".monaco-editor", { state: "visible", timeout: 45_000 });
  // Let the open-with-macro payload land and the document settle.
  await editorPage.waitForTimeout(1_500);
  // The library's backdrop would otherwise cover the main grid.
  await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
  await expect(library).toBeHidden({ timeout: 5_000 });
  return editorPage;
}

/** The document selector (the first .ose-select in the toolbar). */
function documentSelect(editorPage: Page) {
  return editorPage.locator("select.ose-select").first();
}

/** Every console line the editor has printed, newest last. */
async function consoleText(editorPage: Page): Promise<string> {
  const lines = await editorPage.locator(".ose-console-line").allInnerTexts();
  return lines.join("\n");
}

/** The module live-state chip that REPLACED the Save button for modules. */
function liveIndicator(editorPage: Page) {
  return editorPage.locator("[data-testid='module-live-indicator']");
}

/** "live" | "saving" | "deferred" | "error" — the chip's machine-readable state. */
async function liveState(editorPage: Page): Promise<string | null> {
  const el = liveIndicator(editorPage);
  if ((await el.count()) === 0) return null;
  return el.first().getAttribute("data-live-state");
}

/** The text Monaco is showing right now (these documents render in full). */
async function editorText(editorPage: Page): Promise<string> {
  const text = await editorPage.locator(".monaco-editor .view-lines").first().innerText();
  return text.replace(/ /g, " ");
}

/**
 * Source text reduced to what survives a trip through Monaco's DOM: no trailing
 * whitespace, no blank lines. Enough to say "the buffer is the file again"
 * without asserting on indentation the renderer is free to express differently.
 */
function normalizeSource(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/ /g, " ").trimEnd())
    .filter((l) => l.trim().length > 0)
    .join("\n");
}

/** The literal a recorded macro writes into (row, col) — the token to retype. */
function recordedLiteral(source: string, row: number, col: number): string | null {
  const m = new RegExp(
    `setCellValue\\(\\s*${row}\\s*,\\s*${col}\\s*,\\s*"?([^",)]+)"?\\s*\\)`,
  ).exec(source);
  return m ? m[1] : null;
}

/**
 * Wait until the editor shows NO debug session.
 *
 * The editor window mirrors the host's session over a bridge, so the host can
 * have torn a session down a beat before this window knows. Pressing Run into
 * that gap is not something a person can do — they are looking at the badge —
 * so the spec waits for the same thing they would.
 */
async function waitForNoSession(editorPage: Page): Promise<void> {
  await expect(editorPage.locator(".osd-badge")).toHaveCount(0, { timeout: 60_000 });
  await expect(toolbarButton(editorPage, "Debug")).toBeVisible({ timeout: 30_000 });
}

/**
 * Run an assertion; if it fails, attach what the editor was saying at the time.
 *
 * A failed poll otherwise reports only "expected X, got Y" about a cell, which
 * says nothing about WHY — and the two windows that could explain it (the
 * editor's console, the host's session) are not in the screenshot.
 */
async function withEditorConsole<T>(
  editorPage: Page,
  fn: () => Promise<T>,
  host?: { page: Page; scriptId: string },
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const text = await consoleText(editorPage).catch(() => "(console unavailable)");
    const live = await liveState(editorPage).catch(() => null);
    const code = await editorText(editorPage).catch(() => "(editor unavailable)");
    const session = host
      ? JSON.stringify(await hostDebugState(host.page, host.scriptId).catch(() => null))
      : "(not requested)";
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        `--- live state: ${live}\n--- host session: ${session}\n` +
        `--- editor console ---\n${text}\n--- buffer ---\n${code}`,
    );
  }
}

/**
 * Retype a value the way a person would: double-click it to select the word,
 * then type the replacement. Real keystrokes through Monaco's own input path —
 * which is what the live-persist debounce is listening to.
 */
async function retypeToken(editorPage: Page, from: string, to: string): Promise<void> {
  const token = editorPage
    .locator(".monaco-editor .view-lines span")
    .filter({ hasText: new RegExp(`^["']?${from}["']?$`) })
    .first();
  await expect(token, `the value ${from} is on screen to be edited`).toBeVisible({
    timeout: 20_000,
  });
  await token.dblclick();
  await editorPage.waitForTimeout(120);
  await editorPage.keyboard.type(to, { delay: 40 });
}

/**
 * Add text at the very end of the document.
 *
 * `insertText` rather than `type`: a multi-character insert goes in verbatim,
 * where per-character typing would trigger Monaco's bracket auto-closing and
 * quietly repair the very syntax error the test is trying to make.
 */
async function insertAtEnd(editorPage: Page, text: string): Promise<void> {
  await editorPage.locator(".monaco-editor .view-lines").first().click();
  await editorPage.waitForTimeout(120);
  await editorPage.keyboard.press("Control+End");
  await editorPage.keyboard.insertText(text);
}

/** The editor toolbar's Run / Debug buttons (never the debug panel's Fire rows). */
function toolbarButton(editorPage: Page, label: "Run" | "Debug" | "Stop" | "Continue") {
  return editorPage.locator("button.ose-btn").filter({ hasText: new RegExp(`^${label}$`) }).first();
}

/**
 * Start an in-page sampler over the controls this feature is about.
 *
 * Sampling from the test process would take one reading per CDP round trip and
 * could miss the dirty window entirely; "Run was NEVER disabled while the buffer
 * was dirty" is a claim about an interval, so the samples are taken inside the
 * page at 25 ms and read back afterwards.
 */
async function startControlSampler(editorPage: Page): Promise<void> {
  await editorPage.evaluate(() => {
    const w = window as any;
    if (w.__liveSamplerTimer) clearInterval(w.__liveSamplerTimer);
    w.__liveSamples = [];
    const findBtn = (label: string): HTMLButtonElement | undefined =>
      Array.from(document.querySelectorAll("button.ose-btn")).find(
        (b) => (b.textContent || "").trim() === label,
      ) as HTMLButtonElement | undefined;
    w.__liveSamplerTimer = setInterval(() => {
      const run = findBtn("Run");
      const dbg = findBtn("Debug");
      const chip = document.querySelector("[data-testid='module-live-indicator']");
      const status = document.querySelector(
        "[data-testid='editor-save-state']",
      ) as HTMLElement | null;
      w.__liveSamples.push({
        t: Date.now(),
        runPresent: !!run,
        runDisabled: run ? run.disabled === true : null,
        debugPresent: !!dbg,
        debugDisabled: dbg ? dbg.disabled === true : null,
        live: chip ? chip.getAttribute("data-live-state") : null,
        status: status ? status.innerText.trim() : null,
      });
    }, 25);
  });
}

interface ControlSample {
  t: number;
  runPresent: boolean;
  runDisabled: boolean | null;
  debugPresent: boolean;
  debugDisabled: boolean | null;
  live: string | null;
  status: string | null;
}

async function stopControlSampler(editorPage: Page): Promise<ControlSample[]> {
  return editorPage.evaluate(() => {
    const w = window as any;
    if (w.__liveSamplerTimer) clearInterval(w.__liveSamplerTimer);
    w.__liveSamplerTimer = null;
    return (w.__liveSamples ?? []) as ControlSample[];
  });
}

/** Record every workbook dirty-state announcement the editor window makes. */
async function watchDirtyEvents(editorPage: Page): Promise<void> {
  await editorPage.evaluate(() => {
    const w = window as any;
    w.__dirtyEvents = [];
    if (w.__dirtyListener) window.removeEventListener("app:dirty-state-changed", w.__dirtyListener);
    w.__dirtyListener = (e: any) => w.__dirtyEvents.push(e?.detail?.isDirty === true);
    window.addEventListener("app:dirty-state-changed", w.__dirtyListener);
  });
}

async function readDirtyEvents(editorPage: Page): Promise<boolean[]> {
  return editorPage.evaluate(() => ((window as any).__dirtyEvents ?? []) as boolean[]);
}

/**
 * The CSS-pixel point on the canvas that lands inside a floating button anchored
 * at (row, col). Mirrors createButtonControlAt + getFloatingCanvasBounds, reading
 * LIVE grid state so a prior width/zoom change still hits the button.
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

async function readDesignMode(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const mod: any = await (window as any).__calcImport(
      new URL("/src/api/designMode.ts", document.baseURI).href,
    );
    return mod.getDesignMode() === true;
  });
}

/** Turn Design Mode off if a previous spec left it on (a click would select). */
async function ensureDesignModeOff(page: Page, grid: any): Promise<void> {
  if (await readDesignMode(page)) {
    await grid.menuAction("Developer", "Design Mode");
  }
  expect(await readDesignMode(page)).toBe(false);
}

/**
 * Sample a predicate repeatedly for `ms` and fail the moment it stops holding.
 * A single reading after a wait proves nothing about an interval.
 */
async function assertHoldsFor(
  page: Page,
  ms: number,
  because: string,
  probe: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + ms;
  let samples = 0;
  while (Date.now() < deadline) {
    const ok = await probe();
    samples++;
    expect(ok, `${because} (sample ${samples})`).toBe(true);
    await page.waitForTimeout(250);
  }
  expect(samples, "the condition was actually sampled").toBeGreaterThan(3);
}

// ===========================================================================

test.describe("Live macro editing (the VBE model)", () => {
  // =========================================================================
  // CLAIMS 1 + 2 — THE REQUEST: edit, press Run, no save step anywhere
  // =========================================================================

  test("1+2. an edited macro runs and is stored with NO save gesture", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} run ${stamp}`;
    // No repeated adjacent digits anywhere: a doubled character typed into the
    // canvas at 30 ms is the one keystroke WebView2 is known to swallow, and a
    // recording that lost a digit would fail this spec for a reason that has
    // nothing to do with live editing.
    const ORIGINAL = "61234";
    const EDITED = "62345";
    const EDITED_AGAIN = "63456";

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [RUN_CELL]);

    let macroId: string | null = null;

    try {
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
        await expect(page.locator("[data-macro-recorder-indicator]")).toBeVisible({
          timeout: 5_000,
        });

        await grid.setCellValue(RUN_CELL.ref, ORIGINAL);
        expect(
          await readCell(page, RUN_CELL.row, RUN_CELL.col),
          "the value really reached the cell (a dropped keystroke would be recorded verbatim)",
        ).toBe(ORIGINAL);

        await page
          .locator("[data-macro-recorder-indicator] button")
          .filter({ hasText: /^Stop$/ })
          .click();
        const result = page.locator("[data-macro-result-dialog]");
        await expect(result).toBeVisible({ timeout: 20_000 });
        await expect(result.locator("[data-macro-save-error]")).toHaveCount(0);
        await expect(result.locator("[data-macro-saved-banner]")).toContainText(macroName);
        await result.locator("[data-macro-result-close]").click();
        await expect(result).toBeHidden({ timeout: 5_000 });
      });

      macroId = await macroIdByName(page, macroName);
      expect(macroId, "the macro was stored as a module").not.toBeNull();

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId!, { timeout: 20_000 });

      await test.step("the module has NO save button — it has a live indicator", async () => {
        await expect(liveIndicator(editorPage)).toBeVisible({ timeout: 20_000 });
        await expect(editorPage.locator("button").filter({ hasText: /^Save Macro$/ })).toHaveCount(
          0,
        );
        await expect(editorPage.locator("button").filter({ hasText: /^Save & Apply$/ })).toHaveCount(
          0,
        );
        expect(await liveState(editorPage)).toBe("live");
        await expect(editorPage.locator("[data-testid='editor-save-state']")).toHaveText("Live");
      });

      await test.step("Run and Debug are offered on a CLEAN buffer", async () => {
        await expect(toolbarButton(editorPage, "Run")).toBeEnabled({ timeout: 10_000 });
        await expect(toolbarButton(editorPage, "Debug")).toBeEnabled();
      });

      const before = await storedSource(page, macroId!);
      expect(
        recordedLiteral(before, RUN_CELL.row, RUN_CELL.col),
        "the recorded source writes exactly the value that was typed",
      ).toBe(ORIGINAL);

      // -- THE EDIT: retype the value, press nothing else ---------------------
      await watchDirtyEvents(editorPage);
      await startControlSampler(editorPage);
      await test.step("retype the value in the buffer (no save control is pressed)", async () => {
        await retypeToken(editorPage, ORIGINAL, EDITED);
      });

      await test.step("the buffer reaches the store on its own (idle write-through)", async () => {
        await expect.poll(async () => liveState(editorPage), { timeout: 30_000 }).toBe("live");
        const stored = await storedSource(page, macroId!);
        expect(stored, "the module store holds the edit").toContain(EDITED);
        expect(stored, "and no longer the original").not.toContain(ORIGINAL);
      });

      const samples = await stopControlSampler(editorPage);

      // -- CLAIM 1a: the controls were never taken away ----------------------
      await test.step("Run and Debug were NEVER disabled while the buffer was dirty", async () => {
        expect(samples.length, "the controls were densely sampled").toBeGreaterThan(20);
        const sawDirty = samples.filter((s) => s.live === "saving");
        expect(
          sawDirty.length,
          `the dirty window was actually observed: ${JSON.stringify(
            samples.map((s) => s.live).slice(0, 60),
          )}`,
        ).toBeGreaterThan(0);
        const runDisabled = samples.filter((s) => s.runPresent && s.runDisabled === true);
        expect(
          runDisabled.length,
          `Run must never be disabled by an unsaved buffer (${runDisabled.length}/${samples.length} samples)`,
        ).toBe(0);
        const debugDisabled = samples.filter((s) => s.debugPresent && s.debugDisabled === true);
        expect(
          debugDisabled.length,
          `Debug must never be disabled by an unsaved buffer (${debugDisabled.length}/${samples.length} samples)`,
        ).toBe(0);
        expect(
          samples.filter((s) => s.runPresent).length,
          "the Run button was on screen throughout",
        ).toBe(samples.length);
      });

      // -- CLAIM 2: stored, and the workbook knows it ------------------------
      await test.step("the workbook is marked modified by the live write", async () => {
        const events = await readDirtyEvents(editorPage);
        expect(
          events.filter((d) => d === true).length,
          "the module write announced app:dirty-state-changed { isDirty: true }",
        ).toBeGreaterThan(0);
        expect(await isFileModified(page), "the backend marks the workbook unsaved").toBe(true);
      });

      // -- CLAIM 1: press Run; the NEW value lands ---------------------------
      await test.step("Run (no save pressed, ever) writes the EDITED value", async () => {
        await clearCells(page, [RUN_CELL]);
        expect(await readCell(page, RUN_CELL.row, RUN_CELL.col)).toBe("");
        const runBtn = toolbarButton(editorPage, "Run");
        await expect(runBtn).toBeEnabled();
        await runBtn.click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readCell(page, RUN_CELL.row, RUN_CELL.col), { timeout: 90_000 })
            .toBe(EDITED);
        });
        expect(await readCell(page, RUN_CELL.row, RUN_CELL.col)).not.toBe(ORIGINAL);
      });

      // -- CLAIM 1 again, the harder half: Run BEFORE the debounce settles ---
      await test.step("a Run pressed immediately after typing flushes first", async () => {
        await releaseTransientDebugMounts(page);
        await expect
          .poll(async () => (await hostDebugState(page, macroId!)).hasSession, { timeout: 30_000 })
          .toBe(false);
        await waitForNoSession(editorPage);
        await clearCells(page, [RUN_CELL]);
        await retypeToken(editorPage, EDITED, EDITED_AGAIN);
        // No wait for the indicator: press Run straight away. The flush in front
        // of Run is what has to make this work.
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readCell(page, RUN_CELL.row, RUN_CELL.col), { timeout: 90_000 })
            .toBe(EDITED_AGAIN);
        });
        expect(await storedSource(page, macroId!), "and what ran is what was stored").toContain(
          EDITED_AGAIN,
        );
      });

      // -- CLAIM 2: reopening the macro shows the new text --------------------
      await test.step("closing and reopening the macro shows the EDITED source", async () => {
        await releaseTransientDebugMounts(page);
        await destroyEditorWindow(page);
        const reopened = await openMacroInEditor(page, grid, macroName);
        await expect(documentSelect(reopened)).toHaveValue(macroId!, { timeout: 20_000 });
        const text = await editorText(reopened);
        expect(text, "the reopened document holds the edit").toContain(EDITED_AGAIN);
        expect(text, "and not the recorded original").not.toContain(ORIGINAL);
        expect(await liveState(reopened)).toBe("live");
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [RUN_CELL]).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 3 — a linked BUTTON runs the live-edited macro
  // =========================================================================

  test("3. a linked button runs the LIVE-edited macro (no save, no reopen)", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} button ${stamp}`;
    const ORIGINAL = "64321";
    const EDITED = "65432";
    const anchors = [{ row: BTN_CTRL.row, col: BTN_CTRL.col }];

    await allowScripts(page);
    await cleanup(page, anchors);
    await destroyEditorWindow(page);
    await clearCells(page, [BTN_OUT_CELL]);
    await ensureDesignModeOff(page, grid);

    let macroId: string | null = null;

    try {
      await test.step("record a macro and link a button to it", async () => {
        await grid.openMenu("Developer");
        const rec = page.locator("button").filter({ hasText: /^Record Macro/ }).first();
        await rec.waitFor({ state: "visible", timeout: 5_000 });
        await rec.click();
        const dialog = page.locator("[data-macro-start-dialog]");
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        await dialog.locator("[data-macro-name-input]").fill(macroName);
        await dialog.locator('[data-macro-target="objectScript"]').check();
        await dialog.locator("[data-macro-start-button]").click();
        await expect(page.locator("[data-macro-recorder-indicator]")).toBeVisible({
          timeout: 5_000,
        });

        await grid.setCellValue(BTN_OUT_CELL.ref, ORIGINAL);
        expect(
          await readCell(page, BTN_OUT_CELL.row, BTN_OUT_CELL.col),
          "the value really reached the cell before it was recorded",
        ).toBe(ORIGINAL);

        await page
          .locator("[data-macro-recorder-indicator] button")
          .filter({ hasText: /^Stop$/ })
          .click();
        const result = page.locator("[data-macro-result-dialog]");
        await expect(result).toBeVisible({ timeout: 20_000 });
        await expect(result.locator("[data-macro-saved-banner]")).toContainText(macroName);
        await result.locator("[data-macro-result-close]").click();
        await expect(result).toBeHidden({ timeout: 5_000 });

        const library = await openMacroLibrary(page, grid);
        const row = library.locator("[data-macro-library-item]").filter({ hasText: macroName });
        await expect(row).toHaveCount(1);
        await row.click();
        await library.locator("[data-macro-anchor-input]").fill(BTN_CTRL.ref);
        await library.locator("[data-macro-add-button]").click();
        await expect(
          page
            .locator("[data-toast]")
            .filter({ hasText: new RegExp(`Button created at ${BTN_CTRL.ref}`) }),
        ).toBeVisible({ timeout: 20_000 });
        await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
        await expect(library).toBeHidden({ timeout: 5_000 });
      });

      macroId = await macroIdByName(page, macroName);
      expect(macroId).not.toBeNull();

      await test.step("baseline: the button runs the ORIGINAL macro", async () => {
        await clearCells(page, [BTN_OUT_CELL]);
        const point = await buttonCanvasPoint(page, BTN_CTRL.row, BTN_CTRL.col);
        await grid.canvas.click({ position: point, force: true });
        await expect
          .poll(async () => readCell(page, BTN_OUT_CELL.row, BTN_OUT_CELL.col), { timeout: 60_000 })
          .toBe(ORIGINAL);
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId!, { timeout: 20_000 });

      await test.step("edit the macro in the editor — press NOTHING else", async () => {
        expect(
          recordedLiteral(await storedSource(page, macroId!), BTN_OUT_CELL.row, BTN_OUT_CELL.col),
          "the recorded source writes exactly the value that was typed",
        ).toBe(ORIGINAL);
        await retypeToken(editorPage, ORIGINAL, EDITED);
        await expect.poll(async () => liveState(editorPage), { timeout: 30_000 }).toBe("live");
        expect(await storedSource(page, macroId!)).toContain(EDITED);
      });

      // -- THE PROOF: the same button, unchanged, now writes the new value ---
      await test.step("the SAME button now writes the EDITED value", async () => {
        await clearCells(page, [BTN_OUT_CELL]);
        expect(await readCell(page, BTN_OUT_CELL.row, BTN_OUT_CELL.col)).toBe("");
        const point = await buttonCanvasPoint(page, BTN_CTRL.row, BTN_CTRL.col);
        await grid.canvas.click({ position: point, force: true });
        await expect
          .poll(async () => readCell(page, BTN_OUT_CELL.row, BTN_OUT_CELL.col), { timeout: 60_000 })
          .toBe(EDITED);
        expect(
          await readCell(page, BTN_OUT_CELL.row, BTN_OUT_CELL.col),
          "decisively not the pre-edit version",
        ).not.toBe(ORIGINAL);
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page, anchors).catch(() => {});
      await clearCells(page, [BTN_OUT_CELL]).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 4 — broken source is refused, loudly, and clobbers nothing
  // =========================================================================

  test("4. unparseable source is refused and the stored version survives", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} broken ${stamp}`;
    const macroId = `macro-e2eliveedit-broken-${stamp}`;
    const VALUE = "66543";
    const REPAIRED = "67654";
    const good = macroSource({
      name: macroName,
      fnName: "e2eLiveEditBroken",
      row: BROKEN_CELL.row,
      col: BROKEN_CELL.col,
      value: VALUE,
    });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [BROKEN_CELL]);

    try {
      await seedMacro(page, { id: macroId, name: macroName, source: good });
      const storedGood = await storedSource(page, macroId);
      expect(storedGood, "the seeded bytes are what the store holds").toBe(good);

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("type source that cannot possibly parse", async () => {
        await insertAtEnd(editorPage, "\nfunction e2eBroken( {\n");
        await expect.poll(async () => liveState(editorPage), { timeout: 30_000 }).toBe("error");
      });

      await test.step("the failure is on screen, in the chip and the status bar", async () => {
        await expect(liveIndicator(editorPage)).toContainText("Not stored");
        await expect(editorPage.locator("[data-testid='editor-save-state']")).toHaveText(
          "Not stored — does not compile",
        );
        await expect
          .poll(async () => consoleText(editorPage), { timeout: 20_000 })
          .toMatch(/stored version is unchanged/i);
      });

      await test.step("the stored bytes are IDENTICAL to before — nothing was clobbered", async () => {
        expect(await storedSource(page, macroId)).toBe(storedGood);
      });

      await test.step("Run REFUSES rather than running the stale stored copy", async () => {
        await clearCells(page, [BROKEN_CELL]);
        expect(await readCell(page, BROKEN_CELL.row, BROKEN_CELL.col)).toBe("");
        const runBtn = toolbarButton(editorPage, "Run");
        await expect(runBtn, "Run stays offered even on broken source").toBeEnabled();
        await runBtn.click();
        await expect
          .poll(async () => consoleText(editorPage), { timeout: 30_000 })
          .toMatch(/Run did not start/i);
        expect(await consoleText(editorPage)).toMatch(/never quietly fall back/i);
        // The decisive half: the older stored version did NOT run behind the
        // author's back.
        await page.waitForTimeout(4_000);
        expect(
          await readCell(page, BROKEN_CELL.row, BROKEN_CELL.col),
          "a refused Run executes nothing at all",
        ).toBe("");
        expect(await storedSource(page, macroId)).toBe(storedGood);
      });

      await test.step("repairing the text makes it live again, and Run works", async () => {
        // Remove the broken tail the way a person would: undo it. Undo is a
        // per-edit step and a multi-line insert can be more than one, so this
        // presses until the buffer IS the file again rather than counting.
        await editorPage.locator(".monaco-editor .view-lines").first().click();
        for (let i = 0; i < 8; i++) {
          if (normalizeSource(await editorText(editorPage)) === normalizeSource(good)) break;
          await editorPage.keyboard.press("Control+z");
          await editorPage.waitForTimeout(250);
        }
        expect(
          normalizeSource(await editorText(editorPage)),
          "the buffer is the last good version again",
        ).toBe(normalizeSource(good));
        // ...and change the value, so what runs next is provably the new text.
        await retypeToken(editorPage, VALUE, REPAIRED);
        await withEditorConsole(editorPage, async () => {
          await expect.poll(async () => liveState(editorPage), { timeout: 30_000 }).toBe("live");
        });
        expect(await storedSource(page, macroId)).toContain(REPAIRED);
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(editorPage, async () => {
          await expect
            .poll(async () => readCell(page, BROKEN_CELL.row, BROKEN_CELL.col), { timeout: 90_000 })
            .toBe(REPAIRED);
        });
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [BROKEN_CELL]).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 5 — an open debug session is never hot-swapped by an edit
  // =========================================================================

  test("5. an open debug session keeps its snapshot when the buffer is edited", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} debug ${stamp}`;
    const macroId = `macro-e2eliveedit-debug-${stamp}`;
    const ORIGINAL = "68123";
    const EDITED = "69234";
    const source = macroSource({
      name: macroName,
      fnName: "e2eLiveEditDebug",
      row: DEBUG_CELL.row,
      col: DEBUG_CELL.col,
      value: ORIGINAL,
    });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [DEBUG_CELL]);

    try {
      await seedMacro(page, { id: macroId, name: macroName, source });
      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("Debug, then Run — the session suspends inside the macro", async () => {
        await toolbarButton(editorPage, "Debug").click();
        await expect(editorPage.locator(".osd-badge")).toBeVisible({ timeout: 60_000 });
        await expect
          .poll(async () => (await hostDebugState(page, macroId)).status, { timeout: 60_000 })
          .not.toBe("starting");
        await toolbarButton(editorPage, "Run").click();
        await expect(editorPage.locator(".osd-badge")).toHaveClass(/paused/, { timeout: 90_000 });
      });

      const paused = await hostDebugState(page, macroId);
      expect(paused.sameModuleInstance, "harness reaches the app's own script host").toBe(true);
      expect(paused.hasSession).toBe(true);
      expect(paused.status).toBe("paused");
      expect(paused.pausedLine, "the session is suspended on a real line").not.toBeNull();
      expect(paused.transientIds).toContain(macroId);

      await test.step("edit the buffer while the session is paused", async () => {
        await retypeToken(editorPage, ORIGINAL, EDITED);
        await expect
          .poll(async () => storedSource(page, macroId), { timeout: 30_000 })
          .toContain(EDITED);
      });

      // -- THE CLAIM ---------------------------------------------------------
      await test.step("the session is NOT remounted: alive, paused, same line", async () => {
        await assertHoldsFor(page, 6_000, "an edit never restarts a live debug session", async () => {
          const s = await hostDebugState(page, macroId);
          return (
            s.hasSession &&
            s.status === "paused" &&
            s.mounted &&
            s.pausedLine === paused.pausedLine &&
            s.transientIds.includes(macroId)
          );
        });
      });

      await test.step("and the editor SAYS the session is running older code", async () => {
        await expect(editorPage.locator("[data-testid='stale-session-banner']")).toBeVisible({
          timeout: 20_000,
        });
        await expect(editorPage.locator("[data-testid='stale-session-banner']")).toContainText(
          /earlier version/i,
        );
      });

      await test.step("Run while paused refuses, naming the paused line", async () => {
        await toolbarButton(editorPage, "Run").click();
        await expect
          .poll(async () => consoleText(editorPage), { timeout: 30_000 })
          .toMatch(/paused at line/i);
        const s = await hostDebugState(page, macroId);
        expect(s.status, "the refusal did not disturb the pause").toBe("paused");
        expect(s.pausedLine).toBe(paused.pausedLine);
      });

      await test.step("after Stop, the next Run picks the edit up", async () => {
        await toolbarButton(editorPage, "Stop").click();
        await expect
          .poll(async () => (await hostDebugState(page, macroId)).hasSession, { timeout: 60_000 })
          .toBe(false);
        // ...and the window the user is looking at agrees the session is gone.
        await waitForNoSession(editorPage);
        await expect(editorPage.locator("[data-testid='stale-session-banner']")).toHaveCount(0);
        await clearCells(page, [DEBUG_CELL]);
        await toolbarButton(editorPage, "Run").click();
        await withEditorConsole(
          editorPage,
          async () => {
            await expect
              .poll(async () => readCell(page, DEBUG_CELL.row, DEBUG_CELL.col), { timeout: 90_000 })
              .toBe(EDITED);
          },
          { page, scriptId: macroId },
        );
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [DEBUG_CELL]).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 6 — the chip must not claim unsaved work that does not exist
  // =========================================================================
  //
  // The indicator replaced the Save button, so it is now the ONLY answer to
  // "does the store hold what I am looking at". Typing something and taking it
  // back leaves the buffer byte-identical to the store — nothing is pending, and
  // a chip left on "Saving…" would be exactly the false alarm the old, always-on
  // dirty flag used to raise.

  test("6. taking an edit back returns the chip to Live (no phantom unsaved work)", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} chip ${stamp}`;
    const macroId = `macro-e2eliveedit-chip-${stamp}`;
    const source = macroSource({
      name: macroName,
      fnName: "e2eLiveEditChip",
      row: CHIP_CELL.row,
      col: CHIP_CELL.col,
      value: "70123",
    });

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);

    try {
      await seedMacro(page, { id: macroId, name: macroName, source });
      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });
      expect(await liveState(editorPage)).toBe("live");

      await test.step("type something unstorable — the chip says so", async () => {
        await insertAtEnd(editorPage, "\n}");
        await expect.poll(async () => liveState(editorPage), { timeout: 30_000 }).toBe("error");
        expect(await storedSource(page, macroId)).toBe(source);
      });

      await test.step("delete it again — the buffer is the stored text once more", async () => {
        await editorPage.keyboard.press("Backspace");
        await editorPage.keyboard.press("Backspace");
        // The stray brace and the line it sat on are gone: the document ends the
        // way the seeded source does.
        await expect
          .poll(
            async () => {
              const lines = (await editorText(editorPage))
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
              return lines.slice(-2).join(" | ");
            },
            { timeout: 15_000 },
          )
          .toBe("return e2eLiveEditChip(context.api); | }");
      });

      await test.step("the chip returns to Live — it must not report phantom work", async () => {
        await expect
          .poll(async () => liveState(editorPage), { timeout: 20_000 })
          .toBe("live");
        await expect(editorPage.locator("[data-testid='editor-save-state']")).toHaveText("Live");
        expect(
          await storedSource(page, macroId),
          "and the store never changed, because nothing needed writing",
        ).toBe(source);
      });
    } finally {
      await releaseTransientDebugMounts(page).catch(() => {});
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
    }
  });
});
