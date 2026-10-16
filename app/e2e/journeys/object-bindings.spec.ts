/**
 * OBJECT PROPERTY BINDINGS (D-BIND, F6), LIVE -- WP-D S12.
 *
 * The owner's sentence: "EVERY property dynamic: reachable by API and Scripts,
 * able to reference grid cells AND model measures, stored so AI can read and
 * edit easily." WP-D built it as ONE Rust-owned store (`bindings.json`, .cala
 * v10) of `{object:{kind,id}, path, formula, model?}` rows: a literal stays in
 * the object's own record, a binding is an overlay Rust evaluates (cells,
 * names, `[Measure]` refs of the page's model under the page's slicers,
 * literal CUBE calls) and announces on `object-bindings:changed`. Every unit
 * tier proved its part with the other parts doubled; this journey drives the
 * whole thing against the REAL backend, the REAL model and the REAL UI.
 *
 * THE FIXTURE IS THE OWNER'S OWN MODEL. C:\Dropbox\Projekt\Calcula\
 * context_manager\model.json against Postgres AdventureWorks on
 * localhost:5432 (postgres/postgres), through helpers/adventureworks-live.ts.
 * An unreachable server FAILS B1 with that helper's sentence -- never a skip.
 * Measures `Revenue` (#,##0) and `% Revenue of Total` (0.0%); the page filter
 * is `BI.dim_territory.territorygroup`.
 *
 * ORACLES ARE NEVER TYPED IN. ORACLE_TOTAL / ORACLE_EUROPE come from
 * `run_design_query` (an independent caller of the engine, with and without
 * the page filter), and the total is cross-checked by a worksheet
 * `=CUBEVALUE("AW bindings";"[Revenue]")` cell. A formatted number is compared
 * by its DIGITS (`digitsOf`), because the owner's sv-SE locale groups
 * thousands with a (narrow) no-break space the test does not need to spell.
 *
 * ONE WORKBOOK, SERIAL. B1..B12 share the workbook B1 builds (Inputs, the canvas
 * "Report" with a Card, a model slicer, a KPI and a shape); B13 starts a fresh
 * one. A failure stops the chain (`mode: "serial"`), so no later step can pass
 * on a state an earlier step never reached.
 *
 * WHAT IS ASSERTED. Backend state (`object_bindings` list / resolved values,
 * persisted charts and controls, the undo stack, the dirty flag, the audit
 * log, the saved archive's bytes), the DOM (the in-place title editor, the
 * Properties pane's fx fields, the Bound Properties view), and what the
 * painters actually WROTE (helpers/chart-paint.ts `fillText` recorder). Never
 * a golden (R14: the goldens are stale by owner decision).
 *
 * LOCALE. sv-SE: a formula a PERSON types uses ';' between arguments and ','
 * for decimals (B2 types `TEXT([Revenue];"#,##0")`, B4 types `1,1`); scripts
 * and the AI write INVARIANT (`,`), and Rust stores the invariant spelling.
 *
 * THE TRIGGER IS ALWAYS AN ANNOUNCING DOOR (D §8 risk 1). A raw
 * `invoke("update_cell")` announces nothing and writes the ACTIVE sheet (here
 * the canvas); no step uses one as its trigger. B4 proves the user's door
 * (typing in the grid -> Core's CELLS_UPDATED) and a backend door (the AI's
 * `set_cell_value` -> `grid:refresh`).
 *
 * RUN NOTES FOR THE PROOF PHASE (CLAUDE.md "a sabotage that is a no-op
 * passes"). B3's dirty / undo assertions must be shown to have teeth ONCE, live:
 * temporarily construct `DocumentEffect::mutates(&file_state)` in the
 * `SetPageFilters` arm of `object_bindings::handle_request_async`
 * (app/src-tauri/src/object_bindings/mod.rs), rebuild, confirm B3 FAILS on
 * "SetPageFilters dirtied the document", revert, rebuild, confirm it passes.
 * This file was WRITTEN in WP-D S12 without being run (implementation steps
 * never run E2E, R12); the proof phase runs it with E2E_MANUAL=1 after a fresh
 * `tauri` build.
 *
 * B14 (the ported journeys) lives in the files it ports:
 * `journeys/fixall-calp.spec.ts` (the button's text binding through push,
 * pull, rename and delete), `tests/scriptable-shapes.spec.ts` (every shape
 * property formula is a binding now), and `journeys/chart-interaction.spec.ts`
 * (the cell-linked title is a binding now). Run all three live beside this one.
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
  barSpec,
  bounded,
  callModule,
  chartData,
  clickCanvasControl,
  clickObject,
  clickSheetTab,
  closeCanvasFlyouts,
  createChart,
  createShape,
  dismissToasts,
  eventually,
  freeCanvasRect,
  gridKey,
  installAppImport,
  invoke,
  isDirty,
  newFile,
  objects,
  openFileAtPath,
  persistedCharts,
  seedSheet1,
  sheetPointToPage,
  sheetsResult,
  type AppWindow,
  type SheetRow,
} from "../helpers/canvas-live";
import { readCell, renameSheetByName, setCells } from "../helpers/calp-harness";
import { connectAdventureWorks, dropAdventureWorks, type AwConnection } from "../helpers/adventureworks-live";
import { cachedData, recordedTexts, startTextRecorder } from "../helpers/chart-paint";
import { clickMenuPath } from "../helpers/life-lifecycle";
import { showPropertiesTabIfPresent } from "../helpers/object-pane";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `@api/objectBindings` -- the seam every family, pane and script goes through. */
const SEAM = "/src/api/objectBindings/index.ts";
/** The seam's bridge (the page-filter snapshot it mirrors to Rust). */
const BRIDGE = "/src/api/objectBindings/bridge.ts";
/** The chart text editor (its binding writes are queued; this awaits the queue). */
const CHART_TEXT_EDITING = "/extensions/Charts/handlers/chartTextEditing.ts";
/** The script host (the restricted-tier clamp sentence lives here, word for word Rust's). */
const SCRIPT_HOST = "/src/api/scriptHost/host.ts";
/** The `@api` facade (script manager, grants, exposed methods). */
const API = "/src/api/index.ts";

const RANGE_INPUT = 'input[placeholder="e.g., Sheet1!A1:D10"]';
const WORK = path.join(os.tmpdir(), "calcula-object-bindings");
const FILE_PRE_BIND = path.join(WORK, "b2-before-bind.cala");
const FILE_CLEAN = path.join(WORK, "b3-clean.cala");
const FILE_V10 = path.join(WORK, "b11-bindings.cala");
const FILE_NO_CHART = path.join(WORK, "b13-no-chart.cala");
const FILE_ONE_CHART = path.join(WORK, "b13-one-chart.cala");

const CONNECTION_NAME = "AW bindings";
const TERRITORY = { table: "BI.dim_territory", column: "territorygroup" };
const EUROPE = "Europe";

/** The Card's LITERAL title (B1); the binding overlays it and must never overwrite it. */
const CARD_TITLE = "Revenue card";
/** What the person types into the title, in their locale (sv-SE). */
const TITLE_TYPED = '=Inputs!B1&TEXT([Revenue];"#,##0")';
/** What Rust stores: invariant, sheet-qualified, `[Revenue]` a measure of the page's model. */
const TITLE_INVARIANT = '=Inputs!B1&TEXT([Revenue],"#,##0")';
const GOAL_FORMULA = "=[Revenue]*Inputs!B2";
const SHAPE_TEXT_FORMULA = '="Region: "&Inputs!B1';
const SHAPE_FILL_FORMULA = "=Inputs!B3";
const TOOLTIP_FORMULA = "=[% Revenue of Total]";
const FILL_COLOUR = "#2F6FDE";

// ---------------------------------------------------------------------------
// Wire shapes (mirrors of app/src/api/types.ts, read-only here)
// ---------------------------------------------------------------------------

interface Ref {
  kind: string;
  id: string;
}

interface Resolved {
  object: Ref;
  path: string;
  value: unknown;
  display: string;
  error: string | null;
  pending: boolean;
}

interface BindingInfo {
  object: Ref;
  path: string;
  formula: string;
  displayFormula: string;
  model: string | null;
  resolved: Resolved | null;
}

interface ModelMeasures {
  modelKey: string;
  connectionId: string;
  name: string;
  measures: string[];
  isDefault: boolean;
}

interface UndoInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoDescription: string | null;
  redoDescription: string | null;
  undoDepth: number;
}

// ---------------------------------------------------------------------------
// Shared state (one workbook, built by B1)
// ---------------------------------------------------------------------------

let conn: AwConnection | null = null;
let previousSecurityLevel = "prompt";
let inputsIndex = -1;
let reportIndex = -1;
let ORACLE_TOTAL = Number.NaN;
let ORACLE_EUROPE = Number.NaN;
let cardId = "";
let kpiId = "";
let slicerId = "";
let modelKey = "";
let shape: { instanceId: string; row: number; col: number; x: number; y: number; uid: string } | null = null;
let scriptId: string | null = null;

const cardRef = (): Ref => ({ kind: "chart", id: cardId });
const kpiRef = (): Ref => ({ kind: "chart", id: kpiId });
const shapeRef = (): Ref => ({ kind: "control", id: shape!.uid });
const keyOf = (o: Ref, p: string): string => `${o.kind}:${o.id} ${p}`;

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** Only the digits of a display: what a formatted number says, whatever the grouping. */
function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

/** The digits `TEXT(x;"#,##0")` writes for a positive x. */
function roundedDigits(x: number): string {
  return String(Math.round(x));
}

/** A display in the user's locale as a number (sv-SE: `1 234,5`). */
function parseLocaleNumber(text: string): number {
  const cleaned = text.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  return cleaned === "" ? Number.NaN : Number(cleaned);
}

function near(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 0.01 + 1e-9 * Math.abs(expected);
}

// ---------------------------------------------------------------------------
// Backend and seam reads
// ---------------------------------------------------------------------------

/**
 * A backend call that may legitimately take long (a model connect, a query, an AI
 * tool that runs the measure pass). Named `invokeBackend` so the command-name
 * census (src/api/__tests__/backendCommandDrift.test.ts) reads its call sites:
 * it matches `invoke(page, "x")` and `invokeBackend(page, "x")`, nothing else.
 */
async function invokeBackend<T = unknown>(page: Page, cmd: string, args: unknown, ms = 180_000): Promise<T> {
  return bounded(
    `invoke ${cmd}`,
    page.evaluate(async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a), { c: cmd, a: args }) as Promise<T>,
    ms,
  );
}

/** One op of the ONE `object_bindings` command (the runtime-only ops are driven this way in B3). */
async function bindingsOp<T = Record<string, unknown>>(page: Page, request: Record<string, unknown>): Promise<T> {
  return invokeBackend<T>(page, "object_bindings", { request }, 120_000);
}

/** Every binding as RUST holds it right now (with its current resolved value). */
async function backendBindings(page: Page, object: Ref | null = null): Promise<BindingInfo[]> {
  const r = await bindingsOp<{ kind: string; bindings?: BindingInfo[] }>(page, { op: "list", object });
  if (r.kind !== "bindings" || !Array.isArray(r.bindings)) throw new Error(`object_bindings list answered ${JSON.stringify(r).slice(0, 300)}`);
  return r.bindings;
}

async function backendBinding(page: Page, object: Ref, p: string): Promise<BindingInfo | null> {
  return (await backendBindings(page, object)).find((b) => b.path === p) ?? null;
}

/** The seam's CACHE (what every painter and pane reads, synchronously). */
async function seamBinding(page: Page, object: Ref, p: string): Promise<BindingInfo | null> {
  return callModule<BindingInfo | null>(page, SEAM, "getBinding", [object, p]);
}

async function seamResolved(page: Page, object: Ref, p: string): Promise<Resolved | null> {
  return callModule<Resolved | null>(page, SEAM, "getResolved", [object, p]);
}

async function undoInfo(page: Page): Promise<UndoInfo> {
  return invoke<UndoInfo>(page, "get_undo_state");
}

/** An exported VALUE (not a function) of an app module, from the instance the app loaded. */
async function moduleValue<T>(page: Page, mod: string, name: string): Promise<T> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod, name }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as Record<string, unknown>;
      if (!(name in m)) throw new Error(`${mod} exports no ${name}`);
      return m[name];
    },
    { mod, name },
  ) as Promise<T>;
}

async function controlMeta(
  page: Page,
  sheetIndex: number,
  row: number,
  col: number,
): Promise<{ uid?: string; controlType: string; properties: Record<string, { valueType: string; value: string }> } | null> {
  return invoke(page, "get_control_metadata", { sheetIndex, row, col });
}

async function resolvedControl(page: Page, sheetIndex: number, row: number, col: number): Promise<Record<string, string>> {
  return invoke<Record<string, string>>(page, "resolve_control_properties", { sheetIndex, row, col });
}

// ---------------------------------------------------------------------------
// The oracle: the model's own answer, by an independent caller
// ---------------------------------------------------------------------------

/** The measure value of a measure-only design-query view (its grand total). */
function measureOfView(view: unknown): number {
  const rows = ((view as { rows?: Array<{ cells?: Array<{ cellType?: string; value?: unknown }> }> }).rows ?? []);
  const of = (type: string): number[] =>
    rows.flatMap((r) => (r.cells ?? []).filter((c) => c.cellType === type && typeof c.value === "number").map((c) => c.value as number));
  const grand = of("GrandTotal");
  if (grand.length > 0) return grand[grand.length - 1];
  const data = of("Data");
  if (data.length > 0) return data[0];
  throw new Error(`the design-query view carries no measure value: ${JSON.stringify(view).slice(0, 600)}`);
}

/** `[Revenue]` of the whole model, or under `territorygroup IN (items)`. */
async function oracleRevenue(page: Page, connectionId: string, items: string[] | null): Promise<number> {
  const view = await invokeBackend(page, "run_design_query", {
    request: {
      connectionId,
      rowFields: [],
      columnFields: [],
      valueFields: [{ measureName: "Revenue" }],
      filterFields: [],
      pageFilterFields: items ? [{ table: TERRITORY.table, column: TERRITORY.column, includedItems: items }] : [],
    },
  });
  return measureOfView(view);
}

// ---------------------------------------------------------------------------
// Product routes
// ---------------------------------------------------------------------------

/** Visuals > <visual> > Design query `VALUES: [Revenue]` > Insert Chart (P5's UI path); returns the new chart id. */
async function insertDesignQueryVisual(page: Page, controlTestId: string, connectionId: string): Promise<string> {
  const before = (await persistedCharts(page)).map((c) => c.id);
  await clickCanvasControl(page, controlTestId);
  await expect(page.locator(RANGE_INPUT), `${controlTestId} opened no Create Chart dialog`).toBeVisible({ timeout: 8000 });
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
  const after = await eventually(() => persistedCharts(page), (cs) => cs.length === before.length + 1, `${controlTestId}: the design-query visual was not inserted`, 30_000);
  return after.find((c) => !before.includes(c.id))!.id;
}

/** Visuals > Slicer, the model option, the territorygroup field (the Insert Slicers dialog). */
async function insertModelSlicer(page: Page): Promise<string> {
  await clickCanvasControl(page, "canvas-insert-slicer");
  const dialog = page.locator("h2", { hasText: "Insert Slicers" }).locator("xpath=../..");
  await expect(dialog, "the Insert Slicers dialog did not open").toBeVisible({ timeout: 8000 });
  const modelOption = await eventually(
    () =>
      dialog.locator("select option").evaluateAll((opts, name) => {
        const all = opts.map((o) => ({ value: (o as HTMLOptionElement).value, label: (o.textContent ?? "").trim() }));
        return all.find((o) => o.label.endsWith("(Model)") && o.label.includes(name)) ?? all.find((o) => o.label.endsWith("(Model)"));
      }, CONNECTION_NAME),
    (o) => !!o,
    "the Insert Slicers dialog does not list the AdventureWorks model",
    20_000,
  );
  await dialog.locator("select").first().selectOption(modelOption!.value);
  const field = dialog.locator("label", { hasText: TERRITORY.column }).locator('input[type="checkbox"]').first();
  await expect(field, `the model's ${TERRITORY.column} field is not offered`).toBeVisible({ timeout: 15_000 });
  await field.check();
  await dialog.getByRole("button", { name: "OK" }).click();
  type SlicerRow = { id: string; sheetIndex: number; sourceType: string };
  const slicers = await eventually(
    () => callModule<SlicerRow[]>(page, MOD.SLICER_STORE, "getAllSlicers", []),
    (s) => s.some((x) => x.sourceType === "biConnection" && x.sheetIndex === reportIndex),
    "no model slicer was created on the canvas",
    20_000,
  );
  return slicers.find((x) => x.sourceType === "biConnection" && x.sheetIndex === reportIndex)!.id;
}

/** Turn fx on for one Properties-pane row, type `formula` (the user's locale) and commit with Enter. */
async function bindInPane(page: Page, key: string, formula: string): Promise<void> {
  const row = page.locator(`[data-testid="control-prop-${key}"]`);
  await expect(row, `the Properties pane has no ${key} row`).toBeVisible({ timeout: 10_000 });
  const field = row.locator(`[data-bindable-field="/properties/${key}"]`);
  await expect(field, `the ${key} row offers no fx (BindableField)`).toHaveCount(1);
  await field.locator("[data-bindable-fx]").click();
  const input = field.locator("[data-binding-formula-input]");
  await expect(input, `fx on ${key} opened no formula editor`).toBeVisible({ timeout: 5000 });
  await input.click();
  await input.fill(formula);
  await page.waitForTimeout(400);
  // The formula autocomplete owns Enter while its list is up: close it first,
  // so Enter COMMITS rather than accepting a suggestion.
  const dropdown = page.locator('[data-testid="formula-autocomplete"]');
  for (let i = 0; i < 3 && (await dropdown.isVisible().catch(() => false)); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
  await expect(input, `closing the suggestions cancelled the ${key} edit`).toHaveValue(formula);
  await page.keyboard.press("Enter");
  await expect(field, `the ${key} field did not become bound`).toHaveAttribute("data-bound", "true", { timeout: 15_000 });
}

/** Mount an object script on the shape (script-form.spec.ts's route): register, grant, mount, wait for its methods. */
async function mountShapeScript(page: Page, def: { id: string; name: string; instanceId: string; source: string; accessLevel: "restricted" | "unlocked"; declaredCapabilities: string[] }, exposes: string[]): Promise<void> {
  await installAppImport(page);
  const outcome = await bounded(
    "mount the shape script",
    page.evaluate(
      async ({ def, exposes, api }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(api)) as {
          ObjectScriptManager: { registerScript: (d: unknown) => void; mountScript: (id: string) => Promise<void>; isScriptMounted: (id: string) => boolean };
          recordCapabilityGrant: (scriptId: string, cap: string) => void;
          listExposedMethods: () => Array<{ objectType: string; instanceId: string | null; methodName: string }>;
        };
        m.ObjectScriptManager.registerScript({ ...def, objectType: "shape", description: null });
        for (const cap of def.declaredCapabilities) m.recordCapabilityGrant(def.id, cap);
        let mountError = "";
        try {
          await m.ObjectScriptManager.mountScript(def.id);
        } catch (e) {
          mountError = e instanceof Error ? e.message : String(e);
        }
        const t0 = Date.now();
        while (Date.now() - t0 < 15_000) {
          const listed = m.listExposedMethods();
          if (exposes.every((name) => listed.some((e) => e.objectType === "shape" && e.instanceId === def.instanceId && e.methodName === name))) {
            return { ok: true, mountError };
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        return { ok: false, mountError };
      },
      { def, exposes, api: API },
    ),
    40_000,
  );
  expect(outcome.ok, `the shape script never exposed ${exposes.join(", ")}${outcome.mountError ? ` (mount said: ${outcome.mountError})` : ""}`).toBe(true);
}

async function unmountScript(page: Page, id: string): Promise<void> {
  await page
    .evaluate(
      async ({ id, api }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(api)) as {
          ObjectScriptManager: { unmountScript: (id: string) => void; removeScript: (id: string) => void };
        };
        try {
          m.ObjectScriptManager.unmountScript(id);
        } catch {
          /* not mounted */
        }
        try {
          m.ObjectScriptManager.removeScript(id);
        } catch {
          /* already gone */
        }
      },
      { id, api: API },
    )
    .catch(() => undefined);
}

async function callShapeMethod<T>(page: Page, instanceId: string, method: string): Promise<T> {
  return bounded(
    `shape.${method}`,
    page.evaluate(
      async ({ instanceId, method, api }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(api)) as {
          callExposedMethod: (t: string, i: string | null, n: string, ...a: unknown[]) => unknown;
        };
        return (await m.callExposedMethod("shape", instanceId, method)) as unknown;
      },
      { instanceId, method, api: API },
    ) as Promise<T>,
    60_000,
  );
}

async function aiTool(page: Page, name: string, input: Record<string, unknown>): Promise<string> {
  return invokeBackend<string>(page, "ai_chat_run_tool", { name, input }, 180_000);
}

/** The archive's entries as text (fflate, like canvas-page-navigator.spec.ts). */
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

/** `{key -> display}` of every binding, once none is pending (the comparison base of B9 / B11). */
async function settledDisplays(page: Page, label: string, timeoutMs = 60_000): Promise<Record<string, string>> {
  const all = await eventually(
    () => backendBindings(page),
    (bs) => bs.length > 0 && bs.every((b) => b.resolved !== null && !b.resolved.pending),
    `${label}: some binding is still unresolved or pending`,
    timeoutMs,
  );
  const out: Record<string, string> = {};
  for (const b of all) out[keyOf(b.object, b.path)] = b.resolved!.display;
  return out;
}

/** The five bindings this journey makes, as the formulas Rust must hold after `sheet`/row shift. */
function expectedFormulas(sheet: string, shift: number): Record<string, string> {
  const r = (n: number) => `B${n + shift}`;
  return {
    [keyOf(cardRef(), "/spec/title")]: `=${sheet}!${r(1)}&TEXT([Revenue],"#,##0")`,
    [keyOf(kpiRef(), "/spec/markOptions/goal")]: `=[Revenue]*${sheet}!${r(2)}`,
    [keyOf(shapeRef(), "/properties/text")]: `="Region: "&${sheet}!${r(1)}`,
    [keyOf(shapeRef(), "/properties/fill")]: `=${sheet}!${r(3)}`,
    [keyOf(shapeRef(), "/properties/tooltip")]: TOOLTIP_FORMULA,
  };
}

/** A `{key -> text}` map as one comparable string, whatever order its keys came in. */
function canonical(map: Record<string, string>): string {
  return JSON.stringify(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The published region of the shape (Core's floating region, by its stored position). */
async function shapeObject(page: Page) {
  const at = (o: { type: string; x: number; y: number }) => o.type === "floating-control" && Math.abs(o.x - shape!.x) < 1 && Math.abs(o.y - shape!.y) < 1;
  const all = await eventually(() => objects(page), (os) => os.some(at), "the shape is not published on the canvas");
  return all.find(at)!;
}

async function formulasNow(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const b of await backendBindings(page)) out[keyOf(b.object, b.path)] = b.formula;
  return out;
}

async function cleanupUi(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await closeCanvasFlyouts(page).catch(() => undefined);
  await dismissToasts(page).catch(() => undefined);
}

// ===========================================================================

test.describe("Object property bindings (D-BIND), live", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test.beforeAll(async ({ sharedPage: page }) => {
    test.setTimeout(120_000);
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    await installAppImport(page);
    previousSecurityLevel = await invoke<string>(page, "get_script_security_level").catch(() => "prompt");
    // The AI tools (B4, B7) and the object script (B6) need script execution;
    // "enabled" keeps the OTHER consent gate out of every assertion here.
    await invoke(page, "set_script_security_level", { level: "enabled" });
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]).catch(() => undefined);
  });

  test.afterAll(async ({ sharedPage: page }) => {
    if (scriptId) await unmountScript(page, scriptId);
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]).catch(() => undefined);
    await newFile(page).catch(() => undefined);
    await dropAdventureWorks(page, conn);
    // A reopen may have re-created the connection from the file: drop every one of this journey's name.
    const conns = await invoke<Array<{ id: string; name: string }>>(page, "bi_get_connections").catch(() => []);
    for (const c of conns) {
      if (c.name === CONNECTION_NAME) await invoke(page, "bi_delete_connection", { connectionId: c.id }).catch(() => undefined);
    }
    await invoke(page, "set_script_security_level", { level: previousSecurityLevel }).catch(() => undefined);
    fs.rmSync(WORK, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  test("B1 setup: Inputs, the AdventureWorks model, a canvas with a measure Card (Visuals > Card > Design query) and a territorygroup model slicer; the Card and a CUBEVALUE cell both equal the oracle", async ({ appPage: page }) => {
    await newFile(page);
    await renameSheetByName(page, "Sheet1", "Inputs");
    inputsIndex = (await sheetsResult(page)).sheets.find((s) => s.name === "Inputs")!.index;
    await setCells(page, inputsIndex, [
      ["B1", "Revenue "],
      ["B2", "=9/10"],
      ["B3", FILL_COLOUR],
    ]);
    expect((await readCell(page, inputsIndex, "B2")).display, "precondition: Inputs!B2 is 0,9").toMatch(/^0[,.]9$/);

    conn = await connectAdventureWorks(page, CONNECTION_NAME);
    ORACLE_TOTAL = await oracleRevenue(page, conn.connectionId, null);
    ORACLE_EUROPE = await oracleRevenue(page, conn.connectionId, [EUROPE]);
    console.log(`[object-bindings] ORACLE_TOTAL=${ORACLE_TOTAL} ORACLE_EUROPE=${ORACLE_EUROPE}`);
    expect(ORACLE_TOTAL > 0, "the model answered no Revenue").toBe(true);
    expect(ORACLE_EUROPE > 0 && ORACLE_EUROPE < ORACLE_TOTAL, "the Europe filter did not narrow Revenue: every later 'it refiltered' would be vacuous").toBe(true);
    expect(roundedDigits(ORACLE_EUROPE), "the two oracles format alike: a digits comparison could not tell them apart").not.toBe(roundedDigits(ORACLE_TOTAL));

    // The cross-check: the same measure through a worksheet CUBE cell.
    await setCells(page, inputsIndex, [["D1", `=CUBEVALUE("${CONNECTION_NAME}";"[Revenue]")`]]);
    // setCells writes through @api CellRange.setValue (updateCellsBatch), which
    // runs no cube prefetch (BUG-0476, pre-existing): force the cube round trip,
    // the route fixall-calp W6 uses. The oracle comparison itself is unchanged.
    await callModule(page, MOD.TAURI_API, "recalcWithCube");
    await eventually(
      async () => parseLocaleNumber((await readCell(page, inputsIndex, "D1")).display),
      (v) => near(v, ORACLE_TOTAL),
      `=CUBEVALUE("${CONNECTION_NAME}";"[Revenue]") never showed the oracle ${ORACLE_TOTAL}`,
      90_000,
    );

    // ---- The canvas "Report".
    const canvas = await addCanvas(page);
    await renameSheetByName(page, canvas.name, "Report");
    reportIndex = canvas.index;

    // ---- Visuals > Card > Design query VALUES: [Revenue].
    cardId = await insertDesignQueryVisual(page, "canvas-visual-card", conn.connectionId);
    const card = (await persistedCharts(page)).find((c) => c.id === cardId)!;
    expect(card.spec.mark, "Visuals > Card inserted no card").toBe("card");
    expect(card.spec.data, "the Card's source is the measure-only query").toMatchObject({ type: "designQuery", dslText: "VALUES: [Revenue]", connectionId: conn.connectionId });
    expect(card.sheetIndex, "the Card did not land on the canvas").toBe(reportIndex);
    await eventually(
      () => cachedData(page, cardId),
      (d) => !!d && near(d.series[0]?.values[0] ?? Number.NaN, ORACLE_TOTAL),
      `the Card never showed the oracle ${ORACLE_TOTAL}`,
      60_000,
    );

    // ---- A LITERAL title through the chart store (the Design panel's route):
    //      the binding in B2 overlays it, and must leave it alone.
    //      The store's updateChartSpec only merges and persists; the Design
    //      panel's `updateSpec` (ChartDesignSections.tsx) then invalidates the
    //      render, re-syncs the regions and announces the change -- the same
    //      four steps here, or the Card never re-lays-out with its title.
    await callModule(page, MOD.CHART_STORE, "updateChartSpec", [cardId, { title: CARD_TITLE }]);
    await callModule(page, MOD.CHART_RENDERER, "invalidateChartCache", [cardId]);
    await callModule(page, MOD.CHART_STORE, "syncChartRegions");
    await page.evaluate(() => {
      window.dispatchEvent(new Event("chart:updated"));
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await callModule(page, MOD.CHART_STORE, "flushPendingChartSaves");
    await eventually(
      async () => (await persistedCharts(page)).find((c) => c.id === cardId)?.spec.title,
      (t) => t === CARD_TITLE,
      "the Card's literal title never reached the backend",
    );

    // ---- Visuals > Slicer from the model (territorygroup), on the SAME canvas.
    slicerId = await insertModelSlicer(page);
    // The Canvas tab drops each insert centred in the view, one pitch down-right
    // of the last (insertOnCanvas.ts, by design), so the slicer lands ON the
    // Card and would take B2's double-click on the Card's title. Move it clear,
    // as the user would drag it (the slicer store's own position write).
    {
      const s = await callModule<{ width: number; height: number }>(page, MOD.SLICER_STORE, "getSlicerById", [slicerId]);
      const clear = await freeCanvasRect(page, { width: s.width, height: s.height });
      await callModule(page, MOD.SLICER_STORE, "updateSlicerPositionAsync", [slicerId, clear.x, clear.y, s.width, s.height]);
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      const card = (await persistedCharts(page)).find((c) => c.id === cardId)!;
      const moved = (await callModule<{ x: number; y: number; width: number; height: number }>(page, MOD.SLICER_STORE, "getSlicerById", [slicerId]));
      const overlaps = moved.x < card.x + card.width && card.x < moved.x + moved.width && moved.y < card.y + card.height && card.y < moved.y + moved.height;
      expect(overlaps, `precondition: the slicer still covers the Card (${JSON.stringify(moved)} vs ${JSON.stringify(card)})`).toBe(false);
    }
    await eventually(
      () => callModule<Array<{ value: string }> | undefined>(page, MOD.SLICER_STORE, "getCachedItems", [slicerId]),
      (it) => (it ?? []).some((x) => x.value === EUROPE),
      `the model slicer does not list ${EUROPE}`,
      30_000,
    );
    await cleanupUi(page);
  });

  // -------------------------------------------------------------------------
  test("B2 the Card's title bound to a cell AND a measure through the in-place title editor: stored invariant, shown in the user's locale, one 'Bind property' step, the literal untouched, the paint follows", async ({ appPage: page }) => {
    await clickSheetTab(page, reportIndex);
    const card = (await persistedCharts(page)).find((c) => c.id === cardId)!;
    const painted = await eventually(() => chartData(page, cardId), (d) => !!d?.layout?.elements?.title, "the Card painted no title rect", 30_000);
    const rect = painted!.layout!.elements!.title;
    const at = await sheetPointToPage(page, card.x + rect.x + rect.width / 2, card.y + rect.y + rect.height / 2);
    // A CLEAN document first, so "the bind dirtied it" cannot be B1's leftovers.
    await page.waitForTimeout(800);
    await invoke(page, "save_file", { path: FILE_PRE_BIND });
    await eventually(() => isDirty(page), (d) => d === false, "precondition: the document is not clean after Save");

    await page.mouse.dblclick(at.x, at.y);
    const editor = page.locator("[data-overlay-text-editor]");
    await expect(editor, "double-clicking the Card's title opened no in-place editor").toBeVisible({ timeout: 5000 });
    expect(await editor.inputValue(), "the editor is seeded from the RAW literal").toBe(CARD_TITLE);
    await editor.fill(TITLE_TYPED);
    await startTextRecorder(page);
    // Excel's commit for a chart title: click outside it.
    const spot = await freeCanvasRect(page, { width: 8, height: 8 });
    const away = await sheetPointToPage(page, spot.x + 4, spot.y + 4);
    await page.mouse.click(away.x, away.y);
    await expect(editor, "clicking outside did not close the title editor").toHaveCount(0, { timeout: 5000 });
    await callModule(page, CHART_TEXT_EDITING, "chartTextWritesSettled");

    const bound = await eventually(() => seamBinding(page, cardRef(), "/spec/title"), (b) => !!b, "the title commit created no binding (seam cache)", 15_000);
    expect(bound!.formula, "Rust stores the INVARIANT, sheet-qualified formula").toBe(TITLE_INVARIANT);
    expect(bound!.displayFormula, "the person's own spelling comes back for display").toBe(TITLE_TYPED);
    const models = await callModule<ModelMeasures[]>(page, SEAM, "listBindingMeasures", [cardRef()]);
    const aw = models.find((m) => m.connectionId === conn!.connectionId);
    expect(aw, `the Card's page offers no AdventureWorks model: ${JSON.stringify(models)}`).toBeTruthy();
    expect(aw!.measures, "the page's model lists Revenue").toContain("Revenue");
    modelKey = aw!.modelKey;
    expect(bound!.model, "[Revenue] was bound to the page's model").toBe(modelKey);
    const fromRust = await backendBinding(page, cardRef(), "/spec/title");
    expect(fromRust?.formula, "the seam cache and Rust disagree").toBe(TITLE_INVARIANT);

    expect(await isDirty(page), "binding a property did not dirty the document").toBe(true);
    expect((await undoInfo(page)).undoDescription, "the bind is not ONE 'Bind property' step").toBe("Bind property");
    expect((await persistedCharts(page)).find((c) => c.id === cardId)!.spec.title, "the binding overwrote the Card's LITERAL title").toBe(CARD_TITLE);

    const resolved = await eventually(
      () => seamResolved(page, cardRef(), "/spec/title"),
      (r) => !!r && !r.pending && digitsOf(r.display) === roundedDigits(ORACLE_TOTAL),
      `the bound title never read "Revenue " + the total ${ORACLE_TOTAL}`,
      60_000,
    );
    expect(resolved!.display.startsWith("Revenue"), `the title lost Inputs!B1: ${resolved!.display}`).toBe(true);
    await eventually(
      () => recordedTexts(page),
      (t) => t.some((s) => s.startsWith("Revenue") && digitsOf(s) === roundedDigits(ORACLE_TOTAL)),
      "the Card did not PAINT the bound title",
      20_000,
    );
    await cleanupUi(page);
  });

  // -------------------------------------------------------------------------
  test("B3 a slicer click refilters the bound title; the runtime-only ops (SetPageFilters, ResolveAll, CellsChanged, RefreshMeasures) never dirty and never add an undo step", async ({ appPage: page }) => {
    await clickSheetTab(page, reportIndex);

    // ---- (a) The user's click on Europe.
    await startTextRecorder(page);
    await callModule(page, MOD.SLICER_STORE, "clickSlicerItem", [slicerId, EUROPE, false]);
    await eventually(
      () => seamResolved(page, cardRef(), "/spec/title"),
      (r) => !!r && !r.pending && digitsOf(r.display) === roundedDigits(ORACLE_EUROPE),
      `the slicer did not refilter the bound title to Europe (${ORACLE_EUROPE})`,
      60_000,
    );
    await eventually(
      () => recordedTexts(page),
      (t) => t.some((s) => s.startsWith("Revenue") && digitsOf(s) === roundedDigits(ORACLE_EUROPE)),
      "the refiltered title was not PAINTED",
      20_000,
    );
    expect((await backendBinding(page, cardRef(), "/spec/title"))?.formula, "a slicer click changed the binding ROW").toBe(TITLE_INVARIANT);

    // ---- (b) Clean document, then the runtime-only ops straight to Rust.
    await page.waitForTimeout(800);
    await invoke(page, "save_file", { path: FILE_CLEAN });
    await eventually(() => isDirty(page), (d) => d === false, "precondition: the document is not clean after Save");
    const depth = (await undoInfo(page)).undoDepth;
    const europeSnapshot = await callModule<Array<{ sheetIndex: number; connectionId: string; filters: unknown[] }>>(page, BRIDGE, "pageFiltersSnapshot");
    expect(europeSnapshot.some((p) => p.sheetIndex === reportIndex), `precondition: the live page-filter snapshot holds the canvas: ${JSON.stringify(europeSnapshot)}`).toBe(true);
    const titleNow = async () => (await backendBinding(page, cardRef(), "/spec/title"))?.resolved?.display ?? "";
    const stillClean = async (op: string) => {
      expect(await isDirty(page), `${op} dirtied the document`).toBe(false);
      expect((await undoInfo(page)).undoDepth, `${op} added an undo step`).toBe(depth);
    };

    expect((await bindingsOp<{ kind: string }>(page, { op: "setPageFilters", pages: europeSnapshot })).kind).toBe("ack");
    await stillClean("SetPageFilters (Europe)");
    const europeTitle = await titleNow();
    expect(digitsOf(europeTitle), "SetPageFilters (Europe) does not read Europe").toBe(roundedDigits(ORACLE_EUROPE));

    expect((await bindingsOp<{ kind: string }>(page, { op: "setPageFilters", pages: [] })).kind).toBe("ack");
    await stillClean("SetPageFilters");
    const totalTitle = await titleNow();
    expect(digitsOf(totalTitle), "SetPageFilters with no filter does not read the total").toBe(roundedDigits(ORACLE_TOTAL));
    expect(totalTitle, "NON-VACUITY: the two snapshots resolved the same title, so 'never dirties' proved nothing").not.toBe(europeTitle);

    expect((await bindingsOp<{ kind: string }>(page, { op: "resolveAll" })).kind).toBe("resolved");
    await stillClean("ResolveAll");
    expect((await bindingsOp<{ kind: string }>(page, { op: "cellsChanged", cells: null })).kind).toBe("resolved");
    await stillClean("CellsChanged");
    expect((await bindingsOp<{ kind: string }>(page, { op: "refreshMeasures", sheetIndex: null })).kind).toBe("ack");
    await stillClean("RefreshMeasures");

    // Put the mirror back where the slicer on screen says it is (Europe).
    expect((await bindingsOp<{ kind: string }>(page, { op: "setPageFilters", pages: europeSnapshot })).kind).toBe("ack");
    await stillClean("SetPageFilters (back to Europe)");
    expect(digitsOf(await titleNow()), "the mirror did not return to Europe").toBe(roundedDigits(ORACLE_EUROPE));
  });

  // -------------------------------------------------------------------------
  test("B4 a KPI goal bound to measure x cell by the AI tool (audited, one step); the user's typed edit and the AI's set_cell_value both move it", async ({ appPage: page, grid }) => {
    await clickSheetTab(page, reportIndex);
    const free = await freeCanvasRect(page, { width: 260, height: 160 });
    kpiId = await createChart(
      page,
      { mark: "kpi", data: { type: "designQuery", dslText: "VALUES: [Revenue]", connectionId: conn!.connectionId }, title: "Revenue KPI" },
      { sheetIndex: reportIndex, x: free.x, y: free.y, width: 260, height: 160, name: "Revenue KPI" },
      { waitPaint: false },
    );
    const depth = (await undoInfo(page)).undoDepth;

    const reply = await aiTool(page, "set_object_binding", { kind: "chart", id: kpiId, path: "/spec/markOptions/goal", formula: GOAL_FORMULA });
    console.log(`[object-bindings] set_object_binding: ${reply}`);
    const goal = await eventually(() => backendBinding(page, kpiRef(), "/spec/markOptions/goal"), (b) => !!b?.resolved && !b.resolved.pending, "the AI's goal binding never resolved", 60_000);
    expect(goal!.formula).toBe(GOAL_FORMULA);
    expect(near(Number(goal!.resolved!.value), ORACLE_EUROPE * 0.9), `goal ${goal!.resolved!.value} is not Europe x 0,9 = ${ORACLE_EUROPE * 0.9}`).toBe(true);
    expect(reply, "the reply does not say what it bound").toContain("Bound /spec/markOptions/goal");
    expect(reply, "the reply does not carry the resolved value").toContain(goal!.resolved!.display);
    expect(reply, "the reply does not say it is one undo step").toContain("one undo step");
    const after = await undoInfo(page);
    expect(after.undoDepth, "the AI's bind is not ONE undo step").toBe(depth + 1);
    expect(after.undoDescription).toBe("Bind property");

    const audit = await invoke<{ entries: Array<Record<string, unknown>> }>(page, "calp_get_audit_log");
    const rows = audit.entries.filter((e) => e.tool === "set_object_binding");
    expect(rows.length, "the AI's binding wrote no audit row").toBeGreaterThan(0);
    expect(rows.some((e) => e.objectId === kpiId && e.path === "/spec/markOptions/goal"), `no audit row names the KPI's goal: ${JSON.stringify(rows.slice(-3))}`).toBe(true);

    // ---- (1) The USER's door: type 1,1 into Inputs!B2 (Core's CELLS_UPDATED).
    await clickSheetTab(page, inputsIndex);
    await grid.setCellValue("B2", "1,1");
    expect((await readCell(page, inputsIndex, "B2")).display, "precondition: the typed 1,1 landed").toMatch(/^1[,.]1$/);
    await eventually(
      async () => Number((await seamResolved(page, kpiRef(), "/spec/markOptions/goal"))?.value),
      (v) => near(v, ORACLE_EUROPE * 1.1),
      `the user's typed edit did not move the goal to Europe x 1,1 = ${ORACLE_EUROPE * 1.1}`,
      30_000,
    );

    // ---- (2) A BACKEND door: the AI's set_cell_value on the active sheet (it
    //      emits grid:refresh). Written as a formula so the number does not
    //      depend on how the locale parses "0.8".
    const written = await aiTool(page, "set_cell_value", { row: 1, col: 1, value: "=8/10" });
    console.log(`[object-bindings] set_cell_value: ${written}`);
    expect((await readCell(page, inputsIndex, "B2")).display, "precondition: the AI's write landed on Inputs!B2").toMatch(/^0[,.]8$/);
    await eventually(
      async () => Number((await seamResolved(page, kpiRef(), "/spec/markOptions/goal"))?.value),
      (v) => near(v, ORACLE_EUROPE * 0.8),
      `the AI's set_cell_value did not move the goal to Europe x 0,8 = ${ORACLE_EUROPE * 0.8}`,
      30_000,
    );
    await clickSheetTab(page, reportIndex);
  });

  // -------------------------------------------------------------------------
  test("B5 a shape's text and fill bound in the Properties pane (fx): resolve_control_properties shows the values, the stored literals stay static, no formula valueType anywhere, the paint follows", async ({ appPage: page }) => {
    await clickSheetTab(page, reportIndex);
    const spot = await freeCanvasRect(page, { width: 220, height: 90 });
    const made = await createShape(page, { sheetIndex: reportIndex, x: spot.x, y: spot.y, width: 220, height: 90 });
    const meta = await controlMeta(page, reportIndex, made.row, made.col);
    expect(meta?.uid, "the new shape has no uid: no binding can name it").toBeTruthy();
    shape = { ...made, uid: meta!.uid! };

    const obj = await shapeObject(page);
    await startTextRecorder(page);
    await clickObject(page, obj);
    // WP-C (D-PANE): the click opens the ONE object pane; its Properties tab
    // hosts the Properties pane (a remembered Format tab would hide the rows).
    await showPropertiesTabIfPresent(page);
    await bindInPane(page, "text", SHAPE_TEXT_FORMULA);
    await bindInPane(page, "fill", SHAPE_FILL_FORMULA);

    expect((await backendBinding(page, shapeRef(), "/properties/text"))?.formula).toBe(SHAPE_TEXT_FORMULA);
    expect((await backendBinding(page, shapeRef(), "/properties/fill"))?.formula).toBe(SHAPE_FILL_FORMULA);
    const shown = await eventually(
      () => resolvedControl(page, reportIndex, shape!.row, shape!.col),
      (r) => (r.text ?? "").startsWith("Region: Revenue") && (r.fill ?? "").toLowerCase() === FILL_COLOUR.toLowerCase(),
      "resolve_control_properties does not show the bound text and fill",
      30_000,
    );
    console.log(`[object-bindings] shape resolved text=${JSON.stringify(shown.text)} fill=${shown.fill}`);

    const stored = await controlMeta(page, reportIndex, shape.row, shape.col);
    expect(stored?.properties.text, "the shape's LITERAL text was overwritten").toEqual({ valueType: "static", value: "" });
    const formulaTyped = Object.entries(stored?.properties ?? {}).filter(([, v]) => v.valueType === "formula").map(([k]) => k);
    expect(formulaTyped, "a formula valueType is stored on the control (the second spelling came back)").toEqual([]);
    await eventually(() => recordedTexts(page), (t) => t.some((s) => s.startsWith("Region: Revenue")), "the shape did not PAINT its bound text", 20_000);
    await cleanupUi(page);
  });

  // -------------------------------------------------------------------------
  test("B6 a restricted object script binds its own tooltip to a measure (bi.query) and reads what the user sees; binding to another sheet's cell is refused with the clamp sentence and changes nothing", async ({ appPage: page }) => {
    await clickSheetTab(page, reportIndex);
    scriptId = `object-bindings-${Date.now().toString(36)}`;
    const source = [
      "// @capability bi.query",
      "function setup(shape) {",
      '  shape.expose("bindTooltip", async () => {',
      "    try {",
      `      await shape.self.bindProperty("/properties/tooltip", ${JSON.stringify(TOOLTIP_FORMULA)});`,
      '      return { ok: true, shown: await shape.self.getProperty("/properties/tooltip") };',
      "    } catch (e) { return { ok: false, code: (e && e.code) || '', message: (e && e.message) || String(e) }; }",
      "  });",
      '  shape.expose("bindOffSheet", async () => {',
      "    try {",
      '      await shape.self.bindProperty("/properties/textColor", "=Inputs!B3");',
      "      return { ok: true };",
      "    } catch (e) { return { ok: false, code: (e && e.code) || '', message: (e && e.message) || String(e) }; }",
      "  });",
      "}",
      "",
    ].join("\n");
    try {
      await mountShapeScript(
        page,
        { id: scriptId, name: "Bindings probe", instanceId: shape!.instanceId, source, accessLevel: "restricted", declaredCapabilities: ["bi.query"] },
        ["bindTooltip", "bindOffSheet"],
      );

      const first = await callShapeMethod<{ ok: boolean; shown?: unknown; code?: string; message?: string }>(page, shape!.instanceId, "bindTooltip");
      expect(first.ok, `the script's measure binding was refused: ${first.code} ${first.message}`).toBe(true);
      const tooltip = await eventually(() => backendBinding(page, shapeRef(), "/properties/tooltip"), (b) => !!b?.resolved && !b.resolved.pending, "the tooltip binding never resolved", 60_000);
      expect(tooltip!.formula).toBe(TOOLTIP_FORMULA);
      expect(tooltip!.model, "the measure was not bound to the page's model").toBe(modelKey);
      expect(tooltip!.resolved!.display, "the % measure is not shown in its 0.0% format").toMatch(/%$/);
      expect(first.shown, "getProperty does not return what the user sees (the resolved display)").toBe(tooltip!.resolved!.display);

      const countBefore = (await backendBindings(page)).length;
      const depthBefore = (await undoInfo(page)).undoDepth;
      const clamp = await moduleValue<string>(page, SCRIPT_HOST, "RESTRICTED_BINDING_CLAMP_MESSAGE");
      const refused = await callShapeMethod<{ ok: boolean; code?: string; message?: string }>(page, shape!.instanceId, "bindOffSheet");
      expect(refused.ok, "a RESTRICTED script bound another sheet's cell while the canvas is in front").toBe(false);
      expect(refused.message ?? "", "the refusal is not the clamp sentence").toContain(clamp);
      expect(await backendBinding(page, shapeRef(), "/properties/textColor"), "the refused binding was stored anyway").toBeNull();
      expect((await backendBindings(page)).length, "the refusal changed the binding set").toBe(countBefore);
      expect((await undoInfo(page)).undoDepth, "the refusal added an undo step").toBe(depthBefore);
    } finally {
      if (scriptId) await unmountScript(page, scriptId);
      scriptId = null;
    }
  });

  // -------------------------------------------------------------------------
  test("B7 the AI reads it: get_sheet_summary lists the canvas's objects with `path := formula -> \"display\"`, and list_object_properties shows the KPI's goal bindable AND bound", async ({ appPage: page }) => {
    const summary = await aiTool(page, "get_sheet_summary", { max_chars: 20000 });
    expect(summary, "the summary has no Canvas objects section").toContain("## Canvas objects");
    expect(summary, "the summary does not name the canvas").toContain("Report");
    expect(summary, "the summary does not show the title binding with its value").toContain(`/spec/title := ${TITLE_INVARIANT} -> "`);
    expect(
      new RegExp(`/properties/fill := =Inputs!B3 -> "${FILL_COLOUR}"`, "i").test(summary),
      `the summary does not show the shape's fill binding: ${summary.slice(summary.indexOf("## Canvas objects"), summary.indexOf("## Canvas objects") + 1500)}`,
    ).toBe(true);

    const kpi = JSON.parse(await aiTool(page, "list_object_properties", { kind: "chart", id: kpiId })) as {
      bindable: Array<{ path: string }>;
      bindings: Array<{ path: string; formula: string }>;
    };
    expect(kpi.bindable.map((b) => b.path), "the KPI's goal is not listed as bindable").toContain("/spec/markOptions/goal");
    expect(kpi.bindings.find((b) => b.path === "/spec/markOptions/goal")?.formula, "the KPI's goal is not listed as bound").toBe(GOAL_FORMULA);
    // Negative control: the Card's goal is bindable but NOT bound.
    const cardProps = JSON.parse(await aiTool(page, "list_object_properties", { kind: "chart", id: cardId })) as {
      bindable: Array<{ path: string }>;
      bindings: Array<{ path: string }>;
    };
    expect(cardProps.bindable.map((b) => b.path)).toContain("/spec/markOptions/goal");
    expect(cardProps.bindings.map((b) => b.path), "the Card lists a binding it does not have").toEqual(["/spec/title"]);
  });

  // -------------------------------------------------------------------------
  test("B8 Ctrl+Z removes the last binding (its value goes, the literal shows), Ctrl+Y restores it", async ({ appPage: page }) => {
    await clickSheetTab(page, reportIndex);
    const before = await undoInfo(page);
    expect(before.undoDescription, "precondition: the last step is the script's binding").toBe("Bind property");
    const display = (await backendBinding(page, shapeRef(), "/properties/tooltip"))!.resolved!.display;

    await gridKey(page, "Control+z");
    await eventually(() => backendBinding(page, shapeRef(), "/properties/tooltip"), (b) => b === null, "Ctrl+Z did not remove the tooltip binding");
    await eventually(() => seamResolved(page, shapeRef(), "/properties/tooltip"), (r) => r === null, "the seam still holds the undone binding's value");
    expect((await resolvedControl(page, reportIndex, shape!.row, shape!.col)).tooltip ?? "", "after Ctrl+Z the tooltip still shows the bound value, not the literal").toBe("");
    expect((await undoInfo(page)).redoDescription, "the redo step is not the binding").toBe("Bind property");

    await gridKey(page, "Control+y");
    const back = await eventually(() => backendBinding(page, shapeRef(), "/properties/tooltip"), (b) => !!b?.resolved && !b.resolved.pending, "Ctrl+Y did not restore the tooltip binding", 60_000);
    expect(back!.formula).toBe(TOOLTIP_FORMULA);
    expect(back!.resolved!.display).toBe(display);
    expect((await undoInfo(page)).undoDescription).toBe("Bind property");
    await eventually(() => resolvedControl(page, reportIndex, shape!.row, shape!.col), (r) => r.tooltip === display, "after Ctrl+Y the tooltip does not show the bound value");
  });

  // -------------------------------------------------------------------------
  test("B9 renaming Inputs re-spells every binding, and inserting a row above row 1 shifts every reference; the values never move", async ({ appPage: page }) => {
    const values = await settledDisplays(page, "before the rename");
    expect(canonical(await formulasNow(page)), "precondition: the five bindings as built").toBe(canonical(expectedFormulas("Inputs", 0)));

    await renameSheetByName(page, "Inputs", "Inputs 2025");
    await eventually(() => formulasNow(page), (f) => canonical(f) === canonical(expectedFormulas("'Inputs 2025'", 0)), "a binding formula did not follow the rename");
    await eventually(() => settledDisplays(page, "after the rename"), (v) => canonical(v) === canonical(values), "a bound value changed with the rename");

    await clickSheetTab(page, inputsIndex);
    await callModule(page, MOD.API_LIB, "insertRows", [0, 1]);
    await eventually(() => formulasNow(page), (f) => canonical(f) === canonical(expectedFormulas("'Inputs 2025'", 1)), "a binding formula did not shift with the inserted row");
    await eventually(() => settledDisplays(page, "after the row insert"), (v) => canonical(v) === canonical(values), "a bound value changed with the row insert");
    await clickSheetTab(page, reportIndex);
  });

  // -------------------------------------------------------------------------
  test("B10 deleting the shape (Delete in Design Mode) removes its bindings, and ONE Ctrl+Z brings back the shape AND its bindings", async ({ appPage: page }) => {
    await clickSheetTab(page, reportIndex);
    const own = (await backendBindings(page, shapeRef())).map((b) => b.path).sort();
    expect(own, "precondition: the shape's three bindings").toEqual(["/properties/fill", "/properties/text", "/properties/tooltip"]);
    await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [true]);
    try {
      await clickObject(page, await shapeObject(page));
      const depth = (await undoInfo(page)).undoDepth;
      await gridKey(page, "Delete");
      await eventually(() => controlMeta(page, reportIndex, shape!.row, shape!.col), (m) => m === null, "Delete did not remove the shape");
      await eventually(() => backendBindings(page, shapeRef()), (bs) => bs.length === 0, "the deleted shape's bindings are still in the store");
      const deleted = await undoInfo(page);
      console.log(`[object-bindings] delete step: ${deleted.undoDescription} (depth ${depth} -> ${deleted.undoDepth})`);
      expect(deleted.undoDepth, "the delete is not ONE undo step").toBe(depth + 1);

      await gridKey(page, "Control+z");
      await eventually(() => controlMeta(page, reportIndex, shape!.row, shape!.col), (m) => m !== null && m.uid === shape!.uid, "Ctrl+Z did not bring the shape back with its uid");
      await eventually(
        async () => (await backendBindings(page, shapeRef())).map((b) => b.path).sort(),
        (p) => JSON.stringify(p) === JSON.stringify(own),
        "the SAME Ctrl+Z did not bring the shape's bindings back",
      );
      expect((await undoInfo(page)).undoDepth, "bringing back the shape and its bindings took more than one step").toBe(depth);
    } finally {
      await callModule(page, MOD.DESIGN_MODE, "setDesignMode", [false]).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  test("B11 Save stamps .cala v10 with the object_bindings feature and an invariant bindings.json; File > New then Open lists the same bindings with the same values, not dirty", async ({ appPage: page }) => {
    const before = await backendBindings(page);
    const values = await settledDisplays(page, "before the save");
    await invoke(page, "save_file", { path: FILE_V10 });
    await eventually(() => isDirty(page), (d) => d === false, "Save did not clean the document");

    const entries = archiveEntries(FILE_V10);
    const manifest = manifestOf(entries);
    expect(manifest.formatVersion, "a workbook with bindings is not stamped v10").toBe(10);
    expect(manifest.features, "the manifest does not declare object_bindings").toContain("object_bindings");
    const rows = JSON.parse(entries["bindings.json"] ?? "null") as Array<Record<string, unknown>> | null;
    expect(Array.isArray(rows), "the archive has no bindings.json array").toBe(true);
    expect(rows!.length).toBe(before.length);
    for (const row of rows!) {
      expect(Object.keys(row).every((k) => ["object", "path", "formula", "model"].includes(k)), `bindings.json row carries an unknown key: ${JSON.stringify(row)}`).toBe(true);
      const object = row.object as Record<string, unknown>;
      expect(typeof object?.kind === "string" && typeof object?.id === "string", `bindings.json row object is not {kind,id}: ${JSON.stringify(row)}`).toBe(true);
    }
    const title = rows!.find((r) => (r.object as Ref).id === cardId && r.path === "/spec/title");
    expect(title?.formula, "the saved title formula is not the INVARIANT spelling").toBe(`='Inputs 2025'!B2&TEXT([Revenue],"#,##0")`);
    expect(title?.model, "the saved title formula lost its model key").toBe(modelKey);
    const charts = JSON.parse(entries["charts.json"] ?? "[]") as Array<Record<string, unknown>>;
    expect(charts.length, "charts.json is empty").toBeGreaterThan(0);
    for (const c of charts) {
      expect(typeof c.spec === "object" && c.spec !== null && !Array.isArray(c.spec), `a charts.json row carries its spec as ${typeof c.spec}, not an object`).toBe(true);
      expect("specJson" in c, "a charts.json row still carries specJson").toBe(false);
    }

    await newFile(page);
    expect(await backendBindings(page), "precondition: File > New emptied the binding store").toEqual([]);
    await openFileAtPath(page, FILE_V10);
    await eventually(
      async () => (await backendBindings(page)).map((b) => `${keyOf(b.object, b.path)} ${b.formula} ${b.model ?? ""}`).sort(),
      (got) => JSON.stringify(got) === JSON.stringify(before.map((b) => `${keyOf(b.object, b.path)} ${b.formula} ${b.model ?? ""}`).sort()),
      "the reopened workbook does not hold the same bindings",
      30_000,
    );
    expect((await bindingsOp<{ kind: string }>(page, { op: "refreshMeasures", sheetIndex: null })).kind).toBe("ack");
    await eventually(() => settledDisplays(page, "after the reopen"), (v) => canonical(v) === canonical(values), "a bound value differs after the reopen", 90_000);
    expect(await isDirty(page), "opening (and resolving) the bindings dirtied the document").toBe(false);
  });

  // -------------------------------------------------------------------------
  test("B12 Formulas > Bound Properties lists every binding with its value; Trace Dependents on the cell the KPI reads names the KPI and no other object", async ({ appPage: page, grid }) => {
    const all = await backendBindings(page);
    await clickMenuPath(page, ["Formulas", "Bound Properties..."]);
    const dialog = page.locator('[data-testid="bound-properties-dialog"]');
    await expect(dialog, "Formulas > Bound Properties... opened no view").toBeVisible({ timeout: 10_000 });
    const rows = dialog.locator('[data-testid="bound-property-row"]');
    await eventually(() => rows.count(), (n) => n === all.length, `the view does not list the ${all.length} bindings`, 15_000);
    for (const b of all) {
      const row = dialog.locator(`[data-testid="bound-property-row"][data-binding-key="${keyOf(b.object, b.path)}"]`);
      await expect(row, `the view does not list ${keyOf(b.object, b.path)}`).toHaveCount(1);
      await expect(row.locator('[data-col="value"]'), `the view shows the wrong value for ${b.path}`).toHaveText(b.resolved!.display);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0, { timeout: 5000 });

    // After B9's insert the KPI reads 'Inputs 2025'!B3, the title and the shape's text B2.
    await clickSheetTab(page, inputsIndex);
    await grid.clickCell("B3");
    type Trace = { boundObjects: Array<{ object: Ref; path: string; formula: string }> };
    const onB3 = await invoke<Trace>(page, "trace_dependents", { row: 2, col: 1 });
    expect(onB3.boundObjects.map((o) => keyOf(o.object, o.path)), "Trace Dependents on B3 does not name exactly the KPI's goal").toEqual([keyOf(kpiRef(), "/spec/markOptions/goal")]);
    const onB2 = await invoke<Trace>(page, "trace_dependents", { row: 1, col: 1 });
    expect(onB2.boundObjects.map((o) => keyOf(o.object, o.path)).sort(), "Trace Dependents on B2 does not name the title and the shape's text").toEqual(
      [keyOf(cardRef(), "/spec/title"), keyOf(shapeRef(), "/properties/text")].sort(),
    );
    await clickSheetTab(page, reportIndex);
  });

  // -------------------------------------------------------------------------
  test("B13 a workbook with a canvas but no chart and no binding stays below v10 with no bindings.json; one range chart (still no binding) stamps v10, still no bindings.json", async ({ appPage: page }) => {
    await newFile(page);
    const sheet1 = (await sheetsResult(page)).sheets[0] as SheetRow;
    await seedSheet1(page);
    await addCanvas(page);
    await invoke(page, "save_file", { path: FILE_NO_CHART });
    const plain = archiveEntries(FILE_NO_CHART);
    expect(manifestOf(plain).formatVersion, "a canvas workbook with no chart and no binding was stamped v10").toBeLessThan(10);
    expect(manifestOf(plain).features).not.toContain("object_bindings");
    expect("bindings.json" in plain, "a workbook with no binding wrote bindings.json").toBe(false);

    await clickSheetTab(page, 0);
    await createChart(page, barSpec(sheet1.sheetId, "Units", 0), { sheetIndex: 0, x: 300, y: 40, width: 320, height: 200, name: "Units" });
    await callModule(page, MOD.CHART_STORE, "flushPendingChartSaves");
    await invoke(page, "save_file", { path: FILE_ONE_CHART });
    const charted = archiveEntries(FILE_ONE_CHART);
    expect(manifestOf(charted).formatVersion, "a chart (charts.json embeds its spec as an object) did not stamp v10").toBe(10);
    expect(manifestOf(charted).features, "a workbook with no binding declared object_bindings").not.toContain("object_bindings");
    expect("bindings.json" in charted, "a chart with no binding wrote bindings.json").toBe(false);
    const charts = JSON.parse(charted["charts.json"] ?? "[]") as Array<Record<string, unknown>>;
    expect(charts.length).toBe(1);
    expect(typeof charts[0].spec, "the chart's spec is not embedded as an object").toBe("object");
    await newFile(page);
  });
});
