//! FILENAME: app/e2e/soak/shrinker-selftest.spec.ts
// PURPOSE: "The detector actually fires" — for the trace minimiser, against
//          the REAL app.
//
// The unit tier (`walker/__tests__/shrinker.test.ts`) proves the ddmin
// algorithm reduces a trace given a replay predicate. It cannot prove the
// thing that actually matters here: that a replay against the live product,
// through `deepResetForWalk` + `WalkRunner` + `createTraceSource`, is faithful
// enough for reduction to converge. Every previous failure of this harness was
// a failure of exactly that — replay fidelity, not arithmetic.
//
// So this spec plants a KNOWN failure with a KNOWN minimum and asserts the
// minimiser finds it:
//
//   trace   = 12 x cell.click, table.create, 12 x cell.click   (25 actions)
//   canary  = "a table exists"                                 (fires at once)
//   minimum = [table.create]                                   (exactly 1)
//
// If this ever fails, the minimiser's answers about real defects are worthless,
// and that is worth ten minutes of a soak run to know.
//
//   E2E_MANUAL=1 npx playwright test --project=soak --grep "minimiser"

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import type { Invariant } from "../invariants";
import {
  WalkRunner,
  createTraceSource,
  deepResetForWalk,
  minimizeTrace,
} from "../walker";
import type { ActionInstance, ActionTrace } from "../walker";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(HERE, "../results/soak");

/** Cells this spec clicks. Any ref works; they are pure filler. */
const FILLER_REFS = ["A1", "B2", "C3", "D4", "E5", "F6", "G7", "H8", "A2", "B3", "C4", "D5"];

/**
 * The planted failure: "a table exists" is a state the walk deliberately
 * reaches, and only `table.create` can reach it. A canary rather than a real
 * invariant, because a self-test that depends on a real defect stops working
 * the day the defect is fixed.
 */
const tableCanary: Invariant = {
  id: "selftest-canary-table-exists",
  description: "Planted failure for the minimiser self-test: fires once a table exists",
  check(snapshot) {
    if (snapshot.logical.tables.length === 0) return [];
    return [
      {
        invariantId: "selftest-canary-table-exists",
        message: `Planted canary: ${snapshot.logical.tables.length} table(s) exist`,
        details: { tableCount: snapshot.logical.tables.length },
      },
    ];
  },
};

function plantedTrace(): ActionTrace {
  const actions: ActionInstance[] = [];
  for (const ref of FILLER_REFS) actions.push({ id: "cell.click", params: { ref } });
  actions.push({ id: "table.create", params: {} });
  for (const ref of FILLER_REFS) actions.push({ id: "cell.click", params: { ref } });
  return {
    version: 1,
    seed: null,
    startedAt: new Date().toISOString(),
    actions,
  };
}

test.describe("Trace minimiser self-test", () => {
  test.setTimeout(1_500_000);

  test("the minimiser reduces a planted 25-action failure to its 1-action cause", async ({
    appPage,
    grid,
  }) => {
    const planted = plantedTrace();
    expect(planted.actions.length).toBe(25);

    // --- Replay function: exactly the one the real bundles use ---
    const replay = async (candidate: ActionTrace) => {
      await deepResetForWalk(appPage);
      await appPage.waitForTimeout(300);

      const runner = new WalkRunner(appPage, grid, {
        source: createTraceSource(candidate),
        invariants: [tableCanary],
        // No oracle battery: this measures REPLAY FIDELITY, and a save/reload
        // round-trip would add minutes per replay without changing the answer.
        oracleBattery: null,
        maxActions: Math.max(1, candidate.actions.length),
        settleTimeMs: 120,
        verbose: false,
      });

      const result = await runner.run();
      return {
        failed: !result.passed,
        violationId: result.violation?.invariantId,
      };
    };

    // --- The planted trace must fail before anything is claimed about it ---
    const first = await replay(planted);
    expect(
      first.failed,
      "the planted trace did not fail — the canary or table.create is broken, " +
        "so nothing this test says about the minimiser means anything"
    ).toBe(true);
    expect(first.violationId).toBe("selftest-canary-table-exists");

    // --- Minimize ---
    const shrink = await minimizeTrace(
      replay,
      planted,
      "selftest-canary-table-exists",
      { maxReplays: 40, timeBudgetMs: 20 * 60 * 1000 }
    );

    console.log(
      `\n  [minimiser self-test] ${planted.actions.length} -> ` +
        `${shrink.minimized.actions.length} actions in ${shrink.replays} replays ` +
        `(verdict=${shrink.verdict}, other outcomes=${JSON.stringify(shrink.otherOutcomes)})\n` +
        `  minimized: ${shrink.minimized.actions.map((a) => a.id).join(", ")}\n` +
        `  results dir: ${RESULTS_DIR}`
    );

    expect(shrink.verdict, "the reduced trace must be re-confirmed to fail").toBe(
      "confirmed"
    );
    expect(shrink.minimized.actions.map((a) => a.id)).toEqual(["table.create"]);
    expect(shrink.truncated).toBe(false);
  });
});
