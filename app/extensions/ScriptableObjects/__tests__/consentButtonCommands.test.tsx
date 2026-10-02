//! FILENAME: app/extensions/ScriptableObjects/__tests__/consentButtonCommands.test.tsx
// PURPOSE: plan_M8 S3 -- the approval screen covers an application's COMMAND
//          buttons, under their own key. A button cell that came with an
//          application runs a Calcula command only after an approval recorded
//          under `button-commands:<application>` (the key Rust's command gate
//          asks), so the load pass must be able to ask for one -- and Allow
//          must record exactly the commands the screen showed, and nothing
//          under the application's bare key on their account.
// CONTEXT: Before S3 an application whose only "code" was command buttons never
//          reached the prompt: the load pass took the union of object scripts,
//          macros and button actions only, and `repromptPackage` returned early
//          when they were empty. Rust's refusal ("you have not approved that
//          ... The approval screen comes back the next time this workbook is
//          opened or the application is updated") named a screen that never
//          came.
//
//          WHY ITS OWN KEY. `recordConsent` replaces a key's whole record, so a
//          command approval under the bare key would erase (or be erased by)
//          the application's object-script/macro approval; and the bare key is
//          the object-script mount floor's key, which admits a mount on ANY
//          non-empty record under it -- a command approval there would open it.
//
//          WHAT THE SCREEN MAY ASK. Only a command a click could run once
//          approved: its LIVE registration opts in (`distributableTrigger`) and
//          is not shadowed -- the page's rule (`judgeApplicationCommand`), the
//          one the click applies. Any other stamped command is NAMED as one that
//          will not run and never recorded: approving a command that can never
//          run is a false yes.
//
// The extension is activated for real against the Tauri-shaped doubles of
// packageConsentLoadPath.test.ts (the REAL consent store over the shared double
// of its two Rust commands) and a registry double behind the REAL @api facade.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExtensionContext } from "@api/contract";
import { registerExtensionRegistryService, type CommandDefinition, type ExtensionRegistryService } from "@api/extensions";
import { createConsentStoreDouble } from "../../../src/api/__tests__/helpers/consentStoreDouble";

// ===========================================================================
// The workbook's stores, as the load path sees them
// ===========================================================================

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

interface FakeModuleRecord {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage: string | null;
  loadError: string | null;
}

const consentStore = createConsentStoreDouble();
let objectScripts: FakeObjectScript[] = [];
let moduleRecords: FakeModuleRecord[] = [];
/** The cell-type assignments of sheet 1 ("Dashboard"), as `get_all_cell_types` returns them. */
let cellTypes: Array<Record<string, unknown>> = [];
let cellTypeListingThrows: Error | null = null;

const registeredScripts = new Map<string, FakeObjectScript>();
const mountedScripts = new Set<string>();

type BusHandler = (detail: unknown) => unknown;
const bus = new Map<string, Set<BusHandler>>();
const emittedEvents: Array<{ name: string; detail: Record<string, unknown> }> = [];
const pendingHandlers: Array<Promise<unknown>> = [];
const toasts: string[] = [];

async function workbookBackend(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (cmd === "get_sheets") {
    return { sheets: [{ index: 0, name: "Sheet1" }, { index: 1, name: "Dashboard" }] };
  }
  if (cmd === "get_all_controls") return [];
  if (cmd === "get_all_cell_types") {
    if (cellTypeListingThrows) throw cellTypeListingThrows;
    return Number(args?.sheetIndex) === 1 ? cellTypes : [];
  }
  throw new Error(`consentButtonCommands: no answer for backend command "${cmd}"`);
}

/* eslint-disable @typescript-eslint/naming-convention -- the doubles must match the real export names */

vi.mock("@api/backend", () => ({
  invokeBackend: (cmd: string, args?: Record<string, unknown>) =>
    consentStore.handles(cmd) ? consentStore.invoke(cmd, args) : workbookBackend(cmd, args),
}));

vi.mock("@api", async () => {
  const caps = await vi.importActual<typeof import("@api/scriptHost/capabilities")>("@api/scriptHost/capabilities");
  const origin = await vi.importActual<typeof import("@api/scriptHost/scriptOrigin")>("@api/scriptHost/scriptOrigin");
  return {
    AppEvents: {
      AFTER_OPEN: "app:after-open",
      AFTER_NEW: "app:after-new",
      BEFORE_CLOSE: "app:before-close",
      PACKAGE_UPDATED: "app:package-updated",
    },
    DialogExtensions: { onChange: () => () => undefined, getVisibleDialogs: () => [] },
    ObjectScriptManager: {
      registerScript: (s: FakeObjectScript) => {
        registeredScripts.set(s.id, s);
      },
      mountScript: async (id: string) => {
        mountedScripts.add(id);
      },
      unmountScript: (id: string) => {
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
    parseDeclaredCapabilities: caps.parseDeclaredCapabilities,
    applyConsentedCapabilities: async () => undefined,
    syncSchedulerPump: async () => undefined,
    stopSchedulerPump: () => undefined,
    scriptOriginForMount: origin.scriptOriginForMount,
    originPackageName: origin.originPackageName,
    IconScript: null,
    IconTemplate: null,
    IconMarketplace: null,
    listDistributedWorkbookScriptRecords: async () =>
      moduleRecords.filter((r) => origin.scriptOriginForStoredRecord(r).kind === "package"),
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

vi.mock("@api/scriptSecurity", () => ({ ensureScriptsAllowed: async () => true }));
vi.mock("@api/heldButtonCode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/heldButtonCode")>()),
  listButtonsRunningMacro: async () => [],
}));
vi.mock("@api/scriptHost/host", () => ({
  hostStopTransientDebugSessions: async () => undefined,
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
  requireScriptEditorProvider: () => ({ openMacroInEditor: async () => undefined }),
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
vi.mock("../lib/scriptPaneHost", () => ({ installScriptPaneHost: () => () => undefined }));
vi.mock("../lib/embeddedFormUx", () => ({ registerEmbeddedFormUx: () => () => undefined }));
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
vi.mock("../lib/cellBehaviorUx", () => ({ registerCellBehaviorUx: () => () => undefined }));
vi.mock("../lib/createForm", () => ({ createFormScript: async () => ({}) }));
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
// The command registry: the shell's stacking, behind the real @api facade
// ===========================================================================

const stacks = new Map<string, CommandDefinition[]>();

function register(command: CommandDefinition): void {
  const stack = stacks.get(command.id) ?? [];
  stack.push(command);
  stacks.set(command.id, stack);
}

const registryService = {
  registerCommand: register,
  getCommand: (id: string) => {
    const stack = stacks.get(id);
    return stack ? stack[stack.length - 1] : undefined;
  },
  isCommandShadowed: (id: string) => (stacks.get(id)?.length ?? 0) > 1,
  getAllCommands: () => [...stacks.values()].map((s) => s[s.length - 1]),
} as unknown as ExtensionRegistryService;

registerExtensionRegistryService(registryService);

const FLAGGED_ID = "reader.refresh";
const FLAGGED_NAME = "Refresh the report";

function registerDefaults(): void {
  register({ id: FLAGGED_ID, name: FLAGGED_NAME, distributableTrigger: true, execute: () => undefined });
  register({ id: "reader.export", name: "Export the report", distributableTrigger: true, execute: () => undefined });
  register({ id: "cellTypes.clear", name: "Clear Cell Type", execute: () => undefined });
}

// ===========================================================================
// Harness
// ===========================================================================

const CONSENT_NEEDED = "scriptable-objects:consent-needed";
const PKG = "Quarterly Reports";
const COMMAND_KEY = `button-commands:${PKG}`;

/** A stamped button cell on Dashboard whose live action is a command. */
function commandCell(
  row: number,
  col: number,
  commandId: string,
  caption: string,
  application: string | null = PKG,
): Record<string, unknown> {
  return {
    sheetIndex: 1,
    row,
    col,
    typeId: "calcula.button",
    params: {
      label: caption,
      action: { kind: "command", commandId },
      ...(application !== null ? { fromApplication: { workspace: "ws", application, version: "1.0.0" } } : {}),
    },
  };
}

const moduleRecord = (over: Partial<FakeModuleRecord> = {}): FakeModuleRecord => ({
  id: "macro-month-end",
  name: "Month end",
  description: "Recorded macro",
  source: "Calcula.setCellValue('A1', 1);",
  sourcePackage: PKG,
  loadError: null,
  ...over,
});

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

async function settle(): Promise<void> {
  while (pendingHandlers.length > 0) {
    const batch = pendingHandlers.splice(0, pendingHandlers.length);
    await Promise.all(batch);
  }
}

async function activateFreshExtension(): Promise<void> {
  vi.resetModules();
  // A fresh module graph has a fresh @api facade: hand it the registry again,
  // as the shell's bootstrap does at startup.
  (await import("@api/extensions")).registerExtensionRegistryService(registryService);
  const mod = (await import("../index")) as { default: { activate: (ctx: ExtensionContext) => Promise<void> } };
  await mod.default.activate(makeContext());
  await settle();
}

/** A `.calp` update landing: the load pass runs again. */
async function packageUpdated(): Promise<void> {
  const { emitAppEvent } = await import("@api/events");
  emitAppEvent("app:package-updated", {});
  await settle();
}

function consentPrompts(): Array<Record<string, unknown>> {
  return emittedEvents.filter((e) => e.name === CONSENT_NEEDED).map((e) => e.detail);
}

function promptsFor(pkg: string): Array<Record<string, unknown>> {
  return consentPrompts().filter((p) => p.packageName === pkg);
}

function lastPromptFor(pkg: string): Record<string, unknown> | undefined {
  const all = promptsFor(pkg);
  return all[all.length - 1];
}

async function allowPrompt(pkg: string, promptId: unknown): Promise<void> {
  const { emitAppEvent } = await import("@api/events");
  emitAppEvent("scriptable-objects:consent-granted", { packageName: pkg, promptId });
  await settle();
}

async function allow(pkg: string): Promise<void> {
  await allowPrompt(pkg, lastPromptFor(pkg)?.promptId);
}

/** The keys Rust's store holds records under. */
function recordedKeys(): string[] {
  return consentStore
    .records()
    .map((r) => r.packageName)
    .sort();
}

function recordedIds(key: string): string[] {
  return (consentStore.records().find((r) => r.packageName === key)?.scripts ?? []).map((s) => s.id).sort();
}

beforeEach(() => {
  consentStore.reset();
  objectScripts = [];
  moduleRecords = [];
  cellTypes = [];
  cellTypeListingThrows = null;
  registeredScripts.clear();
  mountedScripts.clear();
  bus.clear();
  emittedEvents.length = 0;
  pendingHandlers.length = 0;
  toasts.length = 0;
  stacks.clear();
  registerDefaults();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// The load pass asks for an application whose only code is a command button
// ===========================================================================

describe("an application whose only code is a command button", () => {
  // SABOTAGE (1): leave the command groups out of the load pass's union -> no
  // prompt at all.
  it("is prompted once, naming the command and the buttons that run it", async () => {
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh")];
    await activateFreshExtension();
    const prompts = promptsFor(PKG);
    expect(prompts, "an application whose only code is a command button was never asked about").toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt.scriptCount).toBe(0);
    expect(prompt.moduleScriptNames).toEqual([]);
    expect(prompt.commandButtons).toEqual([
      {
        commandId: FLAGGED_ID,
        commandName: FLAGGED_NAME,
        buttons: [{ cell: "Dashboard!B2", caption: "Refresh", kind: "cell" }],
      },
    ]);
    expect(prompt.commandsWontRun).toEqual([]);
  });

  // SABOTAGE (3): write an EMPTY bare record beside the command record -> the
  // store refuses it (an approval lists no code), nothing is approved, red.
  it("Allow writes button-commands:<application> and NO bare record", async () => {
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh")];
    await activateFreshExtension();
    await allow(PKG);
    expect(recordedKeys(), "a command approval went somewhere other than its own key").toEqual([COMMAND_KEY]);
    expect(
      consentStore.grantedIn(COMMAND_KEY, FLAGGED_ID, FLAGGED_ID),
      "the command is not approved at the sha256 of its own id -- the question Rust's gate asks",
    ).toBe(true);
    expect(consentStore.requests.map((r) => r.packageName), "a bare record was sent at all").toEqual([COMMAND_KEY]);
    expect(consentStore.requests[0].grantedCapabilities, "a command grants no capability").toEqual([]);
  });

  // SABOTAGE (2): always ask the bare key in isPackageConsentCurrent -> no bare
  // record exists, so the application asks again forever.
  it("after Allow the next pass does not prompt again -- no bare record is needed", async () => {
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh")];
    await activateFreshExtension();
    await allow(PKG);
    emittedEvents.length = 0;
    bus.clear();
    await activateFreshExtension();
    expect(promptsFor(PKG), "an approved command-only application asked again").toEqual([]);
  });

  it("two buttons running the same command are one item with both buttons", async () => {
    cellTypes = [commandCell(4, 4, FLAGGED_ID, "Again"), commandCell(1, 1, FLAGGED_ID, "Refresh")];
    await activateFreshExtension();
    expect(lastPromptFor(PKG)!.commandButtons).toEqual([
      {
        commandId: FLAGGED_ID,
        commandName: FLAGGED_NAME,
        buttons: [
          { cell: "Dashboard!B2", caption: "Refresh", kind: "cell" },
          { cell: "Dashboard!E5", caption: "Again", kind: "cell" },
        ],
      },
    ]);
  });

  it("another application's command button and the user's own are not this application's to approve", async () => {
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Theirs", "Someone Else"), commandCell(2, 2, FLAGGED_ID, "Mine", null)];
    await activateFreshExtension();
    expect(promptsFor(PKG)).toEqual([]);
    expect(promptsFor("Someone Else")).toHaveLength(1);
    expect(consentPrompts().map((p) => p.packageName)).toEqual(["Someone Else"]);
  });
});

// ===========================================================================
// Only a command a click could run is asked about
// ===========================================================================

describe("a command no click could run is named, never approved", () => {
  // SABOTAGE (6): list every stamped command as approvable, flagged or not ->
  // cellTypes.clear is offered and recorded.
  it("a stamped command whose live registration lacks the flag is listed as one that will not run, and not recorded", async () => {
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh"), commandCell(2, 1, "cellTypes.clear", "Clear")];
    await activateFreshExtension();
    const prompt = lastPromptFor(PKG)!;
    expect((prompt.commandButtons as Array<{ commandId: string }>).map((c) => c.commandId)).toEqual([FLAGGED_ID]);
    expect(prompt.commandsWontRun).toEqual([
      {
        commandId: "cellTypes.clear",
        commandName: "Clear Cell Type",
        why: "it is not on Calcula's list of commands a button from an application may run",
        buttons: [{ cell: "Dashboard!B3", caption: "Clear", kind: "cell" }],
      },
    ]);
    await allow(PKG);
    expect(recordedIds(COMMAND_KEY), "a command that can never run was approved").toEqual([FLAGGED_ID]);
  });

  it("a shadowed command and an unregistered one will not run either, each with its reason", async () => {
    register({ id: "reader.export", name: "Export (replaced)", distributableTrigger: true, execute: () => undefined });
    cellTypes = [
      commandCell(1, 1, FLAGGED_ID, "Refresh"),
      commandCell(2, 1, "reader.export", "Export"),
      commandCell(3, 1, "nowhere.command", "Gone"),
    ];
    await activateFreshExtension();
    const wontRun = lastPromptFor(PKG)!.commandsWontRun as Array<{ commandId: string; why: string }>;
    expect(wontRun.map((c) => [c.commandId, c.why])).toEqual([
      ["nowhere.command", "it is not registered in Calcula"],
      ["reader.export", "another registration has replaced Calcula's own command of that name"],
    ]);
  });

  it("an application whose only commands will not run is not asked at all: Allow could approve nothing", async () => {
    cellTypes = [commandCell(1, 1, "cellTypes.clear", "Clear")];
    await activateFreshExtension();
    expect(promptsFor(PKG)).toEqual([]);
    expect(consentStore.requests).toEqual([]);
  });
});

// ===========================================================================
// Two keys, two records, neither erases the other
// ===========================================================================

describe("an application with a macro AND a command button", () => {
  // SABOTAGE (4): record the commands under the BARE key -> the second record
  // replaces the first, and the macro's approval is gone.
  it("one Allow keeps both records, and a later Allow of one does not erase the other", async () => {
    moduleRecords = [moduleRecord()];
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh")];
    await activateFreshExtension();
    const prompt = lastPromptFor(PKG)!;
    expect(prompt.moduleScriptNames).toEqual(["Month end"]);
    expect((prompt.commandButtons as unknown[]).length).toBe(1);
    await allow(PKG);
    expect(recordedKeys()).toEqual([PKG, COMMAND_KEY].sort());
    expect(recordedIds(PKG), "a command id went into the bare record").toEqual(["macro-month-end"]);
    expect(consentStore.grantedIn(PKG, "macro-month-end", "Calcula.setCellValue('A1', 1);")).toBe(true);
    expect(consentStore.grantedIn(COMMAND_KEY, FLAGGED_ID, FLAGGED_ID)).toBe(true);

    // The macro changes upstream: asked again, allowed again.
    moduleRecords = [moduleRecord({ source: "Calcula.setCellValue('A1', 2);" })];
    await packageUpdated();
    expect(promptsFor(PKG).length, "a changed macro must re-ask").toBe(2);
    await allow(PKG);
    expect(consentStore.grantedIn(PKG, "macro-month-end", "Calcula.setCellValue('A1', 2);")).toBe(true);
    expect(
      consentStore.grantedIn(COMMAND_KEY, FLAGGED_ID, FLAGGED_ID),
      "re-approving the macro erased the command's approval",
    ).toBe(true);
  });
});

// ===========================================================================
// Freshness covers commands
// ===========================================================================

describe("the freshness check covers command buttons", () => {
  // SABOTAGE (5): leave the commands out of isPackageConsentCurrent -> a new
  // command button never re-asks, and Rust refuses it at every click.
  it("a refresh that brings a NEW command asks again; the same command does not", async () => {
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh")];
    await activateFreshExtension();
    await allow(PKG);
    expect(promptsFor(PKG)).toHaveLength(1);

    await packageUpdated();
    expect(promptsFor(PKG), "the same approved command asked again").toHaveLength(1);

    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh"), commandCell(2, 1, "reader.export", "Export")];
    await packageUpdated();
    expect(promptsFor(PKG), "a command button the application newly brought was never asked about").toHaveLength(2);
    expect((lastPromptFor(PKG)!.commandButtons as Array<{ commandId: string }>).map((c) => c.commandId)).toEqual([
      "reader.export",
      FLAGGED_ID,
    ]);
  });
});

// ===========================================================================
// What is granted is what was shown
// ===========================================================================

describe("Allow records exactly the commands the screen showed", () => {
  // SABOTAGE (7): compare only `pending.artifacts` in the moved-on check -> the
  // new command is recorded on a screen that never named it.
  it("a command button added while the screen is open makes Allow refuse and ask again", async () => {
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh")];
    await activateFreshExtension();
    const standing = lastPromptFor(PKG)!.promptId;

    // A refresh lands on the store while the screen is open (before the load
    // pass notices).
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh"), commandCell(2, 1, "reader.export", "Export")];
    await allowPrompt(PKG, standing);

    expect(consentStore.requests, "Allow recorded a command set the screen never showed").toEqual([]);
    expect(toasts.some((t) => t.includes("changed while its approval screen was open"))).toBe(true);
    const reasked = lastPromptFor(PKG)!;
    expect(reasked.promptId, "the user was not asked again").not.toBe(standing);
    expect((reasked.commandButtons as Array<{ commandId: string }>).map((c) => c.commandId)).toEqual([
      "reader.export",
      FLAGGED_ID,
    ]);

    // ...and the re-ask is over what is really there: answering it records it.
    await allow(PKG);
    expect(recordedIds(COMMAND_KEY)).toEqual(["reader.export", FLAGGED_ID]);
  });

  it("a cell-type listing that fails at Allow approves nothing and does not loop", async () => {
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh")];
    await activateFreshExtension();
    const before = promptsFor(PKG).length;
    cellTypeListingThrows = new Error("backend down");
    await allow(PKG);
    expect(consentStore.requests).toEqual([]);
    expect(promptsFor(PKG).length, "a listing failure re-prompted into the same failure").toBe(before);
  });
});

// ===========================================================================
// The screen
// ===========================================================================

describe("the approval screen's command section", () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  async function renderPrompt(prompt: Record<string, unknown>): Promise<void> {
    const { default: Dialog } = await vi.importActual<typeof import("../components/ScriptConsentDialog")>(
      "../components/ScriptConsentDialog",
    );
    await act(async () => {
      root.render(<Dialog isOpen={true} onClose={() => undefined} data={prompt} />);
    });
  }

  // SABOTAGE: drop the command section from ScriptConsentDialog -> red.
  it("lists each command with its buttons, says what allowing means, and names the ones that will not run", async () => {
    cellTypes = [
      commandCell(1, 1, FLAGGED_ID, "Refresh"),
      commandCell(4, 4, FLAGGED_ID, "Again"),
      commandCell(2, 1, "cellTypes.clear", "Clear"),
    ];
    await activateFreshExtension();
    await renderPrompt(lastPromptFor(PKG)!);

    const section = host.querySelector<HTMLElement>("[data-consent-commands]");
    expect(section, "the screen does not show the command buttons it approves").not.toBeNull();
    expect(section!.textContent).toContain("Buttons that run a Calcula command (2)");
    const item = host.querySelector<HTMLElement>(`[data-consent-command="${FLAGGED_ID}"]`);
    expect(item?.textContent).toContain(`"${FLAGGED_NAME}" (${FLAGGED_ID})`);
    const buttons = host.querySelector<HTMLElement>(`[data-consent-command-buttons="${FLAGGED_ID}"]`);
    expect(buttons?.textContent).toContain('Dashboard!B2 "Refresh" (button cell)');
    expect(buttons?.textContent).toContain('Dashboard!E5 "Again" (button cell)');
    expect(section!.textContent).toContain("part of Calcula");
    expect(section!.textContent).toContain("decide when it runs");

    const wontRun = host.querySelector<HTMLElement>("[data-consent-command-wont-run]");
    expect(wontRun?.textContent).toContain('"Clear Cell Type" (cellTypes.clear)');
    expect(wontRun?.textContent).toContain("will not run even if you allow it");
    expect(wontRun?.textContent).toContain("not on Calcula's list of commands a button from an application may run");
    expect(host.querySelector('[data-consent-command="cellTypes.clear"]'), "a command that cannot run was offered").toBeNull();
  });

  it("Block records nothing", async () => {
    cellTypes = [commandCell(1, 1, FLAGGED_ID, "Refresh")];
    await activateFreshExtension();
    await renderPrompt(lastPromptFor(PKG)!);
    const block = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Block");
    expect(block).toBeDefined();
    await act(async () => {
      block!.click();
    });
    await settle();
    expect(consentStore.requests).toEqual([]);
    // A late Allow for that screen is refused: the screen was answered.
    await allow(PKG);
    expect(consentStore.requests, "Allow recorded against a screen already answered with Block").toEqual([]);
  });
});
