//! FILENAME: app/e2e/__tests__/wedgeInstrumentation.test.ts
// PURPOSE: The wedge instrumentation must not FABRICATE a wedge, and must not
//          file another run's log as this run's evidence.
// CONTEXT: BUG-0098 is the unreproduced backend wedge — 64 consecutive timeouts
//          over 5.4 hours, with every channel that could have named the hung
//          command destroyed before anyone read it. Because the defect itself
//          cannot be reproduced, the ONLY thing worth doing is making a
//          recurrence diagnosable. That makes the honesty of the instrumentation
//          load-bearing in a way it usually is not: the artefacts it writes are
//          all a future reader will have.
//
//          Two defects in the existing instrumentation were found while auditing
//          it, and both produce CONFIDENT FALSEHOODS rather than silence:
//
//            1. `Number(process.env.X ?? 5_000)` accepted an empty string (`??`
//               is not triggered by `""`, and `Number("")` is 0) and a malformed
//               one (`Number("5s")` is NaN). `setTimeout(fn, 0 | NaN)` fires
//               immediately, so a perfectly HEALTHY run would latch as wedged
//               and write the marker a future reader would trust.
//
//            2. `global-teardown` archived `results/app-dev.log` on EXISTENCE
//               alone. Under `E2E_MANUAL=1` the app is launched separately, so
//               that file can be a leftover from an earlier run — archived under
//               THIS run's timestamp, it is the wrong evidence under the right
//               name.
//
//          A wedge detector that manufactures wedges, and an archive that files
//          the wrong log, are both worse than not having them: the first thing
//          anyone does with a plausible artefact is believe it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const E2E = join(process.cwd(), "e2e");
const guardSrc = readFileSync(join(E2E, "wedgeGuard.ts"), "utf8");
const teardownSrc = readFileSync(join(E2E, "global-teardown.ts"), "utf8");
const setupSrc = readFileSync(join(E2E, "global-setup.ts"), "utf8");
const configSrc = readFileSync(join(process.cwd(), "playwright.config.ts"), "utf8");

/**
 * The budget parser, re-implemented from the source under test.
 *
 * Extracting it for real would mean importing `wedgeGuard.ts`, which pulls in
 * Playwright types and the marker module. The behaviour is four lines, so it is
 * mirrored here AND the source is asserted to still contain the guard clauses —
 * a copy that silently diverged would pass the behaviour cases while the product
 * regressed, so both halves are needed.
 */
function budgetMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

describe("a malformed budget cannot fabricate a wedge", () => {
  it("an EMPTY env var falls back instead of yielding 0", () => {
    // The nastiest of the three: `?? ` does not catch "", so the old code got
    // `Number("")` === 0, and a 0ms budget fires on the next tick.
    expect(budgetMs("", 5_000)).toBe(5_000);
    expect(budgetMs("   ", 5_000)).toBe(5_000);
  });

  it("a NON-NUMERIC env var falls back instead of yielding NaN", () => {
    // `setTimeout(fn, NaN)` fires immediately, so this latched a healthy run.
    expect(budgetMs("5s", 5_000)).toBe(5_000);
    expect(budgetMs("abc", 5_000)).toBe(5_000);
  });

  it("zero and negative values are refused", () => {
    expect(budgetMs("0", 5_000)).toBe(5_000);
    expect(budgetMs("-1", 5_000)).toBe(5_000);
  });

  it("a LEGITIMATE override is still honoured", () => {
    // Non-vacuity: a parser that always returned the fallback would satisfy
    // every case above while quietly ignoring the operator.
    expect(budgetMs("250", 5_000)).toBe(250);
    expect(budgetMs("30000", 5_000)).toBe(30_000);
  });

  it("the SOURCE still refuses malformed values, not just this copy", () => {
    expect(guardSrc).toContain("Number.isFinite");
    expect(guardSrc).toContain('raw.trim() === ""');
    expect(
      guardSrc.includes("Number(process.env.E2E_WEDGE_BACKEND_MS ??"),
      "wedgeGuard.ts went back to the unguarded `Number(env ?? default)` form, " +
        "which latches a healthy run when the variable is empty or malformed",
    ).toBe(false);
  });
});

describe("the log archive cannot file another run's evidence", () => {
  it("teardown checks the log's mtime against the run start", () => {
    expect(teardownSrc).toContain("E2E_RUN_STARTED_AT");
    expect(teardownSrc).toContain("mtimeMs");
    expect(
      teardownSrc,
      "the archive must skip a log older than this run — under E2E_MANUAL the " +
        "live log can belong to a previous run",
    ).toContain("staleByRunStart");
  });

  it("global-setup publishes the run-start stamp the check reads", () => {
    // The two halves are in different files; either alone is useless, and the
    // teardown check would silently no-op if the stamp were never set.
    expect(
      setupSrc,
      "global-teardown reads E2E_RUN_STARTED_AT; nothing sets it, so the " +
        "staleness check can never fire",
    ).toContain("process.env.E2E_RUN_STARTED_AT =");
  });
});

describe("a runaway run has a ceiling", () => {
  it("playwright.config declares a globalTimeout", () => {
    // BUG-0098 cost 5.4 hours. The wedge guard latches only for the shape it can
    // SEE (a wedged backend); a renderer-side hang happens above it and pays
    // full price per test with no latch.
    expect(
      configSrc,
      "no globalTimeout: a runaway run can again spend hours failing on timeout",
    ).toContain("globalTimeout");
    const m = /globalTimeout:\s*([^,]+),/.exec(configSrc);
    expect(m, "globalTimeout is present but unparseable").not.toBeNull();
    // eslint-disable-next-line no-eval
    const value = eval(m![1]) as number;
    expect(value, "the ceiling must be well above a healthy run (~28 min)").toBeGreaterThan(
      60 * 60 * 1000,
    );
    expect(value, "...and low enough to matter").toBeLessThanOrEqual(4 * 60 * 60 * 1000);
  });
});
