//! FILENAME: app/e2e/soak/soak-walk.spec.ts
// PURPOSE: A single soak walk: long random action sequence with cheap
//          invariants per action and the semantic oracle battery at
//          checkpoints. On failure the spec SELF-MINIMIZES the trace via
//          delta debugging before failing, and writes a complete failure
//          bundle for the triage/fix loop:
//
//            app/e2e/results/soak/failures/<runId>-<violationId>/
//              trace.json            original failing trace
//              minimized.trace.json  ddmin-reduced repro
//              failure.json          violation + digest diff + metadata
//              report.md             human-readable report
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
  minimizeTrace,
  saveTrace,
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
// "0" routes object-script mounts through the legacy main-thread path; anything
// else (incl. unset) uses the Phase 3 worker realm. Same seed on both = the
// worker-vs-legacy dual-run gate.
const SCRIPT_WORKER = process.env.SOAK_SCRIPT_WORKER;

test.describe("Soak walk", () => {
  test("random walk maintains semantic oracles", async ({ appPage, grid }) => {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(500);

    // Select the object-script execution path for the worker-vs-legacy dual-run.
    // useWorkerRealm() reads this per mountScript, so setting it before any
    // script.shape-mount action routes every mount consistently.
    await appPage.evaluate((flag) => {
      try {
        if (flag === "0") window.localStorage.setItem("calcula.scriptWorker", "0");
        else window.localStorage.removeItem("calcula.scriptWorker");
      } catch {
        /* localStorage unavailable */
      }
    }, SCRIPT_WORKER ?? "");
    console.log(
      `  Object-script path: ${SCRIPT_WORKER === "0" ? "LEGACY (main-thread)" : "worker realm"}`,
    );

    console.log(
      `\n  Soak walk: seed=${SEED} actions=${MAX_ACTIONS}` +
        `${BUDGET_MS ? ` budget=${Math.round(BUDGET_MS / 1000)}s` : ""} ` +
        `oracleEvery=${ORACLE_EVERY}`
    );

    const liveDir = path.join(RESULTS_DIR, "live");
    fs.mkdirSync(liveDir, { recursive: true });

    const runner = new WalkRunner(appPage, grid, {
      source: createGeneratorSource({ seed: SEED, rapidFireProbability: RAPID_FIRE }),
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
    const violationId = result.violation?.invariantId ?? "unknown";
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${violationId}`;
    const failureDir = path.join(RESULTS_DIR, "failures", runId);
    fs.mkdirSync(failureDir, { recursive: true });

    saveTrace(result.trace, path.join(failureDir, "trace.json"));
    fs.writeFileSync(
      path.join(failureDir, "failure.json"),
      JSON.stringify(
        {
          seed: SEED,
          violationId,
          violation: result.violation,
          allViolations: result.allViolations,
          failedAtStep: result.failedAtStep,
          totalActions: result.totalActions,
          checkpoints: result.checkpoints,
          replayConfirmed: false,
          minimized: false,
        },
        null,
        2
      ),
      "utf8"
    );
    fs.writeFileSync(path.join(failureDir, "report.md"), report, "utf8");

    const crashed =
      violationId === "page-crashed" || violationId === "oracle-infrastructure";

    if (!NO_SHRINK && !crashed) {
      console.log(`\n  Minimizing failing trace (${result.trace.actions.length} actions)...`);
      const replay = makeReplayFn(appPage, grid, RESULTS_DIR);
      const shrink = await minimizeTrace(replay, result.trace, violationId, {
        maxReplays: 30,
        timeBudgetMs: 15 * 60 * 1000,
      });

      saveTrace(shrink.minimized, path.join(failureDir, "minimized.trace.json"));
      const failureJsonPath = path.join(failureDir, "failure.json");
      const failureJson = JSON.parse(fs.readFileSync(failureJsonPath, "utf8"));
      failureJson.minimized = true;
      failureJson.minimizedActionCount = shrink.minimized.actions.length;
      failureJson.replayConfirmed = shrink.stillFails;
      failureJson.shrinkReplays = shrink.replays;
      fs.writeFileSync(failureJsonPath, JSON.stringify(failureJson, null, 2), "utf8");

      console.log(
        `  Minimized: ${result.trace.actions.length} -> ` +
          `${shrink.minimized.actions.length} actions ` +
          `(${shrink.replays} replays, confirmed=${shrink.stillFails})`
      );
    }

    test.info().annotations.push({ type: "soak-failure", description: report });
    test.info().annotations.push({ type: "soak-failure-dir", description: failureDir });
    expect(result.passed, report).toBe(true);
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
