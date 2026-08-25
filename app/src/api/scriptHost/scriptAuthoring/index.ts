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

import { repairPrompt, validateScriptSource, type ValidationReport } from "../scriptValidation";
import { buildSurfacePrompt } from "../scriptPrompt";
import { extractScript } from "../scriptEval";
import { objectHooksFor } from "../scriptPreview/objectHooks";
import type { CompleteFn, TierPlan } from "../modelProfile";

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
  onAttempt?: (round: number, report: ValidationReport) => void;
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
  if (hooks.length === 0) {
    return [
      "",
      `A "${objectType}" script has no event hooks of its own: put the work directly`,
      "in `setup`, which runs when the script is mounted.",
      "",
      "```javascript",
      "export function setup(context) {",
      "  // your code here",
      "}",
      "```",
    ].join("\n");
  }
  const primary = hooks[0];
  const others =
    hooks.length > 1
      ? ` This object can also fire: ${hooks.slice(1).join(", ")}.`
      : "";
  return [
    "",
    `Follow this shape exactly, replacing only the body. A "${objectType}" reacts`,
    `through \`context.${primary}\`.${others}`,
    "",
    "```javascript",
    "export function setup(context) {",
    `  context.${primary}(async () => {`,
    "    // your code here",
    "  });",
    "}",
    "```",
  ].join("\n");
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
    budgetTokens: req.plan.surfaceBudgetTokens,
    hints: [...(req.hints ?? []), req.intent],
  });

  const system = BASE_SYSTEM + (req.plan.tier === "assisted" ? assistedSystemFor(req.objectType) : "");
  const task = `# Task (the script is attached to a "${req.objectType}")\n${req.intent}`;

  const attempts: AuthorAttempt[] = [];
  let user = `${surface.text}\n\n${task}`;
  /** The previous round's error set, for stall detection (see the loop). */
  let lastSignature = "";
  let repeatedSignatures = 0;
  let stalled = false;

  // rounds + 1: the first pass is the ATTEMPT, `repairRounds` is how many
  // corrections follow it. Off-by-one here silently halves a weak tier's budget.
  for (let round = 0; round <= req.plan.repairRounds; round++) {
    const reply = await req.complete(system, user);
    const source = extractScript(reply);
    const report = validateScriptSource(source);
    const attempt: AuthorAttempt = { round, source, report };
    attempts.push(attempt);
    req.onAttempt?.(round, report);

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
      } else if (req.expectsWrites && dry.totalChanges === 0) {
        behaviouralFix =
          "The script runs without error but changes NOTHING. The task asks it to modify the " +
          "workbook, so it is not doing the job. Return the whole script again, actually writing " +
          "the cells the task describes.";
      }
    }

    if (report.ok && !behaviouralFix) {
      return {
        ok: true,
        source,
        report,
        attempts,
        summary:
          round === 0
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
    summary: `${howItEnded} ${why}`,
  };
}

export { buildSurfacePrompt, validateScriptSource };
