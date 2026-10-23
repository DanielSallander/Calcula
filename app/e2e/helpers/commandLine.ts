/**
 * FILENAME: e2e/helpers/commandLine.ts
 * PURPOSE: ONE definition of how a spec drives the Command Line (View > Command
 *          Line / Ctrl+Shift+P): open it, type a line at its prompt, run it,
 *          read what it printed, close it.
 * CONTEXT: Lifted from `journeys/calp-macro-buttons.spec.ts` (its
 *          "The command line (owner decision B, follow-up F2)" section), where
 *          the five functions were spec-local. That spec is NOT re-pointed here
 *          yet (a follow-up); until then the two copies are byte-identical in
 *          their bodies, and THIS file is the one new specs import.
 *
 * WHY ONE COPY. `helpers/macroEditor.ts` tells the story: `retypeToken` lived
 * as six byte-identical copies, a fix was applied to two of them, and the four
 * that never learned produced an intermittent failure (BUG-0025). A helper that
 * exists in one place can be fixed in one place; one that exists in six is fixed
 * in two. The command line's run key, its prompt-mode button and the shape of
 * its output lines are all product details that WILL change, and when they do
 * every spec that typed a `run` line should learn at once.
 *
 * WHAT IS PRODUCT ROUTE AND WHAT IS NOT. Opening goes through the registered
 * command (`commandLine.toggle`, the same one the menu and the shortcut execute),
 * with `showDialog("command-line-panel")` as the fallback; typing goes through
 * Monaco's own input path with real keystrokes; Ctrl+Enter is the prompt's run
 * key. Reading uses the panel's `<pre>` entries. Nothing here calls the CLI's
 * modules directly -- a line a person TYPES is the act the command line's
 * explicit-run pass stands for (docs/design/wave3-scripting-security.md 11.1),
 * and a helper that bypassed the keystrokes would be proving a different door.
 */
import type { Locator, Page } from "@playwright/test";
import { callModule, eventually, installAppImport, type AppWindow } from "./calp-harness";

/** Plain ASCII for the terminal (CLAUDE.md "Clean Output"). */
function ascii(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "?");
}

function log(message: string): void {
  console.log(`[commandLine] ${ascii(message)}`);
}

/** Press the Command Line toggle the way View > Command Line / Ctrl+Shift+P do (the registered command). */
export async function toggleCommandLine(page: Page): Promise<void> {
  await installAppImport(page);
  await page.evaluate(async () => {
    const m = (await (window as unknown as AppWindow).__appImport!("/src/api/commands.ts")) as {
      CommandRegistry: { execute: (id: string) => Promise<unknown> };
    };
    await m.CommandRegistry.execute("commandLine.toggle");
  });
}

/** Open the command line panel (its toggle, falling back to the dialog service) and return it. */
export async function openCommandLine(page: Page): Promise<Locator> {
  const header = page.locator("span", { hasText: /^Command Line$/ });
  if ((await header.count()) === 0) {
    await toggleCommandLine(page);
    const opened = await header.first().waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
    if (!opened) {
      log("the toggle did not open the command line; opening it through @api showDialog");
      await callModule(page, "/src/api/index.ts", "showDialog", ["command-line-panel"]);
    }
  }
  await header.first().waitFor({ state: "visible", timeout: 10_000 });
  const panel = header.first().locator("xpath=../..");
  await panel.locator(".monaco-editor").first().waitFor({ state: "visible", timeout: 20_000 });
  return panel;
}

export async function closeCommandLine(page: Page): Promise<void> {
  const header = page.locator("span", { hasText: /^Command Line$/ });
  if ((await header.count()) > 0) {
    await header.first().locator("xpath=..").locator("button", { hasText: "\u2715" }).click().catch(() => undefined);
  }
}

export async function commandLineEntries(panel: Locator): Promise<string[]> {
  return panel.locator("pre").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
}

/**
 * TYPE `text` at the prompt and run it (Ctrl+Enter, the prompt's run key) -- the
 * person's act the command line's pass stands for. Resolves with the lines the
 * run printed once `done` matches one of them.
 */
export async function typeAtCommandLine(page: Page, panel: Locator, text: string, done: RegExp): Promise<string[]> {
  const before = (await commandLineEntries(panel)).length;
  const promptButton = panel.locator("button", { hasText: /^Prompt$/ });
  if ((await promptButton.count()) > 0) await promptButton.click();
  await panel.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press("Control+Enter");
  const lines = await eventually(
    async () => (await commandLineEntries(panel)).slice(before),
    (l) => l.some((x) => done.test(x)),
    `the command line never finished "${text}"`,
    30_000,
  );
  await page.waitForTimeout(500);
  return lines;
}
