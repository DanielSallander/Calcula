//! FILENAME: app/e2e/__tests__/oracleCoverage.test.ts
// PURPOSE: Make a walk report state what its oracles actually ASKED, so a green
//          run cannot be mistaken for evidence it does not contain.
//
// CONTEXT. `OracleBattery` has accumulated `undecided` and `suppressed` since it
// was written, and NOTHING in the tree ever read either. The comment on
// `undecided` says outright that a run where most checkpoints land there is a
// weak run "and that has to be visible" — it was not: one `console.warn` per
// checkpoint, scrolled past in a log, and a final verdict still reading
// `[OK] Walk passed`.
//
// MEASURED 2026-08-13, soak seed 90060001, 40 actions, `SOAK_CATEGORY_WEIGHTS=
// sheet:10`: two oracle checkpoints, BOTH undecided (a sheet-structure change
// ends the undo history — Excel parity), and `saveReloadEvery` is 4 so the
// save/reload oracle never ran at all. That walk verified undo zero times and
// persistence zero times and reported a clean pass. Emptying
// `EXCLUDED_UNTIL_FIXED` — which is what finally let the walker touch sheets —
// is exactly what made this reading common rather than rare.
//
// So the counts are part of the report now, and these cases pin the wording:
// the whole value of a warning is what a reader does with it.

import { describe, it, expect } from "vitest";
import { OracleBattery } from "../oracles";

function battery(over: Partial<OracleBattery["coverage"]> = {}): OracleBattery {
  const b = new OracleBattery({ tmpDir: "unused-in-this-tier" });
  Object.assign(b.coverage, over);
  return b;
}

describe("oracle coverage is reported, not assumed", () => {
  it("says how many checkpoints the undo oracle actually decided", () => {
    const text = battery({
      checkpoints: 10,
      undoDecided: 6,
      undoNothingToUndo: 1,
      undoUndecided: 3,
      undoStepsWoundBack: 84,
      recalcRuns: 10,
      saveReloadRuns: 2,
    }).formatCoverage();

    expect(text).toContain("over 10 checkpoint(s)");
    expect(text).toContain("6 decided (84 transaction(s) wound back)");
    expect(text).toContain("1 with nothing to undo");
    expect(text).toContain("3 undecided");
    expect(text).toContain("save/reload round-trip: 2 run(s)");
    expect(text, "nothing to warn about — the oracles ran").not.toContain("[WARNING]");
  });

  it("WARNS when the undo round-trip decided nothing at all", () => {
    // The sheet-weighted walk. Every window ends the history, so the oracle
    // compares nothing and the run is silent about undo.
    const text = battery({
      checkpoints: 2,
      undoUndecided: 2,
      recalcRuns: 2,
      saveReloadRuns: 1,
    }).formatCoverage();

    expect(text).toContain("[WARNING] the undo round-trip decided NOTHING");
    expect(text).toContain("not evidence about undo");
  });

  it("WARNS when the save/reload oracle never ran", () => {
    // `saveReloadEvery` defaults to 4: a walk with fewer than four checkpoints
    // never touches persistence, which is where BUG-0040 and BUG-0041 both
    // lived.
    const text = battery({
      checkpoints: 2,
      undoDecided: 2,
      undoStepsWoundBack: 12,
      recalcRuns: 2,
      saveReloadRuns: 0,
    }).formatCoverage();

    expect(text).toContain("[WARNING] the save/reload round-trip never ran");
  });

  it("stays quiet on a battery that has run nothing yet", () => {
    // A fresh battery must not accuse a run that has not started of covering
    // nothing — the warnings are about checkpoints that HAPPENED.
    const text = new OracleBattery({ tmpDir: "x" }).formatCoverage();
    expect(text).toContain("over 0 checkpoint(s)");
    expect(text).not.toContain("[WARNING]");
  });

  it("names the ledger ids behind any suppression", () => {
    const b = battery({ checkpoints: 4, undoDecided: 4, recalcRuns: 4, saveReloadRuns: 1 });
    b.suppressed.push(
      {
        violation: {
          invariantId: "x",
          oracleId: "undo-round-trip",
          message: "m",
          details: {},
        },
        ledgerId: "BUG-0099",
      },
      {
        violation: {
          invariantId: "x",
          oracleId: "undo-round-trip",
          message: "m",
          details: {},
        },
        ledgerId: "BUG-0099",
      },
    );
    const text = b.formatCoverage();
    expect(text).toContain("2 violation(s) suppressed as known issues: BUG-0099");
  });

  it("has a detector that fires — a zero-coverage run is caught", () => {
    // The self-test the census families all carry, on the number that matters:
    // if the warning were dropped, this is what would go green anyway.
    const weak = battery({ checkpoints: 3, undoUndecided: 3, recalcRuns: 3 });
    const strong = battery({
      checkpoints: 3,
      undoDecided: 3,
      undoStepsWoundBack: 30,
      recalcRuns: 3,
      saveReloadRuns: 1,
    });
    expect(weak.formatCoverage().includes("[WARNING]")).toBe(true);
    expect(strong.formatCoverage().includes("[WARNING]")).toBe(false);
  });
});
