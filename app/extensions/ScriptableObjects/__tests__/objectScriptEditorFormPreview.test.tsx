//! FILENAME: app/extensions/ScriptableObjects/__tests__/objectScriptEditorFormPreview.test.tsx
// PURPOSE: The editor's "Preview form" action: offered ONLY for a form script,
//          sends the code ON SCREEN, and reports every outcome as a status
//          line beside the action — never a dialog.
// CONTEXT: The same drivable-textarea harness as objectScriptEditorAiEdit:
//          the buffer is observable, and the Tauri event door is doubled so
//          what leaves the window and what arrives can both be asserted.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- Monaco: a drivable buffer, plus a fake editor handle --------------------
let latestOnChange: ((v: string | undefined) => void) | null = null;
let latestValue = "";
let mountedEditor = false;

vi.mock("@monaco-editor/react", async () => {
  const react = await import("react");
  const fakeEditor = {
    getValue: () => latestValue,
    getModel: () => ({ getFullModelRange: () => ({ fake: "range" }) }),
    executeEdits: (_src: string, edits: Array<{ text: string }>) => {
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
          // The mount handler wires real Monaco actions; the handle is
          // installed either way, which is what getValue() needs.
        }
      }, [onMount]);
      return react.createElement("textarea", {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute, not an identifier
        "data-testid": "editor-buffer",
        value: value ?? "",
        onChange: (e: { target: { value: string } }) => onChange?.(e.target.value),
      });
    },
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export is a React component; the double must match its name
    DiffEditor: () => null,
    loader: { config: () => {}, init: () => Promise.resolve({}) },
    useMonaco: () => null,
  };
});

// --- Cross-window bridge (the editor's own channels) --------------------------
vi.mock("../lib/crossWindowEvents", () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export is a const object; the double must match its name
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
  emitAiEditRequest: async () => {},
  emitAiEditCancel: async () => {},
  onAiEditProgress: async () => () => {},
  onAiEditResult: async () => () => {},
}));

// --- The Tauri event door: what the preview client sends and hears -----------
const emitted: Array<{ event: string; payload: unknown }> = [];
const listeners = new Map<string, (p: unknown) => void>();
vi.mock("@api/backend", () => ({
  emitTauriEvent: async (event: string, payload: unknown) => {
    emitted.push({ event, payload });
  },
  listenTauriEvent: async (event: string, cb: (p: unknown) => void) => {
    listeners.set(event, cb);
    return () => {};
  },
}));

// --- Stores -------------------------------------------------------------------
const BUTTON_SCRIPT = {
  id: "btn-1",
  name: "Colour cells",
  objectType: "button",
  instanceId: "inst-1",
  source: "export function setup(context) { context.onClick(() => {}); }",
  accessLevel: "restricted",
  enabled: true,
  provenance: "local",
};
const FORM_SCRIPT = {
  id: "form-1",
  name: "Order entry",
  objectType: "form",
  instanceId: "8d3c2b3a-0000-4000-8000-000000000001",
  source: "function setup(form) { form.define({ children: [] }); }",
  accessLevel: "restricted",
  enabled: true,
  provenance: "local",
};
let storedScripts: Array<Record<string, unknown>> = [];

const saveObjectScript = vi.fn(async () => {});
vi.mock("@api/objectScriptBackend", () => ({
  loadAllObjectScripts: async () => storedScripts,
  saveObjectScript: (...a: unknown[]) => saveObjectScript(...(a as [])),
  appendScriptAuthoringRun: async () => {},
  adoptScriptAuthoringRuns: async () => {},
  clearScriptAuthoringRuns: async () => {},
  getScriptAuthoringRuns: async () => [],
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
  hostValidateScript: async () => ({ valid: true }),
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
  // eslint-disable-next-line @typescript-eslint/naming-convention -- React components; the doubles must match the real export names
  DebugPanel: () => null,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- React components; the doubles must match the real export names
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
// The save gate, doubled to PASS the buffer through as its JavaScript — or to
// refuse text containing "@@@", the way the real compiler refuses a syntax
// error. What is asserted is that the preview uses the gate's OUTPUT and
// never stores anything.
vi.mock("../lib/authoringLanguage", () => ({
  objectScriptModelPath: () => "inmemory://script.js",
  registerJavascriptLane: () => {},
  registerTypescriptLane: () => {},
  gateObjectScriptSave: async (src: string) =>
    src.includes("@@@")
      ? {
          ok: false as const,
          detail: "Not saved — the script does not compile:\nLine 1:1 — Unexpected token (TS1109)",
          message: "The script does not compile: Unexpected token (line 1)",
        }
      : { ok: true as const, javascript: `/* compiled */ ${src}`, transformed: false, detail: "" },
}));

import { ObjectScriptEditorApp } from "../components/ObjectScriptEditorApp";
import { FormPreviewEvents, __resetFormPreviewClient } from "../lib/formPreviewBridge";
import { __resetAiEditClient } from "../lib/aiEditClient";

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
function requests(): Array<Record<string, unknown>> {
  return emitted
    .filter((e) => e.event === FormPreviewEvents.REQUEST)
    .map((e) => e.payload as Record<string, unknown>);
}
/** Deliver a result from the main window. */
async function deliver(payload: Record<string, unknown>): Promise<void> {
  const cb = listeners.get(FormPreviewEvents.RESULT);
  expect(cb, "the editor never subscribed to preview results").toBeTruthy();
  await act(async () => {
    cb!(payload);
    await Promise.resolve();
  });
}

beforeEach(() => {
  emitted.length = 0;
  listeners.clear();
  latestOnChange = null;
  latestValue = "";
  mountedEditor = false;
  storedScripts = [FORM_SCRIPT];
  saveObjectScript.mockClear();
  __resetFormPreviewClient();
  __resetAiEditClient();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("Object Script Editor — Preview form", () => {
  it("offers no preview action for a button script", async () => {
    storedScripts = [BUTTON_SCRIPT];
    await mountApp();
    expect(q("ai-edit-toggle"), "the editor did not open on the button script").toBeTruthy();
    expect(q("script-form-preview-action")).toBeNull();
    expect(q("script-form-preview-status")).toBeNull();
  });

  it("offers the preview action for a form script", async () => {
    await mountApp();
    expect(q("script-form-preview-action"), "the toolbar has no Preview form button").toBeTruthy();
    // Idle: no status line until something has been asked.
    expect(q("script-form-preview-status")).toBeNull();
  });

  it("sends the code ON SCREEN through the save gate, without saving it", async () => {
    await mountApp();
    await typeInto(buffer(), "function setup(form) { form.define({ children: [ /* typed */ ] }); }");
    await click("script-form-preview-action");

    expect(requests()).toHaveLength(1);
    expect(requests()[0].scriptId).toBe(FORM_SCRIPT.id);
    expect(requests()[0].scriptName).toBe(FORM_SCRIPT.name);
    // The gate's OUTPUT (JavaScript), built from the unsaved buffer.
    expect(requests()[0].source).toBe(
      "/* compiled */ function setup(form) { form.define({ children: [ /* typed */ ] }); }",
    );
    expect(saveObjectScript).not.toHaveBeenCalled();
    // ...and the action says it is waiting.
    expect(q("script-form-preview-status")!.getAttribute("data-phase")).toBe("running");
    expect((q("script-form-preview-action") as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses inline when the buffer does not compile, and sends nothing", async () => {
    await mountApp();
    await typeInto(buffer(), "function setup(form) { @@@ }");
    await click("script-form-preview-action");

    expect(requests()).toHaveLength(0);
    const status = q("script-form-preview-status");
    expect(status, "no status line for a compile failure").toBeTruthy();
    expect(status!.getAttribute("data-phase")).toBe("failed");
    expect(status!.textContent).toContain("does not compile");
  });

  it("shows a declined report's reason beside the action, not in a dialog", async () => {
    await mountApp();
    await click("script-form-preview-action");
    const requestId = requests()[0].requestId as string;

    await deliver({
      requestId,
      scriptId: FORM_SCRIPT.id,
      outcome: "declined",
      message: "No preview: the preview cannot serve api.fetchRows, so it has nothing to say about this script.",
    });

    const status = q("script-form-preview-status");
    expect(status!.getAttribute("data-phase")).toBe("failed");
    expect(status!.textContent).toContain("api.fetchRows");
    expect(container.querySelector("[role='dialog']")).toBeNull();
    // The action is usable again.
    expect((q("script-form-preview-action") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows 'no layout defined' with the rung's note", async () => {
    await mountApp();
    await click("script-form-preview-action");
    const requestId = requests()[0].requestId as string;
    await deliver({
      requestId,
      scriptId: FORM_SCRIPT.id,
      outcome: "noLayout",
      message: "No layout defined — no layout was captured: the script never called form.define during setup.",
    });
    expect(q("script-form-preview-status")!.textContent).toContain("never called form.define");
  });

  it("reports the open form, then clears the line when it closes", async () => {
    await mountApp();
    await click("script-form-preview-action");
    const requestId = requests()[0].requestId as string;

    await deliver({ requestId, scriptId: FORM_SCRIPT.id, outcome: "shown", message: "Preview open in the main window." });
    expect(q("script-form-preview-status")!.getAttribute("data-phase")).toBe("shown");
    expect(q("script-form-preview-status")!.textContent).toContain("Preview open");

    await deliver({ requestId, scriptId: FORM_SCRIPT.id, outcome: "closed", message: "" });
    expect(q("script-form-preview-status")).toBeNull();
  });

  it("dismissing a note tells the main window to forget it", async () => {
    await mountApp();
    await click("script-form-preview-action");
    const requestId = requests()[0].requestId as string;
    await deliver({ requestId, scriptId: FORM_SCRIPT.id, outcome: "refused", message: "The preview could not open: another script is showing a dialog." });
    expect(q("script-form-preview-status")!.textContent).toContain("another script is showing a dialog");

    await click("script-form-preview-dismiss");

    expect(q("script-form-preview-status")).toBeNull();
    expect(emitted.filter((e) => e.event === FormPreviewEvents.DISMISS)).toEqual([
      { event: FormPreviewEvents.DISMISS, payload: { scriptId: FORM_SCRIPT.id } },
    ]);
  });
});
