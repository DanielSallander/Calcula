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

export interface ShrinkResult {
  minimized: ActionTrace;
  replays: number;
  /** True if the minimized trace was re-confirmed to fail. */
  stillFails: boolean;
  /** True if minimization stopped early (budget/cap). */
  truncated: boolean;
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
    if (verbose) {
      console.log(
        `  [shrink] replay ${replays}: ${candidate.actions.length} actions -> ` +
          `${outcome.failed ? `FAIL(${outcome.violationId})` : "pass"}`
      );
    }
    return matches(outcome);
  }

  let current = failingTrace;

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
        improved = true;
      }
    }
    if (!budgetLeft()) {
      truncated = true;
      break;
    }
  }

  // ---- Confirm the final minimized trace ----
  let stillFails = true;
  if (budgetLeft()) {
    replays++;
    const outcome = await replay(current);
    stillFails = matches(outcome);
  }

  return { minimized: current, replays, stillFails, truncated };
}
