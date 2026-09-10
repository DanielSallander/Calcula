//! FILENAME: app/extensions/_shared/dsl/pivotLayout/dsl-lenient-values.test.ts
// PURPOSE: A filter value may be single-quoted or a bare number, and a
//          redundant direction after TOP/BOTTOM is accepted while a
//          contradictory one is refused by name.
// CONTEXT: 2026-09-10, measured on the design-query corpus: of forty drafts
//          from a 1.5B coder model, nine failed on `= ('Consumer')`, `= '2024'`
//          or `= 2024`, and five on `TOP 3 BY [X] DESC`. None of those is a
//          judgement error, and a person types all four shapes too. Double
//          quotes stay the canonical form the serializer writes; the parser
//          simply reads what a value can only mean.

import { describe, it, expect } from "vitest";
import { lex } from "./lexer";
import { parse } from "./parser";
import { serialize } from "./serializer";
import { canonicalDesignQuery, sameDesignQuery } from "./canonical";

function parsed(dsl: string) {
  const { tokens, errors: lexErrors } = lex(dsl);
  const { ast, errors } = parse(tokens);
  return { ast, errors: [...lexErrors, ...errors].filter((e) => e.severity === "error") };
}

describe("filter values", () => {
  it("accepts single-quoted values as the same value", () => {
    const a = parsed('ROWS: Product.Category\nVALUES: [Quantity]\nFILTERS: Customer.Segment = ("Consumer")');
    const b = parsed("ROWS: Product.Category\nVALUES: [Quantity]\nFILTERS: Customer.Segment = ('Consumer')");
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(b.ast.filters[0].values).toEqual(["Consumer"]);
    expect(sameDesignQuery(
      'ROWS: Product.Category\nVALUES: [Quantity]\nFILTERS: Customer.Segment = ("Consumer")',
      "ROWS: Product.Category\nVALUES: [Quantity]\nFILTERS: Customer.Segment = ('Consumer')",
    )).toBe(true);
  });

  it("accepts a bare number, and a quoted one, as the same value", () => {
    const bare = parsed("ROWS: Customer.Segment\nVALUES: [Revenue]\nFILTERS: Date.Year = (2024)");
    expect(bare.errors).toEqual([]);
    expect(bare.ast.filters[0].values).toEqual(["2024"]);
    expect(sameDesignQuery(
      "ROWS: Customer.Segment\nVALUES: [Revenue]\nFILTERS: Date.Year = (2024)",
      'ROWS: Customer.Segment\nVALUES: [Revenue]\nFILTERS: Date.Year = ("2024")',
    )).toBe(true);
    // Without parentheses and mixed, as a person writes it.
    const mixed = parsed("ROWS: Customer.Segment\nVALUES: [Revenue]\nFILTERS: Date.Year = 2023, 'x', \"y\"");
    expect(mixed.errors).toEqual([]);
    expect(mixed.ast.filters[0].values).toEqual(["2023", "x", "y"]);
  });

  it("accepts them in a field's NOT IN list too", () => {
    const p = parsed("ROWS: Geography.Region NOT IN ('Europe', 2)\nVALUES: [Revenue]");
    expect(p.errors).toEqual([]);
    expect(p.ast.rows[0].hiddenItems).toEqual(["Europe", "2"]);
  });

  it("still refuses a value that is not a value", () => {
    const p = parsed("ROWS: Product.Category\nVALUES: [Quantity]\nFILTERS: Customer.Segment = (Consumer)");
    expect(p.errors.map((e) => e.message)).toContain('Expected quoted string value after "=" or "NOT IN"');
  });

  it("serializes back to double quotes, the canonical form", () => {
    const text = serialize(
      [],
      [],
      [],
      [{ sourceIndex: -1, name: "Customer.Segment", isNumeric: false, hiddenItems: ["Business"] } as never],
      {},
      {},
    );
    expect(text).toContain('"Business"');
    expect(text).not.toContain("'Business'");
  });
});

describe("TOP / BOTTOM direction", () => {
  it("accepts a redundant direction", () => {
    const top = parsed("ROWS: Geography.Country\nVALUES: [Revenue]\nTOP 5 BY [Revenue] DESC");
    expect(top.errors).toEqual([]);
    expect(top.ast.topN).toMatchObject({ count: 5, top: true, byField: "Revenue" });
    const bottom = parsed("ROWS: Geography.Country\nVALUES: [Revenue]\nBOTTOM 5 BY [Revenue] ASC");
    expect(bottom.errors).toEqual([]);
    expect(bottom.ast.topN).toMatchObject({ count: 5, top: false });
    expect(canonicalDesignQuery("ROWS: A.B\nVALUES: [M]\nTOP 5 BY [M] DESC"))
      .toBe(canonicalDesignQuery("ROWS: A.B\nVALUES: [M]\nTOP 5 BY [M]"));
  });

  it("refuses a contradictory direction by naming the clause the person wanted", () => {
    const p = parsed("ROWS: Geography.Country\nVALUES: [Revenue]\nTOP 5 BY [Revenue] ASC");
    expect(p.errors.map((e) => e.message)).toContain(
      "TOP already ranks highest first; for the lowest values write BOTTOM N BY ...",
    );
    const q = parsed("ROWS: Geography.Country\nVALUES: [Revenue]\nBOTTOM 5 BY [Revenue] DESC");
    expect(q.errors.map((e) => e.message)).toContain(
      "BOTTOM already ranks lowest first; for the highest values write TOP N BY ...",
    );
  });
});
