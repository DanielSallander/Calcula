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
  undoDepth: number;
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
