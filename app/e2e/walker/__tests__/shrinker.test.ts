//! FILENAME: app/e2e/walker/__tests__/shrinker.test.ts
// PURPOSE: The trace minimiser's own "the detector actually fires" self-test.
//
// This file exists because the minimiser shipped with a defect that made it
// discard its own answer, and nothing in the tree could have caught it: the
// only way to run the shrinker was to launch the whole app, produce a real
// failing 150-action walk, and read a console line. A minimiser is a pure
// function of (trace, replay predicate) — it is testable in milliseconds, and
// until now it never was.
//
// Vitest picks this up because `vitest.config.ts` includes `e2e/**/*.test.ts`;
// Playwright does not, because every project matches `*.spec.ts`.

import { describe, expect, it } from "vitest";
import { minimizeTrace } from "../shrinker";
import type { ReplayOutcome } from "../shrinker";
import type { ActionInstance, ActionTrace } from "../trace";

// ============================================================================
// Fixtures
// ============================================================================

function action(id: string, params: Record<string, unknown> = {}): ActionInstance {
  return { id, params };
}

function trace(actions: ActionInstance[]): ActionTrace {
  return {
    version: 1,
    seed: 12345,
    startedAt: "2026-08-11T00:00:00.000Z",
    actions,
  };
}

/** A 75-action walk with the two actions that matter buried in the middle. */
function buriedPairTrace(): ActionTrace {
  const actions: ActionInstance[] = [];
  for (let i = 0; i < 40; i++) actions.push(action("cell.click", { ref: `A${i + 1}` }));
  actions.push(action("slicer.create"));
  for (let i = 0; i < 20; i++) actions.push(action("format.bold"));
  actions.push(action("slicer.delete"));
  for (let i = 0; i < 13; i++) actions.push(action("cell.escape"));
  return trace(actions);
}

/**
 * The failure predicate: the walk fails when a slicer is created and then
 * deleted (the orphaned-slicer shape this harness actually hunts). Everything
 * else is filler.
 */
function createThenDeleteReplay(violationId: string) {
  const replays: ActionTrace[] = [];
  const replay = async (candidate: ActionTrace): Promise<ReplayOutcome> => {
    replays.push(candidate);
    const ids = candidate.actions.map((a) => a.id);
    const created = ids.indexOf("slicer.create");
    const deleted = ids.indexOf("slicer.delete");
    const failed = created !== -1 && deleted !== -1 && deleted > created;
    return failed ? { failed: true, violationId } : { failed: false };
  };
  return { replay, replays };
}

// ============================================================================
// Reduction
// ============================================================================

describe("minimizeTrace — reduction", () => {
  it("reduces a 75-action walk to the 2 actions that cause the failure", async () => {
    const failing = buriedPairTrace();
    expect(failing.actions.length).toBe(75);

    const { replay } = createThenDeleteReplay("contextual-ribbon-tabs");
    const result = await minimizeTrace(
      replay,
      failing,
      "contextual-ribbon-tabs",
      { verbose: false, maxReplays: 400 }
    );

    // The known minimum: create then delete, in that order, and nothing else.
    expect(result.minimized.actions.map((a) => a.id)).toEqual([
      "slicer.create",
      "slicer.delete",
    ]);
    expect(result.verdict).toBe("confirmed");
    expect(result.truncated).toBe(false);
  });

  it("preserves action order and parameters in the reduced trace", async () => {
    const failing = trace([
      action("cell.click", { ref: "A1" }),
      action("slicer.create", { columns: 3 }),
      action("cell.click", { ref: "B2" }),
      action("slicer.delete", { index: 0 }),
      action("cell.click", { ref: "C3" }),
    ]);
    const { replay } = createThenDeleteReplay("v");
    const result = await minimizeTrace(replay, failing, "v", { verbose: false });

    expect(result.minimized.actions).toEqual([
      action("slicer.create", { columns: 3 }),
      action("slicer.delete", { index: 0 }),
    ]);
    // Metadata (seed, version) rides along so the reduced trace is replayable.
    expect(result.minimized.seed).toBe(12345);
    expect(result.minimized.version).toBe(1);
  });

  it("never removes the last action — a 1-action trace is already minimal", async () => {
    const failing = trace([action("slicer.create")]);
    const replay = async (): Promise<ReplayOutcome> => ({
      failed: true,
      violationId: "v",
    });
    const result = await minimizeTrace(replay, failing, "v", { verbose: false });
    expect(result.minimized.actions.length).toBe(1);
    expect(result.verdict).toBe("confirmed");
  });
});

// ============================================================================
// The verdict: a shrink must not claim a confirmation it never ran
// ============================================================================

describe("minimizeTrace — verdict", () => {
  /**
   * REGRESSION. `stillFails` was initialised to `true` and only assigned by the
   * final confirmation replay, which is skipped the moment the replay cap or
   * the time budget is exhausted — the ORDINARY outcome on a long trace. A
   * shrink that had reproduced nothing therefore wrote `replayConfirmed: true`
   * into the bundle. Found by this file, on its first run.
   */
  it("says unverified — not confirmed — when the budget dies before anything reproduces", async () => {
    const failing = buriedPairTrace();
    // Nothing ever reproduces; every replay passes.
    const replay = async (): Promise<ReplayOutcome> => ({ failed: false });
    const result = await minimizeTrace(replay, failing, "v", {
      verbose: false,
      maxReplays: 4,
    });
    expect(result.verdict).toBe("unverified");
    expect(result.truncated).toBe(true);
    // Nothing was reduced either — the original trace is returned untouched.
    expect(result.minimized.actions.length).toBe(failing.actions.length);
  });

  it("says not-reproduced when the confirmation replay ran and passed", async () => {
    const failing = trace([action("a"), action("b")]);
    const replay = async (): Promise<ReplayOutcome> => ({ failed: false });
    const result = await minimizeTrace(replay, failing, "v", { verbose: false });
    expect(result.verdict).toBe("not-reproduced");
    expect(result.truncated).toBe(false);
  });

  it("stays confirmed when a reduction reproduced but the budget killed the final replay", async () => {
    // 8 actions; only `slicer.create` matters. The cap is set so the chunk pass
    // makes progress and then runs out before the confirmation replay.
    const failing = trace([
      action("x1"),
      action("x2"),
      action("x3"),
      action("x4"),
      action("slicer.create"),
      action("x5"),
      action("x6"),
      action("x7"),
    ]);
    const replay = async (candidate: ActionTrace): Promise<ReplayOutcome> =>
      candidate.actions.some((a) => a.id === "slicer.create")
        ? { failed: true, violationId: "v" }
        : { failed: false };
    const result = await minimizeTrace(replay, failing, "v", {
      verbose: false,
      maxReplays: 2,
    });
    expect(result.minimized.actions.length).toBeLessThan(failing.actions.length);
    expect(result.verdict).toBe("confirmed");
  });
});

// ============================================================================
// Budget
// ============================================================================

describe("minimizeTrace — budget", () => {
  it("reports truncated when the replay cap is hit before it converges", async () => {
    const failing = buriedPairTrace();
    const { replay } = createThenDeleteReplay("v");
    const result = await minimizeTrace(replay, failing, "v", {
      verbose: false,
      maxReplays: 3,
    });
    expect(result.replays).toBeLessThanOrEqual(4); // 3 + the confirmation replay
    expect(result.minimized.actions.length).toBeGreaterThan(2);
  });

  it("respects the wall-clock budget", async () => {
    const failing = buriedPairTrace();
    const replay = async (candidate: ActionTrace): Promise<ReplayOutcome> => {
      await new Promise((r) => setTimeout(r, 5));
      const ids = candidate.actions.map((a) => a.id);
      return ids.includes("slicer.create") && ids.includes("slicer.delete")
        ? { failed: true, violationId: "v" }
        : { failed: false };
    };
    const result = await minimizeTrace(replay, failing, "v", {
      verbose: false,
      timeBudgetMs: 20,
      maxReplays: 1000,
    });
    expect(result.truncated).toBe(true);
  });
});

// ============================================================================
// The blind spot: a shrink must not discard its own answer
// ============================================================================

describe("minimizeTrace — otherOutcomes (the discarded answer)", () => {
  /**
   * REGRESSION. `matches()` accepts only the ORIGINAL violation id, so a replay
   * that fails with a DIFFERENT id used to be indistinguishable from a replay
   * that passed. On soak seed 20260811 that turned "twelve of twelve replays
   * failed with no-js-exceptions" into `replayConfirmed: false` and a bundle
   * that read as "nothing here". The counts must survive.
   */
  it("counts and reports failures that fired with a DIFFERENT violation id", async () => {
    const failing = buriedPairTrace();
    // The original violation never reproduces; every replay that contains a
    // create fails a different way instead.
    const replay = async (candidate: ActionTrace): Promise<ReplayOutcome> => {
      const ids = candidate.actions.map((a) => a.id);
      if (ids.includes("slicer.create")) {
        return { failed: true, violationId: "no-js-exceptions" };
      }
      return { failed: false };
    };

    const result = await minimizeTrace(replay, failing, "no-console-errors", {
      verbose: false,
      maxReplays: 12,
    });

    expect(result.verdict).not.toBe("confirmed");
    // The answer the old shrinker threw away.
    expect(result.otherOutcomes["no-js-exceptions"]).toBeGreaterThan(0);
    expect(
      result.otherOutcomes["no-js-exceptions"] + (result.otherOutcomes["(passed)"] ?? 0)
    ).toBe(result.replays);
  });

  it("does not count the original violation id among the other outcomes", async () => {
    const failing = buriedPairTrace();
    const { replay } = createThenDeleteReplay("target");
    const result = await minimizeTrace(replay, failing, "target", {
      verbose: false,
    });
    expect(result.otherOutcomes["target"]).toBeUndefined();
    expect(result.otherOutcomes["(passed)"]).toBeGreaterThan(0);
  });

  it("records a failure with no violation id as (unknown), not as a pass", async () => {
    const failing = trace([action("a"), action("b")]);
    const replay = async (): Promise<ReplayOutcome> => ({ failed: true });
    const result = await minimizeTrace(replay, failing, "target", {
      verbose: false,
    });
    expect(result.otherOutcomes["(unknown)"]).toBe(result.replays);
    expect(result.otherOutcomes["(passed)"]).toBeUndefined();
    expect(result.verdict).toBe("not-reproduced");
  });

  it("anyFailure:true accepts a differently-named failure as a match", async () => {
    const failing = buriedPairTrace();
    const replay = async (candidate: ActionTrace): Promise<ReplayOutcome> => {
      const ids = candidate.actions.map((a) => a.id);
      return ids.includes("slicer.create")
        ? { failed: true, violationId: "some-other-invariant" }
        : { failed: false };
    };
    const result = await minimizeTrace(replay, failing, "no-console-errors", {
      verbose: false,
      anyFailure: true,
      maxReplays: 400,
    });
    expect(result.verdict).toBe("confirmed");
    expect(result.minimized.actions.map((a) => a.id)).toEqual(["slicer.create"]);
  });
});
