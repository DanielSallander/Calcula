//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/tokenParser.test.ts
// PURPOSE: Lock in formula-autocomplete token parsing, especially dotted
// built-in names (GET.CONTROLVALUE, GET.ROW.HEIGHT) which must resolve as a
// single name so their argument hints can be looked up.

import { describe, it, expect } from "vitest";
import { parseTokenAtCursor, findArgumentSpans } from "./tokenParser";

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

// The screen tip bolds an argument by index; clicking that argument has to
// select the matching characters in the editor. These spans are what the click
// selects, and they come from the same scan the bolded parameter does — a
// second, independent walk over the formula would eventually disagree with the
// bolded parameter and select the wrong text.
describe("findArgumentSpans - what clicking a parameter selects", () => {
  /** The text a span covers, which is what the editor would highlight. */
  function texts(value: string, cursor: number): string[] {
    return findArgumentSpans(value, cursor).map((s) => value.substring(s.start, s.end));
  }

  it("covers every argument of the call, including the ones right of the caret", () => {
    // The caret is inside the FIRST argument; the other three are still there
    // to be clicked, so the spans may not stop where the caret does.
    const value = "=VLOOKUP(A1,B:C,2,FALSE)";
    expect(texts(value, value.indexOf("A1") + 1)).toEqual(["A1", "B:C", "2", "FALSE"]);
  });

  it("gives an argument that has not been typed yet a zero-width span at its place", () => {
    // Clicking the second parameter of "=SUM(A1," must put the caret after the
    // separator rather than do nothing.
    const value = "=SUM(A1,";
    const spans = findArgumentSpans(value, value.length);
    expect(spans).toHaveLength(2);
    expect(spans[1]).toEqual({ start: 8, end: 8 });
  });

  it("selects the argument text without the space in front of it", () => {
    const value = "=SUM(A1, B1)";
    expect(texts(value, 6)).toEqual(["A1", "B1"]);
  });

  it("does not split on a separator that belongs to a nested call or a string", () => {
    const value = '=IF(SUM(A1,B1)>0,"yes,no",C1)';
    expect(texts(value, value.indexOf("A1") + 1)).toEqual(["A1", "B1"]);
    // ...and from the outer call, the nested one is a single argument.
    expect(texts(value, value.indexOf(">"))).toEqual(['SUM(A1,B1)>0', '"yes,no"', "C1"]);
  });

  it("spans the innermost open call, the same one the hint names", () => {
    const value = "=ROUND(SUM(A1,B1),2)";
    const cursor = value.indexOf("B1");
    expect(parseTokenAtCursor(value, cursor).enclosingFunction).toBe("SUM");
    expect(texts(value, cursor)).toEqual(["A1", "B1"]);
  });

  it("stops at the end of a half-typed formula that has no closing paren", () => {
    const value = "=SUM(A1,B1";
    expect(texts(value, value.length)).toEqual(["A1", "B1"]);
  });

  it("has nothing to select when the caret is not inside a named call", () => {
    expect(findArgumentSpans("=A1+B1", 4)).toEqual([]);
    // A bare grouping paren names no function, so the tip shows nothing either.
    expect(findArgumentSpans("=(A1+B1)", 4)).toEqual([]);
  });
});
