/**
 * FILENAME: app/e2e/tests/inline-editor-live.spec.ts
 * PURPOSE: Prove the inline editor's semantics through the REAL grid after the
 *          <input> -> <textarea> swap.
 *
 * CONTEXT: the swap touches every cell edit in the product, so the unit tests
 * pinning it are necessary but not sufficient — they render the component, not
 * the grid. These drive the actual canvas grid over CDP: Enter commits,
 * Alt+Enter inserts a newline AND grows the box, Escape cancels, Tab commits
 * and moves, multi-line content loads back, and the pre-existing horizontal
 * expansion still happens.
 *
 * The editor is located by `data-inline-editor` — an attribute, not a tag,
 * which is why the tag swap moved no selector (styled-components hashes the
 * class, the documented dialog-selector trap).
 *
 * FOCUS DISCIPLINE: `grid.navigateTo` drives the Name Box and ends with focus
 * on that chrome, so keystrokes never reach the inline editor — a silently
 * empty test. `focusCell` below is the pattern `formula-autocomplete.spec.ts`
 * had to work out for the same reason: navigate via the app's own
 * `app:navigate-to-cell`, then focus the spreadsheet CONTAINER and re-assert,
 * and leave no sibling test's editor open.
 */
import { test, expect } from "../fixtures";
import { parseCellRef } from "../helpers/grid";
import type { Page } from "@playwright/test";

const EDITOR = '[data-inline-editor="true"]';

/**
 * Everything that can make a commit into `ref` produce an EMPTY cell, read at
 * the moment the assertion fails.
 *
 * WHY THIS EXISTS. Test 8 has failed in the FULL functional run and passed 8/8
 * cold in isolation, with `B30` coming back empty rather than holding a prefix.
 * The register recorded that outcome twice and both times ended
 * "the upstream spec responsible is NOT identified" — because the only evidence
 * a shared 450-test run leaves behind is `expected "tabbed", received ""`, which
 * is compatible with half a dozen different causes and points at none of them.
 * Bisecting a shared-app suite to find it costs hours; making the failure name
 * its own cause costs this function.
 *
 * The discriminator that matters is the LAST field: a direct `update_cell`
 * bypasses the keyboard entirely. If that succeeds, the keystrokes never
 * arrived (focus, timing, an editor left open by a sibling); if it is REFUSED,
 * the backend is rejecting writes to this cell and the message says why —
 * sheet protection, a stale spill map (§2y), a validation rule. It writes to
 * the SUBJECT cell on purpose — "is this coordinate writable at all?" is the
 * question — and only ever runs on the failure path, where the spec is already
 * lost and the residue it leaves is a value that says DIAGNOSTIC.
 */
async function diagnoseCommitFailure(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const probe = await page.evaluate(
    async ({ r, c }) => {
      const tauri = (window as never as { __TAURI__?: { core?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__;
      const invoke = tauri?.core?.invoke;
      if (!invoke) return { error: "no Tauri bridge" };
      const safe = async (cmd: string, args?: unknown) => {
        try {
          return await invoke(cmd, args);
        } catch (e) {
          return `REFUSED: ${e instanceof Error ? e.message : String(e)}`;
        }
      };
      return {
        cell: await safe("get_cell", { row: r, col: c }),
        activeSheet: await safe("get_active_sheet"),
        sheets: await safe("get_sheets"),
        undo: await safe("get_undo_state"),
        validation: await safe("get_data_validation", { row: r, col: c }),
        protection: await safe("get_protection_status"),
        cellProtection: await safe("get_cell_protection", { row: r, col: c }),
        hiddenRows: await safe("get_user_hidden_rows"),
        editorOpen: document.querySelectorAll('[data-inline-editor="true"]').length,
        focused: document.activeElement?.getAttribute("data-focus-container") ?? null,
        // THE DISCRIMINATOR: does the BACKEND accept a write to this cell at all?
        directWrite: await safe("update_cell", { row: r, col: c, value: "DIAGNOSTIC" }),
      };
    },
    { r: row, c: col },
  );
  return JSON.stringify(probe, null, 2);
}

async function focusCell(page: Page, ref: string): Promise<void> {
  const { row, col } = parseCellRef(ref);
  await page.evaluate(
    ({ r, c }) => {
      window.dispatchEvent(
        new CustomEvent("app:navigate-to-cell", {
          detail: { row: r, col: c, select: true },
        })
      );
    },
    { r: row, c: col }
  );
  await page.waitForTimeout(400);

  const container = page.locator('[data-focus-container="spreadsheet"]');
  const holdsFocus = () =>
    page.evaluate(
      () =>
        document.activeElement?.getAttribute("data-focus-container") ===
        "spreadsheet"
    );
  for (let attempt = 0; attempt < 5; attempt++) {
    await container.focus();
    await page.waitForTimeout(200);
    if (!(await holdsFocus())) continue;
    // Leave no inline editor open: one app instance serves every spec, and a
    // sibling can leave the editor up on old content, which the first keystroke
    // would APPEND to.
    let clean = true;
    for (let i = 0; i < 4; i++) {
      const editing = await page.evaluate(
        () => (window as never as { __CALCULA_GRID_STATE__?: { editing?: unknown } })
          .__CALCULA_GRID_STATE__?.editing ?? null
      );
      if (!editing) {
        clean = true;
        break;
      }
      clean = false;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      await container.focus();
      await page.waitForTimeout(100);
    }
    if (clean) return;
  }
  throw new Error(
    `[inline-editor-live] spreadsheet container did not take focus for ${ref}; ` +
      "keystrokes would never reach the inline editor and the test would pass " +
      "vacuously."
  );
}

/**
 * Type `text` into the focused cell, opening the editor first and only then
 * sending the remainder.
 *
 * THE OPENING KEYSTROKE USED TO BE SPECIAL, and it was a real app race, not a
 * test artefact: the first character both entered the value AND mounted the
 * editor, and characters sent during that async hand-off did not accumulate.
 * Measured against the running app, `keyboard.type("hello")` committed **"o"**
 * and `keyboard.type("tabbed")` committed **"b"** — only the LAST keystroke
 * survived.
 *
 * FIXED 2026-08-09 (§2r): keystrokes that arrive while the editor is opening
 * are buffered and replayed in order instead of restarting the edit. Tests 7
 * and 8 below are the live proof and deliberately do NOT use this helper —
 * they type at full speed, which is what the bug report did.
 *
 * This helper keeps its wait anyway, because these six tests are about
 * commit/cancel semantics rather than about the opener: waiting keeps a future
 * opener regression from showing up here as six confusing failures instead of
 * two pointed ones.
 */
async function typeIntoCell(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text[0]);
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-inline-editor") === "true",
    undefined,
    { timeout: 5000, polling: 100 }
  );
  await page.waitForTimeout(150);
  if (text.length > 1) await page.keyboard.type(text.slice(1), { delay: 30 });
  await page.waitForTimeout(150);
}

test.describe("Inline editor (textarea) — live grid semantics", () => {
  test("1. Enter commits the entry and moves down", async ({ appPage: page, grid }) => {
    await focusCell(page, "B2");
    await typeIntoCell(page, "hello");
    await expect(page.locator(EDITOR)).toBeVisible();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("B2")).toBe("hello");
    expect(await page.locator(EDITOR).count()).toBe(0);
    expect(await grid.getNameBoxValue()).toBe("B3");
  });

  test("2. Alt+Enter inserts a newline and the editor GROWS", async ({ appPage: page, grid }) => {
    await focusCell(page, "B6");
    await typeIntoCell(page, "first");
    await expect(page.locator(EDITOR)).toBeVisible();
    const before = await page.locator(EDITOR).boundingBox();
    expect(before).not.toBeNull();

    await page.keyboard.press("Alt+Enter");
    await page.keyboard.type("second");
    await page.waitForTimeout(300);

    const after = await page.locator(EDITOR).boundingBox();
    expect(after).not.toBeNull();

    // The value really carries a newline (an <input> could not hold one).
    const live = await page.locator(EDITOR).inputValue();
    expect(live).toBe("first\nsecond");

    // ...and the box grew vertically to show it.
    expect(after!.height).toBeGreaterThan(before!.height);

    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const committed = await grid.getCellLiveValue("B6");
    expect(committed).toContain("first");
    expect(committed).toContain("second");
  });

  test("3. Escape cancels and restores the previous value", async ({ appPage: page, grid }) => {
    await grid.setCellValueDirect("B10", "original");
    await page.waitForTimeout(200);
    await focusCell(page, "B10");
    await page.keyboard.press("F2");
    await expect(page.locator(EDITOR)).toBeVisible();
    await page.keyboard.type("XXX");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    expect(await page.locator(EDITOR).count()).toBe(0);
    expect(await grid.getCellDisplayValue("B10")).toBe("original");
  });

  test("4. Tab commits and moves right", async ({ appPage: page, grid }) => {
    await focusCell(page, "B14");
    await typeIntoCell(page, "tabbed");
    await expect(page.locator(EDITOR)).toBeVisible();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("B14")).toBe("tabbed");
    expect(await grid.getNameBoxValue()).toBe("C14");
  });

  test("5. existing multi-line content loads back into the editor", async ({ appPage: page, grid }) => {
    await grid.setCellValueDirect("B18", "alpha\nbeta\ngamma");
    await page.waitForTimeout(250);
    await focusCell(page, "B18");
    await page.keyboard.press("F2");
    await expect(page.locator(EDITOR)).toBeVisible();

    const loaded = await page.locator(EDITOR).inputValue();
    expect(loaded).toBe("alpha\nbeta\ngamma");
    const threeLine = await page.locator(EDITOR).boundingBox();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    await focusCell(page, "B20");
    await typeIntoCell(page, "x");
    await expect(page.locator(EDITOR)).toBeVisible();
    const oneLine = await page.locator(EDITOR).boundingBox();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    expect(threeLine!.height).toBeGreaterThan(oneLine!.height);
  });

  test("6. horizontal expansion over empty neighbours still works", async ({ appPage: page }) => {
    // Neighbours must be empty — an occupied neighbour deliberately blocks the
    // walk, so this measures expansion rather than the absence of a blocker.
    await focusCell(page, "B24");
    await typeIntoCell(page, "x");
    await expect(page.locator(EDITOR)).toBeVisible();
    const narrow = await page.locator(EDITOR).boundingBox();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    await focusCell(page, "B24");
    await typeIntoCell(
      page,
      "this is a considerably longer entry that must overflow its own column"
    );
    await page.waitForTimeout(400);
    const wide = await page.locator(EDITOR).boundingBox();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    expect(wide!.width).toBeGreaterThan(narrow!.width);
  });

  // ---------------------------------------------------------------------------
  // The opener race (§2r) — typed at full speed, which is how it was measured
  // ---------------------------------------------------------------------------

  test("7. a whole word typed into a CLOSED cell keeps every character", async ({ appPage: page, grid }) => {
    await focusCell(page, "B28");
    // No waiting for the editor: every one of these keystrokes lands while the
    // editor is still opening, which is the entire point. Pre-fix the editor
    // came up holding "o".
    await page.keyboard.type("hello");
    await expect(page.locator(EDITOR)).toBeVisible();
    expect(await page.locator(EDITOR).inputValue()).toBe("hello");

    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect(await grid.getCellDisplayValue("B28")).toBe("hello");
  });

  test("8. the word AND its Enter typed at full speed still commit the word", async ({ appPage: page, grid }) => {
    await focusCell(page, "B30");
    // The commit key can land before there is anything to press it on. It must
    // be replayed, not dropped: pre-fix this committed "b" — when it committed
    // at all.
    await page.keyboard.type("tabbed");
    await page.keyboard.press("Enter");

    // POLLED, not slept on. The previous version waited a flat 500ms and then
    // read once — which is a race, and the one candidate cause of this test's
    // full-run-only failure that could be removed by construction rather than
    // by investigation: in isolation the commit lands in well under 500ms, and
    // at the end of a 450-test run in a shared app it need not. A poll cannot
    // fail for being early, and it keeps every tooth the fixed wait had: the
    // pre-fix build committed "b", which no amount of waiting turns into
    // "tabbed".
    try {
      await expect
        .poll(() => grid.getCellDisplayValue("B30"), {
          timeout: 10_000,
          intervals: [100, 200, 400],
          message: 'the word typed at full speed never reached B30',
        })
        .toBe("tabbed");
    } catch (failure) {
      // The OTHER candidate cause: something upstream is refusing writes to
      // this cell. Say which, here, instead of leaving the next reader the same
      // bare "received ''" the register has now recorded twice as unexplained.
      throw new Error(
        `${failure instanceof Error ? failure.message : String(failure)}\n\n` +
          `COMMIT DIAGNOSIS for B30 (see diagnoseCommitFailure):\n` +
          (await diagnoseCommitFailure(page, "B30")),
      );
    }
    expect(await page.locator(EDITOR).count()).toBe(0);
    expect(await grid.getNameBoxValue()).toBe("B31");
  });
});
