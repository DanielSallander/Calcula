//! FILENAME: app/src/api/scriptHost/scriptAuthoring/index.ts
// PURPOSE: Author one object script: build the prompt, generate, validate, and
//          send failures back for repair until it passes or the rounds run out.
// CONTEXT: docs/design/local-model-script-authoring.md M7. This is where M2 (the
//          validator), M4 (the budget-aware surface) and M7 (the tier plan) stop
//          being separate pieces and become the feature.
//
//          THE REPAIR LOOP IS THE WHOLE ARGUMENT FOR LOCAL MODELS (§1a). Cloud
//          tools do not run six repair rounds because six rounds cost six times
//          the money. Local inference costs electricity and wall-clock, so the
//          iterations can be spent exactly where a weak model needs them — which
//          is why a modest machine can produce a usable script at all.
//
//          IT NEVER RETURNS SILENTLY-BAD WORK. If the rounds run out the result
//          is `ok: false` WITH the last draft and the outstanding findings, so
//          the caller can show the user how far it got and why it stopped. A
//          loop that returned its last attempt as though it had succeeded would
//          hand a broken script to the reviewer with a clean bill of health.

import { analyzeScript, repairPrompt, validateScriptSource, type ValidationReport } from "../scriptValidation";
import { buildSurfacePrompt } from "../scriptPrompt";
import { splitReply } from "../scriptEval";
import { objectHooksFor } from "../scriptPreview/objectHooks";
import { buildRunnableSkeleton, preferredHookFor } from "../scriptTemplate";
import type { CompleteFn, TierPlan } from "../modelProfile";

/**
 * EDIT MODE. The script exists and works; the task is a CHANGE to it.
 *
 * Absent means author from nothing, and every string `authorScript` builds is
 * then byte-identical to what it built before edit mode existed — which is the
 * property the CREATE-mode snapshot test guards.
 */
export interface EditBasis {
  /** The code as it stands ON SCREEN — not the stored copy, not an attempt. */
  baseSource: string;
}

export interface AuthorRequest {
  /** What the user asked for, in their words. */
  intent: string;
  /** The draft's target, e.g. "button". Drives the API slice. */
  objectType: string;
  plan: TierPlan;
  complete: CompleteFn;
  /** Extra ranking terms beyond the intent itself. */
  hints?: string[];
  /** Model name, used only to make a give-up message name what gave up. */
  model?: string;
  /** Set to EDIT an existing script rather than author a new one. */
  edit?: EditBasis;
  /**
   * L3: run the draft against a CLONE of the workbook and report what it would
   * change (`ai_dry_run_script`). Optional because the loop is useful without a
   * live workbook — the offline eval runner has none.
   *
   * WHY IT MATTERS HERE. L0-L2 are static: they cannot see a script that parses,
   * invents nothing, declares its capabilities correctly and then THROWS on the
   * first line. Measured against two real local models, roughly half of all
   * failures were scripts the validator called `ok` — and the loop stopped after
   * one round on every one of them, because that was the honest answer to the
   * only question it could ask. This is the rung that gives it a better one.
   */
  dryRun?: (source: string) => Promise<DryRunReport>;
  /**
   * Whether a correct solution has to change cells.
   *
   * Deliberately the CALLER's judgement, not a corpus field: "it changed
   * nothing" is only a defect when the task was supposed to write, and a script
   * that legitimately only reads and reports is a normal thing to ask for. The
   * caller also knows whether the live workbook actually holds the data the task
   * assumes — against an empty sheet, a correct "sort rows 2-500" changes
   * nothing and must not be marked wrong for it.
   */
  expectsWrites?: boolean;
  /**
   * One attempt finished. WIDENED 2026-08-26 from `(round, report)`.
   *
   * A second callback beside one that already did 90% of the job is the drift
   * this repo keeps paying for, so the existing one carries the whole attempt.
   * It fires AFTER the dry-run block, so `dryRun` is populated when there was
   * one — which is the whole reason a caller wants the attempt rather than the
   * report.
   */
  onAttempt?: (attempt: AuthorAttempt) => void;
}

/** The shape `ai_dry_run_script` returns (mirrors `DryRunReport` in ai/dryrun.rs). */
export interface DryRunReport {
  ok: boolean;
  error?: string | null;
  durationMs: number;
  changes: Array<{ row: number; col: number; before: string; after: string }>;
  truncated: boolean;
  totalChanges: number;
  output: string[];
  /** Values of the cells the caller asked to see, after the run. */
  readBack: Array<{ row: number; col: number; value: string }>;
  /**
   * Handlers the script REGISTERED that the run never fired, because the
   * preview cannot synthesize the payload the product's forwarder delivers.
   *
   * THE FIELD THAT MAKES A ZERO READABLE. `totalChanges === 0` is a statement
   * about the script only when everything it registered actually ran; when the
   * handler holding the work was skipped, the same zero is a statement about
   * the PREVIEW. Without this field the two are indistinguishable, and both a
   * model and a reviewer read the bare "changed no cells" as a defect — the
   * model then spends a repair round "fixing" a correct draft.
   *
   * Always empty in the Rust interpreter realm, which fires no hooks at all.
   */
  unexercisedHooks: string[];
  /**
   * Whether the dry run can speak to this script AT ALL.
   *
   * False means NOTHING else here is evidence about the script — an object
   * script runs in the Worker realm, the preview runs in the interpreter's, and
   * the two share a fraction of one surface. Callers MUST branch on this before
   * drawing any conclusion; treating a declined report as a verdict rejected
   * every valid draft this feature produced.
   */
  applicable: boolean;
  /** Why the dry run declined, when `applicable` is false. */
  declinedReason?: string | null;
}

export interface AuthorAttempt {
  round: number;
  source: string;
  report: ValidationReport;
  /** The model's WHOLE reply, before the fence was taken out of it. */
  reply: string;
  /** The prose outside the fence — the model's account of what it did. */
  note: string;
  /**
   * The inline `<think>...</think>` scratchpad, when the model emitted one.
   *
   * Distinct from the stream-split reasoning the RUNNER accumulates from
   * `ReasoningDelta` events: Ollama delivers deepseek-r1/qwen3 reasoning
   * INLINE in the text, which no delta ever carries — so without this field
   * an inline reasoner's thought process was invisible to the run record.
   */
  thinking: string;
  /** Milliseconds since the RUN started, and how long this attempt took. */
  at: number;
  durationMs: number;
  /** The surface this attempt was shown, as a size. Rides per-attempt so an
   *  evicted log is still self-describing. */
  surfaceTokens: number;
  surfaceTruncated: boolean;
  /** Present when a dry run was performed for this attempt. */
  dryRun?: DryRunReport;
}

export interface AuthorResult {
  ok: boolean;
  /**
   * The loop stopped because the model kept returning the SAME errors, not
   * because it ran out of rounds. A different fact about the model, and the
   * more useful one: more patience would not have helped.
   */
  stalled?: boolean;
  /**
   * EDIT MODE only: the model returned the base source unchanged.
   *
   * NOT a failure — `EDIT_SYSTEM` explicitly licenses it — but reporting plain
   * success would be the same small lie as claiming a repair round that never
   * happened. It must never trigger a repair: the model may simply be right,
   * and a round on a local model is minutes.
   */
  unchanged?: boolean;
  /** The best draft produced. Present even on failure — see the header. */
  source: string;
  report: ValidationReport;
  attempts: AuthorAttempt[];
  /** Why it stopped, in one sentence, for the user. */
  summary: string;
}

// The event teaching here is load-bearing and was WRONG for the feature's
// first two days: this prompt taught `context.expose('onClick', handler)`, and
// an exposed method named "onClick" NEVER receives a click — the product fires
// the onClick HOOK (`context.onClick(handler)`); `expose` is for named
// commands (schedules, shortcuts, other scripts). Every draft this pipeline
// produced for a button therefore mounted cleanly and did nothing when
// clicked. Found by expected-diff grading, the first gate that actually RAN a
// draft against the click path. Same fingerprint as the `export function
// setup` mount defect: the teaching drifted from the production form and every
// test doubled the part that would have told.
const BASE_SYSTEM = [
  "You write Calcula object scripts.",
  "Reply with ONE fenced JavaScript code block and nothing else — no explanation.",
  "The script must export `setup(context)`.",
  "Put the work in a TOP-LEVEL function that takes NO arguments (async function run() { ... }) and have setup() call it, or wire a hook to call it.",
  "setup() is not a run target -- the mount has already called it -- so a script whose only top-level function is setup cannot be started with Run (F5). `context` is in scope for every top-level function in the file, so nothing has to be passed in.",
  "React to the object's events through its hooks: a button's click handler is `context.onClick(handler)`.",
  "Use `context.expose(name, handler)` only for named commands (schedules, shortcuts, other scripts) — an exposed handler does NOT run when the object is clicked.",
  "Reach the API only through `context`, and only methods you were shown.",
  "Declare every privileged capability you use with a `// @capability <id>` line at the top.",
].join("\n");

/**
 * Extra instruction for the weakest tier.
 *
 * Not a different pipeline — the contract is identical (§4c). It narrows what
 * the model is asked to invent, which is the difference between "can author
 * correct code" and "can fill in a shape", and the latter is what a small model
 * does reliably.
 */
/**
 * The worked template, built for the OBJECT TYPE the draft actually targets.
 *
 * IT USED TO HARDCODE `context.onClick`. Reported 2026-08-24 from a real run: a
 * qwen3.5:9b draft passed every static check and then failed the dry run with
 * `context.onClick is not a function`, because the target was not a button and
 * the template had told it to call a hook that object does not have. The
 * assisted tier exists to narrow what a weak model must invent — so a wrong
 * template is worse here than no template, since the model follows it exactly.
 *
 * `objectHooksFor` is the same generated per-type table the preview fires
 * hooks from, so the template and the realm cannot disagree. A type with no
 * hooks of its own gets an honest `setup`-only shape rather than a borrowed one.
 */
function assistedSystemFor(objectType: string): string {
  const hooks = objectHooksFor(objectType);
  const preferred = preferredHookFor(objectType);
  // THE TABLE IS A PREFERENCE OVER THE LIVE LIST, NEVER AN AUTHORITY.
  // An explicit `null` means DIRECT. A named hook the live surface no longer
  // carries degrades to hooks[0] — NOT to direct: a renamed hook must never
  // silently turn a button's template into "runs at mount".
  const primary =
    preferred === null ? null : hooks.includes(preferred) ? preferred : hooks[0] ?? null;

  const lines: string[] = [
    "",
    "Follow this shape exactly, replacing only the body of run().",
  ];
  if (primary) {
    const others = hooks.length > 1
      ? ` This object can also fire: ${hooks.filter((h) => h !== primary).join(", ")}.`
      : "";
    lines.push(`A "${objectType}" reacts through \`context.${primary}\`.${others}`);
  } else if (hooks.length > 0) {
    lines.push(
      `A "${objectType}" script runs when it is mounted, so setup() starts run() directly.` +
        ` This object can also fire: ${hooks.join(", ")}.`,
    );
  } else {
    // The literal two tests in authoring.test.ts key on (one toContain, one
    // not.toContain). Do not reword.
    lines.push(
      `A "${objectType}" script has no event hooks of its own: setup() starts run() directly,`,
      "and setup runs when the script is mounted.",
    );
  }
  lines.push("", "```javascript", buildRunnableSkeleton({ objectType, primaryHook: primary }), "```");
  return lines.join("\n");
}

/**
 * The edit contract. Every line is a measured failure mode, not manners.
 *
 * "Return the WHOLE script": `extractScript` takes a fenced block and
 * `validateScriptSource` validates a whole file. There is no patch applier
 * anywhere in this pipeline, so a diff-shaped reply fails L0 as a parse error —
 * and the model would have been doing what it was asked.
 *
 * The `// @capability` clause: an UNDECLARED capability is an ERROR, but
 * declared-and-unused is only a NOTICE, and the repair prompt carries errors
 * ONLY. So a model that strips a pragma while "tidying" breaks the script in a
 * way this loop can report after the fact but never prevent — which makes
 * saying it up front the only defence.
 *
 * "Return it unchanged" is licensed deliberately: a model that cannot find
 * anything to change should say so by doing nothing, not by inventing a change.
 * `unchanged` on the result reports that honestly instead of claiming work.
 */
const EDIT_SYSTEM = [
  "",
  "You are EDITING a script that already exists and already works.",
  "Return the WHOLE script, including every part you did not change: your reply REPLACES the file, so anything you leave out is deleted.",
  "Change only what the task asks for. Keep every other line byte for byte — the same function names, the same hooks, the same `// @capability` lines, the same comments, in the same order.",
  "Do not restyle working code, do not rename anything you were not asked to rename, and do not delete code you do not understand.",
  "If the script already does what the task asks, return it unchanged.",
].join("\n");

/**
 * The smallest API surface an edit may be left with.
 *
 * A surface trimmed to nothing is worse than a tight one: the model then has no
 * reference at all and invents members from memory, which is the exact failure
 * `scriptPrompt`'s header describes. Below roughly this, `buildSurfacePrompt`
 * starts dropping members the core teaching depends on.
 */
const MIN_EDIT_SURFACE_TOKENS = 1200;

/**
 * Rough token count for a piece of source.
 *
 * Mirrors `buildSurfacePrompt`'s own `length / 3.6` heuristic ON PURPOSE: the
 * two numbers are subtracted from each other, so they must be wrong in the same
 * direction. The module exports no estimator to borrow.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/**
 * The `context.*` members a script already calls, for surface RANKING.
 *
 * From the real AST walk rather than a regex, because one already exists and is
 * what the validator itself trusts. A parse failure yields nothing, which is
 * correct: an unparseable base source has no calls to preserve, and the ranker
 * simply falls back to the intent.
 */
function calledMembers(source: string): string[] {
  try {
    const analysis = analyzeScript(source);
    if (!analysis.parsed) return [];
    // The LEAF of each chain is the useful hint: `api.setRangeFormat` ranks on
    // "setRangeFormat", and the full dotted chain matches nothing in the
    // ranker's term list.
    const terms = new Set<string>();
    for (const call of analysis.calls) {
      for (const part of call.chain.split(".")) {
        if (part.length > 2) terms.add(part);
      }
    }
    return [...terms];
  } catch {
    return [];
  }
}

/**
 * Whether two sources are the same script, ignoring line endings and trailing
 * whitespace — the differences a model round-trip introduces for free.
 */
function sameScript(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n").trimEnd() === b.replace(/\r\n/g, "\n").trimEnd();
}

/**
 * How many times the SAME error set may repeat before the loop gives up.
 *
 * Two, not one: a single repetition can be a model that fixed one of two errors
 * and reintroduced it. Two consecutive identical sets means the repair text is
 * not landing and another round of it will not land either.
 */
const STALLED_AFTER_REPEATS = 2;

/**
 * A stable fingerprint of a round's errors, for detecting a loop going nowhere.
 *
 * Sorted, so two rounds reporting the same problems in a different order are
 * recognised as the same problems. Empty when the round had no errors — which
 * must never count as a repeat, or a run failing only its BEHAVIOURAL check
 * (valid script, changes nothing) would stall out immediately.
 */
function errorSignature(report: ValidationReport): string {
  return report.findings
    .filter((f) => f.severity === "error")
    .map((f) => f.message)
    .sort()
    .join("");
}

export async function authorScript(req: AuthorRequest): Promise<AuthorResult> {
  const surface = buildSurfacePrompt({
    objectType: req.objectType,
    // In EDIT mode the script itself occupies part of the context on every
    // round, so the surface must give ground or the two together overrun a
    // small window — and an overrun truncates the surface at whatever byte the
    // server stopped reading, which is the failure `scriptPrompt`'s own header
    // calls the worst one. Floored, because a surface trimmed to nothing is
    // worse than a tight one: the model then invents members from memory.
    budgetTokens: req.edit
      ? Math.max(MIN_EDIT_SURFACE_TOKENS, req.plan.surfaceBudgetTokens - estimateTokens(req.edit.baseSource))
      : req.plan.surfaceBudgetTokens,
    // The members the script ALREADY calls are ranking hints: without them a
    // budget-trimmed surface can omit the very API the script depends on, and
    // the model cannot see how to keep working code working. Taken from the
    // real AST walk, not a regex — `analyzeScript` is what the validator uses.
    hints: [...(req.hints ?? []), req.intent, ...(req.edit ? calledMembers(req.edit.baseSource) : [])],
  });

  // NEVER BOTH. `assistedSystemFor` is a worked template with an EMPTY body and
  // the instruction "Follow this shape exactly, replacing only the body" — which,
  // handed to a model alongside the user's working script, is an instruction to
  // throw that script away. The assisted tier is the DEFAULT for any unprobed
  // model, i.e. the common local path, so this is not an edge case.
  const system =
    BASE_SYSTEM +
    (req.edit ? EDIT_SYSTEM : req.plan.tier === "assisted" ? assistedSystemFor(req.objectType) : "");

  const task = req.edit
    ? `# Task (edit the script above, which is attached to a "${req.objectType}")\n${req.intent}`
    : `# Task (the script is attached to a "${req.objectType}")\n${req.intent}`;

  /**
   * The current script, shown BEFORE the task so the instruction is the last
   * thing read — the same ordering discipline the repair block already uses by
   * putting `fixes` last. Empty in CREATE mode, which keeps every string this
   * function builds byte-identical to what it built before edit mode existed.
   */
  const baseBlock = req.edit
    ? ["# The script as it is now", "```javascript", req.edit.baseSource.trimEnd(), "```", ""]
    : [];

  const attempts: AuthorAttempt[] = [];
  let user = req.edit
    ? [surface.text, "", ...baseBlock, task].join("\n")
    : `${surface.text}\n\n${task}`;
  /** The previous round's error set, for stall detection (see the loop). */
  let lastSignature = "";
  let repeatedSignatures = 0;
  let stalled = false;
  /** The run-target nudge is ONE SHOT. See the block that sets it. */
  let nudgedRunTarget = false;
  /**
   * The draft that was set aside TO BE NUDGED, and nothing else.
   *
   * Set at exactly one place, and it means exactly one thing: this draft passed
   * every static check and the dry run said nothing, so it WOULD have been
   * accepted — it is only going round again to be made runnable. A nudged reply
   * that comes back broken must never cost the user the working script they
   * already had.
   */
  let setAsideForNudge: { source: string; report: ValidationReport } | null = null;
  const runStartedAt = Date.now();

  // rounds + 1: the first pass is the ATTEMPT, `repairRounds` is how many
  // corrections follow it. Off-by-one here silently halves a weak tier's budget.
  for (let round = 0; round <= req.plan.repairRounds; round++) {
    const t0 = Date.now();
    const reply = await req.complete(system, user);
    // SPLIT, not extracted: the prose around the fence is the model's account of
    // what it changed, and dropping it here is why the author could not see any
    // reasoning anywhere downstream.
    const { source, note, thinking } = splitReply(reply);
    // NARROWED TO THE OBJECT TYPE. The check that GRADES the answer must use
    // the same slice of the API the prompt showed: a draft written against a
    // member this object cannot reach is dead at mount, and a validator that
    // sees the flat union calls it clean.
    const report = validateScriptSource(source, req.objectType);
    const attempt: AuthorAttempt = {
      round,
      source,
      report,
      reply,
      note,
      thinking,
      at: t0 - runStartedAt,
      durationMs: Date.now() - t0,
      surfaceTokens: surface.costTokens,
      surfaceTruncated: surface.truncated,
    };
    attempts.push(attempt);

    // L3 runs ONLY once the static checks pass. Executing a script that is
    // already known broken wastes a run and produces a runtime error that just
    // restates the static one — noise in the repair prompt at the exact moment
    // the model needs a single clear instruction.
    let behaviouralFix = "";
    if (report.ok && req.dryRun) {
      const dry = await req.dryRun(source);
      attempt.dryRun = dry;
      // A declined report is not a verdict. Reading one as a failure sent the
      // model round after round "fixing" a script that was already correct,
      // because the preview realm cannot host an object script at all.
      if (dry.applicable === false) {
        behaviouralFix = "";
      } else if (!dry.ok) {
        behaviouralFix =
          `The script passes every static check but FAILS when run against a copy of the workbook:\n` +
          `  ${dry.error ?? "unknown error"}\n` +
          `Fix the runtime error and return the whole script again.`;
      } else if (req.expectsWrites && dry.totalChanges === 0 && (dry.unexercisedHooks?.length ?? 0) > 0) {
        // SUPPRESSED, NOT FAILED. The zero is a fact about the PREVIEW here:
        // the handler that would have done the writing was never fired, because
        // the preview cannot synthesize the payload the product's forwarder
        // delivers. Sending a correct script back for repair on that evidence
        // is the rung's founding failure mode wearing a different hat — the
        // model has nothing to fix, so it rewrites working code until the
        // rounds run out.
        //
        // NO CURRENT CALLER REACHES THIS, and it is written anyway. The chat
        // path sets `expectsWrites: false` (the `authorScript` call in
        // app/extensions/AIChat/lib/authorRunner.ts) and the eval
        // harness turns an unsynthesizable payload into a HARNESS GAP
        // (`applicable: false`), which is handled two arms above. The day
        // either changes its mind, the default must already be "say nothing"
        // rather than "accuse the draft".
        behaviouralFix = "";
      } else if (req.expectsWrites && dry.totalChanges === 0) {
        behaviouralFix =
          "The script runs without error but changes NOTHING. The task asks it to modify the " +
          "workbook, so it is not doing the job. Return the whole script again, actually writing " +
          "the cells the task describes.";
      }
    }

    // REPORTED ONCE, AND HERE. Below the dry run, so `attempt.dryRun` is filled
    // in; above the nudge, because the nudge is a repair instruction and not a
    // fact about the attempt.
    req.onAttempt?.(attempt);

    // THE RUN-TARGET NUDGE.
    //
    // `round < req.plan.repairRounds` is not defensive: repairRounds is ONE for
    // the strong tier (modelProfile/index.ts:107), so a nudge on the final round
    // sets behaviouralFix, skips the accept arm, ends the loop and reports
    // `ok: false` — "It passes every static check but does not do what was
    // asked" — about a script that is correct.
    //
    // CREATE ONLY: in EDIT mode, EDIT_SYSTEM says "keep every other line byte
    // for byte", and asking for a refactor in the same message contradicts it.
    //
    // ONE SHOT: the change is a pure refactor, and a round is minutes on a local
    // model (6m35s measured).
    if (
      report.ok &&
      !behaviouralFix &&
      !req.edit &&
      !nudgedRunTarget &&
      round < req.plan.repairRounds &&
      report.findings.some((f) => f.code === "no-run-target")
    ) {
      setAsideForNudge = { source, report };
      nudgedRunTarget = true;
      behaviouralFix =
        "The script is valid, but all of its work sits inside setup() or a handler, so the user " +
        "cannot press Run to start it. Move the work into a TOP-LEVEL function that takes NO " +
        "arguments -- async function run() { ... } -- and have setup() call it (or wire the hook " +
        "to call it). Do not change what the script does. Return the whole script again.";
    }

    if (report.ok && !behaviouralFix) {
      const unchanged = req.edit ? sameScript(source, req.edit.baseSource) : undefined;
      return {
        ok: true,
        source,
        report,
        attempts,
        unchanged,
        summary: unchanged
          ? "The model returned the script unchanged — it judged that no edit was needed."
          : req.edit
            ? round === 0
              ? "Edited and validated on the first attempt."
              : `Edited and validated after ${round} correction${round === 1 ? "" : "s"}.`
            : round === 0
              ? "Drafted and validated on the first attempt."
              : `Drafted and validated after ${round} correction${round === 1 ? "" : "s"}.`,
      };
    }

    // STOP WHEN THE LOOP HAS STOPPED LEARNING.
    //
    // Measured 2026-08-24, qwen2.5:7b, assisted tier (6 repair rounds), driving
    // this loop against a live Ollama: rounds 3, 4, 5 and 6 returned the
    // BYTE-IDENTICAL error set — `context.selection.getActiveRanges` is not part
    // of the object-script API — because the model had settled into a Google
    // Apps Script idiom and the same repair text was not going to move it. Those
    // four rounds each rewrote a whole script and re-validated it: on a CPU-bound
    // local model that is minutes of the user's life buying nothing, and it
    // reads to them as a hang.
    //
    // Two identical consecutive repairs is the signal. One repetition can be
    // noise (a model that fixed one of two errors and reintroduced it); two
    // means the prompt is not landing, and no further round of the SAME prompt
    // will land either. The result is unchanged — this draft was going to fail
    // anyway — so the only thing given up is the waiting.
    const signature = errorSignature(report);
    if (signature && signature === lastSignature) {
      repeatedSignatures += 1;
    } else {
      repeatedSignatures = 0;
      lastSignature = signature;
    }
    if (repeatedSignatures >= STALLED_AFTER_REPEATS) {
      stalled = true;
      break;
    }

    // The repair prompt carries ERRORS ONLY. Feeding it the notices would teach
    // the model to strip capability declarations it cannot prove it needs, which
    // is the opposite of what §11.2 decided.
    const fixes = behaviouralFix || repairPrompt(report);
    user = [
      `${surface.text}`,
      "",
      // Spliced into every repair round too, or round 1 loses the very thing it
      // was told to preserve. "# Your previous attempt" below stays honest from
      // round 1 onward — that source IS the model's attempt; only round 0
      // needed a different heading.
      ...baseBlock,
      task,
      "",
      "# Your previous attempt",
      "```javascript",
      source.trimEnd(),
      "```",
      "",
      fixes,
    ].join("\n");
  }

  const last = attempts[attempts.length - 1];

  // A COSMETIC REFACTOR REQUEST MUST NEVER COST A WORKING SCRIPT.
  //
  // "Accept whatever comes back" is not what this loop does: the nudged reply is
  // re-validated, and a broken one would be returned as the result. The draft we
  // set aside was already accept-worthy, so it wins.
  if (!last.report.ok && setAsideForNudge) {
    return {
      ok: true,
      source: setAsideForNudge.source,
      report: setAsideForNudge.report,
      attempts,
      unchanged: req.edit ? sameScript(setAsideForNudge.source, req.edit.baseSource) : undefined,
      summary:
        "Drafted and validated; a follow-up correction was discarded because it came back worse.",
    };
  }

  const errors = last.report.findings.filter((f) => f.severity === "error");
  // A draft can exhaust its rounds while STATICALLY valid — that is exactly the
  // case L3 exists to catch, and reporting "still wrong: " with an empty list
  // would read as a bug in the loop rather than a fact about the script.
  const why = errors.length
    ? `Still wrong: ${errors.map((e) => e.message).join("; ")}`
    : last.dryRun && !last.dryRun.ok
      ? `It passes every static check but fails when run: ${last.dryRun.error ?? "unknown error"}`
      : "It passes every static check but does not do what was asked.";
  // "Ran out of rounds" and "kept making the same mistake" are different facts
  // about the model, and the second one is the more useful of the two: it tells
  // the user that more patience would not have helped and a different model
  // might.
  // "Skipped the rest" is only true when there WAS a rest. A stall detected on
  // the final round has saved nothing, and claiming otherwise is the same kind
  // of small lie as reporting success for an edit that did not happen.
  const roundsSkipped = req.plan.repairRounds + 1 - attempts.length;
  const howItEnded = stalled
    ? `${req.model ?? "The model"} repeated the same mistake on ${STALLED_AFTER_REPEATS + 1} attempts in a row` +
      (roundsSkipped > 0
        ? `, so the remaining ${roundsSkipped} correction${roundsSkipped === 1 ? " was" : "s were"} skipped.`
        : `, through all ${attempts.length} attempts.`) +
      ` Trying a larger model, or rewording the task, is more likely to help than running it again.`
    : `Could not produce a valid script in ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}.`;
  return {
    ok: false,
    source: last.source,
    report: last.report,
    attempts,
    stalled,
    unchanged: req.edit ? sameScript(last.source, req.edit.baseSource) : undefined,
    summary: `${howItEnded} ${why}`,
  };
}

export { buildSurfacePrompt, validateScriptSource };
