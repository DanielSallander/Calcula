//! FILENAME: app/src/api/scriptAssistantSeam.test.ts
// PURPOSE: The seam that lets a script editor ask an AI to change the code on
//          screen, without either extension knowing the other exists.
// CONTEXT: Sibling of macroSeams.test.ts, which is the template. This seam is
//          the MIRROR of scriptEditorService: that one points AIChat -> the
//          editor, this one points the editor -> AIChat.

import { describe, it, expect, beforeEach } from "vitest";
import {
  hasScriptAssistantProvider,
  registerScriptAssistantProvider,
  requireScriptAssistantProvider,
  resetScriptAssistantProvider,
  type ScriptAssistantProvider,
  type ScriptEditRequest,
} from "./scriptAssistantService";

const noop: ScriptAssistantProvider = {
  isConfigured: () => true,
  modelLabel: () => "test-model",
  startScriptEdit: () => "job-1",
  cancelScriptEdit: () => {},
  showJob: () => {},
};

const REQUEST: ScriptEditRequest = {
  documentId: "doc-1",
  documentName: "Paint by value",
  objectType: "button",
  documentKind: "objectScript",
  currentSource: "export function setup(context) {}",
  instruction: "make it green",
  onDone: () => {},
};

beforeEach(() => resetScriptAssistantProvider());

describe("scriptAssistantService seam", () => {
  it("throws a message naming AI Chat when nothing is registered", () => {
    expect(hasScriptAssistantProvider()).toBe(false);
    // The editor turns this into something the user can act on, rather than a
    // button that silently does nothing.
    expect(() => requireScriptAssistantProvider()).toThrow(/AI Chat/);
  });

  it("routes an edit request through the registered provider", () => {
    const seen: ScriptEditRequest[] = [];
    registerScriptAssistantProvider({
      ...noop,
      startScriptEdit: (req) => {
        seen.push(req);
        return "job-42";
      },
    });

    const id = requireScriptAssistantProvider().startScriptEdit(REQUEST);
    expect(id, "the job id comes back immediately, not a promise").toBe("job-42");
    expect(seen).toHaveLength(1);
    // The ON-SCREEN buffer, not a stored copy: the user may have typed since
    // the last save, and editing anything else discards that silently.
    expect(seen[0].currentSource).toBe("export function setup(context) {}");
    expect(seen[0].documentId).toBe("doc-1");
  });

  it("carries cancel and show, so a six-minute run is not a trap", () => {
    const cancelled: string[] = [];
    const shown: string[] = [];
    registerScriptAssistantProvider({
      ...noop,
      cancelScriptEdit: (id) => cancelled.push(id),
      showJob: (id) => shown.push(id),
    });
    requireScriptAssistantProvider().cancelScriptEdit("job-7");
    requireScriptAssistantProvider().showJob("job-7");
    expect(cancelled).toEqual(["job-7"]);
    expect(shown).toEqual(["job-7"]);
  });

  it("answers whether a model is configured, without exposing which settings", () => {
    // The editor must be able to EXPLAIN itself without owning AIChat's
    // settings keys — a second reader of those keys is a second source of truth.
    registerScriptAssistantProvider({ ...noop, isConfigured: () => false, modelLabel: () => "" });
    expect(requireScriptAssistantProvider().isConfigured()).toBe(false);

    registerScriptAssistantProvider({ ...noop, isConfigured: () => true, modelLabel: () => "qwen2.5:7b" });
    expect(requireScriptAssistantProvider().modelLabel()).toBe("qwen2.5:7b");
  });

  it("last registration wins", () => {
    registerScriptAssistantProvider({ ...noop, modelLabel: () => "first" });
    registerScriptAssistantProvider({ ...noop, modelLabel: () => "second" });
    expect(requireScriptAssistantProvider().modelLabel()).toBe("second");
  });

  it("unregistering only clears the provider if it is still the current one", () => {
    // A re-activation must not leave the seam empty because a stale cleanup ran.
    const offFirst = registerScriptAssistantProvider({ ...noop, modelLabel: () => "first" });
    registerScriptAssistantProvider({ ...noop, modelLabel: () => "second" });
    offFirst();
    expect(hasScriptAssistantProvider(), "the SECOND registration must survive").toBe(true);
    expect(requireScriptAssistantProvider().modelLabel()).toBe("second");
  });

  it("unregistering the current provider does clear it", () => {
    const off = registerScriptAssistantProvider(noop);
    off();
    expect(hasScriptAssistantProvider()).toBe(false);
  });
});
