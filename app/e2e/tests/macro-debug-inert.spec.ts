/**
 * ENTERING THE DEBUGGER MUST EXECUTE NOTHING — proved against the real app.
 *
 * WHAT THE USER REPORTED. They opened a recorded macro in the Object Script
 * Editor and pressed Debug. The debugger paused at line 6 — but the grid ALREADY
 * held every value the macro writes, before they had stepped a single line that
 * writes them. Stepping then applied the same effects a second time.
 *
 * THE CAUSE. A module macro is opened under a synthetic unlocked `workbook`
 * definition, where `context.onClick` does not exist. The recorder's generated
 * `setup` therefore falls through its click branch to its last line,
 * `return macroNNNN(context.api)` — so INVOKING `setup` IS RUNNING THE MACRO,
 * and the debug mount invoked it. VBA's contract is the opposite: entering
 * debug prepares the script and executes NOTHING; Run / run-at-cursor / firing a
 * trigger is what starts it, and stepping is what makes effects land.
 *
 * WHY THIS FILE EXISTS. Unit tests called this feature working before, and every
 * live run of it so far has caught something the unit tests could not see. So
 * nothing here is stubbed: the real macro recorder, the real Macros library, the
 * real separate editor window, the real worker realms, the real backend module
 * store and the real grid.
 *
 * THE FOUR CLAIMS (one test each, self-contained, cleaned up in a finally):
 *   1. NOTHING RUNS ON DEBUG START. Record a macro that writes a known value,
 *      clear the cell, press Debug — the cell must STILL BE EMPTY, and the panel
 *      must say so ("Ready — nothing has run yet"), not "Paused — line N" and
 *      not "Running".
 *   2. RUNNING IS WHAT EXECUTES, AND EXACTLY ONCE. From that inert session, Run
 *      (F5) — and because the gutter is empty the session is armed to stop on
 *      the first statement THE USER starts, the cell is still empty AT THE
 *      PAUSE; Continue then lands the write. The macro is a COUNTER (it reads
 *      the cell and writes n+1), so one execution reads "1" and a double
 *      execution would read "2" — the two are distinguishable, which a macro
 *      writing a constant would not be.
 *   3. BUTTON SCRIPTS ARE NOT INERT. A real button object script, mounted the
 *      production way, still runs `setup` under the debugger — so `onClick` is
 *      registered and its Fire row is in the trigger list. The fix must not have
 *      made object-script debugging inert.
 *   4. NO LEAK. Ending a session leaves nothing mounted and no debugger-owned
 *      mount behind.
 *
 * SHARED APP. One app instance drives every functional spec, so this one owns a
 * private patch of the grid (column K, rows 61-64) and cleans up before AND
 * after each test.
 *
 * LOCALE. Every value written is a bare integer or a bare word — no list
 * separators, no decimals — so the spec reads identically under sv-SE and en-US.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const SHEET = 0;

/** Every macro/script this spec creates carries this, so cleanup sweeps strays. */
const NAME_PREFIX = "E2EDebugInert";

/** The Object Script Editor's fixed Tauri window label. */
const EDITOR_LABEL = "object-script-editor";

/** This spec's private patch of the grid. */
const REC_CELL = { ref: "K61", row: 60, col: 10 }; // journey 1 — recorded write
const COUNT_CELL = { ref: "K62", row: 61, col: 10 }; // journey 2 — execution counter
const BTN_OUT_CELL = { ref: "K63", row: 62, col: 10 }; // journey 3 — onClick write
const BTN_CTRL = { row: 63, col: 10 }; // journey 3 — the button control itself
const COLD_CELL = { ref: "K65", row: 64, col: 10 }; // journey 5 — cold-Run counter

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

/**
 * What the SCRIPT HOST in the main window believes about a script id — the
 * second, independent source of truth next to what the editor shows.
 *
 * `sameModuleInstance` is a harness guard, not a product claim: it asserts the
 * module reached through `__calcImport` is the very one the app is running
 * (function identity against the @api barrel). Without it a Vite
 * module-duplication accident would report "nothing mounted" for a live mount
 * and the leak assertions would pass by being blind.
 */
async function hostDebugState(
  page: Page,
  scriptId: string,
): Promise<{
  sameModuleInstance: boolean;
  mounted: boolean;
  transientIds: string[];
  hasSession: boolean;
  status: string | null;
  autoInvokeSetup: boolean | null;
  triggerIds: string[];
  lastActivity: string | null;
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
      autoInvokeSetup: session ? session.autoInvokeSetup === true : null,
      triggerIds: session ? (session.triggers ?? []).map((t: any) => String(t.id)) : [],
      lastActivity: session?.lastActivity ? String(session.lastActivity.label) : null,
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

/** Remove every module this spec created. Idempotent; runs before AND after. */
async function cleanup(page: Page): Promise<void> {
  await releaseTransientDebugMounts(page);
  await page.evaluate(async (prefix) => {
    const tauri = (window as any).__TAURI__;
    try {
      const modules: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
      for (const m of modules) {
        if ((m.name && m.name.startsWith(prefix)) || (m.id && m.id.startsWith("macro-e2edbginert"))) {
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
  await page.waitForTimeout(500);
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
  await editorPage.waitForTimeout(1_200);
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

/** The session badge — the editor's own one-line answer to "what is happening". */
function badge(editorPage: Page) {
  return editorPage.locator(".osd-badge");
}

/**
 * Sample a cell repeatedly and fail the moment it is not empty.
 *
 * A `poll(...).toBe("")` would pass on its FIRST read and never notice a write
 * that lands 300ms later — which is exactly the shape of the bug (an async
 * `setup` invoked at mount). Nothing-happened can only be proved by watching.
 */
async function assertStaysEmpty(
  page: Page,
  cell: { row: number; col: number },
  ms: number,
  because: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  let samples = 0;
  while (Date.now() < deadline) {
    const value = await readCell(page, cell.row, cell.col);
    samples++;
    expect(value, `${because} (sample ${samples})`).toBe("");
    await page.waitForTimeout(250);
  }
  expect(samples, "the cell was actually sampled").toBeGreaterThan(3);
}

// ===========================================================================

test.describe("Entering the debugger executes nothing", () => {
  // =========================================================================
  // JOURNEY 1 — THE REPORTED BUG, with a REAL recorded macro
  // =========================================================================

  test("1. starting a debug session on a RECORDED macro runs none of it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} rec ${stamp}`;
    const VALUE = "70707";

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [REC_CELL]);

    let macroId: string | null = null;
    try {
      // -- Record for real. The generated `setup` this produces is the source of
      //    the bug: its click branch cannot match under the synthetic workbook
      //    definition, so its last line calls the macro body.
      await test.step("record a macro that writes a known value", async () => {
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

        await grid.setCellValue(REC_CELL.ref, VALUE);

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

      // The macro's effect is wiped, so ANY value here afterwards was written by
      // an execution of the macro and nothing else.
      await test.step("clear the cell the macro writes", async () => {
        await clearCells(page, [REC_CELL]);
        expect(await readCell(page, REC_CELL.row, REC_CELL.col)).toBe("");
        const before = await hostDebugState(page, macroId!);
        expect(before.sameModuleInstance, "harness reaches the app's own script host").toBe(true);
        expect(before.mounted, "the macro has never been run in this session").toBe(false);
        expect(before.hasSession).toBe(false);
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId!, { timeout: 20_000 });

      // -- THE DECISIVE ASSERTION ---------------------------------------------
      await test.step("Debug prepares the macro and executes NOTHING", async () => {
        await editorPage.locator("button").filter({ hasText: /^Debug$/ }).first().click();
        await expect(badge(editorPage)).toBeVisible({ timeout: 60_000 });

        // The session is really open (not merely pending).
        await expect
          .poll(async () => (await hostDebugState(page, macroId!)).status, { timeout: 30_000 })
          .not.toBe("starting");

        // THE USER'S REPORT, INVERTED, AND FIRST: the grid must be untouched.
        // Asserted before any host internals so a regression fails in the
        // user's own terms — "the macro ran when I pressed Debug".
        await assertStaysEmpty(
          page,
          REC_CELL,
          6_000,
          "the macro must NOT have run when the debug session started",
        );

        const during = await hostDebugState(page, macroId!);
        expect(during.autoInvokeSetup, "the module-macro mount does not invoke setup").toBe(false);
        expect(during.mounted, "a realm exists — it just ran nothing").toBe(true);
        expect(during.lastActivity, "nothing has executed in this session").toBeNull();
      });

      await test.step("the panel says idle/ready — not paused, not running", async () => {
        // Class, not prose: "waiting" is the machine-readable claim, and it is
        // neither "paused" nor "running".
        await expect(badge(editorPage)).toHaveClass(/waiting/, { timeout: 30_000 });
        const label = (await badge(editorPage).innerText()).trim();
        expect(label, "the badge must not claim a pause").not.toMatch(/Paused/i);
        expect(label, "the badge must not claim execution").not.toMatch(/Running/i);
        expect(label).toMatch(/nothing has run yet/i);
        // ...and the panel body explains it in the same words.
        await expect(editorPage.getByText(/nothing has run yet/i).first()).toBeVisible({
          timeout: 10_000,
        });
        // The status the bug produced is nowhere on screen.
        await expect(editorPage.getByText(/^Paused — line/)).toHaveCount(0);
      });

      // -- JOURNEY 4 (no leak) on this session --------------------------------
      await test.step("Stop leaves nothing mounted and no debugger-owned mount", async () => {
        await editorPage.locator("button").filter({ hasText: /^Stop$/ }).first().click();
        await expect(badge(editorPage)).toHaveCount(0, { timeout: 30_000 });
        await expect
          .poll(async () => (await hostDebugState(page, macroId!)).mounted, { timeout: 30_000 })
          .toBe(false);
        const after = await hostDebugState(page, macroId!);
        expect(after.hasSession).toBe(false);
        expect(after.transientIds).toEqual([]);
        // Stopping is not a back door either: still nothing was executed.
        expect(await readCell(page, REC_CELL.row, REC_CELL.col)).toBe("");
      });
    } finally {
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [REC_CELL]).catch(() => {});
    }
  });

  // =========================================================================
  // JOURNEY 2 — running is what executes, and it executes ONCE
  // =========================================================================
  //
  // The macro is byte-for-byte the recorder's shape (a body function plus a
  // `setup` whose click branch cannot match here, so its last line calls the
  // body) — but its body is a COUNTER: it reads the cell and writes n+1. That is
  // what makes one execution distinguishable from two. A recorded macro writing
  // a constant cannot tell those apart, which is precisely how the original
  // double-run was dismissed as cosmetic.

  test("2. Run is what executes the macro — once, and not before", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} count ${stamp}`;
    const macroId = `macro-e2edbginert-count-${stamp}`;
    const source =
      `// Macro: ${macroName}\n` +
      `// Target runtime: object script (unlocked)\n` +
      `async function e2eCountRuns(api) {\n` +
      `  // ANCHOR_COUNTER_BODY\n` +
      `  const prev = await api.getCellValue(${COUNT_CELL.row}, ${COUNT_CELL.col});\n` +
      `  const n = Number(prev) || 0;\n` +
      `  await api.setCellValue(${COUNT_CELL.row}, ${COUNT_CELL.col}, String(n + 1));\n` +
      `}\n` +
      `\n` +
      `// Entry point. Calcula calls setup() when this script is mounted.\n` +
      `function setup(context) {\n` +
      `  if (!context.api) {\n` +
      `    context.notify("needs an UNLOCKED script", "error");\n` +
      `    return;\n` +
      `  }\n` +
      `  if (typeof context.onClick === "function") {\n` +
      `    context.onClick(async () => {\n` +
      `      await e2eCountRuns(context.api);\n` +
      `    });\n` +
      `    return;\n` +
      `  }\n` +
      `  return e2eCountRuns(context.api);\n` +
      `}\n`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [COUNT_CELL]);

    try {
      await seedMacro(page, { id: macroId, name: macroName, source });
      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("Debug: the counter has not been incremented", async () => {
        await editorPage.locator("button").filter({ hasText: /^Debug$/ }).first().click();
        await expect(badge(editorPage)).toBeVisible({ timeout: 60_000 });
        await expect(badge(editorPage)).toHaveClass(/waiting/, { timeout: 30_000 });
        await assertStaysEmpty(
          page,
          COUNT_CELL,
          5_000,
          "the counter must read empty — zero executions",
        );
      });

      await test.step("the inert mount still registered something to run", async () => {
        // Preparing without executing is only useful if the session can then be
        // STARTED. Both the body and `setup` are offered as Run rows.
        const state = await hostDebugState(page, macroId);
        expect(state.triggerIds).toContain("method:e2eCountRuns");
        expect(state.triggerIds, "setup is runnable on an inert mount").toContain("method:setup");
        expect(state.status, "not a dead end").not.toBe("failed");
        await expect(editorPage.locator(".osd-trigger-row")).not.toHaveCount(0);
      });

      // -- Run (F5). The gutter is empty, so the session is armed to stop on the
      //    first statement the USER starts — that pause is itself proof that the
      //    execution began now and not at mount.
      await test.step("Run pauses on the first statement, with the cell still empty", async () => {
        await editorPage.locator("button").filter({ hasText: /^Run$/ }).first().click();
        await expect(badge(editorPage)).toHaveClass(/paused/, { timeout: 60_000 });
        const label = (await badge(editorPage).innerText()).trim();
        expect(label).toMatch(/Paused/i);
        // Suspended BEFORE the write: this is what the user asked for all along.
        expect(await readCell(page, COUNT_CELL.row, COUNT_CELL.col)).toBe("");
        expect(await consoleText(editorPage)).toMatch(/Running e2eCountRuns\(\)/);
      });

      await test.step("Continue lands the write — exactly one execution", async () => {
        await editorPage.locator("button").filter({ hasText: /^Continue$/ }).first().click();
        await expect
          .poll(async () => readCell(page, COUNT_CELL.row, COUNT_CELL.col), { timeout: 60_000 })
          .toBe("1");

        // Settle, then re-read: a second execution would have made this "2".
        await page.waitForTimeout(4_000);
        expect(
          await readCell(page, COUNT_CELL.row, COUNT_CELL.col),
          "the macro ran ONCE — a mount-time run plus this one would read 2",
        ).toBe("1");

        const after = await hostDebugState(page, macroId);
        expect(after.lastActivity, "the session names what the USER started").toMatch(
          /e2eCountRuns/,
        );
      });

      await test.step("Stop leaves nothing mounted", async () => {
        await editorPage.locator("button").filter({ hasText: /^Stop$/ }).first().click();
        await expect(badge(editorPage)).toHaveCount(0, { timeout: 30_000 });
        await expect
          .poll(async () => (await hostDebugState(page, macroId)).mounted, { timeout: 30_000 })
          .toBe(false);
        expect((await hostDebugState(page, macroId)).transientIds).toEqual([]);
        // Tearing the mount down does not run it either.
        expect(await readCell(page, COUNT_CELL.row, COUNT_CELL.col)).toBe("1");
      });
    } finally {
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [COUNT_CELL]).catch(() => {});
    }
  });

  // =========================================================================
  // JOURNEY 3 — the regression guard: object scripts are NOT inert
  // =========================================================================
  //
  // `setup` is a macro's whole body, but an object script's REGISTRATION step:
  // it is what calls `button.onClick(...)`. If the fix had made every debug
  // mount inert, debugging a button would come up with an empty Fire list and
  // nothing to breakpoint. This mounts a real button script the production way
  // and debugs it from the same editor window the user uses.

  test("3. debugging a BUTTON script still runs setup, so onClick is registered", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const scriptId = `btn-e2edbginert-${stamp}`;
    const scriptName = `${NAME_PREFIX} button ${stamp}`;
    const instanceId = `control-${SHEET}-${BTN_CTRL.row}-${BTN_CTRL.col}`;
    const buttonSource =
      `function setup(button) {\n` +
      `  button.onClick(async function () {\n` +
      `    await button.api.setCellValue(${BTN_OUT_CELL.row}, ${BTN_OUT_CELL.col}, "clicked");\n` +
      `  });\n` +
      `}\n`;

    // A macro only so the Macros library has a row to open the editor window
    // from; the subject of this test is the button script.
    const seedName = `${NAME_PREFIX} opener ${stamp}`;
    const seedId = `macro-e2edbginert-opener-${stamp}`;
    const seedSource =
      `// Macro: ${seedName}\n` +
      `async function e2eOpenerNoop(api) {\n` +
      `  await api.getCellValue(0, 0);\n` +
      `}\n\n` +
      `function setup(context) {\n` +
      `  if (!context.api) { context.notify("needs an unlocked script", "error"); return; }\n` +
      `}\n`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [BTN_OUT_CELL]);

    try {
      await seedMacro(page, { id: seedId, name: seedName, source: seedSource });

      await test.step("a real button control with a real, mounted object script", async () => {
        await page.evaluate(
          async (a) => {
            const tauri = (window as any).__TAURI__;
            await tauri.core.invoke("set_control_metadata", {
              sheetIndex: a.SHEET,
              row: a.row,
              col: a.col,
              metadata: {
                controlType: "button",
                properties: { label: { valueType: "static", value: "E2E" } },
              },
            });
            // Persisted, so the editor lists it in "Object scripts"...
            await tauri.core.invoke("save_object_script", {
              script: {
                id: a.scriptId,
                name: a.scriptName,
                objectType: "button",
                instanceId: a.instanceId,
                source: a.source,
                accessLevel: "unlocked",
                description: null,
                provenance: null,
                packageName: null,
                packageVersion: null,
              },
            });
          },
          {
            SHEET,
            row: BTN_CTRL.row,
            col: BTN_CTRL.col,
            scriptId,
            scriptName,
            instanceId,
            source: buttonSource,
          },
        );

        // ...and mounted through the production manager, exactly as the app does
        // when the workbook loads.
        await page.evaluate(
          async (a) => {
            const api: any = await (window as any).__calcImport(
              new URL("/src/api/index.ts", document.baseURI).href,
            );
            api.ObjectScriptManager.registerScript({
              id: a.scriptId,
              name: a.scriptName,
              objectType: "button",
              instanceId: a.instanceId,
              source: a.source,
              accessLevel: "unlocked",
              description: null,
            });
            await api.ObjectScriptManager.mountScript(a.scriptId);
          },
          { scriptId, scriptName, instanceId, source: buttonSource },
        );

        await expect
          .poll(async () => (await hostDebugState(page, scriptId)).mounted, { timeout: 30_000 })
          .toBe(true);
      });

      const editorPage = await openMacroInEditor(page, grid, seedName);

      await test.step("select the button script in the editor", async () => {
        await documentSelect(editorPage).selectOption(scriptId);
        await expect(documentSelect(editorPage)).toHaveValue(scriptId, { timeout: 20_000 });
      });

      // -- THE REGRESSION ASSERTION -------------------------------------------
      //
      // THE CONTRAST WITH JOURNEY 1 IS THE WHOLE POINT. An empty gutter means
      // "stop on the first statement" on BOTH kinds of script. The macro session
      // reported no pause at all, because its mount deliberately executed
      // nothing. This one stops at line 1 — the debug mount of an object script
      // really is executing its module and about to call `setup`. Same gesture,
      // opposite (and correct) outcome.
      await test.step("Debug EXECUTES this script — it suspends at line 1", async () => {
        await editorPage.locator("button").filter({ hasText: /^Debug$/ }).first().click();
        await expect(badge(editorPage)).toBeVisible({ timeout: 60_000 });

        await expect
          .poll(async () => (await hostDebugState(page, scriptId)).status, { timeout: 60_000 })
          .toBe("paused");
        const state = await hostDebugState(page, scriptId);
        expect(state.autoInvokeSetup, "an object script's debug mount DOES call setup").toBe(true);
        expect(state.transientIds, "a standing object script is not a debugger-owned mount").toEqual(
          [],
        );
        await expect(badge(editorPage)).toHaveClass(/paused/);
        expect((await badge(editorPage).innerText()).trim()).toMatch(/^Paused/);
      });

      await test.step("Continue: setup completes and registers onClick in the Fire list", async () => {
        await editorPage.locator("button").filter({ hasText: /^Continue$/ }).first().click();

        await expect
          .poll(async () => (await hostDebugState(page, scriptId)).triggerIds, { timeout: 60_000 })
          .toContain("hook:onClick");

        const state = await hostDebugState(page, scriptId);
        expect(state.autoInvokeSetup).toBe(true);
        expect(state.status, "not the inert dead end").not.toBe("failed");

        // The user-visible Fire list — non-empty, with an onClick row that can
        // be fired from here.
        const onClickRow = editorPage
          .locator(".osd-trigger-row")
          .filter({ hasText: "onClick" })
          .first();
        await expect(onClickRow).toBeVisible({ timeout: 30_000 });
        const fireButton = onClickRow.locator(".osd-trigger-fire");
        await expect(fireButton).toHaveText("Fire");
        await expect(fireButton).toBeEnabled();

        const label = (await badge(editorPage).innerText()).trim();
        expect(label, "an object script is not reported as having nothing to run").not.toMatch(
          /Nothing to run/i,
        );
        expect(label, "an object script is not reported as the un-run inert kind").not.toMatch(
          /nothing has run yet/i,
        );
      });

      await test.step("firing onClick from the debugger runs the handler", async () => {
        await editorPage
          .locator(".osd-trigger-row")
          .filter({ hasText: "onClick" })
          .first()
          .locator(".osd-trigger-fire")
          .click();
        await expect
          .poll(async () => readCell(page, BTN_OUT_CELL.row, BTN_OUT_CELL.col), { timeout: 60_000 })
          .toBe("clicked");
      });

      await test.step("Stop leaves no debugger-owned mount behind", async () => {
        await editorPage.locator("button").filter({ hasText: /^Stop$/ }).first().click();
        await expect(badge(editorPage)).toHaveCount(0, { timeout: 30_000 });
        // The script itself is a production mount and may legitimately survive;
        // what must NOT survive is a mount the DEBUGGER owns.
        expect((await hostDebugState(page, scriptId)).transientIds).toEqual([]);
      });
    } finally {
      await destroyEditorWindow(page).catch(() => {});
      await page
        .evaluate(
          async (a) => {
            const api: any = await (window as any).__calcImport(
              new URL("/src/api/index.ts", document.baseURI).href,
            );
            try {
              api.ObjectScriptManager.removeScript(a.scriptId);
            } catch {
              /* best effort */
            }
            const tauri = (window as any).__TAURI__;
            await tauri.core.invoke("delete_object_script", { id: a.scriptId }).catch(() => {});
            await tauri.core
              .invoke("remove_control_metadata", {
                sheetIndex: a.SHEET,
                row: a.row,
                col: a.col,
              })
              .catch(() => {});
          },
          { scriptId, SHEET, row: BTN_CTRL.row, col: BTN_CTRL.col },
        )
        .catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [BTN_OUT_CELL]).catch(() => {});
    }
  });

  // =========================================================================
  // JOURNEY 5 — pressing Run WITHOUT pressing Debug first runs it once
  // =========================================================================
  //
  // This is the path that was worst hit and is easiest to miss: Run on a macro
  // with no session open has to CREATE one. It used to plain-mount the macro
  // (execution 1), remount it instrumented (execution 2) and then fire the
  // run-target (execution 3) — three runs for one press of one button, all
  // invisible because a recorded macro writes the same constant every time. The
  // counter makes all three visible; the answer must be 1.

  test("5. Run with no session open runs the macro exactly once", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} cold ${stamp}`;
    const macroId = `macro-e2edbginert-cold-${stamp}`;
    const source =
      `// Macro: ${macroName}\n` +
      `// Target runtime: object script (unlocked)\n` +
      `async function e2eColdRunCount(api) {\n` +
      `  const prev = await api.getCellValue(${COLD_CELL.row}, ${COLD_CELL.col});\n` +
      `  const n = Number(prev) || 0;\n` +
      `  await api.setCellValue(${COLD_CELL.row}, ${COLD_CELL.col}, String(n + 1));\n` +
      `}\n` +
      `\n` +
      `function setup(context) {\n` +
      `  if (!context.api) {\n` +
      `    context.notify("needs an UNLOCKED script", "error");\n` +
      `    return;\n` +
      `  }\n` +
      `  if (typeof context.onClick === "function") {\n` +
      `    context.onClick(async () => {\n` +
      `      await e2eColdRunCount(context.api);\n` +
      `    });\n` +
      `    return;\n` +
      `  }\n` +
      `  return e2eColdRunCount(context.api);\n` +
      `}\n`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [COLD_CELL]);

    try {
      await seedMacro(page, { id: macroId, name: macroName, source });
      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("precondition: no session, nothing mounted, cell empty", async () => {
        const before = await hostDebugState(page, macroId);
        expect(before.sameModuleInstance).toBe(true);
        expect(before.hasSession).toBe(false);
        expect(before.mounted).toBe(false);
        expect(await readCell(page, COLD_CELL.row, COLD_CELL.col)).toBe("");
      });

      await test.step("one press of Run = one execution", async () => {
        await editorPage.locator("button").filter({ hasText: /^Run$/ }).first().click();
        await expect
          .poll(async () => readCell(page, COLD_CELL.row, COLD_CELL.col), { timeout: 90_000 })
          .toBe("1");

        // Settle, then re-read. Mount + instrumented remount + fire would be "3".
        await page.waitForTimeout(5_000);
        expect(
          await readCell(page, COLD_CELL.row, COLD_CELL.col),
          "one press of Run must be one execution, not three",
        ).toBe("1");
        expect(await consoleText(editorPage)).toMatch(/Running e2eColdRunCount\(\)/);

        const after = await hostDebugState(page, macroId);
        expect(after.autoInvokeSetup, "the session Run created is the inert kind").toBe(false);
        expect(after.transientIds, "the debugger owns the mount Run made").toContain(macroId);
      });

      await test.step("Stop leaves nothing mounted", async () => {
        await editorPage.locator("button").filter({ hasText: /^Stop$/ }).first().click();
        await expect
          .poll(async () => (await hostDebugState(page, macroId)).mounted, { timeout: 30_000 })
          .toBe(false);
        expect((await hostDebugState(page, macroId)).transientIds).toEqual([]);
        expect(await readCell(page, COLD_CELL.row, COLD_CELL.col)).toBe("1");
      });
    } finally {
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [COLD_CELL]).catch(() => {});
    }
  });
});
