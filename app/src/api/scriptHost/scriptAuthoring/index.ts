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
  onAttempt?: (round: number, report: ValidationReport) => void;
}

export interface AuthorAttempt {
  round: number;
  source: string;
  report: ValidationReport;
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
    attempts.push({ round, source, report });
    req.onAttempt?.(round, report);

    if (report.ok) {
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
    const fixes = repairPrompt(report);
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
  return {
    ok: false,
    source: last.source,
    report: last.report,
    attempts,
    summary:
      `Could not produce a valid script in ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}. ` +
      `Still wrong: ${errors.map((e) => e.message).join("; ")}`,
  };
}

export { buildSurfacePrompt, validateScriptSource };
