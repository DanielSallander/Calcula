//! FILENAME: app/src/api/designQueryAssist/__tests__/designQueryAssist.test.ts
// PURPOSE: The pure half of the design-query assistant: which names a model is
//          shown and in what order, what it is asked, what constrains its
//          reply, and what is read back out of it.
// CONTEXT: 2026-09-10. The strategy layer decides WHICH names and how they
//          RANK, and nothing else: the tests below pin the rank order, the
//          exclusions and the caps, and the mirror test at the end pins the
//          Rust struct the strategy arrives in.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  buildDesignQueryGrammar,
  buildExamples,
  buildRepairPrompt,
  buildUserPrompt,
  chooseCandidates,
  DESIGN_QUERY_SCHEMA,
  DESIGN_QUERY_SYSTEM_PROMPT,
  DSL_LAYOUT_DIRECTIVES,
  DSL_SHOW_VALUES_AS,
  dslFieldRef,
  extractDesignQuery,
  gbnfTerminal,
  intentOverlap,
  intentTokens,
  MAX_CANDIDATE_DIMENSIONS,
  nameTokens,
  normalizeDsl,
  qualifiedToDsl,
  splitQualified,
  type DesignQueryModel,
} from "../index";

// ---------------------------------------------------------------------------
// A model shaped like the sales-star fixture
// ---------------------------------------------------------------------------

function star(strategy = true): DesignQueryModel {
  return {
    tables: [
      { name: "Sales", columns: [
        { name: "Date", dataType: "Date" }, { name: "ProductKey", dataType: "Int64" },
        { name: "CustomerKey", dataType: "Int64" }, { name: "GeoKey", dataType: "Int64" },
        { name: "Amount", dataType: "Float64" }, { name: "Cost", dataType: "Float64" },
        { name: "Quantity", dataType: "Int64" },
      ] },
      { name: "Product", columns: [
        { name: "ProductKey", dataType: "Int64" }, { name: "Category", dataType: "String" },
        { name: "SubcategoryKey", dataType: "Int64" }, { name: "Name", dataType: "String" },
      ] },
      { name: "Customer", columns: [
        { name: "CustomerKey", dataType: "Int64" }, { name: "Segment", dataType: "String" },
        { name: "Name", dataType: "String" },
      ] },
      { name: "Geography", columns: [
        { name: "GeoKey", dataType: "Int64" }, { name: "Region", dataType: "String" },
        { name: "Country", dataType: "String" },
      ] },
      { name: "Date", columns: [
        { name: "Date", dataType: "Date" }, { name: "Year", dataType: "Int32" },
        { name: "Month", dataType: "String" }, { name: "MonthName", dataType: "String" },
        { name: "MonthNumber", dataType: "Int32" },
      ] },
    ],
    measures: ["Revenue", "Cost", "Margin", "MarginPct", "Quantity", "Customers"].map((name) => ({ name })),
    strategy: strategy
      ? {
          measureOrder: ["Revenue", "MarginPct", "Margin", "Cost", "Quantity", "Customers"],
          measures: {
            Revenue: {
              direction: "higherIsBetter",
              analysisDimensions: ["Product[Category]", "Customer[Segment]", "Geography[Region]"],
              neverSliceBy: ["Product[Name]"],
            },
            Customers: { analysisDimensions: ["Customer[Segment]"], neverSliceBy: ["Customer[Name]"] },
          },
          columnRoles: {
            "Product[Category]": "analysis", "Customer[Segment]": "analysis", "Geography[Region]": "analysis",
            "Product[Name]": "label", "Customer[Name]": "label", "Geography[Country]": "analysis",
            "Product[ProductKey]": "key", "Date[MonthNumber]": "ignore",
          },
          labelColumns: { Product: "Name", Customer: "Name", Geography: "Country" },
          timeAxis: "Date[Date]",
          calendarTable: "Date",
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe("name spelling", () => {
  it("splits a qualified column and spells it the way the DSL does", () => {
    expect(splitQualified("Product[Category]")).toEqual(["Product", "Category"]);
    expect(splitQualified("BI.dim[Full Name]")).toEqual(["BI.dim", "Full Name"]);
    expect(splitQualified("Category")).toBeNull();
    expect(qualifiedToDsl("Product[Category]")).toBe("Product.Category");
    // A space or a dot in either half needs the bracket form the parser accepts.
    expect(qualifiedToDsl("Sales[Order Date]")).toBe("[Sales.Order Date]");
    expect(dslFieldRef("BI.dim_customer", "fullname")).toBe("[BI.dim_customer.fullname]");
  });

  it("tokenizes CamelCase, underscores and dots into words", () => {
    expect(nameTokens("OrderDate_2024")).toEqual(["order", "date", "2024"]);
    expect(nameTokens("MarginPct")).toEqual(["margin", "pct"]);
    expect(nameTokens("Geography.Region")).toEqual(["geography", "region"]);
  });

  it("matches words, inflections through a four-letter prefix, and never a two-letter key", () => {
    const tokens = intentTokens("customers by region and id");
    expect(intentOverlap(tokens, "Customer")).toBe(1);
    expect(intentOverlap(tokens, "Region")).toBe(1);
    // "id" must not reach anything, and "identity" must not be reached by "id".
    expect(intentOverlap(tokens, "Identity")).toBe(0);
    expect(intentOverlap(tokens, "ProductKey")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

describe("chooseCandidates", () => {
  it("puts the measure the request names first, then the strategy's order", () => {
    const c = chooseCandidates(star(), "customers per region");
    expect(c.measures[0]).toBe("Customers");
    expect(c.measures.slice(1, 4)).toEqual(["Revenue", "MarginPct", "Margin"]);
  });

  it("follows the strategy's order when the request names nothing", () => {
    const c = chooseCandidates(star(), "a breakdown please");
    expect(c.measures).toEqual(["Revenue", "MarginPct", "Margin", "Cost", "Quantity", "Customers"]);
  });

  it("uses declaration order with no strategy, and still honours a named measure", () => {
    const c = chooseCandidates(star(false), "margin by segment");
    expect(c.measures[0]).toBe("Margin");
    expect(c.measures).toContain("MarginPct");
    expect(c.dimensions[0]).toBe("Customer.Segment");
  });

  it("never offers a column a lead measure must not be sliced by", () => {
    const c = chooseCandidates(star(), "revenue by product");
    expect(c.dimensions).not.toContain("Product.Name");
    expect(c.dimensions).toContain("Product.Category");
  });

  it("drops keys by role and by name, and ignored columns by role", () => {
    const c = chooseCandidates(star(), "anything");
    for (const d of c.dimensions) {
      expect(d, `${d} is a key`).not.toMatch(/Key$/);
    }
    expect(c.dimensions).not.toContain("Date.MonthNumber");
  });

  it("offers a numeric fact column to aggregate, not to group by", () => {
    const c = chooseCandidates(star(), "total amount by segment");
    expect(c.numericColumns).toContain("Sales.Amount");
    expect(c.dimensions).not.toContain("Sales.Amount");
    // A calendar's Year is numeric AND an axis.
    expect(c.dimensions).toContain("Date.Year");
  });

  it("still offers a numeric column the strategy marks `ignore` for aggregation, never as an axis", () => {
    // Inference marks a fact table's amount columns `ignore` because they are
    // not slicing axes. Summing them is a different question.
    const model = star();
    model.strategy!.columnRoles["Sales[Amount]"] = "ignore";
    model.strategy!.columnRoles["Date[MonthNumber]"] = "ignore";
    const c = chooseCandidates(model, "average amount by segment");
    expect(c.numericColumns).toContain("Sales.Amount");
    expect(c.dimensions).not.toContain("Sales.Amount");
    // An ignored CALENDAR column is neither an axis nor a time grouping.
    expect(c.timeGroupings).not.toContain("Date.MonthNumber");
  });

  it("ranks the analysis dimensions of the lead measure ahead of ordinary columns", () => {
    const c = chooseCandidates(star(), "show revenue");
    const at = (name: string) => c.dimensions.indexOf(name);
    expect(at("Product.Category")).toBeGreaterThanOrEqual(0);
    expect(at("Product.Category")).toBeLessThan(at("Date.Month"));
    expect(at("Customer.Segment")).toBeLessThan(at("Date.Month"));
  });

  it("names the time axis and the calendar groupings coarse first", () => {
    const c = chooseCandidates(star(), "revenue over time");
    expect(c.timeAxis).toBe("Date.Date");
    expect(c.timeGroupings[0]).toBe("Date.Year");
    expect(c.timeGroupings).toContain("Date.MonthName");
    expect(c.timeGroupings.indexOf("Date.Year")).toBeLessThan(c.timeGroupings.indexOf("Date.MonthName"));
  });

  it("finds the calendar without a strategy from the Date-typed table with a Year column", () => {
    const c = chooseCandidates(star(false), "revenue over time");
    expect(c.timeAxis).toBe("Date.Date");
    expect(c.timeGroupings[0]).toBe("Date.Year");
  });

  it("caps both lists and says how many it left out", () => {
    const wide: DesignQueryModel = {
      tables: [{
        name: "Wide",
        columns: Array.from({ length: 40 }, (_, i) => ({ name: `Attr${i}`, dataType: "String" })),
      }],
      measures: Array.from({ length: 30 }, (_, i) => ({ name: `M${i}` })),
    };
    const c = chooseCandidates(wide, "anything");
    expect(c.dimensions).toHaveLength(MAX_CANDIDATE_DIMENSIONS);
    expect(c.droppedDimensions).toBe(40 - MAX_CANDIDATE_DIMENSIONS);
    expect(c.droppedMeasures).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

describe("the prompt", () => {
  it("keeps the system prompt byte-stable and free of model-specific names", () => {
    expect(DESIGN_QUERY_SYSTEM_PROMPT).toBe(DESIGN_QUERY_SYSTEM_PROMPT.slice());
    expect(DESIGN_QUERY_SYSTEM_PROMPT).not.toContain("Revenue");
    expect(DESIGN_QUERY_SYSTEM_PROMPT).toContain("ROWS:");
    expect(DESIGN_QUERY_SYSTEM_PROMPT).toContain("Never invent a name");
    for (const label of DSL_SHOW_VALUES_AS) expect(DESIGN_QUERY_SYSTEM_PROMPT).toContain(`[${label}]`);
  });

  it("lists the names, the time groupings and the request, and states the caps", () => {
    const c = chooseCandidates(star(), "revenue by region");
    const text = buildUserPrompt({ intent: "revenue by region", candidates: { ...c, droppedDimensions: 7 } });
    expect(text).toContain("[Revenue]");
    expect(text).toContain("Geography.Region");
    expect(text).toContain("and 7 more not listed");
    expect(text).toContain("Group time by: Date.Year");
    expect(text.trim().endsWith("Request: revenue by region")).toBe(true);
  });

  it("builds its examples from the candidate names only", () => {
    const c = chooseCandidates(star(), "revenue");
    const examples = buildExamples(c);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    const names = new Set([
      ...c.measures.map((m) => `[${m}]`),
      ...c.dimensions,
      ...c.timeGroupings,
      ...c.numericColumns,
      // The show-values-as labels are vocabulary, not names.
      ...DSL_SHOW_VALUES_AS.map((s) => `[${s}]`),
    ]);
    for (const ex of examples) {
      const json = ex.slice(ex.indexOf("{"));
      const dsl = (JSON.parse(json) as { dsl: string }).dsl;
      for (const token of dsl.match(/\[[^\]]+\]|[A-Za-z_]+\.[A-Za-z_]+/g) ?? []) {
        expect(names.has(token), `${token} was never offered`).toBe(true);
      }
    }
    expect(examples.some((e) => e.includes("[% of grand total]")), "the share form is taught").toBe(true);
    expect(examples.some((e) => e.includes("TOP 3 BY")), "the ranking form is taught").toBe(true);
    // Never a SORT by a measure: the compiler refuses it and a model copies it.
    for (const ex of examples) expect(ex).not.toMatch(/SORT: \[/);
  });

  it("says when there is no calendar rather than staying silent", () => {
    const model = star(false);
    model.tables = model.tables.filter((t) => t.name !== "Date");
    model.tables[0].columns = model.tables[0].columns.filter((c) => c.name !== "Date");
    const text = buildUserPrompt({ intent: "x", candidates: chooseCandidates(model, "x"), examples: false });
    expect(text).toContain("no calendar");
    expect(text).not.toContain("Examples:");
  });

  it("quotes the previous query and the compiler's findings in a repair", () => {
    const text = buildRepairPrompt("ROWS: Foo\nVALUES: [Revenue]", [
      { line: 1, message: 'Unknown field "Foo"' },
      { message: "no VALUES" },
    ]);
    expect(text).toContain("ROWS: Foo");
    expect(text).toContain('- line 1: Unknown field "Foo"');
    expect(text).toContain("- no VALUES");
    expect(text).toContain("same JSON shape");
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("the schema", () => {
  it("bounds every string, requires both fields, and uses no enum", () => {
    const props = DESIGN_QUERY_SCHEMA.properties as Record<string, Record<string, unknown>>;
    for (const [name, p] of Object.entries(props)) {
      expect(p.type, name).toBe("string");
      expect(typeof p.maxLength, `${name} is unbounded`).toBe("number");
      expect(p.enum, `${name} has an enum`).toBeUndefined();
    }
    expect(DESIGN_QUERY_SCHEMA.required).toEqual(["dsl", "explanation"]);
    expect(DESIGN_QUERY_SCHEMA.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

describe("the grammar", () => {
  it("names every candidate as an escaped terminal and nothing else as a dimension", () => {
    const c = chooseCandidates(star(), "revenue by region");
    const g = buildDesignQueryGrammar(c)!;
    expect(g).not.toBeNull();
    for (const d of c.dimensions) expect(g).toContain(`"${d}"`);
    for (const m of c.measures) expect(g).toContain(`"[${m}]"`);
    for (const l of DSL_LAYOUT_DIRECTIVES) expect(g).toContain(`"${l}"`);
    expect(g).toContain('root ::= clause ("\\n" clause)* "\\n"?');
    expect(g).toMatch(/^dim ::= /m);
    // A column the lead measure must never be sliced by is not in the grammar.
    expect(g).not.toContain('"Product.Name"');
  });

  it("escapes quotes and backslashes in a terminal", () => {
    expect(gbnfTerminal('Say "hi"')).toBe('"Say \\"hi\\""');
    expect(gbnfTerminal("a\\b")).toBe('"a\\\\b"');
  });

  it("omits the aggregation rule when there is nothing to aggregate", () => {
    const model = star();
    model.tables[0].columns = model.tables[0].columns.filter((col) => !["Amount", "Cost", "Quantity"].includes(col.name));
    const g = buildDesignQueryGrammar(chooseCandidates(model, "x"))!;
    expect(g).not.toMatch(/^agg ::= /m);
    expect(g).toContain("valref ::= measure");
  });

  it("is null when no valid query could be written", () => {
    expect(buildDesignQueryGrammar({
      measures: [], dimensions: ["A.B"], numericColumns: [], timeAxis: null, timeGroupings: [],
      droppedMeasures: 0, droppedDimensions: 0,
    })).toBeNull();
    expect(buildDesignQueryGrammar({
      measures: ["M"], dimensions: [], numericColumns: [], timeAxis: null, timeGroupings: [],
      droppedMeasures: 0, droppedDimensions: 0,
    })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

describe("extractDesignQuery", () => {
  it("reads a clean JSON reply", () => {
    const p = extractDesignQuery('{"dsl":"ROWS: Product.Category\\nVALUES: [Revenue]","explanation":"Revenue by category."}');
    expect(p?.dsl).toBe("ROWS: Product.Category\nVALUES: [Revenue]");
    expect(p?.explanation).toBe("Revenue by category.");
  });

  it("finds the object inside prose and a fence", () => {
    const p = extractDesignQuery('Sure!\n```json\n{"dsl":"ROWS: A.B\\nVALUES: [M]","explanation":"x"}\n```\nDone.');
    expect(p?.dsl).toBe("ROWS: A.B\nVALUES: [M]");
  });

  it("accepts the bare query a grammar-constrained runtime returns", () => {
    const p = extractDesignQuery("ROWS: Product.Category\nVALUES: [Revenue], [Cost]\nSORT: [Revenue] DESC\n");
    expect(p?.dsl).toBe("ROWS: Product.Category\nVALUES: [Revenue], [Cost]\nSORT: [Revenue] DESC");
    expect(p?.explanation).toBe("");
  });

  it("splits clauses a model ran together on one line, and leaves names alone", () => {
    expect(normalizeDsl("ROWS: Product.Category VALUES: [Revenue] TOP 5 BY [Revenue]")).toBe(
      "ROWS: Product.Category\nVALUES: [Revenue]\nTOP 5 BY [Revenue]",
    );
    // "Top Products" is a name, not a clause.
    expect(normalizeDsl("ROWS: Category.TopProducts\nVALUES: [M]")).toBe("ROWS: Category.TopProducts\nVALUES: [M]");
  });

  it("keeps the query and drops the sentence after it", () => {
    const p = extractDesignQuery("Here you go:\nROWS: A.B\nVALUES: [M]\nThis groups by B.");
    expect(p?.dsl).toBe("ROWS: A.B\nVALUES: [M]");
  });

  it("returns null for a reply with no query in it", () => {
    expect(extractDesignQuery("I cannot help with that.")).toBeNull();
    expect(extractDesignQuery('{"dsl":"hello","explanation":"x"}')).toBeNull();
    expect(extractDesignQuery("")).toBeNull();
  });

  it("normalises Windows line endings", () => {
    expect(extractDesignQuery("ROWS: A.B\r\nVALUES: [M]\r\n")?.dsl).toBe("ROWS: A.B\nVALUES: [M]");
  });
});

// ---------------------------------------------------------------------------
// The Rust mirror
// ---------------------------------------------------------------------------

describe("DesignStrategySummary mirrors the Rust struct", () => {
  // __tests__ -> designQueryAssist -> api -> src -> app -> the repo.
  const REPO = path.resolve(__dirname, "../../../../..");
  const rust = fs.readFileSync(path.join(REPO, "app/src-tauri/src/insights/describe.rs"), "utf8");
  const ts = fs.readFileSync(path.join(__dirname, "../types.ts"), "utf8");

  /** `pub name: Type,` fields of one Rust struct, camelCased. */
  function rustFields(structName: string): string[] {
    const start = rust.indexOf(`pub struct ${structName} {`);
    expect(start, `${structName} not found in describe.rs`).toBeGreaterThan(-1);
    const body = rust.slice(start, rust.indexOf("\n}", start));
    return [...body.matchAll(/^\s*pub ([a-z_]+):/gm)]
      .map((m) => m[1].replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
  }

  /** The property names of one TypeScript interface. */
  function tsFields(name: string): string[] {
    const start = ts.indexOf(`export interface ${name} {`);
    expect(start, `${name} not found in types.ts`).toBeGreaterThan(-1);
    const body = ts.slice(start, ts.indexOf("\n}", start));
    return [...body.matchAll(/^\s+([a-zA-Z]+)\??:/gm)].map((m) => m[1]);
  }

  it("field for field, in both structs", () => {
    expect(tsFields("DesignStrategySummary").sort()).toEqual(rustFields("DesignStrategySummary").sort());
    expect(tsFields("DesignMeasureHints").sort()).toEqual(rustFields("DesignMeasureHints").sort());
  });

  it("parses real fields (a parser that matched nothing would pass vacuously)", () => {
    expect(rustFields("DesignStrategySummary").length).toBeGreaterThanOrEqual(5);
    expect(tsFields("DesignMeasureHints")).toContain("neverSliceBy");
  });
});
