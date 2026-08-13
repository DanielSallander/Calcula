//! FILENAME: app/e2e/soak/soak-walk.spec.ts
// PURPOSE: A single soak walk: long random action sequence with cheap
//          invariants per action and the semantic oracle battery at
//          checkpoints. On failure the spec SELF-MINIMIZES the trace via
//          delta debugging before failing, and writes a complete failure
//          bundle for the triage/fix loop.
//
// The bundle format, the minimization and the "what did the replays do
// INSTEAD" accounting all live in `walker/failureBundle.ts`, which the
// `invariant` walk uses too — there is ONE implementation of a failure
// report in this tree, not one per harness.
//
// Environment variables (set by tests/soak/soak-runner.mjs):
//   SOAK_SEED         seed for the generator (default: Date.now())
//   SOAK_ACTIONS      max actions (default: 150)
//   SOAK_BUDGET_MS    wall-clock budget for the walk (optional)
//   SOAK_ORACLE_EVERY oracle checkpoint cadence (default: 25)
//   SOAK_RAPID_FIRE   rapid-fire create/delete probability (default: 0.15)
//   SOAK_RESULTS_DIR  output dir (default: app/e2e/results/soak)
//   SOAK_NO_SHRINK    set to "1" to skip in-spec minimization

import * as fs from "node:fs";
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

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SEED = Number(process.env.SOAK_SEED ?? Date.now());
const MAX_ACTIONS = Number(process.env.SOAK_ACTIONS ?? 150);
const BUDGET_MS = process.env.SOAK_BUDGET_MS
  ? Number(process.env.SOAK_BUDGET_MS)
  : undefined;
const ORACLE_EVERY = Number(process.env.SOAK_ORACLE_EVERY ?? 25);
const RAPID_FIRE = Number(process.env.SOAK_RAPID_FIRE ?? 0.15);
const RESULTS_DIR = process.env.SOAK_RESULTS_DIR
  ? path.resolve(process.env.SOAK_RESULTS_DIR)
  : path.resolve(HERE, "../results/soak");
const NO_SHRINK = process.env.SOAK_NO_SHRINK === "1";
/** Family weight boost, e.g. SOAK_CATEGORY_WEIGHTS="chart:8,table:2". */
const CATEGORY_WEIGHTS_SPEC = process.env.SOAK_CATEGORY_WEIGHTS ?? "";
const CATEGORY_WEIGHTS = parseCategoryWeights(CATEGORY_WEIGHTS_SPEC);

test.describe("Soak walk", () => {
  test("random walk maintains semantic oracles", async ({ appPage, grid }) => {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(500);

    console.log(
      `\n  Soak walk: seed=${SEED} actions=${MAX_ACTIONS}` +
        `${BUDGET_MS ? ` budget=${Math.round(BUDGET_MS / 1000)}s` : ""} ` +
        `oracleEvery=${ORACLE_EVERY}` +
        `${CATEGORY_WEIGHTS_SPEC ? ` weights=${CATEGORY_WEIGHTS_SPEC}` : ""}`
    );

    const liveDir = path.join(RESULTS_DIR, "live");
    fs.mkdirSync(liveDir, { recursive: true });

    const runner = new WalkRunner(appPage, grid, {
      source: createGeneratorSource({
        seed: SEED,
        rapidFireProbability: RAPID_FIRE,
        categoryWeights: CATEGORY_WEIGHTS,
      }),
      invariants: ALL_INVARIANTS,
      oracleBattery: new OracleBattery({
        tmpDir: path.join(RESULTS_DIR, "tmp"),
      }),
      oracleEveryNActions: ORACLE_EVERY,
      maxActions: MAX_ACTIONS,
      budgetMs: BUDGET_MS,
      resultsDir: liveDir,
    });

    const result = await runner.run();
    const report = formatWalkReport(result);
    console.log(`\n${report}`);

    if (result.passed) {
      expect(result.passed, report).toBe(true);
      return;
    }

    // ---- Failure: write the bundle and self-minimize ----
    const bundle = await writeFailureBundle({
      result,
      page: appPage,
      resultsDir: RESULTS_DIR,
      harness: "soak",
      seed: SEED,
      // The weights are part of what the seed MEANS: the same seed under a
      // different boost picks different actions, so a replay command that
      // omits them replays a different walk. That is the same class of lie the
      // rapid-fire walk's derived seed already had to be fixed for.
      replayCommand:
        `E2E_MANUAL=1 SOAK_SEED=${SEED} SOAK_ACTIONS=${MAX_ACTIONS} ` +
        `SOAK_ORACLE_EVERY=${ORACLE_EVERY} SOAK_RAPID_FIRE=${RAPID_FIRE} ` +
        `${CATEGORY_WEIGHTS_SPEC ? `SOAK_CATEGORY_WEIGHTS="${CATEGORY_WEIGHTS_SPEC}" ` : ""}` +
        `npx playwright test --project=soak --grep "random walk"`,
      replay: NO_SHRINK ? null : makeReplayFn(appPage, grid, RESULTS_DIR),
      extra: {
        maxActions: MAX_ACTIONS,
        rapidFireProbability: RAPID_FIRE,
        oracleEveryNActions: ORACLE_EVERY,
        budgetMs: BUDGET_MS ?? null,
        categoryWeights: CATEGORY_WEIGHTS ?? null,
      },
    });

    test.info().annotations.push({ type: "soak-failure", description: bundle.report });
    test.info().annotations.push({ type: "soak-failure-dir", description: bundle.dir });
    expect(result.passed, bundle.report).toBe(true);
  });
});

// ============================================================================
// Replay function for the shrinker
// ============================================================================

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
      // Replay verifies at the END of the trace only (one big checkpoint):
      // huge cadence + the runner's final off-cadence checkpoint. Save/reload
      // runs on every checkpoint so saveReload failures reproduce too.
      oracleBattery: new OracleBattery({
        tmpDir: path.join(resultsDir, "tmp"),
        saveReloadEvery: 1,
      }),
      oracleEveryNActions: 1_000_000,
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
