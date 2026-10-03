/**
 * THE STATUS BAR'S CODE-AND-SCRIPTS INDICATOR, THROUGH THE REAL UI (2026-10-03).
 *
 * The owner moved "Code in This File" and "Script Permissions" off the
 * activity rail: two icons that looked the same whether the file held no code
 * or code that reaches the network. In their place, one shield on the status
 * bar, straight after the selection readout, that SAYS whether the file holds
 * code (a count), whether anything is worth a look (an amber dot), and opens
 * onto those facts and both panels.
 *
 * WHY A JOURNEY. The unit tier pins the words (codeStatus.test.ts), the drawing
 * (codeStatusItem.test.tsx) and the CSS that keeps the item on the bar
 * (statusBarChrome.test.tsx) -- but jsdom computes no layout, performs no
 * native button activation, and has no Tauri event bus. Only the real app can
 * show that the indicator (a) updates from a REAL backend write with nothing
 * opened, (b) agrees with the panel it summarises, (c) opens upward inside the
 * window, (d) survives a script's 512-character status message on real boxes,
 * and (e) works from the keyboard.
 *
 * Every test starts from File > New and puts back what it adds.
 *
 * PROVED 2026-10-03: 9/9 live. The FIRST live run failed C5 and found a defect
 * no unit test could see: the trigger's css`` referred to the dot as
 * `.${dotClass}`, which @emotion/css treats as COMPOSITION -- the dot's 7px size
 * and amber fill landed on the button itself (12x7px live; jsdom computes no
 * layout). Fixed by reaching the dot through an attribute, now pinned by a
 * unit test that reads the generated rule. The same run showed the selection
 * readout cut to "Col:..." beside a long script message (flexbox shares a
 * shortfall in proportion; any share draws the ellipsis), so the readout no
 * longer shrinks while a script message shows. Each unit guard behind these
 * journeys was sabotage-checked (removed, test fails; restored byte for byte,
 * test passes).
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures";

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function callModule<T = unknown>(page: Page, modulePath: string, fn: string, args: unknown[] = []): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const m = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL(modulePath, document.baseURI).href)) as Record<string, (...a: unknown[]) => unknown>;
      if (typeof m[fn] !== "function") throw new Error(`${modulePath} exports no function "${fn}"`);
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

const indicator = (page: Page): Locator => page.locator('[data-testid="code-status"]');
const popoverMenu = (page: Page): Locator => page.locator('[role="menu"][aria-label="Code and scripts"]');
const sidePanel = (page: Page): Locator => page.locator("[data-side-panel]");

/** The indicator's state, polled until it reads `level` (reads land within the debounce). */
async function expectLevel(page: Page, level: string, label: string, timeout = 8_000): Promise<void> {
  await expect
    .poll(async () => indicator(page).getAttribute("data-level"), { timeout, intervals: [150], message: label })
    .toBe(level);
}

async function expectCount(page: Page, count: string, label: string, timeout = 8_000): Promise<void> {
  await expect
    .poll(async () => indicator(page).getAttribute("data-count"), { timeout, intervals: [150], message: label })
    .toBe(count);
}

async function closeSidePanel(page: Page): Promise<void> {
  const close = sidePanel(page).getByRole("button", { name: "Close panel" });
  if (await close.isVisible().catch(() => false)) await close.click();
  await expect(sidePanel(page)).toHaveCount(0);
}

async function closePopover(page: Page): Promise<void> {
  if (await popoverMenu(page).isVisible().catch(() => false)) await page.keyboard.press("Escape");
  await expect(popoverMenu(page)).toHaveCount(0);
}

const MODULE_ID = "e2e-code-status-module";
const OBJECT_ID = "e2e-code-status-reach";

async function removeTestCode(page: Page): Promise<void> {
  await callModule(page, "/src/api/workbookScripts.ts", "deleteWorkbookScript", [MODULE_ID]).catch(() => undefined);
  await callModule(page, "/src/api/objectScriptBackend.ts", "deleteObjectScript", [OBJECT_ID]).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

test.describe("the status bar's code-and-scripts indicator", () => {
  test.afterEach(async ({ grid }) => {
    const page = grid.page;
    await callModule(page, "/src/api/grid.ts", "clearStatusBarText").catch(() => undefined);
    await closePopover(page).catch(() => undefined);
    await closeSidePanel(page).catch(() => undefined);
    await removeTestCode(page);
  });

  test("C1: the rail no longer carries the two icons; the indicator sits straight after the selection readout, quiet on a new file", async ({ grid }) => {
    const page = grid.page;
    await newFile(page);

    // Off the rail...
    await expect(page.locator('[data-activity-view="scriptable-objects.codeInThisFile"]')).toHaveCount(0);
    await expect(page.locator('[data-activity-view="scriptable-objects.permissions"]')).toHaveCount(0);
    // ...while the rail itself is still there (positive control: the selector is right).
    await expect(page.locator('[data-activity-view="explorer"]')).toHaveCount(1);

    // On the bar, quiet: no code, nothing held, nothing refused.
    await expectLevel(page, "none", "a new file has no code");
    await expect(indicator(page)).toHaveAttribute("aria-label", "Code and scripts: No code in this file. Show details.");
    await expect(page.locator('[data-testid="code-status-dot"]')).toHaveCount(0);
    await expect(indicator(page).locator("svg")).toHaveAttribute("data-shield-mark", "check");

    // Straight after the selection readout, inside the 24px bar.
    await grid.clickCell("B4");
    const selection = await page.locator('[data-testid="status-bar-selection"]').boundingBox();
    const item = await indicator(page).boundingBox();
    const bar = await page.locator('[data-testid="status-bar"]').boundingBox();
    expect(selection && item && bar, "the bar, the readout and the indicator all render").toBeTruthy();
    expect(item!.x, "the indicator follows the selection readout").toBeGreaterThan(selection!.x + selection!.width);
    expect(item!.x - (selection!.x + selection!.width), "and sits right beside it").toBeLessThan(24);
    expect(item!.y).toBeGreaterThanOrEqual(bar!.y);
    expect(item!.y + item!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
  });

  test("C2: it opens UPWARD inside the window onto its facts, and each item opens its panel", async ({ grid }) => {
    const page = grid.page;
    await newFile(page);
    await expectLevel(page, "none", "a new file has no code");

    await indicator(page).click();
    await expect(popoverMenu(page)).toBeVisible();
    const pop = await popoverMenu(page).locator("xpath=..").boundingBox();
    const item = await indicator(page).boundingBox();
    expect(pop!.y + pop!.height, "the popover ends above the indicator").toBeLessThanOrEqual(item!.y);
    expect(pop!.y, "and starts inside the window").toBeGreaterThanOrEqual(0);
    await expect(page.locator('[data-code-status-fact="code"]')).toHaveText(/No code in this file/);

    await page.getByTestId("code-status-open-code").click();
    await expect(popoverMenu(page)).toHaveCount(0);
    await expect(sidePanel(page)).toContainText("Code in This File");
    await expect(sidePanel(page)).toContainText("This workbook contains no code.");

    await indicator(page).click();
    await page.getByTestId("code-status-open-permissions").click();
    await expect(sidePanel(page)).toContainText("Script Permissions");
    await expect(sidePanel(page)).toContainText("What scripts can do");
  });

  test("C3: a macro written to the file shows up WITHOUT opening anything; deleting it puts the quiet shield back", async ({ grid }) => {
    const page = grid.page;
    await newFile(page);
    await expectLevel(page, "none", "a new file has no code");

    // The real write door: announces itself as a Tauri event, the indicator's
    // re-read signal. Nothing is clicked, nothing is opened.
    await callModule(page, "/src/api/workbookScripts.ts", "saveWorkbookScript", [
      { id: MODULE_ID, name: "E2E macro", source: "Calcula.setCellValue('A1', 1);" },
    ]);
    await expectLevel(page, "present", "one local, grid-only macro");
    await expectCount(page, "1", "the panel's count");
    await expect(indicator(page)).toHaveText("1");

    await indicator(page).click();
    await expect(page.locator('[data-code-status-fact="code"]')).toContainText("1 piece of code in this file");
    await expect(page.locator('[data-code-status-fact="code"]')).toContainText("all written here");
    await closePopover(page);

    await callModule(page, "/src/api/workbookScripts.ts", "deleteWorkbookScript", [MODULE_ID]);
    await expectLevel(page, "none", "the macro is gone");
  });

  test("C4: code that can reach outside the grid raises the dot, and the indicator AGREES with the panel it opens", async ({ grid }) => {
    const page = grid.page;
    await newFile(page);
    await expectLevel(page, "none", "a new file has no code");

    await callModule(page, "/src/api/objectScriptBackend.ts", "saveObjectScript", [
      {
        id: OBJECT_ID,
        name: "E2E reach",
        objectType: "workbook",
        instanceId: null,
        source: "// @capability storage\nexport default {};",
        accessLevel: "restricted",
      },
    ]);
    // Nothing else is sent: the save door announces itself AFTER the backend
    // write (OBJECT_SCRIPTS_CHANGED_EVENT), and that alone must reach the item.
    await expectLevel(page, "notice", "a script that declares storage reaches beyond the grid");
    await expect(indicator(page).locator("svg")).toHaveAttribute("data-shield-mark", "alert");
    await expect(page.locator('[data-testid="code-status-dot"]')).toHaveCount(1);
    await expect(indicator(page)).toHaveAttribute("aria-label", /1 thing worth a look: 1 can reach beyond the grid/);

    // The popover says it, and its door opens the panel that says the same.
    await indicator(page).click();
    await expect(page.locator('[data-code-status-fact="beyond-grid"]')).toContainText("1 can reach beyond the grid");
    await page.getByTestId("code-status-open-code").click();
    await expect(sidePanel(page)).toContainText("1 code units");
    // The panel paints the SAME words from the same list.
    await expect(sidePanel(page)).toContainText("1 can reach beyond the grid");
  });

  test("C5: a script's 512-character status message truncates on one line and never pushes the indicator off the bar", async ({ grid }) => {
    const page = grid.page;
    await newFile(page);
    await expectLevel(page, "none", "a new file has no code");

    const long = "Status ".repeat(74).slice(0, 512);
    await callModule(page, "/src/api/grid.ts", "setStatusBarText", [long]);
    const mode = page.locator('[data-testid="status-bar-mode"]');
    await expect(mode).toHaveText(long);

    const bar = await page.locator('[data-testid="status-bar"]').boundingBox();
    const modeBox = await mode.boundingBox();
    const item = await indicator(page).boundingBox();
    const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    expect(modeBox!.height, "the message is ONE line, not wrapped over the bar").toBeLessThanOrEqual(bar!.height);
    expect(item!.width, "the indicator keeps its width").toBeGreaterThan(20);
    expect(item!.x + item!.width, "the indicator is still inside the window").toBeLessThanOrEqual(viewport.width);
    expect(item!.y + item!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
    // It is the message that gave way, not the indicator.
    expect(await mode.evaluate((el) => el.scrollWidth > el.clientWidth), "the message is truncated").toBe(true);
    // And it is still clickable there.
    await indicator(page).click();
    await expect(popoverMenu(page)).toBeVisible();
  });

  test("C6: right-click opens the indicator's popover, never the Sum/Average menu (which the rest of the bar still opens)", async ({ grid }) => {
    const page = grid.page;
    await newFile(page);
    await expectLevel(page, "none", "a new file has no code");

    await indicator(page).click({ button: "right" });
    await expect(popoverMenu(page)).toBeVisible();
    await expect(page.getByText("Numerical Count", { exact: true })).toHaveCount(0);
    await closePopover(page);

    // Positive control: the bar's own right-click still opens Sum/Average.
    await page.locator('[data-testid="status-bar-mode"]').click({ button: "right" });
    await expect(page.getByText("Numerical Count", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Numerical Count", { exact: true })).toHaveCount(0);
  });

  test("C7: the keyboard: Enter opens it on the first item, ArrowDown + Enter opens Script Permissions, Escape returns focus", async ({ grid }) => {
    const page = grid.page;
    await newFile(page);
    await expectLevel(page, "none", "a new file has no code");

    await indicator(page).focus();
    await page.keyboard.press("Enter");
    await expect(popoverMenu(page)).toBeVisible();
    await expect(page.getByTestId("code-status-open-code")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popoverMenu(page)).toHaveCount(0);
    await expect(indicator(page)).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("code-status-open-code")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("code-status-open-permissions")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sidePanel(page)).toContainText("Script Permissions");
  });

  test("C9: facts arriving while the popover is OPEN grow it UPWARD -- its two doors never leave the window", async ({ grid }) => {
    const page = grid.page;
    await newFile(page);
    await expectLevel(page, "none", "a new file has no code");

    await indicator(page).click();
    await expect(popoverMenu(page)).toBeVisible();
    const card = popoverMenu(page).locator("xpath=..");
    const before = await card.boundingBox();

    // Code lands while it is open: a macro and a script that reaches beyond
    // the grid -- the card gains rows.
    await callModule(page, "/src/api/workbookScripts.ts", "saveWorkbookScript", [
      { id: MODULE_ID, name: "E2E macro", source: "Calcula.setCellValue('A1', 1);" },
    ]);
    await callModule(page, "/src/api/objectScriptBackend.ts", "saveObjectScript", [
      {
        id: OBJECT_ID,
        name: "E2E reach",
        objectType: "workbook",
        instanceId: null,
        source: "// @capability storage\nexport default {};",
        accessLevel: "restricted",
      },
    ]);
    await expect(page.locator('[data-code-status-fact="beyond-grid"]')).toBeVisible({ timeout: 8_000 });
    await expect(popoverMenu(page)).toBeVisible();

    const after = await card.boundingBox();
    const item = await indicator(page).boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(after!.height, "the card grew").toBeGreaterThan(before!.height);
    // Held by its bottom edge: same bottom, taller card, top moved UP.
    expect(Math.abs(after!.y + after!.height - (before!.y + before!.height)), "the bottom edge stayed put").toBeLessThan(1.5);
    expect(after!.y + after!.height).toBeLessThanOrEqual(item!.y);
    // Both doors are on screen and still work.
    for (const door of ["code-status-open-code", "code-status-open-permissions"]) {
      const box = await page.getByTestId(door).boundingBox();
      expect(box!.y + box!.height, `${door} is inside the window`).toBeLessThanOrEqual(viewport.height);
      expect(box!.y).toBeGreaterThanOrEqual(0);
    }
    await page.getByTestId("code-status-open-code").click();
    await expect(sidePanel(page)).toContainText("Code in This File");
  });

  test("C8: Developer carries both panels too (a door that does not depend on the status bar)", async ({ grid }) => {
    const page = grid.page;
    await newFile(page);

    for (const [label, proof] of [
      ["Code in This File", "This workbook contains no code."],
      ["Script Permissions", "What scripts can do"],
    ] as const) {
      await grid.openMenu("Developer");
      const item = page.locator("button").filter({ hasText: new RegExp(`^${label}`) }).first();
      await item.waitFor({ state: "visible", timeout: 5_000 });
      await item.click();
      await expect(sidePanel(page)).toContainText(label);
      await expect(sidePanel(page)).toContainText(proof);
      await closeSidePanel(page);
    }
  });
});
