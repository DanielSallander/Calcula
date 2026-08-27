//! FILENAME: app/extensions/ScriptableObjects/__tests__/aiEditRunSurvivesTheWire.test.ts
// PURPOSE: THE DROP-DETECTOR. Prove that the whole authoring run — every field,
//          including the model's own prose — survives the trip from the main
//          window's bridge, across the Tauri channel, into the editor window's
//          state.
// CONTEXT: 2026-08-26. The report that started this work was one sentence: "I
//          could not see the reasoning or the results from the chat." The prose
//          was destroyed on arrival at one end, and nothing downstream could
//          show what it never received. This test is the guard against that
//          happening again anywhere along the wire.
//
//          LOAD-BEARING PRECISELY BECAUSE `tsconfig.check.json` EXCLUDES TEST
//          FILES. The type gate can never see a hand-written double that forgets
//          a field, so a payload that quietly drops half a record would compile,
//          run, and show the author an empty log. The assertions here are on
//          VALUES, not on types.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuthoringRun } from "@api/scriptHost/authoringRun";

// ---------------------------------------------------------------------------
// One in-memory channel, standing in for the two Tauri windows.
//
// The bridge EMITS and the client LISTENS, so the mock wires the emit straight
// into whatever the client subscribed — which is exactly what the real channel
// does, minus the process boundary.
// ---------------------------------------------------------------------------

const emitted: { results: unknown[]; progress: unknown[] } = { results: [], progress: [] };
let requestHandler: ((p: never) => void) | null = null;
let progressHandler: ((p: never) => void) | null = null;
let resultHandler: ((p: never) => void) | null = null;

vi.mock("../lib/crossWindowEvents", () => ({
  emitAiEditRequest: vi.fn(async (p: never) => {
    requestHandler?.(p);
  }),
  emitAiEditCancel: vi.fn(async () => {}),
  emitAiEditResult: vi.fn(async (p: never) => {
    emitted.results.push(p);
    resultHandler?.(p);
  }),
  emitAiEditProgress: vi.fn(async (p: never) => {
    emitted.progress.push(p);
    progressHandler?.(p);
  }),
  onAiEditRequest: vi.fn(async (cb: (p: never) => void) => {
    requestHandler = cb;
    return () => {};
  }),
  onAiEditCancel: vi.fn(async (_cb: (p: never) => void) => () => {}),
  onAiEditProgress: vi.fn(async (cb: (p: never) => void) => {
    progressHandler = cb;
    return () => {};
  }),
  onAiEditResult: vi.fn(async (cb: (p: never) => void) => {
    resultHandler = cb;
    return () => {};
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

import { installAiEditBridge, __resetAiEditBridge } from "../lib/aiEditBridge";
import {
  aiEditStateFor,
  askAiToEdit,
  installAiEditClient,
  __resetAiEditClient,
} from "../lib/aiEditClient";

// ---------------------------------------------------------------------------
// A run with a DISTINCT sentinel in every field.
//
// Distinct on purpose: a payload that copied the wrong field into the right slot
// would pass a test written with repeated values.
// ---------------------------------------------------------------------------

const SENTINEL_RUN: AuthoringRun = {
  runId: "sentinel-run-id",
  kind: "edit",
  outcome: "unchanged",
  decision: "accepted",
  decidedAt: "2026-08-26T10:11:12.000Z",
  startedAt: "2026-08-26T10:00:00.000Z",
  elapsedMs: 395_000,
  instruction: "sentinel instruction: make the totals bold",
  objectType: "sentinel-object-type",
  providerId: "sentinel-provider",
  model: "sentinel-model:9b",
  tier: "sentinel-tier",
  surfaceTokens: 4321,
  surfaceTruncated: true,
  summary: "sentinel summary",
  attempts: [
    {
      attempt: 1,
      at: 0,
      durationMs: 190_000,
      ok: false,
      reply: "sentinel reply one, prose before ```js\ncode\n``` and prose after",
      replyChars: 999,
      note: "sentinel note one — what the model says it did",
      reasoning: "sentinel reasoning one",
      reasoningChars: 111,
      findings: [
        { severity: "error", code: "sentinel-code-a", message: "sentinel message a" },
        { severity: "notice", code: "sentinel-code-b", message: "sentinel message b" },
      ],
      dryRun: {
        applicable: true,
        ok: false,
        changedCells: 7,
        error: "sentinel dry-run error",
        declinedReason: "sentinel declined reason",
      },
    },
    {
      attempt: 2,
      at: 190_000,
      durationMs: 205_000,
      ok: true,
      reply: "sentinel reply two",
      replyChars: 18,
      note: "sentinel note two",
      reasoning: "sentinel reasoning two",
      reasoningChars: 22,
      findings: [{ severity: "notice", code: "sentinel-code-c", message: "sentinel message c" }],
    },
  ],
  notices: ["sentinel notice one", "sentinel notice two"],
  changedNothing: true,
  unexercisedHooks: ["onSentinelHook"],
  elided: true,
};

const DOC = "obj-sentinel";
const ASK = {
  documentId: DOC,
  documentName: "Sentinel Button",
  objectType: "button",
  documentKind: "objectScript" as const,
  currentSource: "SENTINEL SOURCE AS ASKED",
  instruction: "sentinel instruction: make the totals bold",
};

async function installBoth(): Promise<() => void> {
  const offBridge = installAiEditBridge();
  const offClient = installAiEditClient();
  // Both subscribe through a promise chain, so the handlers are not registered
  // until the microtask queue drains.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return () => {
    offBridge();
    offClient();
  };
}

beforeEach(() => {
  emitted.results.length = 0;
  emitted.progress.length = 0;
  requestHandler = null;
  progressHandler = null;
  resultHandler = null;
  provider = null;
  __resetAiEditBridge();
  __resetAiEditClient();
});

afterEach(() => {
  __resetAiEditBridge();
  __resetAiEditClient();
});

describe("the authoring run survives the wire", () => {
  it("arrives in the editor's state field for field", async () => {
    let done: ((r: Record<string, unknown>) => void) | null = null;
    provider = {
      isConfigured: () => true,
      modelLabel: () => "sentinel-model:9b",
      startScriptEdit: (req: { documentId: string; onDone: (r: Record<string, unknown>) => void }) => {
        done = req.onDone;
        return "job-sentinel";
      },
      cancelScriptEdit: () => {},
      showJob: () => {},
    };

    const off = await installBoth();
    askAiToEdit(ASK);
    await Promise.resolve();

    expect(done, "the bridge never started the edit").toBeTruthy();
    done!({
      documentId: DOC,
      ok: true,
      source: "SENTINEL SOURCE AS ASKED",
      summary: "sentinel summary",
      unchanged: true,
      unexercisedHooks: ["onSentinelHook"],
      run: SENTINEL_RUN,
    });
    await Promise.resolve();

    const state = aiEditStateFor(DOC);
    expect(state.phase).toBe("proposed");
    // THE ASSERTION THIS FILE EXISTS FOR. Deep equality, not a field check: a
    // bridge that rebuilt a "summary" of the run would pass any assertion
    // written one field at a time.
    expect(state.run).toEqual(SENTINEL_RUN);
    // The two facts the run itself cannot state: what was typed, and what the
    // model was handed.
    expect(state.instruction).toBe(ASK.instruction);
    expect(state.askedAgainst).toBe(ASK.currentSource);

    off();
  });

  it("drops no key on the way", async () => {
    let done: ((r: Record<string, unknown>) => void) | null = null;
    provider = {
      isConfigured: () => true,
      modelLabel: () => "sentinel-model:9b",
      startScriptEdit: (req: { onDone: (r: Record<string, unknown>) => void }) => {
        done = req.onDone;
        return "job-sentinel";
      },
      cancelScriptEdit: () => {},
      showJob: () => {},
    };

    const off = await installBoth();
    askAiToEdit(ASK);
    await Promise.resolve();
    done!({
      documentId: DOC,
      ok: true,
      source: "NEW",
      summary: "sentinel summary",
      unexercisedHooks: [],
      run: SENTINEL_RUN,
    });
    await Promise.resolve();

    const arrived = aiEditStateFor(DOC).run;
    expect(arrived).toBeTruthy();
    // Enumerated rather than listed, so a field ADDED to `AuthoringRun` and
    // forgotten by the bridge is caught by this test without anyone editing it.
    for (const key of Object.keys(SENTINEL_RUN)) {
      expect(Object.keys(arrived as object), `key "${key}" was lost on the wire`).toContain(key);
    }
    // And the nested prose, which is the specific thing that used to be thrown
    // away before it ever reached a wire at all.
    expect(arrived!.attempts[0].note).toBe(SENTINEL_RUN.attempts[0].note);
    expect(arrived!.attempts[0].reasoning).toBe(SENTINEL_RUN.attempts[0].reasoning);
    expect(arrived!.attempts[0].reply).toBe(SENTINEL_RUN.attempts[0].reply);
    expect(arrived!.attempts[0].findings).toEqual(SENTINEL_RUN.attempts[0].findings);
    expect(arrived!.attempts[0].dryRun).toEqual(SENTINEL_RUN.attempts[0].dryRun);

    off();
  });

  it("says REFUSED when there was no model to ask, and still restates the question", async () => {
    // No provider at all. The refusal is not "the model could not write it" —
    // telling an author that when no model was ever selected sends them tuning
    // the wrong thing.
    provider = null;

    const off = await installBoth();
    askAiToEdit(ASK);
    await Promise.resolve();

    const state = aiEditStateFor(DOC);
    expect(state.phase).toBe("error");
    expect(state.run).toBeTruthy();
    expect(state.run!.outcome).toBe("refused");
    expect(state.run!.attempts).toEqual([]);
    expect(state.run!.elapsedMs).toBe(0);
    expect(state.run!.instruction).toBe(ASK.instruction);
    expect(state.run!.objectType).toBe(ASK.objectType);
    // Present on the PAYLOAD too, not only reconstructed locally: a replayed
    // refusal into a freshly opened window has no local state to fall back on.
    const payload = emitted.results[emitted.results.length - 1] as Record<string, unknown>;
    expect(payload.instruction).toBe(ASK.instruction);
    expect(payload.askedAgainst).toBe(ASK.currentSource);

    off();
  });

  it("normalises a provider that reports no run at all to null, never undefined", async () => {
    // A third-party assistant may run no repair loop. Absent must not cross the
    // wire as a silent `undefined` that a render then indexes into.
    let done: ((r: Record<string, unknown>) => void) | null = null;
    provider = {
      isConfigured: () => true,
      modelLabel: () => "x",
      startScriptEdit: (req: { onDone: (r: Record<string, unknown>) => void }) => {
        done = req.onDone;
        return "job-x";
      },
      cancelScriptEdit: () => {},
      showJob: () => {},
    };

    const off = await installBoth();
    askAiToEdit(ASK);
    await Promise.resolve();
    done!({ documentId: DOC, ok: true, source: "NEW", summary: "done" });
    await Promise.resolve();

    const payload = emitted.results[emitted.results.length - 1] as Record<string, unknown>;
    expect(payload).toHaveProperty("run");
    expect(payload.run).toBeNull();
    expect(aiEditStateFor(DOC).run).toBeNull();

    off();
  });
});
