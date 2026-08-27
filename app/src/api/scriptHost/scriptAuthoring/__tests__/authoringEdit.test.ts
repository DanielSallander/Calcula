//! FILENAME: app/src/api/scriptHost/scriptAuthoring/__tests__/authoringEdit.test.ts
// PURPOSE: EDIT mode — "here is a working script, change this about it" — and
//          the guarantee that adding it changed nothing about CREATE mode.
// CONTEXT: 2026-08-25. The owner asked for "Edit with AI" inside the Object
//          Script Editor, so the pipeline needs a second mode. The danger is not
//          that edit mode fails; it is that a model handed a working script
//          throws it away and writes a new one. Everything below is about that.

import { describe, it, expect, vi } from "vitest";
import { authorScript } from "../index";

const PLAN_ASSISTED = { tier: "assisted" as const, surfaceBudgetTokens: 3686, repairRounds: 6, rationale: "" };
const PLAN_STANDARD = { tier: "standard" as const, surfaceBudgetTokens: 4000, repairRounds: 3, rationale: "" };

const BASE = [
  "// @capability net.fetch https://example.com",
  "export function setup(context) {",
  "  context.onClick(async () => {",
  "    await context.api.setRangeFormat(0, 0, 2, 0, { backgroundColor: '#FFFF00' });",
  "  });",
  "}",
].join("\n");

const fenced = (src: string) => ["```javascript", src, "```"].join("\n");

function scripted(...replies: string[]) {
  let i = 0;
  return vi.fn(async () => replies[Math.min(i++, replies.length - 1)]);
}

/** The (system, user) pair of the n-th completion. */
function promptOf(complete: ReturnType<typeof scripted>, n = 0): { system: string; user: string } {
  const [system, user] = complete.mock.calls[n] as [string, string];
  return { system, user };
}

describe("CREATE mode is byte-identical to before edit mode existed", () => {
  // THE REGRESSION GUARD FOR THE WHOLE CHANGE. Edit mode is additive or it is a
  // rewrite of the path that already works.
  it("builds the same round-0 prompt when `edit` is absent", async () => {
    const complete = scripted(fenced(BASE));
    await authorScript({ intent: "colour the cells", objectType: "button", plan: PLAN_STANDARD, complete });
    const { user, system } = promptOf(complete);

    expect(user).toContain("# Calcula object-script API");
    expect(user).toContain('# Task (the script is attached to a "button")');
    expect(user).toContain("colour the cells");
    // The edit-only blocks must be entirely absent.
    expect(user).not.toContain("# The script as it is now");
    expect(user).not.toContain("edit the script above");
    expect(system).not.toContain("You are EDITING");
  });

  it("still appends the assisted template in CREATE mode", async () => {
    const complete = scripted(fenced(BASE));
    await authorScript({ intent: "x", objectType: "button", plan: PLAN_ASSISTED, complete });
    expect(promptOf(complete).system).toContain("Follow this shape exactly");
  });

  it("reports `unchanged` as undefined, not false", async () => {
    // A CREATE run has nothing to be unchanged FROM; `false` would imply it did.
    const complete = scripted(fenced(BASE));
    const r = await authorScript({ intent: "x", objectType: "button", plan: PLAN_STANDARD, complete });
    expect(r.unchanged).toBeUndefined();
  });

  it("never tells the model about the transcript that records it", async () => {
    // CHEAP, AND IT GUARDS A BUG CLASS RATHER THAN A LINE. A run is now recorded
    // — replies, prose, reasoning, timings — and the tempting next edit is
    // "while we're here, tell the model its reasoning is being kept." That is
    // teaching drift: the prompt would start describing the product's internals
    // instead of the API, and every draft would pay tokens for it. All three
    // system prompts are covered: BASE alone (standard), BASE + the assisted
    // template, and BASE + the edit contract.
    const forbidden = ["transcript", "history", "reasoning"];
    const probes: Array<[string, string]> = [];

    const std = scripted(fenced(BASE));
    await authorScript({ intent: "x", objectType: "button", plan: PLAN_STANDARD, complete: std });
    probes.push(["standard (BASE_SYSTEM alone)", promptOf(std).system]);

    const assisted = scripted(fenced(BASE));
    await authorScript({ intent: "x", objectType: "button", plan: PLAN_ASSISTED, complete: assisted });
    probes.push(["assisted (BASE_SYSTEM + template)", promptOf(assisted).system]);

    const edit = scripted(fenced(BASE));
    await authorScript({
      intent: "x", objectType: "button", plan: PLAN_STANDARD, complete: edit,
      edit: { baseSource: BASE },
    });
    probes.push(["edit (BASE_SYSTEM + EDIT_SYSTEM)", promptOf(edit).system]);

    for (const [label, system] of probes) {
      for (const word of forbidden) {
        expect(system.toLowerCase(), `${label} must not mention "${word}"`).not.toContain(word);
      }
    }
  });
});

describe("EDIT mode shows the model the script it is changing", () => {
  it("puts the current script BEFORE the task", async () => {
    // The instruction must be the last thing read — the same ordering the
    // repair block already uses by putting the fixes last.
    const complete = scripted(fenced(BASE));
    await authorScript({
      intent: "make it green instead", objectType: "button", plan: PLAN_STANDARD, complete,
      edit: { baseSource: BASE },
    });
    const { user } = promptOf(complete);
    expect(user).toContain("# The script as it is now");
    expect(user).toContain("context.api.setRangeFormat");
    expect(user.indexOf("# The script as it is now"))
      .toBeLessThan(user.indexOf("# Task (edit the script above"));
  });

  it("names the task as an EDIT, not a fresh authoring job", async () => {
    const complete = scripted(fenced(BASE));
    await authorScript({
      intent: "make it green", objectType: "sheet", plan: PLAN_STANDARD, complete,
      edit: { baseSource: BASE },
    });
    expect(promptOf(complete).user).toContain('# Task (edit the script above, which is attached to a "sheet")');
  });

  it("NEVER hands the model the blank worked template", async () => {
    // THE SINGLE MOST IMPORTANT ASSERTION HERE. `assistedSystemFor` says
    // "Follow this shape exactly, replacing only the body" over an EMPTY body.
    // Handed to a model beside the user's working script, that is an
    // instruction to delete it — and assisted is the DEFAULT tier for any
    // unprobed local model, so this is the common path, not an edge case.
    const complete = scripted(fenced(BASE));
    await authorScript({
      intent: "make it green", objectType: "button", plan: PLAN_ASSISTED, complete,
      edit: { baseSource: BASE },
    });
    const { system } = promptOf(complete);
    expect(system).not.toContain("Follow this shape exactly");
    expect(system).not.toContain("// your code here");
    expect(system, "the edit contract replaces it").toContain("You are EDITING");
  });

  it("tells the model the reply REPLACES the file", async () => {
    const complete = scripted(fenced(BASE));
    await authorScript({
      intent: "x", objectType: "button", plan: PLAN_STANDARD, complete, edit: { baseSource: BASE },
    });
    const { system } = promptOf(complete);
    // There is no patch applier in this pipeline: a diff-shaped reply fails L0.
    expect(system).toContain("Return the WHOLE script");
    expect(system).toContain("anything you leave out is deleted");
    expect(system).toContain("byte for byte");
    // Capability pragmas are the silent casualty of "tidying": an undeclared
    // capability is an error, but declared-and-unused is only a notice, so the
    // repair loop can report a stripped pragma but never prevent it.
    expect(system).toContain("// @capability");
  });

  it("keeps the base script in REPAIR rounds too", async () => {
    // Round 1 must not lose the thing it was told to preserve.
    const invented = fenced("export function setup(context) { context.api.nope(); }");
    const complete = scripted(invented, fenced(BASE));
    await authorScript({
      intent: "x", objectType: "button", plan: PLAN_STANDARD, complete, edit: { baseSource: BASE },
    });
    const repair = promptOf(complete, 1).user;
    expect(repair).toContain("# The script as it is now");
    expect(repair).toContain("# Your previous attempt");
    expect(repair).toContain("api.nope");
  });
});

describe("EDIT mode ranks the surface by what the script already uses", () => {
  it("keeps the members the script depends on in the API slice", async () => {
    // Without this a budget-trimmed surface can omit the very API the script
    // calls, and the model cannot see how to keep working code working.
    const complete = scripted(fenced(BASE));
    await authorScript({
      intent: "make it green", objectType: "button", plan: PLAN_STANDARD, complete,
      edit: { baseSource: BASE },
    });
    expect(promptOf(complete).user).toContain("api.setRangeFormat");
  });

  it("survives a base source that does not parse", async () => {
    // An unparseable base has no calls to preserve; the ranker falls back to
    // the intent rather than throwing.
    const complete = scripted(fenced(BASE));
    const r = await authorScript({
      intent: "fix the syntax error", objectType: "button", plan: PLAN_STANDARD, complete,
      edit: { baseSource: "export function setup(context) { this is not javascript" },
    });
    expect(r.ok).toBe(true);
  });

  it("leaves the surface room by charging the script against the budget", async () => {
    // A long script plus a full surface overruns a small window, and an overrun
    // truncates the surface at whatever byte the server stopped reading.
    const long = `${BASE}\n${"// filler comment line to make this script long\n".repeat(400)}`;
    const complete = scripted(fenced(BASE));
    await authorScript({
      intent: "x", objectType: "button", plan: { ...PLAN_STANDARD, surfaceBudgetTokens: 4000 },
      complete, edit: { baseSource: long },
    });
    const { user } = promptOf(complete);
    // Trimmed, but never to nothing: the floor keeps a usable reference.
    expect(user).toContain("# Calcula object-script API");
    expect(user.length).toBeGreaterThan(long.length);
  });
});

describe("an unchanged reply is reported, not repaired", () => {
  it("flags `unchanged` when the model returns the script as-is", async () => {
    const complete = scripted(fenced(BASE));
    const r = await authorScript({
      intent: "make sure it handles empty cells", objectType: "button", plan: PLAN_STANDARD,
      complete, edit: { baseSource: BASE },
    });
    expect(r.ok, "returning it unchanged is licensed, not a failure").toBe(true);
    expect(r.unchanged).toBe(true);
    expect(r.attempts, "and it must NOT burn a repair round").toHaveLength(1);
    expect(r.summary).toContain("unchanged");
  });

  it("ignores line-ending and trailing-whitespace churn", async () => {
    const complete = scripted(fenced(`${BASE.replace(/\n/g, "\r\n")}\n\n`));
    const r = await authorScript({
      intent: "x", objectType: "button", plan: PLAN_STANDARD, complete, edit: { baseSource: BASE },
    });
    expect(r.unchanged, "a round trip through a model adds these for free").toBe(true);
  });

  it("does NOT flag a real edit", async () => {
    const edited = BASE.replace("#FFFF00", "#00FF00");
    const complete = scripted(fenced(edited));
    const r = await authorScript({
      intent: "make it green", objectType: "button", plan: PLAN_STANDARD, complete,
      edit: { baseSource: BASE },
    });
    expect(r.unchanged).toBe(false);
    expect(r.source).toContain("#00FF00");
    expect(r.summary).toContain("Edited and validated");
  });

  it("reports the edit wording, not the drafting wording", async () => {
    const complete = scripted(fenced(BASE.replace("#FFFF00", "#00FF00")));
    const r = await authorScript({
      intent: "x", objectType: "button", plan: PLAN_STANDARD, complete, edit: { baseSource: BASE },
    });
    expect(r.summary).not.toContain("Drafted");
  });
});

describe("what an attempt records, against the REAL loop", () => {
  // DELIBERATELY NOT IN `authorRunner.test.ts`. That file mocks `authorScript`,
  // so a stall assertion there would be an assertion about the fixture the test
  // itself wrote. The stall, the timings and the out-of-fence prose are all
  // properties of THIS loop, so they are measured where the loop actually runs.
  const INVALID = "export function setup(context) { context.nopeNope(); }";

  it("stalls after the same errors repeat, and records three attempts", async () => {
    const complete = scripted(fenced(INVALID));
    const r = await authorScript({
      intent: "x", objectType: "button", plan: PLAN_ASSISTED, model: "m", complete,
    });
    expect(r.ok).toBe(false);
    expect(r.stalled).toBe(true);
    // STALLED_AFTER_REPEATS is 2, so: one attempt plus two identical repeats.
    // NOT the full seven that `PLAN_ASSISTED` would otherwise allow.
    expect(r.attempts).toHaveLength(3);
  });

  it("carries the model's out-of-fence prose, and per-attempt timings", async () => {
    // THE FIELD THE OWNER WENT LOOKING FOR. `extractScript` used to keep the
    // fence and drop every word around it, so the model's account of what it did
    // was destroyed at the moment it arrived.
    const reply = [
      "Here is what I changed and why.",
      fenced(BASE),
      "I left the capability pragma alone on purpose.",
    ].join("\n\n");
    const complete = scripted(reply);
    const r = await authorScript({
      intent: "x", objectType: "button", plan: PLAN_STANDARD, complete, edit: { baseSource: BASE },
    });
    const a = r.attempts[0];
    expect(a.note).toContain("Here is what I changed and why.");
    expect(a.note).toContain("I left the capability pragma alone on purpose.");
    expect(a.note, "the fence itself is the SOURCE, not the note").not.toContain("```");
    expect(a.reply, "the whole reply, verbatim").toBe(reply);
    expect(a.source).toContain("setRangeFormat");

    // Timings. `at` is measured from the RUN's start, so attempt 0 is at ~0 and
    // never negative; both are integers, because the wire types them as i64 and
    // serde_json refuses a float for an integer field.
    for (const at of r.attempts) {
      expect(at.at).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(at.at), "`at` must be an integer for the i64 wire field").toBe(true);
      expect(at.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(at.durationMs), "`durationMs` must be an integer too").toBe(true);
      expect(at.surfaceTokens).toBeGreaterThan(0);
      expect(typeof at.surfaceTruncated).toBe("boolean");
    }
  });

  it("records an empty note for a model that fences and says nothing else", async () => {
    // The common case must not fabricate prose out of stray whitespace.
    const complete = scripted(fenced(BASE));
    const r = await authorScript({
      intent: "x", objectType: "button", plan: PLAN_STANDARD, complete, edit: { baseSource: BASE },
    });
    expect(r.attempts[0].note).toBe("");
  });
});
