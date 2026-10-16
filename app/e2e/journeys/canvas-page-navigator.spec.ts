/**
 * THE PAGE NAVIGATOR IS ONE LIVE OBJECT, THROUGH THE REAL UI (WP-B, D-NAV, 2026-10-15).
 *
 * Owner finding F2: Buttons > Page Navigator used to insert one ordinary
 * navigate button per canvas -- a snapshot of the page list at insert time, N
 * objects to move, nothing for a page added later. It is now ONE control of
 * type `pageNavigator` whose items are DERIVED live from @api/reportPages
 * (canvases in tab order; hidden and Tooltip pages left out unless the
 * navigator's own toggles say otherwise), with container properties and
 * per-button overrides (`pageOverrides`, matched by sheet id), the current
 * page decided by sheet id, a Design-Mode ladder (first press = the whole
 * navigator, a second press = one button), and a pull that remaps page
 * targets to the subscriber's sheet ids (BUG-0449). Every lane proved its part
 * in jsdom with the backend doubled; this journey drives each one against the
 * REAL backend, the real tab strip and the real Properties pane.
 *
 * WHAT IS ASSERTED. Backend control metadata (`get_all_controls`: the stored
 * properties -- the item list is never among them), the description the
 * painter itself reads (`describePageNavigator`, PageNavigator/describe.ts:
 * items, captions, current / selected / hidden flags and where each item
 * sits), what the painters actually WROTE (a `fillText` recorder installed in
 * the page before the paint), the active sheet (backend AND grid), toasts, the
 * Properties pane's DOM (header, sections, rows, aria-expanded), the open task
 * panes (the real store), and RELATIVE pixel samples through
 * e2e/viewportSample.ts (a patch compared with itself before and after, and
 * with an untouched twin, so a sample proves change in both directions).
 * Never a golden: the goldens are stale by owner decision and this display is
 * DPR 2.
 *
 * LOCALE. sv-SE. Nothing here types a formula or a decimal number, so the
 * separator question does not arise; property values go through
 * set_control_property as the strings the Properties pane writes.
 *
 * MODEL FIXTURE. The owner's AdventureWorks model
 * (C:\Dropbox\Projekt\Calcula\context_manager\model.json, a `{ formatVersion,
 * model }` bundle) against Postgres at localhost:5432 (postgres/postgres). A
 * measure-only Card (`VALUES: [Revenue]`) sits on the first page so the pages
 * are real report pages with a live visual, not empty canvases. An unreachable
 * server FAILS the journey (never a skip): a proof that quietly ran without its
 * fixture is not a proof.
 *
 * SHAPE. One serial journey over one workbook (N1..N10 build on each other),
 * then save/reopen (N11) and the collaboration round trip (N12) on fresh
 * workbooks. Each step is its own `test`, so a failure names its step.
 *
 * DELIBERATE DEPARTURES FROM THE SPEC TEXT (each verified against the code):
 *   - N9: deleting a sheet ENDS the undo history (BUG-0005, Excel parity;
 *     app/src-tauri/src/sheets.rs, app/src/shell/SheetTabs/sheetDeletePolicy.ts),
 *     so "Ctrl+Z brings the item back" cannot happen. N9 asserts the history
 *     ended and that Ctrl+Z brings back no ghost item instead.
 *   - N5: the Properties pane's Destination lists only OTHER pages
 *     (ButtonActionSection.tsx), so a navigate button aimed at its own page is
 *     made through the seam (@api/buttonControlService createButton with an
 *     `action`), the route the old per-page navigator used.
 *   - N11: the fixture's Card is a chart, and charts stamp their own format
 *     version (WP-D, R8), so "formatVersion 9" is proved as what it means --
 *     the navigator raises no version: the same workbook saved with and without
 *     the navigator carries the same version, and only the first lists the
 *     `page_navigator` feature id.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync } from "fflate";
import { test, expect } from "../fixtures";
import {
  MOD,
  addCanvas,
  bounded,
  callModule,
  clickCanvasControl,
  clickCanvasMenuRow,
  clickEmpty,
  clickSheetTab,
  closeCanvasFlyouts,
  createChart,
  createShape,
  dismissToasts,
  dragObject,
  eventually,
  freeCanvasRect,
  gridKey,
  humanClick,
  installAppImport,
  invoke,
  newFile,
  openFileAtPath,
  patchActiveCanvas,
  selectedObjects,
  sheetPointToPage,
  sheetsResult,
  startToasts,
  toasts,
  undoState,
  type AppWindow,
  type SheetRow,
} from "../helpers/canvas-live";
import { openAt, renameSheetByName } from "../helpers/calp-harness";
import { checkout, publishNew, push, refreshApply, refreshPreview, subscribe } from "../helpers/calp-collab";
import { samplePixelGrids, diffCount, type PixelClip } from "../viewportSample";
import { showPropertiesTabIfPresent } from "../helpers/object-pane";

const RUN = Date.now().toString(36);
const MODEL_FILE = "C:\\Dropbox\\Projekt\\Calcula\\context_manager\\model.json";
const MODEL_SOURCE_ID = "Adventureworks";
const MODEL_URL = "postgresql://postgres:postgres@localhost:5432/Adventureworks";
const CONNECTION_NAME = "AdventureWorks (nav)";
const WORK = path.join(os.tmpdir(), `calcula-page-navigator-${RUN}`);

/** `PROPERTIES_PANE_ID`, app/extensions/Controls/index.ts. */
const CONTROL_PROPERTIES_PANE = "control-properties";
/** WP-C's object pane (D-PANE); asserted closed too, whether or not it has landed. */
const OBJECT_PANE = "object-pane";
/** `DESIGN_MODE_MENU_ITEM_ID`, app/extensions/Controls/index.ts. */
const DESIGN_MODE_MENU_ITEM = "developer:designMode";
/** buttonActions.ts: the sentence a press on a hidden page's item says. */
const HIDDEN_PAGE_TOAST = "is hidden, so the button cannot open it.";

// ---------------------------------------------------------------------------
// Shapes read back from the app
// ---------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NavItem {
  key: string;
  sheetId: string;
  sheetName: string;
  index: number;
  caption: string;
  hiddenPage: boolean;
  tooltipPage: boolean;
  current: boolean;
  pressed: boolean;
  selected: boolean;
  rect: Rect;
}

interface NavDescription {
  controlId: string;
  box: Rect;
  props: Record<string, unknown>;
  items: NavItem[];
}

type ControlProps = Record<string, { valueType?: string; value: string }>;

interface ControlRecord {
  row: number;
  col: number;
  type: string;
  props: ControlProps;
}

interface NavHandle {
  sheetIndex: number;
  row: number;
  col: number;
  controlId: string;
  props: ControlProps;
}

type Sheet = SheetRow & { visibility?: string };

// ---------------------------------------------------------------------------
// The journey's pages (filled by the fixture; ids never change, indices do)
// ---------------------------------------------------------------------------

let connectionId = "";
let A: Sheet;
let B: Sheet;
let C: Sheet;
let D: Sheet;
/** The navigator's stored metadata after N1, canonical form (N2 / N7 compare against it). */
let navRecord = "";

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/**
 * Record every string a 2D context WRITES from now on (on- and off-screen
 * canvases); copied from canvas-powerbi.spec.ts, where it is local. What it
 * sees is what the painter wrote, which is what the reader reads.
 */
async function startTextRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eTexts?: string[] };
    w.__e2eTexts = [];
    const protos: Array<{ fillText: (...a: unknown[]) => void; __e2eWrapped?: boolean } | null> = [
      CanvasRenderingContext2D.prototype as unknown as { fillText: (...a: unknown[]) => void; __e2eWrapped?: boolean },
      typeof OffscreenCanvasRenderingContext2D !== "undefined"
        ? (OffscreenCanvasRenderingContext2D.prototype as unknown as { fillText: (...a: unknown[]) => void; __e2eWrapped?: boolean })
        : null,
    ];
    for (const p of protos) {
      if (!p || p.__e2eWrapped) continue;
      const original = p.fillText;
      p.fillText = function (this: unknown, ...args: unknown[]) {
        const list = (window as unknown as { __e2eTexts?: string[] }).__e2eTexts;
        if (list) {
          list.push(String(args[0]));
          if (list.length > 20_000) list.splice(0, 10_000);
        }
        return original.apply(this, args);
      };
      p.__e2eWrapped = true;
    }
  });
}

async function recordedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as unknown as { __e2eTexts?: string[] }).__e2eTexts ?? [])]);
}

/** A stable serialisation (sorted keys), so "byte-identical" does not depend on map order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** A slow backend call (model create / connect), bounded at 180 s. */
async function invokeSlow<T = unknown>(page: Page, cmd: string, args: unknown): Promise<T> {
  return bounded(
    `invoke ${cmd}`,
    page.evaluate(async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a), { c: cmd, a: args }) as Promise<T>,
    180_000,
  );
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

async function sheetById(page: Page, sheetId: string): Promise<Sheet> {
  const s = (await sheetsResult(page)).sheets.find((x) => x.sheetId === sheetId) as Sheet | undefined;
  if (!s) throw new Error(`no sheet with id ${sheetId}`);
  return s;
}

async function sheetByName(page: Page, name: string): Promise<Sheet> {
  const s = (await sheetsResult(page)).sheets.find((x) => x.name === name) as Sheet | undefined;
  if (!s) throw new Error(`no sheet named "${name}" in ${JSON.stringify((await sheetsResult(page)).sheets.map((x) => x.name))}`);
  return s;
}

async function activeIndex(page: Page): Promise<number> {
  return (await sheetsResult(page)).activeIndex;
}

/** The tab strip's click, waited until the backend agrees. */
async function goTo(page: Page, sheetId: string): Promise<number> {
  const s = await sheetById(page, sheetId);
  if ((await activeIndex(page)) !== s.index) {
    await clickSheetTab(page, s.index);
    await eventually(() => activeIndex(page), (i) => i === s.index, `could not switch to "${s.name}"`);
    await page.waitForTimeout(300);
  }
  return s.index;
}

/** The GRID's active sheet (paint-time truth), not the backend's. */
async function gridActiveIndex(page: Page): Promise<number | null> {
  await installAppImport(page);
  return page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
      getGridStateSnapshot: () => { sheetContext?: { activeSheetIndex?: number } } | null;
    };
    return m.getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? null;
  }, MOD.GRID_API);
}

/** Right-click a tab and choose a row of its menu (rows are matched inside the menu only). */
async function tabMenu(page: Page, index: number, label: string): Promise<void> {
  await page.locator(`button[data-sheet-tab="${index}"]`).click({ button: "right" });
  const menu = page
    .locator("div")
    .filter({ has: page.getByText("Unhide Sheet...", { exact: true }) })
    .filter({ has: page.getByText("Tab Color", { exact: true }) })
    .last();
  await menu.waitFor({ state: "visible", timeout: 5000 });
  await menu.locator("button").filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first().click();
  await page.waitForTimeout(400);
}

/** The tab strip's Unhide dialog: pick `name`, press OK. */
async function unhideViaDialog(page: Page, anyVisibleIndex: number, name: string): Promise<void> {
  await tabMenu(page, anyVisibleIndex, "Unhide Sheet...");
  const dialog = page
    .locator("div")
    .filter({ has: page.getByText("Unhide Sheet", { exact: true }) })
    .filter({ has: page.locator("button", { hasText: /^OK$/ }) })
    .last();
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  await dialog.getByText(name, { exact: true }).first().click();
  await dialog.locator("button", { hasText: /^OK$/ }).click();
  await eventually(
    async () => (await sheetsResult(page)).sheets.find((s) => s.name === name) as Sheet | undefined,
    (s) => !!s && (s.visibility ?? "visible") === "visible",
    `the Unhide dialog did not unhide "${name}"`,
  );
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// The navigator
// ---------------------------------------------------------------------------

async function controlsWithProps(page: Page, sheetIndex: number): Promise<ControlRecord[]> {
  const raw = await invoke<Array<{ row: number; col: number; metadata: { controlType: string; properties: ControlProps } }>>(page, "get_all_controls", { sheetIndex });
  return raw.map((c) => ({ row: c.row, col: c.col, type: c.metadata.controlType, props: c.metadata.properties }));
}

const prop = (p: ControlProps, k: string): string => p[k]?.value ?? "";

/** The ONE navigator on a page (throws when there is none or more than one). */
async function navigatorOn(page: Page, sheetId: string): Promise<NavHandle> {
  const s = await sheetById(page, sheetId);
  const navs = (await controlsWithProps(page, s.index)).filter((c) => c.type === "pageNavigator");
  if (navs.length !== 1) throw new Error(`expected one pageNavigator on "${s.name}", found ${navs.length}`);
  const controlId = await callModule<string>(page, MOD.CONTROLS_FLOATING_STORE, "makeFloatingControlId", [s.index, navs[0].row, navs[0].col]);
  return { sheetIndex: s.index, row: navs[0].row, col: navs[0].col, controlId, props: navs[0].props };
}

/** THE description the painter, the zone and the press read (its page must be on screen). */
async function describeNav(page: Page, controlId: string): Promise<NavDescription | null> {
  return callModule<NavDescription | null>(page, MOD.NAV_DESCRIBE, "describePageNavigator", [controlId]);
}

async function waitNav(page: Page, controlId: string, ok: (d: NavDescription) => boolean, label: string, timeoutMs = 8000): Promise<NavDescription> {
  return (await eventually(() => describeNav(page, controlId), (d) => !!d && ok(d), label, timeoutMs))!;
}

const keys = (d: NavDescription): string[] => d.items.map((i) => i.key);
const itemOf = (d: NavDescription, sheetId: string): NavItem | undefined => d.items.find((i) => i.sheetId === sheetId);

/** Press (run mode) or click (Design Mode) the centre of an item, the way a hand does. */
async function clickItem(page: Page, item: NavItem): Promise<void> {
  const at = await sheetPointToPage(page, item.rect.x + item.rect.width / 2, item.rect.y + item.rect.height / 2);
  await humanClick(page, at.x, at.y);
  await page.waitForTimeout(400);
}

async function selectedNavigatorItem(page: Page): Promise<{ controlId: string; itemKey: string } | null> {
  return callModule(page, MOD.NAV_ITEM_SELECTION, "getSelectedNavigatorItem");
}

/** The ids of every grid region published right now (any kind, any mode). */
async function regionIds(page: Page): Promise<string[]> {
  await installAppImport(page);
  return page.evaluate(async (mod) => {
    const g = (await (window as unknown as AppWindow).__appImport!(mod)) as { getGridRegions: () => Array<{ id: string }> };
    return g.getGridRegions().map((r) => r.id);
  }, MOD.GRID_OVERLAYS);
}

/** Park the pointer where nothing is (a hover must never be part of a sample). */
async function parkPointer(page: Page): Promise<void> {
  const spot = await freeCanvasRect(page, { width: 8, height: 8 });
  const at = await sheetPointToPage(page, spot.x + 4, spot.y + 4);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
// Design Mode, panes, the Properties pane
// ---------------------------------------------------------------------------

/** The Developer menu's Design Mode check, as the menu bar renders it. */
async function designModeMenuChecked(page: Page): Promise<boolean | null> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod, id }) => {
      type Item = { id?: string; checked?: boolean; children?: Item[] };
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { getMenus: () => Array<{ items?: Item[] }> };
      const walk = (items: Item[]): boolean | null | undefined => {
        for (const it of items) {
          if (it.id === id) return it.checked ?? null;
          const inner = it.children ? walk(it.children) : undefined;
          if (inner !== undefined) return inner;
        }
        return undefined;
      };
      for (const menu of m.getMenus()) {
        const r = walk(menu.items ?? []);
        if (r !== undefined) return r;
      }
      return null;
    },
    { mod: MOD.UI, id: DESIGN_MODE_MENU_ITEM },
  );
}

/** Design Mode on/off through the flag the Developer menu toggles; waits for the menu's check to follow. */
async function setDesign(page: Page, on: boolean): Promise<void> {
  const now = await callModule<boolean>(page, MOD.DESIGN_MODE, "getDesignMode");
  if (now !== on) await callModule(page, MOD.DESIGN_MODE, "toggleDesignMode");
  await eventually(() => designModeMenuChecked(page), (c) => c === on, `the Developer menu's Design Mode check is not ${on}`);
  await page.waitForTimeout(300);
}

/** The view ids of every open task pane (the real store). */
async function openPaneIds(page: Page): Promise<string[]> {
  await installAppImport(page);
  return page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
      useTaskPaneStore: { getState: () => { isOpen?: boolean; openPanes?: Array<{ viewId: string }> } };
    };
    const s = m.useTaskPaneStore.getState();
    return s.isOpen ? (s.openPanes ?? []).map((p) => p.viewId) : [];
  }, MOD.TASK_PANE_STORE);
}

const PANE_TITLE = "Page navigator Properties";

/** The navigator's Properties pane (Design Mode must be on); clicks the navigator when the pane is not up. */
async function openNavigatorProperties(page: Page, controlId: string) {
  const title = page.getByText(PANE_TITLE, { exact: true });
  if (!(await title.isVisible().catch(() => false))) {
    const d = await waitNav(page, controlId, (x) => x.items.length > 0, "the navigator has no item to click");
    await clickItem(page, d.items[0]);
    // WP-C (D-PANE): the Properties pane is the ONE object pane's Properties
    // tab now, and the tab a reader last picked is remembered per object type.
    await showPropertiesTabIfPresent(page);
    await expect(title, "clicking the navigator in Design Mode did not open its Properties pane").toBeVisible({ timeout: 10_000 });
  }
  return title.locator("xpath=ancestor::div[.//*[@data-testid='nav-buttons-section']][1]");
}

/** Flip a Properties-pane switch row and wait until the backend holds `want`. */
async function setSwitch(page: Page, controlId: string, sheetId: string, key: string, want: boolean): Promise<void> {
  await openNavigatorProperties(page, controlId);
  const row = page.locator(`[data-testid="control-prop-${key}"]`);
  await expect(row, `the Properties pane has no ${key} row`).toBeVisible({ timeout: 5000 });
  const input = row.locator('input[role="switch"]');
  if ((await input.isChecked()) !== want) await row.locator("label").first().click();
  await eventually(
    async () => prop((await navigatorOn(page, sheetId)).props, key),
    (v) => v === String(want),
    `the ${key} switch did not write "${want}"`,
  );
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Seam routes (what the product's own inserts call)
// ---------------------------------------------------------------------------

interface ButtonHandle {
  instanceId: string;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

async function seamCreateButton(page: Page, req: Record<string, unknown>): Promise<ButtonHandle> {
  await installAppImport(page);
  return bounded(
    "createButton",
    page.evaluate(
      async ({ mod, req }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          requireButtonControlProvider: () => { createButton: (r: unknown) => Promise<unknown> };
        };
        return m.requireButtonControlProvider().createButton(req);
      },
      { mod: MOD.BUTTON_SERVICE, req },
    ) as Promise<ButtonHandle>,
  );
}

async function seamCreateNavigator(page: Page, req: Record<string, unknown>): Promise<ButtonHandle> {
  await installAppImport(page);
  return bounded(
    "createPageNavigator",
    page.evaluate(
      async ({ mod, req }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          requireButtonControlProvider: () => { createPageNavigator: (r: unknown) => Promise<unknown> };
        };
        return m.requireButtonControlProvider().createPageNavigator(req);
      },
      { mod: MOD.BUTTON_SERVICE, req },
    ) as Promise<ButtonHandle>,
  );
}

async function seamRemoveControl(page: Page, anchor: { sheetIndex: number; row: number; col: number }): Promise<void> {
  await installAppImport(page);
  await bounded(
    "removeButton",
    page.evaluate(
      async ({ mod, anchor }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          requireButtonControlProvider: () => { removeButton: (a: unknown) => Promise<void> };
        };
        await m.requireButtonControlProvider().removeButton(anchor);
      },
      { mod: MOD.BUTTON_SERVICE, anchor },
    ),
  );
}

async function parseOverrides(page: Page, value: string): Promise<Array<Record<string, unknown>>> {
  return callModule(page, MOD.BUTTON_SERVICE, "parsePageNavigatorOverrides", [value]);
}

/** Click a control's centre as a user would (run mode: a button performs its action). */
async function clickControlCentre(page: Page, p: ControlProps): Promise<void> {
  const at = await sheetPointToPage(page, Number(prop(p, "x")) + Number(prop(p, "width")) / 2, Number(prop(p, "y")) + Number(prop(p, "height")) / 2);
  await humanClick(page, at.x, at.y);
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function manifestOf(file: string): { formatVersion: number; features: string[] } {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(file)));
  const raw = entries["manifest.json"];
  if (!raw) throw new Error(`${file} has no manifest.json (entries: ${Object.keys(entries).join(", ")})`);
  const m = JSON.parse(new TextDecoder().decode(raw)) as { formatVersion: number; features?: string[] };
  return { formatVersion: m.formatVersion, features: m.features ?? [] };
}

// ---------------------------------------------------------------------------
// The model Card (fixture)
// ---------------------------------------------------------------------------

async function cardValue(page: Page, chartId: string): Promise<number | null> {
  const d = await callModule<{ data?: { series?: Array<{ values: number[] }> } } | null>(page, MOD.CHART_RENDERER, "getCachedChartData", [chartId]);
  const v = d?.data?.series?.[0]?.values?.[0];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Visuals > Card > Design query, the way canvas-powerbi.spec.ts P5 inserts one (the fallback route). */
async function cardThroughDialog(page: Page): Promise<string> {
  const listCharts = async () => (await invoke<Array<{ id: string }>>(page, "get_charts")).map((c) => c.id);
  const before = await listCharts();
  await clickCanvasControl(page, "canvas-visual-card");
  await expect(page.locator('input[placeholder="e.g., Sheet1!A1:D10"]')).toBeVisible({ timeout: 8000 });
  await page.getByText("Design query", { exact: true }).click();
  const connSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "Select a BI connection" }) });
  await connSelect.selectOption(connectionId);
  await page.waitForTimeout(1200);
  const editor = page.locator(".monaco-editor").filter({ visible: true }).first();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type("VALUES: [Revenue]", { delay: 30 });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Insert Chart" }).click();
  const after = await eventually(listCharts, (ids) => ids.length === before.length + 1, "the design-query Card was not inserted", 20_000);
  return after.find((id) => !before.includes(id))!;
}

// ===========================================================================

test.describe("Page Navigator = one live object (D-NAV), live", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test.beforeAll(async ({ sharedPage: page }) => {
    test.setTimeout(600_000);
    fs.mkdirSync(WORK, { recursive: true });
    await installAppImport(page);
    await newFile(page);
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]);

    // ---- The owner's AdventureWorks model, against the real Postgres.
    const bundle = JSON.parse(fs.readFileSync(MODEL_FILE, "utf8")) as Record<string, unknown>;
    const info = await invokeSlow<{ id: string }>(page, "bi_create_connection", {
      request: { name: CONNECTION_NAME, description: null, connectionString: "", modelJson: bundle },
    });
    connectionId = info.id;
    try {
      await invokeSlow(page, "bi_model_connect_source", { connectionId, sourceId: MODEL_SOURCE_ID, connectionString: MODEL_URL, remember: false });
    } catch (e) {
      throw new Error(`AdventureWorks Postgres at localhost:5432 is not reachable: ${String(e).slice(0, 400)}`);
    }

    // ---- Three canvases (A, B, C) beside the worksheet Sheet1.
    A = (await addCanvas(page)) as Sheet;
    B = (await addCanvas(page)) as Sheet;
    C = (await addCanvas(page)) as Sheet;
    for (const s of [A, B, C]) expect(s.sheetId, `precondition: canvas ${s.name} has a sheet id`).toBeTruthy();
    await goTo(page, A.sheetId!);

    // ---- On A, a measure-only Card: the model must answer.
    let cardId: string;
    try {
      cardId = await createChart(
        page,
        { mark: "card", data: { type: "designQuery", dslText: "VALUES: [Revenue]", connectionId }, title: "Revenue" },
        { sheetIndex: A.index, x: 40, y: 120, width: 240, height: 120 },
        { waitPaint: false },
      );
    } catch (e) {
      console.log(`[canvas-page-navigator] the Card spec was refused (${String(e).slice(0, 200)}); inserting it through the dialog`);
      cardId = await cardThroughDialog(page);
    }
    await eventually(() => cardValue(page, cardId), (v) => v !== null, "the AdventureWorks Card never showed the model's Revenue", 60_000);
  });

  test.afterAll(async ({ sharedPage: page }) => {
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]).catch(() => undefined);
    await newFile(page).catch(() => undefined);
    const conns = await invoke<Array<{ id: string; name: string }>>(page, "bi_get_connections").catch(() => []);
    for (const c of conns) {
      if (c.id === connectionId || c.name === CONNECTION_NAME) {
        await invoke(page, "bi_delete_connection", { connectionId: c.id }).catch(() => undefined);
      }
    }
    fs.rmSync(WORK, { recursive: true, force: true });
  });

  test("N1 Insert one live object: one pageNavigator control, no per-page buttons, one undo step; items A,B,C in tab order with A current", async ({ appPage: page }) => {
    await setDesign(page, false);
    await goTo(page, A.sheetId!);
    await startTextRecorder(page);
    const before = await controlsWithProps(page, A.index);

    await clickCanvasMenuRow(page, "canvas-buttons", "canvas-buttons-pageNavigator");
    const after = await eventually(
      () => controlsWithProps(page, A.index),
      (cs) => cs.some((c) => c.type === "pageNavigator"),
      "Buttons > Page Navigator inserted no pageNavigator control",
    );
    expect(after.filter((c) => c.type === "pageNavigator"), "exactly ONE navigator").toHaveLength(1);
    expect(after.filter((c) => c.type === "button").length, "the insert added ordinary buttons").toBe(before.filter((c) => c.type === "button").length);
    expect(after.length, "the insert added more than one control").toBe(before.length + 1);

    const nav = await navigatorOn(page, A.sheetId!);
    const p = nav.props;
    expect(prop(p, "embedded"), "embedded must be written explicitly").toBe("false");
    expect(prop(p, "pinToGrid"), "pinToGrid must be written explicitly (an absent one means 'moves with cells')").toBe("false");
    expect(prop(p, "pageOverrides")).toBe("[]");
    expect(prop(p, "showHiddenPages")).toBe("false");
    for (const k of ["action", "actionTarget", "actionTargetName", "onSelect", "text", "macroRef"]) {
      expect(p[k], `a navigator stores no "${k}"`).toBeUndefined();
    }
    expect((await undoState(page)).undoDescription, "the insert is ONE undo step").toBe("Insert Page Navigator");

    const d = await waitNav(page, nav.controlId, (x) => x.items.length === 3, "the navigator does not list the three canvases");
    expect(d.items.map((i) => i.caption), "one item per canvas, by page name, in tab order").toEqual([A.name, B.name, C.name]);
    expect(keys(d), "items are keyed by sheet id").toEqual([A.sheetId, B.sheetId, C.sheetId]);
    expect(d.items.map((i) => i.current), "A (the page on screen) is the current item").toEqual([true, false, false]);

    // The box: inside the page, at the seam's natural size for three pages (clamped).
    const layout = (await sheetById(page, A.sheetId!)).canvasLayout!;
    expect(d.box.x >= 0 && d.box.y >= 0 && d.box.x + d.box.width <= layout.pageWidth && d.box.y + d.box.height <= layout.pageHeight, `the navigator's box ${JSON.stringify(d.box)} is not inside the ${layout.pageWidth}x${layout.pageHeight} page`).toBe(true);
    const natural = await callModule<{ width: number; height: number }>(page, MOD.BUTTON_SERVICE, "pageNavigatorNaturalSize", [3]);
    expect({ w: d.box.width, h: d.box.height }).toEqual({ w: Math.min(natural.width, layout.pageWidth), h: Math.min(natural.height, layout.pageHeight) });

    await eventually(() => recordedTexts(page), (t) => [A.name, B.name, C.name].every((n) => t.includes(n)), "the painter did not WRITE all three captions");

    // Undo takes the ONE control away; redo brings it back.
    await gridKey(page, "Control+z");
    await eventually(() => controlsWithProps(page, A.index), (cs) => !cs.some((c) => c.type === "pageNavigator"), "Ctrl+Z did not remove the navigator");
    expect((await controlsWithProps(page, A.index)).length, "Ctrl+Z removed more (or less) than the navigator").toBe(before.length);
    await gridKey(page, "Control+y");
    await eventually(() => controlsWithProps(page, A.index), (cs) => cs.filter((c) => c.type === "pageNavigator").length === 1, "Ctrl+Y did not bring the navigator back");
    const redone = await navigatorOn(page, A.sheetId!);
    await waitNav(page, redone.controlId, (x) => x.items.length === 3, "the redone navigator does not list the three canvases");
    navRecord = canonical(redone.props);
  });

  test("N2 A page added later appears, with nothing re-inserted and nothing stored", async ({ appPage: page }) => {
    D = (await addCanvas(page)) as Sheet;
    expect(D.sheetId, "precondition: the new canvas has an id").toBeTruthy();
    await startTextRecorder(page);
    await goTo(page, A.sheetId!);
    const nav = await navigatorOn(page, A.sheetId!);
    expect(canonical(nav.props), "the stored navigator changed when a page was added (the item list must not be stored)").toBe(navRecord);
    const d = await waitNav(page, nav.controlId, (x) => x.items.length === 4, "the page added later did not appear in the navigator");
    expect(keys(d)).toEqual([A.sheetId, B.sheetId, C.sheetId, D.sheetId]);
    expect(d.items.map((i) => i.caption)).toEqual([A.name, B.name, C.name, D.name]);
    await eventually(() => recordedTexts(page), (t) => t.includes(D.name), `the painter did not WRITE the new page's caption "${D.name}" after the switch back`);
  });

  test("N3 A run-mode press on an item opens its page and opens no pane; the current page's item does nothing", async ({ appPage: page }) => {
    await setDesign(page, false);
    await goTo(page, A.sheetId!);
    const nav = await navigatorOn(page, A.sheetId!);
    let d = await waitNav(page, nav.controlId, (x) => x.items.length === 4, "precondition: four items");

    // The current page's item: already there -- no switch, no pane, no selection.
    await clickItem(page, itemOf(d, A.sheetId!)!);
    expect(await activeIndex(page), "pressing the current page's item moved the user").toBe(A.index);
    const panes = await openPaneIds(page);
    expect(panes.filter((p) => p === CONTROL_PROPERTIES_PANE || p === OBJECT_PANE), "a run-mode press opened a pane").toEqual([]);
    expect((await selectedObjects(page)).map((o) => o.id), "a run-mode press selected the navigator").not.toContain(nav.controlId);

    // B's item opens B.
    d = (await describeNav(page, nav.controlId))!;
    await clickItem(page, itemOf(d, B.sheetId!)!);
    await eventually(() => activeIndex(page), (i) => i === B.index, "a run-mode press on B's item did not open B");
    expect((await openPaneIds(page)).filter((p) => p === CONTROL_PROPERTIES_PANE || p === OBJECT_PANE), "the press opened a pane").toEqual([]);

    // Back on A (tab click): A's item is current again.
    await goTo(page, A.sheetId!);
    await waitNav(page, nav.controlId, (x) => itemOf(x, A.sheetId!)?.current === true && x.items.filter((i) => i.current).length === 1, "back on A, A's item is not the one current item");
  });

  test("N4 Sliding off an item cancels the press: no switch, no toast", async ({ appPage: page }) => {
    await setDesign(page, false);
    await goTo(page, A.sheetId!);
    const nav = await navigatorOn(page, A.sheetId!);
    const d = await waitNav(page, nav.controlId, (x) => x.items.length === 4, "precondition: four items");
    const b = itemOf(d, B.sheetId!)!;
    const c = itemOf(d, C.sheetId!)!;
    const pb = await sheetPointToPage(page, b.rect.x + b.rect.width / 2, b.rect.y + b.rect.height / 2);
    const pc = await sheetPointToPage(page, c.rect.x + c.rect.width / 2, c.rect.y + c.rect.height / 2);
    await startToasts(page);
    await page.mouse.move(pb.x, pb.y);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.move(pc.x, pc.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    expect(await activeIndex(page), "a press that slid from B to C opened a page").toBe(A.index);
    expect(await toasts(page), "a cancelled press said something").toEqual([]);
    // POSITIVE CONTROL: the same press released on B opens B.
    await clickItem(page, b);
    await eventually(() => activeIndex(page), (i) => i === B.index, "a plain press on B did not open B (positive control)");
    await goTo(page, A.sheetId!);
  });

  test("N5 Renames follow and the current page is decided by id: a renamed page keeps its caption in step, a renamed ACTIVE page stays current, and a navigate button to it keeps its wash", async ({ appPage: page }) => {
    await setDesign(page, false);
    await goTo(page, A.sheetId!);
    const nav = await navigatorOn(page, A.sheetId!);
    await waitNav(page, nav.controlId, (x) => x.items.length === 4, "precondition: four items");

    // Two ordinary navigate buttons on A, the same size: one to A itself
    // (painted current: the wash), one to B (the untouched twin).
    const r1 = await freeCanvasRect(page, { width: 96, height: 32 }, 24);
    const self = await seamCreateButton(page, { sheetIndex: A.index, x: r1.x, y: r1.y, width: 96, height: 32, label: "Self", action: { kind: "navigate", sheetId: A.sheetId, sheetName: A.name } });
    // The second spot must see the first button as an obstacle: wait for its region.
    await eventually(() => regionIds(page), (ids) => ids.includes(self.instanceId), "the first button was never published as a region");
    const r2 = await freeCanvasRect(page, { width: 96, height: 32 }, 24);
    const other = await seamCreateButton(page, { sheetIndex: A.index, x: r2.x, y: r2.y, width: 96, height: 32, label: "Other", action: { kind: "navigate", sheetId: B.sheetId, sheetName: B.name } });
    await eventually(() => regionIds(page), (ids) => ids.includes(other.instanceId), "the second button was never published as a region");
    await page.waitForTimeout(600);
    // The lower-left corner of each face: below the 3D highlight band, clear of the caption and the border.
    const patch = async (b: ButtonHandle): Promise<PixelClip> => {
      const tl = await sheetPointToPage(page, b.x + 6, b.y + b.height - 12);
      return { x: Math.round(tl.x), y: Math.round(tl.y), width: 6, height: 6 };
    };
    await parkPointer(page);
    const [selfBefore, otherBefore] = await samplePixelGrids(page, [await patch(self), await patch(other)]);
    const px = selfBefore.width * selfBefore.height;
    expect(diffCount(selfBefore, otherBefore), "precondition: the button to the page on screen carries no current-page wash").toBeGreaterThan(px / 2);

    // Rename B (not active): its caption follows.
    await callModule(page, MOD.TAURI_API, "renameSheet", [(await sheetById(page, B.sheetId!)).index, "Sales Overview"]);
    B = await sheetById(page, B.sheetId!);
    expect(B.name).toBe("Sales Overview");
    await waitNav(page, nav.controlId, (x) => itemOf(x, B.sheetId!)?.caption === "Sales Overview", "B's item did not take its new name");

    // Rename A, the ACTIVE page: its item is STILL current (sheet id, never the name).
    await callModule(page, MOD.TAURI_API, "renameSheet", [A.index, "Start"]);
    A = await sheetById(page, A.sheetId!);
    expect(A.name).toBe("Start");
    const d = await waitNav(page, nav.controlId, (x) => itemOf(x, A.sheetId!)?.caption === "Start", "A's item did not take its new name");
    expect(itemOf(d, A.sheetId!)!.current, "the renamed active page's item is no longer current").toBe(true);
    expect(d.items.filter((i) => i.current), "exactly one item is current").toHaveLength(1);

    // The navigate button to A keeps its wash (isCurrentPageButton by id).
    await page.waitForTimeout(600);
    await parkPointer(page);
    const [selfAfter, otherAfter] = await samplePixelGrids(page, [await patch(self), await patch(other)]);
    expect(diffCount(selfAfter, selfBefore), "after renaming the page on screen, its navigate button lost its current-page wash").toBeLessThan(px / 10);
    expect(diffCount(selfAfter, otherAfter), "after the rename the two buttons look alike (the wash is gone)").toBeGreaterThan(px / 2);
    expect(diffCount(otherAfter, otherBefore), "the untouched twin changed").toBeLessThan(px / 10);
  });

  test("N6 A reorder follows: items are in the new tab order", async ({ appPage: page }) => {
    await goTo(page, A.sheetId!);
    const from = (await sheetById(page, C.sheetId!)).index;
    const to = (await sheetById(page, B.sheetId!)).index;
    await callModule(page, MOD.TAURI_API, "moveSheet", [from, to]);
    await eventually(async () => (await sheetById(page, C.sheetId!)).index, (i) => i === to, "the move did not land");
    for (const s of [A, B, C, D]) Object.assign(s, await sheetById(page, s.sheetId!));
    const nav = await navigatorOn(page, A.sheetId!);
    const d = await waitNav(page, nav.controlId, (x) => keys(x).join() === [A.sheetId, C.sheetId, B.sheetId, D.sheetId].join(), "the items did not follow the new tab order (A, C, B, D)");
    expect(d.items.map((i) => i.caption)).toEqual([A.name, C.name, "Sales Overview", D.name]);
  });

  test("N7 Hiding a NON-active page drops its item (the Core announcement); Show hidden pages lists it disabled; unhide restores it; hiding the ACTIVE page lands the grid and the controls together", async ({ appPage: page }) => {
    await setDesign(page, false);
    await goTo(page, A.sheetId!);
    let nav = await navigatorOn(page, A.sheetId!);
    await waitNav(page, nav.controlId, (x) => x.items.length === 4, "precondition: four items");

    // ---- Hide B (not the active page) through the real tab menu.
    await tabMenu(page, (await sheetById(page, B.sheetId!)).index, "Hide Sheet");
    await eventually(async () => (await sheetById(page, B.sheetId!)).visibility, (v) => v === "hidden", "the tab menu did not hide B");
    await waitNav(page, nav.controlId, (x) => !itemOf(x, B.sheetId!) && x.items.length === 3, "B's item did not disappear when B was hidden");
    expect(await activeIndex(page), "hiding another page moved the user").toBe(A.index);
    nav = await navigatorOn(page, A.sheetId!);
    expect(canonical(nav.props), "hiding a page changed the stored navigator").toBe(navRecord);

    // ---- Show hidden pages (Properties pane, Design Mode): B is listed, disabled.
    await setDesign(page, true);
    await setSwitch(page, nav.controlId, A.sheetId!, "showHiddenPages", true);
    let d = await waitNav(page, nav.controlId, (x) => itemOf(x, B.sheetId!)?.hiddenPage === true, "with Show hidden pages, B is not listed as a hidden page");
    expect(d.items.length).toBe(4);
    await setDesign(page, false);
    await startToasts(page);
    d = (await describeNav(page, nav.controlId))!;
    await clickItem(page, itemOf(d, B.sheetId!)!);
    await eventually(() => toasts(page), (t) => t.some((x) => x.text.includes(HIDDEN_PAGE_TOAST)), "pressing a hidden page's item did not say why it cannot open");
    expect(await activeIndex(page), "a hidden page was opened").toBe(A.index);
    await dismissToasts(page);

    // ---- Unhide B through the tab menu's Unhide dialog: its item is an ordinary one again.
    await unhideViaDialog(page, A.index, "Sales Overview");
    await waitNav(page, nav.controlId, (x) => itemOf(x, B.sheetId!)?.hiddenPage === false, "after Unhide, B's item is not an ordinary item");
    await setDesign(page, true);
    await setSwitch(page, nav.controlId, A.sheetId!, "showHiddenPages", false);
    await setDesign(page, false);

    // ---- Hide the ACTIVE page C (with a shape of its own) through the tab strip.
    await goTo(page, C.sheetId!);
    const shapeAt = await freeCanvasRect(page, { width: 120, height: 80 });
    const shape = await createShape(page, { sheetIndex: C.index, x: shapeAt.x, y: shapeAt.y, width: 120, height: 80 });
    await eventually(
      () => callModule<Array<{ id: string }>>(page, MOD.CONTROLS_FLOATING_STORE, "getAllFloatingControls"),
      (cs) => cs.some((c) => c.id === shape.instanceId),
      "precondition: C's shape is not in the floating store",
    );
    await tabMenu(page, C.index, "Hide Sheet");
    const landed = await eventually(() => sheetsResult(page), (r) => r.activeIndex !== C.index && (r.sheets.find((s) => s.sheetId === C.sheetId) as Sheet | undefined)?.visibility === "hidden", "hiding the active page did not land on another page");
    await eventually(() => gridActiveIndex(page), (g) => g === landed.activeIndex, "the GRID's active sheet disagrees with the backend after hiding the active page");
    const floating = await eventually(
      () => callModule<Array<{ id: string; sheetIndex: number }>>(page, MOD.CONTROLS_FLOATING_STORE, "getAllFloatingControls"),
      (cs) => cs.every((c) => c.sheetIndex === landed.activeIndex),
      "the floating store still holds controls of another page after the hide",
    );
    expect(floating.map((c) => c.id), "the hidden page's shape is still loaded (and painted)").not.toContain(shape.instanceId);
    const backendOnLanded = await controlsWithProps(page, landed.activeIndex);
    expect(floating.length, "the floating store does not hold exactly the landed page's controls").toBe(backendOnLanded.length);

    await goTo(page, A.sheetId!);
    nav = await navigatorOn(page, A.sheetId!);
    await waitNav(page, nav.controlId, (x) => !itemOf(x, C.sheetId!) && x.items.length === 3, "the navigator still lists the hidden page C");

    // Put C back for N9 (and prove the unhide reaches the navigator too).
    await unhideViaDialog(page, A.index, C.name);
    await waitNav(page, nav.controlId, (x) => !!itemOf(x, C.sheetId!) && x.items.length === 4, "after Unhide, C's item did not come back");
    for (const s of [A, B, C, D]) Object.assign(s, await sheetById(page, s.sheetId!));
  });

  test("N8 Tooltip pages are left out unless Show tooltip pages is on", async ({ appPage: page }) => {
    await setDesign(page, false);
    await goTo(page, D.sheetId!);
    await patchActiveCanvas(page, { pagePreset: "tooltip" });
    expect((await sheetById(page, D.sheetId!)).canvasLayout?.pagePreset).toBe("tooltip");
    await goTo(page, A.sheetId!);
    const nav = await navigatorOn(page, A.sheetId!);
    await waitNav(page, nav.controlId, (x) => !itemOf(x, D.sheetId!) && x.items.length === 3, "the Tooltip page D is still listed");
    await setDesign(page, true);
    await setSwitch(page, nav.controlId, A.sheetId!, "showTooltipPages", true);
    await waitNav(page, nav.controlId, (x) => itemOf(x, D.sheetId!)?.tooltipPage === true, "with Show tooltip pages, D is not listed");
    await setSwitch(page, nav.controlId, A.sheetId!, "showTooltipPages", false);
    await waitNav(page, nav.controlId, (x) => !itemOf(x, D.sheetId!), "with Show tooltip pages off again, D is still listed");
    await setDesign(page, false);
  });

  test("N9 Deleting a page drops its item; the delete ends the undo history, so Ctrl+Z brings back no ghost", async ({ appPage: page }) => {
    await setDesign(page, false);
    await goTo(page, A.sheetId!);
    const nav = await navigatorOn(page, A.sheetId!);
    await waitNav(page, nav.controlId, (x) => !!itemOf(x, C.sheetId!), "precondition: C is listed");
    await tabMenu(page, (await sheetById(page, C.sheetId!)).index, "Delete");
    const confirm = page
      .locator("div")
      .filter({ has: page.getByText("Delete Sheet", { exact: true }) })
      .filter({ has: page.locator("button", { hasText: /^Cancel$/ }) })
      .last();
    await confirm.waitFor({ state: "visible", timeout: 5000 });
    await confirm.locator("button", { hasText: /^Delete$/ }).click();
    await eventually(() => sheetsResult(page), (r) => !r.sheets.some((s) => s.sheetId === C.sheetId), "the tab menu's Delete did not delete C");
    await goTo(page, A.sheetId!);
    // Re-read the navigator: its id carries the sheet INDEX, which a delete before A could change.
    const navAfter = await navigatorOn(page, A.sheetId!);
    const after = await waitNav(page, navAfter.controlId, (x) => !itemOf(x, C.sheetId!), "the deleted page's item is still listed");
    expect(keys(after)).toEqual([A.sheetId, B.sheetId]);
    expect((await undoState(page)).canUndo, "a sheet delete must end the undo history (BUG-0005, Excel parity)").toBe(false);
    await gridKey(page, "Control+z");
    await page.waitForTimeout(800);
    expect((await sheetsResult(page)).sheets.some((s) => s.sheetId === C.sheetId), "Ctrl+Z brought a deleted sheet back").toBe(false);
    const still = (await describeNav(page, (await navigatorOn(page, A.sheetId!)).controlId))!;
    expect(keys(still), "Ctrl+Z after a delete changed the navigator").toEqual([A.sheetId, B.sheetId]);
    for (const s of [A, B, D]) Object.assign(s, await sheetById(page, s.sheetId!));
  });

  test("N10 Design Mode: the first press selects the whole navigator, a second press one button; Escape climbs; the Buttons section edits one page's button; a drag moves the whole navigator; Lock Objects refuses it and selects no button", async ({ appPage: page }) => {
    await goTo(page, A.sheetId!);
    let nav = await navigatorOn(page, A.sheetId!);
    await setDesign(page, true);
    expect(await designModeMenuChecked(page), "the Developer menu does not show Design Mode checked").toBe(true);
    try {
      let d = await waitNav(page, nav.controlId, (x) => x.items.length === 2, "precondition: two items (A, B)");

      // ---- First press: the whole navigator.
      await clickItem(page, itemOf(d, B.sheetId!)!);
      expect((await selectedObjects(page)).map((o) => o.id), "the first press did not select the navigator").toEqual([nav.controlId]);
      const pane = await openNavigatorProperties(page, nav.controlId);
      await expect(pane.locator('[data-testid="nav-buttons-section"]'), "the Properties pane has no Buttons section").toBeVisible();
      await expect(pane.getByText("Buttons", { exact: true }), "the overrides section is not titled Buttons (exactly once)").toHaveCount(1);
      await expect(pane.getByText("Button style", { exact: true }), "the style group is not titled Button style").toHaveCount(1);
      const rows = pane.locator('[data-testid^="nav-buttons-row-"]');
      await expect(rows, "the Buttons section does not list one row per item").toHaveCount(d.items.length);
      expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("aria-expanded"))), "a row is expanded with no button selected").toEqual(d.items.map(() => "false"));
      expect((await selectedNavigatorItem(page)), "the first press selected a button").toBeNull();

      // ---- Second press (no move): B's button.
      await page.waitForTimeout(700); // never a double-click
      d = (await describeNav(page, nav.controlId))!;
      await clickItem(page, itemOf(d, B.sheetId!)!);
      await expect(page.locator(`[data-testid="nav-buttons-row-${B.sheetId}"]`), "selecting B's button did not expand its row").toHaveAttribute("aria-expanded", "true");
      d = await waitNav(page, nav.controlId, (x) => itemOf(x, B.sheetId!)?.selected === true, "describe does not mark B's button selected");
      expect(d.items.filter((i) => i.selected)).toHaveLength(1);

      // ---- Escape climbs one rung, then the next.
      await gridKey(page, "Escape");
      await waitNav(page, nav.controlId, (x) => x.items.every((i) => !i.selected), "Escape did not drop the button selection");
      expect((await selectedObjects(page)).map((o) => o.id), "the first Escape dropped the navigator too").toEqual([nav.controlId]);
      await gridKey(page, "Escape");
      await eventually(() => selectedObjects(page), (s) => s.length === 0, "the second Escape left something selected");

      // ---- Select B's button again and give it a caption.
      d = (await describeNav(page, nav.controlId))!;
      await clickItem(page, itemOf(d, B.sheetId!)!);
      await page.waitForTimeout(700);
      d = (await describeNav(page, nav.controlId))!;
      await clickItem(page, itemOf(d, B.sheetId!)!);
      await waitNav(page, nav.controlId, (x) => itemOf(x, B.sheetId!)?.selected === true, "B's button is not selected again");
      await startTextRecorder(page);
      const caption = page.locator(`[data-testid="nav-buttons-caption-${B.sheetId}"]`);
      await expect(caption).toBeVisible({ timeout: 5000 });
      await caption.fill("Overview");
      await caption.press("Enter");
      const written = await eventually(
        async () => parseOverrides(page, prop((await navigatorOn(page, A.sheetId!)).props, "pageOverrides")),
        (list) => list.length === 1 && list[0].text === "Overview",
        "the caption was not written to pageOverrides",
      );
      expect(written[0], "the override is keyed by B's id and name").toMatchObject({ sheetId: B.sheetId, sheetName: "Sales Overview", text: "Overview" });
      await waitNav(page, nav.controlId, (x) => itemOf(x, B.sheetId!)?.caption === "Overview", "B's item does not show the new caption");
      await eventually(() => recordedTexts(page), (t) => t.includes("Overview"), "the painter did not WRITE the new caption");

      // ---- Hide A's button (its row stays listed).
      const rowA = page.locator(`[data-testid="nav-buttons-row-${A.sheetId}"]`);
      if ((await rowA.getAttribute("aria-expanded")) !== "true") await rowA.click();
      await page.locator(`[data-testid="nav-buttons-show-${A.sheetId}"]`).uncheck();
      await waitNav(page, nav.controlId, (x) => !itemOf(x, A.sheetId!) && x.items.length === 1, "unchecking A's button did not take its item away");
      await expect(rowA, "A's row left the Buttons section with its item").toBeVisible();

      // ---- Click nothing, then the navigator once: the whole navigator, no button.
      const spot = await freeCanvasRect(page, { width: 8, height: 8 });
      await clickEmpty(page, spot.x + 4, spot.y + 4);
      await eventually(() => selectedObjects(page), (s) => s.length === 0, "clicking an empty spot left something selected");
      d = (await describeNav(page, nav.controlId))!;
      await clickItem(page, itemOf(d, B.sheetId!)!);
      expect((await selectedObjects(page)).map((o) => o.id)).toEqual([nav.controlId]);
      expect(await selectedNavigatorItem(page)).toBeNull();

      // ---- A drag of the selected navigator moves the WHOLE control and selects no button.
      const layout = (await sheetById(page, A.sheetId!)).canvasLayout!;
      const snap = layout.snapToGrid ? layout.gridSizePx : 0;
      const x0 = Number(prop(nav.props, "x"));
      d = (await describeNav(page, nav.controlId))!;
      const b = itemOf(d, B.sheetId!)!;
      await dragObject(page, { x: d.box.x, y: d.box.y }, [{ dx: 12, dy: 0 }, { dx: 40, dy: 0 }], { dx: b.rect.x - d.box.x + b.rect.width / 2, dy: b.rect.y - d.box.y + b.rect.height / 2 });
      const moved = await eventually(async () => Number(prop((await navigatorOn(page, A.sheetId!)).props, "x")), (x) => x !== x0, "the drag did not move the navigator");
      expect(Math.abs(moved - (x0 + 40)), `the navigator moved to x=${moved}, not by ~40 px from ${x0}`).toBeLessThanOrEqual(snap);
      expect((await controlsWithProps(page, A.index)).filter((c) => c.type === "pageNavigator"), "the drag split the navigator").toHaveLength(1);
      expect(await selectedNavigatorItem(page), "a drag selected a button").toBeNull();
      nav = await navigatorOn(page, A.sheetId!);
      expect((await describeNav(page, nav.controlId))!.items.filter((i) => i.selected), "a drag left a button selected").toEqual([]);

      // ---- Lock Objects: a drag is refused with ONE toast and selects no button; a caption edit still writes.
      await clickCanvasControl(page, "canvas-lock-objects");
      await eventually(async () => (await sheetById(page, A.sheetId!)).canvasLayout?.objectsLocked, (l) => l === true, "Lock Objects did not lock the page");
      await closeCanvasFlyouts(page);
      if (!(await selectedObjects(page)).some((o) => o.id === nav.controlId)) {
        d = (await describeNav(page, nav.controlId))!;
        await clickItem(page, itemOf(d, B.sheetId!)!);
      }
      if ((await selectedNavigatorItem(page)) !== null) await gridKey(page, "Escape");
      expect((await selectedObjects(page)).map((o) => o.id), "precondition: the navigator is selected, no button").toEqual([nav.controlId]);
      expect(await selectedNavigatorItem(page)).toBeNull();
      const xLocked = Number(prop(nav.props, "x"));
      await page.waitForTimeout(700);
      await startToasts(page);
      d = (await describeNav(page, nav.controlId))!;
      const bl = itemOf(d, B.sheetId!)!;
      await dragObject(page, { x: d.box.x, y: d.box.y }, [{ dx: 12, dy: 0 }, { dx: 40, dy: 0 }], { dx: bl.rect.x - d.box.x + bl.rect.width / 2, dy: bl.rect.y - d.box.y + bl.rect.height / 2 });
      await page.waitForTimeout(900);
      expect(Number(prop((await navigatorOn(page, A.sheetId!)).props, "x")), "a LOCKED page let the navigator move").toBe(xLocked);
      const lockToasts = (await toasts(page)).filter((t) => /locked/i.test(t.text));
      expect(lockToasts.length, `one refused drag must say so exactly once: ${JSON.stringify(await toasts(page))}`).toBe(1);
      expect(await selectedNavigatorItem(page), "the immovable drag selected a button (no moveComplete is reported for it)").toBeNull();
      expect((await describeNav(page, nav.controlId))!.items.filter((i) => i.selected)).toEqual([]);

      const pane2 = await openNavigatorProperties(page, nav.controlId);
      const rowB = pane2.locator(`[data-testid="nav-buttons-row-${B.sheetId}"]`);
      if ((await rowB.getAttribute("aria-expanded")) !== "true") await rowB.click();
      const caption2 = page.locator(`[data-testid="nav-buttons-caption-${B.sheetId}"]`);
      await caption2.fill("Overview B");
      await caption2.press("Enter");
      await eventually(
        async () => parseOverrides(page, prop((await navigatorOn(page, A.sheetId!)).props, "pageOverrides")),
        (list) => list.some((o) => o.sheetId === B.sheetId && o.text === "Overview B"),
        "with Lock Objects on, a caption edit did not write (format stays editable)",
      );

      await clickCanvasControl(page, "canvas-lock-objects");
      await eventually(async () => (await sheetById(page, A.sheetId!)).canvasLayout?.objectsLocked, (l) => !l, "Lock Objects did not unlock the page");
      await closeCanvasFlyouts(page);
    } finally {
      await setDesign(page, false);
    }
  });

  test("N11 Save and reopen: the navigator, its overrides and its live items come back; the file lists page_navigator and the navigator raises no format version", async ({ appPage: page }) => {
    const withNav = path.join(WORK, "with-navigator.cala");
    const withoutNav = path.join(WORK, "without-navigator.cala");
    await goTo(page, A.sheetId!);
    const before = await navigatorOn(page, A.sheetId!);
    await invoke(page, "save_file", { path: withNav });
    await newFile(page);
    await openFileAtPath(page, withNav);

    const a = await sheetByName(page, "Start");
    A = a;
    await goTo(page, a.sheetId!);
    const after = await navigatorOn(page, a.sheetId!);
    expect(canonical(after.props), "the navigator did not come back as it was saved").toBe(canonical(before.props));
    const d = await waitNav(page, after.controlId, (x) => x.items.length === 1, "after reopening, the navigator does not list one item (A's button is hidden, D is a Tooltip page)");
    expect(d.items.map((i) => i.caption), "the override's caption did not come back").toEqual(["Overview B"]);
    expect(d.items[0].sheetName).toBe("Sales Overview");

    const m1 = manifestOf(withNav);
    expect(m1.features, "the saved manifest does not declare the page_navigator feature").toContain("page_navigator");
    expect(m1.formatVersion, "a canvas workbook is at least version 9").toBeGreaterThanOrEqual(9);

    // The same workbook without the navigator: no feature id, the SAME version.
    await seamRemoveControl(page, { sheetIndex: after.sheetIndex, row: after.row, col: after.col });
    await eventually(() => controlsWithProps(page, after.sheetIndex), (cs) => !cs.some((c) => c.type === "pageNavigator"), "the navigator was not removed");
    await invoke(page, "save_file", { path: withoutNav });
    const m2 = manifestOf(withoutNav);
    expect(m2.features, "a workbook without a navigator declares page_navigator").not.toContain("page_navigator");
    expect(m1.formatVersion, `the navigator raised the format version (${m2.formatVersion} -> ${m1.formatVersion})`).toBe(m2.formatVersion);
    console.log(`[canvas-page-navigator] N11 formatVersion ${m1.formatVersion}, features ${JSON.stringify(m1.features)}`);
  });

  test("N12 BUG-0449: a subscriber after a collision rename gets page targets remapped to ITS sheet ids, and a refresh after the subscriber's own rename keeps them", async ({ appPage: page }) => {
    test.setTimeout(600_000);
    const ws = path.join(WORK, "workspace");
    fs.mkdirSync(ws, { recursive: true });
    const app = `page-nav-${RUN}`;
    await setDesign(page, false);

    // ---- The publisher: Sales (a navigator captioning Detail "Details", and a navigate button to Detail) + Detail.
    await newFile(page);
    const s1 = await addCanvas(page);
    await renameSheetByName(page, s1.name, "Sales");
    const s2 = await addCanvas(page);
    await renameSheetByName(page, s2.name, "Detail");
    const pubSales = await sheetByName(page, "Sales");
    const pubDetail = await sheetByName(page, "Detail");
    await goTo(page, pubSales.sheetId!);
    const pubNav = await seamCreateNavigator(page, { sheetIndex: pubSales.index, x: 40, y: 40 });
    const overrides = await callModule<string>(page, MOD.BUTTON_SERVICE, "serializePageNavigatorOverrides", [[{ sheetId: pubDetail.sheetId, sheetName: "Detail", text: "Details" }]]);
    await invoke(page, "set_control_property", {
      sheetIndex: pubSales.index, row: pubNav.row, col: pubNav.col, controlType: "pageNavigator",
      propertyName: "pageOverrides", valueType: "static", value: overrides,
    });
    await seamCreateButton(page, { sheetIndex: pubSales.index, x: 40, y: 120, width: 120, height: 32, label: "To detail", action: { kind: "navigate", sheetId: pubDetail.sheetId, sheetName: "Detail" } });
    const published = await publishNew(page, ws, app, "1.0.0", [pubSales.index, pubDetail.index]);
    expect(published.version, `precondition: ${app} was published`).toBe("1.0.0");

    // ---- The subscriber owns a "Detail" already, so the pulled one becomes "Detail (2)".
    await newFile(page);
    await renameSheetByName(page, "Sheet1", "Detail");
    await subscribe(page, ws, app);
    const pulled = await sheetByName(page, "Detail (2)");
    const own = await sheetByName(page, "Detail");
    expect(own.kind, "precondition: the subscriber's own Detail is its worksheet").not.toBe("canvas");
    expect(pulled.sheetId, "the pulled page and the subscriber's own Detail are one sheet").not.toBe(own.sheetId);

    const assertTargets = async (target: Sheet, label: string): Promise<void> => {
      const sales = await sheetByName(page, "Sales");
      const ctrls = await controlsWithProps(page, sales.index);
      const btn = ctrls.find((c) => c.type === "button" && prop(c.props, "action") === "navigate");
      expect(btn, `${label}: the navigate button did not arrive`).toBeTruthy();
      expect(prop(btn!.props, "actionTarget"), `${label}: the button's target is not the local id of "${target.name}"`).toBe(target.sheetId);
      expect(prop(btn!.props, "actionTargetName"), `${label}: the button's target name`).toBe(target.name);
      const navRow = ctrls.find((c) => c.type === "pageNavigator");
      expect(navRow, `${label}: the navigator did not arrive`).toBeTruthy();
      const list = await parseOverrides(page, prop(navRow!.props, "pageOverrides"));
      expect(list, `${label}: the navigator's override`).toHaveLength(1);
      expect(list[0], `${label}: the override is not re-aimed at the local "${target.name}"`).toMatchObject({ sheetId: target.sheetId, sheetName: target.name, text: "Details" });

      // Pressing the item AND the button both land on the target, never on the subscriber's own Detail.
      await goTo(page, sales.sheetId!);
      const navId = await callModule<string>(page, MOD.CONTROLS_FLOATING_STORE, "makeFloatingControlId", [sales.index, navRow!.row, navRow!.col]);
      const d = await waitNav(page, navId, (x) => x.items.some((i) => i.caption === "Details"), `${label}: no item is captioned "Details"`);
      const item = d.items.find((i) => i.caption === "Details")!;
      expect(item.sheetId, `${label}: the "Details" item is not the target page`).toBe(target.sheetId);
      await clickItem(page, item);
      await eventually(() => activeIndex(page), (i) => i === target.index, `${label}: the navigator's item did not open "${target.name}"`);
      await goTo(page, sales.sheetId!);
      await page.waitForTimeout(400);
      await clickControlCentre(page, btn!.props);
      const landed = await eventually(() => sheetsResult(page), (r) => r.activeIndex === target.index, `${label}: the navigate button did not open "${target.name}"`);
      const onScreen = landed.sheets.find((s) => s.index === landed.activeIndex);
      expect(onScreen?.sheetId, `${label}: the button landed on another sheet than "${target.name}"`).toBe(target.sheetId);
      expect(onScreen?.sheetId, `${label}: the button landed on the subscriber's own Detail`).not.toBe(own.sheetId);
    };
    await assertTargets(pulled, "subscribe");

    // ---- The subscriber renames its pulled page; the publisher pushes 1.1.0 (a new gap); the subscriber refreshes.
    await renameSheetByName(page, "Detail (2)", "Detail Local");
    const subFile = path.join(WORK, "subscriber.cala");
    await invoke(page, "save_file", { path: subFile });

    await newFile(page);
    await checkout(page, ws, app);
    const coSales = await sheetByName(page, "Sales");
    const coNav = (await controlsWithProps(page, coSales.index)).find((c) => c.type === "pageNavigator");
    expect(coNav, "precondition: the working copy carries the navigator").toBeTruthy();
    await invoke(page, "set_control_property", {
      sheetIndex: coSales.index, row: coNav!.row, col: coNav!.col, controlType: "pageNavigator",
      propertyName: "gap", valueType: "static", value: "12",
    });
    const pushed = await push(page, ws, app, "1.1.0");
    expect(pushed.version).toBe("1.1.0");

    await openAt(page, subFile);
    const preview = await refreshPreview(page);
    const row = preview.subscriptionPreviews.find((p) => p.packageName === app);
    expect(row?.newVersion, "the refresh preview does not offer 1.1.0").toBe("1.1.0");
    await refreshApply(page, preview);
    const salesAfter = await sheetByName(page, "Sales");
    const refreshedNav = (await controlsWithProps(page, salesAfter.index)).find((c) => c.type === "pageNavigator");
    expect(prop(refreshedNav!.props, "gap"), "the refresh did not replace the navigator (no new gap)").toBe("12");
    await assertTargets(await sheetByName(page, "Detail Local"), "refresh");
    await newFile(page);
  });
});
