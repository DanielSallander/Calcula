//! FILENAME: app/src/api/scriptHost/authoringRun/__tests__/editVerdict.test.ts
// PURPOSE: The two facts must stay two facts.
// CONTEXT: 2026-08-26, reported: "I saw the diff page (it looked nice), however
//          it did not change anything (maybe that was as it should be)."  The
//          parenthesis is the defect: a run that ENDED one way and a buffer that
//          MATCHES for an unrelated reason produced one indistinguishable
//          sentence, so the author could not tell a real answer from a failure.
//
//          THE DISTINCTNESS TEST IS THE GUARD FOR THE ACTUAL BUG. Asserting
//          each arm's wording one at a time would stay green if two arms were
//          quietly collapsed onto the same string; only comparing them all
//          against each other catches a re-collapse.

import { describe, it, expect } from "vitest";
import {
  editVerdict,
  outcomeOf,
  clampRun,
  elideMiddle,
  MAX_REPLY_CHARS,
  MAX_REASONING_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_RUN_CHARS,
  MAX_LOG_BYTES,
  MAX_DETAIL_CHARS,
  MAX_META_CHARS,
  MAX_ATTEMPTS_PER_RUN,
  MAX_NOTICES_PER_RUN,
  MAX_FINDINGS_PER_ATTEMPT,
  MAX_HOOKS_PER_RUN,
  type AuthoringRun,
  type RunAttempt,
  type RunOutcome,
} from "../index";

const OUTCOMES: RunOutcome[] = [
  "changed", "unchanged", "stalled", "exhausted", "failed", "cancelled", "refused",
];

function verdict(outcome: RunOutcome, identicalToBuffer: boolean, bufferMovedSinceAsk: boolean) {
  return editVerdict({
    outcome,
    identicalToBuffer,
    bufferMovedSinceAsk,
    model: "qwen2.5-coder:7b",
    attempts: 3,
    elapsedMs: 395_000,
  });
}

describe("editVerdict", () => {
  it("never says the same sentence about two different situations", () => {
    // ONE ROW PER SITUATION, not per raw combination: only the `unchanged` arm
    // reads `bufferMovedSinceAsk` at all, so sweeping the full 7x2x2 product
    // collects the SAME headline several times and a set-size assertion over it
    // is a tautology. These are the nine situations that say something.
    const SITUATIONS: ReadonlyArray<readonly [label: string, o: RunOutcome, ident: boolean, moved: boolean]> = [
      ["unchanged, you typed during the run", "unchanged", false, true],
      ["unchanged, a genuine no-op", "unchanged", true, false],
      ["unchanged, round-tripped whitespace", "unchanged", false, false],
      ["changed, but you already have it", "changed", true, false],
      ["stalled", "stalled", false, false],
      ["exhausted", "exhausted", false, false],
      ["refused", "refused", false, false],
      ["cancelled", "cancelled", false, false],
      ["failed", "failed", false, false],
    ];

    const seen = new Map<string, string>();
    for (const [label, o, ident, moved] of SITUATIONS) {
      const { headline } = verdict(o, ident, moved);
      expect(headline, `"${label}" says nothing at all`).not.toBe("");
      const clash = seen.get(headline);
      expect(
        clash,
        `"${label}" and "${clash}" show the identical sentence: ${JSON.stringify(headline)}`,
      ).toBeUndefined();
      seen.set(headline, label);
    }
    expect(seen.size).toBe(SITUATIONS.length);

    // And the combinations that deliberately say NOTHING stay silent.
    for (const moved of [true, false]) {
      expect(verdict("changed", false, moved).headline).toBe("");
    }
  });

  it("distinguishes the three `unchanged` situations by their reason", () => {
    // Round-tripped whitespace, a genuine no-op, and an author who typed during
    // a six-minute run are three different facts with three different
    // consequences for pressing Accept.
    const moved = verdict("unchanged", false, true);
    expect(moved.headline).toContain("edited this script since you asked");
    expect(moved.detail).toContain("REPLACE what you have typed");

    const noop = verdict("unchanged", true, false);
    expect(noop.headline).toContain("found nothing to change");
    expect(noop.detail).toContain("a real answer, not a failure");

    const reformatted = verdict("unchanged", false, false);
    expect(reformatted.headline).toContain("reformatted");
    expect(reformatted.detail).toContain("whitespace");

    expect(new Set([moved.headline, noop.headline, reformatted.headline]).size).toBe(3);
  });

  it("says NOTHING extra about an ordinary changed proposal", () => {
    // `headline: ""` means the caller's own "N lines differ" line stands. A
    // component that printed a headline unconditionally would make every one of
    // the assertions above meaningless.
    expect(verdict("changed", false, false)).toEqual({ headline: "", detail: "" });
    expect(verdict("changed", false, true)).toEqual({ headline: "", detail: "" });
    expect(verdict("changed", true, false).headline).toContain("already matches");
  });

  it("names the model, and falls back to 'The model' when there is no name", () => {
    expect(verdict("stalled", false, false).headline).toContain("qwen2.5-coder:7b");
    const anon = editVerdict({
      outcome: "stalled", identicalToBuffer: false, bufferMovedSinceAsk: false,
      model: "", attempts: 3, elapsedMs: 1,
    });
    expect(anon.headline).toContain("The model");
  });

  it("counts attempts in English on the exhausted arm", () => {
    const one = editVerdict({
      outcome: "exhausted", identicalToBuffer: false, bufferMovedSinceAsk: false,
      model: "m", attempts: 1, elapsedMs: 1,
    });
    expect(one.headline).toContain("in 1 attempt.");
    expect(verdict("exhausted", false, false).headline).toContain("in 3 attempts.");
  });

  it("promises nothing was written on every arm that wrote nothing", () => {
    for (const outcome of ["exhausted", "refused", "cancelled", "failed"] as RunOutcome[]) {
      expect(verdict(outcome, false, false).detail).toMatch(/[Nn]othing (has been |was )written/);
    }
  });
});

describe("outcomeOf", () => {
  it("tests `ok` BEFORE `unchanged`", () => {
    // NOT HYPOTHETICAL: `authorScript` sets `unchanged` on its FAILURE return
    // too, and `authorRunner` carries it onto the `!result.ok` arm. An
    // `unchanged`-first ordering headlines a run that exhausted every repair
    // round with "This is a real answer, not a failure."
    expect(outcomeOf({ ok: false, unchanged: true })).toBe("exhausted");
    expect(outcomeOf({ ok: false, unchanged: true, stalled: true })).toBe("stalled");
    expect(outcomeOf({ ok: false })).toBe("exhausted");
    expect(outcomeOf({ ok: true })).toBe("changed");
    expect(outcomeOf({ ok: true, unchanged: true })).toBe("unchanged");
    // The one that must never happen.
    expect(outcomeOf({ ok: false, unchanged: true })).not.toBe("unchanged");
  });
});

// ---------------------------------------------------------------------------

function attempt(over: Partial<RunAttempt> = {}): RunAttempt {
  return {
    attempt: 1, at: 0, durationMs: 1, ok: true,
    reply: "", replyChars: 0, note: "", reasoning: "", reasoningChars: 0,
    findings: [],
    ...over,
  };
}

function run(over: Partial<AuthoringRun> = {}): AuthoringRun {
  return {
    runId: "r1", kind: "edit", outcome: "changed",
    startedAt: "2026-08-26T10:00:00.000Z", elapsedMs: 1,
    instruction: "make it red", objectType: "button",
    providerId: "ollama", model: "m", tier: "restricted",
    surfaceTokens: 100, surfaceTruncated: false,
    summary: "ok", attempts: [attempt()], notices: [],
    changedNothing: false, unexercisedHooks: [],
    ...over,
  };
}

describe("clampRun", () => {
  it("leaves a run that EXACTLY fits every cap byte-identical and unmarked", () => {
    // The off-by-one guard. A `>=` anywhere marks an honest log `elided`, and a
    // marker that fires on honest logs means nothing.
    // `note` shares the REPLY cap, and reply+note+reasoning together must fit
    // the overall budget: 4000 + 4000 + 2000 = 10,000 <= 12,000.
    const exact = run({
      instruction: "i".repeat(MAX_INSTRUCTION_CHARS),
      attempts: [attempt({
        reply: "r".repeat(MAX_REPLY_CHARS),
        note: "n".repeat(MAX_REPLY_CHARS),
        reasoning: "x".repeat(MAX_REASONING_CHARS),
      })],
    });
    const out = clampRun(exact);
    expect(out.elided).toBeUndefined();
    expect(out).toBe(exact); // the SAME object, not a rebuilt equal one
    expect(out.instruction.length).toBe(MAX_INSTRUCTION_CHARS);
    expect(out.attempts[0].reply.length).toBe(MAX_REPLY_CHARS);
  });

  it("elides an over-long reply, marks it, and says how much went", () => {
    const out = clampRun(run({
      attempts: [attempt({ reply: "r".repeat(MAX_REPLY_CHARS + 1), replyChars: MAX_REPLY_CHARS + 1 })],
    }));
    expect(out.elided).toBe(true);
    expect(out.attempts[0].reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(out.attempts[0].reply).toContain("characters omitted");
    // The TRUE length survives, so the elision is legible as one.
    expect(out.attempts[0].replyChars).toBe(MAX_REPLY_CHARS + 1);
  });

  it("elides the instruction and the reasoning at their own caps", () => {
    const out = clampRun(run({
      instruction: "i".repeat(MAX_INSTRUCTION_CHARS + 1),
      attempts: [attempt({ reasoning: "x".repeat(MAX_REASONING_CHARS + 1) })],
    }));
    expect(out.elided).toBe(true);
    expect(out.instruction.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
    expect(out.attempts[0].reasoning.length).toBeLessThanOrEqual(MAX_REASONING_CHARS);
  });

  it("spends the overall budget in attempt order, so the TAIL gives ground", () => {
    // Seven attempts of 5,000-char notes is not a log, it is a copy. The EARLY
    // attempts are the ones a reader wants.
    const attempts = Array.from({ length: 7 }, (_, i) =>
      attempt({ attempt: i + 1, reply: `A${i}`.padEnd(3000, "r"), note: `N${i}`.padEnd(2000, "n") }));
    const out = clampRun(run({ attempts }));
    expect(out.elided).toBe(true);
    const total = out.attempts.reduce(
      (n, a) => n + a.reply.length + a.note.length + a.reasoning.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_RUN_CHARS);
    expect(out.attempts[0].reply.startsWith("A0")).toBe(true);
    expect(out.attempts[0].note.startsWith("N0")).toBe(true);
    expect(out.attempts[6].note).toBe("");
    // Every attempt is still THERE — a dropped attempt would hide a round.
    expect(out.attempts).toHaveLength(7);
  });

  // -------------------------------------------------------------------------
  // The clamp holes: every field, every vector. (2026-08-27)
  // -------------------------------------------------------------------------

  /** A run with EVERY string oversized and EVERY vector overlong. `fill` is a
   *  parameter so the ceiling test can use U+0001, the char JSON.stringify
   *  escapes to six bytes. */
  function hostileRun(fill: string): AuthoringRun {
    const big = (n: number) => fill.repeat(n);
    return run({
      runId: big(10_000),
      kind: big(10_000) as AuthoringRun["kind"],
      outcome: big(10_000) as RunOutcome,
      decision: big(10_000) as AuthoringRun["decision"],
      decidedAt: big(10_000),
      startedAt: big(10_000),
      instruction: big(100_000),
      objectType: big(10_000),
      providerId: big(10_000),
      model: big(10_000),
      tier: big(10_000),
      summary: big(3_000_000),
      attempts: Array.from({ length: MAX_ATTEMPTS_PER_RUN + 20 }, (_, i) =>
        attempt({
          attempt: i + 1,
          reply: big(100_000),
          note: big(100_000),
          reasoning: big(100_000),
          findings: Array.from({ length: MAX_FINDINGS_PER_ATTEMPT + 20 }, () => ({
            severity: big(10_000) as "error",
            code: big(10_000),
            message: big(10_000),
          })),
          dryRun: {
            applicable: true,
            ok: false,
            changedCells: 7,
            error: big(100_000),
            declinedReason: big(100_000),
          },
        })),
      notices: Array.from({ length: MAX_NOTICES_PER_RUN + 20 }, () => big(100_000)),
      unexercisedHooks: Array.from({ length: MAX_HOOKS_PER_RUN + 20 }, () => big(100_000)),
    });
  }

  it("caps EVERY field and bounds EVERY vector of a hostile run", () => {
    // The measured hole: only instruction/reply/note/reasoning were capped, so
    // one hostile append under a fresh draft-* id — accepted unconditionally,
    // and structurally exempt from the byte loop's eviction as a single-run
    // bucket — had no serialized ceiling and made INNOCENT scripts' history
    // pay for it on the Rust side.
    const out = clampRun(hostileRun("x"));
    expect(out.elided).toBe(true);

    for (const s of [out.runId, out.kind, out.outcome, out.decision!, out.decidedAt!,
      out.startedAt, out.objectType, out.providerId, out.model, out.tier]) {
      expect(s.length).toBeLessThanOrEqual(MAX_META_CHARS);
    }
    expect(out.instruction.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
    expect(out.summary.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);

    expect(out.attempts).toHaveLength(MAX_ATTEMPTS_PER_RUN);
    expect(out.attempts[0].attempt).toBe(1); // the EARLIEST attempts are kept
    expect(out.attempts[MAX_ATTEMPTS_PER_RUN - 1].attempt).toBe(MAX_ATTEMPTS_PER_RUN);
    expect(out.notices).toHaveLength(MAX_NOTICES_PER_RUN);
    expect(out.unexercisedHooks).toHaveLength(MAX_HOOKS_PER_RUN);

    for (const n of out.notices) expect(n.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
    for (const h of out.unexercisedHooks) expect(h.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
    for (const a of out.attempts) {
      expect(a.reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
      expect(a.note.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
      expect(a.reasoning.length).toBeLessThanOrEqual(MAX_REASONING_CHARS);
      expect(a.findings).toHaveLength(MAX_FINDINGS_PER_ATTEMPT);
      for (const f of a.findings) {
        expect(f.severity.length).toBeLessThanOrEqual(MAX_META_CHARS);
        expect(f.code.length).toBeLessThanOrEqual(MAX_META_CHARS);
        expect(f.message.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
      }
      expect(a.dryRun!.error!.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
      expect(a.dryRun!.declinedReason!.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
    }
  });

  it("makes the summary and the notices pay from the same budget as the attempts", () => {
    // 4,000 (summary at its cap) + 4 x 500 (notices at theirs) + 3,000 + 3,000
    // spends the 12,000 budget exactly, so the THIRD attempt's text arrives
    // with nothing left. A budget that skips the summary and the notices
    // leaves it 3,000 chars instead.
    const out = clampRun(run({
      summary: "s".repeat(MAX_REPLY_CHARS),
      notices: Array.from({ length: 4 }, () => "n".repeat(MAX_DETAIL_CHARS)),
      attempts: Array.from({ length: 3 }, (_, i) =>
        attempt({ attempt: i + 1, reply: "r".repeat(3000) })),
    }));
    expect(out.elided).toBe(true);
    expect(out.attempts[0].reply.length).toBe(3000);
    expect(out.attempts[1].reply.length).toBe(3000);
    expect(out.attempts[2].reply).toBe("");
    const total = out.summary.length
      + out.notices.reduce((n, s) => n + s.length, 0)
      + out.attempts.reduce((n, a) => n + a.reply.length + a.note.length + a.reasoning.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_RUN_CHARS);
  });

  it("returns the SAME object for a run at every NEW cap exactly", () => {
    // The identity contract extends to the new caps: summary, notices, hooks,
    // findings and metadata all exactly AT their caps must come back as the
    // same object, unmarked. (The prose budget: 4,000 summary + 4 x 500
    // notices + 4,000 reply + 2,000 reasoning = 12,000 exactly.)
    const exact = run({
      runId: "i".repeat(MAX_META_CHARS),
      model: "m".repeat(MAX_META_CHARS),
      summary: "s".repeat(MAX_REPLY_CHARS),
      notices: Array.from({ length: 4 }, () => "n".repeat(MAX_DETAIL_CHARS)),
      unexercisedHooks: Array.from({ length: MAX_HOOKS_PER_RUN }, () => "h".repeat(MAX_DETAIL_CHARS)),
      attempts: [attempt({
        reply: "r".repeat(MAX_REPLY_CHARS),
        reasoning: "x".repeat(MAX_REASONING_CHARS),
        findings: Array.from({ length: MAX_FINDINGS_PER_ATTEMPT }, () => ({
          severity: "notice" as const,
          code: "c".repeat(MAX_META_CHARS),
          message: "m".repeat(MAX_DETAIL_CHARS),
        })),
        dryRun: {
          applicable: true, ok: true, changedCells: 1,
          error: "e".repeat(MAX_DETAIL_CHARS),
          declinedReason: "d".repeat(MAX_DETAIL_CHARS),
        },
      })],
    });
    const out = clampRun(exact);
    expect(out.elided).toBeUndefined();
    expect(out).toBe(exact); // the SAME object, not a rebuilt equal one
  });

  it("gives one clamped run a serialized ceiling below MAX_LOG_BYTES even when every char escapes", () => {
    // U+0001 is what JSON.stringify turns into a six-byte backslash-u escape,
    // and a compromised renderer gets to pick its characters — so the per-run
    // ceiling is only real if it holds at six bytes per char. The Rust twin
    // measures the same shape against the pretty archive writer.
    const out = clampRun(hostileRun("\u0001"));
    const size = JSON.stringify(out).length;
    expect(size).toBeLessThan(MAX_LOG_BYTES);
  });
});

describe("elideMiddle", () => {
  it("returns a string that already fits untouched", () => {
    expect(elideMiddle("abc", 3)).toBe("abc");
    expect(elideMiddle("abcd", 3)).not.toBe("abcd");
  });

  it("keeps the head AND the tail, and says how much went", () => {
    const out = elideMiddle("H".repeat(500) + "T".repeat(500), 200);
    expect(out.startsWith("H")).toBe(true);
    expect(out.endsWith("T")).toBe(true);
    expect(out).toMatch(/\.\.\. \(\d+ characters omitted\) \.\.\./);
  });

  it("NEVER returns more than it was asked for, marker or no marker", () => {
    // The marker alone is ~35 characters. MEASURED 2026-08-26: without the
    // fallback, every `max` under that came back LONGER than the cap, and
    // `clampRun`'s budget loop calls this with `left = 0` — so a seven-attempt
    // record measured 12,135 against a 12,000 cap. A cap that does not cap is
    // not a defence against a verbose model wedging the channel.
    for (const max of [0, 1, 10, 34, 35, 39, 40, 60, 200, 2000]) {
      expect(elideMiddle("x".repeat(3000), max).length, `max=${max}`).toBeLessThanOrEqual(max);
    }
  });
});
