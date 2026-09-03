/**
 * TYPESCRIPT FORMS, RELEASE ONE — the modal form as a scriptable object, live.
 *
 * WHAT IS PROVED. A `form` object script (the VBA UserForm replacement) whose
 * `form.define(spec)` + `form.show()` opens a TRUSTED host-painted modal
 * (ScriptableObjects/components/scriptForm/ScriptFormDialog.tsx), whose bound
 * widgets read their cells at show and write the TYPED value back on Submit in
 * ONE undo step, whose declarative and scripted validation can block a submit,
 * which follows a bound cell that another script changes underneath it, which
 * holds the app-wide modal slot against every other script's dialog, and which
 * another script can open by name through `caps.forms.show` while its own
 * relayed method call outlives the 30 s method deadline.
 *
 * WHY A JOURNEY. Nothing below the e2e tier can run a Worker realm (jsdom has
 * none), and the dialog is React in the main window driven by app events. Every
 * assertion here is about the running product: the DOM hooks the renderer
 * publishes (`data-script-form*`, `data-form-widget`, `data-form-frame`), the
 * backend's own typed cell reads, and the host registry's own state
 * (`getActiveScriptForm`, the audit ring, the undo stack).
 *
 * HOW THE SCRIPTS ARE DRIVEN. The form script exposes `run` (registered
 * explicitly with `form.expose`, because the scaffold's top-level `run()` is a
 * Run (F5) DEBUG target and a production mount builds none) and the test
 * invokes it through `callExposedMethod`, i.e. the host -> worker relay that
 * carries the 30 s method-call deadline. The answers come back as that call's
 * return value, so "the form resolved with what the user typed" and "the
 * deadline did not fire" are the same observation. A SECOND unlocked script
 * (`probe`) is the test's hands inside the realm: typed cell reads
 * (`api.getCellData`, the only place `type` is observable), typed seed writes,
 * a competing `caps.dialog.alert`, and the live-update write.
 *
 * ONE DOOR INTO THE APP. Everything this spec reads or resets — the script
 * manager, the form and dialog registries, the audit ring, the grant sets — is
 * taken from `/src/api/index.ts`, the `@api` facade the extensions themselves
 * import, exactly as consent-flow.spec.ts does. A per-module import would be a
 * second address for the same state.
 *
 * MODULE IDENTITY. Vite's dev server versions a module's URL (`?t=...`) after
 * an edit in its import graph, so `import("/src/api/index.ts")` can hand back a
 * PHANTOM instance whose registries are empty while the app's own has a form
 * open. Every read and every reset below goes through the URL the app actually
 * loaded (see `installAppImport`), the trap consent-refusal.spec.ts documents —
 * and `buildRig` asserts the instance is shared before any test concludes
 * anything from an empty registry.
 *
 * WHY EVERY TEST RESETS THE REGISTRIES. One modal slot serves the whole app. A
 * failed assertion that left a form open would refuse the next spec's dialog
 * with "another script is showing a dialog", and the wedge guard would blame
 * that spec. `afterEach` therefore calls `resetScriptForms()` and
 * `resetScriptDialogs()` unconditionally, in that order (the form registry
 * releases its slot and settles its awaiting show; the dialog registry then
 * clears the slot table and the dismissal streak), through the app's own module.
 *
 * GRID REAL ESTATE. Columns DP..DR (0-based 119..121), rows 122..128 (0-based
 * 121..127). Confirmed unclaimed at authoring time: the only other user of
 * column DP is script-preview.spec.ts, at rows 1..4 (0-based 0..3).
 *
 * LOCALE. sv-SE. Every number the form writes goes out TYPED (invariant), so no
 * list separator or decimal comma is ever typed into the grid here; the one
 * seed with a fraction (1234.5) is written by the probe script as a NUMBER for
 * the same reason.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

// ---------------------------------------------------------------------------
// Real estate (0-based)
// ---------------------------------------------------------------------------

const COL_DP = 119;
const COL_DQ = 120;
const COL_DR = 121;

/** The worked example's B2..B6, rebound to the private column. */
const CUSTOMER = { row: 121, col: COL_DP, ref: "DP122" };
const REGION = { row: 122, col: COL_DP, ref: "DP123" };
const QTY = { row: 123, col: COL_DP, ref: "DP124" };
const PRICE = { row: 124, col: COL_DP, ref: "DP125" };
const SHIP_DATE = { row: 125, col: COL_DP, ref: "DP126" };
/** The positive-control edit for the undo case. */
const SECOND_EDIT = { row: 121, col: COL_DQ };

const PRIVATE_CELLS: Array<{ row: number; col: number }> = [
  CUSTOMER,
  REGION,
  QTY,
  PRICE,
  SHIP_DATE,
  SECOND_EDIT,
];

/**
 * The instance id a button script attached to an on-grid control would carry
 * (`control-{sheet}-{row}-{col}`, DR128). NO control metadata is written for
 * it: `ObjectScriptManager.mountScript` resolves a script by ID and checks
 * nothing about the object it names, so creating the control would add an undo
 * entry and a dirty document to a spec that measures both — without making any
 * assertion here truer.
 */
const BUTTON_INSTANCE = `control-0-127-${COL_DR}`;

/** METHOD_CALL_TIMEOUT_MS in scriptHost/protocol.ts is 30 s; the hold must outlive it. */
const METHOD_DEADLINE_MS = 30_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `@api` facade — the same module every extension imports. */
const API = "/src/api/index.ts";
/** The editor's single save gate (transpile + sandbox parse). */
const AUTHORING = "/extensions/ScriptableObjects/lib/authoringLanguage.ts";

// ---------------------------------------------------------------------------
// Page-side typing (no `any`: the harness lint treats it as an error)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/naming-convention --
 * These are names the RUNTIME chose, not names this file gets to pick:
 * `__TAURI__` is Tauri's injected bridge, `__calcImport` is installed by
 * main.tsx, `__appImport`/`__formRun` are this spec's own page-side globals
 * (double-underscore is the harness convention for them), and
 * `ObjectScriptManager` / `WebviewWindow` are exported identifiers. Renaming
 * any of them would name nothing that exists. */
type AppWindow = Window & {
  __calcImport: (url: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
  __formRun?: ParkedRun;
};
/* eslint-enable @typescript-eslint/naming-convention */

/** A parked host -> worker call: settled state readable from the test. */
interface ParkedRun {
  settled: boolean;
  value: unknown;
  error: string | null;
}

/** What `api.getCellData` hands a script — the only typed read there is. */
interface TypedCell {
  value: string | number | boolean | null;
  display: string;
  type: "number" | "text" | "boolean" | "empty" | "error";
  formula?: string;
}

interface ScriptDefinitionInput {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  source: string;
  accessLevel: "restricted" | "unlocked";
  declaredCapabilities: string[];
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * Install `window.__appImport(path)`: import the module at the URL the running
 * app loaded it from (resource timing, newest HMR version last), falling back
 * to the plain path only when the app has not loaded that module yet.
 */
async function installAppImport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    if (w.__appImport) return;
    w.__appImport = async (modulePath: string) => {
      const entries = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((n) => {
          try {
            return new URL(n).pathname === modulePath;
          } catch {
            return false;
          }
        });
      entries.sort();
      const url =
        entries.length > 0 ? entries[entries.length - 1] : new URL(modulePath, document.baseURI).href;
      return w.__calcImport(url);
    };
  });
}

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a),
    { c: cmd, a: args },
  ) as Promise<T>;
}

/** Call one exported function of an app module, by the URL the app loaded. */
async function callApp<T = unknown>(
  page: Page,
  modulePath: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(modulePath)) as Record<string, (...a: unknown[]) => unknown>;
      if (typeof m[fn] !== "function") throw new Error(`${modulePath} exports no function "${fn}"`);
      return (await m[fn](...args)) as unknown;
    },
    { modulePath, fn, args },
  ) as Promise<T>;
}

/** The same call against `@api`, which is where all of this spec's state lives. */
async function callApi<T = unknown>(page: Page, fn: string, args: unknown[] = []): Promise<T> {
  return callApp<T>(page, API, fn, args);
}

/** Script Security "enabled": the mount gate is a no-op, so nothing here can
 *  be explained by the OTHER consent gate. */
async function allowScripts(page: Page): Promise<void> {
  await invoke(page, "set_script_security_level", { level: "enabled" });
}

/**
 * The sheet name the form's identity band will print.
 *
 * Read the way the HOST reads it — `sheets[activeIndex]` (host.ts's
 * `resolveFormBindings` indexes the array by position) — so a workbook whose
 * `index` fields ever stop matching their positions makes this helper wrong in
 * the same direction as the product, instead of failing the assertion for a
 * reason that has nothing to do with forms.
 */
async function activeSheetName(page: Page): Promise<string> {
  const r = await invoke<{ sheets: Array<{ index: number; name: string }>; activeIndex: number }>(
    page,
    "get_sheets",
  );
  return r.sheets[r.activeIndex]?.name ?? "";
}

async function undoState(page: Page): Promise<{ transactionOpen: boolean; undoDepth: number }> {
  return invoke(page, "get_undo_state");
}

/** The backend `undo` COMMAND — the same entry the ribbon's Undo reaches. Not
 *  Ctrl+Z over CDP, which WebView2 swallows before the app sees it. */
async function undoOnce(page: Page): Promise<void> {
  await invoke(page, "undo");
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(250);
}

async function clearPrivateCells(page: Page): Promise<void> {
  for (const c of PRIVATE_CELLS) {
    await invoke(page, "update_cell", { row: c.row, col: c.col, value: "" }).catch(() => undefined);
  }
  await invoke(page, "apply_formatting", {
    params: { rows: [PRICE.row], cols: [PRICE.col], numberFormat: "general" },
  }).catch(() => undefined);
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
}

/** Every registry a failed test could leave holding the modal slot. */
async function resetFormRegistries(page: Page): Promise<void> {
  await installAppImport(page);
  await callApi(page, "resetScriptForms").catch(() => undefined);
  await callApi(page, "resetScriptDialogs").catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

/**
 * Register a script, GRANT its capabilities up front (a local script would
 * otherwise be JIT-prompted on first use — a React dialog this spec is not
 * about), mount it, and wait until its exposed methods are registered.
 */
async function mountScript(page: Page, def: ScriptDefinitionInput, exposes: string[]): Promise<void> {
  const outcome = await page.evaluate(
    async ({ def, exposes, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- an exported identifier, not a name this file picks
        ObjectScriptManager: {
          registerScript: (d: unknown) => void;
          mountScript: (id: string) => Promise<void>;
          isScriptMounted: (id: string) => boolean;
        };
        recordCapabilityGrant: (scriptId: string, cap: string) => void;
        listExposedMethods: () => Array<{
          objectType: string;
          instanceId: string | null;
          methodName: string;
        }>;
      };
      m.ObjectScriptManager.registerScript({ ...def, description: null });
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
        const ready = exposes.every((name) =>
          listed.some(
            (e) =>
              e.objectType === def.objectType &&
              e.instanceId === def.instanceId &&
              e.methodName === name,
          ),
        );
        if (ready) {
          return { ok: true, mounted: m.ObjectScriptManager.isScriptMounted(def.id), mountError };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ok: false, mounted: m.ObjectScriptManager.isScriptMounted(def.id), mountError };
    },
    { def, exposes, api: API },
  );
  expect(
    outcome.ok,
    `"${def.name}" mounted=${outcome.mounted} but never exposed ${exposes.join(", ")}` +
      (outcome.mountError ? ` (mount said: ${outcome.mountError})` : ""),
  ).toBe(true);
}

async function unmountScript(page: Page, scriptId: string): Promise<void> {
  await page
    .evaluate(
      async ({ scriptId, api }) => {
        const w = window as unknown as AppWindow;
        const m = (await w.__appImport!(api)) as {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- an exported identifier, not a name this file picks
          ObjectScriptManager: { unmountScript: (id: string) => void; removeScript: (id: string) => void };
        };
        try {
          m.ObjectScriptManager.unmountScript(scriptId);
        } catch {
          /* not mounted */
        }
        try {
          m.ObjectScriptManager.removeScript(scriptId);
        } catch {
          /* already gone */
        }
      },
      { scriptId, api: API },
    )
    .catch(() => undefined);
}

/** Call an exposed method and AWAIT it inside the page (bounded by the caller). */
async function callExposed<T = unknown>(
  page: Page,
  objectType: string,
  instanceId: string | null,
  method: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ objectType, instanceId, method, args, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        callExposedMethod: (t: string, i: string | null, n: string, ...a: unknown[]) => unknown;
      };
      return (await m.callExposedMethod(objectType, instanceId, method, ...args)) as unknown;
    },
    { objectType, instanceId, method, args, api: API },
  ) as Promise<T>;
}

/**
 * Start an exposed method WITHOUT awaiting it — the call blocks on the modal,
 * and awaiting inside one evaluate would deadlock against the clicks that
 * answer it. The promise is parked on `window.__formRun`.
 */
async function startExposed(
  page: Page,
  objectType: string,
  instanceId: string | null,
  method: string,
  args: unknown[] = [],
): Promise<void> {
  await page.evaluate(
    async ({ objectType, instanceId, method, args, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        callExposedMethod: (t: string, i: string | null, n: string, ...a: unknown[]) => unknown;
      };
      const parked: ParkedRun = { settled: false, value: undefined, error: null };
      w.__formRun = parked;
      Promise.resolve(m.callExposedMethod(objectType, instanceId, method, ...args)).then(
        (v) => {
          parked.settled = true;
          parked.value = v;
        },
        (e: unknown) => {
          parked.settled = true;
          parked.error = e instanceof Error ? e.message : String(e);
        },
      );
    },
    { objectType, instanceId, method, args, api: API },
  );
}

async function parkedRun(page: Page): Promise<ParkedRun> {
  return page.evaluate(() => {
    const w = window as unknown as AppWindow;
    return w.__formRun ?? { settled: false, value: undefined, error: "no parked run" };
  });
}

async function waitForParkedRun(page: Page, timeout = 20_000): Promise<ParkedRun> {
  await expect.poll(async () => (await parkedRun(page)).settled, { timeout }).toBe(true);
  return parkedRun(page);
}

async function activeForm(page: Page): Promise<{ scriptId: string; scriptName: string } | null> {
  return callApi(page, "getActiveScriptForm");
}

/** Audit-ring rows written under one script for one method. */
async function auditRows(page: Page, scriptId: string, method: string): Promise<number> {
  return page.evaluate(
    async ({ scriptId, method, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        getAuditTail: (limit?: number) => Array<{ scriptId: string; method: string; ok: boolean }>;
      };
      return m
        .getAuditTail(2000)
        .filter((e) => e.scriptId === scriptId && e.method === method && e.ok).length;
    },
    { scriptId, method, api: API },
  );
}

// ---- sources ---------------------------------------------------------------

/**
 * The worked example from `getScaffoldTemplate("form")`, rebound from B2:B6
 * to the private cells. `run` is exposed explicitly: the scaffold's top-level
 * `run()` is a Run (F5) target, which only a DEBUG mount registers.
 */
function formSource(): string {
  return [
    "// @capability ui.dialog",
    "function setup(form) {",
    "  // #region Form layout (designer-owned)",
    "  form.define({",
    '    title: "Order entry", submitLabel: "Save", width: 460,',
    "    children: [",
    `      { type: "textbox",  name: "customer", label: "Customer",   bind: "${CUSTOMER.ref}", required: true, maxLength: 80 },`,
    `      { type: "dropdown", name: "region",   label: "Region",     bind: "${REGION.ref}", options: ["EMEA", "APAC", "AMER"] },`,
    '      { type: "row", children: [',
    `        { type: "number", name: "qty",   label: "Quantity",   bind: "${QTY.ref}", min: 1, required: true },`,
    `        { type: "number", name: "price", label: "Unit price", bind: "${PRICE.ref}", min: 0 } ] },`,
    `      { type: "date",     name: "shipDate", label: "Ship date", bind: "${SHIP_DATE.ref}" },`,
    '      { type: "checkbox", name: "rush",     label: "Rush order" },',
    '      { type: "label",    name: "total",    text: "Total: -", style: "muted" },',
    "    ],",
    "  });",
    "  // #endregion",
    "  form.onChange(({ name, values }) => {",
    '    if (name === "qty" || name === "price") {',
    "      const total = Number(values.qty ?? 0) * Number(values.price ?? 0);",
    '      form.control("total").setText("Total: " + total.toFixed(2));',
    "    }",
    "  });",
    "  form.onSubmit(({ values }) => {",
    '    if (values.rush === true && values.region === "APAC") {',
    '      return { cancel: true, errors: { region: "Rush orders are not available in APAC" } };',
    "    }",
    "  });",
    '  form.expose("run", async () => {',
    "    const answers = await form.show();",
    "    return answers;",
    "  });",
    "}",
    "",
  ].join("\n");
}

/** The test's hands inside the realm: typed reads/writes and a competing dialog. */
function probeSource(): string {
  return [
    "// @capability ui.dialog",
    "function setup(shape) {",
    '  shape.expose("readCell", async (row, col) => shape.api.getCellData(row, col));',
    '  shape.expose("writeCell", async (row, col, value) => { await shape.api.setCellValue(row, col, value); return true; });',
    '  shape.expose("alert", async () => {',
    '    try { await shape.caps.dialog.alert("probe alert"); return "SHOWN"; }',
    '    catch (e) { return "REJECTED:" + ((e && e.code) || "") + ":" + ((e && e.message) || String(e)); }',
    "  });",
    "}",
    "",
  ].join("\n");
}

/** A restricted button script that opens the form BY NAME and returns the answers. */
function buttonSource(formName: string): string {
  return [
    "// @capability ui.dialog",
    "function setup(button) {",
    '  button.expose("open", async () => {',
    `    try { const answers = await button.caps.forms.show(${JSON.stringify(formName)}); return { ok: true, answers }; }`,
    "    catch (e) { return { ok: false, error: ((e && e.code) || '') + ':' + ((e && e.message) || String(e)) }; }",
    "  });",
    "}",
    "",
  ].join("\n");
}

/**
 * Route a source through the editor's single save gate (transpile + sandbox
 * parse) exactly as Save in the editor does, and hand back the JavaScript the
 * app would store. A gate refusal is a test failure with the gate's own reason.
 */
async function gateSource(page: Page, source: string, scriptName: string): Promise<string> {
  const result = await page.evaluate(
    async ({ source, scriptName, authoring, api }) => {
      const w = window as unknown as AppWindow;
      const gate = (await w.__appImport!(authoring)) as {
        gateObjectScriptSave: (
          source: string,
          name: string,
          validate: (js: string) => Promise<{ valid: boolean; error?: string }>,
        ) => Promise<{ ok: true; javascript: string } | { ok: false; detail: string }>;
      };
      const host = (await w.__appImport!(api)) as {
        hostValidateScript: (js: string) => Promise<{ valid: boolean; error?: string }>;
      };
      return gate.gateObjectScriptSave(source, scriptName, host.hostValidateScript);
    },
    { source, scriptName, authoring: AUTHORING, api: API },
  );
  if (!result.ok) throw new Error(`save gate refused "${scriptName}": ${result.detail}`);
  return result.javascript;
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

function dialog(page: Page) {
  return page.locator("[data-script-form]");
}
function widget(page: Page, name: string) {
  return page.locator(`[data-form-widget="${name}"]`);
}
function frameError(page: Page, name: string) {
  return page.locator(`[data-form-frame="${name}"] [role="alert"]`);
}
/** The footer's Submit. `.first()` because a `role: "submit"` button WIDGET
 *  wears the same hook (FormWidgetTree.tsx) when a spec declares one. */
function submitButton(page: Page) {
  return page.locator("[data-script-form-submit]").first();
}
function cancelButton(page: Page) {
  return page.locator("[data-script-form-cancel]").first();
}

/** Wait for the form to be on screen AND acknowledged by the host registry. */
async function waitForForm(page: Page, scriptId: string): Promise<void> {
  await expect(dialog(page)).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => (await activeForm(page))?.scriptId ?? null, { timeout: 10_000 })
    .toBe(scriptId);
}

/** Focus a text-like widget and replace its content (the bound display text
 *  gives way to the typed value on focus, so click first, then fill). */
async function fillWidget(page: Page, name: string, value: string): Promise<void> {
  const el = widget(page, name);
  await el.click();
  await el.fill(value);
}

// ---------------------------------------------------------------------------
// Per-test fixture: one form, one probe, private cells
// ---------------------------------------------------------------------------

interface Rig {
  formId: string;
  formName: string;
  formInstance: string;
  probeId: string;
  probeInstance: string;
}

async function seedCells(page: Page, rig: Rig): Promise<void> {
  // A number with a fraction is written TYPED by the probe (invariant), never as
  // text through the locale-sensitive entry ladder.
  await callExposed(page, "shape", rig.probeInstance, "writeCell", [PRICE.row, PRICE.col, 1234.5]);
  await invoke(page, "apply_formatting", {
    params: { rows: [PRICE.row], cols: [PRICE.col], numberFormat: "currency_usd" },
  });
  await invoke(page, "update_cell", { row: SHIP_DATE.row, col: SHIP_DATE.col, value: "2026-01-15" });
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(150);
}

async function buildRig(page: Page): Promise<Rig> {
  await installAppImport(page);
  await allowScripts(page);
  await resetFormRegistries(page);
  await clearPrivateCells(page);

  const uniq = Date.now().toString(36);
  const rig: Rig = {
    formId: `e2e-form-${uniq}`,
    formName: `E2E Order Form ${uniq}`,
    formInstance: await page.evaluate(() => crypto.randomUUID()),
    probeId: `e2e-form-probe-${uniq}`,
    probeInstance: `e2e-form-probe-${uniq}`,
  };

  await mountScript(
    page,
    {
      id: rig.probeId,
      name: "Form Probe",
      objectType: "shape",
      instanceId: rig.probeInstance,
      source: probeSource(),
      accessLevel: "unlocked",
      declaredCapabilities: ["ui.dialog"],
    },
    ["readCell", "writeCell", "alert"],
  );

  const javascript = await gateSource(page, formSource(), rig.formName);
  await mountScript(
    page,
    {
      id: rig.formId,
      name: rig.formName,
      objectType: "form",
      instanceId: rig.formInstance,
      source: javascript,
      accessLevel: "restricted",
      declaredCapabilities: ["ui.dialog"],
    },
    ["run"],
  );

  // MODULE-INSTANCE CHECK. Every mount records at least the ambient grants, so
  // a mounted script with an EMPTY grant set means this spec imported a
  // different copy of `@api` (Vite `?t=` HMR versioning) — after which every
  // "the registry is empty" assertion below would be vacuously true.
  const grants = await callApi<{ caps: string[] }>(page, "getScriptGrants", [rig.formId]);
  expect(
    grants.caps,
    "module-instance check: the app's grant set for the just-mounted form script is " +
      "empty, so this spec is talking to a PHANTOM copy of /src/api/index.ts",
  ).toContain("ui.dialog");

  await seedCells(page, rig);
  return rig;
}

async function readCell(page: Page, rig: Rig, cell: { row: number; col: number }): Promise<TypedCell> {
  return callExposed<TypedCell>(page, "shape", rig.probeInstance, "readCell", [cell.row, cell.col]);
}

// ===========================================================================

test.describe("TypeScript Forms — a modal form as a scriptable object", () => {
  let rig: Rig | null = null;
  let buttonId: string | null = null;

  test.afterEach(async ({ sharedPage: page }) => {
    // The slot first: a form left open would refuse every later dialog.
    await resetFormRegistries(page);
    if (buttonId) {
      await unmountScript(page, buttonId);
      buttonId = null;
    }
    if (rig) {
      await unmountScript(page, rig.formId);
      await unmountScript(page, rig.probeId);
      rig = null;
    }
    await clearPrivateCells(page);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
    }
  });

  // =========================================================================
  // 1. Insert > Form mints a `form` object script
  // =========================================================================
  test("Insert > Form creates a form script with a minted UUID instanceId", async ({
    appPage: page,
    grid,
  }) => {
    // The journey project already allows 300 s; opening a cold Object Script
    // Editor WINDOW (a second Tauri webview + Monaco) can eat a large slice of it.
    test.setTimeout(300_000);
    await installAppImport(page);
    await allowScripts(page);
    const before = new Set(
      (await invoke<Array<{ id: string }>>(page, "list_object_scripts")).map((s) => s.id),
    );

    await grid.openMenu("Insert");
    const item = page
      .locator("button")
      .filter({ hasText: /^\s*Form\.\.\.\s*$/ })
      .first();
    await expect(item, "Insert > Form... must be on the menu").toBeVisible({ timeout: 5_000 });
    await item.click();

    let created: { id: string; name: string; objectType: string; instanceId: string | null } | undefined;
    await expect
      .poll(
        async () => {
          const scripts = await invoke<
            Array<{ id: string; name: string; objectType: string; instanceId: string | null }>
          >(page, "list_object_scripts");
          created = scripts.find((s) => !before.has(s.id) && s.objectType === "form");
          return created?.id ?? null;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();

    try {
      expect(created?.objectType).toBe("form");
      expect(created?.name ?? "", "forms are auto-numbered Form1, Form2, ...").toMatch(/^Form\d+$/);
      // A MINTED identity: a fresh UUID, never an anchor-derived id (which loses
      // its script on copy) and never something the file chose.
      expect(created?.instanceId ?? "").toMatch(UUID_RE);
      expect(created?.id ?? "").toMatch(UUID_RE);
    } finally {
      // The action also opened the Object Script Editor (a separate Tauri
      // window); wait for it to exist, then take it down so it cannot outlive
      // this test. Destroying before it is created would leave it orphaned.
      await waitForEditorWindow(page, 45_000);
      await destroyEditorWindow(page);
      if (created) {
        await unmountScript(page, created.id);
        await invoke(page, "delete_object_script", { id: created.id }).catch(() => undefined);
      }
    }
  });

  // =========================================================================
  // 2. run() shows the form; the band is host chrome
  // =========================================================================
  test("run() opens the form and the identity band names the script and its sheet", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page);
    const sheetName = await activeSheetName(page);

    await startExposed(page, "form", rig.formInstance, "run");
    await waitForForm(page, rig.formId);

    const band = page.locator("[data-script-form-band]");
    await expect(band).toContainText(rig.formName);
    await expect(band).toContainText("A form from a script in this workbook");
    // Restricted tier with bound cells: the bindings are pinned to the sheet
    // the form opened on, and the band says which.
    await expect(band).toContainText(`Sheet: ${sheetName}`);
    // The script's own title is BODY content, never the band.
    await expect(page.locator("[data-script-form-title]")).toHaveText("Order entry");
    await expect(band).not.toContainText("Order entry");

    // Seeds came from the cells: the currency cell shows its formatted text
    // while unfocused, and the widget holds the typed 1234.5 underneath.
    const price = widget(page, "price");
    await expect(price).toBeVisible();
    const shown = await price.inputValue();
    expect(shown, "an unfocused bound widget shows the grid's formatted text").not.toBe("1234.5");
    expect(shown).toContain("234");
    await price.click();
    await expect(price).toHaveValue("1234.5");

    // The show has not resolved: the user has not answered yet.
    expect((await parkedRun(page)).settled).toBe(false);

    await cancelButton(page).click();
    await expect(dialog(page)).toBeHidden({ timeout: 10_000 });
    const run = await waitForParkedRun(page);
    expect(run.error).toBeNull();
    expect(run.value, "Cancel resolves null").toBeNull();
  });

  // =========================================================================
  // 3. Declarative validation blocks Submit
  // =========================================================================
  test("Submit with a required field empty is blocked and writes nothing", async ({ appPage: page }) => {
    rig = await buildRig(page);
    await startExposed(page, "form", rig.formInstance, "run");
    await waitForForm(page, rig.formId);

    await submitButton(page).click();
    await expect(frameError(page, "customer")).toHaveText("This is required");
    await expect(frameError(page, "qty")).toHaveText("This is required");
    // Still open, still unanswered, still the same session.
    await expect(dialog(page)).toBeVisible();
    expect((await parkedRun(page)).settled).toBe(false);
    expect((await activeForm(page))?.scriptId).toBe(rig.formId);
    expect((await readCell(page, rig, CUSTOMER)).type).toBe("empty");
    expect(await auditRows(page, rig.formId, "sheet.setCellValue")).toBe(0);

    await cancelButton(page).click();
    expect((await waitForParkedRun(page)).value).toBeNull();
  });

  // =========================================================================
  // 4. Typed writeback in ONE undo step
  // =========================================================================
  test("Enter writes the TYPED values of the dirty widgets back in one undo step", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page);
    // THE PRECONDITION the one-undo claim rests on: `withScriptUndoBatch` JOINS
    // an already-open transaction rather than opening its own.
    const before = await undoState(page);
    expect(before.transactionOpen, "no transaction may be open before the submit").toBe(false);
    const writesBefore = await auditRows(page, rig.formId, "sheet.setCellValue");

    await startExposed(page, "form", rig.formInstance, "run");
    await waitForForm(page, rig.formId);

    await fillWidget(page, "customer", "Acme");
    await widget(page, "region").selectOption("APAC");
    await fillWidget(page, "qty", "3");
    await fillWidget(page, "price", "1300");
    // The scripted onChange reacted to the typed numbers (label patched live).
    await expect(widget(page, "total")).toHaveText("Total: 3900.00");
    // Enter in a single-line input submits.
    await widget(page, "qty").press("Enter");

    await expect(dialog(page)).toBeHidden({ timeout: 15_000 });
    const run = await waitForParkedRun(page);
    expect(run.error).toBeNull();
    expect(run.value).toMatchObject({ customer: "Acme", region: "APAC", qty: 3, price: 1300, rush: false });

    // TYPED, not the display string: the number widgets produced numbers.
    const qty = await readCell(page, rig, QTY);
    expect(qty.type, `qty landed as ${JSON.stringify(qty)}`).toBe("number");
    expect(qty.value).toBe(3);
    const price = await readCell(page, rig, PRICE);
    expect(price.type, "the currency-formatted cell stays NUMERIC after an edit").toBe("number");
    expect(price.value).toBe(1300);
    expect(price.display, "the cell keeps its currency format").not.toBe("1300");
    expect(price.display).toContain("300");
    expect((await readCell(page, rig, CUSTOMER)).value).toBe("Acme");
    expect((await readCell(page, rig, REGION)).value).toBe("APAC");

    // An UNTOUCHED bound widget is not rewritten: exactly the four dirty
    // widgets produced a write, the ship date (seeded, never edited) did not.
    expect(await auditRows(page, rig.formId, "sheet.setCellValue")).toBe(writesBefore + 4);

    // ONE undo step for all four writes.
    const after = await undoState(page);
    expect(after.undoDepth - before.undoDepth, "the submit is exactly one transaction").toBe(1);

    // Positive control: a second, ordinary edit needs its own undo first.
    await invoke(page, "update_cell", { row: SECOND_EDIT.row, col: SECOND_EDIT.col, value: "second-edit" });
    expect((await undoState(page)).undoDepth - before.undoDepth).toBe(2);
    await undoOnce(page);
    expect((await readCell(page, rig, SECOND_EDIT)).type, "the first undo reverts the second edit").toBe("empty");
    expect((await readCell(page, rig, CUSTOMER)).value, "...and leaves the form's writes alone").toBe("Acme");

    await undoOnce(page);
    expect((await readCell(page, rig, CUSTOMER)).type, "one undo reverts every bound write").toBe("empty");
    expect((await readCell(page, rig, QTY)).type).toBe("empty");
    expect((await readCell(page, rig, REGION)).type).toBe("empty");
    const restored = await readCell(page, rig, PRICE);
    expect(restored.value).toBe(1234.5);
    expect((await undoState(page)).undoDepth).toBe(before.undoDepth);
  });

  // =========================================================================
  // 5. Escape
  // =========================================================================
  test("Escape resolves null and writes nothing", async ({ appPage: page }) => {
    rig = await buildRig(page);
    await startExposed(page, "form", rig.formInstance, "run");
    await waitForForm(page, rig.formId);

    await fillWidget(page, "customer", "Never saved");
    await fillWidget(page, "qty", "7");
    await widget(page, "customer").press("Escape");

    await expect(dialog(page)).toBeHidden({ timeout: 10_000 });
    const run = await waitForParkedRun(page);
    expect(run.error).toBeNull();
    expect(run.value).toBeNull();
    expect((await readCell(page, rig, CUSTOMER)).type).toBe("empty");
    expect((await readCell(page, rig, QTY)).type).toBe("empty");
    expect(await auditRows(page, rig.formId, "sheet.setCellValue")).toBe(0);
    expect(await activeForm(page)).toBeNull();
  });

  // =========================================================================
  // 6. onSubmit verdict
  // =========================================================================
  test("an onSubmit that returns {cancel:true, errors} keeps the form open and writes nothing", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page);
    await startExposed(page, "form", rig.formInstance, "run");
    await waitForForm(page, rig.formId);

    await fillWidget(page, "customer", "Blocked Co");
    await fillWidget(page, "qty", "2");
    await widget(page, "region").selectOption("APAC");
    await widget(page, "rush").check();
    await submitButton(page).click();

    // The script's verdict, kept whole: its per-widget error under the widget.
    await expect(frameError(page, "region")).toHaveText("Rush orders are not available in APAC");
    await expect(dialog(page)).toBeVisible();
    expect((await parkedRun(page)).settled).toBe(false);
    expect((await readCell(page, rig, CUSTOMER)).type, "a refused submit writes nothing").toBe("empty");
    expect(await auditRows(page, rig.formId, "sheet.setCellValue")).toBe(0);

    // The user may act again after a refusal: fix the choice and save.
    await widget(page, "region").selectOption("EMEA");
    await submitButton(page).click();
    await expect(dialog(page)).toBeHidden({ timeout: 15_000 });
    const run = await waitForParkedRun(page);
    expect(run.value).toMatchObject({ customer: "Blocked Co", region: "EMEA", qty: 2, rush: true });
    expect((await readCell(page, rig, CUSTOMER)).value).toBe("Blocked Co");
  });

  // =========================================================================
  // 7. Live cell update from another script
  // =========================================================================
  test("a bound cell changed by another script while the form is open updates the widget", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page);
    await startExposed(page, "form", rig.formInstance, "run");
    await waitForForm(page, rig.formId);

    const region = widget(page, "region");
    await expect(region).toHaveValue("");
    // Another script (its own id, so this is NOT an own-write echo) changes
    // the cell the region widget is bound to.
    await callExposed(page, "shape", rig.probeInstance, "writeCell", [REGION.row, REGION.col, "AMER"]);
    await expect(region, "the untouched widget follows the cell").toHaveValue("AMER", { timeout: 10_000 });

    // A widget the user already edited keeps the user's value and is marked
    // stale instead of being overwritten.
    await fillWidget(page, "customer", "Typed first");
    await callExposed(page, "shape", rig.probeInstance, "writeCell", [CUSTOMER.row, CUSTOMER.col, "From cell"]);
    await expect(page.locator('[data-form-stale="customer"]')).toBeVisible({ timeout: 10_000 });
    await expect(widget(page, "customer")).toHaveValue("Typed first");

    await cancelButton(page).click();
    expect((await waitForParkedRun(page)).value).toBeNull();
  });

  // =========================================================================
  // 8. One modal app-wide
  // =========================================================================
  test("another script's caps.dialog.alert is refused while the form is open", async ({ appPage: page }) => {
    rig = await buildRig(page);
    await startExposed(page, "form", rig.formInstance, "run");
    await waitForForm(page, rig.formId);

    const verdict = await callExposed<string>(page, "shape", rig.probeInstance, "alert");
    expect(verdict, "the shared modal slot refuses a second modal, rejected not queued").toMatch(/^REJECTED:/);
    expect(verdict).toContain("is showing a dialog");
    expect(verdict).toContain(rig.formName);
    // The form is still the one on screen — nothing was stacked or replaced.
    await expect(dialog(page)).toBeVisible();
    expect((await activeForm(page))?.scriptId).toBe(rig.formId);

    await cancelButton(page).click();
    await waitForParkedRun(page);

    // Positive control: with the form gone the SAME alert is admitted — it
    // reaches the screen (the dialog registry holds it) and resolves once the
    // user closes it. Without this, the refusal above would pass just as well
    // against a dialog system that refuses everything.
    await startExposed(page, "shape", rig.probeInstance, "alert");
    await expect
      .poll(
        async () =>
          (await callApi<{ scriptId: string } | null>(page, "getActiveScriptDialog"))?.scriptId ?? null,
        { timeout: 10_000 },
      )
      .toBe(rig.probeId);
    await page.getByRole("button", { name: "OK", exact: true }).click({ timeout: 10_000 });
    const admitted = await waitForParkedRun(page);
    expect(admitted.value).toBe("SHOWN");
    expect(await activeForm(page)).toBeNull();
  });

  // =========================================================================
  // 9. Cross-script show by name, past the 30 s method deadline
  // =========================================================================
  test("a button script's caps.forms.show receives the answers, and its method deadline does not fire", async ({
    appPage: page,
  }) => {
    // 33 s of this test is deliberate WAITING (past METHOD_CALL_TIMEOUT_MS),
    // so it keeps the project budget rather than shrinking it.
    test.setTimeout(300_000);
    rig = await buildRig(page);

    buttonId = `e2e-form-button-${Date.now().toString(36)}`;
    // Same tier and origin as the form (restricted, local): the only callers
    // `caps.forms.show` resolves a form for (the R7 trust predicate is tier AND
    // origin equality, broker.ts `sameTrustOrigin`).
    await mountScript(
      page,
      {
        id: buttonId,
        name: "Order Button",
        objectType: "button",
        instanceId: BUTTON_INSTANCE,
        source: buttonSource(rig.formName),
        accessLevel: "restricted",
        declaredCapabilities: ["ui.dialog"],
      },
      ["open"],
    );

    await startExposed(page, "button", BUTTON_INSTANCE, "open");
    await waitForForm(page, rig.formId);

    // A PROXIED show names both scripts in the band.
    const band = page.locator("[data-script-form-band]");
    await expect(band).toContainText(rig.formName);
    await expect(band).toContainText("opened by Order Button");

    // Hold the form open PAST the relayed-method deadline. The host suspends
    // the caller's clock while the form it awaits is open; without that the
    // parked call rejects with "Method 'open' timed out (30000ms)".
    await page.waitForTimeout(METHOD_DEADLINE_MS + 3_000);
    await expect(dialog(page), "the form must still be up after the deadline").toBeVisible();
    const midway = await parkedRun(page);
    expect(midway.settled, `the caller's call settled early: ${midway.error ?? JSON.stringify(midway.value)}`).toBe(
      false,
    );

    await fillWidget(page, "customer", "Late answer");
    await fillWidget(page, "qty", "5");
    await submitButton(page).click();
    await expect(dialog(page)).toBeHidden({ timeout: 15_000 });

    const run = await waitForParkedRun(page);
    expect(run.error).toBeNull();
    expect(run.value).toMatchObject({ ok: true, answers: { customer: "Late answer", qty: 5 } });
    // And the owner's bindings wrote the cells, on the form owner's behalf.
    expect((await readCell(page, rig, CUSTOMER)).value).toBe("Late answer");
    expect((await readCell(page, rig, QTY)).value).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The Object Script Editor is a separate Tauri window; Insert > Form opens it.
// ---------------------------------------------------------------------------

/** The editor's fixed Tauri window label (openObjectScriptWindow.ts). */
const EDITOR_LABEL = "object-script-editor";

/* eslint-disable @typescript-eslint/naming-convention -- Tauri's own injected names. */
type TauriWindowApi = {
  __TAURI__?: {
    webviewWindow?: {
      WebviewWindow?: { getByLabel: (label: string) => Promise<{ destroy: () => Promise<void> } | null> };
    };
  };
};
/* eslint-enable @typescript-eslint/naming-convention */

/** True once the editor page exists in the CDP context (it loads objectScript.html). */
async function waitForEditorWindow(page: Page, timeoutMs: number): Promise<boolean> {
  const ctx = page.context();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const editor = ctx.pages().find((p) => p !== page && p.url().includes("objectScript.html"));
    if (editor) {
      await editor.waitForLoadState("domcontentloaded").catch(() => undefined);
      return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function destroyEditorWindow(page: Page): Promise<void> {
  await page
    .evaluate(async (label) => {
      const WebviewWindow = (window as unknown as TauriWindowApi).__TAURI__?.webviewWindow?.WebviewWindow;
      if (!WebviewWindow) return;
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) await existing.destroy();
    }, EDITOR_LABEL)
    .catch(() => undefined);
  await page.waitForTimeout(500);
}
