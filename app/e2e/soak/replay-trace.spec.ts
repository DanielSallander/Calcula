//! FILENAME: app/e2e/soak/replay-trace.spec.ts
// PURPOSE: Replay an explicit action trace and run the oracle battery at the
//          end. Used by the soak runner for:
//            - fix validation (the minimized repro must PASS after a fix)
//            - manual reproduction of a ledgered bug
//
// Environment variables:
//   SOAK_TRACE        path to a .trace.json file (required)
//   SOAK_EXPECT_FAIL  "1" to assert the trace still FAILS (repro check),
//                     otherwise the trace must PASS (fix validation).
//   SOAK_RESULTS_DIR  output dir (default: app/e2e/results/soak)

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import { ALL_INVARIANTS } from "../invariants";
import { OracleBattery } from "../oracles";
import {
  WalkRunner,
  createTraceSource,
  deepResetForWalk,
  formatWalkReport,
  loadTrace,
} from "../walker";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TRACE_PATH = process.env.SOAK_TRACE;
const EXPECT_FAIL = process.env.SOAK_EXPECT_FAIL === "1";
const RESULTS_DIR = process.env.SOAK_RESULTS_DIR
  ? path.resolve(process.env.SOAK_RESULTS_DIR)
  : path.resolve(HERE, "../results/soak");

test.describe("Trace replay", () => {
  test.skip(!TRACE_PATH, "SOAK_TRACE env var not set");

  test("replayed trace meets oracle expectations", async ({ appPage, grid }) => {
    const trace = loadTrace(TRACE_PATH!);
    console.log(
      `\n  Replaying trace: ${TRACE_PATH} (${trace.actions.length} actions, ` +
        `expect ${EXPECT_FAIL ? "FAIL" : "PASS"})`
    );

    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(300);

    const runner = new WalkRunner(appPage, grid, {
      source: createTraceSource(trace),
      invariants: ALL_INVARIANTS,
      oracleBattery: new OracleBattery({
        tmpDir: path.join(RESULTS_DIR, "tmp"),
        saveReloadEvery: 1,
      }),
      oracleEveryNActions: 1_000_000, // single oracle checkpoint at trace end
      maxActions: trace.actions.length,
      settleTimeMs: 200,
    });

    const result = await runner.run();
    const report = formatWalkReport(result);
    console.log(`\n${report}`);

    if (EXPECT_FAIL) {
      expect(result.passed, `Trace was expected to still FAIL (repro check) but passed.`).toBe(false);
    } else {
      expect(result.passed, report).toBe(true);
    }
  });
});
