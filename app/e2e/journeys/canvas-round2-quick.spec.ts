/**
 * CANVAS ROUND 2, PACKAGE P1 ("quick"), LIVE, AGAINST THE OWNER'S
 * ADVENTUREWORKS MODEL (2026-10-16).
 *
 * Two owner findings, each proved end to end against the REAL backend, the real
 * Postgres model and the real pointer (spec: scratchpad r2/specs/P1-quick.md,
 * section 5):
 *
 *   G1 "the chart background colour does nothing". Three colour pickers each
 *      hand-rolled the OS picker wrong (a controlled restore that made the
 *      native `change` see "same colour"; a commit diffed against the draft the
 *      preview had already moved; a commit on every `input`). They now share
 *      `_shared/components/colorPick/useNativeColorPick`: every `input` step
 *      PREVIEWS, the native `change` COMMITS once. The plot area no longer
 *      paints its own #fafafa over the visual container, a solid pick clears a
 *      stored gradient and turns the background on, and a style preset no
 *      longer leaves the previous preset's axis/title colours behind (BUG-0489).
 *      -> Q1..Q8.
 *   G2-A "a ribbon filter on a schema-qualified table shows no values". The
 *      field key `BI.dim_date.year` was split at its FIRST dot (table "BI"),
 *      and the failure was swallowed into "No matching values". The key is now
 *      split against the model's own table list, a failure is SHOWN with a
 *      Retry, and the ribbon concept is called "dependent filters" everywhere.
 *      -> F1..F4.
 *
 * WHAT IS ASSERTED. Persisted state (the backend's chart specs and ribbon
 * filters, the undo label, the dirty flag), the DOM (the Format rows, the
 * filter checklist and its test hooks), and RELATIVE pixel samples
 * (e2e/viewportSample.ts, cropped from ONE unclipped capture): the plot's MODE
 * colour, corner patches of the visual, the page beside it, and an untouched
 * control chart. Never a golden (R14: the goldens are stale by owner decision,
 * and this display is DPR 2). Every expected filter value comes from the model
 * through the backend's own commands, never typed in.
 *
 * HOW A PICK IS DRIVEN. The OS picker cannot be scripted from the page, so
 * Q1..Q6 and Q8 fire the two events Chromium fires when ChooseColor closes on a
 * colour -- `input`, one frame, `change` -- on the real `<input type="color">`,
 * with the value written through the NATIVE setter (React's value tracker would
 * otherwise swallow the `input`). Q7 drives the REAL picker: in WebView2 that is
 * Chromium's in-page colour popup, not the OS ChooseColor (measured 2026-10-17),
 * driven through the page keyboard (see Q7).
 *
 * THE SCENE (built by Q0; the steps run in order, `mode: "serial"`).
 * File > New; Sheet1 A1:B4 = Region / Units (three rows) and a RANGE bar chart
 * "RCH" over it; the owner's AdventureWorks connection (probed: an unreachable
 * server FAILS Q0, never a skip); a canvas shown at 70 % (grid and snap off)
 * holding
 *   BAR   a design-query bar (territorygroup x [Revenue])    (80, 80, 520 x 320)
 *   MROW  a multi-row card on the same query                 (640, 80, 320 x 320)
 *   BAR2  a second design-query bar, never touched (control)  (80, 440, 520 x 260)
 * Objects are selected by the J7 route: a click at (24, 24) inside the visual,
 * the frame/title band, never a datum.
 *
 * DELIBERATE DEPARTURES FROM THE SPEC TEXT, each checked against the code:
 *   - The scene is built by a test (Q0), as object-pane-format.spec.ts builds
 *     its J0, not in `beforeAll`: the appPage fixture's per-test guards (wedge,
 *     focus, task-pane reset) only run around a TEST, and a failed scene is then
 *     reported as a failure instead of skipping every step silently.
 *   - BAR2 is 260 high, not 300: the canvas page is 720 high, and (80, 440) +
 *     300 would hang 20 px below the page.
 *   - Sheet1's table is written with `update_cell` (object-pane-format's
 *     `writeActive`), not `setCellValueDirect`, which emits no
 *     `app:cells-updated` (memory note), so the range chart could read nothing.
 *   - Q1 / Q2 / Q8 SAVE the workbook first (save_file marks it clean), so "the
 *     pick dirties the document" and "a preview does not" are measured from a
 *     clean flag instead of a flag that set-up already raised.
 *   - Q2 also asserts the preview is SHOWN while it runs: without that positive
 *     control "the input wrote nothing" would pass for an input that never
 *     reached the picker at all.
 *   - "Distance" for a colour is the Euclidean RGB distance; "equal within 6"
 *     is the largest channel difference.
 *
 * RUNNING IT. P1 changed Rust (the ribbon-filter rename S6, the container
 * literal door S2), so launch manually (`E2E_MANUAL=1`, no `--reporter`; memory
 * note "E2E after a Rust change") with
 * CARGO_TARGET_DIR=C:/Users/Salle/AppData/Local/calcula-target, and confirm
 * global-setup printed a binary built after P1. Postgres must be up.
 *
 * SABOTAGES FOR THE PROOF PHASE: the table in P1-quick.md section 5 (X1..X10).
 * Confirm each sabotage changed behaviour before reading the failure.
 */
import type { Locator, Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import {
  addCanvas,
  callModule,
  clickSheetTab,
  createChart,
  dismissToasts,
  eventually,
  gridKey,
  humanClick,
  installAppImport,
  invoke,
  isDirty,
  newFile,
  openFileAtPath,
  patchActiveCanvas,
  persistedCharts,
  selectedObjects,
  sheetPointToPage,
  sheetsResult,
  undoState,
  type PersistedChart,
} from "../helpers/canvas-live";
import { dropAdventureWorks, type AwConnection } from "../helpers/adventureworks-live";
import {
  REGION_TYPE,
  clickRegion,
  closeObjectPaneQuietly,
  closeTaskPanes,
  connectAdventureWorksProbed,
  contentRectOf,
  expandFormatCard,
  formatInput,
  hexRgb,
  nearestColour,
  openFormat,
  openPaneTab,
  regionWhere,
  restoreObjectPaneMemory,
  setFormatToggle,
  sheetClip,
  showFormatSection,
  waitPane,
  type LiveRegion,
  type PaneState,
} from "../helpers/object-pane";
import { samplePixelGrids, type PixelClip, type PixelSample } from "../viewportSample";

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

const RUN = Date.now().toString(36);
const CONNECTION_NAME = `AW (round 2 quick ${RUN})`;
const ZOOM_PERCENT = 70;
const DOC = path.join(os.tmpdir(), `calcula-round2-quick-${RUN}.cala`);

const BAR_AT = { x: 80, y: 80, width: 520, height: 320 };
const MROW_AT = { x: 640, y: 80, width: 320, height: 320 };
const BAR2_AT = { x: 80, y: 440, width: 520, height: 260 };
/** An empty point of the canvas page (sheet px): a click there selects nothing. */
const EMPTY_AT = { x: 1150, y: 650 };
/** The page between BAR and MROW (sheet px): what "no background" looks like. */
const PAGE_AT = { x: 612, y: 200 };

const DSL = "ROWS: BI.dim_territory.territorygroup\nVALUES: [Revenue]";
const SHEET1_TABLE: string[][] = [
  ["Region", "Units"],
  ["North", "10"],
  ["South", "40"],
  ["East", "20"],
];
const RCH_AT = { x: 300, y: 20, width: 360, height: 220 };

/** The fields F1..F4 filter on (schema-qualified tables: the first dot is the SCHEMA's). */
const YEAR_FIELD = "BI.dim_date.year";
const GROUP_FIELD = "BI.dim_territory.territorygroup";
const COUNTRY_FIELD = "BI.dim_territory.countryregioncode";
const MISSING_COLUMN_FIELD = "BI.dim_territory.no_such_column";
const MISSING_TABLE_FIELD = "BI.dim_dat.year";
const EUROPE = "Europe";

const FILTER_STORE = "/extensions/ControlsPane/lib/filterPaneStore.ts";

interface Scene {
  conn: AwConnection;
  sheet1Index: number;
  canvasIndex: number;
  barId: string;
  mrowId: string;
  bar2Id: string;
  rchId: string;
  rchSeriesName: string;
  /** F1: the year filter made through Controls > Add > Filter. */
  yearFilterId: string | null;
  groupFilterId: string | null;
  countryFilterId: string | null;
}

let scene: Scene | null = null;
let connHeld: AwConnection | null = null;

function need(): Scene {
  if (!scene) throw new Error("the scene was not built (Q0 failed); every later step needs it");
  return scene;
}

// ---------------------------------------------------------------------------
// Reading the app
// ---------------------------------------------------------------------------

/**
 * Run an EXTENSION command (`ExtensionRegistry.registerCommand`, which is how
 * Charts registers chart.setGradientFill / chart.applyStyle). `executeCommand`
 * goes through `CommandRegistry` (@api/commands), a different registry that
 * only warns "No handler registered" for these ids -- so a step driven through
 * it changed nothing and then waited 8 s for state that could never come.
 * An id with no live registration FAILS here instead of passing silently.
 */
async function runExtensionCommand(page: Page, id: string, arg: unknown): Promise<void> {
  await installAppImport(page);
  const found = await page.evaluate(
    async ({ id, arg }) => {
      const imp = (window as unknown as { __appImport: (m: string) => Promise<unknown> }).__appImport;
      const m = (await imp("/src/api/extensions.ts")) as {
        ExtensionRegistry: { getCommand: (id: string) => { execute: (ctx: unknown) => unknown } | undefined };
      };
      const cmd = m.ExtensionRegistry.getCommand(id);
      if (!cmd) return false;
      await cmd.execute(arg);
      return true;
    },
    { id, arg },
  );
  if (!found) throw new Error(`no extension command "${id}" is registered`);
}

async function chartRow(page: Page, id: string): Promise<PersistedChart> {
  const c = (await persistedCharts(page)).find((x) => x.id === id);
  if (!c) throw new Error(`the backend holds no chart ${id}`);
  return c;
}

interface StoredBackground {
  color?: string | null;
  show?: boolean;
  gradient?: unknown;
}

async function storedBackground(page: Page, id: string): Promise<StoredBackground> {
  const spec = (await chartRow(page, id)).spec as { container?: { background?: StoredBackground } };
  return spec.container?.background ?? {};
}

async function storedColour(page: Page, id: string): Promise<string | null> {
  const c = (await storedBackground(page, id)).color;
  return typeof c === "string" && c !== "" ? c.toLowerCase() : null;
}

async function activeIndex(page: Page): Promise<number> {
  return (await sheetsResult(page)).activeIndex;
}

/** Member keys of a `bi_get_column_values` answer: a plain string before P2, a `{ key }` MemberRef after. */
function memberKeys(r: unknown[]): string[] {
  return r.map((m) => (typeof m === "string" ? m : String((m as { key: unknown }).key)));
}

// ---------------------------------------------------------------------------
// Colours and pixels
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

function distance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function maxChannel(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

function hex(rgb: Rgb): string {
  return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/**
 * The most frequent colour among an n x n grid of points of a sample, bucketed
 * to 8 levels per channel; returns the AVERAGE of the points in that bucket (so
 * a distance against an exact hex stays meaningful).
 */
function modeOf(s: PixelSample, n: number): Rgb {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = Math.min(s.width - 1, Math.floor(((i + 0.5) / n) * s.width));
      const y = Math.min(s.height - 1, Math.floor(((j + 0.5) / n) * s.height));
      const k = (y * s.width + x) * 4;
      const r = s.data[k];
      const g = s.data[k + 1];
      const b = s.data[k + 2];
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      const e = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      e.count++;
      e.r += r;
      e.g += g;
      e.b += b;
      buckets.set(key, e);
    }
  }
  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const e of buckets.values()) if (!best || e.count > best.count) best = e;
  if (!best) return [0, 0, 0];
  return [best.r / best.count, best.g / best.count, best.b / best.count];
}

/** The PLOT clip of a region: the central 60 % of its content rect. */
async function plotClip(page: Page, regionId: string): Promise<PixelClip> {
  const c = await contentRectOf(page, regionId);
  return sheetClip(page, c.x + c.width * 0.2, c.y + c.height * 0.2, c.width * 0.6, c.height * 0.6);
}

/** A 4 x 4 sheet-px patch inset 5 px from one corner of a region's outer rect (inside its border). */
async function cornerClip(page: Page, r: LiveRegion, corner: "topRight" | "bottomRight" | "bottomLeft"): Promise<PixelClip> {
  const f = r.floating;
  const x = corner === "bottomLeft" ? f.x + 5 : f.x + f.width - 9;
  const y = corner === "topRight" ? f.y + 5 : f.y + f.height - 9;
  return sheetClip(page, x, y, 4, 4);
}

async function pageClip(page: Page): Promise<PixelClip> {
  return sheetClip(page, PAGE_AT.x, PAGE_AT.y, 4, 4);
}

/** Mode colours of several clips, cropped from ONE capture (n x n points each). */
async function modes(page: Page, clips: PixelClip[], n = 15): Promise<Rgb[]> {
  const samples = await samplePixelGrids(page, clips);
  return samples.map((s) => modeOf(s, n));
}

/** `plotMode(regionId)` of the spec: the most frequent colour of the plot's central 60 %. */
async function plotMode(page: Page, regionId: string): Promise<Rgb> {
  return (await modes(page, [await plotClip(page, regionId)]))[0];
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

async function ensureZoom(page: Page): Promise<void> {
  const geo = await readGridGeometry(page);
  if (Math.abs(geo.zoom - ZOOM_PERCENT / 100) < 0.01) return;
  await callModule(page, "/src/api/grid.ts", "setZoomLevel", [ZOOM_PERCENT]);
  await eventually(() => readGridGeometry(page), (g) => Math.abs(g.zoom - ZOOM_PERCENT / 100) < 0.01, `the canvas did not zoom to ${ZOOM_PERCENT}%`);
  await page.waitForTimeout(200);
}

async function onCanvas(page: Page): Promise<void> {
  const s = need();
  if ((await activeIndex(page)) !== s.canvasIndex) {
    await clickSheetTab(page, s.canvasIndex);
    await eventually(() => activeIndex(page), (i) => i === s.canvasIndex, "the canvas did not become the active sheet");
  }
  await ensureZoom(page);
}

async function onSheet1(page: Page): Promise<void> {
  const s = need();
  if ((await activeIndex(page)) !== s.sheet1Index) {
    await clickSheetTab(page, s.sheet1Index);
    await eventually(() => activeIndex(page), (i) => i === s.sheet1Index, "Sheet1 did not become the active sheet");
  }
}

function chartRegion(page: Page, chartId: string): Promise<LiveRegion> {
  return regionWhere(page, (r) => r.type === REGION_TYPE.chart && r.data.chartId === chartId, `chart ${chartId}`);
}

/** Click the empty page: nothing selected, the pane closes (also clears selection handles off the pixels). */
async function deselectAll(page: Page): Promise<void> {
  const p = await sheetPointToPage(page, EMPTY_AT.x, EMPTY_AT.y);
  await humanClick(page, p.x, p.y);
  await eventually(() => selectedObjects(page), (s) => s.length === 0, "a click on the empty page left an object selected");
  await waitPane(page, (s) => !s.open, "with nothing selected the object pane is still open");
  await page.waitForTimeout(300);
}

/** Select a chart by the J7 route (a fresh click at 24,24) and wait until the pane shows it. */
async function selectChart(page: Page, chartId: string): Promise<PaneState> {
  await deselectAll(page);
  const r = await chartRegion(page, chartId);
  await clickRegion(page, r, { dx: 24, dy: 24 });
  return waitPane(page, (s) => s.open && s.regionId === r.id, `a click on chart ${chartId} did not open the object pane on it`);
}

/** The chart's Format > General > Effects card, its Background swatch on screen. */
async function openEffects(page: Page, chartId: string): Promise<Locator> {
  await selectChart(page, chartId);
  await openFormat(page, "general");
  await expandFormatCard(page, "effects");
  const swatch = formatInput(page, "background.color");
  await swatch.waitFor({ state: "visible", timeout: 8000 });
  return swatch;
}

async function undo(page: Page): Promise<void> {
  await gridKey(page, "Control+z");
  await page.waitForTimeout(600);
}

async function redo(page: Page): Promise<void> {
  await gridKey(page, "Control+y");
  await page.waitForTimeout(600);
}

/** save_file to the journey's temp document: the dirty flag is then CLEAN (mark_saved). */
async function saveClean(page: Page): Promise<void> {
  const res = await invoke<{ success?: boolean } | null>(page, "save_file", { path: DOC });
  expect(res === null || res?.success !== false, `save_file refused: ${JSON.stringify(res)}`).toBe(true);
  await eventually(() => isDirty(page), (d) => !d, "save_file left the document dirty");
}

/**
 * Fire the events Chromium fires when the OS picker reports a colour, on the
 * REAL `<input type="color">` (the locator, or the colour input inside it):
 * the value is written through the native setter (React's value tracker would
 * swallow an `input` after a plain `el.value = ...`), then `input` (bubbling),
 * one animation frame, then `change`.
 */
async function firePick(loc: Locator, hexValue: string, opts: { input: boolean; change: boolean; focus?: boolean }): Promise<void> {
  await loc.evaluate(
    async (node, a) => {
      const el = (node instanceof HTMLInputElement ? node : node.querySelector('input[type="color"]')) as HTMLInputElement | null;
      if (!el) throw new Error("firePick: no colour input here");
      if (a.focus) el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, a.hex);
      if (a.input) el.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (a.change) el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { hex: hexValue, input: opts.input, change: opts.change, focus: opts.focus ?? false },
  );
  await loc.page().waitForTimeout(300);
}

/** The `value` an `<input type="color">` (or the one inside the locator) shows. */
async function swatchValue(loc: Locator): Promise<string> {
  return loc.evaluate((node) => {
    const el = (node instanceof HTMLInputElement ? node : node.querySelector('input[type="color"]')) as HTMLInputElement | null;
    return el ? el.value.toLowerCase() : "";
  });
}

// ---- The Controls ribbon tab and the filter checklist ----

async function ensureControlsTab(page: Page): Promise<void> {
  const add = page.locator('[data-testid="controls-pane-add"]').first();
  if (await add.isVisible().catch(() => false)) return;
  const strip = page.locator("[data-ribbon-content]").locator("xpath=..");
  await strip.locator("button", { hasText: /^Controls$/ }).first().click();
  await add.waitFor({ state: "visible", timeout: 8000 });
}

async function filterCardIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid="controls-pane-filter-open"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-filter-id") ?? ""));
}

function dropdown(page: Page): Locator {
  return page.locator('[data-testid="controls-pane-filter-dropdown"]');
}

async function closeFilterDropdown(page: Page): Promise<void> {
  if ((await dropdown(page).count()) === 0) return;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  if ((await dropdown(page).count()) > 0) {
    await dropdown(page).getByRole("button", { name: "Cancel", exact: true }).first().click();
  }
  await expect(dropdown(page), "the filter checklist did not close").toHaveCount(0, { timeout: 5000 });
}

/** Open one card's checklist and wait until it shows its values OR why it could not. */
async function openFilter(page: Page, filterId: string): Promise<void> {
  await closeFilterDropdown(page);
  await ensureControlsTab(page);
  await page.locator(`[data-testid="controls-pane-filter-open"][data-filter-id="${filterId}"]`).click();
  await dropdown(page).waitFor({ state: "visible", timeout: 8000 });
  await eventually(
    async () => ({
      items: await dropdown(page).locator('[data-testid="controls-pane-filter-item"]').count(),
      error: await dropdown(page).locator('[data-testid="controls-pane-filter-items-error"]').count(),
    }),
    (v) => v.items > 0 || v.error > 0,
    `the checklist of filter ${filterId} showed neither values nor an error`,
    60_000,
  );
}

async function shownItems(page: Page): Promise<Array<{ value: string; hasData: string }>> {
  return dropdown(page)
    .locator('[data-testid="controls-pane-filter-item"]')
    .evaluateAll((els) => els.map((e) => ({ value: e.getAttribute("data-value") ?? "", hasData: e.getAttribute("data-has-data") ?? "" })));
}

/** A ribbon filter through the store's own door (F1's second filter, F2/F3's extras). */
async function createFilterViaStore(page: Page, name: string, fieldName: string): Promise<string> {
  const s = need();
  const before = await filterCardIds(page);
  const f = await callModule<{ id: string } | null>(page, FILTER_STORE, "createFilterAsync", [{ name, connectionId: s.conn.connectionId, fieldName }]);
  expect(f, `createFilterAsync refused ${fieldName}`).toBeTruthy();
  await ensureControlsTab(page);
  await eventually(() => filterCardIds(page), (ids) => ids.includes(f!.id) && ids.length === before.length + 1, `the card of ${fieldName} never appeared in the Controls tab`);
  return f!.id;
}

// ===========================================================================

test.describe("canvas round 2, P1: one commit per colour pick, a transparent plot, presets, and ribbon filter values on schema-qualified tables (live, AdventureWorks)", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test.afterAll(async ({ sharedPage: page }) => {
    await page.keyboard.press("Escape").catch(() => undefined);
    await restoreObjectPaneMemory(page).catch(() => undefined);
    await dismissToasts(page).catch(() => undefined);
    await closeObjectPaneQuietly(page).catch(() => undefined);
    await newFile(page).catch(() => undefined);
    await dropAdventureWorks(page, connHeld);
    // A reopen re-creates the connection from the file: drop every one of this journey's name.
    const conns = await invoke<Array<{ id: string; name: string }>>(page, "bi_get_connections").catch(() => []);
    for (const c of conns) {
      if (c.name === CONNECTION_NAME) await invoke(page, "bi_delete_connection", { connectionId: c.id }).catch(() => undefined);
    }
    fs.rmSync(DOC, { force: true });
    // The leaked-pane rule: prove the task-pane container hidden before the next spec runs.
    const panes = await closeTaskPanes(page);
    expect(panes.isOpen, `a task pane is still open after the journey: ${JSON.stringify(panes)}`).toBe(false);
  });

  // -------------------------------------------------------------------------
  test("Q0 the scene: Sheet1 table and a range chart; AdventureWorks connected and probed; a canvas with BAR, MROW and the control BAR2", async ({ appPage: page }) => {
    await installAppImport(page);
    await restoreObjectPaneMemory(page);
    await newFile(page);
    const first = await sheetsResult(page);
    const sheet1 = first.sheets[first.activeIndex];
    for (let r = 0; r < SHEET1_TABLE.length; r++) {
      for (let c = 0; c < SHEET1_TABLE[r].length; c++) {
        await invoke(page, "update_cell", { row: r, col: c, value: SHEET1_TABLE[r][c] });
      }
    }
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    const rchId = await createChart(
      page,
      {
        mark: "bar",
        data: { sheetIndex: sheet1.index, ...(sheet1.sheetId ? { sheetId: sheet1.sheetId } : {}), startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
        title: "Units",
      },
      { sheetIndex: sheet1.index, ...RCH_AT, name: "RCH" },
    );
    const rchSpec = (await chartRow(page, rchId)).spec as { series?: Array<{ name?: string }> };
    const rchSeriesName = rchSpec.series?.[0]?.name ?? "";
    expect(rchSeriesName, "the range chart has no named first series").not.toBe("");

    const probed = await connectAdventureWorksProbed(page, CONNECTION_NAME);
    connHeld = probed.conn;

    const canvas = await addCanvas(page);
    await patchActiveCanvas(page, { showGrid: false, snapToGrid: false });
    await ensureZoom(page);
    const designBar = (title: string): Record<string, unknown> => ({
      mark: "bar",
      data: { type: "designQuery", dslText: DSL, connectionId: probed.conn.connectionId },
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [],
      title,
    });
    const barId = await createChart(page, designBar("Revenue"), { sheetIndex: canvas.index, ...BAR_AT, name: "BAR" }, { waitPaint: false });
    const mrowId = await createChart(
      page,
      { ...designBar("Revenue rows"), mark: "multiRowCard" },
      { sheetIndex: canvas.index, ...MROW_AT, name: "MROW" },
      { waitPaint: false },
    );
    const bar2Id = await createChart(page, designBar("Control"), { sheetIndex: canvas.index, ...BAR2_AT, name: "BAR2" }, { waitPaint: false });
    scene = {
      conn: probed.conn,
      sheet1Index: sheet1.index,
      canvasIndex: canvas.index,
      barId,
      mrowId,
      bar2Id,
      rchId,
      rchSeriesName,
      yearFilterId: null,
      groupFilterId: null,
      countryFilterId: null,
    };
    // Wait for paint: every visual's plot stops being the empty page.
    for (const id of [barId, mrowId, bar2Id]) {
      await eventually(
        () => callModule<{ data?: { categories?: string[] } } | null>(page, "/extensions/Charts/rendering/chartRenderer.ts", "getCachedChartData", [id]),
        (d) => !!d && (d.data?.categories ?? []).includes(EUROPE),
        `chart ${id} never painted the model's territory groups`,
        60_000,
      );
    }
    await deselectAll(page);
  });

  // -------------------------------------------------------------------------
  test("Q1 the Format tab's Background swatch commits ONCE on change; the whole visual (plot interior too) turns green; BAR2 is untouched; one Ctrl+Z / Ctrl+Y step", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await deselectAll(page);
    const bar = await chartRegion(page, s.barId);
    const bar2 = await chartRegion(page, s.bar2Id);
    const [plotBefore, bar2Before] = await modes(page, [await plotClip(page, bar.id), await plotClip(page, bar2.id)]);
    expect(distance(plotBefore, hexRgb("#ffffff")), `BAR's plot is ${hex(plotBefore)} before the pick, not the near-white default`).toBeLessThanOrEqual(40);
    const colourBefore = await storedColour(page, s.barId);
    await saveClean(page);

    const swatch = await openEffects(page, s.barId);
    await firePick(swatch, "#1b5e20", { input: true, change: true });
    await eventually(() => storedColour(page, s.barId), (c) => c === "#1b5e20", "the picked #1b5e20 did not persist in spec.container.background.color");
    expect((await undoState(page)).undoDescription, 'the pick is not a "Format Object" step').toBe("Format Object");
    expect(await isDirty(page), "the pick did not dirty the document").toBe(true);

    await deselectAll(page);
    const green = hexRgb("#1b5e20");
    const [plotAfter, cornerAfter, bar2After] = await eventually(
      async () => modes(page, [await plotClip(page, bar.id), await cornerClip(page, bar, "bottomRight"), await plotClip(page, bar2.id)], 15),
      (m) => distance(m[0], green) <= 40,
      "the PLOT interior of BAR did not turn #1b5e20 (the plot area still paints its own fill over the visual's background)",
    );
    expect(distance(plotAfter, green)).toBeLessThanOrEqual(40);
    expect(distance(cornerAfter, green), `the visual's corner is ${hex(cornerAfter)}, not the picked green`).toBeLessThanOrEqual(40);
    expect(maxChannel(bar2After, bar2Before), `the control BAR2 changed (${hex(bar2Before)} -> ${hex(bar2After)})`).toBeLessThanOrEqual(6);

    // ONE Ctrl+Z restores; Ctrl+Y re-applies; a SECOND Ctrl+Z restores and leaves no second "Format Object".
    await undo(page);
    await eventually(() => storedColour(page, s.barId), (c) => c === colourBefore, `ONE Ctrl+Z did not restore ${colourBefore}`);
    await eventually(() => plotMode(page, bar.id), (m) => distance(m, plotBefore) <= 12, "after Ctrl+Z the plot does not look as before");
    await redo(page);
    await eventually(() => storedColour(page, s.barId), (c) => c === "#1b5e20", "Ctrl+Y did not re-apply #1b5e20");
    await undo(page);
    await eventually(() => storedColour(page, s.barId), (c) => c === colourBefore, "the second Ctrl+Z did not restore the colour");
    expect((await undoState(page)).undoDescription, "the pick left a SECOND Format Object step behind it (one step per input?)").not.toBe("Format Object");
  });

  // -------------------------------------------------------------------------
  test("Q2 an input alone only PREVIEWS: the chart shows it, nothing is written, the undo label and the clean flag stay; a blur ends the preview", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await deselectAll(page);
    const bar = await chartRegion(page, s.barId);
    const plotStored = await plotMode(page, bar.id);
    const before = JSON.stringify((await chartRow(page, s.barId)).spec);
    await saveClean(page);
    const swatch = await openEffects(page, s.barId);
    const undoBefore = (await undoState(page)).undoDescription;

    await firePick(swatch, "#880e4f", { input: true, change: false, focus: true });
    // Positive control: the input REACHED the picker (the chart previews it).
    await eventually(() => plotMode(page, bar.id), (m) => distance(m, hexRgb("#880e4f")) <= 60, "the input step was not previewed on the chart (did it reach the picker at all?)");
    expect(JSON.stringify((await chartRow(page, s.barId)).spec), "an input alone wrote the spec").toBe(before);
    expect((await undoState(page)).undoDescription, "an input alone pushed an undo step").toBe(undoBefore);
    expect(await isDirty(page), "an input alone dirtied the document").toBe(false);

    // Blur (focus the hex box): the preview ends, the plot shows the stored colour again.
    await formatInput(page, "background.color-hex").focus();
    await eventually(() => plotMode(page, bar.id), (m) => distance(m, plotStored) <= 12, "the blur did not end the preview");
    expect(JSON.stringify((await chartRow(page, s.barId)).spec), "the blur wrote the spec").toBe(before);
    expect(await isDirty(page), "the blur dirtied the document").toBe(false);
  });

  // -------------------------------------------------------------------------
  test("Q3 the Chart elements card's Chart area Background: unset it shows #ffffff; input previews only; change writes ONE Format Object step; the swatch then shows the stored colour", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await selectChart(page, s.barId);
    await openPaneTab(page, "format");
    await showFormatSection(page, "visual");
    const card = page.locator('[data-testid="chart-format-pane"]');
    await card.waitFor({ state: "visible", timeout: 8000 });
    const swatch = card.locator('input[type="color"][aria-label="Background"]');
    await swatch.waitFor({ state: "visible", timeout: 8000 });

    // Unset first: "Reset" (shown only while a colour is stored).
    const reset = card.getByRole("button", { name: "Reset", exact: true });
    if ((await reset.count()) > 0) {
      await reset.first().click();
      await eventually(() => storedColour(page, s.barId), (c) => c === null, "Reset did not clear the stored chart-area colour");
    }
    expect(await swatchValue(swatch), "with no colour stored the swatch does not show the container default #ffffff").toBe("#ffffff");

    const before = JSON.stringify((await chartRow(page, s.barId)).spec);
    const undoBefore = (await undoState(page)).undoDescription;
    await firePick(swatch, "#0d47a1", { input: true, change: false });
    expect(JSON.stringify((await chartRow(page, s.barId)).spec), "an input on the Chart elements card wrote the spec").toBe(before);
    expect((await undoState(page)).undoDescription, "an input on the Chart elements card pushed an undo step").toBe(undoBefore);

    await swatch.evaluate((el) => el.dispatchEvent(new Event("change", { bubbles: true })));
    await eventually(() => storedColour(page, s.barId), (c) => c === "#0d47a1", "the change did not persist #0d47a1");
    expect((await undoState(page)).undoDescription, 'the commit is not a "Format Object" step').toBe("Format Object");
    await eventually(() => swatchValue(swatch), (v) => v === "#0d47a1", "the swatch does not show the stored colour after the commit");

    // Exactly ONE new step: one Ctrl+Z goes back to the unset colour, Ctrl+Y puts it back.
    await undo(page);
    await eventually(() => storedColour(page, s.barId), (c) => c === null, "ONE Ctrl+Z did not take the pick back (more than one step per pick?)");
    await redo(page);
    await eventually(() => storedColour(page, s.barId), (c) => c === "#0d47a1", "Ctrl+Y did not re-apply #0d47a1");
  });

  // -------------------------------------------------------------------------
  test("Q4 a solid pick clears a stored gradient and a switched-off background turns back on", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await deselectAll(page);
    const bar = await chartRegion(page, s.barId);
    await runExtensionCommand(page, "chart.setGradientFill", {
      chartId: s.barId,
      target: "chartBackground",
      gradient: { type: "linear", direction: "topToBottom", stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] },
    });
    await eventually(() => storedBackground(page, s.barId), (b) => b.gradient !== undefined && b.gradient !== null, "chart.setGradientFill stored no container gradient");
    const sumDist = (a: Rgb, b: Rgb): number => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    const corners = async (): Promise<Rgb[]> => modes(page, [await cornerClip(page, bar, "topRight"), await cornerClip(page, bar, "bottomRight"), await pageClip(page)], 4);
    await eventually(corners, (m) => sumDist(m[0], m[1]) > 100, "the gradient is not painted (top and bottom of the visual look alike)");

    await openEffects(page, s.barId);
    await firePick(formatInput(page, "background.color"), "#ffd54f", { input: true, change: true });
    const solid = await eventually(() => storedBackground(page, s.barId), (b) => String(b.color).toLowerCase() === "#ffd54f", "the solid #ffd54f did not persist");
    expect(solid.gradient ?? null, "the solid pick left the stored gradient in place").toBeNull();
    await deselectAll(page);
    const amber = await eventually(corners, (m) => maxChannel(m[0], m[1]) <= 6, "after the solid pick the top and bottom of the visual still differ (gradient painted)");
    expect(distance(amber[0], hexRgb("#ffd54f")), `the visual is ${hex(amber[0])}, not #ffd54f`).toBeLessThanOrEqual(40);

    // Background off: the visual shows the page.
    await openEffects(page, s.barId);
    await setFormatToggle(page, "background.show", false);
    await eventually(() => storedBackground(page, s.barId), (b) => b.show === false, "switching the background off did not persist");
    await deselectAll(page);
    await eventually(corners, (m) => maxChannel(m[1], m[2]) <= 6, "with the background off the visual's corner is not the page");

    // A pick turns it back on.
    await openEffects(page, s.barId);
    await firePick(formatInput(page, "background.color"), "#4a148c", { input: true, change: true });
    const purple = await eventually(() => storedBackground(page, s.barId), (b) => String(b.color).toLowerCase() === "#4a148c", "the pick #4a148c did not persist");
    expect(purple.show, "a solid pick on a switched-off background did not turn it on").toBe(true);
    await deselectAll(page);
    await eventually(corners, (m) => distance(m[1], hexRgb("#4a148c")) <= 40, "the visual is not purple after the pick");
  });

  // -------------------------------------------------------------------------
  test("Q5 the multi-row card's rows show the visual's background (no row-card fill of their own)", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await openEffects(page, s.mrowId);
    await firePick(formatInput(page, "background.color"), "#2e7d32", { input: true, change: true });
    await eventually(() => storedColour(page, s.mrowId), (c) => c === "#2e7d32", "the pick #2e7d32 did not persist on MROW");
    await deselectAll(page);
    const mrow = await chartRegion(page, s.mrowId);
    const c = await contentRectOf(page, mrow.id);
    // Around 70 % of the content width, inside the first row's band (the top fifth), away from the accent bar.
    const rowClip = await sheetClip(page, c.x + c.width * 0.66, c.y + c.height * 0.04, c.width * 0.08, c.height * 0.14);
    const [row] = await eventually(
      async () => modes(page, [rowClip], 9),
      (m) => nearestColour(m[0], { picked: "#2e7d32", white: "#ffffff", plotDefault: "#fafafa" }).name === "picked",
      "the multi-row card's first row does not show the visual's #2e7d32 (a row-card fill paints over it)",
    );
    expect(nearestColour(row, { picked: "#2e7d32", white: "#ffffff", plotDefault: "#fafafa" }).name).toBe("picked");
  });

  // -------------------------------------------------------------------------
  test("Q6 presets: mono-blue then colorful-1 leaves no axis / title colour behind (BUG-0489), no plot fill, a white solid background and no gradient", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await deselectAll(page);
    type PresetSpec = { config?: { theme?: Record<string, unknown> }; container?: { background?: StoredBackground } };
    const readSpec = async (): Promise<PresetSpec> => (await chartRow(page, s.barId)).spec as PresetSpec;
    await runExtensionCommand(page, "chart.applyStyle", { chartId: s.barId, presetId: "mono-blue" });
    // Positive control, and the wait: mono-blue's OWN theme keys are persisted
    // before colorful-1 runs. Both presets paint a white background, so "the
    // background is white" alone matched mono-blue's save and read the row
    // before colorful-1's debounced save landed (found live 2026-10-17).
    await eventually(readSpec, (sp) => String(sp.config?.theme?.axisColor ?? "").toLowerCase() === "#4e79a7", "mono-blue did not persist its axis colour");
    await runExtensionCommand(page, "chart.applyStyle", { chartId: s.barId, presetId: "colorful-1" });
    // colorful-1's own mark: its gridline colour (mono-blue's is #d0dce8).
    const spec = await eventually(
      readSpec,
      (sp) => String(sp.container?.background?.color ?? "").toLowerCase() === "#ffffff" && String(sp.config?.theme?.gridLineColor ?? "").toLowerCase() === "#e8e8e8",
      "colorful-1 did not write its gridline colour and a white container background",
    );
    const theme = spec.config?.theme ?? {};
    expect(theme.axisColor, "mono-blue's axis colour survived colorful-1 (BUG-0489)").toBeUndefined();
    expect(theme.titleColor, "mono-blue's title colour survived colorful-1 (BUG-0489)").toBeUndefined();
    expect(theme.plotBackground, "colorful-1 wrote a plot fill").toBeUndefined();
    expect(spec.container?.background?.gradient ?? null, "the preset left a gradient").toBeNull();
    const bar = await chartRegion(page, s.barId);
    await eventually(() => plotMode(page, bar.id), (m) => distance(m, hexRgb("#ffffff")) <= 40, "after colorful-1 the plot is not white");
  });

  // -------------------------------------------------------------------------
  test("Q7 the REAL WebView2 colour picker (Chromium popup, keyboard-driven): a pick persists #641ec8 as ONE undo step", async ({ appPage: page }, testInfo) => {
    const s = need();
    await onCanvas(page);
    const before = await storedColour(page, s.barId);
    const swatch = await openEffects(page, s.barId);
    // Count what the page observes (recorded, not asserted: how many `input` steps one native pick sends).
    await swatch.evaluate((el) => {
      const w = window as unknown as { e2eR2PickEvents?: { input: number; change: number } };
      w.e2eR2PickEvents = { input: 0, change: 0 };
      el.addEventListener("input", () => w.e2eR2PickEvents!.input++);
      el.addEventListener("change", () => w.e2eR2PickEvents!.change++);
    });
    // WHAT THE PICKER IS (measured live 2026-10-17). WebView2 does NOT open the
    // OS ChooseColor dialog for <input type="color">: it opens Chromium's own
    // colour popup (gradient square, eyedropper, hue strip, R/G/B boxes), a
    // separate widget no Win32 dialog search can find -- the ChooseColor driver
    // (`setNativeColor`) answered NOCOLORDIALOG every time. The popup takes the
    // page's KEYBOARD: three Tabs reach the R box, each box is typed, and Enter
    // chooses and closes it. Driven that way it is the REAL picker and the REAL
    // event sequence (a probe recorded 8 `input` events, one per typed digit
    // step, then ONE `change`).
    await swatch.click({ timeout: 15_000 });
    await page.waitForTimeout(800);
    for (let k = 0; k < 3; k++) await page.keyboard.press("Tab");
    const typeBox = async (v: string, last: boolean): Promise<void> => {
      await page.keyboard.press("Control+A");
      await page.keyboard.type(v);
      if (!last) await page.keyboard.press("Tab");
    };
    await typeBox("100", false);
    await typeBox("30", false);
    await typeBox("200", true);
    await page.keyboard.press("Enter");
    const driven = { output: "chromium colour popup: Tab x3, R=100 G=30 B=200, Enter" };
    await eventually(() => storedColour(page, s.barId), (c) => c === "#641ec8", `the native pick did not persist #641ec8 (driver: ${driven.output})`, 15_000);
    expect((await undoState(page)).undoDescription, 'the native pick is not a "Format Object" step').toBe("Format Object");
    const events = await page.evaluate(() => (window as unknown as { e2eR2PickEvents?: { input: number; change: number } }).e2eR2PickEvents ?? null);
    testInfo.annotations.push({ type: "native-pick-events", description: `input=${events?.input ?? "?"} change=${events?.change ?? "?"}; driver: ${driven.output.replace(/\s+/g, " ")}` });
    console.log(`[Q7] native-pick-events input=${events?.input ?? "?"} change=${events?.change ?? "?"}`);
    await undo(page);
    await eventually(() => storedColour(page, s.barId), (c) => c === before, `ONE Ctrl+Z did not restore ${before} after the native pick`);
  });

  // -------------------------------------------------------------------------
  test("Q8 a series colour picked on a range chart's Data tab persists in spec.seriesColors as ONE step and dirties the document", async ({ appPage: page }) => {
    const s = need();
    await onSheet1(page);
    await closeObjectPaneQuietly(page).catch(() => undefined);
    const r = await chartRegion(page, s.rchId);
    await clickRegion(page, r, { dx: 30, dy: 30 });
    await gridKey(page, "Control+1");
    await waitPane(page, (p) => p.open && p.regionId === r.id, "Ctrl+1 on the selected range chart opened no pane");
    await openPaneTab(page, "data");
    // The suffix is the series' SOURCE COLUMN index, not its position in the
    // list: A1:B4 with A as the category makes the one series column 1
    // (`chart-data-range-series-color-1`; found live 2026-10-17 -- "-0" never
    // existed). The first series swatch is taken whatever its column.
    const swatch = page.locator('[data-testid^="chart-data-range-series-color-"]').first();
    await swatch.waitFor({ state: "visible", timeout: 10_000 });
    await saveClean(page);
    await firePick(swatch, "#c62828", { input: true, change: true });
    const spec = await eventually(
      async () => (await chartRow(page, s.rchId)).spec as { seriesColors?: Record<string, string> },
      (sp) => String(sp.seriesColors?.[s.rchSeriesName] ?? "").toLowerCase() === "#c62828",
      `the series colour #c62828 of "${s.rchSeriesName}" did not persist in spec.seriesColors`,
    );
    expect(Object.keys(spec.seriesColors ?? {}), "the pick wrote more than the one series").toEqual([s.rchSeriesName]);
    expect((await undoState(page)).undoDescription, 'the series pick is not ONE "Edit chart data" step').toBe("Edit chart data");
    expect(await isDirty(page), "the series pick did not dirty the document").toBe(true);
    await undo(page);
    await eventually(
      async () => ((await chartRow(page, s.rchId)).spec as { seriesColors?: Record<string, string> }).seriesColors?.[s.rchSeriesName],
      (c) => c === undefined,
      "ONE Ctrl+Z did not take the series colour back",
    );
    await redo(page);
    await closeObjectPaneQuietly(page).catch(() => undefined);
    await onCanvas(page);
  });

  // -------------------------------------------------------------------------
  test("F1 Controls > Add > Filter on BI.dim_date.year lists the model's years (no first-dot split, no hidden failure); territorygroup lists its groups", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await ensureControlsTab(page);
    const before = await filterCardIds(page);

    await page.locator('[data-testid="controls-pane-add"]').first().click();
    const addFilter = page.locator('[data-testid="controls-pane-add-filter"]');
    await expect(addFilter, "Add > Filter... is not enabled with a model connection present").toBeEnabled({ timeout: 10_000 });
    await addFilter.click();
    const select = page.locator('[data-testid="controls-pane-add-filter-connection"]');
    await select.waitFor({ state: "visible", timeout: 10_000 });
    const optionValue = await select.evaluate((el, name) => {
      const opt = Array.from((el as HTMLSelectElement).options).find((o) => (o.textContent ?? "").startsWith(name));
      return opt ? opt.value : null;
    }, CONNECTION_NAME);
    expect(optionValue, `the Model Connection list has no "${CONNECTION_NAME}"`).not.toBeNull();
    await select.selectOption(optionValue!);
    const search = page.getByPlaceholder("Search fields...");
    if (await search.isVisible().catch(() => false)) await search.fill("year");
    const field = page.locator(`[data-testid="controls-pane-add-filter-field"][data-field="${YEAR_FIELD}"] input`);
    await field.waitFor({ state: "visible", timeout: 10_000 });
    await field.check();
    await page.locator('[data-testid="controls-pane-add-filter-create"]').click();
    await expect(page.locator('[data-testid="controls-pane-add-filter-create"]'), "the Add Filter dialog did not close").toHaveCount(0, { timeout: 15_000 });

    const after = await eventually(() => filterCardIds(page), (ids) => ids.length === before.length + 1, "Add Filter made no new card (or more than one)");
    const yearId = after.find((id) => !before.includes(id))!;
    s.yearFilterId = yearId;
    const f = await callModule<{ fieldName: string } | undefined>(page, FILTER_STORE, "getFilterById", [yearId]);
    expect(f?.fieldName, "the dialog composed another key").toBe(YEAR_FIELD);

    await openFilter(page, yearId);
    const years = memberKeys(await invoke<unknown[]>(page, "bi_get_column_values", { connectionId: s.conn.connectionId, table: "BI.dim_date", column: "year" }));
    expect(years.length, `the model answered fewer than 3 years: ${JSON.stringify(years)}`).toBeGreaterThanOrEqual(3);
    const shown = (await shownItems(page)).map((i) => i.value);
    expect([...shown].sort(), "the year filter does not list the model's years").toEqual([...years].sort());
    await expect(dropdown(page).locator('[data-testid="controls-pane-filter-items-error"]'), "the year filter shows a load error").toHaveCount(0);
    await expect(dropdown(page).getByText("No matching values"), 'the year filter says "No matching values"').toHaveCount(0);

    // territorygroup through the store door.
    const groupId = await createFilterViaStore(page, `R2Group${RUN}`, GROUP_FIELD);
    s.groupFilterId = groupId;
    await openFilter(page, groupId);
    const groups = memberKeys(await invoke<unknown[]>(page, "bi_get_column_values", { connectionId: s.conn.connectionId, table: "BI.dim_territory", column: "territorygroup" }));
    const shownGroups = (await shownItems(page)).map((i) => i.value);
    expect([...shownGroups].sort(), "the territorygroup filter does not list the model's groups").toEqual([...groups].sort());
    for (const g of ["Europe", "North America", "Pacific"]) {
      expect(groups, `the model has no territory group ${g}`).toContain(g);
    }
    await closeFilterDropdown(page);
  });

  // -------------------------------------------------------------------------
  test("F2 a dependent filter narrows on dotted tables: Europe on territorygroup dims every country without Europe data, and dependentFilters persists", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    expect(s.groupFilterId, "F1 made no territorygroup filter").not.toBeNull();
    const countryId = await createFilterViaStore(page, `R2Country${RUN}`, COUNTRY_FIELD);
    s.countryFilterId = countryId;

    await openFilter(page, s.groupFilterId!);
    await dropdown(page).locator('[data-testid="controls-pane-filter-dependents-open"]').click();
    const tick = dropdown(page).locator("label", { hasText: "countryregioncode" }).locator('input[type="checkbox"]');
    await tick.first().waitFor({ state: "visible", timeout: 8000 });
    await tick.first().check();
    await dropdown(page).getByRole("button", { name: "Save", exact: true }).click();
    await eventually(
      async () => (await callModule<{ dependentFilters?: string[] } | undefined>(page, FILTER_STORE, "getFilterById", [s.groupFilterId!]))?.dependentFilters ?? [],
      (d) => d.includes(countryId),
      "saving the Dependent filters panel did not store the country filter",
    );

    // Only Europe, OK.
    if ((await dropdown(page).count()) === 0) await openFilter(page, s.groupFilterId!);
    await dropdown(page).getByRole("button", { name: "Select None", exact: true }).click();
    await dropdown(page).locator(`[data-testid="controls-pane-filter-item"][data-value="${EUROPE}"] input`).check();
    await dropdown(page).getByRole("button", { name: "OK", exact: true }).click();
    await eventually(
      async () => (await callModule<{ selectedItems?: string[] | null } | undefined>(page, FILTER_STORE, "getFilterById", [s.groupFilterId!]))?.selectedItems ?? null,
      (sel) => Array.isArray(sel) && sel.length === 1 && sel[0] === EUROPE,
      "selecting only Europe and pressing OK did not store the selection",
    );
    await closeFilterDropdown(page);

    const oracle = await invoke<string[]>(page, "bi_get_column_available_values", {
      connectionId: s.conn.connectionId,
      table: "BI.dim_territory",
      column: "countryregioncode",
      constraints: [{ table: "BI.dim_territory", column: "territorygroup", values: [EUROPE] }],
    });
    expect(oracle.length, "the oracle says no country has Europe data").toBeGreaterThan(0);
    await openFilter(page, countryId);
    const items = await eventually(
      () => shownItems(page),
      (it) => it.length > 0 && [...it.filter((i) => i.hasData === "true").map((i) => i.value)].sort().join("|") === [...oracle].sort().join("|"),
      `the countryregioncode items with data are not the oracle's ${JSON.stringify(oracle)}`,
      30_000,
    );
    expect(items.some((i) => i.hasData === "false"), "no country is dimmed: the dependent filter did not narrow (all has-data true)").toBe(true);
    await expect(dropdown(page).locator('[data-testid="controls-pane-filter-narrowing-error"]'), "the checklist reports a narrowing failure").toHaveCount(0);
    await closeFilterDropdown(page);

    const persisted = await invoke<Array<{ id: string; dependentFilters?: string[] }>>(page, "get_all_ribbon_filters");
    const group = persisted.find((f) => f.id === s.groupFilterId);
    expect(group?.dependentFilters ?? [], "the backend's territory filter does not list the country filter as a dependent").toContain(countryId);
    expect(JSON.stringify(persisted), "the backend still speaks crossFilterTargets").not.toContain("crossFilterTargets");
  });

  // -------------------------------------------------------------------------
  test("F3 a failure is SHOWN with the whole field name, and Retry really retries; a dotted key naming no model table says so", async ({ appPage: page }) => {
    await onCanvas(page);
    const badId = await createFilterViaStore(page, `R2Bad${RUN}`, MISSING_COLUMN_FIELD);
    await openFilter(page, badId);
    const err = dropdown(page).locator('[data-testid="controls-pane-filter-items-error"]');
    await expect(err, "a filter on a missing column shows no error").toBeVisible();
    await expect(err).toContainText("Could not load the values of");
    await expect(err).toContainText(MISSING_COLUMN_FIELD);
    await expect(dropdown(page).locator('[data-testid="controls-pane-filter-item"]'), "a failed load still lists values").toHaveCount(0);
    await expect(dropdown(page).getByText("No matching values"), 'a failed load is shown as "No matching values"').toHaveCount(0);

    const a1 = await callModule<number>(page, FILTER_STORE, "getFilterLoadAttempts", [badId]);
    await dropdown(page).locator('[data-testid="controls-pane-filter-items-retry"]').click();
    await eventually(() => callModule<number>(page, FILTER_STORE, "getFilterLoadAttempts", [badId]), (n) => n === a1 + 1, "Retry did not run another load");
    await expect(err, "after Retry the (same) failure is no longer shown").toBeVisible();
    await closeFilterDropdown(page);

    const noTableId = await createFilterViaStore(page, `R2NoTable${RUN}`, MISSING_TABLE_FIELD);
    await openFilter(page, noTableId);
    await expect(dropdown(page).locator('[data-testid="controls-pane-filter-items-error"]'), "a key naming no model table is not refused by the table-list check").toContainText("names no table of this model");
    await closeFilterDropdown(page);
  });

  // -------------------------------------------------------------------------
  test("F4 the word: the checklist and its Dependent filters panel never say cross-filter; dependentFilters survives save and reopen", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    await openFilter(page, s.groupFilterId!);
    const word = /cross[\s-]?filter/i;
    expect(await dropdown(page).innerText(), "the filter checklist says cross-filter").not.toMatch(word);
    await dropdown(page).locator('[data-testid="controls-pane-filter-dependents-open"]').click();
    await expect(dropdown(page).getByText("Dependent filters").first()).toBeVisible();
    expect(await dropdown(page).innerText(), "the Dependent filters panel says cross-filter").not.toMatch(word);
    await closeFilterDropdown(page);

    const res = await invoke<{ success?: boolean } | null>(page, "save_file", { path: DOC });
    expect(res === null || res?.success !== false, `save_file refused: ${JSON.stringify(res)}`).toBe(true);
    await newFile(page);
    await openFileAtPath(page, DOC);
    const reopened = await eventually(
      () => invoke<Array<{ id: string; fieldName: string; dependentFilters?: string[] }>>(page, "get_all_ribbon_filters"),
      (fs2) => fs2.some((f) => f.fieldName === GROUP_FIELD),
      "after reopening there is no territorygroup filter",
      30_000,
    );
    const group = reopened.find((f) => f.fieldName === GROUP_FIELD)!;
    const country = reopened.find((f) => f.fieldName === COUNTRY_FIELD);
    expect(country, "after reopening there is no countryregioncode filter").toBeTruthy();
    expect(group.dependentFilters ?? [], "dependentFilters did not survive save and reopen").toContain(country!.id);
    expect(JSON.stringify(reopened), "the reopened filters speak crossFilterTargets").not.toContain("crossFilterTargets");
  });
});

