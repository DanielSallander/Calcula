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
  /** The best draft produced. Present even on failure — see the header. */
  source: string;
  report: ValidationReport;
  attempts: AuthorAttempt[];
  /** Why it stopped, in one sentence, for the user. */
  summary: string;
}

const BASE_SYSTEM = [
  "You write Calcula object scripts.",
  "Reply with ONE fenced JavaScript code block and nothing else — no explanation.",
  "The script must export `setup(context)`; register behaviour with `context.expose(name, handler)`.",
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
const ASSISTED_SYSTEM = [
  "",
  "Follow this shape exactly, replacing only the body:",
  "",
  "```javascript",
  "export function setup(context) {",
  "  context.expose('onClick', async () => {",
  "    // your code here",
  "  });",
  "}",
  "```",
].join("\n");

export async function authorScript(req: AuthorRequest): Promise<AuthorResult> {
  const surface = buildSurfacePrompt({
    objectType: req.objectType,
    budgetTokens: req.plan.surfaceBudgetTokens,
    hints: [...(req.hints ?? []), req.intent],
  });

  const system = BASE_SYSTEM + (req.plan.tier === "assisted" ? ASSISTED_SYSTEM : "");
  const task = `# Task (the script is attached to a "${req.objectType}")\n${req.intent}`;

  const attempts: AuthorAttempt[] = [];
  let user = `${surface.text}\n\n${task}`;

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
  return {
    ok: false,
    source: last.source,
    report: last.report,
    attempts,
    summary:
      `Could not produce a valid script in ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}. ` +
      why,
  };
}

export { buildSurfacePrompt, validateScriptSource };
