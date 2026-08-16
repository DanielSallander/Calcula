//! FILENAME: app/e2e/__tests__/oracleCadenceReachable.test.ts
// PURPOSE: FAIL the build when a walk is configured so that its save/reload
//          round-trip oracle can never come due -- the state the `invariant`
//          project shipped in, undetected, for the whole correctness programme.
//
// WHAT HAPPENED, MEASURED 2026-08-15.
// `OracleBattery` fires the save/reload oracle when
// `checkpointCount % saveReloadEvery === 0`, and defaults `saveReloadEvery` to
// 4. The `invariant` project runs:
//
//     main walk        75 actions / oracleEvery 25  ->  3 checkpoints
//     rapid-fire walk  50 actions / oracleEvery 25  ->  2 checkpoints
//
// 3 % 4 and 2 % 4 are never 0, so the oracle had NEVER run in that project on
// ANY seed. Two cold runs that day (seeds 20260811 and 20260815) each printed
//
//     save/reload round-trip: 0 run(s)
//     [WARNING] the save/reload round-trip never ran - persistence was not
//     exercised
//
// and each reported `2 passed`. The warning had been there the whole time and
// read like bad luck, because nothing said it was ARITHMETIC.
//
// This file pins two things: the pure arithmetic, and the CONFIGURATION of the
// real spec -- read out of its source, so raising ACTIONS_PER_RUN or lowering
// the cadence in that file cannot quietly make the oracle unreachable again.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeUnreachableSaveReloadCadence,
  plannedCheckpointCount,
} from "../oracles";

const SPEC = join(process.cwd(), "e2e", "tests", "state-consistency.spec.ts");

/** Read a `const NAME = <number>` out of the spec, so the test cannot drift. */
function constant(source: string, name: string): number {
  const m = new RegExp(`const ${name} = (\\d+)`).exec(source);
  if (!m) {
    throw new Error(
      `Could not find \`const ${name}\` in ${SPEC}. If it was renamed, point ` +
        `this test at the new name -- do NOT replace the read with a literal, ` +
        `which is the drift this file exists to prevent.`,
    );
  }
  return Number(m[1]);
}

describe("plannedCheckpointCount", () => {
  it("counts the checkpoints a walk can actually reach", () => {
    expect(plannedCheckpointCount(75, 25)).toBe(3);
    expect(plannedCheckpointCount(50, 25)).toBe(2);
    expect(plannedCheckpointCount(150, 25)).toBe(6);
  });

  it("rounds UP, because the walker also checkpoints at the last step", () => {
    // 60 actions at a cadence of 25 checkpoints at 25, 50 and 60.
    expect(plannedCheckpointCount(60, 25)).toBe(3);
  });

  it("is now an EXACT bound for a completed walk, which it was not", () => {
    // The docstring promises this over-counts and never under-counts, and that
    // was false for every walk whose length is not a multiple of the cadence:
    // `WalkRunner` fired the in-loop checkpoint at the last step AND then the
    // "final off-cadence" one at the SAME step, so a 60-action walk at cadence
    // 25 reached FOUR checkpoints against the three predicted here -- a second,
    // identical battery run (digests, undo round-trip and save/reload) over a
    // state nothing had touched in between. `lastCheckpointStep` in
    // `WalkRunner.run` now suppresses the duplicate, so the arithmetic below is
    // the count a completed walk actually reaches.
    expect(plannedCheckpointCount(40, 25)).toBe(2);
    expect(plannedCheckpointCount(60, 25)).toBe(3);
    expect(plannedCheckpointCount(25, 25)).toBe(1);
  });

  it("is zero for a degenerate configuration rather than NaN or Infinity", () => {
    expect(plannedCheckpointCount(0, 25)).toBe(0);
    expect(plannedCheckpointCount(75, 0)).toBe(0);
  });
});

describe("describeUnreachableSaveReloadCadence", () => {
  it("names the defect that shipped: cadence 4, three checkpoints", () => {
    const message = describeUnreachableSaveReloadCadence(4, 3);
    expect(message).not.toBeNull();
    expect(message).toContain("can NEVER run");
    // The three numbers a reader needs are all in the sentence.
    expect(message).toContain("every 4th checkpoint");
    expect(message).toContain("at most 3");
    // And it prescribes the fix rather than just complaining.
    expect(message).toContain("saveReloadEvery: 3");
  });

  it("is silent when the cadence is reachable", () => {
    expect(describeUnreachableSaveReloadCadence(3, 3)).toBeNull();
    expect(describeUnreachableSaveReloadCadence(2, 2)).toBeNull();
    expect(describeUnreachableSaveReloadCadence(4, 6)).toBeNull();
  });

  it("treats 0 as a deliberate opt-out, not as unreachable", () => {
    // `saveReloadEvery: 0` is the documented way to say "this walk does not
    // exercise persistence". Refusing it would turn an explicit decision into
    // an error.
    expect(describeUnreachableSaveReloadCadence(0, 3)).toBeNull();
    expect(describeUnreachableSaveReloadCadence(0, 0)).toBeNull();
  });

  it("fires on the exact boundary, one checkpoint short", () => {
    // The sabotage direction: the off-by-one that would let it back in.
    expect(describeUnreachableSaveReloadCadence(4, 4)).toBeNull();
    expect(describeUnreachableSaveReloadCadence(5, 4)).not.toBeNull();
  });
});

describe("the invariant project's own configuration", () => {
  const source = readFileSync(SPEC, "utf8");

  it("reaches its save/reload cadence on the MAIN walk", () => {
    const planned = plannedCheckpointCount(
      constant(source, "ACTIONS_PER_RUN"),
      constant(source, "ORACLE_EVERY_N_ACTIONS"),
    );
    const message = describeUnreachableSaveReloadCadence(
      constant(source, "SAVE_RELOAD_EVERY_MAIN"),
      planned,
    );
    expect(message, message ?? "").toBeNull();
  });

  it("reaches its save/reload cadence on the RAPID-FIRE walk", () => {
    // The rapid-fire walk's length is a literal in its own WalkRunner options
    // (`maxActions: 50`), not a named constant, so it is read as one.
    const rapid = /maxActions: (\d+),\n\s+settleTimeMs: SETTLE_MS,\n\s+resultsDir: path\.join\(RESULTS_DIR, "live-rapid"\)/.exec(
      source,
    );
    expect(
      rapid,
      "could not find the rapid-fire walk's maxActions in the spec",
    ).not.toBeNull();
    const planned = plannedCheckpointCount(
      Number(rapid![1]),
      // The rapid-fire walk has its OWN cadence and must be checked against it.
      // Reading ORACLE_EVERY_N_ACTIONS here (the main walk's) would have gone on
      // passing while the rapid walk's real cadence went unchecked.
      constant(source, "RAPID_ORACLE_EVERY_N_ACTIONS"),
    );
    const message = describeUnreachableSaveReloadCadence(
      constant(source, "SAVE_RELOAD_EVERY_RAPID"),
      planned,
    );
    expect(message, message ?? "").toBeNull();
  });

  it("gives the RAPID-FIRE walk a cadence its undo window can survive", () => {
    // The number this guards, and why it is not arbitrary. `WalkRunner` rebases
    // the undo baseline after every NON-checkpoint action, so a window is only
    // lost when the checkpoint's own action ends the undo history. Measured on
    // seed 20260816102: 11 history-enders in 50 actions, i.e. ~0.22 per action.
    // With the two checkpoints this walk used to get, ~5% of seeds produced
    // ZERO undo evidence and failed `undo-evidence-missing` -- which is how a
    // fresh seed turned the invariant project red on 2026-08-16.
    //
    // The assertion is on the SHAPE of the fix (many short windows), not on the
    // literal 5, so re-tuning stays possible and going back to a handful of long
    // windows does not.
    const rapidCadence = constant(source, "RAPID_ORACLE_EVERY_N_ACTIONS");
    const mainCadence = constant(source, "ORACLE_EVERY_N_ACTIONS");
    expect(
      rapidCadence,
      "the rapid-fire walk churns objects at rapidFireProbability 0.5, so it " +
        "ends the undo history far more often than the main walk and needs a " +
        "SHORTER cadence, not the same one",
    ).toBeLessThan(mainCadence);

    const rapid = /maxActions: (\d+),\n\s+settleTimeMs: SETTLE_MS,\n\s+resultsDir: path\.join\(RESULTS_DIR, "live-rapid"\)/.exec(
      source,
    );
    expect(rapid).not.toBeNull();
    const windows = plannedCheckpointCount(Number(rapid![1]), rapidCadence);
    // P(no evidence) ~= 0.22^windows. Eight windows is ~2e-6; two was ~5e-2.
    expect(
      windows,
      "too few undo windows for the walk to be reliably decidable",
    ).toBeGreaterThanOrEqual(8);
  });

  it("states the cadence EXPLICITLY rather than inheriting the default", () => {
    // Inheriting `OracleBattery`'s default of 4 is exactly how this broke. Both
    // walks must name their own number.
    const batteries = [...source.matchAll(/new OracleBattery\(\{([\s\S]*?)\}\)/g)];
    expect(batteries.length).toBeGreaterThanOrEqual(2);
    for (const [, body] of batteries) {
      expect(
        body,
        "an OracleBattery in state-consistency.spec.ts does not state " +
          "`saveReloadEvery`, so it inherits the default of 4 - which this " +
          "project's walks cannot reach",
      ).toContain("saveReloadEvery");
    }
  });
});
