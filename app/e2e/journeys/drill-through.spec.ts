/**
 * DRILL-THROUGH ON MODEL VISUALS, LIVE (2026-10-23).
 *
 * A design-query chart and a BI pivot each carry a drill-through DEFINITION
 * (a design-query DSL plus a presentation); the clicked datum's members are
 * added to that query as ONE `FILTERS:` clause on member KEYS, and the result
 * lands on an EPHEMERAL sheet that closes when the user leaves it unless the
 * tab is double-clicked, which keeps it. docs/design/model-drillthrough.md is
 * the spec; this journey drives it through the REAL right-click menus, the
 * REAL tab strip and the REAL backend.
 *
 * THE FIXTURE is the sales-star model written to CSV in a temp folder (the
 * canvas-powerbi / insight-overlays-pivot recipe): no server, four small
 * dimension tables and a Sales fact.
 *
 * ORACLES ARE NEVER TYPED IN. Every expected number comes from
 * `designQueryOracle` (helpers/crossfilter-live.ts): the product's own DSL
 * compiler plus `run_design_query` invoked DIRECTLY with an explicit
 * `pageFilterFields` for the drilled member -- never through the drill, so a
 * bake defect cannot make the sheet and its oracle agree.
 *
 * WHAT IS ASSERTED. The backend's sheet list (`get_sheets`: count, active
 * index, `ephemeral`, `kind`, identity by `sheetId` across index shifts), the
 * cells the table presentation wrote (`get_range_cells_typed`), the persisted
 * chart of the chart presentation (`get_charts`: its sheet and the baked
 * `dslText`), the DOM of the two context menus. Never a golden.
 *
 * ONE WORKBOOK, SERIAL. `beforeAll` builds it (a canvas "Report" with the bar
 * chart C; Sheet1 holds the pivot PV); J1..J9 run on it in order and a failure
 * stops the chain so no later step passes on a state an earlier step never
 * reached.
 *
 * SABOTAGES (run each once in the proof phase, confirm it changed behaviour,
 * see the named assertion fail, revert):
 *   SB1 bakeDrillFilters returns the DSL unchanged        -> J1 "the table equals the oracle for <CAT>"
 *   SB2 resolveEphemeralLeave always returns null         -> J2 "the drill sheet is gone by id"
 *   SB3 resolveTabDoubleClick always returns "rename"     -> J3 "the kept sheet is no longer ephemeral"
 *   SB4 append_user_sheet skips the ephemeral insert (Rust, sheets.rs) -> J1 "the drill sheet is ephemeral"
 *   SB5 the chart presentation creates its chart with the UNBAKED dsl -> J4 "the result chart's query carries the drilled member"
 *   SB6 the pivot value-cell label stays "Show Details"   -> J5 "the pivot's value cell offers Drill through"
 *   SB7 the row is offered on a chart whose datum has no identity -> J6 "a transformed chart's row is disabled"
 *   SB8 the strip discards by the INDEX its leave observer read, with the two-step-flow guard off (the pre-fix code)
 *                                                          -> J7 "the insert landed and the temporary sheet went"
 *        (a user sheet -- the one J3 kept -- is deleted and the temporary sheet stays, so the
 *        wait for the expected list fails before "every sheet ... survives" is reached)
 *   SB9 the leave observer pauses only while the formula EXPECTS a reference (the pre-fix predicate)
 *                                                          -> J8 "the temporary sheet survives a reference pick on another sheet"
 *   SB10 hasDesignQueryDrill ignores the region's hasDesignQueryDrill (cache only, the pre-fix code)
 *                                                          -> J9 "a never-selected box offers Drill through on its first right-click"
 *
 * PROVED 2026-10-23: each sabotage was run once against the live app (SB4
 * after a rebuild) and the assertion named above was seen red, then reverted
 * through a harness that backs the file up and checks no marker is left.
 *
 * J7-J9 were added after the review round (2026-10-23) for the review's two
 * blockers -- a leave judged in the middle of Insert Sheet deleted a user
 * sheet by a stale index; a formula's cross-sheet reference pick discarded the
 * sheet being edited -- and for the cold label of a never-selected canvas box.
 * J7 inserts a sheet at index 0, so J7-J9 find every sheet by its STABLE id.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import {
  MOD,
  addCanvas,
  callModule,
  clickSheetTab,
  createChart,
  eventually,
  humanClick,
  installAppImport,
  invoke,
  newFile,
  persistedCharts,
  sheetsResult,
  type AppWindow,
  type SheetRow,
} from "../helpers/canvas-live";
import { barPoint, designQueryOracle, near, valuesByMember, type DesignQueryView } from "../helpers/crossfilter-live";
import { cellPagePoint } from "../helpers/edit-harness";
import {
  cellPagePoint as boxCellPoint,
  createAwCanvasPivot,
  findViewCell,
} from "../helpers/adventureworks-live";
import { GRID_MENU } from "../helpers/life-lifecycle";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "../../../tests/fixtures/model");
const STAR_SOURCE = "drill_through_csv";
/** The @api pivot facade (`pivot.createFromBiModel` / `pivot.updateBiFields`), as insight-overlays-pivot uses it. */
const PIVOT_FACADE = "/src/api/pivot.ts";
/** The Pivot extension's own module (`setPivotDrillBehavior`). */
const PIVOT_API = MOD.PIVOT_API;

const CHART_MENU = "[data-chart-context-menu]";
const DRILL_ROW = `${CHART_MENU} [data-chart-menu-item="drillThrough"]`;

/** The category the journey drills on (a member of the sales-star fixture's Product.Category). */
const CAT = "Gadgets";
/** The definition's query: revenue by region. The clicked category is ADDED by the drill. */
const DRILL_DSL = "ROWS: Geography.Region\nVALUES: [Revenue]";
/** The source chart's query: revenue by product category (the bars). */
const CHART_DSL = "ROWS: Product.Category\nVALUES: [Revenue]";

// ---------------------------------------------------------------------------
// Fixture: the sales star over CSV
// ---------------------------------------------------------------------------

interface StarBundle {
  model: { tables: Array<{ name: string; columns: Array<{ name: string; data_type: unknown }>; [k: string]: unknown }>; [k: string]: unknown };
  data: Record<string, { columns: string[]; rows: unknown[][] }>;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function starModelOver(dir: string): Record<string, unknown> {
  const bundle = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "sales_star.json"), "utf8")) as StarBundle;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-drill-"));
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

interface TypedCell {
  row: number;
  col: number;
  value: unknown;
  display: string;
  type: string;
}

/** Every non-empty cell of the top-left box of a sheet, by the backend's typed read. */
async function sheetCells(page: Page, sheetIndex: number, rows = 30, cols = 4): Promise<TypedCell[]> {
  return invoke<TypedCell[]>(page, "get_range_cells_typed", {
    sheetIndex,
    startRow: 0,
    startCol: 0,
    endRow: rows - 1,
    endCol: cols - 1,
  });
}

/** The "<row label> -> number" pairs a drill TABLE wrote (label in col 0, the first number to its right). */
function tableValues(cells: TypedCell[]): Record<string, number> {
  const byRow = new Map<number, TypedCell[]>();
  for (const c of cells) {
    const list = byRow.get(c.row) ?? [];
    list.push(c);
    byRow.set(c.row, list);
  }
  const out: Record<string, number> = {};
  for (const [, list] of byRow) {
    const label = list.find((c) => c.col === 0 && typeof c.value === "string" && c.value !== "");
    const number = list.find((c) => c.col > 0 && typeof c.value === "number");
    if (label && number) out[String(label.value)] = number.value as number;
  }
  return out;
}

/** The oracle for the DEFINITION's query filtered to one member of one field. */
async function drillOracle(page: Page, connectionId: string, field: string, key: string): Promise<DesignQueryView> {
  return designQueryOracle(page, connectionId, DRILL_DSL, [{ field, keys: [key] }]);
}

function sheetById(r: { sheets: SheetRow[] }, id: string): SheetRow | undefined {
  return r.sheets.find((s) => s.sheetId === id);
}

/** Wait for a NEW active sheet to appear beyond `before`, and return it. */
async function waitForNewActiveSheet(page: Page, before: { sheets: SheetRow[] }, label: string): Promise<SheetRow & { ephemeral?: boolean }> {
  const ids = new Set(before.sheets.map((s) => s.sheetId));
  const r = await eventually(
    () => sheetsResult(page) as Promise<{ sheets: Array<SheetRow & { ephemeral?: boolean }>; activeIndex: number }>,
    (x) => x.sheets.length === before.sheets.length + 1 && !ids.has(x.sheets.find((s) => s.index === x.activeIndex)?.sheetId),
    label,
    20_000,
  );
  const active = r.sheets.find((s) => s.index === r.activeIndex);
  if (!active) throw new Error(`${label}: no active sheet in the result`);
  return active;
}

/** The CURRENT index of a sheet, by its stable id (indices shift under an insert). */
async function indexOfSheet(page: Page, sheetId: string): Promise<number> {
  const r = await sheetsResult(page);
  const sheet = sheetById(r, sheetId);
  if (!sheet) throw new Error(`no sheet has id ${sheetId}`);
  return sheet.index;
}

/** Run a registered command the way a menu item or a key binding does. */
async function executeCommand(page: Page, id: string, args?: unknown): Promise<void> {
  await installAppImport(page);
  await page.evaluate(
    async ({ id, args }) => {
      const m = (await (window as unknown as AppWindow).__appImport!("/src/api/commands.ts")) as {
        CommandRegistry: { execute: (id: string, args?: unknown) => Promise<unknown> };
      };
      await m.CommandRegistry.execute(id, args);
    },
    { id, args },
  );
}

/** Drill through the CAT bar of the report's chart as a TABLE and return the new active sheet. */
async function drillTableFromReport(page: Page, s: Scene): Promise<SheetRow & { ephemeral?: boolean }> {
  await clickSheetTab(page, await indexOfSheet(page, s.canvasId));
  await setChartDrill(page, s.chartId, { dslText: DRILL_DSL, presentation: { kind: "table" }, name: "Regions", keepFilters: true });
  const before = await sheetsResult(page);
  await openChartMenuOnBar(page, s.chartId, CAT);
  await page.locator(DRILL_ROW).click();
  const drill = await waitForNewActiveSheet(page, before, "the drill adds a sheet and lands on it");
  expect(drill.ephemeral, "the drill sheet is ephemeral").toBe(true);
  return drill;
}

async function openChartMenuOnBar(page: Page, chartId: string, category: string): Promise<void> {
  const p = await barPoint(page, chartId, category);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(120);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await expect(page.locator(CHART_MENU), "the chart context menu opens on the bar").toBeVisible({ timeout: 5_000 });
}

async function setChartDrill(page: Page, chartId: string, definition: Record<string, unknown> | undefined): Promise<void> {
  await callModule(page, MOD.CHART_STORE, "updateChartSpec", [chartId, { drillThrough: definition }]);
  await callModule(page, MOD.CHART_STORE, "syncChartRegions");
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

interface Scene {
  connectionId: string;
  canvasIndex: number;
  canvasId: string;
  chartId: string;
  pivotId: string;
  /** The pivot's CAT value cell on Sheet1 (grid coordinates). */
  pivotCatCell: { row: number; col: number };
  catOracle: Record<string, number>;
}

let conn: { connectionId: string; dir: string } | null = null;
let scene: Scene | null = null;

function needScene(): Scene {
  if (!scene) throw new Error("the scene was not built (beforeAll failed); every step needs it");
  return scene;
}

test.describe("Drill-through on model visuals, live on the sales star", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test.beforeAll(async ({ sharedPage: page }) => {
    await installAppImport(page);
    await newFile(page);
    conn = await connectStar(page, "Sales star (drill-through journey)");
    const { connectionId } = conn;

    // Sheet1 (index 0): the BI pivot PV, categories down, Revenue.
    const created = await page.evaluate(
      async ({ connectionId, mod, cat }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          pivot: {
            createFromBiModel: (r: unknown) => Promise<{ pivotId: string }>;
            updateBiFields: (r: unknown) => Promise<{ rows: Array<{ viewRow: number; rowType: string; cells: Array<{ cellType: string; value: unknown }> }> }>;
          };
        };
        const v = await m.pivot.createFromBiModel({ destinationCell: "B2", connectionId, name: "PV" });
        const view = await m.pivot.updateBiFields({
          pivotId: v.pivotId,
          rowFields: [{ table: "Product", column: "Category" }],
          columnFields: [],
          valueFields: [{ measureName: "Revenue" }],
          filterFields: [],
        });
        const hit = view.rows.find((r) => r.rowType === "Data" && r.cells.some((c) => c.cellType === "RowHeader" && c.value === cat));
        const dataCol = hit ? hit.cells.findIndex((c) => c.cellType === "Data") : -1;
        return { pivotId: v.pivotId, catViewRow: hit?.viewRow ?? -1, dataCol };
      },
      { connectionId, mod: PIVOT_FACADE, cat: CAT },
    );
    expect(created.catViewRow, `the pivot shows a ${CAT} row`).toBeGreaterThanOrEqual(0);
    expect(created.dataCol, `the ${CAT} row has a value cell`).toBeGreaterThanOrEqual(0);
    // B2 is (row 1, col 1); the view is written at the anchor.
    const pivotCatCell = { row: 1 + created.catViewRow, col: 1 + created.dataCol };

    // The pivot's drill: a design query, presented as a table.
    await page.evaluate(
      async ({ pivotId, mod, dsl }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          setPivotDrillBehavior: (pivotId: string, behavior: unknown) => Promise<void>;
        };
        await m.setPivotDrillBehavior(pivotId, {
          kind: "builtin",
          designQuery: { dslText: dsl, presentation: { kind: "table" }, name: "Regions", keepFilters: true },
        });
      },
      { pivotId: created.pivotId, mod: PIVOT_API, dsl: DRILL_DSL },
    );

    // The canvas "Report" with the bar chart C.
    const canvas = await addCanvas(page);
    const chartId = await createChart(
      page,
      {
        mark: "bar",
        data: { type: "designQuery", dslText: CHART_DSL, connectionId },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [],
        title: "Revenue by category",
      },
      { sheetIndex: canvas.index, x: 40, y: 40, width: 520, height: 320, name: "C" },
    );
    await setChartDrill(page, chartId, { dslText: DRILL_DSL, presentation: { kind: "table" }, name: "Regions", keepFilters: true });

    const oracle = valuesByMember(await drillOracle(page, connectionId, "Product.Category", CAT), { byLabel: true });
    expect(Object.keys(oracle).length, `the oracle has regions for ${CAT}`).toBeGreaterThan(0);

    scene = {
      connectionId,
      canvasIndex: canvas.index,
      canvasId: canvas.sheetId ?? "",
      chartId,
      pivotId: created.pivotId,
      pivotCatCell,
      catOracle: oracle,
    };
    console.log(`[drill] scene: canvas ${canvas.index} (${canvas.sheetId}), chart ${chartId}, pivot ${created.pivotId}, oracle ${JSON.stringify(oracle)}`);
  });

  test.afterAll(async ({ sharedPage: page }) => {
    await dropStar(page, conn);
  });

  // -------------------------------------------------------------------------
  // J1: right-click a bar -> Drill through -> an ephemeral TABLE sheet
  // -------------------------------------------------------------------------
  test("J1 a right-click on a category bar offers Drill through, and the table sheet equals the oracle", async ({ sharedPage: page }) => {
    const s = needScene();
    await clickSheetTab(page, s.canvasIndex);
    const before = await sheetsResult(page);

    await openChartMenuOnBar(page, s.chartId, CAT);
    const row = page.locator(DRILL_ROW);
    await expect(row, "the run row is offered on a datum of a chart with a definition").toHaveCount(1);
    await expect(row, "the run row names the datum it acts on").toContainText(CAT);
    await row.click();

    const drill = await waitForNewActiveSheet(page, before, "the drill adds a sheet and lands on it");
    expect(drill.ephemeral, "the drill sheet is ephemeral").toBe(true);
    expect(drill.kind ?? "worksheet", "a table presentation is a worksheet").toBe("worksheet");

    const cells = await eventually(
      () => sheetCells(page, drill.index),
      (c) => Object.keys(tableValues(c)).length >= Object.keys(s.catOracle).length,
      "the table sheet holds a region row per oracle member",
      15_000,
    );
    const got = tableValues(cells);
    for (const [region, expected] of Object.entries(s.catOracle)) {
      expect(got[region], `the table equals the oracle for ${CAT}: ${region}`).toBeDefined();
      expect(near(got[region], expected), `the table equals the oracle for ${CAT}: ${region} = ${got[region]} vs ${expected}`).toBe(true);
    }
    const caption = cells.filter((c) => c.row === 1).map((c) => c.display).join(" ");
    expect(caption, "the caption names the drilled member by its label").toContain(CAT);
  });

  // -------------------------------------------------------------------------
  // J2: leaving the sheet deletes it
  // -------------------------------------------------------------------------
  test("J2 clicking back to the report removes the drill sheet", async ({ sharedPage: page }) => {
    const s = needScene();
    const r = await sheetsResult(page);
    const drill = r.sheets.find((x) => x.index === r.activeIndex);
    if (!drill?.sheetId) throw new Error("J2 needs the drill sheet J1 left active");
    const drillId = drill.sheetId;

    await clickSheetTab(page, s.canvasIndex);
    const after = await eventually(() => sheetsResult(page), (x) => !sheetById(x, drillId), "the drill sheet is gone by id", 15_000);
    expect(sheetById(after, s.canvasId)?.index, "the report is the active sheet").toBe(after.activeIndex);
    expect(after.sheets.length, "exactly the drill sheet went").toBe(r.sheets.length - 1);
  });

  // -------------------------------------------------------------------------
  // J3: a double-click on the tab keeps it
  // -------------------------------------------------------------------------
  test("J3 a double-click on the drill tab keeps the sheet, which then survives a leave", async ({ sharedPage: page }) => {
    const s = needScene();
    const before = await sheetsResult(page);
    await openChartMenuOnBar(page, s.chartId, CAT);
    await page.locator(DRILL_ROW).click();
    const drill = await waitForNewActiveSheet(page, before, "the second drill adds a sheet");
    expect(drill.ephemeral, "the second drill sheet is ephemeral").toBe(true);
    const drillId = drill.sheetId ?? "";

    await page.locator(`button[data-sheet-tab="${drill.index}"]`).dblclick();
    const kept = await eventually(
      () => sheetsResult(page) as Promise<{ sheets: Array<SheetRow & { ephemeral?: boolean }>; activeIndex: number }>,
      (x) => x.sheets.find((y) => y.sheetId === drillId)?.ephemeral === false,
      "the kept sheet is no longer ephemeral",
      10_000,
    );
    expect(kept.sheets.find((y) => y.sheetId === drillId)?.name, "the kept sheet keeps its name").toBe(drill.name);

    await clickSheetTab(page, s.canvasIndex);
    await page.waitForTimeout(1_500);
    const after = await sheetsResult(page);
    expect(sheetById(after, drillId), "the kept sheet survives a leave").toBeDefined();
  });

  // -------------------------------------------------------------------------
  // J4: the chart presentation
  // -------------------------------------------------------------------------
  test("J4 a chart presentation lands a canvas with one chart whose query carries the drilled member", async ({ sharedPage: page }) => {
    const s = needScene();
    await setChartDrill(page, s.chartId, { dslText: DRILL_DSL, presentation: { kind: "chart", mark: "pie" }, name: "Regions", keepFilters: true });
    const before = await sheetsResult(page);
    await openChartMenuOnBar(page, s.chartId, CAT);
    await page.locator(DRILL_ROW).click();
    const drill = await waitForNewActiveSheet(page, before, "the chart drill adds a sheet");
    expect(drill.ephemeral, "the chart drill sheet is ephemeral").toBe(true);
    expect(drill.kind, "a chart presentation is a canvas").toBe("canvas");

    const charts = await eventually(
      () => persistedCharts(page),
      (cs) => cs.some((c) => c.sheetIndex === drill.index),
      "the result chart is persisted on the drill canvas",
      15_000,
    );
    const result = charts.filter((c) => c.sheetIndex === drill.index);
    expect(result.length, "exactly one chart on the drill canvas").toBe(1);
    expect(result[0].spec.mark, "the result chart has the definition's mark").toBe("pie");
    const data = result[0].spec.data as { type?: string; dslText?: string; connectionId?: string };
    expect(data.type).toBe("designQuery");
    expect(data.connectionId, "the result chart reads the source's connection").toBe(s.connectionId);
    expect(data.dslText ?? "", "the result chart's query carries the drilled member").toMatch(
      new RegExp(`FILTERS:[^\\n]*\\[Product\\.Category\\]\\s*=\\s*\\(\\s*"${CAT}"\\s*\\)`),
    );

    await clickSheetTab(page, s.canvasIndex);
    const drillId = drill.sheetId ?? "";
    await eventually(() => sheetsResult(page), (x) => !sheetById(x, drillId), "the chart drill sheet is gone by id", 15_000);
    const left = await persistedCharts(page);
    expect(left.some((c) => c.id === result[0].id), "the result chart went with its sheet").toBe(false);
  });

  // -------------------------------------------------------------------------
  // J5: the pivot's value cell
  // -------------------------------------------------------------------------
  test("J5 the pivot's value cell offers Drill through and drills to the same oracle", async ({ sharedPage: page }) => {
    const s = needScene();
    await clickSheetTab(page, 0);
    await page.waitForTimeout(500);
    const before = await sheetsResult(page);

    const p = await cellPagePoint(page, s.pivotCatCell.row, s.pivotCatCell.col);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(120);
    await page.mouse.click(p.x, p.y, { button: "right" });
    const menu = page.locator(GRID_MENU);
    await expect(menu, "the grid context menu opens on the pivot's value cell").toBeVisible({ timeout: 5_000 });
    const item = menu.locator('[role="menuitem"]').filter({ hasText: /^Drill through$/ });
    await expect(item, "the pivot's value cell offers Drill through").toHaveCount(1);
    await expect(menu.locator('[role="menuitem"]').filter({ hasText: /^Show Details$/ }), "Show Details gave way to Drill through").toHaveCount(0);
    await item.click();

    const drill = await waitForNewActiveSheet(page, before, "the pivot drill adds a sheet");
    expect(drill.ephemeral, "the pivot drill sheet is ephemeral").toBe(true);
    const cells = await eventually(
      () => sheetCells(page, drill.index),
      (c) => Object.keys(tableValues(c)).length >= Object.keys(s.catOracle).length,
      "the pivot drill table holds a region row per oracle member",
      15_000,
    );
    const got = tableValues(cells);
    for (const [region, expected] of Object.entries(s.catOracle)) {
      expect(near(got[region] ?? Number.NaN, expected), `the pivot drill equals the oracle for ${CAT}: ${region}`).toBe(true);
    }

    await clickSheetTab(page, 0);
    const drillId = drill.sheetId ?? "";
    await eventually(() => sheetsResult(page), (x) => !sheetById(x, drillId), "the pivot drill sheet is gone by id", 15_000);
  });

  // -------------------------------------------------------------------------
  // J6: a datum without identity is told, not drilled unfiltered
  // -------------------------------------------------------------------------
  test("J6 a transformed chart's row is disabled with a reason", async ({ sharedPage: page }) => {
    const s = needScene();
    await clickSheetTab(page, s.canvasIndex);
    // A transform strips the member paths (chartDataReader withoutSourceText).
    await callModule(page, MOD.CHART_STORE, "updateChartSpec", [s.chartId, { transform: [{ type: "sort", field: "Revenue", order: "desc" }] }]);
    await callModule(page, MOD.CHART_RENDERER, "invalidateChartCache", [s.chartId]);
    await callModule(page, MOD.CHART_STORE, "syncChartRegions");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("app:grid-refresh")));
    await page.waitForTimeout(1_500);
    const before = await sheetsResult(page);

    await openChartMenuOnBar(page, s.chartId, CAT);
    const row = page.locator(DRILL_ROW);
    await expect(row, "the run row is still listed").toHaveCount(1);
    await expect(row, "a transformed chart's row is disabled").toHaveAttribute("aria-disabled", "true");
    await row.click({ force: true });
    await page.waitForTimeout(1_500);
    const after = await sheetsResult(page);
    expect(after.sheets.length, "a disabled row drills nothing").toBe(before.sheets.length);
    await page.keyboard.press("Escape");

    // Restore the chart for anything that runs after.
    await callModule(page, MOD.CHART_STORE, "updateChartSpec", [s.chartId, { transform: undefined }]);
    await callModule(page, MOD.CHART_RENDERER, "invalidateChartCache", [s.chartId]);
    await callModule(page, MOD.CHART_STORE, "syncChartRegions");
  });

  // -------------------------------------------------------------------------
  // J7: Insert Sheet while on a temporary sheet (review blocker 1)
  // -------------------------------------------------------------------------
  test("J7 inserting a sheet before the first tab while on a temporary sheet removes only the temporary sheet", async ({ sharedPage: page }) => {
    const s = needScene();
    const before = await sheetsResult(page);
    const drill = await drillTableFromReport(page, s);
    const drillId = drill.sheetId ?? "";

    // Excel's Insert on the first tab: add a sheet, then move it to index 0
    // -- the strip's own two-step flow. Landing on the new sheet LEAVES the
    // temporary one, which must be the one removed.
    await executeCommand(page, "core.sheet.insert", { index: 0 });
    const after = await eventually(
      () => sheetsResult(page),
      (r) => !sheetById(r, drillId) && r.sheets.length === before.sheets.length + 1,
      "the insert landed and the temporary sheet went",
      20_000,
    );
    const oldIds = before.sheets.map((x) => x.sheetId);
    const survivors = after.sheets.filter((x) => oldIds.includes(x.sheetId)).map((x) => x.sheetId);
    expect(survivors, "every sheet that existed before the drill survives, in order").toEqual(oldIds);
    const first = after.sheets.find((x) => x.index === Math.min(...after.sheets.map((y) => y.index)));
    expect(oldIds.includes(first?.sheetId), "the inserted sheet is the first tab").toBe(false);
    expect(first?.index, "the inserted sheet is the active one").toBe(after.activeIndex);
  });

  // -------------------------------------------------------------------------
  // J8: a formula's reference pick on another sheet (review blocker 2)
  // -------------------------------------------------------------------------
  test("J8 a formula that picks a reference on another sheet keeps the temporary sheet it is written on", async ({ sharedPage: page, gridPersistent }) => {
    const s = needScene();
    const drill = await drillTableFromReport(page, s);
    const drillId = drill.sheetId ?? "";
    const sheet1 = (await sheetsResult(page)).sheets.find((x) => x.name === "Sheet1");
    if (!sheet1?.sheetId) throw new Error("J8 needs Sheet1");

    // G2 is right of the drill table (Region, Revenue): an empty cell.
    await gridPersistent.clickCell("G2");
    await page.keyboard.type("=");
    // Point mode across sheets: the edit stays alive while Sheet1 is shown.
    await page.locator(`button[data-sheet-tab="${sheet1.index}"]`).click();
    await page.waitForTimeout(500);
    await gridPersistent.clickCell("A1");
    await eventually(
      () => gridPersistent.formulaBar.inputValue(),
      (v) => v === "=Sheet1!A1",
      "clicking Sheet1!A1 inserted a qualified reference into the drill sheet's edit",
    );
    // The reference is in: the formula no longer EXPECTS one, but the edit is
    // still open on the temporary sheet. Give a wrong observer time to act.
    await page.waitForTimeout(1_200);
    expect(sheetById(await sheetsResult(page), drillId), "the temporary sheet survives a reference pick on another sheet").toBeDefined();
    await page.keyboard.press("Enter");

    const back = await eventually(
      () => sheetsResult(page),
      (r) => sheetById(r, drillId)?.index === r.activeIndex,
      "Enter returned to the temporary sheet",
      10_000,
    );
    const drillIndex = sheetById(back, drillId)?.index ?? -1;
    const g2 = await eventually(
      () =>
        invoke<Array<TypedCell & { formula?: string | null }>>(page, "get_range_cells_typed", {
          sheetIndex: drillIndex,
          startRow: 1,
          startCol: 6,
          endRow: 1,
          endCol: 6,
        }),
      (c) => c.length === 1,
      "the formula was stored on the temporary sheet",
    );
    expect(g2[0].formula, "the formula landed on the temporary sheet's G2").toBe("=Sheet1!A1");

    // A real leave still removes it.
    await clickSheetTab(page, await indexOfSheet(page, s.canvasId));
    await eventually(() => sheetsResult(page), (r) => !sheetById(r, drillId), "leaving after the edit removes the temporary sheet", 15_000);
  });

  // -------------------------------------------------------------------------
  // J9: the first right-click on a never-selected canvas pivot box
  // -------------------------------------------------------------------------
  test("J9 a never-selected canvas pivot box offers Drill through on its first right-click, and drills", async ({ sharedPage: page }) => {
    const s = needScene();
    const canvasIndex = await indexOfSheet(page, s.canvasId);
    await clickSheetTab(page, canvasIndex);
    const boxId = await createAwCanvasPivot(page, {
      canvasIndex,
      connectionId: s.connectionId,
      frame: { x: 600, y: 40, width: 360, height: 260 },
      rows: [{ table: "Product", column: "Category" }],
      columns: [],
      values: [{ measureName: "Revenue" }],
      name: "PB",
    });
    await page.evaluate(
      async ({ pivotId, mod, dsl }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          setPivotDrillBehavior: (pivotId: string, behavior: unknown) => Promise<void>;
        };
        await m.setPivotDrillBehavior(pivotId, {
          kind: "builtin",
          designQuery: { dslText: dsl, presentation: { kind: "table" }, name: "Regions", keepFilters: true },
        });
      },
      { pivotId: boxId, mod: PIVOT_API, dsl: DRILL_DSL },
    );
    // Cold: away and back, so nothing about the box is cached from a selection.
    const sheet1 = (await sheetsResult(page)).sheets.find((x) => x.name === "Sheet1");
    await clickSheetTab(page, sheet1?.index ?? 0);
    await clickSheetTab(page, await indexOfSheet(page, s.canvasId));
    await page.waitForTimeout(800);

    const at = await findViewCell(
      page,
      boxId,
      (cell, _r, _c, row) => row.rowType === "Data" && cell.cellType === "Data" && row.cells.some((x) => x.cellType === "RowHeader" && x.value === CAT),
    );
    if (!at) throw new Error(`the box shows no ${CAT} value cell`);
    const before = await sheetsResult(page);
    const p = await boxCellPoint(page, boxId, at.viewRow, at.viewCol);
    await humanClick(page, p.x, p.y, "right");
    await expect(page.locator('[data-pivot-box-menu="0"]'), "the right-click opens the box menu").toBeVisible({ timeout: 5_000 });
    const item = page.locator('[data-pivot-box-menu="0"] [role="menuitem"][data-item-id="pivot:showDetails"]');
    await expect(item, "a never-selected box offers Drill through on its first right-click").toHaveText(/^\s*Drill through\s*$/);
    await item.click();

    const drill = await waitForNewActiveSheet(page, before, "the box drill adds a sheet");
    expect(drill.ephemeral, "the box drill sheet is ephemeral").toBe(true);
    const cells = await eventually(
      () => sheetCells(page, drill.index),
      (c) => Object.keys(tableValues(c)).length >= Object.keys(s.catOracle).length,
      "the box drill table holds a region row per oracle member",
      15_000,
    );
    const got = tableValues(cells);
    for (const [region, expected] of Object.entries(s.catOracle)) {
      expect(near(got[region] ?? Number.NaN, expected), `the box drill equals the oracle for ${CAT}: ${region}`).toBe(true);
    }
    await clickSheetTab(page, await indexOfSheet(page, s.canvasId));
    const drillId = drill.sheetId ?? "";
    await eventually(() => sheetsResult(page), (r) => !sheetById(r, drillId), "the box drill sheet is gone by id", 15_000);
  });
});
