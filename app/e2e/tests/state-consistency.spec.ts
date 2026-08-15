//! FILENAME: app/e2e/tests/state-consistency.spec.ts
// PURPOSE: Invariant-based monkey testing for state consistency bugs.
//          Runs randomized action sequences and checks UI invariants after
//          each action. On failure it MINIMIZES the failing trace and writes
//          a complete failure bundle.
//
// THIS SPEC USED TO HAVE ITS OWN RUNNER, ITS OWN ACTION CATALOG AND ITS OWN
// GENERATOR — a strict subset of the walker's, 27 actions against 59, with no
// trace, no minimiser and no bundle. That is why `state-consistency` was
// classified as monkey flake three times: a failure report that lists action
// IDs and nothing else cannot be replayed, cannot be reduced, and cannot be
// distinguished from noise. The orphaned slicer it was hiding had to be
// reduced BY HAND. The v1 runner (`invariants/runner.ts`), catalog
// (`invariants/actions.ts`), generator (`invariants/actionGenerator.ts`) and
// reporter (`invariants/reporter.ts`) are DELETED; this spec now drives the
// same `WalkRunner` the soak walk drives, over the same catalog, and produces
// the same failure bundle from the same `writeFailureBundle`.
//
// Environment:
//   INVARIANT_SEED            replay a specific walk (default: Date.now()). The
//                             second test uses SEED + 1 so replaying one does
//                             not replay both.
//   INVARIANT_SHRINK_REPLAYS  cap on shrink replays (default 30)
//   INVARIANT_SHRINK_BUDGET_MS  wall-clock budget for the shrink (default 15m)
//   INVARIANT_NO_SHRINK=1     write the bundle but skip minimization

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import { ALL_INVARIANTS } from "../invariants";
import { OracleBattery } from "../oracles";
import {
  WalkRunner,
  createGeneratorSource,
  createTraceSource,
  deepResetForWalk,
  formatWalkReport,
  parseCategoryWeights,
  writeFailureBundle,
} from "../walker";
import type { ActionTrace, WalkResult } from "../walker";

// ============================================================================
// Configuration
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Number of actions per random exploration run */
const ACTIONS_PER_RUN = 75;

/** Time to wait for UI to settle after each action (ms) */
const SETTLE_MS = 250;

/** Run the semantic oracle battery (undo/save-reload/recalc round-trips)
 *  every N actions */
const ORACLE_EVERY_N_ACTIONS = 25;

/**
 * How often the SAVE/RELOAD round-trip runs, in checkpoints.
 *
 * IT MUST BE STATED HERE, and this is why. `OracleBattery` defaults it to 4,
 * and this project reaches 3 checkpoints on the main walk (75 actions / 25) and
 * 2 on the rapid-fire walk (50 / 25). `checkpointCount % 4 === 0` is therefore
 * false at every checkpoint this project can reach, so the save/reload oracle
 * had NEVER run here on any seed — while every run printed its own
 * "[WARNING] the save/reload round-trip never ran" and still reported a clean
 * pass. Measured 2026-08-15; see open-decisions-2026-08.md.
 *
 * Set to the walk's LAST reachable checkpoint so persistence is exercised
 * exactly once per walk (it is the most expensive oracle and it resets the undo
 * stack, so more often would cost the undo oracle its evidence).
 * `WalkRunner.run` now REFUSES a walk whose cadence cannot come due, so this
 * cannot silently rot again.
 */
const SAVE_RELOAD_EVERY_MAIN = 3;   // 75 actions / 25 = 3 checkpoints
const SAVE_RELOAD_EVERY_RAPID = 2;  // 50 actions / 25 = 2 checkpoints

/** Bundles, live traces and the oracle's temp .cala files. */
const RESULTS_DIR = path.resolve(HERE, "../results/invariant");

/**
 * The failure report says "use this seed to replay". It could not be used: the
 * seed was `Date.now()` with no way to inject one, so every reported seed was
 * unreplayable and every invariant failure had to be re-found by luck.
 */
const BASE_SEED = Number(process.env.INVARIANT_SEED ?? Date.now());

/** Shrink budget. Raise both when a failure is worth an hour of reduction. */
const SHRINK_MAX_REPLAYS = Number(process.env.INVARIANT_SHRINK_REPLAYS ?? 30);
const SHRINK_BUDGET_MS = Number(
  process.env.INVARIANT_SHRINK_BUDGET_MS ?? 15 * 60 * 1000
);
const NO_SHRINK = process.env.INVARIANT_NO_SHRINK === "1";

/**
 * Family weight boost, e.g. INVARIANT_CATEGORY_WEIGHTS="chart:8".
 * Part of what the seed means — see the replay commands below.
 */
const CATEGORY_WEIGHTS_SPEC = process.env.INVARIANT_CATEGORY_WEIGHTS ?? "";
const CATEGORY_WEIGHTS = parseCategoryWeights(CATEGORY_WEIGHTS_SPEC);
const WEIGHTS_ENV = CATEGORY_WEIGHTS_SPEC
  ? `INVARIANT_CATEGORY_WEIGHTS="${CATEGORY_WEIGHTS_SPEC}" `
  : "";

// ============================================================================
// Tests
// ============================================================================

test.describe("State consistency (invariant monkey testing)", () => {
  // Generous timeout: many sequential actions, oracle checkpoints, and — on
  // failure — an in-spec ddmin shrink before the test is allowed to fail.
  test.setTimeout(1_500_000);

  test("random action sequence maintains UI invariants", async ({
    appPage,
    grid,
  }) => {
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(500);

    const seed = BASE_SEED;
    console.log(
      `\n  Invariant walk seed: ${seed}` +
        `${CATEGORY_WEIGHTS_SPEC ? ` weights=${CATEGORY_WEIGHTS_SPEC}` : ""}`
    );

    const runner = new WalkRunner(appPage, grid, {
      source: createGeneratorSource({ seed, categoryWeights: CATEGORY_WEIGHTS }),
      invariants: ALL_INVARIANTS,
      oracleBattery: new OracleBattery({
        tmpDir: path.join(RESULTS_DIR, "tmp"),
        saveReloadEvery: SAVE_RELOAD_EVERY_MAIN,
      }),
      oracleEveryNActions: ORACLE_EVERY_N_ACTIONS,
      maxActions: ACTIONS_PER_RUN,
      settleTimeMs: SETTLE_MS,
      resultsDir: path.join(RESULTS_DIR, "live"),
    });

    const result = await runner.run();
    console.log(`\n${formatWalkReport(result)}`);

    if (result.passed) {
      expect(result.passed).toBe(true);
      return;
    }

    const bundle = await writeFailureBundle({
      result,
      page: appPage,
      resultsDir: RESULTS_DIR,
      harness: "invariant",
      seed,
      replayCommand:
        `E2E_MANUAL=1 INVARIANT_SEED=${seed} ${WEIGHTS_ENV}npx playwright test ` +
        `--project=invariant --grep "random action sequence"`,
      replay: NO_SHRINK ? null : makeReplayFn(appPage, grid, RESULTS_DIR),
      shrinkMaxReplays: SHRINK_MAX_REPLAYS,
      shrinkTimeBudgetMs: SHRINK_BUDGET_MS,
      extra: {
        maxActions: ACTIONS_PER_RUN,
        settleTimeMs: SETTLE_MS,
        categoryWeights: CATEGORY_WEIGHTS ?? null,
      },
    });

    test.info().annotations.push({
      type: "invariant-failure",
      description: bundle.report,
    });
    test.info().annotations.push({
      type: "invariant-failure-dir",
      description: bundle.dir,
    });
    expect(result.passed, bundle.report).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Targeted scenario: create-then-delete rapid fire
  // -------------------------------------------------------------------------

  test("rapid create-delete cycles maintain UI invariants", async ({
    appPage,
    grid,
  }) => {
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(500);

    // `+ 1` keeps the two tests on different walks when a seed is given, so
    // replaying one does not replay the other.
    const seed = BASE_SEED + 1;
    console.log(
      `\n  Rapid-fire walk seed: ${seed}` +
        `${CATEGORY_WEIGHTS_SPEC ? ` weights=${CATEGORY_WEIGHTS_SPEC}` : ""}`
    );

    const runner = new WalkRunner(appPage, grid, {
      source: createGeneratorSource({
        seed,
        rapidFireProbability: 0.5,
        categoryWeights: CATEGORY_WEIGHTS,
      }),
      invariants: ALL_INVARIANTS,
      oracleBattery: new OracleBattery({
        tmpDir: path.join(RESULTS_DIR, "tmp"),
        saveReloadEvery: SAVE_RELOAD_EVERY_RAPID,
      }),
      oracleEveryNActions: ORACLE_EVERY_N_ACTIONS,
      maxActions: 50,
      settleTimeMs: SETTLE_MS,
      resultsDir: path.join(RESULTS_DIR, "live-rapid"),
    });

    const result = await runner.run();
    console.log(`\n${formatWalkReport(result)}`);

    if (result.passed) {
      expect(result.passed).toBe(true);
      return;
    }

    const bundle = await writeFailureBundle({
      result,
      page: appPage,
      resultsDir: RESULTS_DIR,
      harness: "invariant-rapid-fire",
      seed,
      // The spec derives this walk's seed as INVARIANT_SEED + 1, so the command
      // that replays it passes the BASE seed, not this one. Printing the seed
      // that actually drove the generator and a command that would produce a
      // different walk is how a bundle lies to the next reader.
      replayCommand:
        `E2E_MANUAL=1 INVARIANT_SEED=${seed - 1} ${WEIGHTS_ENV}npx playwright test ` +
        `--project=invariant --grep "rapid create-delete"`,
      replay: NO_SHRINK ? null : makeReplayFn(appPage, grid, RESULTS_DIR),
      shrinkMaxReplays: SHRINK_MAX_REPLAYS,
      shrinkTimeBudgetMs: SHRINK_BUDGET_MS,
      extra: {
        maxActions: 50,
        settleTimeMs: SETTLE_MS,
        rapidFireProbability: 0.5,
        derivedSeed: `INVARIANT_SEED + 1 = ${seed}`,
        categoryWeights: CATEGORY_WEIGHTS ?? null,
      },
    });

    test.info().annotations.push({
      type: "invariant-failure",
      description: bundle.report,
    });
    test.info().annotations.push({
      type: "invariant-failure-dir",
      description: bundle.dir,
    });
    expect(result.passed, bundle.report).toBe(true);
  });
});

// ============================================================================
// Replay function for the shrinker
// ============================================================================

/**
 * Replays a candidate trace from a deep-reset workbook and reports what
 * happened. Identical in shape to the soak walk's: one runner, one catalog,
 * one reset, one definition of "did this trace fail".
 */
function makeReplayFn(
  appPage: Parameters<typeof deepResetForWalk>[0],
  grid: ConstructorParameters<typeof WalkRunner>[1],
  resultsDir: string
) {
  return async (trace: ActionTrace) => {
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(300);

    const runner = new WalkRunner(appPage, grid, {
      source: createTraceSource(trace),
      invariants: ALL_INVARIANTS,
      oracleBattery: new OracleBattery({
        tmpDir: path.join(resultsDir, "tmp"),
        saveReloadEvery: 1,
      }),
      oracleEveryNActions: 1_000_000, // single oracle checkpoint at trace end
      maxActions: trace.actions.length,
      settleTimeMs: 150,
      verbose: false,
    });

    const result: WalkResult = await runner.run();
    return {
      failed: !result.passed,
      violationId: result.violation?.invariantId,
    };
  };
}
