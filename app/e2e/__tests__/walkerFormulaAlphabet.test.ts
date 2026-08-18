//! FILENAME: app/e2e/__tests__/walkerFormulaAlphabet.test.ts
// PURPOSE: Keep the soak walker's formula alphabet inside the four constraints
//          that make a walk's failures MEAN something.
//
// The alphabet sat at six formulas for a long time, guarded by a belief rather
// than a test: "widening it changes what the committed seeds mean". That was
// false in both halves — there is no committed seed and no seed-derived baseline
// in the repo — but the constraints that DO matter were equally unenforced, and
// they are the ones that cost a run when broken. Each of the four below has a
// concrete failure attached to it, so a future entry that violates one fails here
// rather than three hours into a soak.

import { describe, it, expect } from "vitest";
import { FORMULAS } from "../walker/actionCatalog";
import { VOLATILE_FORMULA } from "../oracles/recalcConsistency";

/** Functions whose result SPILLS across neighbouring cells. */
const SPILLING = /\b(SORT|SORTBY|UNIQUE|SEQUENCE|FILTER|RANDARRAY|TRANSPOSE|XLOOKUP)\s*\(/i;

describe("the walker's formula alphabet", () => {
  it("is non-trivial and every entry is a formula", () => {
    expect(FORMULAS.length).toBeGreaterThan(6);
    for (const f of FORMULAS) {
      expect(f.startsWith("="), `"${f}" must start with '='`).toBe(true);
    }
    expect(new Set(FORMULAS).size, "duplicates waste a draw").toBe(FORMULAS.length);
  });

  it("uses ';' argument separators, never ','", () => {
    // The suite runs under sv-SE, where ',' is the DECIMAL separator and a
    // comma-separated argument list silently mis-parses — the walker would then
    // be exercising a text cell it believes is a formula.
    const offenders = FORMULAS.filter((f) => {
      // A comma inside a quoted criteria string is not an argument separator.
      const withoutStrings = f.replace(/"[^"]*"/g, '""');
      return withoutStrings.includes(",");
    });
    expect(
      offenders,
      "these use ',' as an argument separator, which mis-parses under sv-SE — " +
        "use ';' (see the actionCatalog header)",
    ).toEqual([]);
  });

  it("contains no VOLATILE function, read from the oracle's own definition", () => {
    // Not a copy of the regex: `recalcConsistency` exports it, so the guard and
    // the oracle cannot drift. That oracle skips cells that ARE volatile but not
    // cells that merely DEPEND on one, so a single volatile entry makes it fire on
    // legitimate change for anything the walker later builds on G10:G12.
    const offenders = FORMULAS.filter((f) => VOLATILE_FORMULA.test(f));
    expect(
      offenders,
      "a volatile entry makes recalc-consistency report legitimate changes as " +
        "violations for every cell downstream of it",
    ).toEqual([]);
  });

  it("contains nothing that SPILLS", () => {
    // The five write targets are a 2x3 block (G10, H10, G11, H11, G12), so a
    // spilling formula lands on its neighbours and yields #SPILL! depending on
    // which target the rng drew first — a nondeterministic failure that looks
    // like a product bug.
    const offenders = FORMULAS.filter((f) => SPILLING.test(f));
    expect(
      offenders,
      "the walker writes into a 2x3 block, so a spilling formula collides with " +
        "its own neighbours nondeterministically",
    ).toEqual([]);
  });

  it("contains no literal 'Test', which replace.all would rewrite mid-walk", () => {
    // `replace.all` rewrites "Test" -> "Tst" across the whole workbook, so a
    // formula carrying it would be silently corrupted partway through a walk and
    // every later assertion about that cell would be about a different formula.
    const offenders = FORMULAS.filter((f) => f.includes("Test"));
    expect(offenders).toEqual([]);
  });

  it("stays clear of the ranges other actions mutate", () => {
    // structure.insert-row/delete-row work rows 45-55, insert-col/delete-col work
    // cols 55-65 (BC..BM). A formula referencing those would change meaning
    // underneath the walk for reasons that are not a defect.
    const offenders = FORMULAS.filter((f) => {
      for (const m of f.matchAll(/\$?([A-Z]{1,2})\$?(\d{1,7})/g)) {
        const row = Number(m[2]);
        if (row >= 45 && row <= 55) return true;
        const col = m[1]
          .split("")
          .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
        if (col >= 56 && col <= 66) return true;
      }
      return false;
    });
    expect(
      offenders,
      "these reference the rows/columns that structure.insert-* and delete-* " +
        "mutate, so their meaning changes mid-walk for a non-defect reason",
    ).toEqual([]);
  });
});
