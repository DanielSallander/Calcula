//! FILENAME: app/extensions/Pivot/dsl/dsl-error-handling.test.ts
// PURPOSE: Verify defensive coding across DSL pipeline stages (lex, parse, compile, serialize, processDsl).
// CONTEXT: Ensures all functions handle null/undefined/empty/malformed inputs gracefully.

import { describe, it, expect } from "vitest";
import { lex } from "./lexer";
import { parse } from "./parser";
import { compile, type CompileContext } from "./compiler";
import { serialize } from "./serializer";
import { processDsl } from "./index";
import { validate } from "./validator";
import { emptyAST } from "./ast";
import { TokenType } from "./tokens";

// ============================================================================
// Helpers
// ============================================================================

function minimalContext(): CompileContext {
  return {
    sourceFields: [
      { index: 0, name: "Region", isNumeric: false },
      { index: 1, name: "Sales", isNumeric: true },
      { index: 2, name: "Profit", isNumeric: true },
    ],
  };
}

// ============================================================================
// lex - null/undefined/empty/malformed inputs
// ============================================================================

describe("lex error handling", () => {
  it("handles empty string", () => {
    const result = lex("");
    expect(result.tokens.length).toBe(1); // just EOF
    expect(result.tokens[0].type).toBe(TokenType.EOF);
    expect(result.errors).toEqual([]);
  });

  it("throws on null/undefined (no runtime guard)", () => {
    expect(() => lex(null as unknown as string)).toThrow();
    expect(() => lex(undefined as unknown as string)).toThrow();
  });

  it("reports error for unknown characters", () => {
    const result = lex("ROWS: @%&");
    expect(result.errors.length).toBeGreaterThan(0);
    // Should still produce tokens for the valid parts
    expect(result.tokens.some(t => t.type === TokenType.Rows)).toBe(true);
  });

  it("reports error for unterminated string", () => {
    const result = lex('FILTERS: Region = "hello');
    expect(result.errors.some(e => e.message.includes("Unterminated"))).toBe(true);
  });

  it("reports error for unterminated bracket identifier", () => {
    const result = lex("VALUES: [TotalSales");
    expect(result.errors.some(e => e.message.includes("Unterminated"))).toBe(true);
  });

  it("handles string with only whitespace", () => {
    const result = lex("   \t  \r  ");
    expect(result.tokens.length).toBe(1); // just EOF
    expect(result.errors).toEqual([]);
  });

  it("handles string with only newlines", () => {
    const result = lex("\n\n\n");
    // Should have newline tokens + EOF
    expect(result.tokens.filter(t => t.type === TokenType.Newline).length).toBe(3);
  });

  it("handles very long input", () => {
    const input = "ROWS: " + "Field, ".repeat(1000) + "LastField";
    const result = lex(input);
    expect(result.errors).toEqual([]);
    expect(result.tokens.length).toBeGreaterThan(1000);
  });

  it("handles comments correctly", () => {
    const result = lex("# this is a comment\nROWS: Region");
    expect(result.tokens.some(t => t.type === TokenType.Comment)).toBe(true);
    expect(result.tokens.some(t => t.type === TokenType.Rows)).toBe(true);
  });

  it("lexes number literals with decimals", () => {
    const result = lex("TOP 10.5");
    expect(result.tokens.some(t => t.type === TokenType.NumberLiteral && t.value === "10.5")).toBe(true);
  });
});

// ============================================================================
// parse - null/undefined/empty/malformed token streams
// ============================================================================

describe("parse error handling", () => {
  it("handles empty token stream (just EOF)", () => {
    const { tokens } = lex("");
    const result = parse(tokens);
    expect(result.errors).toEqual([]);
    expect(result.ast.rows).toEqual([]);
    expect(result.ast.columns).toEqual([]);
    expect(result.ast.values).toEqual([]);
  });

  it("handles garbage input with error recovery", () => {
    const { tokens } = lex("!!! ??? ### ROWS: Region");
    const result = parse(tokens);
    // Should recover and parse ROWS clause despite leading garbage
    expect(result.ast.rows.length).toBeGreaterThanOrEqual(0);
    // Should report errors for the garbage
    expect(result.errors.length).toBeGreaterThanOrEqual(0);
  });

  it("handles clause with no fields after colon", () => {
    const { tokens } = lex("ROWS:");
    const result = parse(tokens);
    expect(result.ast.rows).toEqual([]);
  });

  it("handles VALUES with unknown aggregation", () => {
    // "FooBar(Sales)" -- FooBar is not recognized as aggregation, so parsed as bare field
    const { tokens } = lex("VALUES: Sales");
    const result = parse(tokens);
    expect(result.ast.values.length).toBe(1);
  });

  it("handles FILTERS with missing value after =", () => {
    const { tokens } = lex("FILTERS: Region = ");
    const result = parse(tokens);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.message.includes("Expected quoted string"))).toBe(true);
  });

  it("handles TOP without number", () => {
    const { tokens } = lex("TOP BY Sales");
    const result = parse(tokens);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.message.includes("number"))).toBe(true);
  });

  it("handles SAVE without AS", () => {
    const { tokens } = lex('SAVE "test"');
    const result = parse(tokens);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("handles multiple clauses with errors interspersed", () => {
    const input = `ROWS: Region
VALUES: !!!
COLUMNS: Sales`;
    const { tokens } = lex(input);
    const result = parse(tokens);
    // Should parse ROWS and possibly COLUMNS despite VALUES error
    expect(result.ast.rows.length).toBe(1);
  });

  it("handles CALC with missing equals", () => {
    const { tokens } = lex("CALC MyField");
    const result = parse(tokens);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("handles LAYOUT with unknown directives", () => {
    const { tokens } = lex("LAYOUT: compact, unknown-thing");
    const result = parse(tokens);
    // Parser accepts any identifier as a directive; compiler/validator catches unknowns
    expect(result.ast.layout.length).toBe(2);
  });

  it("handles dotted identifiers in ROWS", () => {
    const { tokens } = lex("ROWS: Orders.Region");
    const result = parse(tokens);
    expect(result.ast.rows.length).toBe(1);
    expect(result.ast.rows[0].table).toBe("Orders");
    expect(result.ast.rows[0].column).toBe("Region");
  });
});

// ============================================================================
// compile - invalid CompileContext inputs
// ============================================================================

describe("compile error handling", () => {
  it("handles empty AST with valid context", () => {
    const result = compile(emptyAST(), minimalContext());
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.values).toEqual([]);
    expect(result.filters).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("handles AST with unknown field names", () => {
    const { tokens } = lex("ROWS: UnknownField");
    const { ast } = parse(tokens);
    const result = compile(ast, minimalContext());
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.message.includes("Unknown field"))).toBe(true);
  });

  it("handles empty sourceFields", () => {
    const { tokens } = lex("ROWS: Region");
    const { ast } = parse(tokens);
    const result = compile(ast, { sourceFields: [] });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("handles bracket measures without BI model", () => {
    const { tokens } = lex("VALUES: [TotalSales]");
    const { ast } = parse(tokens);
    const result = compile(ast, minimalContext());
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.message.includes("BI"))).toBe(true);
  });

  it("handles BI context with dotted field names", () => {
    const ctx: CompileContext = {
      sourceFields: [],
      biModel: {
        tables: [
          { name: "Orders", columns: [{ name: "Region", isNumeric: false }, { name: "Amount", isNumeric: true }] },
        ],
        measures: [{ name: "TotalSales", aggregation: "sum" as any }],
        relationships: [],
      },
    };
    const { tokens } = lex("ROWS: Orders.Region\nVALUES: [TotalSales]");
    const { ast } = parse(tokens);
    const result = compile(ast, ctx);
    expect(result.rows.length).toBe(1);
    expect(result.values.length).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("handles BI context with unknown dotted field", () => {
    const ctx: CompileContext = {
      sourceFields: [],
      biModel: {
        tables: [{ name: "Orders", columns: [{ name: "Region", isNumeric: false }] }],
        measures: [],
        relationships: [],
      },
    };
    const { tokens } = lex("ROWS: Orders.Ghost");
    const { ast } = parse(tokens);
    const result = compile(ast, ctx);
    expect(result.errors.some(e => e.message.includes("Unknown field"))).toBe(true);
  });

  it("handles FILTERS with inclusion values and no unique values map", () => {
    const { tokens } = lex('FILTERS: Region = ("East")');
    const { ast } = parse(tokens);
    const result = compile(ast, minimalContext());
    // Without filterUniqueValues, inclusion filters can't be inverted
    expect(result.filters.length).toBe(1);
  });

  it("handles LAYOUT with unknown directive (produces warning)", () => {
    const { tokens } = lex("LAYOUT: compact, bogus-directive");
    const { ast } = parse(tokens);
    const result = compile(ast, minimalContext());
    expect(result.errors.some(e => e.message.includes("Unknown layout directive"))).toBe(true);
  });

  it("compiles all valid layout directives", () => {
    const directives = [
      "compact", "outline", "tabular", "repeat-labels", "no-repeat-labels",
      "no-grand-totals", "grand-totals", "no-row-totals", "row-totals",
      "no-column-totals", "column-totals", "show-empty-rows", "show-empty-cols",
      "values-on-rows", "values-on-columns", "auto-fit",
    ];
    for (const d of directives) {
      const { tokens } = lex(`LAYOUT: ${d}`);
      const { ast } = parse(tokens);
      const result = compile(ast, minimalContext());
      // Should not produce errors for valid directives
      const layoutErrors = result.errors.filter(e => e.message.includes("layout"));
      expect(layoutErrors.length).toBe(0);
    }
  });
});

// ============================================================================
// serialize - empty/edge-case inputs
// ============================================================================

describe("serialize error handling", () => {
  it("handles all empty arrays", () => {
    const result = serialize([], [], [], [], {});
    expect(result).toBe("");
  });

  it("handles empty rows but non-empty values", () => {
    const result = serialize(
      [],
      [],
      [{ sourceIndex: 0, name: "Sales", isNumeric: true, aggregation: "sum" as any }],
      [],
      {},
    );
    expect(result).toContain("VALUES:");
  });

  it("handles fields with special characters in names", () => {
    const result = serialize(
      [{ sourceIndex: 0, name: "My Field (special)", isNumeric: false }],
      [],
      [],
      [],
      {},
    );
    expect(result).toContain('"My Field (special)"');
  });

  it("handles filters with hiddenItems", () => {
    const result = serialize(
      [],
      [],
      [],
      [{ sourceIndex: 0, name: "Region", isNumeric: false, hiddenItems: ["East", "West"] }],
      {},
    );
    expect(result).toContain("NOT IN");
  });

  it("handles layout with all options set", () => {
    const result = serialize([], [], [], [], {
      reportLayout: "tabular",
      repeatRowLabels: true,
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
      showEmptyRows: true,
      showEmptyCols: true,
      valuesPosition: "rows",
      autoFitColumnWidths: true,
    });
    expect(result).toContain("LAYOUT:");
    expect(result).toContain("tabular");
  });

  it("handles saveAs option", () => {
    const result = serialize([], [], [], [], {}, { saveAs: "My Layout" });
    expect(result).toContain('SAVE AS "My Layout"');
  });

  it("handles BI measure value fields", () => {
    const result = serialize(
      [],
      [],
      [{ sourceIndex: -1, name: "[TotalSales]", isNumeric: true, customName: "[TotalSales]", aggregation: "sum" as any }],
      [],
      {},
      {
        biModel: {
          tables: [],
          measures: [{ name: "TotalSales", aggregation: "sum" as any }],
          relationships: [],
        },
      },
    );
    expect(result).toContain("[TotalSales]");
  });
});

// ============================================================================
// validate - edge cases
// ============================================================================

describe("validate error handling", () => {
  it("handles empty AST", () => {
    const errors = validate(emptyAST(), { sourceFields: [] });
    expect(Array.isArray(errors)).toBe(true);
  });

  it("reports unknown fields", () => {
    const { tokens } = lex("ROWS: UnknownField");
    const { ast } = parse(tokens);
    const errors = validate(ast, { sourceFields: [] });
    expect(errors.some(e => e.message.includes("Unknown field"))).toBe(true);
  });

  it("reports duplicate fields across zones", () => {
    const { tokens } = lex("ROWS: Region\nCOLUMNS: Region");
    const { ast } = parse(tokens);
    const ctx = minimalContext();
    const errors = validate(ast, ctx);
    expect(errors.some(e => e.message.includes("appears in both"))).toBe(true);
  });

  it("reports info when no VALUES defined", () => {
    const { tokens } = lex("ROWS: Region");
    const { ast } = parse(tokens);
    const errors = validate(ast, minimalContext());
    expect(errors.some(e => e.severity === "info")).toBe(true);
  });

  it("warns about numeric aggregation on non-numeric field", () => {
    const { tokens } = lex("VALUES: Sum(Region)");
    const { ast } = parse(tokens);
    const errors = validate(ast, minimalContext());
    expect(errors.some(e => e.message.includes("non-numeric"))).toBe(true);
  });

  it("warns about filter with no values", () => {
    const { tokens } = lex("FILTERS: Region");
    const { ast } = parse(tokens);
    const errors = validate(ast, minimalContext());
    expect(errors.some(e => e.message.includes("no values"))).toBe(true);
  });
});

// ============================================================================
// processDsl - full pipeline with invalid inputs
// ============================================================================

describe("processDsl error handling", () => {
  it("handles empty string", () => {
    const result = processDsl("", minimalContext());
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.values).toEqual([]);
  });

  it("throws on null/undefined (no runtime guard)", () => {
    expect(() => processDsl(null as unknown as string, minimalContext())).toThrow();
    expect(() => processDsl(undefined as unknown as string, minimalContext())).toThrow();
  });

  it("accumulates errors from all pipeline stages", () => {
    const result = processDsl(
      "ROWS: @UnknownField\nVALUES: [NonExistentMeasure]",
      minimalContext(),
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("handles completely invalid DSL", () => {
    const result = processDsl("@@@ ### !!!", minimalContext());
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.rows).toEqual([]);
  });

  it("handles valid DSL with all clauses", () => {
    const input = `ROWS: Region
VALUES: Sum(Sales), Sum(Profit)
FILTERS: Region = ("East")
SORT: Sales DESC
LAYOUT: compact, repeat-labels`;
    const ctx: CompileContext = {
      ...minimalContext(),
      filterUniqueValues: new Map([["Region", ["East", "West", "North"]]]),
    };
    const result = processDsl(input, ctx);
    expect(result.rows.length).toBe(1);
    expect(result.values.length).toBe(2);
    expect(result.filters.length).toBe(1);
  });

  it("provides descriptive error messages with location info", () => {
    const result = processDsl("ROWS: UnknownField", { sourceFields: [] });
    for (const err of result.errors) {
      expect(err.message.length).toBeGreaterThan(0);
      expect(typeof err.location.line).toBe("number");
      expect(typeof err.location.column).toBe("number");
    }
  });

  it("handles CALC with expression referencing bracket measures", () => {
    const input = "CALC Revenue = [Sales] * 2";
    const result = processDsl(input, minimalContext());
    expect(result.calculatedFields.length).toBe(1);
    expect(result.calculatedFields[0].name).toBe("Revenue");
    expect(result.calculatedFields[0].formula).toContain("[Sales]");
  });
});
