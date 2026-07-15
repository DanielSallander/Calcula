//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/tokenParser.test.ts
// PURPOSE: Lock in formula-autocomplete token parsing, especially dotted
// built-in names (GET.CONTROLVALUE, GET.ROW.HEIGHT) which must resolve as a
// single name so their argument hints can be looked up.

import { describe, it, expect } from "vitest";
import { parseTokenAtCursor } from "./tokenParser";

describe("parseTokenAtCursor - dropdown trigger", () => {
  it("triggers on a plain function prefix right after '='", () => {
    const ctx = parseTokenAtCursor("=SU", 3);
    expect(ctx.token).toBe("SU");
    expect(ctx.shouldTrigger).toBe(true);
  });

  it("keeps a dotted name as a single token past the dot", () => {
    const ctx = parseTokenAtCursor("=GET.CONT", 9);
    expect(ctx.token).toBe("GET.CONT");
    expect(ctx.shouldTrigger).toBe(true);
  });

  it("triggers immediately after the dot of a dotted name", () => {
    const ctx = parseTokenAtCursor("=GET.", 5);
    expect(ctx.token).toBe("GET.");
    expect(ctx.shouldTrigger).toBe(true);
  });

  it("does not trigger on a cell reference", () => {
    expect(parseTokenAtCursor("=A1", 3).shouldTrigger).toBe(false);
    expect(parseTokenAtCursor("=$B$2", 5).shouldTrigger).toBe(false);
  });

  it("does not trigger on numbers or decimals", () => {
    expect(parseTokenAtCursor("=SUM(3", 6).shouldTrigger).toBe(false);
    expect(parseTokenAtCursor("=SUM(3.14", 9).shouldTrigger).toBe(false);
  });
});

describe("parseTokenAtCursor - enclosing function (argument hints)", () => {
  it("resolves a plain enclosing function and argument index", () => {
    const ctx = parseTokenAtCursor("=SUM(A1,", 8);
    expect(ctx.enclosingFunction).toBe("SUM");
    expect(ctx.argumentIndex).toBe(1);
  });

  it("resolves a dotted enclosing function as the whole name", () => {
    const ctx = parseTokenAtCursor("=GET.CONTROLVALUE(", 18);
    expect(ctx.enclosingFunction).toBe("GET.CONTROLVALUE");
    expect(ctx.argumentIndex).toBe(0);
  });

  it("tracks the argument index inside a dotted function", () => {
    const value = '=GET.CONTROLVALUE("Region",';
    const ctx = parseTokenAtCursor(value, value.length);
    expect(ctx.enclosingFunction).toBe("GET.CONTROLVALUE");
    expect(ctx.argumentIndex).toBe(1);
  });

  it("resolves a multi-dot enclosing function name", () => {
    const ctx = parseTokenAtCursor("=GET.ROW.HEIGHT(", 16);
    expect(ctx.enclosingFunction).toBe("GET.ROW.HEIGHT");
    expect(ctx.argumentIndex).toBe(0);
  });

  it("does not mistake a leading number for part of the function name", () => {
    // "3.SUM(" is not valid, but the extractor must not return ".SUM"/"3.SUM".
    const ctx = parseTokenAtCursor("=3.SUM(", 7);
    expect(ctx.enclosingFunction).toBe("SUM");
  });

  it("still reports the enclosing function even when the arg token is numeric", () => {
    const ctx = parseTokenAtCursor("=SUM(3.14", 9);
    expect(ctx.enclosingFunction).toBe("SUM");
    expect(ctx.shouldTrigger).toBe(false);
  });

  // Regression: the hint must NOT vanish while typing a quoted string argument.
  // GET.CONTROLVALUE's first argument is always a quoted control name, so a
  // half-typed string has only an OPENING quote -- which previously flipped the
  // backward scan into "in string" mode and swallowed the enclosing "(".
  it("keeps the enclosing function while typing a half-typed string argument", () => {
    const cases = [
      '=GET.CONTROLVALUE("',
      '=GET.CONTROLVALUE("R',
      '=GET.CONTROLVALUE("Region',
    ];
    for (const value of cases) {
      const ctx = parseTokenAtCursor(value, value.length);
      expect(ctx.enclosingFunction).toBe("GET.CONTROLVALUE");
      expect(ctx.argumentIndex).toBe(0);
    }
  });

  it("keeps the enclosing function across a closed string into the next argument", () => {
    const value = '=GET.CONTROLVALUE("Region",';
    const ctx = parseTokenAtCursor(value, value.length);
    expect(ctx.enclosingFunction).toBe("GET.CONTROLVALUE");
    expect(ctx.argumentIndex).toBe(1);
  });

  it("handles half-typed string args for plain and nested functions", () => {
    expect(parseTokenAtCursor('=SUM("te', 8).enclosingFunction).toBe("SUM");
    // A comma, a string opened with '(' and ',' inside must not confuse it.
    const nested = '=IF(A1>0,"y';
    expect(parseTokenAtCursor(nested, nested.length).enclosingFunction).toBe("IF");
    expect(parseTokenAtCursor(nested, nested.length).argumentIndex).toBe(1);
  });

  it("resolves the outer function once an inner call is closed", () => {
    const value = "=IF(SUM(A1,B1),";
    const ctx = parseTokenAtCursor(value, value.length);
    expect(ctx.enclosingFunction).toBe("IF");
    expect(ctx.argumentIndex).toBe(1);
  });
});
