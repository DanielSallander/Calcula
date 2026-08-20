//! FILENAME: app/src/api/scriptHost/scriptAuthoring/__tests__/authoring.test.ts
// PURPOSE: Pin the repair loop and the tier plan, with the model faked so the
//          tests are deterministic and free.
// CONTEXT: M7. The two properties worth guarding hardest are that a rejected
//          draft is actually SENT BACK with its errors, and that running out of
//          rounds is reported as a failure rather than passed off as a result.

import { describe, it, expect, vi } from "vitest";
import { authorScript } from "../index";
import { planFor, probeModel, describeProfile, DEFAULT_CONTEXT_TOKENS, type ModelProfile } from "../../modelProfile";
import { CANARY_TASKS } from "../../generated/canaryTasks";

const GOOD = [
  "```javascript",
  "export function setup(context) {",
  "  context.expose('onClick', async () => {",
  "    await context.api.setCellValue(0, 0, 'hi');",
  "  });",
  "}",
  "```",
].join("\n");

const INVENTED = [
  "```javascript",
  "export function setup(context) {",
  "  context.expose('onClick', async () => {",
  "    await context.api.setCellValu(0, 0, 'hi');",
  "  });",
  "}",
  "```",
].join("\n");

const UNDECLARED = [
  "```javascript",
  "export function setup(context) {",
  "  context.expose('onClick', async () => {",
  "    await context.caps.fetch('https://example.com');",
  "  });",
  "}",
  "```",
].join("\n");

const NO_SETUP = "```javascript\nonClick(() => { context.log('x'); });\n```";

const PLAN = { tier: "standard" as const, surfaceBudgetTokens: 4000, repairRounds: 3, rationale: "" };

function scripted(...replies: string[]) {
  let i = 0;
  return vi.fn(async () => replies[Math.min(i++, replies.length - 1)]);
}

describe("the happy path", () => {
  it("returns on the first attempt when the draft validates", async () => {
    const complete = scripted(GOOD);
    const r = await authorScript({ intent: "put hi in A1", objectType: "button", plan: PLAN, complete });
    expect(r.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(r.attempts).toHaveLength(1);
    expect(r.summary).toMatch(/first attempt/);
  });

  it("shows the model the API surface and the task", async () => {
    const complete = scripted(GOOD);
    await authorScript({ intent: "put hi in A1", objectType: "button", plan: PLAN, complete });
    const [system, user] = complete.mock.calls[0];
    expect(system).toMatch(/setup\(context\)/);
    expect(system).toMatch(/only methods you were shown/);
    expect(user).toContain("# Calcula object-script API");
    expect(user).toContain("put hi in A1");
    expect(user).toContain('attached to a "button"');
  });
});

describe("the repair loop", () => {
  it("sends a rejected draft back WITH its errors and the previous attempt", async () => {
    const complete = scripted(INVENTED, GOOD);
    const r = await authorScript({ intent: "put hi in A1", objectType: "button", plan: PLAN, complete });
    expect(r.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);

    const repairPrompt = complete.mock.calls[1][1];
    expect(repairPrompt, "the model must see what it wrote").toContain("api.setCellValu");
    expect(repairPrompt, "and be told what was wrong").toMatch(/is not part of the object-script API/);
    expect(repairPrompt, "and be given the fix").toContain("api.setCellValue");
    expect(r.summary).toMatch(/after 1 correction/);
  });

  it("repairs a missing capability pragma", async () => {
    const complete = scripted(UNDECLARED, GOOD);
    const r = await authorScript({ intent: "download something", objectType: "button", plan: PLAN, complete });
    expect(r.ok).toBe(true);
    expect(complete.mock.calls[1][1]).toContain("// @capability net.fetch");
  });

  it("repairs a missing setup entry point", async () => {
    const complete = scripted(NO_SETUP, GOOD);
    const r = await authorScript({ intent: "log something", objectType: "button", plan: PLAN, complete });
    expect(r.ok).toBe(true);
    expect(complete.mock.calls[1][1]).toMatch(/defines no `setup` function/);
  });

  it("does NOT feed notices back to the model", async () => {
    // §11.2: a declared-but-unobserved capability is a NOTICE for the human
    // reviewer. Sending it to the model teaches it to strip declarations it
    // cannot prove it needs, which is exactly backwards.
    const overDeclared = "```javascript\n// @capability storage\n" +
      "export function setup(context) { context.log('x'); }\n```";
    const complete = scripted(overDeclared);
    const r = await authorScript({ intent: "log", objectType: "button", plan: PLAN, complete });
    expect(r.ok, "an over-declared script is VALID and must not loop").toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(r.report.findings.some((f) => f.code === "declared-not-observed")).toBe(true);
  });

  it("spends exactly repairRounds corrections after the first attempt", async () => {
    // Off-by-one here silently halves a weak tier's budget.
    const complete = scripted(INVENTED);
    await authorScript({
      intent: "x",
      objectType: "button",
      plan: { ...PLAN, repairRounds: 3 },
      complete,
    });
    expect(complete).toHaveBeenCalledTimes(4);
  });

  it("reports the attempts it made, in order", async () => {
    const complete = scripted(INVENTED, INVENTED, GOOD);
    const r = await authorScript({ intent: "x", objectType: "button", plan: PLAN, complete });
    expect(r.attempts.map((a) => a.round)).toEqual([0, 1, 2]);
    expect(r.attempts[0].report.ok).toBe(false);
    expect(r.attempts[2].report.ok).toBe(true);
  });
});

describe("L3 — the dry run turns a runtime failure into a repair round", () => {
  // The gap this closes, measured against two real local models: roughly HALF of
  // all failures were scripts the validator called `ok`. The loop stopped after
  // one round on every one of them, because "does it parse and call real
  // methods" was the only question it could ask.
  const dryOk = (totalChanges: number) => ({
    ok: true,
    error: null,
    durationMs: 3,
    changes: [],
    truncated: false,
    totalChanges,
    output: [],
  });
  const dryFailed = (error: string) => ({
    ok: false,
    error,
    durationMs: 1,
    changes: [],
    truncated: false,
    totalChanges: 0,
    output: [],
  });

  it("repairs a script that passes every static check but throws when run", () => {
    // GOOD is statically valid, so without L3 this returns on attempt 0.
    return (async () => {
      const complete = scripted(GOOD, GOOD);
      let call = 0;
      const dryRun = vi.fn(async () => (call++ === 0 ? dryFailed("TypeError: v.map is not a function") : dryOk(1)));
      const r = await authorScript({ intent: "x", objectType: "button", plan: PLAN, complete, dryRun });
      expect(r.ok).toBe(true);
      expect(complete).toHaveBeenCalledTimes(2);
      const repair = complete.mock.calls[1][1];
      expect(repair).toContain("FAILS when run against a copy of the workbook");
      expect(repair).toContain("TypeError: v.map is not a function");
    })();
  });

  it("repairs a script that runs cleanly and changes nothing, when writes were expected", async () => {
    const complete = scripted(GOOD, GOOD);
    let call = 0;
    const dryRun = vi.fn(async () => (call++ === 0 ? dryOk(0) : dryOk(1)));
    const r = await authorScript({
      intent: "put hi in A1",
      objectType: "button",
      plan: PLAN,
      complete,
      dryRun,
      expectsWrites: true,
    });
    expect(r.ok).toBe(true);
    expect(complete.mock.calls[1][1]).toContain("changes NOTHING");
  });

  it("accepts a no-op script when the task did not ask for writes", async () => {
    // A script that only reads and reports is a normal thing to ask for; marking
    // it wrong would make the loop refuse legitimate work.
    const complete = scripted(GOOD);
    const dryRun = vi.fn(async () => dryOk(0));
    const r = await authorScript({ intent: "log it", objectType: "button", plan: PLAN, complete, dryRun });
    expect(r.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does NOT dry-run a draft that already failed the static checks", async () => {
    // Executing a known-broken script wastes a run and produces a runtime error
    // that merely restates the static one — noise exactly when the model needs
    // one clear instruction.
    const complete = scripted(INVENTED, GOOD);
    const dryRun = vi.fn(async () => dryOk(1));
    await authorScript({ intent: "x", objectType: "button", plan: PLAN, complete, dryRun });
    expect(dryRun).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[1][1]).toContain("is not part of the object-script API");
  });

  it("records the dry run on the attempt it belongs to", async () => {
    const complete = scripted(GOOD);
    const dryRun = vi.fn(async () => dryOk(4));
    const r = await authorScript({ intent: "x", objectType: "button", plan: PLAN, complete, dryRun });
    expect(r.attempts[0].dryRun?.totalChanges).toBe(4);
  });

  it("behaves exactly as before when no dry run is supplied", async () => {
    // The offline eval runner has no live workbook; the loop must still work.
    const complete = scripted(GOOD);
    const r = await authorScript({ intent: "x", objectType: "button", plan: PLAN, complete });
    expect(r.ok).toBe(true);
    expect(r.attempts[0].dryRun).toBeUndefined();
  });

  it("reports a statically-valid script that never runs as such, not as 'still wrong: '", async () => {
    const complete = scripted(GOOD);
    const dryRun = vi.fn(async () => dryFailed("ReferenceError: foo is not defined"));
    const r = await authorScript({
      intent: "x",
      objectType: "button",
      plan: { ...PLAN, repairRounds: 1 },
      complete,
      dryRun,
    });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("passes every static check but fails when run");
    expect(r.summary).toContain("ReferenceError");
    expect(r.summary).not.toContain("Still wrong: .");
  });
});

describe("running out of rounds", () => {
  it("fails honestly instead of returning the last attempt as a success", async () => {
    const complete = scripted(INVENTED);
    const r = await authorScript({
      intent: "x",
      objectType: "button",
      plan: { ...PLAN, repairRounds: 1 },
      complete,
    });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/Could not produce a valid script in 2 attempts/);
    // The draft is still returned, so the user can see how far it got.
    expect(r.source).toContain("setCellValu");
    expect(r.summary).toContain("is not part of the object-script API");
  });
});

describe("the tier plan", () => {
  const profile = (canaryScore: number, contextTokens = DEFAULT_CONTEXT_TOKENS): ModelProfile => ({
    providerId: "ollama",
    model: "m",
    contextTokens,
    decodeTokensPerSec: 20,
    emitsFencedCode: true,
    canaryScore,
    tasksScored: 12,
    tasksTotal: 12,
    measuredAt: "2026-08-19T00:00:00.000Z",
  });

  it("spends MORE repair rounds on a weaker model, not fewer", () => {
    // Backwards only if you are paying per token. Locally a round is seconds.
    expect(planFor(profile(0.95)).repairRounds).toBeLessThan(planFor(profile(0.6)).repairRounds);
    expect(planFor(profile(0.6)).repairRounds).toBeLessThan(planFor(profile(0.2)).repairRounds);
  });

  it("names the three tiers by measurement, never by model name", () => {
    expect(planFor(profile(0.95)).tier).toBe("direct");
    expect(planFor(profile(0.6)).tier).toBe("standard");
    expect(planFor(profile(0.2)).tier).toBe("assisted");
  });

  it("scales the surface budget to the context window", () => {
    expect(planFor(profile(0.9, 32_000)).surfaceBudgetTokens).toBeGreaterThan(
      planFor(profile(0.9, 8_192)).surfaceBudgetTokens,
    );
    // Never zero, however small the window claims to be.
    expect(planFor(profile(0.9, 100)).surfaceBudgetTokens).toBeGreaterThanOrEqual(1000);
  });

  it("states a weak model's weakness in words the user will see", () => {
    // §10: degradation must be VISIBLE. A silent quality drop makes the user
    // blame the product rather than the model they chose.
    const text = describeProfile(profile(0.2));
    expect(text).toMatch(/struggles/);
    expect(text).toMatch(/20%/);
    expect(text).toMatch(/tokens\/sec/);
  });
});

describe("the probe", () => {
  it("scores every canary task and reports how many were attempted", async () => {
    let t = 0;
    const profile = await probeModel({
      providerId: "ollama",
      model: "m",
      complete: async () => GOOD,
      now: () => (t += 1000),
    });
    expect(profile.tasksTotal).toBe(CANARY_TASKS.length);
    expect(profile.tasksScored).toBe(CANARY_TASKS.length);
    expect(profile.canaryScore).toBeGreaterThan(0);
    expect(profile.emitsFencedCode).toBe(true);
  });

  it("does NOT count a transport failure as a model failure", async () => {
    // Recording a dropped connection as a zero quietly blames the model for a
    // laptop that went to sleep.
    let call = 0;
    const profile = await probeModel({
      providerId: "ollama",
      model: "m",
      complete: async () => {
        call++;
        if (call % 2 === 0) throw new Error("connection reset");
        return GOOD;
      },
      now: (() => { let t = 0; return () => (t += 1000); })(),
    });
    expect(profile.tasksScored).toBeLessThan(profile.tasksTotal);
    expect(profile.tasksScored).toBeGreaterThan(0);
    // The score is the mean over what was ACTUALLY scored.
    expect(profile.canaryScore).toBeGreaterThan(0);
  });

  it("reports a zero score rather than NaN when nothing completed", async () => {
    const profile = await probeModel({
      providerId: "x",
      model: "y",
      complete: async () => { throw new Error("down"); },
      now: (() => { let t = 0; return () => (t += 1000); })(),
    });
    expect(profile.canaryScore).toBe(0);
    expect(profile.tasksScored).toBe(0);
    expect(profile.decodeTokensPerSec).toBe(0);
    expect(Number.isNaN(profile.canaryScore)).toBe(false);
  });

  it("reports progress so a two-minute probe is not a frozen dialog", async () => {
    const seen: number[] = [];
    await probeModel({
      providerId: "x",
      model: "y",
      complete: async () => GOOD,
      now: (() => { let t = 0; return () => (t += 10); })(),
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual(CANARY_TASKS.map((_, i) => i + 1));
  });

  it("scores a model that answers with nonsense far below one that works", async () => {
    const clock = () => { let t = 0; return () => (t += 100); };
    const good = await probeModel({ providerId: "a", model: "b", complete: async () => GOOD, now: clock() });
    const bad = await probeModel({
      providerId: "a",
      model: "b",
      complete: async () => "```javascript\nExcel.run(ctx => ctx.sync());\n```",
      now: clock(),
    });
    expect(bad.canaryScore).toBeLessThan(good.canaryScore);
  });
});
