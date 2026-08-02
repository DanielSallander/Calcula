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
      violations.push(...(await checkRecalcConsistency(page)));
    }

    // 2. Undo round-trip — ends back at the current state.
    if (!this.disabled.has("undo-round-trip")) {
      violations.push(...(await checkUndoRoundTrip(page, baseline)));
    }

    // 3. Save/reload round-trip — LAST: open_file clears the undo stack.
    const saveReloadDue =
      this.saveReloadEvery > 0 &&
      this.checkpointCount % this.saveReloadEvery === 0;
    if (saveReloadDue && !this.disabled.has("save-reload-round-trip")) {
      violations.push(
        ...(await checkSaveReloadRoundTrip({ page, tmpDir: this.tmpDir }))
      );
      undoBaselineReset = true;
    }

    const { active, suppressed } = filterKnownIssues(violations);
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
