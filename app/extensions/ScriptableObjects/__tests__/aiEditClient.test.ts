//! FILENAME: app/extensions/ScriptableObjects/__tests__/aiEditClient.test.ts
// PURPOSE: Prove the editor-side rule: a proposal NEVER reaches the buffer by
//          itself, and the state it lives in is safe to hand React.
// CONTEXT: Two bugs already cost a run each in this feature — an in-place
//          update React could not see, and a fresh array per call that React saw
//          as an endless change. Both live in `useSyncExternalStore`'s identity
//          contract, so both are pinned here.

import { describe, it, expect, vi, beforeEach } from "vitest";

const emitted: { requests: unknown[]; cancels: unknown[] } = { requests: [], cancels: [] };
let progressHandler: ((p: unknown) => void) | null = null;
let resultHandler: ((p: unknown) => void) | null = null;
const offProgress = vi.fn();
const offResult = vi.fn();
let requestRejects = false;

vi.mock("../lib/crossWindowEvents", () => ({
  emitAiEditRequest: vi.fn(async (p: unknown) => {
    if (requestRejects) throw new Error("no main window");
    emitted.requests.push(p);
  }),
  emitAiEditCancel: vi.fn(async (p: unknown) => {
    emitted.cancels.push(p);
  }),
  onAiEditProgress: vi.fn(async (cb: (p: unknown) => void) => {
    progressHandler = cb;
    return offProgress;
  }),
  onAiEditResult: vi.fn(async (cb: (p: unknown) => void) => {
    resultHandler = cb;
    return offResult;
  }),
}));

import {
  aiEditStateFor,
  anyAiEditRunning,
  askAiToEdit,
  cancelAiEdit,
  clearAiEdit,
  installAiEditClient,
  rejectAiEdit,
  subscribeToAiEdits,
  __resetAiEditClient,
} from "../lib/aiEditClient";

const ASK = {
  documentId: "obj-1",
  documentName: "Button 1",
  objectType: "button",
  documentKind: "objectScript" as const,
  currentSource: "export function onClick() {}",
  instruction: "make it red",
};

async function install(): Promise<() => void> {
  const off = installAiEditClient();
  await Promise.resolve();
  await Promise.resolve();
  return off;
}

beforeEach(() => {
  emitted.requests = [];
  emitted.cancels = [];
  progressHandler = null;
  resultHandler = null;
  requestRejects = false;
  __resetAiEditClient();
  vi.clearAllMocks();
});

describe("aiEditClient — the proposal stops here", () => {
  it("sends the on-screen source and enters the running state", async () => {
    await install();
    askAiToEdit(ASK);

    expect(emitted.requests).toHaveLength(1);
    expect(emitted.requests[0]).toMatchObject({ currentSource: ASK.currentSource, instruction: "make it red" });
    expect(aiEditStateFor("obj-1").phase).toBe("running");
    expect(anyAiEditRunning()).toBe(true);
  });

  it("holds a proposal without applying anything", async () => {
    await install();
    askAiToEdit(ASK);
    resultHandler!({ documentId: "obj-1", jobId: "j1", ok: true, source: "NEW", summary: "did it" });

    const state = aiEditStateFor("obj-1");
    expect(state.phase).toBe("proposed");
    expect(state.proposal).toBe("NEW");
    // The client has no route to the buffer at all — that is the guarantee.
    expect(Object.keys(state)).not.toContain("applied");
  });

  it("always holds an ARRAY of unexercised hooks, whatever the payload carried", async () => {
    // The diff window renders off `state.unexercisedHooks.length`. A result from
    // an assistant provider that ran no dry run — or from a main window built
    // before the field existed — omits it, and `undefined.length` inside a
    // render takes the review window down with it.
    await install();
    askAiToEdit(ASK);
    resultHandler!({ documentId: "obj-1", jobId: "j1", ok: true, source: "NEW", summary: "" });
    expect(aiEditStateFor("obj-1").unexercisedHooks).toEqual([]);

    askAiToEdit({ ...ASK, documentId: "obj-2" });
    resultHandler!({
      documentId: "obj-2",
      jobId: "j2",
      ok: true,
      source: "NEW",
      summary: "",
      unexercisedHooks: ["onSelectionChange"],
    });
    expect(aiEditStateFor("obj-2").unexercisedHooks).toEqual(["onSelectionChange"]);
  });

  it("keeps state per document, so a run survives switching scripts", async () => {
    await install();
    askAiToEdit(ASK);
    askAiToEdit({ ...ASK, documentId: "macro-2", documentKind: "module" });
    resultHandler!({ documentId: "obj-1", jobId: "j1", ok: true, source: "A", summary: "" });

    expect(aiEditStateFor("obj-1").phase).toBe("proposed");
    expect(aiEditStateFor("macro-2").phase).toBe("running");
  });

  it("turns a failed result into an error, never a proposal", async () => {
    await install();
    askAiToEdit(ASK);
    resultHandler!({ documentId: "obj-1", jobId: "", ok: false, source: "", summary: "no model selected" });

    expect(aiEditStateFor("obj-1").phase).toBe("error");
    expect(aiEditStateFor("obj-1").proposal).toBe("");
  });

  it("reports a request that never left the window", async () => {
    // Otherwise the spinner runs forever waiting on a result that cannot come.
    requestRejects = true;
    await install();
    askAiToEdit(ASK);
    await Promise.resolve();
    await Promise.resolve();

    expect(aiEditStateFor("obj-1").phase).toBe("error");
    expect(aiEditStateFor("obj-1").summary).toMatch(/main window/i);
  });

  it("leaves nothing behind on reject, and tells the main window to forget it", async () => {
    await install();
    askAiToEdit(ASK);
    resultHandler!({ documentId: "obj-1", jobId: "j1", ok: true, source: "NEW", summary: "" });
    rejectAiEdit("obj-1");

    expect(aiEditStateFor("obj-1").phase).toBe("idle");
    expect(aiEditStateFor("obj-1").proposal).toBe("");
    // Without this, a rejected proposal comes BACK when the window reopens: the
    // main window replays its last result per document on READY.
    expect(emitted.cancels).toEqual([{ documentId: "obj-1", jobId: "j1" }]);
  });

  it("clears after accept so the same diff cannot be accepted twice", async () => {
    await install();
    askAiToEdit(ASK);
    resultHandler!({ documentId: "obj-1", jobId: "j1", ok: true, source: "NEW", summary: "" });
    clearAiEdit("obj-1");
    expect(aiEditStateFor("obj-1").phase).toBe("idle");
  });

  it("ignores a replayed result for a proposal already on screen", async () => {
    // The main window re-sends on READY because it cannot know the first
    // delivery landed. Re-opening a diff the author is already looking at — or
    // worse, one they just resolved — is this side's job to prevent.
    await install();
    askAiToEdit(ASK);
    resultHandler!({ documentId: "obj-1", jobId: "j1", ok: true, source: "FIRST", summary: "" });
    resultHandler!({ documentId: "obj-1", jobId: "j1", ok: true, source: "SECOND", summary: "" });

    expect(aiEditStateFor("obj-1").proposal).toBe("FIRST");
  });

  it("accepts a replayed result in a freshly opened window", async () => {
    // The window was closed mid-run: no local state, so the replay IS the
    // delivery.
    await install();
    resultHandler!({ documentId: "obj-9", jobId: "j2", ok: true, source: "LATE", summary: "" });
    expect(aiEditStateFor("obj-9").phase).toBe("proposed");
    expect(aiEditStateFor("obj-9").proposal).toBe("LATE");
  });

  it("ignores progress for a run it is no longer waiting on", async () => {
    await install();
    askAiToEdit(ASK);
    cancelAiEdit("obj-1");
    progressHandler!({ documentId: "obj-1", jobId: "j1", phase: "Round 2", live: "" });

    expect(aiEditStateFor("obj-1").phase).toBe("idle");
  });

  it("shows progress while running", async () => {
    await install();
    askAiToEdit(ASK);
    progressHandler!({ documentId: "obj-1", jobId: "j1", phase: "Round 2 of 3", live: "validating" });

    expect(aiEditStateFor("obj-1").progress).toBe("Round 2 of 3");
    expect(aiEditStateFor("obj-1").live).toBe("validating");
  });
});

describe("aiEditClient — the useSyncExternalStore contract", () => {
  it("returns a STABLE object when nothing has happened", () => {
    // A fresh literal per call is a new snapshot every render, which React
    // answers with "Maximum update depth exceeded". This exact shape has
    // already broken this feature once.
    expect(aiEditStateFor("nope")).toBe(aiEditStateFor("nope"));
    expect(aiEditStateFor(null)).toBe(aiEditStateFor("also-nope"));
  });

  it("returns a stable object between changes", async () => {
    await install();
    askAiToEdit(ASK);
    const a = aiEditStateFor("obj-1");
    expect(aiEditStateFor("obj-1")).toBe(a);
  });

  it("REPLACES the object on every change, never mutates it", async () => {
    // An in-place update returns the same reference, Object.is says "no
    // change", and React never re-renders — which is how the Stop button in the
    // main window came to look dead.
    await install();
    askAiToEdit(ASK);
    const running = aiEditStateFor("obj-1");
    progressHandler!({ documentId: "obj-1", jobId: "j1", phase: "Round 2", live: "" });
    const progressed = aiEditStateFor("obj-1");

    expect(progressed).not.toBe(running);
    expect(running.progress).toBe("Sending to the model");
    expect(progressed.progress).toBe("Round 2");
  });

  it("notifies subscribers on every transition", async () => {
    await install();
    const seen = vi.fn();
    const off = subscribeToAiEdits(seen);

    askAiToEdit(ASK);
    progressHandler!({ documentId: "obj-1", jobId: "j1", phase: "Round 2", live: "" });
    resultHandler!({ documentId: "obj-1", jobId: "j1", ok: true, source: "NEW", summary: "" });
    expect(seen).toHaveBeenCalledTimes(3);

    off();
    rejectAiEdit("obj-1");
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("unsubscribes even when teardown beats the async registration", async () => {
    const off = installAiEditClient();
    off();
    await Promise.resolve();
    await Promise.resolve();
    expect(offProgress).toHaveBeenCalled();
    expect(offResult).toHaveBeenCalled();
  });
});
