//! FILENAME: app/e2e/oracles/types.ts
// PURPOSE: Shared types for the semantic oracle battery.

import type { Page } from "@playwright/test";
import type { InvariantViolation } from "../invariants/invariants";
import type { Digest, DigestDiff } from "./digest";

/** A violation found by a semantic oracle. Extends the invariant violation
 *  shape so existing reporting handles it. */
export interface OracleViolation extends InvariantViolation {
  /** Which oracle found it (also mirrored in invariantId for the reporter). */
  oracleId: string;
  /** Path-level digest diff, when the oracle compared digests. */
  digestDiff?: DigestDiff;
}

export interface OracleContext {
  page: Page;
  /** Directory for temp files (save/reload round-trip). Must exist. */
  tmpDir: string;
}

/** Baseline captured at the START of a checkpoint window. */
export interface OracleBaseline {
  digest: Digest;
  /** Reported for diagnostics only. Depth is a SIZE, not a position: history
   *  is capped, so two depths cannot be subtracted to get a distance. The
   *  round-trip oracle navigates by `undoTopSeq`. */
  undoDepth: number;
  /** History id of the entry on TOP of the undo stack at this moment, or null
   *  when the stack was empty. Undoing back to the baseline means popping
   *  every entry that now sits above this id. */
  undoTopSeq: number | null;
  /** Transactions the size cap had dropped when the baseline was taken. A
   *  change since then means history older than the cap is gone. */
  evictedTotal: number;
  /** Transactions a WHOLESALE clear had discarded when the baseline was taken.
   *  A change since then means a workbook-STRUCTURE change ended the history
   *  (Excel parity: adding, deleting, renaming, moving or copying a sheet is
   *  not undoable and clears the stack). Without this the oracle could not
   *  tell that case from "the walk undid past the checkpoint", and reported a
   *  sheet insert as an undo defect — BUG-0005. */
  clearedTotal: number;
  /** How many times a WHOLESALE clear had HAPPENED when the baseline was
   *  taken, however little each one discarded. `clearedTotal` counts
   *  transactions and stays at zero when the stack was already empty, which
   *  left one case of the same family standing — see `UndoStateJson`. */
  clearsTotal: number;
  /**
   * EntityIds of the floating ranges alive at the baseline. Floating-range
   * CREATE is the one mutation in the product that is neither undoable NOR
   * history-ending (add_sheet parity without the clear — §16's doctrine), so
   * a window that created one can never be wound back to its checkpoint: the
   * FR and its backing sheet survive every undo. Without this list the oracle
   * DECIDES such a window and reports the surviving FR as an undo defect —
   * the same instrument-blames-the-product shape as BUG-0005/S12.
   */
  floatingRangeIds: string[];
}

export interface OracleCheckpointResult {
  violations: OracleViolation[];
  /** True if an oracle reset the undo stack (save/reload does — open_file
   *  clears history). The caller must treat the next window's undo baseline
   *  as starting from depth 0. */
  undoBaselineReset: boolean;
  /** Fresh baseline for the next checkpoint window. */
  nextBaseline: OracleBaseline;
}
