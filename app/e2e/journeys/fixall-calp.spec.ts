/**
 * FIX-ALL WAVE, LIVE: Collaboration (.calp) and sheet structure.
 *
 * Every LIVE CHECK the wave A-F agents wrote for their calp / sheets / backend
 * (B1-B4) / undo work, driven in the running app. Each test is named after the
 * item it proves and asserts BOTH directions: the fixed behaviour happens where
 * it should (a positive control, so a no-op cannot pass) and the old wrong
 * behaviour does not.
 *
 * ROUTES. The dialogs' own @api/collaboration calls followed by the same
 * announcements the dialogs make (helpers/calp-collab.ts), the tab strip's own
 * rename/delete/move events, the @api range facade for cell writes, the
 * extensions' own stores for objects. Reads come from the backend or the DOM.
 *
 * SELF-CLEANING. Every test ends in the app's own File > New (file-api, never a
 * raw new_file -- BUG-0205). Workspaces and files live under one temp folder
 * that is removed first. Application names carry a per-run suffix, so a TOFU pin
 * from an earlier run can never answer for this one.
 *
 * LOCALE. sv-SE: a formula argument list written through update paths uses ';'.
 */
import type { Locator, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import { startMcp } from "../helpers/calp-mcp";
import { samplePixelGrids } from "../viewportSample";
import {
  activate,
  addCanvas,
  addWorksheet,
  callModule,
  deleteSheetByName,
  emitApp,
  eventually,
  invoke,
  installAppImport,
  isDirty,
  moveSheetByName,
  newFile,
  openAt,
  pressUndo,
  readCell,
  readCells,
  renameSheetByName,
  saveAs,
  setCells,
  sheetIndex,
  sheetNames,
  sheets,
  tryInvoke,
  tryModule,
  undoState,
  COLLAB,
  type AppWindow,
} from "../helpers/calp-harness";
import {
  checkout,
  describeDiff,
  detachSheet,
  diffIsEmpty,
  overrides,
  publishNew,
  push,
  pushDiff,
  refreshApply,
  refreshPreview,
  subscribe,
  subscriberDiff,
  workingCopy,
} from "../helpers/calp-collab";

const RUN = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), "calcula-fixall-calp");
const WS = path.join(WORK, "workspace");
const file = (name: string) => path.join(WORK, `${name}.cala`);

const CHART_STORE = "/extensions/Charts/lib/chartStore.ts";
const CHART_RENDERER = "/extensions/Charts/rendering/chartRenderer.ts";
const PANE_STORE = "/extensions/ControlsPane/lib/controlsPaneStore.ts";
const PANE_SOURCE = "/extensions/ControlsPane/lib/dropdownCellRangeSource.ts";
const BUTTONS = "/src/api/buttonControlService.ts";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface RichApp {
  app: string;
  pubFile: string;
  paneName: string;
  chartId: string;
}

/** Rename the first sheet of a fresh workbook to "Data" and give it A1 = `a1`. */
async function ownData(page: Page, a1: string): Promise<void> {
  await renameSheetByName(page, "Sheet1", "Data");
  await setCells(page, await sheetIndex(page, "Data"), [["A1", a1]]);
}

/**
 * The publisher's application: Data (A1=21 .. A5, B1:B5) and Report with
 * A1 `=Data!A1*2`. With `rich`, Report also carries every object kind a
 * collision rename must reach: a chart over the string source "Data!A1:B5", a
 * workbook name `=Data!$A$1`, a conditional format `=A1>Data!$B$1`, one typed
 * without "=" and in another case (`A1 > data!$B$1`), a custom validation
 * `=COUNTIF(Data!A:A,A1)=1`, a button whose text formula is `=Data!A1`, and a
 * pane dropdown on `Data!A1:A5`.
 */
async function buildApp(page: Page, tag: string, rich = false): Promise<RichApp> {
  const app = `fixall-${tag}-${RUN}`;
  await newFile(page);
  await renameSheetByName(page, "Sheet1", "Data");
  const data = await sheetIndex(page, "Data");
  await setCells(page, data, [
    ["A1", "21"], ["A2", "22"], ["A3", "23"], ["A4", "24"], ["A5", "25"],
    ["B1", "5"], ["B2", "6"], ["B3", "7"], ["B4", "8"], ["B5", "9"],
  ]);
  const report = await addWorksheet(page);
  await renameSheetByName(page, report.name, "Report");
  const rep = await sheetIndex(page, "Report");
  await setCells(page, rep, [["A1", "=Data!A1*2"], ["A2", "base2"], ["A3", "base3"]]);
  let chartId = "";
  const paneName = `Pick${tag.replace(/[^A-Za-z0-9]/g, "")}${RUN}`;
  if (rich) {
    await activate(page, "Report");
    await invoke(page, "create_named_range", { name: `DataTop${RUN}`, sheetIndex: null, refersTo: "=Data!$A$1" });
    await addCf(page, "=A1>Data!$B$1", 0, 0);
    await addCf(page, "A1 > data!$B$1", 1, 0);
    await setDv(page, rep, 0, 1, { custom: { formula: "=COUNTIF(Data!A:A,A1)=1" } });
    const btn = await page.evaluate(
      async ({ mod, rep }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          requireButtonControlProvider: () => { createButton: (r: unknown) => Promise<{ row: number; col: number }> };
        };
        return m.requireButtonControlProvider().createButton({ sheetIndex: rep, row: 1, col: 3, label: "Go" });
      },
      { mod: BUTTONS, rep },
    );
    await invoke(page, "set_control_property", {
      sheetIndex: rep, row: btn.row, col: btn.col, controlType: "button",
      propertyName: "text", valueType: "formula", value: "=Data!A1",
    });
    const pane = await callModule<{ id: string } | null>(page, PANE_STORE, "createControlAsync", [
      { name: paneName, controlType: "dropdown", config: { type: "dropdown", source: { type: "cellRange", reference: "Data!A1:A5" }, placeholder: null }, order: null },
    ]);
    expect(pane, "precondition: the pane dropdown was created").toBeTruthy();
    chartId = await makeChart(page, rep, "Data!A1:B5", `Chart${tag}`);
  }
  const pubFile = file(`pub-${tag}`);
  const published = await publishNew(page, WS, app, "1.0.0");
  expect(published.version, `precondition: ${app} was published`).toBe("1.0.0");
  await saveAs(page, pubFile);
  return { app, pubFile, paneName, chartId };
}

function dv(rule: unknown): unknown {
  return {
    rule,
    errorAlert: { title: "", message: "", style: "stop", showAlert: true },
    prompt: { title: "", message: "", showPrompt: false },
    ignoreBlanks: true,
  };
}

/** An expression conditional format on the ACTIVE sheet (the CF dialog's own command). */
async function addCf(page: Page, formula: string, row: number, col: number): Promise<void> {
  const r = await callModule<{ success: boolean; error?: string | null }>(page, "/src/api/backend.ts", "addConditionalFormat", [
    {
      rule: { type: "expression", formula },
      format: { backgroundColor: "#FFC7CE" },
      ranges: [{ startRow: row, startCol: col, endRow: row, endCol: col }],
      stopIfTrue: false,
    },
  ]);
  expect(r.success, `precondition: conditional format ${formula} was refused: ${r.error ?? ""}`).toBe(true);
}

/**
 * A LIST rule sourced from a range, built and written exactly as the Data
 * Validation dialog does (createListRuleFromRange -> @api setDataValidation).
 * Until 2026-09-29 this wrote the backend's snake_case wire shape by hand,
 * because the dialog's own camelCase route was refused (DV-WIRE; fixed:
 * `ListSource` now renames its variant fields, pinned by
 * serde_enum_field_case_tests.rs).
 */
async function setListDv(page: Page, sheetIdx: number, row: number, col: number, srcSheet: number, r0: number, c0: number, r1: number, c1: number): Promise<void> {
  const rule = await callModule<unknown>(page, "/src/core/types/types.ts", "createListRuleFromRange", [r0, c0, r1, c1, srcSheet, true]);
  await setDv(page, sheetIdx, row, col, rule);
}

/** A validation rule through the app's own setDataValidation (the DV dialog's route). */
async function setDv(page: Page, sheetIdx: number, row: number, col: number, rule: unknown, endRow = row): Promise<void> {
  const r = await tryModule(page, "/src/api/lib.ts", "setDataValidation", [row, col, endRow, col, dv(rule), sheetIdx]);
  expect(r.ok, `precondition: setDataValidation threw: ${r.error}`).toBe(true);
  const res = r.value as { success: boolean; error?: string | null };
  expect(res.success, `precondition: validation ${JSON.stringify(rule)} was refused: ${res.error ?? ""}`).toBe(true);
}

/** A bar chart on `sheetIdx` through the chart store (the app's own create). */
async function makeChart(page: Page, sheetIdx: number, data: unknown, name: string): Promise<string> {
  await installAppImport(page);
  const id = await page.evaluate(
    async ({ mod, spec, placement }) => {
      const store = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        createChart: (s: unknown, p: Record<string, unknown>) => { chartId: string };
        syncChartRegions: () => void;
      };
      const created = store.createChart(spec, placement);
      store.syncChartRegions();
      return created.chartId;
    },
    {
      mod: CHART_STORE,
      spec: {
        mark: "bar",
        data,
        hasHeaders: false,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "B", color: "#4472C4" }],
        title: name,
      },
      placement: { sheetIndex: sheetIdx, x: 400, y: 120, width: 320, height: 200, name },
    },
  );
  // The chart save is debounced: wait until the backend holds it.
  await eventually(() => invoke<Array<{ id: string }>>(page, "get_charts"), (c) => c.some((x) => x.id === id), "the chart never reached the backend");
  await page.waitForTimeout(900);
  return id;
}

async function chartSpec(page: Page, chartId: string): Promise<{ sheetIndex: number; spec: { data?: unknown } } | null> {
  const charts = await invoke<Array<{ id: string; sheetIndex: number; specJson: string }>>(page, "get_charts");
  const c = charts.find((x) => x.id === chartId);
  if (!c) return null;
  const def = JSON.parse(c.specJson) as { spec?: { data?: unknown } };
  return { sheetIndex: c.sheetIndex, spec: def.spec ?? {} };
}

async function chartValues(page: Page, chartId: string): Promise<number[] | null> {
  await installAppImport(page);
  return page.evaluate(
    async ({ id, mod }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        getCachedChartData: (id: string) => { data?: { series?: Array<{ values: number[] }> } } | null;
      };
      return m.getCachedChartData(id)?.data?.series?.[0]?.values ?? null;
    },
    { id: chartId, mod: CHART_RENDERER },
  );
}

async function cfFormulas(page: Page, sheetIdx: number): Promise<string[]> {
  const rules = await invoke<Array<{ rule: { type: string; formula?: string } }>>(page, "get_all_conditional_formats", { sheetIndex: sheetIdx });
  return rules.map((r) => r.rule.formula ?? "");
}

async function dvRules(page: Page, sheetIdx: number): Promise<Array<{ startRow: number; startCol: number; validation: { rule: Record<string, unknown> } }>> {
  return invoke(page, "get_all_data_validations", { sheetIndex: sheetIdx });
}

async function paneSource(page: Page, name: string): Promise<string | null> {
  const all = await invoke<Array<{ name: string; config: { type: string; source?: { type: string; reference?: string } } }>>(page, "get_all_pane_controls");
  const c = all.find((x) => x.name === name);
  return c?.config.source?.reference ?? null;
}

async function namedRange(page: Page, name: string): Promise<{ refersTo: string; sheetIndex: number | null } | null> {
  const all = await invoke<Array<{ name: string; refersTo: string; sheetIndex: number | null }>>(page, "get_all_named_ranges");
  return all.find((n) => n.name.toLowerCase() === name.toLowerCase()) ?? null;
}

async function buttonTextFormula(page: Page, sheetIdx: number): Promise<{ formula: string; resolved: string } | null> {
  const all = await invoke<Array<{ row: number; col: number; controlType?: string; metadata?: { properties: Record<string, { valueType: string; value: string }> } }>>(
    page,
    "get_all_controls",
    { sheetIndex: sheetIdx },
  );
  for (const c of all) {
    const meta = await invoke<{ controlType: string; properties: Record<string, { valueType: string; value: string }> } | null>(page, "get_control_metadata", {
      sheetIndex: sheetIdx, row: c.row, col: c.col,
    });
    const text = meta?.properties?.text;
    if (meta?.controlType === "button" && text?.valueType === "formula") {
      const resolved = await invoke<Record<string, string>>(page, "resolve_control_properties", { sheetIndex: sheetIdx, row: c.row, col: c.col });
      return { formula: text.value, resolved: resolved.text ?? "" };
    }
  }
  return null;
}

/** The formula bar text for a cell, selected the way the user selects it. */
async function formulaBarFor(page: Page, grid: { clickCell: (r: string) => Promise<void>; formulaBar: { inputValue: () => Promise<string> } }, sheet: string, ref: string): Promise<string> {
  await activate(page, sheet);
  await grid.clickCell(ref);
  await page.waitForTimeout(300);
  return grid.formulaBar.inputValue();
}

/** Published artifacts of a version whose logical path matches, read from the workspace's blob store. */
function publishedArtifacts(app: string, version: string, match: RegExp): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(WS, app, version, "version-manifest.json"), "utf8")) as {
      artifactChecksums?: Record<string, string>;
    };
    const out: Record<string, unknown> = {};
    for (const [logical, sum] of Object.entries(manifest.artifactChecksums ?? {})) {
      if (!match.test(logical)) continue;
      const hex = sum.replace(/^sha256:/, "");
      const blob = path.join(WS, ".blobs", hex.slice(0, 2), hex);
      out[logical] = fs.existsSync(blob) ? fs.readFileSync(blob, "utf8").slice(0, 1500) : `(no blob at ${blob})`;
    }
    return JSON.stringify(out);
  } catch (e) {
    return `(could not read: ${String(e)})`;
  }
}

// ===========================================================================
// COLLABORATION
// ===========================================================================

test.describe("fix-all live: collaboration (.calp)", () => {
  test.beforeAll(() => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WS, { recursive: true });
  });

  test("C6 BUG-0134: the Application Inspector refuses a missing workspace and creates no folder", async ({ appPage: page }) => {
    test.setTimeout(180_000);
    const missing = path.join("C:\\Temp", `no-such-ws-${RUN}`);
    expect(fs.existsSync(missing), "precondition: the folder does not exist").toBe(false);
    // A real workspace for the positive control.
    const { app } = await buildApp(page, "c6");
    const context = page.context();
    const before = new Set(context.pages());
    try {
      await page.locator("button").filter({ hasText: /^Collaboration$/ }).first().click();
      await page.getByText("Application Inspector...", { exact: true }).first().click();
      const inspector = await eventually(
        async () => context.pages().find((p) => !before.has(p) || /packageInspector/.test(p.url())) ?? null,
        (p) => !!p && /packageInspector/.test(p.url()),
        "the Application Inspector window never appeared",
        30_000,
      );
      const box = inspector!.locator('input[placeholder^="Workspace, application"]');
      await box.waitFor({ state: "visible", timeout: 30_000 });

      await box.fill(missing);
      await box.press("Enter");
      await eventually(
        () => inspector!.evaluate(() => document.body.innerText),
        (t) => /does not exist/i.test(t),
        "the inspector did not say the workspace does not exist",
        20_000,
      );
      expect(fs.existsSync(missing), "a READ of a missing workspace created the folder on disk").toBe(false);

      // POSITIVE CONTROL: the same field lists a real workspace's applications.
      await box.fill(WS);
      await box.press("Enter");
      await eventually(
        () => inspector!.evaluate(() => Array.from(document.querySelectorAll("option")).map((o) => o.textContent ?? "")),
        (opts) => opts.some((o) => o.includes(app)),
        "the inspector did not list the real workspace's application",
        20_000,
      );
      await inspector!.evaluate(async () => {
        const w = window as unknown as AppWindow;
        await w.__TAURI__.window?.getCurrentWindow().close();
      }).catch(() => undefined);
    } finally {
      fs.rmSync(missing, { recursive: true, force: true });
      await newFile(page);
    }
  });

  test("C1 BUG-0151 + B4: a subscribe that renames the pulled Data to 'Data (2)' carries every reference with it", async ({ appPage: page, grid }) => {
    test.setTimeout(300_000);
    try {
      const { app, paneName, chartId } = await buildApp(page, "c1sub", true);
      await newFile(page);
      await ownData(page, "1000");
      await subscribe(page, WS, app);

      const names = await sheetNames(page);
      expect(names, "the subscriber's own Data stays, the pulled one is renamed").toEqual(expect.arrayContaining(["Data", "Data (2)", "Report"]));
      const rep = await sheetIndex(page, "Report");
      const a1 = await readCell(page, rep, "A1");
      expect(a1.display, "Report!A1 reads the PULLED Data (21*2), not the subscriber's own (1000*2)").toBe("42");
      expect(a1.formula).toBe("='Data (2)'!A1*2");
      expect(await formulaBarFor(page, grid, "Report", "A1"), "the formula bar shows the renamed reference").toBe("='Data (2)'!A1*2");

      // Every object kind follows the rename -- and none reads the subscriber's own Data.
      const cfs = await cfFormulas(page, rep);
      expect(cfs, `conditional formats: ${JSON.stringify(cfs)}`).toContain("=A1>'Data (2)'!$B$1");
      expect(cfs.some((f) => /'Data \(2\)'!\$B\$1/.test(f) && !/=/.test(f.charAt(0))), `the '='-less rule follows too: ${JSON.stringify(cfs)}`).toBe(true);
      expect(cfs.filter((f) => /(^|[^'(])\bdata!/i.test(f)), "no conditional format still names the bare Data").toEqual([]);
      const dvs = await dvRules(page, rep);
      const custom = dvs.map((d) => (d.validation.rule.custom as { formula?: string } | undefined)?.formula ?? "").filter(Boolean);
      expect(custom, "the custom validation follows").toEqual(["=COUNTIF('Data (2)'!A:A,A1)=1"]);
      const btn = await buttonTextFormula(page, rep);
      expect(btn?.formula, "the button's text formula follows").toBe("='Data (2)'!A1");
      expect(btn?.resolved, "the button shows the PULLED Data!A1").toBe("21");
      expect(await paneSource(page, paneName), "the pane dropdown follows").toBe("'Data (2)'!A1:A5");
      const items = await callModule<string[]>(page, PANE_SOURCE, "loadCellRangeItems", [(await paneSource(page, paneName))!]);
      expect(items, "the dropdown lists the pulled Data's cells").toEqual(["21", "22", "23", "24", "25"]);
      const pulledChart = (await invoke<Array<{ id: string; specJson: string }>>(page, "get_charts")).find((c) => c.id === chartId || JSON.parse(c.specJson).spec?.title === "Chartc1sub");
      expect(pulledChart, "the chart arrived").toBeTruthy();
      expect(JSON.parse(pulledChart!.specJson).spec.data, "the chart's string source follows").toBe("'Data (2)'!A1:B5");
      const nr = await namedRange(page, `DataTop${RUN}`);
      expect(nr?.refersTo, "the workbook name follows").toBe("='Data (2)'!$A$1");
    } finally {
      await newFile(page);
    }
  });

  test("C1 BUG-0151 + R2 + B4: a checkout into a workbook with its own Data reads the application's Data, the push preview shows no differences, and the push ships the published spelling", async ({ appPage: page }) => {
    test.setTimeout(360_000);
    try {
      const { app } = await buildApp(page, "c1co", true);
      await newFile(page);
      await ownData(page, "1000");
      await checkout(page, WS, app);
      expect(await sheetNames(page)).toEqual(expect.arrayContaining(["Data", "Data (2)", "Report"]));
      const rep = await sheetIndex(page, "Report");
      expect((await readCell(page, rep, "A1")).display, "the working copy computes from the APPLICATION's Data").toBe("42");

      // The push preview: nothing changed, so nothing is listed -- no cell, chart,
      // name, conditional-format, validation, control or pane-control row.
      const d = await pushDiff(page, WS, app);
      // One assertion per object domain, so a row in one domain cannot hide the others.
      expect.soft(d.totals.cellsChanged, `R2: a cell row: ${describeDiff(d)}`).toBe(0);
      for (const domain of ["chart", "namedRange", "conditionalFormat", "dataValidation", "control", "paneControl"]) {
        expect
          .soft(d.objects.filter((o) => o.domain === domain).map((o) => `${o.name}/${o.change}`), `R2/B4: a ${domain} row in the push preview of an untouched working copy`)
          .toEqual([]);
      }
      if (!diffIsEmpty(d)) {
        console.log(`[C1-checkout] push preview: ${describeDiff(d)}`);
        console.log(`[C1-checkout] published controls: ${publishedArtifacts(app, "1.0.0", /control/i)}`);
        const local = await invoke<Array<{ row: number; col: number; metadata: unknown }>>(page, "get_all_controls", { sheetIndex: rep });
        console.log(`[C1-checkout] working-copy controls: ${JSON.stringify(local).slice(0, 1500)}`);
      }
      expect.soft(diffIsEmpty(d), `the untouched working copy's push preview lists changes: ${describeDiff(d)}`).toBe(true);

      // ...and the real dialog says so.
      await page.locator("button").filter({ hasText: /^Collaboration$/ }).first().click();
      await page.getByText("Publish Application...", { exact: true }).first().click();
      await expect.soft(page.getByText(/No differences between/).first(), "the push dialog does not say 'No differences'").toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);

      // POSITIVE CONTROL: a real edit IS listed.
      await setCells(page, rep, [["A3", "edited"]]);
      const edited = await pushDiff(page, WS, app);
      expect(diffIsEmpty(edited), "a real edit must show in the push preview").toBe(false);
      await setCells(page, rep, [["A3", "base3"]]);
      expect(diffIsEmpty(await pushDiff(page, WS, app)), "putting the value back empties the preview again").toBe(true);

      // Push, then a FRESH subscriber reads the published spelling.
      const pushed = await push(page, WS, app, "1.1.0");
      expect(pushed.version).toBe("1.1.0");
      await newFile(page);
      await subscribe(page, WS, app);
      const fresh = await sheetIndex(page, "Report");
      const a1 = await readCell(page, fresh, "A1");
      expect(a1.formula, "the push shipped the working copy's rename instead of the published name").toBe("=Data!A1*2");
      expect(a1.display).toBe("42");
      const cfs = await cfFormulas(page, fresh);
      expect(cfs.some((f) => /Data \(2\)/.test(f)), `a pushed conditional format names the working copy's rename: ${JSON.stringify(cfs)}`).toBe(false);
    } finally {
      await newFile(page);
    }
  });

  test("R1: a held-back cell is published as the application's own formula, and the working copy keeps the edit", async ({ appPage: page }) => {
    test.setTimeout(360_000);
    try {
      const { app } = await buildApp(page, "r1");
      await newFile(page);
      await ownData(page, "1000");
      await checkout(page, WS, app);
      const rep = await sheetIndex(page, "Report");
      const repId = (await sheets(page)).sheets.find((s) => s.index === rep)!.sheetId!;
      await setCells(page, rep, [["A1", "='Data (2)'!A1*3"], ["A2", "shipped"]]);
      expect((await readCell(page, rep, "A1")).display).toBe("63");
      const before = await pushDiff(page, WS, app);
      expect(before.sheets.find((s) => s.name === "Report")?.cellsModified ?? 0, `precondition: the edits are in the push preview: ${describeDiff(before)}`).toBeGreaterThanOrEqual(2);

      await push(page, WS, app, "1.1.0", [{ sheetId: repId, row: 0, col: 0 }]);

      // The working copy keeps the held-back edit.
      const kept = await readCell(page, rep, "A1");
      expect(kept.formula, "the hold-back was not put back in the working copy").toBe("='Data (2)'!A1*3");
      expect(kept.display).toBe("63");
      const wcFile = file("wc-r1");
      await saveAs(page, wcFile);

      // A fresh subscriber gets the BASE formula for A1 and the ticked edit for A2.
      await newFile(page);
      await subscribe(page, WS, app);
      const fresh = await sheetIndex(page, "Report");
      const [f1, f2] = await readCells(page, fresh, ["A1", "A2"]);
      expect(f1.formula, "the held-back cell was published with the working copy's rename or its edit").toBe("=Data!A1*2");
      expect(f1.display).toBe("42");
      expect(f2.display, "POSITIVE CONTROL: the ticked edit was published").toBe("shipped");
    } finally {
      await newFile(page);
    }
  });

  test("C1 BUG-0151: a refresh after the publisher's v2 recomputes from the renamed pulled sheet with no conflicts", async ({ appPage: page }) => {
    test.setTimeout(360_000);
    try {
      const { app, pubFile } = await buildApp(page, "c1rf");
      // Subscriber with its own Data.
      await newFile(page);
      await ownData(page, "1000");
      await subscribe(page, WS, app);
      const subFile = file("sub-c1rf");
      expect((await readCell(page, await sheetIndex(page, "Report"), "A1")).display).toBe("42");
      await saveAs(page, subFile);

      // The publisher pushes v1.1.0 with =Data!A1*3.
      await openAt(page, pubFile);
      await setCells(page, await sheetIndex(page, "Report"), [["A1", "=Data!A1*3"]]);
      await push(page, WS, app, "1.1.0");

      await openAt(page, subFile);
      const preview = await refreshPreview(page);
      const row = preview.subscriptionPreviews.find((p) => p.packageName === app);
      expect(row, "POSITIVE CONTROL: the refresh preview offers v1.1.0").toBeTruthy();
      expect(row!.newVersion).toBe("1.1.0");
      expect(row!.conflicts, "the refresh preview lists conflicts for untouched cells").toEqual([]);
      expect(preview.totalOverridesConflicted).toBe(0);
      await refreshApply(page, preview);
      const a1 = await readCell(page, await sheetIndex(page, "Report"), "A1");
      expect(a1.formula).toBe("='Data (2)'!A1*3");
      expect(a1.display, "the refresh computed from the subscriber's own Data (3000) or did not land").toBe("63");
    } finally {
      await newFile(page);
    }
  });

  test("R3: a refresh after the subscriber deleted the pulled 'Data (2)' reads #REF!, never the subscriber's own Data", async ({ appPage: page }) => {
    test.setTimeout(360_000);
    try {
      const { app, pubFile } = await buildApp(page, "r3");
      await newFile(page);
      await ownData(page, "1000");
      await subscribe(page, WS, app);
      await detachSheet(page, await sheetIndex(page, "Data (2)"));
      await deleteSheetByName(page, "Data (2)");
      const subFile = file("sub-r3");
      await saveAs(page, subFile);

      await openAt(page, pubFile);
      await setCells(page, await sheetIndex(page, "Report"), [["A1", "=Data!A1*3"]]);
      await push(page, WS, app, "1.1.0");

      await openAt(page, subFile);
      const preview = await refreshPreview(page);
      expect(preview.subscriptionPreviews.find((p) => p.packageName === app)?.newVersion, "POSITIVE CONTROL: v1.1.0 is offered").toBe("1.1.0");
      await refreshApply(page, preview);
      const a1 = await readCell(page, await sheetIndex(page, "Report"), "A1");
      expect(a1.formula ?? "", "POSITIVE CONTROL: the refresh landed (the formula is v1.1.0's *3)").toMatch(/\*3$/);
      expect(a1.display, "the refreshed formula reads the subscriber's own Data").not.toBe("3000");
      expect(a1.display).toBe("#REF!");
    } finally {
      await newFile(page);
    }
  });

  test("R4: after detaching 'Data (2)', View changes lists no Report!A1 row", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    try {
      const { app } = await buildApp(page, "r4");
      await newFile(page);
      await ownData(page, "1000");
      await subscribe(page, WS, app);
      await detachSheet(page, await sheetIndex(page, "Data (2)"));
      const d = await subscriberDiff(page, app);
      const rows = d.sheets.flatMap((s) => s.sample.map((c) => `${s.name}!${c.a1}`));
      expect(rows, `View changes lists a change nobody made: ${describeDiff(d)}`).not.toContain("Report!A1");
      expect(d.totals.cellsChanged, describeDiff(d)).toBe(0);

      // POSITIVE CONTROL: a real local edit IS listed.
      await setCells(page, await sheetIndex(page, "Report"), [["B5", "local"]]);
      const d2 = await subscriberDiff(page, app);
      expect(d2.sheets.flatMap((s) => s.sample.map((c) => `${s.name}!${c.a1}`)), describeDiff(d2)).toContain("Report!B5");
    } finally {
      await newFile(page);
    }
  });

  test("B1: renaming a pulled tab carries an override that names it, and the next refresh is not a false conflict", async ({ appPage: page }) => {
    test.setTimeout(360_000);
    try {
      const { app, pubFile } = await buildApp(page, "b1");
      await newFile(page);
      await subscribe(page, WS, app);
      expect(await sheetNames(page), "no collision: the pulled tab keeps its name").toEqual(expect.arrayContaining(["Data", "Report"]));
      // Override the pulled formula with one that also names the pulled tab --
      // typed on the Report sheet, the user's own route (an edit of the ACTIVE
      // sheet is what records an override).
      const rep = await activate(page, "Report");
      await setCells(page, rep, [["A1", "=Data!A1*10"]]);
      const ov = await eventually(() => overrides(page), (o) => o.some((x) => x.position[0] === 0 && x.position[1] === 0), "the edit was not recorded as an override");
      expect(JSON.stringify(ov.find((x) => x.position[0] === 0 && x.position[1] === 0)!.current)).toMatch(/Data!A1\*10/);

      await renameSheetByName(page, "Data", "Facts");
      const cell = await readCell(page, rep, "A1");
      expect(cell.formula).toBe("=Facts!A1*10");
      const after = (await overrides(page)).find((x) => x.position[0] === 0 && x.position[1] === 0)!;
      expect(after.current.formula ?? after.current.display ?? "", "the override record kept the old tab name").toMatch(/Facts!A1\*10/);
      const subFile = file("sub-b1");
      await saveAs(page, subFile);

      // The publisher pushes a version that leaves Report!A1 alone.
      await openAt(page, pubFile);
      await setCells(page, await sheetIndex(page, "Data"), [["A5", "99"]]);
      await push(page, WS, app, "1.1.0");

      await openAt(page, subFile);
      const preview = await refreshPreview(page);
      const row = preview.subscriptionPreviews.find((p) => p.packageName === app);
      expect(row?.newVersion, "POSITIVE CONTROL: v1.1.0 is offered").toBe("1.1.0");
      expect(row!.conflicts, "the renamed tab turned the untouched override into a false conflict").toEqual([]);
      await refreshApply(page, preview);
      const rep2 = await sheetIndex(page, "Report");
      expect((await readCell(page, rep2, "A1")).formula, "the override survives the refresh").toBe("=Facts!A1*10");
      expect((await readCell(page, await sheetIndex(page, "Facts"), "A5")).display, "POSITIVE CONTROL: the upstream change landed").toBe("99");
      expect((await overrides(page)).some((o) => o.conflict), "an override was flagged as conflicted").toBe(false);
    } finally {
      await newFile(page);
    }
  });

  test("R5: a sheet named Rock'!Roll is collision-renamed inside a chart source by its real prefix, and the chart renders", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    const odd = "Rock'!Roll";
    try {
      const app = `fixall-r5-${RUN}`;
      await newFile(page);
      await renameSheetByName(page, "Sheet1", odd);
      await setCells(page, await sheetIndex(page, odd), [["A1", "x"], ["A2", "y"], ["A3", "z"], ["B1", "3"], ["B2", "5"], ["B3", "7"]]);
      const plain = await addWorksheet(page);
      await renameSheetByName(page, plain.name, "Plain Data");
      await setCells(page, await sheetIndex(page, "Plain Data"), [["A1", "p"], ["A2", "q"], ["B1", "2"], ["B2", "4"]]);
      const rep = await addWorksheet(page);
      await activate(page, rep.name);
      const chartId = await makeChart(page, rep.index, "'Rock''!Roll'!A1:B3", "RockChart");
      // CONTROL chart: a quoted name WITHOUT an escaped quote, same sheet.
      const controlId = await makeChart(page, rep.index, "'Plain Data'!A1:B2", "PlainChart");
      await eventually(() => chartValues(page, controlId), (v) => JSON.stringify(v) === "[2,4]", "precondition: the control chart does not render on the publisher", 20_000);
      const publisherRock = await eventually(() => chartValues(page, chartId), () => true, "read", 3000).catch(() => null);
      console.log(`[R5] on the PUBLISHER, the 'Rock''!Roll' chart plots: ${JSON.stringify(publisherRock)}`);
      await publishNew(page, WS, app, "1.0.0");

      await newFile(page);
      await renameSheetByName(page, "Sheet1", odd);
      await setCells(page, await sheetIndex(page, odd), [["B1", "100"], ["B2", "200"], ["B3", "300"]]);
      await subscribe(page, WS, app);
      expect(await sheetNames(page)).toEqual(expect.arrayContaining([odd, `${odd} (2)`]));
      const pulled = (await invoke<Array<{ id: string; sheetIndex: number; specJson: string }>>(page, "get_charts")).find(
        (c) => JSON.parse(c.specJson).spec?.title === "RockChart",
      );
      expect(pulled, "the chart arrived").toBeTruthy();
      expect(JSON.parse(pulled!.specJson).spec.data, "the chart source was corrupted or not renamed").toBe("'Rock''!Roll (2)'!A1:B3");
      await page.locator(`button[data-sheet-tab="${pulled!.sheetIndex}"]`).click();
      const pulledControl = (await invoke<Array<{ id: string; specJson: string }>>(page, "get_charts")).find((c) => JSON.parse(c.specJson).spec?.title === "PlainChart")!;
      await eventually(() => chartValues(page, pulledControl.id), (v) => JSON.stringify(v) === "[2,4]", "CONTROL: the pulled plain chart does not render either (harness)", 20_000);
      await eventually(() => chartValues(page, pulled!.id), (v) => JSON.stringify(v) === "[3,5,7]", "the pulled chart does not plot the PULLED sheet's values", 20_000);
    } finally {
      await newFile(page);
    }
  });

  test("C5 BUG-0154 + R6: a dev subscribe resolves the Sheet1 collision, Calc reads 'Sheet1 (2)', dev refresh keeps the tabs, and a second dev subscribe is refused without dirtying", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    try {
      const src = file("dev-source");
      await newFile(page);
      await setCells(page, 0, [["A1", "5"]]);
      const calc = await addWorksheet(page);
      await renameSheetByName(page, calc.name, "Calc");
      await setCells(page, await sheetIndex(page, "Calc"), [["A1", "=Sheet1!A1*2"]]);
      await saveAs(page, src);

      await newFile(page);
      await setCells(page, 0, [["A1", "7"]]);
      await callModule(page, COLLAB, "devSubscribe", [{ sourcePath: src, sheetNames: [] }]);
      await page.waitForTimeout(600);
      const names = await sheetNames(page);
      expect(names, "a dev pull created two sheets with one name").toEqual(["Sheet1", "Sheet1 (2)", "Calc"]);
      const calcRead = await readCell(page, await sheetIndex(page, "Calc"), "A1");
      expect(calcRead.formula).toBe("='Sheet1 (2)'!A1*2");
      expect(calcRead.display, "Calc reads the subscriber's own Sheet1 (7*2) instead of the source's").toBe("10");

      await callModule(page, COLLAB, "devRefresh");
      await page.waitForTimeout(600);
      expect(await sheetNames(page), "dev refresh changed the tabs").toEqual(["Sheet1", "Sheet1 (2)", "Calc"]);

      // R6: save (clean), then a second dev subscribe to the same source.
      const target = file("dev-subscriber");
      await saveAs(page, target);
      expect(await isDirty(page), "precondition: the saved workbook is clean").toBe(false);
      const second = await tryModule(page, COLLAB, "devSubscribe", [{ sourcePath: src, sheetNames: [] }]);
      expect(second.ok, "a second dev subscribe of the same source succeeded").toBe(false);
      expect(second.error).toContain("CALP_DEV_SHEET_ALREADY_HERE");
      expect(await sheetNames(page), "the refused dev subscribe changed the tabs").toEqual(["Sheet1", "Sheet1 (2)", "Calc"]);
      expect(await isDirty(page), "the refused dev subscribe dirtied the document").toBe(false);
    } finally {
      await newFile(page);
    }
  });

  test("W11 (validation): a pulled list validation lists the PULLED Lists sheet in a workbook that already has two sheets, before and after a refresh", async ({ appPage: page }) => {
    test.setTimeout(360_000);
    try {
      const app = `fixall-w11v-${RUN}`;
      await newFile(page);
      await renameSheetByName(page, "Sheet1", "Report");
      const lists = await addWorksheet(page);
      await renameSheetByName(page, lists.name, "Lists");
      const li = await sheetIndex(page, "Lists");
      await setCells(page, li, [["A1", "Red"], ["A2", "Green"], ["A3", "Blue"]]);
      await setListDv(page, await sheetIndex(page, "Report"), 0, 0, li, 0, 0, 2, 0);
      await publishNew(page, WS, app, "1.0.0");
      const pubFile = file("pub-w11v");
      await saveAs(page, pubFile);

      await newFile(page);
      const s2 = await addWorksheet(page);
      await setCells(page, s2.index, [["A1", "wrong1"], ["A2", "wrong2"], ["A3", "wrong3"]]);
      await subscribe(page, WS, app);
      await activate(page, "Report");
      const listed = await invoke<string[] | null>(page, "get_validation_list_values", { row: 0, col: 0 });
      expect(listed, "the pulled dropdown lists a local sheet by the publisher's index").toEqual(["Red", "Green", "Blue"]);
      const subFile = file("sub-w11v");
      await saveAs(page, subFile);

      await openAt(page, pubFile);
      await setCells(page, await sheetIndex(page, "Lists"), [["A1", "Cyan"]]);
      await push(page, WS, app, "1.1.0");
      await openAt(page, subFile);
      const preview = await refreshPreview(page);
      expect(preview.subscriptionPreviews.find((p) => p.packageName === app)?.newVersion).toBe("1.1.0");
      await refreshApply(page, preview);
      await activate(page, "Report");
      const after = await invoke<string[] | null>(page, "get_validation_list_values", { row: 0, col: 0 });
      expect(after, "after the refresh the dropdown does not list the pulled (updated) Lists").toEqual(["Cyan", "Green", "Blue"]);
    } finally {
      await newFile(page);
    }
  });

  test("W11 (overrides): deleting a local sheet an override names turns it #REF!, a 3D endpoint shrinks, and the next refresh keeps both with no conflict", async ({ appPage: page }) => {
    test.setTimeout(360_000);
    try {
      const { app, pubFile } = await buildApp(page, "w11o");
      await newFile(page);
      const mid = await addWorksheet(page);
      await renameSheetByName(page, mid.name, "Mid");
      const x = await addWorksheet(page);
      await renameSheetByName(page, x.name, "X");
      await setCells(page, await sheetIndex(page, "Mid"), [["B1", "4"]]);
      await setCells(page, await sheetIndex(page, "X"), [["A1", "11"], ["B1", "6"]]);
      await subscribe(page, WS, app);
      const rep = await activate(page, "Report");
      await setCells(page, rep, [["A2", "=X!A1"], ["A3", "=SUM(Mid:X!B1)"]]);
      await eventually(() => overrides(page), (o) => o.length >= 2, "precondition: the two edits were not recorded as overrides");
      expect((await readCells(page, rep, ["A2", "A3"])).map((c) => c.display), "precondition").toEqual(["11", "10"]);

      await deleteSheetByName(page, "X");
      const rep2 = await sheetIndex(page, "Report");
      const [a2, a3] = await readCells(page, rep2, ["A2", "A3"]);
      expect(a2.display).toBe("#REF!");
      expect(a3.formula, "the 3D endpoint did not shrink to Mid").toBe("=SUM(Mid:Mid!B1)");
      expect(a3.display).toBe("4");
      const ov = await overrides(page);
      const o2 = ov.find((o) => o.position[0] === 1 && o.position[1] === 0);
      const o3 = ov.find((o) => o.position[0] === 2 && o.position[1] === 0);
      expect(JSON.stringify(o2?.current), "the override record still names the deleted sheet").toContain("#REF!");
      // Sheet names are case-insensitive; the record's own spelling is logged
      // (the lexer's upper-casing of a bare start sheet surfaces here, see the
      // 3D-endpoint test, which pins the spelling a user sees).
      console.log(`[W11o] override records: A2=${JSON.stringify(o2?.current)} A3=${JSON.stringify(o3?.current)}`);
      expect(JSON.stringify(o3?.current), "the override record did not shrink to Mid:Mid").toMatch(/SUM\(Mid:Mid!B1\)/i);
      const subFile = file("sub-w11o");
      await saveAs(page, subFile);

      await openAt(page, pubFile);
      await setCells(page, await sheetIndex(page, "Data"), [["A5", "77"]]);
      await push(page, WS, app, "1.1.0");
      await openAt(page, subFile);
      const preview = await refreshPreview(page);
      const row = preview.subscriptionPreviews.find((p) => p.packageName === app);
      expect(row?.newVersion, "POSITIVE CONTROL: v1.1.0 is offered").toBe("1.1.0");
      expect(row!.conflicts, "the deleted sheet turned the overrides into conflicts").toEqual([]);
      await refreshApply(page, preview);
      const rep3 = await sheetIndex(page, "Report");
      const [b2, b3] = await readCells(page, rep3, ["A2", "A3"]);
      expect(b2.display, "the override was lost at the refresh").toBe("#REF!");
      expect(b3.formula, "the shrunk 3D override was lost or re-widened at the refresh").toBe("=SUM(Mid:Mid!B1)");
    } finally {
      await newFile(page);
    }
  });
});

// ===========================================================================
// SHEET STRUCTURE: rename / delete / move repair every store that names a sheet
// ===========================================================================

async function cfCells(page: Page, r0: number, c0: number, r1: number, c1: number): Promise<Array<{ row: number; col: number }>> {
  const r = await invoke<{ cells: Array<{ row: number; col: number }> }>(page, "evaluate_conditional_formats", { startRow: r0, startCol: c0, endRow: r1, endCol: c1 });
  return r.cells;
}

async function validates(page: Page, row: number, col: number, value: string): Promise<boolean> {
  const r = await invoke<{ isValid: boolean }>(page, "validate_pending_value", { row, col, pendingValue: value });
  return r.isValid;
}

/** Validate the value a cell HOLDS on the active sheet (validate_cell). */
async function validatesCell(page: Page, row: number, col: number): Promise<boolean> {
  const r = await invoke<{ isValid: boolean }>(page, "validate_cell", { row, col });
  return r.isValid;
}

async function addButtonWithFormula(page: Page, sheetIdx: number, row: number, col: number, formula: string): Promise<void> {
  const btn = await page.evaluate(
    async ({ mod, s, row, col }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        requireButtonControlProvider: () => { createButton: (r: unknown) => Promise<{ row: number; col: number }> };
      };
      return m.requireButtonControlProvider().createButton({ sheetIndex: s, row, col, label: "Go" });
    },
    { mod: BUTTONS, s: sheetIdx, row, col },
  );
  await invoke(page, "set_control_property", {
    sheetIndex: sheetIdx, row: btn.row, col: btn.col, controlType: "button",
    propertyName: "text", valueType: "formula", value: formula,
  });
}

async function addPaneDropdown(page: Page, name: string, reference: string): Promise<void> {
  const pane = await callModule<{ id: string } | null>(page, PANE_STORE, "createControlAsync", [
    { name, controlType: "dropdown", config: { type: "dropdown", source: { type: "cellRange", reference }, placeholder: null }, order: null },
  ]);
  expect(pane, `precondition: the pane dropdown ${name} was created`).toBeTruthy();
}

async function listItems(page: Page, reference: string): Promise<string[]> {
  return callModule<string[]>(page, PANE_SOURCE, "loadCellRangeItems", [reference]);
}

/** Workbook: Sheet1 + the named extra sheets (added in order, renamed). */
async function workbookWith(page: Page, names: string[]): Promise<void> {
  await newFile(page);
  for (const n of names) {
    const s = await addWorksheet(page);
    if (s.name !== n) await renameSheetByName(page, s.name, n);
  }
  await activate(page, "Sheet1");
}

test.describe("fix-all live: sheet structure", () => {
  test("B2: a sheet renamed to True and then to Q1. is quoted in every formula, and the formulas keep computing", async ({ appPage: page }) => {
    try {
      await workbookWith(page, ["Sheet2"]);
      await setCells(page, await sheetIndex(page, "Sheet2"), [["A1", "5"]]);
      await setCells(page, 0, [["A1", "=Sheet2!A1*2"]]);
      expect((await readCell(page, 0, "A1")).display, "precondition").toBe("10");

      await renameSheetByName(page, "Sheet2", "True");
      let a1 = await readCell(page, 0, "A1");
      expect(a1.formula, "TRUE left bare does not parse back").toBe("='True'!A1*2");
      await setCells(page, await sheetIndex(page, "True"), [["A1", "6"]]);
      await eventually(() => readCell(page, 0, "A1"), (c) => c.display === "12", "the formula stopped computing after the rename to True");

      await renameSheetByName(page, "True", "Q1.");
      a1 = await readCell(page, 0, "A1");
      expect(a1.formula, "Q1. left bare does not parse back").toBe("='Q1.'!A1*2");
      await setCells(page, await sheetIndex(page, "Q1."), [["A1", "7"]]);
      await eventually(() => readCell(page, 0, "A1"), (c) => c.display === "14", "the formula stopped computing after the rename to Q1.");
    } finally {
      await newFile(page);
    }
  });

  test("B3 + W8: @Data!A1:A3, SUM(Data!A1#), an array constant and Data!A1[0] follow a rename, and a delete turns every one into #REF!", async ({ appPage: page }) => {
    try {
      await workbookWith(page, ["Data"]);
      const data = await sheetIndex(page, "Data");
      await setCells(page, data, [["A1", "=SEQUENCE(3)"]]);
      await setCells(page, 0, [["A1", "=@Data!A1:A3"], ["A2", "=SUM(Data!A1#)"], ["A3", "={1\\Data!A1}"], ["A4", "=Data!A1[0]"]]);
      const before = await readCells(page, 0, ["A1", "A2", "A3", "A4"]);
      console.log(`[B3/W8] before: ${JSON.stringify(before)}`);
      expect(before[0].display, "precondition: @Data!A1:A3").toBe("1");
      expect(before[1].display, "precondition: SUM(Data!A1#)").toBe("6");
      const withArray = (before[2].formula ?? "").startsWith("=");
      const withIndex = (before[3].formula ?? "").startsWith("=");

      await renameSheetByName(page, "Data", "Facts");
      const renamed = await readCells(page, 0, ["A1", "A2", "A3", "A4"]);
      expect(renamed[0].formula, "B3: the implicit-intersection reference kept the old name").toBe("=@Facts!A1:A3");
      expect(renamed[1].formula, "B3: the spill reference kept the old name").toBe("=SUM(Facts!A1#)");
      if (withArray) expect(renamed[2].formula ?? "", "the array constant kept the old name").toMatch(/Facts!A1/);
      if (withIndex) expect(renamed[3].formula ?? "", "the index access kept the old name").toMatch(/Facts!A1/);
      expect(renamed.map((c) => c.formula ?? "").filter((f) => /Data!/i.test(f)), "a formula still names Data").toEqual([]);
      expect(renamed[1].display, "the spill sum stopped computing").toBe("6");

      await deleteSheetByName(page, "Facts");
      const deleted = await readCells(page, 0, ["A1", "A2", "A3", "A4"]);
      console.log(`[B3/W8] after delete: ${JSON.stringify(deleted)}`);
      expect(deleted[0].display, "W8: @ over a deleted sheet").toBe("#REF!");
      expect(deleted[1].display, "W8: # over a deleted sheet").toBe("#REF!");
      if (withIndex) expect(deleted[3].display, "W8: index access over a deleted sheet").toBe("#REF!");
      expect(deleted.map((c) => c.formula ?? "").filter((f) => /Facts!|Data!/i.test(f)), "W8: a formula still names the deleted sheet").toEqual([]);
      // After the delete the backend reports NO formula text for these cells
      // (the whole formula collapsed to the #REF! error): both "shows #REF!" and
      // "no formula still names Data" hold, which is what the check asks.
      if (withArray) expect(deleted[2].display, "W8: the array constant over a deleted sheet").toBe("#REF!");
      expect(withArray && withIndex, `the array constant (${before[2].formula}) and index access (${before[3].formula}) were accepted as formulas`).toBe(true);
    } finally {
      await newFile(page);
    }
  });

  test("RENAME RULE STORES (wb-backend fixup): renaming Data carries the conditional format, the custom validation and the button formula, and each still works", async ({ appPage: page }) => {
    try {
      await workbookWith(page, ["Data"]);
      const data = await sheetIndex(page, "Data");
      await setCells(page, data, [["A1", "a"], ["A2", "b"], ["A3", "c"], ["B1", "5"]]);
      await activate(page, "Sheet1");
      await addCf(page, "=A1>Data!$B$1", 0, 0);
      await setDv(page, 0, 0, 1, { custom: { formula: "=COUNTIF(Data!A:A,B1)=1" } });
      await addButtonWithFormula(page, 0, 3, 3, "=Data!A1");
      // BASELINE: the rule accepts a listed value and refuses another before the rename.
      await setCells(page, 0, [["B1", "b"]]);
      expect(await validatesCell(page, 0, 1), "precondition: the rule accepts a value in Data!A:A").toBe(true);
      await setCells(page, 0, [["B1", "zzz"]]);
      expect(await validatesCell(page, 0, 1), "precondition: the rule refuses a value not in Data!A:A").toBe(false);
      await setCells(page, 0, [["B1", ""]]);

      await renameSheetByName(page, "Data", "Facts");
      await activate(page, "Sheet1");
      expect(await cfFormulas(page, 0), "Manage Rules shows the old name").toEqual(["=A1>Facts!$B$1"]);
      const custom = (await dvRules(page, 0)).map((d) => (d.validation.rule.custom as { formula?: string } | undefined)?.formula ?? "");
      expect(custom, "the validation rule shows the old name").toEqual(["=COUNTIF(Facts!A:A,B1)=1"]);
      const btn = await buttonTextFormula(page, 0);
      expect(btn?.formula).toBe("=Facts!A1");
      expect(btn?.resolved, "the button no longer shows Data!A1's value").toBe("a");

      // They still WORK, in both directions.
      await setCells(page, 0, [["A1", "9"]]);
      expect((await cfCells(page, 0, 0, 0, 0)).length, "the highlight does not fire for 9 > 5").toBe(1);
      await setCells(page, 0, [["A1", "1"]]);
      expect((await cfCells(page, 0, 0, 0, 0)).length, "the highlight fires for 1 > 5").toBe(0);
      // A custom rule is evaluated over the grid (validate_pending_value does not
      // substitute the pending value into the formula), so the value is put in
      // B1 and the CELL is validated -- what Circle Invalid Data reads.
      await setCells(page, 0, [["B1", "b"]]);
      expect(await validatesCell(page, 0, 1), "a value in Facts!A:A is refused after the rename").toBe(true);
      await setCells(page, 0, [["B1", "zzz"]]);
      expect(await validatesCell(page, 0, 1), "a value not in Facts!A:A is accepted after the rename").toBe(false);
    } finally {
      await newFile(page);
    }
  });

  test("W7 + X13: a pane dropdown on Data!A1:A5 follows a rename through the tab strip (and the open pane), survives save + reopen, follows the MCP rename_sheet tool, and follows a floating-range rename", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    const name = `PickW7${RUN}`;
    const frName = `PickFr${RUN}`;
    let mcp: Awaited<ReturnType<typeof startMcp>> | null = null;
    try {
      await workbookWith(page, ["Data"]);
      await setCells(page, await sheetIndex(page, "Data"), [["A1", "v1"], ["A2", "v2"], ["A3", "v3"], ["A4", "v4"], ["A5", "v5"]]);
      await addPaneDropdown(page, name, "Data!A1:A5");
      expect(await listItems(page, "Data!A1:A5"), "precondition").toEqual(["v1", "v2", "v3", "v4", "v5"]);

      await renameSheetByName(page, "Data", "My Facts");
      expect(await paneSource(page, name), "the rename did not carry the pane dropdown").toBe("'My Facts'!A1:A5");
      // X13: the OPEN pane's own cache follows without a reload.
      await eventually(
        () => callModule<{ config: { source?: { reference?: string } } } | undefined>(page, PANE_STORE, "getControlByName", [name]),
        (c) => c?.config.source?.reference === "'My Facts'!A1:A5",
        "the Controls pane kept the old reference until a reload",
      );
      expect(await listItems(page, "'My Facts'!A1:A5")).toEqual(["v1", "v2", "v3", "v4", "v5"]);

      const saved = file("w7");
      await saveAs(page, saved);
      await newFile(page);
      expect(await paneSource(page, name), "precondition: File > New cleared the pane controls").toBeNull();
      await openAt(page, saved);
      expect(await paneSource(page, name), "the renamed source did not survive save + reopen").toBe("'My Facts'!A1:A5");
      expect(await listItems(page, "'My Facts'!A1:A5"), "after reopen the dropdown does not list the cells").toEqual(["v1", "v2", "v3", "v4", "v5"]);

      // Through the MCP rename_sheet tool.
      mcp = await startMcp(page);
      const r = await mcp.call("rename_sheet", { index: await sheetIndex(page, "My Facts"), new_name: "Facts2" });
      expect(r.isError, `the MCP rename failed: ${r.text}`).toBe(false);
      await eventually(() => sheetNames(page), (n) => n.includes("Facts2"), "the MCP rename did not land");
      expect(await paneSource(page, name), "the MCP rename_sheet tool did not carry the pane dropdown").toBe("Facts2!A1:A5");
      expect(await listItems(page, "Facts2!A1:A5")).toEqual(["v1", "v2", "v3", "v4", "v5"]);

      // A floating range's rename (Float1 -> Float2).
      const canvas = await addCanvas(page);
      await activate(page, canvas.name);
      const fr = await callModule<{ id: string }>(page, "/src/api/floatingRanges.ts", "createFloatingRange", [320, 96, "Float1"]);
      await callModule(page, "/src/api/floatingRanges.ts", "updateFloatingRange", [fr.id, { rowCount: 4 }]);
      for (const [r0, v] of [[0, "f1"], [1, "f2"], [2, "f3"]] as Array<[number, string]>) {
        await callModule(page, "/src/api/floatingRanges.ts", "updateFloatingRangeCell", [fr.id, r0, 0, v]);
      }
      await addPaneDropdown(page, frName, "Float1!A1:A3");
      const beforeRename = await listItems(page, "Float1!A1:A3");
      await callModule(page, "/src/api/floatingRanges.ts", "renameFloatingRange", [fr.id, "Float2"]);
      expect(await paneSource(page, frName), "the floating-range rename did not carry the pane dropdown").toBe("Float2!A1:A3");
      expect(await paneSource(page, name), "the other dropdown was disturbed").toBe("Facts2!A1:A5");
      // LAST, because it fails for a reason of its own: the dropdown resolves a
      // prefix against getSheets(), which omits a floating range's backing sheet.
      expect(beforeRename, "a pane dropdown sourced from a floating range lists nothing (before any rename)").toEqual(["f1", "f2", "f3"]);
      expect(await listItems(page, "Float2!A1:A3"), "after the rename the dropdown does not list the floating range").toEqual(["f1", "f2", "f3"]);
    } finally {
      await mcp?.stop();
      await newFile(page);
    }
  });

  test("W10 (delete): deleting Data turns the conditional format, both validations, the button formula and the pane dropdown into #REF!, and the list refuses every entry", async ({ appPage: page }) => {
    const name = `PickDel${RUN}`;
    try {
      await workbookWith(page, ["Data"]);
      const data = await sheetIndex(page, "Data");
      await setCells(page, data, [["A1", "a"], ["A2", "b"], ["A3", "c"], ["B1", "5"]]);
      await activate(page, "Sheet1");
      await addCf(page, "=A1>Data!$B$1", 0, 0);
      await setDv(page, 0, 0, 1, { custom: { formula: "=A1<Data!$B$1" } });
      await setListDv(page, 0, 0, 2, data, 0, 0, 2, 0);
      await addButtonWithFormula(page, 0, 3, 3, "=Data!A1");
      await addPaneDropdown(page, name, "Data!A1:A5");
      // POSITIVE CONTROL: before the delete the list lists and accepts.
      expect(await invoke(page, "get_validation_list_values", { row: 0, col: 2 })).toEqual(["a", "b", "c"]);
      expect(await validates(page, 0, 2, "a"), "precondition: the list accepts one of its values").toBe(true);

      await deleteSheetByName(page, "Data");
      await activate(page, "Sheet1");
      expect(await cfFormulas(page, 0), "Manage Rules still names the deleted sheet").toEqual(["=A1>#REF!"]);
      const rules = await dvRules(page, 0);
      const custom = rules.map((d) => (d.validation.rule.custom as { formula?: string } | undefined)?.formula ?? "").filter(Boolean);
      expect(custom.length, "precondition: the custom rule is still there").toBe(1);
      expect(custom[0], "the custom rule still names the deleted sheet").toContain("#REF!");
      const listed = await invoke<string[] | null>(page, "get_validation_list_values", { row: 0, col: 2 });
      expect(listed ?? [], "the list validation lists another sheet's cells after its source was deleted").toEqual([]);
      expect(await validates(page, 0, 2, "a"), "the orphaned list accepts an entry").toBe(false);
      expect(await validates(page, 0, 2, "zz"), "the orphaned list accepts an entry").toBe(false);
      const btn = await buttonTextFormula(page, 0);
      expect(btn?.formula ?? "", "the button formula still names the deleted sheet").toContain("#REF!");
      expect(await paneSource(page, name), "the pane dropdown source").toBe("#REF!");
      expect(await listItems(page, "#REF!"), "a #REF! source lists the active sheet's cells").toEqual([]);
    } finally {
      await newFile(page);
    }
  });

  test("W10 (move): a list validation sourced from Lists still lists Lists after Lists moves to the front", async ({ appPage: page }) => {
    try {
      await workbookWith(page, ["Sheet2", "Lists"]);
      await setCells(page, await sheetIndex(page, "Sheet2"), [["A1", "d1"], ["A2", "d2"], ["A3", "d3"]]);
      const lists = await sheetIndex(page, "Lists");
      await setCells(page, lists, [["A1", "L1"], ["A2", "L2"], ["A3", "L3"]]);
      await setCells(page, 0, [["A1", "own1"], ["A2", "own2"], ["A3", "own3"]]);
      await activate(page, "Sheet1");
      await setListDv(page, 0, 0, 1, lists, 0, 0, 2, 0);
      expect(await invoke(page, "get_validation_list_values", { row: 0, col: 1 }), "precondition").toEqual(["L1", "L2", "L3"]);

      await moveSheetByName(page, "Lists", 0);
      await activate(page, "Sheet1");
      expect(await invoke(page, "get_validation_list_values", { row: 0, col: 1 }), "after the move the dropdown lists another sheet").toEqual(["L1", "L2", "L3"]);
    } finally {
      await newFile(page);
    }
  });

  test("W10/W11 (3D endpoint): deleting the endpoint Data shrinks Mid:Data to Mid:Mid and Data:Last to Last:Last, in cells and in the conditional format", async ({ appPage: page }) => {
    try {
      await workbookWith(page, ["Mid", "Data", "Last", "Other"]);
      for (const [n, v] of [["Mid", "1"], ["Data", "10"], ["Last", "100"], ["Other", "1000"]] as Array<[string, string]>) {
        await setCells(page, await sheetIndex(page, n), [["B1", v]]);
      }
      await activate(page, "Sheet1");
      await setCells(page, 0, [["A1", "=SUM(Mid:Data!B1)"], ["A2", "=SUM(Data:Last!B1)"]]);
      await addCf(page, "=SUM(Mid:Data!B1)>0", 0, 0);
      expect((await readCells(page, 0, ["A1", "A2"])).map((c) => c.display), "precondition").toEqual(["11", "110"]);

      await deleteSheetByName(page, "Data");
      await activate(page, "Sheet1");
      const [a1, a2] = await readCells(page, 0, ["A1", "A2"]);
      expect(a1.formula, "a deleted end widened to the workbook's last sheet").toBe("=SUM(Mid:Mid!B1)");
      expect(a1.display, "Mid:Mid sums Mid alone, not Mid + Last + Other").toBe("1");
      expect(a2.formula, "a deleted start widened to the workbook's first sheet").toBe("=SUM(Last:Last!B1)");
      expect(a2.display).toBe("100");
      expect(await cfFormulas(page, 0), "Manage Rules").toEqual(["=SUM(Mid:Mid!B1)>0"]);
    } finally {
      await newFile(page);
    }
  });

  test("W9: an index-only chart range (MCP) follows a sheet delete, and says its source sheet is gone when that sheet is deleted", async ({ appPage: page }) => {
    test.setTimeout(240_000);
    const renderErrors: string[] = [];
    let mcp: Awaited<ReturnType<typeof startMcp>> | null = null;
    try {
      await workbookWith(page, ["Sheet2", "Sheet3"]);
      await setCells(page, await sheetIndex(page, "Sheet2"), [["A1", "x"], ["A2", "y"], ["A3", "z"], ["B1", "100"], ["B2", "200"], ["B3", "300"]]);
      await setCells(page, await sheetIndex(page, "Sheet3"), [["A1", "x"], ["A2", "y"], ["A3", "z"], ["B1", "1"], ["B2", "2"], ["B3", "3"]]);
      await activate(page, "Sheet1");
      page.on("console", (m) => {
        if (m.type() === "error" && /Failed to render chart/.test(m.text())) renderErrors.push(m.text());
      });
      mcp = await startMcp(page);
      const made = await mcp.call("create_chart_from_spec", {
        spec: {
          mark: "bar",
          data: { sheetIndex: 2, startRow: 0, startCol: 0, endRow: 2, endCol: 1 },
          hasHeaders: false,
          seriesOrientation: "columns",
          categoryIndex: 0,
          series: [{ name: "v", sourceIndex: 1, color: "#4472C4" }],
          title: `W9${RUN}`,
        },
        sheet_index: 0,
        name: `W9${RUN}`,
      });
      expect(made.isError, `create_chart_from_spec failed: ${made.text}`).toBe(false);
      const chart = await eventually(
        async () => (await invoke<Array<{ id: string; specJson: string }>>(page, "get_charts")).find((c) => JSON.parse(c.specJson).spec?.title === `W9${RUN}`),
        (c) => !!c,
        "the MCP chart never reached the backend",
      );
      const chartId = chart!.id;
      const data0 = ((await chartSpec(page, chartId))!.spec.data ?? {}) as { sheetIndex?: number; sheetId?: string };
      console.log(`[W9] the chart's range as stored: ${JSON.stringify(data0)}`);
      expect(data0.sheetIndex).toBe(2);
      await eventually(() => chartValues(page, chartId), (v) => JSON.stringify(v) === "[1,2,3]", "precondition: the chart plots Sheet3", 20_000);

      await deleteSheetByName(page, "Sheet2");
      const data1 = ((await chartSpec(page, chartId))!.spec.data ?? {}) as { sheetIndex?: number; sheetId?: string };
      console.log(`[W9] after deleting Sheet2: ${JSON.stringify(data1)}`);
      expect(data1.sheetIndex, "the index-only range was not remapped: it now names another sheet").toBe(1);
      await activate(page, "Sheet1");
      await eventually(() => chartValues(page, chartId), (v) => JSON.stringify(v) === "[1,2,3]", "after deleting Sheet2 the chart no longer shows Sheet3's data", 20_000);

      await deleteSheetByName(page, "Sheet3");
      const data2 = ((await chartSpec(page, chartId))!.spec.data ?? {}) as { sheetIndex?: number; sheetId?: string };
      console.log(`[W9] after deleting Sheet3: ${JSON.stringify(data2)}`);
      const raw = (await chartSpec(page, chartId))!.spec;
      await installAppImport(page);
      const read = await page.evaluate(
        async ({ raw }) => {
          const w = window as unknown as AppWindow;
          const norm = (await w.__appImport!("/extensions/Charts/lib/chartSpecNormalize.ts")) as { normalizeChartSpec: (r: unknown) => unknown };
          const reader = (await w.__appImport!("/extensions/Charts/lib/chartDataReader.ts")) as { readChartData: (s: unknown) => Promise<unknown> };
          try {
            const data = await reader.readChartData(norm.normalizeChartSpec(raw));
            return { ok: true, error: "", value: JSON.stringify(data).slice(0, 200) };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e), value: "" };
          }
        },
        { raw },
      );
      console.log(`[W9] the chart reader answered: ${JSON.stringify(read)}`);
      expect(read.ok, `the chart read ${read.value} from a sheet that is not its source`).toBe(false);
      expect(read.error, "the chart does not say its source sheet is gone").toMatch(/source sheet no longer exists/i);
      // ...and the renderer, on screen, fails with the same sentence (its error card).
      await activate(page, "Sheet1");
      await eventually(
        async () => renderErrors.join("\n"),
        (t) => t.includes(chartId) && /source sheet no longer exists/i.test(t),
        "the renderer did not report the missing source sheet for this chart",
        20_000,
      );
    } finally {
      await mcp?.stop();
      await newFile(page);
    }
  });

  test("DV-WIRE: the Data Validation dialog's own list-from-range rule is accepted by the backend", async ({ appPage: page }) => {
    try {
      await workbookWith(page, ["Lists"]);
      const lists = await sheetIndex(page, "Lists");
      await setCells(page, lists, [["A1", "L1"], ["A2", "L2"], ["A3", "L3"]]);
      await activate(page, "Sheet1");
      // Exactly what DataValidationDialog.buildRule + handleOk send for the
      // source "=Lists!$A$1:$A$3": createListRuleFromRange -> @api setDataValidation.
      const rule = await callModule<unknown>(page, "/src/core/types/types.ts", "createListRuleFromRange", [0, 0, 2, 0, lists, true]);
      const r = await tryModule(page, "/src/api/lib.ts", "setDataValidation", [0, 0, 0, 0, dv(rule), 0]);
      expect(r.ok, `the dialog's list-from-range rule is refused on the wire: ${r.error}`).toBe(true);
      expect(await invoke(page, "get_validation_list_values", { row: 0, col: 0 })).toEqual(["L1", "L2", "L3"]);
    } finally {
      await newFile(page);
    }
  });

  test("W12: a spilled floating-grid cell shows the anchor's formula greyed and read-only; the anchor is editable; a shrunk spill is not grey; R1C1 is anchor-relative", async ({ appPage: page, grid }) => {
    test.setTimeout(240_000);
    const FR = { x: 320, y: 96 };
    const CELL = { w: 64.29, h: 20 };
    const ORIGIN = { dx: 28, dy: 20 + 16 }; // row headers 28, title 20, column headers 16
    try {
      await newFile(page);
      const canvas = await addCanvas(page);
      await activate(page, canvas.name);
      const fr = await callModule<{ id: string }>(page, "/src/api/floatingRanges.ts", "createFloatingRange", [FR.x, FR.y, "Float1"]);
      await callModule(page, "/src/api/floatingRanges.ts", "updateFloatingRange", [fr.id, { rowCount: 5, colCount: 3 }]);
      await callModule(page, "/src/api/floatingRanges.ts", "updateFloatingRangeCell", [fr.id, 0, 0, "=SEQUENCE(3)"]);
      await page.waitForTimeout(800);

      const clickFrCell = async (row: number, col: number) => {
        const geo = await readGridGeometry(page);
        const origin = await page.evaluate(() => {
          const c = document.querySelector("canvas") as HTMLCanvasElement;
          const r = c.getBoundingClientRect();
          return { x: r.left, y: r.top };
        });
        const sx = FR.x + ORIGIN.dx + CELL.w * col + CELL.w / 2;
        const sy = FR.y + ORIGIN.dy + CELL.h * row + CELL.h / 2;
        await page.mouse.click(origin.x + (geo.rowHeaderWidth + sx - geo.scrollX) * geo.zoom, origin.y + (geo.colHeaderHeight + sy - geo.scrollY) * geo.zoom);
        await page.waitForTimeout(400);
      };
      const bar = async () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-formula-bar="true"]') as HTMLInputElement | null;
          return { value: el?.value ?? "", readOnly: !!el?.readOnly, color: el ? getComputedStyle(el).color : "" };
        });

      await clickFrCell(0, 0);
      const anchor = await eventually(bar, (b) => b.value === "=SEQUENCE(3)", "precondition: selecting Float1!A1 does not show its formula");
      expect(anchor.readOnly, "the anchor is read-only").toBe(false);

      await clickFrCell(1, 0);
      const ghost = await eventually(bar, (b) => b.value === "=SEQUENCE(3)", "selecting A2 does not show the anchor's formula");
      expect(ghost.readOnly, "the spilled cell is editable").toBe(true);
      expect(ghost.color, "the spilled cell is not greyed").not.toBe(anchor.color);
      // Clicking the greyed bar opens no edit: the bar refuses focus (it blurs
      // itself), stays read-only and keeps the anchor's text.
      await grid.formulaBar.click();
      await page.waitForTimeout(400);
      const afterClick = await page.evaluate(() => {
        const el = document.querySelector('[data-formula-bar="true"]') as HTMLInputElement | null;
        return { focused: document.activeElement === el, readOnly: !!el?.readOnly, value: el?.value ?? "" };
      });
      expect(afterClick, "clicking the greyed bar opened an edit").toEqual({ focused: false, readOnly: true, value: "=SEQUENCE(3)" });
      await page.keyboard.press("Escape");
      const a2 = await callModule<Array<{ formula: string | null; value: unknown }>>(page, "/src/api/floatingRanges.ts", "getFloatingRangeCells", [fr.id, 1, 0, 1, 0]);
      expect(Number(a2[0]?.value), "the spilled cell changed").toBe(2);

      // A shrunk spill: A2 is no longer spilled, so nothing is grey.
      await callModule(page, "/src/api/floatingRanges.ts", "updateFloatingRangeCell", [fr.id, 0, 0, "=SEQUENCE(1)"]);
      await page.waitForTimeout(600);
      await clickFrCell(0, 0);
      await clickFrCell(1, 0);
      const plain = await eventually(bar, (b) => b.value === "", "A2 still shows the old anchor's formula");
      expect(plain.readOnly, "an ordinary empty floating-grid cell is read-only").toBe(false);
      expect(plain.color, "an ordinary cell is greyed").toBe(anchor.color);

      // R1C1: B2 =A1:A3*2 spills B2:B4; B4 shows the anchor's formula relative to the ANCHOR.
      await callModule(page, "/src/api/floatingRanges.ts", "updateFloatingRangeCell", [fr.id, 0, 0, "=SEQUENCE(3)"]);
      await callModule(page, "/src/api/floatingRanges.ts", "updateFloatingRangeCell", [fr.id, 1, 1, "=A1:A3*2"]);
      await callModule(page, "/src/api/grid.ts", "changeReferenceStyle", ["R1C1"]);
      await page.waitForTimeout(600);
      await clickFrCell(3, 1);
      await eventually(bar, (b) => b.value === "=R[-1]C[-1]:R[1]C[-1]*2", "R1C1 ghost text is not relative to the anchor");
    } finally {
      await callModule(page, "/src/api/grid.ts", "changeReferenceStyle", ["A1"]).catch(() => undefined);
      await newFile(page);
    }
  });
});

// ===========================================================================
// UNDO: script batches, the macro runner, the command line, protected paste
// ===========================================================================

const MACRO_RUN = "/src/api/macroRunService.ts";

/**
 * Store a macro in the workbook's script library (the recorder's object-script
 * shape: a body function plus `setup(context)`), exactly what Developer >
 * Macros lists, and return its id.
 */
async function saveMacro(page: Page, tag: string, body: string): Promise<string> {
  const fn = `fixall${tag.replace(/[^A-Za-z0-9]/g, "")}`;
  const id = `macro-fixall-${tag.toLowerCase().replace(/[^a-z0-9]/g, "")}-${RUN}`;
  const source = [`async function ${fn}(api) {`, body, `}`, ``, `function setup(context) {`, `  return ${fn}(context.api);`, `}`, ``].join("\n");
  await invoke(page, "save_script", {
    script: { id, name: `Fixall ${tag}`, description: "Recorded macro · runtime=objectScript · e2e fix-all", source, scope: { type: "workbook" } },
  });
  return id;
}

/** Developer > Macros > Run: the @api/macroRunService seam the library's Run uses. */
async function runMacro(page: Page, id: string): Promise<{ status: string; message?: string }> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod, id }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        requireMacroRunProvider: () => { runMacroByRef: (id: string) => Promise<{ status: string; message?: string }> };
      };
      return m.requireMacroRunProvider().runMacroByRef(id);
    },
    { mod: MACRO_RUN, id },
  );
}

async function withScriptsEnabled<T>(page: Page, body: () => Promise<T>): Promise<T> {
  const previous = await invoke<string>(page, "get_script_security_level").catch(() => "prompt");
  await invoke(page, "set_script_security_level", { level: "enabled" });
  try {
    return await body();
  } finally {
    await invoke(page, "set_script_security_level", { level: previous }).catch(() => undefined);
  }
}

async function activeCells(page: Page, refs: string[]): Promise<string[]> {
  const idx = (await sheets(page)).activeIndex;
  return (await readCells(page, idx, refs)).map((c) => c.display);
}

// ---- the command line -----------------------------------------------------

/** Press the Command Line toggle the way View > Command Line / Ctrl+Shift+P do (the registered command). */
async function toggleCliCommand(page: Page): Promise<void> {
  await installAppImport(page);
  await page.evaluate(async () => {
    const m = (await (window as unknown as AppWindow).__appImport!("/src/api/commands.ts")) as {
      CommandRegistry: { execute: (id: string) => Promise<unknown> };
    };
    await m.CommandRegistry.execute("commandLine.toggle");
  });
}

/**
 * Open the command line through its toggle. When the toggle does not open it
 * (CLI-TOGGLE, a defect this spec proves on its own), fall back to the same
 * dialog through @api showDialog so the checks BEHIND the panel still run.
 */
async function openCli(page: Page): Promise<Locator> {
  const header = page.locator("span", { hasText: /^Command Line$/ });
  if ((await header.count()) === 0) {
    await toggleCliCommand(page);
    const opened = await header.first().waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
    if (!opened) {
      console.log("[CLI] the toggle did not open the command line; opening it through @api showDialog");
      await callModule(page, "/src/api/index.ts", "showDialog", ["command-line-panel"]);
    }
  }
  await header.first().waitFor({ state: "visible", timeout: 10_000 });
  const panel = header.first().locator("xpath=../..");
  await panel.locator(".monaco-editor").first().waitFor({ state: "visible", timeout: 20_000 });
  return panel;
}

async function closeCli(page: Page): Promise<void> {
  const header = page.locator("span", { hasText: /^Command Line$/ });
  if ((await header.count()) > 0) {
    await header.first().locator("xpath=..").locator("button", { hasText: "✕" }).click().catch(() => undefined);
  }
}

interface CliEntry {
  text: string;
  color: string;
}

async function cliEntries(panel: Locator): Promise<CliEntry[]> {
  return panel.locator("pre").evaluateAll((els) => els.map((e) => ({ text: (e.textContent ?? "").trim(), color: getComputedStyle(e).color })));
}

/** Type a command at the prompt and press Enter (the prompt's own run key). */
async function cliPrompt(page: Page, panel: Locator, text: string): Promise<CliEntry[]> {
  const before = (await cliEntries(panel)).length;
  const promptButton = panel.locator("button", { hasText: /^Prompt$/ });
  if ((await promptButton.count()) > 0) await promptButton.click();
  await panel.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text, { delay: 20 });
  // Ctrl+Enter runs whatever the suggestion list shows ("undo" opens one, and
  // plain Enter would accept the suggestion instead of running).
  await page.keyboard.press("Control+Enter");
  return eventually(() => cliEntries(panel), (e) => e.length >= before + 2, `the command line printed nothing for "${text}"`, 15_000).then(async () => {
    await page.waitForTimeout(500);
    return (await cliEntries(panel)).slice(before);
  });
}

/** Run a multi-line script (Script mode, Run), confirming the write plan if asked. */
async function cliScript(page: Page, panel: Locator, lines: string[]): Promise<CliEntry[]> {
  const before = (await cliEntries(panel)).length;
  await panel.locator("button", { hasText: /^Script$/ }).click();
  await panel.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  for (let i = 0; i < lines.length; i++) {
    await page.keyboard.type(lines[i], { delay: 15 });
    if (i < lines.length - 1) await page.keyboard.press("Enter");
  }
  await panel.locator("button", { hasText: /^Run$/ }).first().click();
  // A write plan asks before it runs: press the plan's own Run.
  const confirm = panel.locator("div", { hasText: /^This run makes/ }).locator("button", { hasText: /^Run$/ });
  if (await confirm.first().waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false)) {
    await confirm.first().click();
  }
  await eventually(() => cliEntries(panel), (e) => e.length > before + lines.length, "the script printed nothing", 20_000);
  await page.waitForTimeout(800);
  const promptButton = panel.locator("button", { hasText: /^Prompt$/ });
  await promptButton.click().catch(() => undefined);
  return (await cliEntries(panel)).slice(before);
}

async function protectLikeTheDialog(page: Page, editObjects: boolean): Promise<void> {
  const r = await callModule<{ success: boolean; error?: string | null }>(page, "/src/api/backend.ts", "protectSheet", [
    { options: { allowSelectLockedCells: true, allowSelectUnlockedCells: true, allowFormatCells: false, allowFormatColumns: false, allowFormatRows: false, allowInsertColumns: false, allowInsertRows: false, allowInsertHyperlinks: false, allowDeleteColumns: false, allowDeleteRows: false, allowSort: false, allowAutoFilter: false, allowPivotTables: false, allowEditObjects: editObjects, allowEditScenarios: false } },
  ]);
  expect(r.success, `precondition: protectSheet refused: ${r.error ?? ""}`).toBe(true);
  await callModule(page, "/extensions/Protection/lib/protectionStore.ts", "refreshProtectionState");
}

/** An output line in the command line's ERROR colour (a theme token, so judged by hue). */
function isRed(color: string): boolean {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(color);
  return !!m && Number(m[1]) > 140 && Number(m[2]) < 90 && Number(m[3]) < 90;
}

test.describe("fix-all live: undo (script batches, runner, command line, protected paste)", () => {
  test("X6 (nested batches): Outer + Inner batches are ONE undo step named Outer", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await withScriptsEnabled(page, async () => {
        const id = await saveMacro(
          page,
          "x6nested",
          [
            `  await api.beginBatch("Outer");`,
            `  await api.setCellValue(0, 0, "1");`,
            `  await api.beginBatch("Inner");`,
            `  await api.setCellValue(1, 0, "2");`,
            `  await api.commitBatch();`,
            `  await api.setCellValue(2, 0, "3");`,
            `  await api.commitBatch();`,
          ].join("\n"),
        );
        const depth0 = (await undoState(page)).undoDepth;
        const out = await runMacro(page, id);
        expect(out.status, JSON.stringify(out)).toBe("ran");
        expect(await activeCells(page, ["A1", "A2", "A3"]), "POSITIVE CONTROL: the batch wrote").toEqual(["1", "2", "3"]);
        const u = await undoState(page);
        expect(u.undoDescription, "Edit > Undo does not read Outer").toBe("Outer");
        expect(u.undoDepth - depth0, "the nested batch left more than one undo step").toBe(1);
        await pressUndo(page);
        expect(await activeCells(page, ["A1", "A2", "A3"]), "one Ctrl+Z did not take back A1, A2 and A3 together").toEqual(["", "", ""]);
      });
    } finally {
      await newFile(page);
    }
  });

  test("X6 (runner): a macro that throws inside its batch fails with its message, and leaves no batch open to swallow the next edit", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await withScriptsEnabled(page, async () => {
        const id = await saveMacro(page, "x6runner", [`  await api.beginBatch("M");`, `  await api.setCellValue(0, 0, "1");`, `  throw new Error("boom");`].join("\n"));
        const out = await runMacro(page, id);
        expect(out.status, "the failed run was reported as a success").toBe("failed");
        expect(out.message ?? "").toContain("boom");
        expect((await activeCells(page, ["A1"]))[0], "POSITIVE CONTROL: the write before the throw landed").toBe("1");
        expect((await undoState(page)).undoDescription, "Edit > Undo offers the failed run's batch").not.toBe("M");
        await grid.clickCell("B1");
        await grid.typeIntoCell("5");
        expect((await activeCells(page, ["B1"]))[0]).toBe("5");
        await pressUndo(page);
        const [a1, b1] = await activeCells(page, ["A1", "B1"]);
        expect(b1, "Ctrl+Z did not take back the B1 edit").toBe("");
        expect(a1, "Ctrl+Z took back the failed run's write together with B1 (the batch stayed open)").toBe("1");
      });
    } finally {
      await newFile(page);
    }
  });

  test("X6 (cancel): cancelBatch keeps the write and offers no undo step named B", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await withScriptsEnabled(page, async () => {
        const id = await saveMacro(page, "x6cancel", [`  await api.beginBatch("B");`, `  await api.setCellValue(0, 0, "x");`, `  await api.cancelBatch();`].join("\n"));
        const out = await runMacro(page, id);
        expect(out.status, JSON.stringify(out)).toBe("ran");
        expect((await activeCells(page, ["A1"]))[0], "cancelBatch reverted the write (it only drops the undo record)").toBe("x");
        expect((await undoState(page)).undoDescription, "Edit > Undo offers the cancelled batch").not.toBe("B");
      });
    } finally {
      await newFile(page);
    }
  });

  test("X6 (named style in a batch): createNamedStyle inside a batch keeps the batch ONE step, lists the style, and leaves no scratch cell formatted", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await withScriptsEnabled(page, async () => {
        const id = await saveMacro(
          page,
          "x6style",
          [
            `  await api.beginBatch("B");`,
            `  await api.setCellValue(0, 0, "a");`,
            `  await api.createNamedStyle("Alert", { bold: true });`,
            `  await api.setCellValue(1, 0, "b");`,
            `  await api.commitBatch();`,
          ].join("\n"),
        );
        const out = await runMacro(page, id);
        expect(out.status, JSON.stringify(out)).toBe("ran");
        const styles = await invoke<Array<{ name: string }>>(page, "get_named_styles");
        expect(styles.map((s) => s.name), "Cell Styles does not list Alert").toContain("Alert");
        expect(await activeCells(page, ["A1", "A2"])).toEqual(["a", "b"]);
        expect((await undoState(page)).undoDescription, "the batch is not the top undo step").toBe("B");
        const scratch = async () => invoke<{ styleIndex: number } | null>(page, "get_cell", { row: 2, col: 2 });
        expect((await scratch())?.styleIndex ?? 0, "the scratch cell C3 was left formatted").toBe(0);
        await pressUndo(page);
        expect(await activeCells(page, ["A1", "A2"]), "one Ctrl+Z did not revert A1 and A2 together").toEqual(["", ""]);
        expect((await scratch())?.styleIndex ?? 0, "the undo left the scratch cell formatted").toBe(0);
      });
    } finally {
      await newFile(page);
    }
  });

  test("X6 check 9: a batch continues after its own sheet copy -- the writes after the copy are ONE step named Build, then nothing is left to undo", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await withScriptsEnabled(page, async () => {
        const id = await saveMacro(
          page,
          "x6copy",
          [
            `  await api.beginBatch("Build");`,
            `  await api.setCellValue(0, 0, "1");`,
            `  await api.copySheet(0);`,
            `  await api.setCellValue(1, 0, "2");`,
            `  await api.setCellValue(2, 0, "3");`,
            `  await api.commitBatch();`,
          ].join("\n"),
        );
        const out = await runMacro(page, id);
        expect(out.status, JSON.stringify(out)).toBe("ran");
        const s = await sheets(page);
        expect(s.sheets.length, "precondition: the copy exists").toBe(2);
        const copyIdx = s.activeIndex;
        expect(copyIdx, "precondition: the copy is the active sheet").toBe(1);
        expect((await readCells(page, copyIdx, ["A1", "A2", "A3"])).map((c) => c.display)).toEqual(["1", "2", "3"]);
        expect((await undoState(page)).undoDescription, "Edit > Undo does not read Build").toBe("Build");
        await pressUndo(page);
        expect((await readCells(page, copyIdx, ["A1", "A2", "A3"])).map((c) => c.display), "one Ctrl+Z did not clear A2 and A3 of the copy together").toEqual(["1", "", ""]);
        expect((await undoState(page)).canUndo, "something is left to undo after the copy ended the history").toBe(false);
      });
    } finally {
      await newFile(page);
    }
  });

  test("X6 check 10: a run that fails after its own addSheet leaves no batch open; Ctrl+Z after typing takes back only the typing", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await withScriptsEnabled(page, async () => {
        const id = await saveMacro(
          page,
          "x6addfail",
          [`  await api.beginBatch("M");`, `  await api.addSheet("X");`, `  await api.setCellValue(0, 0, "1");`, `  throw new Error("boom");`].join("\n"),
        );
        const out = await runMacro(page, id);
        expect(out.status).toBe("failed");
        expect(out.message ?? "").toContain("boom");
        await activate(page, "X");
        expect((await activeCells(page, ["A1"]))[0], "POSITIVE CONTROL: the write after addSheet landed on X").toBe("1");
        expect((await undoState(page)).undoDescription, "Edit > Undo offers the failed run's batch").not.toBe("M");
        await grid.clickCell("B1");
        await grid.typeIntoCell("5");
        await pressUndo(page);
        const [a1, b1] = await activeCells(page, ["A1", "B1"]);
        expect(b1, "Ctrl+Z did not take back B1").toBe("");
        expect(a1, "Ctrl+Z took back A1 with B1 (the batch was left open)").toBe("1");
        expect((await undoState(page)).undoDescription ?? "", "Edit > Undo offers M").not.toBe("M");
      });
    } finally {
      await newFile(page);
    }
  });

  test("X6 check 11: the command line's add sheet + two set cell lines succeed, and one Ctrl+Z clears both cells", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const panel = await openCli(page);
      const out = await cliScript(page, panel, ["add sheet Y", "set cell A1 = 1", "set cell A2 = 2"]);
      console.log(`[X6/11] ${JSON.stringify(out)}`);
      expect(out.filter((e) => isRed(e.color)), `the run printed an error: ${JSON.stringify(out)}`).toEqual([]);
      await closeCli(page);
      const y = await activate(page, "Y");
      expect((await readCells(page, y, ["A1", "A2"])).map((c) => c.display), "POSITIVE CONTROL: the run wrote").toEqual(["1", "2"]);
      await pressUndo(page);
      expect((await readCells(page, y, ["A1", "A2"])).map((c) => c.display), "one Ctrl+Z did not clear A1 and A2 together").toEqual(["", ""]);
    } finally {
      await closeCli(page);
      await newFile(page);
    }
  });

  test("X10: goto 2024!A1 prints Moved to '2024'!A1., and undo on an empty history prints 'Nothing to undo.' (not as an error)", async ({ appPage: page }) => {
    try {
      await workbookWith(page, ["2024"]);
      await activate(page, "Sheet1");
      const panel = await openCli(page);
      const out = await cliPrompt(page, panel, "goto 2024!A1");
      console.log(`[X10] ${JSON.stringify(out)}`);
      expect(out.map((e) => e.text), "the sheet name is not quoted by the parser's rule").toContain("Moved to '2024'!A1.");
      expect((await sheets(page)).activeIndex, "POSITIVE CONTROL: goto moved to the sheet").toBe(await sheetIndex(page, "2024"));

      await newFile(page);
      const empty = await cliPrompt(page, await openCli(page), "undo");
      const line = empty.find((e) => /Nothing to undo/.test(e.text));
      expect(line, `no 'Nothing to undo.' on an empty history: ${JSON.stringify(empty)}`).toBeTruthy();
      expect(isRed(line!.color), `an empty history is reported as an error (${line!.color})`).toBe(false);
    } finally {
      await closeCli(page);
      await newFile(page);
    }
  });

  test("CLI-TOGGLE: after the command line is closed with its X, View > Command Line (the toggle command) opens it again", async ({ appPage: page }) => {
    try {
      const header = page.locator("span", { hasText: /^Command Line$/ });
      if ((await header.count()) === 0) await callModule(page, "/src/api/index.ts", "showDialog", ["command-line-panel"]);
      await header.first().waitFor({ state: "visible", timeout: 10_000 });
      await closeCli(page);
      await eventually(() => header.count(), (n) => n === 0, "precondition: the X closed the command line");
      await toggleCliCommand(page);
      const reopened = await header.first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
      expect(reopened, "the toggle (View > Command Line / Ctrl+Shift+P) does not reopen a command line closed with its X").toBe(true);
    } finally {
      await closeCli(page);
    }
  });

  test("X11: pasting a shape onto a canvas protected against object edits is refused with one toast and no dirty flag; allowed, it pastes", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const canvas = await addCanvas(page);
      await activate(page, canvas.name);
      await installAppImport(page);
      await page.evaluate(
        async ({ s }) => {
          const m = (await (window as unknown as AppWindow).__appImport!("/src/api/controlsService.ts")) as {
            requireControlsProvider: () => { createShape: (r: unknown) => Promise<unknown> };
          };
          await m.requireControlsProvider().createShape({ sheetIndex: s, x: 160, y: 128, shapeType: "rectangle", width: 128, height: 80 });
        },
        { s: canvas.index },
      );
      const count = async () => (await invoke<unknown[]>(page, "get_all_controls", { sheetIndex: canvas.index })).length;
      expect(await count(), "precondition: one shape").toBe(1);
      await page.waitForTimeout(600);
      // Select it (a click on its body) and copy it with the user's keys.
      const geo = await readGridGeometry(page);
      const origin = await page.evaluate(() => {
        const r = (document.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect();
        return { x: r.left, y: r.top };
      });
      await page.mouse.click(origin.x + (geo.rowHeaderWidth + 160 + 64 - geo.scrollX) * geo.zoom, origin.y + (geo.colHeaderHeight + 128 + 40 - geo.scrollY) * geo.zoom);
      await page.waitForTimeout(400);
      await page.keyboard.press("Control+c");
      await page.waitForTimeout(400);

      // The Protect Sheet dialog's own steps: protectSheet, then refreshProtectionState.
      await protectLikeTheDialog(page, false);
      await saveAs(page, file("x11"));
      expect(await isDirty(page), "precondition: saved, clean").toBe(false);
      await page.evaluate(() => document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click()));
      await page.keyboard.press("Control+v");
      await page.waitForTimeout(1500);
      const toasts = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[data-toast]")).map((t) => t.textContent ?? ""));
      expect(toasts.filter((t) => /protect/i.test(t)).length, `expected exactly one protection toast: ${JSON.stringify(toasts)}`).toBe(1);
      expect(await count(), "a shape was pasted onto a canvas protected against object edits").toBe(1);
      expect(await isDirty(page), "the refused paste dirtied the document").toBe(false);

      // POSITIVE CONTROL: with Edit objects allowed, the same paste lands.
      await callModule(page, "/src/api/backend.ts", "unprotectSheet", []);
      await protectLikeTheDialog(page, true);
      await page.locator("[data-focus-container='spreadsheet']").focus().catch(() => undefined);
      await page.keyboard.press("Control+v");
      await eventually(count, (n) => n === 2, "with Edit objects allowed the paste did not land");
    } finally {
      await invoke(page, "unprotect_sheet", { password: null }).catch(() => undefined);
      await newFile(page);
    }
  });
});

// ===========================================================================
// MODEL VALUE LISTS WITH (blank), and the remaining collaboration checks
// ===========================================================================

const BLANK_SOURCE = "blank_csv";

/** A one-table CSV model whose region column holds NULLs; year 2025 has ONLY a blank region. */
async function blankModel(page: Page, name: string): Promise<{ connectionId: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-fixall-blank-"));
  fs.writeFileSync(
    path.join(dir, "Sales.csv"),
    ["region,year,revenue", "East,2023,10", "East,2024,20", "West,2023,30", ",2023,40", ",2025,50", "West,2024,60"].join("\n") + "\n",
    "utf8",
  );
  const model = {
    format_version: 28,
    model_name: name,
    model_description: "",
    tables: [
      {
        name: "Sales",
        columns: [
          { name: "region", data_type: "String", nullable: true },
          { name: "year", data_type: "Int64", nullable: false },
          { name: "revenue", data_type: "Float64", nullable: false },
        ],
        storage_mode: "in_memory",
        source_binding: { source_id: BLANK_SOURCE, schema: "csv", table: "Sales" },
      },
    ],
    relationships: [],
    measures: [
      {
        name: "Revenue",
        expression: { Aggregate: { operation: "Sum", operand: { QualifiedColumnRef: { table_or_var: "Sales", column: "revenue" } } } },
        source: "SUM(Sales[revenue])",
        format_string: "#,##0",
      },
    ],
    calculated_columns: [],
    measure_groups: [],
    hierarchies: [],
    kpis: [],
    sources: [{ id: BLANK_SOURCE, kind: "csv", connection: { database: dir, default_schema: "csv" }, preferred_auth: "integrated", display_name: "Blank member (CSV)" }],
  };
  const info = await invoke<{ id: string }>(page, "bi_create_connection", {
    request: { name, description: null, connectionString: "", modelJson: { formatVersion: 1, model } },
  });
  await invoke(page, "bi_model_connect_source", { connectionId: info.id, sourceId: BLANK_SOURCE, connectionString: "", remember: false });
  return { connectionId: String(info.id), dir };
}

async function pivotApi<T>(page: Page, fn: string, arg: unknown): Promise<T> {
  await installAppImport(page);
  return page.evaluate(
    async ({ fn, arg }) => {
      const m = (await (window as unknown as AppWindow).__appImport!("/src/api/pivot.ts")) as { pivot: Record<string, (a: unknown) => Promise<unknown>> };
      return (await m.pivot[fn](arg)) as unknown;
    },
    { fn, arg },
  ) as Promise<T>;
}

/** label -> value for a one-row-field pivot's view (first string cell, last number cell). */
async function pivotRows(page: Page, pivotId: string): Promise<Record<string, number>> {
  const view = await pivotApi<{ rows: Array<{ cells: Array<{ value: unknown }> }> }>(page, "getView", pivotId);
  const out: Record<string, number> = {};
  for (const r of view.rows) {
    const label = r.cells.find((c) => typeof c.value === "string")?.value as string | undefined;
    const nums = r.cells.map((c) => c.value).filter((v): v is number => typeof v === "number");
    if (label !== undefined && nums.length > 0) out[label] = nums[nums.length - 1];
  }
  return out;
}

const SLICER_STORE = "/extensions/Slicer/lib/slicerStore.ts";

test.describe("fix-all live: model value lists name the blank member (W6)", () => {
  test("W6 (model slicer + pinned): the list ends with (blank); East hides the blank row, East + (blank) shows it; pinned, the totals follow", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await blankModel(page, `FixallBlank${RUN}`);
      const v = await pivotApi<{ pivotId: string }>(page, "createFromBiModel", { destinationSheet: 0, connectionId: conn.connectionId, destinationCell: "B2" });
      const pivotId = String(v.pivotId);
      await pivotApi(page, "updateBiFields", {
        pivotId,
        rowFields: [{ table: "Sales", column: "region" }],
        columnFields: [],
        valueFields: [{ measureName: "Revenue" }],
        filterFields: [],
      });
      const all = await eventually(() => pivotRows(page, pivotId), (r) => r["East"] === 30, "precondition: the model pivot did not load");
      console.log(`[W6] unfiltered pivot: ${JSON.stringify(all)}`);

      const slicer = await callModule<{ id: string } | null>(page, SLICER_STORE, "createSlicerAsync", [
        {
          name: "region",
          sheetIndex: 0,
          x: 600,
          y: 40,
          width: 200,
          height: 260,
          sourceType: "biConnection",
          cacheSourceId: conn.connectionId,
          fieldName: "Sales.region",
          connectedSources: [{ sourceType: "biConnection", sourceId: conn.connectionId }],
        },
      ]);
      expect(slicer, "precondition: the model slicer was created").toBeTruthy();
      const items = await eventually(
        () => callModule<Array<{ value: string }> | undefined>(page, SLICER_STORE, "getCachedItems", [slicer!.id]),
        (it) => (it?.length ?? 0) > 0,
        "the model slicer shows no items",
      );
      const values = items!.map((i) => i.value);
      expect(values[values.length - 1], `the list does not end with (blank): ${JSON.stringify(values)}`).toBe("(blank)");
      expect(values.filter((x) => x === "(blank)").length, "(blank) is listed more than once").toBe(1);

      await callModule(page, SLICER_STORE, "updateSlicerSelectionAsync", [slicer!.id, ["East"]]);
      const east = await eventually(() => pivotRows(page, pivotId), (r) => !("West" in r), "selecting East did not filter the pivot");
      expect(Object.keys(east), `East alone still shows the blank row: ${JSON.stringify(east)}`).not.toContain("(blank)");
      await callModule(page, SLICER_STORE, "updateSlicerSelectionAsync", [slicer!.id, ["East", "(blank)"]]);
      const eastBlank = await eventually(() => pivotRows(page, pivotId), (r) => "(blank)" in r, "East + (blank) does not bring the blank row back");
      expect(eastBlank["(blank)"], `the (blank) row's number (X1): ${JSON.stringify(eastBlank)}`).toBe(90);
      expect(eastBlank["East"]).toBe(30);

      // PINNED (filter level 2): the same selections as a model filter.
      await callModule(page, SLICER_STORE, "updateSlicerAsync", [slicer!.id, { filterLevel: 2 }]);
      await callModule(page, SLICER_STORE, "updateSlicerSelectionAsync", [slicer!.id, ["East"]]);
      await callModule(page, SLICER_STORE, "updateSlicerSelectionAsync", [slicer!.id, ["East", "(blank)"]]);
      const pinnedBoth = await eventually(() => pivotRows(page, pivotId), (r) => "(blank)" in r && !("West" in r), "pinned East + (blank) did not filter to East and the blank rows");
      console.log(`[W6] pinned East + (blank): ${JSON.stringify(pinnedBoth)}`);
      const total = pinnedBoth["Grand Total"] ?? pinnedBoth["Total"];
      expect(total, `pinned East + (blank): the total counts East plus the blank rows: ${JSON.stringify(pinnedBoth)}`).toBe(120);
      await callModule(page, SLICER_STORE, "updateSlicerSelectionAsync", [slicer!.id, ["East"]]);
      const pinnedEast = await eventually(() => pivotRows(page, pivotId), (r) => !("(blank)" in r) && !("West" in r), "pinned East did not drop the blank rows");
      expect(pinnedEast["Grand Total"] ?? pinnedEast["Total"], `pinned East alone: ${JSON.stringify(pinnedEast)}`).toBe(30);

    } finally {
      await newFile(page);
      if (conn) {
        await invoke(page, "bi_delete_connection", { connectionId: conn.connectionId }).catch(() => undefined);
        fs.rmSync(conn.dir, { recursive: true, force: true });
      }
    }
  });

  test("W6 (Filter pane + CUBE): the model value list ends with (blank), a year with only blank regions offers only (blank), and CUBEVALUE on '(blank)' reads the blank rows", async ({ appPage: page }) => {
    test.setTimeout(240_000);
    let conn: { connectionId: string; dir: string } | null = null;
    const name = `FixallCube${RUN}`;
    try {
      await newFile(page);
      conn = await blankModel(page, name);
      // The value list every model filter surface reads (Filter pane, CUBE builder, model slicer).
      const values = await invoke<string[]>(page, "bi_get_column_values", { connectionId: conn.connectionId, table: "Sales", column: "region" });
      expect(values[values.length - 1], `the Filter pane's region list does not end with (blank): ${JSON.stringify(values)}`).toBe("(blank)");
      const only2025 = await invoke<string[]>(page, "bi_get_column_available_values", {
        connectionId: conn.connectionId,
        table: "Sales",
        column: "region",
        crossFilters: [{ table: "Sales", column: "year", values: ["2025"] }],
      });
      expect(only2025, "with year 2025 (only blank-region rows), only (blank) has data").toEqual(["(blank)"]);
      const y2023 = await invoke<string[]>(page, "bi_get_column_available_values", {
        connectionId: conn.connectionId, table: "Sales", column: "region", crossFilters: [{ table: "Sales", column: "year", values: ["2023"] }],
      });
      expect(y2023.sort(), "POSITIVE CONTROL: 2023 has East, West and blank rows").toEqual(["(blank)", "East", "West"].sort());

      await setCells(page, 0, [
        ["E20", `=CUBEVALUE("${name}";"[Revenue]";"Sales[region]='(blank)'")`],
        ["E21", `=CUBEVALUE("${name}";"[Revenue]";"Sales[region]='East'")`],
      ]);
      await callModule(page, "/src/core/lib/tauri-api.ts", "recalcWithCube");
      const [blank, east] = await eventually(
        () => readCells(page, 0, ["E20", "E21"]),
        (c) => c[1].display === "30",
        "POSITIVE CONTROL: CUBEVALUE on East did not answer",
        30_000,
      );
      expect(east.display).toBe("30");
      expect(blank.display, `CUBEVALUE on '(blank)' (formula ${blank.formula})`).toBe("90");
    } finally {
      await newFile(page);
      if (conn) {
        await invoke(page, "bi_delete_connection", { connectionId: conn.connectionId }).catch(() => undefined);
        fs.rmSync(conn.dir, { recursive: true, force: true });
      }
    }
  });
});

test.describe("fix-all live: collaboration, the remaining checks", () => {
  test("C2 BUG-0150: a working copy's push preview and merge analysis see the frontend providers' objects, so an untouched one is not 'removed'", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    await installAppImport(page);
    const register = () =>
      page.evaluate(async () => {
        const w = window as unknown as AppWindow & { __fixallC2?: { off: () => void; materialized: string[] } };
        const m = (await w.__appImport!("/src/api/distributableObjects.ts")) as {
          registerDistributableObjectProvider: (p: unknown) => () => void;
        };
        const state = w.__fixallC2 ?? { off: () => undefined, materialized: [] as string[] };
        state.off();
        state.off = m.registerDistributableObjectProvider({
          kind: "e2e.fixallProbe",
          collect: async () => [{ kind: "e2e.fixallProbe", id: "probe-1", name: "Fixall probe", payload: { v: 1 } }],
          materialize: async (objs: Array<{ id: string }>) => {
            state.materialized.push(...objs.map((o) => o.id));
          },
        });
        w.__fixallC2 = state;
      });
    const unregister = () =>
      page.evaluate(() => {
        const w = window as unknown as { __fixallC2?: { off: () => void } };
        w.__fixallC2?.off();
      });
    try {
      await register();
      const app = `fixall-c2-${RUN}`;
      await newFile(page);
      await setCells(page, 0, [["A1", "probe host"]]);
      await publishNew(page, WS, app, "1.0.0");
      await newFile(page);
      await checkout(page, WS, app);
      const materialized = await page.evaluate(() => (window as unknown as { __fixallC2?: { materialized: string[] } }).__fixallC2?.materialized ?? []);
      expect(materialized, "precondition: the checkout handed the object to its provider").toContain("probe-1");

      const d = await pushDiff(page, WS, app);
      expect(d.objects.filter((o) => o.change === "removed"), `the push preview reports a custom object as removed: ${describeDiff(d)}`).toEqual([]);
      expect(diffIsEmpty(d), `the untouched working copy's push preview lists changes: ${describeDiff(d)}`).toBe(true);
      const merge = await callModule<{ analysis: { verdict: string; yourSummary: string[]; theirSummary: string[] } }>(page, COLLAB, "pushMergeAnalyze");
      expect(merge.analysis.yourSummary.filter((s) => /remov/i.test(s)), `the merge analysis says you removed something: ${JSON.stringify(merge.analysis)}`).toEqual([]);

      // POSITIVE CONTROL: without the provider the object IS missing from the working side.
      await unregister();
      const gone = await pushDiff(page, WS, app);
      expect(gone.objects.some((o) => o.change === "removed"), `the diff cannot see custom objects at all: ${describeDiff(gone)}`).toBe(true);
    } finally {
      await unregister();
      await newFile(page);
    }
  });

  test("C4 BUG-0153: a detached sheet's scripted button still runs its own script after a refresh, and its sheet-scoped name stays scoped", async ({ appPage: page, grid }) => {
    test.setTimeout(420_000);
    const app = `fixall-c4-${RUN}`;
    const scriptId = `fixall-c4-script-${RUN}`;
    const nameId = `C4Local${RUN}`;
    const source = (tag: string) => `function setup(button) {\n  button.onClick(() => button.notify("C4-clicked-${tag}", "info"));\n}\n`;
    const previous = await invoke<string>(page, "get_script_security_level").catch(() => "prompt");
    try {
      await invoke(page, "set_script_security_level", { level: "enabled" });
      // ---- publisher: Report with a scripted button and a Report-scoped name.
      await newFile(page);
      await renameSheetByName(page, "Sheet1", "Report");
      const rep = await sheetIndex(page, "Report");
      const btn = await page.evaluate(
        async ({ mod, rep }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            requireButtonControlProvider: () => { createButton: (r: unknown) => Promise<{ instanceId: string; row: number; col: number }> };
          };
          return m.requireButtonControlProvider().createButton({ sheetIndex: rep, row: 1, col: 3, label: "Run" });
        },
        { mod: BUTTONS, rep },
      );
      await invoke(page, "save_object_script", {
        script: { id: scriptId, name: "C4 button", objectType: "button", instanceId: btn.instanceId, source: source("v1"), accessLevel: "restricted", description: null },
      });
      await invoke(page, "create_named_range", { name: nameId, sheetIndex: rep, refersTo: "=Report!$A$1" });
      await publishNew(page, WS, app, "1.0.0");
      const pubFile = file("pub-c4");
      await saveAs(page, pubFile);

      // ---- subscriber: pull, approve the package's scripts, click, detach.
      await newFile(page);
      const pulled = await subscribe(page, WS, app);
      expect(pulled.scriptsPulled, "precondition: the script travelled").toBe(1);
      const allow = page.getByRole("button", { name: /Allow Scripts/ });
      await allow.waitFor({ state: "visible", timeout: 20_000 });
      await allow.click();
      const subRep = await activate(page, "Report");
      const mounted = await eventually(
        () => page.evaluate(async (id) => {
          const m = (await (window as unknown as AppWindow).__appImport!("/src/api/index.ts")) as { ObjectScriptManager: { isScriptMounted: (id: string) => boolean } };
          return m.ObjectScriptManager.isScriptMounted(id);
        }, scriptId),
        (v) => v,
        "the approved package script never mounted",
        15_000,
      ).catch((e) => { console.log(`[C4] ${String(e)}`); return false; });
      const ctrls = await invoke<Array<{ row: number; col: number; metadata: { controlType: string } }>>(page, "get_all_controls", { sheetIndex: subRep });
      console.log(`[C4] mounted=${mounted} controls on Report=${JSON.stringify(ctrls.map((c) => [c.row, c.col, c.metadata.controlType]))} scripts=${JSON.stringify((await invoke<Array<{ id: string; instanceId: string | null }>>(page, "list_object_scripts")).map((x) => [x.id, x.instanceId]))}`);
      const scriptsNow = await invoke<Array<{ id: string; instanceId: string | null }>>(page, "list_object_scripts");
      const bound = scriptsNow.find((s) => s.id === scriptId);
      expect(bound, "precondition: the pulled script is in the workbook").toBeTruthy();
      await page.waitForTimeout(1500);
      await page.evaluate(() => document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click()));
      await page.screenshot({ path: path.join(WORK, "c4-before-click.png") }).catch(() => undefined);
      await grid.clickCell("D2");
      const clicked = await eventually(
        () => page.evaluate(() => Array.from(document.querySelectorAll("[data-toast]")).map((t) => t.textContent ?? "")),
        (t) => t.some((x) => x.includes("C4-clicked-v1")),
        "click",
        15_000,
      ).then(() => true).catch(() => false);
      if (!clicked) {
        // Diagnose: the SCRIPT, reached the way the Controls extension reaches it.
        const design = await callModule<boolean>(page, "/src/api/designMode.ts", "getDesignMode");
        await emitApp(page, "button:clicked", { instanceId: bound!.instanceId, x: 0, y: 0 });
        const viaEvent = await eventually(
          () => page.evaluate(() => Array.from(document.querySelectorAll("[data-toast]")).map((t) => t.textContent ?? "")),
          (t) => t.some((x) => x.includes("C4-clicked-v1")),
          "event",
          8000,
        ).then(() => true).catch(() => false);
        console.log(`[C4] the click ran nothing; designMode=${design}; the script answers button:clicked directly: ${viaEvent}`);
      }
      expect
        .soft(clicked, "PULLED-BUTTON: right after the subscribe the pulled button is not on screen, so a click on it runs nothing")
        .toBe(true);
      // The user's way round it: another tab and back reloads the sheet's controls.
      await page.locator('button[data-sheet-tab="0"]').click();
      await page.waitForTimeout(600);
      await page.locator(`button[data-sheet-tab="${subRep}"]`).click();
      await page.waitForTimeout(1500);
      await page.evaluate(() => document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click()));
      const store = await page.evaluate(async () => {
        const w = window as unknown as AppWindow;
        const fsMod = (await w.__appImport!("/extensions/Controls/lib/floatingStore.ts")) as { getAllFloatingControls: () => unknown[] };
        const gs = (window as unknown as { __CALCULA_GRID_STATE__?: { config?: { activeSheet?: number } } }).__CALCULA_GRID_STATE__;
        return { floating: fsMod.getAllFloatingControls(), gridActive: gs?.config?.activeSheet };
      });
      console.log(`[C4] after the tab switch: ${JSON.stringify(store).slice(0, 800)}`);
      await page.screenshot({ path: path.join(WORK, "c4-after-switch.png") }).catch(() => undefined);
      await grid.clickCell("D2");
      await eventually(
        () => page.evaluate(() => Array.from(document.querySelectorAll("[data-toast]")).map((t) => t.textContent ?? "")),
        (t) => t.some((x) => x.includes("C4-clicked-v1")),
        "POSITIVE CONTROL: after a tab switch, clicking the pulled button did not run its script",
        15_000,
      );
      await detachSheet(page, subRep);
      const scoped0 = await namedRange(page, nameId);
      expect(scoped0?.sheetIndex, "precondition: the pulled name is scoped to Report").toBe(subRep);
      const subFile = file("sub-c4");
      await saveAs(page, subFile);

      // ---- publisher pushes v1.1.0 with a changed script.
      await openAt(page, pubFile);
      await invoke(page, "save_object_script", {
        script: { id: scriptId, name: "C4 button", objectType: "button", instanceId: btn.instanceId, source: source("v2"), accessLevel: "restricted", description: null },
      });
      await setCells(page, await sheetIndex(page, "Report"), [["A5", "v2 content"]]);
      await push(page, WS, app, "1.1.0");

      // ---- subscriber refreshes.
      await openAt(page, subFile);
      const preview = await refreshPreview(page);
      const row = preview.subscriptionPreviews.find((p) => p.packageName === app);
      if (row) await refreshApply(page, preview);
      console.log(`[C4] refresh offered: ${JSON.stringify(row ? { v: row.newVersion } : null)}`);
      const after = await invoke<Array<{ id: string; instanceId: string | null; source?: string }>>(page, "list_object_scripts");
      const kept = after.find((s) => s.instanceId === bound!.instanceId);
      expect(kept, `the detached sheet's control script was orphaned by the refresh: ${JSON.stringify(after.map((s) => [s.id, s.instanceId]))}`).toBeTruthy();
      const scoped = await namedRange(page, nameId);
      expect(scoped, "the sheet-scoped name was lost").toBeTruthy();
      expect(scoped!.sheetIndex, "the sheet-scoped name became workbook-scoped at the refresh").toBe(await sheetIndex(page, "Report"));
      const repNow = await sheetIndex(page, "Report");
      await page.locator('button[data-sheet-tab="0"]').click();
      await page.waitForTimeout(600);
      await page.locator(`button[data-sheet-tab="${repNow}"]`).click();
      await page.waitForTimeout(1500);
      await page.evaluate(() => document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click()));
      await grid.clickCell("D2");
      await eventually(
        () => page.evaluate(() => Array.from(document.querySelectorAll("[data-toast]")).map((t) => t.textContent ?? "")),
        (t) => t.some((x) => x.includes("C4-clicked-v1")),
        "clicking the detached sheet's button no longer runs its (v1) script",
        15_000,
      );
    } finally {
      await invoke(page, "set_script_security_level", { level: previous }).catch(() => undefined);
      await newFile(page);
    }
  });

  test("C8 BUG-0155: File > New without a reload paints nothing of the old document (grid text or canvas pivot), and a checkout's landed sheet paints", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    const inkIn = async (clip: { x: number; y: number; width: number; height: number }) => {
      const [s] = await samplePixelGrids(page, [clip]);
      let dark = 0;
      for (let i = 0; i < s.data.length; i += 4) if (s.data[i] + s.data[i + 1] + s.data[i + 2] < 240) dark++;
      return dark;
    };
    const cellsClip = async () => {
      const geo = await readGridGeometry(page);
      const origin = await page.evaluate(() => {
        const r = (document.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect();
        return { x: r.left, y: r.top };
      });
      return {
        x: Math.round(origin.x + geo.rowHeaderWidth * geo.zoom + 2),
        y: Math.round(origin.y + geo.colHeaderHeight * geo.zoom + 2),
        width: Math.round(3 * geo.defaultCellWidth * geo.zoom - 4),
        height: Math.round(5 * geo.defaultCellHeight * geo.zoom - 4),
      };
    };
    try {
      // Old document: dark text in A1:C5, and a canvas pivot.
      await newFile(page);
      const text: Array<[string, string]> = [];
      for (const r of [1, 2, 3, 4, 5]) for (const c of ["A", "B", "C"]) text.push([`${c}${r}`, "WWWWWWWW"]);
      await setCells(page, 0, text);
      await page.waitForTimeout(800);
      const clip = await cellsClip();
      expect(await inkIn(clip), "POSITIVE CONTROL: the old document's text paints").toBeGreaterThan(200);

      await setCells(page, 0, [["H1", "Item"], ["I1", "Units"], ["H2", "a"], ["I2", "1"], ["H3", "b"], ["I3", "2"]]);
      const canvas = await addCanvas(page);
      await activate(page, canvas.name);
      const view = await callModule<{ pivotId: string }>(page, "/extensions/Pivot/lib/pivot-api.ts", "createPivotTable", [
        { sourceRange: "Sheet1!H1:I3", destinationCell: "A1", sourceSheet: 0, destinationSheet: canvas.index, hasHeaders: true, name: "C8Pivot", canvasFrame: { x: 64, y: 64, width: 320, height: 192, frozenHeaders: true } },
      ]);
      await callModule(page, "/extensions/Pivot/lib/pivot-api.ts", "updatePivotFields", [
        { pivotId: String(view.pivotId), rowFields: [{ sourceIndex: 0, name: "Item" }], valueFields: [{ sourceIndex: 1, name: "Sum of Units", aggregation: "sum" }] },
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      const geo = await readGridGeometry(page);
      const origin = await page.evaluate(() => {
        const r = (document.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect();
        return { x: r.left, y: r.top };
      });
      const boxClip = { x: Math.round(origin.x + 72 * geo.zoom), y: Math.round(origin.y + 72 * geo.zoom), width: Math.round(300 * geo.zoom), height: Math.round(170 * geo.zoom) };
      await eventually(() => inkIn(boxClip), (n) => n > 100, "POSITIVE CONTROL: the canvas pivot does not paint", 15_000);

      // File > New, NO reload: nothing of the old document may paint.
      await newFile(page);
      await page.waitForTimeout(1200);
      expect((await sheets(page)).sheets.length, "precondition: a one-sheet workbook").toBe(1);
      expect(await inkIn(boxClip), "the old canvas pivot still paints over the new workbook").toBe(0);
      expect(await inkIn(await cellsClip()), "the old document's cells still paint on the new Sheet1").toBe(0);

      // A checkout's landed sheet paints its cells.
      const app = `fixall-c8-${RUN}`;
      await setCells(page, 0, text);
      await publishNew(page, WS, app, "1.0.0");
      await newFile(page);
      await checkout(page, WS, app);
      const s = await sheets(page);
      expect(s.activeIndex, "precondition: the checkout landed on the application's sheet").toBe(s.sheets.length - 1);
      await eventually(async () => inkIn(await cellsClip()), (n) => n > 200, "the checked-out sheet's cells do not paint", 15_000);
    } finally {
      await newFile(page);
    }
  });
});

test.describe("fix-all live: the pivot overwrite decline (X7, no change expected)", () => {
  test("X7: a slicer click that would grow a pivot over data, declined at the native prompt, restores the slicer and the pivot with no 'not taken back' toast", async ({ appPage: page }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      await setCells(page, 0, [
        ["A1", "Region"], ["B1", "Sales"],
        ["A2", "East"], ["B2", "1"], ["A3", "East"], ["B3", "2"], ["A4", "West"], ["B4", "3"],
        ["A5", "North"], ["B5", "4"], ["A6", "South"], ["B6", "5"], ["A7", "Central"], ["B7", "6"],
      ]);
      const view = await callModule<{ pivotId: string }>(page, "/extensions/Pivot/lib/pivot-api.ts", "createPivotTable", [
        { sourceRange: "Sheet1!A1:B7", destinationCell: "D1", sourceSheet: 0, destinationSheet: 0, hasHeaders: true, name: "X7Pivot" },
      ]);
      const pivotId = String(view.pivotId);
      await callModule(page, "/extensions/Pivot/lib/pivot-api.ts", "updatePivotFields", [
        { pivotId, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [{ sourceIndex: 1, name: "Sum of Sales", aggregation: "sum" }] },
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      const slicer = await callModule<{ id: string } | null>(page, SLICER_STORE, "createSlicerAsync", [
        { name: "Region", sheetIndex: 0, x: 700, y: 40, width: 180, height: 240, sourceType: "pivot", cacheSourceId: pivotId, fieldName: "Region", connectedSources: [{ sourceType: "pivot", sourceId: pivotId }] },
      ]);
      expect(slicer).toBeTruthy();
      await callModule(page, SLICER_STORE, "updateSlicerSelectionAsync", [slicer!.id, ["East"]]);
      const small = await eventually(() => invoke<Array<{ pivotId: string; endRow: number }>>(page, "get_pivot_regions_for_sheet"), (r) => (r.find((x) => String(x.pivotId) === pivotId)?.endRow ?? 99) <= 4, "precondition: the East-only pivot is small");
      const smallEnd = small.find((x) => String(x.pivotId) === pivotId)!.endRow;
      // The blocker: right below the small pivot, inside what the grown one needs.
      const blockerRow = smallEnd + 2;
      await setCells(page, 0, [[`D${blockerRow + 1}`, "blocker"]]);
      await page.evaluate(() => document.querySelectorAll<HTMLElement>("[data-toast] button").forEach((b) => b.click()));

      // The click STARTS here and is awaited only to the point the request is in flight.
      await installAppImport(page);
      await page.evaluate(
        async ({ mod, id }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { clickSlicerClearFilter: (id: string) => Promise<void> };
          (window as unknown as { __x7Done?: boolean }).__x7Done = false;
          void m.clickSlicerClearFilter(id).finally(() => {
            (window as unknown as { __x7Done?: boolean }).__x7Done = true;
          });
        },
        { mod: SLICER_STORE, id: slicer!.id },
      );
      await page.waitForTimeout(300);
      const verdict = answerNative({ action: "button", label: "Cancel" });
      console.log(`[X7] native prompt: ${verdict}`);
      expect(verdict, "no 'overwrite existing data?' prompt appeared").toMatch(/CLICKED:Cancel/);
      await eventually(() => page.evaluate(() => (window as unknown as { __x7Done?: boolean }).__x7Done === true), (d) => d, "the declined click never finished", 20_000);
      await page.waitForTimeout(800);

      expect((await readCell(page, 0, `D${blockerRow + 1}`)).display, "the declined overwrite destroyed the data").toBe("blocker");
      const sl = (await callModule<Array<{ id: string; selectedItems: string[] | null }>>(page, SLICER_STORE, "getAllSlicers")).find((x) => x.id === slicer!.id);
      expect(sl?.selectedItems, "the slicer did not return to East").toEqual(["East"]);
      const region = (await invoke<Array<{ pivotId: string; endRow: number }>>(page, "get_pivot_regions_for_sheet")).find((x) => String(x.pivotId) === pivotId);
      expect(region?.endRow, "the pivot did not return to its East-only size").toBe(smallEnd);
      const toasts = await page.evaluate(() => Array.from(document.querySelectorAll("[data-toast]")).map((t) => t.textContent ?? ""));
      expect(toasts.filter((t) => /not taken back|could not be taken back/i.test(t)), `a 'not taken back' toast appeared: ${JSON.stringify(toasts)}`).toEqual([]);
    } finally {
      answerNative({ action: "button", label: "Cancel" }, 1500);
      await newFile(page);
    }
  });
});

test.describe("fix-all live: a refused undo in the command line (X10)", () => {
  test("X10 (refused undo): 'undo' typed while a model slicer's filter is still being applied prints the refusal sentence in red", async ({ appPage: page }) => {
    test.setTimeout(420_000);
    let dir: string | null = null;
    let connectionId: string | null = null;
    try {
      await newFile(page);
      // A model big enough that its re-query outlasts a keystroke in this debug build.
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-fixall-slow-"));
      const regions = ["East", "West", "North", "South", "Central", "Nordics", "Iberia", "Alps"];
      const lines = ["region,year,revenue"];
      for (let i = 0; i < 600_000; i++) lines.push(`${regions[i % regions.length]},${2015 + (i % 10)},${(i % 97) + 1}`);
      fs.writeFileSync(path.join(dir, "Sales.csv"), lines.join("\n") + "\n", "utf8");
      const model = {
        format_version: 28,
        model_name: `FixallSlow${RUN}`,
        model_description: "",
        tables: [
          {
            name: "Sales",
            columns: [
              { name: "region", data_type: "String", nullable: true },
              { name: "year", data_type: "Int64", nullable: false },
              { name: "revenue", data_type: "Float64", nullable: false },
            ],
            storage_mode: "in_memory",
            source_binding: { source_id: "slow_csv", schema: "csv", table: "Sales" },
          },
        ],
        relationships: [],
        measures: [
          {
            name: "Revenue",
            expression: { Aggregate: { operation: "Sum", operand: { QualifiedColumnRef: { table_or_var: "Sales", column: "revenue" } } } },
            source: "SUM(Sales[revenue])",
            format_string: "#,##0",
          },
        ],
        calculated_columns: [],
        measure_groups: [],
        hierarchies: [],
        kpis: [],
        sources: [{ id: "slow_csv", kind: "csv", connection: { database: dir, default_schema: "csv" }, preferred_auth: "integrated", display_name: "Slow (CSV)" }],
      };
      const info = await invoke<{ id: string }>(page, "bi_create_connection", {
        request: { name: `FixallSlow${RUN}`, description: null, connectionString: "", modelJson: { formatVersion: 1, model } },
      });
      connectionId = String(info.id);
      await invoke(page, "bi_model_connect_source", { connectionId, sourceId: "slow_csv", connectionString: "", remember: false });
      const v = await pivotApi<{ pivotId: string }>(page, "createFromBiModel", { destinationSheet: 0, connectionId, destinationCell: "B2" });
      const pivotId = String(v.pivotId);
      await pivotApi(page, "updateBiFields", { pivotId, rowFields: [{ table: "Sales", column: "year" }], columnFields: [], valueFields: [{ measureName: "Revenue" }], filterFields: [] });
      await eventually(() => pivotRows(page, pivotId), (r) => Object.keys(r).length >= 10, "precondition: the slow model pivot did not load", 120_000);
      const slicer = await callModule<{ id: string } | null>(page, SLICER_STORE, "createSlicerAsync", [
        {
          name: "region",
          sheetIndex: 0,
          x: 600,
          y: 40,
          width: 200,
          height: 260,
          sourceType: "biConnection",
          cacheSourceId: connectionId,
          fieldName: "Sales.region",
          connectedSources: [{ sourceType: "biConnection", sourceId: connectionId }],
        },
      ]);
      expect(slicer, "precondition: the model slicer was created").toBeTruthy();

      const panel = await openCli(page);
      const selections: string[][] = [["East"], ["West"], ["North"], ["South"]];
      let refusal: { text: string; color: string } | null = null;
      const seen: string[] = [];
      for (const sel of selections) {
        const before = (await cliEntries(panel)).length;
        await panel.locator(".monaco-editor").first().click();
        await page.keyboard.press("Control+a");
        await page.keyboard.press("Delete");
        await page.keyboard.type("undo", { delay: 10 });
        // Start the slicer change (a model re-query) and, while it is in flight,
        // press Enter at the prompt: the undo must be refused, in red.
        await installAppImport(page);
        await page.evaluate(
          async ({ mod, id, sel }) => {
            const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { updateSlicerSelectionAsync: (id: string, s: string[]) => Promise<unknown> };
            void m.updateSlicerSelectionAsync(id, sel);
          },
          { mod: SLICER_STORE, id: slicer!.id, sel },
        );
        await page.keyboard.press("Control+Enter");
        const out = await eventually(() => cliEntries(panel), (e) => e.length >= before + 2, "the command line printed nothing for 'undo'", 30_000);
        const printed = out.slice(before + 1);
        seen.push(...printed.map((e) => `${e.text} [${e.color}]`));
        refusal = printed.find((e) => /still being applied/i.test(e.text)) ?? null;
        await page.waitForTimeout(4000);
        if (refusal) break;
      }
      console.log(`[X10 refused] printed: ${JSON.stringify(seen)}`);
      expect(refusal, `the in-flight window was never hit or the refusal was not printed: ${JSON.stringify(seen)}`).not.toBeNull();
      expect(isRed(refusal!.color), `the refusal is not printed as an error (red): ${refusal!.color}`).toBe(true);
    } finally {
      await closeCli(page);
      await newFile(page);
      if (connectionId) await invoke(page, "bi_delete_connection", { connectionId }).catch(() => undefined);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Answer the native prompt titled "Calcula" from outside the app (e2e/answer-native-dialog.ps1). */
function answerNative(how: { action: "button"; label: string }, waitMs = 20_000): string {
  const driver = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "answer-native-dialog.ps1");
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver, "-TitleLike", "Calcula", "-Action", how.action, "-Button", how.label, "-TimeoutMs", String(waitMs)],
      { encoding: "utf-8", timeout: waitMs + 30_000 },
    )
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" | ");
  } catch (e) {
    return `DRIVERERROR:${String(e)}`;
  }
}

// Keep the imports honest while later blocks are added.
void tryInvoke;
void workingCopy;
