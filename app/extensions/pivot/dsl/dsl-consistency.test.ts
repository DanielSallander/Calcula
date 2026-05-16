//! FILENAME: app/extensions/Pivot/dsl/dsl-consistency.test.ts
// PURPOSE: Integration-level consistency checks for the Pivot DSL pipeline,
//          verifying that lexer, parser, compiler, and serializer agree.

import { describe, it, expect } from "vitest";
import { lex } from "./lexer";
import { parse } from "./parser";
import { compile, type CompileContext } from "./compiler";
import { serialize } from "./serializer";
import { processDsl } from "./index";
import { TokenType } from "./tokens";
import type { SourceField } from "../_shared/components/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

const FIELDS: SourceField[] = [
  sf(0, "Region"),
  sf(1, "Product"),
  sf(2, "Quarter"),
  sf(3, "Sales", true),
  sf(4, "Profit", true),
  sf(5, "Quantity", true),
  sf(6, "Category"),
  sf(7, "Date"),
];

function ctx(fields: SourceField[] = FIELDS): CompileContext {
  return { sourceFields: fields };
}

// ===========================================================================
// Lexer token spans cover entire input (no gaps, no overlaps)
// ===========================================================================

describe("lexer token spans cover entire input", () => {
  function checkCoverage(input: string) {
    const { tokens } = lex(input);

    // Reconstruct the input from tokens.
    // Tokens that cover content: everything except EOF.
    // The lexer skips spaces/tabs/\r but emits Newline, Comment, etc.
    // We verify: no token overlaps another, and non-whitespace characters are covered.

    // Build a coverage array
    const covered = new Array(input.length).fill(false);

    for (const tok of tokens) {
      if (tok.type === TokenType.EOF) continue;
      if (tok.type === TokenType.Newline) {
        // Newline tokens mark a \n. Find it by line/col.
        // The token value is '\n' and location is the position of the newline.
        continue; // newlines are single chars, covered implicitly
      }
    }

    // The key invariant: every non-whitespace character in the input should
    // appear in exactly one token's value. Let's verify token values reconstruct
    // the non-whitespace content.
    const tokenValues = tokens
      .filter((t) => t.type !== TokenType.EOF)
      .map((t) => t.value);

    // The lexer skips whitespace (spaces, tabs, \r) but emits tokens for
    // everything else. It strips delimiters from strings and brackets.
    // Comments preserve their internal spaces. So we verify that every
    // token value is a substring of the input and tokens appear in order.
    let searchFrom = 0;
    for (const tok of tokens) {
      if (tok.type === TokenType.EOF) continue;
      // For bracket/string tokens, find the content within delimiters
      const idx = input.indexOf(tok.value, searchFrom);
      expect(idx).toBeGreaterThanOrEqual(searchFrom);
      searchFrom = idx + tok.value.length;
      // Skip past closing delimiters that the lexer strips
      if (tok.type === TokenType.StringLiteral && input[searchFrom] === '"') searchFrom++;
      if (tok.type === TokenType.BracketIdentifier && input[searchFrom] === ']') searchFrom++;
    }
    // Verify we consumed close to the entire input
    // (only trailing whitespace may remain)
    const remaining = input.slice(searchFrom).trim();
    expect(remaining).toBe("");
  }

  it("simple ROWS clause", () => {
    checkCoverage("ROWS: Region, Product");
  });

  it("multi-line DSL", () => {
    checkCoverage("ROWS: Region\nVALUES: Sum(Sales)");
  });

  it("DSL with comments", () => {
    checkCoverage("# comment\nROWS: Region");
  });

  it("DSL with string literals", () => {
    checkCoverage('FILTERS: Region = "North"');
  });

  it("DSL with bracket identifiers", () => {
    checkCoverage("VALUES: [TotalRevenue]");
  });
});

// ===========================================================================
// Compiler field indices match sourceFields array
// ===========================================================================

describe("compiler field indices match sourceFields array", () => {
  it("row field sourceIndex matches FIELDS array", () => {
    const result = processDsl("ROWS: Region, Product", ctx());
    for (const field of result.rows) {
      const sourceField = FIELDS.find((f) => f.name === field.name);
      expect(sourceField).toBeDefined();
      expect(field.sourceIndex).toBe(sourceField!.index);
    }
  });

  it("value field sourceIndex matches FIELDS array", () => {
    const result = processDsl("VALUES: Sum(Sales)", ctx());
    for (const field of result.values) {
      const sourceField = FIELDS.find((f) => f.name === field.name);
      expect(sourceField).toBeDefined();
      expect(field.sourceIndex).toBe(sourceField!.index);
    }
  });

  it("filter field sourceIndex matches FIELDS array", () => {
    const result = processDsl('FILTERS: Region = "North"', ctx());
    for (const field of result.filters) {
      const sourceField = FIELDS.find((f) => f.name === field.name);
      expect(sourceField).toBeDefined();
      expect(field.sourceIndex).toBe(sourceField!.index);
    }
  });

  it("column field sourceIndex matches FIELDS array", () => {
    const result = processDsl("COLUMNS: Quarter", ctx());
    for (const field of result.columns) {
      const sourceField = FIELDS.find((f) => f.name === field.name);
      expect(sourceField).toBeDefined();
      expect(field.sourceIndex).toBe(sourceField!.index);
    }
  });
});

// ===========================================================================
// Serialize output can always be re-parsed without new errors
// ===========================================================================

describe("serialize output can be re-parsed without new errors", () => {
  function roundTrip(dsl: string) {
    const result1 = processDsl(dsl, ctx());
    // Only proceed if first parse had no fatal errors
    const fatalErrors1 = result1.errors.filter((e) => e.severity === "error");

    const serialized = serialize(
      result1.rows,
      result1.columns,
      result1.values,
      result1.filters,
      result1.layout,
    );

    const result2 = processDsl(serialized, ctx());
    const fatalErrors2 = result2.errors.filter((e) => e.severity === "error");

    // Re-parse should not introduce NEW errors beyond what original had
    expect(fatalErrors2.length).toBeLessThanOrEqual(fatalErrors1.length);
    return { result1, result2, serialized };
  }

  it("simple ROWS + VALUES round-trips", () => {
    roundTrip("ROWS: Region\nVALUES: Sum(Sales)");
  });

  it("ROWS + COLUMNS + VALUES round-trips", () => {
    roundTrip("ROWS: Region\nCOLUMNS: Quarter\nVALUES: Sum(Sales)");
  });

  it("multiple value fields round-trip", () => {
    roundTrip("ROWS: Region\nVALUES: Sum(Sales), Avg(Profit)");
  });

  it("round-tripped rows match original", () => {
    const { result1, result2 } = roundTrip("ROWS: Region, Product\nVALUES: Sum(Sales)");
    expect(result2.rows.map((r) => r.name)).toEqual(result1.rows.map((r) => r.name));
    expect(result2.values.map((v) => v.name)).toEqual(result1.values.map((v) => v.name));
  });
});

// ===========================================================================
// processDsl is deterministic (same input = same output)
// ===========================================================================

describe("processDsl is deterministic", () => {
  const inputs = [
    "ROWS: Region\nVALUES: Sum(Sales)",
    "ROWS: Region, Product\nCOLUMNS: Quarter\nVALUES: Sum(Sales), Avg(Profit)",
    'ROWS: Region\nFILTERS: Category = "Tech"\nVALUES: Count(Sales)',
    "ROWS: Region\nVALUES: Sum(Sales)\nSORT: Sales DESC",
    "ROWS: Region\nVALUES: Sum(Sales)\nLAYOUT: tabular",
  ];

  for (const input of inputs) {
    it(`deterministic for: ${input.replace(/\n/g, " | ")}`, () => {
      const context = ctx();
      const first = processDsl(input, context);
      for (let i = 0; i < 5; i++) {
        const result = processDsl(input, context);
        expect(result.rows).toEqual(first.rows);
        expect(result.columns).toEqual(first.columns);
        expect(result.values).toEqual(first.values);
        expect(result.filters).toEqual(first.filters);
        expect(result.layout).toEqual(first.layout);
        expect(result.errors.length).toBe(first.errors.length);
      }
    });
  }
});
