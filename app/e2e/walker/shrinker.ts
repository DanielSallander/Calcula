//! FILENAME: app/e2e/walker/shrinker.ts
// PURPOSE: Trace minimization via delta debugging (ddmin). A failing
//          400-action walk is useless for debugging; a 4-action repro is
//          gold. The shrinker repeatedly replays subsets of the failing
//          trace against the same failure predicate and keeps the smallest
//          subset that still fails.
//
// Replay semantics: each attempt resets the app to a new workbook, replays
// the candidate trace, and checks whether the SAME violation id fires.
// Preconditions are re-checked during replay, so removing a "create" simply
// causes dependent actions to be skipped rather than crash.

import type { ActionTrace } from "./trace";
import { subTrace } from "./trace";

export interface ReplayOutcome {
  failed: boolean;
  /** Violation id that fired (invariantId/oracleId). */
  violationId?: string;
}

export type ReplayFn = (trace: ActionTrace) => Promise<ReplayOutcome>;

export interface ShrinkOptions {
  /** Cap on replay attempts (default 40). */
  maxReplays?: number;
  /** Wall-clock budget for the whole shrink (default 20 minutes). */
  timeBudgetMs?: number;
  /** Match any failure, not just the original violation id. Useful when a
   *  failure cascades into slightly different violations. Default false. */
  anyFailure?: boolean;
  verbose?: boolean;
}

/**
 * What a shrink actually established about its own result.
 *
 * THIS WAS A BOOLEAN AND THE BOOLEAN LIED. `stillFails` was initialised to
 * `true` and only ever assigned by the final confirmation replay — which is
 * skipped when the replay cap or the time budget is exhausted, the NORMAL
 * outcome on a long trace. So a shrink that ran out of budget wrote
 * `replayConfirmed: true` into the bundle without a single replay having
 * reproduced anything. Three genuinely different results were sharing one
 * `false` and a fourth was hiding inside `true`:
 *
 *   confirmed      — a replay reproduced the original violation on the
 *                    minimized trace. This is the only value that licenses
 *                    "here is a repro".
 *   not-reproduced — replays ran and the original violation never fired. Read
 *                    `otherOutcomes` before calling it noise: it may have
 *                    failed reliably a DIFFERENT way.
 *   unverified     — the budget ran out before anything reproduced. Nothing is
 *                    known either way; this is not evidence of absence.
 */
export type ShrinkVerdict = "confirmed" | "not-reproduced" | "unverified";

export interface ShrinkResult {
  minimized: ActionTrace;
  replays: number;
  /** What the shrink established — see ShrinkVerdict. */
  verdict: ShrinkVerdict;
  /** True if minimization stopped early (budget/cap). */
  truncated: boolean;
  /**
   * Every violation id a replay produced that was NOT the one being minimized,
   * with how many replays produced it — plus `"(passed)"` for replays that did
   * not fail at all.
   *
   * WHY THIS EXISTS. `matches()` accepts only `originalViolationId`, so a
   * replay that fails with a DIFFERENT id is treated exactly like a replay
   * that passed, and the only trace of it was one `[shrink]` console line
   * that nothing read. That threw away the strongest signal a shrink run can
   * produce: on soak seed 20260811 the original violation (a script-mount
   * timeout) never reproduced once in 16 replays, so the bundle recorded
   * `replayConfirmed: false` and read as "nothing here" — while TWELVE OF
   * TWELVE replays of the 14-action subset had failed, every one of them with
   * `no-js-exceptions`. A deterministic failure was sitting inside a bundle
   * that said the failure did not reproduce.
   *
   * A run whose original id never reproduces but which fails reliably with
   * another id is not a non-reproducible failure. It is a DIFFERENT
   * reproducible failure, and the report has to be able to say so.
   */
  otherOutcomes: Record<string, number>;
}

/**
 * Minimize a failing trace with ddmin (chunk removal with halving, followed
 * by a single-action removal pass).
 *
 * @param replay      Replays a trace from a clean workbook; reports outcome.
 * @param failingTrace The original failing trace.
 * @param originalViolationId The violation that the failure predicate matches.
 */
export async function minimizeTrace(
  replay: ReplayFn,
  failingTrace: ActionTrace,
  originalViolationId: string,
  options: ShrinkOptions = {}
): Promise<ShrinkResult> {
  const maxReplays = options.maxReplays ?? 40;
  const timeBudgetMs = options.timeBudgetMs ?? 20 * 60 * 1000;
  const verbose = options.verbose ?? true;
  const startedAt = Date.now();

  let replays = 0;
  let truncated = false;
  /** See ShrinkResult.otherOutcomes — the signal `matches()` discards. */
  const otherOutcomes: Record<string, number> = {};

  const record = (outcome: ReplayOutcome): void => {
    const key = !outcome.failed
      ? "(passed)"
      : (outcome.violationId ?? "(unknown)");
    if (outcome.failed && key === originalViolationId) return;
    otherOutcomes[key] = (otherOutcomes[key] ?? 0) + 1;
  };

  const matches = (outcome: ReplayOutcome): boolean => {
    if (!outcome.failed) return false;
    if (options.anyFailure) return true;
    return outcome.violationId === originalViolationId;
  };

  const budgetLeft = () =>
    replays < maxReplays && Date.now() - startedAt < timeBudgetMs;

  async function failsWith(keep: boolean[], current: ActionTrace): Promise<boolean> {
    replays++;
    const candidate = subTrace(current, keep);
    const outcome = await replay(candidate);
    record(outcome);
    if (verbose) {
      console.log(
        `  [shrink] replay ${replays}: ${candidate.actions.length} actions -> ` +
          `${outcome.failed ? `FAIL(${outcome.violationId})` : "pass"}`
      );
    }
    return matches(outcome);
  }

  let current = failingTrace;
  /**
   * Has any replay demonstrated that `current` fails? Every accepted reduction
   * IS such a demonstration (the candidate was kept precisely because it
   * matched), so a shrink that reduced anything at all has already confirmed
   * its result even if the budget dies before the final confirmation replay.
   */
  let confirmedByReplay = false;

  // ---- Phase 1: chunk removal with halving ----
  let chunkCount = 2;
  while (current.actions.length > 1 && chunkCount <= current.actions.length) {
    if (!budgetLeft()) {
      truncated = true;
      break;
    }

    const n = current.actions.length;
    const chunkSize = Math.ceil(n / chunkCount);
    let removedSomething = false;

    for (let c = 0; c < chunkCount && budgetLeft(); c++) {
      const start = c * chunkSize;
      if (start >= current.actions.length) break;
      const keep = current.actions.map(
        (_, i) => i < start || i >= start + chunkSize
      );
      if (keep.every((k) => !k)) continue; // would remove everything

      if (await failsWith(keep, current)) {
        current = subTrace(current, keep);
        confirmedByReplay = true;
        removedSomething = true;
        // Re-derive chunking against the smaller trace.
        chunkCount = Math.max(2, chunkCount - 1);
        break;
      }
    }

    if (!removedSomething) {
      if (chunkCount >= current.actions.length) break;
      chunkCount = Math.min(current.actions.length, chunkCount * 2);
    }
  }

  // ---- Phase 2: single-action removal pass ----
  let improved = true;
  while (improved && current.actions.length > 1) {
    improved = false;
    for (let i = current.actions.length - 1; i >= 0 && budgetLeft(); i--) {
      const keep = current.actions.map((_, j) => j !== i);
      if (await failsWith(keep, current)) {
        current = subTrace(current, keep);
        confirmedByReplay = true;
        improved = true;
      }
    }
    if (!budgetLeft()) {
      truncated = true;
      break;
    }
  }

  // ---- Confirm the final minimized trace ----
  //
  // The confirmation replay is the ideal, but it is exactly what the budget
  // takes away first, so the fallback is the strongest thing already known:
  // whether any accepted reduction reproduced the failure. `unverified` is a
  // real answer and it is not `true`.
  let verdict: ShrinkVerdict = confirmedByReplay ? "confirmed" : "unverified";
  if (budgetLeft()) {
    replays++;
    const outcome = await replay(current);
    record(outcome);
    verdict = matches(outcome) ? "confirmed" : "not-reproduced";
  }

  // A shrink that never reproduced its own violation is only "inconclusive" if
  // the replays also PASSED. If they failed with something else, say which —
  // in the log as well as the result, because the log is what a human reads
  // first and the bundle's `replayConfirmed: false` is what misled the last
  // pass into filing a reproducible defect as noise.
  if (verdict !== "confirmed" && verbose) {
    const failed = Object.entries(otherOutcomes).filter(([id]) => id !== "(passed)");
    if (failed.length > 0) {
      const summary = failed
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `${id} x${n}`)
        .join(", ");
      console.log(
        `  [shrink] "${originalViolationId}" never reproduced, but replays DID fail: ` +
          `${summary} (${otherOutcomes["(passed)"] ?? 0} passed). ` +
          `This is a different reproducible failure, not an absent one.`
      );
    }
    if (verdict === "unverified") {
      console.log(
        `  [shrink] UNVERIFIED: the budget (${maxReplays} replays / ` +
          `${Math.round(timeBudgetMs / 1000)}s) ran out before any replay ` +
          `reproduced "${originalViolationId}". Nothing is known either way.`
      );
    }
  }

  return { minimized: current, replays, verdict, truncated, otherOutcomes };
}
