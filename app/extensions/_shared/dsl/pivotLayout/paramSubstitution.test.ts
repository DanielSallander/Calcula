//! FILENAME: app/extensions/_shared/dsl/pivotLayout/paramSubstitution.test.ts
import { describe, it, expect } from "vitest";
import type { ControlValue } from "@api/controlValues";
import {
  substituteControlParams,
  hasControlParams,
  extractControlParams,
  dslReferencesControl,
  isBareParamName,
  paramReference,
} from "./paramSubstitution";

function resolver(map: Record<string, ControlValue | undefined>) {
  return (name: string) => map[name];
}

describe("substituteControlParams", () => {
  it("substitutes a text control into a single-value filter", () => {
    const out = substituteControlParams("FILTERS: dim_product.style = @Style", resolver({ Style: { kind: "text", value: "W" } }));
    expect(out).toBe('FILTERS: dim_product.style = ("W")');
  });

  it("substitutes a textList control into a value list", () => {
    const out = substituteControlParams("FILTERS: x = @Sel", resolver({ Sel: { kind: "textList", value: ["A", "B"] } }));
    expect(out).toBe('FILTERS: x = ("A", "B")');
  });

  it("formats numbers and booleans", () => {
    expect(substituteControlParams("FILTERS: n = @N", resolver({ N: { kind: "number", value: 5 } }))).toBe('FILTERS: n = ("5")');
    expect(substituteControlParams("FILTERS: b = @B", resolver({ B: { kind: "boolean", value: true } }))).toBe('FILTERS: b = ("TRUE")');
  });

  it("drops a FILTERS line when the control is unset (show all)", () => {
    const dsl = "ROWS: a\nFILTERS: x = @Missing\nVALUES: [M]";
    expect(substituteControlParams(dsl, resolver({}))).toBe("ROWS: a\nVALUES: [M]");
  });

  it("drops a FILTERS line for empty text or (All)", () => {
    expect(substituteControlParams("FILTERS: x = @S", resolver({ S: { kind: "text", value: "" } }))).toBe("");
    expect(substituteControlParams("FILTERS: x = @S", resolver({ S: { kind: "text", value: "(All)" } }))).toBe("");
  });

  it("an empty textList (Select None) matches NOTHING, not all", () => {
    // Ribbon-filter parity: an applied empty selection empties its targets.
    const out = substituteControlParams("FILTERS: x = @S", resolver({ S: { kind: "textList", value: [] } }));
    expect(out).toBe('FILTERS: x = ("__CALCULA_EMPTY_SELECTION__")');
  });

  it("leaves lines without params unchanged", () => {
    const dsl = "ROWS: a\nVALUES: [M]";
    expect(substituteControlParams(dsl, resolver({}))).toBe(dsl);
  });

  // --- @Name grammar (quoted names, unicode, scoping) -----------------------

  it('resolves quoted names: @"Products.Category" (default ribbon-filter names)', () => {
    const out = substituteControlParams(
      'FILTERS: Products.Category = @"Products.Category"',
      resolver({ "Products.Category": { kind: "text", value: "Bikes" } }),
    );
    expect(out).toBe('FILTERS: Products.Category = ("Bikes")');
  });

  it('resolves quoted names with spaces: @"Region Filter"', () => {
    const out = substituteControlParams(
      'FILTERS: r = @"Region Filter"',
      resolver({ "Region Filter": { kind: "text", value: "East" } }),
    );
    expect(out).toBe('FILTERS: r = ("East")');
  });

  it("resolves unicode bare names (e.g. Swedish)", () => {
    const out = substituteControlParams(
      "FILTERS: omr = @Område",
      resolver({ Område: { kind: "text", value: "Nord" } }),
    );
    expect(out).toBe('FILTERS: omr = ("Nord")');
  });

  it("ignores @ inside quoted string values (data, not a param)", () => {
    const dsl = 'FILTERS: email = ("bob@example.com")';
    expect(substituteControlParams(dsl, resolver({}))).toBe(dsl);
    expect(hasControlParams(dsl)).toBe(false);
  });

  it("ignores @ after a trailing # comment on a FILTERS line", () => {
    const dsl = "FILTERS: x = (\"A\") # ping @alice";
    expect(substituteControlParams(dsl, resolver({}))).toBe(dsl);
    expect(hasControlParams(dsl)).toBe(false);
  });

  it("never rewrites non-FILTERS lines (comments, ROWS, CALC)", () => {
    const dsl = "# review by @alice\nROWS: @NotAParam\nCALC: x = [M] # @y";
    expect(substituteControlParams(dsl, resolver({ NotAParam: { kind: "text", value: "V" } }))).toBe(dsl);
    expect(hasControlParams(dsl)).toBe(false);
  });

  it("substitutes multiple params on one line; any unset drops the line", () => {
    const both = resolver({
      A: { kind: "text", value: "x" },
      B: { kind: "text", value: "y" },
    });
    expect(substituteControlParams("FILTERS: a = @A, b = @B", both)).toBe(
      'FILTERS: a = ("x"), b = ("y")',
    );
    const oneUnset = resolver({ A: { kind: "text", value: "x" } });
    expect(substituteControlParams("FILTERS: a = @A, b = @B", oneUnset)).toBe("");
  });

  it("is immune to String.replace $-expansion in values", () => {
    const out = substituteControlParams(
      "FILTERS: f = @X",
      resolver({ X: { kind: "text", value: "A$&B$'C" } }),
    );
    expect(out).toBe("FILTERS: f = (\"A$&B$'C\")");
  });

  it('escapes a literal double quote in values as "" (lexer-supported)', () => {
    const out = substituteControlParams(
      "FILTERS: size = @S",
      resolver({ S: { kind: "text", value: '5" pipe' } }),
    );
    expect(out).toBe('FILTERS: size = ("5"" pipe")');
  });

  it("hasControlParams detects @tokens on FILTERS lines only", () => {
    expect(hasControlParams("FILTERS: x = @A")).toBe(true);
    expect(hasControlParams('FILTERS: x = @"A B"')).toBe(true);
    expect(hasControlParams("ROWS: a")).toBe(false);
    expect(hasControlParams("# email bob@example.com")).toBe(false);
  });
});

describe("extractControlParams / dslReferencesControl", () => {
  const dsl = 'ROWS: a\nFILTERS: x = @Region, y = @"Products.Category"\nVALUES: [M]';

  it("extracts bare and quoted names from FILTERS lines", () => {
    expect(extractControlParams(dsl)).toEqual(["Region", "Products.Category"]);
  });

  it("matches referenced controls case-insensitively", () => {
    expect(dslReferencesControl(dsl, ["REGION"])).toBe(true);
    expect(dslReferencesControl(dsl, ["products.category"])).toBe(true);
    expect(dslReferencesControl(dsl, ["Other"])).toBe(false);
    expect(dslReferencesControl(dsl, [])).toBe(false);
  });
});

describe("paramReference / isBareParamName", () => {
  it("bare for identifier-like names (incl. unicode)", () => {
    expect(isBareParamName("Region")).toBe(true);
    expect(isBareParamName("Område")).toBe(true);
    expect(paramReference("Region")).toBe("@Region");
  });

  it("quoted for names with dots or spaces", () => {
    expect(isBareParamName("Products.Category")).toBe(false);
    expect(paramReference("Products.Category")).toBe('@"Products.Category"');
    expect(paramReference("Region Filter")).toBe('@"Region Filter"');
  });

  it("undefined for names containing a double quote (not expressible)", () => {
    expect(paramReference('My "special" one')).toBeUndefined();
  });
});
