//! FILENAME: app/e2e/__tests__/knownIssueExpiry.test.ts
// PURPOSE: Make the ORACLE suppression list SELF-EXPIRING against the bug ledger,
//          exactly as `walkerExclusions.test.ts` already does for the walker's
//          action-exclusion list.
//
// WHY THIS EXISTS. `KNOWN_ISSUES` (e2e/oracles/knownIssues.ts) suppresses oracle
// violations while a ledgered bug makes them fire at every checkpoint. Its own
// header says "Remove the entry when the bug is fixed" — and nothing in the tree
// ever compared `ledgerId` to `tests/regression/bug-ledger.json`. A comment is not
// an enforcement mechanism.
//
// THIS LIST IS WHERE THE FAILURE MODE WAS FIRST OBSERVED. A suppression here
// outlived its bug and went on swallowing violations, and because the filter
// suppresses when EVERY digest-diff path is covered by a prefix, a stale prefix
// hides a whole subtree from ANY cause — the oracle reports a green it could not
// have seen a defect through. The walker's `EXCLUDED_UNTIL_FIXED` got this guard;
// the list that started the pattern never did. Now it has the same two cases:
//
//   1. every suppression names a bug that EXISTS in the ledger, and
//   2. that bug's status is still `open`.
//
// IT LANDS GREEN AND VACUOUS, because `KNOWN_ISSUES` is currently empty — which is
// exactly why the third test below matters. A file containing only the two vacuous
// cases would pass even if the predicate returned nothing, so the detector case
// runs the SAME helper the real cases run against a synthetic list.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_ISSUES, type KnownIssue } from "../oracles/knownIssues";

interface LedgerEntry {
  id: string;
  status: string;
}

interface Ledger {
  version: number;
  nextId: number;
  bugs: LedgerEntry[];
}

// Same path form as walkerExclusions.test.ts, which is proven to resolve under
// vitest. Deliberately NOT `process.cwd()`-relative: that only works when vitest
// happens to be launched from app/.
const LEDGER_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "tests",
  "regression",
  "bug-ledger.json",
);

function loadLedger(): Ledger {
  return JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Ledger;
}

/** A suppression is honest only while its bug is still open. */
type Suppression = Pick<KnownIssue, "ledgerId" | "oracleId">;

/**
 * THE PREDICATE UNDER TEST, shared by the real list and the self-test.
 *
 * Shared on purpose: the detector must exercise the code the real cases run, not
 * a retyped copy of it. A retyped detector proves the retyping works.
 */
function staleSuppressions(
  issues: readonly Suppression[],
  ledger: Ledger,
): Array<{ ledgerId: string; oracleId: string; status: string }> {
  const statusOf = new Map(ledger.bugs.map((b) => [b.id, b.status]));
  return issues
    .filter((i) => statusOf.get(i.ledgerId) !== "open")
    .map((i) => ({
      ledgerId: i.ledgerId,
      oracleId: i.oracleId,
      status: statusOf.get(i.ledgerId) ?? "(absent)",
    }));
}

describe("oracle suppressions expire with the bugs that justify them", () => {
  it("names a real ledger entry for every suppression", () => {
    const ledger = loadLedger();
    expect(
      ledger.bugs.length,
      "the ledger failed to load, so every assertion below would pass vacuously",
    ).toBeGreaterThan(50);

    const known = new Set(ledger.bugs.map((b) => b.id));
    const unknown = KNOWN_ISSUES.filter((e) => !known.has(e.ledgerId)).map(
      (e) => `${e.ledgerId} (oracle ${e.oracleId})`,
    );

    expect(
      unknown,
      "these suppressions name a bug id that does not exist in " +
        "tests/regression/bug-ledger.json. A suppression accountable to nothing is " +
        "an unexplained silence in the oracle battery — file the bug through the " +
        "allocator (tests/soak/bug-ledger.mjs) or delete the entry.",
    ).toEqual([]);
  });

  it("keeps a suppression only while its bug is still open", () => {
    const stale = staleSuppressions(KNOWN_ISSUES, loadLedger());

    expect(
      stale,
      "these suppressions outlived the bug that justified them, so the oracle is " +
        "still swallowing violations it should now be reporting. Note the shape of " +
        "the damage: the filter suppresses when EVERY digest-diff path is covered by " +
        "a prefix, so a stale prefix hides that whole subtree from ANY cause — the " +
        "battery reports a green it could not have seen a defect through. Delete the " +
        "entry; if the violation returns, re-ledger it rather than re-suppressing.",
    ).toEqual([]);
  });

  it("the detector finds a stale suppression when there is one", () => {
    // NON-VACUITY. `KNOWN_ISSUES` is empty today, so both cases above pass
    // trivially and would keep passing if the predicate were broken. This runs the
    // SAME helper against a list that is known to be stale.
    const ledger = loadLedger();
    const closed = ledger.bugs.find((b) => b.status !== "open");
    expect(closed, "the ledger must contain at least one closed bug").toBeDefined();

    const found = staleSuppressions(
      [
        { ledgerId: closed!.id, oracleId: "synthetic-closed-bug" },
        { ledgerId: "BUG-9999", oracleId: "synthetic-absent-bug" },
      ],
      ledger,
    );

    expect(found.map((f) => f.oracleId).sort()).toEqual([
      "synthetic-absent-bug",
      "synthetic-closed-bug",
    ]);
    expect(
      found.find((f) => f.oracleId === "synthetic-absent-bug")?.status,
      "an id absent from the ledger must be reported as absent, not silently skipped",
    ).toBe("(absent)");
  });
});
