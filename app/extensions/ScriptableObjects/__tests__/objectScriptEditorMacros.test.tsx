//! FILENAME: app/extensions/ScriptableObjects/__tests__/objectScriptEditorMacros.test.tsx
// PURPOSE: Recorded macros are FIRST-CLASS documents in the Object Script
//          Editor: every macro in the workbook is listed, not just the one the
//          window was navigated to; switching between them keeps each one's
//          unsaved edits; re-opening one selects it instead of duplicating it;
//          the list follows the workbook; and Debug knows a macro is mounted
//          from the module store.
// CONTEXT: The bug this pins: the editor held ONE macro in a single state slot,
//          handed to it over the open-with-macro channel, and rendered exactly
//          one option from it. A user with two recorded macros saw one at a
//          time — opening the second REPLACED the first — because the editor
//          never enumerated macros at all. Monaco is replaced here with a plain
//          textarea so the BUFFER is observable: "did switching lose my edits"
//          is the question, and it cannot be asked of a stub that renders null.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModuleMacroPayload } from "../lib/crossWindowEvents";

// --- Monaco: a real, drivable text buffer ------------------------------------
vi.mock("@monaco-editor/react", async () => {
  const react = await import("react");
  return {
    default: ({
      value,
      onChange,
    }: {
      value?: string;
      onChange?: (v: string | undefined) => void;
    }) =>
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

// --- Cross-window bridge: capture the macro-open listener ---------------------
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
}));

// --- The workbook's MODULE store ---------------------------------------------
interface StoredModule {
  id: string;
  name: string;
  description: string | null;
  source: string;
}
const store = new Map<string, StoredModule>();
let listShouldFail = false;
const saveWorkbookScript = vi.fn(async (script: StoredModule) => {
  store.set(script.id, { ...script });
});
/** Listeners registered through the module store's change channel. */
let scriptsChangedListeners: Array<() => void> = [];

vi.mock("@api/workbookScripts", () => ({
  listWorkbookScriptRecords: async () => {
    if (listShouldFail) throw new Error("no backend");
    return [...store.values()].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      sourcePackage: null,
      loadError: null,
    }));
  },
  getWorkbookScript: async (id: string) => {
    const found = store.get(id);
    if (!found) throw new Error(`Script '${id}' not found`);
    return found;
  },
  saveWorkbookScript: (s: StoredModule) => saveWorkbookScript(s),
  onWorkbookScriptsChanged: async (cb: () => void) => {
    scriptsChangedListeners.push(cb);
    return () => {
      scriptsChangedListeners = scriptsChangedListeners.filter((l) => l !== cb);
    };
  },
  parseModuleScriptRuntime: (description: string | null | undefined) => {
    if (typeof description !== "string") return null;
    const match = /\bruntime=(objectScript|notebook)\b/.exec(description);
    return match ? match[1] : null;
  },
  WORKBOOK_SCRIPTS_CHANGED_EVENT: "workbook:module-scripts-changed",
}));

// --- Object-script backend (empty: this workbook has macros only) -------------
const saveObjectScript = vi.fn(async () => {});
vi.mock("@api/objectScriptBackend", () => ({
  loadAllObjectScripts: async () => [],
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
}));

/** What the editor told `useDebugSession` about the ACTIVE document. */
let debugSessionOptions: { mountFromModuleStore?: boolean } | undefined;
vi.mock("../components/DebugPanel", () => ({
  breakpointShift: () => null,
  DebugPanel: () => null,
  DebugToolbar: () => null,
  injectDebugStyles: () => {},
  useDebugSession: (_id: string | null, options?: { mountFromModuleStore?: boolean }) => {
    debugSessionOptions = options;
    return {
      session: null,
      decorations: [],
      breakpointLines: [],
      send: () => {},
      fire: () => {},
      toggleLine: () => {},
    };
  },
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

const MACRO_A: StoredModule = {
  id: "macro-alpha",
  name: "Alpha close",
  description: "Recorded macro · runtime=objectScript · 2 actions · recorded 2026-08-01",
  source: "function setup(context) { /* alpha */ }",
};
const MACRO_B: StoredModule = {
  id: "macro-beta",
  name: "Beta refresh",
  description: "Recorded macro · runtime=objectScript · 5 actions · recorded 2026-08-02",
  source: "function setup(context) { /* beta */ }",
};
const HAND_MODULE: StoredModule = {
  id: "helper",
  name: "Zed helper",
  description: null,
  source: "Calcula.setCellValue(0, 0, 'x');",
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
  // Let the initial module listing land.
  await act(async () => {
    await Promise.resolve();
  });
}

function select(): HTMLSelectElement {
  return container.querySelector("select") as HTMLSelectElement;
}

function optionLabels(): string[] {
  return [...select().options].map((o) => (o.textContent ?? "").trim());
}

function buffer(): HTMLTextAreaElement {
  return container.querySelector("[data-testid='editor-buffer']") as HTMLTextAreaElement;
}

async function choose(id: string): Promise<void> {
  await act(async () => {
    select().value = id;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function type(text: string): Promise<void> {
  await act(async () => {
    const area = buffer();
    // React's synthetic onChange needs the value set through the native setter.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

describe("Object Script Editor — macros are first-class documents", () => {
  beforeEach(() => {
    macroHandler = null;
    scriptsChangedListeners = [];
    listShouldFail = false;
    store.clear();
    store.set(MACRO_A.id, MACRO_A);
    store.set(MACRO_B.id, MACRO_B);
    saveWorkbookScript.mockClear();
    saveObjectScript.mockClear();
    debugSessionOptions = undefined;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  // THE BUG: two recorded macros, one visible.
  it("lists EVERY macro in the workbook, not only the one it was opened on", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);

    const labels = optionLabels();
    expect(labels).toContain("MACRO — Alpha close");
    expect(labels).toContain("MACRO — Beta refresh");
    expect(select().value).toBe(MACRO_A.id);
  });

  it("distinguishes a recorded MACRO from a hand-authored module", async () => {
    store.set(HAND_MODULE.id, HAND_MODULE);
    await mountApp();

    const labels = optionLabels();
    expect(labels).toContain("MACRO — Alpha close");
    expect(labels).toContain("MODULE — Zed helper");
  });

  // Per-document unsaved edits. Switching away must not lose them, and must not
  // write them either.
  it("keeps each macro's unsaved edits when switching between them", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);

    await type("// edited ALPHA");
    expect(buffer().value).toBe("// edited ALPHA");

    await choose(MACRO_B.id);
    expect(buffer().value).toBe(MACRO_B.source);
    await type("// edited BETA");

    await choose(MACRO_A.id);
    expect(buffer().value).toBe("// edited ALPHA");
    await choose(MACRO_B.id);
    expect(buffer().value).toBe("// edited BETA");

    // ...and nothing was written on the way: switching is not a save, and a
    // module must never leak into the OBJECT-script store.
    expect(saveWorkbookScript).not.toHaveBeenCalled();
    expect(saveObjectScript).not.toHaveBeenCalled();
  });

  it("marks the macros that hold unsaved edits", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);
    await type("// dirty");
    await choose(MACRO_B.id);

    const alpha = [...select().options].find((o) => o.value === MACRO_A.id)!;
    expect(alpha.textContent).toContain("•");
    const beta = [...select().options].find((o) => o.value === MACRO_B.id)!;
    expect(beta.textContent).not.toContain("•");
  });

  it("SELECTS an already-listed macro instead of adding it twice", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);
    await choose(MACRO_B.id);

    await deliverMacro(MACRO_A);

    const values = [...select().options].map((o) => o.value);
    expect(values.filter((v) => v === MACRO_A.id)).toHaveLength(1);
    expect(select().value).toBe(MACRO_A.id);
  });

  it("re-opening the macro in front of you keeps your unsaved edits", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);
    await type("// work in progress");

    await deliverMacro(MACRO_A);

    expect(buffer().value).toBe("// work in progress");
    expect(container.textContent).toContain("unsaved edits");
  });

  // The list follows the workbook: recorded elsewhere, deleted elsewhere.
  it("refreshes when a macro is created or deleted elsewhere", async () => {
    await mountApp();
    expect(optionLabels()).not.toContain("MODULE — Zed helper");

    store.set(HAND_MODULE.id, HAND_MODULE);
    await act(async () => {
      scriptsChangedListeners.forEach((l) => l());
      await Promise.resolve();
    });
    expect(optionLabels()).toContain("MODULE — Zed helper");

    store.delete(MACRO_B.id);
    await act(async () => {
      scriptsChangedListeners.forEach((l) => l());
      await Promise.resolve();
    });
    expect(optionLabels()).not.toContain("MACRO — Beta refresh");
  });

  it("keeps a deleted macro that still has unsaved edits, and says so", async () => {
    await mountApp();
    await deliverMacro(MACRO_B);
    await type("// not saved yet");

    store.delete(MACRO_B.id);
    await act(async () => {
      scriptsChangedListeners.forEach((l) => l());
      await Promise.resolve();
    });

    expect(optionLabels().join("|")).toContain("MACRO — Beta refresh");
    expect(buffer().value).toBe("// not saved yet");
    const banner = container.querySelector("[data-testid='macro-load-error-banner']");
    expect(banner, "no banner explaining the module is gone").toBeTruthy();
    expect(banner!.textContent).toMatch(/deleted from the workbook/i);
  });

  // Debug on a macro must ask the host to mount it FROM THE MODULE STORE, which
  // is the whole of the "cannot debug without running it first" bug.
  it("tells the debugger a macro is mounted from the module store", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);
    expect(debugSessionOptions).toEqual({ mountFromModuleStore: true });
  });

  it("saves a macro back to the MODULE store, marker intact", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);
    await type("// saved body");

    const save = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Save Macro"),
    ) as HTMLButtonElement;
    expect(save, "no Save Macro button for a module document").toBeTruthy();
    await act(async () => {
      save.click();
    });

    expect(saveWorkbookScript).toHaveBeenCalledTimes(1);
    expect(saveWorkbookScript.mock.calls[0][0]).toMatchObject({
      id: MACRO_A.id,
      name: MACRO_A.name,
      description: MACRO_A.description,
      source: "// saved body",
    });
    expect(saveObjectScript).not.toHaveBeenCalled();
  });

  it("never shows an empty list in silence when the store cannot be read", async () => {
    store.clear();
    listShouldFail = true;
    await mountApp();

    expect(container.textContent).toMatch(/could not list this workbook's script modules/i);
  });
});
