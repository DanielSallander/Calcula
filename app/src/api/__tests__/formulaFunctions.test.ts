//! FILENAME: app/src/api/__tests__/formulaFunctions.test.ts
// PURPOSE: The two author-facing UDF contracts that live in the registry
//          module: the cell-error sentinel (a UDF's way to return #N/A rather
//          than the TEXT "#N/A") and the volatile flag (does this cell
//          recalculate on every edit, or only when its arguments change?).

import { describe, it, expect } from "vitest";

import {
  registerFunction,
  getVolatileCustomFunctionNames,
  getCustomFunction,
  cellError,
  normalizeCellErrorLiteral,
  asCellErrorSentinel,
  thrownCellErrorLiteral,
  UDF_ERROR_KEY,
  CELL_ERROR_LITERALS,
  type CustomFunctionDef,
} from "../formulaFunctions";

function def(
  over: Partial<CustomFunctionDef> & { name: string },
): CustomFunctionDef {
  return {
    description: "",
    syntax: "",
    category: "Custom",
    minArgs: 0,
    maxArgs: -1,
    implementation: () => 1,
    ...over,
  };
}

describe("cell-error sentinel", () => {
  it("cellError builds the sentinel under the wire key", () => {
    expect(cellError("#N/A")).toEqual({ [UDF_ERROR_KEY]: "#N/A" });
  });

  it("normalizes case and whitespace, and degrades unknown codes to #VALUE!", () => {
    expect(normalizeCellErrorLiteral(" #n/a ")).toBe("#N/A");
    expect(normalizeCellErrorLiteral("#div/0!")).toBe("#DIV/0!");
    // #NUM!/#NULL! now have engine variants of their own (they arrive from
    // .xlsx), so they must SURVIVE rather than collapse — the assertion here
    // used to be the opposite and pinned the old absence.
    expect(normalizeCellErrorLiteral("#NUM!")).toBe("#NUM!");
    expect(normalizeCellErrorLiteral("#null!")).toBe("#NULL!");
    expect(normalizeCellErrorLiteral("not an error")).toBe("#VALUE!");
    expect(normalizeCellErrorLiteral(42)).toBe("#VALUE!");
  });

  // The calculation-budget error. If this literal were missing from
  // CELL_ERROR_LITERALS it would silently normalize to #VALUE! — the exact
  // conflation the engine gave it a distinct CellError variant to escape, put
  // back by the frontend on the way through.
  it("keeps #LIMIT! distinct instead of collapsing it into #VALUE!", () => {
    expect(normalizeCellErrorLiteral("#LIMIT!")).toBe("#LIMIT!");
    expect(normalizeCellErrorLiteral(" #limit! ")).toBe("#LIMIT!");
    expect(CELL_ERROR_LITERALS).toContain("#LIMIT!");
    // The trailing "!" is load-bearing: the backend's Debug fallback would
    // render "#LIMIT", and that must NOT be accepted as the same thing.
    expect(normalizeCellErrorLiteral("#LIMIT")).toBe("#VALUE!");
  });

  // The blocked-dynamic-array error. Same argument as #LIMIT!, and the
  // sharpest case of it: a blocked array's remedy is in ANOTHER CELL ("clear
  // what is in the way"), so collapsing it to #VALUE! sends the user to inspect
  // a formula whose arguments are all correct.
  it("keeps #SPILL! distinct instead of collapsing it into #VALUE!", () => {
    expect(normalizeCellErrorLiteral("#SPILL!")).toBe("#SPILL!");
    expect(normalizeCellErrorLiteral(" #spill! ")).toBe("#SPILL!");
    expect(CELL_ERROR_LITERALS).toContain("#SPILL!");
    expect(normalizeCellErrorLiteral("#SPILL")).toBe("#VALUE!");
  });

  it("every advertised literal round-trips through normalize", () => {
    for (const lit of CELL_ERROR_LITERALS) {
      expect(normalizeCellErrorLiteral(lit)).toBe(lit);
    }
  });

  // --------------------------------------------------------------------------
  // The DRIFT GUARD for the API list, read out of cell.rs at test time.
  // --------------------------------------------------------------------------
  //
  // `isErrorValue` (gridRenderer/styles/cellFormatting.ts) already has a guard
  // of this shape in core/lib/__tests__/type-guards-exhaustive.test.ts, and it
  // covers a DIFFERENT list — the renderer's. Nothing covered THIS one, so the
  // two `CELL_ERROR_LITERALS` constants could drift apart silently: the grid
  // would paint a new variant red while `normalizeCellErrorLiteral` collapsed
  // the same variant to #VALUE! on the UDF path.
  //
  // That collapse is lossy and SILENT — it is exactly what the comments on
  // #LIMIT! and #SPILL! in formulaFunctions.ts describe, and both of those were
  // caught by hand after the fact. Two literals had already been added to the
  // engine (#NUM!, #NULL!) while this list said they had "no engine variant".
  // Reading the engine's own table is what makes the coverage checkable.
  it("advertises EVERY CellError literal the engine can produce", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const cellRs = fs.readFileSync(
      path.join(__dirname, "../../../../core/engine/src/cell.rs"),
      "utf8",
    );
    // The canonical table: `CellError::X => "#LITERAL"` inside as_literal().
    const start = cellRs.indexOf("pub fn as_literal");
    expect(start, "as_literal not found in core/engine/src/cell.rs").toBeGreaterThan(-1);
    const body = cellRs.slice(start, cellRs.indexOf("\n    }", start));
    const literals = [
      ...new Set([...body.matchAll(/CellError::\w+\s*=>\s*"([^"]+)"/g)].map((m) => m[1])),
    ];
    expect(
      literals.length,
      "parsed no literals out of CellError::as_literal -- the Rust shape changed",
    ).toBeGreaterThan(5);

    for (const literal of literals) {
      expect(
        CELL_ERROR_LITERALS as readonly string[],
        `CELL_ERROR_LITERALS (api/formulaFunctions.ts) is missing "${literal}", which ` +
          `core/engine/src/cell.rs (CellError::as_literal) can put in a cell. ` +
          `normalizeCellErrorLiteral would collapse it to #VALUE! -- a UDF could not ` +
          `return it, and a value carrying it would lose its identity crossing the API.`,
      ).toContain(literal);
      // And it must survive normalize, not merely be listed.
      expect(normalizeCellErrorLiteral(literal)).toBe(literal);
    }

    // The reverse direction: a literal advertised here that the engine cannot
    // produce is a promise nothing can keep.
    for (const advertised of CELL_ERROR_LITERALS) {
      expect(
        literals,
        `CELL_ERROR_LITERALS advertises "${advertised}", which core/engine/src/cell.rs ` +
          `can no longer produce -- remove it or restore the CellError variant.`,
      ).toContain(advertised);
    }
  });

  it("asCellErrorSentinel matches ONLY the object form", () => {
    expect(asCellErrorSentinel(cellError("#REF!"))).toBe("#REF!");
    // A returned string must stay text (Excel parity: only CVErr is an error).
    expect(asCellErrorSentinel("#REF!")).toBeNull();
    expect(asCellErrorSentinel(new Error("#REF!"))).toBeNull();
    expect(asCellErrorSentinel(null)).toBeNull();
    expect(asCellErrorSentinel(123)).toBeNull();
  });

  it("thrownCellErrorLiteral accepts the sentinel AND an exact-literal message", () => {
    expect(thrownCellErrorLiteral(cellError("#N/A"))).toBe("#N/A");
    // The worker error channel only carries `message`, so this form matters.
    expect(thrownCellErrorLiteral(new Error("#N/A"))).toBe("#N/A");
    expect(thrownCellErrorLiteral("#n/a")).toBe("#N/A");
    // A real bug must NOT be mistaken for an error return.
    expect(thrownCellErrorLiteral(new Error("x is not a function"))).toBeNull();
    expect(thrownCellErrorLiteral(new Error("value #N/A was missing"))).toBeNull();
    expect(thrownCellErrorLiteral(undefined)).toBeNull();
  });
});

describe("volatile flag", () => {
  it("defaults to non-volatile and is excluded from the volatile name list", () => {
    const cleanup = registerFunction(def({ name: "VOLTEST_PLAIN" }));
    expect(getCustomFunction("VOLTEST_PLAIN")?.volatile).toBeUndefined();
    expect(getVolatileCustomFunctionNames()).not.toContain("VOLTEST_PLAIN");
    cleanup();
  });

  it("reports functions registered volatile, by uppercased name", () => {
    const cleanup = registerFunction(def({ name: "voltest_tick", volatile: true }));
    expect(getCustomFunction("VOLTEST_TICK")?.volatile).toBe(true);
    expect(getVolatileCustomFunctionNames()).toContain("VOLTEST_TICK");
    cleanup();
    // Unregistering removes it again (no stale volatility after an edit).
    expect(getVolatileCustomFunctionNames()).not.toContain("VOLTEST_TICK");
  });
});
