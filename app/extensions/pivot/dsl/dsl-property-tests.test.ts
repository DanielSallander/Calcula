//! FILENAME: app/extensions/Pivot/dsl/dsl-property-tests.test.ts
// PURPOSE: Property-based/fuzz-style tests for the Pivot Layout DSL.
// CONTEXT: Verifies lexer, parser, and compiler invariants across random inputs.

import { describe, it, expect } from "vitest";
import { lex } from "./lexer";
import { parse } from "./parser";
import { compile, type CompileContext } from "./compiler";
import { serialize } from "./serializer";
import { processDsl } from "./index";
import { TokenType } from "./tokens";
import type { SourceField } from "../../_shared/components/types";

// ============================================================================
// Seeded PRNG for reproducibility
// ============================================================================

function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Sample source fields for compilation context. */
const sampleFields: SourceField[] = [
  { index: 0, name: "Region", isNumeric: false },
  { index: 1, name: "Product", isNumeric: false },
  { index: 2, name: "Sales", isNumeric: true },
  { index: 3, name: "Quantity", isNumeric: true },
  { index: 4, name: "Date", isNumeric: false },
  { index: 5, name: "Cost", isNumeric: true },
];

const sampleCtx: CompileContext = {
  sourceFields: sampleFields,
};

/** Generate a random DSL-like string. */
function randomDslString(rng: () => number, maxLen = 80): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz0123456789:,()[]=\"#\n.-+*/_";
  const len = Math.floor(rng() * maxLen) + 1;
  let result = "";
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(rng() * chars.length)];
  }
  return result;
}

// ============================================================================
// Lexer: never crashes on random input
// ============================================================================

describe("DSL lexer fuzz", () => {
  it("never crashes on 500 random strings", () => {
    const rng = createRng(42);

    for (let i = 0; i < 500; i++) {
      const input = randomDslString(rng, 120);
      const result = lex(input);

      // Always returns valid structure
      expect(Array.isArray(result.tokens)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
      // Always ends with EOF
      expect(result.tokens.length).toBeGreaterThan(0);
      expect(result.tokens[result.tokens.length - 1].type).toBe(TokenType.EOF);
    }
  });

  it("token count is always >= 1 (at least EOF)", () => {
    const rng = createRng(99);
    for (let i = 0; i < 200; i++) {
      const input = randomDslString(rng, 50);
      const result = lex(input);
      expect(result.tokens.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("handles edge cases: empty string, single chars, only whitespace", () => {
    expect(lex("").tokens.length).toBeGreaterThanOrEqual(1);
    expect(lex(" ").tokens.length).toBeGreaterThanOrEqual(1);
    expect(lex("\n").tokens.length).toBeGreaterThanOrEqual(1);
    expect(lex("#").tokens.length).toBeGreaterThanOrEqual(1);
    expect(lex('"').tokens.length).toBeGreaterThanOrEqual(1);
    expect(lex("[").tokens.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Compiler: always returns valid structure even with errors
// ============================================================================

describe("DSL compiler fuzz", () => {
  it("always returns a valid CompileResult for random DSL input", () => {
    const rng = createRng(77);

    for (let i = 0; i < 200; i++) {
      const input = randomDslString(rng, 100);
      const { tokens } = lex(input);
      const { ast } = parse(tokens);
      const result = compile(ast, sampleCtx);

      // Structure is always valid
      expect(Array.isArray(result.rows)).toBe(true);
      expect(Array.isArray(result.columns)).toBe(true);
      expect(Array.isArray(result.values)).toBe(true);
      expect(Array.isArray(result.filters)).toBe(true);
      expect(typeof result.layout).toBe("object");
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.lookupColumns)).toBe(true);
      expect(Array.isArray(result.calculatedFields)).toBe(true);
      expect(Array.isArray(result.valueColumnOrder)).toBe(true);
    }
  });

  it("processDsl never throws for random input", () => {
    const rng = createRng(55);

    for (let i = 0; i < 300; i++) {
      const input = randomDslString(rng, 150);
      // Should never throw
      const result = processDsl(input, sampleCtx);
      expect(result).toBeDefined();
      expect(Array.isArray(result.errors)).toBe(true);
    }
  });
});

// ============================================================================
// Round-trip: serialize(compile(dsl)) produces equivalent output
// ============================================================================

describe("DSL round-trip", () => {
  it("well-formed DSL round-trips through compile -> serialize -> compile", () => {
    const testCases = [
      "ROWS: Region, Product\nVALUES: Sum(Sales)",
      "ROWS: Region\nCOLUMNS: Product\nVALUES: Sum(Sales), Average(Quantity)",
      "ROWS: Region\nVALUES: Sum(Sales)\nLAYOUT: compact, no-grand-totals",
      "ROWS: Region\nVALUES: Sum(Sales)\nFILTERS: Product",
      "ROWS: Date\nVALUES: Sum(Cost)\nLAYOUT: tabular, repeat-labels",
    ];

    for (const dsl of testCases) {
      // First pass
      const result1 = processDsl(dsl, sampleCtx);

      // Serialize back
      const serialized = serialize(
        result1.rows,
        result1.columns,
        result1.values,
        result1.filters,
        result1.layout,
        { calculatedFields: result1.calculatedFields },
      );

      // Second pass
      const result2 = processDsl(serialized, sampleCtx);

      // Zone fields should match
      expect(result2.rows.length).toBe(result1.rows.length);
      expect(result2.columns.length).toBe(result1.columns.length);
      expect(result2.values.length).toBe(result1.values.length);

      // Field names should match
      for (let j = 0; j < result1.rows.length; j++) {
        expect(result2.rows[j].name).toBe(result1.rows[j].name);
      }
      for (let j = 0; j < result1.columns.length; j++) {
        expect(result2.columns[j].name).toBe(result1.columns[j].name);
      }
      for (let j = 0; j < result1.values.length; j++) {
        expect(result2.values[j].name).toBe(result1.values[j].name);
        expect(result2.values[j].aggregation).toBe(result1.values[j].aggregation);
      }
    }
  });

  it("round-trip preserves layout directives", () => {
    const layouts = [
      "compact",
      "outline",
      "tabular",
      "compact, repeat-labels",
      "tabular, no-grand-totals",
      "compact, values-on-rows, auto-fit",
    ];

    for (const layoutStr of layouts) {
      const dsl = `ROWS: Region\nVALUES: Sum(Sales)\nLAYOUT: ${layoutStr}`;
      const result1 = processDsl(dsl, sampleCtx);
      const serialized = serialize(
        result1.rows, result1.columns, result1.values, result1.filters,
        result1.layout,
      );
      const result2 = processDsl(serialized, sampleCtx);

      expect(result2.layout.reportLayout).toBe(result1.layout.reportLayout);
      expect(result2.layout.repeatRowLabels).toBe(result1.layout.repeatRowLabels);
      expect(result2.layout.showRowGrandTotals).toBe(result1.layout.showRowGrandTotals);
      expect(result2.layout.showColumnGrandTotals).toBe(result1.layout.showColumnGrandTotals);
      expect(result2.layout.valuesPosition).toBe(result1.layout.valuesPosition);
      expect(result2.layout.autoFitColumnWidths).toBe(result1.layout.autoFitColumnWidths);
    }
  });
});
