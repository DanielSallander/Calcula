/**
 * WRITEBACK > COLLECT FROM, LIVE -- the publisher chooses which streams (the
 * development line, each environment) the workbook's own regions collect from.
 *
 * OWNER DECISION (2026-10-22). One choice per application, held in the working
 * copy; the DEFAULT is the pipeline's LAST environment; Collected Responses,
 * the exports, scripts and the author's model tables all read it; the pane's
 * own picker is replaced by the same control as the Writeback tab's hero; a new
 * environment arrives unticked with a "not collected" note.
 *
 * WHAT THIS PROVES, in the running app:
 *   1. a pipeline test -> prod on the application, and answers sent from a
 *      subscriber in TEST (1, 2, 3) and one in PROD (10, 20, 30);
 *   2. the author's working copy collects PROD ONLY by default: the hero says
 *      so, Collected Responses lists 3 rows all in prod, and the author's
 *      model table (bi_list_writeback_tables) holds 3 rows;
 *   3. ticking TEST in the hero's menu keeps the menu OPEN, and the pane (one
 *      source of truth) and the model table follow to 6 rows; the workbook is
 *      dirty and the change is in the audit trail;
 *   4. the choice survives save + File > New + reopen;
 *   5. a NEW environment (staging) arrives unticked with "not collected", and
 *      the pane warns; "All streams" collects it.
 *
 * NEVER THE OWNER'S WORKSPACE. C:\writeback-test is COPIED to a temp folder
 * (its submissions and reviews dropped from the copy); every write -- the
 * pipeline, the promotions, the answers -- goes to the copy.
 *
 * ROUTES. The setup (pipeline, promotions, the two subscribers' answers) goes
 * through the backend commands the dialogs call; what is under test -- the
 * hero, its menu, the pane -- is CLICKED.
 */
import type { Locator, Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { activate, callModule, eventually, invoke, isDirty, newFile, openAt, sheets, COLLAB } from "../helpers/calp-harness";
import { checkout } from "../helpers/calp-collab";
import { closeTaskPanes } from "../helpers/object-pane";

const SOURCE_WS = "C:\\writeback-test";
const APP = "writeback-test";
const VERSION = "1.0.0";
/** The publisher's sheet id in the owner's signed manifest (checkout keeps it). */
const PUBLISHER_SHEET_ID = "01a15d70-b30a-7e15-800c-62a1c4efa4d7";

const WORK = path.join(os.tmpdir(), "calcula-collect-streams");
const WS = path.join(WORK, "workspace");
const FILE_AUTHOR = path.join(WORK, "author.cala");

interface StreamsView {
  linked: boolean;
  mode: "default" | "all" | "only";
  selection: string[] | null;
  collecting: string[] | null;
  notCollected: string[];
  summary: string;
  canChange: boolean;
  changeRefusal: string | null;
}

interface TableInfo {
  regionId: string;
  audience: string;
  rowCount: number;
  streams: string;
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function ribbonTab(page: Page, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator('[data-testid="ribbon"] button').filter({ hasText: new RegExp(`^${escaped}$`) });
}

const byTestId = (page: Page, id: string): Locator => page.locator(`[data-testid="${id}"]`);

async function streamsView(page: Page): Promise<StreamsView> {
  return invoke<StreamsView>(page, "calp_collection_streams", { request: { op: "get" } });
}

async function authorTable(page: Page, regionId: string): Promise<TableInfo | undefined> {
  const tables = await invoke<TableInfo[]>(page, "bi_list_writeback_tables", { connectionId: null });
  return tables.find((t) => t.regionId === regionId);
}

/** A blank model holding the author's writeback table, and a SUM measure over its answers. */
interface WritebackModel {
  connectionId: string;
  table: string;
}

const ANSWERED = "Answered";

/**
 * The route a model author takes (Model Editor > Import > Writeback data): a
 * blank model, the region imported as a table, a measure over `value_number`.
 */
async function writebackModel(page: Page, regionId: string): Promise<WritebackModel> {
  const conn = await invoke<{ id: string }>(page, "bi_model_create_blank", { name: `Collect streams ${Date.now()}`, connectionString: null });
  const connectionId = String(conn.id);
  const overview = await invoke<{ tables: Array<{ name: string; sourceId?: string | null }> }>(page, "bi_import_writeback_tables", {
    connectionId,
    regionIds: [regionId],
  });
  expect(overview.tables.length, `the import made no table: ${JSON.stringify(overview.tables)}`).toBe(1);
  const table = overview.tables[0].name;
  await invoke(page, "bi_model_upsert_measure", {
    connectionId,
    originalName: null,
    name: ANSWERED,
    // The table's MODEL name is a bare identifier (BUG-0585: the readable
    // "WB writeback-test Sheet1 (2)!B3:B5" could not be named in a measure).
    formula: `SUM(${table}[value_number])`,
    description: null,
    formatString: null,
    formatStringExpression: null,
    detailRows: null,
    group: null,
    hidden: null,
  });
  return { connectionId, table };
}

/**
 * THE BI QUERY API (`bi_query`, what a pivot, a CUBE formula and a script's
 * bi.query read): the sum of the answers per `environment`, read from the
 * model's own table -- not from the dataset listing beside it.
 */
async function answeredByStream(page: Page, m: WritebackModel): Promise<Record<string, number>> {
  const result = await invoke<{ columns: string[]; rows: Array<Array<string | null>> }>(page, "bi_query", {
    connectionId: m.connectionId,
    request: { measures: [ANSWERED], groupBy: [{ table: m.table, column: "environment" }], filters: [] },
    scriptId: null,
  });
  const streamAt = result.columns.findIndex((c) => /environment/i.test(c));
  const sumAt = result.columns.findIndex((c) => c.includes(ANSWERED));
  expect(streamAt >= 0 && sumAt >= 0, `unexpected bi_query columns ${JSON.stringify(result.columns)}`).toBe(true);
  const out: Record<string, number> = {};
  for (const row of result.rows) out[row[streamAt] ?? ""] = Number(row[sumAt]);
  return out;
}

let biModel: WritebackModel | null = null;

/** A stream -> sum map in a fixed key order (the query's row order is not part of the claim). */
function sortedJson(r: Record<string, number>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** A subscriber in `environment` sends `values` for B3:B5. */
async function answerIn(page: Page, environment: string, values: number[]): Promise<void> {
  await newFile(page);
  const pulled = await invoke<{ firstPulledSheetIndex?: number | null }>(page, "calp_pull", {
    params: { registryPath: WS, packageName: APP, versionPin: "", environment, followLine: false },
  });
  expect(pulled.firstPulledSheetIndex ?? null, `the ${environment} pull landed no sheet`).not.toBeNull();
  await invoke(page, "set_active_sheet", { index: pulled.firstPulledSheetIndex });
  const regions = await eventually(
    () => callModule<Array<{ regionId: string; sheetId: string }>>(page, COLLAB, "getWritebackRegions"),
    (l) => l.length === 1,
    `the ${environment} subscriber has no writeback region`,
    15_000,
  );
  const { regionId, sheetId } = regions[0];
  for (let i = 0; i < values.length; i++) {
    await invoke(page, "calp_save_writeback_draft", {
      regionId,
      sheetId,
      row: 2 + i,
      col: 1,
      value: { type: "number", value: values[i] },
    });
  }
  const sent = await invoke<number>(page, "calp_submit_region", { regionId });
  expect(sent, `the ${environment} subscriber sent nothing`).toBe(values.length);
}

/** Open the author's working copy on its sheet and the publisher Writeback tab on B3. */
async function openAuthorTab(page: Page, grid: { clickCell: (ref: string) => Promise<void> }): Promise<void> {
  const list = await sheets(page);
  const sheet = list.sheets.find((s) => s.sheetId === PUBLISHER_SHEET_ID);
  expect(sheet, `sheets: ${JSON.stringify(list.sheets)}`).toBeTruthy();
  await activate(page, sheet!.name);
  await grid.clickCell("B3");
  await expect.poll(() => ribbonTab(page, "Writeback").count(), { timeout: 8000 }).toBe(1);
  await ribbonTab(page, "Writeback").click();
  await byTestId(page, "writeback-tab-collect-from").waitFor({ state: "visible", timeout: 8000 });
}

let regionId = "";

test.describe.serial("Writeback > Collect From: the publisher chooses which streams are collected", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SOURCE_WS)) throw new Error(`the owner's workspace ${SOURCE_WS} is not on this machine`);
    if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true });
    copyDir(SOURCE_WS, WS);
    for (const sub of ["submissions", "reviews"]) {
      fs.rmSync(path.join(WS, APP, VERSION, sub), { recursive: true, force: true });
    }
    // The copy must not carry a pipeline: this journey defines its own.
    fs.rmSync(path.join(WS, APP, "promotions.json"), { force: true });
  });

  test.afterAll(() => {
    fs.rmSync(WORK, { recursive: true, force: true });
  });

  test("a pipeline test -> prod, and answers sent in test and in prod", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    await newFile(page);
    await invoke(page, "calp_set_environments", {
      params: { registryPath: WS, packageName: APP, environments: ["test", "prod"], expectedSequence: 0 },
    });
    for (const environment of ["test", "prod"]) {
      await invoke(page, "calp_promote", {
        params: { registryPath: WS, packageName: APP, environment, version: VERSION, checkCurrent: true, expectedCurrent: "" },
      });
    }
    await answerIn(page, "test", [1, 2, 3]);
    await answerIn(page, "prod", [10, 20, 30]);
    await newFile(page);
  });

  test("the author's working copy collects the LAST environment (prod) by default", async ({ appPage: page, grid }) => {
    test.setTimeout(300_000);
    await newFile(page);
    const r = await checkout(page, WS, APP);
    expect(r.version).toBe(VERSION);
    const own = await eventually(
      () => callModule<Array<{ id: string }>>(page, COLLAB, "getWritebackDraftRegions"),
      (l) => l.length === 1,
      "the working copy has no designated region",
      15_000,
    );
    regionId = own[0].id;

    const view = await streamsView(page);
    expect(view.linked).toBe(true);
    expect(view.mode).toBe("default");
    expect(view.collecting).toEqual(["prod"]);
    expect(view.canChange, view.changeRefusal ?? "").toBe(true);

    await openAuthorTab(page, grid);
    const hero = byTestId(page, "writeback-tab-collect-from");
    await expect(hero).toHaveAttribute("title", /Collecting from: prod \(the last environment\)\./);

    await byTestId(page, "writeback-tab-collected-responses").click();
    await byTestId(page, "publisher-dashboard").waitFor({ state: "visible", timeout: 10_000 });
    const rows = page.locator('[data-testid="publisher-dashboard-row"]');
    await expect(rows).toHaveCount(3, { timeout: 15_000 });
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-stream")))).toEqual(["prod", "prod", "prod"]);
    await expect(byTestId(page, "publisher-dashboard-streams")).toHaveText("from prod");
    await expect(byTestId(page, "publisher-dashboard-collect-from")).toBeVisible();
    expect(await byTestId(page, "publisher-dashboard-stream").count(), "the pane's own picker is gone").toBe(0);

    const table = await authorTable(page, regionId);
    expect(table, "the author's region is not a model table").toBeTruthy();
    expect(table!.audience).toBe("publisher");
    expect(table!.rowCount).toBe(3);
    expect(table!.streams).toBe("prod");

    // THE MODEL, QUERIED: a model built on the author's table answers with
    // prod's 10 + 20 + 30 and nothing from test's 1 + 2 + 3.
    biModel = await writebackModel(page, regionId);
    const byStream = await eventually(
      () => answeredByStream(page, biModel!),
      (r) => Object.keys(r).length > 0,
      "the model's writeback table answered no rows",
      20_000,
    );
    console.log(`[collect-streams] bi_query by environment, default: ${JSON.stringify(byStream)}`);
    expect(byStream).toEqual({ prod: 60 });
    // Saved, so the next step's "dirty" can only come from the Collect From
    // change (building the model dirtied the workbook too).
    await invoke(page, "save_file", { path: FILE_AUTHOR });
    expect(await isDirty(page), "saved").toBe(false);
  });

  test("ticking test in the tab's menu: the menu stays open, the pane and the model table follow", async ({ appPage: page, grid }) => {
    test.setTimeout(300_000);
    await openAuthorTab(page, grid);
    // The pane OPEN while the choice changes on the tab: it must follow.
    await byTestId(page, "writeback-tab-collected-responses").click();
    await byTestId(page, "publisher-dashboard").waitFor({ state: "visible", timeout: 10_000 });
    await expect(page.locator('[data-testid="publisher-dashboard-row"]')).toHaveCount(3, { timeout: 15_000 });
    expect(await isDirty(page), "precondition: clean before the choice changes").toBe(false);
    await byTestId(page, "writeback-tab-collect-from").click();
    const testRow = byTestId(page, "writeback-collect-stream-test");
    await testRow.waitFor({ state: "visible", timeout: 8000 });
    await expect(testRow).toHaveAttribute("aria-checked", "false");
    await expect(byTestId(page, "writeback-collect-stream-prod")).toHaveAttribute("aria-checked", "true");
    await testRow.click();
    // THE MENU STAYS OPEN, and the row follows the backend's answer.
    await expect(testRow).toBeVisible();
    await expect(testRow).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
    await page.keyboard.press("Escape");

    const view = await streamsView(page);
    expect(view.mode).toBe("only");
    expect(view.selection).toEqual(["prod", "test"]);

    // ONE SOURCE OF TRUTH: the pane (already open) re-reads.
    const rows = page.locator('[data-testid="publisher-dashboard-row"]');
    await expect(rows).toHaveCount(6, { timeout: 15_000 });
    const streams = (await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-stream")))).sort();
    expect(streams).toEqual(["prod", "prod", "prod", "test", "test", "test"]);
    await expect(byTestId(page, "publisher-dashboard-collect-from")).toHaveAttribute("title", /Collecting from: prod, test\./);

    await expect.poll(async () => (await authorTable(page, regionId))?.rowCount, { timeout: 15_000 }).toBe(6);
    expect(await isDirty(page), "the choice is saved with the workbook").toBe(true);
    // THE MODEL FOLLOWS: the same query now adds test's 1 + 2 + 3.
    expect(biModel, "the model step 2 built").toBeTruthy();
    await expect
      .poll(async () => sortedJson(await answeredByStream(page, biModel!)), { timeout: 20_000 })
      .toBe(sortedJson({ prod: 60, test: 6 }));
    console.log(`[collect-streams] bi_query by environment, prod + test: ${JSON.stringify(await answeredByStream(page, biModel!))}`);
    await invoke(page, "bi_delete_connection", { connectionId: biModel!.connectionId });
    biModel = null;
    const audit = await callModule<{ entries: Array<{ event: string; description: string }> }>(page, COLLAB, "getAuditLog");
    const row = audit.entries.find((e) => e.event === "collection_streams_changed");
    expect(row, "Collect From changed is not in the audit trail").toBeTruthy();
    expect(row!.description).toContain("prod, test");
  });

  test("the choice survives save, File > New and reopen", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    const closed = await closeTaskPanes(page);
    expect(closed.isOpen).toBe(false);
    await invoke(page, "save_file", { path: FILE_AUTHOR });
    await newFile(page);
    expect((await streamsView(page)).linked).toBe(false);
    await openAt(page, FILE_AUTHOR);
    const view = await streamsView(page);
    expect(view.selection).toEqual(["prod", "test"]);
    const inbox = await callModule<Array<{ environment: string }>>(page, COLLAB, "loadRegionSubmissions", [regionId]);
    expect(inbox.length).toBe(6);
  });

  test("a NEW environment arrives unticked and not collected; All streams collects it", async ({ appPage: page, grid }) => {
    test.setTimeout(300_000);
    // Sequence 3: the pipeline and two promotions.
    await invoke(page, "calp_set_environments", {
      params: { registryPath: WS, packageName: APP, environments: ["test", "staging", "prod"], expectedSequence: 3 },
    });
    await openAuthorTab(page, grid);
    await byTestId(page, "writeback-tab-collect-from").click();
    const staging = byTestId(page, "writeback-collect-stream-staging");
    await staging.waitFor({ state: "visible", timeout: 8000 });
    await expect(staging).toHaveAttribute("aria-checked", "false");
    await expect(staging).toContainText("not collected");

    await byTestId(page, "writeback-collect-all").click();
    await expect(byTestId(page, "writeback-collect-all")).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
    await expect(staging).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    const view = await streamsView(page);
    expect(view.mode).toBe("all");
    expect(view.notCollected).toEqual([]);

    const closed = await closeTaskPanes(page);
    expect(closed.isOpen, "no pane may leak into later specs").toBe(false);
    await newFile(page);
  });
});
