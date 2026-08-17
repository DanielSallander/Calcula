//! FILENAME: app/e2e/oracles/knownIssues.ts
// PURPOSE: Suppression list for oracle violations caused by KNOWN, ledgered
//          bugs. Without this, one unfixed bug would fail every subsequent
//          checkpoint and drown out new findings.
//
// Entries are keyed by oracle id + digest-diff path prefixes (or a message
// substring for violations without digest diffs). Each entry must reference
// a bug-ledger id (tests/regression/bug-ledger.json) so suppressions stay
// accountable. Remove the entry when the bug is fixed.
//
// ENFORCED as of 2026-08-17: app/e2e/__tests__/knownIssueExpiry.test.ts reads
// tests/regression/bug-ledger.json and fails when an entry here names a bug that
// does not exist or is no longer "open". Closing the bug now turns the
// suppression into a red unit test instead of leaving it here forever. That is
// not hypothetical for this list -- a suppression on it outlived its bug once,
// and because the filter suppresses when EVERY digest-diff path is covered, a
// stale prefix hides that subtree from ANY cause.

import type { OracleViolation } from "./types";

export interface KnownIssue {
  /** Bug ledger id, e.g. "BUG-0003". */
  ledgerId: string;
  /** Oracle that reports the violation. */
  oracleId: string;
  /** Suppress when ALL digest-diff paths start with one of these prefixes. */
  pathPrefixes?: string[];
  /** Suppress when the violation message contains this substring. */
  messageIncludes?: string;
  /** Human note: what the underlying bug is. */
  reason: string;
}

/**
 * Active suppressions. Seed entries are added when a real, reproducible bug
 * is ledgered but not yet fixed.
 */
export const KNOWN_ISSUES: KnownIssue[] = [
  // Fix campaign 2026-06-11: suppressions for BUG-0001/2/3/6/7/8/9/12/13/
  // 17/18 were removed after the underlying bugs were fixed (undo
  // registration batch, merge-redo direction fix, multi-sheet save, .cala
  // sheet metadata, autofilter persistence). If any of them resurface, the
  // oracles will re-flag them — re-ledger rather than re-suppress blindly.
  // BUG-0014 (`sheets[0].colWidths.` + `sheets[1].colWidths.`) and BUG-0015
  // (`pivots.`) WERE HERE. Both are gone, and the reason each one went is
  // different — which is the whole point of re-examining a suppression instead
  // of renewing it.
  //
  // WHAT THEY ACTUALLY SUPPRESSED. Neither was scoped to its defect. The
  // filter suppresses a violation when EVERY digest-diff path is covered by a
  // prefix, so `pivots.` swallowed the entire pivot subtree — every field of
  // every pivot definition, for every cause — and the two `colWidths.` prefixes
  // swallowed ALL column-width divergence on the first two sheets, from any
  // cause at all. BUG-0014's own note admitted the second half ("this also
  // masks other width-undo regressions while open") and it was true: the undo
  // oracle is the instrument this programme trusts to prove undo correctness,
  // and for pivots and for column widths it had been reporting a green it could
  // not have seen a defect through since 2026-06-11.
  //
  // BUG-0014 — STILL REAL, and now FIXED rather than suppressed.
  // `auto_fit_pivot_columns` wrote straight into `column_widths` /
  // `all_column_widths` and recorded nothing on the undo stack, so the widths
  // simply never came back. It now returns what it overwrote and
  // `record_pivot_definition_undo` records it in the SAME transaction as the
  // pivot change (`pivot_col_widths`), because Excel undoes the two together.
  //
  // BUG-0015 — the ledgered CAUSE is fixed: `apply_pivot_create_restore`
  // removes the entry from `PivotState.pivot_tables`, so the grid-source
  // create/update path this bug was found on no longer leaves a ghost. But the
  // blanket prefix had gone on to hide its own successors. Four other pivot
  // commands mutate `pivot_tables` and record NO undo entry at all, and each
  // of them produces exactly the divergence BUG-0015 describes:
  //   * `create_pivot_from_bi_model` — creates a pivot Ctrl+Z cannot remove.
  //     The literal BUG-0015 symptom on the BI path. FIXED (records
  //     `pivot_create`, as the grid-source path always did).
  //   * `relocate_pivot` — moving a pivot was not undoable. FIXED (records
  //     `pivot_definition`; the restore re-renders from the same cache, which
  //     is exactly right for a move).
  //   * `update_bi_pivot_fields` — OPEN. Restoring the old definition against
  //     the new BI query result would render the wrong thing, so it needs a
  //     definition+cache snapshot, not a definition one.
  //   * `change_pivot_data_source` — OPEN, same shape: it rebuilds the cache.
  //   (`refresh_pivot_cache` records nothing either, and that one is correct:
  //    Excel does not undo a PivotTable refresh.)
  //
  // The two OPEN commands are deliberately NOT re-suppressed. A walk that
  // reaches them should fail loudly and name them; a prefix that hides them
  // buys silence at the price of the instrument.
  // BUG-0020 (conditionalFormats.*) WAS HERE and is gone because the defect is
  // fixed, not because it was re-classified. The CF commands recorded no undo
  // entry at all — add/update/delete/reorder/clear were invisible to Ctrl+Z,
  // which Excel has always undone. They now snapshot the sheet's whole rule
  // list (`obj_conditional_formats`) and announce the `conditionalFormats`
  // refresh domain. Covered by `undo_s12_soak_leak_tests` in the app crate.
  // Fixed 2026-08-11 out of the S12 soak bundle, where it was the ONE finding
  // of the three that was a real product defect.
];

export interface FilteredViolations {
  active: OracleViolation[];
  suppressed: Array<{ violation: OracleViolation; issue: KnownIssue }>;
}

export function filterKnownIssues(
  violations: OracleViolation[],
  issues: KnownIssue[] = KNOWN_ISSUES
): FilteredViolations {
  const active: OracleViolation[] = [];
  const suppressed: FilteredViolations["suppressed"] = [];

  for (const violation of violations) {
    // 1. Message-substring suppressions (single issue).
    const msgIssue = issues.find(
      (i) =>
        i.oracleId === violation.oracleId &&
        i.messageIncludes !== undefined &&
        violation.message.includes(i.messageIncludes)
    );
    if (msgIssue) {
      suppressed.push({ violation, issue: msgIssue });
      continue;
    }

    // 2. Path-prefix suppressions: a violation is suppressed when EVERY diff
    //    path is covered by the UNION of known prefixes for this oracle.
    //    A violation mixing known and new divergence stays active.
    const diffs = violation.digestDiff?.diffs ?? [];
    const pathIssues = issues.filter(
      (i) =>
        i.oracleId === violation.oracleId &&
        i.pathPrefixes !== undefined &&
        i.pathPrefixes.length > 0
    );
    if (diffs.length > 0 && pathIssues.length > 0) {
      const findIssueFor = (path: string): KnownIssue | undefined =>
        pathIssues.find((i) => i.pathPrefixes!.some((p) => path.startsWith(p)));
      const allCovered = diffs.every((d) => findIssueFor(d.path) !== undefined);
      if (allCovered) {
        suppressed.push({ violation, issue: findIssueFor(diffs[0].path)! });
        continue;
      }
    }

    active.push(violation);
  }

  return { active, suppressed };
}
