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
    // Excel has #NUM!/#NULL!; the engine has no variant, so they must land on
    // #VALUE! rather than silently disappearing.
    expect(normalizeCellErrorLiteral("#NUM!")).toBe("#VALUE!");
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

  it("every advertised literal round-trips through normalize", () => {
    for (const lit of CELL_ERROR_LITERALS) {
      expect(normalizeCellErrorLiteral(lit)).toBe(lit);
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
