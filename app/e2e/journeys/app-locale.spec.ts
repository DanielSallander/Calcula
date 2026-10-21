/**
 * THE APP LOCALE EVERYWHERE (round 2, package P2, owner finding G0), LIVE,
 * AGAINST THE OWNER'S ADVENTUREWORKS MODEL.
 *
 * The owner rule (memory feedback_app_locale_everywhere.md): every display and
 * every input parse uses the APP locale -- never a fixed en-US, never the OS or
 * browser locale, never a locale that differs from its neighbour. P2 built it
 * as ONE authority in Rust (`app_locale.rs`: `%LOCALAPPDATA%\Calcula\
 * app-settings.json`, `set_locale`, the `locale:changed` event), sync helpers
 * in `@api/locale` that every window installs BEFORE its first render, and ONE
 * member shape `MemberRef { key, label }` at the backend boundary: the key is
 * invariant canonical text and is the only thing selections, page filters and
 * GETPIVOTDATA match on; the label is the app-locale display. Every unit tier
 * proved its part with the other parts doubled; this journey drives the whole
 * thing against the REAL backend, the REAL model and the REAL UI.
 * Spec: scratchpad r2/specs/P2-locale.md section 5 (J1..J12).
 *
 * LOCALE CHOICE. de-DE ("." grouping, "," decimals, ";" list separator) differs
 * from en-US AND from the owner's own sv-SE, so a value that silently stayed in
 * either cannot pass. J11 switches to sv-SE live. Every separator a regex needs
 * is read from `get_locale_settings` and escaped -- never typed as ASCII (sv-SE
 * groups with U+00A0).
 *
 * RESTORE DISCIPLINE. Every explicit `set_locale` persists an override in the
 * OWNER'S profile. The journey reads `boot = get_locale_settings()` in J0 and
 * puts the boot override back (`boot.overrideId ?? "system"`) in J12 AND again
 * in `afterAll`, then asserts the override equals the boot value.
 * `zz-persisted-residue.spec.ts` checks the same against the run's read-only
 * baseline (`e2e/localeBaseline.ts`), so a run that dies between J1 and J12 is
 * still caught.
 *
 * FIXTURE. C:\Dropbox\Projekt\Calcula\context_manager\model.json against
 * Postgres AdventureWorks on localhost:5432 (postgres/postgres), through
 * helpers/adventureworks-live.ts. An unreachable server FAILS the scene step
 * with that helper's sentence -- never a skip. `[Revenue]` is `#,##0`.
 * `BI.dim_product.listprice` is Decimal(38,10), so its member KEY carries the
 * scale ("3578.2700000000", BUG-0518) while its LABEL is General in the app
 * locale ("3578,27"); `BI.dim_date.datekey` is a Date, keyed ISO
 * ("2013-07-01") and labelled in the locale's short date ("01.07.2013").
 *
 * WHAT IS ASSERTED. Backend state (`get_locale_settings`, the settings file,
 * pivot views with their `member`, slicer rows, chart specs, typed cells), the
 * DOM (the Settings dropdown, the status bar, the CSV export dialog, the
 * object pane, Goal Seek), what the painters actually WROTE (the `fillText`
 * recorder of helpers/chart-paint.ts) and RELATIVE pixel samples
 * (viewportSample.ts). Never a golden (R14: the goldens are stale by owner
 * decision).
 *
 * ONE WORKBOOK, SERIAL. J0 builds the scene; J1..J12 run in order on it
 * (`mode: "serial"`), so no step can pass on a state an earlier step never
 * reached.
 *
 * DELIBERATE DEPARTURES FROM THE SPEC TEXT, each checked against the code:
 *   - J4 K card: the spec's `/^\d+(,\d)?K$/` cannot match a real total. The
 *     revenue is about 10^8, so in thousands it is a five- or six-digit number,
 *     and formatVisualNumber GROUPS it ("109.846K" in de-DE). The regex is built
 *     from the locale's own separators and allows the grouping:
 *     `^\d{1,3}(<group>\d{3})*(<decimal>\d)?K$`.
 *   - J5 listprice label: a member label is General ("General has no grouping",
 *     core/engine/src/member_label.rs), so `^\d+<decimal>\d+$` holds -- but
 *     only for a price with a fractional part (a whole price labels "2"). The
 *     header is therefore picked among the FRACTIONAL keys.
 *   - J5 GETPIVOTDATA: the pick's text is asserted through the backend answer
 *     the pick interceptor itself asks (`get_pivot_data_formula`, the route
 *     canvas-pick-cells J1 proves end to end): its item is the KEY.
 *   - J6/J7 "the DOM item texts": a slicer is painted on the canvas, not in the
 *     DOM. The painted texts (the fillText recorder) and the slicer store's
 *     cached labels are asserted instead.
 *   - Slicers are created through the slicer store's `createSlicerAsync` (the
 *     route the Insert Slicers dialog ends in; fixall-calp W6 does the same),
 *     so three model fields need no dialog walk each.
 *   - J9 Goal Seek: the changing cell B1 feeds B2 = B1*2 and the target is
 *     typed "1,5": the SET cell's typed value ends near 1.5 (the spec's
 *     sentence), and B1 near 0.75.
 *
 * RUN NOTES FOR THE PROOF PHASE. P2 changed Rust, so launch manually
 * (`E2E_MANUAL=1`, no `--reporter`; memory "E2E after a Rust change") with
 * CARGO_TARGET_DIR=C:/Users/Salle/AppData/Local/calcula-target, and confirm
 * global-setup printed a binary built after P2. Postgres must be up. This
 * file was WRITTEN in P2 S12 without being run (implementation steps never run
 * E2E, R12). Check that the canvas click points of J4, J6b and J9 hit the
 * object FRAME, not a datum (under P4 a datum click outside Design Mode is
 * content, critic D7): J9 clicks (12, 12) inside the card, its frame band.
 *
 * SABOTAGES (confirm each CHANGED behaviour before reading the failure; CLAUDE.md
 * "a sabotage that is a no-op passes"):
 *   J1  skip `write_settings` in `set_locale_core` (app/src-tauri/src/
 *       locale_commands.rs): the settings-file assertion fails.
 *   J2  remove the `await initAppLocale()` gate in app/src/main.tsx:
 *       `__calcLocaleAtFirstRender` reads "en-US".
 *   J3  make DATEVALUE call `parse_date_string` only (core/engine/src/
 *       evaluator.rs): `=DATEVALUE("15.01.2024")` becomes #VALUE!.
 *   J4  restore a hard-coded "," in `groupDigits` (app/extensions/Charts/
 *       rendering/visuals/visualValues.ts): the de-DE card text check fails.
 *   J5  pass `&LocaleSettings::invariant()` instead of the command's locale
 *       into `view_to_response` (app/src-tauri/src/pivot/utils.rs callers):
 *       the `formattedValue` grouping check fails.
 *   J6  make the slicer UI write `label` into the selection (Slicer
 *       slicerClickSelection.ts): the total goes empty, the key check fails.
 *   J6b publish `item.label` from the slicer's page-filter bridge
 *       (Slicer/lib/slicerPageFilters.ts): the card goes blank and the snapshot
 *       assertion fails.
 *   J9  revert `parseNumberFieldText` (app/src/api/layout/primitives/
 *       fields.tsx) to `Number(raw)`: "2,5" is refused.
 *   J11 skip `app.emit(LOCALE_CHANGED_EVENT)` in `set_locale`: the card text
 *       stays in de-DE format.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import {
  MOD,
  addCanvas,
  addWorksheet,
  callModule,
  clickSheetTab,
  createChart,
  dismissToasts,
  eventually,
  humanClick,
  installAppImport,
  invoke,
  newFile,
  objects,
  persistedCharts,
  sheetsResult,
} from "../helpers/canvas-live";
import {
  awPivotView,
  connectAdventureWorks,
  createAwCanvasPivot,
  dropAdventureWorks,
  escapeRegExp,
  type AwConnection,
  type AwPivotCell,
  type AwPivotView,
} from "../helpers/adventureworks-live";
import { cachedData, recordedTexts, startTextRecorder } from "../helpers/chart-paint";
import { readCell, setCells } from "../helpers/calp-harness";
import { executeCommand } from "../helpers/edit-harness";
import { cellAt, pivotApi } from "../helpers/pivot-live";
import { slicerItemPoint, slicerLanded, slicerRow } from "../helpers/slicers";
import {
  clickRegion,
  closeObjectPaneQuietly,
  closeTaskPanes,
  expandFormatCard,
  formatInput,
  openFormat,
  regionWhere,
  setFormatToggle,
  sheetClip,
  waitPane,
} from "../helpers/object-pane";
import { readGridGeometry } from "../helpers/grid";
import { readAppSettingsOverride } from "../localeBaseline";
import { diffCount, samplePixelGrids } from "../viewportSample";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUN = Date.now().toString(36);
const CONNECTION_NAME = `AW (app locale ${RUN})`;
const ZOOM_PERCENT = 70;

const SETTINGS_LOCALE = '[data-testid="settings-locale"]';
const settingsOption = (id: string): string => `[data-testid="settings-locale-${id}"]`;

/** The objects-binding bridge (its page-filter snapshot is what Rust's mirror gets). */
const BRIDGE = "/src/api/objectBindings/bridge.ts";
const UI = "/src/api/ui.ts";

/** Where things stand on the canvas page (sheet px, page 1280 x 720). */
const CARD_NONE_AT = { x: 40, y: 40, width: 300, height: 140 };
const CARD_K_AT = { x: 360, y: 40, width: 220, height: 140 };
const YEAR_PIVOT_AT = { x: 40, y: 220, width: 340, height: 240 };
const PRICE_PIVOT_AT = { x: 400, y: 220, width: 360, height: 460 };
const COLOR_SLICER_AT = { x: 790, y: 40, width: 200, height: 300 };
const PRICE_SLICER_AT = { x: 1010, y: 40, width: 200, height: 300 };
const DATE_SLICER_AT = { x: 790, y: 380, width: 200, height: 300 };

const YEAR = { table: "BI.dim_date", column: "year" };
const DATEKEY = { table: "BI.dim_date", column: "datekey" };
const LISTPRICE = { table: "BI.dim_product", column: "listprice" };
const COLOR = { table: "BI.dim_product", column: "color" };

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------
// Wire shapes (read-only mirrors of app/src/api/types.ts)
// ---------------------------------------------------------------------------

interface LocaleWire {
  localeId: string;
  overrideId: string | null;
  decimalSeparator: string;
  thousandsSeparator: string;
  listSeparator: string;
  dateFormat: string;
  currencySymbol: string;
  currencyPosition: string;
  monthNamesShort: string[];
}

interface MemberRef {
  key: string;
  label: string;
}

type MemberCell = AwPivotCell & { member?: MemberRef; groupPath?: Array<[number, number]> };

interface SlicerItemWire {
  key: string;
  label: string;
  selected: boolean;
  hasData: boolean;
}

interface GpdResult {
  dataField: string;
  fieldItemPairs: Array<[string, string]>;
  pivotAnchorRow: number;
  pivotAnchorCol: number;
}

interface Region {
  pivotId: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// ---------------------------------------------------------------------------
// Shared state (one workbook, built by J0)
// ---------------------------------------------------------------------------

interface Scene {
  boot: LocaleWire;
  sheet1Index: number;
  pivotSheetIndex: number;
  canvasIndex: number;
  conn: AwConnection | null;
  cardNoneId: string;
  cardKId: string;
  yearPivotId: string;
  pricePivotId: string;
  colorSlicerId: string;
  priceSlicerId: string;
  dateSlicerId: string;
  total: number;
}

let scene: Scene | null = null;
let bootHeld: LocaleWire | null = null;
let connHeld: AwConnection | null = null;

function need(): Scene {
  if (!scene) throw new Error("the scene was not built (J0 failed); every later step needs it");
  return scene;
}

// ---------------------------------------------------------------------------
// The locale
// ---------------------------------------------------------------------------

async function localeNow(page: Page): Promise<LocaleWire> {
  return invoke<LocaleWire>(page, "get_locale_settings", {});
}

/** Put the boot override back (or "system" when there was none) and prove it. */
async function restoreBootLocale(page: Page, boot: LocaleWire): Promise<void> {
  await expect(invoke(page, "set_locale", { localeId: boot.overrideId ?? "system" }), "restoring the boot locale was refused").resolves.toBeTruthy();
  const after = await localeNow(page);
  expect(after.overrideId ?? null, "the profile's persisted override is not the one it had at boot").toBe(boot.overrideId ?? null);
}

/** File > Options > General (the Settings view's General tab). */
async function openSettingsGeneral(page: Page): Promise<void> {
  await executeCommand(page, "settings.showTab", "general");
  await expect(page.locator('[data-testid="settings-general"]'), "Settings > General did not open").toBeVisible({ timeout: 10_000 });
}

async function closeSettings(page: Page): Promise<void> {
  if (await page.locator('[data-testid="settings-general"]').isVisible().catch(() => false)) {
    await executeCommand(page, "settings.toggle");
    await expect(page.locator('[data-testid="settings-general"]'), "Settings did not close").toBeHidden({ timeout: 10_000 });
  }
}

/** Pick a locale in the Settings dropdown (a real click on the real option) and wait for the backend to agree. */
async function pickLocaleInSettings(page: Page, id: string, expectLocaleId?: string): Promise<LocaleWire> {
  await openSettingsGeneral(page);
  await page.locator(SETTINGS_LOCALE).click();
  const option = page.locator(settingsOption(id));
  await expect(option, `the Locale dropdown offers no ${id}`).toBeVisible({ timeout: 5000 });
  await option.click();
  const now = await eventually(
    () => localeNow(page),
    (l) => (id === "system" ? (l.overrideId ?? null) === null : l.overrideId === id) && (!expectLocaleId || l.localeId === expectLocaleId),
    `picking ${id} in Settings did not reach the backend`,
    15_000,
  );
  await closeSettings(page);
  return now;
}

/** A regex fragment matching one separator character (escaped; never typed as ASCII). */
function sep(ch: string): string {
  return escapeRegExp(ch);
}

/** A number DISPLAY read back in the given locale ("1.234,5" -> 1234.5 in de-DE). */
function readLocaleNumber(text: string, l: LocaleWire): number {
  const cleaned = text.split(l.thousandsSeparator).join("").split(l.decimalSeparator).join(".").trim();
  return cleaned === "" ? Number.NaN : Number(cleaned);
}

function numericOf(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) if (typeof x === "number") return x;
  }
  return Number.NaN;
}

// ---------------------------------------------------------------------------
// The canvas and its objects
// ---------------------------------------------------------------------------

async function activeIndex(page: Page): Promise<number> {
  return (await sheetsResult(page)).activeIndex;
}

async function ensureZoom(page: Page): Promise<void> {
  const geo = await readGridGeometry(page);
  if (Math.abs(geo.zoom - ZOOM_PERCENT / 100) < 0.01) return;
  await callModule(page, "/src/api/grid.ts", "setZoomLevel", [ZOOM_PERCENT]);
  await eventually(() => readGridGeometry(page), (g) => Math.abs(g.zoom - ZOOM_PERCENT / 100) < 0.01, `the canvas did not zoom to ${ZOOM_PERCENT}%`);
  await page.waitForTimeout(200);
}

async function onSheet(page: Page, index: number): Promise<void> {
  if ((await activeIndex(page)) !== index) {
    await clickSheetTab(page, index);
    await eventually(() => activeIndex(page), (i) => i === index, `sheet ${index} did not become the active sheet`);
  }
}

async function onCanvas(page: Page): Promise<void> {
  await onSheet(page, need().canvasIndex);
  await ensureZoom(page);
}

/** Repaint every chart from scratch (the recorder sees only paints after it starts). */
async function repaintCharts(page: Page): Promise<void> {
  await callModule(page, MOD.CHART_RENDERER, "invalidateAllChartCaches").catch(() => undefined);
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
}

/** The view of a pivot, its cells typed with the P2 member. */
async function memberView(page: Page, pivotId: string): Promise<AwPivotView> {
  return awPivotView(page, pivotId);
}

function headerCells(view: AwPivotView): Array<{ viewRow: number; viewCol: number; cell: MemberCell }> {
  const out: Array<{ viewRow: number; viewCol: number; cell: MemberCell }> = [];
  for (const row of view.rows) {
    row.cells.forEach((c, i) => {
      if (c.cellType === "RowHeader" || c.cellType === "ColumnHeader") out.push({ viewRow: row.viewRow, viewCol: i, cell: c as MemberCell });
    });
  }
  return out;
}

function grandTotal(view: AwPivotView): number {
  const totals: number[] = [];
  for (const row of view.rows) for (const c of row.cells) if (c.cellType === "GrandTotal" && typeof c.value === "number") totals.push(c.value);
  return totals.length > 0 ? totals[totals.length - 1] : Number.NaN;
}

function dataTexts(view: AwPivotView): string[] {
  const out: string[] = [];
  for (const row of view.rows) for (const c of row.cells) if (c.cellType === "Data" && typeof c.formattedValue === "string" && c.formattedValue !== "") out.push(c.formattedValue);
  return out;
}

/** The measure value of a measure-only design-query view (its grand total). */
function measureOfView(view: unknown): number {
  const rows = (view as { rows?: Array<{ cells?: Array<{ cellType?: string; value?: unknown }> }> }).rows ?? [];
  const of = (type: string): number[] =>
    rows.flatMap((r) => (r.cells ?? []).filter((c) => c.cellType === type && typeof c.value === "number").map((c) => c.value as number));
  const grand = of("GrandTotal");
  if (grand.length > 0) return grand[grand.length - 1];
  const data = of("Data");
  if (data.length > 0) return data[0];
  return Number.NaN;
}

async function designQuery(page: Page, connectionId: string, rowFields: Array<{ table: string; column: string }>, pageFilter: { table: string; column: string; includedItems: string[] } | null): Promise<unknown> {
  return invoke(page, "run_design_query", {
    request: {
      connectionId,
      rowFields,
      columnFields: [],
      valueFields: [{ measureName: "Revenue" }],
      filterFields: [],
      pageFilterFields: pageFilter ? [pageFilter] : [],
    },
  });
}

async function createModelSlicer(page: Page, s: { canvasIndex: number; connectionId: string }, field: { table: string; column: string }, at: { x: number; y: number; width: number; height: number }): Promise<string> {
  const made = await callModule<{ id: string } | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
    {
      name: `${field.column} ${RUN}`,
      sheetIndex: s.canvasIndex,
      ...at,
      sourceType: "biConnection",
      cacheSourceId: s.connectionId,
      fieldName: `${field.table}.${field.column}`,
      connectedSources: [{ sourceType: "biConnection", sourceId: s.connectionId }],
    },
  ]);
  expect(made, `the model slicer on ${field.table}.${field.column} was not created`).toBeTruthy();
  await eventually(() => cachedItems(page, made!.id), (it) => it.length > 0, `the model slicer on ${field.column} shows no items`, 30_000);
  return made!.id;
}

async function cachedItems(page: Page, slicerId: string): Promise<SlicerItemWire[]> {
  return (await callModule<SlicerItemWire[] | undefined>(page, MOD.SLICER_STORE, "getCachedItems", [slicerId])) ?? [];
}

async function cardValue(page: Page, chartId: string): Promise<number> {
  const d = await cachedData(page, chartId);
  return d?.series[0]?.values[0] ?? Number.NaN;
}

// ===========================================================================

test.describe("app locale everywhere (P2, G0): one Rust authority, sync helpers before the first render, MemberRef keys vs labels, live switch (live, AdventureWorks)", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test.afterAll(async ({ sharedPage: page }) => {
    await page.keyboard.press("Escape").catch(() => undefined);
    await closeObjectPaneQuietly(page).catch(() => undefined);
    await closeSettings(page).catch(() => undefined);
    await dismissToasts(page).catch(() => undefined);
    // THE PROFILE FIRST: whatever happened above, the owner's override goes back.
    if (bootHeld) {
      await invoke(page, "set_locale", { localeId: bootHeld.overrideId ?? "system" }).catch(() => undefined);
      const after = await localeNow(page).catch(() => null);
      expect(after?.overrideId ?? null, "afterAll could not put the boot locale override back").toBe(bootHeld.overrideId ?? null);
    }
    await newFile(page).catch(() => undefined);
    await dropAdventureWorks(page, connHeld);
    const conns = await invoke<Array<{ id: string; name: string }>>(page, "bi_get_connections").catch(() => []);
    for (const c of conns) {
      if (c.name === CONNECTION_NAME) await invoke(page, "bi_delete_connection", { connectionId: c.id }).catch(() => undefined);
    }
    // The leaked-pane rule: prove the task-pane container hidden before the next spec runs.
    const panes = await closeTaskPanes(page);
    expect(panes.isOpen, `a task pane is still open after the journey: ${JSON.stringify(panes)}`).toBe(false);
  });

  // -------------------------------------------------------------------------
  test("J0 the boot locale is recorded; a fresh workbook with Sheet1", async ({ appPage: page }) => {
    await installAppImport(page);
    const boot = await localeNow(page);
    bootHeld = boot;
    console.log(`[app-locale] boot locale ${boot.localeId}, override ${JSON.stringify(boot.overrideId)}`);
    expect(boot.localeId, "the backend answered no locale id").toMatch(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
    await newFile(page);
    const first = await sheetsResult(page);
    scene = {
      boot,
      sheet1Index: first.activeIndex,
      pivotSheetIndex: -1,
      canvasIndex: -1,
      conn: null,
      cardNoneId: "",
      cardKId: "",
      yearPivotId: "",
      pricePivotId: "",
      colorSlicerId: "",
      priceSlicerId: "",
      dateSlicerId: "",
      total: Number.NaN,
    };
  });

  // -------------------------------------------------------------------------
  test("J1 persisted authority: Settings > Locale > Deutsch (Deutschland) reaches Rust, the settings file and nowhere else", async ({ appPage: page }) => {
    const now = await pickLocaleInSettings(page, "de-DE", "de-DE");
    expect({ localeId: now.localeId, overrideId: now.overrideId }).toEqual({ localeId: "de-DE", overrideId: "de-DE" });
    expect(now.decimalSeparator, "de-DE decimals").toBe(",");
    expect(now.thousandsSeparator, "de-DE grouping").toBe(".");
    const file = readAppSettingsOverride();
    expect(file.localeOverride, `the settings file ${file.source} does not hold the choice`).toBe("de-DE");
    const stored = await page.evaluate(() => {
      try {
        return localStorage.getItem("calcula.locale");
      } catch {
        return null;
      }
    });
    expect(stored, "the retired localStorage key calcula.locale was written again").toBeNull();
    // The window's SYNC accessor agrees with Rust (it followed locale:changed).
    const sync = await callModule<{ localeId: string }>(page, "/src/api/locale.ts", "getAppLocale");
    expect(sync.localeId, "@api/locale getAppLocale did not follow the switch").toBe("de-DE");
  });

  // -------------------------------------------------------------------------
  test("J2 before the first render: a reload renders its first frame already in de-DE", async ({ appPage: page }) => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-focus-container='spreadsheet']", { state: "visible", timeout: 90_000 });
    await page.waitForTimeout(1500);
    await installAppImport(page);
    const first = await page.evaluate(() => (window as unknown as { __calcLocaleAtFirstRender?: string }).__calcLocaleAtFirstRender ?? null);
    expect(first, "the first frame rendered in another locale than the persisted one (initAppLocale not awaited?)").toBe("de-DE");
    expect((await localeNow(page)).localeId).toBe("de-DE");
  });

  // -------------------------------------------------------------------------
  test("J3 grid regression control: 1234,5 with #,##0.00 reads 1.234,50; DATEVALUE reads the de-DE date; DOLLAR writes the euro in the locale's place", async ({ appPage: page }) => {
    const s = need();
    await onSheet(page, s.sheet1Index);
    const l = await localeNow(page);
    await setCells(page, s.sheet1Index, [
      ["A1", "1234,5"],
      ["A2", '=DATEVALUE("15.01.2024")'],
      ["A3", "=DOLLAR(1234,5)"],
    ]);
    await callModule(page, MOD.TAURI_API, "applyFormatting", [[0], [0], { numberFormat: "#,##0.00" }]);
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    const a1 = await cellAt(page, s.sheet1Index, 0, 0);
    expect(numericOf(a1?.value), "1234,5 typed in de-DE is not the number 1234.5").toBeCloseTo(1234.5, 9);
    await eventually(async () => (await readCell(page, s.sheet1Index, "A1")).display, (d) => d === "1.234,50", "A1 does not display 1.234,50 under #,##0.00");
    expect((await readCell(page, s.sheet1Index, "A2")).display, 'DATEVALUE("15.01.2024") in de-DE').toBe("45306");
    const sym = escapeRegExp(l.currencySymbol.trim());
    const body = `1${sep(l.thousandsSeparator)}234${sep(l.decimalSeparator)}50`;
    const dollar = /before/i.test(l.currencyPosition) ? new RegExp(`^${sym}\\s?${body}$`) : new RegExp(`^${body}\\s?${sym}$`);
    expect((await readCell(page, s.sheet1Index, "A3")).display, `DOLLAR(1234,5) does not match ${dollar}`).toMatch(dollar);
  });

  // -------------------------------------------------------------------------
  test("J10 chrome: the status-bar Sum and the CSV export delimiter follow the app locale", async ({ appPage: page, grid }) => {
    const s = need();
    await onSheet(page, s.sheet1Index);
    await setCells(page, s.sheet1Index, [
      ["C1", "1234,5"],
      ["C2", "1"],
    ]);
    await grid.selectRange("C1", "C2");
    const sum = page.locator("span", { hasText: /^Sum: / }).first();
    await expect(sum, "the status bar shows no Sum for a two-number selection").toBeVisible({ timeout: 10_000 });
    await expect(sum, "the status-bar Sum is not in de-DE").toContainText("1.235,5");

    await callModule(page, UI, "showDialog", ["csv-export"]);
    const dialog = page.locator("span", { hasText: /^Export to CSV$/ }).locator("xpath=../..");
    await expect(dialog, "the CSV export dialog did not open").toBeVisible({ timeout: 10_000 });
    const delimiter = await dialog.locator("select").first().inputValue();
    expect(delimiter, "the CSV export's default delimiter is not the app list separator").toBe((await localeNow(page)).listSeparator);
    expect(delimiter, "de-DE's list separator is ';'").toBe(";");
    await callModule(page, UI, "hideDialog", ["csv-export"]);
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });

  // -------------------------------------------------------------------------
  test("J8 date group names: a range pivot grouped by Months is labelled in de-DE month names and keyed Jan..Dec", async ({ appPage: page }) => {
    const s = need();
    const ws = await addWorksheet(page);
    s.pivotSheetIndex = ws.index;
    await onSheet(page, ws.index);
    const rows: Array<[string, string]> = [["A1", "Date"], ["B1", "Amount"]];
    for (let i = 0; i < 24; i++) {
      const month = (i % 12) + 1;
      const year = i < 12 ? 2024 : 2025;
      rows.push([`A${i + 2}`, `=DATE(${year};${month};15)`]);
      rows.push([`B${i + 2}`, String(10 + i)]);
    }
    await setCells(page, ws.index, rows);
    const view = await callModule<{ pivotId: string }>(page, MOD.PIVOT_API, "createPivotTable", [
      { sourceRange: `${ws.name}!A1:B25`, destinationCell: "D1", sourceSheet: ws.index, destinationSheet: ws.index, hasHeaders: true, name: `Months ${RUN}` },
    ]);
    const pivotId = String(view.pivotId);
    await callModule(page, MOD.PIVOT_API, "updatePivotFields", [
      { pivotId, rowFields: [{ sourceIndex: 0, name: "Date" }], valueFields: [{ sourceIndex: 1, name: "Sum of Amount", aggregation: "sum" }] },
    ]);
    await callModule(page, MOD.PIVOT_API, "groupPivotField", [{ pivotId, fieldIndex: 0, grouping: { type: "dateGrouping", levels: ["month"] } }]);
    await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
    const l = await localeNow(page);
    expect(l.monthNamesShort.length, "get_locale_settings carries no month names").toBe(12);
    const months = await eventually(
      async () => headerCells(await pivotApi<AwPivotView>(page, "getView", pivotId)).filter((h) => h.cell.cellType === "RowHeader" && !!h.cell.member),
      (hs) => hs.length >= 12,
      "the month-grouped pivot shows no twelve month headers",
      30_000,
    );
    expect(months.map((h) => h.cell.member!.key), "the month KEYS are not the invariant Jan..Dec").toEqual(EN_MONTHS);
    expect(months.map((h) => h.cell.member!.label), "the month LABELS are not de-DE's short month names").toEqual(l.monthNamesShort);
    expect(l.monthNamesShort, "the de-DE names differ from English somewhere (else this proves nothing)").not.toEqual(EN_MONTHS);
  });

  // -------------------------------------------------------------------------
  test("J9a inputs: Goal Seek's To value is read in de-DE (1,5)", async ({ appPage: page }) => {
    const s = need();
    await onSheet(page, s.sheet1Index);
    await setCells(page, s.sheet1Index, [
      ["E1", "1"],
      ["E2", "=E1*2"],
    ]);
    await callModule(page, UI, "showDialog", ["goal-seek", { activeRow: 1, activeCol: 4 }]);
    const dialog = page.locator("span", { hasText: /^Goal Seek$/ }).locator("xpath=../..");
    await expect(dialog, "Goal Seek did not open").toBeVisible({ timeout: 10_000 });
    await dialog.locator('input[placeholder="$B$5"]').fill("E2");
    await dialog.locator('input[placeholder="50000"]').fill("1,5");
    await dialog.locator('input[placeholder="$A$1"]').fill("E1");
    await dialog.getByRole("button", { name: "OK" }).click();
    // The status dialog REPLACES the input form under its own title ("Goal Seek
    // Status"), so it is located by that title -- the input form's locator
    // never matches it. OK keeps the solution.
    const status = page.locator("span", { hasText: /^Goal Seek Status$/ }).locator("xpath=../..");
    await expect(status, "Goal Seek did not reach its status dialog (was 1,5 refused?)").toBeVisible({ timeout: 30_000 });
    await status.getByRole("button", { name: "OK" }).click();
    await expect(status).toBeHidden({ timeout: 10_000 });
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    const set = await eventually(async () => numericOf((await cellAt(page, s.sheet1Index, 1, 4))?.value), (v) => Math.abs(v - 1.5) < 1e-3, "Goal Seek did not solve E2 to 1.5 (1,5 in de-DE)", 15_000);
    expect(set, "the set cell's typed value").toBeCloseTo(1.5, 3);
    expect(numericOf((await cellAt(page, s.sheet1Index, 0, 4))?.value), "the changing cell").toBeCloseTo(0.75, 3);
  });

  // -------------------------------------------------------------------------
  test("J0b the canvas scene: AdventureWorks connected; two Cards on [Revenue]; a year pivot and a listprice pivot; model slicers on color, listprice and datekey", async ({ appPage: page }) => {
    const s = need();
    s.conn = await connectAdventureWorks(page, CONNECTION_NAME);
    connHeld = s.conn;
    s.total = measureOfView(await designQuery(page, s.conn.connectionId, [], null));
    console.log(`[app-locale] [Revenue] total = ${s.total}`);
    expect(s.total > 1e6, "the model answered no Revenue total").toBe(true);

    const canvas = await addCanvas(page);
    s.canvasIndex = canvas.index;
    await onCanvas(page);
    await startTextRecorder(page);
    s.cardNoneId = await createChart(
      page,
      { mark: "card", data: { type: "designQuery", dslText: "VALUES: [Revenue]", connectionId: s.conn.connectionId }, title: "Revenue", markOptions: { displayUnits: "none" } },
      { sheetIndex: s.canvasIndex, ...CARD_NONE_AT, name: "Revenue card" },
      { waitPaint: false },
    );
    s.cardKId = await createChart(
      page,
      { mark: "card", data: { type: "designQuery", dslText: "VALUES: [Revenue]", connectionId: s.conn.connectionId }, title: "Revenue K", markOptions: { displayUnits: "thousands" } },
      { sheetIndex: s.canvasIndex, ...CARD_K_AT, name: "Revenue K card" },
      { waitPaint: false },
    );
    for (const id of [s.cardNoneId, s.cardKId]) {
      await eventually(() => cardValue(page, id), (v) => Math.abs(v - s.total) < 0.01, `card ${id} never showed the model total ${s.total}`, 60_000);
    }
    s.yearPivotId = await createAwCanvasPivot(page, { canvasIndex: s.canvasIndex, connectionId: s.conn.connectionId, frame: YEAR_PIVOT_AT, rows: [YEAR], columns: [], values: [{ measureName: "Revenue" }], name: `Years ${RUN}` });
    s.pricePivotId = await createAwCanvasPivot(page, { canvasIndex: s.canvasIndex, connectionId: s.conn.connectionId, frame: PRICE_PIVOT_AT, rows: [LISTPRICE], columns: [], values: [{ measureName: "Revenue" }], name: `Prices ${RUN}` });
    const ctx = { canvasIndex: s.canvasIndex, connectionId: s.conn.connectionId };
    s.colorSlicerId = await createModelSlicer(page, ctx, COLOR, COLOR_SLICER_AT);
    s.priceSlicerId = await createModelSlicer(page, ctx, LISTPRICE, PRICE_SLICER_AT);
    s.dateSlicerId = await createModelSlicer(page, ctx, DATEKEY, DATE_SLICER_AT);
  });

  // -------------------------------------------------------------------------
  test("J4 tile visuals (BUG-0447): the Cards write de-DE digits -- '.' grouping, never ',' grouping; the K card uses the locale's separators", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const l = await localeNow(page);
    await startTextRecorder(page);
    await repaintCharts(page);
    // A Card writes the total grouped, with its decimals ("114.033.992,77"); the
    // K card writes thousands ("114.034K"). The year pivot on the same page also
    // writes grouped numbers -- its Grand Total reads the same total, unrounded
    // to no decimals ("114.033.993") -- and it repaints FIRST, so the wait is for
    // BOTH card texts, never for "some grouped text".
    const grouped = new RegExp(`^\\d{1,3}(${sep(l.thousandsSeparator)}\\d{3})+(${sep(l.decimalSeparator)}\\d+)?$`);
    const kText = new RegExp(`^\\d{1,3}(${sep(l.thousandsSeparator)}\\d{3})*(${sep(l.decimalSeparator)}\\d)?K$`);
    const readsTotal = (x: string) => grouped.test(x) && Math.abs(readLocaleNumber(x, l) - s.total) < 1;
    const texts = await eventually(
      () => recordedTexts(page),
      (t) => t.some((x) => readsTotal(x) && x.includes(l.decimalSeparator)) && t.some((x) => kText.test(x)),
      `the Cards did not write the total grouped with "${l.thousandsSeparator}" and a K text`,
      20_000,
    );
    // "<d>,<ddd>" is ALSO a correct de-DE decimal with three places: the listprice
    // slicer labels the price 112.565 "112,565" (General, the locale's decimal
    // comma). A text that IS a de-DE label of a listprice member is therefore not
    // an en-US grouping; every other "<d>,<ddd>" still fails.
    const priceLabels = new Set(
      (await invoke<MemberRef[]>(page, "bi_get_column_values", { connectionId: s.conn!.connectionId, table: LISTPRICE.table, column: LISTPRICE.column })).map((m) => m.label),
    );
    expect(texts.filter((x) => /\d,\d{3}/.test(x) && !priceLabels.has(x)), "a painter wrote en-US ',' grouping under de-DE").toEqual([]);
    const totalText = texts.find((x) => readsTotal(x) && x.includes(l.decimalSeparator));
    expect(totalText, `no Card text reads the model's total ${s.total}`).toBeDefined();
    const kWritten = texts.find((x) => kText.test(x))!;
    expect(readLocaleNumber(kWritten.slice(0, -1), l), `the K card's ${kWritten} is not the total in thousands`).toBeCloseTo(s.total / 1000, 0);
  });

  // -------------------------------------------------------------------------
  test("J5 canvas BI pivot: formattedValue in de-DE; a year header is {Y,Y}; a listprice header keys invariant and labels in de-DE; GETPIVOTDATA names the KEY", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const l = await localeNow(page);
    // The owner's AdventureWorks is re-dated (its years are 2023..2026 on
    // 2026-10-17, not the classic 2011..2014), so the year is read from the
    // view, never typed: any four-digit year header proves it -- a year >= 1000
    // that a grouping format would have written "2.023".
    const isYear = (h: { cell: MemberCell }) => h.cell.cellType === "RowHeader" && /^\d{4}$/.test(h.cell.member?.key ?? "");
    const years = await eventually(() => memberView(page, s.yearPivotId), (v) => headerCells(v).some(isYear), "the year pivot shows no four-digit year header with a member", 60_000);
    const grouped = new RegExp(`^\\d{1,3}(${sep(l.thousandsSeparator)}\\d{3})+$`);
    expect(dataTexts(years).some((t) => grouped.test(t)), `no data cell of the year pivot is grouped with "${l.thousandsSeparator}": ${JSON.stringify(dataTexts(years).slice(0, 6))}`).toBe(true);
    expect(dataTexts(years).filter((t) => /\d,\d{3}/.test(t)), "a pivot data cell is grouped en-US").toEqual([]);
    const year = headerCells(years).find(isYear)!;
    const y = year.cell.member!.key;
    expect(year.cell.member, `the year ${y} header is not {key:"${y}", label:"${y}"}`).toEqual({ key: y, label: y });
    for (const h of headerCells(years).filter((x) => x.cell.member)) {
      expect(h.cell.member!.key, "a year header's key is not its label (General has no grouping)").toBe(h.cell.member!.label);
    }

    const prices = await eventually(() => memberView(page, s.pricePivotId), (v) => headerCells(v).some((h) => !!h.cell.member), "the listprice pivot shows no header with a member", 60_000);
    const fractional = headerCells(prices).find((h) => h.cell.cellType === "RowHeader" && !!h.cell.member && /^\d+\.\d+$/.test(h.cell.member.key) && !Number.isInteger(Number(h.cell.member.key)));
    expect(fractional, "the listprice pivot shows no fractional price header").toBeTruthy();
    const m = fractional!.cell.member!;
    expect(m.key, "the listprice KEY is not invariant canonical").toMatch(/^\d+\.\d+$/);
    expect(m.label, "the listprice LABEL is not in de-DE").toMatch(new RegExp(`^\\d+${sep(l.decimalSeparator)}\\d+$`));
    expect(readLocaleNumber(m.label, l), "the label is not the key's number").toBeCloseTo(Number(m.key), 9);

    // GETPIVOTDATA on that row's value: the item it names is the KEY.
    const row = prices.rows.find((r) => r.viewRow === fractional!.viewRow)!;
    const dataCol = row.cells.findIndex((c) => c.cellType === "Data" && typeof c.value === "number");
    expect(dataCol, "the fractional price row has no value cell").toBeGreaterThanOrEqual(0);
    const region = (await invoke<Region[]>(page, "get_pivot_regions_for_sheet")).find((r) => String(r.pivotId) === s.pricePivotId);
    expect(region, "the listprice pivot has no region on the canvas").toBeTruthy();
    const gpd = await invoke<GpdResult | null>(page, "get_pivot_data_formula", { row: region!.startRow + fractional!.viewRow, col: region!.startCol + dataCol });
    expect(gpd, "get_pivot_data_formula answered nothing for a value cell").toBeTruthy();
    const items = gpd!.fieldItemPairs.map((p) => p[1]);
    expect(items, "GETPIVOTDATA does not name the member KEY").toContain(m.key);
    expect(items, "GETPIVOTDATA names the LABEL").not.toContain(m.label);
  });

  // -------------------------------------------------------------------------
  test("J6 model slicer keys (BUG-0166 class): items show labels; a real click on a listprice item filters the pivot and persists the KEY", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const l = await localeNow(page);
    const colors = await cachedItems(page, s.colorSlicerId);
    expect(colors.length, "the color slicer has no items").toBeGreaterThan(0);
    for (const it of colors) if (it.key !== "") expect(it.label, "a text member's label is not its key").toBe(it.key);

    const prices = await cachedItems(page, s.priceSlicerId);
    const item = prices.find((i) => i.hasData && i.key !== "");
    expect(item, "the listprice slicer has no item with data").toBeTruthy();
    expect(item!.key, "a listprice slicer KEY is not invariant").toMatch(/^\d+\.\d+$/);
    expect(item!.label, "a listprice slicer LABEL uses a '.' decimal under de-DE").not.toContain(".");
    expect(readLocaleNumber(item!.label, l), "the slicer label is not the key's number").toBeCloseTo(Number(item!.key), 9);
    // What the slicer PAINTS is the label.
    await startTextRecorder(page);
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await eventually(() => recordedTexts(page), (t) => t.includes(item!.label), `the listprice slicer did not paint the label ${item!.label}`, 15_000);

    const before = grandTotal(await memberView(page, s.yearPivotId));
    const p = await slicerItemPoint(page, s.priceSlicerId, item!.key);
    await humanClick(page, p.x, p.y);
    await slicerLanded(page);
    const after = await eventually(
      async () => grandTotal(await memberView(page, s.yearPivotId)),
      (t) => Number.isFinite(t) && t > 0 && Math.abs(t - before) > 0.01,
      `a click on listprice ${item!.label} did not refilter the year pivot (total stays ${before} or went empty)`,
      60_000,
    );
    expect(after < before, "the filtered total is not below the full total").toBe(true);
    const row = await slicerRow(page, s.priceSlicerId);
    expect(row.selectedItems, "the slicer's persisted selection is not the KEY spelling").toEqual([item!.key]);
    await callModule(page, MOD.SLICER_STORE, "clickSlicerClearFilter", [s.priceSlicerId]);
    await slicerLanded(page);
    await eventually(async () => grandTotal(await memberView(page, s.yearPivotId)), (t) => Math.abs(t - before) < 0.01, "clearing the listprice slicer did not bring the total back", 60_000);
  });

  // -------------------------------------------------------------------------
  test("J7 + J6b date members: datekey labels are dd.mm.yyyy, keys ISO; one datekey filters the Card through a page filter that carries the KEY", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const members = await invoke<MemberRef[]>(page, "bi_get_column_values", { connectionId: s.conn!.connectionId, table: DATEKEY.table, column: DATEKEY.column });
    const dated = members.filter((m) => m.key !== "");
    expect(dated.length, "bi_get_column_values returned no datekeys").toBeGreaterThan(0);
    for (const m of dated.slice(0, 50)) {
      expect(m.key, "a datekey KEY is not ISO").toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.label, "a datekey LABEL is not de-DE's short date").toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
      const [y, mo, d] = m.key.split("-");
      expect(m.label, "label and key name different days").toBe(`${d}.${mo}.${y}`);
    }
    const items = await cachedItems(page, s.dateSlicerId);
    const byKey = new Map(dated.map((m) => [m.key, m.label]));
    for (const it of items.filter((x) => x.key !== "").slice(0, 50)) {
      expect(it.label, `the slicer's label of ${it.key} is not bi_get_column_values' label`).toBe(byKey.get(it.key));
    }

    // A day that sold something, from the model itself.
    const byDay = await designQuery(page, s.conn!.connectionId, [DATEKEY], null);
    const sold = headerCells(byDay as AwPivotView).find((h) => {
      if (h.cell.cellType !== "RowHeader" || !h.cell.member || h.cell.member.key === "") return false;
      const row = (byDay as AwPivotView).rows.find((r) => r.viewRow === h.viewRow);
      return !!row && row.cells.some((c) => c.cellType === "Data" && typeof c.value === "number" && c.value > 0);
    });
    expect(sold, "the model sold nothing on any day").toBeTruthy();
    const dayKey = sold!.cell.member!.key;
    const oracle = measureOfView(await designQuery(page, s.conn!.connectionId, [], { ...DATEKEY, includedItems: [dayKey] }));
    expect(oracle > 0 && Math.abs(oracle - s.total) > 0.01, `the day ${dayKey} does not narrow Revenue (${oracle})`).toBe(true);

    await callModule(page, MOD.SLICER_STORE, "clickSlicerItem", [s.dateSlicerId, dayKey, false]);
    await slicerLanded(page);
    await eventually(() => cardValue(page, s.cardNoneId), (v) => Math.abs(v - oracle) < 0.01, `the Card was not refiltered to ${dayKey} (${oracle})`, 60_000);
    const snapshot = await callModule<Array<{ filters: Array<{ field: string; includedItems: string[] }> }>>(page, BRIDGE, "pageFiltersSnapshot");
    const dayFilter = snapshot.flatMap((p) => p.filters).find((f) => f.field.includes("datekey"));
    expect(dayFilter, `the page-filter snapshot carries no datekey filter: ${JSON.stringify(snapshot)}`).toBeTruthy();
    expect(dayFilter!.includedItems, "the page filter does not carry the KEY").toEqual([dayKey]);
    for (const k of dayFilter!.includedItems) expect(k, "a page filter carries a label").toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await callModule(page, MOD.SLICER_STORE, "clickSlicerClearFilter", [s.dateSlicerId]);
    await slicerLanded(page);
    await eventually(() => cardValue(page, s.cardNoneId), (v) => Math.abs(v - s.total) < 0.01, "clearing the datekey slicer did not bring the Card back to the total", 60_000);
  });

  // -------------------------------------------------------------------------
  test("J9b inputs: the object pane's border width reads '2,5' as 2.5", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const card = await regionWhere(page, (r) => r.data.chartId === s.cardKId, "the K card");
    await clickRegion(page, card, { dx: 12, dy: 12 });
    await waitPane(page, (p) => p.open && p.regionId === card.id, "a click on the K card's frame did not open the object pane on it");
    await openFormat(page, "general");
    await expandFormatCard(page, "effects");
    await setFormatToggle(page, "border.show", true);
    const input = formatInput(page, "border.width");
    await input.waitFor({ state: "visible", timeout: 8000 });
    await input.click();
    await input.fill("2,5");
    await input.press("Enter");
    await eventually(
      async () => {
        const c = (await persistedCharts(page)).find((x) => x.id === s.cardKId);
        return ((c?.spec as { container?: { border?: { width?: unknown } } } | undefined)?.container?.border?.width ?? null) as number | null;
      },
      (w) => w === 2.5,
      'the border width typed "2,5" did not persist as 2.5',
      15_000,
    );
    await expect(input, "the field does not show the committed width in de-DE").toHaveValue("2,5");
    await closeObjectPaneQuietly(page);
  });

  // -------------------------------------------------------------------------
  test("J11 live switch: Settings > sv-SE repaints the Card, re-reads the pivots and changes the card's pixels, without a reload", async ({ appPage: page }) => {
    const s = need();
    await onCanvas(page);
    const card = (await objects(page)).find((o) => o.chartId === s.cardNoneId);
    expect(card, "the Card is not published on the canvas").toBeTruthy();
    const clip = await sheetClip(page, card!.x, card!.y, card!.w, card!.h);
    await repaintCharts(page);
    await page.waitForTimeout(800);
    const [deSample] = await samplePixelGrids(page, [clip]);

    await startTextRecorder(page);
    const sv = await pickLocaleInSettings(page, "sv-SE", "sv-SE");
    await onCanvas(page);
    const grouped = new RegExp(`^\\d{1,3}(${sep(sv.thousandsSeparator)}\\d{3})+$`);
    // The CARD's text: grouped AND with its decimals, reading the total (the
    // year pivot repaints grouped numbers too, its Grand Total without
    // decimals -- see J4).
    const cardGrouped = new RegExp(`^\\d{1,3}(${sep(sv.thousandsSeparator)}\\d{3})+${sep(sv.decimalSeparator)}\\d+$`);
    await eventually(
      () => recordedTexts(page),
      (t) => t.some((x) => cardGrouped.test(x) && Math.abs(readLocaleNumber(x, sv) - s.total) < 1),
      `after the switch no Card wrote the total grouped with sv-SE's U+${sv.thousandsSeparator.charCodeAt(0).toString(16).toUpperCase()}`,
      20_000,
    );

    const years = await eventually(() => memberView(page, s.yearPivotId), (v) => dataTexts(v).some((t) => grouped.test(t)), "the year pivot was not re-read in sv-SE", 30_000);
    expect(dataTexts(years).filter((t) => /\d\.\d{3}/.test(t)), "a pivot data cell still carries de-DE grouping").toEqual([]);
    const prices = await memberView(page, s.pricePivotId);
    const fractional = headerCells(prices).find((h) => !!h.cell.member && /^\d+\.\d+$/.test(h.cell.member.key) && !Number.isInteger(Number(h.cell.member.key)));
    expect(fractional?.cell.member?.label ?? "", "the listprice label does not use sv-SE's decimal comma").toMatch(/^\d+,\d+$/);

    await page.waitForTimeout(800);
    const [svSample] = await samplePixelGrids(page, [clip]);
    await page.waitForTimeout(400);
    const [svAgain] = await samplePixelGrids(page, [clip]);
    const area = clip.width * clip.height;
    expect(diffCount(deSample, svSample), "the Card's pixels did not change with the locale").toBeGreaterThan(Math.max(4, area * 0.0005));
    expect(diffCount(svSample, svAgain), "the Card is not stable under one locale (the comparison above would be noise)").toBeLessThan(Math.max(4, area * 0.0005));
  });

  // -------------------------------------------------------------------------
  test("J12 restore: System default clears the override; the boot override (if any) comes back; the settings file agrees", async ({ appPage: page }) => {
    const s = need();
    const sys = await pickLocaleInSettings(page, "system");
    expect(sys.overrideId ?? null, "System default left an override").toBeNull();
    expect(readAppSettingsOverride().localeOverride, "System default left an override in the settings file").toBeNull();
    if (s.boot.overrideId) await restoreBootLocale(page, s.boot);
    const after = await localeNow(page);
    expect(after.overrideId ?? null, "the profile's override is not the boot value").toBe(s.boot.overrideId ?? null);
    expect(readAppSettingsOverride().localeOverride, "the settings file does not hold the boot value").toBe(s.boot.overrideId ?? null);
    expect(after.localeId, "the app is not back on the locale it booted in").toBe(s.boot.localeId);
    await dropAdventureWorks(page, s.conn);
    connHeld = null;
  });
});
