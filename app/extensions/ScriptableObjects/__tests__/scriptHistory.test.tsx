//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptHistory.test.tsx
// PURPOSE: The rule that keeps a Tauri event channel out of the workbook:
//
//              NOTHING IS WRITTEN DOWN UNTIL A HUMAN DECIDES.
//
// CONTEXT: 2026-08-26. The authoring history is persisted state, and the thing
//          that produces it — `objscript:ai-edit-result` — is an event another
//          window emits. If a result could write on ARRIVAL, then asking for an
//          edit and rejecting it would dirty the workbook, a replayed delivery
//          would append a second copy of a run nobody made twice, and the
//          channel itself would be a write path into a persisted store.
//
//          So the write point is the BUTTON, and this file pins that: arrival
//          writes nothing, Accept and Reject write exactly one run each with the
//          decision that was actually made, and the record carries what was
//          asked and what came back.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- Cross-window bridge ------------------------------------------------------
let aiResultHandler: ((payload: unknown) => void) | null = null;
const aiRequests: Array<Record<string, unknown>> = [];
vi.mock("../lib/crossWindowEvents", () => ({
  ObjectScriptEditorEvents: {},
  emitSaveAndApply: vi.fn(async () => {}),
  emitRegisterScript: vi.fn(async () => {}),
  emitToggleAccess: vi.fn(async () => {}),
  emitEditorClosed: vi.fn(async () => {}),
  emitEditorReady: vi.fn(async () => {}),
  onOpenWithScript: async () => () => {},
  onOpenWithDraft: async () => () => {},
  onOpenWithModuleMacro: async () => () => {},
  onConsoleOutput: async () => () => {},
  onScriptError: async () => () => {},
  onScriptsChanged: async () => () => {},
  emitAiEditRequest: async (p: Record<string, unknown>) => {
    aiRequests.push(p);
  },
  emitAiEditCancel: async () => {},
  onAiEditProgress: async () => () => {},
  onAiEditResult: async (cb: (p: unknown) => void) => {
    aiResultHandler = cb;
    return () => {};
  },
}));

// --- Backend ------------------------------------------------------------------
const SCRIPT = {
  id: "btn-1",
  name: "Colour cells",
  objectType: "button",
  instanceId: "inst-1",
  source: "export function setup(context) { context.log('original'); }",
  accessLevel: "restricted",
  enabled: true,
  provenance: "local",
};
const saveObjectScript = vi.fn(async () => {});
const appendScriptAuthoringRun = vi.fn(async () => {});
const adoptScriptAuthoringRuns = vi.fn(async () => {});
const clearScriptAuthoringRuns = vi.fn(async () => {});
const getScriptAuthoringRuns = vi.fn(async () => [] as unknown[]);
vi.mock("@api/objectScriptBackend", () => ({
  loadAllObjectScripts: async () => [SCRIPT],
  saveObjectScript: (...a: unknown[]) => saveObjectScript(...(a as [])),
  appendScriptAuthoringRun: (...a: unknown[]) => appendScriptAuthoringRun(...(a as [])),
  adoptScriptAuthoringRuns: (...a: unknown[]) => adoptScriptAuthoringRuns(...(a as [])),
  clearScriptAuthoringRuns: (...a: unknown[]) => clearScriptAuthoringRuns(...(a as [])),
  getScriptAuthoringRuns: (...a: unknown[]) => getScriptAuthoringRuns(...(a as [])),
}));
vi.mock("@api/backend", () => ({
  listenTauriEvent: async () => () => {},
  emitTauriEvent: async () => {},
}));
vi.mock("@api/workbookScripts", () => ({
  listWorkbookScriptRecords: async () => [],
  getWorkbookScript: async () => {
    throw new Error("no modules here");
  },
  saveWorkbookScript: async () => {},
  onWorkbookScriptsChanged: async () => () => {},
  parseModuleScriptRuntime: () => null,
  WORKBOOK_SCRIPTS_CHANGED_EVENT: "workbook:module-scripts-changed",
}));
vi.mock("../lib/openObjectScriptWindow", () => ({
  openObjectScriptEditor: async () => {},
  openObjectScriptEditorWithDraft: async () => {},
  isObjectScriptEditorOpen: () => false,
}));
vi.mock("@api", () => ({
  getScaffoldTemplate: () => "// scaffold",
  getContextDocumentation: () => [],
  hostValidateScript: async () => ({ ok: true }),
  showToast: vi.fn(),
  saveObjectScript: (...a: unknown[]) => saveObjectScript(...(a as [])),
}));
vi.mock("@api/dialogs", () => ({
  promptAsync: vi.fn(async () => null),
  confirmAsync: vi.fn(async () => false),
  alertAsync: vi.fn(async () => {}),
}));
vi.mock("@api/scriptTranspile", () => ({ prefetchScriptTranspiler: () => {} }));
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
  getDebugSession: () => null,
  stopDebugSessionAndWait: async () => {},
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
    isPaused: false,
    busy: false,
    error: null,
    inertMount: true,
    start: () => {},
    stop: () => {},
    send: () => {},
    fire: () => {},
    toggleLine: () => {},
  }),
}));
vi.mock("../lib/monacoTypings", () => ({
  configureObjectScriptTypings: () => {},
  setActiveContextType: () => {},
  annotateScaffold: (s: string) => s,
  contextInterfaceNameFor: (objectType: string) => objectType,
}));
vi.mock("../lib/authoringLanguage", () => ({
  objectScriptModelPath: () => "inmemory://script.js",
  registerJavascriptLane: () => {},
  registerTypescriptLane: () => {},
  gateObjectScriptSave: async (src: string) => ({
    ok: true as const,
    javascript: src,
    transformed: false,
    detail: "",
  }),
}));

import { ObjectScriptEditorApp } from "../components/ObjectScriptEditorApp";
import { __resetAiEditClient } from "../lib/aiEditClient";

/** A run with every field a panel or a diff reads. */
function runFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-1",
    kind: "edit",
    outcome: "changed",
    startedAt: "2026-08-26T09:00:00.000Z",
    elapsedMs: 12_000,
    instruction: "make it red",
    objectType: "button",
    providerId: "ollama",
    model: "qwen3.5:9b",
    tier: "assisted",
    surfaceTokens: 1200,
    surfaceTruncated: false,
    summary: "Edited and validated on the first attempt.",
    attempts: [
      {
        attempt: 1,
        at: 0,
        durationMs: 4000,
        ok: true,
        reply: "Here is the change you asked for.\n```javascript\nok\n```",
        replyChars: 54,
        note: "Here is the change you asked for.",
        reasoning: "First I looked at the click handler.",
        reasoningChars: 36,
        findings: [],
        dryRun: { applicable: true, ok: true, changedCells: 3 },
      },
    ],
    notices: [],
    changedNothing: false,
    unexercisedHooks: [],
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

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
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function q(testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${testid}']`);
}
function all(testid: string): HTMLElement[] {
  return [...container.querySelectorAll(`[data-testid='${testid}']`)] as HTMLElement[];
}
async function click(testid: string): Promise<void> {
  const el = q(testid);
  expect(el, `no element with data-testid='${testid}'`).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}
async function typeInto(el: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function ask(instruction: string): Promise<void> {
  await click("ai-edit-toggle");
  const box = q("ai-edit-instruction") as HTMLTextAreaElement;
  expect(box, "the composer never opened").toBeTruthy();
  await typeInto(box, instruction);
  await click("ai-edit-ask");
}
async function deliver(payload: Record<string, unknown>): Promise<void> {
  expect(aiResultHandler, "the editor never subscribed to AI results").toBeTruthy();
  await act(async () => {
    aiResultHandler!(payload);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}
function proposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documentId: SCRIPT.id,
    jobId: "job-1",
    ok: true,
    source: "export function setup(context) { context.log('AI'); }",
    summary: "Edited and validated on the first attempt.",
    unexercisedHooks: [],
    run: runFixture(),
    instruction: "make it red",
    askedAgainst: SCRIPT.source,
    ...over,
  };
}

beforeEach(() => {
  aiResultHandler = null;
  aiRequests.length = 0;
  saveObjectScript.mockClear();
  appendScriptAuthoringRun.mockClear();
  adoptScriptAuthoringRuns.mockClear();
  clearScriptAuthoringRuns.mockClear();
  getScriptAuthoringRuns.mockClear();
  getScriptAuthoringRuns.mockResolvedValue([]);
  __resetAiEditClient();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("nothing is written down until a human decides", () => {
  it("writes NOTHING when a result arrives", async () => {
    // THE SECURITY PROPERTY. `objscript:ai-edit-result` is a channel another
    // window emits on; if arriving were enough to write, that channel would be a
    // way into a persisted store, and merely asking for an edit you then reject
    // would dirty the workbook.
    await mountApp();
    await ask("make it red");
    await deliver(proposal());

    expect(q("ai-edit-diff"), "the diff never opened").toBeTruthy();
    expect(appendScriptAuthoringRun).not.toHaveBeenCalled();
    expect(adoptScriptAuthoringRuns).not.toHaveBeenCalled();
  });

  it("writes exactly one ACCEPTED run when the author accepts", async () => {
    await mountApp();
    await ask("make it red");
    await deliver(proposal());
    await click("ai-edit-accept");

    expect(appendScriptAuthoringRun).toHaveBeenCalledTimes(1);
    const [scriptId, run] = appendScriptAuthoringRun.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(scriptId).toBe(SCRIPT.id);
    expect(run.decision).toBe("accepted");
    expect(typeof run.decidedAt).toBe("string");
    // The record that was decided about, not a reconstruction of it.
    expect(run.runId).toBe("run-1");
    expect(run.instruction).toBe("make it red");
  });

  it("writes exactly one REJECTED run when the author rejects", async () => {
    // "I asked for X, it proposed Y, I said no" is the one fact a run cannot
    // know about itself, and it is the whole reason a rejection is recorded.
    await mountApp();
    await ask("make it red");
    await deliver(proposal());
    await click("ai-edit-reject");

    expect(appendScriptAuthoringRun).toHaveBeenCalledTimes(1);
    const [, run] = appendScriptAuthoringRun.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(run.decision).toBe("rejected");
  });

  it("drops a REPLAYED result for a document already at a decision", async () => {
    // The main window re-sends on every editor open because it cannot know
    // whether the first delivery landed. A diff the author is already looking at
    // must not reopen, and a second delivery must not write a second run.
    await mountApp();
    await ask("make it red");
    await deliver(proposal());
    await deliver(proposal());
    await click("ai-edit-accept");

    expect(appendScriptAuthoringRun).toHaveBeenCalledTimes(1);
  });

  it("accepts a replay into a window that never asked", async () => {
    // The reopened-editor case: this window has no memory of the request, so it
    // cannot dedupe. Writing again is correct here, and harmless, because the
    // backend replaces a run whose `runId` it already holds.
    await mountApp();
    await deliver(proposal());
    expect(q("ai-edit-diff"), "the replayed proposal never opened").toBeTruthy();
    await click("ai-edit-accept");

    expect(appendScriptAuthoringRun).toHaveBeenCalledTimes(1);
    const [, run] = appendScriptAuthoringRun.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(run.runId, "the same run id the first delivery carried").toBe("run-1");
  });
});

describe("the history panel shows the conversation that produced the script", () => {
  it("shows the UNDECIDED proposal, which is not persisted anywhere", async () => {
    // THE REPORTED MOMENT. The author was looking at a proposal they had not
    // decided about when they went looking for the reasoning; a panel that read
    // only the backend would have shown them an empty page.
    await mountApp();
    await ask("make it red");
    await deliver(proposal());
    await click("script-history-toggle");

    const live = q("script-history-live");
    expect(live, "the live run is not shown").toBeTruthy();
    expect(live!.textContent).toContain("not yet saved");
    expect(live!.textContent).toContain("make it red");
    expect(live!.textContent).toContain("qwen3.5:9b");
    // The model's own words, which used to be destroyed at `extractScript`.
    expect(q("script-history-reply")!.textContent).toContain(
      "Here is the change you asked for.",
    );
    expect(q("script-history-reasoning")!.textContent).toContain(
      "First I looked at the click handler.",
    );
  });

  it("reads the persisted runs when it opens, and not before", async () => {
    getScriptAuthoringRuns.mockResolvedValue([
      runFixture({ runId: "run-old", decision: "rejected", instruction: "make it blue" }),
    ]);
    await mountApp();
    expect(getScriptAuthoringRuns, "an ordinary session must not pay for this").not.toHaveBeenCalled();

    await click("script-history-toggle");
    expect(getScriptAuthoringRuns).toHaveBeenCalledWith(SCRIPT.id);
    const runs = all("script-history-run");
    expect(runs).toHaveLength(1);
    expect(runs[0].getAttribute("data-decision")).toBe("rejected");
    expect(runs[0].textContent).toContain("make it blue");
    expect(runs[0].textContent).toContain("you rejected it");
  });

  it("says so, plainly, when there is nothing recorded", async () => {
    await mountApp();
    await click("script-history-toggle");
    expect(q("script-history-empty")!.textContent).toContain("Nothing recorded");
  });

  it("lets the author delete their own words", async () => {
    getScriptAuthoringRuns.mockResolvedValue([runFixture({ runId: "run-old" })]);
    await mountApp();
    await click("script-history-toggle");
    expect(all("script-history-run")).toHaveLength(1);

    await click("script-history-clear");
    expect(clearScriptAuthoringRuns).toHaveBeenCalledWith(SCRIPT.id);
    expect(all("script-history-run")).toHaveLength(0);
  });
});
