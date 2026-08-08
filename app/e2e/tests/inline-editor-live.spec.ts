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
 * Type `text` into the focused cell, opening the editor safely first.
 *
 * THE OPENING KEYSTROKE IS SPECIAL and this is a real app race, not a test
 * artefact: the first character both enters the value AND mounts the editor,
 * and characters sent during that async hand-off do not accumulate. Measured
 * here against the running app: `keyboard.type("hello")` commits **"o"** and
 * `keyboard.type("tabbed")` commits **"b"** — only the LAST keystroke survives.
 *
 * That race predates the <textarea> swap (`formula-autocomplete.spec.ts` works
 * around the same thing for `=SU`, and its header says the app is worth
 * fixing). It is NOT what these tests are about: they pin commit/cancel
 * semantics, so they open the editor, wait for it to exist, and only then type
 * the remainder. Test 3 types after F2 — no mount race — and passes either way,
 * which is what identifies the race as the opener rather than the editor.
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
});
