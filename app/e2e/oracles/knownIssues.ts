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
  {
    ledgerId: "BUG-0001",
    oracleId: "undo-round-trip",
    pathPrefixes: ["charts."],
    reason:
      "Chart create/delete is not registered in the undo system — undo-all " +
      "leaves charts behind. Found by the first oracle run (2026-06-10).",
  },
  {
    ledgerId: "BUG-0002",
    oracleId: "undo-round-trip",
    pathPrefixes: ["sparklines."],
    reason:
      "Sparkline group create/delete bypasses the undo system (same opaque " +
      "JSON storage pattern as charts). Confirmed 2026-06-11 (seed 424242).",
  },
  {
    ledgerId: "BUG-0003",
    oracleId: "undo-round-trip",
    pathPrefixes: ["autoFilters."],
    reason:
      "AutoFilter mutations are not restored by undo — filter state " +
      "survives undo-all. Found by the verification walks (2026-06-11).",
  },
  {
    ledgerId: "BUG-0006",
    oracleId: "undo-round-trip",
    pathPrefixes: ["tables."],
    reason:
      "Table create/delete is not registered in the undo system — undo-all " +
      "leaves tables behind. Found by the verification walks (2026-06-11).",
  },
  {
    ledgerId: "BUG-0007",
    oracleId: "undo-round-trip",
    pathPrefixes: ["namedRanges."],
    reason:
      "Named range create/delete is not restored by undo. May be Excel-parity " +
      "expected behavior — pending user decision (undo.named-ranges).",
  },
  {
    ledgerId: "BUG-0008",
    oracleId: "undo-round-trip",
    pathPrefixes: ["dataValidations."],
    reason:
      "Data validation rules survive undo-all (Excel undoes validation " +
      "changes). Found by the verification walks (2026-06-11).",
  },
  {
    ledgerId: "BUG-0009",
    oracleId: "undo-round-trip",
    pathPrefixes: ["sheets[0].mergedRegions", "sheets[1].mergedRegions"],
    reason:
      "Redo of merge_cells does not restore the merged region. 1-action " +
      "repro: tests/regression/repros/BUG-0009.trace.json (2026-06-11).",
  },
  {
    ledgerId: "BUG-0012",
    oracleId: "save-reload-round-trip",
    pathPrefixes: ["sparklines."],
    reason:
      "Sparkline groups are lost across save/reload (not persisted or not " +
      "restored). Found by the scenario suite (2026-06-11).",
  },
  {
    ledgerId: "BUG-0013",
    oracleId: "save-reload-round-trip",
    pathPrefixes: ["tables."],
    reason:
      "Table autoFilterId linkage is lost across save/reload " +
      "(saved_to_table hardcodes auto_filter_id: None). Found 2026-06-11.",
  },
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
    ledgerId: "BUG-0017",
    oracleId: "undo-round-trip",
    pathPrefixes: [
      "sheets[0].freezeRow",
      "sheets[0].freezeCol",
      "sheets[1].freezeRow",
      "sheets[1].freezeCol",
    ],
    reason:
      "Redo of set_freeze_panes does not restore the freeze (same redo-path " +
      "class as BUG-0009 merge redo). Found 2026-06-11.",
  },
  {
    ledgerId: "BUG-0018",
    oracleId: "save-reload-round-trip",
    pathPrefixes: [
      "sheets[0].freezeRow",
      "sheets[0].freezeCol",
      "sheets[1].freezeRow",
      "sheets[1].freezeCol",
    ],
    reason:
      "Freeze panes are lost across save/reload (load path does not restore " +
      "freeze_configs). Found 2026-06-11.",
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
