//! FILENAME: app/e2e/__tests__/shrinkSkip.test.ts
// PURPOSE: Some verdicts must never be handed to the trace minimizer. Prove the
//          list is right and that it fires.
// CONTEXT: MEASURED 2026-08-16, invariant seed 20260816102. The rapid-fire walk
//          failed `undo-evidence-missing` and the spec then ran ddmin over the
//          50-action trace. Sixteen-plus replays, EVERY ONE "-> pass".
//
//          It could not have gone any other way. All three replay paths build
//          their `OracleBattery` with `requireUndoEvidence: false` -- correctly,
//          because a one-action shrink candidate must not be judged on undo
//          evidence -- so the verdict being minimized is one the replay function
//          is structurally incapable of returning. ddmin reduced nothing, burned
//          up to 30 replays and a 15-minute budget, and would have written a
//          bundle whose "could not reduce" reads like a failed reproduction.
//
//          It is also the wrong question to ask. `undo-evidence-missing` is a
//          property of the walk's CONFIGURATION -- oracle cadence measured
//          against how often the action mix ends the undo history -- not of the
//          trace. There is no smaller reproducer to find.
//
//          Two individually-correct decisions combined into a broken one, which
//          is the class of defect only an integration pass catches.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skipShrinkReason } from "../walker/failureBundle";

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("skipShrinkReason", () => {
  it("refuses to minimize `undo-evidence-missing`", () => {
    const reason = skipShrinkReason("undo-evidence-missing");
    expect(reason).not.toBeNull();
  });

  it("says BOTH why it is impossible and why it is the wrong question", () => {
    // A skip reason that only said "not minimized" would send the reader
    // looking for a shrink bug that does not exist.
    const reason = skipShrinkReason("undo-evidence-missing")!;
    expect(reason).toContain("requireUndoEvidence: false");
    expect(reason).toMatch(/CONFIGURATION/);
    expect(reason).toMatch(/not of the trace/);
  });

  it("still refuses the two it always refused", () => {
    expect(skipShrinkReason("page-crashed")).not.toBeNull();
    expect(skipShrinkReason("oracle-infrastructure")).not.toBeNull();
  });

  it("does NOT refuse an ordinary product violation", () => {
    // The other direction. A skip list that grew to cover everything would
    // silently retire the minimizer.
    for (const id of [
      "undo-round-trip",
      "save-reload-round-trip",
      "recalc-consistency",
      "no-js-exceptions",
      "unknown",
    ]) {
      expect(skipShrinkReason(id), id).toBeNull();
    }
  });
});

describe("the premise: every replay path really does waive undo evidence", () => {
  // If one of these ever started REQUIRING undo evidence, minimizing
  // `undo-evidence-missing` would become possible and the skip above would be
  // over-broad. Read from source so the premise cannot drift unnoticed.
  const replayPaths = [
    "tests/state-consistency.spec.ts",
    "soak/soak-walk.spec.ts",
    "soak/replay-trace.spec.ts",
  ];

  for (const rel of replayPaths) {
    it(`${rel} waives it on the replay path`, () => {
      const src = fs.readFileSync(path.join(E2E_DIR, rel), "utf-8");
      expect(src).toContain("requireUndoEvidence: false");
    });
  }

  it("the GENERATED walks do not waive it", () => {
    // The requirement has to stay on the walks that are actually asked about
    // undo, or the meta-assertion guards nothing.
    const src = fs.readFileSync(
      path.join(E2E_DIR, "tests/state-consistency.spec.ts"),
      "utf-8",
    );
    const waivers = src.split("requireUndoEvidence: false").length - 1;
    expect(
      waivers,
      "state-consistency.spec.ts should waive undo evidence exactly once -- on " +
        "the shrink replay function, never on the two generated walks",
    ).toBe(1);
  });
});
