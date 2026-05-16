//! FILENAME: app/extensions/Pivot/dsl/dsl-negative-tests.test.ts
// PURPOSE: Negative testing for Pivot DSL - special chars, binary data, injection attacks.
// CONTEXT: Verifies the DSL pipeline gracefully handles adversarial and malformed input.

import { describe, it, expect } from "vitest";
import { processDsl } from "./index";
import { lex } from "./lexer";
import { parse } from "./parser";
import type { SourceField } from "../../_shared/components/types";
import type { CompileContext } from "./compiler";

// ============================================================================
// Helpers
// ============================================================================

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

const FIELDS: SourceField[] = [
  sf(0, "Region"),
  sf(1, "Product"),
  sf(2, "Sales", true),
  sf(3, "Profit", true),
];

function ctx(): CompileContext {
  return { sourceFields: FIELDS };
}

function run(dsl: string) {
  return processDsl(dsl, ctx());
}

// ============================================================================
// DSL with only special characters
// ============================================================================

describe("DSL - special characters only", () => {
  it("handles only punctuation", () => {
    expect(() => run("!@#$%^&*()")).not.toThrow();
  });

  it("handles only colons", () => {
    expect(() => run("::::")).not.toThrow();
  });

  it("handles only commas", () => {
    expect(() => run(",,,,,")).not.toThrow();
  });

  it("handles only newlines", () => {
    const result = run("\n\n\n\n");
    expect(result).toBeDefined();
  });

  it("handles tabs and spaces only", () => {
    const result = run("\t\t   \t   ");
    expect(result).toBeDefined();
  });

  it("handles mixed unicode symbols", () => {
    expect(() => run("\u00A9\u2603\u2764\u00AE")).not.toThrow();
  });
});

// ============================================================================
// DSL with binary data (null bytes, control chars)
// ============================================================================

describe("DSL - binary / control characters", () => {
  it("handles null bytes", () => {
    expect(() => run("ROWS:\0Region\0")).not.toThrow();
  });

  it("handles control characters (ASCII 1-31)", () => {
    const controlChars = Array.from({ length: 31 }, (_, i) =>
      String.fromCharCode(i + 1)
    ).join("");
    expect(() => run(`ROWS: ${controlChars}`)).not.toThrow();
  });

  it("handles DEL character (127)", () => {
    expect(() => run("VALUES: Sum(\x7FSales)")).not.toThrow();
  });

  it("handles mixed null bytes and valid DSL", () => {
    const result = run("ROWS: Region\0\nVALUES: Sum(Sales)");
    expect(result).toBeDefined();
  });
});

// ============================================================================
// DSL with extremely long single token
// ============================================================================

describe("DSL - extremely long tokens", () => {
  it("handles 10K character field name", () => {
    const longName = "A".repeat(10000);
    expect(() => run(`ROWS: ${longName}`)).not.toThrow();
  });

  it("handles 10K character value expression", () => {
    const longExpr = "Sum(" + "Sales+".repeat(1500) + "Sales)";
    expect(() => run(`VALUES: ${longExpr}`)).not.toThrow();
  });

  it("handles many short lines", () => {
    const manyLines = Array.from({ length: 1000 }, (_, i) => `ROWS: Region`).join("\n");
    expect(() => run(manyLines)).not.toThrow();
  });
});

// ============================================================================
// DSL with mismatched quotes/brackets
// ============================================================================

describe("DSL - mismatched quotes and brackets", () => {
  it("handles unclosed single quote at start", () => {
    const result = run("ROWS: 'Region");
    expect(result).toBeDefined();
  });

  it("handles unclosed double quote at start", () => {
    const result = run('VALUES: "Sum(Sales)');
    expect(result).toBeDefined();
  });

  it("handles unclosed parenthesis in value", () => {
    const result = run("VALUES: Sum(Sales");
    expect(result).toBeDefined();
  });

  it("handles extra closing parenthesis", () => {
    const result = run("VALUES: Sum(Sales))");
    expect(result).toBeDefined();
  });

  it("handles unclosed bracket", () => {
    expect(() => run("CALC: Margin = [Sales")).not.toThrow();
  });

  it("handles mismatched bracket types", () => {
    expect(() => run("CALC: X = (Sales]")).not.toThrow();
  });

  it("handles quotes at every position", () => {
    // Quote before keyword, between keyword and colon, after colon
    expect(() => run("'ROWS: Region")).not.toThrow();
    expect(() => run("ROWS': Region")).not.toThrow();
    expect(() => run("ROWS:' Region")).not.toThrow();
  });
});

// ============================================================================
// DSL with SQL injection attempts
// ============================================================================

describe("DSL - SQL injection attempts", () => {
  it("handles DROP TABLE", () => {
    const result = run("ROWS: Region; DROP TABLE users;--");
    expect(result).toBeDefined();
    // Should treat it as text, not execute anything
  });

  it("handles UNION SELECT", () => {
    const result = run("VALUES: Sum(Sales) UNION SELECT * FROM passwords");
    expect(result).toBeDefined();
  });

  it("handles OR 1=1", () => {
    const result = run("FILTER: Region = '' OR '1'='1'");
    expect(result).toBeDefined();
  });

  it("handles comment injection", () => {
    const result = run("ROWS: Region /* malicious */ Product");
    expect(result).toBeDefined();
  });

  it("handles escaped quotes injection", () => {
    const result = run("ROWS: Region\\'; DROP TABLE;--");
    expect(result).toBeDefined();
  });

  it("handles hex-encoded injection", () => {
    const result = run("ROWS: 0x52656769'6F6E");
    expect(result).toBeDefined();
  });
});
