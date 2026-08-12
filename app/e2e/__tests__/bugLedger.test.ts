//! FILENAME: app/e2e/__tests__/bugLedger.test.ts
// PURPOSE: Unit tier for the bug ledger's ID ALLOCATOR -- the one piece of the
//          soak/invariant harness that can silently destroy a record.
// CONTEXT: `tests/regression/bug-ledger.json` is written by the soak runner and
//          by the invariant harness, and EDITED BY HAND whenever a bug is filed
//          from an e2e or review pass. Both writers went through
//          `tests/soak/bug-ledger.mjs`; the hand edits did not.
//
//          Measured 2026-08-12: the file held BUG-0024 through BUG-0028 above a
//          `nextId` of 24. All five were filed by hand and none bumped the
//          counter. The next soak finding would have been issued "BUG-0024" a
//          SECOND time, and `updateBug` resolved an id with `.find`, so every
//          later patch -- triage, fix status, validatedBy -- would have landed
//          on the first entry carrying that id: a closed, unrelated bug
//          rewritten in place, with the new one left un-updatable. Nothing in
//          the tree could have said so; the harness had no unit tier at all,
//          which is the same gap that let the trace minimiser ship discarding
//          its own answer (see the header of vitest.config.ts).
//
//          This file lives under `e2e/__tests__` because that is where the
//          harness's node-side unit tier already runs. The module under test is
//          shared by both harnesses, not owned by either.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain ESM harness module, no type declarations by design
import { addBug, updateBug, nextFreeId } from "../../../tests/soak/bug-ledger.mjs";

interface Ledger {
  version: number;
  nextId: number;
  bugs: { id: string; status: string; [k: string]: unknown }[];
}

const ledgerWith = (nextId: number, ids: string[]): Ledger => ({
  version: 1,
  nextId,
  bugs: ids.map((id) => ({ id, status: "open" })),
});

describe("the bug ledger's id allocator", () => {
  it("derives the next id from the ENTRIES, not from the counter", () => {
    // The exact state the real file was in: five hand-filed bugs above a
    // counter that never moved.
    const ledger = ledgerWith(24, [
      "BUG-0024",
      "BUG-0025",
      "BUG-0026",
      "BUG-0027",
      "BUG-0028",
    ]);
    expect(nextFreeId(ledger)).toBe(29);
    expect(addBug(ledger, {})).toBe("BUG-0029");
    expect(ledger.nextId).toBe(30);
  });

  it("never issues an id that already exists", () => {
    const ledger = ledgerWith(24, ["BUG-0024", "BUG-0025", "BUG-0026"]);
    const issued = [addBug(ledger, {}), addBug(ledger, {}), addBug(ledger, {})];
    expect(issued).toEqual(["BUG-0027", "BUG-0028", "BUG-0029"]);
    const ids = ledger.bugs.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the counter as a FLOOR, so ids do not go backwards after a deletion", () => {
    // Deleting the highest entry must not hand its number to a different bug:
    // the id is quoted in traces, repro bundles and the register.
    const ledger = ledgerWith(40, ["BUG-0005"]);
    expect(nextFreeId(ledger)).toBe(40);
    expect(addBug(ledger, {})).toBe("BUG-0040");
  });

  it("ignores entries whose id is not a BUG-nnnn at all", () => {
    const ledger = ledgerWith(1, ["BUG-0003", "not-a-bug-id", ""]);
    expect(nextFreeId(ledger)).toBe(4);
  });

  it("starts at 1 on an empty ledger", () => {
    expect(nextFreeId({ version: 1, nextId: 1, bugs: [] })).toBe(1);
  });
});

describe("updateBug refuses to guess", () => {
  it("patches the one entry that carries the id", () => {
    const ledger = ledgerWith(3, ["BUG-0001", "BUG-0002"]);
    updateBug(ledger, "BUG-0002", { status: "fixed" });
    expect(ledger.bugs.map((b) => b.status)).toEqual(["open", "fixed"]);
  });

  it("throws on an unknown id rather than writing nothing quietly", () => {
    expect(() => updateBug(ledger0(), "BUG-9999", { status: "fixed" })).toThrow(
      /Unknown bug id/,
    );
  });

  it("throws on a DUPLICATE id instead of patching the first match", () => {
    // The failure mode the stale counter would have produced. Picking the first
    // match is what rewrites a closed bug with an unrelated one's triage.
    const ledger = ledgerWith(3, ["BUG-0002", "BUG-0002"]);
    expect(() => updateBug(ledger, "BUG-0002", { status: "fixed" })).toThrow(
      /Duplicate bug id BUG-0002: 2 entries share it/,
    );
  });

  function ledger0(): Ledger {
    return ledgerWith(2, ["BUG-0001"]);
  }
});

describe("the committed ledger is internally consistent", () => {
  const ledger: Ledger = JSON.parse(
    readFileSync(
      join(process.cwd(), "..", "tests", "regression", "bug-ledger.json"),
      "utf8",
    ),
  );

  it("has no duplicate ids", () => {
    const ids = ledger.bugs.map((b) => b.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes, `duplicate bug ids in the committed ledger: ${dupes.join(", ")}`).toEqual([]);
  });

  it("carries a counter above every id it already holds", () => {
    expect(
      ledger.nextId,
      "tests/regression/bug-ledger.json's nextId is at or below an id it " +
        "already contains, so the next soak finding would be issued a duplicate",
    ).toBe(nextFreeId(ledger));
  });

  it("agrees with itself about which bugs are fixed", () => {
    // `status` and `fix.status` are two fields saying one thing, and the
    // markdown view renders the outer one while agents read the inner one.
    const disagreeing = ledger.bugs
      .filter((b) => {
        const inner = (b.fix as { status?: string } | undefined)?.status;
        if (inner === undefined) return false;
        const outerFixed = b.status === "fixed" || b.status === "verified-by-user";
        const innerFixed = inner === "fixed";
        return outerFixed !== innerFixed;
      })
      .map((b) => `${b.id}: status=${b.status} fix.status=${(b.fix as { status?: string }).status}`);
    expect(
      disagreeing,
      "a bug whose two status fields disagree reads as open in one view and " +
        "closed in the other. (This is NOT what hid BUG-0026 and BUG-0028 for " +
        "a day: those agreed with each other and disagreed with the TREE, " +
        "which no file-local rule can see.)",
    ).toEqual([]);
  });
});
