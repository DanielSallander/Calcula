//! FILENAME: app/extensions/ScriptableObjects/__tests__/packageConsentLoadPath.test.ts
// PURPOSE: The object-script CONSENT LOAD PATH, driven for real — the pass that
//          decides, on every workbook load and every .calp update, which
//          applications are already approved and which get a prompt.
// CONTEXT: Three defects lived in the same ~100 lines of
//          `extensions/ScriptableObjects/index.ts`, and each of them was a
//          package whose code the user could never approve:
//
//   1. THE PASS WAS DRIVEN BY OBJECT SCRIPTS ALONE. The whole block sat behind
//      `if (distributedScripts.length > 0)` and looped a map built only from
//      distributed OBJECT scripts. `core/calp/src/pull.rs` materializes
//      `modules/*.json` independently, so an application shipping only MACROS
//      emitted no SCRIPT_CONSENT_NEEDED (this is its single emitter), wrote no
//      bare-name consent record, and had every macro refused forever by the Rust
//      module gate.
//   2. AN APPLICATION APPROVED THIS SESSION WAS NEVER RE-CHECKED.
//      `isPackageConsentCurrent` — the only place a macro's presence and hash are
//      ever checked — ran only when the session set did not already hold the
//      package. That set is cleared on AFTER_OPEN but NOT by PACKAGE_UPDATED, so
//      a Distribution ▸ Update bringing a new or changed macro recorded nothing.
//   3. THE DIALOG AND THE RECORDER NORMALIZED THE NAME DIFFERENTLY. The prompt
//      named zero macros while the recorder granted them — consent covering
//      artifacts the screen never showed.
//
// WHY THIS SUITE ACTIVATES THE REAL EXTENSION. The failure modes are "no event
// was emitted" and "a check was skipped", which no assertion on a helper can
// see. So the extension is activated against mocked collaborators and a REAL
// consent store over an in-memory virtual filesystem (the technique
// packageMacroConsent.test.ts established), and the suite asserts on the events
// the load path emits and the JSON bytes Rust reads.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ExtensionContext } from "@api/contract";
// NOT mocked: the placeholder spelling and the origin derivation are the very
// things under test, so they are read from the module that owns them.
import { scriptOriginForMount } from "@api/scriptHost/scriptOrigin";

// ===========================================================================
// The workbook's stores, as the load path sees them
// ===========================================================================

/** An object script exactly as `loadAllObjectScripts` hands one over. */
interface FakeObjectScript {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  source: string;
  accessLevel: string;
  provenance?: string;
  packageName?: string;
}

/** A module record, as `listWorkbookScriptRecords` returns one. */
interface FakeModuleRecord {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage: string | null;
  loadError: string | null;
}

/** The consent store's file system. */
const files = new Map<string, string>();
let objectScripts: FakeObjectScript[] = [];
let moduleRecords: FakeModuleRecord[] = [];
let moduleListingThrows: Error | null = null;

/** The mounted/registered state the fake ObjectScriptManager keeps. */
const registeredScripts = new Map<string, FakeObjectScript>();
const mountedScripts = new Set<string>();
/**
 * Every mount/unmount in order, as `"mount:<id>"` / `"unmount:<id>"`.
 *
 * The mounted SET alone cannot see the defect it exists for: after a revoking
 * update the old realm is still mounted, so "is it mounted?" answers yes both
 * before and after a grant that never re-ran it. Only the sequence distinguishes
 * "the approved code was started" from "the old code was left running".
 */
const mountLog: string[] = [];

/** The app-event bus. */
type BusHandler = (detail: unknown) => unknown;
const bus = new Map<string, Set<BusHandler>>();
const emittedEvents: Array<{ name: string; detail: Record<string, unknown> }> = [];
const pendingHandlers: Array<Promise<unknown>> = [];

/** Every toast the extension raised, in order. */
const toasts: string[] = [];

// ===========================================================================
// Mocks
// ===========================================================================
//
// Every factory below references the module-level state ONLY from inside a
// closure. A factory that read one of these bindings directly would run before
// the test module's own `const`s are initialized.
//
// The doubles have to be spelled exactly as the real exports are, and several of
// those are PascalCase (a namespace object, a manager, React components), so the
// identifier-format rule is off for the mock block and back on after it.
/* eslint-disable @typescript-eslint/naming-convention -- the doubles must match the real export names */

vi.mock("@api/backend", () => ({
  readVirtualFile: async (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw new Error("not found");
    return v;
  },
  createVirtualFile: async (p: string, content: string) => {
    files.set(p, content);
  },
}));

vi.mock("@api", async () => {
  const caps = await vi.importActual<typeof import("@api/scriptHost/capabilities")>(
    "@api/scriptHost/capabilities",
  );
  const origin = await vi.importActual<typeof import("@api/scriptHost/scriptOrigin")>(
    "@api/scriptHost/scriptOrigin",
  );
  return {
    AppEvents: {
      AFTER_OPEN: "app:after-open",
      AFTER_NEW: "app:after-new",
      BEFORE_CLOSE: "app:before-close",
      PACKAGE_UPDATED: "app:package-updated",
    },
    DialogExtensions: {
      onChange: () => () => undefined,
      getVisibleDialogs: () => [],
    },
    ObjectScriptManager: {
      registerScript: (s: FakeObjectScript) => {
        registeredScripts.set(s.id, s);
      },
      mountScript: async (id: string) => {
        mountLog.push(`mount:${id}`);
        mountedScripts.add(id);
      },
      unmountScript: (id: string) => {
        mountLog.push(`unmount:${id}`);
        mountedScripts.delete(id);
      },
      isScriptMounted: (id: string) => mountedScripts.has(id),
      getAllScripts: () => [...registeredScripts.values()],
      onScriptChange: () => () => undefined,
    },
    resetObjectScriptManager: () => {
      registeredScripts.clear();
      mountedScripts.clear();
    },
    loadAllObjectScripts: async () => objectScripts,
    saveObjectScript: async () => undefined,
    deleteObjectScript: async () => undefined,
    getScaffoldTemplate: () => "",
    showToast: (message: string) => {
      toasts.push(message);
    },
    resolveCapabilityRequest: () => undefined,
    resolveScriptDialog: () => undefined,
    dismissScriptDialog: () => undefined,
    SCRIPT_DIALOG_REQUEST_EVENT: "scriptable-objects:script-dialog-request",
    // The REAL pragma parser: the capability union the prompt shows is derived
    // with it, and a stub would make every capability assertion meaningless.
    parseDeclaredCapabilities: caps.parseDeclaredCapabilities,
    applyConsentedCapabilities: async () => undefined,
    syncSchedulerPump: async () => undefined,
    stopSchedulerPump: () => undefined,
    // The REAL origin derivation. The load path's consent key IS
    // `scriptOriginForMount`'s answer, which is the point of the fix — a stub
    // here would let the key drift from the mount gate's without a red test.
    scriptOriginForMount: origin.scriptOriginForMount,
    originPackageName: origin.originPackageName,
    IconScript: null,
    IconTemplate: null,
    IconMarketplace: null,
    // The distributed-only door the consent set lists through: the rows whose
    // stamp names a package (decided by the same derivation the real door
    // uses), each resolved to its record. The double holds full records, so the
    // filter is the whole difference from the full inventory.
    listDistributedWorkbookScriptRecords: async () => {
      if (moduleListingThrows) throw moduleListingThrows;
      return moduleRecords.filter((r) => origin.scriptOriginForStoredRecord(r).kind === "package");
    },
  };
});

vi.mock("@api/events", () => ({
  emitAppEvent: (name: string, detail: unknown) => {
    emittedEvents.push({ name, detail: (detail ?? {}) as Record<string, unknown> });
    for (const handler of [...(bus.get(name) ?? [])]) {
      const result = handler(detail);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        pendingHandlers.push(result as Promise<unknown>);
      }
    }
  },
  onAppEvent: (name: string, cb: BusHandler) => {
    const set = bus.get(name) ?? new Set<BusHandler>();
    set.add(cb);
    bus.set(name, set);
    return () => {
      set.delete(cb);
    };
  },
}));

vi.mock("@api/scriptSecurity", () => ({
  ensureScriptsAllowed: async () => true,
}));

vi.mock("@api/scriptHost/host", () => ({
  hostStopTransientDebugSessions: async () => undefined,
  // M3c: activate() hands these to the embedded-form layer. Doubled here for
  // the same reason as everything else in this file — the load path is what is
  // under test, not the surfaces it installs.
  openEmbeddedScriptForm: async () => ({ ok: false, reason: "no host in this test" }),
  closeEmbeddedScriptForm: () => undefined,
}));

vi.mock("@api/scriptHost/scriptFormSpec", () => ({
  SCRIPT_FORM_CLOSE_EVENT: "scriptable-objects:form-close",
  SCRIPT_FORM_INPUT_EVENT: "scriptable-objects:form-input",
  SCRIPT_FORM_REQUEST_EVENT: "scriptable-objects:form-request",
}));

vi.mock("@api/scriptEditorService", () => ({
  registerScriptEditorProvider: () => () => undefined,
}));

vi.mock("../lib/templateManager", () => ({
  listTemplates: async () => [],
  stampFromTemplate: () => ({}),
  loadTemplate: async () => null,
}));

vi.mock("../lib/debugger", () => ({
  installObjectScriptDebugBridge: () => () => undefined,
  reloadPersistedBreakpoints: async () => undefined,
}));

vi.mock("../lib/openObjectScriptWindow", () => ({
  openObjectScriptEditor: async () => undefined,
  openMacroInEditor: async () => undefined,
}));

vi.mock("../lib/scriptDrafts", () => ({
  installScriptDraftReview: () => () => undefined,
  openRememberedDraft: async () => undefined,
}));

vi.mock("../lib/aiEditBridge", () => ({
  installAiEditBridge: () => () => undefined,
  replayAiEditResults: async () => undefined,
}));

vi.mock("../lib/formPreviewBridge", () => ({
  installFormPreviewBridge: () => () => undefined,
  replayFormPreviewResults: async () => undefined,
}));

vi.mock("../lib/scriptPaneHost", () => ({
  installScriptPaneHost: () => () => undefined,
}));

// M3c: the embedded-form surfaces and their grid gestures, doubled like the
// task pane's above. The UX module registers grid context-menu items through
// `gridExtensions`, which this file's `@api` double does not carry.
vi.mock("../lib/embeddedFormUx", () => ({
  registerEmbeddedFormUx: () => () => undefined,
}));
vi.mock("../lib/scriptEmbedHost", () => ({
  installScriptEmbedHost: () => Object.assign(() => undefined, { retry: () => undefined, reconcile: () => undefined }),
}));
vi.mock("../lib/embeddedFormLayer", () => ({
  installEmbeddedFormLayer: () => ({
    deps: {
      paint: () => undefined,
      forget: () => undefined,
      openSession: async () => ({ ok: false, reason: "no layer in this test" }),
      closeSession: () => undefined,
    },
    dispose: () => undefined,
  }),
}));

vi.mock("../lib/cellBehaviorUx", () => ({
  registerCellBehaviorUx: () => () => undefined,
}));

vi.mock("../lib/createForm", () => ({
  createFormScript: async () => ({}),
}));

vi.mock("../lib/crossWindowEvents", () => ({
  onSaveAndApply: async () => () => undefined,
  onRegisterScript: async () => () => undefined,
  onToggleAccess: async () => () => undefined,
  onEditorClosed: async () => () => undefined,
  onEditorReady: async () => () => undefined,
  emitConsoleOutput: () => undefined,
  emitScriptError: () => undefined,
  emitScriptsChanged: () => undefined,
}));

vi.mock("../components/ObjectScriptManagerPane", () => ({ default: () => null }));
vi.mock("../components/PermissionsPanel", () => ({
  MountedScriptsSection: () => null,
  PolicyTableSection: () => null,
  ActivitySection: () => null,
}));
vi.mock("../components/CodeInThisFilePanel", () => ({ CodeInThisFileSection: () => null }));
vi.mock("../components/ScriptConsentDialog", () => ({ default: () => null }));
vi.mock("../components/CapabilityRequestDialog", () => ({ default: () => null }));
vi.mock("../components/ScriptDialogPrompt", () => ({
  default: () => null,
  SCRIPT_DIALOG_ANSWERED_EVENT: "scriptable-objects:script-dialog-answered",
}));
vi.mock("../components/scriptForm", () => ({ ScriptFormDialog: () => null }));
vi.mock("../components/TemplateManagerDialog", () => ({ default: () => null }));
vi.mock("../components/ScriptMarketplace", () => ({ default: () => null }));
/* eslint-enable @typescript-eslint/naming-convention */

// ===========================================================================
// Harness
// ===========================================================================

const CONSENT_FILE = ".calcula/script-consent.json";
const CONSENT_NEEDED = "scriptable-objects:consent-needed";
const PKG = "Quarterly Reports";

const objectScript = (over: Partial<FakeObjectScript> = {}): FakeObjectScript => ({
  id: "obj-refresh",
  name: "Refresh",
  objectType: "button",
  instanceId: "btn-1",
  source: "// @capability storage\nreturn 1;",
  accessLevel: "restricted",
  provenance: "distributed",
  packageName: PKG,
  ...over,
});

const moduleRecord = (over: Partial<FakeModuleRecord> = {}): FakeModuleRecord => ({
  id: "macro-month-end",
  name: "Month end",
  description: "Recorded macro",
  source: "Calcula.setCellValue('A1', 1);",
  sourcePackage: PKG,
  loadError: null,
  ...over,
});

/** A context that records nothing but satisfies every registration `activate` makes. */
function makeContext(): ExtensionContext {
  const noop = (): void => undefined;
  return {
    ui: {
      dialogs: { register: noop, unregister: noop, show: noop, hide: noop },
      menus: { registerItem: noop },
      taskPanes: { register: noop, unregister: noop },
      panels: { register: noop, unregister: noop },
    },
  } as unknown as ExtensionContext;
}

/** Drain every async app-event handler the emit fan-out started. */
async function settle(): Promise<void> {
  while (pendingHandlers.length > 0) {
    const batch = pendingHandlers.splice(0, pendingHandlers.length);
    await Promise.all(batch);
  }
}

interface LoadedExtension {
  activate: (ctx: ExtensionContext) => Promise<void>;
  deactivate: () => void;
}

/** A FRESH copy of the extension: its session consent set starts empty. */
async function activateFreshExtension(): Promise<LoadedExtension> {
  vi.resetModules();
  const mod = (await import("../index")) as { default: LoadedExtension };
  const extension = mod.default;
  await extension.activate(makeContext());
  await settle();
  return extension;
}

/** Every consent prompt the load path asked for, in order. */
function consentPrompts(): Array<Record<string, unknown>> {
  return emittedEvents.filter((e) => e.name === CONSENT_NEEDED).map((e) => e.detail);
}

function promptFor(packageName: string): Record<string, unknown> | undefined {
  return consentPrompts().find((p) => p.packageName === packageName);
}

/**
 * Answer a prompt the way ScriptConsentDialog's Allow button does — echoing the
 * `promptId` of the screen that is actually standing.
 *
 * That echo is the fix for "the prompt and the grant come from two independent
 * listings": the handler grants the artifact set THAT screen enumerated, and
 * refuses a grant it cannot tie to a standing screen. So the harness has to
 * answer the last prompt for the package, exactly as the dialog does — see
 * `allowWithStalePrompt` for the case where it deliberately does not.
 */
async function allow(packageName: string): Promise<void> {
  const prompts = consentPrompts().filter((p) => p.packageName === packageName);
  const promptId = prompts[prompts.length - 1]?.promptId;
  const { emitAppEvent } = await import("@api/events");
  emitAppEvent("scriptable-objects:consent-granted", { packageName, promptId });
  await settle();
}

/** Press Allow on a screen that is no longer the standing one. */
async function allowWithStalePrompt(
  packageName: string,
  promptId: unknown,
): Promise<void> {
  const { emitAppEvent } = await import("@api/events");
  emitAppEvent("scriptable-objects:consent-granted", { packageName, promptId });
  await settle();
}

/**
 * `consent_granted_in` (app/src-tauri/src/calp_commands.rs), over the SAME JSON
 * Rust parses: a record under this application key naming this artifact id with
 * this exact source hash. Asserting through the file rather than through the
 * TypeScript helpers is the point — the backend is what refuses, and it reads
 * the bytes, not our types.
 */
async function consentGrantedIn(
  packageKey: string,
  scriptId: string,
  source: string,
): Promise<boolean> {
  const raw = files.get(CONSENT_FILE);
  if (raw === undefined) return false;
  const { sha256Hex } = await import("@api/distributedConsent");
  const hash = await sha256Hex(source);
  const parsed = JSON.parse(raw) as {
    consents?: Array<{
      packageName?: string;
      scripts?: Array<{ id?: string; sourceHash?: string }>;
    }>;
  };
  return (parsed.consents ?? []).some(
    (r) =>
      r.packageName === packageKey &&
      (r.scripts ?? []).some((s) => s.id === scriptId && s.sourceHash === hash),
  );
}

beforeEach(() => {
  files.clear();
  objectScripts = [];
  moduleRecords = [];
  moduleListingThrows = null;
  registeredScripts.clear();
  mountedScripts.clear();
  mountLog.length = 0;
  bus.clear();
  emittedEvents.length = 0;
  pendingHandlers.length = 0;
  toasts.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// (1) An application that ships ONLY macros must still be approvable
// ===========================================================================

describe("an application that ships only macros is still offered for approval", () => {
  it("prompts for it, naming the macros, with no object script in sight", async () => {
    moduleRecords = [moduleRecord()];
    // Deliberately not empty: a LOCAL object script must not make this pass look
    // like it had distributed object scripts to loop over.
    objectScripts = [
      objectScript({ id: "local-1", provenance: "local", packageName: undefined }),
    ];

    await activateFreshExtension();

    const prompt = promptFor(PKG);
    expect(
      prompt,
      "a .calp shipping macros and no object scripts emitted no consent prompt at all, " +
        "so every one of its macros stays refused forever",
    ).toBeDefined();
    expect(prompt!.scriptCount).toBe(0);
    expect(prompt!.scriptNames).toEqual([]);
    expect(prompt!.moduleScriptNames).toEqual(["Month end"]);
    // The ids travel too, so the prompt's Inspect affordance has something to
    // open when there is no object script to open.
    expect(prompt!.moduleScriptIds).toEqual(["macro-month-end"]);
  });

  it("...and allowing writes the record the Rust module gate reads", async () => {
    moduleRecords = [moduleRecord()];
    await activateFreshExtension();

    // The grant answers a prompt. Asserting the prompt happened keeps this test
    // from passing on a load path that emitted nothing at all.
    expect(promptFor(PKG)).toBeDefined();
    await allow(PKG);

    expect(
      await consentGrantedIn(PKG, "macro-month-end", "Calcula.setCellValue('A1', 1);"),
      "the macro must be in the record under its own id and its own source hash",
    ).toBe(true);
  });

  it("...and the next load does not ask again", async () => {
    moduleRecords = [moduleRecord()];
    await activateFreshExtension();
    expect(promptFor(PKG), "the first load must ask").toBeDefined();
    await allow(PKG);

    emittedEvents.length = 0;
    bus.clear();
    await activateFreshExtension();

    expect(
      promptFor(PKG),
      "a macro-only application that was approved must hydrate as current, not re-prompt",
    ).toBeUndefined();
  });

  it("a package with BOTH kinds is still evaluated once, over both stores", async () => {
    objectScripts = [objectScript()];
    moduleRecords = [moduleRecord()];

    await activateFreshExtension();

    expect(consentPrompts().length).toBe(1);
    const prompt = promptFor(PKG)!;
    expect(prompt.scriptNames).toEqual(["Refresh"]);
    expect(prompt.moduleScriptNames).toEqual(["Month end"]);

    await allow(PKG);
    expect(await consentGrantedIn(PKG, "obj-refresh", objectScript().source)).toBe(true);
    expect(
      await consentGrantedIn(PKG, "macro-month-end", "Calcula.setCellValue('A1', 1);"),
    ).toBe(true);
  });
});

// ===========================================================================
// (2) A package approved this session is re-checked on every pass
// ===========================================================================

describe("freshness is re-evaluated on every load, and it may revoke", () => {
  /** Approve the package, then let a `.calp` refresh land through PACKAGE_UPDATED. */
  async function approveThenRefresh(
    mutate: () => void,
  ): Promise<Array<Record<string, unknown>>> {
    objectScripts = [objectScript()];
    moduleRecords = [moduleRecord()];
    await activateFreshExtension();
    await allow(PKG);

    // The session now holds this application. PACKAGE_UPDATED re-runs the load
    // WITHOUT clearing that set — which is the whole trap.
    emittedEvents.length = 0;
    mutate();
    const { emitAppEvent } = await import("@api/events");
    emitAppEvent("app:package-updated", {});
    await settle();
    return consentPrompts();
  }

  it("a NEW macro arriving in an update re-prompts the application", async () => {
    const prompts = await approveThenRefresh(() => {
      moduleRecords = [
        moduleRecord(),
        moduleRecord({ id: "macro-new", name: "New", source: "1;" }),
      ];
    });

    expect(
      prompts.map((p) => p.packageName),
      "an application approved earlier in the session was never re-checked, so an " +
        "update's new macro was recorded nowhere and stayed refused with no prompt",
    ).toContain(PKG);
    expect(prompts[0].moduleScriptNames).toEqual(["Month end", "New"]);
  });

  it("a CHANGED macro re-prompts, and the prompt shows the diff", async () => {
    const prompts = await approveThenRefresh(() => {
      moduleRecords = [moduleRecord({ source: "Calcula.setCellValue('A1', 999);" })];
    });

    expect(prompts.map((p) => p.packageName)).toContain(PKG);
    const changed = prompts[0].changedScripts as Array<{ id: string; newSource: string }>;
    expect(changed.map((c) => c.id)).toEqual(["macro-month-end"]);
    expect(changed[0].newSource).toBe("Calcula.setCellValue('A1', 999);");
  });

  it("an unchanged application is NOT re-prompted by an update", async () => {
    // The positive control. Revoking on every pass would be just as wrong as
    // never checking: the user would be asked again on every refresh.
    const prompts = await approveThenRefresh(() => undefined);
    expect(prompts).toEqual([]);
  });

  it("a freshness check that THROWS does not count as consent", async () => {
    objectScripts = [objectScript()];
    moduleRecords = [moduleRecord()];
    await activateFreshExtension();
    await allow(PKG);

    emittedEvents.length = 0;
    // `isPackageConsentCurrent` hashes every artifact; the first hash rejects.
    // Everything after it (the re-consent diff) still works, so the prompt this
    // produces is a real one and not a cascade of failures.
    const digest = vi.spyOn(crypto.subtle, "digest");
    digest.mockRejectedValueOnce(new Error("subtle is unavailable"));

    const { emitAppEvent } = await import("@api/events");
    emitAppEvent("app:package-updated", {});
    await settle();

    expect(
      consentPrompts().map((p) => p.packageName),
      '"I could not find out whether you approved this" must never be read as ' +
        "approval, not even for a package the session already held",
    ).toContain(PKG);
  });
});

// ===========================================================================
// (3) One normalization of the application name
// ===========================================================================

describe("the prompt and the recorder agree on the application's name", () => {
  const SPACED = "  Quarterly Reports  ";

  it("a whitespace-bearing name names its macros on the prompt AND in the record", async () => {
    objectScripts = [objectScript({ packageName: SPACED })];
    moduleRecords = [moduleRecord({ sourcePackage: SPACED })];

    await activateFreshExtension();

    const prompt = promptFor(SPACED);
    expect(prompt, "the prompt must be keyed by the same string everything else uses").toBeDefined();
    expect(
      prompt!.moduleScriptNames,
      "the prompt named zero macros while the recorder granted them — consent " +
        "covering artifacts the screen never showed",
    ).toEqual(["Month end"]);

    await allow(SPACED);
    expect(
      await consentGrantedIn(SPACED, "macro-month-end", "Calcula.setCellValue('A1', 1);"),
    ).toBe(true);
    expect(await consentGrantedIn(SPACED, "obj-refresh", objectScript().source)).toBe(true);
  });

  it("the key is the raw name, which is what BOTH backend gates compare", async () => {
    // The module gate asks `consent_granted_in` with the module record's stored
    // `source_package`; the mount gate is called with
    // `scriptOriginForMount(definition).name`. Neither trims, so a trimmed key
    // would write a record neither of them can find.
    objectScripts = [objectScript({ packageName: SPACED })];
    moduleRecords = [moduleRecord({ sourcePackage: SPACED })];
    await activateFreshExtension();
    await allow(SPACED);

    const record = JSON.parse(files.get(CONSENT_FILE)!) as {
      consents: Array<{ packageName: string }>;
    };
    expect(record.consents.map((c) => c.packageName)).toEqual([
      scriptOriginForMount({ provenance: "distributed", packageName: SPACED }).kind === "package"
        ? SPACED
        : "not-a-package",
    ]);
  });

  it("...and the whole application hydrates as current on the next load", async () => {
    objectScripts = [objectScript({ packageName: SPACED })];
    moduleRecords = [moduleRecord({ sourcePackage: SPACED })];
    await activateFreshExtension();
    await allow(SPACED);

    emittedEvents.length = 0;
    bus.clear();
    await activateFreshExtension();
    expect(consentPrompts()).toEqual([]);
  });
});

// ===========================================================================
// The nameless distributed script: one placeholder, the mount gate's
// ===========================================================================

describe("a distributed script that carries no application name", () => {
  // Reachable, and not only in theory: `provenance` and `packageName` are both
  // `#[serde(default)]` on ObjectScriptDef
  // (core/calcula-format/src/features/object_scripts.rs), so a `.cala` carrying
  // `"provenance": "distributed"` and no `packageName` parses straight into this
  // shape — and a `.cala` is a ZIP of JSON that arrives from other people.
  const placeholder = scriptOriginForMount({ provenance: "distributed" });

  it("is grouped under the SAME placeholder the mount gate asks about", async () => {
    objectScripts = [objectScript({ packageName: undefined })];

    await activateFreshExtension();

    expect(placeholder.kind).toBe("package");
    const name = placeholder.kind === "package" ? placeholder.name : "";
    expect(
      promptFor(name),
      "the load path spelled this placeholder differently from " +
        "scriptOriginForMount, so the approval was written under a key " +
        "check_distributed_mount_consent never asks for and every mount was refused",
    ).toBeDefined();
  });

  it("...and its record is written under that same key", async () => {
    objectScripts = [objectScript({ packageName: undefined })];
    await activateFreshExtension();
    const name = placeholder.kind === "package" ? placeholder.name : "";
    await allow(name);

    expect(await consentGrantedIn(name, "obj-refresh", objectScript().source)).toBe(true);
  });
});

// ===========================================================================
// The macro listing's failure is not silently read as "no macros"
// ===========================================================================

describe("a module listing that fails does not fabricate an empty macro set", () => {
  it("the object scripts still get their prompt", async () => {
    objectScripts = [objectScript()];
    moduleListingThrows = new Error("backend down");

    await activateFreshExtension();

    const prompt = promptFor(PKG);
    expect(prompt).toBeDefined();
    expect(prompt!.moduleScriptNames).toEqual([]);
  });
});

// ===========================================================================
// (4) WHAT IS GRANTED IS WHAT WAS DISPLAYED
// ===========================================================================
//
// The prompt listed the workbook once to build `moduleScriptNames` /
// `moduleScriptIds`; the `consent-granted` handler received only
// `{ packageName }` and RE-DERIVED both sets from a second, independent listing.
// The consent dialog is non-modal and `AppEvents.PACKAGE_UPDATED` re-runs the
// whole load, so a Distribution ▸ Update or a gateway pull landing while the
// user reads the screen made Allow record a set the screen never showed. The
// transparency requirement is the exact inverse.
//
// The chosen answer when the workbook has moved on is REFUSE AND RE-PROMPT.
// Granting the stale set would run code the workbook no longer has; granting the
// fresh set would approve code the user never read. Only asking again keeps the
// invariant true, and it costs one extra click in a case that is rare.

describe("a grant is tied to the screen that produced it", () => {
  /** The last prompt emitted for `pkg`, whatever else has happened since. */
  function lastPromptFor(pkg: string): Record<string, unknown> {
    const all = consentPrompts().filter((p) => p.packageName === pkg);
    return all[all.length - 1];
  }

  it("records exactly the artifacts the screen enumerated", async () => {
    // The positive control. Everything below asserts a refusal, so without this
    // the suite would pass on a handler that refuses every grant there is.
    objectScripts = [objectScript()];
    moduleRecords = [moduleRecord()];
    await activateFreshExtension();
    await allow(PKG);

    const record = JSON.parse(files.get(CONSENT_FILE)!) as {
      consents: Array<{ packageName: string; scripts: Array<{ id: string }> }>;
    };
    const prompt = lastPromptFor(PKG);
    const shown = [
      ...(prompt.scriptIds as string[]),
      ...(prompt.moduleScriptIds as string[]),
    ].sort();
    expect(record.consents[0].scripts.map((s) => s.id).sort()).toEqual(shown);
  });

  it("an update that REPLACES the screen makes the old screen's Allow record nothing", async () => {
    objectScripts = [objectScript()];
    moduleRecords = [moduleRecord()];
    await activateFreshExtension();
    const stale = lastPromptFor(PKG).promptId;

    // A Distribution ▸ Update lands while the prompt is open: the load re-runs,
    // the package is re-checked, and a NEW screen is emitted for the new code.
    moduleRecords = [
      moduleRecord(),
      moduleRecord({ id: "macro-new", name: "New", source: "wipeEverything();" }),
    ];
    const { emitAppEvent } = await import("@api/events");
    emitAppEvent("app:package-updated", {});
    await settle();
    expect(lastPromptFor(PKG).promptId, "the update must produce a new screen").not.toBe(stale);

    // ...and NOW the user presses Allow on the screen they were reading.
    const promptsBefore = consentPrompts().length;
    await allowWithStalePrompt(PKG, stale);

    expect(
      files.get(CONSENT_FILE),
      "the grant was applied to a set the screen never showed — 'wipeEverything();' " +
        "was approved by a click on a screen that never named it",
    ).toBeUndefined();
    expect(
      consentPrompts().length,
      "refusing without re-asking would strand the application with no way to approve it",
    ).toBeGreaterThan(promptsBefore);
  });

  it("the workbook moving on UNDER a standing screen is refused too", async () => {
    // The screen is never replaced here — a pull re-materializes the module
    // store between the prompt and the click, before the load path notices. The
    // promptId still matches, so only comparing the artifacts can catch it.
    objectScripts = [objectScript()];
    moduleRecords = [moduleRecord()];
    await activateFreshExtension();
    const standing = lastPromptFor(PKG).promptId;

    moduleRecords = [moduleRecord({ source: "wipeEverything();" })];
    await allowWithStalePrompt(PKG, standing);

    expect(
      files.get(CONSENT_FILE),
      "the macro's body changed under the screen and Allow recorded the NEW body",
    ).toBeUndefined();

    const reasked = lastPromptFor(PKG);
    expect(reasked.promptId, "the user must be asked again").not.toBe(standing);

    // ...and the re-ask is over the code that is REALLY there now: answering it
    // records the new body, so the refusal costs one click and strands nothing.
    await allow(PKG);
    expect(await consentGrantedIn(PKG, "macro-month-end", "wipeEverything();")).toBe(true);
  });

  it("a module listing that fails at Allow does NOT re-prompt into the same failure", async () => {
    // The load path degrades a listing failure to "no macros" and prompts
    // anyway. So a grant handler that treats the same failure as "the workbook
    // moved on" and re-prompts walks straight back into it: Allow, throw,
    // re-prompt, Allow, throw — a screen the user can never satisfy and can
    // never dismiss. "I could not read this" is not "this changed".
    objectScripts = [objectScript()];
    moduleRecords = [moduleRecord()];
    await activateFreshExtension();
    const promptsBefore = consentPrompts().length;

    moduleListingThrows = new Error("backend down");
    await allow(PKG);

    expect(
      files.get(CONSENT_FILE),
      "an unverifiable artifact set must not be approved",
    ).toBeUndefined();
    expect(
      consentPrompts().length,
      "re-prompting on a listing FAILURE is an unbreakable loop, not a second chance",
    ).toBe(promptsBefore);
  });

  it("the re-ask never offers a script the application has REMOVED", async () => {
    // `ObjectScriptManager` is cumulative for the session and never drops a
    // script an update removed from the application; `loadAllObjectScripts()` is
    // the store. Re-prompting from the registry offered to approve — and then
    // mount — code the workbook no longer has.
    objectScripts = [objectScript(), objectScript({ id: "obj-gone", name: "Gone", instanceId: "btn-2" })];
    await activateFreshExtension();
    expect(promptFor(PKG)!.scriptIds).toContain("obj-gone");
    const standing = lastPromptFor(PKG).promptId;

    // The update drops one script from the application. The load has not re-run,
    // so the standing screen still names it — answering it must be refused, and
    // the re-ask must be over what is really there.
    objectScripts = [objectScript()];
    await allowWithStalePrompt(PKG, standing);

    const reasked = lastPromptFor(PKG);
    expect(reasked.promptId, "the user must be asked again").not.toBe(standing);
    expect(
      reasked.scriptIds,
      "the re-ask offered a script the application no longer ships",
    ).not.toContain("obj-gone");
  });

  it("a grant carrying no promptId at all is refused, not trusted", async () => {
    objectScripts = [objectScript()];
    await activateFreshExtension();

    await allowWithStalePrompt(PKG, undefined);

    expect(files.get(CONSENT_FILE)).toBeUndefined();
  });
});

// ===========================================================================
// (4b) THE REFUSAL PATH RE-ASKS A BOUNDED NUMBER OF TIMES
// ===========================================================================
//
// A refused grant re-prompts so the user is never stranded, but each re-prompt
// is a fresh screen, and a workbook that kept changing between screen and click
// would be re-asked on every click forever. No source is known to re-fire
// PACKAGE_UPDATED continuously, so the bound is proportionate: a per-package
// count for the session, printed in the refusal toast, after which the loop
// stops and says so. The next open, or the next update's own load pass, asks
// afresh — and a grant that goes through resets the count.

describe("a refused grant is re-asked a bounded number of times per session", () => {
  /** Press Allow on a screen that never existed — always refused, always re-asked. */
  async function pressAllowOnAGhostScreen(): Promise<void> {
    await allowWithStalePrompt(PKG, "no-such-screen");
  }

  async function activateAndReadTheBound(): Promise<number> {
    await activateFreshExtension();
    // The same module instance `activateFreshExtension` loaded — no reset in
    // between — so this is the number the toasts print.
    const mod = (await import("../index")) as unknown as Record<string, unknown>;
    return mod.MAX_REFUSAL_REPROMPTS_PER_SESSION as number;
  }

  it("re-asks up to the bound, numbering each re-ask in the toast, then stops and says so", async () => {
    objectScripts = [objectScript()];
    const MAX = await activateAndReadTheBound();
    expect(MAX).toBeGreaterThan(0);
    expect(consentPrompts()).toHaveLength(1);

    for (let n = 1; n <= MAX; n++) {
      await pressAllowOnAGhostScreen();
      expect(consentPrompts(), `re-ask ${n} must produce a fresh screen`).toHaveLength(1 + n);
      expect(
        toasts[toasts.length - 1],
        "the user must be able to see how many re-asks are left",
      ).toContain(`re-ask ${n} of ${MAX} this session`);
    }

    // The (MAX+1)th refusal: no new screen, and the toast says the loop ended.
    await pressAllowOnAGhostScreen();
    expect(
      consentPrompts(),
      "an unbounded refusal path re-prompts on every click, forever",
    ).toHaveLength(1 + MAX);
    expect(toasts[toasts.length - 1]).toContain("will not re-ask on its own again");
    expect(toasts[toasts.length - 1]).toContain(`${MAX} times this session`);
    // Nothing was approved at any point.
    expect(files.get(CONSENT_FILE)).toBeUndefined();
  });

  it("the next update's load pass still asks, and a grant that goes through resets the count", async () => {
    objectScripts = [objectScript()];
    const MAX = await activateAndReadTheBound();
    for (let n = 0; n <= MAX; n++) await pressAllowOnAGhostScreen();
    const exhausted = consentPrompts().length;

    // The load pass is NOT the refusal path: an update asks afresh.
    const { emitAppEvent } = await import("@api/events");
    emitAppEvent("app:package-updated", {});
    await settle();
    expect(consentPrompts().length, "the bound must not silence the load pass").toBe(exhausted + 1);

    // A real Allow on that screen goes through...
    await allow(PKG);
    expect(await consentGrantedIn(PKG, "obj-refresh", objectScript().source)).toBe(true);

    // ...and the count starts over: the next refusal is "1 of MAX" again, not
    // "already asked MAX times".
    await pressAllowOnAGhostScreen();
    expect(toasts[toasts.length - 1]).toContain(`re-ask 1 of ${MAX} this session`);
  });

  it("the count is per application: one application's refusals do not spend another's", async () => {
    const OTHER = "Other App";
    objectScripts = [
      objectScript(),
      objectScript({ id: "obj-other", name: "Other", instanceId: "btn-9", packageName: OTHER }),
    ];
    const MAX = await activateAndReadTheBound();
    for (let n = 0; n <= MAX; n++) await pressAllowOnAGhostScreen();
    const otherBefore = consentPrompts().filter((p) => p.packageName === OTHER).length;

    await allowWithStalePrompt(OTHER, "no-such-screen");
    expect(consentPrompts().filter((p) => p.packageName === OTHER)).toHaveLength(otherBefore + 1);
    expect(toasts[toasts.length - 1]).toContain(`re-ask 1 of ${MAX} this session`);
  });
});

// ===========================================================================
// (5) AN ID COLLISION MUST NOT MAKE AN APPLICATION UNAPPROVABLE
// ===========================================================================
//
// The object-script store and the module store have separate id namespaces and
// nothing at publish or pull enforces uniqueness across them. A flat, id-keyed
// consent record cannot hold both, so `packageConsentArtifacts` drops the macro
// — a deliberate "resolve the ambiguity to a refusal" choice. The freshness
// check did not get the memo: it still REQUIRED that macro's hash, which the
// record it had just written could never carry. The application re-prompted on
// every open and pressing Allow could not make it stop.

describe("a macro whose id collides with an object script", () => {
  const collide = (): FakeModuleRecord =>
    moduleRecord({ id: "obj-refresh", name: "Month end", source: "differentBody();" });

  it("is named on the prompt as something Allow will NOT cover", async () => {
    objectScripts = [objectScript()];
    moduleRecords = [collide()];

    await activateFreshExtension();

    const prompt = promptFor(PKG)!;
    expect(
      prompt.moduleScriptNames,
      "it cannot be approved, so it must not be listed among what allowing approves",
    ).toEqual([]);
    expect(
      prompt.unapprovableMacroNames,
      "the prompt must SAY what it cannot approve rather than looping silently",
    ).toEqual(["Month end"]);
  });

  it("...and Allow ends the prompt for good", async () => {
    objectScripts = [objectScript()];
    moduleRecords = [collide()];
    await activateFreshExtension();
    expect(promptFor(PKG), "the first load must ask").toBeDefined();
    await allow(PKG);

    emittedEvents.length = 0;
    bus.clear();
    await activateFreshExtension();

    expect(
      promptFor(PKG),
      "the record could never satisfy the freshness check, so the application " +
        "re-prompted on every open and Allow could never end the loop",
    ).toBeUndefined();
  });

  it("the colliding macro is still NOT in the record — it stays refused at Run", async () => {
    // The safety half. Ending the loop must not be done by approving the thing
    // that could not be identified.
    objectScripts = [objectScript()];
    moduleRecords = [collide()];
    await activateFreshExtension();
    await allow(PKG);

    expect(await consentGrantedIn(PKG, "obj-refresh", "differentBody();")).toBe(false);
    expect(await consentGrantedIn(PKG, "obj-refresh", objectScript().source)).toBe(true);
  });
});

// ===========================================================================
// (6) APPROVING CHANGED CODE MUST START THAT CODE
// ===========================================================================
//
// PACKAGE_UPDATED re-runs the load WITHOUT `resetObjectScriptManager`, so a
// realm mounted from the OLD source stays live while `registerScript` swaps the
// definition underneath it and the hash check revokes the package. The grant's
// mount loop was guarded by `if (!isScriptMounted(script.id))`, so the
// still-running old realm was skipped: the user approved the new code and the
// old code kept running — under whatever capability set it had already been
// granted, which the new source may have widened.

describe("Allow after a revoking update re-mounts, it does not just re-record", () => {
  async function approveThenChangeTheCode(): Promise<void> {
    objectScripts = [objectScript()];
    await activateFreshExtension();
    await allow(PKG);
    expect(mountLog, "the first grant must actually mount it").toEqual([
      "mount:obj-refresh",
    ]);

    // The publisher ships new code for the same script id.
    objectScripts = [
      objectScript({ source: "// @capability storage\nwipeEverything();" }),
    ];
    const { emitAppEvent } = await import("@api/events");
    emitAppEvent("app:package-updated", {});
    await settle();
  }

  it("the update revokes and re-prompts while the OLD realm is still live", async () => {
    await approveThenChangeTheCode();
    expect(promptFor(PKG), "a changed script must re-prompt").toBeDefined();
    expect(
      mountedScripts.has("obj-refresh"),
      "the premise: the load path deliberately leaves it running",
    ).toBe(true);
  });

  it("...and Allow restarts it, so the approved source is what runs", async () => {
    await approveThenChangeTheCode();
    mountLog.length = 0;

    await allow(PKG);

    expect(
      mountLog,
      "the mount loop skipped anything already mounted, so the user approved the " +
        "new code and the OLD realm kept running",
    ).toEqual(["unmount:obj-refresh", "mount:obj-refresh"]);
  });
});
