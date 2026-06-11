//! FILENAME: app/e2e/oracles/cheapInvariants.ts
// PURPOSE: Cheap synchronous invariants added to the per-action check list
//          (ALL_INVARIANTS). These cost nothing — they only inspect the
//          snapshot already captured after every action.

import type { Invariant, InvariantViolation } from "../invariants/invariants";

// Excel-compatible hard caps; Calcula's grid uses the same order of magnitude.
const MAX_ROWS = 1_048_576;
const MAX_COLS = 16_384;

/**
 * INVARIANT: The selection must be well-formed and within plausible grid
 * bounds. A selection with inverted or absurd coordinates indicates state
 * corruption in the selection model.
 */
export const selectionInBounds: Invariant = {
  id: "selection-in-bounds",
  description: "Selection coordinates are well-formed and within grid bounds",
  check(snapshot) {
    const violations: InvariantViolation[] = [];
    const sel = snapshot.logical.selection;
    if (!sel) return violations;

    const problems: string[] = [];
    if (sel.startRow < 0 || sel.startCol < 0) problems.push("negative start");
    if (sel.endRow < sel.startRow) problems.push("endRow < startRow");
    if (sel.endCol < sel.startCol) problems.push("endCol < startCol");
    if (sel.endRow >= MAX_ROWS) problems.push(`endRow >= ${MAX_ROWS}`);
    if (sel.endCol >= MAX_COLS) problems.push(`endCol >= ${MAX_COLS}`);

    if (problems.length > 0) {
      violations.push({
        invariantId: "selection-in-bounds",
        message: `Malformed selection (${problems.join(", ")}): ${JSON.stringify(sel)}`,
        details: { selection: sel, problems },
      });
    }
    return violations;
  },
};

export const CHEAP_INVARIANTS: Invariant[] = [selectionInBounds];
