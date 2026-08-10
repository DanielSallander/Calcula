/**
 * §2ac THROUGH THE REAL UI — Undo and Redo are offered only when they exist.
 *
 * WHAT §2ac WAS. The app NEVER disabled either affordance, anywhere. The Home
 * tab rendered `undo`/`redo` as plain `<Button>`s with no binding to
 * `get_undo_state`; the Edit menu items carried no enablement; and nothing in
 * `app/src` or `app/extensions` read `canUndo` for a UI state at all. On an
 * empty stack the button said "there is something here to undo" when there was
 * not — and until §2x landed, that press was the gesture that overwrote a cell
 * of the open workbook with a value from a document the user had closed.
 *
 * The fix is on the STORE (`undo_history::UndoHistory` announcing
 * `document:undo-state-changed` on a TRANSITION), a frontend bridge, and ONE
 * cached answer (`@api/undoState`) that both consumers read — so a greyed
 * ribbon button can never sit above an enabled menu entry for the same command.
 *
 * WHAT THIS SPEC ADDS over the 6 Rust store tests and the 27 frontend unit
 * tests: neither of those can see the WIRE. The backend event, the shell
 * bridge, the shared store, the Home tab's `disabled` attribute and the Edit
 * menu's `disabled` attribute are five hops, and every one of the unit tests
 * stands on one side or the other of it. This drives real gestures and reads
 * the real DOM.
 *
 * EVERY CLAIM IS PAIRED WITH ITS NEGATIVE, because "disabled" is trivially
 * satisfiable by a component that disables everything, and "enabled" by one
 * that binds nothing at all — which is precisely the state the app shipped in:
 *   - on the empty stack, a NEIGHBOURING ribbon button (Bold) must stay live;
 *   - after one edit, Undo enables while Redo stays disabled — the two halves
 *     move independently or the binding is a blanket toggle;
 *   - after the undo, Redo enables AND Undo goes dead;
 *   - a further edit clears the redo stack, so Redo goes dead again WHILE THE
 *     DOCUMENT IS ALREADY DIRTY AND STAYS DIRTY. That transition is the
 *     register's own argument for a channel separate from `document:dirty-
 *     changed`, and it is asserted here rather than repeated.
 *
 * WHY A JOURNEY. It calls File > New, writes `.cala` files and opens them.
 *
 * GRID REAL ESTATE. Columns EG..EJ (136..139). Every test starts from File > New.
 *
 * LOCALE. sv-SE. No formula here needs a list separator.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef, type GridHelper } from "../helpers/grid";

const FILE_ONE = path.join(os.tmpdir(), "calcula-undo-enablement-one.cala");
const FILE_TWO = path.join(os.tmpdir(), "calcula-undo-enablement-two.cala");

const CELL = "EG5";

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const t = (
        window as unknown as {
          __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
        }
      ).__TAURI__;
      return t.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

async function callModule<T = unknown>(
  page: Page,
  modulePath: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const m = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL(modulePath, document.baseURI).href)) as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      if (typeof m[fn] !== "function") {
        throw new Error(`${modulePath} exports no function "${fn}"`);
      }
      return (await m[fn](...(args as unknown[]))) as unknown;
    },
    { modulePath, fn, args },
  ) as Promise<T>;
}

async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(900);
}

/** Open a document through the app's own open path (announces, resets, no picker). */
async function openAt(page: Page, target: string): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [target]);
  await page.waitForTimeout(2000);
}

/**
 * The BACKEND's answer — the thing the UI is supposed to be showing.
 *
 * Only the two booleans, projected out of a payload that also carries depths
 * and descriptions: the assertions below compare the whole object, and a depth
 * would make every comparison brittle for no gain.
 */
async function undoState(page: Page): Promise<{ canUndo: boolean; canRedo: boolean }> {
  const full = await invoke<{ canUndo: boolean; canRedo: boolean }>(page, "get_undo_state");
  return { canUndo: full.canUndo, canRedo: full.canRedo };
}

/**
 * The ribbon button's own DOM state. THROWS when the button is absent: "I could
 * not find it" must never read as "it was correctly disabled".
 */
async function ribbonDisabled(page: Page, which: "undo" | "redo" | "bold"): Promise<boolean> {
  const btn = page.locator(`[data-testid="fmt-${which}"]`).first();
  if ((await btn.count()) === 0) {
    throw new Error(`the ribbon has no [data-testid="fmt-${which}"] button`);
  }
  return btn.isDisabled();
}

/**
 * The Edit menu item's own DOM state, resolved by WHOLE label so "Undo" cannot
 * silently match something else, and THROWING unless exactly one matches.
 */
async function editMenuDisabled(grid: GridHelper, label: "Undo" | "Redo"): Promise<boolean> {
  const page = grid.page;
  await grid.openMenu("Edit");
  const container = page
    .locator("button")
    .filter({ hasText: /^Edit$/ })
    .first()
    .locator("xpath=..");
  const buttons = container.locator("button");
  const count = await buttons.count();
  const matches: number[] = [];
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = ((await buttons.nth(i).innerText()) ?? "").replace(/\s+/g, " ").trim();
    texts.push(raw);
    const labelPart = raw.replace(/\s+(?:Ctrl|Alt|Shift)\+\S+$/, "").trim();
    if (labelPart === label) matches.push(i);
  }
  if (matches.length !== 1) {
    await grid.closeMenu();
    throw new Error(
      `expected exactly one Edit-menu item "${label}", found ${matches.length}. ` +
        `Menu contents: ${JSON.stringify(texts)}`,
    );
  }
  const disabled = await buttons.nth(matches[0]).isDisabled();
  await grid.closeMenu();
  return disabled;
}

/**
 * Assert the WHOLE picture at once — backend, ribbon and menu — so a surface
 * that has drifted from the other two is named rather than averaged away.
 * `wait` lets the event-driven store settle before the DOM is read.
 */
async function expectAvailability(
  grid: GridHelper,
  want: { canUndo: boolean; canRedo: boolean },
  label: string,
): Promise<void> {
  const page = grid.page;
  await expect
    .poll(async () => JSON.stringify(await undoState(page)), {
      timeout: 10_000,
      intervals: [200],
      message: `${label}: the BACKEND's undo state never reached the expected value`,
    })
    .toBe(JSON.stringify(want));

  await expect
    .poll(async () => await ribbonDisabled(page, "undo"), {
      timeout: 10_000,
      intervals: [200],
      message:
        `${label}: the ribbon's Undo button does not reflect canUndo=${want.canUndo}. ` +
        `The backend announces on a TRANSITION only — a button that never moved ` +
        `means the event, the bridge or the shared store did not carry it.`,
    })
    .toBe(!want.canUndo);

  await expect
    .poll(async () => await ribbonDisabled(page, "redo"), {
      timeout: 10_000,
      intervals: [200],
      message: `${label}: the ribbon's Redo button does not reflect canRedo=${want.canRedo}`,
    })
    .toBe(!want.canRedo);

  // ONE store, two consumers: a greyed ribbon button above a live menu entry
  // for the same command is the failure `@api/undoState` exists to prevent.
  expect(
    await editMenuDisabled(grid, "Undo"),
    `${label}: Edit > Undo disagrees with the ribbon's Undo button`,
  ).toBe(!want.canUndo);
  expect(
    await editMenuDisabled(grid, "Redo"),
    `${label}: Edit > Redo disagrees with the ribbon's Redo button`,
  ).toBe(!want.canRedo);
}

/** Write one cell through the REAL inline editor. */
async function typeInto(grid: GridHelper, ref: string, value: string): Promise<void> {
  await grid.navigateTo(ref);
  await grid.typeIntoCell(value);
  await grid.page.waitForTimeout(400);
}

async function cellDisplay(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cells = await invoke<Array<{ row: number; col: number; display: string }>>(
    page,
    "get_viewport_cells",
    { startRow: row, startCol: col, endRow: row, endCol: col },
  );
  return String(cells[0]?.display ?? "");
}

// ===========================================================================

test.describe.serial("§2ac — Undo and Redo are offered only when they exist", () => {
  test.beforeAll(() => {
    for (const f of [FILE_ONE, FILE_TWO]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  // =========================================================================
  // 1. THE FOUR TRANSITIONS, EACH WITH ITS NEGATIVE
  // =========================================================================
  test("a fresh document offers neither; an edit arms Undo; the undo arms Redo; the next edit disarms it again", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    // ---- (1) A FRESH DOCUMENT OFFERS NEITHER.
    await newFile(page);
    await expectAvailability(grid, { canUndo: false, canRedo: false }, "fresh document");

    // THE NEGATIVE. A component that disabled its whole group would satisfy
    // everything above. Bold sits in the same ribbon and must be untouched.
    expect(
      await ribbonDisabled(page, "bold"),
      "the Bold button went dead alongside Undo/Redo — the enablement is a blanket " +
        "over the ribbon, not a binding on exactly two ids",
    ).toBe(false);

    // ---- (2) ONE EDIT ARMS UNDO — AND ONLY UNDO.
    expect(
      await cellDisplay(page, CELL),
      "precondition: the cell must be empty, or the edit below may be a no-op that " +
        "pushes nothing onto the stack",
    ).toBe("");
    await typeInto(grid, CELL, "FIRST");
    expect(await cellDisplay(page, CELL), "the typed edit did not reach the cell").toBe("FIRST");

    await expectAvailability(grid, { canUndo: true, canRedo: false }, "after one edit");

    // ---- (3) THE UNDO ARMS REDO, AND DISARMS UNDO.
    await grid.navigateTo(CELL);
    await grid.undo();
    await page.waitForTimeout(500);
    expect(
      await cellDisplay(page, CELL),
      "the undo did not actually undo, so the state below would be about nothing",
    ).toBe("");
    await expectAvailability(grid, { canUndo: false, canRedo: true }, "after the undo");

    // ---- (4) THE NEXT EDIT CLEARS THE REDO STACK.
    //
    // This is the transition that proves the channel has to be its own. The
    // document was ALREADY dirty before this edit and is still dirty after it,
    // so `document:dirty-changed` emits nothing here — and yet Redo must go
    // from live to dead. A Redo button subscribed to the dirty flag would still
    // be offering a redo that no longer exists.
    const dirtyBefore = await invoke<boolean>(page, "is_file_modified");
    await typeInto(grid, CELL, "SECOND");
    const dirtyAfter = await invoke<boolean>(page, "is_file_modified");
    expect(
      [dirtyBefore, dirtyAfter],
      "precondition: this transition is only interesting while the dirty flag does " +
        "NOT move across it",
    ).toEqual([true, true]);

    await expectAvailability(grid, { canUndo: true, canRedo: false }, "after the redo-clearing edit");
  });

  // =========================================================================
  // 2. A DOCUMENT SWAP — THE BUTTONS FOLLOW THE NEW DOCUMENT
  // =========================================================================
  test("after opening another workbook both are dead again, and they come back with that document's own history", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    // Two saved workbooks. Saving is setup; the gestures under test are the
    // open and the edits.
    await newFile(page);
    await typeInto(grid, CELL, "IN-ONE");
    await invoke(page, "save_file", { path: FILE_ONE });
    await expect
      .poll(() => fs.existsSync(FILE_ONE), { timeout: 20_000, intervals: [200] })
      .toBe(true);

    await newFile(page);
    await typeInto(grid, CELL, "IN-TWO");
    await invoke(page, "save_file", { path: FILE_TWO });
    await expect
      .poll(() => fs.existsSync(FILE_TWO), { timeout: 20_000, intervals: [200] })
      .toBe(true);

    // Open ONE and edit it, so the affordances are live for a reason.
    await openAt(page, FILE_ONE);
    expect(
      await cellDisplay(page, CELL),
      "precondition: workbook ONE must be the document on screen",
    ).toBe("IN-ONE");
    await expectAvailability(grid, { canUndo: false, canRedo: false }, "freshly opened ONE");

    await typeInto(grid, CELL, "EDITED-IN-ONE");
    await expectAvailability(grid, { canUndo: true, canRedo: false }, "after editing ONE");

    // ---- THE SWAP. The undo stack dies with its document (§2x); the buttons
    // must say so. THE NEGATIVE IS THE LINE ABOVE: they were live a moment ago,
    // in the same session, on the same ribbon.
    await openAt(page, FILE_TWO);
    expect(
      await cellDisplay(page, CELL),
      "precondition: workbook TWO must be the document on screen",
    ).toBe("IN-TWO");
    await expectAvailability(
      grid,
      { canUndo: false, canRedo: false },
      "after swapping to TWO",
    );

    // ---- AND THEY REFLECT THE NEW DOCUMENT, not merely "off": an edit in TWO
    // arms Undo again, which a button stuck dead after the swap would fail.
    await typeInto(grid, CELL, "EDITED-IN-TWO");
    await expectAvailability(grid, { canUndo: true, canRedo: false }, "after editing TWO");

    // ---- The press that follows really belongs to TWO. §2x's guarantee, seen
    // from the affordance's side.
    await grid.navigateTo(CELL);
    await grid.undo();
    await page.waitForTimeout(500);
    expect(
      await cellDisplay(page, CELL),
      "the undo offered on the newly-opened document did not restore THAT " +
        "document's value",
    ).toBe("IN-TWO");
  });
});
