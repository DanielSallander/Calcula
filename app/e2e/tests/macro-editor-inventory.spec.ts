/**
 * MACROS ARE FIRST-CLASS SCRIPT INVENTORY — proved against the real application.
 *
 * WHY THIS FILE EXISTS. The user came back a fourth time. Two bugs, both from the
 * same root cause — a module macro was treated as a transient visitor handed in
 * over an event, not as a member of the workbook's script inventory:
 *
 *   A. "I have two recorded macros ... but in the Object Script Editor I only
 *      see one at a time in the drop down menu."  The editor held ONE `macroDoc`
 *      state slot, fed only by the open-with-macro channel; opening the second
 *      macro replaced the first.
 *   B. "Cannot debug a script that is not mounted — apply it first. If I run it
 *      first it works, but I cannot debug it from start."  A module macro is
 *      never persistently mounted by design, and Debug required a standing mount.
 *
 * Unit tests declared this feature working three times before the user found it
 * broken, so every claim below is made against the REAL app: the real recorder,
 * the real Macros dialog, the real separate Object Script Editor window, the real
 * worker realms, the real backend module store. Nothing is stubbed.
 *
 * THE FOUR JOURNEYS (one test each, self-contained, cleaned up in a finally):
 *   1. TWO MACROS VISIBLE — record two macros, open the editor, see BOTH in the
 *      dropdown, and switch between them seeing each one's OWN source.
 *   2. COLD DEBUG — open a macro that has never been run in this session and
 *      press Debug. A session must open. ("Not mounted" is the bug.)
 *   3. RUN-AT-CURSOR, TWO TOP-LEVEL FUNCTIONS — put the cursor in the SECOND
 *      function, press Run, and see only THAT function's write land. Then the
 *      first. Then a two-argument function, which must REFUSE with a clear
 *      message rather than make a wrong-arity call.
 *   4. NO MOUNT LEAK — after a debug session ends, nothing is left mounted and a
 *      fresh session still opens. (A transient debug mount that survived Stop was
 *      an unlocked realm nothing would ever revoke.)
 *
 * SHARED APP. One app instance drives every functional spec, so this one owns a
 * private patch of the grid (rows 22-27 of column B) and cleans up before AND
 * after each test.
 *
 * LOCALE. Every value written is an integer or a bare word — no list separators,
 * no decimals — so the spec is identical under sv-SE and en-US.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const SHEET = 0;

/** Every macro name/id this spec creates carries this, so cleanup sweeps strays. */
const NAME_PREFIX = "E2EMacroInv";

/** The Object Script Editor's fixed Tauri window label. */
const EDITOR_LABEL = "object-script-editor";

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
 * Seed a macro module straight into the workbook script store, marked for the
 * OBJECT-SCRIPT runtime. Journey 1 records for real (that is the reported
 * gesture); journeys 2-4 only need a macro to EXIST and to have never been run,
 * so they seed one and stay deterministic.
 */
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
 * What the SCRIPT HOST in the main window believes about a script id.
 *
 * `sameModuleInstance` is a harness guard, not a product claim: it asserts that
 * the module this reaches through `__calcImport` is the very one the app is
 * running (function identity against the @api barrel). Without it a Vite
 * module-duplication accident would report "nothing mounted" for a live mount and
 * the leak assertions below would pass by being blind.
 */
async function hostMountState(
  page: Page,
  scriptId: string,
): Promise<{
  sameModuleInstance: boolean;
  mounted: boolean;
  transientIds: string[];
  hasSession: boolean;
}> {
  return page.evaluate(async (id) => {
    const host: any = await (window as any).__calcImport(
      new URL("/src/api/scriptHost/host.ts", document.baseURI).href,
    );
    const api: any = await (window as any).__calcImport(
      new URL("/src/api/index.ts", document.baseURI).href,
    );
    return {
      sameModuleInstance: host.hostIsMounted === api.hostIsMounted,
      mounted: host.hostIsMounted(id) === true,
      transientIds: (host.hostTransientDebugMountIds() as string[]) ?? [],
      hasSession: !!host.getDebugSession(id),
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

/**
 * Remove every module this spec created. Idempotent and failure-tolerant — runs
 * before AND after each test.
 */
async function cleanup(page: Page): Promise<void> {
  await releaseTransientDebugMounts(page);
  await page.evaluate(async (prefix) => {
    const tauri = (window as any).__TAURI__;
    try {
      const modules: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
      for (const m of modules) {
        if ((m.name && m.name.startsWith(prefix)) || (m.id && m.id.startsWith("macro-e2emacroinv"))) {
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

/**
 * DESTROY (not merely close) any editor window a previous run left. The editor
 * is a single Tauri window with a fixed label; a stale one makes a fresh create
 * fail on a duplicate label, and a bare page.close() leaves a zombie shell still
 * claiming it.
 */
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

/**
 * CLOSE the editor window the way the user does (the title-bar X), rather than
 * destroying it. This is the gesture whose cleanup path was never proved: the
 * editor announces its own close from `beforeunload`, and that announcement is
 * what releases the debugger-owned mounts.
 */
async function closeEditorWindow(page: Page): Promise<void> {
  await page.evaluate(async (label) => {
    const T = (window as any).__TAURI__;
    const WebviewWindow = T?.webviewWindow?.WebviewWindow;
    if (!WebviewWindow) throw new Error("Tauri webviewWindow API is not exposed");
    const existing = await WebviewWindow.getByLabel(label);
    if (!existing) throw new Error("the editor window is not open");
    await existing.close();
  }, EDITOR_LABEL);
  await page.waitForTimeout(1_200);
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

/**
 * Double-click a macro row in Developer > Macros... and hand back the editor
 * window it opens (or focuses), with Monaco mounted.
 */
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

/** The text Monaco is actually SHOWING (what the user reads on screen). */
async function editorText(editorPage: Page): Promise<string> {
  return editorPage.locator(".monaco-editor .view-lines").first().innerText();
}

/** Every console line the editor has printed, newest last. */
async function consoleText(editorPage: Page): Promise<string> {
  const lines = await editorPage.locator(".ose-console-line").allInnerTexts();
  return lines.join("\n");
}

/**
 * Put the caret on the line carrying `anchor` by clicking that rendered line.
 * The anchors are unique comments, so this is the user's own gesture — click
 * where you want to run from — not an API poke at the editor's internals.
 */
async function placeCursorOnAnchor(editorPage: Page, anchor: string): Promise<void> {
  const line = editorPage.locator(".view-line").filter({ hasText: anchor }).first();
  await expect(line).toBeVisible({ timeout: 10_000 });
  await line.click();
  await editorPage.waitForTimeout(250);
}

// ===========================================================================
// JOURNEY 1 — BUG A: BOTH recorded macros are in the editor's dropdown
// ===========================================================================

test.describe("Macros are first-class script inventory", () => {
  test("1. two recorded macros BOTH appear in the editor, each with its own source", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const nameOne = `${NAME_PREFIX} one ${stamp}`;
    const nameTwo = `${NAME_PREFIX} two ${stamp}`;
    const CELL_ONE = { ref: "B22", row: 21, col: 1 };
    const CELL_TWO = { ref: "B23", row: 22, col: 1 };
    const VALUE_ONE = "51511";
    const VALUE_TWO = "62622";

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [CELL_ONE, CELL_TWO]);

    /** Record one macro that writes one value into one cell. */
    async function recordMacro(macroName: string, ref: string, value: string): Promise<void> {
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

      await grid.setCellValue(ref, value);

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
    }

    let editorPage: Page | null = null;
    try {
      await test.step("record TWO macros, exactly as the user did", async () => {
        await recordMacro(nameOne, CELL_ONE.ref, VALUE_ONE);
        await recordMacro(nameTwo, CELL_TWO.ref, VALUE_TWO);
      });

      const idOne = await macroIdByName(page, nameOne);
      const idTwo = await macroIdByName(page, nameTwo);
      expect(idOne, "macro 1 was stored as a module").not.toBeNull();
      expect(idTwo, "macro 2 was stored as a module").not.toBeNull();
      expect(idTwo).not.toBe(idOne);

      // Both are in the Macros library — the user's own starting observation
      // ("I see them both in the Macros menu").
      await test.step("both macros are listed in Developer > Macros...", async () => {
        const library = await openMacroLibrary(page, grid);
        await expect(
          library.locator("[data-macro-library-item]").filter({ hasText: nameOne }),
        ).toHaveCount(1);
        await expect(
          library.locator("[data-macro-library-item]").filter({ hasText: nameTwo }),
        ).toHaveCount(1);
        await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
        await expect(library).toBeHidden({ timeout: 5_000 });
      });

      editorPage = await openMacroInEditor(page, grid, nameOne);

      // -- THE BUG-A ASSERTION -------------------------------------------------
      await test.step("BOTH macros are in the editor's document dropdown", async () => {
        const group = editorPage!.locator('optgroup[label="Macros / modules"]');
        await expect(group).toHaveCount(1, { timeout: 30_000 });
        // Present, in the macros group, and named — for BOTH, at the same time.
        // Before the fix the second option simply did not exist.
        const optOne = group.locator(`option[value="${idOne}"]`);
        const optTwo = group.locator(`option[value="${idTwo}"]`);
        await expect(optOne).toHaveCount(1, { timeout: 20_000 });
        await expect(optTwo).toHaveCount(1, { timeout: 20_000 });
        await expect(optOne).toContainText(nameOne);
        await expect(optTwo).toContainText(nameTwo);
      });

      await test.step("the editor opened ON macro one, showing macro one's source", async () => {
        await expect(documentSelect(editorPage!)).toHaveValue(idOne!, { timeout: 20_000 });
        const text = await editorText(editorPage!);
        expect(text, "macro one's recorded value is on screen").toContain(VALUE_ONE);
        expect(text, "macro two's value is NOT on screen").not.toContain(VALUE_TWO);
      });

      await test.step("selecting macro two shows macro TWO's source", async () => {
        await documentSelect(editorPage!).selectOption(idTwo!);
        await expect
          .poll(async () => editorText(editorPage!), { timeout: 20_000 })
          .toContain(VALUE_TWO);
        const text = await editorText(editorPage!);
        expect(text, "macro one's value is gone from the buffer").not.toContain(VALUE_ONE);
        await expect(documentSelect(editorPage!)).toHaveValue(idTwo!);
      });

      await test.step("switching BACK shows macro one again (neither replaced the other)", async () => {
        await documentSelect(editorPage!).selectOption(idOne!);
        await expect
          .poll(async () => editorText(editorPage!), { timeout: 20_000 })
          .toContain(VALUE_ONE);
        const text = await editorText(editorPage!);
        expect(text).not.toContain(VALUE_TWO);
        // ...and the OTHER macro is still listed while this one is open.
        await expect(
          editorPage!.locator(`optgroup[label="Macros / modules"] option[value="${idTwo}"]`),
        ).toHaveCount(1);
      });
    } finally {
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [CELL_ONE, CELL_TWO]).catch(() => {});
    }
  });

  // =========================================================================
  // JOURNEY 2 + 4 — BUG B: cold debug, and no mount left behind afterwards
  // =========================================================================

  test("2+4. a macro that has NEVER run can be debugged, and leaves no mount behind", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} cold ${stamp}`;
    const macroId = `macro-e2emacroinv-cold-${stamp}`;
    const CELL = { row: 23, col: 1 }; // B24
    const source =
      `// Macro: ${macroName}\n` +
      `async function e2eColdDebugMacro(api) {\n` +
      `  await api.setCellValue(${CELL.row}, ${CELL.col}, "70707");\n` +
      `}\n\n` +
      `function setup(context) {\n` +
      `  if (!context.api) { context.notify("needs an unlocked script", "error"); return; }\n` +
      `}\n`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [CELL]);

    let editorPage: Page | null = null;
    try {
      await seedMacro(page, { id: macroId, name: macroName, source });

      // It has NEVER been run in this session: nothing is mounted under its id.
      await test.step("precondition: the macro is not mounted (it has never run)", async () => {
        const before = await hostMountState(page, macroId);
        expect(before.sameModuleInstance, "harness reaches the app's own script host").toBe(true);
        expect(before.mounted).toBe(false);
        expect(before.hasSession).toBe(false);
        expect(before.transientIds).not.toContain(macroId);
      });

      editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      const debugButton = editorPage.locator("button").filter({ hasText: /^Debug$/ }).first();

      // -- THE BUG-B ASSERTION ------------------------------------------------
      await test.step("Debug opens a session from cold (no 'not mounted' refusal)", async () => {
        await expect(debugButton).toBeVisible({ timeout: 20_000 });
        await expect(debugButton).toBeEnabled();
        await debugButton.click();

        // A session badge is the editor's own proof that a session exists.
        await expect(editorPage!.locator(".osd-badge")).toBeVisible({ timeout: 60_000 });
        // ...and the refusal that WAS the bug is nowhere on screen.
        await expect(editorPage!.getByText(/not mounted/i)).toHaveCount(0);
        await expect(editorPage!.getByText(/apply it first/i)).toHaveCount(0);
      });

      await test.step("the host really mounted it, and marked the mount debugger-owned", async () => {
        await expect
          .poll(async () => (await hostMountState(page, macroId)).hasSession, { timeout: 30_000 })
          .toBe(true);
        const during = await hostMountState(page, macroId);
        expect(during.mounted, "a real worker realm exists for the macro").toBe(true);
        expect(
          during.transientIds,
          "the debugger owns this mount, so Stop can tear it down",
        ).toContain(macroId);
      });

      // -- THE LEAK ASSERTION (journey 4) -------------------------------------
      await test.step("Stop tears the mount down — nothing is left mounted", async () => {
        await editorPage!.locator("button").filter({ hasText: /^Stop$/ }).first().click();
        await expect(editorPage!.locator(".osd-badge")).toHaveCount(0, { timeout: 30_000 });

        await expect
          .poll(async () => (await hostMountState(page, macroId)).mounted, { timeout: 30_000 })
          .toBe(false);
        const after = await hostMountState(page, macroId);
        expect(after.hasSession).toBe(false);
        expect(
          after.transientIds,
          "no debugger-owned mount survives the session it was made for",
        ).not.toContain(macroId);
      });

      await test.step("a SECOND cold session still opens (the first left nothing broken)", async () => {
        await expect(debugButton).toBeVisible({ timeout: 20_000 });
        await debugButton.click();
        await expect(editorPage!.locator(".osd-badge")).toBeVisible({ timeout: 60_000 });
        await expect(editorPage!.getByText(/not mounted/i)).toHaveCount(0);
        await expect
          .poll(async () => (await hostMountState(page, macroId)).mounted, { timeout: 30_000 })
          .toBe(true);

        await editorPage!.locator("button").filter({ hasText: /^Stop$/ }).first().click();
        await expect
          .poll(async () => (await hostMountState(page, macroId)).mounted, { timeout: 30_000 })
          .toBe(false);
      });

      await test.step("the workbook is left with NO debugger-owned mounts at all", async () => {
        const end = await hostMountState(page, macroId);
        expect(end.transientIds).toEqual([]);
      });
    } finally {
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [CELL]).catch(() => {});
    }
  });

  // =========================================================================
  // JOURNEY 5 — closing the editor window releases the debugger's mount
  // =========================================================================
  //
  // A user who is done debugging closes the window; they do not necessarily
  // press Stop first. The mount the debugger made is an UNLOCKED `workbook`
  // realm — the most privileged thing this app runs — so if the close does not
  // release it, it survives in the main window with no UI left that knows it is
  // there. Nothing but this can prove the announcement actually crosses.

  test("5. closing the editor window releases the debugger-owned mount", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} close ${stamp}`;
    const macroId = `macro-e2emacroinv-close-${stamp}`;
    const CELL = { row: 24, col: 1 }; // B25
    const source =
      `// Macro: ${macroName}\n` +
      `async function e2eCloseWindowMacro(api) {\n` +
      `  await api.setCellValue(${CELL.row}, ${CELL.col}, "60606");\n` +
      `}\n\n` +
      `function setup(context) {\n` +
      `  if (!context.api) { context.notify("needs an unlocked script", "error"); return; }\n` +
      `}\n`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [CELL]);

    try {
      await seedMacro(page, { id: macroId, name: macroName, source });
      const editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      await test.step("a debug session is live, so a real unlocked realm exists", async () => {
        await editorPage.locator("button").filter({ hasText: /^Debug$/ }).first().click();
        await expect(editorPage.locator(".osd-badge")).toBeVisible({ timeout: 60_000 });
        await expect
          .poll(async () => (await hostMountState(page, macroId)).mounted, { timeout: 30_000 })
          .toBe(true);
        expect((await hostMountState(page, macroId)).transientIds).toContain(macroId);
      });

      await test.step("CLOSING the window (no Stop) releases it", async () => {
        await closeEditorWindow(page);
        await expect
          .poll(async () => (await hostMountState(page, macroId)).transientIds, { timeout: 30_000 })
          .not.toContain(macroId);
        const after = await hostMountState(page, macroId);
        expect(after.mounted, "no unlocked realm outlives the window that opened it").toBe(false);
        expect(after.hasSession).toBe(false);
      });
    } finally {
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [CELL]).catch(() => {});
    }
  });

  // =========================================================================
  // JOURNEY 3 — run-at-cursor with SEVERAL top-level functions
  // =========================================================================

  test("3. Run runs the function the cursor is in, and refuses a wrong arity", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);

    const stamp = Date.now().toString(36);
    const macroName = `${NAME_PREFIX} cursor ${stamp}`;
    const macroId = `macro-e2emacroinv-cursor-${stamp}`;
    const FIRST = { row: 25, col: 1 }; // B26
    const SECOND = { row: 26, col: 1 }; // B27
    const VALUE_FIRST = "81811";
    const VALUE_SECOND = "92922";

    // THREE top-level functions besides setup, deliberately: with more than one
    // non-setup function there is no "sole function" fallback, so the cursor —
    // and only the cursor — decides what runs.
    const source =
      `// Macro: ${macroName}\n` +
      `async function e2eWriteFirst(api) {\n` +
      `  // ANCHOR_FIRST_FUNCTION\n` +
      `  await api.setCellValue(${FIRST.row}, ${FIRST.col}, "${VALUE_FIRST}");\n` +
      `}\n` +
      `\n` +
      `async function e2eWriteSecond(api) {\n` +
      `  // ANCHOR_SECOND_FUNCTION\n` +
      `  await api.setCellValue(${SECOND.row}, ${SECOND.col}, "${VALUE_SECOND}");\n` +
      `}\n` +
      `\n` +
      `async function e2eNeedsTwoArguments(api, extra) {\n` +
      `  // ANCHOR_ARITY_FUNCTION\n` +
      `  await api.setCellValue(${FIRST.row}, ${FIRST.col}, String(extra));\n` +
      `}\n` +
      `\n` +
      `function setup(context) {\n` +
      `  if (!context.api) { context.notify("needs an unlocked script", "error"); return; }\n` +
      `}\n`;

    await allowScripts(page);
    await cleanup(page);
    await destroyEditorWindow(page);
    await clearCells(page, [FIRST, SECOND]);

    let editorPage: Page | null = null;
    try {
      await seedMacro(page, { id: macroId, name: macroName, source });
      editorPage = await openMacroInEditor(page, grid, macroName);
      await expect(documentSelect(editorPage)).toHaveValue(macroId, { timeout: 20_000 });

      const runButton = editorPage.locator("button").filter({ hasText: /^Run$/ }).first();
      await expect(runButton).toBeVisible({ timeout: 20_000 });
      await expect(runButton).toBeEnabled();

      await test.step("cursor in the SECOND function: only the second function's write lands", async () => {
        await clearCells(page, [FIRST, SECOND]);
        expect(await readCell(page, FIRST.row, FIRST.col)).toBe("");
        expect(await readCell(page, SECOND.row, SECOND.col)).toBe("");

        await placeCursorOnAnchor(editorPage!, "ANCHOR_SECOND_FUNCTION");
        await runButton.click();

        await expect
          .poll(async () => readCell(page, SECOND.row, SECOND.col), { timeout: 90_000 })
          .toContain(VALUE_SECOND);
        // The OTHER function did not run. This is the whole claim.
        expect(await readCell(page, FIRST.row, FIRST.col)).toBe("");
        // ...and the editor named what it started, out loud.
        expect(await consoleText(editorPage!)).toMatch(/Running e2eWriteSecond\(\)/);
      });

      await test.step("cursor in the FIRST function: only the first function's write lands", async () => {
        await clearCells(page, [FIRST, SECOND]);
        expect(await readCell(page, FIRST.row, FIRST.col)).toBe("");
        expect(await readCell(page, SECOND.row, SECOND.col)).toBe("");

        await placeCursorOnAnchor(editorPage!, "ANCHOR_FIRST_FUNCTION");
        await runButton.click();

        await expect
          .poll(async () => readCell(page, FIRST.row, FIRST.col), { timeout: 90_000 })
          .toContain(VALUE_FIRST);
        expect(await readCell(page, SECOND.row, SECOND.col)).toBe("");
        expect(await consoleText(editorPage!)).toMatch(/Running e2eWriteFirst\(\)/);
      });

      await test.step("cursor in a TWO-ARGUMENT function: a clear refusal, not a wrong call", async () => {
        await clearCells(page, [FIRST, SECOND]);
        await placeCursorOnAnchor(editorPage!, "ANCHOR_ARITY_FUNCTION");
        await runButton.click();

        await expect
          .poll(async () => consoleText(editorPage!), { timeout: 30_000 })
          .toMatch(/e2eNeedsTwoArguments/);
        const console = await consoleText(editorPage!);
        expect(console).toMatch(/takes 2 arguments/);
        // It refused; it did not call the function with a missing argument
        // (which would have written the string "undefined" into the cell).
        await page.waitForTimeout(2_000);
        expect(await readCell(page, FIRST.row, FIRST.col)).toBe("");
        expect(await readCell(page, SECOND.row, SECOND.col)).toBe("");
      });
    } finally {
      await destroyEditorWindow(page).catch(() => {});
      await cleanup(page).catch(() => {});
      await clearCells(page, [FIRST, SECOND]).catch(() => {});
    }
  });
});
