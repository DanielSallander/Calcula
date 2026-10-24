//! FILENAME: app/extensions/_shared/drillThrough/__tests__/dslFilters.test.ts
// PURPOSE: How a drill-through's filters are written into the DSL (one
//          FILTERS clause, bracketed fields, quoted keys with the doubled-quote
//          escape, the blank as ""), merged per field (intersection / union,
//          an empty inclusion refused), and described (labels, never keys).
// CONTEXT: docs/design/model-drillthrough.md 2.4. Each spelling rule here is
//          one the lexer or the compiler imposes, so the bake is proved
//          end-to-end: the baked text is lexed, parsed and compiled against a
//          model, and the request is what the engine route expects.

import { describe, it, expect } from "vitest";
import type { DrillFilterSpec } from "@api";
import {
  BLANK_MEMBER_LABEL,
  DrillBakeRefusal,
  bakeDrillFilters,
  bracketDrillField,
  describeDrillFilters,
  drillFilterTerms,
  drillMemberLabels,
  isBlankMemberKey,
  mergeDrillSpecs,
  quoteDrillKey,
} from "../dslFilters";
import { compileDesignQuery } from "../../dsl/pivotLayout/designQuery";
import { extractControlParams, substituteControlParams } from "../../dsl/pivotLayout/paramSubstitution";
import { lex } from "../../dsl/pivotLayout/lexer";
import { parse } from "../../dsl/pivotLayout/parser";
import type { BiPivotModelInfo } from "../../components/types";

const col = (name: string) => ({ name, dataType: "string", isNumeric: false });
const biModel: BiPivotModelInfo = {
  tables: [
    { name: "Product", columns: [col("Category"), col("Område")] },
    { name: "Geo", columns: [col("Region")] },
    { name: "BI.dim_date", columns: [col("Year")] },
  ],
  measures: [{ name: "Revenue" } as BiPivotModelInfo["measures"][number]],
  connectionId: "c1",
};

const BASE = "ROWS: Geo.Region\nVALUES: [Revenue]";

function compiled(text: string) {
  const out = compileDesignQuery(text, "c1", biModel);
  expect(out.errors, text).toEqual([]);
  expect(out.request).not.toBeNull();
  return out.request!;
}

describe("quoteDrillKey / bracketDrillField: the lexer's spelling", () => {
  it("quotes every key and DOUBLES a quote inside it (the lexer's one escape)", () => {
    // SABOTAGE: write `\"` -- the lexer has no backslash escape.
    expect(quoteDrillKey('Bikes', "F")).toBe('"Bikes"');
    expect(quoteDrillKey('He said "hi"', "F")).toBe('"He said ""hi"""');
    const { tokens, errors } = lex(`FILTERS: [Product.Category] = (${quoteDrillKey('He said "hi"', "F")})`);
    expect(errors).toEqual([]);
    expect(parse(tokens).ast.filters[0].values).toEqual(['He said "hi"']);
  });

  it("the blank member is the empty string, and lexes back to it", () => {
    expect(quoteDrillKey("", "F")).toBe('""');
    const { ast } = parse(lex('FILTERS: [Geo.Region] = ("")').tokens);
    expect(ast.filters[0].values).toEqual([""]);
  });

  it("keeps a key AS-IS: spaces, a number's digits, a Decimal's scale, a date's ISO text", () => {
    for (const key of [" padded ", "2024", "5.50", "2024-01-15 13:04:05", "TRUE", "a,b", "x#y", "me@x.com"]) {
      const { ast, errors } = parse(lex(`FILTERS: [F.G] = (${quoteDrillKey(key, "F.G")})`).tokens);
      expect(errors).toEqual([]);
      expect(ast.filters[0].values).toEqual([key]);
    }
  });

  it("refuses a key with a line break (a string literal stops at the line end)", () => {
    expect(() => quoteDrillKey("two\nlines", "Geo.Region")).toThrow(DrillBakeRefusal);
    try {
      quoteDrillKey("two\nlines", "Geo.Region");
    } catch (e) {
      expect((e as DrillBakeRefusal).field).toBe("Geo.Region");
      expect((e as DrillBakeRefusal).message).toMatch(/line break/);
    }
  });

  it("brackets every field, and refuses one containing ]", () => {
    expect(bracketDrillField("Product.Category")).toBe("[Product.Category]");
    expect(() => bracketDrillField("Weird].Name")).toThrow(DrillBakeRefusal);
  });

  it("a bracketed non-ASCII column and a dotted table name both compile (unbracketed they would not lex)", () => {
    const req = compiled(bakeDrillFilters(BASE, [
      { field: "Product.Område", includedKeys: ["Norr"] },
      { field: "BI.dim_date.Year", includedKeys: ["2024"] },
    ]));
    expect(req.filterFields).toEqual([
      { table: "Product", column: "Område", includedItems: ["Norr"], hiddenItems: [] },
      { table: "BI.dim_date", column: "Year", includedItems: ["2024"], hiddenItems: [] },
    ]);
    // The control: the bare spelling fails to lex.
    expect(lex("FILTERS: Product.Område = (\"Norr\")").errors.length).toBeGreaterThan(0);
  });
});

describe("mergeDrillSpecs: one term set per field", () => {
  it("intersects every inclusion list on a field, in the first list's order, and keeps the labels of the survivors", () => {
    const merged = mergeDrillSpecs([
      { field: "Geo.Region", includedKeys: ["E", "N", "W"], labels: ["East", "North", "West"] },
      { field: "geo.region", includedKeys: ["W", "E"] },
    ]);
    expect(merged).toEqual([{ field: "Geo.Region", includedKeys: ["E", "W"], labels: ["East", "West"] }]);
  });

  it("unites hidden keys once each, and carries an inclusion and an exclusion on one field together", () => {
    const merged = mergeDrillSpecs([
      { field: "Geo.Region", hiddenKeys: ["S", "W"] },
      { field: "Geo.Region", hiddenKeys: ["W", "N"], includedKeys: ["E", "N"] },
    ]);
    expect(merged).toEqual([{ field: "Geo.Region", includedKeys: ["E", "N"], hiddenKeys: ["S", "W", "N"] }]);
  });

  it("REFUSES an empty intersection -- the source shows no members here", () => {
    // SABOTAGE: write `= ()` or a sentinel instead -- the parser rejects the
    // first, and the second runs a query that keeps nothing with no word why.
    expect(() =>
      mergeDrillSpecs([
        { field: "Geo.Region", includedKeys: ["E"] },
        { field: "Geo.Region", includedKeys: ["W"] },
      ]),
    ).toThrow(/no member/);
  });

  it("REFUSES an inclusion handed in empty (a slicer's Select None)", () => {
    expect(() => mergeDrillSpecs([{ field: "Geo.Region", includedKeys: [] }])).toThrow(DrillBakeRefusal);
  });

  it("REFUSES an inclusion the exclusions cancel completely (Rust keeps included minus hidden)", () => {
    // SABOTAGE: drop the check -- the bake writes `= ("East"), NOT IN
    // ("East")` and the drill runs a query that keeps nothing, with no word
    // why (review F6: a page slicer keeping East over a pivot hiding East).
    const cancelled = () =>
      mergeDrillSpecs([
        { field: "Geo.Region", hiddenKeys: ["East"] },
        { field: "geo.region", includedKeys: ["East"] },
      ]);
    expect(cancelled).toThrow(DrillBakeRefusal);
    expect(cancelled).toThrow('The filters on "Geo.Region" keep no member: every member they include is also excluded, so there is nothing to drill into.');
    // A member the exclusions leave standing is a drill.
    expect(
      mergeDrillSpecs([
        { field: "Geo.Region", includedKeys: ["East", "West"] },
        { field: "Geo.Region", hiddenKeys: ["East"] },
      ]),
    ).toEqual([{ field: "Geo.Region", includedKeys: ["East", "West"], hiddenKeys: ["East"] }]);
  });

  it("the blank member is ONE member under either spelling when exclusions cancel an inclusion", () => {
    // Rust's `is_blank_member_key`: "" or "(blank)" in any ASCII case.
    expect(() =>
      mergeDrillSpecs([
        { field: "Geo.Region", hiddenKeys: [""] },
        { field: "Geo.Region", includedKeys: ["(Blank)"] },
      ]),
    ).toThrow(DrillBakeRefusal);
    expect(() =>
      mergeDrillSpecs([
        { field: "Geo.Region", hiddenKeys: ["(BLANK)"] },
        { field: "Geo.Region", includedKeys: ["", "(blank)"] },
      ]),
    ).toThrow(DrillBakeRefusal);
    // A non-blank member hidden as "(blank)" does not cancel a real key.
    expect(mergeDrillSpecs([{ field: "Geo.Region", includedKeys: ["blank"], hiddenKeys: ["(blank)"] }])).toHaveLength(1);
  });

  it("isBlankMemberKey folds ASCII case only, exactly like Rust's eq_ignore_ascii_case", () => {
    expect(isBlankMemberKey("")).toBe(true);
    expect(isBlankMemberKey("(blank)")).toBe(true);
    expect(isBlankMemberKey("(BlAnK)")).toBe(true);
    expect(isBlankMemberKey("(blanK)")).toBe(false); // the Kelvin sign is not an ASCII K
    expect(isBlankMemberKey(" (blank)")).toBe(false);
    expect(isBlankMemberKey("blank")).toBe(false);
  });

  it("drops a spec with nothing to say, keeps first-appearance order, and labels only when every survivor has one", () => {
    const merged = mergeDrillSpecs([
      { field: "A.X", hiddenKeys: [] },
      { field: "B.Y", includedKeys: ["1", "2"], labels: ["one"] },
      { field: "C.Z", includedKeys: ["k"], labels: ["K"] },
    ]);
    expect(merged.map((m) => m.field)).toEqual(["B.Y", "C.Z"]);
    expect(merged[0]).not.toHaveProperty("labels");
    expect(merged[1].labels).toEqual(["K"]);
  });
});

describe("bakeDrillFilters: ONE more FILTERS line", () => {
  it("appends one clause carrying every term, comma-separated, and leaves the text alone when there is nothing to bake", () => {
    const baked = bakeDrillFilters(`${BASE}\n`, [
      { field: "Product.Category", includedKeys: ["Bikes"], labels: ["Bikes"] },
      { field: "Geo.Region", hiddenKeys: ["South"] },
    ]);
    expect(baked).toBe(`${BASE}\nFILTERS: [Product.Category] = ("Bikes"), [Geo.Region] NOT IN ("South")`);
    expect(baked.match(/^\s*FILTERS\s*:/gm)).toHaveLength(1);
    expect(bakeDrillFilters(BASE, [])).toBe(BASE);
    expect(bakeDrillFilters("", [{ field: "Geo.Region", includedKeys: ["E"] }])).toBe('FILTERS: [Geo.Region] = ("E")');
  });

  it("the author's own FILTERS on the same field ANDs with the baked term (the request carries the intersection)", () => {
    // SABOTAGE: `this.ast.filters = ...` in the parser, or the Map-by-name in
    // compileDesignQuery -- either way the author's list or the drilled member
    // silently replaces the other.
    const text = `${BASE}\nFILTERS: [Product.Category] = ("Bikes", "Clothing")`;
    const req = compiled(bakeDrillFilters(text, [{ field: "Product.Category", includedKeys: ["Bikes"] }]));
    expect(req.filterFields).toEqual([{ table: "Product", column: "Category", includedItems: ["Bikes"], hiddenItems: [] }]);
  });

  it("the blank member travels as includedItems [\"\"] -- Rust folds it to the engine's (Blank)", () => {
    const req = compiled(bakeDrillFilters(BASE, [{ field: "Product.Category", includedKeys: [""] }]));
    expect(req.filterFields[0].includedItems).toEqual([""]);
  });

  it("writes a key with a quote so that it compiles back to the same key", () => {
    const req = compiled(bakeDrillFilters(BASE, [{ field: "Product.Category", includedKeys: ['12" wheels'] }]));
    expect(req.filterFields[0].includedItems).toEqual(['12" wheels']);
  });

  it("is a refusal, never a half-written line, when one spec cannot be spelled", () => {
    expect(() =>
      bakeDrillFilters(BASE, [
        { field: "Product.Category", includedKeys: ["Bikes"] },
        { field: "Geo.Region", includedKeys: ["two\nlines"] },
      ]),
    ).toThrow(DrillBakeRefusal);
  });

  it("re-substituting the baked text is a NO-OP, even for a name holding @ or a quote (spec 2.4)", () => {
    // SABOTAGE: drop the bracket skip in scanParamTokens -- the chart's
    // reader re-runs the substitution on every read, reads `@mail` as an
    // unset param and DROPS the baked line: the kept chart then shows
    // unfiltered data with no error (review F7).
    const baked = bakeDrillFilters(BASE, [
      { field: "Contacts.e@mail", includedKeys: ["bob@x.com"] },
      { field: 'P.15" screens', includedKeys: ["a@b"] },
    ]);
    expect(baked).toBe(`${BASE}\nFILTERS: [Contacts.e@mail] = ("bob@x.com"), [P.15" screens] = ("a@b")`);
    expect(substituteControlParams(baked, () => undefined)).toBe(baked);
    expect(extractControlParams(baked)).toEqual([]);
  });

  it("terms of one merged spec: an inclusion term and an exclusion term", () => {
    expect(drillFilterTerms({ field: "Geo.Region", includedKeys: ["E"], hiddenKeys: ["W", "S"] })).toEqual([
      '[Geo.Region] = ("E")',
      '[Geo.Region] NOT IN ("W", "S")',
    ]);
  });
});

describe("describeDrillFilters / drillMemberLabels: labels, never keys", () => {
  it("renders labels and the blank as (Blank), field by field", () => {
    // SABOTAGE: render `includedKeys` -- a Decimal shows as "5.50" and the
    // blank as nothing.
    const specs: DrillFilterSpec[] = [
      { field: "Product.Category", includedKeys: ["BK", ""], labels: ["Bikes", "(blank)"] },
      { field: "Geo.Region", hiddenKeys: ["S", "W"] },
    ];
    expect(describeDrillFilters(specs)).toBe(`Product.Category: Bikes, ${BLANK_MEMBER_LABEL}; Geo.Region: 2 excluded`);
  });

  it("falls back to a COUNT when a kept member has no label (a key is never shown)", () => {
    expect(describeDrillFilters([{ field: "Geo.Region", includedKeys: ["E", "W"] }])).toBe("Geo.Region: 2 selected");
    expect(describeDrillFilters([{ field: "Geo.Region", includedKeys: ["E", "W"], labels: ["East"] }])).toBe("Geo.Region: 2 selected");
    expect(describeDrillFilters([{ field: "Geo.Region", includedKeys: ["E", "W"], labels: ["East", ""] }])).toBe("Geo.Region: 2 selected");
  });

  it("describes the MERGED filters, so the caption says what was baked", () => {
    const text = describeDrillFilters([
      { field: "Geo.Region", includedKeys: ["E", "W"], labels: ["East", "West"] },
      { field: "Geo.Region", includedKeys: ["W"] },
    ]);
    expect(text).toBe("Geo.Region: West");
    expect(describeDrillFilters([])).toBe("");
  });

  it("drillMemberLabels lists the clicked members' labels alone, the blank as (Blank), unlabelled ones skipped", () => {
    expect(drillMemberLabels([
      { field: "Product.Category", includedKeys: ["BK"], labels: ["Bikes"] },
      { field: "Date.Year", includedKeys: ["2024"], labels: ["2024"] },
      { field: "Geo.Region", includedKeys: [""] },
      { field: "X.Y", includedKeys: ["k"] },
    ])).toBe(`Bikes, 2024, ${BLANK_MEMBER_LABEL}`);
  });
});
