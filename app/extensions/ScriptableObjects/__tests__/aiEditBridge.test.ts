//! FILENAME: app/extensions/ScriptableObjects/__tests__/aiEditBridge.test.ts
// PURPOSE: Prove the main-window AI-edit bridge always answers.
// CONTEXT: The editor window shows a spinner from the moment it sends a request
//          until a RESULT comes back. Every way this bridge can fail therefore
//          has to produce a result, not a log line — a silent failure is a
//          permanently spinning editor. These tests exist for the silence.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const emitted: { results: unknown[]; progress: unknown[] } = { results: [], progress: [] };
let requestHandler: ((p: unknown) => void) | null = null;
let cancelHandler: ((p: unknown) => void) | null = null;
const offRequest = vi.fn();
const offCancel = vi.fn();

vi.mock("../lib/crossWindowEvents", () => ({
  emitAiEditResult: vi.fn(async (p: unknown) => {
    emitted.results.push(p);
  }),
  emitAiEditProgress: vi.fn(async (p: unknown) => {
    emitted.progress.push(p);
  }),
  onAiEditRequest: vi.fn(async (cb: (p: unknown) => void) => {
    requestHandler = cb;
    return offRequest;
  }),
  onAiEditCancel: vi.fn(async (cb: (p: unknown) => void) => {
    cancelHandler = cb;
    return offCancel;
  }),
}));

let provider: Record<string, unknown> | null = null;
vi.mock("@api", () => ({
  hasScriptAssistantProvider: () => provider !== null,
  requireScriptAssistantProvider: () => {
    if (!provider) throw new Error("No script assistant provider is registered.");
    return provider;
  },
}));

import {
  installAiEditBridge,
  replayAiEditResults,
  __resetAiEditBridge,
} from "../lib/aiEditBridge";

// ---------------------------------------------------------------------------

const REQUEST = {
  documentId: "obj-1",
  documentName: "Button 1",
  objectType: "button",
  documentKind: "object" as const,
  currentSource: "export function onClick() {}",
  instruction: "make it red",
};

/** Install and wait for the (async) listener registrations to settle. */
async function install(): Promise<() => void> {
  const off = installAiEditBridge();
  await Promise.resolve();
  await Promise.resolve();
  return off;
}

type Result = {
  documentId: string;
  jobId: string;
  ok: boolean;
  source: string;
  summary: string;
  unchanged?: boolean;
};

function results(): Result[] {
  return emitted.results as Result[];
}

beforeEach(() => {
  emitted.results = [];
  emitted.progress = [];
  requestHandler = null;
  cancelHandler = null;
  provider = null;
  __resetAiEditBridge();
  vi.clearAllMocks();
});

afterEach(() => {
  __resetAiEditBridge();
});

describe("aiEditBridge — it always answers", () => {
  it("answers with a refusal when no assistant is registered", async () => {
    // The AIChat extension can be disabled. The editor's button is still there.
    await install();
    requestHandler!(REQUEST);

    expect(results()).toHaveLength(1);
    expect(results()[0].ok).toBe(false);
    expect(results()[0].documentId).toBe("obj-1");
    expect(results()[0].summary).toMatch(/not loaded/i);
  });

  it("answers with a refusal when no model is configured", async () => {
    provider = { isConfigured: () => false, startScriptEdit: vi.fn() };
    await install();
    requestHandler!(REQUEST);

    expect(results()).toHaveLength(1);
    expect(results()[0].ok).toBe(false);
    // The user cannot choose a model from the editor window, so the refusal
    // has to say where to go.
    expect(results()[0].summary).toMatch(/AI Chat/i);
    expect(provider.startScriptEdit).not.toHaveBeenCalled();
  });

  it("answers with a refusal when the provider throws synchronously", async () => {
    provider = {
      isConfigured: () => true,
      startScriptEdit: () => {
        throw new Error("model host is down");
      },
    };
    await install();
    requestHandler!(REQUEST);

    expect(results()).toHaveLength(1);
    expect(results()[0].ok).toBe(false);
    expect(results()[0].summary).toMatch(/model host is down/);
  });

  it("never proposes the current source back as a refusal", async () => {
    // A "proposal" byte-identical to the buffer would invite the user to accept
    // a no-op and believe something happened.
    await install();
    requestHandler!(REQUEST);
    expect(results()[0].source).toBe("");
    expect(results()[0].source).not.toBe(REQUEST.currentSource);
  });

  it("forwards a successful proposal without applying it", async () => {
    let done: ((r: unknown) => void) | null = null;
    provider = {
      isConfigured: () => true,
      startScriptEdit: (req: { onDone: (r: unknown) => void }) => {
        done = req.onDone;
        return "job-7";
      },
    };
    await install();
    requestHandler!(REQUEST);

    // Nothing is emitted until the run finishes — no partial buffer writes.
    expect(results()).toHaveLength(0);

    done!({ documentId: "obj-1", ok: true, source: "export function onClick() { /* red */ }", summary: "Made it red." });

    expect(results()).toHaveLength(1);
    expect(results()[0].ok).toBe(true);
    expect(results()[0].jobId).toBe("job-7");
    expect(results()[0].source).toContain("red");
  });

  it("passes the ON-SCREEN source, not a stored copy", async () => {
    const start = vi.fn(() => "job-1");
    provider = { isConfigured: () => true, startScriptEdit: start };
    await install();
    requestHandler!(REQUEST);

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        currentSource: REQUEST.currentSource,
        instruction: "make it red",
        documentKind: "object",
        objectType: "button",
      }),
    );
  });

  it("relays progress under the running job id", async () => {
    let onProgress: ((phase: string, live?: string) => void) | null = null;
    provider = {
      isConfigured: () => true,
      startScriptEdit: (req: { onProgress: (p: string, l?: string) => void }) => {
        onProgress = req.onProgress;
        return "job-9";
      },
    };
    await install();
    requestHandler!(REQUEST);

    onProgress!("Round 2 of 3", "checking the API surface");
    expect(emitted.progress).toEqual([
      { documentId: "obj-1", jobId: "job-9", phase: "Round 2 of 3", live: "checking the API surface" },
    ]);
  });

  it("re-sends the last result when an editor announces itself ready", async () => {
    // The window can be CLOSED during a six-minute run; a result emitted at a
    // window that no longer exists is lost.
    let done: ((r: unknown) => void) | null = null;
    provider = {
      isConfigured: () => true,
      startScriptEdit: (req: { onDone: (r: unknown) => void }) => {
        done = req.onDone;
        return "job-3";
      },
    };
    await install();
    requestHandler!(REQUEST);
    done!({ documentId: "obj-1", ok: true, source: "new", summary: "done" });
    emitted.results = [];

    replayAiEditResults();

    expect(results()).toHaveLength(1);
    expect(results()[0].source).toBe("new");
  });

  it("cancels the job the editor names", async () => {
    const cancel = vi.fn();
    provider = { isConfigured: () => true, startScriptEdit: () => "job-4", cancelScriptEdit: cancel };
    await install();
    requestHandler!(REQUEST);

    cancelHandler!({ documentId: "obj-1", jobId: "job-4" });
    expect(cancel).toHaveBeenCalledWith("job-4");
  });

  it("ignores a cancel with no job id", async () => {
    const cancel = vi.fn();
    provider = { isConfigured: () => true, cancelScriptEdit: cancel };
    await install();
    cancelHandler!({ documentId: "obj-1", jobId: "" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("unsubscribes on teardown and forgets stored results", async () => {
    provider = { isConfigured: () => true, startScriptEdit: () => "job-5" };
    const off = await install();
    off();
    expect(offRequest).toHaveBeenCalled();
    expect(offCancel).toHaveBeenCalled();

    replayAiEditResults();
    expect(results()).toHaveLength(0);
  });

  it("unsubscribes even when teardown beats the async registration", async () => {
    // installAiEditBridge() returns synchronously but subscribes on a promise.
    // An extension deactivated in that window must not leak a listener.
    const off = installAiEditBridge();
    off();
    await Promise.resolve();
    await Promise.resolve();
    expect(offRequest).toHaveBeenCalled();
    expect(offCancel).toHaveBeenCalled();
  });

  it("keeps one result per document", async () => {
    const dones: Array<(r: unknown) => void> = [];
    provider = {
      isConfigured: () => true,
      startScriptEdit: (req: { onDone: (r: unknown) => void }) => {
        dones.push(req.onDone);
        return `job-${dones.length}`;
      },
    };
    await install();
    requestHandler!(REQUEST);
    requestHandler!({ ...REQUEST, documentId: "macro-2", documentKind: "module" });
    dones[0]({ documentId: "obj-1", ok: true, source: "A", summary: "a" });
    dones[1]({ documentId: "macro-2", ok: true, source: "B", summary: "b" });
    emitted.results = [];

    replayAiEditResults();
    expect(results().map((r) => r.source).sort()).toEqual(["A", "B"]);
  });
});
