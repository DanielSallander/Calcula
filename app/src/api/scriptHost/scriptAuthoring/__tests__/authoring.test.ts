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

// THE FIXTURE IS THE PRODUCTION SHAPE, and as of 2026-08-26 that includes a
// top-level zero-argument RUN TARGET.
//
// It is not decoration. `authorScript` now nudges a valid CREATE draft that has
// no run target back for one more round, so a setup-only fixture makes every
// test in this file spend an extra `complete` call for a reason none of them is
// about. Fixtures that do not look like what the loop is being asked to produce
// are how the assisted template drifted away from the production form in the
// first place.
const GOOD = [
  "```javascript",
  "async function run() {",
  "  await context.api.setCellValue(0, 0, 'hi');",
  "}",
  "export function setup(context) {",
  "  context.onClick(async () => {",
  "    await run();",
  "  });",
  "}",
  "```",
].join("\n");

const INVENTED = [
  "```javascript",
  "export function setup(context) {",
  "  context.onClick(async () => {",
  "    await context.api.setCellValu(0, 0, 'hi');",
  "  });",
  "}",
  "```",
].join("\n");

const UNDECLARED = [
  "```javascript",
  "export function setup(context) {",
  "  context.onClick(async () => {",
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
      "async function run() { context.log('x'); }\n" +
      "export function setup(context) { return run(); }\n```";
    const complete = scripted(overDeclared);
    const r = await authorScript({ intent: "log", objectType: "button", plan: PLAN, complete });
    expect(r.ok, "an over-declared script is VALID and must not loop").toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(r.report.findings.some((f) => f.code === "declared-not-observed")).toBe(true);
  });

  it("spends exactly repairRounds corrections after the first attempt", async () => {
    // Off-by-one here silently halves a weak tier's budget.
    //
    // Each round must invent a DIFFERENT member. Feeding one constant script
    // makes every round's error set identical, which is the stall case — the
    // loop would correctly cut it short and this test would be measuring stall
    // detection instead of the round budget it exists to guard.
    const wrong = (member: string) =>
      ["```javascript", `export function setup(context) { context.${member}(); }`, "```"].join("\n");
    const complete = scripted(wrong("nopeOne"), wrong("nopeTwo"), wrong("nopeThree"), wrong("nopeFour"));
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
  // The doubles carry the WHOLE report shape, including the fields the loop does
  // not read today. A double that is a subset of what production emits is a
  // second definition of the type, and it stops catching the day the loop starts
  // reading one of the missing fields.
  const dryOk = (totalChanges: number, unexercisedHooks: string[] = []) => ({
    ok: true,
    error: null,
    durationMs: 3,
    changes: [],
    truncated: false,
    totalChanges,
    output: [],
    readBack: [],
    unexercisedHooks,
    applicable: true,
    declinedReason: null,
  });
  const dryFailed = (error: string) => ({
    ok: false,
    error,
    durationMs: 1,
    changes: [],
    truncated: false,
    totalChanges: 0,
    output: [],
    readBack: [],
    unexercisedHooks: [],
    applicable: true,
    declinedReason: null,
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

  /**
   * THE UNEXERCISED-HOOK SUPPRESSION.
   *
   * "It changed nothing" is only evidence about the DRAFT when everything the
   * draft registered actually ran. When the handler holding the work was never
   * fired — the preview cannot synthesize the payload the product's forwarder
   * delivers — the same zero is evidence about the PREVIEW, and sending a
   * correct script back for repair on it is the founding failure mode of this
   * whole rung wearing a different hat: the model has nothing to fix, so it
   * rewrites working code until the rounds run out.
   */
  it("does NOT repair a script whose handler the preview never fired", async () => {
    const complete = scripted(GOOD, GOOD);
    const dryRun = vi.fn(async () => dryOk(0, ["onSelectionChange"]));
    const r = await authorScript({
      intent: "colour the selection",
      objectType: "button",
      plan: PLAN,
      complete,
      dryRun,
      expectsWrites: true,
    });
    expect(r.ok).toBe(true);
    expect(complete, "one round: there was nothing to correct").toHaveBeenCalledTimes(1);
  });

  it("still repairs the same zero when every handler DID run", async () => {
    // The control. Without it the suppression above could be passing because
    // the expectsWrites check stopped working altogether.
    const complete = scripted(GOOD, GOOD);
    let call = 0;
    const dryRun = vi.fn(async () => (call++ === 0 ? dryOk(0, []) : dryOk(1, [])));
    const r = await authorScript({
      intent: "put hi in A1",
      objectType: "button",
      plan: PLAN,
      complete,
      dryRun,
      expectsWrites: true,
    });
    expect(r.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][1]).toContain("changes NOTHING");
  });

  it("treats a report that omits the field as 'everything ran'", async () => {
    // `run-eval.mjs` and third-party providers hand-build this shape. The
    // suppression reads `?? 0`, so an absent list must repair exactly as an
    // empty one does — never suppress on a field nobody set.
    const complete = scripted(GOOD, GOOD);
    let call = 0;
    const legacy = (totalChanges: number) => ({
      ok: true,
      error: null,
      durationMs: 3,
      changes: [],
      truncated: false,
      totalChanges,
      output: [],
      readBack: [],
      applicable: true,
      declinedReason: null,
    });
    const dryRun = vi.fn(async () => (call++ === 0 ? legacy(0) : legacy(1)));
    const r = await authorScript({
      intent: "put hi in A1",
      objectType: "button",
      plan: PLAN,
      complete,
      dryRun,
      expectsWrites: true,
    });
    expect(r.ok).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
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

describe("the loop stops when it has stopped learning", () => {
  // MEASURED 2026-08-24, qwen2.5:7b, assisted tier, live Ollama, driving the
  // real loop: rounds 3, 4, 5 and 6 returned the BYTE-IDENTICAL error set
  // (`context.selection.getActiveRanges` is not part of the object-script API).
  // The model had settled into a Google Apps Script idiom and the same repair
  // text was never going to move it. Each of those rounds rewrote a whole script
  // and re-validated it — minutes of a CPU-bound user's life, buying nothing,
  // and reading to them as a hang.

  const PLAN = { tier: "assisted" as const, surfaceBudgetTokens: 3000, repairRounds: 6, rationale: "test" };
  const APPS_SCRIPT = "export function setup(context) {\n  context.onClick(() => { context.selection.getActiveRanges(); });\n}";

  it("gives up after the same errors repeat, instead of burning every round", async () => {
    let calls = 0;
    const res = await authorScript({
      intent: "colour the selected cells",
      objectType: "button",
      plan: PLAN,
      model: "qwen2.5:7b",
      complete: async () => { calls++; return "```javascript\n" + APPS_SCRIPT + "\n```"; },
    });

    expect(res.ok).toBe(false);
    expect(res.stalled).toBe(true);
    // 1 attempt + 2 identical repeats = 3. NOT the full 7.
    expect(calls, "the remaining rounds must be skipped").toBe(3);
    expect(res.attempts).toHaveLength(3);
  });

  it("names the model, so the user knows what to change", async () => {
    const res = await authorScript({
      intent: "colour the selected cells", objectType: "button", plan: PLAN, model: "qwen2.5:7b",
      complete: async () => "```javascript\n" + APPS_SCRIPT + "\n```",
    });
    expect(res.summary).toContain("qwen2.5:7b");
    expect(res.summary).toContain("same mistake");
    // And it still says what is actually wrong.
    expect(res.summary).toContain("getActiveRanges");
  });

  it("does NOT give up while the model is still making progress", async () => {
    // Different errors each round means the repair text IS landing.
    const bad = (member: string) =>
      "```javascript\nexport function setup(context) {\n  context.onClick(() => { context." + member + "(); });\n}\n```";
    const members = ["nopeOne", "nopeTwo", "nopeThree", "nopeFour", "nopeFive", "nopeSix", "nopeSeven"];
    let i = 0;
    const res = await authorScript({
      intent: "x", objectType: "button", plan: PLAN,
      complete: async () => bad(members[i++] ?? "nopeLast"),
    });
    expect(res.stalled).toBeFalsy();
    expect(res.attempts, "every round is spent when each one is different").toHaveLength(7);
  });

  it("tolerates one repetition before giving up", async () => {
    // A model that fixes one of two errors and reintroduces it is not stuck.
    const seq = ["alpha", "beta", "alpha", "gamma", "delta", "epsilon", "zeta"];
    let i = 0;
    const res = await authorScript({
      intent: "x", objectType: "button", plan: PLAN,
      complete: async () => {
        const m = seq[i++] ?? "omega";
        return "```javascript\nexport function setup(context) {\n  context.onClick(() => { context." + m + "(); });\n}\n```";
      },
    });
    expect(res.stalled).toBeFalsy();
  });

  it("a successful round is never mistaken for a stall", async () => {
    // errorSignature("") must not count as a repeat, or a run failing only its
    // BEHAVIOURAL check would stall out immediately.
    const good = "```javascript\nexport function setup(context) {\n  context.onClick(async () => { await context.api.setCellValue(0, 0, 'x'); });\n}\n```";
    let calls = 0;
    const res = await authorScript({
      intent: "write a cell", objectType: "button", plan: PLAN,
      complete: async () => { calls++; return good; },
      expectsWrites: true,
      // Valid every time, but reports no writes: the behavioural rung keeps
      // sending it back, and the error signature is empty on every round.
      dryRun: async () => ({
        ok: true, error: null, durationMs: 1, changes: [], truncated: false,
        totalChanges: 0, output: [], readBack: [], applicable: true, declinedReason: null,
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.stalled, "an empty error set is not a repeated error set").toBeFalsy();
    expect(calls).toBe(7);
  });
});

describe("the give-up message does not overclaim", () => {
  // Caught by running the real loop against a live Ollama on 2026-08-24: the
  // stall was detected on the FINAL round, and the summary still said "the
  // remaining corrections were skipped" when there were none remaining.
  const APPS_SCRIPT = "export function setup(context) {\n  context.onClick(() => { context.selection.getActiveRanges(); });\n}";
  const reply = "```javascript\n" + APPS_SCRIPT + "\n```";

  it("says how many rounds it actually saved", async () => {
    const res = await authorScript({
      intent: "x", objectType: "button", model: "m",
      plan: { tier: "assisted", surfaceBudgetTokens: 3000, repairRounds: 6, rationale: "" },
      complete: async () => reply,
    });
    // 1 attempt + 2 repeats = 3 used, so 4 of the 7 were skipped.
    expect(res.summary).toContain("remaining 4 corrections were skipped");
  });

  it("claims nothing was skipped when the stall lands on the last round", async () => {
    // repairRounds 2 => 3 attempts total, which is exactly the stall threshold.
    const res = await authorScript({
      intent: "x", objectType: "button", model: "m",
      plan: { tier: "assisted", surfaceBudgetTokens: 3000, repairRounds: 2, rationale: "" },
      complete: async () => reply,
    });
    expect(res.stalled).toBe(true);
    expect(res.summary).not.toContain("skipped");
    expect(res.summary).toContain("through all 3 attempts");
  });
});

describe("the assisted template matches the object it targets", () => {
  // Reported 2026-08-24 from a real run: a qwen3.5:9b draft passed every static
  // check and then failed the dry run with `context.onClick is not a function`,
  // because the target was not a button and the template had told it to call a
  // hook that object does not have. The assisted tier exists to narrow what a
  // weak model must invent, so a WRONG template is worse than none — the model
  // follows it exactly.
  const ASSISTED = { tier: "assisted" as const, surfaceBudgetTokens: 3000, repairRounds: 1, rationale: "" };

  async function systemFor(objectType: string): Promise<string> {
    const complete = scripted(GOOD);
    await authorScript({ intent: "x", objectType, plan: ASSISTED, complete });
    return complete.mock.calls[0][0] as string;
  }

  it("teaches a button its click hook", async () => {
    expect(await systemFor("button")).toContain("context.onClick(async () =>");
  });

  it("does NOT teach a workbook a click hook it does not have", async () => {
    const system = await systemFor("workbook");
    expect(system, "the exact failure reported").not.toContain("context.onClick(async () =>");
  });

  it("names the hooks the type actually has, or says it has none", async () => {
    // WAS `hooks[0]`, AND THAT ASSERTION PINNED THE DEFECT. Alphabetically first
    // is not "the hook a script for this object usually wants": for a workbook
    // it is `onAfterSave` and for a sheet `onActivate`, neither of which is
    // anybody's default. `preferredHookFor` is the product judgement, and the
    // live generated list stays the authority — so what is asserted here is that
    // whatever hook gets taught is one the object ACTUALLY HAS.
    const { objectHooksFor } = await import("../../scriptPreview/objectHooks");
    const { preferredHookFor } = await import("../../scriptTemplate");
    for (const type of ["button", "workbook", "sheet", "chart", "slicer", "textbox"]) {
      const system = await systemFor(type);
      const hooks = objectHooksFor(type);
      const taught = preferredHookFor(type);
      if (hooks.length === 0) {
        expect(system, `${type} has no hooks and must be told so`).toContain("no event hooks of its own");
      } else if (taught === null) {
        expect(system, `${type} is taught the direct shape`).toContain("setup() starts run() directly");
      } else {
        expect(hooks, `${type}'s preferred hook must be one it has`).toContain(taught);
        expect(system, `${type} should be taught ${taught}`).toContain(`context.${taught}(async () =>`);
      }
    }
  });

  it("still teaches a setup entry point whichever shape it picks", async () => {
    for (const type of ["button", "workbook"]) {
      expect(await systemFor(type)).toContain("export function setup(context)");
    }
  });

  it("leaves the non-assisted tiers alone", async () => {
    // The template is the assisted tier's narrowing; a capable model gets the
    // rules and writes its own shape.
    const complete = scripted(GOOD);
    await authorScript({ intent: "x", objectType: "workbook", plan: PLAN, complete });
    const system = complete.mock.calls[0][0] as string;
    expect(system).not.toContain("Follow this shape exactly");
    expect(system).not.toContain("no event hooks of its own");
  });

  it("carries the skeleton's exact bytes, and names no hook the type lacks", async () => {
    // ONE definition of the runnable shape. If the prompt paraphrases the
    // skeleton instead of embedding it, the teaching and the scaffold drift —
    // which is the bug class the whole `scriptTemplate` leaf exists to close.
    const { objectHooksFor } = await import("../../scriptPreview/objectHooks");
    const { buildRunnableSkeleton, preferredHookFor } = await import("../../scriptTemplate");
    const { OBJECT_TYPE_CONTEXTS } = await import("../../generated/scriptSurfacePolicy");

    for (const [type] of OBJECT_TYPE_CONTEXTS) {
      const system = await systemFor(type);
      const hooks = objectHooksFor(type);
      const preferred = preferredHookFor(type);
      const primary =
        preferred === null ? null : hooks.includes(preferred) ? preferred : hooks[0] ?? null;
      expect(system, `${type} must embed the skeleton verbatim`)
        .toContain(buildRunnableSkeleton({ objectType: type, primaryHook: primary }));

      // And it must never WIRE a hook this object does not have — the exact
      // failure reported on 2026-08-24 (`context.onClick is not a function`).
      // The wiring form, not the bare name: BASE_SYSTEM legitimately says "a
      // button's click handler is `context.onClick(handler)`" to every type, and
      // that is a rule about the API, not a template telling THIS object to call
      // a method it does not have.
      for (const other of ["onClick", "onEdit", "onRefresh", "onSelectionChange", "onDataChange"]) {
        if (hooks.includes(other)) continue;
        expect(system, `${type} has no ${other}`).not.toContain(`context.${other}(async () =>`);
      }
    }
  });

  it("degrades a renamed hook to a REAL hook, never to 'runs at mount'", async () => {
    // THE FAILURE DIRECTION. The table is a preference; `objectHooksFor` is the
    // authority. When the table names a hook the object no longer carries, the
    // template must fall back to one the object DOES carry — falling back to the
    // direct branch would silently turn a button's template into "runs at
    // mount", which is the very defect the run-target work exists to fix.
    const template = await import("../../scriptTemplate");
    const spy = vi.spyOn(template, "preferredHookFor").mockReturnValue("onHookThatWasRenamedAway");
    try {
      const { objectHooksFor } = await import("../../scriptPreview/objectHooks");
      const system = await systemFor("button");
      expect(objectHooksFor("button")).toContain("onClick");
      expect(system, "it must still wire a hook").toContain("context.onClick(async () =>");
      expect(system).not.toContain("setup() starts run() directly");
      expect(system).not.toContain("onHookThatWasRenamedAway");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the run target is taught at EVERY tier, not only the assisted one", () => {
  // THE INVERSION THE OWNER'S REPORT EXPOSED. `assistedSystemFor` is appended
  // only when `tier === "assisted"`, so teaching the entry point there alone
  // would leave every PROBED, CAPABLE model producing exactly the script the
  // owner could not run — the missing teaching would be in the tier for models
  // measured as GOOD.
  it.each([
    ["assisted", { tier: "assisted" as const, surfaceBudgetTokens: 3000, repairRounds: 6, rationale: "" }],
    ["standard", PLAN],
    ["direct", { tier: "direct" as const, surfaceBudgetTokens: 6000, repairRounds: 1, rationale: "" }],
  ])("%s", async (_label, plan) => {
    const complete = scripted(GOOD);
    await authorScript({ intent: "x", objectType: "button", plan, complete });
    const system = complete.mock.calls[0][0] as string;
    expect(system).toContain("TOP-LEVEL function that takes NO arguments");
    expect(system).toContain("async function run()");
    expect(system, "and WHY setup does not count").toContain("setup() is not a run target");
  });

  it("says the same thing in the API surface header the user prompt carries", async () => {
    // The surface header used to say the API is reachable "through the `context`
    // parameter of `export function setup(context)`" — which reads as a
    // PROHIBITION on the very shape the template now asks for.
    const complete = scripted(GOOD);
    await authorScript({ intent: "x", objectType: "button", plan: PLAN, complete });
    const user = complete.mock.calls[0][1] as string;
    expect(user).toContain("also in scope for");
    expect(user).toContain("every top-level function in the file");
  });
});

describe("the run-target nudge", () => {
  // Reported 2026-08-26: "again I could not run it due to it lacking some sort
  // of entry point function." A draft whose whole body sits inside setup() or a
  // handler mounts correctly and has NOTHING for Run (F5) to start.
  const HOOK_ONLY = [
    "```javascript",
    "export function setup(context) {",
    "  context.onClick(async () => {",
    "    await context.api.setCellValue(0, 0, 'hi');",
    "  });",
    "}",
    "```",
  ].join("\n");

  it("fires ONCE, and only in CREATE mode", async () => {
    const complete = scripted(HOOK_ONLY, HOOK_ONLY, HOOK_ONLY, HOOK_ONLY);
    const r = await authorScript({ intent: "x", objectType: "button", plan: PLAN, complete });
    expect(r.ok).toBe(true);
    // One nudge => exactly two calls, even though the second reply STILL has no
    // run target and repairRounds is 3.
    expect(complete).toHaveBeenCalledTimes(2);
    const nudges = complete.mock.calls.filter(
      (c) => typeof c[1] === "string" && (c[1] as string).includes("cannot press Run to start it"),
    );
    expect(nudges, "one shot: a pure refactor is not worth two rounds").toHaveLength(1);
  });

  it("does NOT nudge an EDIT, which was told to keep every other line", async () => {
    const complete = scripted(HOOK_ONLY);
    const r = await authorScript({
      intent: "x", objectType: "button", plan: PLAN, complete,
      edit: { baseSource: HOOK_ONLY.split("\n").slice(1, -1).join("\n") },
    });
    expect(r.ok).toBe(true);
    expect(complete, "asking for a refactor contradicts EDIT_SYSTEM").toHaveBeenCalledTimes(1);
  });

  it("never turns a VALID draft into a failure on the final round", async () => {
    // THE STRONG TIER HAS repairRounds === 1, so a nudge on the LAST round would
    // set behaviouralFix, skip the accept arm, run out of rounds and report
    // `ok: false` — "It passes every static check but does not do what was
    // asked" — about a script that is correct. Round 0 has to fail here, or the
    // nudge lands on round 0 and there is still a round left to spend.
    const complete = scripted(INVENTED, HOOK_ONLY);
    const r = await authorScript({
      intent: "x", objectType: "button", plan: { ...PLAN, repairRounds: 1 }, complete,
    });
    expect(r.ok, "a correct script must never be reported as a failure").toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][1] as string).not.toContain("cannot press Run to start it");
  });

  it("keeps the draft it set aside when the nudged reply comes back worse", async () => {
    // A COSMETIC REFACTOR REQUEST MUST NEVER COST A WORKING SCRIPT.
    const BROKEN = "```javascript\nexport function setup(context) { context.nopeNope(); }\n```";
    const complete = scripted(HOOK_ONLY, BROKEN, BROKEN, BROKEN);
    const r = await authorScript({ intent: "x", objectType: "button", plan: PLAN, complete });
    expect(r.ok).toBe(true);
    expect(r.source, "the valid draft wins").toContain("setCellValue");
    expect(r.source).not.toContain("nopeNope");
    expect(r.summary).toContain("discarded because it came back worse");
  });

  it("accepts the nudged reply when it IS better", async () => {
    // The control. Without it the set-aside path could be passing because the
    // nudge stopped happening at all.
    const complete = scripted(HOOK_ONLY, GOOD);
    const r = await authorScript({ intent: "x", objectType: "button", plan: PLAN, complete });
    expect(r.ok).toBe(true);
    expect(r.source).toContain("async function run()");
    expect(r.summary).not.toContain("came back worse");
  });
});
