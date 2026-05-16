//! FILENAME: app/extensions/Pivot/dsl/dsl-format-stability.test.ts
// PURPOSE: Verify backward-compatible behavior for Pivot DSL syntax and output.

import { describe, it, expect } from "vitest";
import { lex } from "./lexer";
import { parse } from "./parser";
import { serialize } from "./serializer";
import {
  TokenType,
  KEYWORDS,
  AGGREGATION_NAMES,
  LAYOUT_DIRECTIVES,
  SHOW_VALUES_AS_NAMES,
  VISUAL_CALC_FUNCTIONS,
} from "./tokens";
import { emptyAST } from "./ast";
import type { DslError } from "./errors";

// ============================================================================
// DSL Syntax Stability
// ============================================================================

describe("DSL syntax stability", () => {
  it("ROWS clause parses correctly", () => {
    const { tokens } = lex("ROWS: Region, Country");
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.rows).toHaveLength(2);
    expect(ast.rows[0].name).toBe("Region");
    expect(ast.rows[1].name).toBe("Country");
  });

  it("VALUES clause with aggregation parses correctly", () => {
    const { tokens } = lex('VALUES: Sum(Sales), Average(Quantity)');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.values).toHaveLength(2);
    expect(ast.values[0].aggregation).toBe("sum");
    expect(ast.values[0].fieldName).toBe("Sales");
    expect(ast.values[1].aggregation).toBe("average");
  });

  it("FILTERS with NOT IN parses correctly", () => {
    const { tokens } = lex('FILTERS: Region NOT IN ("North", "South")');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].exclude).toBe(true);
    expect(ast.filters[0].values).toEqual(["North", "South"]);
  });

  it("LAYOUT clause parses known directives", () => {
    const { tokens } = lex("LAYOUT: compact, repeat-labels, no-grand-totals");
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.layout.map((l) => l.key)).toEqual([
      "compact", "repeat-labels", "no-grand-totals",
    ]);
  });

  it("multi-clause DSL parses end-to-end", () => {
    const dsl = [
      "ROWS: Region",
      "COLUMNS: Year",
      "VALUES: Sum(Sales)",
      'FILTERS: Country = ("Sweden")',
      "LAYOUT: tabular",
    ].join("\n");
    const { tokens } = lex(dsl);
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.rows).toHaveLength(1);
    expect(ast.columns).toHaveLength(1);
    expect(ast.values).toHaveLength(1);
    expect(ast.filters).toHaveLength(1);
    expect(ast.layout).toHaveLength(1);
  });
});

// ============================================================================
// Keyword Strings Stability
// ============================================================================

describe("DSL keyword string stability", () => {
  it("all keyword strings are stable (snapshot)", () => {
    expect(Object.keys(KEYWORDS).sort()).toMatchInlineSnapshot(`
      [
        "AS",
        "ASC",
        "BOTTOM",
        "BY",
        "CALC",
        "COLUMNS",
        "DESC",
        "FILTERS",
        "IN",
        "LAYOUT",
        "LOOKUP",
        "NOT",
        "ROWS",
        "SAVE",
        "SORT",
        "TOP",
        "VALUES",
        "VIA",
      ]
    `);
  });

  it("aggregation names are stable (snapshot)", () => {
    expect([...AGGREGATION_NAMES].sort()).toMatchInlineSnapshot(`
      [
        "average",
        "count",
        "countnumbers",
        "max",
        "min",
        "product",
        "stddev",
        "stddevp",
        "sum",
        "var",
        "varp",
      ]
    `);
  });

  it("layout directives are stable (snapshot)", () => {
    expect([...LAYOUT_DIRECTIVES].sort()).toMatchInlineSnapshot(`
      [
        "auto-fit",
        "column-totals",
        "compact",
        "grand-totals",
        "no-column-totals",
        "no-grand-totals",
        "no-repeat-labels",
        "no-row-totals",
        "outline",
        "repeat-labels",
        "row-totals",
        "show-empty-cols",
        "show-empty-rows",
        "subtotals-bottom",
        "subtotals-off",
        "subtotals-top",
        "tabular",
        "values-on-columns",
        "values-on-rows",
      ]
    `);
  });

  it("show-values-as names are stable (snapshot)", () => {
    expect([...SHOW_VALUES_AS_NAMES.keys()].sort()).toMatchInlineSnapshot(`
      [
        "% difference",
        "% of column",
        "% of column total",
        "% of grand total",
        "% of parent column",
        "% of parent row",
        "% of row",
        "% of row total",
        "difference",
        "index",
        "running total",
      ]
    `);
  });

  it("visual calc function names are stable", () => {
    expect([...VISUAL_CALC_FUNCTIONS.keys()].sort()).toMatchInlineSnapshot(`
      [
        "children",
        "first",
        "grandtotal",
        "isatlevel",
        "last",
        "leaves",
        "lookup",
        "lookupwithtotals",
        "movingaverage",
        "next",
        "parent",
        "previous",
        "range",
        "runningsum",
      ]
    `);
  });
});

// ============================================================================
// Serializer Output Format Stability
// ============================================================================

describe("Serializer output format stability", () => {
  it("serializes ROWS clause in stable format", () => {
    const output = serialize(
      [{ name: "Region", sourceIndex: 0, isSelected: false }],
      [],
      [],
      [],
      {},
    );
    expect(output).toBe("ROWS:    Region");
  });

  it("serializes VALUES with Sum() in stable format", () => {
    const output = serialize(
      [],
      [],
      [{ name: "Sales", sourceIndex: 1, isSelected: false, aggregation: "sum" as const }],
      [],
      {},
    );
    expect(output).toBe("VALUES:  Sum(Sales)");
  });

  it("serializes LAYOUT directives in stable format", () => {
    const output = serialize(
      [{ name: "Region", sourceIndex: 0, isSelected: false }],
      [],
      [{ name: "Sales", sourceIndex: 1, isSelected: false, aggregation: "sum" as const }],
      [],
      { reportLayout: "tabular" as const, repeatRowLabels: true },
    );
    expect(output).toContain("LAYOUT:  tabular, repeat-labels");
  });

  it("serializes multi-field ROWS with comma separation", () => {
    const output = serialize(
      [
        { name: "Region", sourceIndex: 0, isSelected: false },
        { name: "City", sourceIndex: 1, isSelected: false },
      ],
      [],
      [],
      [],
      {},
    );
    expect(output).toBe("ROWS:    Region, City");
  });

  it("serializes FILTERS with NOT IN in stable format", () => {
    const output = serialize(
      [],
      [],
      [],
      [{ name: "Region", sourceIndex: 0, isSelected: false, hiddenItems: ["North", "South"] }],
      {},
    );
    expect(output).toBe('FILTERS: Region NOT IN ("North", "South")');
  });
});

// ============================================================================
// Error Message Format Stability
// ============================================================================

describe("DSL error message format stability", () => {
  it("lexer errors have location information", () => {
    const { errors } = lex("ROWS: @invalid");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toHaveProperty("message");
    expect(errors[0]).toHaveProperty("severity");
    expect(errors[0]).toHaveProperty("location");
    expect(errors[0].location).toHaveProperty("line");
    expect(errors[0].location).toHaveProperty("column");
  });

  it("error objects have the DslError shape", () => {
    const { tokens, errors: lexErrors } = lex("VALUES: NotAFunction(X)");
    const { errors: parseErrors } = parse(tokens);
    const allErrors: DslError[] = [...lexErrors, ...parseErrors];
    for (const err of allErrors) {
      expect(err).toHaveProperty("message");
      expect(err).toHaveProperty("severity");
      expect(["error", "warning", "info"]).toContain(err.severity);
      expect(err).toHaveProperty("location");
    }
  });

  it("emptyAST produces a stable empty structure", () => {
    const ast = emptyAST();
    expect(ast).toMatchInlineSnapshot(`
      {
        "calculatedFields": [],
        "columns": [],
        "filters": [],
        "layout": [],
        "rows": [],
        "sort": [],
        "values": [],
      }
    `);
  });
});
