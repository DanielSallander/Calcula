/**
 * Plumbing for the ONE object pane (WP-C D-PANE) and its Format tab (D-FORMAT),
 * for `journeys/object-pane-format.spec.ts` and for every journey that must
 * keep the pane out of its way.
 *
 * WHAT THE PANE IS. Selecting an object on a CANVAS page opens one task pane
 * ("object-pane") at the RELEASE of a press that did not move: the family's
 * build tabs (Fields / Design for a model object, Data for a range chart,
 * Settings / Properties for the rest) plus a Power BI Format tab whose General
 * section holds the Properties, Title, Effects and Data format cards. Doors
 * (Ctrl+1, a family's "Format..." row, View > Panels > Show Object pane) open
 * it anywhere, also after the reader closed it by hand.
 *
 * THE LEAKED-PANE RULE (memory note "a leaked task pane narrows the grid for
 * LATER specs"). The fixture's per-test `useTaskPaneStore.reset()`
 * (fixtures.ts) CLEARS `manuallyClosed`, so a journey that does not want the
 * auto-open pane must say so in a `test.beforeEach` -- which Playwright runs
 * AFTER the fixture -- through `closeObjectPaneForGood`: the user-equivalent
 * state "the reader closed the pane by hand" (a press then never opens it;
 * a door still does).
 *
 * TAB MEMORY. The pane remembers, per region type and in localStorage, the
 * build tab and the Format section the reader last PICKED in its strips
 * (BuiltIn/ObjectPane/lib/tabMemory.ts). That memory outlives the journey and
 * the app run, so a journey that clicks tabs must put it back
 * (`restoreObjectPaneMemory`): otherwise the next run of a journey that waits
 * for a Properties pane after a press finds the Format tab instead.
 *
 * Everything here drives or reads the RUNNING app through its own modules (the
 * instance the app loaded, through canvas-live's `__appImport`) and the
 * backend. Nothing in here asserts; the spec decides.
 */
import type { Locator, Page } from "@playwright/test";
import { readGridGeometry } from "./grid";
import { MOD, bounded, callModule, eventually, humanClick, installAppImport, sheetPointToPage, type AppWindow } from "./canvas-live";
import { connectAdventureWorks, type AwConnection } from "./adventureworks-live";
import type { PixelClip, PixelSample } from "../viewportSample";

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export const PANE_MOD = {
  OBJECT_PANE: "/src/api/objectPane.ts",
  UI: "/src/api/ui.ts",
  KEYBINDINGS: "/src/api/keybindings.ts",
  VISUAL_CONTAINER_PAINT: "/src/api/visualContainerPaint.ts",
  OBJECT_GEOMETRY: "/src/api/objectGeometry.ts",
  OBJECT_BINDINGS: "/src/api/objectBindings/index.ts",
  GRID_OVERLAYS: "/src/api/gridOverlays.ts",
  TAB_MEMORY: "/extensions/BuiltIn/ObjectPane/lib/tabMemory.ts",
  DESIGN_QUERY_READER: "/extensions/Charts/lib/designQueryChartDataReader.ts",
} as const;

/** `OBJECT_PANE_ID`, app/src/api/objectPane.ts. */
export const OBJECT_PANE_ID = "object-pane";

/** `PIVOT_PANE_ID`, app/extensions/Pivot/manifest.ts (the worksheet pivot's own pane). */
export const PIVOT_EDITOR_PANE_ID = "pivot-editor";

/** The region types each family publishes (their stores' `syncXRegions`). */
export const REGION_TYPE = {
  chart: "chart",
  pivot: "pivot-visual",
  slicer: "slicer",
  timeline: "timeline-slicer",
  floatingRange: "floating-range",
  control: "floating-control",
} as const;

/** Each region type's first build tab (what a press lands on with no memory). */
export const FIRST_BUILD_TAB: Readonly<Record<string, string>> = {
  [REGION_TYPE.chart]: "fields",
  [REGION_TYPE.pivot]: "fields",
  [REGION_TYPE.slicer]: "settings",
  [REGION_TYPE.timeline]: "settings",
  [REGION_TYPE.floatingRange]: "properties",
  [REGION_TYPE.control]: "properties",
};

// ---------------------------------------------------------------------------
// The pane's state
// ---------------------------------------------------------------------------

/** What the pane shows (@api/objectPane `getObjectPaneState`). */
export interface PaneState {
  open: boolean;
  regionId: string | null;
  regionType: string | null;
  tabId: string | null;
}

export async function paneState(page: Page): Promise<PaneState> {
  return callModule<PaneState>(page, PANE_MOD.OBJECT_PANE, "getObjectPaneState");
}

/** Wait until the pane state satisfies `ok` (a press opens one task AFTER the mouseup). */
export async function waitPane(page: Page, ok: (s: PaneState) => boolean, label: string, timeoutMs = 8000): Promise<PaneState> {
  return eventually(() => paneState(page), ok, label, timeoutMs);
}

/**
 * Assert-free check that the pane stays CLOSED for `ms` (a decision is deferred
 * one task after the mouseup; reading at once would prove nothing). Returns the
 * first open state seen, or null when it stayed closed.
 */
export async function paneOpenedWithin(page: Page, ms = 700): Promise<PaneState | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await paneState(page);
    if (s.open) return s;
    await page.waitForTimeout(100);
  }
  return null;
}

/** The view ids of every open task pane, from the Shell (empty while the container is hidden). */
export async function openTaskPaneIds(page: Page): Promise<string[]> {
  const open = await callModule<boolean>(page, PANE_MOD.UI, "isTaskPaneContainerOpen");
  if (!open) return [];
  return callModule<string[]>(page, PANE_MOD.UI, "getOpenTaskPaneIds");
}

export async function manuallyClosedPanes(page: Page): Promise<string[]> {
  return callModule<string[]>(page, PANE_MOD.UI, "getTaskPaneManuallyClosed");
}

/** The pane's root element (`ObjectPaneView`). */
export function paneRoot(page: Page): Locator {
  return page.locator('[data-testid="object-pane"]');
}

/** The tab strip's labels, left to right ("Fields", "Design", "Format"). */
export async function paneTabs(page: Page): Promise<string[]> {
  const tabs = page.locator('[data-testid="object-pane-tabs"] [role="tab"]');
  return tabs.evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
}

/** Pick a tab in the pane's strip by its id ("fields", "format", ...) and wait for it. */
export async function openPaneTab(page: Page, tabId: string): Promise<void> {
  const tab = page.locator(`[data-testid="object-pane-tab-${tabId}"]`);
  await tab.waitFor({ state: "visible", timeout: 8000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await eventually(() => paneState(page), (s) => s.open && s.tabId === tabId, `the object pane did not switch to its "${tabId}" tab`);
  await page.waitForTimeout(150);
}

/**
 * The Format tab on the requested half: Visual (the family's own cards) or
 * General (Properties / Title / Effects / Data format). A family with no visual
 * cards has no switch and shows General.
 */
export async function showFormatSection(page: Page, section: "visual" | "general"): Promise<void> {
  const root = page.locator('[data-testid="object-pane-format"]');
  await root.waitFor({ state: "visible", timeout: 8000 });
  const switcher = page.locator('[data-testid="object-pane-format-sections"]');
  if ((await switcher.count()) === 0) {
    if (section === "visual") throw new Error("showFormatSection: this object's Format tab has no Visual section");
    return;
  }
  const tab = page.locator(`[data-testid="object-pane-format-${section}"]`);
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await eventually(() => root.getAttribute("data-format-section"), (v) => v === section, `the Format tab did not show its ${section} section`);
}

/**
 * When a door just opened the object pane on Format, make sure its VISUAL
 * section shows (a chart's "Chart elements" card, `chart-format-pane`, lives
 * there): the section a reader last picked is remembered per object type, so
 * an earlier General pick would hide the card. A no-op when no Format tab with
 * a section switch appears within `waitMs`.
 */
export async function showVisualSectionIfPresent(page: Page, waitMs = 3000): Promise<void> {
  const switcher = page.locator('[data-testid="object-pane-format-sections"]');
  const shown = await switcher
    .first()
    .waitFor({ state: "visible", timeout: waitMs })
    .then(
      () => true,
      () => false,
    );
  if (!shown) return;
  const tab = page.locator('[data-testid="object-pane-format-visual"]');
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

/**
 * After a press that should show a floating control's Properties: when the
 * object pane opened (WP-C hosts the control's Properties pane in its
 * Properties tab), make sure that tab is the one shown -- the tab a reader last
 * picked is remembered per object type, so an earlier Format pick would hide
 * the Properties rows. A no-op when no object pane appears within `waitMs`.
 */
export async function showPropertiesTabIfPresent(page: Page, waitMs = 3000): Promise<void> {
  const tab = page.locator('[data-testid="object-pane-tab-properties"]');
  const shown = await tab
    .first()
    .waitFor({ state: "visible", timeout: waitMs })
    .then(
      () => true,
      () => false,
    );
  if (!shown) return;
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

/** The pane on Format, on one section. */
export async function openFormat(page: Page, section: "visual" | "general" = "general"): Promise<void> {
  await openPaneTab(page, "format");
  await showFormatSection(page, section);
}

/** One row of a Format card (`[data-format-card] [data-field-id]`, S6). */
export function formatRow(page: Page, cardId: string, fieldId: string): Locator {
  return page.locator(`[data-format-card="${cardId}"] [data-field-id="${fieldId}"]`);
}

/** A Format field's literal editor (`data-testid="format-<fieldId>"`). */
export function formatInput(page: Page, fieldId: string): Locator {
  return page.locator(`[data-testid="format-${fieldId}"]`);
}

/** Make sure a Format card is expanded (its header toggles it). */
export async function expandFormatCard(page: Page, cardId: string): Promise<void> {
  const header = page.locator(`[data-format-card-header="${cardId}"]`);
  await header.waitFor({ state: "visible", timeout: 8000 });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
}

/** Type a number into a Format number row and commit it with Enter (ONE commit). */
export async function commitFormatNumber(page: Page, fieldId: string, value: number): Promise<void> {
  const input = formatInput(page, fieldId);
  await input.waitFor({ state: "visible", timeout: 8000 });
  await input.click();
  await input.fill(String(value));
  await input.press("Enter");
  await page.waitForTimeout(250);
}

/** Type a hex code into a Format colour row's code box and commit it with Enter. */
export async function commitFormatHex(page: Page, fieldId: string, hex: string): Promise<void> {
  const input = formatInput(page, `${fieldId}-hex`);
  await input.waitFor({ state: "visible", timeout: 8000 });
  await input.click();
  await input.fill(hex);
  await input.press("Enter");
  await page.waitForTimeout(250);
}

/** Type text into a Format text row and commit it with Enter. */
export async function commitFormatText(page: Page, fieldId: string, text: string): Promise<void> {
  const input = formatInput(page, fieldId);
  await input.waitFor({ state: "visible", timeout: 8000 });
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  await page.waitForTimeout(250);
}

/** Set a Format on/off row. Returns whether it clicked (false = it already was `on`). */
export async function setFormatToggle(page: Page, fieldId: string, on: boolean): Promise<boolean> {
  const box = formatInput(page, fieldId);
  await box.waitFor({ state: "visible", timeout: 8000 });
  if ((await box.isChecked()) === on) return false;
  await box.click();
  await page.waitForTimeout(250);
  return true;
}

/** Pick a value of a Format choice row (commits at once). */
export async function selectFormat(page: Page, fieldId: string, value: string): Promise<void> {
  const select = formatInput(page, fieldId);
  await select.waitFor({ state: "visible", timeout: 8000 });
  await select.selectOption(value);
  await page.waitForTimeout(250);
}

/**
 * Set a Format slider (transparency) to its MIDDLE value with one real pointer
 * click at the centre of its track: a range input maps its centre to the middle
 * of [min, max] whatever its thumb's width, and the slider commits ONCE at the
 * pointer's release (a keyboard walk would commit once per key).
 */
export async function clickSliderMiddle(page: Page, fieldId: string): Promise<number> {
  const slider = formatInput(page, fieldId);
  await slider.waitFor({ state: "visible", timeout: 8000 });
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  if (!box) throw new Error(`the ${fieldId} slider has no box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(300);
  return Number(await slider.inputValue());
}

/**
 * Bind a Format row through WP-D's fx (`BindableField`): switch fx on, type the
 * formula in the user's locale, close any suggestion list, commit with Enter,
 * and wait until the field says it is bound.
 */
export async function bindFormatField(page: Page, cardId: string, fieldId: string, pointer: string, formula: string): Promise<void> {
  const row = formatRow(page, cardId, fieldId);
  await row.waitFor({ state: "visible", timeout: 10_000 });
  const field = row.locator(`[data-bindable-field="${pointer}"]`);
  if ((await field.count()) === 0) {
    throw new Error(`the Format row ${cardId}/${fieldId} offers no fx at ${pointer} (data-bindable=${await row.getAttribute("data-bindable")})`);
  }
  if ((await field.getAttribute("data-bound")) !== "true" || (await field.locator("[data-binding-formula-input]").count()) === 0) {
    await field.locator("[data-bindable-fx]").first().click();
  }
  const input = field.locator("[data-binding-formula-input]");
  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.click();
  await input.fill(formula);
  await page.waitForTimeout(400);
  const dropdown = page.locator('[data-testid="formula-autocomplete"]');
  for (let i = 0; i < 3 && (await dropdown.isVisible().catch(() => false)); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
  await page.keyboard.press("Enter");
  await eventually(() => field.getAttribute("data-bound"), (v) => v === "true", `the ${fieldId} row did not become bound to ${formula}`, 15_000);
}

/** "Remove binding" on a bound Format row. */
export async function removeFormatBinding(page: Page, cardId: string, fieldId: string, pointer: string): Promise<void> {
  const field = formatRow(page, cardId, fieldId).locator(`[data-bindable-field="${pointer}"]`);
  await field.locator("[data-bindable-remove]").first().click();
  await eventually(() => field.getAttribute("data-bound"), (v) => v === "false", `"Remove binding" left ${fieldId} bound`, 15_000);
}

// ---------------------------------------------------------------------------
// Keeping the pane out of the way (other journeys)
// ---------------------------------------------------------------------------

/**
 * Close the object pane AS IF BY HAND -- `markTaskPaneManuallyClosed` then
 * `closeTaskPane` -- and prove it hidden. From then on a press opens nothing
 * (only a door reopens it), so a journey written before the pane existed keeps
 * its full-width grid. Call it from a `test.beforeEach`: the fixture's
 * per-test store reset clears the "closed by hand" mark.
 */
export async function closeObjectPaneForGood(page: Page): Promise<void> {
  await installAppImport(page);
  await callModule(page, PANE_MOD.UI, "markTaskPaneManuallyClosed", [OBJECT_PANE_ID]);
  await callModule(page, PANE_MOD.UI, "closeTaskPane", [OBJECT_PANE_ID]);
  await eventually(
    async () => ({ state: await paneState(page), shown: await openTaskPaneIds(page), marked: await manuallyClosedPanes(page) }),
    (v) => !v.state.open && !v.shown.includes(OBJECT_PANE_ID) && v.marked.includes(OBJECT_PANE_ID),
    "closeObjectPaneForGood: the object pane is still shown (or not marked closed by hand) -- later steps would run against a narrowed grid",
  );
}

/** Close the object pane WITHOUT the hand mark (a press reopens it). Proves it hidden. */
export async function closeObjectPaneQuietly(page: Page): Promise<void> {
  await callModule(page, PANE_MOD.UI, "closeTaskPane", [OBJECT_PANE_ID]);
  await eventually(() => paneState(page), (s) => !s.open, "closeTaskPane left the object pane open");
}

/**
 * Close every task pane through the REAL store -- the appPage fixture's own
 * route (`useTaskPaneStore.reset()`) -- and say what is open afterwards. File >
 * New closes no task pane, so a journey's teardown calls this and asserts
 * `isOpen === false` (memory note "a leaked task pane narrows the grid for
 * LATER specs"). Moved here from calp-inline-buttons.spec.ts (round 2, P1 S8).
 */
export async function closeTaskPanes(page: Page): Promise<{ isOpen: boolean; openPanes: number }> {
  await installAppImport(page);
  return bounded(
    "closeTaskPanes",
    page.evaluate(async (mod) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        useTaskPaneStore: { getState: () => { reset: () => void; isOpen?: boolean; openPanes?: unknown[] } };
      };
      m.useTaskPaneStore.getState().reset();
      const s = m.useTaskPaneStore.getState();
      return { isOpen: Boolean(s.isOpen), openPanes: Array.isArray(s.openPanes) ? s.openPanes.length : -1 };
    }, MOD.TASK_PANE_STORE),
  );
}

/**
 * A floating control's Properties, through its own right-click menu's
 * "Properties..." row (`controls.properties`, an @api/objectPane door): the
 * route that works on a WORKSHEET too, where a press opens no pane (WP-C S13
 * retired the old press opener of `control-properties`). Resolves once the
 * object pane shows the control's Properties tab.
 */
export async function openControlPropertiesFromMenu(page: Page, o: { x: number; y: number; w: number; h: number }): Promise<void> {
  const p = await sheetPointToPage(page, o.x + o.w / 2, o.y + o.h / 2);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button: "right" });
  await page.waitForTimeout(60);
  await page.mouse.up({ button: "right" });
  const row = page.locator('[data-control-menu-item="controls.properties"]');
  await row.waitFor({ state: "visible", timeout: 8000 });
  await row.click();
  await eventually(() => paneState(page), (s) => s.open && s.tabId === "properties", 'the control menu\'s "Properties..." did not open the object pane on Properties');
  await page.locator('[data-testid="object-pane"][data-active-tab="properties"]').waitFor({ state: "visible", timeout: 8000 });
}

/**
 * Put the pane's remembered tabs and Format sections back to what a reader
 * with no history gets: each type's first build tab, and Format's Visual
 * section (`restoreObjectPaneMemory`). The memory is localStorage-backed, so
 * this matters to the NEXT run of every journey that waits for a build tab.
 */
export async function restoreObjectPaneMemory(page: Page, types: readonly string[] = Object.keys(FIRST_BUILD_TAB)): Promise<void> {
  for (const type of types) {
    const tab = FIRST_BUILD_TAB[type];
    if (tab) await callModule(page, PANE_MOD.TAB_MEMORY, "rememberTab", [type, tab]).catch(() => undefined);
    await callModule(page, PANE_MOD.TAB_MEMORY, "rememberFormatSection", [type, "visual"]).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Regions, geometry, focus
// ---------------------------------------------------------------------------

export interface LiveRegion {
  id: string;
  type: string;
  floating: { x: number; y: number; width: number; height: number };
  data: Record<string, unknown>;
  hasContainer: boolean;
}

/** Every floating region published for the ACTIVE sheet (with whether it carries a container). */
export async function liveRegions(page: Page): Promise<LiveRegion[]> {
  await installAppImport(page);
  return bounded(
    "liveRegions",
    page.evaluate(async (mod) => {
      const g = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        getGridRegions: () => Array<{ id: string; type: string; floating?: { x: number; y: number; width: number; height: number }; data?: Record<string, unknown>; container?: unknown }>;
      };
      return g
        .getGridRegions()
        .filter((r) => !!r.floating)
        .map((r) => ({
          id: r.id,
          type: r.type,
          floating: { x: r.floating!.x, y: r.floating!.y, width: r.floating!.width, height: r.floating!.height },
          data: JSON.parse(JSON.stringify(r.data ?? {})) as Record<string, unknown>,
          hasContainer: r.container !== undefined && r.container !== null,
        }));
    }, PANE_MOD.GRID_OVERLAYS),
  );
}

/** The live region that satisfies `pick` (waits for it to be published). */
export async function regionWhere(page: Page, pick: (r: LiveRegion) => boolean, label: string, timeoutMs = 15_000): Promise<LiveRegion> {
  const all = await eventually(() => liveRegions(page), (rs) => rs.some(pick), `${label} was never published on the active page`, timeoutMs);
  return all.find(pick)!;
}

/**
 * A hand's click at a point inside a region (sheet offsets from its top-left;
 * default 24,24 -- the frame/title band of a chart, never a datum). Moved here
 * from object-pane-format.spec.ts (round 2, P1 S8).
 */
export async function clickRegion(page: Page, r: LiveRegion, at: { dx: number; dy: number } = { dx: 24, dy: 24 }): Promise<void> {
  const p = await sheetPointToPage(page, r.floating.x + at.dx, r.floating.y + at.dy);
  await humanClick(page, p.x, p.y);
  await page.waitForTimeout(250);
}

/** Core's content rect of a live region (sheet px): what the family lays out and hit-tests inside. */
export async function contentRectOf(page: Page, regionId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  await installAppImport(page);
  return bounded(
    "contentRectOf",
    page.evaluate(
      async ({ ov, vcp, id }) => {
        const w = window as unknown as AppWindow;
        const g = (await w.__appImport!(ov)) as { getGridRegions: () => Array<{ id: string }> };
        const p = (await w.__appImport!(vcp)) as { visualContentRect: (r: unknown) => { x: number; y: number; width: number; height: number } };
        const region = g.getGridRegions().find((r) => r.id === id);
        if (!region) throw new Error(`no region ${id} is published`);
        const r = p.visualContentRect(region);
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      },
      { ov: PANE_MOD.GRID_OVERLAYS, vcp: PANE_MOD.VISUAL_CONTAINER_PAINT, id: regionId },
    ),
  );
}

/**
 * Move (and size) an object through the product's geometry seam
 * (@api/objectGeometry `commitObjectGeometry`, the Size and Position route):
 * ONE undoable "Size and Position" step.
 */
export async function placeRegion(page: Page, regionId: string, rect: { x: number; y: number; width?: number; height?: number }): Promise<void> {
  await installAppImport(page);
  const out = await bounded(
    "placeRegion",
    page.evaluate(
      async ({ ov, geo, id, rect }) => {
        const w = window as unknown as AppWindow;
        const g = (await w.__appImport!(ov)) as { getGridRegions: () => Array<{ id: string; floating?: { x: number; y: number; width: number; height: number } }> };
        const m = (await w.__appImport!(geo)) as {
          commitObjectGeometry: (changes: unknown[], label: string) => Promise<{ committed: number; refused: number; skipped: number }>;
        };
        const region = g.getGridRegions().find((r) => r.id === id);
        if (!region?.floating) return { error: `no floating region ${id}` };
        return m.commitObjectGeometry(
          [{ region, x: rect.x, y: rect.y, width: rect.width ?? region.floating.width, height: rect.height ?? region.floating.height }],
          "Size and Position",
        );
      },
      { ov: PANE_MOD.GRID_OVERLAYS, geo: PANE_MOD.OBJECT_GEOMETRY, id: regionId, rect },
    ),
  );
  if ("error" in out) throw new Error(`placeRegion: ${out.error}`);
  if (out.committed !== 1) throw new Error(`placeRegion: the geometry seam did not commit the move of ${regionId}: ${JSON.stringify(out)}`);
  await page.waitForTimeout(300);
}

/** Whether the grid has the keyboard (@api/keybindings `isGridFocused`, what every Delete door asks). */
export async function isGridFocused(page: Page): Promise<boolean> {
  return callModule<boolean>(page, PANE_MOD.KEYBINDINGS, "isGridFocused");
}

/** Whether the DOM focus is inside the spreadsheet's focus container. */
export async function focusInsideGrid(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const a = document.activeElement;
    return !!a && !!a.closest('[data-focus-container="spreadsheet"]');
  });
}

/**
 * The field names a pivot editor shows in one of its wells ("Rows", "Values"...),
 * read from the DOM under `rootTestId` (the lifted editor is
 * `canvas-pivot-build`). A well is the DropZone whose title div reads `title`;
 * its pills carry their display name in `span[title]`.
 */
export async function wellFieldNames(page: Page, rootTestId: string, title: string): Promise<string[] | null> {
  return page.evaluate(
    ({ rootTestId, title }) => {
      const root = document.querySelector(`[data-testid="${rootTestId}"]`);
      if (!root) return null;
      const titles = Array.from(root.querySelectorAll("div")).filter(
        (d) => d.children.length === 0 && (d.textContent ?? "").trim() === title && (d.parentElement?.children.length ?? 0) >= 2,
      );
      for (const t of titles) {
        const content = t.parentElement!.children[1];
        if (!content) continue;
        return Array.from(content.querySelectorAll("span[title]")).map((s) => s.getAttribute("title") ?? "");
      }
      return null;
    },
    { rootTestId, title },
  );
}

/** The centre (client px) of one well of an editor under `rootTestId`, or null. */
export async function wellCentre(page: Page, rootTestId: string, title: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ({ rootTestId, title }) => {
      const root = document.querySelector(`[data-testid="${rootTestId}"]`);
      if (!root) return null;
      const t = Array.from(root.querySelectorAll("div")).find(
        (d) => d.children.length === 0 && (d.textContent ?? "").trim() === title && (d.parentElement?.children.length ?? 0) >= 2,
      );
      if (!t) return null;
      const r = t.parentElement!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    { rootTestId, title },
  );
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** What the chart reader computes for a design query (categories, series, display texts). */
export interface DesignQueryData {
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  displayValues?: string[][];
}

/**
 * Run a design query the way a chart reads it (`readDesignQueryData`: the DSL
 * compiled against the connection's model, `run_design_query`), for a source
 * no stored chart holds -- so no page filter and no chart's data format applies.
 * Every expected number in the journey comes from here, never typed in.
 */
export async function designQueryData(page: Page, connectionId: string, dslText: string): Promise<DesignQueryData> {
  await installAppImport(page);
  return bounded(
    "designQueryData",
    page.evaluate(
      async ({ mod, connectionId, dslText }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          readDesignQueryData: (source: unknown, ctx?: unknown) => Promise<DesignQueryData>;
        };
        const d = await m.readDesignQueryData({ type: "designQuery", dslText, connectionId }, { fieldFormats: {} });
        return { categories: d.categories, series: d.series.map((s) => ({ name: s.name, values: s.values })), displayValues: d.displayValues };
      },
      { mod: PANE_MOD.DESIGN_QUERY_READER, connectionId, dslText },
    ),
    120_000,
  );
}

/** The one value of a measure-only design query (a Card's number). */
export async function expectedMeasure(page: Page, connectionId: string, dslText: string): Promise<number> {
  const d = await designQueryData(page, connectionId, dslText);
  const v = d.series[0]?.values[0];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`the model answered no number for "${dslText}": ${JSON.stringify(d).slice(0, 400)}`);
  return v;
}

/** A measure per member of the query's ROWS (category -> value). */
export async function expectedByCategory(page: Page, connectionId: string, dslText: string): Promise<Record<string, number>> {
  const d = await designQueryData(page, connectionId, dslText);
  const out: Record<string, number> = {};
  d.categories.forEach((c, i) => {
    out[c] = d.series[0]?.values[i] ?? Number.NaN;
  });
  return out;
}

/**
 * The owner's AdventureWorks connection (helpers/adventureworks-live.ts) plus a
 * PROBE through the chart's own route: an unreachable server is a HARD failure
 * that names host, port and credentials -- never a skip.
 */
export async function connectAdventureWorksProbed(page: Page, name: string): Promise<{ conn: AwConnection; total: number }> {
  let conn: AwConnection;
  try {
    conn = await connectAdventureWorks(page, name);
  } catch (e) {
    throw new Error(`AdventureWorks is not reachable at localhost:5432 (postgres/postgres): ${String(e).slice(0, 500)}`);
  }
  try {
    const total = await expectedMeasure(page, conn.connectionId, "VALUES: [Revenue]");
    return { conn, total };
  } catch (e) {
    throw new Error(`AdventureWorks is not reachable at localhost:5432 (postgres/postgres): ${String(e).slice(0, 500)}`);
  }
}

// ---------------------------------------------------------------------------
// Instruments: what was painted
// ---------------------------------------------------------------------------

/**
 * Record every string a 2D context writes from now on WITH the fill colour it
 * was written in (on- and off-screen canvases). Separate from chart-paint.ts's
 * text-only recorder (its own flag), so both can be installed at once.
 */
export async function startStyledTextRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eStyledTexts?: Array<{ text: string; fill: string }> };
    w.__e2eStyledTexts = [];
    type Proto = { fillText: (...a: unknown[]) => void; __e2eStyleWrapped?: boolean };
    const protos: Array<Proto | null> = [
      CanvasRenderingContext2D.prototype as unknown as Proto,
      typeof OffscreenCanvasRenderingContext2D !== "undefined" ? (OffscreenCanvasRenderingContext2D.prototype as unknown as Proto) : null,
    ];
    for (const p of protos) {
      if (!p || p.__e2eStyleWrapped) continue;
      const original = p.fillText;
      p.fillText = function (this: { fillStyle?: unknown }, ...args: unknown[]) {
        const list = (window as unknown as { __e2eStyledTexts?: Array<{ text: string; fill: string }> }).__e2eStyledTexts;
        if (list) {
          list.push({ text: String(args[0]), fill: String(this.fillStyle ?? "").toLowerCase() });
          if (list.length > 20_000) list.splice(0, 10_000);
        }
        return original.apply(this, args);
      };
      p.__e2eStyleWrapped = true;
    }
  });
}

export async function recordedStyledTexts(page: Page): Promise<Array<{ text: string; fill: string }>> {
  return page.evaluate(() => [...((window as unknown as { __e2eStyledTexts?: Array<{ text: string; fill: string }> }).__e2eStyledTexts ?? [])]);
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

/** A PAGE clip of a rectangle given in SHEET px of the active sheet. */
export async function sheetClip(page: Page, sx: number, sy: number, sw: number, sh: number): Promise<PixelClip> {
  const geo = await readGridGeometry(page);
  const tl = await sheetPointToPage(page, sx, sy);
  return { x: tl.x, y: tl.y, width: Math.max(1, sw * geo.zoom), height: Math.max(1, sh * geo.zoom) };
}

/** The average colour of a sample. */
export function averageRgb(s: PixelSample | number[]): [number, number, number] {
  const d = Array.isArray(s) ? s : s.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    n++;
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

/** The average luminance (0..255) of a sample. */
export function luminance(s: PixelSample | number[]): number {
  const [r, g, b] = averageRgb(s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Which of `candidates` (name -> #rrggbb) the colour is nearest to (sum of channel distances). */
export function nearestColour(rgb: [number, number, number], candidates: Record<string, string>): { name: string; distance: number } {
  let best = { name: "", distance: Number.POSITIVE_INFINITY };
  for (const [name, hex] of Object.entries(candidates)) {
    const c = hexRgb(hex);
    const d = Math.abs(rgb[0] - c[0]) + Math.abs(rgb[1] - c[1]) + Math.abs(rgb[2] - c[2]);
    if (d < best.distance) best = { name, distance: d };
  }
  return best;
}
