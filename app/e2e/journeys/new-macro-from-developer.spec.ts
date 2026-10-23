/**
 * FILENAME: e2e/journeys/new-macro-from-developer.spec.ts
 * PURPOSE: A first-time user writes, runs, undoes and re-runs a macro from
 *          Developer -- the "Macros on-ramp" (spec 2026-10-22, section 8's ONE
 *          live journey). The user never types a line of code.
 * CONTEXT: Developer > New Macro creates `Macro1` (`macro-macro1`, the starter
 *          from `@api/scriptHost/macroStarter.ts` through
 *          `@api/macroModules.createStarterMacro`) and opens it live in the
 *          Object Script Editor. The starter adds 1 to every SELECTED cell that
 *          holds a number, in ONE undo step, and runs ONCE per gesture from every
 *          door: F5 in the editor, Developer > Macros... > Run (object script),
 *          a button on the sheet, and `run Macro1` at the command line.
 *
 * THE PROOF IS THE A1 SEQUENCE. A1 starts at 10 and reads
 *     10 -> 11 (F5) -> 10 (Ctrl+Z) -> 11 (Ctrl+Y) -> 12 (Macros dialog)
 *        -> 13 (button) -> 14 (button again) -> 15 (command line).
 * Each step is +1 exactly, so a door that ran the work twice (the DIRECT-branch
 * double run of open-items.md, which a module macro sidesteps by construction:
 * the editor's mount is inert) reads 12 where 11 is expected and goes red on
 * the spot. Beside A1: A2 (2.5 -> 3.5, written as a NUMBER, read back in the app
 * locale), A3 (`x`, text: left alone), A4 (`=A1*2`: the formula is kept and
 * recalculates to 22).
 *
 * STATE AND DOM, NEVER PIXELS. Cells are read from the backend (`get_cell`), the
 * macro from the store (`get_script`), the editor's state from its own test ids
 * (`module-live-indicator`), the dialog from its `data-macro-*` attributes, the
 * menu from the rendered dropdown's buttons. No screenshot (the goldens are
 * stale and this machine runs at DPR 2).
 *
 * THE DEVELOPER MENU ORDER is asserted from the OPEN dropdown's rendered button
 * labels: New Macro < Record Macro... < Macros... < Object Script Editor <
 * Notebook. That is the four negative orders (-40, -30, -20, -10) of the two
 * extensions, proved from what the user sees rather than from the registry.
 *
 * F5 IS DISPATCHED SYNTHETICALLY. A real F5 keystroke is WebView2's RELOAD
 * accelerator (home-excel.spec.ts H13 learned this for the grid), so pressing
 * it with `keyboard.press` would reload the editor window instead of reaching
 * Monaco's keybinding. The spec clicks into Monaco and dispatches a keydown
 * with `keyCode: 116` to the focused element (Monaco resolves keybindings from
 * `keyCode`, not from `key`). If that still produced no run within ten seconds
 * the toolbar's Run button -- the SAME handler, `runFromCursor` -- is pressed
 * instead and the fallback is LOGGED and annotated, so the report says which
 * door fired. Either way the once-assertion (11, not 12) stands.
 *
 * THE STARTER ACTS ON THE SELECTION, and `getCellFormulaBarText` CLICKS the
 * cell it reads, which moves the selection. So A1:A4 is re-selected before
 * every run door after the first; this is the user's precondition ("select some
 * cells with numbers"), made explicit rather than left to the previous step.
 *
 * LOCALE. A2 is typed with the app locale's decimal separator (read from
 * `@api/locale.getLocaleSettings`, never assumed), and its display read back the
 * same way, so the journey is the same under sv-SE and en-US. The macro writes
 * NUMBERS (not text), which is what makes 3.5 come back as "3,5" under sv-SE.
 *
 * SCRIPT SECURITY is set to "enabled" for the run doors and restored in
 * `finally` (calp-macro-buttons' `withScriptsEnabled`): the subject here is the
 * doors, not the consent prompt.
 *
 * SELF-CLEANING. Any Object Script Editor window left by an earlier spec is
 * destroyed first (a stale one would be FOUND by `findEditorPage` before the
 * new macro reached it); the workbook is File > New before and after; the
 * command line panel is closed and proved hidden (a leaked task pane narrows
 * the grid for later specs).
 *
 * SABOTAGE PROOFS (spec section 8; the orchestrator performs each one LIVE,
 * once, and records the observed outcome here before the spec is trusted).
 * TODO (orchestrator), each a one-line edit applied, run, observed, reverted:
 *   S1  app/src/api/scriptHost/macroStarter.ts -- in the template body change
 *       `value: Number(cell.value) + AMOUNT,` to `value: Number(cell.value) + 2,`.
 *       EXPECTED RED: step "F5 runs macro1 once" -- `A1 after F5` reads "12",
 *       not "11" (and A2 reads 4.5 in the locale).
 *       OBSERVED 2026-10-23: RED as expected, both tests -- "A1 after F5 should read 11" (it read 12) and "A1 after F5 from the welcome door should read 11". Restored byte-identical.
 *   S2  app/extensions/MacroRecorder/index.ts -- on the `developer:new-macro`
 *       registration change `order: -40,` to `order: 0,`.
 *       EXPECTED RED: step "Developer menu order" -- New Macro sorts below
 *       Record Macro... / Macros... / Object Script Editor (0 ties with every
 *       order-less item and loses to the three negative orders).
 *       OBSERVED 2026-10-23: RED as expected -- "New Macro is not above Record Macro...": the dropdown read Record Macro, Macros, Object Script Editor, Notebook, ..., New Macro (ninth). The welcome test still passed (it does not assert the order). Restored byte-identical.
 *   S3  app/src/api/scriptHost/macroStarter.ts -- in the DIRECT branch of
 *       setup() change `return macro1(context.api).then((n) => {` to
 *       `macro1(context.api).then((n) => {` (drop `return`; the stored source
 *       the journey creates then carries the fire-and-forget form).
 *       EXPECTED RED: step "Developer > Macros... > Run (object script)" --
 *       `A1 after the dialog's Run` never reaches "12" (the one-off mount
 *       resolves before the write and the realm is gone), while the F5 step
 *       BEFORE it still passes: the two doors are independent.
 *       OBSERVED 2026-10-23: RED as expected -- "A1 after the dialog's Run should read 12" (the F5 step before it PASSED: the two doors are independent). Restored byte-identical.
 *   S4  app/src/api/macroNaming.ts -- in `buildStarterMacroDescription` drop
 *       the `runtime=objectScript` marker (e.g. return
 *       `Macro \u00b7 written ${writtenAt}`).
 *       EXPECTED RED: step "Developer > Macros... > Run (object script)" --
 *       `selectInMacrosDialog` reads `data-macro-run-route="moduleRuntime"`
 *       instead of `objectScript`.
 *       OBSERVED 2026-10-23: RED, one step EARLIER than predicted -- "the document select never selected the new macro": without the marker the editor labels the document MODULE, not MACRO, so the label assertion fails before the dialog's route assertion is reached. The marker is therefore pinned twice on this path. Restored byte-identical.
 *   S5  app/extensions/ScriptableObjects/components/ObjectScriptEditorApp.tsx --
 *       delete the line `keybindings: [monaco.KeyCode.F5],` from the
 *       `objectScript.debug.runOrContinue` action.
 *       EXPECTED RED: step "F5 runs macro1 once" -- `taken` is false (Monaco
 *       took no F5), with no fallback to the toolbar button.
 *       OBSERVED 2026-10-23: RED as expected, both tests -- "Monaco did not take the synthetic F5" (defaultPrevented=false) and the welcome test's "F5 was not taken by Monaco". No fallback fired. Restored byte-identical.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { menuBarButton, type GridHelper } from "../helpers/grid";
import { callModule, dismissToasts, eventually, invoke, newFile, sheets } from "../helpers/calp-harness";
import { gridSelection } from "../helpers/edit-harness";
import { editorText, liveState, storedModuleSource } from "../helpers/macroEditor";
import { closeCommandLine, openCommandLine, typeAtCommandLine } from "../helpers/commandLine";

/** The Object Script Editor's fixed Tauri window label (object-script-ai-edit.spec.ts). */
const EDITOR_LABEL = "object-script-editor";

/** What Developer > New Macro mints on an empty store (spec section 2, step 2). */
const MACRO_ID = "macro-macro1";
const MACRO_NAME = "Macro1";

const API_LOCALE = "/src/api/locale.ts";
const DESIGN_MODE = "/src/api/designMode.ts";
const FLOATING_STORE = "/extensions/Controls/lib/floatingStore.ts";

/** Where the dialog's Add Button places the button: B6 = row 5, col 1. */
const BUTTON_ANCHOR = "B6";
const BUTTON_ROW = 5;
const BUTTON_COL = 1;

// ---------------------------------------------------------------------------
// Plumbing (local copies, each named after the spec it was lifted from)
// ---------------------------------------------------------------------------

/** Plain ASCII for the terminal (CLAUDE.md "Clean Output"). */
function ascii(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "?");
}

function log(message: string): void {
  console.log(`[new-macro] ${ascii(message)}`);
}

/** calp-macro-buttons.spec.ts `withScriptsEnabled`: the doors, not the consent prompt, are under test. */
async function withScriptsEnabled<T>(page: Page, body: () => Promise<T>): Promise<T> {
  const previous = await invoke<string>(page, "get_script_security_level").catch(() => "prompt");
  await invoke(page, "set_script_security_level", { level: "enabled" });
  try {
    return await body();
  } finally {
    await invoke(page, "set_script_security_level", { level: previous }).catch(() => undefined);
  }
}

/** object-script-ai-edit.spec.ts `destroyEditorWindow`: from the MAIN window, by label. */
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

/** object-script-ai-edit.spec.ts `findEditorPage`: the editor page, once it exists and has loaded. */
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

/** calp-macro-buttons.spec.ts `openMacrosDialog`. */
async function openMacrosDialog(page: Page, grid: GridHelper): Promise<Locator> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await grid.openMenu("Developer");
  const item = page.locator("button").filter({ hasText: /^Macros/ }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click();
  const library = page.locator("[data-macro-library-dialog]");
  await expect(library, "Developer > Macros... did not open the macro library").toBeVisible({ timeout: 10_000 });
  return library;
}

/** calp-macro-buttons.spec.ts `selectInMacrosDialog`: listed once, and runs as an OBJECT SCRIPT. */
async function selectInMacrosDialog(library: Locator, name: string): Promise<void> {
  const row = library.locator("[data-macro-library-item]").filter({ hasText: name });
  await expect(row, `the Macros dialog does not list "${name}" exactly once`).toHaveCount(1);
  await row.click();
  await expect(library.locator("[data-macro-run-route]"), `"${name}" would not run as an object script`).toHaveAttribute(
    "data-macro-run-route",
    "objectScript",
  );
}

/** calp-macro-buttons.spec.ts `ensureRunMode`: a click on a button RUNS it (Design Mode would select it). */
async function ensureRunMode(page: Page): Promise<void> {
  const design = await callModule<boolean>(page, DESIGN_MODE, "getDesignMode");
  if (design) await callModule(page, DESIGN_MODE, "setDesignMode", [false]);
  expect(await callModule<boolean>(page, DESIGN_MODE, "getDesignMode"), "precondition: Design Mode is off").toBe(false);
}

/**
 * calp-macro-buttons.spec.ts `clickButtonCell`: click the button anchored at
 * `ref` with the real pointer -- after proving the point is not covered by a
 * dialog, so a click that "ran nothing" cannot be a click that never reached
 * the grid.
 */
async function clickButtonCell(page: Page, grid: GridHelper, ref: string): Promise<void> {
  const p = await grid.cellCenterScrollAware(ref);
  const box = await grid.canvas.boundingBox();
  const onScreen = !!box && p.x >= 0 && p.y >= 0 && p.x <= box.width && p.y <= box.height;
  if (box && onScreen) {
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        const area = document.querySelector("[data-grid-area]");
        const inside = !!el && !!area && area.contains(el);
        const what = el ? `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 80)}"` : "(nothing)";
        return { inside, what };
      },
      { x: box.x + p.x, y: box.y + p.y },
    );
    if (!hit.inside) throw new Error(`${ref} is covered by ${ascii(hit.what)}: a click there would not reach the button`);
  }
  await grid.clickCell(ref);
}

/** floating-grid-home.spec.ts `decimalSeparator`: the APP locale's, never assumed. */
async function decimalSeparator(page: Page): Promise<string> {
  const s = await callModule<{ decimalSeparator?: string }>(page, API_LOCALE, "getLocaleSettings");
  const sep = String(s?.decimalSeparator ?? "");
  expect(sep.length, "the app locale's decimal separator read empty: a display comparison would prove nothing").toBeGreaterThan(0);
  return sep;
}

/**
 * The item buttons of the OPEN Developer dropdown, top to bottom, with their
 * labels as rendered. The dropdown is the menu-bar button's second sibling and
 * its items are `./div/button` (the MenuBar's MenuContainer > Dropdown >
 * SubMenuContainer > MenuItemButton shape -- the same walk life-lifecycle.ts
 * `openLevel` makes); each item's label is the LAST line of its first child's
 * text, because several icons draw text (life-lifecycle.ts `itemLabel` explains
 * why a whole-text read is wrong). Separators render no button, so they are
 * simply absent from the list. Nothing here matches on text to FIND the menu,
 * so an item whose icon draws text cannot hide it.
 */
async function openDeveloperDropdown(page: Page, grid: GridHelper): Promise<{ items: Locator; labels: string[] }> {
  await grid.openMenu("Developer");
  const menuBtn = await menuBarButton(page, "Developer");
  const dropdown = menuBtn.locator("xpath=../*[2]");
  await expect(dropdown, "the Developer menu did not open a dropdown").toHaveCount(1, { timeout: 5_000 });
  const items = dropdown.locator("xpath=./div/button");
  const n = await items.count();
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    const text = ((await items.nth(i).locator("xpath=./*[1]").innerText().catch(() => "")) ?? "").trim();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    labels.push(lines.length > 0 ? lines[lines.length - 1] : "");
  }
  return { items, labels };
}

/** The editor's Console lines, as shown. */
async function consoleLines(editorPage: Page): Promise<string[]> {
  return editorPage.locator(".ose-console-line").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
}

/**
 * The buffer as Monaco shows it, PAGED: `editorText` is the rendered viewport
 * only (Monaco virtualises lines), and the starter's body begins at line 26,
 * below a 24-line header. The cursor sits at line 1 after open; each PageDown
 * (Monaco's own key -- not a browser accelerator) moves one viewport, and the
 * reads are concatenated until every wanted substring was seen or three pages
 * went by. Evidence, never the oracle: the store is the oracle.
 */
async function pagedEditorText(editorPage: Page, wanted: string[]): Promise<string> {
  // Focus Monaco first: PageDown goes to whatever holds the keyboard, and
  // nothing in the editor window has been clicked yet.
  await editorPage.locator(".monaco-editor").first().click();
  await editorPage.waitForTimeout(150);
  let text = await editorText(editorPage);
  for (let pages = 0; pages < 3 && !wanted.every((w) => text.includes(w)); pages++) {
    await editorPage.keyboard.press("PageDown");
    await editorPage.waitForTimeout(250);
    text += "\n" + (await editorText(editorPage));
  }
  // Back to the top, so a later Run resolves its cursor from line 1 (any line
  // resolves to macro1 -- spec section 2 step 4 -- but line 1 is the user's).
  await editorPage.keyboard.press("Control+Home");
  await editorPage.waitForTimeout(100);
  return text;
}

/** The document select's selected option text ("MACRO \u2014 Macro1"), read from the option itself. */
async function selectedDocumentLabel(editorPage: Page): Promise<string> {
  return editorPage
    .locator("select")
    .first()
    .evaluate((s) => {
      const sel = s as HTMLSelectElement;
      return (sel.selectedOptions[0]?.textContent ?? "").trim();
    });
}

/**
 * F5 in the editor. A real F5 is WebView2's reload accelerator, so the key is
 * dispatched as a DOM event to the element Monaco focused on the click (its
 * hidden textarea). Monaco's keybinding resolver reads `keyCode` (116 = F5);
 * `key`/`code` alone would not resolve. Returns whether Monaco took the key.
 */
async function pressF5InMonaco(editorPage: Page): Promise<boolean> {
  await editorPage.locator(".monaco-editor").first().click();
  await editorPage.waitForTimeout(150);
  return editorPage.evaluate(() => {
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    const init: KeyboardEventInit & { keyCode: number; which: number } = {
      key: "F5",
      code: "F5",
      keyCode: 116,
      which: 116,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    const down = new KeyboardEvent("keydown", init);
    // Belt and braces: some builds ignore the legacy init members.
    Object.defineProperty(down, "keyCode", { get: () => 116 });
    Object.defineProperty(down, "which", { get: () => 116 });
    target.dispatchEvent(down);
    const up = new KeyboardEvent("keyup", init);
    Object.defineProperty(up, "keyCode", { get: () => 116 });
    Object.defineProperty(up, "which", { get: () => 116 });
    target.dispatchEvent(up);
    return down.defaultPrevented;
  });
}

/** The floating button anchored at (row, col) is in the Controls store of the ACTIVE sheet (what paints and hit-tests it). */
async function waitForFloatingButton(page: Page, row: number, col: number): Promise<void> {
  const idx = (await sheets(page)).activeIndex;
  await eventually(
    () => callModule<Array<{ row: number; col: number }>>(page, FLOATING_STORE, "getFloatingControlsForSheet", [idx]),
    (all) => all.some((f) => f.row === row && f.col === col),
    `the button at ${BUTTON_ANCHOR} never reached the floating store of the active sheet`,
    10_000,
  );
  await page.waitForTimeout(300);
}

/** The user's precondition before every run door: the four cells are selected. */
async function selectTargets(grid: GridHelper): Promise<void> {
  await grid.selectRange("A1", "A4");
}

async function describeSelection(page: Page): Promise<string> {
  const s = await gridSelection(page).catch(() => null);
  return s ? `r${s.startRow}c${s.startCol}:r${s.endRow}c${s.endCol} (+${s.additionalRanges.length} areas)` : "(unreadable)";
}

/** Poll A1 (the backend's display) until it reads `expected`; the message names the door. */
async function expectA1(grid: GridHelper, page: Page, expected: string, door: string): Promise<void> {
  await expect
    .poll(() => grid.getCellDisplayValue("A1"), {
      timeout: 30_000,
      message: `A1 after ${door} should read ${expected} (selection was ${await describeSelection(page)})`,
    })
    .toBe(expected);
}

// ===========================================================================

test.describe("Macros on-ramp: Developer > New Macro", () => {
  // `appPage`, not the default `page`: the latter is a blank Playwright page.
  test("a first-time user writes, runs, undoes and re-runs a macro from Developer -- once per door: 10 -> 11 -> 10 -> 11 -> 12 -> 13 -> 14 -> 15", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);
    let editorPage: Page | null = null;

    await destroyEditorWindow(page);
    await newFile(page);
    await ensureRunMode(page);
    await dismissToasts(page);

    const sep = await decimalSeparator(page);
    const two5 = `2${sep}5`;
    const three5 = `3${sep}5`;

    try {
      await test.step("the workbook: 10, 2.5 (app locale), x, =A1*2; A1:A4 selected", async () => {
        await grid.setCellValue("A1", "10");
        await grid.setCellValue("A2", two5);
        await grid.setCellValue("A3", "x");
        await grid.setCellValue("A4", "=A1*2");
        await expectA1(grid, page, "10", "typing");
        // The oracle for the locale display, read back the way the macro's
        // result will be: if 2.5 did not land as 2.5 here, 3.5 proves nothing.
        expect(await grid.getCellDisplayValue("A2"), `A2 typed as ${ascii(two5)} in the app locale`).toBe(two5);
        expect(await grid.getCellDisplayValue("A3"), "A3").toBe("x");
        await expect.poll(() => grid.getCellDisplayValue("A4"), { timeout: 10_000, message: "A4 = A1*2" }).toBe("20");
        await selectTargets(grid);
      });

      await withScriptsEnabled(page, async () => {
        await test.step("Developer menu order: New Macro, Record Macro..., Macros..., Object Script Editor, then Notebook", async () => {
          const { items, labels } = await openDeveloperDropdown(page, grid);
          log(`Developer menu reads: ${labels.join(" | ")}`);
          const at = (pred: (l: string) => boolean, name: string): number => {
            const i = labels.findIndex(pred);
            expect(i, `the Developer menu has no "${name}" item; it reads ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(0);
            return i;
          };
          const iNew = at((l) => l === "New Macro", "New Macro");
          const iRecord = at((l) => l.startsWith("Record Macro"), "Record Macro...");
          const iMacros = at((l) => l.startsWith("Macros"), "Macros...");
          const iEditor = at((l) => l === "Object Script Editor", "Object Script Editor");
          const iNotebook = at((l) => l === "Notebook", "Notebook");
          const order = `${JSON.stringify(labels)}`;
          expect(iNew, `New Macro is not above Record Macro...: ${order}`).toBeLessThan(iRecord);
          expect(iRecord, `Record Macro... is not above Macros...: ${order}`).toBeLessThan(iMacros);
          expect(iMacros, `Macros... is not above Object Script Editor: ${order}`).toBeLessThan(iEditor);
          expect(iEditor, `Object Script Editor is not above Notebook: ${order}`).toBeLessThan(iNotebook);
          // Click it. No dialog: the macro is created and the editor opens.
          await items.nth(iNew).click();
        });

        await test.step("the Object Script Editor opens on MACRO -- Macro1, live, showing the starter", async () => {
          editorPage = await findEditorPage(page, 45_000);
          await editorPage.waitForSelector(".monaco-editor", { state: "visible", timeout: 45_000 });
          await expect
            .poll(() => liveState(editorPage!), { timeout: 30_000, message: "the module live chip never reported live" })
            .toBe("live");
          await expect
            .poll(() => selectedDocumentLabel(editorPage!), { timeout: 20_000, message: "the document select never selected the new macro" })
            // The em dash is the product's "KIND -- name" idiom (macroDocOptionLabel); written as an escape so it is reviewable.
            .toBe(`MACRO \u2014 ${MACRO_NAME}`);
          const wanted = ["async function macro1(api)", "api.getSelection()"];
          const shown = await pagedEditorText(editorPage, wanted);
          for (const w of wanted) {
            expect(shown, `the buffer does not show ${JSON.stringify(w)}`).toContain(w);
          }
          const stored = await storedModuleSource(page, MACRO_ID);
          expect(stored, `the store holds no setup() for ${MACRO_ID}`).toContain("function setup(context)");
          expect(stored, "the store holds a different work function than the buffer shows").toContain("async function macro1(api)");
        });

        await test.step("F5 runs macro1 once: A1 11, A2 3.5, A3 x, A4 = 22 and still a formula; Console says Running macro1()", async () => {
          const before = (await consoleLines(editorPage!)).length;
          const taken = await pressF5InMonaco(editorPage!);
          log(`synthetic F5 dispatched to Monaco (defaultPrevented=${taken})`);
          const ran = await eventually(
            async () => (await consoleLines(editorPage!)).slice(before),
            (lines) => lines.some((l) => /Running macro1\(\)/.test(l)),
            "F5 printed no Running line",
            10_000,
          ).then(
            () => true,
            () => false,
          );
          // NO FALLBACK. The toolbar Run button is the same handler, and a run
          // through it would make every later assertion pass while the one key
          // every on-ramp text names was broken (a review found exactly that:
          // deleting Monaco's F5 keybinding left this journey green). The door
          // under test is F5; if it does not fire, this step is red.
          expect(taken, "Monaco did not take the synthetic F5 (keybinding objectScript.debug.runOrContinue)").toBe(true);
          expect(ran, "F5 reached Monaco but started no run within 10 s (no 'Running macro1()' Console line)").toBe(true);
          await expect
            .poll(async () => (await consoleLines(editorPage!)).slice(before).filter((l) => /Running macro1\(\)/.test(l)).length, {
              timeout: 20_000,
              message: "the Console never printed `Running macro1()...`",
            })
            .toBe(1);
          // ONCE -- 11, not 12. This is the assertion the whole file is for.
          await expectA1(grid, page, "11", "F5");
          await expect.poll(() => grid.getCellDisplayValue("A2"), { timeout: 10_000, message: `A2 after F5 should read ${ascii(three5)}` }).toBe(three5);
          expect(await grid.getCellDisplayValue("A3"), "A3 (text) must be left alone").toBe("x");
          await expect.poll(() => grid.getCellDisplayValue("A4"), { timeout: 10_000, message: "A4 (=A1*2) should recalculate to 22" }).toBe("22");
          const a4 = await grid.getCellFormulaBarText("A4");
          expect(a4.startsWith("="), `A4 must still be a formula, it reads ${JSON.stringify(a4)}`).toBe(true);
          const complaints = (await consoleLines(editorPage!)).filter((l) => /did not run|Select the cells|Run failed/.test(l));
          expect(complaints, "the Console reports a refusal or a failure for the F5 run").toEqual([]);
        });

        await test.step("Ctrl+Z once takes A1 AND A2 back together (one step); Ctrl+Y puts them back", async () => {
          await grid.undo();
          await expectA1(grid, page, "10", "one Ctrl+Z");
          expect(await grid.getCellDisplayValue("A2"), "A2 after ONE Ctrl+Z: both cells are one undo step").toBe(two5);
          await grid.redo();
          await expectA1(grid, page, "11", "Ctrl+Y");
          expect(await grid.getCellDisplayValue("A2"), "A2 after Ctrl+Y").toBe(three5);
        });

        await test.step("Developer > Macros... > Run (object script): once -> 12; [OK] Finished", async () => {
          await dismissToasts(page);
          await selectTargets(grid);
          const library = await openMacrosDialog(page, grid);
          await selectInMacrosDialog(library, MACRO_NAME);
          const run = library.locator("[data-macro-run-button]");
          await expect(run, "the dialog's primary button is not the object-script Run").toHaveText("Run (object script)");
          await expect(run, "Run is not enabled for Macro1").toBeEnabled();
          await run.click();
          await expectA1(grid, page, "12", "the dialog's Run");
          await expect(library.locator("[data-macro-output]"), "the dialog did not report the run").toContainText("[OK] Finished", { timeout: 20_000 });

          // Add Button: a button at B6 that LINKS the macro, through the dialog.
          await library.locator("[data-macro-anchor-input]").fill(BUTTON_ANCHOR);
          await library.locator("[data-macro-add-button]").click();
          await waitForFloatingButton(page, BUTTON_ROW, BUTTON_COL);
          await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
          await expect(library, "the Macros dialog did not close").toBeHidden({ timeout: 5_000 });
        });

        await test.step("the button on the sheet runs it on every click: 13, then 14", async () => {
          await ensureRunMode(page);
          await dismissToasts(page);
          await selectTargets(grid);
          await clickButtonCell(page, grid, BUTTON_ANCHOR);
          await expectA1(grid, page, "13", "the first button click");
          await dismissToasts(page);
          await selectTargets(grid);
          await clickButtonCell(page, grid, BUTTON_ANCHOR);
          await expectA1(grid, page, "14", "the second button click");
        });

        await test.step("`run Macro1` at the command line: 15", async () => {
          await dismissToasts(page);
          await selectTargets(grid);
          const panel = await openCommandLine(page);
          const lines = await typeAtCommandLine(page, panel, `run ${MACRO_NAME}`, /ran \(|failed:|did not run/);
          expect(
            lines.some((l) => /Macro 'Macro1' ran \(/.test(l)),
            `the command line did not report the run; it printed ${JSON.stringify(lines.map(ascii))}`,
          ).toBe(true);
          await expectA1(grid, page, "15", "the command line");
          await closeCommandLine(page);
          // A leaked panel narrows the grid for every later spec.
          await expect(page.locator("span", { hasText: /^Command Line$/ }), "the command line panel is still open").toHaveCount(0, { timeout: 5_000 });
        });
      });
    } finally {
      await closeCommandLine(page).catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
      await destroyEditorWindow(page);
      await dismissToasts(page).catch(() => undefined);
      await newFile(page);
    }
  });

  // THE THIRD DOOR, LIVE: the editor window opened with NOTHING in the workbook
  // shows the welcome panel instead of a bare buffer; its New Macro button
  // creates Macro1, the buffer takes the editor's place back, the cursor is
  // put INTO the code (F5 is Monaco's key, not the window's -- outside the
  // editor it is WebView2's reload), and F5 then runs the starter once.
  test("the Object Script Editor opened empty shows the welcome panel; its New Macro button creates Macro1, focuses the code, and F5 runs it once", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(240_000);
    let editorPage: Page | null = null;

    await destroyEditorWindow(page);
    await newFile(page);
    await ensureRunMode(page);
    await dismissToasts(page);

    try {
      await test.step("the workbook: 10 in A1, selected", async () => {
        await grid.setCellValue("A1", "10");
        await expectA1(grid, page, "10", "typing");
        await grid.selectRange("A1", "A1");
      });

      await withScriptsEnabled(page, async () => {
        await test.step("Developer > Object Script Editor opens the window on the welcome panel, not on a buffer", async () => {
          const { items, labels } = await openDeveloperDropdown(page, grid);
          const iEditor = labels.findIndex((l) => l === "Object Script Editor");
          expect(iEditor, `the Developer menu has no "Object Script Editor" item; it reads ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(0);
          await items.nth(iEditor).click();
          editorPage = await findEditorPage(page, 45_000);
          const welcome = editorPage.locator("[data-testid='editor-welcome']");
          await expect(welcome, "the empty editor did not show the welcome panel").toBeVisible({ timeout: 30_000 });
          await expect(welcome, "the welcome panel does not say what a macro is").toContainText("Nothing to edit yet");
          await expect(editorPage.locator("[data-testid='editor-new-macro']"), "the welcome panel has no New Macro button").toBeVisible();
          // The buffer is HIDDEN (display none on its container), never unmounted.
          const monacoShown = await editorPage.locator(".monaco-editor").first().isVisible().catch(() => false);
          expect(monacoShown, "the welcome panel is showing but the buffer is still on screen beside it").toBe(false);
          const placeholder = await editorPage
            .locator("select")
            .first()
            .evaluate((s) => ((s as HTMLSelectElement).options[0]?.textContent ?? "").trim());
          expect(placeholder, "the document select's placeholder should send the user to New Macro").toContain("press New Macro");
        });

        await test.step("New Macro on the welcome panel: Macro1 is created, selected, live, and the cursor is in the code", async () => {
          const before = (await consoleLines(editorPage!)).length;
          await editorPage!.locator("[data-testid='editor-new-macro']").click();
          await expect(editorPage!.locator("[data-testid='editor-welcome']"), "the welcome panel stayed after New Macro").toBeHidden({ timeout: 30_000 });
          await editorPage!.waitForSelector(".monaco-editor", { state: "visible", timeout: 30_000 });
          await expect
            .poll(() => selectedDocumentLabel(editorPage!), { timeout: 20_000, message: "the document select never selected the new macro" })
            .toBe("MACRO " + String.fromCharCode(0x2014) + " " + MACRO_NAME);
          await expect
            .poll(() => liveState(editorPage!), { timeout: 30_000, message: "the module live chip never reported live" })
            .toBe("live");
          const stored = await storedModuleSource(page, MACRO_ID);
          expect(stored, `the store holds no setup() for ${MACRO_ID}`).toContain("function setup(context)");
          await eventually(
            async () => (await consoleLines(editorPage!)).slice(before),
            (lines) => lines.some((l) => /Created "Macro1"/.test(l)),
            "the Console never said the macro was created",
            10_000,
          );
          // FOCUS IS IN THE CODE: the click landed on a button, and a user who
          // reads "press F5" would otherwise reload the window.
          await expect
            .poll(
              () =>
                editorPage!.evaluate(() => {
                  const el = document.activeElement as HTMLElement | null;
                  return !!el && !!el.closest(".monaco-editor");
                }),
              { timeout: 10_000, message: "after New Macro the keyboard focus is not inside the code" },
            )
            .toBe(true);
        });

        await test.step("F5 (no click into the code first) runs macro1 once: A1 11", async () => {
          // NOT pressF5InMonaco, which clicks into Monaco first: the point here
          // is that the focus New Macro gave the editor is enough on its own.
          const taken = await editorPage!.evaluate(() => {
            const target = (document.activeElement as HTMLElement | null) ?? document.body;
            const init: KeyboardEventInit & { keyCode: number; which: number } = {
              key: "F5",
              code: "F5",
              keyCode: 116,
              which: 116,
              bubbles: true,
              cancelable: true,
              composed: true,
            };
            const down = new KeyboardEvent("keydown", init);
            Object.defineProperty(down, "keyCode", { get: () => 116 });
            Object.defineProperty(down, "which", { get: () => 116 });
            target.dispatchEvent(down);
            const up = new KeyboardEvent("keyup", init);
            Object.defineProperty(up, "keyCode", { get: () => 116 });
            Object.defineProperty(up, "which", { get: () => 116 });
            target.dispatchEvent(up);
            return down.defaultPrevented;
          });
          log(`synthetic F5 dispatched to the focused element (defaultPrevented=${taken})`);
          expect(taken, "F5 was not taken by Monaco: the focus New Macro gave the editor did not hold").toBe(true);
          await expectA1(grid, page, "11", "F5 from the welcome door");
          // ONCE: 11, not 12.
          await page.waitForTimeout(1_000);
          expect(await grid.getCellDisplayValue("A1"), "A1 moved again after the single F5").toBe("11");
        });
      });
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await destroyEditorWindow(page);
      await dismissToasts(page).catch(() => undefined);
      await newFile(page);
    }
  });
});
