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
      options,
    }: {
      value?: string;
      onChange?: (v: string | undefined) => void;
      options?: { readOnly?: boolean };
    }) =>
      react.createElement("textarea", {
        "data-testid": "editor-buffer",
        // What the editor TOLD Monaco. Reflected as an attribute rather than
        // applied to the textarea, deliberately: `readOnly` on the element would
        // make the guard tests below unable to drive a keystroke past the UI, and
        // the thing worth proving is that the WRITE path refuses even when one
        // gets through. The attribute proves the UI half; the store proves the
        // structural half.
        // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM data-* attribute, not an identifier
        "data-readonly": options?.readOnly === true ? "true" : "false",
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
  // "Edit with AI" channels. The editor subscribes to the two on* channels on
  // mount; installAiEditClient catches a missing export's throw and AI editing
  // is then silently absent (one console.warn per missing channel) with the
  // window still mounting. Mocked here so the subscriptions actually succeed.
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
  /** The `.calp` this module was pulled from; absent for the user's own code. */
  sourcePackage?: string | null;
  /** Workbook-wide, or attached to one sheet. Must survive every write. */
  scope?: { type: string; name?: string };
}
const store = new Map<string, StoredModule>();
let listShouldFail = false;
/** Ids whose RECORD read fails while the listing still names them. */
const unreadable = new Set<string>();
const saveWorkbookScript = vi.fn(async (script: StoredModule) => {
  store.set(script.id, { ...script });
});
/** Listeners registered through the module store's change channel. */
let scriptsChangedListeners: Array<() => void> = [];

vi.mock("@api/workbookScripts", () => ({
  listWorkbookScriptRecords: async () => {
    if (listShouldFail) throw new Error("no backend");
    // FAITHFUL TO THE REAL LISTING (app/src/api/workbookScripts.ts): a record
    // whose per-record read fails is still LISTED, with an empty source and
    // `sourcePackage: null` — which is the absence of an answer, not the claim
    // that the module is local. The editor must not read it as one.
    return [...store.values()].map((s) =>
      unreadable.has(s.id)
        ? {
            id: s.id,
            name: s.name,
            description: null,
            source: "",
            sourcePackage: null,
            loadError: `Script '${s.id}' could not be read`,
          }
        : {
            id: s.id,
            name: s.name,
            description: s.description,
            source: s.source,
            sourcePackage: s.sourcePackage ?? null,
            scope: s.scope,
            loadError: null,
          },
    );
  },
  getWorkbookScript: async (id: string) => {
    if (unreadable.has(id)) throw new Error(`Script '${id}' could not be read`);
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
  // The REAL derivations (app/src/api/scriptHost/scriptOrigin.ts), copied
  // faithfully rather than stubbed: what this window says about a macro's tier
  // and its publisher must be what every other trust surface derives, and a
  // stub that always answered "local" would make these assertions meaningless.
  scriptOriginForStoredRecord: (record: { sourcePackage?: string | null }) => {
    const name =
      typeof record.sourcePackage === "string" ? record.sourcePackage.trim() : "";
    return name === "" ? { kind: "local" } : { kind: "package", name };
  },
  accessLevelForOrigin: (
    origin: { kind: string },
    requested: "restricted" | "unlocked",
  ) => (origin.kind === "package" ? "restricted" : requested),
  originPackageName: (origin: { kind: string; name?: string }) =>
    origin.kind === "package" ? origin.name ?? null : null,
  mountProvenanceForOrigin: (origin: { kind: string; name?: string }) =>
    origin.kind === "package"
      ? { provenance: "distributed", packageName: origin.name }
      : { provenance: "local" },
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

/** What the editor told `useDebugSession` about the ACTIVE document. */
let debugSessionOptions: { mountFromModuleStore?: boolean } | undefined;
/** What the editor told the Run/Debug toolbar about the ACTIVE document. */
let debugToolbarProps: { runDisabled?: boolean; runDisabledTitle?: string } | undefined;
vi.mock("../components/DebugPanel", () => ({
  breakpointShift: () => null,
  DebugPanel: () => null,
  DebugToolbar: (props: { runDisabled?: boolean; runDisabledTitle?: string }) => {
    debugToolbarProps = props;
    return null;
  },
  injectDebugStyles: () => {},
  useDebugSession: (_id: string | null, options?: { mountFromModuleStore?: boolean }) => {
    debugSessionOptions = options;
    return {
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
    };
  },
}));
vi.mock("../lib/monacoTypings", () => ({
  configureObjectScriptTypings: () => {},
  setActiveContextType: () => {},
  annotateScaffold: (s: string) => s,
  // The API Reference heading reads the interface name out of the generated
  // typings now, so a partial mock that omits it throws inside the sidebar.
  contextInterfaceNameFor: (objectType: string) => objectType,
}));
/**
 * The compile gate every persist runs BEFORE it writes.
 *
 * Spied rather than stubbed, because it is the only observable proof that the
 * live persister was ARMED at all. `saveWorkbookScript` alone cannot tell "we
 * never tracked this document" from "we tracked it, tried to write, and the
 * write's own guard threw" — and the second is the belt, not the rule.
 */
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
  gateObjectScriptSave: (src: string, ..._rest: unknown[]) => gateObjectScriptSave(src),
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
    unreadable.clear();
    store.clear();
    store.set(MACRO_A.id, MACRO_A);
    store.set(MACRO_B.id, MACRO_B);
    saveWorkbookScript.mockClear();
    saveObjectScript.mockClear();
    debugSessionOptions = undefined;
    debugToolbarProps = undefined;
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

  // Per-document buffers. Switching away FLUSHES the document being left (a
  // module is live code), and must still never lose the text of either one.
  it("keeps each macro's own text when switching, and flushes the one being left", async () => {
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

    // Each switch stored the document it left — to the MODULE store, by id.
    // A module must never leak into the OBJECT-script store.
    expect(store.get(MACRO_A.id)!.source).toBe("// edited ALPHA");
    expect(store.get(MACRO_B.id)!.source).toBe("// edited BETA");
    expect(saveObjectScript).not.toHaveBeenCalled();
  });

  it("marks only the macros whose text could NOT be stored", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);
    await type("// stored fine");
    await choose(MACRO_B.id);

    // Alpha stored cleanly on the way out, so it carries no warning dot: with
    // live editing a dot on ordinary typing would claim work is at risk.
    const alpha = [...select().options].find((o) => o.value === MACRO_A.id)!;
    expect(alpha.textContent).not.toContain("•");
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

  // The VBE has no per-module Save button, and neither does this: a control
  // offering to save edits that are already live states the opposite of what is
  // true. What replaces it is the live indicator.
  it("offers no Save button for a module — it shows the live state instead", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);

    const save = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Save Macro"),
    );
    expect(save, "a module must not carry a Save button").toBeFalsy();

    const indicator = container.querySelector("[data-testid='module-live-indicator']");
    expect(indicator, "no live indicator for a module document").toBeTruthy();
    expect(indicator!.textContent).toContain("Live");
  });

  it("stores a macro back to the MODULE store, marker intact", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);
    await type("// saved body");

    // Any explicit gesture flushes; switching away is the one this test can
    // drive without timers (the debounce path has its own test).
    await choose(MACRO_B.id);

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

// =============================================================================
// A PUBLISHER'S MACRO, IN THE EDITOR.
//
// A `.calp` may ship MODULE SCRIPTS (`core/calp/src/pull.rs` stamps
// `source_package` on each one), and this window lists them beside the user's
// own. Three things were wrong here, and all three are about the window ASSERTING
// something it had not derived:
//
//   1. The idle AUTO-PERSIST wrote the buffer back with no `source_package` at
//      all. Opening a publisher's macro and pausing was enough to send a write
//      that dropped the stamp — no gesture, nothing on screen.
//   2. `macroDocFromRecord` HARD-CODED `accessLevel: "unlocked"`, so the toolbar
//      told the user a publisher's macro runs at the top tier while
//      `hostStartModuleScriptDebugSession` mounts exactly that module RESTRICTED.
//   3. The list showed a publisher's macro identically to one the user recorded.
//
// AND THEN (1) CAME BACK WEARING THE OPPOSITE FACE. Sending the stamp on every
// write is right, but `save_script` also makes an omitted stamp STICKY — so
// either way the record ends up holding the user's edited bytes under the
// publisher's name, and the Rust consent gate (which matches package + id +
// source) then recognises nothing. A consented macro the user was happily
// running was refused FOREVER after they opened it in this window and paused.
// The laundering version was a security hole; the sticky version destroys the
// macro instead. This window now does neither: a publisher's module is
// READ-ONLY here, no write of it is ever made, and the publisher's record stays
// byte-for-byte as it arrived — which is also what keeps Developer ▸ Macros… ▸
// "Save as my copy" armed, since that offer is made by comparing the buffer with
// the STORED source.
// =============================================================================

const THEIR_MACRO: StoredModule = {
  id: "macro-vendor",
  name: "Vendor close",
  description: "Recorded macro · runtime=objectScript · 2 actions · recorded 2026-09-01",
  source: "function setup(context) { /* theirs */ }",
  sourcePackage: "Acme Finance Pack",
};

describe("Object Script Editor — a distributed macro is visibly a publisher's", () => {
  beforeEach(() => {
    macroHandler = null;
    scriptsChangedListeners = [];
    listShouldFail = false;
    unreadable.clear();
    store.clear();
    store.set(THEIR_MACRO.id, THEIR_MACRO);
    store.set(MACRO_A.id, MACRO_A);
    saveWorkbookScript.mockClear();
    saveObjectScript.mockClear();
    debugSessionOptions = undefined;
    debugToolbarProps = undefined;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  // (3) The list is where the user chooses what to open. A publisher's macro
  // that reads identically to their own is a decision they cannot make.
  it("names the application in the module list, and leaves the user's own bare", async () => {
    await mountApp();

    const labels = optionLabels();
    expect(labels.join("|")).toContain('MACRO — Vendor close — from "Acme Finance Pack"');
    expect(labels).toContain("MACRO — Alpha close");
  });

  it("says whose code is on screen, and what editing it does not change", async () => {
    await mountApp();
    await deliverMacro(THEIR_MACRO);

    const banner = container.querySelector("[data-testid='macro-provenance-banner']");
    expect(banner, "a publisher's macro opened with no banner").toBeTruthy();
    expect(banner!.getAttribute("data-macro-source-package")).toBe("Acme Finance Pack");
    expect(banner!.textContent).toMatch(/you did not write this/i);
    expect(banner!.textContent).toMatch(/restricted/i);
  });

  // EVERY SENTENCE IN THE BANNER MUST BE TRUE OF WHAT THE CODE DOES.
  //
  // It used to say editing here kept the application's stamp and that "the
  // workbook script runtime will then refuse to run it". Two lies in one
  // paragraph: this window's Run route mounts the STORED module by id and
  // performs no such refusal, and the edit it described did not leave the macro
  // merely un-runnable-for-now — it left a stored record that matches no consent
  // record, i.e. a macro the user could never run again and could not repair.
  it("promises only the refusal this window performs, and never the bricking edit", async () => {
    await mountApp();
    await deliverMacro(THEIR_MACRO);

    const banner = container.querySelector("[data-testid='macro-provenance-banner']")!;
    expect(banner.textContent).toMatch(/read-only/i);
    expect(banner.textContent).toMatch(/from the module store/i);
    // The sentence that was not true of the run route, in any of its spellings.
    expect(banner.textContent).not.toMatch(/will then refuse to run it/i);
    expect(banner.textContent).not.toMatch(/no longer matches the code you approved/i);
  });

  // ...AND THE REMEDY IT NAMES MUST STILL BE REACHABLE WHEN THE USER GETS THERE.
  // Developer ▸ Macros… offers "Save as my copy" by comparing the buffer with the
  // STORED source (`macroEditDisposition`, MacroRecorder/lib/macroLibrary.ts). An
  // in-place write from this window made those two equal, so by the time the user
  // followed the banner's own instruction the offer was gone and the stored macro
  // was already broken. Leaving the record untouched is what keeps it armed.
  it("names a remedy that is still armed — the stored record is left as it arrived", async () => {
    await mountApp();
    await deliverMacro(THEIR_MACRO);

    const banner = container.querySelector("[data-testid='macro-provenance-banner']")!;
    expect(banner.textContent).toMatch(/Save as my copy/i);
    expect(banner.textContent).toMatch(/Developer . Macros/i);

    await type("function setup(context) { /* my edit */ }");
    await choose(MACRO_A.id);

    // The publisher's record still differs from the text the user typed, which
    // is exactly the comparison the fork offer is made on.
    expect(store.get(THEIR_MACRO.id)).toEqual(THEIR_MACRO);
  });

  it("shows no such banner for a macro the user recorded", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);

    expect(container.querySelector("[data-testid='macro-provenance-banner']")).toBeNull();
  });

  // (2) The tier the runtime will actually give it — not a constant.
  it("states the RESTRICTED tier a distributed macro is really mounted at", async () => {
    await mountApp();
    await deliverMacro(THEIR_MACRO);

    const chip = container.querySelector("[data-testid='macro-tier-chip']")!;
    expect(chip.getAttribute("data-macro-tier")).toBe("restricted");
    expect(chip.textContent).toMatch(/restricted/i);
    expect(chip.getAttribute("title")).toContain("Acme Finance Pack");
  });

  it("still says unlocked for a macro the user recorded", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);

    const chip = container.querySelector("[data-testid='macro-tier-chip']")!;
    expect(chip.getAttribute("data-macro-tier")).toBe("unlocked");
    expect(chip.textContent).not.toMatch(/restricted/i);
  });

  // (1) THE WRITE THAT BRICKED THE MACRO. Every write this window makes goes
  // through the persister, so the flush a document switch performs is the very
  // call the idle debounce fires — with no gesture and nothing on screen.
  it("makes NO write of a publisher's macro, however the buffer is driven", async () => {
    await mountApp();
    await deliverMacro(THEIR_MACRO);
    await type("function setup(context) { /* my edit */ }");

    // Switching document flushes the one being left. Closing the window flushes
    // every tracked document. Neither may touch a module that arrived in an
    // application.
    await choose(MACRO_A.id);

    expect(saveWorkbookScript).not.toHaveBeenCalled();
    expect(store.get(THEIR_MACRO.id)).toEqual(THEIR_MACRO);
    // NOT EVEN ATTEMPTED. The persister does not TRACK a publisher's module, so
    // no timer is armed and no flush reaches the write at all. If it ever did,
    // the write's own refusal would surface here as a console error — which is
    // the belt, not the rule, and this asserts the rule.
    expect(container.textContent).not.toMatch(/refused the write/i);
  });

  it("opens a publisher's macro read-only, and says why on the indicator", async () => {
    await mountApp();
    await deliverMacro(THEIR_MACRO);

    expect(buffer().getAttribute("data-readonly")).toBe("true");
    const indicator = container.querySelector("[data-testid='module-live-indicator']")!;
    expect(indicator.getAttribute("data-live-state")).toBe("readOnly");
    expect(indicator.textContent).toContain("Read-only");
    expect(indicator.getAttribute("title")).toMatch(/Save as my copy/i);
  });

  it("leaves the user's own macro editable and live", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);

    expect(buffer().getAttribute("data-readonly")).toBe("false");
    const indicator = container.querySelector("[data-testid='module-live-indicator']")!;
    expect(indicator.getAttribute("data-live-state")).toBe("live");
  });

  // READ-ONLY IS NOT UNRUNNABLE. The mount is by id, from the module store, at
  // the restricted tier — the same mount a button on the grid uses — so reading
  // and stepping through a publisher's macro is exactly what this window is for.
  // Disabling Run "because it is read-only" would be a fresh untruth.
  it("still lets a publisher's macro be run and stepped through", async () => {
    await mountApp();
    await deliverMacro(THEIR_MACRO);

    expect(debugToolbarProps?.runDisabled).toBe(false);
    expect(debugSessionOptions).toEqual({ mountFromModuleStore: true });
  });

  it("writes null for the user's own macro — a positive statement, not a shrug", async () => {
    await mountApp();
    await deliverMacro(MACRO_A);
    await type("// mine");
    await choose(THEIR_MACRO.id);

    expect(saveWorkbookScript.mock.calls[0][0]).toMatchObject({
      id: MACRO_A.id,
      sourcePackage: null,
    });
  });

  // An unreadable record is not a local record. The open payload carries no
  // provenance at all, so "could not read it" must not be rendered as "yours".
  it("does not turn an unreadable publisher macro into local code on screen", async () => {
    await mountApp();
    unreadable.add(THEIR_MACRO.id);
    await deliverMacro(THEIR_MACRO);

    const banner = container.querySelector("[data-testid='macro-provenance-banner']");
    expect(banner, "the last known provenance was dropped on a read failure").toBeTruthy();
    expect(banner!.getAttribute("data-macro-source-package")).toBe("Acme Finance Pack");
    const chip = container.querySelector("[data-testid='macro-tier-chip']")!;
    expect(chip.getAttribute("data-macro-tier")).toBe("restricted");
  });

  // A LISTING THAT COULD NOT READ THE RECORD MUST NOT DEMOTE IT EITHER.
  // `listWorkbookScriptRecords` reports `sourcePackage: null` for a record it
  // failed to read, because it had nothing to ask — so a refresh arriving while
  // the store hiccups must not turn a publisher's macro into the user's own
  // (and make it editable, which is how it would then get bricked).
  it("keeps the last known publisher when a later listing cannot read the record", async () => {
    await mountApp();
    await deliverMacro(THEIR_MACRO);

    unreadable.add(THEIR_MACRO.id);
    await act(async () => {
      scriptsChangedListeners.forEach((l) => l());
      await Promise.resolve();
    });

    const chip = container.querySelector("[data-testid='macro-tier-chip']")!;
    expect(chip.getAttribute("data-macro-provenance")).toBe("package");
    expect(chip.getAttribute("data-macro-tier")).toBe("restricted");
    expect(buffer().getAttribute("data-readonly")).toBe("true");
  });
});

// =============================================================================
// (3) UNKNOWN PROVENANCE IS NOT THE SAFE ANSWER.
//
// The tier chip had two branches: a package name, or "A macro you wrote runs at
// the unlocked tier". A module whose record could NOT be read reaches the second
// one — `sourcePackage` is null because nothing answered, not because the module
// is local — so the one control whose job is to say whose code this is asserted
// the reassuring answer from no evidence at all.
// =============================================================================

const MYSTERY_MACRO: StoredModule = {
  id: "macro-mystery",
  name: "Mystery module",
  description: "Recorded macro · runtime=objectScript · 1 action · recorded 2026-09-02",
  source: "function setup(context) { /* unreadable */ }",
};

describe("Object Script Editor — a module whose origin could not be read", () => {
  beforeEach(() => {
    macroHandler = null;
    scriptsChangedListeners = [];
    listShouldFail = false;
    unreadable.clear();
    store.clear();
    store.set(MYSTERY_MACRO.id, MYSTERY_MACRO);
    store.set(MACRO_A.id, MACRO_A);
    // Unreadable from the very first listing, so nothing about its origin has
    // ever been established in this window.
    unreadable.add(MYSTERY_MACRO.id);
    saveWorkbookScript.mockClear();
    saveObjectScript.mockClear();
    debugSessionOptions = undefined;
    debugToolbarProps = undefined;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("says the origin is unknown instead of claiming the user wrote it", async () => {
    await mountApp();
    await choose(MYSTERY_MACRO.id);

    const chip = container.querySelector("[data-testid='macro-tier-chip']")!;
    expect(chip.getAttribute("data-macro-provenance")).toBe("unknown");
    expect(chip.textContent).toMatch(/origin unknown/i);
    const title = chip.getAttribute("title") ?? "";
    expect(title).toMatch(/could not be read/i);
    expect(title).toMatch(/may be yours or it may have arrived in an application/i);
    expect(title).not.toMatch(/A macro you wrote/i);
  });

  it("still says 'a macro you wrote' when that is actually established", async () => {
    await mountApp();
    await choose(MACRO_A.id);

    const chip = container.querySelector("[data-testid='macro-tier-chip']")!;
    expect(chip.getAttribute("data-macro-provenance")).toBe("local");
    expect(chip.getAttribute("title")).toMatch(/A macro you wrote/i);
  });

  // ===========================================================================
  // ...AND UNKNOWN PROVENANCE IS NOT PERMISSION EITHER.
  //
  // The previous round taught the CHIP to say "origin unknown" and stopped
  // there: the buffer stayed editable and TRACKED by the live persister, so the
  // first keystroke armed an idle write that stored the preview text over
  // whatever is really under that id. The record could not be read, so we do not
  // know what that is — the user's own macro (destroyed) or a publisher's
  // (bricked against the content-keyed Rust consent gate, because `save_script`
  // makes the package stamp sticky). If we could not read what is there, we must
  // not write over it.
  // ===========================================================================

  it("opens a module whose record could not be read READ-ONLY, and says why", async () => {
    await mountApp();
    await choose(MYSTERY_MACRO.id);

    expect(buffer().getAttribute("data-readonly")).toBe("true");
    const indicator = container.querySelector("[data-testid='module-live-indicator']")!;
    expect(indicator.getAttribute("data-live-state")).toBe("readOnly");
    const why = indicator.getAttribute("title") ?? "";
    expect(why).toMatch(/could not be read/i);
    expect(why).toMatch(/read-only until a read succeeds/i);
  });

  it("makes NO write of an unreadable module, however the buffer is driven", async () => {
    await mountApp();
    await choose(MYSTERY_MACRO.id);

    await type("function setup(context) { /* my edit */ }");

    // The indicator never claims a write is coming: a document the persister
    // does not track can never reach "Saving…", which is the observable half of
    // "no idle timer was armed".
    expect(
      container
        .querySelector("[data-testid='module-live-indicator']")!
        .getAttribute("data-live-state"),
    ).toBe("readOnly");

    // Switching document FLUSHES the one being left, and closing the window
    // flushes every tracked document. Neither may write a record nobody read.
    await choose(MACRO_A.id);

    expect(saveWorkbookScript).not.toHaveBeenCalled();
    expect(store.get(MYSTERY_MACRO.id)).toEqual(MYSTERY_MACRO);
    // NOT EVEN ATTEMPTED, which is the rule rather than the belt. The persister
    // does not TRACK this document, so no timer is armed and no flush reaches
    // the write at all. If tracking ever armed it, the write's own refusal would
    // surface in the console as "The module store refused the write" — so this
    // line is what distinguishes "we never tried" from "we tried and were
    // stopped by the last guard". (Verified: relaxing the tracking rule alone
    // leaves every other assertion in this test green.)
    expect(container.textContent).not.toMatch(/refused the write/i);
  });

  it("does not write it on window close either", async () => {
    await mountApp();
    await choose(MYSTERY_MACRO.id);
    await type("function setup(context) { /* my edit */ }");
    gateObjectScriptSave.mockClear();

    // The dispose effect flushes EVERY tracked document on the way out — the
    // last door, and the one no gesture reveals.
    await act(async () => {
      root.unmount();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Re-mount an empty root so the shared afterEach has something to unmount.
    root = createRoot(container);

    expect(saveWorkbookScript).not.toHaveBeenCalled();
    expect(store.get(MYSTERY_MACRO.id)).toEqual(MYSTERY_MACRO);
    // NOT EVEN ATTEMPTED. The close flush gates before it writes, so a gate call
    // here would mean the document was tracked and the write's own guard — the
    // belt — was what stopped it. The console is gone with the window, so this
    // is the only place that distinction is still observable after unmount.
    expect(gateObjectScriptSave, "the close flush armed a write").not.toHaveBeenCalled();
  });

  it("the banner tells the user it is read-only, not that saving will fix it", async () => {
    await mountApp();
    await choose(MYSTERY_MACRO.id);

    const banner = container.querySelector("[data-testid='macro-load-error-banner']")!;
    expect(banner.textContent).toMatch(/read-only/i);
    // The sentence that invited the destructive gesture. Ctrl+S on a record
    // nobody has read is exactly the write this whole change refuses.
    expect(banner.textContent).not.toMatch(/until this is saved/i);
  });

  // THE POSITIVE CONTROL. Read-only here is a consequence of the failed READ,
  // not a permanent state: once the store answers, the module is the user's to
  // edit and the live path works as it always did. Without this, "refuse
  // everything" would pass the tests above and quietly break the feature.
  it("becomes editable and live again once the record can be read", async () => {
    await mountApp();
    await choose(MYSTERY_MACRO.id);
    expect(buffer().getAttribute("data-readonly")).toBe("true");

    unreadable.delete(MYSTERY_MACRO.id);
    await act(async () => {
      scriptsChangedListeners.forEach((l) => l());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(buffer().getAttribute("data-readonly")).toBe("false");
    await type("// mine now");
    await choose(MACRO_A.id);
    expect(store.get(MYSTERY_MACRO.id)!.source).toBe("// mine now");
  });
});

// =============================================================================
// A WRITE MUST NOT WIDEN WHERE THE MODULE RESOLVES FROM.
//
// Every write from this window sent a hard-coded `scope: { type: "workbook" }`,
// so an idle auto-persist of a SHEET-SCOPED module — no gesture, just a pause in
// typing — moved it to the whole workbook. That is a visibility change the
// author never asked for, was never told about, and cannot undo, because the old
// scope is gone from the store.
// =============================================================================

const SHEET_SCOPED_MACRO: StoredModule = {
  id: "macro-scoped",
  name: "Budget close",
  description: "Recorded macro · runtime=objectScript · 1 action · recorded 2026-09-02",
  source: "function setup(context) { /* scoped */ }",
  scope: { type: "sheet", name: "Budget" },
};

describe("Object Script Editor — a module's stored scope survives a live write", () => {
  beforeEach(() => {
    macroHandler = null;
    scriptsChangedListeners = [];
    listShouldFail = false;
    unreadable.clear();
    store.clear();
    store.set(SHEET_SCOPED_MACRO.id, SHEET_SCOPED_MACRO);
    store.set(MACRO_A.id, MACRO_A);
    saveWorkbookScript.mockClear();
    saveObjectScript.mockClear();
    debugSessionOptions = undefined;
    debugToolbarProps = undefined;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("writes the scope it READ, never a workbook default", async () => {
    await mountApp();
    await choose(SHEET_SCOPED_MACRO.id);
    await type("function setup(context) { /* edited */ }");
    await choose(MACRO_A.id);

    expect(saveWorkbookScript).toHaveBeenCalled();
    const written = saveWorkbookScript.mock.calls[0][0];
    expect(written.id).toBe(SHEET_SCOPED_MACRO.id);
    expect(written.source).toBe("function setup(context) { /* edited */ }");
    expect(written.scope).toEqual({ type: "sheet", name: "Budget" });
    expect(store.get(SHEET_SCOPED_MACRO.id)!.scope).toEqual({
      type: "sheet",
      name: "Budget",
    });
  });
});
