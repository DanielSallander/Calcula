//! FILENAME: app/e2e/tests/state-consistency.spec.ts
// PURPOSE: Invariant-based monkey testing for state consistency bugs.
//          Runs randomized action sequences and checks UI invariants after
//          each action. Any failure prints the seed for deterministic replay.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import {
  ALL_INVARIANTS,
  createActionGenerator,
  InvariantRunner,
  formatReport,
} from "../invariants";
import { OracleBattery } from "../oracles";
import { resetToNewWorkbook } from "../helpers/screenshots";

// ============================================================================
// Configuration
// ============================================================================

/** Number of actions per random exploration run */
const ACTIONS_PER_RUN = 75;

/** Time to wait for UI to settle after each action (ms) */
const SETTLE_MS = 250;

/** Run the semantic oracle battery (undo/save-reload/recalc round-trips)
 *  every N actions */
const ORACLE_EVERY_N_ACTIONS = 25;

/** Temp dir for the save/reload oracle's .cala files */
const ORACLE_TMP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../results/oracle-tmp"
);

// ============================================================================
// Tests
// ============================================================================

test.describe("State consistency (invariant monkey testing)", () => {
  // Give these tests a generous timeout — they run many sequential actions
  test.setTimeout(120_000);

  test("random action sequence maintains UI invariants", async ({
    appPage,
    grid,
  }) => {
    await resetToNewWorkbook(appPage);
    await appPage.waitForTimeout(500);

    const seed = Date.now();
    console.log(`\n  Invariant test seed: ${seed}`);

    const runner = new InvariantRunner(appPage, grid, {
      invariants: ALL_INVARIANTS,
      actionGenerator: createActionGenerator({ seed }),
      maxActions: ACTIONS_PER_RUN,
      settleTimeMs: SETTLE_MS,
      oracleBattery: new OracleBattery({ tmpDir: ORACLE_TMP_DIR }),
      oracleEveryNActions: ORACLE_EVERY_N_ACTIONS,
    });

    const result = await runner.run();
    const report = formatReport(result);
    console.log(`\n${report}`);

    if (!result.passed) {
      // Attach the full report as a test annotation for Playwright HTML report
      test.info().annotations.push({
        type: "invariant-failure",
        description: report,
      });
    }

    expect(result.passed, report).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Targeted scenario: create-then-delete rapid fire
  // -------------------------------------------------------------------------

  test("rapid create-delete cycles maintain UI invariants", async ({
    appPage,
    grid,
  }) => {
    await resetToNewWorkbook(appPage);
    await appPage.waitForTimeout(500);

    const seed = Date.now() + 1;
    console.log(`\n  Rapid-fire test seed: ${seed}`);

    const runner = new InvariantRunner(appPage, grid, {
      invariants: ALL_INVARIANTS,
      actionGenerator: createActionGenerator({
        seed,
        rapidFireProbability: 0.5, // 50% chance of rapid-fire pairs
      }),
      maxActions: 50,
      settleTimeMs: SETTLE_MS,
      oracleBattery: new OracleBattery({ tmpDir: ORACLE_TMP_DIR }),
      oracleEveryNActions: ORACLE_EVERY_N_ACTIONS,
    });

    const result = await runner.run();
    const report = formatReport(result);
    console.log(`\n${report}`);

    expect(result.passed, report).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Regression replay template — uncomment and set a failing seed to debug
  // -------------------------------------------------------------------------

  // test("replay regression seed XXXXXXXXX", async ({ appPage, grid }) => {
  //   await resetToNewWorkbook(appPage);
  //   await appPage.waitForTimeout(500);
  //
  //   const seed = XXXXXXXXX; // <-- paste failing seed here
  //   console.log(`\n  Replay seed: ${seed}`);
  //
  //   const runner = new InvariantRunner(appPage, grid, {
  //     invariants: ALL_INVARIANTS,
  //     actionGenerator: createActionGenerator({ seed }),
  //     maxActions: ACTIONS_PER_RUN,
  //     settleTimeMs: SETTLE_MS,
  //   });
  //
  //   const result = await runner.run();
  //   const report = formatReport(result);
  //   console.log(`\n${report}`);
  //
  //   expect(result.passed, report).toBe(true);
  // });
});
