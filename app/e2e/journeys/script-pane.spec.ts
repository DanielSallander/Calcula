/**
 * THE TASK PANE (M2) — a script's modeless surface beside the grid, live.
 *
 * WHAT IS PROVED. A `form` object script's `form.pane` facet
 * (`scriptHost/worker/contextShims.ts`, `paneFacet`) docking a layout the
 * TRUSTED host paints — `ScriptableObjects/components/scriptPane/
 * ScriptPaneSection.tsx` over `lib/scriptPaneStore.ts`, registered through the
 * `registerPanel` seam by `lib/scriptPaneHost.ts` — with the SAME
 * `FormWidgetTree` the modal form paints, and:
 *
 *   IDENTITY    the band is host chrome: it names the script, says the pane is
 *               "A task pane from a script in this workbook", and names the
 *               sheet the restricted-tier bindings are pinned to;
 *   BINDINGS    a bound widget shows its cell at dock, writes the TYPED value
 *               back on CHANGE (a pane has no Submit), keeps a currency cell
 *               numeric, and follows another script's write while visible;
 *   THE FLUSH   a close inside the text debounce still writes the last
 *               keystrokes — `pane.dock`'s consent sentence promises "closing
 *               the pane does not undo that";
 *   THE GESTURE `pane.reveal()` on the script's own clock answers
 *               `{ revealed: false, reason: "no-gesture" }` and the sidebar
 *               stays where the user left it; the same call one keypress later
 *               is granted;
 *   THE LADDER  past the per-pane update bucket a HOST-owned banner appears in
 *               a slot the script's `pane.update({ message })` can neither
 *               clear nor overwrite, and it names the offence that happened
 *               (UPDATES, not reveals);
 *   TRANSPARENCY the docked pane is in `getScriptHeldState()` with its owner,
 *               its bound-cell count and its badge — and leaves when it closes;
 *   THE PIN     off the pinned sheet the bound widgets go read-only under the
 *               HOST's binding notice, NOTHING is read while the user is away,
 *               and the return re-enables them with current values.
 *
 * WHY A JOURNEY. Nothing below the e2e tier has a Worker realm (jsdom has
 * none), a real panel system to register into, or a backend that can answer a
 * typed cell read. Every assertion here is about the running product: the DOM
 * hooks the renderer publishes (`data-script-pane*`, and `data-form-widget` /
 * `data-form-frame`, which the pane shares with the modal because the widget
 * tree is ONE module), the backend's own typed cell reads, the audit ring, and
 * the host registry's own state (`listScriptPanes`, `getScriptHeldState`).
 *
 * HOW THE SCRIPT IS DRIVEN, AND WHY TWO WAYS.
 *  - THE KEYBOARD, where the point is that the USER started the run: the script
 *    binds Ctrl+Shift+D / Ctrl+Shift+Y with `caps.shortcut.bind`, and the test
 *    presses them. That goes through the app's ONE keydown listener
 *    (`api/keybindings.ts` -> `handleGlobalKeyDown` -> the script runner), which
 *    is one of the sites that stamp `noteScriptGesture` — so the pane's "did a
 *    person just do this?" window is opened by a real key press and by nothing
 *    this file could fake. `callExposedMethod`, which every other test uses, is
 *    deliberately NOT such a site (a scheduled job shares that door).
 *  - THE MOUNT, for every test whose subject is not the gesture: `mountWorker`
 *    stamps the same gesture ("the person applied this script to an object"),
 *    so a dock right after the mount takes the screen. If that window has
 *    lapsed (a slow first mount), the rig opens the panel the way the user
 *    would from the panel list — `openPanel`, the exact host call the pane's
 *    own activity-bar icon makes — so no test's SUBJECT depends on how fast the
 *    realm span up. `pane.dock` resolving `opened: true` is asserted only in
 *    the test that is about it.
 *
 * ONE DOOR INTO THE APP. Everything read or reset here — the script manager,
 * the pane registry, the audit ring, the grant sets, the code inventory — comes
 * from `/src/api/index.ts` (and `/src/api/codeInventory.ts`, which the barrel
 * re-exports, so the app has always loaded it), the same modules the extensions
 * import.
 *
 * MODULE IDENTITY. Vite's dev server versions a module's URL (`?t=...`) after
 * an edit in its import graph, so `import("/src/api/index.ts")` can hand back a
 * PHANTOM instance whose registries are empty while the app's own holds a pane.
 * Every read and every reset goes through the URL the app actually loaded (see
 * `installAppImport`). What would CATCH a phantom is the work that crosses
 * module graphs — `openPanel`/`closePanel`, which need the `panelService` the
 * Shell registered, and `getScriptHeldState`, which codeInventory.ts resolves
 * through its own imports — not a read-back of something this spec just wrote
 * (see the note in `buildRig`).
 *
 * WHY EVERY TEST RESETS THE REGISTRY. A pane left docked would keep a panel
 * registered in the sidebar for the NEXT spec, and the wedge guard would blame
 * that one. `afterEach` closes the panel, calls `resetScriptPanes()`
 * unconditionally through the app's own module, and unmounts both scripts. The
 * rig is handed to `afterEach` BEFORE the mounts (see `buildRig`'s `adopt`), so
 * a mount that throws cannot leave this script holding Ctrl+Shift+D/Y — which
 * `registerScriptKeybinding` would then refuse to every later test in the file.
 *
 * GRID REAL ESTATE. Column DS (0-based 122), rows 140..143 (0-based 139..142).
 * Checked at authoring time across all of `app/e2e`: no file names a `DS`/`DT`
 * cell or column 122/123; the only other three-figure columns in the suite are
 * script-form.spec.ts (DP..DR, 119..121, rows 122..128),
 * script-form-distributed.spec.ts (DQ125), script-preview.spec.ts (DP rows
 * 1..4) and open-items-owner-calls.spec.ts (columns 100/101). Rows 140/141 do
 * appear in vba-wiring-batch.spec.ts — in columns AW..BA, nowhere near DS.
 *
 * LOCALE. sv-SE, where the list separator is ";". Every number a bound widget
 * writes goes out TYPED (invariant), so no decimal comma is ever typed into the
 * grid: the fractional seed (1234.5) is written by the probe as a NUMBER, and
 * every write is checked through `api.getCellData().type`, the only typed read
 * a script has.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

// ---------------------------------------------------------------------------
// Real estate (0-based) and the constants the product owns
// ---------------------------------------------------------------------------

const COL_DS = 122;

const CUSTOMER = { row: 139, col: COL_DS, ref: "DS140" };
const QTY = { row: 140, col: COL_DS, ref: "DS141" };
const PRICE = { row: 141, col: COL_DS, ref: "DS142" };
const REGION = { row: 142, col: COL_DS, ref: "DS143" };

const BOUND_CELLS: Array<{ row: number; col: number }> = [CUSTOMER, QTY, PRICE, REGION];

/** Every bound widget is a CELL binding, so this is what the inventory must count. */
const BOUND_CELL_COUNT = BOUND_CELLS.length;

/** PANE_REVEAL_GESTURE_WINDOW_MS in scriptPaneSpec.ts is 5 s. */
const GESTURE_WINDOW_MS = 5_000;
/**
 * PANE_THROTTLE_BANNER_AT is 30 refusals in a sliding minute; PANE_THROTTLE_COOLDOWN_AT
 * is 120, and a COOLDOWN would swallow the script's own message and make the second
 * half of that test vacuous. The bucket holds 30 and refills at 30/s, so N updates
 * that take the host `t` seconds to drain produce `N - 30 - 30t` refusals.
 *
 * At 140 that is 110 when they drain instantly and still 30 if draining takes 2.6
 * seconds. The UPPER end cannot reach the cooldown at any drain rate — 30 tokens
 * are always available, so refusals never exceed N - 30 = 110 — which is why the
 * count is pushed up rather than kept tight: every extra call buys tolerance for a
 * slow machine on the low side and costs nothing on the high side.
 *
 * `t` is not zero here: the hammer has to yield to the worker's event loop every
 * 20 calls or the in-flight cap eats the rest (see `paneSource`). Seven yields of
 * 50 ms spend 0.35 s of the 2.6 s budget, leaving the rest for the host.
 */
const HAMMER_UPDATES = 140;
/** FORM_TEXT_CHANGE_DEBOUNCE_MS in scriptForms.ts is 150 ms. */
const TEXT_DEBOUNCE_MS = 150;

/**
 * The combinations the pane script takes.
 *
 * TAKEN elsewhere, and therefore unusable: A B C E F H L N O P S U V X are in
 * `RESERVED_SCRIPT_COMBOS` (keybindings.ts) and G J K R T are live
 * `DEFAULT_KEYBINDINGS` entries — `registerScriptKeybinding` refuses either.
 * That leaves D I M Q W Y Z; these two are from that set.
 */
const DOCK_COMBO = "Ctrl+Shift+D";
const REVEAL_COMBO = "Ctrl+Shift+Y";

/** The `@api` facade — the same module every extension imports. */
const API = "/src/api/index.ts";
/** The transparency spine; `@api/codeInventory` is where the panel reads it. */
const CODE_INVENTORY = "/src/api/codeInventory.ts";
/** The editor's single save gate (transpile + sandbox parse). */
const AUTHORING = "/extensions/ScriptableObjects/lib/authoringLanguage.ts";
/** The renderer wiring — asked for the panel id rather than re-spelling it here. */
const PANE_HOST = "/extensions/ScriptableObjects/lib/scriptPaneHost.ts";

const PANE_ID_RE = /^pane-\d+$/;

// ---------------------------------------------------------------------------
// Page-side typing (no `any`: the harness lint treats it as an error)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/naming-convention --
 * Names the RUNTIME chose, not names this file gets to pick: `__TAURI__` is
 * Tauri's injected bridge, `__calcImport` is installed by main.tsx,
 * `__appImport` is this spec's own page-side global (double underscore is the
 * harness convention for them), and `ObjectScriptManager` is an exported
 * identifier. Renaming any of them would name nothing that exists. */
type AppWindow = Window & {
  __calcImport: (url: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
};
/* eslint-enable @typescript-eslint/naming-convention */

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

/** What `pane.dock()` resolves (PaneDockResult). */
interface PaneDockResult {
  paneId: string;
  opened: boolean;
  placement: "sidebar" | "ribbon";
}

/** What `pane.reveal()` resolves (PaneRevealResult). */
interface PaneRevealResult {
  revealed: boolean;
  reason?: string;
}

/** One row of `listScriptPanes()` (ScriptPaneSummary). */
interface PaneSummary {
  paneId: string;
  scriptId: string;
  scriptName: string;
  docked: boolean;
  visible: boolean;
  placement: "sidebar" | "ribbon" | null;
  badge: string | null;
  boundCells: number;
  updatesLastMinute: number;
}

/** One `panes` row of `getScriptHeldState()` (ScriptPaneHeldEntry). */
interface PaneHeldEntry {
  paneId: string;
  scriptId: string;
  ownerName: string;
  ownerMissing: boolean;
  visible: boolean;
  placement: "sidebar" | "ribbon" | null;
  boundCells: number;
  updatesLastMinute: number;
  updateWindowMs: number;
  badge: string | null;
}

interface HeldState {
  panes: PaneHeldEntry[];
  forms: Array<{ showId: string; scriptId: string; ownerName: string }>;
}

interface HeldSummary {
  panes: number;
  forms: number;
  any: boolean;
}

/** What the script's `onPaneClose` recorded (PaneCloseDetail). */
interface PaneCloseDetail {
  paneId: string;
  reason: string;
  values: Record<string, unknown>;
}

interface ShortcutBinding {
  combo: string;
  handler: string;
}

interface SheetInfo {
  index: number;
  name: string;
}

/** One audit-ring row, as `getAuditTail` hands it out. */
interface AuditRow {
  scriptId: string;
  method: string;
  ok: boolean;
  error?: string;
}

/** Audit rows for one script and one method, split by verdict. */
interface AuditTally {
  total: number;
  ok: number;
  refused: number;
}

// ---------------------------------------------------------------------------
// Plumbing (borrowed whole from script-form.spec.ts — same traps, same answers)
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

async function sheets(page: Page): Promise<{ sheets: SheetInfo[]; activeIndex: number }> {
  return invoke(page, "get_sheets");
}

/**
 * The sheet name the pane's identity band will print.
 *
 * Read the way the PANE's host reads it — `nameOfSheet(sheets, activeIndex)`
 * in host.ts, which finds the sheet whose `.index` is the active one, NOT the
 * array position. Round 3 of the M2 review changed this exact spelling; a
 * helper that kept the old one would fail for a reason that has nothing to do
 * with panes.
 */
async function activeSheetName(page: Page): Promise<string> {
  const r = await sheets(page);
  return r.sheets.find((s) => s.index === r.activeIndex)?.name ?? "";
}

/**
 * Register a script, GRANT its capabilities up front (a local script would
 * otherwise be JIT-prompted on first use — and for `ui.pane` that dialog is
 * ITSELF a gesture, which would make the gesture tests measure the prompt),
 * mount it, and wait until its exposed methods are registered.
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

/** Call an exposed method and AWAIT it inside the page (bounded by the caller).
 *  NOTE: `callExposedMethod` is deliberately NOT one of the gesture-stamping
 *  entries (a scheduled job and a cross-script call share this door), which is
 *  what makes it the right way to ask for a reveal "on the script's own clock". */
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

/** Audit-ring rows for one script and one method, split by verdict. */
async function auditTally(page: Page, scriptId: string, method: string): Promise<AuditTally> {
  return page.evaluate(
    async ({ scriptId, method, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        getAuditTail: (limit?: number) => AuditRow[];
      };
      const rows = m.getAuditTail(4000).filter((e) => e.scriptId === scriptId && e.method === method);
      return {
        total: rows.length,
        ok: rows.filter((e) => e.ok).length,
        refused: rows.filter((e) => !e.ok).length,
      };
    },
    { scriptId, method, api: API },
  );
}

/**
 * How many rows of `method` this script has once the ring has STOPPED growing.
 *
 * A dock's bound reads and the first reveal's re-read are in flight when the
 * pane paints, so a baseline taken at that moment would count them against
 * whatever happens next — and "nothing was read while the user was away" is
 * exactly the claim that must not absorb an in-flight read.
 */
async function settledAuditTotal(page: Page, scriptId: string, method: string): Promise<number> {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const total = (await auditTally(page, scriptId, method)).total;
    if (total === last) return total;
    last = total;
    await page.waitForTimeout(400);
  }
  return last;
}

/** Refused rows carrying one error code — `NoGesture` for a reveal on the script's own clock. */
async function auditRefusalsWithError(
  page: Page,
  scriptId: string,
  method: string,
  error: string,
): Promise<number> {
  return page.evaluate(
    async ({ scriptId, method, error, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        getAuditTail: (limit?: number) => AuditRow[];
      };
      return m
        .getAuditTail(4000)
        .filter((e) => e.scriptId === scriptId && e.method === method && !e.ok && e.error === error).length;
    },
    { scriptId, method, error, api: API },
  );
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
// Sources
// ---------------------------------------------------------------------------

/**
 * The pane script: ONE `form` object script whose `form.pane` facet is the
 * whole subject. Every method is exposed explicitly — the scaffold's top-level
 * `run()` is a Run (F5) DEBUG target, which only a debug mount registers — and
 * the two shortcuts are what let a REAL key press start a run.
 *
 * The API used here is the GENERATED one (`objectContexts.d.ts`,
 * `ScriptPaneApi`): define / dock / update / setBadge / reveal / close /
 * control / paneId / values / isOpen / onChange / onClick / onClose.
 */
function paneSource(): string {
  return [
    "// @capability ui.pane",
    "// @capability ui.shortcut",
    "function setup(form) {",
    "  var lastDock = null;",
    "  var lastReveal = null;",
    "  var closes = [];",
    "  var bindErrors = [];",
    "  form.pane.define({",
    '    title: "Order pane",',
    "    children: [",
    `      { type: "textbox",  name: "customer", label: "Customer",   bind: "${CUSTOMER.ref}", maxLength: 80 },`,
    `      { type: "number",   name: "qty",      label: "Quantity",   bind: "${QTY.ref}", min: 0 },`,
    `      { type: "number",   name: "price",    label: "Unit price", bind: "${PRICE.ref}", min: 0 },`,
    `      { type: "dropdown", name: "region",   label: "Region",     bind: "${REGION.ref}", options: ["EMEA", "APAC", "AMER"] },`,
    '      { type: "label",    name: "note",     text: "Ready" },',
    "    ],",
    "  });",
    "  form.pane.onClose(function (detail) { closes.push(detail); });",
    "  form.expose(\"dockPane\", async function () { lastDock = await form.pane.dock(); return lastDock; });",
    "  form.expose(\"revealPane\", async function () { lastReveal = await form.pane.reveal(); return lastReveal; });",
    "  form.expose(\"lastDock\", async function () { return lastDock; });",
    "  form.expose(\"lastReveal\", async function () { return lastReveal; });",
    "  form.expose(\"closes\", async function () { return closes; });",
    "  form.expose(\"paneId\", async function () { return form.pane.paneId; });",
    "  form.expose(\"paneValues\", async function () { return form.pane.values; });",
    "  form.expose(\"closePane\", async function () { form.pane.close(); return true; });",
    "  form.expose(\"setBadge\", async function (text) { form.pane.setBadge(text); return true; });",
    "  form.expose(\"say\", async function (text) { form.pane.update({ message: { text: text, kind: \"info\" } }); return true; });",
    // THE HAMMER MUST YIELD, and this is not a stylistic choice.
    //
    // `pane.update` is a FIRE-AND-FORGET shim call, but every one of them still
    // occupies a slot in the worker's own in-flight table until the host's reply
    // comes back — and `call()` rejects with "rpc-saturated" past
    // MAX_INFLIGHT_CALLS (32, protocol.ts) WITHOUT EVER POSTING THE MESSAGE. A
    // tight synchronous `for` loop never returns to the worker's event loop, so
    // no reply can be processed, so calls 33..n are dropped inside the worker:
    // the host would see 32 updates, refuse 2 of them, and this test would fail
    // on a banner that never appeared — with nothing on screen to say the
    // hammer never reached the pane. So: fire under the cap, then yield long
    // enough for the replies to land (the sandbox clamps setTimeout to 16 ms;
    // 50 is slack for a loaded machine), and repeat.
    "  form.expose(\"hammer\", async function (n) {",
    "    var sent = 0;",
    "    while (sent < n) {",
    "      var stop = Math.min(n, sent + 20);",
    "      for (; sent < stop; sent++) form.pane.update({ controls: { note: { text: \"tick \" + sent } } });",
    "      await new Promise(function (r) { setTimeout(r, 50); });",
    "    }",
    "    return sent;",
    "  });",
    "  form.expose(\"shortcuts\", async function () { return form.caps.shortcut.list(); });",
    "  form.expose(\"bindErrors\", async function () { return bindErrors; });",
    // A refused bind (a combination something else took) is LOUD by design, so
    // it is kept and reported rather than left as an unhandled rejection the
    // test would meet later as "the key press did nothing".
    "  var noteBindError = function (e) { bindErrors.push(String((e && e.message) || e)); };",
    `  form.caps.shortcut.bind(${JSON.stringify(DOCK_COMBO)}, "dockPane", { label: "Dock the E2E task pane" }).catch(noteBindError);`,
    `  form.caps.shortcut.bind(${JSON.stringify(REVEAL_COMBO)}, "revealPane", { label: "Bring the E2E task pane forward" }).catch(noteBindError);`,
    "}",
    "",
  ].join("\n");
}

/** The test's hands inside the realm: typed cell reads and typed seed writes. */
function probeSource(): string {
  return [
    "function setup(shape) {",
    '  shape.expose("readCell", async (row, col) => shape.api.getCellData(row, col));',
    '  shape.expose("writeCell", async (row, col, value) => { await shape.api.setCellValue(row, col, value); return true; });',
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The pane on screen
// ---------------------------------------------------------------------------

/** The pane's root — the section component, mounted exactly while it is painted. */
function pane(page: Page) {
  return page.locator("[data-script-pane]");
}
/** One widget of the pane. The hook is `data-form-widget`: the pane and the
 *  modal paint the SAME FormWidgetTree module (scriptPaneSharedTree.test.ts). */
function paneWidget(page: Page, name: string) {
  return page.locator(`[data-script-pane] [data-form-widget="${name}"]`);
}
function paneFrame(page: Page, name: string) {
  return page.locator(`[data-script-pane] [data-form-frame="${name}"]`);
}
function paneBand(page: Page) {
  return page.locator("[data-script-pane-band]");
}
function paneCloseButton(page: Page) {
  return page.locator("[data-script-pane-close]");
}
/** The HOST's throttle banner — a slot no script patch can reach. */
function hostBanner(page: Page) {
  return page.locator("[data-script-pane-host-banner]");
}
/** The HOST's bindings notice (off the pinned sheet) — its own slot again. */
function bindingNotice(page: Page) {
  return page.locator("[data-script-pane-binding-notice]");
}
/** The SCRIPT's own message (`pane.update({ message })`). */
function scriptMessage(page: Page) {
  return page.locator("[data-script-pane-message]");
}

/** Focus a text-like widget and replace its content (the bound display text
 *  gives way to the typed value on focus, so click first, then fill). */
async function fillWidget(page: Page, name: string, value: string): Promise<void> {
  const el = paneWidget(page, name);
  await el.click();
  await el.fill(value);
}

/**
 * Type into a bound widget and close the pane IN THE SAME TASK, so the text
 * debounce is provably still pending when the close lands.
 *
 * TWO CDP round trips would race a 150 ms timer and the test would pass on the
 * timer's side without ever exercising the flush. The value is set through the
 * native setter and an `input` event dispatched, which is exactly the event
 * React turns into the widget's `onChange` for a keystroke, and the band's own
 * X is then clicked — the user-owned close path (`store.close()` -> the
 * registry -> CLOSE), not a script call.
 */
async function typeThenCloseInOneTask(page: Page, name: string, value: string): Promise<void> {
  await page.evaluate(
    ({ name, value }) => {
      const input = document.querySelector<HTMLInputElement>(
        `[data-script-pane] [data-form-widget="${name}"]`,
      );
      if (!input) throw new Error(`no pane widget named "${name}" is on screen`);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("this browser has no native HTMLInputElement value setter");
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const close = document.querySelector<HTMLButtonElement>("[data-script-pane-close]");
      if (!close) throw new Error("the pane's own close button is not on screen");
      close.click();
    },
    { name, value },
  );
}

// ---------------------------------------------------------------------------
// Registry reads
// ---------------------------------------------------------------------------

async function listPanes(page: Page): Promise<PaneSummary[]> {
  return callApi<PaneSummary[]>(page, "listScriptPanes");
}

async function paneRow(page: Page, scriptId: string): Promise<PaneSummary | null> {
  const rows = await listPanes(page);
  return rows.find((r) => r.scriptId === scriptId) ?? null;
}

async function heldState(page: Page): Promise<HeldState> {
  return callApp<HeldState>(page, CODE_INVENTORY, "getScriptHeldState");
}

async function heldSummary(page: Page, state: HeldState): Promise<HeldSummary> {
  return callApp<HeldSummary>(page, CODE_INVENTORY, "summarizeScriptHeldState", [state]);
}

/** The panel id the wiring registers this pane under — asked of the wiring
 *  itself (`scriptPanePanelId`) rather than re-spelled here, because a copied
 *  id is a second source of truth that drifts on the owner's next change. */
async function panelIdFor(page: Page, scriptId: string, paneKey: string): Promise<string> {
  return callApp<string>(page, PANE_HOST, "scriptPanePanelId", [scriptId, paneKey]);
}

/** Open the pane's panel the way the user does from the panel list / activity
 *  bar. Host code, not the script's: `pane.reveal` is the script's door and is
 *  never used to set a test up. */
async function userOpensPanel(page: Page, panelId: string): Promise<void> {
  await callApi(page, "openPanel", [panelId]);
}

/** Close the sidebar view onto the pane, as the sidebar's own close does. The
 *  pane stays DOCKED — a hidden pane is not a closed one. */
async function userClosesPanel(page: Page, panelId: string): Promise<void> {
  await callApi(page, "closePanel", [panelId]);
}

/**
 * Click a sheet tab — the real gesture, and the only one that emits the app's
 * SHEET_CHANGED (SheetTabs.tsx), which the pane's off-sheet return listens for.
 *
 * `sheetIndex` is the sheet's own `.index`, NOT its position in `get_sheets`:
 * the tab is rendered as `data-sheet-tab={sheet.index}` and the switch it
 * performs is `setActiveSheet(sheet.index)`. The two coincide in a workbook
 * nobody has reorganised, which is exactly what would make a position-keyed
 * helper pass here and fail — or, worse, walk to the wrong sheet — the first
 * time a spec before this one deleted or reordered one.
 */
async function clickSheetTab(page: Page, sheetIndex: number): Promise<void> {
  const tab = page.locator(`button[data-sheet-tab="${sheetIndex}"]`);
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await tab.click();
  // POLLED, not slept. The click is a frontend gesture and the switch it
  // starts finishes in the BACKEND, so a fixed wait is a bet on machine speed:
  // a tab strip still catching up with a sheet added through `invoke` lost the
  // click outright here, and the test then failed on a precondition that named
  // the click rather than the timing. If the switch genuinely never happens
  // this still fails — with the index it was stuck on.
  await expect
    .poll(async () => (await sheets(page)).activeIndex, {
      timeout: 10_000,
      message: `the click on the tab for sheet index ${sheetIndex} never moved the active sheet`,
    })
    .toBe(sheetIndex);
}

/**
 * Press one of the script's own shortcuts — a REAL key press through the app's
 * one keydown listener, which is what stamps the pane's user gesture.
 *
 * The spreadsheet container is focused first: script bindings are registered
 * with context "not-editing", and a combination pressed while a cell editor
 * has focus is deliberately ignored by `handleGlobalKeyDown`.
 */
async function pressScriptShortcut(page: Page, combo: string): Promise<void> {
  await page.locator("[data-focus-container='spreadsheet']").focus();
  await page.keyboard.press(combo.replace("Ctrl+", "Control+"));
}

/**
 * The script really did take the combination — otherwise a key press below
 * would prove nothing about gestures and everything about typing. The refusals
 * ride along in the polled value so a failure NAMES the reason (a combination
 * something else holds) instead of reporting an empty list.
 */
async function assertShortcutBound(page: Page, rig: Rig, combo: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const listed = await callExposed<ShortcutBinding[]>(page, "form", rig.paneInstance, "shortcuts");
        const errors = await callExposed<string[]>(page, "form", rig.paneInstance, "bindErrors");
        const held = listed.map((b) => b.combo).join(", ");
        return errors.length > 0 ? `${held} [refused: ${errors.join(" | ")}]` : held;
      },
      { timeout: 10_000 },
    )
    .toContain(combo);
}

/**
 * Close every pane session through the app's own registry.
 *
 * `strict` is how a RENAMED export is caught. `afterEach` must not throw — a
 * failing reset there would replace the test's real failure with its own — so
 * cleanup swallows; but `callApp` reports a missing export by throwing, and a
 * swallowed one everywhere would mean this spec's whole cleanup could quietly
 * become a no-op the day `resetScriptPanes` is renamed. `buildRig` therefore
 * calls it strictly, once, before every test: a rename fails loudly at setup
 * instead of never.
 */
async function resetPaneRegistry(page: Page, strict = false): Promise<void> {
  await installAppImport(page);
  if (strict) {
    await callApi(page, "resetScriptPanes");
    return;
  }
  await callApi(page, "resetScriptPanes").catch(() => undefined);
}

async function clearBoundCells(page: Page): Promise<void> {
  for (const c of BOUND_CELLS) {
    await invoke(page, "update_cell", { row: c.row, col: c.col, value: "" }).catch(() => undefined);
  }
  await invoke(page, "apply_formatting", {
    params: { rows: [PRICE.row], cols: [PRICE.col], numberFormat: "general" },
  }).catch(() => undefined);
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
}

// ---------------------------------------------------------------------------
// Per-test fixture: one pane script, one probe, four private cells
// ---------------------------------------------------------------------------

interface Rig {
  paneScriptId: string;
  paneName: string;
  paneInstance: string;
  probeId: string;
  probeInstance: string;
  /** The Shell panel id of the pane the script docks under its default key "0". */
  panelId: string;
}

async function seedCells(page: Page, rig: Rig): Promise<void> {
  // A number with a fraction is written TYPED by the probe (invariant), never
  // through the locale-sensitive entry ladder — sv-SE would type a comma.
  await callExposed(page, "shape", rig.probeInstance, "writeCell", [PRICE.row, PRICE.col, 1234.5]);
  await callExposed(page, "shape", rig.probeInstance, "writeCell", [CUSTOMER.row, CUSTOMER.col, "Seed Co"]);
  await invoke(page, "apply_formatting", {
    params: { rows: [PRICE.row], cols: [PRICE.col], numberFormat: "currency_usd" },
  });
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(150);
}

/**
 * `adopt` hands the rig to the test's `afterEach` BEFORE anything is mounted.
 *
 * WHY IT IS NOT JUST A RETURN VALUE. This script takes two keyboard shortcuts,
 * and `registerScriptKeybinding` refuses a combination something else already
 * holds. If a mount below threw and the rig were only handed back on success,
 * the failed test's script would stay mounted holding Ctrl+Shift+D/Y — and
 * every LATER test in this file would fail at `assertShortcutBound` with a
 * conflict against a corpse, blaming the pane for a mount that went wrong once.
 */
async function buildRig(page: Page, adopt: (rig: Rig) => void): Promise<Rig> {
  await installAppImport(page);
  await allowScripts(page);
  await resetPaneRegistry(page, true);
  await clearBoundCells(page);

  const uniq = Date.now().toString(36);
  const paneScriptId = `e2e-pane-${uniq}`;
  const rig: Rig = {
    paneScriptId,
    // Deliberately shares no words with the script's own title ("Order pane"):
    // the band assertion below is that the SCRIPT-supplied title never reaches
    // the host chrome, and a name that differed from it only in letter case
    // would make that assertion pass for a reason nobody intended.
    paneName: `E2E Pane Script ${uniq}`,
    paneInstance: await page.evaluate(() => crypto.randomUUID()),
    probeId: `e2e-pane-probe-${uniq}`,
    probeInstance: `e2e-pane-probe-${uniq}`,
    panelId: "",
  };
  rig.panelId = await panelIdFor(page, paneScriptId, "0");
  adopt(rig);

  await mountScript(
    page,
    {
      id: rig.probeId,
      name: "Pane Probe",
      objectType: "shape",
      instanceId: rig.probeInstance,
      source: probeSource(),
      accessLevel: "unlocked",
      declaredCapabilities: [],
    },
    ["readCell", "writeCell"],
  );
  await seedCells(page, rig);

  const javascript = await gateSource(page, paneSource(), rig.paneName);
  await mountScript(
    page,
    {
      id: rig.paneScriptId,
      name: rig.paneName,
      objectType: "form",
      instanceId: rig.paneInstance,
      source: javascript,
      accessLevel: "restricted",
      declaredCapabilities: ["ui.pane", "ui.shortcut"],
    },
    ["dockPane", "revealPane", "closePane", "hammer", "say"],
  );

  // THE MOUNT REALLY TOOK, AND `@api` REALLY EXPORTS WHAT THIS SPEC CALLS. An
  // empty grant set here means the mount above did not do what it said, or one
  // of these exports has been renamed (`callApp` throws on a missing one).
  //
  // WHAT IT DOES NOT PROVE, honestly: it is NOT a phantom-module check. Both the
  // grant WRITE (inside `mountScript`) and this READ go through the same
  // `__appImport` resolution, so a Vite `?t=` copy would satisfy itself. The
  // real phantom detectors in this file are the tests that cross module graphs:
  // `openPanel`/`closePanel` (tests 4 and 7) reach a `panelService` the SHELL
  // registered, and `getScriptHeldState` (test 6) comes from codeInventory.ts's
  // own import of the pane registry. If this spec ever held a phantom `@api`,
  // those are what would fail — this line would not.
  const grants = await callApi<{ caps: string[] }>(page, "getScriptGrants", [rig.paneScriptId]);
  expect(
    grants.caps,
    "the app's grant set for the just-mounted pane script is empty: either the " +
      "mount did nothing, or an export this spec names has been renamed",
  ).toContain("ui.pane");

  return rig;
}

/**
 * Dock the pane and make sure it is ON SCREEN, without depending on the
 * gesture window — see the header. The dock itself rides the MOUNT's stamp;
 * if that has lapsed the pane is registered but not opened, and the user opens
 * it from the panel list, which is exactly what `pane.dock`'s consent sentence
 * says happens.
 */
async function dockAndShow(page: Page, rig: Rig): Promise<PaneDockResult> {
  const dock = await callExposed<PaneDockResult>(page, "form", rig.paneInstance, "dockPane");
  expect(dock.paneId, "the dock resolves a host-minted pane id").toMatch(PANE_ID_RE);
  if (!dock.opened) await userOpensPanel(page, rig.panelId);
  await expect(pane(page)).toBeVisible({ timeout: 15_000 });
  // ...and the REGISTRY agrees it is on screen: "visible" is what installs the
  // bound-cell watch, so a test that assumed it would silently prove nothing.
  await expect
    .poll(async () => (await paneRow(page, rig.paneScriptId))?.visible ?? false, { timeout: 10_000 })
    .toBe(true);
  return dock;
}

async function readCell(
  page: Page,
  rig: Rig,
  cell: { row: number; col: number },
): Promise<TypedCell> {
  return callExposed<TypedCell>(page, "shape", rig.probeInstance, "readCell", [cell.row, cell.col]);
}

// ===========================================================================

test.describe("The task pane — a script's modeless surface beside the grid", () => {
  let rig: Rig | null = null;

  test.afterEach(async ({ sharedPage: page }) => {
    // The sidebar view first (so the activity bar is not left pointing at a
    // panel that is about to be unregistered), then the registry, then the
    // scripts: a pane left docked would keep a panel in the NEXT spec's sidebar.
    if (rig) await userClosesPanel(page, rig.panelId).catch(() => undefined);
    await resetPaneRegistry(page);
    if (rig) {
      await unmountScript(page, rig.paneScriptId);
      await unmountScript(page, rig.probeId);
      rig = null;
    }
    // Back to the first sheet whatever the test did with the tabs — one app
    // instance serves every spec, and the sheet a spec leaves behind is state.
    await invoke(page, "set_active_sheet", { index: 0 }).catch(() => undefined);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("sheets:refresh"));
      window.dispatchEvent(new Event("grid:refresh"));
    });
    await clearBoundCells(page);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
    }
  });

  // =========================================================================
  // 1. A run the USER started docks the pane, and the band is host chrome
  // =========================================================================
  test("a shortcut the user presses docks the pane beside the grid, and the band names the script, its origin and its sheet", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page, (r) => { rig = r; });
    const sheetName = await activeSheetName(page);

    await assertShortcutBound(page, rig, DOCK_COMBO);
    await pressScriptShortcut(page, DOCK_COMBO);

    await expect(
      pane(page),
      `${DOCK_COMBO} must reach the app's keydown listener and run the script's dockPane()`,
    ).toBeVisible({ timeout: 20_000 });

    // What `pane.dock` RESOLVED: the whole truth, not just the id. `opened` is
    // true because a person pressed the keys a moment ago. (Polled: the pane is
    // painted from the renderer's ack, and the worker records the resolved
    // result a tick later.)
    await expect
      .poll(
        async () =>
          (await callExposed<PaneDockResult | null>(page, "form", rig!.paneInstance, "lastDock"))
            ?.paneId ?? "",
        { timeout: 15_000 },
      )
      .toMatch(PANE_ID_RE);
    const dock = await callExposed<PaneDockResult | null>(page, "form", rig.paneInstance, "lastDock");
    expect(dock?.opened, "a dock inside the user's gesture window TAKES the screen").toBe(true);
    expect(dock?.placement).toBe("sidebar");

    // The band: every line host-derived, and the branch is on the origin KIND.
    await expect(paneBand(page)).toContainText(rig.paneName);
    await expect(paneBand(page)).toContainText("A task pane from a script in this workbook");
    // Restricted tier with cell bindings: the pin, and the band says which sheet.
    await expect(paneBand(page)).toContainText(`Sheet: ${sheetName}`);
    // The script's own title is BODY content, never the band.
    await expect(page.locator("[data-script-pane-title]")).toHaveText("Order pane");
    await expect(paneBand(page)).not.toContainText("Order pane");
    // The band also carries the one close the USER owns — a pane the person
    // cannot put away is a pane a script has taken.
    await expect(paneCloseButton(page)).toBeVisible();

    // MODELESS, and that is the whole point: the grid is still there and no
    // modal is up. A pane blocks nobody.
    await expect(page.locator("[data-focus-container='spreadsheet']")).toBeVisible();
    await expect(page.locator("[data-script-form]")).toHaveCount(0);

    // The registry's own row — a LIST, not an "active" one.
    const row = await paneRow(page, rig.paneScriptId);
    expect(row?.paneId).toBe(dock?.paneId);
    expect(row?.docked).toBe(true);
    expect(row?.visible).toBe(true);
    expect(row?.boundCells).toBe(BOUND_CELL_COUNT);
  });

  // =========================================================================
  // 2. Bindings, live: read at dock, TYPED write on change, follow the cell
  // =========================================================================
  test("bound widgets show their cells at dock and write the TYPED value on CHANGE — there is no Submit", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page, (r) => { rig = r; });
    const writesBefore = (await auditTally(page, rig.paneScriptId, "sheet.setCellValue")).ok;
    await dockAndShow(page, rig);

    // Seeded from the cells: the currency cell shows its FORMATTED text while
    // unfocused, with the typed 1234.5 underneath.
    const price = paneWidget(page, "price");
    const shown = await price.inputValue();
    expect(shown, "an unfocused bound widget shows the grid's formatted text").not.toBe("1234.5");
    expect(shown).toContain("234");
    await price.click();
    await expect(price).toHaveValue("1234.5");
    await expect(paneWidget(page, "customer")).toHaveValue("Seed Co");

    // A pane has no Submit — every write is `writeOn: "change"`. Each of these
    // lands while the pane is still on screen.
    await fillWidget(page, "qty", "3");
    await expect
      .poll(async () => (await readCell(page, rig!, QTY)).value, { timeout: 10_000 })
      .toBe(3);
    const qty = await readCell(page, rig, QTY);
    expect(qty.type, `qty landed as ${JSON.stringify(qty)} — the number widget must write a NUMBER`).toBe(
      "number",
    );

    await fillWidget(page, "price", "1300");
    await expect
      .poll(async () => (await readCell(page, rig!, PRICE)).value, { timeout: 10_000 })
      .toBe(1300);
    const written = await readCell(page, rig, PRICE);
    expect(written.type, "the currency-formatted cell stays NUMERIC after an edit").toBe("number");
    expect(written.display, "the cell keeps its currency format").not.toBe("1300");
    expect(written.display).toContain("300");

    await fillWidget(page, "customer", "Acme");
    await expect
      .poll(async () => (await readCell(page, rig!, CUSTOMER)).value, { timeout: 10_000 })
      .toBe("Acme");
    expect((await readCell(page, rig, CUSTOMER)).type).toBe("text");

    // The pane is STILL open — nothing was submitted and nothing closed.
    await expect(pane(page)).toBeVisible();
    expect(
      (await auditTally(page, rig.paneScriptId, "sheet.setCellValue")).ok - writesBefore,
      "exactly the three changed widgets wrote; the untouched region did not",
    ).toBe(3);

    // ...and the pane FOLLOWS its cells: another script's write (its own id, so
    // this is not an own-write echo) reaches the visible pane's widget.
    await callExposed(page, "shape", rig.probeInstance, "writeCell", [REGION.row, REGION.col, "AMER"]);
    await expect(paneWidget(page, "region"), "the untouched widget follows the cell").toHaveValue(
      "AMER",
      { timeout: 10_000 },
    );
  });

  // =========================================================================
  // 3. The close-path flush
  // =========================================================================
  test("closing the pane inside the text debounce still writes the last keystrokes to the cell", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page, (r) => { rig = r; });
    const dock = await dockAndShow(page, rig);

    // Typed AND closed in one task: the 150 ms debounce is provably pending
    // when the band's X lands, which is the case the flush exists for.
    await typeThenCloseInOneTask(page, "customer", "Typed at the last moment");

    await expect(pane(page)).toHaveCount(0, { timeout: 10_000 });
    await expect
      .poll(async () => (await paneRow(page, rig!.paneScriptId)) === null, { timeout: 10_000 })
      .toBe(true);

    // THE PROMISE `pane.dock`'s consent sentence makes: "closing the pane does
    // not undo that". The write is host-executed and lands after the close.
    await expect
      .poll(async () => (await readCell(page, rig!, CUSTOMER)).value, { timeout: 15_000 })
      .toBe("Typed at the last moment");
    expect((await readCell(page, rig, CUSTOMER)).type).toBe("text");

    // The script heard the close, with the user as the reason and the typed
    // value in hand — the same value the cell now holds.
    const closes = await callExposed<PaneCloseDetail[]>(page, "form", rig.paneInstance, "closes");
    expect(closes.length, "onPaneClose fired exactly once").toBe(1);
    expect(closes[0].paneId).toBe(dock.paneId);
    expect(closes[0].reason, "the person closed it").toBe("user");
    expect(closes[0].values.customer).toBe("Typed at the last moment");
  });

  // =========================================================================
  // 4. The gesture bound on `pane.reveal`
  // =========================================================================
  test("a reveal on the script's own clock is refused and takes no screen; the same reveal one keypress later is granted", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page, (r) => { rig = r; });
    await dockAndShow(page, rig);

    // The user puts the sidebar away. The pane is HIDDEN, not closed.
    await userClosesPanel(page, rig.panelId);
    await expect(pane(page)).toHaveCount(0, { timeout: 10_000 });
    expect((await paneRow(page, rig.paneScriptId))?.docked, "hiding a pane does not close it").toBe(true);

    // Outlive the window. Five seconds of REAL time: the window is measured
    // against Date.now() inside the app, and this spec drives the product from
    // outside it — there is no fake clock to reach. It is also the cheapest
    // wait in this file.
    await page.waitForTimeout(GESTURE_WINDOW_MS + 1_200);

    const refusalsBefore = await auditRefusalsWithError(page, rig.paneScriptId, "pane.reveal", "NoGesture");
    const refused = await callExposed<PaneRevealResult>(page, "form", rig.paneInstance, "revealPane");
    expect(refused.revealed).toBe(false);
    expect(refused.reason, "the code a script can branch on").toBe("no-gesture");

    // ...and the sidebar was NOT forced onto the pane.
    await page.waitForTimeout(500);
    await expect(
      pane(page),
      "a refused reveal must leave the sidebar exactly where the user left it",
    ).toHaveCount(0);
    expect(
      await auditRefusalsWithError(page, rig.paneScriptId, "pane.reveal", "NoGesture"),
      "the refusal is recorded under the script — the broker's own row for a reveal says ok",
    ).toBe(refusalsBefore + 1);

    // POSITIVE CONTROL. The identical call, made by the identical script, one
    // real key press later — without it the refusal above would pass just as
    // well against a reveal that never works.
    await assertShortcutBound(page, rig, REVEAL_COMBO);
    await pressScriptShortcut(page, REVEAL_COMBO);
    await expect
      .poll(
        async () =>
          (await callExposed<PaneRevealResult | null>(page, "form", rig!.paneInstance, "lastReveal"))
            ?.revealed ?? null,
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(pane(page), "the granted reveal brought the pane forward").toBeVisible({
      timeout: 10_000,
    });
  });

  // =========================================================================
  // 5. The throttle banner is the host's, and it names the offence
  // =========================================================================
  test("hammering pane.update raises a HOST banner the script can neither clear nor overwrite, and it names UPDATES", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page, (r) => { rig = r; });
    await dockAndShow(page, rig);
    await expect(hostBanner(page), "nothing is throttled yet").toHaveCount(0);

    // Past the 30/s bucket: on the order of a hundred dropped calls in the
    // minute — over the banner threshold (30) and short of the cooldown (120),
    // which would swallow the script's own message and make the second half of
    // this test vacuous. See HAMMER_UPDATES for the arithmetic.
    const hammered = await callExposed<number>(page, "form", rig.paneInstance, "hammer", [
      HAMMER_UPDATES,
    ]);
    expect(hammered, "the script issued every update it was asked for").toBe(HAMMER_UPDATES);

    // ...AND EVERY ONE OF THEM CROSSED. The broker audits each admitted call
    // whatever the registry then does with it, so this count is the number of
    // `pane.update`s that actually reached the host. It is asserted because the
    // ONE way this test can lie is a hammer that never hammered: past
    // MAX_INFLIGHT_CALLS the worker rejects its own calls before posting them,
    // and a test that only looked for the banner would report "no banner"
    // instead of "only 32 of 140 updates were sent".
    expect(
      (await auditTally(page, rig.paneScriptId, "pane.update")).total,
      "every pane.update reached the host — a short count means the worker's " +
        "in-flight cap (MAX_INFLIGHT_CALLS) swallowed the rest, not that the pane ignored them",
    ).toBe(HAMMER_UPDATES);

    await expect(hostBanner(page)).toBeVisible({ timeout: 15_000 });
    await expect(hostBanner(page)).toContainText("updating its pane faster than Calcula allows");
    await expect(hostBanner(page)).toContainText("being slowed down");
    // The ladder is climbed by three different refusals and the sentence must
    // name the one that happened: this script never asked for a reveal. BOTH
    // reveal-flavoured wordings are excluded — the reveal-only sentence says
    // "bring its pane forward" and the MIXED one says "bring it forward", so
    // testing only the first would let the mixed accusation through.
    await expect(
      hostBanner(page),
      "the banner must not accuse the script of something it never did",
    ).not.toContainText("bring its pane forward");
    await expect(
      hostBanner(page),
      "...nor of the MIXED offence, which names a reveal this script never asked for",
    ).not.toContainText("bring it forward");

    // Let the bucket refill so the script's OWN message is admitted — the
    // point is that an admitted script patch still cannot touch the banner.
    await page.waitForTimeout(500);
    await callExposed(page, "form", rig.paneInstance, "say", ["Everything is fine, honestly"]);

    await expect(scriptMessage(page)).toHaveText("Everything is fine, honestly", { timeout: 10_000 });
    // Two elements, two slots, two owners.
    await expect(hostBanner(page), "the script's message did not clear the host's banner").toHaveCount(1);
    await expect(scriptMessage(page)).toHaveCount(1);
    await expect(hostBanner(page)).toContainText("updating its pane faster than Calcula allows");
    await expect(hostBanner(page)).not.toContainText("Everything is fine");
    const slots = await page.evaluate(() => {
      const banner = document.querySelector("[data-script-pane-host-banner]");
      const message = document.querySelector("[data-script-pane-message]");
      if (!banner || !message) return "one of the two slots is missing";
      if (banner === message) return "one element wears both hooks";
      if (banner.contains(message) || message.contains(banner)) return "one slot is nested in the other";
      return "distinct";
    });
    expect(slots, "the host's banner and the script's message are two elements in two slots").toBe(
      "distinct",
    );
  });

  // =========================================================================
  // 6. Transparency: the inventory's held state
  // =========================================================================
  test("a docked pane is in the code inventory's held state with its owner and bound cells, and leaves when it closes", async ({
    appPage: page,
  }) => {
    rig = await buildRig(page, (r) => { rig = r; });
    const dock = await dockAndShow(page, rig);
    await callExposed(page, "form", rig.paneInstance, "setBadge", ["3"]);

    const state = await heldState(page);
    const held = state.panes.find((p) => p.scriptId === rig!.paneScriptId);
    expect(held, `the docked pane must appear in getScriptHeldState(): ${JSON.stringify(state.panes)}`)
      .toBeDefined();
    expect(held?.paneId).toBe(dock.paneId);
    // The owner is joined, never taken from the script's own claim.
    expect(held?.ownerName).toBe(rig.paneName);
    expect(held?.ownerMissing).toBe(false);
    expect(held?.visible).toBe(true);
    expect(held?.placement).toBe("sidebar");
    expect(held?.boundCells, "every bound widget of this pane is a CELL binding").toBe(BOUND_CELL_COUNT);
    expect(held?.badge, "the badge the script pinned on the tab").toBe("3");
    expect(held?.updateWindowMs, "the panel is told the window it may phrase the count over").toBe(60_000);

    // The badge was ADMITTED, so it also counts as a script-driven repaint —
    // the number the panel phrases over `updateWindowMs`. (`summary.any` is
    // deliberately NOT asserted: this script also holds two shortcuts, so `any`
    // is true whatever the pane rows say, and an assertion that cannot fail is
    // worse than none.)
    expect(
      held?.updatesLastMinute,
      "the admitted setBadge is counted as a repaint the user can see",
    ).toBeGreaterThanOrEqual(1);

    const summary = await heldSummary(page, state);
    expect(summary.panes).toBe(1);
    expect(summary.forms, "a pane is not a modal form").toBe(0);

    // ...and the row goes when the pane does. A stale row here is a user being
    // told a script still holds a surface it gave back.
    await callExposed(page, "form", rig.paneInstance, "closePane");
    await expect(pane(page)).toHaveCount(0, { timeout: 10_000 });
    const after = await heldState(page);
    expect(after.panes.filter((p) => p.scriptId === rig!.paneScriptId)).toEqual([]);
    expect((await heldSummary(page, after)).panes).toBe(0);
  });

  // =========================================================================
  // 7. The pinned sheet at restricted tier
  // =========================================================================
  test("off the pinned sheet the bound widgets go read-only under the host's notice, nothing is read, and the return re-reads", async ({
    appPage: page,
  }) => {
    // Sheet2 must EXIST, or the pin comparison never happens. Added through
    // the backend command, so the tab strip has to catch up before a tab can
    // be clicked — wait for the sheet to be THERE rather than assuming the
    // next line's render already happened.
    if (!(await sheets(page)).sheets.some((s) => s.name === "Sheet2")) {
      await invoke(page, "add_sheet", { name: "Sheet2" });
      // `sheets:refresh`, not `grid:refresh`: the tab strip listens for the
      // former (SheetTabs.tsx) and nothing else re-reads the sheet list after a
      // backend-only add. Without it the strip kept rendering ONE tab while the
      // backend held two, and the click below landed on a tab the frontend
      // already believed was active — a no-op that failed three assertions
      // later, naming the click instead of the missing refresh.
      await page.evaluate(() => window.dispatchEvent(new Event("sheets:refresh")));
      await expect
        .poll(async () => (await sheets(page)).sheets.some((s) => s.name === "Sheet2"), {
          timeout: 10_000,
          message: "add_sheet never produced a sheet named Sheet2",
        })
        .toBe(true);
      await expect(
        page.locator("button[data-sheet-tab]"),
        "the tab strip never picked up the sheet added through the backend",
      ).not.toHaveCount(1, { timeout: 10_000 });
    }
    // Resolve BOTH sheets by their own `.index` — the tab strip renders
    // `data-sheet-tab={sheet.index}` and the host pins by index too, so a
    // position taken from the array would be a second, silently different
    // answer the moment a sheet has been reordered or deleted.
    const list = (await sheets(page)).sheets;
    const away = list.find((s) => s.name === "Sheet2");
    const home = list.find((s) => s.name !== "Sheet2");
    expect(away, "precondition: a second sheet to walk to").toBeDefined();
    expect(home, "precondition: a sheet to dock the pane on").toBeDefined();
    const awayIndex = away!.index;
    await clickSheetTab(page, home!.index);
    const homeName = await activeSheetName(page);
    const homeIndex = (await sheets(page)).activeIndex;
    expect(homeName, "precondition: the pane docks on the sheet the user is looking at").toBeTruthy();
    expect(homeIndex, "the tab click really moved the app to the home sheet").toBe(home!.index);
    expect(homeIndex, "precondition: home and away are different sheets").not.toBe(awayIndex);

    rig = await buildRig(page, (r) => { rig = r; });
    await dockAndShow(page, rig);
    await expect(paneBand(page)).toContainText(`Sheet: ${homeName}`);
    await expect(bindingNotice(page), "on the pinned sheet there is nothing to say").toHaveCount(0);

    const readsBefore = await settledAuditTotal(page, rig.paneScriptId, "sheet.getCellData");
    expect(readsBefore, "the dock read this pane's bound cells").toBeGreaterThanOrEqual(
      BOUND_CELL_COUNT,
    );

    // The user puts the pane away, walks to another sheet, and comes back to
    // the pane — the sequence the pane's reveal re-read has to answer for.
    await userClosesPanel(page, rig.panelId);
    await expect(pane(page)).toHaveCount(0, { timeout: 10_000 });
    await clickSheetTab(page, awayIndex);
    await userOpensPanel(page, rig.panelId);
    await expect(pane(page)).toBeVisible({ timeout: 10_000 });

    // The HOST's own slot says why, and names the sheet to go back to.
    await expect(bindingNotice(page)).toBeVisible({ timeout: 10_000 });
    await expect(bindingNotice(page)).toContainText(
      `The cells this pane is bound to are on "${homeName}"`,
    );
    await expect(bindingNotice(page)).toContainText(
      `switch back to "${homeName}" to see and save this pane's cells`,
    );
    // The widgets are not usable while their cells are out of reach...
    await expect(paneWidget(page, "region")).toBeDisabled();
    await expect(paneWidget(page, "customer")).not.toBeEditable();
    // ...and they still show the last value the pane read, not a blank.
    await expect(paneWidget(page, "customer")).toHaveValue("Seed Co");
    await expect(paneFrame(page, "customer")).toContainText(`switch back to "${homeName}"`);

    // NOTHING WAS READ. A reveal off the pinned sheet used to charge the script
    // one refused read per bound cell for a gesture the USER made.
    await page.waitForTimeout(1_000);
    expect(
      (await auditTally(page, rig.paneScriptId, "sheet.getCellData")).total - readsBefore,
      "no cell may be read — refused or otherwise — while the user is on another sheet",
    ).toBe(0);

    // While the user is away, the cell changes on the pinned sheet (an
    // off-sheet write, so the active sheet is untouched).
    await invoke(page, "update_cell_on_sheets", {
      sheetIndices: [homeIndex],
      row: CUSTOMER.row,
      col: CUSTOMER.col,
      value: "Changed while away",
    });

    // Coming back is the user's own gesture, and the pane must be current.
    await clickSheetTab(page, homeIndex);
    await expect(bindingNotice(page), "the notice comes down on the user's return").toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(paneWidget(page, "customer")).toBeEditable();
    await expect(paneWidget(page, "region")).toBeEnabled();
    await expect(
      paneWidget(page, "customer"),
      "the return RE-READS: the widget shows what the cell says now",
    ).toHaveValue("Changed while away", { timeout: 15_000 });
    expect(
      (await auditTally(page, rig.paneScriptId, "sheet.getCellData")).total - readsBefore,
      "the re-read happens on the return, under the script's own audited rows",
    ).toBeGreaterThan(0);

    // And the pane is writable again: what the user types now reaches the cell.
    await fillWidget(page, "customer", "Back home");
    await page.waitForTimeout(TEXT_DEBOUNCE_MS + 400);
    await expect
      .poll(async () => (await readCell(page, rig!, CUSTOMER)).value, { timeout: 10_000 })
      .toBe("Back home");
  });
});
