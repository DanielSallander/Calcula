/**
 * ONE definition of how a spec edits a module in the Object Script Editor.
 *
 * WHY THIS FILE EXISTS. `retypeToken` — double-click a token, type over it —
 * lived as SIX byte-identical copies (macro-live-edit, vba-idioms-wave1..4,
 * vba-wiring-batch). That is not merely repetition: it is six places for a fix
 * to be applied to, and it was applied to two of them. Waves 4 and the wiring
 * batch carried a comment saying the live chip could turn "Live" while the
 * store was still a keystroke behind, and worked around it by polling; the
 * other four never learned, and one of them (wave 3 #5) is the intermittent
 * failure filed as BUG-0025 — it typed "A1" and read `const jump = "A"` back.
 *
 * The product defect behind that is fixed (ObjectScriptEditorApp: the chip is
 * derived from the buffer as it is NOW, never from a write that a later
 * keystroke has overtaken), so the wait below is a wait on a signal that is
 * true when it says it is true. What remains here is the discipline that keeps
 * it honest:
 *
 *   - "live" is waited for, and the store is then read ONCE. Polling the store
 *     until it agrees would re-hide exactly the class of defect this file was
 *     born from, because a chip that lies is invisible to a poll that waits it
 *     out.
 *   - a failure reports the MONACO BUFFER alongside the stored text. That is
 *     the measurement that separates "the editor never received the keystroke"
 *     from "the store is behind the editor", and having to re-derive it cost
 *     this program a 38-minute run per hypothesis.
 */
import { type Page, expect } from "@playwright/test";

/** The module live-state chip that REPLACED the Save button for modules. */
export function liveIndicator(editorPage: Page) {
  return editorPage.locator("[data-testid='module-live-indicator']");
}

/** "live" | "saving" | "deferred" | "error" — the chip's machine-readable state. */
export async function liveState(editorPage: Page): Promise<string | null> {
  const el = liveIndicator(editorPage);
  if ((await el.count()) === 0) return null;
  return el.first().getAttribute("data-live-state");
}

/**
 * The text Monaco is showing right now.
 *
 * Monaco renders its lines as DOM and pads them with non-breaking spaces, which
 * are normalised back to ordinary ones here. These documents are short enough to
 * render in full; a long one would be virtualised and this would show the
 * viewport only, which is why it is used as EVIDENCE and never as an oracle.
 */
export async function editorText(editorPage: Page): Promise<string> {
  const text = await editorPage.locator(".monaco-editor .view-lines").first().innerText();
  // Written as an ESCAPE, never as a literal: an invisible U+00A0 sitting in
  // source is unreviewable, and this program has already lost time to a
  // character nobody could see.
  return text.replace(/\u00a0/g, " ");
}

/**
 * Retype a value the way a person would: double-click it to select the word,
 * then type the replacement. Real keystrokes through Monaco's own input path —
 * which is what the live-persist debounce is listening to.
 */
export async function retypeToken(editorPage: Page, from: string, to: string): Promise<void> {
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

/** The source the workbook's module store holds for `macroId`, right now. */
export async function storedModuleSource(page: Page, macroId: string): Promise<string> {
  return page.evaluate(async (id) => {
    // Reached by index rather than by a named property: the global is named by
    // Tauri, and spelling it as a type member would fight this repo's
    // camelCase naming rule for a name we do not own.
    type TauriBridge = { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
    const tauri = (window as unknown as Record<string, TauriBridge>)["__TAURI__"];
    const script = (await tauri.core.invoke("get_script", { id })) as { source?: unknown } | null;
    return String(script?.source ?? "");
  }, macroId);
}

/**
 * Retype + wait for the idle write-through, so what runs is what was typed.
 *
 * `expectStored` (default: the typed token) is the substring that must appear in
 * the stored source. On failure the message carries the three facts that decide
 * WHERE the fault is: the chip's state, the buffer on screen, and the bytes the
 * store holds.
 */
export async function retypeAndStore(
  page: Page,
  editorPage: Page,
  macroId: string,
  from: string,
  to: string,
  expectStored?: string,
): Promise<void> {
  await retypeToken(editorPage, from, to);
  await expect
    .poll(async () => liveState(editorPage), {
      timeout: 30_000,
      message: `the editor never reported the module live after typing "${to}"`,
    })
    .toBe("live");
  const stored = await storedModuleSource(page, macroId);
  const wanted = expectStored ?? to;
  if (!stored.includes(wanted)) {
    const buffer = await editorText(editorPage).catch(() => "(editor unavailable)");
    const chip = await liveState(editorPage).catch(() => null);
    throw new Error(
      `the module store does not hold the typed edit.\n` +
        `--- expected substring: ${JSON.stringify(wanted)}\n` +
        `--- live chip: ${chip}\n` +
        `--- monaco buffer ---\n${buffer}\n` +
        `--- stored source ---\n${stored}\n\n` +
        `If the BUFFER holds it and the STORE does not, the chip reported "live" ` +
        `while a write was still owed (BUG-0025's class). If the buffer does not ` +
        `hold it either, a keystroke never reached Monaco — a harness fault.`,
    );
  }
}
