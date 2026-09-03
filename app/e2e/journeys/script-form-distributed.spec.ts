/**
 * A FORM THAT ARRIVES IN A `.calp` — consent is what decides whether it can
 * ever be on screen.
 *
 * WHAT IS PROVED. A published application carries two object scripts: a `form`
 * (the VBA UserForm replacement) and a `button` that opens it by name through
 * `caps.forms.show`. A subscriber pulls it, and:
 *
 *   DECLINED  no modal appears, neither script is mounted, the form script's
 *             grant set does NOT contain `ui.dialog`, and a LOCAL script that
 *             asks for the form by name is refused by name — "no form named ...
 *             is running (it may not exist, or its package has not been
 *             approved)". A distributed form that nobody approved is not merely
 *             ungranted; it is unreachable.
 *   ACCEPTED  both scripts mount, `ui.dialog` is granted from the package
 *             MANIFEST's ceiling (never from the tamperable source), the
 *             package's own button opens the form, and the host-drawn identity
 *             band names THE PACKAGE and the script that opened it.
 *
 * ...and, in both directions, the LOCAL caller is refused even after consent:
 * `caps.forms.show` resolves a form only among mounted forms of the same TIER
 * AND the same trust ORIGIN (`sameTrustOrigin`, scriptHost/broker.ts), and a
 * package name is not "local". Consent buys the package's own scripts the
 * right to talk to each other, not a door for everyone else.
 *
 * THE TIER CLAMP, VISIBLE. A pulled script is forced to `restricted` at pull
 * (core/calp/src/pull.rs), so a widget the publisher bound to `Sheet2!B2`
 * cannot be read on a subscriber looking at Sheet1. That is not silently
 * dropped and it is not a hard failure either: the widget renders DISABLED,
 * carrying the refusal's own words. A binding the script cannot reach must be
 * visible as such, or the user cannot tell a blank field from a blocked one.
 *
 * WHY A JOURNEY. It publishes a `.calp`, calls File > New, pulls, and drives
 * the real React consent dialog and the real modal. Nothing below this tier has
 * a Worker realm, a registry on disk, or a rendered form.
 *
 * PLUMBING, BORROWED. The publish/pull/registry shape is subscription-restore
 * .spec.ts's; the "read the app's own authorisation state, and pair every
 * refusal with a positive control" discipline is consent-refusal.spec.ts's.
 * The distributed-script consent prompt is REACT (ScriptConsentDialog, buttons
 * "Block" / "Allow Scripts"), not a Win32 TaskDialog, so no native-dialog
 * driver (app/e2e/answer-native-dialog.ps1) is needed here — and `newFile()` in
 * core/lib/file-api.ts prompts about nothing, so no native dialog can appear
 * behind this spec's back either.
 *
 * ONE DOOR INTO THE APP. Every read and reset goes through `/src/api/index.ts`,
 * the `@api` facade the extensions import, resolved through the URL the running
 * app actually loaded (Vite's `?t=` HMR versioning otherwise hands back a
 * PHANTOM module whose registries are empty and whose grant sets are empty —
 * against which every refusal assertion here would pass vacuously). The
 * module-instance check in the first test is what makes the rest meaningful.
 *
 * GRID REAL ESTATE. Column DQ (0-based 120), row 125 (0-based 124) — inside the
 * DP..DR / rows 122..128 band this feature owns, and not one of the cells
 * script-form.spec.ts uses. `Sheet2!B2` is named but never read or written: the
 * whole point of that binding is that the tier refuses it.
 *
 * LOCALE. sv-SE. No formula and no list separator appears here, and the one
 * value the form could write is text.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

// ---------------------------------------------------------------------------
// Fixture layout
// ---------------------------------------------------------------------------

const WORK = path.join(os.tmpdir(), "calcula-script-form-distributed");
const WORKSPACE = path.join(WORK, "workspace");
const FILE_PUBLISHER = path.join(WORK, "publisher.cala");

/**
 * A per-run application name.
 *
 * `consentedPackages` in the ScriptableObjects extension is SESSION state keyed
 * by package name, and one app instance serves the whole suite. A fixed name
 * would mean that a second run against the same running app found the package
 * already consented and never showed the prompt — the decline test would then
 * pass for the wrong reason, which is the exact failure mode this spec exists
 * to rule out.
 */
const RUN = Date.now().toString(36);
const PACKAGE = `script-form-app-${RUN}`;
const VERSION = "1.0.0";

/** Script ids survive publish and pull unchanged, so the grant assertions can name them. */
const FORM_SCRIPT_ID = `dist-form-${RUN}`;
const BUTTON_SCRIPT_ID = `dist-button-${RUN}`;
const FORM_NAME = `Dist Order Form ${RUN}`;
const BUTTON_NAME = `Dist Order Button ${RUN}`;
const BUTTON_INSTANCE = `dist-button-instance-${RUN}`;

/** The subscriber-authored caller: LOCAL origin, so never same-trust with the package. */
const LOCAL_CALLER_ID = `local-caller-${RUN}`;
const LOCAL_CALLER_INSTANCE = `local-caller-instance-${RUN}`;

/** The one binding the pulled form CAN resolve, on the sheet the subscriber is looking at. */
const CUSTOMER_CELL = { row: 124, col: 120, ref: "DQ125" };
/** The binding a restricted script may not reach. Never read, never written. */
const OFFSHEET_BIND = "Sheet2!B2";
const OFFSHEET_SHEET = "Sheet2";

/** The `@api` facade — the same module every extension imports. */
const API = "/src/api/index.ts";
/** The editor's single save gate (transpile + sandbox parse). */
const AUTHORING = "/extensions/ScriptableObjects/lib/authoringLanguage.ts";

// ---------------------------------------------------------------------------
// Page-side typing (no `any`: the harness lint treats it as an error)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/naming-convention --
 * Names the RUNTIME chose, not names this file gets to pick: `__TAURI__` is
 * Tauri's injected bridge, `__calcImport` is installed by main.tsx, and
 * `__appImport`/`__distRun` are this spec's own page-side globals (the
 * double-underscore is the harness convention for them). */
type AppWindow = Window & {
  __calcImport: (url: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
  __distRun?: ParkedRun;
};
/* eslint-enable @typescript-eslint/naming-convention */

interface ParkedRun {
  settled: boolean;
  value: unknown;
  error: string | null;
}

interface SheetInfo {
  index: number;
  name: string;
}

interface ScriptSummary {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  provenance?: string | null;
  packageName?: string | null;
  declaredCapabilities?: string[];
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** Import the module at the URL the RUNNING app loaded it from (newest HMR version last). */
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

async function callApi<T = unknown>(page: Page, fn: string, args: unknown[] = []): Promise<T> {
  return callApp<T>(page, API, fn, args);
}

/** Script Security "enabled" -> the mount gate is a no-op, isolating the CONSENT gate. */
async function allowScripts(page: Page): Promise<void> {
  await invoke(page, "set_script_security_level", { level: "enabled" });
}

async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await callApp(page, "/src/core/lib/file-api.ts", "newFile");
  await page.waitForTimeout(900);
}

/** Both modal registries — a form or dialog left open would refuse the next one. */
async function resetModalRegistries(page: Page): Promise<void> {
  await installAppImport(page);
  await callApi(page, "resetScriptForms").catch(() => undefined);
  await callApi(page, "resetScriptDialogs").catch(() => undefined);
}

async function listScripts(page: Page): Promise<ScriptSummary[]> {
  return invoke<ScriptSummary[]>(page, "list_object_scripts");
}

async function isMounted(page: Page, scriptId: string): Promise<boolean> {
  return page.evaluate(
    async ({ scriptId, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- an exported identifier, not a name this file picks
        ObjectScriptManager: { isScriptMounted: (id: string) => boolean };
      };
      return m.ObjectScriptManager.isScriptMounted(scriptId);
    },
    { scriptId, api: API },
  );
}

async function grantsFor(page: Page, scriptId: string): Promise<string[]> {
  const grants = await callApi<{ caps: string[] }>(page, "getScriptGrants", [scriptId]);
  return grants.caps;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * The published FORM. Two bindings on purpose: one the subscriber's restricted
 * handle can read, and one on another sheet that it cannot — so "the tier
 * refusal is visible" has a control beside it.
 */
function formSource(): string {
  return [
    "// @capability ui.dialog",
    "function setup(form) {",
    "  form.define({",
    '    title: "Distributed order", submitLabel: "Save", width: 460,',
    "    children: [",
    `      { type: "textbox",  name: "customer", label: "Customer", bind: "${CUSTOMER_CELL.ref}", maxLength: 80 },`,
    `      { type: "dropdown", name: "offsheet", label: "Region (other sheet)", bind: "${OFFSHEET_BIND}", options: ["EMEA", "APAC"] },`,
    "    ],",
    "  });",
    "}",
    "",
  ].join("\n");
}

/** The published BUTTON: same package, same tier — the only caller allowed to open the form. */
function packageButtonSource(): string {
  return [
    "// @capability ui.dialog",
    "function setup(button) {",
    '  button.expose("open", async () => {',
    `    try { const answers = await button.caps.forms.show(${JSON.stringify(FORM_NAME)}); return { ok: true, answers }; }`,
    "    catch (e) { return { ok: false, error: ((e && e.code) || '') + ':' + ((e && e.message) || String(e)) }; }",
    "  });",
    "}",
    "",
  ].join("\n");
}

/** The subscriber's OWN script asking for the package's form by name. */
function localCallerSource(): string {
  return [
    "// @capability ui.dialog",
    "function setup(button) {",
    '  button.expose("tryOpen", async () => {',
    `    try { await button.caps.forms.show(${JSON.stringify(FORM_NAME)}); return "SHOWN"; }`,
    '    catch (e) { return "REFUSED:" + ((e && e.code) || "") + ":" + ((e && e.message) || String(e)); }',
    "  });",
    "}",
    "",
  ].join("\n");
}

/**
 * Route a source through the editor's single save gate (transpile + sandbox
 * parse), exactly as Save does, and hand back the JavaScript the app stores.
 * A refusal is a test failure carrying the gate's own reason — a fixture that
 * quietly published un-runnable text would fail later, in the wrong place.
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
// Mounting a LOCAL script (the subscriber's own caller)
// ---------------------------------------------------------------------------

interface LocalScriptInput {
  id: string;
  name: string;
  objectType: string;
  instanceId: string;
  source: string;
  declaredCapabilities: string[];
}

/**
 * Register, GRANT and mount a local script, then wait until its exposed method
 * is registered. The grant is recorded up front because a LOCAL script's first
 * ungranted capability call raises the JIT permission dialog — a second consent
 * surface this spec is not about, and one that would race the package prompt.
 */
async function mountLocalScript(page: Page, def: LocalScriptInput, exposes: string[]): Promise<void> {
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
      m.ObjectScriptManager.registerScript({
        ...def,
        accessLevel: "restricted",
        description: null,
      });
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
          ObjectScriptManager: {
            unmountScript: (id: string) => void;
            removeScript: (id: string) => void;
          };
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

async function callExposed<T = unknown>(
  page: Page,
  objectType: string,
  instanceId: string | null,
  method: string,
): Promise<T> {
  return page.evaluate(
    async ({ objectType, instanceId, method, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        callExposedMethod: (t: string, i: string | null, n: string) => unknown;
      };
      return (await m.callExposedMethod(objectType, instanceId, method)) as unknown;
    },
    { objectType, instanceId, method, api: API },
  ) as Promise<T>;
}

/** Start an exposed method WITHOUT awaiting it: it blocks on the modal this test answers. */
async function startExposed(
  page: Page,
  objectType: string,
  instanceId: string | null,
  method: string,
): Promise<void> {
  await page.evaluate(
    async ({ objectType, instanceId, method, api }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        callExposedMethod: (t: string, i: string | null, n: string) => unknown;
      };
      const parked: ParkedRun = { settled: false, value: undefined, error: null };
      w.__distRun = parked;
      Promise.resolve(m.callExposedMethod(objectType, instanceId, method)).then(
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
    { objectType, instanceId, method, api: API },
  );
}

async function parkedRun(page: Page): Promise<ParkedRun> {
  return page.evaluate(() => {
    const w = window as unknown as AppWindow;
    return w.__distRun ?? { settled: false, value: undefined, error: "no parked run" };
  });
}

async function waitForParkedRun(page: Page, timeout = 20_000): Promise<ParkedRun> {
  await expect.poll(async () => (await parkedRun(page)).settled, { timeout }).toBe(true);
  return parkedRun(page);
}

// ---------------------------------------------------------------------------
// The distribution flow
// ---------------------------------------------------------------------------

/**
 * The event the Subscribe dialog fires after a pull (SubscribeDialog.tsx).
 *
 * `calp_pull` is a BACKEND command: it materializes the scripts into
 * `AppState.object_scripts` and nothing more. What makes the ScriptableObjects
 * extension register them and run the consent flow IN THIS SESSION — rather
 * than only after a save and reopen — is this event. Invoking the command
 * without it would leave the prompt unfired and the whole spec asserting
 * nothing.
 */
async function announcePull(page: Page, version: string, scriptsPulled: number): Promise<void> {
  await page.evaluate(
    async ({ api, packageName, version, scriptsPulled }) => {
      const w = window as unknown as AppWindow;
      const m = (await w.__appImport!(api)) as {
        emitAppEvent: (name: string, detail?: unknown) => void;
        // eslint-disable-next-line @typescript-eslint/naming-convention -- an exported identifier, not a name this file picks
        AppEvents: Record<string, string>;
      };
      m.emitAppEvent(m.AppEvents.PACKAGE_UPDATED, {
        packageName,
        version,
        kind: "subscribe",
        sheetsPulled: 0,
        scriptsPulled,
      });
    },
    { api: API, packageName: PACKAGE, version, scriptsPulled },
  );
}

/** The ScriptConsentDialog's own subtitle — the one string that is only ever on it. */
function consentDialogHeading(page: Page) {
  return page.getByText("This workbook contains scripts from an external package").first();
}

/** Make sure the workbook has a sheet named exactly `Sheet2`, and leave sheet 0 active. */
async function ensureOffSheet(page: Page): Promise<void> {
  let sheets = (await invoke<{ sheets: SheetInfo[] }>(page, "get_sheets")).sheets;
  if (!sheets.some((s) => s.name === OFFSHEET_SHEET)) {
    await invoke(page, "add_sheet", { name: OFFSHEET_SHEET });
    sheets = (await invoke<{ sheets: SheetInfo[] }>(page, "get_sheets")).sheets;
  }
  expect(
    sheets.map((s) => s.name),
    `precondition: "${OFFSHEET_SHEET}" must exist, or the off-sheet binding would be ` +
      `refused as an UNKNOWN SHEET rather than by the restricted-tier clamp — a ` +
      `different refusal with a different message`,
  ).toContain(OFFSHEET_SHEET);
  await invoke(page, "set_active_sheet", { index: 0 });
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(150);
}

// ===========================================================================

test.describe.serial("a `.calp` form: declined, then approved", () => {
  test.beforeAll(() => {
    if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.mkdirSync(WORKSPACE, { recursive: true });
  });

  /**
   * Leave a BLANK document behind.
   *
   * This spec ends holding a subscriber workbook whose backend store still
   * carries two distributed scripts and whose session has consented to them.
   * The next spec in this project inherits that document — and any later
   * `AFTER_OPEN` would re-run `loadAndMountScripts` over those scripts. File >
   * New clears the store, unmounts everything through `AFTER_NEW`, and drops
   * this spec's cell with it, so nothing of ours can surface inside someone
   * else's failure.
   */
  test.afterAll(async ({ sharedPage: page }) => {
    await installAppImport(page).catch(() => undefined);
    await unmountScript(page, LOCAL_CALLER_ID);
    await unmountScript(page, FORM_SCRIPT_ID);
    await unmountScript(page, BUTTON_SCRIPT_ID);
    await newFile(page).catch(() => undefined);
    await resetModalRegistries(page).catch(() => undefined);
  });

  // =========================================================================
  // 1. Publish, subscribe, DECLINE
  // =========================================================================
  test("a declined package's form never appears, is never granted ui.dialog, and cannot be opened by name", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    await installAppImport(page);
    await allowScripts(page);
    await resetModalRegistries(page);

    // ---- THE PUBLISHER ----------------------------------------------------
    await newFile(page);
    expect(
      await listScripts(page),
      "precondition: the publisher workbook must start empty, or the application " +
        "would carry scripts this test never wrote",
    ).toHaveLength(0);

    const formJs = await gateSource(page, formSource(), FORM_NAME);
    const buttonJs = await gateSource(page, packageButtonSource(), BUTTON_NAME);
    // Saved through the ordinary command: `calp_publish` reads
    // `AppState.object_scripts`, so a script that never reached the backend is
    // simply absent from the application.
    await invoke(page, "save_object_script", {
      script: {
        id: FORM_SCRIPT_ID,
        name: FORM_NAME,
        objectType: "form",
        instanceId: `dist-form-instance-${RUN}`,
        source: formJs,
        accessLevel: "restricted",
        description: null,
      },
    });
    await invoke(page, "save_object_script", {
      script: {
        id: BUTTON_SCRIPT_ID,
        name: BUTTON_NAME,
        objectType: "button",
        instanceId: BUTTON_INSTANCE,
        source: buttonJs,
        accessLevel: "restricted",
        description: null,
      },
    });
    const authored = await listScripts(page);
    expect(
      authored.map((s) => s.id).sort(),
      "precondition: both scripts must be in the workbook before it is published",
    ).toEqual([BUTTON_SCRIPT_ID, FORM_SCRIPT_ID].sort());
    // The R19 ceiling the application will carry is lifted from the SOURCE
    // pragmas at publish time, so a script that lost its `// @capability` line
    // would ship with an empty ceiling and the form could never be shown.
    expect(
      authored.find((s) => s.id === FORM_SCRIPT_ID)?.declaredCapabilities ?? [],
      "the form script must declare ui.dialog, or the published ceiling is empty",
    ).toContain("ui.dialog");

    await invoke(page, "save_file", { path: FILE_PUBLISHER });
    await expect
      .poll(() => fs.existsSync(FILE_PUBLISHER), { timeout: 20_000, intervals: [200] })
      .toBe(true);

    const published = await invoke<{ packageName: string; version: string }>(page, "calp_publish", {
      params: {
        registryPath: WORKSPACE,
        packageName: PACKAGE,
        version: VERSION,
        kind: "report",
        sheetIndices: [],
        publishedBy: "e2e",
        includeComments: false,
      },
    });
    expect(
      published.version,
      "precondition: nothing below means anything if the application was not published",
    ).toBe(VERSION);

    // ---- THE SUBSCRIBER ---------------------------------------------------
    // File > New wipes every document-scoped store AND resets the object-script
    // manager (AFTER_NEW), so this is the subscriber's machine as far as the
    // frontend is concerned.
    await newFile(page);
    await resetModalRegistries(page);
    expect(
      await listScripts(page),
      "File > New left the publisher's scripts in the backend store",
    ).toHaveLength(0);
    await ensureOffSheet(page);

    // The subscriber's OWN script, which will ask for the package's form by
    // name. Mounted BEFORE the pull so nothing about its state depends on the
    // consent decision.
    await mountLocalScript(
      page,
      {
        id: LOCAL_CALLER_ID,
        name: "Local Caller",
        objectType: "button",
        instanceId: LOCAL_CALLER_INSTANCE,
        source: localCallerSource(),
        declaredCapabilities: ["ui.dialog"],
      },
      ["tryOpen"],
    );

    // MODULE-INSTANCE CHECK. A mounted script whose grant set is EMPTY means
    // this spec imported a different copy of `@api` (Vite `?t=` HMR
    // versioning); every "not granted" assertion below would then be vacuous.
    expect(
      await grantsFor(page, LOCAL_CALLER_ID),
      "module-instance check: the app's grant set for a just-mounted local script " +
        "is empty, so this spec is talking to a PHANTOM copy of /src/api/index.ts",
    ).toContain("ui.dialog");

    const pull = await invoke<{ scriptsPulled: number; resolvedVersion: string }>(page, "calp_pull", {
      params: { registryPath: WORKSPACE, packageName: PACKAGE, versionPin: VERSION },
    });
    expect(
      pull.scriptsPulled,
      "the pull carried no scripts, so the consent gate below has nothing to gate",
    ).toBe(2);

    const pulled = await listScripts(page);
    const pulledForm = pulled.find((s) => s.id === FORM_SCRIPT_ID);
    expect(pulledForm, "the form script did not survive the pull").toBeTruthy();
    expect(pulledForm?.provenance, "a pulled script must be marked distributed").toBe("distributed");
    expect(pulledForm?.packageName).toBe(PACKAGE);
    // The ceiling is SERVER-authoritative: it comes from the signed manifest,
    // not from the (tamperable) source the subscriber now holds.
    expect(
      pulledForm?.declaredCapabilities ?? [],
      "the pulled ceiling must carry ui.dialog from the application manifest",
    ).toContain("ui.dialog");

    // ---- THE PROMPT -------------------------------------------------------
    await announcePull(page, pull.resolvedVersion, pull.scriptsPulled);
    await expect(consentDialogHeading(page)).toBeVisible({ timeout: 20_000 });
    // `.first()` throughout: `getByText` is not required to resolve to one node
    // (a wrapping paragraph matches its own child's text), and a strict-mode
    // violation here would read as "the prompt did not name the package".
    await expect(page.getByText(`"${PACKAGE}"`, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(FORM_NAME, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(BUTTON_NAME, { exact: false }).first()).toBeVisible();
    // The capability is named in the words the user reads (CAP_DESCRIPTION).
    await expect(
      page.getByText("show you a dialog and receive what you enter").first(),
    ).toBeVisible();

    // ---- DECLINE ----------------------------------------------------------
    await page.getByRole("button", { name: "Block", exact: true }).click();
    await expect(consentDialogHeading(page)).toBeHidden({ timeout: 10_000 });
    // Give a mount that should NOT be happening time to happen anyway.
    await page.waitForTimeout(2_000);

    // (1) NOTHING IS ON SCREEN. A declined form is not a form the user has to
    //     dismiss; it is a form that was never painted.
    await expect(page.locator("[data-script-form]")).toHaveCount(0);
    expect(await callApi(page, "getActiveScriptForm")).toBeNull();

    // (2) NEITHER SCRIPT RUNS.
    expect(await isMounted(page, FORM_SCRIPT_ID), "a declined form script mounted anyway").toBe(false);
    expect(await isMounted(page, BUTTON_SCRIPT_ID), "a declined button script mounted anyway").toBe(
      false,
    );

    // (3) THE GRANT SET IS THE AUTHORITY THE BROKER CONSULTS, AND IT IS EMPTY
    //     OF THE ONE CAPABILITY A FORM NEEDS. Declaring a capability in the
    //     manifest is a CEILING, never a grant.
    expect(
      await grantsFor(page, FORM_SCRIPT_ID),
      "declining still granted the form script ui.dialog",
    ).not.toContain("ui.dialog");
    expect(await grantsFor(page, BUTTON_SCRIPT_ID)).not.toContain("ui.dialog");

    // (4) AND THE FORM IS UNREACHABLE BY NAME. `caps.forms.show` resolves only
    //     among MOUNTED forms, so an unapproved package's form is not merely
    //     un-openable — it does not exist to ask for.
    const refused = await callExposed<string>(page, "button", LOCAL_CALLER_INSTANCE, "tryOpen");
    expect(refused, `caps.forms.show answered "${refused}" for a declined package`).toMatch(
      /^REFUSED:/,
    );
    expect(refused).toContain(`no form named "${FORM_NAME}" is running`);
    expect(refused).toContain("has not been approved");
    await expect(page.locator("[data-script-form]")).toHaveCount(0);
  });

  // =========================================================================
  // 2. ACCEPT — and the local caller is STILL refused
  // =========================================================================
  test("approving the package mounts its form, the band names the package, and a Sheet2 binding is disabled with its reason", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    await installAppImport(page);
    await resetModalRegistries(page);
    await invoke(page, "set_active_sheet", { index: 0 });

    // The extension re-prompts because the decline recorded no consent: the
    // package is neither in this session's `consentedPackages` nor in the
    // workbook's persisted consent file.
    await announcePull(page, VERSION, 2);
    await expect(consentDialogHeading(page)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Allow Scripts", exact: true }).click();
    await expect(consentDialogHeading(page)).toBeHidden({ timeout: 10_000 });

    // The granted handler mounts asynchronously.
    await expect
      .poll(async () => isMounted(page, FORM_SCRIPT_ID), { timeout: 30_000 })
      .toBe(true);
    await expect
      .poll(async () => isMounted(page, BUTTON_SCRIPT_ID), { timeout: 30_000 })
      .toBe(true);
    expect(
      await grantsFor(page, FORM_SCRIPT_ID),
      "consent must GRANT the ceiling the manifest declared",
    ).toContain("ui.dialog");

    // ---- THE CONTROL THAT SURVIVES CONSENT --------------------------------
    // Approving a package does not make its forms public. `caps.forms.show`
    // resolves a form only for a caller of the same TIER and the same trust
    // ORIGIN, and a package name is not "local".
    const localVerdict = await callExposed<string>(page, "button", LOCAL_CALLER_INSTANCE, "tryOpen");
    expect(
      localVerdict,
      "a LOCAL script opened an approved package's form: consent bought the package " +
        "its own scripts, not a door for every script in the workbook",
    ).toMatch(/^REFUSED:/);
    expect(localVerdict).toContain(`no form named "${FORM_NAME}" is running`);
    await expect(page.locator("[data-script-form]")).toHaveCount(0);

    // ---- THE PACKAGE'S OWN BUTTON OPENS IT --------------------------------
    await startExposed(page, "button", BUTTON_INSTANCE, "open");
    await expect(page.locator("[data-script-form]")).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        async () =>
          (await callApi<{ scriptId: string } | null>(page, "getActiveScriptForm"))?.scriptId ?? null,
        { timeout: 10_000 },
      )
      .toBe(FORM_SCRIPT_ID);

    // THE IDENTITY BAND IS HOST CHROME. It names the script, the PACKAGE it
    // came from, and the script that opened it on its behalf — none of which
    // the script can address or spell.
    const band = page.locator("[data-script-form-band]");
    await expect(band).toContainText(FORM_NAME);
    await expect(band, "a distributed form must name its package, not read as local").toContainText(
      `A form from the package "${PACKAGE}"`,
    );
    await expect(band).toContainText(`opened by ${BUTTON_NAME}`);
    // The script's own title is BODY content, below the band.
    await expect(page.locator("[data-script-form-title]")).toHaveText("Distributed order");

    // ---- THE TIER CLAMP, VISIBLE ------------------------------------------
    // Bound to Sheet2!B2 while the subscriber is looking at sheet 0: the read
    // was refused under the script's own handle, so the widget is disabled and
    // carries the refusal's own words rather than showing an empty box.
    const offsheet = page.locator('[data-form-widget="offsheet"]');
    await expect(offsheet).toBeVisible();
    await expect(offsheet, "a binding the tier refuses must not be editable").toBeDisabled();
    await expect(page.locator('[data-form-frame="offsheet"]')).toContainText(
      "Restricted scripts can only reach the sheet you are looking at",
    );

    // ...and the control: the SAME-SHEET binding resolved and is editable.
    const customer = page.locator('[data-form-widget="customer"]');
    await expect(customer).toBeVisible();
    await expect(customer, "the resolvable binding must still be usable").toBeEnabled();
    await expect(band, "the band states which sheet the bindings are pinned to").toContainText(
      "Sheet:",
    );

    // ---- CLOSE ------------------------------------------------------------
    await page.locator("[data-script-form-cancel]").first().click();
    await expect(page.locator("[data-script-form]")).toBeHidden({ timeout: 10_000 });
    const run = await waitForParkedRun(page);
    expect(run.error).toBeNull();
    // The caller receives the answer too: null, because the user closed it.
    expect(run.value).toMatchObject({ ok: true, answers: null });
    expect(await callApi(page, "getActiveScriptForm")).toBeNull();
  });
});
