//! FILENAME: app/extensions/Pivot/dsl/dsl-type-coercion.test.ts
// PURPOSE: Type coercion edge cases in Pivot DSL parsing
// CONTEXT: Field names that look like numbers, booleans, or null

import { describe, it, expect } from "vitest";
import { lex } from "./lexer";
import { parse } from "./parser";
import { processDsl, type CompileContext } from "./index";

function parseText(text: string) {
  const { tokens } = lex(text);
  return parse(tokens);
}

const stubCtx: CompileContext = {
  availableFields: [
    "0", "1", "123", "true", "false", "null", "undefined", "NaN",
    "Infinity", "Price", "Category", "Region",
  ],
};

// ---------------------------------------------------------------------------
// Numeric field names that could be confused with indices
// ---------------------------------------------------------------------------

describe("DSL with numeric field names", () => {
  it("field named '0' is parsed as identifier, not index", () => {
    const { ast, errors } = parseText('ROWS: "0"');
    expect(ast.rows).toHaveLength(1);
    expect(ast.rows[0].name).toBe("0");
  });

  it("field named '123' in VALUES clause", () => {
    const { ast } = parseText('VALUES: Sum("123")');
    expect(ast.values).toHaveLength(1);
    expect(ast.values[0].fieldName).toBe("123");
  });

  it("field named '1' as sort field", () => {
    const { ast } = parseText('SORT: "1" DESC');
    expect(ast.sort).toHaveLength(1);
    expect(ast.sort[0].fieldName).toBe("1");
    expect(ast.sort[0].direction).toBe("desc");
  });

  it("multiple numeric field names in ROWS", () => {
    const { ast } = parseText('ROWS: "0", "1", "123"');
    expect(ast.rows).toHaveLength(3);
    expect(ast.rows.map((r) => r.name)).toEqual(["0", "1", "123"]);
  });
});

// ---------------------------------------------------------------------------
// Boolean-like field names
// ---------------------------------------------------------------------------

describe("DSL with boolean-like field names", () => {
  it("field named 'true' (quoted) is parsed correctly", () => {
    const { ast } = parseText('ROWS: "true"');
    expect(ast.rows).toHaveLength(1);
    expect(ast.rows[0].name).toBe("true");
  });

  it("field named 'false' (quoted) is parsed correctly", () => {
    const { ast } = parseText('ROWS: "false"');
    expect(ast.rows).toHaveLength(1);
    expect(ast.rows[0].name).toBe("false");
  });

  it("field named 'null' (quoted) is parsed correctly", () => {
    const { ast } = parseText('ROWS: "null"');
    expect(ast.rows).toHaveLength(1);
    expect(ast.rows[0].name).toBe("null");
  });

  it("field named 'undefined' (quoted) is parsed correctly", () => {
    const { ast } = parseText('COLUMNS: "undefined"');
    expect(ast.columns).toHaveLength(1);
    expect(ast.columns[0].name).toBe("undefined");
  });

  it("field named 'NaN' (quoted) in VALUES", () => {
    const { ast } = parseText('VALUES: Sum("NaN")');
    expect(ast.values).toHaveLength(1);
    expect(ast.values[0].fieldName).toBe("NaN");
  });

  it("field named 'Infinity' (quoted) in ROWS", () => {
    const { ast } = parseText('ROWS: "Infinity"');
    expect(ast.rows).toHaveLength(1);
    expect(ast.rows[0].name).toBe("Infinity");
  });
});

// ---------------------------------------------------------------------------
// Numeric string values in filters
// ---------------------------------------------------------------------------

describe("DSL with numeric string values in filters", () => {
  it("filter with numeric string value '42'", () => {
    const { ast } = parseText('FILTERS: Category = ("42")');
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].values).toEqual(["42"]);
  });

  it("filter with zero string '0'", () => {
    const { ast } = parseText('FILTERS: Region = ("0")');
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].values).toEqual(["0"]);
  });

  it("filter with 'true' and 'false' as string values", () => {
    const { ast } = parseText('FILTERS: Region = ("true", "false")');
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].values).toEqual(["true", "false"]);
  });

  it("filter with 'null' as string value", () => {
    const { ast } = parseText('FILTERS: Category = ("null")');
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].values).toEqual(["null"]);
  });

  it("filter NOT IN with numeric string values", () => {
    const { ast } = parseText('FILTERS: Price NOT IN ("0", "100")');
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].exclude).toBe(true);
    expect(ast.filters[0].values).toEqual(["0", "100"]);
  });

  it("filter with empty string value", () => {
    const { ast } = parseText('FILTERS: Category = ("")');
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].values).toEqual([""]);
  });
});
