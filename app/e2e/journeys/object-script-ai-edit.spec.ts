/**
 * "EDIT WITH AI" — THE ROUND TRIP, AND THE PROMISE THAT NOTHING IS SAVED.
 *
 * WHY THIS FILE EXISTS. Every unit test for this feature mocks the one part that
 * can actually be wrong: the cross-window bridge. The Object Script Editor is a
 * SEPARATE Tauri window that activates no extensions, and every AI backend
 * command is window-guarded to `main` — so a request has to leave the editor as
 * a Tauri event, be picked up by a listener the ScriptableObjects extension
 * registers in the main window, go through the `@api/scriptAssistantService`
 * seam into AIChat, and come back the same way. Six moving parts, all stubbed
 * out in jsdom, and a silent failure at any of them leaves the author looking at
 * a spinner forever.
 *
 * WHAT IS PROVED HERE:
 *   1. The editor offers "Edit with AI" on a real recorded macro.
 *   2. A request with NO MODEL CONFIGURED comes back as a visible refusal —
 *      the round trip completes, and the refusal names where to go and fix it.
 *   3. The macro is byte-identical afterwards, in the buffer AND in the store.
 *
 * WHY THE REFUSAL PATH. The positive path needs a local model answering, which
 * is minutes of CPU and not deterministic. The refusal exercises the SAME six
 * parts — it differs only in what the seam decides — and it is the path that
 * fails silently if the bridge is broken, because "no answer" and "no model"
 * look identical from the editor. A run that never answered would time out here
 * exactly as it would for the user.
 *
 * THE MODEL SELECTION IS RESTORED. This drives the real app against the real
 * profile; clearing the owner's provider choice and leaving it cleared would be
 * a side effect of a test, so it is saved and put back in a finally.
 *
 * LOCALE. No numbers, no list separators — identical under sv-SE and en-US.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
// The ONE definition of how a spec reads the Monaco buffer. Re-deriving it here
// is how six drifting copies of retypeToken happened; the helper normalises the
// non-breaking spaces Monaco pads lines with, written as an escape.
import { editorText } from "../helpers/macroEditor";

/** Every artefact this spec creates carries this, so cleanup sweeps strays. */
const NAME_PREFIX = "E2EAiEdit";

/** The Object Script Editor's fixed Tauri window label. */
const EDITOR_LABEL = "object-script-editor";

/** Extension-settings keys behind `isConfigured()` on the assistant seam. */
const SETTING_KEYS = [
  "ext.calcula.ai-chat.providerId",
  "ext.calcula.ai-chat.model",
];

const MACRO_SOURCE =
  "async function e2eAiEditMacro(api) {\n" +
  "  await api.setCellValue(0, 0, 'before');\n" +
  "}\n";

// ---------------------------------------------------------------------------
// Backend + settings helpers — setup and assertions, never the thing under test
// ---------------------------------------------------------------------------

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

async function storedSource(page: Page, id: string): Promise<string | null> {
  // get_script, NOT list_scripts: the list returns SUMMARIES with no source at
  // all, so a find().source there is silently undefined and every comparison
  // against it fails for the wrong reason.
  return page.evaluate(async (id) => {
    const tauri = (window as any).__TAURI__;
    try {
      const script: { source?: string } = await tauri.core.invoke("get_script", { id });
      return script?.source ?? null;
    } catch {
      return null;
    }
  }, id);
}

/** Every script the workbook holds, as evidence when a lookup misses. */
async function scriptInventory(page: Page): Promise<string> {
  const list = await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    const scripts: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
    return scripts.map((s) => s.id + " / " + s.name);
  });
  return list.length === 0 ? "(the workbook holds no scripts)" : list.join(", ");
}

async function deleteMacrosWithPrefix(page: Page, prefix: string): Promise<void> {
  await page
    .evaluate(async (prefix) => {
      const tauri = (window as any).__TAURI__;
      const scripts: Array<{ id: string; name: string }> = await tauri.core.invoke("list_scripts");
      for (const s of scripts) {
        if (s.name?.startsWith(prefix) || s.id?.startsWith(prefix)) {
          await tauri.core.invoke("delete_script", { id: s.id }).catch(() => {});
        }
      }
    }, prefix)
    .catch(() => {});
}

/** Read the model selection so it can be put back exactly as it was. */
async function readSettings(page: Page, keys: string[]): Promise<Record<string, string | null>> {
  return page.evaluate((keys) => {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = window.localStorage.getItem(k);
    return out;
  }, keys);
}

async function writeSettings(page: Page, values: Record<string, string | null>): Promise<void> {
  await page.evaluate((values) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, v);
    }
  }, values);
}

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
  await editorPage.waitForTimeout(1_200);
  await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
  await expect(library).toBeHidden({ timeout: 5_000 });
  return editorPage;
}

// ===========================================================================

test.describe("Edit with AI reaches the main window and back", () => {
  // `appPage`, not the default `page` — the latter is a blank Playwright page,
  // not the Tauri app, and reading its localStorage is a SecurityError.
  test("a refusal completes the round trip and leaves the macro untouched", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);
    const macroName = `${NAME_PREFIX}Macro`;
    const macroId = `${NAME_PREFIX}-macro-1`;
    let savedSettings: Record<string, string | null> = {};

    await destroyEditorWindow(page);
    await deleteMacrosWithPrefix(page, NAME_PREFIX);

    try {
      savedSettings = await readSettings(page, SETTING_KEYS);

      await test.step("no model is selected, so the seam must refuse", async () => {
        await writeSettings(page, Object.fromEntries(SETTING_KEYS.map((k) => [k, null])));
      });

      await seedMacro(page, { id: macroId, name: macroName, source: MACRO_SOURCE });
      const editorPage = await openMacroInEditor(page, grid, macroName);

      await test.step("the toolbar offers Edit with AI on a recorded macro", async () => {
        const toggle = editorPage.locator("[data-testid='ai-edit-toggle']");
        await expect(toggle, "no Edit with AI button in the editor toolbar").toBeVisible({
          timeout: 20_000,
        });
        await toggle.click();
      });

      await test.step("the instruction goes to the main window", async () => {
        const box = editorPage.locator("[data-testid='ai-edit-instruction']");
        await expect(box, "the AI composer never opened").toBeVisible({ timeout: 10_000 });
        await box.click();
        await editorPage.keyboard.type("add a guard for an empty selection");
        await editorPage.locator("[data-testid='ai-edit-ask']").click();
      });

      await test.step("...and an answer comes BACK, rather than spinning forever", async () => {
        // This is the assertion the whole file is for. If any link in the
        // bridge is broken the editor stays in its running state and this times
        // out — which is exactly what the user would experience.
        const banner = editorPage.locator("[data-testid='ai-edit-error']");
        await expect(
          banner,
          "the editor never heard back from the main window — the bridge is broken",
        ).toBeVisible({ timeout: 60_000 });
        // The refusal has to say where to fix it: the model cannot be chosen
        // from this window.
        await expect(banner).toContainText(/AI Chat/i);
        await expect(banner).toContainText(/not changed/i);
      });

      await test.step("no diff was offered, and nothing was written", async () => {
        await expect(editorPage.locator("[data-testid='ai-edit-diff']")).toHaveCount(0);
        expect(await editorText(editorPage)).toContain("'before'");
        const stored = await storedSource(page, macroId);
        expect(
          stored,
          "a refused edit changed the stored macro. Inventory: " + (await scriptInventory(page)),
        ).toBe(MACRO_SOURCE);
      });
    } finally {
      await destroyEditorWindow(page);
      await deleteMacrosWithPrefix(page, NAME_PREFIX);
      // Put the owner's model choice back exactly as it was.
      if (Object.keys(savedSettings).length > 0) {
        await writeSettings(page, savedSettings).catch(() => {});
      }
    }
  });
});
