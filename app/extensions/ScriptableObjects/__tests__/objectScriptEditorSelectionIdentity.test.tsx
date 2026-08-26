//! FILENAME: app/extensions/ScriptableObjects/__tests__/objectScriptEditorSelectionIdentity.test.tsx
// PURPOSE: The Object Script Editor must open on the document it was opened FOR,
//          decided by identity, never by which asynchronous thing finished first.
// CONTEXT: The defect: during a 12-minute run the macro <select> came up on a
//          `-sbfault-` id when the user had double-clicked a `-sb-` one. Three
//          independent asynchronous things decide the initial selection — the
//          editor registering its cross-window listeners, the main window's
//          4-second fallback delivery timer, and the editor's own "nothing is
//          selected yet, take the first one" fallback. A slow-booting editor let
//          the timer deliver into a void; the payload was LOST; and the fallback
//          then chose whatever sorted first alphabetically. "sbfault" sorts
//          before "statusbar", which is exactly what was seen.
//
//          The window now carries the requested document id in its own URL, so
//          the very first render already knows the answer. These tests drive the
//          editor with NO open payload at all — the lost-payload case — and with
//          a payload whose record read is held open, the slow-backend case.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModuleMacroPayload } from "../lib/crossWindowEvents";

// --- Monaco: a plain, drivable buffer ----------------------------------------
vi.mock("@monaco-editor/react", async () => {
  const react = await import("react");
  return {
    default: ({ value, onChange }: { value?: string; onChange?: (v: string | undefined) => void }) =>
      react.createElement("textarea", {
        "data-testid": "editor-buffer",
        value: value ?? "",
        onChange: (e: { target: { value: string } }) => onChange?.(e.target.value),
      }),
    DiffEditor: () => null,
    loader: { config: () => {}, init: () => Promise.resolve({}) },
    useMonaco: () => null,
  };
});

// --- Cross-window bridge ------------------------------------------------------
let macroHandler: ((payload: ModuleMacroPayload) => void) | null = null;
vi.mock("../lib/crossWindowEvents", () => ({
  ObjectScriptEditorEvents: {},
  emitSaveAndApply: vi.fn(async () => {}),
  emitRegisterScript: vi.fn(async () => {}),
  emitToggleAccess: vi.fn(async () => {}),
  emitEditorClosed: vi.fn(async () => {}),
  emitEditorReady: vi.fn(async () => {}),
  onOpenWithScript: async () => () => {},
  onOpenWithDraft: async () => () => {},
  onOpenWithModuleMacro: async (cb: (payload: ModuleMacroPayload) => void) => {
    macroHandler = cb;
    return () => {
      macroHandler = null;
    };
  },
  onConsoleOutput: async () => () => {},
  onScriptError: async () => () => {},
  onScriptsChanged: async () => () => {},
  // "Edit with AI" channels. The editor subscribes to these on mount; a partial
  // mock without them throws inside the mount effect and takes the window down.
  emitAiEditRequest: async () => {},
  emitAiEditCancel: async () => {},
  onAiEditProgress: async () => () => {},
  onAiEditResult: async () => () => {},
}));

// --- The workbook's MODULE store ---------------------------------------------
interface StoredModule {
  id: string;
  name: string;
  description: string | null;
  source: string;
}
const store = new Map<string, StoredModule>();
/** When set, getWorkbookScript parks until released — the slow-backend case. */
let heldRead: (() => void) | null = null;
let holdReads = false;

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
    if (holdReads) {
      await new Promise<void>((resolve) => {
        heldRead = resolve;
      });
    }
    const found = store.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return found;
  },
  saveWorkbookScript: async () => {},
  onWorkbookScriptsChanged: async () => () => {},
  parseModuleScriptRuntime: (description: string | null | undefined) => {
    if (typeof description !== "string") return null;
    const match = /\bruntime=(objectScript|notebook)\b/.exec(description);
    return match ? match[1] : null;
  },
  WORKBOOK_SCRIPTS_CHANGED_EVENT: "workbook:module-scripts-changed",
}));

vi.mock("@api/objectScriptBackend", () => ({
  loadAllObjectScripts: async () => [],
  saveObjectScript: async () => {},
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
  saveObjectScript: async () => {},
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
  // The API Reference heading reads the interface name out of the generated
  // typings now, so a partial mock that omits it throws inside the sidebar.
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
import { editorUrlForDocument, readRequestedDocumentId } from "../lib/editorTarget";

// The exact shape of the reported pair: "sbfault" sorts BEFORE "statusbar", so
// the alphabetical fallback picks the wrong one.
const STAMP = "mfa1x";
const WANTED: StoredModule = {
  id: `macro-e2evba4-sb-${STAMP}`,
  name: `E2E VBA4 statusbar ${STAMP}`,
  description: "Recorded macro · runtime=objectScript",
  source: "function setup(context) { /* statusbar */ }",
};
const DECOY: StoredModule = {
  id: `macro-e2evba4-sbfault-${STAMP}`,
  name: `E2E VBA4 sbfault ${STAMP}`,
  description: "Recorded macro · runtime=objectScript",
  source: "function setup(context) { /* sbfault */ }",
};

let container: HTMLDivElement;
let root: Root;

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

function setWindowUrlFor(documentId: string | null): void {
  const url = editorUrlForDocument(documentId);
  const hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
  window.location.hash = hash;
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
    await Promise.resolve();
  });
}

function select(): HTMLSelectElement {
  return container.querySelector("select") as HTMLSelectElement;
}

async function deliverMacro(macro: StoredModule): Promise<void> {
  expect(macroHandler, "the editor never subscribed to open-with-module-macro").toBeTruthy();
  await act(async () => {
    macroHandler!({
      macroId: macro.id,
      name: macro.name,
      source: macro.source,
      description: macro.description,
    });
    await Promise.resolve();
  });
}

describe("editorTarget — the requested document travels with the window", () => {
  it("round-trips an id through the URL fragment", () => {
    expect(readRequestedDocumentId(editorUrlForDocument("macro-a b/c"))).toBe("macro-a b/c");
  });

  it("is a FRAGMENT, so nothing but the webview ever sees it", () => {
    const url = editorUrlForDocument("macro-x");
    expect(url.startsWith("/objectScript.html#")).toBe(true);
    expect(url).not.toContain("?");
  });

  it("yields null for a plain open and for junk", () => {
    expect(readRequestedDocumentId(editorUrlForDocument(null))).toBeNull();
    expect(readRequestedDocumentId("")).toBeNull();
    expect(readRequestedDocumentId("#doc=")).toBeNull();
    expect(readRequestedDocumentId("#other=1")).toBeNull();
    expect(readRequestedDocumentId("#doc=%E0%A4%A")).toBeNull();
  });
});

describe("Object Script Editor selects by identity, not by arrival order", () => {
  beforeEach(() => {
    macroHandler = null;
    holdReads = false;
    heldRead = null;
    store.clear();
    // Insertion order deliberately puts the WANTED macro first, so a test that
    // passes cannot be passing because of store ordering.
    store.set(WANTED.id, WANTED);
    store.set(DECOY.id, DECOY);
    setWindowUrlFor(null);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    setWindowUrlFor(null);
  });

  // THE BUG: the open payload never arrives (the fallback timer delivered it
  // before this window could listen), and the editor picks alphabetically.
  it("opens on the requested macro even when the open payload is LOST entirely", async () => {
    setWindowUrlFor(WANTED.id);
    await mountApp();

    expect(select().value).toBe(WANTED.id);
    expect(select().value).not.toBe(DECOY.id);
  });

  it("without a requested id it still falls back to the first document", async () => {
    // Proves the assertion above is about the request, not about sort order:
    // with no request the alphabetical fallback genuinely does pick the decoy.
    await mountApp();
    expect(select().value).toBe(DECOY.id);
  });

  it("holds the requested selection while the record read is still in flight", async () => {
    setWindowUrlFor(WANTED.id);
    holdReads = true;
    await mountApp();

    await deliverMacro(WANTED);
    // The record read is parked; the listing has already landed. Nothing may
    // have drifted to the alphabetically-first macro in the meantime.
    expect(select().value).toBe(WANTED.id);

    holdReads = false;
    await act(async () => {
      heldRead?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(select().value).toBe(WANTED.id);
  });

  it("a payload for a DIFFERENT macro still navigates there", async () => {
    setWindowUrlFor(WANTED.id);
    await mountApp();
    expect(select().value).toBe(WANTED.id);

    await deliverMacro(DECOY);
    expect(select().value).toBe(DECOY.id);
  });

  it("falls back rather than showing nothing when the requested id is gone", async () => {
    setWindowUrlFor("macro-deleted-before-this-window-opened");
    await mountApp();
    // Both listings answered and the id is in neither: the request is released.
    expect(select().value).toBe(DECOY.id);
  });

  it("an explicit choice survives a late payload for the id in the URL", async () => {
    setWindowUrlFor(WANTED.id);
    await mountApp();
    expect(select().value).toBe(WANTED.id);

    await act(async () => {
      select().value = DECOY.id;
      select().dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(select().value).toBe(DECOY.id);
  });
});
