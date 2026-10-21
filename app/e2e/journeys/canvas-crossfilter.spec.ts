/**
 * CROSS-FILTER, CROSS-HIGHLIGHT, EDIT INTERACTIONS AND RIBBON FILTERS ON EVERY
 * MODEL VISUAL, LIVE -- P4 S13 (canvas round 2, G2-B and G4).
 *
 * The owner's decisions: a ribbon filter reaches every model visual it is
 * scoped to -- PivotTables AND charts, cards, KPIs and gauges -- and the two
 * must agree (G2-B); a click on a visual's datum cross-filters (or
 * cross-highlights) the other visuals of its canvas page the way Power BI does,
 * and Canvas > Edit interactions says, per pair, Filter / Highlight / None (G4).
 * The spec is scratchpad r2/specs/P4-filters-xfilter.md section 5 (J1..J10).
 *
 * THE FIXTURE IS THE OWNER'S OWN MODEL. C:\Dropbox\Projekt\Calcula\
 * context_manager\model.json against Postgres AdventureWorks on localhost:5432
 * (postgres/postgres), through helpers/adventureworks-live.ts. An unreachable
 * server FAILS the run with that helper's sentence -- never a skip. Its tables
 * are schema-qualified (`BI.dim_territory`), so every field key is dotted and
 * every split goes through the model's own table list.
 *
 * ORACLES ARE NEVER TYPED IN. Every expected number comes from
 * `designQueryOracle` (helpers/crossfilter-live.ts): the product's pure DSL
 * compiler plus `run_design_query` invoked DIRECTLY with explicit
 * `pageFilterFields` / `tupleFilters` -- never through a chart, never through
 * `@api/reportFilters`, so a resolver defect cannot make the visual and its
 * oracle agree. A non-rectangular selection's oracle is a SUM of rectangular
 * oracle queries, and is asserted to DIFFER from the rectangular product.
 *
 * WHAT IS ASSERTED. The selection seam (`selectionState`), the backend's
 * layout (`layoutInteractions`), its ribbon filters, its undo stack and dirty
 * flag, the saved archive's bytes, the renderer's cached data (values,
 * highlight values, member paths), the pivot box's displayed and REAL views,
 * a GETPIVOTDATA cell, the DOM of Edit interactions, the cursor the user sees,
 * and RELATIVE pixel samples (the same patch before and after, plus an
 * untouched control patch). Never a golden (R14).
 *
 * ONE WORKBOOK, SERIAL. `beforeAll` builds it (Sheet1 with a GETPIVOTDATA cell
 * and the range chart's cells; one canvas "Report" with C1, C2, P1e, K, K2, L,
 * PV, S, R and C3); J1..J10 run on it in order, and a failure stops the chain
 * (`mode: "serial"`) so no later step passes on a state an earlier step never
 * reached.
 *
 * DEVIATIONS FROM THE SPEC'S TEXT (each keeps its intent):
 *   - J3b: the spec sets "the J2 ribbon filter" to the member m of D, but the J2
 *     filter is on categoryname and m is a member of D. J3b makes a second
 *     ribbon filter on D (the store's own create door, then the CARD's checklist
 *     for the selection, which is the gesture under test) and removes it after.
 *   - J7: "Undo the S -> PV pair" after selecting 2013 would undo the slicer
 *     click first (it is the newer step). So the order is S -> K None, then 2013
 *     in S (PV's real view folds to 2013 -- a precondition with teeth), then
 *     S -> PV None (the re-fold to unfiltered, DC-9), then ONE Ctrl+Z, which
 *     must bring back both the pair and the 2013 fold.
 *   - J8: K follows neither C1 (J6 set C1 -> K None) nor S (J7 set S -> K None)
 *     by then, so "K still equals oracle(Europe)" is checked on L instead (L
 *     follows C1 by Filter -- a line cannot highlight -- and S): L's total equals
 *     oracle(Europe, 2013) before and after the sheet switch, and K stays the
 *     unfiltered oracle.
 *   - J7 "its definition carries no hidden_items for year" is read through the
 *     pivot facade's stored field configuration (`getPivotFieldConfiguration`),
 *     the only TS read of the definition's hidden items.
 *   - Objects whose body ACTS on a press (a source bar, a slicer item) are
 *     selected as OBJECTS through Core's selection seam (`selectObjectByRef`)
 *     before Edit interactions: a press there would cross-filter or toggle an
 *     item, which is a different gesture from "select the source".
 *
 * WRITTEN, NOT RUN (P4 S13: implementation steps never run E2E, R12). The proof
 * phase runs it with E2E_MANUAL=1 after a fresh `tauri` build (memory
 * e2e_manual_launch_after_rust_change.md). S8 (the Slicer side) lands in the
 * same wave: J3's has-data, J6's slicer strip and J7 need it.
 *
 * SABOTAGES FOR THE PROOF PHASE (spec section 5; run each once, confirm it
 * changed behaviour, see the named assertion fail, revert):
 *   SB1 resolve.ts keeps the target's own selection   -> J3 "C1 keeps every category"
 *   SB2 resolve.ts ignores explicit pairs             -> J6 "K stays unfiltered under None"
 *   SB3 always rectangular field filters              -> J5 "K differs from the rectangular oracle"
 *   SB4 pivotVisualOverlay paints the real view only  -> J3 "PV paints the filtered view"
 *   SB5 page_model_slicers drops the interaction (Rust) -> J7 "PV real total unfiltered under S -> PV None"
 *   SB6 filterReportPublisher scope all for manual    -> J2 "K returns to unfiltered under Selected visuals"
 *   SB7 chartZoneAt drops the Design Mode guard       -> J9 "the ladder selects the series"
 *   SB8 selections.ts no reset on AFTER_OPEN          -> J8 "reopen: the selection is empty"
 *   SB9 refold_after_interaction_change no pivots (Rust) -> J10 "PV real total unfiltered after the MCP write"
 *   SB10 crossFilterClick builds the tuple from the LABEL -> J3b "the selection holds the key"
 */
import type { Locator, Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync } from "fflate";
import { test, expect } from "../fixtures";
import {
  MOD,
  addCanvas,
  callModule,
  clickCanvasControl,
  closeCanvasFlyouts,
  clickEmpty,
  clickSheetTab,
  createChart,
  eventually,
  freeCanvasRect,
  gridKey,
  humanClick,
  installAppImport,
  invoke,
  isDirty,
  newFile,
  openFileAtPath,
  patchActiveCanvas,
  persistedCharts,
  pivotRegions,
  sheetsResult,
  slicersAll,
  tryInvoke,
  undoState,
} from "../helpers/canvas-live";
import { readCell, renameSheetByName, setCells } from "../helpers/calp-harness";
import { awPivotView, connectAdventureWorks, createAwCanvasPivot, dropAdventureWorks, AW_CONNECTION_STRING, AW_SOURCE_ID, type AwConnection } from "../helpers/adventureworks-live";
import { startTextRecorder, recordedTexts } from "../helpers/chart-paint";
import { readGridGeometry } from "../helpers/grid";
import { samplePixels, diffCount, type PixelClip } from "../viewportSample";
import { luminance, sheetClip } from "../helpers/object-pane";
import { allowScripts, settleInPage, startObjectScript } from "../helpers/pivot-live";
import { slicerItemPoint, slicerLanded } from "../helpers/slicers";
import { startMcp } from "../helpers/calp-mcp";
import {
  XF_MOD,
  barPoint,
  barPointAt,
  cardText,
  chartCache,
  clearAllSelections,
  cursorAt,
  designQueryOracle,
  designQueryOracleOutcome,
  filteredPivotView,
  forgetOracleModels,
  grandTotalOf,
  groupMemberKeys,
  layoutInteractions,
  measureOf,
  near,
  pairKeys,
  parseAppNumber,
  patchAt,
  pieHighlight,
  pivotBadge,
  pivotHiddenItems,
  plotGapPoint,
  rgbDistance,
  selectObjectByRef,
  selectionState,
  seriesTotal,
  titleShowsDirty,
  undoSignature,
  valuesByMember,
  type OracleFieldFilter,
  type OracleTupleFilter,
  type XfChartData,
  type XfInteractions,
  type XfVisualRef,
} from "../helpers/crossfilter-live";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECTION_NAME = "AW cross-filter";
const REPORT = "Report";
const ZOOM_PERCENT = 70;

const TERRITORY = "BI.dim_territory.territorygroup";
const CATEGORY = "BI.dim_product.categoryname";
const YEAR = "BI.dim_date.year";

const EUROPE = "Europe";
const PACIFIC = "Pacific";
const BIKES = "Bikes";
const ACCESSORIES = "Accessories";

const DSL_C1 = `ROWS: ${TERRITORY}\nVALUES: [Revenue]`;
const DSL_C2 = `ROWS: ${TERRITORY}\nCOLUMNS: ${CATEGORY}\nVALUES: [Revenue]`;
const DSL_P1E = `ROWS: ${CATEGORY}\nVALUES: [Revenue]`;
const DSL_K = "VALUES: [Revenue]";
const DSL_K2 = "VALUES: [% Revenue of Total]";
const DSL_L = `ROWS: ${YEAR}\nVALUES: [Revenue]`;

/** The engine's refusal of a compound measure under a tuple filter, as S4b prefixes it. */
const TUPLE_REFUSAL = "This visual cannot apply the selection from another visual here";
/** The undo label of an Edit interactions change (S4a / S4d). */
const INTERACTION_STEP = "Change visual interaction";
/** A range chart's reason in Edit interactions (Charts' RANGE_CHART_REASON). */
const RANGE_REASON = "Reads cells, not the model";

const FILTER_STORE = XF_MOD.FILTER_STORE;
const WORK = path.join(os.tmpdir(), "calcula-canvas-crossfilter");
const FILE_BASE = path.join(WORK, "j2-base.cala");
const FILE_WITH = path.join(WORK, "j8-with-interactions.cala");
const FILE_WITHOUT = path.join(WORK, "j8-without.cala");

/** Two clicks at one point closer than this fuse into a dblclick (chart-interaction.spec.ts). */
const SLOW_CLICK_GAP_MS = 650;

// The page layout (sheet px of the 1280 x 720 page).
const AT = {
  C1: { x: 20, y: 20, width: 360, height: 230 },
  C2: { x: 400, y: 20, width: 440, height: 230 },
  P1E: { x: 860, y: 20, width: 300, height: 230 },
  K: { x: 20, y: 270, width: 200, height: 110 },
  K2: { x: 240, y: 270, width: 300, height: 170 },
  L: { x: 560, y: 270, width: 300, height: 170 },
  S: { x: 880, y: 270, width: 160, height: 230 },
  PV: { x: 20, y: 460, width: 340, height: 240 },
  R: { x: 380, y: 460, width: 260, height: 240 },
  C3: { x: 660, y: 460, width: 380, height: 240 },
} as const;

// ---------------------------------------------------------------------------
// Shared state (one workbook, built by beforeAll)
// ---------------------------------------------------------------------------

interface LocaleWire {
  localeId: string;
  overrideId: string | null;
  decimalSeparator: string;
  listSeparator: string;
}

interface Scene {
  conn: AwConnection;
  sheet1Index: number;
  reportIndex: number;
  reportSheetId: string;
  c1: string;
  c2: string;
  p1e: string;
  k: string;
  k2: string;
  l: string;
  r: string;
  c3: string;
  pv: string;
  s: string;
  /** The DECIMAL column J3b keys on, and the member whose sv-SE label differs from its key. */
  d: { field: string; key: string; label: string };
  /** Every territory group the model has (C1's categories, unfiltered). */
  groups: string[];
  /** The year S selects in J7 / J10. */
  year: string;
  /** The J2 ribbon filter. */
  ribbonId: string;
  /** A free sheet-px rect of the page: the empty-page clicks and the untouched control patch. */
  free: { x: number; y: number; width: number; height: number };
  /** The unfiltered [Revenue]. */
  total: number;
}

let scene: Scene | null = null;
let bootLocale: LocaleWire | null = null;
let previousSecurityLevel = "prompt";
const connsMade: AwConnection[] = [];

function need(): Scene {
  if (!scene) throw new Error("the scene was not built (beforeAll failed); every step needs it");
  return scene;
}

const chartRef = (id: string): XfVisualRef => ({ kind: "chart", id });

// ---------------------------------------------------------------------------
// Oracle shortcuts
// ---------------------------------------------------------------------------

async function revenue(page: Page, filters: OracleFieldFilter[] = [], tuples: OracleTupleFilter[] = []): Promise<number> {
  return measureOf(await designQueryOracle(page, need().conn.connectionId, DSL_K, filters, tuples));
}

function f(field: string, ...keys: string[]): OracleFieldFilter {
  return { field, keys };
}

// ---------------------------------------------------------------------------
// Navigation
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

async function onReport(page: Page): Promise<void> {
  const s = need();
  if ((await activeIndex(page)) !== s.reportIndex) {
    await clickSheetTab(page, s.reportIndex);
    await eventually(() => activeIndex(page), (i) => i === s.reportIndex, "the Report canvas did not become the active sheet");
  }
  await ensureZoom(page);
}

/** Park the pointer on the free page area (no hover state on any visual). */
async function parkPointer(page: Page): Promise<void> {
  const s = need();
  const clip = await sheetClip(page, s.free.x + s.free.width - 8, s.free.y + s.free.height - 8, 2, 2);
  await page.mouse.move(clip.x, clip.y);
  await page.waitForTimeout(250);
}

/** A click the way a hand makes one, then the slow gap so the next click cannot fuse into a dblclick. */
async function click(page: Page, at: { x: number; y: number }, opts: { ctrl?: boolean } = {}): Promise<void> {
  if (opts.ctrl) await page.keyboard.down("Control");
  try {
    await humanClick(page, at.x, at.y);
  } finally {
    if (opts.ctrl) await page.keyboard.up("Control");
  }
  await page.waitForTimeout(SLOW_CLICK_GAP_MS);
}

// ---------------------------------------------------------------------------
// Waits on what the visuals show
// ---------------------------------------------------------------------------

async function waitChart(page: Page, id: string, ok: (d: XfChartData) => boolean, label: string, timeoutMs = 60_000): Promise<XfChartData> {
  const d = await eventually(() => chartCache(page, id), (x) => !!x && ok(x), label, timeoutMs);
  return d!;
}

async function waitCardValue(page: Page, id: string, expected: number, label: string): Promise<void> {
  await eventually(() => cardText(page, id), (t) => near(t.value, expected), `${label} (expected ${expected})`, 60_000);
}

async function waitSeriesTotal(page: Page, id: string, expected: number, label: string): Promise<void> {
  await waitChart(page, id, (d) => near(seriesTotal(d), expected), `${label} (expected a total of ${expected})`);
}

async function waitRealPivotTotal(page: Page, pivotId: string, expected: number, label: string): Promise<void> {
  await eventually(async () => grandTotalOf(await awPivotView(page, pivotId)), (t) => near(t, expected), `${label} (expected ${expected})`, 90_000);
}

/** Sheet1!A1 (the GETPIVOTDATA on PV), read with the app locale's parser. */
async function gpdValue(page: Page): Promise<number> {
  const c = await readCell(page, need().sheet1Index, "A1");
  return (await parseAppNumber(page, c.display)) ?? Number.NaN;
}

async function waitGpd(page: Page, expected: number, label: string): Promise<void> {
  // GETPIVOTDATA shows the value in the pivot's number format (#,##0): it is
  // compared to the rounded oracle.
  await eventually(() => gpdValue(page), (v) => Number.isFinite(v) && Math.abs(v - expected) <= 0.5 + 1e-9 * Math.abs(expected), `${label} (expected ${expected})`, 60_000);
}

async function waitSelection(page: Page, ok: (s: Awaited<ReturnType<typeof selectionState>>) => boolean, label: string): Promise<Awaited<ReturnType<typeof selectionState>>> {
  return eventually(() => selectionState(page), ok, label, 10_000);
}

// ---------------------------------------------------------------------------
// The Controls tab's ribbon filter card (the user's own route)
// ---------------------------------------------------------------------------

function dropdown(page: Page): Locator {
  return page.locator('[data-testid="controls-pane-filter-dropdown"]');
}

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

async function storedSelection(page: Page, filterId: string): Promise<string[] | null> {
  const fl = await callModule<{ selectedItems?: string[] | null } | undefined>(page, FILTER_STORE, "getFilterById", [filterId]);
  return fl?.selectedItems ?? null;
}

/** Keep exactly `keys` through the checklist (Select None, tick, OK). */
async function selectFilterKeys(page: Page, filterId: string, keys: string[]): Promise<void> {
  await openFilter(page, filterId);
  await dropdown(page).getByRole("button", { name: "Select None", exact: true }).click();
  for (const k of keys) {
    await dropdown(page).locator(`[data-testid="controls-pane-filter-item"][data-value="${k}"] input`).check();
  }
  await dropdown(page).getByRole("button", { name: "OK", exact: true }).click();
  await eventually(
    () => storedSelection(page, filterId),
    (sel) => Array.isArray(sel) && [...sel].sort().join("|") === [...keys].sort().join("|"),
    `selecting ${JSON.stringify(keys)} and pressing OK did not store the selection`,
  );
  await closeFilterDropdown(page);
}

/** Every item again (Select All, OK): the filter stops filtering. */
async function clearFilterKeys(page: Page, filterId: string): Promise<void> {
  await openFilter(page, filterId);
  await dropdown(page).getByRole("button", { name: "Select All", exact: true }).click();
  await dropdown(page).getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForTimeout(500);
  await closeFilterDropdown(page);
}

/** The card's Connections panel: pick a mode (Power BI's words) and its targets, Save. */
async function setConnectionMode(
  page: Page,
  filterId: string,
  mode: "Selected visuals" | "Selected pages" | "All pages",
  opts: { visuals?: XfVisualRef[]; sheets?: string[] } = {},
): Promise<void> {
  await openFilter(page, filterId);
  await dropdown(page).getByRole("button", { name: "Connections", exact: true }).click();
  await expect(dropdown(page).getByText("Report connections"), "the Connections panel did not open").toBeVisible({ timeout: 5000 });
  await dropdown(page).locator("label", { hasText: mode }).locator('input[type="radio"]').check();
  if (mode === "Selected visuals") {
    // Every listed row reflects exactly `visuals`: unticked unless named.
    const rows = dropdown(page).locator("label[data-visual-ref]");
    const n = await rows.count();
    const wanted = new Set((opts.visuals ?? []).map((v) => `${v.kind}:${v.id}`));
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const key = (await row.getAttribute("data-visual-ref")) ?? "";
      const box = row.locator('input[type="checkbox"]');
      if (wanted.has(key)) await box.check();
      else await box.uncheck();
    }
    for (const key of wanted) {
      await expect(dropdown(page).locator(`label[data-visual-ref="${key}"]`), `the Report connections list does not offer ${key}`).toHaveCount(1);
    }
    // No PivotTable row is ticked: they are listed first, with the kind tag "PivotTable".
    const pivotRows = dropdown(page).locator("label", { hasText: "PivotTable" }).locator('input[type="checkbox"]');
    for (let i = 0; i < (await pivotRows.count()); i++) await pivotRows.nth(i).uncheck();
  }
  if (mode === "Selected pages") {
    // Only the panel's SHEET rows: a label whose whole text is a sheet name
    // (the value checklist above the panel has checkboxes too, and must not
    // be touched).
    const wanted = new Set(opts.sheets ?? []);
    const sheetNames = new Set((await sheetsResult(page)).sheets.map((x) => x.name));
    const boxes = dropdown(page).locator("label").filter({ has: page.locator('input[type="checkbox"]') });
    const n = await boxes.count();
    let touched = 0;
    for (let i = 0; i < n; i++) {
      const row = boxes.nth(i);
      if ((await row.locator('xpath=ancestor-or-self::*[@data-testid="controls-pane-filter-item"]').count()) > 0) continue;
      const text = ((await row.innerText()) ?? "").trim();
      if (!sheetNames.has(text)) continue;
      touched++;
      const box = row.locator('input[type="checkbox"]');
      if (wanted.has(text)) await box.check();
      else await box.uncheck();
    }
    expect(touched, "the Selected pages panel does not list every sheet").toBe(sheetNames.size);
  }
  await dropdown(page).getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(600);
  await closeFilterDropdown(page);
}

interface RibbonFilterRow {
  id: string;
  fieldName: string;
  connectionMode?: string;
  selectedItems?: string[] | null;
  connectedVisuals?: XfVisualRef[];
  connectedPivots?: string[];
  connectedSheets?: number[];
}

async function backendRibbonFilter(page: Page, id: string): Promise<RibbonFilterRow> {
  const all = await invoke<RibbonFilterRow[]>(page, "get_all_ribbon_filters");
  const row = all.find((r) => r.id === id);
  if (!row) throw new Error(`the backend holds no ribbon filter ${id}`);
  return row;
}

// ---------------------------------------------------------------------------
// Edit interactions (Canvas > Arrange)
// ---------------------------------------------------------------------------

const overlay = (page: Page): Locator => page.locator("[data-canvas-interactions]");
const strip = (page: Page, ref: XfVisualRef): Locator => page.locator(`[data-testid="canvas-interaction-${ref.kind}-${ref.id}"]`);
const modeButton = (page: Page, ref: XfVisualRef, mode: "filter" | "highlight" | "none"): Locator =>
  page.locator(`[data-testid="canvas-interaction-${ref.kind}-${ref.id}-${mode}"]`);

/** Select `source` as an object, then turn Edit interactions on. */
async function enterEditInteractions(page: Page, source: XfVisualRef): Promise<void> {
  await onReport(page);
  await selectObjectByRef(page, source);
  await clickCanvasControl(page, "canvas-edit-interactions");
  await expect(overlay(page), "Edit interactions shows no strips").toHaveCount(1, { timeout: 8000 });
  await expect(page.locator('[data-testid="canvas-edit-interactions"]'), "the toggle is not pressed").toHaveAttribute("aria-pressed", "true");
  // At a narrow ribbon the toggle lives in the folded Arrange group's flyout,
  // which stays open after the click (a collapsed group keeps its flyout) and
  // lies over the strips of the visuals under it. Close it the way a user
  // does -- its group button -- and prove the mode survived.
  await closeCanvasFlyouts(page);
  await expect(overlay(page), "closing the Arrange flyout ended Edit interactions").toHaveCount(1, { timeout: 3000 });
}

async function exitEditInteractions(page: Page): Promise<void> {
  if ((await overlay(page).count()) === 0) return;
  await gridKey(page, "Escape");
  await expect(overlay(page), "Escape did not end Edit interactions").toHaveCount(0, { timeout: 5000 });
}

/** One pair through the strip, as ONE undo step "Change visual interaction". */
async function setPairByStrip(page: Page, source: XfVisualRef, target: XfVisualRef, mode: "filter" | "highlight" | "none"): Promise<void> {
  const s = need();
  const before = await undoState(page);
  const depthBefore = (before as { undoDepth?: number }).undoDepth ?? -1;
  await modeButton(page, target, mode).click();
  await eventually(
    () => layoutInteractions(page, s.reportIndex),
    // Every pick here is a NON-default mode (the UI writes only those), so it
    // must appear as an explicit pair.
    (i) => pairKeys(i).includes(`${source.kind}:${source.id} -> ${target.kind}:${target.id} = ${mode}`),
    `the ${source.kind}:${source.id} -> ${target.kind}:${target.id} = ${mode} pick did not reach the layout`,
    30_000,
  );
  const after = await eventually(() => undoState(page), (u) => u.undoDescription === INTERACTION_STEP, `the pick recorded no "${INTERACTION_STEP}" step`, 30_000);
  const depthAfter = (after as { undoDepth?: number }).undoDepth ?? -1;
  if (depthBefore >= 0 && depthAfter >= 0) expect(depthAfter, "the pick recorded more or less than ONE step").toBe(depthBefore + 1);
  await expect(modeButton(page, target, mode), "the picked mode is not pressed").toHaveAttribute("aria-pressed", "true");
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

function archiveEntries(file: string): Record<string, string> {
  if (!fs.existsSync(file)) throw new Error(`nothing was saved at ${file}`);
  const raw = unzipSync(new Uint8Array(fs.readFileSync(file)));
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(raw)) out[name] = new TextDecoder().decode(bytes);
  return out;
}

function manifestOf(entries: Record<string, string>): { formatVersion: number; features: string[] } {
  const text = entries["manifest.json"];
  if (!text) throw new Error(`the archive has no manifest.json (entries: ${Object.keys(entries).join(", ")})`);
  const m = JSON.parse(text) as { formatVersion: number; features?: string[] };
  return { formatVersion: m.formatVersion, features: m.features ?? [] };
}

async function saveTo(page: Page, file: string): Promise<void> {
  fs.rmSync(file, { force: true });
  const res = await invoke<{ success?: boolean } | null>(page, "save_file", { path: file });
  expect(res === null || res?.success !== false, `save_file refused: ${JSON.stringify(res)}`).toBe(true);
  await eventually(async () => fs.existsSync(file), (v) => v, `nothing was written at ${file}`);
}

// ---------------------------------------------------------------------------
// Re-binding after a reopen
// ---------------------------------------------------------------------------

/**
 * After a reopen: the objects by NAME (never trusting an id across a load),
 * the connection the charts read (a reopen may re-create it from the file),
 * and that connection connected to Postgres -- an unreachable server FAILS.
 */
async function rebindScene(page: Page): Promise<void> {
  const s = need();
  const sheets = await sheetsResult(page);
  const report = sheets.sheets.find((x) => x.name === REPORT);
  expect(report, "the reopened workbook has no Report canvas").toBeTruthy();
  s.reportIndex = report!.index;
  s.reportSheetId = report!.sheetId ?? s.reportSheetId;
  s.sheet1Index = sheets.sheets.find((x) => x.name === "Sheet1")!.index;
  const charts = await eventually(() => persistedCharts(page), (cs) => cs.length >= 8, "the reopened workbook holds fewer than 8 charts", 30_000);
  const byName = (n: string): string => {
    const c = charts.find((x) => x.name === n);
    if (!c) throw new Error(`the reopened workbook has no chart ${n}`);
    return c.id;
  };
  s.c1 = byName("C1");
  s.c2 = byName("C2");
  s.p1e = byName("P1e");
  s.k = byName("K");
  s.k2 = byName("K2");
  s.l = byName("L");
  s.r = byName("R");
  s.c3 = byName("C3");
  const connectionId = String((charts.find((x) => x.id === s.c1)!.spec.data as { connectionId?: string }).connectionId ?? "");
  expect(connectionId, "C1's spec names no connection after the reopen").not.toBe("");
  if (connectionId !== s.conn.connectionId) {
    s.conn = { connectionId, name: CONNECTION_NAME };
    connsMade.push(s.conn);
  }
  forgetOracleModels();
  const probe = await designQueryOracleOutcome(page, connectionId, DSL_K);
  if ("error" in probe) {
    const connected = await tryInvoke(page, "bi_model_connect_source", { connectionId, sourceId: AW_SOURCE_ID, connectionString: AW_CONNECTION_STRING, remember: false });
    expect("error" in connected ? connected.error : "", "the reopened connection could not be connected to Postgres").toBe("");
  }
  const slicers = await slicersAll(page);
  const sl = slicers.find((x) => x.name === "S");
  expect(sl, "the reopened workbook has no slicer S").toBeTruthy();
  s.s = sl!.id;
  await onReport(page);
  const regions = await eventually(() => pivotRegions(page), (r) => r.length === 1, "the reopened Report holds no single pivot box", 60_000);
  s.pv = regions[0].pivotId;
}

// ---------------------------------------------------------------------------
// Scripts (a REAL object-script realm, through the broker)
// ---------------------------------------------------------------------------

/**
 * Run `body` (with `api` in scope) once in a real worker realm and return what
 * it wrote into Sheet1!J1 -- the script's only way to hand a value back. A
 * thrown error is written as `ERR <message>`.
 */
async function scriptResult(page: Page, key: string, body: string): Promise<string> {
  const s = need();
  const wrapped =
    `  let out;\n  try {\n${body}\n  } catch (e) {\n    out = "ERR " + (e && e.message ? e.message : String(e));\n  }\n` +
    `  await api.setCellValue(0, 9, typeof out === "string" ? out : JSON.stringify(out), "Sheet1");`;
  await startObjectScript(page, key, `cross-filter ${key}`, wrapped);
  await settleInPage(page, key, 60_000);
  const c = await readCell(page, s.sheet1Index, "J1");
  return c.display;
}

// ===========================================================================

test.describe("Cross-filter, cross-highlight, Edit interactions and ribbon filters on every model visual (P4), live on AdventureWorks", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test.beforeAll(async ({ sharedPage: page }) => {
    test.setTimeout(600_000);
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    await installAppImport(page);
    previousSecurityLevel = await invoke<string>(page, "get_script_security_level").catch(() => "prompt");
    bootLocale = await invoke<LocaleWire>(page, "get_locale_settings", {});
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]).catch(() => undefined);
    await newFile(page);

    const conn = await connectAdventureWorks(page, CONNECTION_NAME);
    connsMade.push(conn);

    // ---- Sheet1: the range chart's cells (A10:B14); A1 gets the GETPIVOTDATA once PV exists.
    const sheets0 = await sheetsResult(page);
    const sheet1Index = sheets0.sheets.find((x) => x.name === "Sheet1")!.index;
    await setCells(page, sheet1Index, [
      ["A10", "Month"],
      ["B10", "Units"],
      ["A11", "Jan"],
      ["B11", "10"],
      ["A12", "Feb"],
      ["B12", "40"],
      ["A13", "Mar"],
      ["B13", "20"],
      ["A14", "Apr"],
      ["B14", "30"],
    ]);

    // ---- The canvas "Report".
    const canvas = await addCanvas(page);
    await renameSheetByName(page, canvas.name, REPORT);
    const sheets1 = await sheetsResult(page);
    const report = sheets1.sheets.find((x) => x.name === REPORT)!;
    expect(report.sheetId, "the Report canvas has no sheet id").toBeTruthy();
    if ((await activeIndex(page)) !== report.index) await clickSheetTab(page, report.index);
    await patchActiveCanvas(page, { showGrid: false, snapToGrid: false });
    await ensureZoom(page);
    await startTextRecorder(page);

    const total = measureOf(await designQueryOracle(page, conn.connectionId, DSL_K));
    const byGroup = valuesByMember(await designQueryOracle(page, conn.connectionId, DSL_C1));
    const groups = Object.keys(byGroup).sort();
    for (const g of [EUROPE, PACIFIC]) expect(groups, `the model has no territory group ${g}`).toContain(g);
    expect(byGroup[EUROPE], "Europe would not narrow Revenue: the journey would be vacuous").toBeLessThan(total);

    const dq = (mark: string, dslText: string, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      mark,
      data: { type: "designQuery", dslText, connectionId: conn.connectionId },
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [],
      title,
      ...extra,
    });
    const place = (at: { x: number; y: number; width: number; height: number }, name: string) => ({ sheetIndex: report.index, ...at, name });
    const c1 = await createChart(page, dq("bar", DSL_C1, "Revenue by group"), place(AT.C1, "C1"), { waitPaint: false });
    const c2 = await createChart(page, dq("bar", DSL_C2, "Revenue by group and category"), place(AT.C2, "C2"), { waitPaint: false });
    const p1e = await createChart(page, dq("pie", DSL_P1E, "Revenue by category"), place(AT.P1E, "P1e"), { waitPaint: false });
    const k = await createChart(page, dq("card", DSL_K, "Revenue", { markOptions: { displayUnits: "none" } }), place(AT.K, "K"), { waitPaint: false });
    const k2 = await createChart(page, dq("card", DSL_K2, "Share", { markOptions: { displayUnits: "none" } }), place(AT.K2, "K2"), { waitPaint: false });
    const l = await createChart(page, dq("line", DSL_L, "Revenue by year"), place(AT.L, "L"), { waitPaint: false });
    const r = await createChart(
      page,
      {
        mark: "bar",
        data: { sheetIndex: sheet1Index, startRow: 9, startCol: 0, endRow: 13, endCol: 1 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
        title: "Units (cells)",
      },
      place(AT.R, "R"),
      { waitPaint: false },
    );

    const pv = await createAwCanvasPivot(page, {
      canvasIndex: report.index,
      connectionId: conn.connectionId,
      frame: AT.PV,
      rows: [{ table: "BI.dim_territory", column: "territorygroup" }],
      columns: [],
      values: [{ measureName: "Revenue" }],
      name: "PV",
    });

    const years = (await invoke<unknown[]>(page, "bi_get_column_values", { connectionId: conn.connectionId, table: "BI.dim_date", column: "year" })).map((m) =>
      typeof m === "string" ? m : String((m as { key: unknown }).key),
    );
    expect(years.length, `the model answered fewer than 2 years: ${JSON.stringify(years)}`).toBeGreaterThanOrEqual(2);
    const year = years.includes("2013") ? "2013" : years[1];

    const slicer = await callModule<{ id: string } | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
      {
        name: "S",
        sheetIndex: report.index,
        ...AT.S,
        sourceType: "biConnection",
        cacheSourceId: conn.connectionId,
        fieldName: YEAR,
        connectedSources: [{ sourceType: "biConnection", sourceId: conn.connectionId }],
      },
    ]);
    expect(slicer, "the model slicer S was not created").toBeTruthy();
    await eventually(
      () => callModule<Array<{ key: string }> | undefined>(page, MOD.SLICER_STORE, "getCachedItems", [slicer!.id]),
      (it) => (it ?? []).some((x) => x.key === year),
      `the model slicer S does not list ${year}`,
      30_000,
    );

    // ---- D: the first DECIMAL model column with < 50 members, one of whose
    // sv-SE labels differs from its key (read with the locale switched).
    const biModel = await invoke<{ tables: Array<{ name: string; columns: Array<{ name: string; dataType: string; isNumeric: boolean }> }> }>(page, "get_connection_bi_model", {
      connectionId: conn.connectionId,
    });
    await invoke(page, "set_locale", { localeId: "sv-SE" });
    let d: Scene["d"] | null = null;
    try {
      outer: for (const t of biModel.tables) {
        for (const c of t.columns) {
          if (!/decimal/i.test(c.dataType)) continue;
          const members = await invoke<Array<{ key: string; label: string }>>(page, "bi_get_column_values", { connectionId: conn.connectionId, table: t.name, column: c.name });
          if (!Array.isArray(members) || members.length === 0 || members.length >= 50) continue;
          const m = members.find((x) => typeof x === "object" && x.key !== "" && x.label !== x.key);
          if (m) {
            d = { field: `${t.name}.${c.name}`, key: m.key, label: m.label };
            break outer;
          }
        }
      }
    } finally {
      await invoke(page, "set_locale", { localeId: bootLocale.overrideId ?? "system" });
    }
    expect(d, "no DECIMAL model column with fewer than 50 members has a member whose sv-SE label differs from its key: J3b would be vacuous").not.toBeNull();
    const c3 = await createChart(page, dq("bar", `ROWS: ${d!.field}\nVALUES: [Revenue]`, "Revenue by D"), place(AT.C3, "C3"), { waitPaint: false });

    // ---- Sheet1!A1: GETPIVOTDATA on PV. The API's cell door reads a formula the
    // way a user types it -- in the APP locale since P2 -- so the argument
    // separator is the locale's own (";" in the owner's sv-SE; a "," there is a
    // decimal comma and the entry lands as text). The data field is the value
    // field's NAME, "[Revenue]" on a model pivot -- the spelling the product's own
    // pick writes (pivot/commands.rs names a measure field "[<measure>]").
    const sepNow = (await invoke<LocaleWire>(page, "get_locale_settings", {})).listSeparator;
    await setCells(page, sheet1Index, [["A1", `=GETPIVOTDATA("[Revenue]"${sepNow}${REPORT}!A1)`]]);

    const free = await freeCanvasRect(page, { width: 120, height: 80 });

    scene = {
      conn,
      sheet1Index,
      reportIndex: report.index,
      reportSheetId: report.sheetId!,
      c1,
      c2,
      p1e,
      k,
      k2,
      l,
      r,
      c3,
      pv,
      s: slicer!.id,
      d: d!,
      groups,
      year,
      ribbonId: "",
      free,
      total,
    };

    // Everything painted, unfiltered.
    await waitChart(page, c1, (x) => x.categories.length === groups.length, "C1 never painted its territory groups");
    await waitChart(page, c2, (x) => x.series.length > 1, "C2 never painted a series per category");
    await waitChart(page, p1e, (x) => x.categories.length > 1, "P1e never painted its categories");
    await waitCardValue(page, k, total, "K never showed the model's total");
    await waitChart(page, k2, (x) => Number.isFinite(x.series[0]?.values[0] ?? Number.NaN), "K2 never showed the share");
    await waitChart(page, l, (x) => x.categories.length > 1, "L never painted its years");
    await waitChart(page, r, (x) => x.categories.length === 4, "R never painted its four months");
    await waitChart(page, c3, (x) => x.categories.length > 1, "C3 never painted D's members");
    await waitRealPivotTotal(page, pv, total, "PV's real grand total is not the model's total");
    await waitGpd(page, total, "Sheet1!A1 (GETPIVOTDATA on PV) is not the model's total");
    expect(await selectionState(page), "a fresh workbook holds a visual selection").toEqual([]);
  });

  test.afterAll(async ({ sharedPage: page }) => {
    await page.keyboard.press("Escape").catch(() => undefined);
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]).catch(() => undefined);
    if (bootLocale) await invoke(page, "set_locale", { localeId: bootLocale.overrideId ?? "system" }).catch(() => undefined);
    await newFile(page).catch(() => undefined);
    for (const c of connsMade) await dropAdventureWorks(page, c);
    const conns = await invoke<Array<{ id: string; name: string }>>(page, "bi_get_connections").catch(() => []);
    for (const c of conns) {
      if (c.name === CONNECTION_NAME) await invoke(page, "bi_delete_connection", { connectionId: c.id }).catch(() => undefined);
    }
    await invoke(page, "set_script_security_level", { level: previousSecurityLevel }).catch(() => undefined);
    fs.rmSync(WORK, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  test("J1 capabilities: with Design Mode off a C1 bar is a cross-filter press (the hand); the same over the range chart R is not", async ({ appPage: page }) => {
    const s = need();
    await onReport(page);
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]);
    const europe = await barPoint(page, s.c1, EUROPE);
    expect(await cursorAt(page, europe), "a C1 bar is not a cross-filter press: the cursor there is not the hand").toBe("pointer");
    const rBar = await barPointAt(page, s.r, 1);
    expect(await cursorAt(page, rBar), "a bar of the range chart R promises a cross-filter press").not.toBe("pointer");
    await parkPointer(page);
  });

  // -------------------------------------------------------------------------
  test("J2 G2-B: a ribbon filter on categoryname filters the Card and the PivotTable alike; Selected visuals reaches only C1; Selected pages (Sheet1) reaches nothing on Report", async ({ appPage: page }) => {
    test.setTimeout(420_000);
    const s = need();
    await onReport(page);
    await ensureControlsTab(page);
    const before = await filterCardIds(page);

    // Controls > Add > Filter on BI.dim_product.categoryname.
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
    if (await search.isVisible().catch(() => false)) await search.fill("categoryname");
    const field = page.locator(`[data-testid="controls-pane-add-filter-field"][data-field="${CATEGORY}"] input`);
    await field.waitFor({ state: "visible", timeout: 10_000 });
    await field.check();
    await page.locator('[data-testid="controls-pane-add-filter-create"]').click();
    await expect(page.locator('[data-testid="controls-pane-add-filter-create"]'), "the Add Filter dialog did not close").toHaveCount(0, { timeout: 15_000 });
    const after = await eventually(() => filterCardIds(page), (ids) => ids.length === before.length + 1, "Add Filter made no new card (or more than one)");
    s.ribbonId = after.find((id) => !before.includes(id))!;

    // The value list is non-empty (P1) and holds Bikes.
    await openFilter(page, s.ribbonId);
    const shown = await dropdown(page).locator('[data-testid="controls-pane-filter-item"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-value") ?? ""));
    expect(shown.length, "the categoryname filter lists no values").toBeGreaterThan(0);
    expect(shown, "the categoryname filter does not list Bikes").toContain(BIKES);
    await closeFilterDropdown(page);
    expect((await backendRibbonFilter(page, s.ribbonId)).connectionMode, "a new filter is not All pages").toBe("workbook");

    // All pages: K and PV both filtered, and they agree.
    await startTextRecorder(page);
    await selectFilterKeys(page, s.ribbonId, [BIKES]);
    const bikes = await revenue(page, [f(CATEGORY, BIKES)]);
    expect(bikes, "Bikes would not narrow Revenue").toBeLessThan(s.total);
    await waitCardValue(page, s.k, bikes, "K does not show Revenue of Bikes under the All pages ribbon filter");
    const card = await eventually(() => cardText(page, s.k), (t) => t.painted && t.display !== null, "K's painter never wrote its display", 30_000);
    const parsed = await parseAppNumber(page, card.display!);
    expect(parsed, `K's painted text "${card.display}" does not parse in the app locale`).not.toBeNull();
    expect(Math.abs(parsed! - bikes), `K's painted text "${card.display}" is not the oracle ${bikes}`).toBeLessThanOrEqual(0.5 + 1e-9 * bikes);
    await waitRealPivotTotal(page, s.pv, bikes, "PV's grand total is not Revenue of Bikes under the All pages ribbon filter");
    const kNow = (await cardText(page, s.k)).value;
    const pvNow = grandTotalOf(await awPivotView(page, s.pv));
    expect(near(kNow, pvNow), `the Card (${kNow}) and the PivotTable (${pvNow}) disagree under one ribbon filter`).toBe(true);

    // Selected visuals, only C1.
    await setConnectionMode(page, s.ribbonId, "Selected visuals", { visuals: [chartRef(s.c1)] });
    const persisted = await eventually(
      () => backendRibbonFilter(page, s.ribbonId),
      (r) => r.connectionMode === "manual" && (r.connectedVisuals ?? []).length === 1,
      "the backend does not hold the Selected visuals scope",
    );
    expect(persisted.connectedVisuals, "connectedVisuals is not [C1]").toEqual([{ kind: "chart", id: s.c1 }]);
    expect(persisted.connectedPivots ?? [], "a pivot is still connected under Selected visuals (C1 only)").toEqual([]);
    await waitCardValue(page, s.k, s.total, "K did not return to the unfiltered total under Selected visuals (C1 only)");
    await waitSeriesTotal(page, s.c1, bikes, "C1 is not filtered to Bikes under Selected visuals (C1)");
    await waitRealPivotTotal(page, s.pv, s.total, "PV did not return to unfiltered under Selected visuals (C1 only)");

    // Selected pages, Sheet1 only: nothing on Report is filtered.
    await setConnectionMode(page, s.ribbonId, "Selected pages", { sheets: ["Sheet1"] });
    await eventually(() => backendRibbonFilter(page, s.ribbonId), (r) => r.connectionMode === "bySheet", "the backend does not hold the Selected pages scope");
    await waitCardValue(page, s.k, s.total, "K is filtered under Selected pages (Sheet1 only)");
    await waitSeriesTotal(page, s.c1, s.total, "C1 is filtered under Selected pages (Sheet1 only)");
    await waitRealPivotTotal(page, s.pv, s.total, "PV is filtered under Selected pages (Sheet1 only)");

    // All pages again, then every item: later phases start unfiltered.
    await setConnectionMode(page, s.ribbonId, "All pages");
    await eventually(() => backendRibbonFilter(page, s.ribbonId), (r) => r.connectionMode === "workbook", "the backend does not hold All pages again");
    await clearFilterKeys(page, s.ribbonId);
    await waitCardValue(page, s.k, s.total, "K did not return to unfiltered once the ribbon filter keeps every item");
    await waitRealPivotTotal(page, s.pv, s.total, "PV did not return to unfiltered once the ribbon filter keeps every item");
    await onReport(page);
    await saveTo(page, FILE_BASE);
    expect(await isDirty(page), "the save left the document dirty").toBe(false);
  });

  // -------------------------------------------------------------------------
  test("J3 a plain click on C1's Europe bar: one selection by KEY; K filtered, P1e highlighted by name, C1 not filtered by itself (its other bars fade), PV paints a filtered view with a badge while its real view and GETPIVOTDATA stay, nothing dirty, S dims years without Europe", async ({ appPage: page }) => {
    test.setTimeout(420_000);
    const s = need();
    await onReport(page);
    expect(await isDirty(page), "precondition: the document is clean (J2 saved it)").toBe(false);
    const undoBefore = await undoSignature(page);
    const c1Before = await chartCache(page, s.c1);
    const otherGroups = (c1Before?.categories ?? []).filter((c) => c !== EUROPE);
    expect(otherGroups.length, "C1 has no other bar than Europe").toBeGreaterThan(0);

    // Pixels BEFORE: the other C1 bars, a P1e slice, the untouched control patch.
    await parkPointer(page);
    const otherPatches = await Promise.all(otherGroups.map(async (g) => patchAt(await barPoint(page, s.c1, g), 3)));
    const otherBefore = await Promise.all(otherPatches.map((p) => samplePixels(page, p)));
    const pieBefore = await pieHighlight(page, s.p1e);
    const control: PixelClip = await sheetClip(page, s.free.x + 10, s.free.y + 10, 30, 20);
    const controlBefore = await samplePixels(page, control);
    expect(rgbDistance(pieBefore.inner, pieBefore.outer), "precondition: an unhighlighted pie slice is not one colour").toBeLessThan(30);

    await startTextRecorder(page);
    await click(page, await barPoint(page, s.c1, EUROPE));
    const sel = await waitSelection(page, (x) => x.length === 1, "the click on Europe made no single selection");
    expect(sel[0].source, "the selection's source is not C1").toEqual({ kind: "chart", id: s.c1 });
    expect(sel[0].fields, "the selection's fields").toEqual([TERRITORY]);
    expect(sel[0].tuples, "the selection's tuples are not the Europe KEY").toEqual([[EUROPE]]);
    expect(sel[0].pageSheetId, "the selection is not on Report").toBe(s.reportSheetId);

    // K: filtered (a card cannot highlight, so the filter beats the highlight).
    const europe = await revenue(page, [f(TERRITORY, EUROPE)]);
    await waitCardValue(page, s.k, europe, "K does not show Revenue of Europe");

    // P1e: highlight values by NAME, values unfiltered.
    const pieAll = valuesByMember(await designQueryOracle(page, s.conn.connectionId, DSL_P1E), { byLabel: true });
    const pieEurope = valuesByMember(await designQueryOracle(page, s.conn.connectionId, DSL_P1E, [f(TERRITORY, EUROPE)]), { byLabel: true });
    const pie = await waitChart(page, s.p1e, (d) => Array.isArray(d.highlightValues) && d.highlightValues.length > 0, "P1e has no highlight values under C1's selection");
    pie.categories.forEach((cat, i) => {
      expect(near(pie.highlightValues![0][i] ?? 0, pieEurope[cat] ?? 0), `P1e's highlight of ${cat} is not Revenue of ${cat} in Europe`).toBe(true);
      expect(near(pie.series[0].values[i], pieAll[cat] ?? Number.NaN), `P1e's value of ${cat} is filtered (a highlight keeps the whole)`).toBe(true);
    });

    // C1: not filtered by itself -- every category, the same values.
    const c1After = await waitChart(page, s.c1, (d) => !!d.crossFilterSelf, "C1 does not know its own selection");
    expect(c1After.categories, "C1 lost categories under its own selection").toEqual(c1Before!.categories);
    expect(near(seriesTotal(c1After), s.total), "C1 is filtered by its own selection").toBe(true);
    // ...nor HIGHLIGHTED by it: a bar chart's default toward a bar chart is
    // Highlight, so a resolver that let the source's own selection through
    // would put it in C1's highlights (its values stay whole, so the checks
    // above cannot see that). The fading of C1's other bars is crossFilterSelf's.
    expect(c1After.highlightValues ?? null, "C1 is highlighted by its own selection").toBeNull();

    // Pixels AFTER.
    await parkPointer(page);
    await page.waitForTimeout(400);
    const otherAfter = await Promise.all(otherPatches.map((p) => samplePixels(page, p)));
    otherGroups.forEach((g, i) => {
      expect(luminance(otherAfter[i]), `C1's ${g} bar does not sample fainter than before`).toBeGreaterThan(luminance(otherBefore[i]) + 15);
    });
    const pieAfter = await pieHighlight(page, s.p1e);
    expect(rgbDistance(pieAfter.inner, pieAfter.outer), `P1e's ${pieAfter.label} slice shows no highlighted inner arc`).toBeGreaterThan(30);
    expect(diffCount(controlBefore, await samplePixels(page, control)), "the untouched control patch changed").toBe(0);

    // PV: the filtered view and its badge; the REAL view and GETPIVOTDATA unchanged.
    const badge = await eventually(() => pivotBadge(page, s.pv), (b) => b?.kind === "filtered", "PV paints no 'Filtered by' badge", 60_000);
    expect(badge!.text, "PV's badge does not name C1").toBe(`Filtered by ${sel[0].sourceName}`);
    expect(sel[0].sourceName, "the selection's source name is not C1's name").toBe("C1");
    await eventually(async () => grandTotalOf(await filteredPivotView(page, s.pv)), (t) => near(t, europe), "PV's displayed grand total is not Revenue of Europe", 60_000);
    // ...and that view is what the box PAINTS: its Grand Total text, as the
    // painter wrote it (the stored filtered view alone cannot show a painter
    // that went on drawing the real one).
    const filteredTotalText = String(
      ((await filteredPivotView(page, s.pv))?.rows ?? []).flatMap((r) => r.cells ?? []).find((c) => c.cellType === "GrandTotal")?.formattedValue ?? "",
    );
    expect(filteredTotalText, "PV's filtered view has no formatted Grand Total").not.toBe("");
    // K paints the same Europe total in the same "#,##0", so seeing that text
    // proves nothing about the BOX. What only the box can paint is the REAL
    // view's Grand Total: on a fresh repaint under the selection it must be gone.
    const realTotalText = String(
      ((await awPivotView(page, s.pv)).rows ?? []).flatMap((r) => r.cells ?? []).find((c) => c.cellType === "GrandTotal")?.formattedValue ?? "",
    );
    expect(realTotalText, "PV's real view has no formatted Grand Total").not.toBe("");
    await startTextRecorder(page);
    await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await eventually(() => recordedTexts(page), (t) => t.includes(filteredTotalText) && t.some((x) => x.startsWith("Filtered by")), `PV's box did not repaint the filtered Grand Total "${filteredTotalText}"`, 15_000);
    await page.waitForTimeout(800);
    expect((await recordedTexts(page)).includes(realTotalText), `PV's box painted the REAL Grand Total "${realTotalText}" under the selection`).toBe(false);
    await eventually(() => recordedTexts(page), (t) => t.some((x) => x.startsWith("Filtered by")), "PV's painter never wrote its badge", 15_000);
    expect(near(grandTotalOf(await awPivotView(page, s.pv)), s.total), "PV's REAL view was filtered by a visual selection").toBe(true);
    await waitGpd(page, s.total, "GETPIVOTDATA on PV moved under a visual selection");

    // View state: nothing dirty, no undo step.
    expect(await isDirty(page), "a cross-filter click dirtied the document").toBe(false);
    expect(await titleShowsDirty(page), "a cross-filter click raised the title asterisk").toBe(false);
    expect(await undoSignature(page), "a cross-filter click touched the undo stack").toBe(undoBefore);

    // S: years without Europe sales are dimmed (has-data), by the oracle.
    const available = (await invoke<unknown[]>(page, "bi_get_column_available_values", {
      connectionId: s.conn.connectionId,
      table: "BI.dim_date",
      column: "year",
      constraints: [{ table: "BI.dim_territory", column: "territorygroup", values: [EUROPE] }],
    })).map((m) => (typeof m === "string" ? m : String((m as { key: unknown }).key)));
    await eventually(
      () => callModule<Array<{ key: string; hasData: boolean }> | undefined>(page, MOD.SLICER_STORE, "getCachedItems", [s.s]),
      (items) =>
        !!items &&
        items.length > 0 &&
        items.filter((i) => i.hasData).map((i) => i.key).sort().join("|") === [...available].sort().join("|"),
      `S's years with data are not the oracle's ${JSON.stringify(available)} under Europe`,
      60_000,
    );
  });

  // -------------------------------------------------------------------------
  test("J3b keys under the app locale (sv-SE): C3's member is selected by KEY while its label is painted; a ribbon filter's card stores the KEY too", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    const s = need();
    await onReport(page);
    await clearAllSelections(page);
    await startTextRecorder(page);
    await invoke(page, "set_locale", { localeId: "sv-SE" });
    try {
      await eventually(() => invoke<LocaleWire>(page, "get_locale_settings", {}), (l) => l.localeId === "sv-SE", "the app locale did not become sv-SE");
      const c3 = await waitChart(page, s.c3, (d) => d.categories.includes(s.d.label), `C3 does not show the sv-SE label "${s.d.label}" of ${s.d.key}`);
      const ci = c3.categories.indexOf(s.d.label);
      expect(c3.categoryMembers?.[ci], `C3's category "${s.d.label}" does not carry the member KEY`).toEqual([{ field: s.d.field, key: s.d.key }]);
      await eventually(() => recordedTexts(page), (t) => t.includes(s.d.label), `C3's painter never wrote the sv-SE label "${s.d.label}"`, 15_000);
      const dqView = await designQueryOracle(page, s.conn.connectionId, `ROWS: ${s.d.field}\nVALUES: [Revenue]`);
      expect(groupMemberKeys(dqView, s.d.field), "run_design_query's groupMembers do not hold the KEY").toContain(s.d.key);

      await click(page, await barPointAt(page, s.c3, ci));
      const sel = await waitSelection(page, (x) => x.length === 1, "the click on C3 made no single selection");
      expect(sel[0].fields, "C3's selection fields").toEqual([s.d.field]);
      expect(sel[0].tuples, "the selection holds the LABEL, not the KEY").toEqual([[s.d.key]]);
      const underM = await revenue(page, [f(s.d.field, s.d.key)]);
      await waitCardValue(page, s.k, underM, `K is not Revenue under ${s.d.field} = ${s.d.key}`);

      // A ribbon filter on D, its selection made through the CARD's checklist.
      const fl = await callModule<{ id: string } | null>(page, FILTER_STORE, "createFilterAsync", [{ name: "D filter", connectionId: s.conn.connectionId, fieldName: s.d.field }]);
      expect(fl, `createFilterAsync refused ${s.d.field}`).toBeTruthy();
      try {
        await eventually(() => filterCardIds(page), (ids) => ids.includes(fl!.id), "the D filter's card never appeared");
        await selectFilterKeys(page, fl!.id, [s.d.key]);
        const row = await backendRibbonFilter(page, fl!.id);
        expect(row.selectedItems, "the ribbon filter stored the LABEL, not the KEY").toEqual([s.d.key]);
        await waitCardValue(page, s.k, underM, "K left the oracle once the D ribbon filter joined the selection");
      } finally {
        await callModule(page, FILTER_STORE, "deleteFilterAsync", [fl!.id]).catch(() => undefined);
      }
      await clearAllSelections(page);
      await waitCardValue(page, s.k, s.total, "K did not return to unfiltered after J3b");
    } finally {
      await invoke(page, "set_locale", { localeId: bootLocale!.overrideId ?? "system" });
    }
  });

  // -------------------------------------------------------------------------
  test("J4 Ctrl+click adds Pacific; a plain click replaces; the sole selected datum toggles off; the plot background, the empty page and Escape (with nothing selected) each clear", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    const s = need();
    await onReport(page);
    await clearAllSelections(page);
    const europeAt = await barPoint(page, s.c1, EUROPE);
    const pacificAt = await barPoint(page, s.c1, PACIFIC);

    await click(page, europeAt);
    await waitSelection(page, (x) => x.length === 1 && x[0].tuples.length === 1, "Europe was not selected");
    await click(page, pacificAt, { ctrl: true });
    const two = await waitSelection(page, (x) => x.length === 1 && x[0].tuples.length === 2, "Ctrl+click did not add Pacific");
    expect(two[0].tuples.map((t) => t[0]).sort(), "the two tuples").toEqual([EUROPE, PACIFIC].sort());
    await waitCardValue(page, s.k, await revenue(page, [f(TERRITORY, EUROPE, PACIFIC)]), "K is not Revenue of Europe or Pacific");

    await click(page, pacificAt);
    const one = await waitSelection(page, (x) => x.length === 1 && x[0].tuples.length === 1, "a plain click on Pacific did not replace the selection");
    expect(one[0].tuples, "a plain click did not keep Pacific only").toEqual([[PACIFIC]]);

    await click(page, pacificAt);
    await waitSelection(page, (x) => x.length === 0, "a click on the sole selected Pacific did not clear it");
    await waitCardValue(page, s.k, s.total, "K did not return to unfiltered after the toggle-off");

    await click(page, europeAt);
    await waitSelection(page, (x) => x.length === 1, "Europe was not selected again");
    await click(page, await plotGapPoint(page, s.c1));
    await waitSelection(page, (x) => x.length === 0, "a click on C1's plot background did not clear the selection");

    await click(page, europeAt);
    await waitSelection(page, (x) => x.length === 1, "Europe was not selected again (empty page)");
    await clickEmpty(page, s.free.x + 20, s.free.y + 20);
    await waitSelection(page, (x) => x.length === 0, "a click on the empty page did not clear the selection");

    await click(page, europeAt);
    await waitSelection(page, (x) => x.length === 1, "Europe was not selected again (Escape)");
    await gridKey(page, "Escape"); // first: the selected OBJECT goes
    await page.waitForTimeout(300);
    expect((await selectionState(page)).length, "the first Escape (an object was selected) cleared the visual selection").toBe(1);
    await gridKey(page, "Escape"); // then: nothing selected -> the page's selections go
    await waitSelection(page, (x) => x.length === 0, "Escape with no object selected did not clear the selection");
    await waitCardValue(page, s.k, s.total, "K did not return to unfiltered after Escape");
  });

  // -------------------------------------------------------------------------
  test("J5 exact tuples: (Europe, Bikes) + (Pacific, Accessories) on C2 is non-rectangular; K is the sum of the two rectangular oracles and differs from the product; the compound share is refused, and answers once the selection is rectangular", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    const s = need();
    await onReport(page);
    await clearAllSelections(page);

    await click(page, await barPoint(page, s.c2, EUROPE, BIKES));
    await waitSelection(page, (x) => x.length === 1 && x[0].tuples.length === 1, "(Europe, Bikes) was not selected");
    // K2's refusal is PAINTED by the render that follows the tuple selection:
    // the recorder must be running before it.
    await startTextRecorder(page);
    await click(page, await barPoint(page, s.c2, PACIFIC, ACCESSORIES), { ctrl: true });
    const sel = await waitSelection(page, (x) => x.length === 1 && x[0].tuples.length === 2, "Ctrl+click did not add (Pacific, Accessories)");
    expect(sel[0].fields, "C2's selection fields").toEqual([TERRITORY, CATEGORY]);
    expect(sel[0].tuples.map((t) => t.join("/")).sort(), "the tuples").toEqual([`${EUROPE}/${BIKES}`, `${PACIFIC}/${ACCESSORIES}`].sort());

    const exact =
      (await revenue(page, [f(TERRITORY, EUROPE), f(CATEGORY, BIKES)])) + (await revenue(page, [f(TERRITORY, PACIFIC), f(CATEGORY, ACCESSORIES)]));
    const rectangular = await revenue(page, [f(TERRITORY, EUROPE, PACIFIC), f(CATEGORY, BIKES, ACCESSORIES)]);
    expect(near(exact, rectangular), "precondition: the tuple and the rectangular product agree on this data -- J5 would be vacuous").toBe(false);
    await waitCardValue(page, s.k, exact, "K is not the sum of the two rectangular oracles");
    expect(near((await cardText(page, s.k)).value, rectangular), "K equals the RECTANGULAR product: the tuple filter was widened").toBe(false);

    // K2: the compound share is refused under a tuple filter -- never answered unfiltered.
    const refusal = await designQueryOracleOutcome(page, s.conn.connectionId, DSL_K2, [], [
      { fields: [TERRITORY, CATEGORY], tuples: [[EUROPE, BIKES], [PACIFIC, ACCESSORIES]] },
    ]);
    // The refusal exists only for a measure that CLEARs a filter (the engine's
    // ContestedClear, pivot/headless.rs). The owner's "% Revenue of Total" is
    // written `GVAR total = [Revenue] RETURN [Revenue] / total` (2026-10-17):
    // a GVAR is evaluated under the query's own filters, the tuple filter
    // included, so nothing is contested and the engine ANSWERS. Then K2 must
    // show exactly that tuple-filtered answer; the refusal itself is proved by
    // design_query_tuple_tests.rs on a CLEARing measure.
    if ("error" in refusal) {
      expect(refusal.error, "the engine refused the share with another error").toContain(TUPLE_REFUSAL);
      await eventually(
        () => recordedTexts(page),
        (t) => t.join(" ").includes("cannot apply the selection"),
        "K2 does not show the refusal of its compound measure under the tuple filter",
        60_000,
      );
    } else {
      const tupleShare = measureOf(refusal.view);
      console.log(`[canvas-crossfilter] J5: the model's share is not a CLEARing measure; the engine answered ${tupleShare} under the tuples (no refusal to show)`);
      await waitCardValue(page, s.k2, tupleShare, "K2 does not show the engine's tuple-filtered share");
    }

    // Only (Europe, Bikes): rectangular, so the share evaluates (host-mask route).
    await click(page, await barPoint(page, s.c2, PACIFIC, ACCESSORIES), { ctrl: true });
    await waitSelection(page, (x) => x.length === 1 && x[0].tuples.length === 1, "Ctrl+click did not take (Pacific, Accessories) back");
    const share = measureOf(await designQueryOracle(page, s.conn.connectionId, DSL_K2, [f(TERRITORY, EUROPE), f(CATEGORY, BIKES)]));
    await waitCardValue(page, s.k2, share, "K2 is not the share under territorygroup = Europe, categoryname = Bikes");
    await clearAllSelections(page);
  });

  // -------------------------------------------------------------------------
  test("J6 Edit interactions: strips on every visual (no Highlight on K, L, PV, S; R disabled with its reason); C1 -> K None is one undo step and keeps K unfiltered; Ctrl+Z / Ctrl+Y; C1 -> P1e Filter filters instead of highlighting", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    const s = need();
    await clearAllSelections(page);
    await enterEditInteractions(page, chartRef(s.c1));
    await expect(page.locator('[data-testid="canvas-interaction-source-outline"]'), "C1 has no source outline").toHaveCount(1);
    const targets: XfVisualRef[] = [chartRef(s.c2), chartRef(s.p1e), chartRef(s.k), chartRef(s.l), { kind: "pivot", id: s.pv }, { kind: "slicer", id: s.s }];
    for (const t of targets) await expect(strip(page, t), `no Edit interactions strip on ${t.kind}:${t.id}`).toHaveCount(1);
    for (const t of [chartRef(s.k), chartRef(s.l), { kind: "pivot", id: s.pv } as XfVisualRef, { kind: "slicer", id: s.s } as XfVisualRef]) {
      await expect(modeButton(page, t, "highlight"), `${t.kind}:${t.id} offers Highlight, which it cannot paint`).toHaveCount(0);
    }
    const rNone = modeButton(page, chartRef(s.r), "none");
    await expect(rNone, "the range chart R shows no None").toHaveCount(1);
    await expect(rNone, "R's None is not disabled").toBeDisabled();
    await expect(rNone, "R's None does not say why").toHaveAttribute("title", RANGE_REASON);

    await setPairByStrip(page, chartRef(s.c1), chartRef(s.k), "none");
    expect(pairKeys(await layoutInteractions(page, s.reportIndex)), "the layout does not hold C1 -> K = none").toContain(`chart:${s.c1} -> chart:${s.k} = none`);
    await exitEditInteractions(page);

    await click(page, await barPoint(page, s.c1, EUROPE));
    await waitSelection(page, (x) => x.length === 1, "Europe was not selected (J6)");
    await waitChart(page, s.p1e, (d) => Array.isArray(d.highlightValues), "P1e does not highlight under C1's selection (J6)");
    await page.waitForTimeout(800);
    expect(near((await cardText(page, s.k)).value, s.total), "K followed C1 although C1 -> K is None").toBe(true);

    await gridKey(page, "Escape"); // the object (the selection stays)
    await gridKey(page, "Control+z");
    await eventually(() => layoutInteractions(page, s.reportIndex), (i) => !pairKeys(i).some((k) => k.includes(`-> chart:${s.k} `)), "Ctrl+Z did not take the C1 -> K pair back");
    const europe = await revenue(page, [f(TERRITORY, EUROPE)]);
    await waitCardValue(page, s.k, europe, "after Ctrl+Z K does not follow Europe again");
    await gridKey(page, "Control+y");
    await eventually(() => layoutInteractions(page, s.reportIndex), (i) => pairKeys(i).includes(`chart:${s.c1} -> chart:${s.k} = none`), "Ctrl+Y did not bring the C1 -> K pair back");
    await waitCardValue(page, s.k, s.total, "after Ctrl+Y K follows C1 again");

    await enterEditInteractions(page, chartRef(s.c1));
    await setPairByStrip(page, chartRef(s.c1), chartRef(s.p1e), "filter");
    await exitEditInteractions(page);
    const pieEurope = valuesByMember(await designQueryOracle(page, s.conn.connectionId, DSL_P1E, [f(TERRITORY, EUROPE)]), { byLabel: true });
    const pie = await waitChart(
      page,
      s.p1e,
      (d) => d.highlightValues === undefined && d.categories.every((c, i) => near(d.series[0].values[i], pieEurope[c] ?? 0)),
      "P1e is not FILTERED to Europe under C1 -> P1e = filter",
    );
    expect(pie.highlightValues, "P1e still carries highlight values under Filter").toBeUndefined();
    await clearAllSelections(page);
  });

  // -------------------------------------------------------------------------
  test("J7 a slicer as source: S -> K None; 2013 in S filters C1 and PV but not K; S -> PV None re-folds PV's REAL view to unfiltered (no hidden year items, GETPIVOTDATA follows); ONE Ctrl+Z brings back the pair and the fold", async ({ appPage: page }) => {
    test.setTimeout(420_000);
    const s = need();
    await clearAllSelections(page);
    const slicer: XfVisualRef = { kind: "slicer", id: s.s };
    const pivot: XfVisualRef = { kind: "pivot", id: s.pv };

    await enterEditInteractions(page, slicer);
    await setPairByStrip(page, slicer, chartRef(s.k), "none");
    await exitEditInteractions(page);

    await parkPointer(page);
    const at = await slicerItemPoint(page, s.s, s.year);
    await humanClick(page, at.x, at.y);
    await slicerLanded(page);
    const inYear = await revenue(page, [f(YEAR, s.year)]);
    await waitSeriesTotal(page, s.c1, inYear, `C1 is not filtered to ${s.year} by S`);
    await page.waitForTimeout(800);
    expect(near((await cardText(page, s.k)).value, s.total), "K followed S although S -> K is None").toBe(true);
    await waitRealPivotTotal(page, s.pv, inYear, `precondition: PV's real view does not fold S's ${s.year}`);

    await enterEditInteractions(page, slicer);
    await setPairByStrip(page, slicer, pivot, "none");
    await exitEditInteractions(page);
    await waitRealPivotTotal(page, s.pv, s.total, "PV's REAL grand total is still filtered under S -> PV = None (the backend fold did not exclude it)");
    expect(await pivotHiddenItems(page, s.pv, "year"), "PV's definition still hides year items under S -> PV = None").toEqual([]);
    await waitGpd(page, s.total, "GETPIVOTDATA on PV is not unfiltered under S -> PV = None");

    await gridKey(page, "Control+z");
    await eventually(() => layoutInteractions(page, s.reportIndex), (i) => !pairKeys(i).some((k) => k.startsWith(`slicer:${s.s} -> pivot:${s.pv} `)), "Ctrl+Z did not take the S -> PV pair back");
    await waitRealPivotTotal(page, s.pv, inYear, `ONE Ctrl+Z did not bring PV's ${s.year} fold back with the pair`);
    await waitGpd(page, inYear, "GETPIVOTDATA did not follow the undone fold");
  });

  // -------------------------------------------------------------------------
  test("J8 lifetime and persistence: a selection survives a sheet switch; the save carries the pairs and the visual targets as feature ids (never a higher version) and no selection; reopen and File New start empty; Clear All Slicers keeps the selection", async ({ appPage: page }) => {
    test.setTimeout(480_000);
    const s = need();
    await clearAllSelections(page);
    await onReport(page);

    await click(page, await barPoint(page, s.c1, EUROPE));
    await waitSelection(page, (x) => x.length === 1, "Europe was not selected (J8)");
    const lExpected = await revenue(page, [f(TERRITORY, EUROPE), f(YEAR, s.year)]);
    await waitSeriesTotal(page, s.l, lExpected, `L is not Revenue of Europe in ${s.year}`);
    await clickSheetTab(page, s.sheet1Index);
    await clickSheetTab(page, s.reportIndex);
    await ensureZoom(page);
    const kept = await selectionState(page);
    expect(kept.map((x) => `${x.source.kind}:${x.source.id} ${JSON.stringify(x.tuples)}`), "the sheet switch dropped the selection").toEqual([`chart:${s.c1} [["${EUROPE}"]]`]);
    await waitSeriesTotal(page, s.l, lExpected, "after the sheet switch L no longer follows the selection");
    expect(near((await cardText(page, s.k)).value, s.total), "K (None to both C1 and S) moved").toBe(true);

    // The J2 filter in Selected visuals (C1) for the visual-targets feature id.
    await setConnectionMode(page, s.ribbonId, "Selected visuals", { visuals: [chartRef(s.c1)] });
    await eventually(() => backendRibbonFilter(page, s.ribbonId), (r) => (r.connectedVisuals ?? []).length === 1, "the ribbon filter does not hold C1");
    await onReport(page);
    const pairsSaved = pairKeys(await layoutInteractions(page, s.reportIndex));
    expect(pairsSaved.length, "precondition: the page holds pairs to save").toBeGreaterThan(0);

    await saveTo(page, FILE_WITH);
    const entries = archiveEntries(FILE_WITH);
    const withManifest = manifestOf(entries);
    expect(withManifest.features, "the save does not declare canvas_interactions").toContain("canvas_interactions");
    expect(withManifest.features, "the save does not declare ribbon_filter_visual_targets").toContain("ribbon_filter_visual_targets");
    const metadata = Object.entries(entries).filter(([name, text]) => name.endsWith("metadata.json") && text.includes('"interactions"'));
    expect(metadata.length, "no canvas metadata.json carries the interactions").toBeGreaterThan(0);
    expect(metadata.some(([, text]) => text.includes(s.c1) && text.includes(s.k)), "the canvas metadata.json does not name the C1 -> K pair").toBe(true);
    for (const [name, text] of Object.entries(entries)) {
      expect(text.includes('"tuples"'), `${name} carries a visual selection (tuples)`).toBe(false);
      expect(/crossFilterSelection|"selections"/.test(text), `${name} carries a visual selection`).toBe(false);
    }

    // Reopen: no selection, the interactions back. Opened straight over the
    // workbook that HOLDS the Europe selection -- a File > New first would
    // clear it on AFTER_NEW and hide whether AFTER_OPEN does.
    expect((await selectionState(page)).length, "precondition: the workbook being replaced holds a selection").toBe(1);
    await openFileAtPath(page, FILE_WITH);
    await rebindScene(page);
    expect(await selectionState(page), "a reopened workbook holds a visual selection").toEqual([]);
    await eventually(() => layoutInteractions(page, s.reportIndex), (i) => JSON.stringify(pairKeys(i)) === JSON.stringify(pairsSaved), "the reopened page does not hold the saved pairs", 30_000);

    // File New: no selection.
    await waitChart(page, s.c1, (d) => d.categories.includes(EUROPE), "C1 did not paint after the reopen");
    await click(page, await barPoint(page, s.c1, EUROPE));
    await waitSelection(page, (x) => x.length === 1, "Europe was not selected after the reopen");
    await newFile(page);
    expect(await selectionState(page), "File > New kept a visual selection").toEqual([]);

    // Clear All Slicers (the button action's route) keeps a visual selection.
    await openFileAtPath(page, FILE_WITH);
    await rebindScene(page);
    await waitChart(page, s.c1, (d) => d.categories.includes(EUROPE), "C1 did not paint after the second reopen");
    await click(page, await barPoint(page, s.c1, EUROPE));
    await waitSelection(page, (x) => x.length === 1, "Europe was not selected before Clear All Slicers");
    await callModule(page, XF_MOD.SLICER_CLEAR, "clearSlicersOnSheet", [s.reportIndex]);
    await slicerLanded(page);
    expect((await selectionState(page)).length, "Clear All Slicers cleared a visual selection").toBe(1);
    await clearAllSelections(page);

    // The same workbook WITHOUT interactions and visual targets stamps the same version.
    await patchActiveCanvas(page, { interactions: { pairs: [] } });
    await setConnectionMode(page, s.ribbonId, "All pages");
    await onReport(page);
    await saveTo(page, FILE_WITHOUT);
    const without = manifestOf(archiveEntries(FILE_WITHOUT));
    expect(without.features, "canvas_interactions is declared with no interactions").not.toContain("canvas_interactions");
    expect(without.features, "ribbon_filter_visual_targets is declared with no visual targets").not.toContain("ribbon_filter_visual_targets");
    expect(withManifest.formatVersion, "interactions / visual targets RAISED the format version").toBe(without.formatVersion);

    // Back to the saved workbook for J9 / J10 (S holds the year again, the pairs are back).
    await newFile(page);
    await openFileAtPath(page, FILE_WITH);
    await rebindScene(page);
    await waitChart(page, s.c1, (d) => d.categories.length > 0, "C1 did not paint after the last reopen");
    // A model pivot reopens with an EMPTY cache: its data arrives on its first
    // query (pivot/types.rs SavedBiPivotMetadata, BUG-0162/BUG-0496), and until
    // then its box shows "Grand Total 0". Refresh it as a user does
    // (canvas.spec #11 does the same), so J10's PV preconditions read data.
    await callModule(page, XF_MOD.PIVOT_API, "refreshPivotCache", [s.pv]);
    await waitRealPivotTotal(page, s.pv, await revenue(page, [f(YEAR, s.year)]), `after its refresh the reopened PV does not fold S's ${s.year}`);
  });

  // -------------------------------------------------------------------------
  test("J9 Design Mode: a click on a C1 bar walks the selection ladder to the series and never touches the visual selections", async ({ appPage: page }) => {
    const s = need();
    await onReport(page);
    await clearAllSelections(page);
    await gridKey(page, "Escape");
    const before = JSON.stringify(await selectionState(page));
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [true]);
    try {
      const at = await barPoint(page, s.c1, EUROPE);
      await click(page, at);
      await click(page, at);
      const snap = await eventually(
        () => callModule<{ chartId: string | null; level: string }>(page, MOD.CHART_SELECTION, "getChartSelection", []),
        (x) => x.chartId === s.c1 && x.level === "series",
        "in Design Mode two clicks on a C1 bar did not select its series",
      );
      expect(snap.level, "the ladder").toBe("series");
      expect(JSON.stringify(await selectionState(page)), "a Design Mode click changed the visual selections").toBe(before);
    } finally {
      await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]);
      await gridKey(page, "Escape");
    }
  });

  // -------------------------------------------------------------------------
  test("J10 scripts and MCP: getCrossFilters mirrors the seam; setCrossFilter(Pacific) filters K; R and an unknown pair ref are refused; MCP reads the interactions line and its S -> PV None re-folds PV with one undo step", async ({ appPage: page }) => {
    test.setTimeout(480_000);
    const s = need();
    await onReport(page);
    await clearAllSelections(page);
    await allowScripts(page);

    // C1 -> K is None since J6: put it back to the default so K follows C1 here.
    await patchActiveCanvas(page, { interactions: { pairs: [] } });
    await eventually(() => layoutInteractions(page, s.reportIndex), (i) => pairKeys(i).length === 0, "the pairs were not cleared for J10");

    await click(page, await barPoint(page, s.c1, EUROPE));
    const seam = await waitSelection(page, (x) => x.length === 1, "Europe was not selected (J10)");
    const got = JSON.parse(await scriptResult(page, "get", `    out = await api.getCrossFilters();`)) as Array<{ source: XfVisualRef; fields: string[]; tuples: string[][] }>;
    expect(got.map((x) => ({ source: x.source, fields: x.fields, tuples: x.tuples })), "api.getCrossFilters() does not mirror the seam").toEqual(
      seam.map((x) => ({ source: x.source, fields: x.fields, tuples: x.tuples })),
    );

    const setOut = await scriptResult(
      page,
      "set",
      `    await api.setCrossFilter({ kind: "chart", id: ${JSON.stringify(s.c1)} }, { fields: [${JSON.stringify(TERRITORY)}], tuples: [[${JSON.stringify(PACIFIC)}]] }, ${JSON.stringify(REPORT)});\n    out = "ok";`,
    );
    expect(setOut, "api.setCrossFilter on C1 was refused").toBe("ok");
    await waitSelection(page, (x) => x.length === 1 && JSON.stringify(x[0].tuples) === JSON.stringify([[PACIFIC]]), "api.setCrossFilter did not land Pacific in the seam");
    // Clearing the pairs also gave S -> K back its default, and S still holds
    // the year the J8 file was saved with: K is filtered by BOTH sources, so the
    // oracle carries S's selection too (read, never assumed).
    const sNow = (await slicersAll(page)).find((x) => x.id === s.s) as { selectedItems?: string[] | null } | undefined;
    const sYears = sNow?.selectedItems ?? null;
    const pacificOracle = await revenue(page, [f(TERRITORY, PACIFIC), ...(sYears && sYears.length > 0 ? [f(YEAR, ...sYears)] : [])]);
    await waitCardValue(page, s.k, pacificOracle, `K is not Revenue of Pacific${sYears ? ` in ${sYears.join(", ")} (S)` : ""} after api.setCrossFilter`);

    const onR = await scriptResult(
      page,
      "setR",
      `    await api.setCrossFilter({ kind: "chart", id: ${JSON.stringify(s.r)} }, { fields: [${JSON.stringify(TERRITORY)}], tuples: [[${JSON.stringify(EUROPE)}]] }, ${JSON.stringify(REPORT)});\n    out = "ok";`,
    );
    expect(onR, "api.setCrossFilter on the range chart R was not refused").toMatch(/^ERR .*cannot filter other visuals/);
    const unknownRef = await scriptResult(
      page,
      "layout",
      `    await api.setCanvasLayout({ interactions: { pairs: [{ source: { kind: "chart", id: "no-such-chart" }, target: { kind: "chart", id: ${JSON.stringify(s.k)} }, mode: "none" }] } }, ${JSON.stringify(REPORT)});\n    out = "ok";`,
    );
    expect(unknownRef, "api.setCanvasLayout with an unknown pair ref was not refused").toMatch(/^ERR .*not a visual on canvas/);
    await clearAllSelections(page);

    // MCP: S holds the year again (the reopened J8 file), so PV's real view folds it.
    const inYear = await revenue(page, [f(YEAR, s.year)]);
    const sRow = (await slicersAll(page)).find((x) => x.id === s.s) as { selectedItems?: string[] | null } | undefined;
    if (!sRow?.selectedItems || !sRow.selectedItems.includes(s.year)) {
      await parkPointer(page);
      const at = await slicerItemPoint(page, s.s, s.year);
      await humanClick(page, at.x, at.y);
      await slicerLanded(page);
    }
    await waitRealPivotTotal(page, s.pv, inYear, `precondition: PV's real view does not fold S's ${s.year} (J10)`);

    const mcp = await startMcp(page);
    try {
      await onReport(page);
      const summary = await mcp.call("get_sheet_summary", { max_chars: 0 });
      expect(summary.isError, `get_sheet_summary failed: ${summary.text.slice(0, 300)}`).toBe(false);
      const current: XfInteractions = (await layoutInteractions(page, s.reportIndex)) ?? { pairs: [] };
      const value = { ...(current.defaultMode ? { defaultMode: current.defaultMode } : {}), pairs: [...current.pairs, { source: { kind: "slicer", id: s.s }, target: { kind: "pivot", id: s.pv }, mode: "none" }] };
      const wrote = await mcp.call("set_object_property", { kind: "canvasPage", id: s.reportSheetId, path: "/interactions", value });
      expect(wrote.isError, `set_object_property /interactions failed: ${wrote.text.slice(0, 300)}`).toBe(false);
      await eventually(() => layoutInteractions(page, s.reportIndex), (i) => pairKeys(i).includes(`slicer:${s.s} -> pivot:${s.pv} = none`), "the MCP write did not reach the layout");
      await eventually(() => undoState(page), (u) => u.undoDescription === INTERACTION_STEP, "the MCP write recorded no undo step");
      await waitRealPivotTotal(page, s.pv, s.total, "PV's REAL grand total is still filtered after the MCP S -> PV None write (no re-fold)");
      await waitGpd(page, s.total, "GETPIVOTDATA on PV did not follow the MCP re-fold");
      const after = await mcp.call("get_sheet_summary", { max_chars: 0 });
      expect(after.text, "get_sheet_summary has no interactions line").toContain("  interactions:");
      expect(after.text, "get_sheet_summary's interactions line does not name S -> PV = none").toContain(`slicer:${s.s} -> pivot:${s.pv} = none`);

      await onReport(page);
      await gridKey(page, "Control+z");
      await eventually(() => layoutInteractions(page, s.reportIndex), (i) => !pairKeys(i).some((k) => k.startsWith(`slicer:${s.s} -> pivot:${s.pv} `)), "Ctrl+Z did not take the MCP pair back");
      await waitRealPivotTotal(page, s.pv, inYear, "ONE Ctrl+Z did not restore both the MCP pair and PV's fold");
    } finally {
      await mcp.stop();
    }
  });
});

