//! FILENAME: app/e2e/oracles/index.ts
// PURPOSE: The semantic oracle battery. Orchestrates the expensive oracles
//          (undo round-trip, recalc consistency, save/reload round-trip) at
//          checkpoints, shared by the random walker and scenario tests.
//
// Checkpoint protocol:
//   const battery = new OracleBattery({ tmpDir });
//   let baseline = await battery.begin(page);          // window start
//   ... perform K actions ...
//   const result = await battery.checkpoint(page, baseline);
//   baseline = result.nextBaseline;                    // next window
//
// Ordering inside a checkpoint matters:
//   1. recalc consistency (does not disturb undo stack or state)
//   2. undo round-trip   (ends back at the same state)
//   3. save/reload       (LAST — open_file clears the undo stack)

import type { Page } from "@playwright/test";
import { captureUndoBaseline, checkUndoRoundTrip } from "./undoRoundTrip";
import { checkSaveReloadRoundTrip } from "./saveReloadRoundTrip";
import { checkRecalcConsistency } from "./recalcConsistency";
import { checkNoCalculationLimit } from "./calculationBudget";
import { getWorkbookDigest } from "./digest";
import { filterKnownIssues } from "./knownIssues";
import type {
  OracleBaseline,
  OracleCheckpointResult,
  OracleViolation,
} from "./types";

export type { Digest, DigestDiff, DigestDiffEntry, DiffProfile } from "./digest";
export { getWorkbookDigest, diffDigests, canonicalStringify, hashValue } from "./digest";
export { captureUndoBaseline, checkUndoRoundTrip, getUndoState } from "./undoRoundTrip";
export type { UndoRoundTripOutcome } from "./undoRoundTrip";
export { checkSaveReloadRoundTrip } from "./saveReloadRoundTrip";
export { checkRecalcConsistency } from "./recalcConsistency";
export { checkNoCalculationLimit, LIMIT_LITERAL } from "./calculationBudget";
export { CHEAP_INVARIANTS, selectionInBounds } from "./cheapInvariants";
export { KNOWN_ISSUES, filterKnownIssues } from "./knownIssues";
export type { KnownIssue } from "./knownIssues";
export type {
  OracleBaseline,
  OracleCheckpointResult,
  OracleContext,
  OracleViolation,
} from "./types";

export interface OracleBatteryOptions {
  /** Directory for temp .cala files (save/reload oracle). */
  tmpDir: string;
  /** Run the save/reload oracle only every Nth checkpoint (it is the most
   *  expensive and resets the undo stack). Default: 4. Set 0 to disable. */
  saveReloadEvery?: number;
  /** Disable individual oracles (e.g. while a blocking bug is open). */
  disable?: Array<"undo-round-trip" | "recalc-consistency" | "save-reload-round-trip">;
}

export class OracleBattery {
  private readonly tmpDir: string;
  private readonly saveReloadEvery: number;
  private readonly disabled: Set<string>;
  private checkpointCount = 0;
  /** Suppressed violations accumulated across the run (for reporting). */
  readonly suppressed: Array<{ violation: OracleViolation; ledgerId: string }> = [];
  /**
   * Checkpoints an oracle DECLINED to decide, with the reason. Not defects and
   * not suppressions: the question could not be asked. The only invariant id
   * that lands here is `undo-history-unreachable`, and it now arrives for two
   * distinct reasons:
   *
   *   * the walk pushed more than the 100-entry undo cap holds, so the
   *     checkpoint state is no longer on the stack (the original reason); or
   *   * the walk changed the workbook's SHEET STRUCTURE inside the window.
   *     Adding, deleting, renaming, moving or copying a sheet is not undoable
   *     in Excel and ends the undo history here too (BUG-0005), so there is no
   *     history left to wind back through.
   *
   * The message says which, because the remedies differ: the first is a
   * checkpoint-spacing problem, the second is inherent to the action.
   *
   * Collected rather than dropped because a run where most late checkpoints
   * end up here is a WEAK run, and that has to be visible: it is how the
   * round-trip oracle silently stops testing anything on a long walk. That is
   * doubly true now — a walker that reaches `sheet.add` often will undecide
   * many windows, and the count is the only signal that it did.
   */
  readonly undecided: Array<{ checkpoint: number; violation: OracleViolation }> = [];

  /**
   * WHAT THIS RUN'S ORACLES ACTUALLY GOT TO ASK.
   *
   * `undecided` and `suppressed` above have been accumulated since this class
   * was written and NOTHING has ever read either one. The comment on
   * `undecided` says, in as many words, that a run where most checkpoints end
   * up there is a WEAK run "and that has to be visible" — and it never was: the
   * only trace is a `console.warn` per checkpoint, scrolled past in a log, with
   * the final verdict still reading `[OK] Walk passed`.
   *
   * That gap became load-bearing the moment `EXCLUDED_UNTIL_FIXED` was emptied
   * and the walker could generate sheet actions again. A sheet-structure change
   * ENDS the undo history (Excel parity), so a sheet-weighted walk leaves nearly
   * every window undecided. MEASURED on soak seed 90060001 (40 actions,
   * `sheet:10`): two checkpoints, BOTH undecided, and `saveReloadEvery` is 4 so
   * the save/reload oracle never ran either. The walk verified undo zero times
   * and persistence zero times, and reported a clean pass.
   *
   * So the counts are now part of the report. `decided` is evidence; the rest
   * are the absence of it.
   */
  readonly coverage = {
    checkpoints: 0,
    undoDecided: 0,
    undoNothingToUndo: 0,
    undoUndecided: 0,
    /** Total transactions wound back and replayed across all checkpoints. */
    undoStepsWoundBack: 0,
    recalcRuns: 0,
    saveReloadRuns: 0,
  };

  /** One line stating what was verified and what was merely not contradicted. */
  formatCoverage(): string {
    const c = this.coverage;
    const undoParts = [
      `${c.undoDecided} decided (${c.undoStepsWoundBack} transaction(s) wound back)`,
      `${c.undoNothingToUndo} with nothing to undo`,
      `${c.undoUndecided} undecided`,
    ];
    return (
      `  --- Oracle coverage over ${c.checkpoints} checkpoint(s) ---\n` +
      `  undo round-trip: ${undoParts.join(", ")}\n` +
      `  recalc consistency: ${c.recalcRuns} run(s); ` +
      `save/reload round-trip: ${c.saveReloadRuns} run(s)` +
      (c.undoDecided === 0 && c.checkpoints > 0
        ? `\n  [WARNING] the undo round-trip decided NOTHING in this run — ` +
          `a green result here is not evidence about undo`
        : "") +
      (c.saveReloadRuns === 0 && c.checkpoints > 0
        ? `\n  [WARNING] the save/reload round-trip never ran — ` +
          `persistence was not exercised`
        : "") +
      (this.suppressed.length > 0
        ? `\n  ${this.suppressed.length} violation(s) suppressed as known issues: ` +
          [...new Set(this.suppressed.map((s) => s.ledgerId))].join(", ")
        : "")
    );
  }

  constructor(options: OracleBatteryOptions) {
    this.tmpDir = options.tmpDir;
    this.saveReloadEvery = options.saveReloadEvery ?? 4;
    this.disabled = new Set(options.disable ?? []);
  }

  /** Capture the baseline at the start of a checkpoint window. */
  async begin(page: Page): Promise<OracleBaseline> {
    return captureUndoBaseline(page);
  }

  /**
   * Run the oracle battery at a checkpoint. Returns active violations (known
   * issues filtered out, recorded in `this.suppressed`) and the baseline for
   * the next window.
   */
  async checkpoint(
    page: Page,
    baseline: OracleBaseline
  ): Promise<OracleCheckpointResult> {
    this.checkpointCount++;
    this.coverage.checkpoints++;
    const violations: OracleViolation[] = [];
    const budgetViolations: OracleViolation[] = [];
    let undoBaselineReset = false;

    // 0. Calculation budget — no cell in a generated workbook may ever hold
    //    `#LIMIT!`. Runs FIRST and off a digest of the current state, because a
    //    tripped budget makes every oracle below it report confusing secondary
    //    damage (an error value differs from a number, so the undo and
    //    save/reload digests diverge too) and the real cause should be named
    //    before the symptoms. See calculationBudget.ts.
    budgetViolations.push(
      ...checkNoCalculationLimit(await getWorkbookDigest(page))
    );

    // 1. Recalc consistency — read-only with respect to undo stack.
    if (!this.disabled.has("recalc-consistency")) {
      this.coverage.recalcRuns++;
      violations.push(...(await checkRecalcConsistency(page)));
    }

    // 2. Undo round-trip — ends back at the current state.
    if (!this.disabled.has("undo-round-trip")) {
      const outcome = await checkUndoRoundTrip(page, baseline);
      if (outcome.verdict === "decided") {
        this.coverage.undoDecided++;
        this.coverage.undoStepsWoundBack += outcome.stepsUndone;
      } else if (outcome.verdict === "nothing-to-undo") {
        this.coverage.undoNothingToUndo++;
      } else {
        this.coverage.undoUndecided++;
      }
      violations.push(...outcome.violations);
    }

    // 3. Save/reload round-trip — LAST: open_file clears the undo stack.
    const saveReloadDue =
      this.saveReloadEvery > 0 &&
      this.checkpointCount % this.saveReloadEvery === 0;
    if (saveReloadDue && !this.disabled.has("save-reload-round-trip")) {
      this.coverage.saveReloadRuns++;
      violations.push(
        ...(await checkSaveReloadRoundTrip({ page, tmpDir: this.tmpDir }))
      );
      undoBaselineReset = true;
    }

    // Undecidable checkpoints are pulled out BEFORE the known-issues ledger.
    // They are not defects, so failing the walk on one reports the harness's
    // own blind spot as a product bug (which is what S11 and S12's first two
    // findings were); and they are not suppressions either, so hiding them in
    // the ledger would make the blind spot invisible instead.
    const decidable: OracleViolation[] = [];
    for (const v of violations) {
      if (v.invariantId === "undo-history-unreachable") {
        this.undecided.push({ checkpoint: this.checkpointCount, violation: v });
        console.warn(`  [oracle] ${v.message}`);
      } else {
        decidable.push(v);
      }
    }

    const { active, suppressed } = filterKnownIssues(decidable);
    for (const s of suppressed) {
      this.suppressed.push({ violation: s.violation, ledgerId: s.issue.ledgerId });
    }

    // Budget violations bypass the known-issues ledger ON PURPOSE. A ledger
    // entry would turn "the calculation budget is mis-calibrated and is
    // silently corrupting ordinary workbooks" into a suppressed line in a
    // report, which is exactly the signal this gate exists to produce.
    const nextBaseline = await this.begin(page);
    return {
      violations: [...budgetViolations, ...active],
      undoBaselineReset,
      nextBaseline,
    };
  }
}
