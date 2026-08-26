//! FILENAME: app/extensions/AIChat/__tests__/authorRunner.test.ts
// PURPOSE: The glue between the guided screen and the built pipeline — the part
//          that decides what the model is asked, what counts as a failure, and
//          what the user is shown while it takes six minutes.
// CONTEXT: 2026-08-25. Two things measured on a local qwen3.5:9b drove this
//          file: one attempt took 6m35s (so the completion is STREAMED, to prove
//          liveness), and a clean draft that changed 0 cells was sent back for a
//          repair round that then timed out (so `expectsWrites` is off, and the
//          observation is reported instead).

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("../lib/aiChatBackend", () => ({ aiChatBackend: { invoke: (...a: unknown[]) => invoke(...a) } }));

/** The stream listener the runner registers, so a test can push deltas. */
let deltaSink: ((e: unknown) => void) | null = null;
const unlisten = vi.fn();
vi.mock("@api", () => ({
  listenTauriEvent: async (_name: string, cb: (e: unknown) => void) => {
    deltaSink = cb;
    return unlisten;
  },
}));

vi.mock("../lib/probeRunner", () => ({ readProfile: () => null }));

const authorScript = vi.fn();
const previewObjectScript = vi.fn();
vi.mock("@api/scriptHost/scriptAuthoring", () => ({ authorScript: (...a: unknown[]) => authorScript(...a) }));
vi.mock("@api/scriptHost/scriptPreview", () => ({ previewObjectScript: (...a: unknown[]) => previewObjectScript(...(a as [])) }));
vi.mock("@api/scriptHost/modelProfile", () => ({
  planFor: () => ({ tier: "assisted", surfaceBudgetTokens: 3686, repairRounds: 6, rationale: "unmeasured" }),
}));

const { runAuthor } = await import("../lib/authorRunner");

const REQ = {
  intent: "colour each selected cell by its content",
  objectType: "button",
  providerId: "ollama",
  model: "qwen3.5:9b",
};

const OK_RESULT = { ok: true, source: "export function setup(c) {}", report: { ok: true, findings: [] }, attempts: [], summary: "Done." };

const dry = (over: Record<string, unknown> = {}) => ({
  ok: true, error: null, durationMs: 2, changes: [], truncated: false,
  totalChanges: 3, output: [], readBack: [], unexercisedHooks: [],
  applicable: true, declinedReason: null,
  ...over,
});

beforeEach(() => {
  invoke.mockReset();
  authorScript.mockReset();
  previewObjectScript.mockReset();
  unlisten.mockClear();
  deltaSink = null;
  previewObjectScript.mockResolvedValue(dry());
  invoke.mockResolvedValue({ blocks: [{ type: "text", text: "```javascript\nexport function setup(c) {}\n```" }], stopReason: "endTurn", model: "m" });
});

describe("the completion is streamed, so a six-minute wait proves it is alive", () => {
  it("uses the STREAMING command and correlates by stream id", async () => {
    authorScript.mockImplementation(async (r: { complete: (s: string, u: string) => Promise<string> }) => {
      await r.complete("sys", "user");
      return OK_RESULT;
    });
    await runAuthor({ ...REQ });

    const call = invoke.mock.calls.find((c) => c[0] === "ai_chat_complete_stream");
    expect(call, "non-streaming gives one line then six minutes of nothing").toBeTruthy();
    expect(typeof (call![1] as { streamId: string }).streamId).toBe("string");
    // Deterministic code generation; the repair loop is the recovery mechanism.
    expect((call![1] as { request: { temperature: number } }).request.temperature).toBe(0);
  });

  it("reports a growing line count while the model writes", async () => {
    const live: string[] = [];
    authorScript.mockImplementation(async (r: { complete: (s: string, u: string) => Promise<string> }) => {
      const p = r.complete("sys", "user");
      // The listener registration is awaited inside `complete`, so the stream
      // id does not exist until a few microtasks have run. Pushing a delta
      // before that reads a call that has not happened yet.
      await tick();
      deltaSink!({ streamId: lastStreamId(), type: "textDelta", text: "line one\nline two\n" });
      await p;
      return OK_RESULT;
    });
    await runAuthor({ ...REQ, onLiveProgress: (t) => live.push(t) });
    expect(live.length).toBeGreaterThan(0);
    expect(live[0]).toContain("qwen3.5:9b is writing");
    expect(live[0]).toContain("lines so far");
  });

  it("ignores deltas belonging to another stream", async () => {
    const live: string[] = [];
    authorScript.mockImplementation(async (r: { complete: (s: string, u: string) => Promise<string> }) => {
      const p = r.complete("sys", "user");
      await tick();
      // Four lines from somewhere else, then ONE from this stream. Asserting
      // only that the foreign delta is ignored would pass just as well if the
      // listener were broken outright, so a matching delta has to land too.
      deltaSink!({ streamId: "someone-elses-turn", type: "textDelta", text: "a\nb\nc\nd\n" });
      deltaSink!({ streamId: lastStreamId(), type: "textDelta", text: "mine\n" });
      await p;
      return OK_RESULT;
    });
    await runAuthor({ ...REQ, onLiveProgress: (t) => live.push(t) });
    expect(live, "the matching delta must still be counted").toHaveLength(1);
    expect(live[0], "and only it — 2 lines, not 6").toContain("2 lines so far");
  });

  it("unregisters the listener even when the attempt throws", async () => {
    authorScript.mockImplementation(async (r: { complete: (s: string, u: string) => Promise<string> }) => {
      invoke.mockRejectedValueOnce(new Error("boom"));
      await expect(r.complete("sys", "user")).rejects.toThrow("boom");
      return OK_RESULT;
    });
    await runAuthor({ ...REQ });
    expect(unlisten, "a leaked listener keeps counting a dead stream").toHaveBeenCalled();
  });

  /** Let the runner get as far as registering its listener and invoking. */
  async function tick(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }

  function lastStreamId(): string {
    const call = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").pop();
    return (call![1] as { streamId: string }).streamId;
  }
});

describe("'changed nothing' is reported, not acted on", () => {
  // THE ten-minute bug. A clean draft that changed 0 cells was sent back for a
  // repair round that timed out. `AuthorRequest` says this is the caller's
  // judgement and warns about exactly this case; the guided path cannot judge
  // it, because the preview runs against whatever workbook is open.
  it("does NOT ask the pipeline to treat zero changes as a failure", async () => {
    authorScript.mockResolvedValue(OK_RESULT);
    await runAuthor({ ...REQ });
    expect((authorScript.mock.calls[0][0] as { expectsWrites: boolean }).expectsWrites).toBe(false);
  });

  it("flags it on the result instead", async () => {
    previewObjectScript.mockResolvedValue(dry({ totalChanges: 0 }));
    authorScript.mockImplementation(async (r: { dryRun: (s: string) => Promise<unknown> }) => {
      await r.dryRun("export function setup(c) {}");
      return OK_RESULT;
    });
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    const res = await runAuthor({ ...REQ });
    expect(res.changedNothing).toBe(true);
  });

  it("does not flag a run that DID change cells", async () => {
    authorScript.mockImplementation(async (r: { dryRun: (s: string) => Promise<unknown> }) => {
      await r.dryRun("x");
      return OK_RESULT;
    });
    const res = await runAuthor({ ...REQ });
    expect(res.changedNothing).toBe(false);
  });

  it("does not flag a preview that could not judge the script", async () => {
    // `applicable: false` means the report describes the PREVIEW, not the draft.
    previewObjectScript.mockResolvedValue(dry({ totalChanges: 0, applicable: false, declinedReason: "no realm" }));
    authorScript.mockImplementation(async (r: { dryRun: (s: string) => Promise<unknown> }) => {
      await r.dryRun("x");
      return OK_RESULT;
    });
    const res = await runAuthor({ ...REQ });
    expect(res.changedNothing, "a declined preview is not evidence").toBe(false);
  });

  it("does not flag a run where no preview happened at all", async () => {
    authorScript.mockResolvedValue(OK_RESULT);
    const res = await runAuthor({ ...REQ });
    expect(res.changedNothing).toBe(false);
  });
});

describe("the phases a user actually sees", () => {
  it("names the model, the attempt and the step", async () => {
    const phases: string[] = [];
    authorScript.mockImplementation(async (r: { complete: (s: string, u: string) => Promise<string>; dryRun: (s: string) => Promise<unknown> }) => {
      await r.complete("sys", "user");
      await r.dryRun("x");
      return OK_RESULT;
    });
    await runAuthor({ ...REQ, onPhase: (p) => phases.push(p) });

    expect(phases[0]).toBe("Loading Calcula's script API");
    expect(phases.some((p) => p.includes("Plan: assisted"))).toBe(true);
    expect(phases.some((p) => p === "Writing the script with qwen3.5:9b (attempt 1 of 7)")).toBe(true);
    expect(phases.some((p) => p.includes("replied ("))).toBe(true);
    expect(phases.some((p) => p === "Checking it against Calcula's API")).toBe(true);
    expect(phases.some((p) => p === "Running it against a copy of your workbook")).toBe(true);
    expect(phases.some((p) => p.includes("changing 3 cells"))).toBe(true);
  });

  it("previews at the tier a draft actually mounts at", async () => {
    authorScript.mockImplementation(async (r: { dryRun: (s: string) => Promise<unknown> }) => {
      await r.dryRun("x");
      return OK_RESULT;
    });
    await runAuthor({ ...REQ });
    expect(previewObjectScript.mock.calls[0][0]).toMatchObject({ tier: "restricted", objectType: "button" });
  });

  it("stops before calling the model when cancelled", async () => {
    authorScript.mockImplementation(async (r: { complete: (s: string, u: string) => Promise<string> }) => {
      await expect(r.complete("sys", "user")).rejects.toThrow("cancelled");
      return OK_RESULT;
    });
    await runAuthor({ ...REQ, isCancelled: () => true });
    expect(invoke.mock.calls.some((c) => c[0] === "ai_chat_complete_stream")).toBe(false);
  });
});

describe("EDIT mode", () => {
  // 2026-08-25: the owner asked for "Edit with AI" inside the Object Script
  // Editor. An edit runs the same pipeline but must NOT end in the draft queue.

  it("passes the on-screen source into the pipeline as an edit basis", async () => {
    authorScript.mockResolvedValue({ ...OK_RESULT, unchanged: false });
    await runAuthor({ ...REQ, baseSource: "export function setup(c) { c.log('hi'); }" });
    const call = authorScript.mock.calls[0][0] as { edit?: { baseSource: string } };
    expect(call.edit?.baseSource).toBe("export function setup(c) { c.log('hi'); }");
  });

  it("does NOT set an edit basis when creating", async () => {
    authorScript.mockResolvedValue(OK_RESULT);
    await runAuthor({ ...REQ });
    expect((authorScript.mock.calls[0][0] as { edit?: unknown }).edit).toBeUndefined();
  });

  it("NEVER queues an edit as a draft", async () => {
    // draft_object_script mints a NEW id; saving that would APPEND a second
    // script instead of updating the one the user is editing.
    authorScript.mockResolvedValue({ ...OK_RESULT, unchanged: false });
    const res = await runAuthor({ ...REQ, baseSource: "export function setup(c) {}" });
    expect(res.ok).toBe(true);
    expect(
      invoke.mock.calls.some((c) => c[0] === "ai_chat_run_tool"),
      "an edit belongs to a script that already exists",
    ).toBe(false);
    expect(res.draftId).toBeUndefined();
  });

  it("still queues a CREATE as a draft", async () => {
    // The control: without it the assertion above passes for a broken runner.
    authorScript.mockResolvedValue(OK_RESULT);
    invoke.mockResolvedValue('Drafted (id=draft-abc123) for button.');
    const res = await runAuthor({ ...REQ });
    expect(invoke.mock.calls.some((c) => c[0] === "ai_chat_run_tool")).toBe(true);
    expect(res.draftId).toBe("draft-abc123");
  });

  it("carries `unchanged` through to the caller", async () => {
    authorScript.mockResolvedValue({ ...OK_RESULT, unchanged: true });
    const res = await runAuthor({ ...REQ, baseSource: "export function setup(c) {}" });
    expect(res.unchanged, "the model judging no change is worth saying").toBe(true);
  });

  it("returns the best attempt when an edit fails", async () => {
    authorScript.mockResolvedValue({
      ok: false, source: "half edited", report: { ok: false, findings: [] },
      attempts: [], summary: "Gave up.", unchanged: false,
    });
    const res = await runAuthor({ ...REQ, baseSource: "export function setup(c) {}" });
    expect(res.ok).toBe(false);
    expect(res.source).toBe("half edited");
    expect(invoke.mock.calls.some((c) => c[0] === "ai_chat_run_tool")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T15 — the two fields the result grew, on every arm that can return
// ---------------------------------------------------------------------------

describe("what the preview could not exercise reaches the result", () => {
  // `totalChanges === 0` is a statement about the SCRIPT only when everything it
  // registered actually ran. When the handler holding the work was never fired,
  // the same zero is a statement about the PREVIEW — and the screen used to
  // blame the user's data for it in both cases.

  /** A run whose preview reported one unfired handler. */
  function previewedWithUnfiredHook(): void {
    previewObjectScript.mockResolvedValue(
      dry({ totalChanges: 0, unexercisedHooks: ["onSelectionChange"] }),
    );
    authorScript.mockImplementation(async (r: { dryRun: (s: string) => Promise<unknown> }) => {
      await r.dryRun("export function setup(c) {}");
      return OK_RESULT;
    });
  }

  it("carries it on the DELIVERED-DRAFT arm", async () => {
    previewedWithUnfiredHook();
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    const res = await runAuthor({ ...REQ });
    expect(res.draftId, "this is the delivered arm, not another one").toBe("draft-abc123");
    expect(res.unexercisedHooks).toEqual(["onSelectionChange"]);
  });

  it("carries it on the FAILURE arm", async () => {
    previewObjectScript.mockResolvedValue(
      dry({ totalChanges: 0, unexercisedHooks: ["onSelectionChange"] }),
    );
    authorScript.mockImplementation(async (r: { dryRun: (s: string) => Promise<unknown> }) => {
      await r.dryRun("x");
      return { ...OK_RESULT, ok: false, summary: "Gave up." };
    });
    const res = await runAuthor({ ...REQ });
    expect(res.ok).toBe(false);
    expect(res.unexercisedHooks).toEqual(["onSelectionChange"]);
  });

  it("carries it on the EDIT arm", async () => {
    previewedWithUnfiredHook();
    const res = await runAuthor({ ...REQ, baseSource: "export function setup(c) {}" });
    expect(res.draftId, "an edit is never queued").toBeUndefined();
    expect(res.unexercisedHooks).toEqual(["onSelectionChange"]);
  });

  it("carries it on the DELIVERY-FAILURE arm", async () => {
    previewedWithUnfiredHook();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_run_tool") throw new Error("Script Security refused");
      return { blocks: [], stopReason: "endTurn", model: "m" };
    });
    const res = await runAuthor({ ...REQ });
    expect(res.deliveryError).toContain("Script Security refused");
    expect(res.unexercisedHooks).toEqual(["onSelectionChange"]);
  });

  it("is EMPTY when the preview declined — a declined report is not evidence", async () => {
    previewObjectScript.mockResolvedValue(
      dry({ applicable: false, declinedReason: "no realm", unexercisedHooks: ["onSelectionChange"] }),
    );
    authorScript.mockImplementation(async (r: { dryRun: (s: string) => Promise<unknown> }) => {
      await r.dryRun("x");
      return OK_RESULT;
    });
    const res = await runAuthor({ ...REQ });
    expect(res.unexercisedHooks).toEqual([]);
  });

  it("is EMPTY when a preview omits the field entirely", async () => {
    // A third-party provider, or a hand-built double, may not carry it. The
    // contract promises an array either way.
    const { unexercisedHooks: _drop, ...withoutField } = dry({ totalChanges: 0 });
    previewObjectScript.mockResolvedValue(withoutField);
    authorScript.mockImplementation(async (r: { dryRun: (s: string) => Promise<unknown> }) => {
      await r.dryRun("x");
      return OK_RESULT;
    });
    const res = await runAuthor({ ...REQ });
    expect(res.unexercisedHooks).toEqual([]);
  });

  it("names the handler in the phase log, where the user is watching", async () => {
    const details: Array<string | undefined> = [];
    previewedWithUnfiredHook();
    await runAuthor({ ...REQ, onPhase: (_p, d) => details.push(d) });
    expect(details.some((d) => d?.includes("onSelectionChange"))).toBe(true);
    expect(details.some((d) => d?.includes("never fired"))).toBe(true);
  });
});

describe("the ladder's notices reach the result too", () => {
  const MIXED_REPORT = {
    ok: true,
    findings: [
      { severity: "notice", message: "`net.fetch` is declared but no call requiring it was found." },
      { severity: "error", message: "`context.nope` is not part of the object-script API" },
    ],
  };

  it("carries the notices and NOT the errors", async () => {
    authorScript.mockImplementation(async (r: { onAttempt: (n: number, rep: unknown) => void }) => {
      r.onAttempt(0, MIXED_REPORT);
      return { ...OK_RESULT, report: MIXED_REPORT };
    });
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    const res = await runAuthor({ ...REQ });

    expect(res.notices).toEqual(["`net.fetch` is declared but no call requiring it was found."]);
    // The error went where errors go — the per-round problem list — and a
    // notice must never appear there, because that list feeds the repair.
    expect(res.rounds[0].problems).toEqual(["`context.nope` is not part of the object-script API"]);
  });

  it("carries them on the EDIT arm as well", async () => {
    authorScript.mockResolvedValue({ ...OK_RESULT, report: MIXED_REPORT, unchanged: false });
    const res = await runAuthor({ ...REQ, baseSource: "export function setup(c) {}" });
    expect(res.notices).toEqual(["`net.fetch` is declared but no call requiring it was found."]);
  });

  it("carries them on the FAILURE arm as well", async () => {
    authorScript.mockResolvedValue({ ...OK_RESULT, ok: false, report: MIXED_REPORT });
    const res = await runAuthor({ ...REQ });
    expect(res.notices).toEqual(["`net.fetch` is declared but no call requiring it was found."]);
  });

  it("carries them on the DELIVERY-FAILURE arm as well", async () => {
    authorScript.mockResolvedValue({ ...OK_RESULT, report: MIXED_REPORT });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_run_tool") throw new Error("Script Security refused");
      return { blocks: [], stopReason: "endTurn", model: "m" };
    });
    const res = await runAuthor({ ...REQ });
    expect(res.deliveryError).toContain("Script Security refused");
    expect(res.notices).toEqual(["`net.fetch` is declared but no call requiring it was found."]);
  });

  it("is an empty list when the report has none", async () => {
    authorScript.mockResolvedValue(OK_RESULT);
    const res = await runAuthor({ ...REQ });
    expect(res.notices).toEqual([]);
  });
});
