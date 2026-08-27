//! FILENAME: app/extensions/ScriptableObjects/__tests__/objectScriptEditorDraft.test.tsx
// PURPOSE: The Object Script Editor's AI-draft review mode: a drafted script is
//          shown for review, is labelled as never-saved and never-mounted, and
//          reaches no persistence path until the human presses Save.
// CONTEXT: The MCP `draft_object_script` tool promises the agent that its draft
//          "is queued for the user to review in the Object Script Editor".
//          These tests pin what the user is actually shown when it arrives, and
//          the fact that opening it writes nothing. Monaco is stubbed by
//          vitest.config, so the assertions are on the chrome around the editor
//          — the banner, the selector, the status bar and the Save button —
//          which is precisely where the honesty claims live.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OpenWithDraftPayload, ScriptDraft } from "../lib/crossWindowEvents";

// --- Cross-window bridge: capture the draft listener --------------------------
let draftHandler: ((payload: OpenWithDraftPayload) => void) | null = null;
let aiResultHandler: ((payload: unknown) => void) | null = null;
const aiRequests: Array<Record<string, unknown>> = [];
const emitSaveAndApply = vi.fn(async () => {});
const emitRegisterScript = vi.fn(async () => {});
const emitToggleAccess = vi.fn(async () => {});
vi.mock("../lib/crossWindowEvents", () => ({
  ObjectScriptEditorEvents: {},
  emitSaveAndApply: (...a: unknown[]) => emitSaveAndApply(...(a as [])),
  emitRegisterScript: (...a: unknown[]) => emitRegisterScript(...(a as [])),
  emitToggleAccess: (...a: unknown[]) => emitToggleAccess(...(a as [])),
  emitEditorClosed: vi.fn(async () => {}),
  emitEditorReady: vi.fn(async () => {}),
  onOpenWithScript: async () => () => {},
  onOpenWithDraft: async (cb: (payload: OpenWithDraftPayload) => void) => {
    draftHandler = cb;
    return () => { draftHandler = null; };
  },
  onOpenWithModuleMacro: async () => () => {},
  onConsoleOutput: async () => () => {},
  onScriptError: async () => () => {},
  onScriptsChanged: async () => () => {},
  // "Edit with AI" channels. The editor subscribes to the two on* channels on
  // mount; installAiEditClient catches a missing export's throw and AI editing
  // is then silently absent (one console.warn per missing channel) with the
  // window still mounting. Mocked here so the subscriptions succeed — and
  // captured, because the decided-draft tests below deliver proposals.
  emitAiEditRequest: async (p: Record<string, unknown>) => {
    aiRequests.push(p);
  },
  emitAiEditCancel: async () => {},
  onAiEditProgress: async () => () => {},
  onAiEditResult: async (cb: (p: unknown) => void) => {
    aiResultHandler = cb;
    return () => { aiResultHandler = null; };
  },
}));

// --- Backend ------------------------------------------------------------------
const saveObjectScript = vi.fn(async () => {});
const loadAllObjectScripts = vi.fn(async () => [] as unknown[]);
// The authoring log. Declared here because the editor imports these four by
// name: vitest throws at the access for an export the factory does not
// declare, and the save path catches that in the same try/catch that absorbs
// a failed log write (the save still lands — "still saves the draft when the
// history write fails" below pins exactly that). The four are declared so the
// log writes are observable calls rather than silently-skipped throws.
const adoptScriptAuthoringRuns = vi.fn(async () => {});
const appendScriptAuthoringRun = vi.fn(async () => {});
const clearScriptAuthoringRuns = vi.fn(async () => {});
const getScriptAuthoringRuns = vi.fn(async () => [] as unknown[]);
vi.mock("@api/objectScriptBackend", () => ({
  loadAllObjectScripts: (...a: unknown[]) => loadAllObjectScripts(...(a as [])),
  saveObjectScript: (...a: unknown[]) => saveObjectScript(...(a as [])),
  adoptScriptAuthoringRuns: (...a: unknown[]) => adoptScriptAuthoringRuns(...(a as [])),
  appendScriptAuthoringRun: (...a: unknown[]) => appendScriptAuthoringRun(...(a as [])),
  clearScriptAuthoringRuns: (...a: unknown[]) => clearScriptAuthoringRuns(...(a as [])),
  getScriptAuthoringRuns: (...a: unknown[]) => getScriptAuthoringRuns(...(a as [])),
}));
// `@api/dialogs` MUST be doubled for the rename tests: the real `promptAsync`
// builds a DOM overlay whose promise resolves only when someone clicks it, so an
// unmocked call hangs the test rather than failing it. This file doubles eleven
// modules and did not double this one, because nothing here reached a dialog
// until Rename existed.
const promptAsync = vi.fn(async () => "Refresh sales" as string | null);
vi.mock("@api/dialogs", () => ({
  promptAsync: (...a: unknown[]) => promptAsync(...(a as [])),
  confirmAsync: vi.fn(async () => false),
  alertAsync: vi.fn(async () => {}),
}));
vi.mock("@api/backend", () => ({
  listenTauriEvent: async () => () => {},
  emitTauriEvent: async () => {},
}));
vi.mock("../lib/openObjectScriptWindow", () => ({
  openObjectScriptEditor: async () => {},
  openObjectScriptEditorWithDraft: async () => {},
  isObjectScriptEditorOpen: () => false,
}));

// --- @api barrel --------------------------------------------------------------
const hostValidateScript = vi.fn(async () => ({ ok: true }));
vi.mock("@api", () => ({
  getScaffoldTemplate: () => "// scaffold",
  getContextDocumentation: () => [],
  hostValidateScript: (...a: unknown[]) => hostValidateScript(...(a as [])),
  showToast: vi.fn(),
  saveObjectScript: (...a: unknown[]) => saveObjectScript(...(a as [])),
}));
vi.mock("@api/scriptTranspile", () => ({ prefetchScriptTranspiler: () => {} }));

// --- Editor support modules ---------------------------------------------------
vi.mock("../lib/templateManager", () => ({
  listTemplates: async () => [],
  saveTemplate: async () => {},
  createTemplateFromScript: () => ({}),
  stampFromTemplate: () => ({}),
  loadTemplate: async () => null,
  deleteTemplate: async () => {},
}));
vi.mock("../lib/debugger", () => ({
  clearBreakpoints: () => {},
  shiftBreakpoints: () => {},
  subscribeRemoteDebugState: () => () => {},
  setRemoteDebugTransport: () => {},
  runAtCursor: async () => ({ status: "noFunction", message: "" }),
}));
vi.mock("../components/DebugPanel", () => ({
  breakpointShift: () => null,
  DebugPanel: () => null,
  DebugToolbar: () => null,
  injectDebugStyles: () => {},
  useDebugSession: () => ({
    session: null,
    decorations: [],
    breakpointLines: [],
    send: () => {},
    fire: () => {},
    toggleLine: () => {},
  }),
}));
vi.mock("../lib/monacoTypings", () => ({
  configureObjectScriptTypings: () => {},
  setActiveContextType: () => {},
  annotateScaffold: (s: string) => s,
  // The API Reference heading reads the interface name out of the generated
  // typings now, so a partial mock that omits it throws inside the sidebar.
  contextInterfaceNameFor: (objectType: string) => objectType,
}));
const gateObjectScriptSave = vi.fn(async (src: string) => ({
  ok: true as const,
  javascript: src,
  transformed: false,
  detail: "",
}));
vi.mock("../lib/authoringLanguage", () => ({
  objectScriptModelPath: () => "inmemory://script.js",
  registerJavascriptLane: () => {},
  registerTypescriptLane: () => {},
  gateObjectScriptSave: (...a: unknown[]) =>
    (gateObjectScriptSave as unknown as (...x: unknown[]) => unknown)(...a),
}));

import { ObjectScriptEditorApp } from "../components/ObjectScriptEditorApp";
import { __resetAiEditClient } from "../lib/aiEditClient";

const DRAFT: ScriptDraft = {
  id: "draft-abc123",
  name: "Refresh the report",
  objectType: "button",
  instanceId: "btn-1",
  description: "Pulls the latest figures when clicked",
  source: "export function setup(context) { context.log('drafted'); }",
  declaredCapabilities: ["net.fetch"],
  createdAt: "2026-08-02T10:00:00Z",
  mounted: false,
};

let container: HTMLDivElement;
let root: Root;

// jsdom has no layout, so it has no scrollIntoView; the console pane calls it
// on every render. Same shim the other component tests in this repo use for
// React's act environment flag.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

async function mountApp(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ObjectScriptEditorApp));
  });
}

async function deliverDraft(draft: ScriptDraft = DRAFT): Promise<void> {
  expect(draftHandler, "the editor never subscribed to objscript:open-with-draft").toBeTruthy();
  await act(async () => {
    draftHandler!({ draft });
  });
}

/**
 * Let the banner's lazy capability scan land.
 *
 * The effect imports `@api/scriptHost/scriptValidation` on demand — the surface
 * it reaches is ~94 KB and an AI draft is a rare document. Importing it here
 * first puts it in the module registry, so all that is left to flush is the
 * promise chain and the re-render it causes.
 */
async function settleCapabilityScan(): Promise<void> {
  await import("@api/scriptHost/scriptValidation");
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Object Script Editor — AI draft review mode", () => {
  beforeEach(() => {
    draftHandler = null;
    saveObjectScript.mockClear();
    emitSaveAndApply.mockClear();
    emitRegisterScript.mockClear();
    gateObjectScriptSave.mockClear();
    adoptScriptAuthoringRuns.mockClear();
    appendScriptAuthoringRun.mockClear();
    loadAllObjectScripts.mockClear();
    promptAsync.mockClear();
    promptAsync.mockResolvedValue("Refresh sales");
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("shows the draft under a banner that says it is not saved and not mounted", async () => {
    await mountApp();
    await deliverDraft();

    const banner = container.querySelector("[data-testid='ai-draft-banner']");
    expect(banner, "no AI-draft banner rendered").toBeTruthy();
    const text = banner!.textContent ?? "";
    expect(text).toMatch(/not saved/i);
    expect(text).toMatch(/not mounted/i);
    expect(text).toMatch(/none of it has run/i);
    // The reviewer must be told what the code declared BEFORE deciding.
    expect(text).toContain("net.fetch");
    expect(text).toContain("restricted");

    // The status bar must not claim the document is saved.
    expect(container.textContent).toContain("Never saved");
    expect(container.textContent).not.toContain("AI DRAFT — Refresh the reportSaved");
  });

  // WHAT THE DRAFT ASKS FOR THAT NOTHING IN IT APPEARS TO USE. The reviewer
  // grants exactly these capabilities by pressing Save, and the banner used to
  // say only what was declared.
  it("names a declared capability no call in the draft appears to need", async () => {
    await mountApp();
    await deliverDraft({
      ...DRAFT,
      source: "// @capability net.fetch\nexport function setup(context) { context.log('hi'); }",
    });
    await settleCapabilityScan();

    const line = container.querySelector("[data-testid='ai-draft-unobserved']");
    expect(line, "the banner never said the declaration was unused").toBeTruthy();
    expect(line!.textContent).toContain("net.fetch");
  });

  it("says nothing when the draft actually uses what it declares", async () => {
    // The control. Without it the assertion above passes for a banner that
    // shouts about every declaration, which would train the reviewer to ignore
    // the line entirely.
    await mountApp();
    await deliverDraft({
      ...DRAFT,
      source:
        "// @capability net.fetch\nexport async function setup(context) { await context.caps.fetch('https://example.com'); }",
    });
    await settleCapabilityScan();

    expect(container.querySelector("[data-testid='ai-draft-unobserved']")).toBeNull();
  });

  it("reads the PRAGMAS, not the draft's declaredCapabilities list", async () => {
    // The default fixture declares net.fetch on the payload over a source with
    // no pragma at all. Production cannot emit that shape — the draft's list is
    // parsed out of the source it carries (`app/src-tauri/src/mcp/drafts.rs:159`
    // -> `core/persistence/src/lib.rs:1705`) — and the scan deliberately reads
    // the source, because the source is what will run.
    await mountApp();
    await deliverDraft();
    await settleCapabilityScan();

    expect(container.querySelector("[data-testid='ai-draft-unobserved']")).toBeNull();
    // ...while the banner still reports what the payload claims.
    expect(container.querySelector("[data-testid='ai-draft-banner']")!.textContent).toContain(
      "net.fetch",
    );
  });

  // THE SECURITY PROPERTY: arriving is inert.
  it("writes nothing when the draft arrives", async () => {
    await mountApp();
    await deliverDraft();

    expect(saveObjectScript).not.toHaveBeenCalled();
    expect(emitSaveAndApply).not.toHaveBeenCalled();
    expect(emitRegisterScript).not.toHaveBeenCalled();
  });

  // Switching scripts auto-saves the current one. A draft must be exempt:
  // wandering off the review must not be what commits AI code to the workbook.
  it("does not persist the draft when the author selects another script", async () => {
    await mountApp();
    await deliverDraft();

    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe(select.options[0].value);
    expect(select.options[0].textContent).toContain("AI DRAFT");

    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(saveObjectScript).not.toHaveBeenCalled();
    expect(emitSaveAndApply).not.toHaveBeenCalled();
  });

  // ...and Save DOES go through the ordinary gate + save + mount path, so the
  // human's decision is the only thing that promotes it.
  it("promotes the draft only through the normal gated save path", async () => {
    await mountApp();
    await deliverDraft();

    const save = [...container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").includes("Save as Script"),
    ) as HTMLButtonElement | undefined;
    expect(save, "no 'Save as Script' button for a draft").toBeTruthy();
    expect(save!.disabled).toBe(false);

    await act(async () => { save!.click(); });

    expect(gateObjectScriptSave).toHaveBeenCalledTimes(1);
    expect(saveObjectScript).toHaveBeenCalledTimes(1);
    expect(emitSaveAndApply).toHaveBeenCalledTimes(1);
    const stored = saveObjectScript.mock.calls[0][0] as unknown as {
      source: string; accessLevel: string; id: string; objectType: string;
    };
    expect(stored.source).toBe(DRAFT.source);
    expect(stored.accessLevel).toBe("restricted");
    expect(stored.objectType).toBe("button");
    expect(stored.id).not.toBe(DRAFT.id);

    // Once promoted it is an ordinary script: the review banner is gone.
    expect(container.querySelector("[data-testid='ai-draft-banner']")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The authoring history follows the draft into the workbook
// ---------------------------------------------------------------------------

/** Click a testid and let the promise chain behind it settle. */
async function clickTestId(testid: string): Promise<void> {
  const el = container.querySelector(`[data-testid='${testid}']`) as HTMLElement | null;
  expect(el, `no element with data-testid='${testid}'`).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function clickSave(): Promise<void> {
  const save = [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").includes("Save as Script"),
  ) as HTMLButtonElement | undefined;
  expect(save, "no 'Save as Script' button for a draft").toBeTruthy();
  await act(async () => {
    save!.click();
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

describe("Object Script Editor — a draft's authoring history", () => {
  beforeEach(() => {
    draftHandler = null;
    saveObjectScript.mockClear();
    emitSaveAndApply.mockClear();
    adoptScriptAuthoringRuns.mockClear();
    appendScriptAuthoringRun.mockClear();
    adoptScriptAuthoringRuns.mockImplementation(async () => {});
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("re-keys the run that WROTE the draft onto the id it was saved as", async () => {
    // The run was recorded in the main window against the `draft-*` id, because
    // that is the only id that existed then. This is the instant the script
    // gains a persisted identity, and both ids are in hand.
    let bannerStillUp: boolean | null = null;
    adoptScriptAuthoringRuns.mockImplementation(async () => {
      // A WEAK BUT REAL ORDERING WITNESS: the promotion has not been committed
      // to the DOM yet when the adopt runs.
      bannerStillUp = !!container.querySelector("[data-testid='ai-draft-banner']");
    });

    await mountApp();
    await deliverDraft();
    await clickSave();

    expect(adoptScriptAuthoringRuns).toHaveBeenCalledTimes(1);
    const [fromId, toId] = adoptScriptAuthoringRuns.mock.calls[0] as unknown as [string, string];
    expect(fromId).toBe(DRAFT.id);
    const stored = saveObjectScript.mock.calls[0][0] as unknown as { id: string };
    expect(toId).toBe(stored.id);
    expect(toId).not.toBe(DRAFT.id);
    expect(bannerStillUp).toBe(true);
    // Nothing was DECIDED in this window, so nothing extra is written.
    expect(appendScriptAuthoringRun).not.toHaveBeenCalled();
  });

  it("adopts nothing for a draft that is never saved", async () => {
    await mountApp();
    await deliverDraft();

    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(adoptScriptAuthoringRuns).not.toHaveBeenCalled();
    expect(appendScriptAuthoringRun).not.toHaveBeenCalled();
  });

  it("still saves the draft when the history write fails", async () => {
    // A log line is not worth a script. The save has already happened by the
    // time the history is carried over, and reporting "Failed to save" about a
    // save that succeeded would be the worse lie.
    adoptScriptAuthoringRuns.mockRejectedValue(new Error("no such workbook"));

    await mountApp();
    await deliverDraft();
    await clickSave();

    expect(saveObjectScript).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='ai-draft-banner']")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deciding about an AI edit WHILE reviewing a draft
// ---------------------------------------------------------------------------
//
// The owner decision is that EDIT runs persist when the author DECIDES —
// reject included — and a draft is no exception: the decision is appended
// under the `draft-*` id (the one key the backend accepts before Save) and
// `adoptScriptAuthoringRuns` re-keys it onto the minted id when the draft is
// saved. recordDecision used to early-return on `isDraft`, which dropped the
// decided run everywhere: these tests pin the repaired path end to end.

/** Everything an `AuthoringRun` carries, with a real run id. */
function runFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-1",
    kind: "edit",
    outcome: "changed",
    startedAt: "2026-08-26T09:00:00.000Z",
    elapsedMs: 5_000,
    instruction: "tighten it",
    objectType: "button",
    providerId: "ollama",
    model: "qwen3.5:9b",
    tier: "assisted",
    surfaceTokens: 1200,
    surfaceTruncated: false,
    summary: "Tightened it.",
    attempts: [],
    notices: [],
    changedNothing: false,
    unexercisedHooks: [],
    ...over,
  };
}

async function typeInto(el: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Open the AI composer, type an instruction, and send it. */
async function askAi(instruction: string): Promise<void> {
  await clickTestId("ai-edit-toggle");
  const box = container.querySelector(
    "[data-testid='ai-edit-instruction']",
  ) as HTMLTextAreaElement | null;
  expect(box, "the composer never opened").toBeTruthy();
  await typeInto(box!, instruction);
  await clickTestId("ai-edit-ask");
}

/** Deliver a successful proposal for the document the editor asked about. */
async function deliverAiProposal(source: string): Promise<void> {
  expect(aiResultHandler, "the editor never subscribed to AI results").toBeTruthy();
  expect(aiRequests, "the editor never sent an AI-edit request").toHaveLength(1);
  await act(async () => {
    aiResultHandler!({
      documentId: aiRequests[0].documentId,
      jobId: "job-1",
      ok: true,
      source,
      summary: "Tightened it.",
      unexercisedHooks: [],
      run: runFixture(),
      instruction: "tighten it",
      askedAgainst: DRAFT.source,
    });
    await Promise.resolve();
  });
}

describe("Object Script Editor — deciding about an AI edit on a draft", () => {
  beforeEach(() => {
    draftHandler = null;
    aiResultHandler = null;
    aiRequests.length = 0;
    saveObjectScript.mockClear();
    emitSaveAndApply.mockClear();
    adoptScriptAuthoringRuns.mockClear();
    adoptScriptAuthoringRuns.mockImplementation(async () => {});
    appendScriptAuthoringRun.mockClear();
    __resetAiEditClient();
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("persists a Reject under the draft-* id — the owner-decision case", async () => {
    await mountApp();
    await deliverDraft();
    await askAi("tighten it");
    await deliverAiProposal("export function setup(context) { /* PROPOSED */ }");
    await clickTestId("ai-edit-reject");

    expect(appendScriptAuthoringRun).toHaveBeenCalledTimes(1);
    const [id, run] = appendScriptAuthoringRun.mock.calls[0] as unknown as [
      string,
      { runId: string; decision: string; decidedAt: string },
    ];
    expect(id).toBe(DRAFT.id);
    expect(run.runId).toBe("run-1");
    expect(run.decision).toBe("rejected");
    expect(run.decidedAt).toBeTruthy();
    // Deciding about an edit is not saving the draft.
    expect(saveObjectScript).not.toHaveBeenCalled();
    expect(adoptScriptAuthoringRuns).not.toHaveBeenCalled();
  });

  it("appends an Accept under the draft-* id and rides the adopt at Save", async () => {
    await mountApp();
    await deliverDraft();
    await askAi("tighten it");
    await deliverAiProposal("export function setup(context) { /* ACCEPTED */ }");
    await clickTestId("ai-edit-accept");

    // The decision was appended under the DRAFT id at the instant it was made.
    expect(appendScriptAuthoringRun).toHaveBeenCalledTimes(1);
    expect(appendScriptAuthoringRun.mock.calls[0][0] as unknown as string).toBe(DRAFT.id);
    expect(
      (appendScriptAuthoringRun.mock.calls[0][1] as unknown as { decision: string }).decision,
    ).toBe("accepted");

    await clickSave();

    // Save re-keys the whole draft bucket — decided edit run included — onto
    // the minted id. The decided run is null in the client by now, so the
    // save-time pending backstop appends nothing: still exactly one append.
    expect(adoptScriptAuthoringRuns).toHaveBeenCalledTimes(1);
    const [fromId, toId] = adoptScriptAuthoringRuns.mock.calls[0] as unknown as [string, string];
    expect(fromId).toBe(DRAFT.id);
    const stored = saveObjectScript.mock.calls[0][0] as unknown as { id: string; source: string };
    expect(toId).toBe(stored.id);
    expect(toId).not.toBe(DRAFT.id);
    expect(stored.source).toContain("ACCEPTED");
    expect(appendScriptAuthoringRun).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Rename — the escape hatch for a name the author did not choose
// ---------------------------------------------------------------------------

const SAVED_SCRIPT = {
  id: "btn-9",
  name: "Colour cells",
  objectType: "button",
  instanceId: "inst-9",
  source: "export function setup(context) { context.log('stored'); }",
  accessLevel: "restricted",
  enabled: true,
  provenance: "local",
};

describe("Object Script Editor — Rename", () => {
  beforeEach(() => {
    draftHandler = null;
    saveObjectScript.mockClear();
    emitSaveAndApply.mockClear();
    emitRegisterScript.mockClear();
    promptAsync.mockClear();
    promptAsync.mockResolvedValue("Refresh sales");
    loadAllObjectScripts.mockResolvedValue([] as unknown[]);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("renames a DRAFT in place, writing nothing", async () => {
    // An AI draft arrives named after the request that produced it, and this is
    // the cheapest possible fix when that name is wrong. A draft has no backend
    // record, so renaming it must not be the gesture that creates one.
    await mountApp();
    await deliverDraft();
    await clickTestId("script-rename");

    const option = container.querySelector("select option") as HTMLOptionElement;
    expect(option.textContent).toContain("AI DRAFT — Refresh sales (button)");
    expect(saveObjectScript).not.toHaveBeenCalled();
    expect(emitSaveAndApply).not.toHaveBeenCalled();
  });

  it("renames a SAVED script without remounting it", async () => {
    // `emitSaveAndApply` unmounts and remounts the script in the main window,
    // re-running setup() for what is a cosmetic change. Registering refreshes
    // the registry and nothing else.
    loadAllObjectScripts.mockResolvedValue([SAVED_SCRIPT]);
    await mountApp();
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    await clickTestId("script-rename");

    expect(saveObjectScript).toHaveBeenCalledTimes(1);
    const stored = saveObjectScript.mock.calls[0][0] as unknown as { name: string; source: string };
    expect(stored.name).toBe("Refresh sales");
    // THE STORED TEXT, not the buffer: a rename must neither save nor discard
    // unsaved edits.
    expect(stored.source).toBe(SAVED_SCRIPT.source);
    expect(emitRegisterScript).toHaveBeenCalledTimes(1);
    expect(emitSaveAndApply).not.toHaveBeenCalled();
  });

  it("writes nothing when the author cancels, clears it, or keeps the name", async () => {
    loadAllObjectScripts.mockResolvedValue([SAVED_SCRIPT]);
    await mountApp();
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

    for (const answer of [null, "", "   ", SAVED_SCRIPT.name]) {
      promptAsync.mockResolvedValue(answer as string | null);
      await clickTestId("script-rename");
    }

    expect(promptAsync).toHaveBeenCalledTimes(4);
    expect(saveObjectScript).not.toHaveBeenCalled();
    expect(emitRegisterScript).not.toHaveBeenCalled();
  });
});
