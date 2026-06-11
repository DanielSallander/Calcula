//! FILENAME: app/e2e/oracles/knownIssues.ts
// PURPOSE: Suppression list for oracle violations caused by KNOWN, ledgered
//          bugs. Without this, one unfixed bug would fail every subsequent
//          checkpoint and drown out new findings.
//
// Entries are keyed by oracle id + digest-diff path prefixes (or a message
// substring for violations without digest diffs). Each entry must reference
// a bug-ledger id (tests/regression/bug-ledger.json) so suppressions stay
// accountable. Remove the entry when the bug is fixed.

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
  {
    ledgerId: "BUG-0014",
    oracleId: "undo-round-trip",
    pathPrefixes: ["sheets[0].colWidths.", "sheets[1].colWidths."],
    reason:
      "Undo of pivot creation does not restore auto-sized column widths. " +
      "NOTE: this also masks other width-undo regressions while open. " +
      "Found 2026-06-11.",
  },
  {
    ledgerId: "BUG-0015",
    oracleId: "undo-round-trip",
    pathPrefixes: ["pivots."],
    reason:
      "Undo of pivot creation leaves a ghost pivot definition in " +
      "PivotState.pivot_tables. Contradicts [verified] undo.pivot-filter — " +
      "needs investigation. Found 2026-06-11.",
  },
  {
    ledgerId: "BUG-0020",
    oracleId: "undo-round-trip",
    pathPrefixes: ["conditionalFormats."],
    reason:
      "Conditional formatting rules are not undo-registered (surfaced once " +
      "the walker's CF action used the correct serde tag). Found 2026-06-11.",
  },
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
