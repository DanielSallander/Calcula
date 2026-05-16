import { describe, it, expect } from "vitest";
import {
  processDsl,
  lex,
  compile,
  serialize,
  TokenType,
  AGGREGATION_NAMES,
} from "./index";
import { parse } from "./parser";
import { emptyAST } from "./ast";
import type { CompileContext } from "./compiler";
import type { SourceField } from "../_shared/components/types";

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(fields: Array<{ name: string; isNumeric: boolean }>): CompileContext {
  return {
    sourceFields: fields.map((f, i) => ({
      index: i,
      name: f.name,
      isNumeric: f.isNumeric,
    })) as SourceField[],
  };
}

const defaultCtx = makeCtx([
  { name: "Region", isNumeric: false },
  { name: "Product", isNumeric: false },
  { name: "Sales", isNumeric: true },
  { name: "Quantity", isNumeric: true },
]);

// ============================================================================
// processDsl always returns CompileResult (never throws)
// ============================================================================

describe("processDsl contract", () => {
  it("returns CompileResult for valid input", () => {
    const result = processDsl("ROWS: Region\nVALUES: sum(Sales)", defaultCtx);
    expect(Array.isArray(result.rows)).toBe(true);
    expect(Array.isArray(result.columns)).toBe(true);
    expect(Array.isArray(result.values)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.parseErrors)).toBe(true);
  });

  it("returns CompileResult for empty input (never throws)", () => {
    const result = processDsl("", defaultCtx);
    expect(Array.isArray(result.rows)).toBe(true);
    expect(Array.isArray(result.columns)).toBe(true);
    expect(Array.isArray(result.values)).toBe(true);
  });

  it("returns CompileResult for garbage input (never throws)", () => {
    const result = processDsl("!!!@@@###$$$", defaultCtx);
    expect(Array.isArray(result.rows)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("returns CompileResult for syntactically broken input", () => {
    const result = processDsl("ROWS: ROWS: ROWS:", defaultCtx);
    expect(Array.isArray(result.rows)).toBe(true);
  });
});

// ============================================================================
// lex always returns tokens ending with EOF
// ============================================================================

describe("lex contract", () => {
  it("empty string produces tokens ending with EOF", () => {
    const { tokens } = lex("");
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens[tokens.length - 1].type).toBe(TokenType.EOF);
  });

  it("valid input produces tokens ending with EOF", () => {
    const { tokens } = lex("ROWS: Region, Product");
    expect(tokens[tokens.length - 1].type).toBe(TokenType.EOF);
  });

  it("garbage input still produces tokens ending with EOF", () => {
    const { tokens } = lex("@@@!!!");
    expect(tokens[tokens.length - 1].type).toBe(TokenType.EOF);
  });

  it("every token has a location with line and column", () => {
    const { tokens } = lex("ROWS: Region\nVALUES: sum(Sales)");
    for (const token of tokens) {
      expect(typeof token.location.line).toBe("number");
      expect(typeof token.location.column).toBe("number");
    }
  });

  it("returns errors array (possibly empty, never undefined)", () => {
    const result = lex("ROWS: Region");
    expect(Array.isArray(result.errors)).toBe(true);
  });
});

// ============================================================================
// compile always returns valid structure with rows/columns/values arrays
// ============================================================================

describe("compile contract", () => {
  it("compiling empty AST returns empty arrays", () => {
    const result = compile(emptyAST(), defaultCtx);
    expect(Array.isArray(result.rows)).toBe(true);
    expect(Array.isArray(result.columns)).toBe(true);
    expect(Array.isArray(result.values)).toBe(true);
    expect(Array.isArray(result.filters)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.lookupColumns)).toBe(true);
    expect(Array.isArray(result.calculatedFields)).toBe(true);
    expect(Array.isArray(result.valueColumnOrder)).toBe(true);
    expect(result.layout).toBeDefined();
  });

  it("compiling parsed AST preserves field references", () => {
    const { tokens } = lex("ROWS: Region\nVALUES: sum(Sales)");
    const { ast } = parse(tokens);
    const result = compile(ast, defaultCtx);
    expect(result.rows.length).toBe(1);
    expect(result.values.length).toBe(1);
  });
});

// ============================================================================
// serialize always returns a string
// ============================================================================

describe("serialize contract", () => {
  it("returns a string for empty zones", () => {
    const result = serialize([], [], [], [], {
      layoutMode: "compact",
      repeatLabels: false,
      showGrandTotals: true,
      showRowTotals: true,
      showColumnTotals: true,
    });
    expect(typeof result).toBe("string");
  });

  it("returns a string for populated zones", () => {
    const row = {
      sourceIndex: 0,
      name: "Region",
      isNumeric: false,
    };
    const val = {
      sourceIndex: 2,
      name: "Sales",
      isNumeric: true,
      aggregation: "sum" as const,
    };
    const result = serialize([row], [], [val], [], {
      layoutMode: "compact",
      repeatLabels: false,
      showGrandTotals: true,
      showRowTotals: true,
      showColumnTotals: true,
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// AGGREGATION_NAMES map to valid function names
// ============================================================================

describe("AGGREGATION_NAMES contract", () => {
  it("is non-empty", () => {
    expect(AGGREGATION_NAMES.size).toBeGreaterThan(0);
  });

  it("contains standard aggregation functions", () => {
    expect(AGGREGATION_NAMES.has("sum")).toBe(true);
    expect(AGGREGATION_NAMES.has("count")).toBe(true);
    expect(AGGREGATION_NAMES.has("average")).toBe(true);
    expect(AGGREGATION_NAMES.has("min")).toBe(true);
    expect(AGGREGATION_NAMES.has("max")).toBe(true);
  });

  it("all names are lowercase strings", () => {
    for (const name of AGGREGATION_NAMES) {
      expect(typeof name).toBe("string");
      expect(name).toBe(name.toLowerCase());
    }
  });
});
