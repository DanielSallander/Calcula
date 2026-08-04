//! FILENAME: app/extensions/ScriptableObjects/__tests__/liveMacroEditing.test.tsx
// PURPOSE: A macro edited in the Object Script Editor is LIVE — the Excel/VBE
//          model. There is no per-module save step: the buffer reaches the
//          module store on its own, Run and Debug are never disabled by an
//          unsaved buffer, and what runs is always what is on screen.
// CONTEXT: The bug this pins: Run and Debug were disabled until the user pressed
//          "Save Macro", so editing a macro and pressing F5 — the one gesture
//          every VBA user has in their fingers — did nothing at all.
//
//          These tests are as much about what must NOT happen: an AI draft must
//          never be written by a timer, transiently-broken source must never
//          replace the last version that compiled, and an open debug session must
//          never be remounted underneath the author.
//
//          Monaco is replaced with a plain textarea so the BUFFER is drivable.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModuleMacroPayload, OpenWithDraftPayload, ScriptDraft } from "../lib/crossWindowEvents";
import type { DebugSessionState } from "@api/scriptHost/host";
import { LIVE_PERSIST_DEBOUNCE_MS } from "../lib/liveModuleBuffer";

// --- Monaco: a real, drivable text buffer, plus a mounted editor handle -------
// The handle matters here: run-at-cursor reads the cursor line from the mounted
// editor and does nothing at all without one, so a stub that never mounts would
// make every Run test pass for the wrong reason.
vi.mock("@monaco-editor/react", async () => {
  const react = await import("react");
  const editorHandle = {
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    setPosition: () => {},
    addAction: () => ({ dispose: () => {} }),
    onMouseDown: () => ({ dispose: () => {} }),
    onDidChangeModelContent: () => ({ dispose: () => {} }),
    deltaDecorations: () => [] as string[],
    revealLineInCenter: () => {},
    revealLineInCenterIfOutsideViewport: () => {},
    executeEdits: () => true,
    focus: () => {},
  };
  return {
    default: ({
      value,
      onChange,
      onMount,
    }: {
      value?: string;
      onChange?: (v: string | undefined) => void;
      onMount?: (editor: unknown, monaco: unknown) => void;
    }) => {
      // Mount once; the editor is re-rendered on every keystroke.
      react.useEffect(() => {
        onMount?.(editorHandle, {});
      }, [onMount]);
      return react.createElement("textarea", {
        "data-testid": "editor-buffer",
        value: value ?? "",
        onChange: (e: { target: { value: string } }) => onChange?.(e.target.value),
      });
    },
    DiffEditor: () => null,
    loader: { config: () => {}, init: () => Promise.resolve({}) },
    useMonaco: () => null,
  };
});

// --- Cross-window bridge -----------------------------------------------------
let macroHandler: ((payload: ModuleMacroPayload) => void) | null = null;
let draftHandler: ((payload: OpenWithDraftPayload) => void) | null = null;
const emitSaveAndApply = vi.fn(async () => {});
vi.mock("../lib/crossWindowEvents", () => ({
  ObjectScriptEditorEvents: {},
  emitSaveAndApply: (...a: unknown[]) => emitSaveAndApply(...(a as [])),
  emitRegisterScript: vi.fn(async () => {}),
  emitToggleAccess: vi.fn(async () => {}),
  emitEditorClosed: vi.fn(async () => {}),
  emitEditorReady: vi.fn(async () => {}),
  onOpenWithScript: async () => () => {},
  onOpenWithDraft: async (cb: (payload: OpenWithDraftPayload) => void) => {
    draftHandler = cb;
    return () => {
      draftHandler = null;
    };
  },
  onOpenWithModuleMacro: async (cb: (payload: ModuleMacroPayload) => void) => {
    macroHandler = cb;
    return () => {
      macroHandler = null;
    };
  },
  onConsoleOutput: async () => () => {},
  onScriptError: async () => () => {},
  onScriptsChanged: async () => () => {},
}));

// --- The workbook's MODULE store ---------------------------------------------
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
const objectScripts: Array<Record<string, unknown>> = [];
const saveObjectScript = vi.fn(async () => {});
vi.mock("@api/objectScriptBackend", () => ({
  loadAllObjectScripts: async () => [...objectScripts],
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
vi.mock("../lib/monacoTypings", () => ({
  configureObjectScriptTypings: () => {},
  setActiveContextType: () => {},
  annotateScaffold: (s: string) => s,
}));

// --- The save gate: "@@@" is the source that does not compile ------------------
vi.mock("../lib/authoringLanguage", () => ({
  objectScriptModelPath: () => "inmemory://script.js",
  registerJavascriptLane: () => {},
  registerTypescriptLane: () => {},
  gateObjectScriptSave: async (src: string) =>
    src.includes("@@@")
      ? {
          ok: false as const,
          detail:
            "Not saved — the script does not compile:\nLine 1:1 — ')' expected. (TS1005)\nYour edit is still in the editor.",
          message: "The script does not compile: ')' expected. (line 1)",
        }
      : { ok: true as const, javascript: src, transformed: false },
}));

// --- Debugger: a controllable session ----------------------------------------
let session: DebugSessionState | null = null;
const runAtCursor = vi.fn(async () => ({ status: "ran" as const, functionName: "macro1" }));
const stopDebugSessionAndWait = vi.fn(async () => {
  session = null;
});
vi.mock("../lib/debugger", () => ({
  clearBreakpoints: () => {},
  shiftBreakpoints: () => {},
  subscribeRemoteDebugState: () => () => {},
  setRemoteDebugTransport: () => {},
  runAtCursor: (...a: unknown[]) => runAtCursor(...(a as [])),
  getDebugSession: () => session,
  stopDebugSessionAndWait: (...a: unknown[]) => stopDebugSessionAndWait(...(a as [])),
}));

/** The Debug button's start handler, captured from the toolbar. */
let toolbarOnStart: ((o: { pauseOnEntry: boolean }) => void) | undefined;
let toolbarRunDisabled: boolean | undefined;
const debugStart = vi.fn();
vi.mock("../components/DebugPanel", async () => {
  const react = await import("react");
  return {
    breakpointShift: () => null,
    DebugPanel: () => null,
    DebugToolbar: (props: {
      onStart?: (o: { pauseOnEntry: boolean }) => void;
      onRun?: () => void;
      runDisabled?: boolean;
    }) => {
      toolbarOnStart = props.onStart;
      toolbarRunDisabled = props.runDisabled;
      return react.createElement("button", {
        "data-testid": "run-button",
        disabled: props.runDisabled === true,
        onClick: () => props.onRun?.(),
      }, "Run");
    },
    injectDebugStyles: () => {},
    useDebugSession: () => ({
      session,
      decorations: [],
      breakpointLines: [],
      isPaused: session?.status === "paused",
      busy: false,
      error: null,
      inertMount: true,
      start: (...a: unknown[]) => debugStart(...(a as [])),
      stop: () => {},
      send: () => {},
      fire: () => {},
      toggleLine: () => {},
    }),
  };
});

import { ObjectScriptEditorApp } from "../components/ObjectScriptEditorApp";

const MACRO: StoredModule = {
  id: "macro-alpha",
  name: "Alpha close",
  description: "Recorded macro · runtime=objectScript · 2 actions · recorded 2026-08-01",
  source: "function macro1(api) { /* v1 */ }",
};

const DRAFT: ScriptDraft = {
  id: "draft-abc123",
  name: "Refresh the report",
  objectType: "button",
  instanceId: "btn-1",
  description: "Pulls the latest figures when clicked",
  source: "export function setup(context) { context.log('drafted'); }",
  declaredCapabilities: [],
  createdAt: "2026-08-02T10:00:00Z",
  mounted: false,
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

function buffer(): HTMLTextAreaElement {
  return container.querySelector("[data-testid='editor-buffer']") as HTMLTextAreaElement;
}

async function type(text: string): Promise<void> {
  await act(async () => {
    const area = buffer();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function deliverMacro(): Promise<void> {
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

/** Let the idle window elapse and every resulting promise settle. */
async function idle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LIVE_PERSIST_DEBOUNCE_MS + 5);
  });
}

async function clickRun(): Promise<void> {
  await act(async () => {
    (container.querySelector("[data-testid='run-button']") as HTMLButtonElement).click();
    await Promise.resolve();
  });
  // Run flushes, may stop a stale session and then fires: let it all settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function consoleText(): string {
  return container.textContent ?? "";
}

function liveIndicator(): HTMLElement | null {
  return container.querySelector("[data-testid='module-live-indicator']");
}

describe("Object Script Editor — a macro edit is live", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    macroHandler = null;
    draftHandler = null;
    session = null;
    store.clear();
    store.set(MACRO.id, { ...MACRO });
    objectScripts.length = 0;
    saveWorkbookScript.mockClear();
    saveObjectScript.mockClear();
    runAtCursor.mockClear();
    stopDebugSessionAndWait.mockClear();
    debugStart.mockClear();
    emitSaveAndApply.mockClear();
    toolbarOnStart = undefined;
    toolbarRunDisabled = undefined;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  // ---- 1. The debounce -----------------------------------------------------

  it("writes the edit to the module store once typing settles — no Save press", async () => {
    await mountApp();
    await deliverMacro();

    await type("function macro1(api) { /* v2 */ }");
    expect(store.get(MACRO.id)!.source).toBe(MACRO.source); // not yet

    await idle();

    expect(store.get(MACRO.id)!.source).toBe("function macro1(api) { /* v2 */ }");
    // The runtime marker rides along untouched: it is what routes the macro.
    expect(saveWorkbookScript.mock.calls[0][0]).toMatchObject({
      id: MACRO.id,
      description: MACRO.description,
    });
    expect(liveIndicator()!.textContent).toContain("Live");
  });

  it("coalesces a burst of typing into one write", async () => {
    await mountApp();
    await deliverMacro();

    for (const text of ["v1", "v12", "v123"]) {
      await type(text);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_PERSIST_DEBOUNCE_MS / 2);
      });
    }
    await idle();

    expect(saveWorkbookScript).toHaveBeenCalledTimes(1);
    expect(store.get(MACRO.id)!.source).toBe("v123");
  });

  // ---- 2. Run is never blocked, and runs the NEW source --------------------

  it("never disables Run for an unsaved buffer", async () => {
    await mountApp();
    await deliverMacro();
    await type("function macro1(api) { /* freshly typed */ }");

    expect(toolbarRunDisabled).toBe(false);
    expect(
      (container.querySelector("[data-testid='run-button']") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("Run flushes the buffer FIRST and runs the new source", async () => {
    await mountApp();
    await deliverMacro();
    await type("function macro1(api) { /* v2 */ }");

    // No idle window: Run itself must do the flushing.
    await clickRun();

    expect(store.get(MACRO.id)!.source).toBe("function macro1(api) { /* v2 */ }");
    expect(runAtCursor).toHaveBeenCalledTimes(1);
    expect(runAtCursor.mock.calls[0][1]).toBe("function macro1(api) { /* v2 */ }");
  });

  // ---- 3. Source that does not compile -------------------------------------

  it("keeps the last good stored version when the source does not compile", async () => {
    await mountApp();
    await deliverMacro();

    await type("function macro1(api) { @@@ }");
    await idle();

    expect(store.get(MACRO.id)!.source).toBe(MACRO.source);
    expect(saveWorkbookScript).not.toHaveBeenCalled();
    expect(consoleText()).toContain("does not compile");
    expect(consoleText()).toContain("still runs the last version that compiled");
    expect(liveIndicator()!.getAttribute("data-live-state")).toBe("error");
  });

  // Found by the live run: the chip replaced the Save button, so it is the only
  // answer to "does the store hold what I am looking at" — and it must not claim
  // work that does not exist. Typing something and taking it back leaves the
  // buffer byte-identical to the store, and NOTHING will ever write again: the
  // debounce is not armed, and the flush behind Ctrl+S/Run short-circuits on
  // "unchanged" without reporting an outcome. A chip left on "Saving…" would
  // therefore stay there for the rest of the session.
  it("returns the chip to Live when an edit is taken back to the stored text", async () => {
    await mountApp();
    await deliverMacro();

    await type("function macro1(api) { @@@ }");
    await idle();
    expect(liveIndicator()!.getAttribute("data-live-state")).toBe("error");

    await type(MACRO.source);

    // Immediately, not after a write: there is no write to wait for.
    expect(liveIndicator()!.getAttribute("data-live-state")).toBe("live");
    expect(container.querySelector("[data-testid='editor-save-state']")!.textContent).toBe("Live");
    await idle();
    expect(saveWorkbookScript).not.toHaveBeenCalled();
    expect(store.get(MACRO.id)!.source).toBe(MACRO.source);
    expect(liveIndicator()!.getAttribute("data-live-state")).toBe("live");
  });

  it("Run on un-compilable source FAILS LOUDLY instead of running the older stored copy", async () => {
    await mountApp();
    await deliverMacro();
    await type("function macro1(api) { @@@ }");

    await clickRun();

    expect(runAtCursor).not.toHaveBeenCalled();
    expect(store.get(MACRO.id)!.source).toBe(MACRO.source);
    expect(consoleText()).toContain("does not compile");
    expect(consoleText()).toContain("Run did not start");
  });

  it("Debug on un-compilable source refuses too — a session must not instrument stale text", async () => {
    await mountApp();
    await deliverMacro();
    await type("function macro1(api) { @@@ }");

    await act(async () => {
      toolbarOnStart!({ pauseOnEntry: true });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(debugStart).not.toHaveBeenCalled();
    expect(consoleText()).toContain("Debug did not start");
  });

  // ---- 4. An open debug session is not hot-swapped -------------------------

  it("does NOT remount an open session when an edit is persisted, and says so", async () => {
    await mountApp();
    await deliverMacro();
    session = {
      scriptId: MACRO.id,
      status: "paused",
      paused: { line: 3, reason: "breakpoint" },
      breakpoints: [3],
      triggers: [],
      autoInvokeSetup: false,
    } as unknown as DebugSessionState;

    await type("function macro1(api) { /* v2 */ }");
    await idle();

    // The edit IS stored...
    expect(store.get(MACRO.id)!.source).toBe("function macro1(api) { /* v2 */ }");
    // ...and the session was left completely alone.
    expect(stopDebugSessionAndWait).not.toHaveBeenCalled();
    expect(debugStart).not.toHaveBeenCalled();
    // ...and the difference is legible.
    const banner = container.querySelector("[data-testid='stale-session-banner']");
    expect(banner, "no banner saying the session runs older code").toBeTruthy();
    expect(banner!.textContent).toMatch(/earlier version/i);
  });

  it("refuses to Run into a PAUSED stale session rather than discarding the pause", async () => {
    await mountApp();
    await deliverMacro();
    session = {
      scriptId: MACRO.id,
      status: "paused",
      paused: { line: 3, reason: "breakpoint" },
      breakpoints: [3],
      triggers: [],
      autoInvokeSetup: false,
    } as unknown as DebugSessionState;

    await type("function macro1(api) { /* v2 */ }");
    await idle();
    await clickRun();

    expect(stopDebugSessionAndWait).not.toHaveBeenCalled();
    expect(runAtCursor).not.toHaveBeenCalled();
    expect(consoleText()).toContain("paused at line 3");
  });

  it("restarts a stale session that is NOT paused, so Run picks up the edit", async () => {
    await mountApp();
    await deliverMacro();
    session = {
      scriptId: MACRO.id,
      status: "waiting",
      paused: null,
      breakpoints: [],
      triggers: [],
      autoInvokeSetup: false,
    } as unknown as DebugSessionState;

    await type("function macro1(api) { /* v2 */ }");
    await idle();
    await clickRun();

    expect(stopDebugSessionAndWait).toHaveBeenCalledWith(MACRO.id);
    expect(runAtCursor).toHaveBeenCalledTimes(1);
    expect(runAtCursor.mock.calls[0][1]).toBe("function macro1(api) { /* v2 */ }");
  });

  // ---- 5. An AI draft is never written by anything but a human -------------

  it("NEVER auto-persists an AI draft", async () => {
    await mountApp();
    await act(async () => {
      draftHandler!({ draft: DRAFT });
      await Promise.resolve();
    });
    expect(buffer().value).toBe(DRAFT.source);

    await type("// a human edited the AI's draft");
    await idle();
    await idle();

    expect(saveObjectScript).not.toHaveBeenCalled();
    expect(saveWorkbookScript).not.toHaveBeenCalled();
    expect(emitSaveAndApply).not.toHaveBeenCalled();
    // ...and the status bar still says exactly that.
    expect(
      container.querySelector("[data-testid='editor-save-state']")!.textContent,
    ).toBe("Never saved");
  });
});

// ============================================================================
// The other half of the scope decision: an OBJECT script is not a module.
// ============================================================================
//
// Saving an object script is also APPLYING it — the main window remounts the
// realm and re-runs setup(), and the mount re-hashes the source for the
// capability-grant binding. Doing that on an idle timer would restart live code
// (and re-prompt for capabilities) every time the author paused typing, for
// half-written text they never asked to run. So it does NOT auto-persist — but
// Run and Debug still flush it, because pressing Run IS asking for it.

describe("Object Script Editor — an object script applies on gesture, not on a timer", () => {
  const SCRIPT = {
    id: "os-1",
    name: "Sheet Script",
    objectType: "sheet",
    instanceId: null,
    source: "export function setup(context) { /* v1 */ }",
    accessLevel: "restricted",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    session = null;
    store.clear();
    objectScripts.length = 0;
    objectScripts.push({ ...SCRIPT });
    saveWorkbookScript.mockClear();
    saveObjectScript.mockClear();
    runAtCursor.mockClear();
    emitSaveAndApply.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("does not write an object script on an idle pause", async () => {
    await mountApp();
    expect(buffer().value).toBe(SCRIPT.source);

    await type("export function setup(context) { /* v2 */ }");
    await idle();
    await idle();

    expect(saveObjectScript).not.toHaveBeenCalled();
    expect(emitSaveAndApply).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='editor-save-state']")!.textContent,
    ).toBe("Modified");
  });

  it("Run applies the edit first, then runs it", async () => {
    await mountApp();
    await type("export function setup(context) { /* v2 */ }");

    await clickRun();

    expect(saveObjectScript).toHaveBeenCalledTimes(1);
    expect(emitSaveAndApply).toHaveBeenCalledTimes(1);
    expect(runAtCursor).toHaveBeenCalledTimes(1);
    expect(runAtCursor.mock.calls[0][1]).toBe("export function setup(context) { /* v2 */ }");
  });
});
