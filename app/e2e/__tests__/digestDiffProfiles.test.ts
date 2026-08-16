//! FILENAME: app/e2e/__tests__/digestDiffProfiles.test.ts
// PURPOSE: Unit tier for `diffDigests`' profile exclusions -- the decision about
//          what each oracle is entitled to call a difference.
//
// WHY THIS FILE EXISTS. The undo round-trip oracle's whole judgement is
// "baseline digest == digest after winding back", so anything the profile
// compares that undo does not restore is a false positive BY CONSTRUCTION -- it
// fires on a correct product, every time, and no threshold can tune it away.
// One such field shipped: `activeSheet`.
//
// MEASURED on invariant seed 20260815001, the first walk the newly-decidable
// oracle ever judged: `sheet.switch {tabIndex: 0}` at action 4, twenty-two
// ordinary transactions after it, and winding all 22 back produced exactly ONE
// digest difference in the entire workbook -- `activeSheet: 2 -> 0`. That is the
// walk's own sheet switch, which is `deliberately_clean(Navigation)` in the
// backend and pushes no undo entry, reported as an undo defect. See
// UNDO_EXCLUDED_SECTIONS in oracles/digest.ts for the full argument and for
// what covers the behaviour instead.
//
// The exclusions are asymmetric on purpose and the asymmetry is the thing worth
// pinning: `activeSheet` IS persisted, so save/reload must still compare it.

import { describe, it, expect } from "vitest";
import { diffDigests, hashValue } from "../oracles/digest";
import type { Digest } from "../oracles/digest";

/** A minimal but structurally real digest. */
function digest(over: Record<string, unknown> = {}): Digest {
  const value = {
    version: 1,
    activeSheet: 0,
    sheetNames: ["Sheet1", "Sheet2"],
    sheets: [
      { name: "Sheet1", cells: { "0:0": { v: "1", s: 0 } } },
      { name: "Sheet2", cells: {} },
    ],
    usedStyles: { 0: { bold: false } },
    namedRanges: {},
    tables: {},
    charts: {},
    protectedRegions: { a: 1 },
    ...over,
  };
  return { hash: hashValue(value), digest: value as never };
}

describe("the undo profile does not compare the view position", () => {
  it("calls two digests equal when only the active sheet differs", () => {
    const result = diffDigests(digest(), digest({ activeSheet: 2 }), "undo");
    expect(result.equal, JSON.stringify(result.diffs)).toBe(true);
  });

  it("still compares everything else", () => {
    // The self-test: an exclusion that swallowed a real difference would be
    // worse than the false positive it removed.
    const changed = digest({
      activeSheet: 2,
      sheets: [
        { name: "Sheet1", cells: { "0:0": { v: "999", s: 0 } } },
        { name: "Sheet2", cells: {} },
      ],
    });
    const result = diffDigests(digest(), changed, "undo");
    expect(result.equal).toBe(false);
    expect(result.diffs.map((d) => d.path).join(" ")).toContain("sheets");
    expect(
      result.diffs.map((d) => d.path).join(" "),
      "the excluded field must not reappear in the diff list",
    ).not.toContain("activeSheet");
  });

  it("still compares the sheet NAMES, which undo can move", () => {
    // Renaming a sheet ends the history, so the oracle declines those windows
    // rather than comparing them -- but a name that changed with no rename is a
    // finding, and dropping `activeSheet` must not drop its neighbour.
    const result = diffDigests(
      digest(),
      digest({ sheetNames: ["Sheet1", "Renamed"] }),
      "undo",
    );
    expect(result.equal).toBe(false);
    expect(result.diffs[0].path).toContain("sheetNames");
  });
});

describe("the saveReload profile DOES compare the active sheet", () => {
  it("reports a save/reload that lost which sheet was active", () => {
    // `workbook.active_sheet` is persisted. Losing it across a save and reopen
    // is a real defect, and this is the only oracle positioned to see it.
    const result = diffDigests(digest({ activeSheet: 1 }), digest(), "saveReload");
    expect(result.equal).toBe(false);
    expect(result.diffs.map((d) => d.path)).toContain("activeSheet");
  });
});

describe("the exclusions both profiles have always had", () => {
  it("ignores protectedRegions everywhere", () => {
    for (const profile of ["undo", "saveReload"] as const) {
      const result = diffDigests(
        digest(),
        digest({ protectedRegions: { b: 2 } }),
        profile,
      );
      expect(result.equal, `${profile} compared protectedRegions`).toBe(true);
    }
  });

  it("ignores the usedStyles MAP only across save/reload", () => {
    // Index 7 is in the map and referenced by no cell, which is the case the
    // exclusion is about: style INDICES are reassigned by a save/reload, so the
    // map itself is not comparable while the styles the cells resolve to are.
    // (Changing a style a cell DOES reference still shows up under saveReload,
    // through the resolved-style substitution -- that is the whole point of it.)
    const changed = digest({ usedStyles: { 0: { bold: false }, 7: { bold: true } } });
    expect(diffDigests(digest(), changed, "saveReload").equal).toBe(true);
    expect(
      diffDigests(digest(), changed, "undo").equal,
      "style indices ARE stable in memory -- the undo profile must still compare them",
    ).toBe(false);
  });
});
