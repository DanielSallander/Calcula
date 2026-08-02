//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptDraftReview.test.ts
// PURPOSE: The AI script-draft review queue must actually exist, and arriving
//          must never make AI-authored code run.
// CONTEXT: `app/src-tauri/src/mcp/drafts.rs` emits `mcp:script-draft` and its
//          tool response tells the calling agent the draft "is queued for the
//          user to review in the Object Script Editor". Nothing in the frontend
//          listened for that event, and no surface listed drafts — the agent,
//          and therefore the user, was told something that was not true. These
//          tests pin the wiring AND the property that makes the wiring safe:
//          the arrival path notifies and opens a review window, and does not
//          save, register or mount anything.

import { describe, it, expect, beforeEach, vi } from "vitest";

// --- The Tauri event bridge --------------------------------------------------
type DraftListener = (payload: unknown) => void;
const listeners = new Map<string, DraftListener[]>();
const unlistenSpy = vi.fn();
const listenTauriEvent = vi.fn(
  async (event: string, cb: DraftListener): Promise<() => void> => {
    const list = listeners.get(event) ?? [];
    list.push(cb);
    listeners.set(event, list);
    return unlistenSpy;
  },
);
vi.mock("@api/backend", () => ({
  listenTauriEvent: (...args: unknown[]) =>
    (listenTauriEvent as unknown as (...a: unknown[]) => unknown)(...args),
  emitTauriEvent: vi.fn(async () => {}),
}));

// --- The @api barrel ---------------------------------------------------------
// `saveObjectScript` and the whole ObjectScriptManager are stubbed here purely
// so the test can assert they are NEVER reached from the arrival path.
const showToast = vi.fn();
const saveObjectScript = vi.fn(async () => {});
const registerScript = vi.fn();
const mountScript = vi.fn(async () => {});
vi.mock("@api", () => ({
  showToast: (...args: unknown[]) => showToast(...args),
  saveObjectScript: (...args: unknown[]) => saveObjectScript(...(args as [])),
  ObjectScriptManager: {
    registerScript: (...args: unknown[]) => registerScript(...args),
    mountScript: (...args: unknown[]) => mountScript(...(args as [])),
  },
}));

// --- The editor window -------------------------------------------------------
const openObjectScriptEditorWithDraft = vi.fn(async () => {});
const openObjectScriptEditor = vi.fn(async () => {});
vi.mock("../lib/openObjectScriptWindow", () => ({
  openObjectScriptEditorWithDraft: (...args: unknown[]) =>
    (openObjectScriptEditorWithDraft as unknown as (...a: unknown[]) => Promise<void>)(...args),
  openObjectScriptEditor: (...args: unknown[]) =>
    (openObjectScriptEditor as unknown as (...a: unknown[]) => Promise<void>)(...args),
  isObjectScriptEditorOpen: () => false,
}));

import {
  MCP_SCRIPT_DRAFT_EVENT,
  installScriptDraftReview,
  isScriptDraft,
  draftToScriptDefinition,
} from "../lib/scriptDrafts";
import type { ScriptDraft } from "../lib/crossWindowEvents";

/** A well-formed draft exactly as `mcp/drafts.rs` serializes one. */
function makeDraft(overrides: Partial<ScriptDraft> = {}): ScriptDraft {
  return {
    id: "draft-0123456789abcdef",
    name: "Refresh the report",
    objectType: "button",
    instanceId: "btn-1",
    description: "Pulls the latest figures when clicked",
    source: "export function setup(context) { context.log('hi'); }",
    declaredCapabilities: [],
    createdAt: "2026-08-02T10:00:00Z",
    mounted: false,
    ...overrides,
  };
}

function emitDraft(payload: unknown): void {
  const list = listeners.get(MCP_SCRIPT_DRAFT_EVENT) ?? [];
  expect(list.length, "nothing is listening for mcp:script-draft").toBeGreaterThan(0);
  for (const cb of list) cb(payload);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MCP script-draft review queue", () => {
  beforeEach(() => {
    listeners.clear();
    listenTauriEvent.mockClear();
    unlistenSpy.mockClear();
    showToast.mockClear();
    saveObjectScript.mockClear();
    registerScript.mockClear();
    mountScript.mockClear();
    openObjectScriptEditorWithDraft.mockClear();
  });

  it("subscribes to the event the backend actually emits", async () => {
    const dispose = installScriptDraftReview();
    await flush();
    expect(listenTauriEvent).toHaveBeenCalledTimes(1);
    expect(listenTauriEvent.mock.calls[0][0]).toBe("mcp:script-draft");
    dispose();
  });

  it("opens the drafted script for review and tells the user it has not run", async () => {
    const dispose = installScriptDraftReview();
    await flush();

    const draft = makeDraft();
    emitDraft(draft);
    await flush();

    expect(openObjectScriptEditorWithDraft).toHaveBeenCalledTimes(1);
    expect(openObjectScriptEditorWithDraft.mock.calls[0][0]).toEqual(draft);

    expect(showToast).toHaveBeenCalledTimes(1);
    const message = String(showToast.mock.calls[0][0]);
    expect(message).toContain("Refresh the report");
    expect(message).toMatch(/not saved/i);
    expect(message).toMatch(/has not run/i);

    dispose();
  });

  // THE SECURITY PROPERTY. A draft is code an AI wrote; the user has not read
  // it yet. Arrival must be inert.
  it("does not save, register or mount the drafted script", async () => {
    const dispose = installScriptDraftReview();
    await flush();

    emitDraft(makeDraft({ declaredCapabilities: ["net.fetch"] }));
    await flush();

    expect(saveObjectScript).not.toHaveBeenCalled();
    expect(registerScript).not.toHaveBeenCalled();
    expect(mountScript).not.toHaveBeenCalled();

    dispose();
  });

  it("refuses a malformed payload instead of opening an editor on it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispose = installScriptDraftReview();
    await flush();

    // Empty source, unknown object type, and a payload that CLAIMS it is
    // already mounted — the one claim a draft may never make.
    emitDraft(makeDraft({ source: "" }));
    emitDraft(makeDraft({ objectType: "machine" }));
    emitDraft(makeDraft({ mounted: true }));
    emitDraft(null);
    emitDraft({ nope: true });
    await flush();

    expect(openObjectScriptEditorWithDraft).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    warn.mockRestore();
    dispose();
  });

  it("stops delivering once the extension is torn down", async () => {
    const dispose = installScriptDraftReview();
    await flush();
    dispose();
    expect(unlistenSpy).toHaveBeenCalledTimes(1);

    emitDraft(makeDraft());
    await flush();
    expect(openObjectScriptEditorWithDraft).not.toHaveBeenCalled();
  });
});

describe("draft payload validation", () => {
  it("accepts every object type the backend will accept", () => {
    // Mirrors VALID_OBJECT_TYPES in app/src-tauri/src/mcp/drafts.rs.
    const rustTypes = [
      "workbook", "sheet", "cell", "row", "column", "slicer", "chart", "pivot",
      "button", "textbox", "timeline", "shape", "table", "namedRange", "panel", "range",
    ];
    for (const t of rustTypes) {
      expect(isScriptDraft(makeDraft({ objectType: t })), t).toBe(true);
    }
  });

  it("rejects a draft with a non-string capability list", () => {
    expect(isScriptDraft(makeDraft({ declaredCapabilities: [1 as unknown as string] }))).toBe(false);
    expect(isScriptDraft(makeDraft({ declaredCapabilities: undefined as unknown as string[] }))).toBe(false);
  });
});

describe("promoting a draft to a script", () => {
  it("never arrives pre-escalated to the unlocked tier", () => {
    const script = draftToScriptDefinition(makeDraft());
    expect(script.accessLevel).toBe("restricted");
  });

  it("assigns a fresh id rather than letting the AI pick the identity", () => {
    const draft = makeDraft();
    const a = draftToScriptDefinition(draft);
    const b = draftToScriptDefinition(draft);
    expect(a.id).not.toBe(draft.id);
    expect(a.id).not.toBe(b.id);
  });

  it("carries the draft's target and source through unchanged", () => {
    const draft = makeDraft();
    const script = draftToScriptDefinition(draft);
    expect(script.objectType).toBe("button");
    expect(script.instanceId).toBe("btn-1");
    expect(script.source).toBe(draft.source);
    expect(script.name).toBe(draft.name);
    expect(script.provenance).toBeUndefined();
  });
});
