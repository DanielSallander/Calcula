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
import {
  ACTIONS_THAT_MAY_END_UNDO_HISTORY,
  captureUndoBaseline,
  checkUndoRoundTrip,
  getUndoState,
  undoBaselineUnreachableReason,
} from "./undoRoundTrip";
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
export {
  ACTIONS_THAT_MAY_END_UNDO_HISTORY,
  captureUndoBaseline,
  checkUndoRoundTrip,
  getUndoState,
  stepsBackToBaseline,
  undoBaselineUnreachableReason,
} from "./undoRoundTrip";
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
  /**
   * Whether a run that decides ZERO undo round-trips is a FAILURE (default
   * true). See `undoEvidenceFailure`.
   *
   * Set false ONLY where a run genuinely cannot be expected to produce undo
   * evidence and the caller is reading something else — the trace-replay paths,
   * where the trace is whatever the shrinker handed over and may be a single
   * `sheet.add`. Turning it off anywhere a GENERATED walk runs re-creates the
   * exact silence this flag exists to break.
   */
  requireUndoEvidence?: boolean;
}

/**
 * The most checkpoints a walk of `maxActions` at a cadence of
 * `oracleEveryNActions` can possibly reach.
 *
 * An UPPER bound on purpose: a wall-clock budget (soak) or an early failure can
 * end a walk sooner, so this over-counts and never under-counts. That is the
 * direction that makes the reachability check below safe — it can only fire on
 * a configuration that could not reach the cadence even in its best case.
 *
 * PURE, so the arithmetic has a unit tier
 * (`app/e2e/__tests__/oracleCadenceReachable.test.ts`).
 */
export function plannedCheckpointCount(
  maxActions: number,
  oracleEveryNActions: number,
): number {
  if (maxActions <= 0 || oracleEveryNActions <= 0) return 0;
  // The walker checkpoints every Nth action AND at the last step, so a walk
  // whose length is not a multiple of the cadence gets one extra.
  return Math.ceil(maxActions / oracleEveryNActions);
}

/**
 * The sentence a walk configuration deserves when its save/reload cadence can
 * NEVER come due — or null when it can.
 *
 * WHY THIS EXISTS, MEASURED 2026-08-15 while closing the correctness programme.
 * The `invariant` project runs 75 actions at a cadence of 25 (**3** checkpoints)
 * and a rapid-fire walk of 50 at 25 (**2**), while `saveReloadEvery` defaults to
 * **4**. `checkpointCount % 4 === 0` is therefore false at every checkpoint the
 * project can reach: the save/reload round-trip oracle has never run in that
 * project on ANY seed, and could not have. Every run printed
 * "[WARNING] the save/reload round-trip never ran — persistence was not
 * exercised" and then reported a clean pass, so the warning read like luck.
 *
 * A guard that cannot run is not a guard that passed. This turns "it happened
 * not to fire" into a configuration error that names the three numbers.
 *
 * PURE.
 */
export function describeUnreachableSaveReloadCadence(
  saveReloadEvery: number,
  plannedCheckpoints: number,
): string | null {
  if (saveReloadEvery <= 0) return null; // 0 means "deliberately disabled"
  if (plannedCheckpoints >= saveReloadEvery) return null;
  return (
    `the save/reload round-trip oracle can NEVER run in this walk: it fires on ` +
    `every ${saveReloadEvery}th checkpoint, and this walk can reach at most ` +
    `${plannedCheckpoints}. Persistence would go unexercised while the run ` +
    `reported a clean pass.\n` +
    `      Fix it in the SPEC, by one of:\n` +
    `        - pass \`saveReloadEvery: ${Math.max(1, plannedCheckpoints)}\` to the ` +
    `OracleBattery, so it runs once per walk;\n` +
    `        - lengthen the walk or shorten \`oracleEveryNActions\` until at least ` +
    `${saveReloadEvery} checkpoints are reachable;\n` +
    `        - pass \`saveReloadEvery: 0\` to state on purpose that this walk does ` +
    `not exercise persistence.`
  );
}

/**
 * `sheet.add=4 fr.create=3` — which actions forced a mid-window rebase, most
 * frequent first. Exported and pure so the report line has a unit tier.
 */
export function summarizeRebaseActions(
  rebases: ReadonlyArray<{ action: string }>
): string {
  const counts: Record<string, number> = {};
  for (const r of rebases) counts[r.action] = (counts[r.action] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, n]) => `${id}=${n}`)
    .join(" ");
}

export class OracleBattery {
  private readonly tmpDir: string;
  private readonly saveReloadEvery: number;
  private readonly disabled: Set<string>;
  private readonly requireUndoEvidence: boolean;
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
    /** Times the undo baseline was re-captured mid-window (see `rebases`). */
    undoBaselineRebases: 0,
    recalcRuns: 0,
    saveReloadRuns: 0,
  };

  /**
   * Every mid-window re-capture of the undo baseline, with the action that
   * forced it.
   *
   * Kept rather than counted because the ACTION is the interesting half. A
   * rebase after `sheet.add` is the product behaving exactly as Excel does; a
   * rebase after `cell.edit` would mean an ordinary edit had ended the undo
   * history, which is a defect the walker could otherwise absorb in silence
   * (see `ACTIONS_THAT_MAY_END_UNDO_HISTORY`).
   */
  readonly rebases: Array<{
    step: number;
    action: string;
    reason: string;
    /** True when the action had no business ending the history. */
    unexpected: boolean;
  }> = [];

  /**
   * The sentence a run deserves when its undo oracle decided NOTHING — or null
   * when it decided something.
   *
   * WHY THIS IS A FAILURE AND NOT A WARNING. The warning already existed, in
   * `formatCoverage` below, and it was printed by EVERY walk run on 2026-08-15
   * — 10 walks, 32 checkpoints, 0 decided — under a final verdict still reading
   * `[OK] Walk passed`. The register recorded it as an evidentiary gap and the
   * suites stayed green, which is the same lie `assertCadenceReachable` was
   * written to stop one paragraph earlier in this file: a guard that could not
   * run is not a guard that passed, and an oracle that decided nothing is not
   * an oracle that agreed.
   *
   * Undo is where this programme has found its most severe defects — a sheet's
   * whole cell map replaced by another sheet's snapshot, an undo stack
   * outliving its document across File > Open, undo recalculating no dependents
   * — so "the undo evidence is missing" is exactly the result that must not
   * look like "the undo evidence is clean".
   *
   * PURE (reads only `coverage`), so it has a unit tier.
   */
  undoEvidenceFailure(): string | null {
    if (this.disabled.has("undo-round-trip")) return null;
    if (!this.requireUndoEvidence) return null;
    const c = this.coverage;
    if (c.checkpoints === 0) return null;
    if (c.undoDecided > 0) return null;
    return (
      `the undo round-trip oracle DECIDED NOTHING across ${c.checkpoints} ` +
      `checkpoint(s): ${c.undoNothingToUndo} had nothing to undo and ` +
      `${c.undoUndecided} were undecidable. This run carries no undo evidence ` +
      `at all, so passing it would say "undo is fine" on the strength of zero ` +
      `comparisons — and undo is where this programme has found its most ` +
      `severe defects.\n` +
      `      ${c.undoBaselineRebases} mid-window rebase(s) happened, so the ` +
      `walk was already trying: the windows still closed on a history-ender.\n` +
      `      Fix it in the SPEC, by one of:\n` +
      `        - shorten \`oracleEveryNActions\` so a window closes before the ` +
      `next history-ender lands;\n` +
      `        - down-weight the families that end the undo history ` +
      `(\`categoryWeights: { sheet: 0.2, floating: 0.5 }\`);\n` +
      `        - pass \`requireUndoEvidence: false\` to state on purpose that ` +
      `this run is not asking about undo (trace replays only).`
    );
  }

  /** One line stating what was verified and what was merely not contradicted. */
  formatCoverage(): string {
    const c = this.coverage;
    const undoParts = [
      `${c.undoDecided} decided (${c.undoStepsWoundBack} transaction(s) wound back)`,
      `${c.undoNothingToUndo} with nothing to undo`,
      `${c.undoUndecided} undecided`,
    ];
    const unexpected = this.rebases.filter((r) => r.unexpected);
    return (
      `  --- Oracle coverage over ${c.checkpoints} checkpoint(s) ---\n` +
      `  undo round-trip: ${undoParts.join(", ")}\n` +
      `  undo baseline rebases: ${c.undoBaselineRebases}` +
      (c.undoBaselineRebases > 0
        ? ` (${summarizeRebaseActions(this.rebases)})`
        : "") +
      `\n` +
      `  recalc consistency: ${c.recalcRuns} run(s); ` +
      `save/reload round-trip: ${c.saveReloadRuns} run(s)` +
      (unexpected.length > 0
        ? `\n  [WARNING] ${unexpected.length} action(s) ended the undo history ` +
          `that have no business ending it: ` +
          unexpected
            .map((r) => `step ${r.step} ${r.action}`)
            .join(", ")
        : "") +
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
    this.requireUndoEvidence = options.requireUndoEvidence ?? true;
  }

  /**
   * Re-capture the undo baseline IF the current one can no longer be wound back
   * to — the change that lets this oracle decide anything at all.
   *
   * Called by `WalkRunner` after every action, off the snapshot it already
   * took, at the cost of one `get_undo_state` invoke (and a workbook digest
   * only on the actions that actually killed the window).
   *
   * WHAT IT DOES NOT DO. It does not relax a verdict, skip a comparison, or
   * decide a window that cannot be decided. The baseline it captures is a real
   * state of the workbook, its digest is taken at that moment, and the round
   * trip that later winds back to it pops exactly the ids that sit above it.
   * The only thing that changes is WHEN the window starts: a window no longer
   * has to begin 25 actions before the checkpoint and survive every draw in
   * between. MEASURED LIVE on the `invariant` project, same 6 seeds and 12
   * walks each way: 5 of 28 checkpoints decided -> 27 of 30, and 174 -> 546
   * transactions actually wound back and replayed. (Simulated over the
   * generator alone the same change reads 6/120 -> 112/120; the two disagree,
   * and the live figure is the one to quote — see
   * `app/e2e/__tests__/undoOracleDecidability.test.ts`.)
   *
   * The action id is recorded with every rebase, because the rebase makes the
   * cause invisible otherwise and one of the causes would be a serious defect
   * (see `ACTIONS_THAT_MAY_END_UNDO_HISTORY`).
   */
  async rebaseUndoBaselineIfUnreachable(
    page: Page,
    baseline: OracleBaseline,
    context: {
      step: number;
      action: string;
      /** FR ids as of the post-action snapshot the walker already captured. */
      floatingRangeIdsNow: readonly string[];
    }
  ): Promise<{ baseline: OracleBaseline; rebased: boolean }> {
    if (this.disabled.has("undo-round-trip")) return { baseline, rebased: false };
    const undoState = await getUndoState(page);
    const reason = undoBaselineUnreachableReason(
      baseline,
      undoState,
      context.floatingRangeIdsNow
    );
    if (reason === null) return { baseline, rebased: false };

    const unexpected = !ACTIONS_THAT_MAY_END_UNDO_HISTORY.has(context.action);
    this.rebases.push({
      step: context.step,
      action: context.action,
      reason,
      unexpected,
    });
    this.coverage.undoBaselineRebases++;
    console.log(
      `  [oracle] undo baseline re-captured after step ${context.step} ` +
        `(${context.action}): ${reason}` +
        (unexpected
          ? `  [WARNING] ${context.action} is not an action that may end the ` +
            `undo history`
          : "")
    );
    return { baseline: await this.begin(page), rebased: true };
  }

  /**
   * REFUSE a walk whose save/reload cadence cannot come due. Called by
   * `WalkRunner.run` with the walk's own upper bound on checkpoints — the only
   * place both numbers exist at once.
   *
   * Throwing rather than warning is the point: the warning already existed and
   * a whole project ran for weeks with its persistence oracle unreachable.
   */
  assertCadenceReachable(plannedCheckpoints: number): void {
    if (this.disabled.has("save-reload-round-trip")) return;
    const message = describeUnreachableSaveReloadCadence(
      this.saveReloadEvery,
      plannedCheckpoints,
    );
    if (message !== null) {
      throw new Error(`[oracles] ${message}`);
    }
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
