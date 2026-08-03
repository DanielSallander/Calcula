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
const emitSaveAndApply = vi.fn(async () => {});
const emitRegisterScript = vi.fn(async () => {});
const emitToggleAccess = vi.fn(async () => {});
vi.mock("../lib/crossWindowEvents", () => ({
  ObjectScriptEditorEvents: {},
  emitSaveAndApply: (...a: unknown[]) => emitSaveAndApply(...(a as [])),
  emitRegisterScript: (...a: unknown[]) => emitRegisterScript(...(a as [])),
  emitToggleAccess: (...a: unknown[]) => emitToggleAccess(...(a as [])),
  emitEditorClosed: vi.fn(async () => {}),
  onOpenWithScript: async () => () => {},
  onOpenWithDraft: async (cb: (payload: OpenWithDraftPayload) => void) => {
    draftHandler = cb;
    return () => { draftHandler = null; };
  },
  onOpenWithModuleMacro: async () => () => {},
  onConsoleOutput: async () => () => {},
  onScriptError: async () => () => {},
  onScriptsChanged: async () => () => {},
}));

// --- Backend ------------------------------------------------------------------
const saveObjectScript = vi.fn(async () => {});
const loadAllObjectScripts = vi.fn(async () => [] as unknown[]);
vi.mock("@api/objectScriptBackend", () => ({
  loadAllObjectScripts: (...a: unknown[]) => loadAllObjectScripts(...(a as [])),
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

describe("Object Script Editor — AI draft review mode", () => {
  beforeEach(() => {
    draftHandler = null;
    saveObjectScript.mockClear();
    emitSaveAndApply.mockClear();
    gateObjectScriptSave.mockClear();
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
