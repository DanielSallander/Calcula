//! FILENAME: app/e2e/__tests__/walkerExclusions.test.ts
// PURPOSE: Make the walker's action-suppression list SELF-EXPIRING against the
//          bug ledger.
//
// CONTEXT. `EXCLUDED_UNTIL_FIXED` in `walker/actionCatalog.ts` removes actions
// from the GENERATION catalog while a ledgered bug makes every walk using them
// fail the same way. The mechanism is sound; its lifetime was not. Each entry
// carried a `ledgerId` string, and nothing in the tree ever compared that
// string to `tests/regression/bug-ledger.json`.
//
// MEASURED 2026-08-12: the list still excluded `sheet.add`, `sheet.switch`,
// `sheet.rename` and `sheet.delete` against BUG-0005 — which was closed, along
// with BUG-0034, by a pass that REWROTE the sheet/undo surface. So the four
// actions covering the freshly-rewritten code were the exact four the walker
// was forbidden to generate, and every green walk report was silently a report
// about a workbook that never had a second sheet.
//
// This is the third instance in this programme of a suppression outliving its
// reason (the register records two on the undo oracle, which blinded it to all
// pivot divergence). The pattern only stops when the suppression is required to
// prove its own justification is still live, which is what these cases do:
//
//   1. every excluded entry names a bug that EXISTS in the ledger, and
//   2. that bug's status is still `open`.
//
// Closing the bug therefore turns the suppression red on the next unit run
// instead of leaving it in place forever.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_CATALOG,
  FULL_ACTION_CATALOG,
  EXCLUDED_UNTIL_FIXED,
} from "../walker/actionCatalog";

interface LedgerEntry {
  id: string;
  status: string;
}

interface Ledger {
  version: number;
  nextId: number;
  bugs: LedgerEntry[];
}

const LEDGER_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "tests",
  "regression",
  "bug-ledger.json"
);

function loadLedger(): Ledger {
  return JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Ledger;
}

describe("the walker's action exclusions expire with the bugs that justify them", () => {
  it("names a real ledger entry for every exclusion", () => {
    const ledger = loadLedger();
    const known = new Set(ledger.bugs.map((b) => b.id));
    const unknown = EXCLUDED_UNTIL_FIXED.filter((e) => !known.has(e.ledgerId));
    expect(
      unknown.map((e) => e.ledgerId),
      "an exclusion cites a bug id that is not in tests/regression/bug-ledger.json — " +
        "either file the bug or drop the exclusion"
    ).toEqual([]);
  });

  it("suppresses actions ONLY while the cited bug is still open", () => {
    const ledger = loadLedger();
    const statusOf = new Map(ledger.bugs.map((b) => [b.id, b.status]));

    const stale = EXCLUDED_UNTIL_FIXED.filter(
      (e) => statusOf.get(e.ledgerId) !== "open"
    ).map((e) => ({
      ledgerId: e.ledgerId,
      status: statusOf.get(e.ledgerId) ?? "(absent)",
      actions: e.actions.map((a) => a.id),
    }));

    expect(
      stale,
      "these actions are still withheld from the walker although the bug that " +
        "justified withholding them is closed. Re-enable them (delete the " +
        "entry) and replay tests/regression/repros/<bug>.trace.json. This is " +
        "exactly how the four sheet actions stayed suppressed after BUG-0005 " +
        "and BUG-0034 rewrote the surface they cover."
    ).toEqual([]);
  });

  it("keeps excluded actions REPLAYABLE even while they are suppressed", () => {
    // The generation catalog may shrink; the replay catalog may not, or every
    // recorded repro trace citing a suppressed action stops resolving.
    const fullIds = new Set(FULL_ACTION_CATALOG.map((a) => a.id));
    for (const entry of EXCLUDED_UNTIL_FIXED) {
      for (const action of entry.actions) {
        expect(fullIds.has(action.id), `${action.id} missing from FULL_ACTION_CATALOG`).toBe(
          true
        );
      }
    }
  });

  it("generates the sheet actions again now that BUG-0005 and BUG-0034 are closed", () => {
    // A named regression for the specific hole this file was written for: the
    // sheet surface must be reachable by generation, not merely by replay.
    const generated = new Set(ACTION_CATALOG.map((a) => a.id));
    for (const id of ["sheet.add", "sheet.switch", "sheet.rename", "sheet.delete"]) {
      expect(generated.has(id), `${id} is not generatable`).toBe(true);
    }
  });

  it("covers the sheet operations that RENUMBER the workbook, and the one that hides", () => {
    // The four re-enabled actions were the four that had been suppressed — not
    // the four that matter. `move` and `copy` are the other two commands the
    // undo oracle's own message names as history-ending, and they are the two
    // that renumber every index-anchored object without deleting anything;
    // `hide` changes which sheet is ACTIVE while changing the sheet list not at
    // all, which is where BUG-0046 lived. None of the three existed here.
    const generated = new Set(ACTION_CATALOG.map((a) => a.id));
    for (const id of ["sheet.move", "sheet.copy", "sheet.hide"]) {
      expect(generated.has(id), `${id} is not generatable`).toBe(true);
    }
  });

  it("covers all three operations BUG-0050 made undoable — hide, unhide, tab colour", () => {
    // BUG-0050 gave hide/unhide/set_tab_color real undo entries. `sheet.hide`
    // existed already; until `sheet.unhide` and `sheet.tabColor` joined, no
    // walk could ever put the other two inside an undo-oracle window, so their
    // undo entries were asserted by unit tests and exercised by nothing.
    const generated = new Set(ACTION_CATALOG.map((a) => a.id));
    for (const id of ["sheet.hide", "sheet.unhide", "sheet.tabColor"]) {
      expect(generated.has(id), `${id} is not generatable`).toBe(true);
    }
  });

  it("has a detector that fires — a closed bug's exclusion is caught", () => {
    // The self-test the fourteen census families all carry: prove the check
    // can fail, using a synthetic list rather than the real one.
    const ledger: Ledger = {
      version: 1,
      nextId: 3,
      bugs: [
        { id: "BUG-0001", status: "fixed" },
        { id: "BUG-0002", status: "open" },
      ],
    };
    const statusOf = new Map(ledger.bugs.map((b) => [b.id, b.status]));
    const list = [
      { ledgerId: "BUG-0001", actions: [{ id: "sheet.add" }] },
      { ledgerId: "BUG-0002", actions: [{ id: "chart.create" }] },
      { ledgerId: "BUG-9999", actions: [{ id: "table.create" }] },
    ];

    const stale = list.filter((e) => statusOf.get(e.ledgerId) !== "open");
    expect(stale.map((e) => e.ledgerId)).toEqual(["BUG-0001", "BUG-9999"]);
  });
});
