/**
 * THE CANVAS TAB AS POWER BI'S REPORT AUTHORING, THROUGH THE REAL UI (2026-10-08).
 *
 * The contextual Canvas tab was rebuilt as Power BI Desktop's report authoring
 * (CONTRACT-CANVAS): six groups (Pages, Visuals, Elements, Arrange, Page, View),
 * a Visuals strip plus an All Visuals gallery, the new chart marks Card /
 * Multi-row card / KPI / Gauge and Line-and-stacked-column, measure-only design
 * queries filtered by model slicers on the same page (@api/pageFilters), shape
 * thumbnails at catalog size, declarative button actions (navigate, back,
 * clearSlicers), a theme gallery seam, wallpaper + Lock Objects + the Tooltip
 * page size, and the LPAD/RPAD worksheet functions. Every lane proved its part
 * in jsdom with the backend doubled; this journey drives each one against the
 * REAL backend in the REAL ribbon.
 *
 * WHAT IS ASSERTED. Backend state (persisted chart specs, canvas layouts,
 * controls and their action properties, cell displays and formulas), the DOM
 * (groups, rows, menus, dialogs), what the chart painters actually WROTE (a
 * `fillText` recorder installed in the page before the insert -- the text a
 * Card shows is a fact about the paint, not about a cache), and RELATIVE pixel
 * samples through e2e/viewportSample.ts (the same patch before and after, plus
 * an untouched control patch, so a sample proves change in both directions).
 * Never a golden: the goldens are stale by owner decision and this display is
 * DPR 2.
 *
 * THE NARROW WINDOW. The harness window is 1280 px wide, where Arrange, Page and
 * View are folded into launchers. Every Canvas control is reached through
 * `canvasControl` (helpers/canvas-live.ts), which opens the folded group's
 * flyout when it has to; P1 asserts the fold goes right to left.
 *
 * LOCALE. sv-SE: formulas typed into update_cell use `;` between arguments, and
 * a number is written as a formula (`=12345/10`) rather than "1234.5", which
 * this locale stores as TEXT.
 *
 * MODEL FIXTURE. tests/fixtures/model/sales_star.json written to CSV in a temp
 * folder (the insight-overlays pivot journey's recipe); the expected totals are
 * computed here from the same rows, never typed in.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import {
  CANVAS_GROUPS,
  MOD,
  addCanvas,
  callModule,
  canvasControl,
  canvasMenuRow,
  clickCanvasControl,
  clickCanvasMenuRow,
  clickEmpty,
  clickObject,
  clickSheetTab,
  closeCanvasFlyouts,
  collapsedCanvasGroups,
  controlsOn,
  createShape,
  dismissToasts,
  dragObject,
  ensureCanvasTab,
  eventually,
  freeCanvasRect,
  gridBox,
  humanClick,
  installAppImport,
  invoke,
  newFile,
  objects,
  openFileAtPath,
  persistedCharts,
  sheetPointToPage,
  sheetsResult,
  startToasts,
  toasts,
  undoState,
  type PersistedChart,
  type SheetRow,
} from "../helpers/canvas-live";
import { cachedData, recordedTexts, startTextRecorder, type CachedData } from "../helpers/chart-paint";
import { closeObjectPaneForGood } from "../helpers/object-pane";
import { samplePixelGrids, diffCount, type PixelClip } from "../viewportSample";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "../../../tests/fixtures/model");
const STAR_SOURCE = "canvas_pbi_csv";
const RANGE_INPUT = 'input[placeholder="e.g., Sheet1!A1:D10"]';
const SLICER_STORE = MOD.SLICER_STORE;
const TAURI_API = MOD.TAURI_API;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Sheet1 A1:D5: Region / Q1 / Q2 / Q3 (whole numbers: no locale question). */
const QUARTERS: string[][] = [
  ["Region", "Q1", "Q2", "Q3"],
  ["North", "10", "20", "5"],
  ["South", "40", "15", "25"],
  ["East", "20", "30", "10"],
  ["West", "30", "25", "20"],
];

/** Sheet1 F1:H7: Month / Sales / Goal -- the KPI's trend, indicator and goal. */
const KPI_ROWS: string[][] = [
  ["Month", "Sales", "Goal"],
  ["Jan", "50", "60"],
  ["Feb", "55", "60"],
  ["Mar", "62", "60"],
  ["Apr", "58", "60"],
  ["May", "70", "60"],
  ["Jun", "75", "60"],
];

async function writeGrid(page: Page, rows: string[][], row0: number, col0: number): Promise<void> {
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      await invoke(page, "update_cell", { row: row0 + r, col: col0 + c, value: rows[r][c] });
    }
  }
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
}

interface StarBundle {
  model: { tables: Array<{ name: string; columns: Array<{ name: string; data_type: unknown }>; [k: string]: unknown }>; [k: string]: unknown };
  data: Record<string, { columns: string[]; rows: unknown[][] }>;
}

function readStar(): StarBundle {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "sales_star.json"), "utf8")) as StarBundle;
}

/** Revenue = SUM(Sales[Amount]) in total and per Geography.Region, from the fixture's own rows. */
function starRevenue(): { total: number; byRegion: Record<string, number> } {
  const b = readStar();
  const S = b.data.Sales;
  const G = b.data.Geography;
  const gi = S.columns.indexOf("GeoKey");
  const ai = S.columns.indexOf("Amount");
  const region = new Map<unknown, string>(G.rows.map((r) => [r[G.columns.indexOf("GeoKey")], String(r[G.columns.indexOf("Region")])]));
  const byRegion: Record<string, number> = {};
  let total = 0;
  for (const r of S.rows) {
    const amount = Number(r[ai]);
    const reg = region.get(r[gi]) ?? "(blank)";
    byRegion[reg] = (byRegion[reg] ?? 0) + amount;
    total += amount;
  }
  return { total, byRegion };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The sales-star model bound to CSVs in `dir` (the insight-overlays pivot journey's recipe). */
function starModelOver(dir: string): Record<string, unknown> {
  const bundle = readStar();
  for (const [table, { columns, rows }] of Object.entries(bundle.data)) {
    fs.writeFileSync(path.join(dir, `${table}.csv`), [columns.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n", "utf8");
  }
  const model = { ...bundle.model };
  model.tables = bundle.model.tables.map((t) => ({
    ...t,
    columns: t.columns.map((c) => (c.data_type === "Int32" ? { ...c, data_type: "Int64" } : c)),
    source_binding: { source_id: STAR_SOURCE, schema: "csv", table: t.name },
  }));
  model.sources = [
    { id: STAR_SOURCE, kind: "csv", connection: { database: dir, default_schema: "csv" }, preferred_auth: "integrated", display_name: "Sales star (CSV)" },
  ];
  return model;
}

async function connectStar(page: Page, name: string): Promise<{ connectionId: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-canvas-pbi-"));
  const info = await invoke<{ id: string }>(page, "bi_create_connection", {
    request: { name, description: null, connectionString: "", modelJson: { formatVersion: 1, model: starModelOver(dir) } },
  });
  await invoke(page, "bi_model_connect_source", { connectionId: info.id, sourceId: STAR_SOURCE, connectionString: "", remember: false });
  return { connectionId: info.id, dir };
}

async function dropStar(page: Page, conn: { connectionId: string; dir: string } | null): Promise<void> {
  if (!conn) return;
  await invoke(page, "bi_delete_connection", { connectionId: conn.connectionId }).catch(() => undefined);
  fs.rmSync(conn.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------
//
// `startTextRecorder` / `recordedTexts` / `cachedData` live in
// helpers/chart-paint.ts (shared with object-bindings.spec.ts, never copied).

/** A chart's box in PAGE pixels (it must be on screen). */
async function chartClip(page: Page, c: { x: number; y: number; width: number; height: number }, inset = 6): Promise<PixelClip> {
  const geo = await readGridGeometry(page);
  const tl = await sheetPointToPage(page, c.x + inset, c.y + inset);
  return {
    x: Math.round(tl.x),
    y: Math.round(tl.y),
    width: Math.round((c.width - 2 * inset) * geo.zoom),
    height: Math.round((c.height - 2 * inset) * geo.zoom),
  };
}

// ---------------------------------------------------------------------------
// Product routes
// ---------------------------------------------------------------------------

/** The Create Chart dialog the Canvas tab opened: fill the range and press Insert Chart. */
async function finishChartDialog(page: Page, range: string, beforeIds: string[]): Promise<PersistedChart> {
  const input = page.locator(RANGE_INPUT);
  await expect(input, "the visual opened no Create Chart dialog").toBeVisible({ timeout: 8000 });
  await input.fill(range);
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "Insert Chart" }).click();
  const all = await eventually(() => persistedCharts(page), (cs) => cs.length === beforeIds.length + 1, `Insert Chart created nothing (range ${range})`, 15_000);
  return all.find((c) => !beforeIds.includes(c.id))!;
}

/** Insert a visual from the band's two rows (`canvas-visual-<id>`). */
async function insertFromRow(page: Page, visualId: string, range: string): Promise<PersistedChart> {
  const before = (await persistedCharts(page)).map((c) => c.id);
  await clickCanvasControl(page, `canvas-visual-${visualId}`);
  return finishChartDialog(page, range, before);
}

/** Insert a visual from the All Visuals gallery (`canvas-visual-gallery-<id>`). */
async function insertFromGallery(page: Page, visualId: string, range: string): Promise<PersistedChart> {
  const before = (await persistedCharts(page)).map((c) => c.id);
  await clickCanvasControl(page, "canvas-all-visuals");
  const tile = page.locator(`[data-testid="canvas-visual-gallery-${visualId}"]`).filter({ visible: true }).first();
  await expect(tile, `the All Visuals gallery has no ${visualId} tile`).toBeVisible({ timeout: 5000 });
  await tile.click();
  return finishChartDialog(page, range, before);
}

async function waitPainted(page: Page, chartId: string): Promise<CachedData> {
  return (await eventually(() => cachedData(page, chartId), (d) => !!d && d.series.length > 0, `chart ${chartId} never painted`, 15_000))!;
}

type ControlProps = Record<string, { value: string }>;

async function controlsWithProps(page: Page, sheetIndex: number): Promise<Array<{ row: number; col: number; type: string; props: ControlProps }>> {
  const raw = await invoke<Array<{ row: number; col: number; metadata: { controlType: string; properties: ControlProps } }>>(page, "get_all_controls", { sheetIndex });
  return raw.map((c) => ({ row: c.row, col: c.col, type: c.metadata.controlType, props: c.metadata.properties }));
}

const prop = (p: ControlProps, k: string): string => p[k]?.value ?? "";

/** Click a floating control's centre as a user would (run mode: a button runs). */
async function clickControlCentre(page: Page, p: ControlProps): Promise<void> {
  const x = Number(prop(p, "x")) + Number(prop(p, "width")) / 2;
  const y = Number(prop(p, "y")) + Number(prop(p, "height")) / 2;
  const at = await sheetPointToPage(page, x, y);
  await humanClick(page, at.x, at.y);
  await page.waitForTimeout(400);
}

async function activeIndex(page: Page): Promise<number> {
  return (await sheetsResult(page)).activeIndex;
}

async function layoutOf(page: Page, index: number): Promise<NonNullable<SheetRow["canvasLayout"]>> {
  const s = (await sheetsResult(page)).sheets.find((x) => x.index === index);
  if (!s?.canvasLayout) throw new Error(`sheet ${index} is not a canvas`);
  return s.canvasLayout;
}

/**
 * A ribbon control by test id on whatever tab brought it (a contextual tab may
 * fold its groups): inline, or inside the first folded group that holds it.
 */
async function clickRibbonAnywhere(page: Page, testId: string): Promise<void> {
  const visible = page.locator(`[data-testid="${testId}"]`).filter({ visible: true });
  for (let i = 0; i < 20 && (await visible.count()) === 0; i++) await page.waitForTimeout(100);
  if ((await visible.count()) === 0) {
    const launchers = page.locator('[data-ribbon-content] [data-testid^="section-launcher-"]');
    const n = await launchers.count();
    for (let i = 0; i < n && (await visible.count()) === 0; i++) {
      await launchers.nth(i).click();
      await page.waitForTimeout(250);
      if ((await visible.count()) === 0) await launchers.nth(i).click();
    }
  }
  if ((await visible.count()) === 0) throw new Error(`clickRibbonAnywhere: no visible [data-testid="${testId}"] in the band or a folded group`);
  await visible.first().click();
  await page.waitForTimeout(250);
}

async function focusCanvasGrid(page: Page): Promise<void> {
  await page.locator("[data-focus-container='spreadsheet']").focus();
  await page.waitForTimeout(80);
}

async function cleanup(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await closeCanvasFlyouts(page).catch(() => undefined);
  await dismissToasts(page).catch(() => undefined);
  await newFile(page);
}

// ===========================================================================

test.describe("Canvas tab = Power BI report authoring, live", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ appPage }) => {
    await installAppImport(appPage);
    // WP-C: a canvas click opens the object pane at release and narrows the
    // grid. This journey predates it and asserts nothing about it: close the
    // pane AS IF BY HAND, per test (the fixture's store reset clears the mark).
    await closeObjectPaneForGood(appPage);
    await newFile(appPage);
  });

  test("P1 the six groups in order, folding right to left, every group reachable; the Visuals strip is Power BI's two pane rows", async ({ appPage: page }) => {
    try {
      await addCanvas(page);
      await ensureCanvasTab(page);
      const cells = await page.locator("[data-ribbon-content] [data-section-cell]").evaluateAll((nodes) =>
        nodes.map((n) => ({
          label: n.lastElementChild?.textContent?.trim() ?? "",
          folded: n.querySelector('[data-testid^="section-launcher-"]') !== null,
        })),
      );
      expect(cells.map((c) => c.label), "the Canvas tab's groups, left to right").toEqual(["Pages", "Visuals", "Elements", "Arrange", "Page", "View"]);
      // Folding goes right to left: the folded groups are a SUFFIX of the band.
      const firstFolded = cells.findIndex((c) => c.folded);
      if (firstFolded >= 0) {
        expect(cells.slice(firstFolded).every((c) => c.folded), `a group left of a folded one is inline: ${JSON.stringify(cells)}`).toBe(true);
      }
      const folded = await collapsedCanvasGroups(page);
      expect(folded, "View folds first, Pages last").toEqual(CANVAS_GROUPS.filter((g) => folded.includes(g)));
      console.log(`[canvas-powerbi] at ${await page.evaluate(() => innerWidth)} px folded: ${folded.join(", ") || "none"}`);

      // No control in the band is labelled exactly "Canvas" (E2E finds the TAB by that text).
      const named = await page.locator("[data-ribbon-content] button").evaluateAll((bs) => bs.filter((b) => (b.textContent ?? "").trim() === "Canvas").length);
      expect(named, "a band control is labelled exactly 'Canvas'").toBe(0);

      // The two rows, in Power BI's pane order; Matrix and Slicer keep their old Insert ids.
      const rows = [
        ["stackedBar", "stackedColumn", "clusteredBar", "clusteredColumn", "line", "lineClusteredColumn"],
        ["pie", "donut", "matrix", "card", "kpi", "slicer"],
      ];
      const rowId = (id: string) => (id === "matrix" ? "canvas-insert-pivot" : id === "slicer" ? "canvas-insert-slicer" : `canvas-visual-${id}`);
      for (const id of rows.flat()) await expect(await canvasControl(page, rowId(id)), `the Visuals strip lacks ${id}`).toBeVisible();
      const order = await page.locator("[data-ribbon-content]").evaluate(
        (band, ids) => ids.map((id) => {
          const el = band.querySelector(`[data-testid="${id}"]`);
          const r = el?.getBoundingClientRect();
          return r ? { id, x: Math.round(r.left), y: Math.round(r.top) } : { id, x: -1, y: -1 };
        }),
        rows.flat().map(rowId),
      );
      const r1 = order.slice(0, 6);
      const r2 = order.slice(6);
      expect(new Set(r1.map((o) => o.y)).size, `row 1 is not one row: ${JSON.stringify(r1)}`).toBe(1);
      expect(new Set(r2.map((o) => o.y)).size, `row 2 is not one row: ${JSON.stringify(r2)}`).toBe(1);
      expect(r2[0].y, "row 2 is below row 1").toBeGreaterThan(r1[0].y);
      for (const row of [r1, r2]) {
        expect(row.map((o) => o.x), `a row is out of Power BI's order: ${JSON.stringify(row)}`).toEqual([...row.map((o) => o.x)].sort((a, b) => a - b));
      }

      // One representative control of every group is reachable, folded or not.
      for (const id of ["canvas-new-page", "canvas-all-visuals", "canvas-insert-floatingGrid", "canvas-arrange-lock", "canvas-page-size", "canvas-design-mode"]) {
        await expect(await canvasControl(page, id), `${id} cannot be reached`).toBeVisible();
        await closeCanvasFlyouts(page);
      }

      // At 1920 px every group is inline (two-line hero labels, Excel's way: one line
      // made Arrange 467 px wide and folded View with 300 px of band left -- live 2026-10-08).
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
        await eventually(() => collapsedCanvasGroups(page), (g) => g.length === 0, "at 1920 px some Canvas groups are still folded", 8000);
      } finally {
        await cdp.send("Emulation.clearDeviceMetricsOverride");
        await cdp.detach().catch(() => undefined);
        await page.waitForTimeout(800);
      }

      // New Page adds a canvas (and it becomes the page on screen).
      const before = await sheetsResult(page);
      await clickCanvasControl(page, "canvas-new-page");
      const after = await eventually(() => sheetsResult(page), (r) => r.sheets.length === before.sheets.length + 1, "New Page added no page");
      expect(after.sheets[after.activeIndex].kind, "New Page added a worksheet, not a canvas").toBe("canvas");
    } finally {
      await cleanup(page);
    }
  });

  test("P2 the strip and the All Visuals gallery insert each family with the right persisted mark and stack mode: stacked column, 100% stacked bar, line and stacked column", async ({ appPage: page }) => {
    try {
      await writeGrid(page, QUARTERS, 0, 0);
      await addCanvas(page);

      const stackedColumn = await insertFromRow(page, "stackedColumn", "Sheet1!A1:D5");
      expect(stackedColumn.spec.mark, "Stacked column chart").toBe("bar");
      expect((stackedColumn.spec.markOptions as Record<string, unknown> | undefined)?.stackMode).toBe("stacked");
      const d1 = await waitPainted(page, stackedColumn.id);
      expect(d1.categories, "it charts Sheet1's regions").toEqual(["North", "South", "East", "West"]);

      const bar100 = await insertFromGallery(page, "stackedBar100", "Sheet1!A1:D5");
      expect(bar100.spec.mark, "100% stacked bar chart").toBe("horizontalBar");
      expect((bar100.spec.markOptions as Record<string, unknown> | undefined)?.stackMode).toBe("percentStacked");
      await waitPainted(page, bar100.id);

      const combo = await insertFromGallery(page, "lineStackedColumn", "Sheet1!A1:D5");
      expect(combo.spec.mark, "Line and stacked column chart").toBe("combo");
      expect((combo.spec.markOptions as Record<string, unknown> | undefined)?.stackMode).toBe("stacked");
      const d3 = await waitPainted(page, combo.id);
      expect(d3.series.map((s) => s.name), "three series from the three quarters").toEqual(["Q1", "Q2", "Q3"]);

      // The clustered row button writes "none" explicitly (the store deep-merges).
      const clustered = await insertFromRow(page, "clusteredBar", "Sheet1!A1:D5");
      expect(clustered.spec.mark).toBe("horizontalBar");
      expect((clustered.spec.markOptions as Record<string, unknown> | undefined)?.stackMode).toBe("none");

      const canvasIndex = await activeIndex(page);
      for (const c of [stackedColumn, bar100, combo, clustered]) expect(c.sheetIndex, `${c.name} did not land on the canvas`).toBe(canvasIndex);
    } finally {
      await cleanup(page);
    }
  });

  test("P3 a Card from one cell shows that cell as formatted: text as text, a currency number scaled with its symbol, and the source text under 'none' units", async ({ appPage: page }) => {
    try {
      await writeGrid(page, [["On track", "=12345/10"]], 1, 5); // F2 text, G2 1234.5
      await callModule(page, TAURI_API, "applyFormatting", [[1], [6], { numberFormat: "currency_usd" }]);
      const g2 = await invoke<{ display?: string }>(page, "get_cell", { row: 1, col: 6 });
      expect(g2?.display ?? "", "precondition: G2 shows as currency").toMatch(/^\$1\D?234[.,]50$/);
      await addCanvas(page);

      await startTextRecorder(page);
      const textCard = await insertFromRow(page, "card", "Sheet1!F2");
      expect(textCard.spec.mark).toBe("card");
      expect(textCard.width < 480 && textCard.height < 300, `a Card is placed at its own size, not a chart's: ${textCard.width}x${textCard.height}`).toBe(true);
      await waitPainted(page, textCard.id);
      await eventually(() => recordedTexts(page), (t) => t.includes("On track"), "the text Card never WROTE 'On track'");
      expect((await recordedTexts(page)).filter((t) => t === "0"), "the text Card painted the parser's 0").toEqual([]);

      await startTextRecorder(page);
      const numberCard = await insertFromRow(page, "card", "Sheet1!G2");
      const nd = await waitPainted(page, numberCard.id);
      expect(nd.series[0].values[0], "the Card reads G2's number").toBeCloseTo(1234.5, 6);
      await eventually(() => recordedTexts(page), (t) => t.includes("$1.2K"), "the currency Card did not write $1.2K (auto units keep the $)");

      // Display units "none" through Chart Design > Card (the tile's Visual section):
      // the source's own text, exactly as the cell shows it.
      const cardObj = await eventually(() => objects(page), (os) => os.some((o) => o.chartId === numberCard.id), "the number Card was not published");
      await clickObject(page, cardObj.find((o) => o.chartId === numberCard.id)!, { at: { dx: 20, dy: 20 } });
      await startTextRecorder(page);
      // Selecting a chart ADDS the Chart Design tab without taking the band (Excel's rule).
      const strip = page.locator("[data-ribbon-content]").locator("xpath=..");
      const designTab = strip.locator("button", { hasText: /^Chart Design$/ }).first();
      await expect(designTab, "selecting the Card added no Chart Design tab").toBeVisible({ timeout: 5000 });
      await designTab.click();
      await clickRibbonAnywhere(page, "chart-visual");
      const none = page.locator('[data-testid="chart-visual-units-none"]').filter({ visible: true }).first();
      await expect(none, "the Card's Visual options offer no 'None' display units").toBeVisible({ timeout: 5000 });
      await none.click();
      await eventually(() => recordedTexts(page), (t) => t.includes(g2!.display!), `with units 'none' the Card did not write the cell's own text ${g2?.display}`);
      await eventually(async () => ((await persistedCharts(page)).find((c) => c.id === numberCard.id)!.spec.markOptions as Record<string, unknown> | undefined)?.displayUnits, (u) => u === "none", "the units choice did not persist");
    } finally {
      await cleanup(page);
    }
  });

  test("P4 KPI and Gauge render: persisted specs, what they wrote, and the pixels change where they stand and nowhere else", async ({ appPage: page }) => {
    try {
      await writeGrid(page, KPI_ROWS, 0, 5); // F1:H7
      await invoke(page, "update_cell", { row: 9, col: 1, value: "64" }); // B10
      await addCanvas(page);

      // ---- KPI from the strip.
      await startTextRecorder(page);
      const before = (await persistedCharts(page)).map((c) => c.id);
      await clickCanvasControl(page, "canvas-visual-kpi");
      await expect(page.locator(RANGE_INPUT)).toBeVisible({ timeout: 8000 });
      const kpi = await finishChartDialog(page, "Sheet1!F1:H7", before);
      expect(kpi.spec.mark).toBe("kpi");
      const kd = await waitPainted(page, kpi.id);
      expect(kd.series.map((s) => s.name), "indicator then goal").toEqual(["Sales", "Goal"]);
      const kpiTexts = await eventually(() => recordedTexts(page), (t) => t.includes("75"), "the KPI did not write its latest value 75");
      expect(kpiTexts.some((t) => /^Goal: 60/.test(t)), `the KPI did not write its goal line: ${JSON.stringify(kpiTexts.slice(-30))}`).toBe(true);

      // ---- Gauge from the gallery, over one cell.
      await startTextRecorder(page);
      const gauge = await insertFromGallery(page, "gauge", "Sheet1!B10");
      expect(gauge.spec.mark).toBe("gauge");
      const gd = await waitPainted(page, gauge.id);
      expect(gd.series[0].values[0]).toBe(64);
      const gTexts = await eventually(() => recordedTexts(page), (t) => t.includes("64") && t.includes("128"), "the Gauge did not write 64 and its default max 128");
      expect(gTexts.includes("0"), "the Gauge did not write its minimum 0").toBe(true);

      // ---- Pixels, both directions: the gauge's box with the gauge, without it
      //      (Ctrl+Z takes the insert back), and with it again (Ctrl+Y); a control
      //      patch of empty page never changes.
      await clickEmpty(page, 4, 4);
      await page.waitForTimeout(400);
      const g = await gridBox(page);
      const box = await chartClip(page, gauge);
      const control: PixelClip = { x: Math.round(g.x + 12), y: Math.round(g.y + g.height - 60), width: 40, height: 40 };
      const [withGauge, ctrlA] = await samplePixelGrids(page, [box, control]);
      await focusCanvasGrid(page);
      await page.keyboard.press("Control+z");
      await eventually(() => persistedCharts(page), (cs) => !cs.some((c) => c.id === gauge.id), "Ctrl+Z did not take the gauge back");
      await page.waitForTimeout(600);
      const [without, ctrlB] = await samplePixelGrids(page, [box, control]);
      await focusCanvasGrid(page);
      await page.keyboard.press("Control+y");
      await eventually(() => persistedCharts(page), (cs) => cs.some((c) => c.id === gauge.id), "Ctrl+Y did not bring the gauge back");
      await waitPainted(page, gauge.id);
      await page.waitForTimeout(600);
      const [again] = await samplePixelGrids(page, [box]);
      const area = withGauge.width * withGauge.height;
      expect(diffCount(withGauge, without), "the Gauge painted nothing where it stands").toBeGreaterThan(area * 0.03);
      expect(diffCount(again, without), "redone, the Gauge painted nothing").toBeGreaterThan(area * 0.03);
      expect(diffCount(again, withGauge), "redone, the Gauge does not look like itself").toBeLessThan(area * 0.01);
      expect(diffCount(ctrlA, ctrlB), "pixels changed where nothing was").toBeLessThan(20);
    } finally {
      await cleanup(page);
    }
  });

  test("P5 a Card from a model MEASURE (measure-only design query) is refiltered by a model slicer on the same canvas; Clear All Slicers clears it", async ({ appPage: page }) => {
    let conn: { connectionId: string; dir: string } | null = null;
    const { total, byRegion } = starRevenue();
    try {
      conn = await connectStar(page, "Canvas PBI star");
      const canvas = await addCanvas(page);

      // ---- Visuals > Card, Design query, VALUES: [Revenue] (no ROWS: one grand total).
      const before = (await persistedCharts(page)).map((c) => c.id);
      await clickCanvasControl(page, "canvas-visual-card");
      await expect(page.locator(RANGE_INPUT)).toBeVisible({ timeout: 8000 });
      await page.getByText("Design query", { exact: true }).click();
      const connSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "Select a BI connection" }) });
      await connSelect.selectOption(conn.connectionId);
      await page.waitForTimeout(1200);
      const editor = page.locator(".monaco-editor").filter({ visible: true }).first();
      await editor.click();
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Delete");
      await page.keyboard.type("VALUES: [Revenue]", { delay: 30 });
      await page.waitForTimeout(1500);
      await startTextRecorder(page);
      await page.getByRole("button", { name: "Insert Chart" }).click();
      const charts = await eventually(() => persistedCharts(page), (cs) => cs.length === before.length + 1, "the design-query Card was not inserted", 20_000);
      const card = charts.find((c) => !before.includes(c.id))!;
      expect(card.spec.mark).toBe("card");
      expect(card.spec.data, "the Card's source is the measure-only query").toMatchObject({ type: "designQuery", dslText: "VALUES: [Revenue]", connectionId: conn.connectionId });
      const full = await eventually(() => cachedData(page, card.id), (d) => !!d && Math.abs((d.series[0]?.values[0] ?? NaN) - total) < 0.01, `the Card never showed the model's total ${total}`, 30_000);
      expect(full!.series[0].name, "the caption is the measure's name, without brackets").toBe("Revenue");
      await eventually(() => recordedTexts(page), (t) => t.includes(`${Math.round(total / 1e6)}M`), "the Card did not write the total in auto units");

      // ---- Visuals > Slicer from the model (Geography.Region), on the SAME canvas.
      await clickCanvasControl(page, "canvas-insert-slicer");
      const dialog = page.locator("h2", { hasText: "Insert Slicers" }).locator("xpath=../..");
      await expect(dialog).toBeVisible();
      const modelOption = await eventually(
        () => dialog.locator("select option").evaluateAll((opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, label: (o.textContent ?? "").trim() })).find((o) => o.label.endsWith("(Model)"))),
        (o) => !!o,
        "the Insert Slicers dialog does not list the model",
        15_000,
      );
      await dialog.locator("select").selectOption(modelOption!.value);
      await dialog.locator("label", { hasText: /Region/ }).locator('input[type="checkbox"]').first().check();
      await dialog.getByRole("button", { name: "OK" }).click();
      type SlicerRow = { id: string; sheetIndex: number; sourceType: string; selectedItems: string[] | null };
      const slicer = (await eventually(
        () => callModule<SlicerRow[]>(page, SLICER_STORE, "getAllSlicers", []),
        (s) => s.some((x) => x.sourceType === "biConnection"),
        "no model slicer was created",
      )).find((x) => x.sourceType === "biConnection")!;
      expect(slicer.sheetIndex, "the slicer sits on the Card's canvas").toBe(canvas.index);
      await eventually(() => callModule<Array<{ value: string }> | undefined>(page, SLICER_STORE, "getCachedItems", [slicer.id]), (it) => (it?.length ?? 0) > 0, "the model slicer shows no items", 15_000);

      // ---- Pick Nordics: the Card is re-queried with the page's filter.
      await startTextRecorder(page);
      await callModule(page, SLICER_STORE, "clickSlicerItem", [slicer.id, "Nordics", false]);
      await eventually(() => cachedData(page, card.id), (d) => !!d && Math.abs((d.series[0]?.values[0] ?? NaN) - byRegion.Nordics) < 0.01, `the slicer did not refilter the Card to Nordics (${byRegion.Nordics})`, 30_000);
      await eventually(() => recordedTexts(page), (t) => t.includes(`${(byRegion.Nordics / 1e6).toFixed(1)}M`), "the refiltered Card did not WRITE the Nordics total");

      // ---- Elements > Buttons > Clear All Slicers, then press it in run mode.
      await clickCanvasMenuRow(page, "canvas-buttons", "canvas-buttons-clearSlicers");
      const btn = (await eventually(() => controlsWithProps(page, canvas.index), (cs) => cs.some((c) => prop(c.props, "action") === "clearSlicers"), "Clear All Slicers inserted no action button"))
        .find((c) => prop(c.props, "action") === "clearSlicers")!;
      expect(prop(btn.props, "text"), "the button says what it does").toMatch(/clear/i);
      expect(prop(btn.props, "onSelect"), "an action button carries no code").toBe("");
      await clickEmpty(page, 4, 4);
      await clickControlCentre(page, btn.props);
      await eventually(() => callModule<SlicerRow | undefined>(page, SLICER_STORE, "getSlicerById", [slicer.id]), (s) => !!s && s.selectedItems === null, "Clear All Slicers did not clear the slicer");
      await eventually(() => cachedData(page, card.id), (d) => !!d && Math.abs((d.series[0]?.values[0] ?? NaN) - total) < 0.01, "after Clear All Slicers the Card is not back at the total", 30_000);
    } finally {
      await cleanup(page);
      await dropStar(page, conn);
    }
  });

  test("P6 Shapes menu: Basic shapes and Arrows with thumbnails, More Shapes by category; Oval inserts at the catalog's own size", async ({ appPage: page }) => {
    try {
      const canvas = await addCanvas(page);
      const catalog = await page.evaluate(async () => {
        const w = window as unknown as { __appImport: (m: string) => Promise<{ requireControlsProvider: () => { listShapeCatalog: () => Array<{ id: string; defaultWidth: number; defaultHeight: number }> } }> };
        return (await w.__appImport("/src/api/controlsService.ts")).requireControlsProvider().listShapeCatalog().map((e) => ({ id: e.id, defaultWidth: e.defaultWidth, defaultHeight: e.defaultHeight }));
      });
      const oval = catalog.find((e) => e.id === "oval");
      expect(oval, "the catalog has an oval").toBeTruthy();

      const ovalRow = await canvasMenuRow(page, "canvas-shapes", "canvas-shapes-oval");
      const menu = page.locator('[role="menu"]').filter({ visible: true }).last();
      await expect(menu.getByText("Basic shapes", { exact: true })).toBeVisible();
      await expect(menu.getByText("Arrows", { exact: true })).toBeVisible();
      await expect(menu.getByText("Speech bubble", { exact: true })).toBeVisible();
      expect(await ovalRow.locator("svg path").count(), "the Oval row has no thumbnail").toBeGreaterThan(0);
      await expect(page.locator('[data-testid="canvas-shapes-more"]').filter({ visible: true })).toBeVisible();
      await ovalRow.click();
      const made = await eventually(() => controlsOn(page, canvas.index), (cs) => cs.length === 1, "Shapes > Oval inserted nothing");
      const props = (await controlsWithProps(page, canvas.index))[0].props;
      expect(prop(props, "shapeType") || prop(props, "shape"), "the inserted shape is an oval").toMatch(/oval|ellipse/i);
      expect({ w: made[0].width, h: made[0].height }, "the oval is at the catalog's default size").toEqual({ w: oval!.defaultWidth, h: oval!.defaultHeight });

      // The face of the split inserts a rectangle (the kept canvas-insert-shape id).
      await clickCanvasControl(page, "canvas-insert-shape");
      await eventually(() => controlsOn(page, canvas.index), (cs) => cs.length === 2, "the Shapes face inserted nothing");
    } finally {
      await cleanup(page);
    }
  });

  test("P7 Buttons: Page Navigator inserts ONE live pageNavigator control in one undo step and a run-mode press on an item switches pages; Back returns to the previous page", async ({ appPage: page }) => {
    try {
      const c1 = await addCanvas(page);
      const c2 = await addCanvas(page);
      await clickSheetTab(page, c1.index);
      await eventually(() => activeIndex(page), (i) => i === c1.index, "precondition: the first canvas is not active");

      // ONE control of its own type (D-NAV, 2026-10-15): the items are derived
      // live from the page list, never stored as one button per page.
      await clickCanvasMenuRow(page, "canvas-buttons", "canvas-buttons-pageNavigator");
      const controls = await eventually(
        () => controlsWithProps(page, c1.index),
        (cs) => cs.some((c) => c.type === "pageNavigator"),
        "Page Navigator inserted no pageNavigator control",
      );
      const navs = controls.filter((c) => c.type === "pageNavigator");
      expect(navs, "Page Navigator is ONE control").toHaveLength(1);
      expect(controls.filter((c) => c.type === "button"), "Page Navigator still inserts one button per page").toEqual([]);
      expect((await undoState(page)).undoDescription, "Page Navigator is ONE undo step").toBe("Insert Page Navigator");
      const nav = navs[0];
      expect(prop(nav.props, "action"), "a navigator stores no action target").toBe("");

      // Its box: the seam's natural size for the two visible, non-Tooltip canvases, clamped to the page.
      const natural = await callModule<{ width: number; height: number }>(page, MOD.BUTTON_SERVICE, "pageNavigatorNaturalSize", [2]);
      const layout = await layoutOf(page, c1.index);
      expect(
        { w: Number(prop(nav.props, "width")), h: Number(prop(nav.props, "height")) },
        "the navigator's box is not the natural size of two pages (clamped to the page)",
      ).toEqual({ w: Math.min(natural.width, layout.pageWidth), h: Math.min(natural.height, layout.pageHeight) });

      // Run mode: press the item of the second canvas (where describe -- the
      // painter's own read -- says it is).
      const navId = await callModule<string>(page, MOD.CONTROLS_FLOATING_STORE, "makeFloatingControlId", [c1.index, nav.row, nav.col]);
      type NavItem = { sheetId: string; caption: string; current: boolean; rect: { x: number; y: number; width: number; height: number } };
      const described = await eventually(
        () => callModule<{ items: NavItem[] } | null>(page, MOD.NAV_DESCRIBE, "describePageNavigator", [navId]),
        (d) => !!d && d.items.length === 2,
        "the navigator does not describe one item per canvas",
      );
      expect(described!.items.map((i) => i.caption), "one item per canvas, named by page, in tab order").toEqual([c1.name, c2.name]);
      expect(described!.items.map((i) => i.current), "the first canvas's item is the current page").toEqual([true, false]);
      const spot = await freeCanvasRect(page, { width: 8, height: 8 });
      await clickEmpty(page, spot.x + 4, spot.y + 4);
      const toC2 = described!.items[1];
      const at = await sheetPointToPage(page, toC2.rect.x + toC2.rect.width / 2, toC2.rect.y + toC2.rect.height / 2);
      await humanClick(page, at.x, at.y);
      await eventually(() => activeIndex(page), (i) => i === c2.index, "the navigator's item did not switch to its page");

      // On the second page: Buttons > Back, then press it.
      await clickCanvasMenuRow(page, "canvas-buttons", "canvas-buttons-back");
      const back = (await eventually(() => controlsWithProps(page, c2.index), (cs) => cs.some((c) => prop(c.props, "action") === "back"), "Back inserted no action button"))
        .find((c) => prop(c.props, "action") === "back")!;
      const backSpot = await freeCanvasRect(page, { width: 8, height: 8 });
      await clickEmpty(page, backSpot.x + 4, backSpot.y + 4);
      await clickControlCentre(page, back.props);
      await eventually(() => activeIndex(page), (i) => i === c1.index, "Back did not return to the page the user came from");
    } finally {
      await cleanup(page);
    }
  });

  test("P8 Page: Tooltip page size, Wallpaper paints the area outside the page, Lock Objects refuses a drag with exactly one toast", async ({ appPage: page }) => {
    try {
      const canvas = await addCanvas(page);

      // ---- Page Size > Tooltip.
      await clickCanvasMenuRow(page, "canvas-page-size", "canvas-page-size-tooltip");
      await eventually(() => layoutOf(page, canvas.index), (l) => l.pagePreset === "tooltip" && l.pageWidth === 320 && l.pageHeight === 240, "Page Size > Tooltip did not make a 320 x 240 page");
      await closeCanvasFlyouts(page);
      await page.waitForTimeout(500);

      // ---- Wallpaper: the area outside the 320 x 240 page, sampled before and after.
      const g = await gridBox(page);
      const outside: PixelClip = { x: Math.round(g.x + g.width - 120), y: Math.round(g.y + g.height - 120), width: 40, height: 40 };
      const insidePage = await sheetPointToPage(page, 120, 100);
      const inside: PixelClip = { x: Math.round(insidePage.x), y: Math.round(insidePage.y), width: 30, height: 30 };
      const [outBefore, inBefore] = await samplePixelGrids(page, [outside, inside]);
      await (await canvasControl(page, "canvas-page-wallpaper-options")).click();
      const hex = page.locator('[data-testid$="-hex"]').filter({ visible: true }).first();
      await expect(hex, "the Wallpaper palette has no hex field").toBeVisible({ timeout: 5000 });
      await hex.fill("#1F4E79");
      await hex.press("Enter");
      await eventually(() => layoutOf(page, canvas.index), (l) => (l.wallpaper ?? "").toLowerCase() === "#1f4e79", "Wallpaper did not persist #1F4E79");
      await page.keyboard.press("Escape").catch(() => undefined);
      await closeCanvasFlyouts(page);
      await page.waitForTimeout(600);
      const [outAfter, inAfter] = await samplePixelGrids(page, [outside, inside]);
      expect(diffCount(outBefore, outAfter), "the wallpaper did not paint the area outside the page").toBeGreaterThan(outAfter.data.length / 4 / 2);
      const px = outAfter.data.slice(0, 3);
      expect(Math.abs(px[0] - 0x1f) + Math.abs(px[1] - 0x4e) + Math.abs(px[2] - 0x79), `outside the page is not the wallpaper: rgb(${px.join(",")})`).toBeLessThan(24);
      expect(diffCount(inBefore, inAfter), "the wallpaper painted INSIDE the page").toBeLessThan(20);

      // ---- Lock Objects: one shape; a drag is refused with ONE toast; unlocking lets it move.
      await createShape(page, { sheetIndex: canvas.index, x: 40, y: 40, width: 120, height: 80 });
      const shape = (await eventually(() => objects(page), (o) => o.length === 1, "the shape was not published"))[0];
      await clickCanvasControl(page, "canvas-lock-objects");
      await eventually(() => layoutOf(page, canvas.index), (l) => l.objectsLocked === true, "Lock Objects did not lock the page");
      await closeCanvasFlyouts(page);
      await startToasts(page);
      await dragObject(page, shape, [{ dx: 16, dy: 0 }, { dx: 48, dy: 8 }], { dx: 60, dy: 40 });
      await page.waitForTimeout(900);
      expect((await controlsOn(page, canvas.index))[0].x, "a LOCKED page let the shape move").toBe(40);
      const lockToasts = (await toasts(page)).filter((t) => /locked/i.test(t.text));
      expect(lockToasts.length, `one drag must say so exactly once: ${JSON.stringify(await toasts(page))}`).toBe(1);
      expect(lockToasts[0].text).toContain("Lock Objects");

      await clickCanvasControl(page, "canvas-lock-objects");
      await eventually(() => layoutOf(page, canvas.index), (l) => !l.objectsLocked, "Lock Objects did not unlock the page");
      await closeCanvasFlyouts(page);
      const again = (await objects(page))[0];
      await dragObject(page, again, [{ dx: 16, dy: 0 }, { dx: 48, dy: 0 }], { dx: 60, dy: 40 });
      await eventually(async () => (await controlsOn(page, canvas.index))[0].x, (x) => x !== 40, "after unlocking, the shape still cannot be dragged (positive control)");
    } finally {
      await cleanup(page);
    }
  });

  test("P9 View: Page View > Fit to Width fits the page's width and is checked; Themes opens the document theme gallery", async ({ appPage: page }) => {
    try {
      const canvas = await addCanvas(page);
      const layout = await layoutOf(page, canvas.index);
      await clickCanvasMenuRow(page, "canvas-page-view", "canvas-page-view-actual");
      await eventually(() => readGridGeometry(page), (g) => Math.abs(g.zoom - 1) < 0.01, "Actual Size did not set 100%");
      await closeCanvasFlyouts(page);

      await clickCanvasMenuRow(page, "canvas-page-view", "canvas-page-view-fitWidth");
      const geo = await eventually(() => readGridGeometry(page), (g) => Math.abs(g.zoom - 1) > 0.01, "Fit to Width did not change the zoom");
      const box = await gridBox(page);
      const shown = layout.pageWidth * geo.zoom;
      expect(shown, `the fitted page (${shown.toFixed(0)} px) is wider than the view (${box.width.toFixed(0)} px)`).toBeLessThanOrEqual(box.width);
      expect(shown, `the fitted page (${shown.toFixed(0)} px) does not use the view's width (${box.width.toFixed(0)} px)`).toBeGreaterThan(box.width * 0.85);
      await closeCanvasFlyouts(page);
      const row = await canvasMenuRow(page, "canvas-page-view", "canvas-page-view-fitWidth");
      await expect(row, "Fit to Width is not the checked view").toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await closeCanvasFlyouts(page);

      // ---- Themes: the Page Layout gallery, hosted by the Canvas tab.
      await clickCanvasControl(page, "canvas-themes");
      const rows = page.locator('[data-testid^="page-layout-theme-"]').filter({ visible: true });
      await eventually(() => rows.count(), (n) => n > 1, "Themes opened no theme gallery rows");
      await page.keyboard.press("Escape");
      await expect(rows).toHaveCount(0);
    } finally {
      await cleanup(page);
    }
  });

  test("P10 LPAD/RPAD: =LPAD(42;5;\"0\") shows 00042, RPAD lifts over a range and spills, fx lists both under Text, =LP offers LPAD with its hint, and the formulas survive save and reopen", async ({ appPage: page, grid }) => {
    const doc = path.join(os.tmpdir(), `calcula-canvas-pbi-lpad-${Date.now()}.cala`);
    try {
      await writeGrid(page, [["=LPAD(42;5;\"0\")"]], 0, 0);
      await writeGrid(page, [["ab"], ["abcd"], ["x"]], 2, 0);
      await writeGrid(page, [["=RPAD(A3:A5;6;\".\")"]], 2, 2);
      const show = async (r: number, c: number) => (await invoke<{ display?: string } | null>(page, "get_cell", { row: r, col: c }))?.display ?? "";
      await eventually(() => show(0, 0), (d) => d === "00042", "=LPAD(42;5;\"0\") does not show 00042");
      expect([await show(2, 2), await show(3, 2), await show(4, 2)], "RPAD spills one padded text per row").toEqual(["ab....", "abcd..", "x....."]);

      // ---- fx: both under Text.
      await grid.clickCell("E1");
      await page.locator('button[title="Insert Function"]').click();
      const rail = page.locator('[data-testid="function-category-rail"]');
      await expect(rail).toBeVisible({ timeout: 5000 });
      await rail.getByRole("button", { name: "Text", exact: true }).click();
      const list = page.locator('[data-testid="function-list-pane"]');
      for (const fn of ["LPAD", "RPAD"]) await expect(list.getByText(fn, { exact: true }), `fx > Text does not list ${fn}`).toBeVisible();
      await list.getByText("LPAD", { exact: true }).click();
      await expect(page.getByText(/LPAD\(text, ?length/), "the fx details show no LPAD signature").toBeVisible();
      await page.locator('input[placeholder="Search for a function..."]').press("Escape");
      await expect(rail).toHaveCount(0);
      // Cancel takes back the "=" fx typed (Excel): no entry is left open in E1.
      await eventually(() => page.evaluate(() => (window as unknown as { __CALCULA_GRID_STATE__?: { editing?: unknown } }).__CALCULA_GRID_STATE__?.editing ?? null), (e) => e === null, "cancelling fx left the \"=\" entry open in E1");

      // ---- Typing =LP offers LPAD; its argument hint follows.
      await grid.clickCell("E2");
      const container = page.locator('[data-focus-container="spreadsheet"]');
      for (let i = 0; i < 5; i++) {
        await container.focus();
        await page.waitForTimeout(200);
        if (await page.evaluate(() => document.activeElement?.getAttribute("data-focus-container") === "spreadsheet")) break;
      }
      await page.keyboard.type("=");
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-inline-editor") === "true", undefined, { timeout: 5000, polling: 200 });
      await page.waitForTimeout(150);
      await page.keyboard.type("LP", { delay: 80 });
      const dropdown = page.locator('[data-testid="formula-autocomplete"]');
      await expect(dropdown, "=LP opened no suggestions").toBeVisible({ timeout: 5000 });
      await expect(dropdown.getByText("LPAD", { exact: true }), "=LP does not offer LPAD").toBeVisible();
      await page.keyboard.type("AD(", { delay: 80 });
      const hint = page.locator('[data-testid="formula-argument-hint"]');
      await expect(hint, "LPAD( shows no argument hint").toBeVisible({ timeout: 5000 });
      await expect(hint).toContainText("LPAD");
      await expect(hint).toContainText("length");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      // ---- Save and reopen.
      await invoke(page, "save_file", { path: doc });
      await newFile(page);
      await openFileAtPath(page, doc);
      await eventually(() => show(0, 0), (d) => d === "00042", "after reopening, A1 does not show 00042");
      const a1 = await invoke<{ formula?: string | null } | null>(page, "get_cell", { row: 0, col: 0 });
      expect(a1?.formula ?? "", "the LPAD formula did not survive save and reopen").toMatch(/^=LPAD\(42[;,]\s?5[;,]\s?"0"\)$/);
      expect(await show(3, 2), "the RPAD spill did not survive save and reopen").toBe("abcd..");
    } finally {
      await cleanup(page);
      fs.rmSync(doc, { force: true });
    }
  });
});
