//! FILENAME: app/extensions/ScriptableObjects/__tests__/objectScriptEditorAiEdit.test.tsx
// PURPOSE: The rule the user asked for, tested against a real buffer:
//
//              AI DOES NOT SAVE. THE AUTHOR ACCEPTS OR REJECTS A DIFF.
//
// CONTEXT: 2026-08-25 — "when AI edits a script it does not save it directly but
//          rather we get like a diff window and the user is then prompted to
//          either accept or reject the final code change? For both recorded
//          macros and object scripts".
//
//          Monaco is replaced with a drivable textarea so the BUFFER is
//          observable — "did the proposal reach my script" cannot be asked of a
//          stub that renders null. The fake editor routes executeEdits back
//          through onChange, which is what the real one does, so Accept
//          exercises the same dirty-marking and live-save path as typing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModuleMacroPayload } from "../lib/crossWindowEvents";

// --- Monaco: a drivable buffer, plus a fake editor handle --------------------
/** Latest onChange handed to the fake Editor, so executeEdits can reach it. */
let latestOnChange: ((v: string | undefined) => void) | null = null;
let latestValue = "";
/** True once the app has been given an editor handle. */
let mountedEditor = false;

vi.mock("@monaco-editor/react", async () => {
  const react = await import("react");
  const fakeEditor = {
    getValue: () => latestValue,
    getModel: () => ({ getFullModelRange: () => ({ fake: "range" }) }),
    executeEdits: (_src: string, edits: Array<{ text: string }>) => {
      // The real editor fires the change handler; so does this one, which is
      // the whole reason Accept marks the document dirty.
      latestOnChange?.(edits[0].text);
      return true;
    },
    pushUndoStop: () => {},
    focus: () => {},
    addAction: () => ({ dispose: () => {} }),
    addCommand: () => {},
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    setPosition: () => {},
    revealLineInCenter: () => {},
    onDidChangeCursorPosition: () => ({ dispose: () => {} }),
    onDidChangeModelContent: () => ({ dispose: () => {} }),
    onMouseDown: () => ({ dispose: () => {} }),
    createDecorationsCollection: () => ({ set: () => {}, clear: () => {} }),
    deltaDecorations: () => [],
    updateOptions: () => {},
    layout: () => {},
  };
  return {
    default: ({
      value,
      onChange,
      onMount,
    }: {
      value?: string;
      onChange?: (v: string | undefined) => void;
      onMount?: (ed: unknown, monaco: unknown) => void;
    }) => {
      latestOnChange = onChange ?? null;
      latestValue = value ?? "";
      react.useEffect(() => {
        if (mountedEditor || !onMount) return;
        mountedEditor = true;
        try {
          onMount(fakeEditor, {});
        } catch {
          // The mount handler wires real Monaco actions; whatever it cannot do
          // against a double is not what this test is about. The handle is
          // installed either way, which is what Accept needs.
        }
      }, [onMount]);
      return react.createElement("textarea", {
        "data-testid": "editor-buffer",
        value: value ?? "",
        onChange: (e: { target: { value: string } }) => onChange?.(e.target.value),
      });
    },
    // The diff is the point of this test, so it renders its inputs where they
    // can be read rather than being stubbed away.
    DiffEditor: ({ original, modified }: { original?: string; modified?: string }) =>
      react.createElement("div", { "data-testid": "diff-body" }, `${original}>>>${modified}`),
    loader: { config: () => {}, init: () => Promise.resolve({}) },
    useMonaco: () => null,
  };
});

// --- Cross-window bridge ------------------------------------------------------
let macroHandler: ((payload: ModuleMacroPayload) => void) | null = null;
let scriptHandler: ((payload: unknown) => void) | null = null;
let aiResultHandler: ((payload: unknown) => void) | null = null;
let aiProgressHandler: ((payload: unknown) => void) | null = null;
const aiRequests: Array<Record<string, unknown>> = [];
const aiCancels: Array<Record<string, unknown>> = [];

vi.mock("../lib/crossWindowEvents", () => ({
  ObjectScriptEditorEvents: {},
  emitSaveAndApply: vi.fn(async () => {}),
  emitRegisterScript: vi.fn(async () => {}),
  emitToggleAccess: vi.fn(async () => {}),
  emitEditorClosed: vi.fn(async () => {}),
  emitEditorReady: vi.fn(async () => {}),
  onOpenWithScript: async (cb: (p: unknown) => void) => {
    scriptHandler = cb;
    return () => {};
  },
  onOpenWithDraft: async () => () => {},
  onOpenWithModuleMacro: async (cb: (payload: ModuleMacroPayload) => void) => {
    macroHandler = cb;
    return () => {};
  },
  onConsoleOutput: async () => () => {},
  onScriptError: async () => () => {},
  onScriptsChanged: async () => () => {},
  emitAiEditRequest: async (p: Record<string, unknown>) => {
    aiRequests.push(p);
  },
  emitAiEditCancel: async (p: Record<string, unknown>) => {
    aiCancels.push(p);
  },
  onAiEditProgress: async (cb: (p: unknown) => void) => {
    aiProgressHandler = cb;
    return () => {};
  },
  onAiEditResult: async (cb: (p: unknown) => void) => {
    aiResultHandler = cb;
    return () => {};
  },
}));

// --- Module store (recorded macros) -------------------------------------------
interface StoredModule {
  id: string;
  name: string;
  description: string | null;
  source: string;
}
const store = new Map<string, StoredModule>();
const saveWorkbookScript = vi.fn(async (script: StoredModule) => {
  store.set(script.id, { ...script });
});

vi.mock("@api/workbookScripts", () => ({
  listWorkbookScriptRecords: async () =>
    [...store.values()].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      sourcePackage: null,
      loadError: null,
    })),
  getWorkbookScript: async (id: string) => {
    const found = store.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return found;
  },
  saveWorkbookScript: (s: StoredModule) => saveWorkbookScript(s),
  onWorkbookScriptsChanged: async () => () => {},
  parseModuleScriptRuntime: (description: string | null | undefined) => {
    if (typeof description !== "string") return null;
    const match = /\bruntime=(objectScript|notebook)\b/.exec(description);
    return match ? match[1] : null;
  },
  WORKBOOK_SCRIPTS_CHANGED_EVENT: "workbook:module-scripts-changed",
}));

// --- Object-script backend ----------------------------------------------------
const OBJECT_SCRIPT = {
  id: "btn-1",
  name: "Colour cells",
  objectType: "button",
  instanceId: "inst-1",
  source: "export function onClick() { /* original */ }",
  accessLevel: "restricted",
  enabled: true,
  provenance: "local",
};
const saveObjectScript = vi.fn(async () => {});
vi.mock("@api/objectScriptBackend", () => ({
  loadAllObjectScripts: async () => [OBJECT_SCRIPT],
  saveObjectScript: (...a: unknown[]) => saveObjectScript(...(a as [])),
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
vi.mock("@api", () => ({
  getScaffoldTemplate: () => "// scaffold",
  getContextDocumentation: () => [],
  hostValidateScript: async () => ({ ok: true }),
  showToast: vi.fn(),
  saveObjectScript: (...a: unknown[]) => saveObjectScript(...(a as [])),
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

const MACRO: StoredModule = {
  id: "macro-alpha",
  name: "Alpha close",
  description: "Recorded macro · runtime=objectScript · 2 actions · recorded 2026-08-01",
  source: "function setup(context) { /* alpha */ }",
};

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
    await Promise.resolve();
  });
}

function q(testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${testid}']`);
}
function buffer(): HTMLTextAreaElement {
  return container.querySelector("[data-testid='editor-buffer']") as HTMLTextAreaElement;
}
async function click(testid: string): Promise<void> {
  const el = q(testid);
  expect(el, `no element with data-testid='${testid}'`).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}
async function typeInto(el: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Open the AI composer, type an instruction, and send it. */
async function ask(instruction: string): Promise<void> {
  await click("ai-edit-toggle");
  const box = q("ai-edit-instruction") as HTMLTextAreaElement;
  expect(box, "the composer never opened").toBeTruthy();
  await typeInto(box, instruction);
  await click("ai-edit-ask");
}

/** Deliver a successful proposal from the main window. */
async function propose(documentId: string, source: string, summary = "Changed it."): Promise<void> {
  expect(aiResultHandler, "the editor never subscribed to AI results").toBeTruthy();
  await act(async () => {
    aiResultHandler!({ documentId, jobId: "job-1", ok: true, source, summary });
    await Promise.resolve();
  });
}

beforeEach(() => {
  macroHandler = null;
  scriptHandler = null;
  aiResultHandler = null;
  aiProgressHandler = null;
  aiRequests.length = 0;
  aiCancels.length = 0;
  latestOnChange = null;
  latestValue = "";
  mountedEditor = false;
  store.clear();
  store.set(MACRO.id, MACRO);
  saveWorkbookScript.mockClear();
  saveObjectScript.mockClear();
  __resetAiEditClient();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("Object Script Editor — Edit with AI never writes for you", () => {
  it("offers Edit with AI on an object script", async () => {
    await mountApp();
    expect(q("ai-edit-toggle"), "the toolbar has no Edit with AI button").toBeTruthy();
  });

  it("sends the text ON SCREEN, including unsaved edits", async () => {
    // Editing the STORED copy would silently discard what the author typed and
    // then hand back a diff against the wrong thing.
    await mountApp();
    await typeInto(buffer(), "export function onClick() { /* I typed this */ }");
    await ask("add a guard");

    expect(aiRequests).toHaveLength(1);
    expect(aiRequests[0].currentSource).toBe("export function onClick() { /* I typed this */ }");
    expect(aiRequests[0].instruction).toBe("add a guard");
    expect(aiRequests[0].documentKind).toBe("object");
  });

  it("does not touch the buffer when the proposal arrives", async () => {
    // THE HEADLINE. A proposal is a proposal until the author says otherwise.
    await mountApp();
    const originalText = buffer().value;
    await ask("make it red");
    await propose(OBJECT_SCRIPT.id, "export function onClick() { /* AI WROTE THIS */ }");

    expect(buffer().value).toBe(originalText);
    expect(buffer().value).not.toContain("AI WROTE THIS");
    expect(saveObjectScript).not.toHaveBeenCalled();
  });

  it("opens a diff showing both sides", async () => {
    await mountApp();
    const originalText = buffer().value;
    await ask("make it red");
    await propose(OBJECT_SCRIPT.id, "PROPOSED");

    expect(q("ai-edit-diff"), "no diff window opened").toBeTruthy();
    expect(q("diff-body")!.textContent).toBe(`${originalText}>>>PROPOSED`);
    expect(q("ai-edit-diff-summary")!.textContent).toContain("Changed it.");
  });

  it("writes the proposal into the buffer ONLY on Accept", async () => {
    await mountApp();
    await ask("make it red");
    await propose(OBJECT_SCRIPT.id, "ACCEPTED SOURCE");
    expect(buffer().value).not.toBe("ACCEPTED SOURCE");

    await click("ai-edit-accept");

    expect(buffer().value).toBe("ACCEPTED SOURCE");
    // Through the change handler, so the document is dirty and Save is live —
    // exactly as if the author had typed it.
    expect(q("editor-save-state")!.textContent).toMatch(/modified/i);
    // ...and still nothing has been persisted for an object script.
    expect(saveObjectScript).not.toHaveBeenCalled();
  });

  it("leaves the buffer byte-identical on Reject", async () => {
    await mountApp();
    const originalText = buffer().value;
    await ask("make it red");
    await propose(OBJECT_SCRIPT.id, "REJECTED SOURCE");
    await click("ai-edit-reject");

    expect(buffer().value).toBe(originalText);
    expect(q("ai-edit-diff")).toBeNull();
  });

  it("tells the main window to forget a rejected proposal", async () => {
    // The main window replays its last result per document when an editor
    // announces itself ready; without this, a rejected proposal comes back.
    await mountApp();
    await ask("make it red");
    await propose(OBJECT_SCRIPT.id, "REJECTED SOURCE");
    await click("ai-edit-reject");

    expect(aiCancels).toEqual([{ documentId: OBJECT_SCRIPT.id, jobId: "job-1" }]);
  });

  it("cannot accept the same diff twice", async () => {
    await mountApp();
    await ask("make it red");
    await propose(OBJECT_SCRIPT.id, "ONCE");
    await click("ai-edit-accept");
    expect(q("ai-edit-diff")).toBeNull();
  });

  it("shows progress while the model works", async () => {
    await mountApp();
    await ask("make it red");
    expect(q("ai-edit-progress"), "no progress line while running").toBeTruthy();

    await act(async () => {
      aiProgressHandler!({
        documentId: OBJECT_SCRIPT.id,
        jobId: "job-1",
        phase: "Round 2 of 3",
        live: "checking the API surface",
      });
      await Promise.resolve();
    });
    expect(q("ai-edit-progress")!.textContent).toContain("Round 2 of 3");
    expect(q("ai-edit-live")!.textContent).toContain("checking the API surface");
  });

  it("reports a refusal without touching the script", async () => {
    await mountApp();
    const originalText = buffer().value;
    await ask("make it red");
    await act(async () => {
      aiResultHandler!({
        documentId: OBJECT_SCRIPT.id,
        jobId: "",
        ok: false,
        source: "",
        summary: "No AI model is selected.",
      });
      await Promise.resolve();
    });

    expect(q("ai-edit-error")!.textContent).toContain("No AI model is selected.");
    expect(q("ai-edit-diff")).toBeNull();
    expect(buffer().value).toBe(originalText);
  });

  it("keeps a proposal for a document the author has navigated away from", async () => {
    // A six-minute run must survive switching scripts. The diff opens when the
    // author comes back to it, rather than being lost or hijacking the window.
    await mountApp();
    await ask("make it red");
    await propose("some-other-doc", "NOT FOR THIS ONE");

    expect(q("ai-edit-diff"), "a diff opened for a document that is not on screen").toBeNull();
  });
});

describe("Object Script Editor — a recorded macro gets the same protection", () => {
  async function openMacro(): Promise<void> {
    await mountApp();
    expect(macroHandler, "the editor never subscribed to open-with-module-macro").toBeTruthy();
    await act(async () => {
      macroHandler!({
        macroId: MACRO.id,
        name: MACRO.name,
        source: MACRO.source,
        description: MACRO.description,
      });
      await Promise.resolve();
    });
  }

  it("offers Edit with AI on a macro, marked as a module", async () => {
    await openMacro();
    expect(q("ai-edit-toggle")).toBeTruthy();
    await ask("simplify it");
    expect(aiRequests[0].documentKind).toBe("module");
    expect(aiRequests[0].currentSource).toBe(MACRO.source);
  });

  it("does not persist a macro when the proposal arrives", async () => {
    // A macro auto-persists about a second after any buffer change, so an
    // auto-applied proposal would be SAVED before the author had read it.
    await openMacro();
    await ask("simplify it");
    await propose(MACRO.id, "function setup(context) { /* AI */ }");

    expect(saveWorkbookScript).not.toHaveBeenCalled();
    expect(buffer().value).toBe(MACRO.source);
  });

  it("says that accepting a macro saves it", async () => {
    await openMacro();
    await ask("simplify it");
    await propose(MACRO.id, "function setup(context) { /* AI */ }");

    expect(q("ai-edit-accept")!.textContent).toContain("Accept and save");
    expect(q("ai-edit-diff")!.textContent).toContain("saves it within a second");
  });

  it("applies to the macro buffer on Accept", async () => {
    await openMacro();
    await ask("simplify it");
    await propose(MACRO.id, "function setup(context) { /* AI */ }");
    await click("ai-edit-accept");

    expect(buffer().value).toBe("function setup(context) { /* AI */ }");
  });

  it("cannot be accepted when the proposal is identical", async () => {
    // Offering "Accept" for a no-op invites the author to believe something
    // happened.
    await openMacro();
    await ask("simplify it");
    await propose(MACRO.id, MACRO.source);

    const accept = q("ai-edit-accept") as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(q("ai-edit-diff-nochange")).toBeTruthy();
  });
});
