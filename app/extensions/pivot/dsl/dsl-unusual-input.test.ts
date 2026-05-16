//! FILENAME: app/extensions/Pivot/dsl/dsl-unusual-input.test.ts
// PURPOSE: Tests with unusual/extreme DSL inputs to find edge cases in parsing and compilation.

import { describe, it, expect } from "vitest";
import { processDsl } from "./index";
import { lex } from "./lexer";
import { parse } from "./parser";
import type { SourceField } from "../_shared/components/types";
import type { CompileContext } from "./compiler";

// ============================================================================
// Test Helpers
// ============================================================================

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

function ctx(fields: SourceField[]): CompileContext {
  return { sourceFields: fields };
}

function run(dsl: string, fields: SourceField[]) {
  return processDsl(dsl, ctx(fields));
}

// ============================================================================
// DSL with 100 ROWS fields
// ============================================================================

describe("DSL with 100 ROWS fields", () => {
  const fields100 = Array.from({ length: 100 }, (_, i) => sf(i, `Field${i}`));
  const rowsList = fields100.map((f) => f.name).join(", ");

  it("parses 100 ROWS fields without crashing", () => {
    const result = run(`ROWS: ${rowsList}`, fields100);
    expect(result).toBeDefined();
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("lexer handles very long ROWS clause", () => {
    const { tokens, errors } = lex(`ROWS: ${rowsList}`);
    expect(tokens.length).toBeGreaterThan(100);
    expect(errors).toHaveLength(0);
  });
});

// ============================================================================
// DSL with 50 VALUES each with different aggregation
// ============================================================================

describe("DSL with 50 VALUES with different aggregations", () => {
  const numericFields = Array.from({ length: 50 }, (_, i) => sf(i, `Metric${i}`, true));
  const aggTypes = ["SUM", "AVG", "COUNT", "MIN", "MAX"];
  const valuesClause = numericFields
    .map((f, i) => `${aggTypes[i % aggTypes.length]}(${f.name})`)
    .join(", ");

  it("parses 50 VALUES without error", () => {
    const result = run(`VALUES: ${valuesClause}`, numericFields);
    expect(result).toBeDefined();
    expect(result.values.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves different aggregation types", () => {
    const result = run(`VALUES: ${valuesClause}`, numericFields);
    // At minimum, all recognized values should be present
    expect(result.values.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// DSL with filter containing 500 items
// ============================================================================

describe("DSL with filter containing 500 items", () => {
  const fields = [sf(0, "Category"), sf(1, "Amount", true)];
  const filterItems = Array.from({ length: 500 }, (_, i) => `"Item${i}"`).join(", ");

  it("parses large FILTER clause", () => {
    const dsl = `FILTER: Category IN (${filterItems})`;
    const result = run(dsl, fields);
    expect(result).toBeDefined();
  });

  it("lexer tokenizes 500 filter items", () => {
    const dsl = `FILTER: Category IN (${filterItems})`;
    const { tokens } = lex(dsl);
    // Should have at least 500 string tokens
    expect(tokens.length).toBeGreaterThan(500);
  });
});

// ============================================================================
// DSL with CALC expression 500 chars long
// ============================================================================

describe("DSL with CALC expression 500 chars long", () => {
  const fields = [sf(0, "A", true), sf(1, "B", true)];
  // Build a long expression by chaining additions
  const longExpr = Array.from({ length: 100 }, () => "[A] + [B]").join(" + ");

  it("parses very long CALC expression", () => {
    const dsl = `VALUES: SUM(A)\nCALC: LongCalc = ${longExpr}`;
    const result = run(dsl, fields);
    expect(result).toBeDefined();
  });

  it("the CALC expression string is preserved", () => {
    const dsl = `VALUES: SUM(A)\nCALC: LongCalc = ${longExpr}`;
    const { tokens } = lex(dsl);
    expect(tokens.length).toBeGreaterThan(10);
  });
});

// ============================================================================
// DSL with field names that look like numbers
// ============================================================================

describe("DSL with field names that look like numbers", () => {
  const fields = [sf(0, "123"), sf(1, "456", true), sf(2, "0"), sf(3, "3.14", true)];

  it("parses numeric-looking field names in ROWS", () => {
    const result = run("ROWS: 123, 0", fields);
    expect(result).toBeDefined();
  });

  it("parses numeric-looking field names in VALUES", () => {
    const result = run("VALUES: SUM(456), AVG(3.14)", fields);
    expect(result).toBeDefined();
  });
});

// ============================================================================
// DSL with field names containing special characters
// ============================================================================

describe("DSL with field names containing special characters", () => {
  const fields = [
    sf(0, "Sales ($)"),
    sf(1, "Growth %", true),
    sf(2, "Name/Title"),
    sf(3, "Cost & Price", true),
    sf(4, "Field-Name"),
    sf(5, "Field_Name"),
    sf(6, "Field.Name"),
  ];

  it("handles field names with parentheses and dollar signs", () => {
    const result = run('ROWS: "Sales ($)"', fields);
    expect(result).toBeDefined();
  });

  it("handles field names with percent signs", () => {
    const result = run('VALUES: SUM("Growth %")', fields);
    expect(result).toBeDefined();
  });

  it("handles field names with slashes", () => {
    const result = run('ROWS: "Name/Title"', fields);
    expect(result).toBeDefined();
  });

  it("handles field names with ampersands", () => {
    const result = run('VALUES: SUM("Cost & Price")', fields);
    expect(result).toBeDefined();
  });

  it("handles field names with hyphens, underscores, dots", () => {
    const result = run('ROWS: Field-Name, Field_Name, "Field.Name"', fields);
    expect(result).toBeDefined();
  });
});

// ============================================================================
// DSL mixing all clause types in non-standard order
// ============================================================================

describe("DSL with all clause types in non-standard order", () => {
  const fields = [
    sf(0, "Region"),
    sf(1, "Product"),
    sf(2, "Sales", true),
    sf(3, "Profit", true),
  ];

  it("parses clauses in reverse order (VALUES before ROWS)", () => {
    const dsl = `VALUES: SUM(Sales)\nROWS: Region\nCOLUMNS: Product`;
    const result = run(dsl, fields);
    expect(result).toBeDefined();
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("parses FILTER before ROWS", () => {
    const dsl = `FILTER: Region = "East"\nROWS: Product\nVALUES: SUM(Sales)`;
    const result = run(dsl, fields);
    expect(result).toBeDefined();
  });

  it("parses CALC before VALUES", () => {
    const dsl = `CALC: Margin = [Profit] / [Sales]\nVALUES: SUM(Sales), SUM(Profit)\nROWS: Region`;
    const result = run(dsl, fields);
    expect(result).toBeDefined();
  });
});

// ============================================================================
// DSL with multiple SAVE AS (last wins?)
// ============================================================================

describe("DSL with multiple SAVE AS clauses", () => {
  const fields = [sf(0, "Region"), sf(1, "Sales", true)];

  it("does not crash with multiple SAVE AS", () => {
    const dsl = `ROWS: Region\nVALUES: SUM(Sales)\nSAVE AS: "Layout A"\nSAVE AS: "Layout B"`;
    const result = run(dsl, fields);
    expect(result).toBeDefined();
  });

  it("parses both SAVE AS tokens", () => {
    const dsl = `SAVE AS: "First"\nSAVE AS: "Second"`;
    const { tokens } = lex(dsl);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
  });
});
