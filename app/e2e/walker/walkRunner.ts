//! FILENAME: app/e2e/walker/walkRunner.ts
// PURPOSE: The walk runner — generalizes the v1 InvariantRunner:
//          - actions come from an ActionSource (seeded generator OR explicit
//            trace replay)
//          - every executed action is recorded and the trace is FLUSHED TO
//            DISK after every action (a hard WebView2 crash still leaves a
//            replayable artifact)
//          - cheap invariants run after every action; the semantic oracle
//            battery runs every N actions and at the end
//          - stops on maxActions OR a wall-clock budget (soak mode)

import * as path from "node:path";
import type { Page } from "@playwright/test";
import type { GridHelper } from "../helpers/grid";
import type { Invariant, InvariantViolation } from "../invariants/invariants";
import {
  captureSnapshot,
  installErrorTracking,
  setWalkStep,
} from "../invariants/stateSnapshot";
import type { StateSnapshot } from "../invariants/stateSnapshot";
import type { OracleBattery } from "../oracles";
import type { OracleBaseline } from "../oracles/types";
import type { ActionSource } from "./sources";
import type { ActionTrace } from "./trace";
import { createTrace, saveTrace } from "./trace";
import { executeInstance } from "./actionCatalog";
import type { AnyActionDef } from "./actionCatalog";

// ============================================================================
// Types
// ============================================================================

export interface WalkOptions {
  source: ActionSource;
  /** Cheap invariants checked after every action. */
  invariants: Invariant[];
  /** Semantic oracle battery (null disables oracle checkpoints). */
  oracleBattery?: OracleBattery | null;
  /** Oracle checkpoint cadence (default 25). */
  oracleEveryNActions?: number;
  /** Stop after this many actions (default 75; ignored when the source is a
   *  trace that ends earlier). */
  maxActions?: number;
  /** Stop when this much wall-clock time has elapsed (soak mode). */
  budgetMs?: number;
  /** UI settle time after each action (default 250ms). */
  settleTimeMs?: number;
  /** Directory where the live trace is flushed (trace.json). */
  resultsDir?: string;
  /** Catalog used for executing instances (default ACTION_CATALOG). */
  catalog?: AnyActionDef[];
  verbose?: boolean;
}

/**
 * How long one action actually took.
 *
 * S13's bundle could not distinguish "the script mount sat on its ten-second
 * deadline and then failed" from "something failed instantly": nothing timed
 * anything. A deadline is a DURATION, so a bundle that cannot report durations
 * cannot report deadlines, and the only failure mode this walker has that is
 * defined in seconds was the one it could say least about.
 */
export interface ActionTiming {
  step: number;
  id: string;
  params: Record<string, unknown>;
  /** Milliseconds from the start of the walk to the start of this action. */
  startedAtMs: number;
  /** Milliseconds `execute()` took (excludes the settle wait). */
  durationMs: number;
  /** Set when `execute()` threw and the walk tolerated it. */
  error?: string;
}

export interface CheckpointTiming {
  step: number;
  durationMs: number;
}

export interface WalkResult {
  passed: boolean;
  seed: number | null;
  totalActions: number;
  failedAtStep: number | null;
  /** The concrete, replayable trace of everything that executed. */
  trace: ActionTrace;
  violation: InvariantViolation | null;
  allViolations: InvariantViolation[];
  failingSnapshot: StateSnapshot | null;
  /** Oracle checkpoints that ran, with how long each took. */
  checkpoints: CheckpointTiming[];
  /** Per-action timings, in execution order. */
  timings: ActionTiming[];
  elapsedMs: number;
}

// ============================================================================
// Runner
// ============================================================================

export class WalkRunner {
  private page: Page;
  private grid: GridHelper;
  private opts: WalkOptions;

  constructor(page: Page, grid: GridHelper, opts: WalkOptions) {
    this.page = page;
    this.grid = grid;
    this.opts = opts;
  }

  async run(): Promise<WalkResult> {
    const {
      source,
      invariants,
      oracleBattery = null,
      oracleEveryNActions = 25,
      maxActions = 75,
      budgetMs,
      settleTimeMs = 250,
      resultsDir,
      catalog,
      verbose = true,
    } = this.opts;

    const startedAt = Date.now();
    const trace = createTrace(source.seed);
    const tracePath = resultsDir ? path.join(resultsDir, "trace.json") : null;
    const checkpoints: CheckpointTiming[] = [];
    const timings: ActionTiming[] = [];

    const fail = (
      step: number,
      violation: InvariantViolation,
      all: InvariantViolation[],
      snapshot: StateSnapshot | null
    ): WalkResult => ({
      passed: false,
      seed: source.seed,
      totalActions: step,
      failedAtStep: step,
      trace,
      violation,
      allViolations: all,
      failingSnapshot: snapshot,
      checkpoints,
      timings,
      elapsedMs: Date.now() - startedAt,
    });

    installErrorTracking(this.page);

    let oracleBaseline: OracleBaseline | null = oracleBattery
      ? await oracleBattery.begin(this.page)
      : null;

    let snapshot = await captureSnapshot(this.page);
    let step = 0;

    while (step < maxActions) {
      if (budgetMs !== undefined && Date.now() - startedAt > budgetMs) {
        if (verbose) console.log(`  [walk] budget reached after ${step} actions`);
        break;
      }

      const instance = source.next(snapshot, step + 1);
      if (instance === null) break; // trace exhausted
      step++;

      trace.actions.push(instance);
      if (tracePath) saveTrace(trace, tracePath);

      if (verbose) {
        console.log(`  [step ${step}/${maxActions}] ${instance.id}`);
      }

      // Every console line from here on belongs to this step.
      setWalkStep(step);

      // Execute
      const actionStartedAtMs = Date.now() - startedAt;
      const actionStartedAt = Date.now();
      const timing: ActionTiming = {
        step,
        id: instance.id,
        params: instance.params,
        startedAtMs: actionStartedAtMs,
        durationMs: 0,
      };
      timings.push(timing);
      try {
        await executeInstance(this.page, this.grid, instance, catalog);
        timing.durationMs = Date.now() - actionStartedAt;
      } catch (err) {
        timing.durationMs = Date.now() - actionStartedAt;
        const msg = (err as Error).message ?? "";
        timing.error = msg;
        if (
          msg.includes("Target page, context or browser has been closed") ||
          msg.includes("Target closed") ||
          msg.includes("browser has been closed")
        ) {
          console.log(`  [ABORT] Page closed at step ${step} during ${instance.id}`);
          return fail(
            step,
            {
              invariantId: "page-crashed",
              message: `Page/browser closed during action "${instance.id}": ${msg}`,
              details: { action: instance.id, error: msg },
            },
            [],
            null
          );
        }
        // Other failures are expected with random sequences (preconditions
        // can be stale) — log and continue.
        if (verbose) console.log(`    [action failed] ${instance.id}: ${msg}`);
      }

      // Settle
      try {
        await this.page.waitForTimeout(settleTimeMs);
      } catch {
        return fail(
          step,
          {
            invariantId: "page-crashed",
            message: `Page closed during settle after action "${instance.id}"`,
            details: { action: instance.id },
          },
          [],
          null
        );
      }

      // Snapshot
      try {
        snapshot = await captureSnapshot(this.page);
      } catch {
        return fail(
          step,
          {
            invariantId: "page-crashed",
            message: `Page closed during snapshot after action "${instance.id}"`,
            details: { action: instance.id },
          },
          [],
          null
        );
      }

      // Cheap invariants
      const violations = invariants.flatMap((inv) => inv.check(snapshot));
      if (violations.length > 0) {
        return fail(step, violations[0], violations, snapshot);
      }

      // Oracle battery checkpoint
      const isLastStep = step === maxActions;
      const budgetExhausted =
        budgetMs !== undefined && Date.now() - startedAt > budgetMs;
      if (
        oracleBattery !== null &&
        oracleBaseline !== null &&
        (step % oracleEveryNActions === 0 || isLastStep || budgetExhausted)
      ) {
        if (verbose) console.log(`  [oracle checkpoint] after step ${step}`);
        const checkpointTiming: CheckpointTiming = { step, durationMs: 0 };
        checkpoints.push(checkpointTiming);
        const checkpointStartedAt = Date.now();
        try {
          const result = await oracleBattery.checkpoint(this.page, oracleBaseline);
          checkpointTiming.durationMs = Date.now() - checkpointStartedAt;
          oracleBaseline = result.nextBaseline;
          if (result.violations.length > 0) {
            return fail(step, result.violations[0], result.violations, snapshot);
          }
        } catch (err) {
          checkpointTiming.durationMs = Date.now() - checkpointStartedAt;
          const msg = (err as Error).message ?? String(err);
          return fail(
            step,
            {
              invariantId: "oracle-infrastructure",
              message: `Oracle battery failed to run: ${msg}`,
              details: { error: msg },
            },
            [],
            snapshot
          );
        }
      }
    }

    // Final oracle checkpoint if the loop ended off-cadence (budget/trace end)
    if (
      oracleBattery !== null &&
      oracleBaseline !== null &&
      step > 0 &&
      step % (this.opts.oracleEveryNActions ?? 25) !== 0
    ) {
      if (verbose) console.log(`  [oracle checkpoint] final after step ${step}`);
      const finalTiming: CheckpointTiming = { step, durationMs: 0 };
      checkpoints.push(finalTiming);
      const finalStartedAt = Date.now();
      try {
        const result = await oracleBattery.checkpoint(this.page, oracleBaseline);
        finalTiming.durationMs = Date.now() - finalStartedAt;
        if (result.violations.length > 0) {
          return fail(step, result.violations[0], result.violations, snapshot);
        }
      } catch (err) {
        finalTiming.durationMs = Date.now() - finalStartedAt;
        const msg = (err as Error).message ?? String(err);
        return fail(
          step,
          {
            invariantId: "oracle-infrastructure",
            message: `Oracle battery failed to run: ${msg}`,
            details: { error: msg },
          },
          [],
          snapshot
        );
      }
    }

    return {
      passed: true,
      seed: source.seed,
      totalActions: step,
      failedAtStep: null,
      trace,
      violation: null,
      allViolations: [],
      failingSnapshot: null,
      checkpoints,
      timings,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

// ============================================================================
// Report formatting
// ============================================================================

export function formatWalkReport(result: WalkResult): string {
  if (result.passed) {
    return (
      `[OK] Walk passed\n` +
      `  Seed: ${result.seed ?? "(trace replay)"}\n` +
      `  Actions executed: ${result.totalActions}\n` +
      `  Oracle checkpoints: ${result.checkpoints.length}\n` +
      `  Elapsed: ${Math.round(result.elapsedMs / 1000)}s`
    );
  }

  const lines: string[] = [
    `[FAIL] Walk violation detected`,
    ``,
    `  Seed: ${result.seed ?? "(trace replay)"}`,
    `  Failed at step: ${result.failedAtStep} of ${result.totalActions}`,
    ``,
    `  --- Violation ---`,
    `  Invariant: ${result.violation!.invariantId}`,
    `  Message: ${result.violation!.message}`,
    ``,
  ];

  if (result.violation!.details) {
    lines.push(`  --- Details ---`);
    for (const [key, value] of Object.entries(result.violation!.details)) {
      lines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
    lines.push(``);
  }

  if (result.allViolations.length > 1) {
    lines.push(`  --- Additional violations: ${result.allViolations.length - 1} ---`);
    for (const v of result.allViolations.slice(1)) {
      lines.push(`  [${v.invariantId}] ${v.message.slice(0, 200)}`);
    }
    lines.push(``);
  }

  lines.push(`  --- Action trace (last 20 of ${result.trace.actions.length}) ---`);
  const actions = result.trace.actions;
  const startIdx = Math.max(0, actions.length - 20);
  for (let i = startIdx; i < actions.length; i++) {
    const marker = i === actions.length - 1 ? " <-- FAILED HERE" : "";
    lines.push(`  ${i + 1}. ${actions[i].id} ${JSON.stringify(actions[i].params)}${marker}`);
  }

  // The slowest actions, because the walker's only second-defined failure mode
  // (the 10s script-mount deadline) is invisible in an untimed trace. An action
  // sitting on ~10000ms IS the deadline; one at 120ms is not.
  const slowest = [...result.timings]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);
  if (slowest.length > 0 && slowest[0].durationMs > 0) {
    lines.push(``);
    lines.push(`  --- Slowest actions ---`);
    for (const t of slowest) {
      lines.push(
        `  step ${t.step}: ${t.id} ${t.durationMs}ms` +
          (t.error ? ` (threw: ${t.error.slice(0, 120)})` : "")
      );
    }
  }

  return lines.join("\n");
}
