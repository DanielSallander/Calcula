/**
 * A FINISHED MACRO MUST LEAVE DEBUG MODE — proved against the real app.
 *
 * WHAT THE USER REPORTED. They opened a recorded macro in the Object Script
 * Editor, pressed Debug, and stepped through EVERY line. The values landed at
 * the right lines (the inert-mount fix works) — but when the last line was
 * behind them the toolbar still showed a live session badged
 * "Waiting for a trigger". Waiting for what? Nothing in the app can start a
 * recorded macro; only the user can. They asked, reasonably: "It should exit
 * debug mode when stepping through all the lines, correct?"
 *
 * THE CAUSE. `idleStatusFor` counted every trigger, and a macro's trigger list
 * is never empty: alongside real event hooks the debugger exposes the macro's
 * own top-level functions as RUN-TARGETS, purely so the user can start them. The
 * two kinds answer opposite questions —
 *   hook   -- something in the app WILL fire this. "Waiting" is true.
 *   method -- YOU may run this again. Nothing is going to arrive.
 * — so a macro reported "waiting" forever, and nothing ever released the
 * debugger-owned mount.
 *
 * WHY THIS FILE EXISTS. Every live run of this feature has caught a bug the unit
 * tests could not see. Nothing here is stubbed: the real macro recorder, the
 * real Macros library, the real separate editor window, the real worker realms,
 * the real backend module store and the real grid. `macro-debug-inert.spec.ts`
 * proves entering the debugger executes NOTHING; this file proves the other end
 * of the same session — that finishing it gets you OUT.
 *
 * THE FOUR CLAIMS (one test each, self-contained, cleaned up in a finally):
 *   1. STEPPING PAST THE LAST LINE LEAVES DEBUG MODE. Record a real macro, press
 *      Debug, press Run, then press Step Over until there is nothing left to
 *      step. The session must be GONE — no badge, no Stop button, Debug offered
 *      again, `getDebugSession` null, nothing mounted, no debugger-owned mount —
 *      and the console must carry a completion line, because a badge that simply
 *      vanishes is indistinguishable from a crash. The badge is sampled at EVERY
 *      pause and must never once have read "Waiting for a trigger".
 *   2. THE WRITES STILL LANDED. The macro's value is in the cell after the
 *      session tore itself down, and stays there. Auto-teardown must not roll
 *      anything back nor race the final write.
 *   3. A BUTTON SCRIPT IS NOT SWEPT UP (what an over-broad fix breaks). A real
 *      button object script, mounted the production way, reports `waiting` after
 *      `setup` — named as "Waiting for onClick" — keeps a FIREABLE onClick row,
 *      and its session survives: held under observation, and again after a fired
 *      handler has run to completion. A hook is a promise that something will
 *      fire; ending there would unregister the handler being debugged.
 *   4. A FAILING MACRO KEEPS ITS SESSION. A macro whose body throws is exactly
 *      when the debugger is worth having open. The session stays, the error text
 *      is on screen, the mount is kept, and no auto-end fires.
 *
 * DEVIATION FROM THE LITERAL REQUEST, ASSERTED AS BUILT (claim 4). A run-target
 * that throws does NOT move the session to `status: "failed"`. `failed` is
 * reserved for "this session can never run anything" (a `setup` that threw; an
 * inert mount with no run-target), and `DebugPanel` disables every Run/Fire row
 * unless the session is idle — so `failed` would delete the button the user
 * needs to retry after fixing the error. The session settles idle with the error
 * carried in `lastActivity.error`, badged "Finished with an error". This spec
 * asserts the SUBSTANCE the request is about: session kept, error visible, no
 * auto-end.
 *
 * SHARED APP. One app instance drives every functional spec, so this one owns a
 * private patch of the grid (column L, rows 71-75) and cleans up before AND
 * after each test.
 *
 * LOCALE. Every value written is a bare integer or a bare word — no list
 * separators, no decimals — so the spec reads identically under sv-SE and en-US.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const SHEET = 0;

/** Every macro/script this spec creates carries this, so cleanup sweeps strays. */
const NAME_PREFIX = "E2EAutoEnd";

/** The Object Script Editor's fixed Tauri window label. */
const EDITOR_LABEL = "object-script-editor";

/** This spec's private patch of the grid. */
const REC_CELL = { ref: "L71", row: 70, col: 11 }; // claims 1+2 — recorded write
const BTN_OUT_CELL = { ref: "L73", row: 72, col: 11 }; // claim 3 — onClick write
const BTN_CTRL = { row: 73, col: 11 }; // claim 3 — the button control itself
const THROW_CELL = { ref: "L75", row: 74, col: 11 }; // claim 4 — written before the throw

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
 * and every teardown assertion here would pass by being blind.
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
  hookTriggerIds: string[];
  methodTriggerIds: string[];
  lastActivity: string | null;
  lastActivityError: string | null;
  lastActivityDurationMs: number | null;
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
    const triggers: any[] = session ? (session.triggers ?? []) : [];
    return {
      sameModuleInstance: host.hostIsMounted === api.hostIsMounted,
      mounted: host.hostIsMounted(id) === true,
      transientIds: (host.hostTransientDebugMountIds() as string[]) ?? [],
      hasSession: !!session,
      status: session ? String(session.status) : null,
      autoInvokeSetup: session ? session.autoInvokeSetup === true : null,
      triggerIds: triggers.map((t: any) => String(t.id)),
      hookTriggerIds: triggers.filter((t: any) => t.kind === "hook").map((t: any) => String(t.id)),
      methodTriggerIds: triggers
        .filter((t: any) => t.kind === "method")
        .map((t: any) => String(t.id)),
      lastActivity: session?.lastActivity ? String(session.lastActivity.label) : null,
      lastActivityError: session?.lastActivity?.error ? String(session.lastActivity.error) : null,
      lastActivityDurationMs:
        typeof session?.lastActivity?.durationMs === "number"
          ? Number(session.lastActivity.durationMs)
          : null,
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
        if ((m.name && m.name.startsWith(prefix)) || (m.id && m.id.startsWith("macro-e2eautoend"))) {
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

/** Badge text right now, or null when there is no session on screen. */
async function badgeText(editorPage: Page): Promise<string | null> {
  const b = badge(editorPage);
  if ((await b.count()) === 0) return null;
  return (await b.first().innerText()).trim();
}

/** The debug toolbar's step-over button (icon only — identified by its tooltip). */
function stepOverButton(editorPage: Page) {
  return editorPage.locator('button[title^="Step over"]').first();
}

/**
 * Wait until the session is suspended again or has ended.
 *
 * Between two steps the session passes through "running" and back; polling for
 * exactly those two resting outcomes is what makes the step loop deterministic
 * instead of timing-based.
 */
async function waitPausedOrGone(
  page: Page,
  scriptId: string,
  timeoutMs: number,
): Promise<{ outcome: "paused" | "gone" | "stuck"; status: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let status: string | null = null;
  while (Date.now() < deadline) {
    const state = await hostDebugState(page, scriptId);
    if (!state.hasSession) return { outcome: "gone", status: null };
    status = state.status;
    if (status === "paused") return { outcome: "paused", status };
    await page.waitForTimeout(200);
  }
  return { outcome: "stuck", status };
}

/**
 * Sample a predicate repeatedly for `ms` and fail the moment it stops holding.
 *
 * A single `expect` after a wait passes on ONE reading; "the session did not end
 * behind the user's back" is a claim about an interval, and an auto-end that
 * fires 800ms late would slip straight through a single reading.
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

test.describe("A finished macro leaves debug mode", () => {
  // =========================================================================
  // CLAIMS 1 + 2 — THE REPORTED BUG, with a REAL recorded macro, stepped
  // =========================================================================
  //
  // The user's exact gesture: Debug, then step, step, step until the macro is
  // over. Continue would prove the auto-end too, but the report is about
  // STEPPING, and the step path is the one that walks off the end of the
  // function — where a session that never releases is most visible.

  test("1. stepping past the last line of a RECORDED macro ends the session (and the write stands)", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} rec ${stamp}`;
    const VALUE = "80808";

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [REC_CELL]);

    let macroId: string | null = null;
    /** The badge as it read at every single pause, in order. */
    const badgeHistory: string[] = [];

    try {
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

      // Wiped, so ANY value here afterwards was written by an execution of the
      // macro and nothing else.
      await test.step("clear the cell the macro writes", async () => {
        await clearCells(page, [REC_CELL]);
        expect(await readCell(page, REC_CELL.row, REC_CELL.col)).toBe("");
        const before = await hostDebugState(page, macroId!);
        expect(before.sameModuleInstance, "harness reaches the app's own script host").toBe(true);
        expect(before.hasSession).toBe(false);
        expect(before.mounted).toBe(false);
      });

      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId!, { timeout: 20_000 });

      await test.step("Debug prepares the macro — a session exists, nothing has run", async () => {
        await editorPage.locator("button").filter({ hasText: /^Debug$/ }).first().click();
        await expect(badge(editorPage)).toBeVisible({ timeout: 60_000 });
        await expect
          .poll(async () => (await hostDebugState(page, macroId!)).status, { timeout: 60_000 })
          .not.toBe("starting");

        const during = await hostDebugState(page, macroId!);
        expect(during.autoInvokeSetup, "the module-macro mount does not invoke setup").toBe(false);
        expect(during.mounted, "a realm exists — it just ran nothing").toBe(true);
        expect(during.transientIds, "the mount belongs to the debugger").toContain(macroId!);
        expect(during.lastActivity, "nothing has executed in this session").toBeNull();
        // THE TRIGGER SHAPE THAT CAUSED THE BUG: run-targets only, no hook.
        expect(during.hookTriggerIds, "nothing in the app can fire a recorded macro").toEqual([]);
        expect(
          during.methodTriggerIds.length,
          "but the user is offered run-targets to start it with",
        ).toBeGreaterThan(0);
        // A prepared-but-un-run session must NOT already claim to be waiting on
        // something. This is the exact sentence the user was shown forever.
        const label = await badgeText(editorPage);
        expect(label, "a prepared macro is not waiting for anything").not.toMatch(
          /Waiting for a trigger/i,
        );
        badgeHistory.push(String(label));
      });

      await test.step("Run suspends on the first statement", async () => {
        await editorPage.locator("button").filter({ hasText: /^Run$/ }).first().click();
        await expect(badge(editorPage)).toHaveClass(/paused/, { timeout: 90_000 });
        expect(await readCell(page, REC_CELL.row, REC_CELL.col)).toBe("");
      });

      // -- THE USER'S GESTURE: step until there is nothing left to step -------
      let steps = 0;
      let finalOutcome: "paused" | "gone" | "stuck" = "paused";
      await test.step("step through every line", async () => {
        for (let i = 0; i < 40; i++) {
          const settled = await waitPausedOrGone(page, macroId!, 60_000);
          finalOutcome = settled.outcome;
          if (settled.outcome !== "paused") break;

          const label = await badgeText(editorPage);
          if (label !== null) badgeHistory.push(label);

          const step = stepOverButton(editorPage);
          await expect(step).toBeEnabled({ timeout: 15_000 });
          await step.click();
          steps++;
          await editorPage.waitForTimeout(150);
        }
        expect(steps, "the macro really was stepped through").toBeGreaterThan(0);
      });

      // -- CLAIM 1 ------------------------------------------------------------
      await test.step("the session ended itself — no Stop was ever pressed", async () => {
        expect(
          finalOutcome,
          "stepping past the last line must leave debug mode, not park in an idle session",
        ).toBe("gone");

        // The host's truth.
        await expect
          .poll(async () => (await hostDebugState(page, macroId!)).hasSession, { timeout: 30_000 })
          .toBe(false);
        const after = await hostDebugState(page, macroId!);
        expect(after.mounted, "the debugger-owned realm went with the session").toBe(false);
        expect(after.transientIds, "no debugger-owned mount survives").toEqual([]);

        // The user's truth: badge gone, Stop gone, Debug offered again.
        await expect(badge(editorPage)).toHaveCount(0, { timeout: 30_000 });
        await expect(
          editorPage.locator("button").filter({ hasText: /^Stop$/ }),
        ).toHaveCount(0);
        await expect(
          editorPage.locator("button").filter({ hasText: /^Debug$/ }).first(),
        ).toBeVisible({ timeout: 10_000 });
      });

      await test.step("the badge NEVER read 'Waiting for a trigger'", async () => {
        expect(badgeHistory.length, "badge states were actually sampled").toBeGreaterThan(1);
        const offending = badgeHistory.filter((l) => /Waiting for a trigger/i.test(l));
        expect(
          offending,
          `the reported symptom, seen in the badge history: ${JSON.stringify(badgeHistory)}`,
        ).toEqual([]);
      });

      await test.step("the console says it finished, so the badge did not just vanish", async () => {
        await expect
          .poll(async () => consoleText(editorPage), { timeout: 30_000 })
          .toMatch(/debug session ended/i);
        const text = await consoleText(editorPage);
        expect(text, "the completion names the script").toContain(macroName);
        expect(text).toMatch(/finished/i);
        // ...and tells the user how to get back in.
        expect(text).toMatch(/Run \(F5\)|press Run/i);
      });

      // -- CLAIM 2 ------------------------------------------------------------
      await test.step("the write landed and stands after the teardown", async () => {
        expect(
          await readCell(page, REC_CELL.row, REC_CELL.col),
          "stepping to the end applied the macro's write",
        ).toBe(VALUE);
        // Ending the session is not a rollback and not a second execution.
        await page.waitForTimeout(4_000);
        expect(
          await readCell(page, REC_CELL.row, REC_CELL.col),
          "the auto-teardown neither rolled the write back nor re-ran the macro",
        ).toBe(VALUE);
        expect((await hostDebugState(page, macroId!)).hasSession).toBe(false);
      });
    } finally {
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [REC_CELL]).catch(() => {});
    }
  });

  // =========================================================================
  // CLAIM 3 — the regression guard: a hook really is something to wait for
  // =========================================================================
  //
  // The fix hinges on one distinction. Widen it by a hair — end on any clean
  // completion, or treat "no method left" as "nothing left" — and debugging a
  // button becomes impossible: the session that owns the onClick handler would
  // tear itself down the moment `setup` returned, or the moment a click had been
  // handled. This mounts a REAL button script the production way and holds the
  // session under observation at both of those moments.

  test("3. a BUTTON script waits for onClick — its session is never auto-ended", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const scriptId = `btn-e2eautoend-${stamp}`;
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
    const seedId = `macro-e2eautoend-opener-${stamp}`;
    const seedSource =
      `// Macro: ${seedName}\n` +
      `async function e2eAutoEndOpenerNoop(api) {\n` +
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

      await test.step("Debug executes this script — it suspends at line 1", async () => {
        await editorPage.locator("button").filter({ hasText: /^Debug$/ }).first().click();
        await expect(badge(editorPage)).toBeVisible({ timeout: 60_000 });
        await expect
          .poll(async () => (await hostDebugState(page, scriptId)).status, { timeout: 60_000 })
          .toBe("paused");
        expect((await hostDebugState(page, scriptId)).autoInvokeSetup).toBe(true);
      });

      await test.step("Continue: setup registers onClick and the session reports WAITING", async () => {
        await editorPage.locator("button").filter({ hasText: /^Continue$/ }).first().click();

        await expect
          .poll(async () => (await hostDebugState(page, scriptId)).status, { timeout: 60_000 })
          .toBe("waiting");

        const state = await hostDebugState(page, scriptId);
        expect(state.hookTriggerIds, "a real event hook exists").toContain("hook:onClick");

        // The badge NAMES what it is waiting for — the whole point of the
        // hook/method distinction. "Waiting for a trigger" (unnamed) is the
        // symptom sentence and must not appear here either.
        const label = await badgeText(editorPage);
        expect(label).toMatch(/^Waiting for onClick/);
        expect(label).not.toMatch(/Waiting for a trigger/i);
      });

      await test.step("the session is NOT auto-ended — held under observation", async () => {
        await assertHoldsFor(
          page,
          6_000,
          "a script with a live event hook keeps its session and its mount",
          async () => {
            const s = await hostDebugState(page, scriptId);
            return s.hasSession && s.mounted && s.status === "waiting";
          },
        );
        await expect(badge(editorPage)).toHaveCount(1);
      });

      await test.step("its onClick row is still there and still fireable", async () => {
        const onClickRow = editorPage
          .locator(".osd-trigger-row")
          .filter({ hasText: "onClick" })
          .first();
        await expect(onClickRow).toBeVisible({ timeout: 30_000 });
        const fireButton = onClickRow.locator(".osd-trigger-fire");
        await expect(fireButton).toHaveText("Fire");
        await expect(fireButton).toBeEnabled();
      });

      await test.step("firing onClick runs the handler", async () => {
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

      await test.step("a COMPLETED hook run still does not end the session", async () => {
        // The auto-end is armed by exactly this event — a clean completion. The
        // hook is what must veto it, at the one moment the veto matters.
        await expect
          .poll(async () => (await hostDebugState(page, scriptId)).lastActivity, { timeout: 30_000 })
          .not.toBeNull();
        await assertHoldsFor(
          page,
          6_000,
          "the session survives a handler that ran to completion",
          async () => {
            const s = await hostDebugState(page, scriptId);
            return s.hasSession && s.mounted && s.status === "waiting";
          },
        );
        expect(await badgeText(editorPage)).toMatch(/^Waiting for onClick/);
      });

      await test.step("Stop leaves no debugger-owned mount behind", async () => {
        await editorPage.locator("button").filter({ hasText: /^Stop$/ }).first().click();
        await expect(badge(editorPage)).toHaveCount(0, { timeout: 30_000 });
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
  // CLAIM 4 — a run that threw is exactly when the debugger must stay open
  // =========================================================================

  test("4. a macro whose body THROWS keeps its session, its mount and its error", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} throws ${stamp}`;
    const macroId = `macro-e2eautoend-throws-${stamp}`;
    const BOOM = "E2EBOOM deliberate failure";
    const source =
      `// Macro: ${macroName}\n` +
      `// Target runtime: object script (unlocked)\n` +
      `async function e2eAutoEndThrows(api) {\n` +
      `  await api.setCellValue(${THROW_CELL.row}, ${THROW_CELL.col}, "reached");\n` +
      `  throw new Error("${BOOM}");\n` +
      `}\n` +
      `\n` +
      `function setup(context) {\n` +
      `  if (!context.api) {\n` +
      `    context.notify("needs an UNLOCKED script", "error");\n` +
      `    return;\n` +
      `  }\n` +
      `  return e2eAutoEndThrows(context.api);\n` +
      `}\n`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [THROW_CELL]);

    try {
      await seedMacro(page, { id: macroId, name: macroName, source });
      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("Debug, then Run — it suspends before the failing line", async () => {
        await editorPage.locator("button").filter({ hasText: /^Debug$/ }).first().click();
        await expect(badge(editorPage)).toBeVisible({ timeout: 60_000 });
        await expect
          .poll(async () => (await hostDebugState(page, macroId)).status, { timeout: 60_000 })
          .not.toBe("starting");

        await editorPage.locator("button").filter({ hasText: /^Run$/ }).first().click();
        await expect(badge(editorPage)).toHaveClass(/paused/, { timeout: 90_000 });
      });

      await test.step("Continue: the body throws", async () => {
        await editorPage.locator("button").filter({ hasText: /^Continue$/ }).first().click();
        await expect
          .poll(async () => (await hostDebugState(page, macroId)).lastActivityError, {
            timeout: 90_000,
          })
          .toContain("E2EBOOM");
      });

      // -- THE CLAIM ----------------------------------------------------------
      await test.step("the session is KEPT — no auto-end after a failure", async () => {
        await assertHoldsFor(
          page,
          8_000,
          "a run that threw keeps its session and its debugger-owned mount",
          async () => {
            const s = await hostDebugState(page, macroId);
            return s.hasSession && s.mounted && s.transientIds.includes(macroId);
          },
        );
        const s = await hostDebugState(page, macroId);
        expect(s.autoInvokeSetup, "still the debugger's own inert mount").toBe(false);
        expect(s.hookTriggerIds, "nothing can fire it — the error is the only reason it stays").toEqual(
          [],
        );
        expect(
          s.methodTriggerIds.length,
          "and the run-targets survive so the user can retry",
        ).toBeGreaterThan(0);
      });

      await test.step("the error is on screen, in the badge and in the panel", async () => {
        const label = await badgeText(editorPage);
        expect(label, "the badge does not hide the failure").toMatch(/error/i);
        expect(label, "and it is not the symptom sentence").not.toMatch(/Waiting for a trigger/i);
        // The error TEXT itself, where the user reads it.
        await expect(editorPage.getByText(/E2EBOOM/).first()).toBeVisible({ timeout: 30_000 });
        await expect(
          editorPage.getByText(/session is kept open on purpose/i).first(),
        ).toBeVisible({ timeout: 30_000 });
      });

      await test.step("the retry path is live: the Run row is still enabled", async () => {
        const runRow = editorPage
          .locator(".osd-trigger-row")
          .filter({ hasText: "e2eAutoEndThrows" })
          .first();
        await expect(runRow).toBeVisible({ timeout: 30_000 });
        await expect(runRow.locator(".osd-trigger-fire")).toBeEnabled();
      });

      await test.step("what ran before the throw stands", async () => {
        expect(await readCell(page, THROW_CELL.row, THROW_CELL.col)).toBe("reached");
      });

      await test.step("Stop is still the way out, and it leaves nothing behind", async () => {
        await editorPage.locator("button").filter({ hasText: /^Stop$/ }).first().click();
        await expect(badge(editorPage)).toHaveCount(0, { timeout: 30_000 });
        await expect
          .poll(async () => (await hostDebugState(page, macroId)).mounted, { timeout: 30_000 })
          .toBe(false);
        expect((await hostDebugState(page, macroId)).transientIds).toEqual([]);
      });
    } finally {
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [THROW_CELL]).catch(() => {});
    }
  });
});
