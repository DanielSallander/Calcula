/**
 * The Home tab's controls, found wherever the ribbon has put them.
 *
 * WHY THIS EXISTS (2026-10-04). The Home tab became Excel 365's: eight groups,
 * and on a narrow window they COLLAPSE right to left into group buttons, the
 * way Excel's do (collapse priorities Styles 10, Cells 20, Editing 30, then
 * Number, Alignment, Font, Clipboard, Undo). The E2E window is 1280 px wide,
 * and at that width Styles, Cells and Editing are group buttons: their
 * controls (`fmt-cellStyles`, `fmt-sortFilter`, `fmt-clear`, ...) are not in
 * the DOM at all until the group's flyout is opened. A spec that clicks
 * `[data-testid="fmt-sortFilter"]` directly therefore times out on a window of
 * that width and passes on a wider one -- the worst kind of test.
 *
 * `homeControl(page, testId)` is the ONE way the specs reach a Home control:
 *
 *   1. it makes sure the Home tab is the one on screen (never by re-clicking
 *      an ACTIVE tab: that collapses the ribbon -- fixall-edit's
 *      `clickRibbonTab` note);
 *   2. a control already visible (its group inline, or its flyout already
 *      open) is returned as it is;
 *   3. otherwise the collapsed group that holds it is opened
 *      (`section-launcher-home.<group>`) and the control is returned from
 *      INSIDE that flyout -- the group it belongs to by default is tried first,
 *      and then every other collapsed Home group, so a customised layout that
 *      moved the control still finds it;
 *   4. a control that is in no group at all fails loudly, naming the groups it
 *      looked in, instead of timing out on a selector.
 *
 * The flyout is what Excel's collapsed group shows (`Launcher` in
 * `src/api/layout/primitives/Launcher.tsx`): a body portal tagged
 * `data-section-flyout`, role="dialog", rendering the group's own section at
 * panel geometry, so every control keeps its `fmt-*` test id there. Menus a
 * flyout control opens are portals tagged the same way, so choosing a menu row
 * does NOT close the group's flyout; `closeHomeFlyouts` does, and the appPage
 * fixture's five Escapes do between tests.
 *
 * Nothing here asserts product behaviour. It finds things; the specs assert.
 */
import type { Locator, Page } from "@playwright/test";

/** The Home tab's groups in Excel's left-to-right order (homeTabConfig DEFAULT_LAYOUT). */
export const HOME_GROUP_IDS = [
  "undo",
  "clipboard",
  "font",
  "alignment",
  "number",
  "styles",
  "cells",
  "editing",
] as const;
export type HomeGroupId = (typeof HOME_GROUP_IDS)[number];

/** Their captions, in the same order. */
export const HOME_GROUP_LABELS = [
  "Undo",
  "Clipboard",
  "Font",
  "Alignment",
  "Number",
  "Styles",
  "Cells",
  "Editing",
] as const;

/**
 * Which default group each catalog item lives in. A HINT for which flyout to
 * open first -- never the only route: `homeControl` falls back to every other
 * collapsed Home group, so a layout the user customised is still searched.
 * Items that are in the catalog but not in the default layout (strikethrough,
 * clearAll, insertRow, ...) are listed under the group Customize Home Tab
 * offers them in, which is where a spec that puts one back would put it.
 */
const DEFAULT_GROUP_OF: Readonly<Record<string, HomeGroupId>> = {
  undo: "undo",
  redo: "undo",
  paste: "clipboard",
  cut: "clipboard",
  copy: "clipboard",
  formatPainter: "clipboard",
  fontName: "font",
  fontSize: "font",
  increaseFontSize: "font",
  decreaseFontSize: "font",
  bold: "font",
  italic: "font",
  underline: "font",
  strikethrough: "font",
  superscript: "font",
  subscript: "font",
  borders: "font",
  backgroundColor: "font",
  textColor: "font",
  formatCells: "font",
  alignTop: "alignment",
  alignMiddle: "alignment",
  alignBottom: "alignment",
  orientation: "alignment",
  wrapText: "alignment",
  alignLeft: "alignment",
  alignCenter: "alignment",
  alignRight: "alignment",
  decreaseIndent: "alignment",
  increaseIndent: "alignment",
  mergeCells: "alignment",
  numberFormat: "number",
  accountingFormat: "number",
  percentFormat: "number",
  commaFormat: "number",
  increaseDecimal: "number",
  decreaseDecimal: "number",
  conditionalFormatting: "styles",
  formatAsTable: "styles",
  cellStyles: "styles",
  insertCells: "cells",
  deleteCells: "cells",
  formatMenu: "cells",
  insertRow: "cells",
  insertColumn: "cells",
  deleteRow: "cells",
  deleteColumn: "cells",
  autoSum: "editing",
  fill: "editing",
  clear: "editing",
  sortFilter: "editing",
  findSelect: "editing",
  find: "editing",
  clearContents: "editing",
  clearFormatting: "editing",
  clearAll: "editing",
};

/** The section id the shell gives a Home group (`home.<group>`). */
export function homeSectionId(groupId: string): string {
  return `home.${groupId}`;
}

/** The test id of a collapsed Home group's button (SectionCell.tsx). */
export function homeGroupLauncherTestId(groupId: string): string {
  return `section-launcher-${homeSectionId(groupId)}`;
}

/**
 * The group a test id belongs to by default, or null when the id names no
 * catalog item (then every collapsed group is searched).
 *
 * `fmt-<itemId>` and `fmt-<itemId>-<suffix>` (a split's chevron, a palette)
 * map through the catalog item; `dialog-launcher-home.<group>` names its group
 * outright.
 */
export function defaultHomeGroupOf(testId: string): HomeGroupId | null {
  const launcher = /^dialog-launcher-home\.([A-Za-z]+)$/.exec(testId);
  if (launcher) {
    const g = launcher[1] as HomeGroupId;
    return (HOME_GROUP_IDS as readonly string[]).includes(g) ? g : null;
  }
  const m = /^fmt-([A-Za-z]+)/.exec(testId);
  if (!m) return null;
  return DEFAULT_GROUP_OF[m[1]] ?? null;
}

function byTestId(page: Page, testId: string): Locator {
  return page.locator(`[data-testid="${testId}"]`);
}

/** The ribbon's band (the strip of group cells). */
function ribbonBand(page: Page): Locator {
  return page.locator("[data-ribbon-content]").first();
}

/**
 * Whether the Home tab's sections are the ones in the band: either a Home
 * control is rendered there, or one of Home's collapsed group buttons is.
 */
async function homeIsShowing(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const band = document.querySelector("[data-ribbon-content]");
    if (!band) return false;
    return (
      band.querySelector('[data-testid="fmt-paste"], [data-testid="fmt-undo"], [data-testid="fmt-bold"]') !==
        null || band.querySelector('[data-testid^="section-launcher-home."]') !== null
    );
  });
}

/**
 * Make the Home tab the one on screen. Clicks the tab only when another tab is
 * showing: clicking the ACTIVE tab collapses the ribbon.
 */
export async function ensureHomeTab(page: Page): Promise<void> {
  if (await homeIsShowing(page)) return;
  const strip = page.locator("[data-ribbon-content]").locator("xpath=..");
  await strip.locator("button", { hasText: /^Home$/ }).first().click();
  for (let i = 0; i < 40; i++) {
    if (await homeIsShowing(page)) return;
    await page.waitForTimeout(100);
  }
  throw new Error("ensureHomeTab: the Home tab's controls never appeared in the ribbon band");
}

/** Whether a Home group is a collapsed group button right now. */
export async function homeGroupIsCollapsed(page: Page, groupId: string): Promise<boolean> {
  await ensureHomeTab(page);
  return (await byTestId(page, homeGroupLauncherTestId(groupId)).count()) > 0;
}

/** The ids of the Home groups that are collapsed right now, in band order. */
export async function collapsedHomeGroups(page: Page): Promise<string[]> {
  await ensureHomeTab(page);
  const ids = await page
    .locator('[data-ribbon-content] [data-testid^="section-launcher-home."]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-testid") ?? ""));
  return ids.map((id) => id.replace(/^section-launcher-home\./, ""));
}

/** The open flyout of a collapsed Home group (role="dialog", named by the group's label). */
function flyoutOf(page: Page, groupLabel: string): Locator {
  return page.locator(`[data-section-flyout][role="dialog"][aria-label="${groupLabel}"]`);
}

function labelOf(groupId: string): string {
  const i = (HOME_GROUP_IDS as readonly string[]).indexOf(groupId);
  return i >= 0 ? HOME_GROUP_LABELS[i] : groupId;
}

/**
 * Open a collapsed Home group's flyout and return it. Throws when the group is
 * not collapsed (an inline group has no flyout: its controls are in the band).
 */
export async function openHomeGroupFlyout(page: Page, groupId: string): Promise<Locator> {
  await ensureHomeTab(page);
  const button = byTestId(page, homeGroupLauncherTestId(groupId)).first();
  if ((await button.count()) === 0) {
    throw new Error(
      `openHomeGroupFlyout: the Home group "${groupId}" is not collapsed (no ` +
        `${homeGroupLauncherTestId(groupId)}); its controls are inline in the band`,
    );
  }
  const flyout = flyoutOf(page, labelOf(groupId));
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.click();
  }
  await flyout.first().waitFor({ state: "visible", timeout: 5_000 });
  return flyout.first();
}

/** Whether an element sits inside a collapsed group's flyout (or a popover). */
export async function isInHomeFlyout(control: Locator): Promise<boolean> {
  return control.evaluate((el) => el.closest("[data-section-flyout]") !== null);
}

/**
 * Close every open Home group flyout by toggling its group button (no Escape:
 * an Escape would also close a dialog the spec is looking at).
 */
export async function closeHomeFlyouts(page: Page): Promise<void> {
  const open = page.locator('[data-testid^="section-launcher-home."][aria-expanded="true"]');
  for (let i = 0; i < 8; i++) {
    if ((await open.count()) === 0) return;
    await open.first().click();
    await page.waitForTimeout(100);
  }
}

/**
 * The Home control with this test id, wherever the ribbon has put it: inline in
 * the band, or inside its collapsed group's flyout (opened when needed).
 *
 * Accepts `fmt-<itemId>` (and `fmt-<itemId>-options` etc.) and
 * `dialog-launcher-home.<group>`. The returned locator is the FIRST VISIBLE
 * element carrying the id.
 */
export async function homeControl(page: Page, testId: string): Promise<Locator> {
  await ensureHomeTab(page);
  const visible = byTestId(page, testId).filter({ visible: true });
  if ((await visible.count()) > 0) return visible.first();

  const collapsed = await collapsedHomeGroups(page);
  const hint = defaultHomeGroupOf(testId);
  const order = [
    ...(hint && collapsed.includes(hint) ? [hint] : []),
    ...collapsed.filter((g) => g !== hint),
  ];
  for (const groupId of order) {
    const flyout = await openHomeGroupFlyout(page, groupId);
    const inside = flyout.locator(`[data-testid="${testId}"]`).filter({ visible: true });
    // The section mounts inside the flyout on open; give it a moment to render.
    for (let i = 0; i < 10; i++) {
      if ((await inside.count()) > 0) return inside.first();
      await page.waitForTimeout(100);
    }
    await closeHomeFlyouts(page);
  }
  // One last look: a control that rendered late in the band.
  if ((await visible.count()) > 0) return visible.first();
  throw new Error(
    `homeControl: no visible [data-testid="${testId}"] on the Home tab -- not inline in the band, ` +
      `and not in any collapsed group's flyout (collapsed: ${collapsed.join(", ") || "none"}; ` +
      `default group: ${hint ?? "unknown"})`,
  );
}

/** Click a Home control wherever it is (see `homeControl`). */
export async function clickHomeControl(page: Page, testId: string): Promise<void> {
  await (await homeControl(page, testId)).click();
}

/**
 * Open the menu a Home control opens (a menu button, or a split's `-options`
 * chevron) and return the row with `rowTestId`, waiting for it to be visible.
 * Rows are body portals, so they are looked up page-wide.
 */
export async function homeMenuRow(page: Page, triggerTestId: string, rowTestId: string): Promise<Locator> {
  const trigger = await homeControl(page, triggerTestId);
  const row = byTestId(page, rowTestId).filter({ visible: true }).first();
  // Click only when the row is not already showing: a second click on an open
  // menu's trigger closes it.
  if ((await row.count()) === 0) await trigger.click();
  await row.waitFor({ state: "visible", timeout: 5_000 });
  return row;
}

/** Open a Home menu and click one of its rows. */
export async function clickHomeMenuRow(page: Page, triggerTestId: string, rowTestId: string): Promise<void> {
  await (await homeMenuRow(page, triggerTestId, rowTestId)).click();
}

/** The band's own Home section cells, as laid out: caption + whether collapsed. */
export async function readHomeSectionCells(
  page: Page,
): Promise<Array<{ label: string; collapsed: boolean; launcherTestId: string | null }>> {
  await ensureHomeTab(page);
  return ribbonBand(page).evaluate((band) =>
    Array.from(band.querySelectorAll("[data-section-cell]")).map((cell) => {
      const launcher = cell.querySelector('[data-testid^="section-launcher-"]');
      return {
        label: cell.lastElementChild?.textContent?.trim() ?? "",
        collapsed: launcher !== null,
        launcherTestId: launcher?.getAttribute("data-testid") ?? null,
      };
    }),
  );
}
