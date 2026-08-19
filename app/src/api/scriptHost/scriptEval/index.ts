//! FILENAME: app/src/api/scriptHost/scriptEval/index.ts
// PURPOSE: Score one candidate script against one eval task. Pure — no I/O, no
//          model, no filesystem — so the same function serves the CI corpus
//          check, the offline runner, and M7's in-app `canaryScore`.
// CONTEXT: docs/design/local-model-script-authoring.md §11.3, M5.
//
//          THE CORPUS IS AT tests/eval/tasks.json, deliberately outside `app/`:
//          the owner's decision was that it ships as a public developer/CI
//          artifact, because withholding it would make every compatibility claim
//          about a model unfalsifiable.
//
//          WHY SCORING IS NOT JUST "DID IT VALIDATE". A script can pass L0-L2 and
//          still not do the job — `export function setup() {}` validates
//          perfectly and achieves nothing. So a task also names the chains its
//          solution must actually call. That is a weak behavioural assertion
//          rather than a real one (it cannot tell a correct SUM from a wrong
//          one), and it is honest about being weak: the strong check is the
//          dry-run diff, which needs a live workbook and belongs to the runner,
//          not here.

import { validateScriptSource } from "../scriptValidation";
import { analyzeScript } from "../scriptValidation/analyze";

/** One task from tests/eval/tasks.json. */
export interface EvalTask {
  id: string;
  /** In the in-app probe subset (M7's canaryScore). */
  canary: boolean;
  objectType: string;
  /** The user's words — what a model is actually given. */
  intent: string;
  /** Terms handed to the prompt assembler (M4) for ranking. */
  hints: string[];
  /** Capabilities the correct solution requires. Order-insensitive. */
  expectCapabilities: string[];
  /** Chains a correct solution has to call. */
  mustCall: string[];
  /** A solution that really works, kept as lines for readable diffs. */
  reference: string[];
  /** Why this task is interesting, when that is not obvious. */
  notes?: string;
}

export interface EvalCorpus {
  version: number;
  tasks: EvalTask[];
}

/** The reference solution as a single source string. */
export function referenceSource(task: EvalTask): string {
  return task.reference.join("\n") + "\n";
}

export interface TaskScore {
  taskId: string;
  /** L0 — it is JavaScript. */
  parsed: boolean;
  /** L1 — every method it calls exists. */
  reachClean: boolean;
  /** L2 — no capability used without being declared. */
  capabilitiesDeclared: boolean;
  /** The declared set is exactly what the task expects: no more, no less. */
  capabilitiesExact: boolean;
  /** Every chain in `mustCall` was actually called. */
  behavioural: boolean;
  /** Chains the task required that the candidate never called. */
  missingCalls: string[];
  /** Methods it invented. The single most diagnostic failure. */
  inventedMethods: string[];
  /** 0..1. Weighted so "invented an API" costs more than "missed a step". */
  score: number;
  /** True only when every component passed. */
  passed: boolean;
}

const WEIGHTS = {
  parsed: 0.15,
  reachClean: 0.3,
  capabilitiesDeclared: 0.25,
  capabilitiesExact: 0.1,
  behavioural: 0.2,
} as const;

/**
 * Score a candidate against a task.
 *
 * The weights encode what actually costs a user. `reachClean` is heaviest
 * because an invented method is the failure that cannot be recovered from
 * without a repair round, and `capabilitiesDeclared` is next because an
 * undeclared capability passes review and dies at run time (§5b). Over-declaring
 * (`capabilitiesExact`) is the lightest: it produces a reviewer notice, which is
 * the system working as designed rather than a defect.
 */
export function scoreCandidate(task: EvalTask, candidate: string): TaskScore {
  const report = validateScriptSource(candidate);
  const analysis = report.analysis;

  const parsed = analysis.parsed;
  const inventedMethods = report.findings
    .filter((f) => f.code === "unknown-member")
    .map((f) => f.message);
  const reachClean = parsed && inventedMethods.length === 0;
  const capabilitiesDeclared =
    parsed && !report.findings.some((f) => f.code === "undeclared-capability");

  const expected = [...task.expectCapabilities].sort();
  const declared = [...report.declared].sort();
  const capabilitiesExact =
    expected.length === declared.length && expected.every((c, i) => c === declared[i]);

  const called = new Set(analysis.calls.map((c) => c.chain));
  const missingCalls = task.mustCall.filter((c) => !called.has(c));
  const behavioural = parsed && missingCalls.length === 0;

  const score =
    (parsed ? WEIGHTS.parsed : 0) +
    (reachClean ? WEIGHTS.reachClean : 0) +
    (capabilitiesDeclared ? WEIGHTS.capabilitiesDeclared : 0) +
    (capabilitiesExact ? WEIGHTS.capabilitiesExact : 0) +
    (behavioural ? WEIGHTS.behavioural : 0);

  return {
    taskId: task.id,
    parsed,
    reachClean,
    capabilitiesDeclared,
    capabilitiesExact,
    behavioural,
    missingCalls,
    inventedMethods,
    score: Number(score.toFixed(4)),
    passed:
      parsed && reachClean && capabilitiesDeclared && capabilitiesExact && behavioural,
  };
}

/**
 * Pull a script out of a model's reply.
 *
 * Models fence their code far more reliably than they emit conformant tool-call
 * JSON, which is the whole reason §1a says script authoring suits weak models:
 * the output is ONE artifact in a code block. A reply with no fence at all is
 * taken verbatim, because some models simply answer with bare code.
 */
export function extractScript(reply: string): string {
  const fenced = reply.match(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim() + "\n";
  return reply.trim() + "\n";
}

export interface CorpusSummary {
  total: number;
  passed: number;
  /** Mean score across every task, 0..1. */
  meanScore: number;
  failures: TaskScore[];
}

export function summarize(scores: TaskScore[]): CorpusSummary {
  const passed = scores.filter((s) => s.passed).length;
  const meanScore = scores.length
    ? Number((scores.reduce((a, s) => a + s.score, 0) / scores.length).toFixed(4))
    : 0;
  return { total: scores.length, passed, meanScore, failures: scores.filter((s) => !s.passed) };
}

/** Re-exported so a runner needs one import. */
export { validateScriptSource, analyzeScript };
