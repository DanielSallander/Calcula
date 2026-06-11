//! FILENAME: app/e2e/invariants/runner.ts
// PURPOSE: Orchestrates the invariant test loop: pick action -> execute ->
//          settle -> snapshot -> check invariants -> repeat or fail.

import type { Page } from "@playwright/test";
import type { GridHelper } from "../helpers/grid";
import type { Invariant } from "./invariants";
import type { ActionGenerator } from "./actionGenerator";
import type { RunResult } from "./reporter";
import { captureSnapshot, installErrorTracking } from "./stateSnapshot";
import type { OracleBattery } from "../oracles";
import type { OracleBaseline } from "../oracles/types";

// ============================================================================
// Runner Options
// ============================================================================

export interface RunnerOptions {
  /** Invariants to check after each action */
  invariants: Invariant[];
  /** Action generator (seeded PRNG) */
  actionGenerator: ActionGenerator;
  /** Maximum number of actions to execute (default: 75) */
  maxActions?: number;
  /** Milliseconds to wait for UI to settle after each action (default: 250) */
  settleTimeMs?: number;
  /** Log each action to console as it executes (default: true) */
  verbose?: boolean;
  /**
   * Semantic oracle battery (undo round-trip, recalc consistency, save/reload
   * round-trip). When set, the battery runs every `oracleEveryNActions`
   * actions and at the end of the run; oracle violations fail the run like
   * invariant violations.
   */
  oracleBattery?: OracleBattery;
  /** Checkpoint cadence for the oracle battery (default: 25) */
  oracleEveryNActions?: number;
}

// ============================================================================
// Runner
// ============================================================================

export class InvariantRunner {
  private page: Page;
  private grid: GridHelper;
  private options: Required<Omit<RunnerOptions, "oracleBattery">> & {
    oracleBattery: OracleBattery | null;
  };

  constructor(page: Page, grid: GridHelper, options: RunnerOptions) {
    this.page = page;
    this.grid = grid;
    this.options = {
      invariants: options.invariants,
      actionGenerator: options.actionGenerator,
      maxActions: options.maxActions ?? 75,
      settleTimeMs: options.settleTimeMs ?? 250,
      verbose: options.verbose ?? true,
      oracleBattery: options.oracleBattery ?? null,
      oracleEveryNActions: options.oracleEveryNActions ?? 25,
    };
  }

  async run(): Promise<RunResult> {
    const {
      invariants,
      actionGenerator,
      maxActions,
      settleTimeMs,
      verbose,
      oracleBattery,
      oracleEveryNActions,
    } = this.options;
    const actionHistory: string[] = [];
    const seed = actionGenerator.seed;

    // Install console/exception tracking
    installErrorTracking(this.page);

    // Oracle baseline for the first checkpoint window
    let oracleBaseline: OracleBaseline | null = oracleBattery
      ? await oracleBattery.begin(this.page)
      : null;

    // Capture initial snapshot
    let snapshot = await captureSnapshot(this.page);

    for (let step = 1; step <= maxActions; step++) {
      // Pick the next action
      const action = actionGenerator.next(snapshot);
      actionHistory.push(action.id);

      if (verbose) {
        console.log(`  [step ${step}/${maxActions}] ${action.id}`);
      }

      // Execute the action
      try {
        await action.execute(this.page, this.grid);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        // If the page/browser was closed, stop immediately — no recovery possible
        if (msg.includes("Target page, context or browser has been closed") ||
            msg.includes("Target closed") ||
            msg.includes("browser has been closed")) {
          console.log(`  [ABORT] Page closed at step ${step} during ${action.id}`);
          return {
            passed: false,
            seed,
            totalActions: step,
            failedAtStep: step,
            actionHistory,
            violation: {
              invariantId: "page-crashed",
              message: `Page/browser closed during action "${action.id}": ${msg}`,
              details: { action: action.id, error: msg },
            },
            allViolations: [],
            failingSnapshot: null,
          };
        }
        // Other action execution failures — log but don't fail the invariant test.
        // Some actions may fail due to app state (e.g., trying to create a
        // slicer when no table exists). This is expected with random sequences.
        if (verbose) {
          console.log(`    [action failed] ${action.id}: ${msg}`);
        }
      }

      // Wait for UI to settle
      try {
        await this.page.waitForTimeout(settleTimeMs);
      } catch {
        // Page closed during settle — bail out
        console.log(`  [ABORT] Page closed during settle after step ${step}`);
        return {
          passed: false,
          seed,
          totalActions: step,
          failedAtStep: step,
          actionHistory,
          violation: {
            invariantId: "page-crashed",
            message: `Page closed during settle after action "${action.id}"`,
            details: { action: action.id },
          },
          allViolations: [],
          failingSnapshot: null,
        };
      }

      // Capture new snapshot
      try {
        snapshot = await captureSnapshot(this.page);
      } catch {
        console.log(`  [ABORT] Page closed during snapshot after step ${step}`);
        return {
          passed: false,
          seed,
          totalActions: step,
          failedAtStep: step,
          actionHistory,
          violation: {
            invariantId: "page-crashed",
            message: `Page closed during snapshot after action "${action.id}"`,
            details: { action: action.id },
          },
          allViolations: [],
          failingSnapshot: null,
        };
      }

      // Check all invariants
      const violations = invariants.flatMap((inv) => inv.check(snapshot));

      if (violations.length > 0) {
        return {
          passed: false,
          seed,
          totalActions: step,
          failedAtStep: step,
          actionHistory,
          violation: violations[0],
          allViolations: violations,
          failingSnapshot: snapshot,
        };
      }

      // Run the semantic oracle battery at checkpoints (and on the last step)
      const checkpointDue =
        oracleBattery !== null &&
        oracleBaseline !== null &&
        (step % oracleEveryNActions === 0 || step === maxActions);
      if (checkpointDue) {
        if (verbose) {
          console.log(`  [oracle checkpoint] after step ${step}`);
        }
        try {
          const result = await oracleBattery!.checkpoint(
            this.page,
            oracleBaseline!
          );
          oracleBaseline = result.nextBaseline;
          if (result.violations.length > 0) {
            return {
              passed: false,
              seed,
              totalActions: step,
              failedAtStep: step,
              actionHistory,
              violation: result.violations[0],
              allViolations: result.violations,
              failingSnapshot: snapshot,
            };
          }
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          return {
            passed: false,
            seed,
            totalActions: step,
            failedAtStep: step,
            actionHistory,
            violation: {
              invariantId: "oracle-infrastructure",
              message: `Oracle battery failed to run: ${msg}`,
              details: { error: msg },
            },
            allViolations: [],
            failingSnapshot: snapshot,
          };
        }
      }
    }

    // All actions completed without violations
    return {
      passed: true,
      seed,
      totalActions: maxActions,
      failedAtStep: null,
      actionHistory,
      violation: null,
      allViolations: [],
      failingSnapshot: null,
    };
  }
}
