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

/**
 * The transcript client. Mocked because the real one calls `invoke` straight
 * through to Tauri, and because the CREATE run is persisted here — in the main
 * window, keyed by the DRAFT id the delivery just minted, which is what lets the
 * editor re-key it on Save without widening the editor seam by a single field.
 */
const appendScriptAuthoringRun = vi.fn(async () => {});
vi.mock("@api/objectScriptBackend", () => ({
  appendScriptAuthoringRun: (...a: unknown[]) => appendScriptAuthoringRun(...(a as [])),
}));

const authorScript = vi.fn();
const previewObjectScript = vi.fn();
vi.mock("@api/scriptHost/scriptAuthoring", () => ({ authorScript: (...a: unknown[]) => authorScript(...a) }));
vi.mock("@api/scriptHost/scriptPreview", () => ({ previewObjectScript: (...a: unknown[]) => previewObjectScript(...(a as [])) }));
vi.mock("@api/scriptHost/modelProfile", () => ({
  planFor: () => ({ tier: "assisted", surfaceBudgetTokens: 3686, repairRounds: 6, rationale: "unmeasured" }),
}));

const { runAuthor } = await import("../lib/authorRunner");
const { MAX_REASONING_CHARS } = await import("@api/scriptHost/authoringRun");

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
  appendScriptAuthoringRun.mockClear();
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

  it("records the CREATE run under the DRAFT id", async () => {
    // The draft id is the only identity this script has until someone saves it,
    // and both ids are in the editor's hand from the moment the draft arrives —
    // so keying here is what makes the editor's adopt-on-save possible without a
    // single new field on the wire.
    authorScript.mockResolvedValue(OK_RESULT);
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    const res = await runAuthor({ ...REQ });

    expect(appendScriptAuthoringRun).toHaveBeenCalledTimes(1);
    const [id, run] = appendScriptAuthoringRun.mock.calls[0] as unknown as [string, { kind: string; runId: string }];
    expect(id).toBe("draft-abc123");
    expect(run.kind).toBe("create");
    // The SAME record the caller got, not a second description of the same run.
    expect(run).toBe(res.run);
  });

  it("does not record an EDIT here — the editor writes that, on a decision", async () => {
    // The control. An edit belongs to a script that already exists, and nothing
    // is persisted about it until a human presses Accept or Reject.
    authorScript.mockResolvedValue(OK_RESULT);
    await runAuthor({ ...REQ, baseSource: "export function setup(c) {}" });
    expect(appendScriptAuthoringRun).not.toHaveBeenCalled();
  });

  it("delivers the draft even when the transcript write fails", async () => {
    // Fire-and-forget is load-bearing: an authoring run that SUCCEEDED must not
    // be reported as failed because a log write did not land.
    authorScript.mockResolvedValue(OK_RESULT);
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    appendScriptAuthoringRun.mockRejectedValueOnce(new Error("no workbook"));
    const res = await runAuthor({ ...REQ });
    expect(res.ok).toBe(true);
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
  // EVERY FINDING CARRIES ITS CODE, as of 2026-08-26: `notices` is what two
  // screens render, and both used to print the lot under "check what it
  // declares" — which became a lie the moment the ladder raised a notice about
  // something other than a declaration.
  const MIXED_REPORT = {
    ok: true,
    findings: [
      { severity: "notice", code: "declared-not-observed", message: "`net.fetch` is declared but no call requiring it was found." },
      { severity: "error", code: "unknown-member", message: "`context.nope` is not part of the object-script API" },
    ],
  };

  it("carries the notices and NOT the errors", async () => {
    // `onAttempt` WAS `(round, report)` and is now `(attempt)`. WIDENED, not
    // joined by a second callback: one callback that already did 90% of the job
    // is what the whole attempt now rides on. The two assertions below are
    // UNCHANGED, which is the proof that widening it changed no behaviour.
    authorScript.mockImplementation(async (r: { onAttempt: (a: unknown) => void }) => {
      r.onAttempt({
        round: 0,
        source: "export function setup(c) {}",
        report: MIXED_REPORT,
        reply: "```javascript\nexport function setup(c) {}\n```",
        note: "",
        at: 0,
        durationMs: 1,
        surfaceTokens: 100,
        surfaceTruncated: false,
      });
      return { ...OK_RESULT, report: MIXED_REPORT };
    });
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    const res = await runAuthor({ ...REQ });

    expect(res.notices).toEqual([
      { code: "declared-not-observed", message: "`net.fetch` is declared but no call requiring it was found." },
    ]);
    // The error went where errors go — the per-round problem list — and a
    // notice must never appear there, because that list feeds the repair.
    expect(res.rounds[0].problems).toEqual(["`context.nope` is not part of the object-script API"]);
  });

  it("carries them on the EDIT arm as well", async () => {
    authorScript.mockResolvedValue({ ...OK_RESULT, report: MIXED_REPORT, unchanged: false });
    const res = await runAuthor({ ...REQ, baseSource: "export function setup(c) {}" });
    expect(res.notices).toEqual([
      { code: "declared-not-observed", message: "`net.fetch` is declared but no call requiring it was found." },
    ]);
  });

  it("carries them on the FAILURE arm as well", async () => {
    authorScript.mockResolvedValue({ ...OK_RESULT, ok: false, report: MIXED_REPORT });
    const res = await runAuthor({ ...REQ });
    expect(res.notices).toEqual([
      { code: "declared-not-observed", message: "`net.fetch` is declared but no call requiring it was found." },
    ]);
  });

  it("carries them on the DELIVERY-FAILURE arm as well", async () => {
    authorScript.mockResolvedValue({ ...OK_RESULT, report: MIXED_REPORT });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_run_tool") throw new Error("Script Security refused");
      return { blocks: [], stopReason: "endTurn", model: "m" };
    });
    const res = await runAuthor({ ...REQ });
    expect(res.deliveryError).toContain("Script Security refused");
    expect(res.notices).toEqual([
      { code: "declared-not-observed", message: "`net.fetch` is declared but no call requiring it was found." },
    ]);
  });

  it("is an empty list when the report has none", async () => {
    authorScript.mockResolvedValue(OK_RESULT);
    const res = await runAuthor({ ...REQ });
    expect(res.notices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The NAME the draft carries
// ---------------------------------------------------------------------------

describe("the name that reaches the draft store", () => {
  // Reported 2026-08-26: "It prompts 'what should change in' and then the
  // beginning of my prompt is shown: 'create a script that formats the'."
  // `titleFor` took the first six words, so every AI draft was named after its
  // own request preamble.
  //
  // `./scriptName` is a SIBLING and is deliberately not mocked in this file, so
  // the real function runs and this measures the real name.
  const OWNER_PROMPT = "create a script that formats the background color of each selected cell";

  function draftInput(): Record<string, unknown> {
    const call = invoke.mock.calls.find((c) => c[0] === "ai_chat_run_tool");
    return (call![1] as { input: Record<string, unknown> }).input;
  }

  it("names the draft after the WORK, never after the request", async () => {
    authorScript.mockResolvedValue(OK_RESULT);
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    await runAuthor({ ...REQ, intent: OWNER_PROMPT });

    const input = draftInput();
    expect(input.name).toBe("Formats the background color of each selected...");
    expect(input.name as string).not.toContain("create a script");
  });

  it("still hands the draft store the FULL intent as its description", async () => {
    // The draft banner renders `description`, and truncating it there would lose
    // the only complete record of what was asked.
    authorScript.mockResolvedValue(OK_RESULT);
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    await runAuthor({ ...REQ, intent: OWNER_PROMPT });

    const input = draftInput();
    expect(input.description).toBe(OWNER_PROMPT);
    // snake_case because this is an MCP tool INPUT SCHEMA, not a serde struct.
    expect(input.object_type).toBe("button");
  });
});

// ---------------------------------------------------------------------------
// The RUN record — what the owner could not see
// ---------------------------------------------------------------------------

describe("the run record", () => {
  /** An attempt as `authorScript` now produces one. */
  const attempt = (over: Record<string, unknown> = {}) => ({
    round: 0,
    source: "export function setup(c) {}",
    report: { ok: true, findings: [] },
    reply: "```javascript\nexport function setup(c) {}\n```",
    note: "",
    thinking: "",
    at: 0,
    durationMs: 5,
    surfaceTokens: 1234,
    surfaceTruncated: false,
    ...over,
  });

  it("keeps the model's WHOLE reply, prose and all", async () => {
    // THE ANTI-DRIFT TEST, and the one that stops anyone "tidying" the recorder
    // back into a code archive. `extractScript` kept the fence and dropped every
    // word around it, which is why the author could see no reasoning anywhere.
    const reply = [
      "I looked at the sheet first.",
      "```javascript",
      "export function setup(c) {}",
      "```",
      "I left the capability line alone.",
    ].join("\n");
    authorScript.mockResolvedValue({
      ...OK_RESULT,
      attempts: [attempt({ reply, note: "I looked at the sheet first.\nI left the capability line alone." })],
    });
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    const res = await runAuthor({ ...REQ });

    expect(res.run.attempts).toHaveLength(1);
    expect(res.run.attempts[0].reply).toContain("I looked at the sheet first.");
    expect(res.run.attempts[0].reply).toContain("I left the capability line alone.");
    expect(res.run.attempts[0].replyChars).toBe(reply.length);
    expect(res.run.attempts[0].note).toContain("I left the capability line alone.");
  });

  it("records the reasoning deltas that were already on the wire", async () => {
    // `ReasoningDelta` is emitted by ai/stream.rs and typed in aiTypes.ts; the
    // listener's `event.type !== "textDelta"` early return discarded every one.
    const long = "why".repeat(2000); // 6,000 chars, well past MAX_REASONING_CHARS
    authorScript.mockImplementation(async (r: { complete: (s: string, u: string) => Promise<string> }) => {
      const p = r.complete("sys", "user");
      for (let i = 0; i < 4; i++) await Promise.resolve();
      const call = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").pop();
      const streamId = (call![1] as { streamId: string }).streamId;
      deltaSink!({ streamId, type: "reasoningDelta", text: long });
      await p;
      return { ...OK_RESULT, attempts: [attempt()] };
    });
    invoke.mockResolvedValue({ blocks: [{ type: "text", text: "```javascript\nexport function setup(c) {}\n```" }], stopReason: "endTurn", model: "m" });
    const res = await runAuthor({ ...REQ });

    const a = res.run.attempts[0];
    expect(a.reasoning.length, "the record is capped").toBeLessThanOrEqual(MAX_REASONING_CHARS);
    expect(a.reasoning.startsWith("why"), "head-kept, so the opening survives").toBe(true);
    expect(a.reasoning.length, "and it is not empty — the deltas DID arrive").toBeGreaterThan(100);
    expect(a.reasoningChars, "the TRUE length, so the elision is legible").toBe(long.length);
  });

  it("falls back to the INLINE scratchpad when no reasoning delta ever fired", async () => {
    // Ollama delivers deepseek-r1/qwen3 reasoning inline as <think>...</think>
    // in the TEXT — no ReasoningDelta fires for it. Before the fallback, an
    // inline reasoner's run record showed an empty reasoning column while its
    // actual thought process sat inside the reply.
    authorScript.mockResolvedValue({
      ...OK_RESULT,
      attempts: [attempt({ thinking: "maybe onSelectionChange... no, direct." })],
    });
    const res = await runAuthor({ ...REQ });
    const a = res.run.attempts[0];
    expect(a.reasoning).toBe("maybe onSelectionChange... no, direct.");
    expect(a.reasoningChars).toBe("maybe onSelectionChange... no, direct.".length);
  });

  it("prefers stream reasoning over the inline scratchpad when BOTH exist", async () => {
    // A server that splits reasoning out sends deltas AND may leave residue in
    // the text. The deltas are the authoritative channel; falling through to
    // the scratchpad would record the same thoughts twice under two shapes.
    authorScript.mockImplementation(async (r: { complete: (s: string, u: string) => Promise<string> }) => {
      const p = r.complete("sys", "user");
      for (let i = 0; i < 4; i++) await Promise.resolve();
      const call = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").pop();
      const streamId = (call![1] as { streamId: string }).streamId;
      deltaSink!({ streamId, type: "reasoningDelta", text: "streamed thought" });
      await p;
      return { ...OK_RESULT, attempts: [attempt({ thinking: "inline residue" })] };
    });
    invoke.mockResolvedValue({ blocks: [{ type: "text", text: "```javascript\nexport function setup(c) {}\n```" }], stopReason: "endTurn", model: "m" });
    const res = await runAuthor({ ...REQ });
    expect(res.run.attempts[0].reasoning).toBe("streamed thought");
  });

  it("maps ok/unchanged/stalled onto the outcome, with `ok` tested FIRST", async () => {
    // `authorScript` sets `unchanged` on its FAILURE return too, so an
    // unchanged-first ordering would headline an exhausted run as "a real
    // answer, not a failure".
    authorScript.mockResolvedValue({ ...OK_RESULT, unchanged: true, attempts: [attempt()] });
    expect((await runAuthor({ ...REQ, baseSource: "x" })).run.outcome).toBe("unchanged");

    authorScript.mockResolvedValue({ ...OK_RESULT, ok: false, stalled: true, attempts: [attempt()] });
    expect((await runAuthor({ ...REQ })).run.outcome).toBe("stalled");

    authorScript.mockResolvedValue({ ...OK_RESULT, ok: false, unchanged: true, attempts: [attempt()] });
    expect((await runAuthor({ ...REQ })).run.outcome).toBe("exhausted");

    authorScript.mockResolvedValue({ ...OK_RESULT, attempts: [attempt()] });
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    expect((await runAuthor({ ...REQ })).run.outcome).toBe("changed");
  });

  it("reports ALL FOUR errors of a round, not the first three", async () => {
    // The regression guard for the removed `.slice(0, 3)`: trimming at the
    // RECORDER meant the fourth error could never be recovered downstream.
    const four = [1, 2, 3, 4].map((n) => ({ severity: "error", code: "unknown-member", message: `problem ${n}` }));
    const badReport = { ok: false, findings: four };
    authorScript.mockImplementation(async (r: { onAttempt: (a: unknown) => void }) => {
      r.onAttempt(attempt({ report: badReport }));
      return { ...OK_RESULT, ok: false, report: badReport, attempts: [attempt({ report: badReport })] };
    });
    const res = await runAuthor({ ...REQ });
    expect(res.run.attempts[0].findings).toHaveLength(4);
    expect(res.rounds[0].problems, "the fourth error must survive the recorder").toEqual([
      "problem 1", "problem 2", "problem 3", "problem 4",
    ]);
  });

  it("carries every severity onto the record, notices included", async () => {
    const mixed = [
      { severity: "notice", code: "declared-not-observed", message: "`net.fetch` is declared but unused." },
      { severity: "error", code: "unknown-member", message: "`context.nope` is not part of the API" },
    ];
    authorScript.mockResolvedValue({
      ...OK_RESULT,
      report: { ok: true, findings: mixed },
      attempts: [attempt({ report: { ok: true, findings: mixed } })],
    });
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    const res = await runAuthor({ ...REQ });
    expect(res.run.attempts[0].findings.map((f) => f.severity)).toEqual(["notice", "error"]);
    expect(res.run.notices).toEqual(["`net.fetch` is declared but unused."]);
  });

  it("is present on EVERY return arm, including the failure one", async () => {
    previewObjectScript.mockResolvedValue(dry({ totalChanges: 0 }));
    authorScript.mockImplementation(async (r: { dryRun: (s: string) => Promise<unknown> }) => {
      await r.dryRun("x");
      return {
        ...OK_RESULT, ok: false, summary: "Gave up.",
        report: { ok: false, findings: [{ severity: "notice", code: "n", message: "a notice" }] },
        attempts: [attempt()],
      };
    });
    const res = await runAuthor({ ...REQ });
    expect(res.ok).toBe(false);
    expect(res.run.notices, "the failure arm must fill it too").toEqual(["a notice"]);
    expect(res.run.changedNothing).toBe(true);
    expect(res.run.kind).toBe("create");
    expect(res.run.model).toBe("qwen3.5:9b");
    expect(res.run.tier).toBe("assisted");
  });

  it("clamps a verbose run to the wire budget, and SAYS that it did", async () => {
    // A local model that reasons at length must not be able to wedge the channel.
    const attempts = Array.from({ length: 7 }, (_, i) =>
      attempt({ round: i, at: i * 1000, note: "n".repeat(5000), reply: "r".repeat(5000) }),
    );
    authorScript.mockResolvedValue({ ...OK_RESULT, attempts });
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    const res = await runAuthor({ ...REQ });

    const total = res.run.attempts.reduce(
      (n, a) => n + a.reply.length + a.note.length + a.reasoning.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(12_000);
    expect(res.run.elided, "an elision the reader cannot see reads as a bug").toBe(true);
    expect(res.run.attempts[0].replyChars, "the TRUE length survives the clamp").toBe(5000);
  });

  it("uses integers for every field the Rust wire types as an integer", async () => {
    // serde_json REFUSES a JSON float for an i64/u32 field: one
    // `performance.now()` in `buildRunRecord` and the whole append invoke fails
    // with "invalid type: floating point number".
    authorScript.mockResolvedValue({ ...OK_RESULT, attempts: [attempt()] });
    invoke.mockResolvedValue("Drafted (id=draft-abc123) for button.");
    const res = await runAuthor({ ...REQ });
    const ints: Array<[string, number]> = [
      ["elapsedMs", res.run.elapsedMs],
      ["surfaceTokens", res.run.surfaceTokens],
      ["attempt", res.run.attempts[0].attempt],
      ["at", res.run.attempts[0].at],
      ["durationMs", res.run.attempts[0].durationMs],
      ["replyChars", res.run.attempts[0].replyChars],
      ["reasoningChars", res.run.attempts[0].reasoningChars],
    ];
    for (const [name, value] of ints) {
      expect(Number.isInteger(value), `${name} must be an integer on the wire`).toBe(true);
      expect(value, `${name} must not be negative`).toBeGreaterThanOrEqual(0);
    }
    expect(res.run.startedAt, "ISO, so Rust can parse it as a string").toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
