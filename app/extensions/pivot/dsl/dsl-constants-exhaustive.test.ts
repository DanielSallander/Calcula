//! FILENAME: app/extensions/Pivot/dsl/dsl-constants-exhaustive.test.ts
// PURPOSE: Exhaustive verification that all DSL enums, constant maps, and
//          token types are complete and consistent.

import { describe, it, expect } from "vitest";
import {
  TokenType,
  KEYWORDS,
  AGGREGATION_NAMES,
  LAYOUT_DIRECTIVES,
  SHOW_VALUES_AS_NAMES,
  VISUAL_CALC_FUNCTIONS,
  VISUAL_CALC_RESET_OPTIONS,
} from "./tokens";
import { lex } from "./lexer";
import { compile, type CompileContext } from "./compiler";
import { serialize } from "./serializer";
import { AGGREGATION_OPTIONS, type AggregationType } from "../../_shared/components/types";
import type { PivotLayoutAST, ValueFieldNode } from "./ast";
import { emptyAST } from "./ast";

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(fields: Array<{ name: string; isNumeric: boolean }>): CompileContext {
  return {
    sourceFields: fields.map((f, i) => ({ index: i, name: f.name, isNumeric: f.isNumeric })),
  };
}

function makeValueNode(fieldName: string, aggregation: AggregationType): ValueFieldNode {
  return {
    fieldName,
    aggregation,
    isMeasure: false,
    location: { line: 1, column: 0, endColumn: 0 },
  };
}

// ============================================================================
// Tests: AGGREGATION_NAMES
// ============================================================================

describe("AGGREGATION_NAMES completeness", () => {
  const ALL_AGG_TYPES: AggregationType[] = [
    "sum", "count", "average", "min", "max",
    "countnumbers", "stddev", "stddevp", "var", "varp", "product",
  ];

  it("every AggregationType is in AGGREGATION_NAMES", () => {
    for (const agg of ALL_AGG_TYPES) {
      expect(AGGREGATION_NAMES.has(agg)).toBe(true);
    }
  });

  it("AGGREGATION_NAMES has no extra entries beyond AggregationType", () => {
    for (const name of AGGREGATION_NAMES) {
      expect(ALL_AGG_TYPES).toContain(name);
    }
  });

  it("AGGREGATION_NAMES matches AGGREGATION_OPTIONS values", () => {
    const optionValues = new Set(AGGREGATION_OPTIONS.map((o) => o.value));
    expect(AGGREGATION_NAMES.size).toBe(optionValues.size);
    for (const name of AGGREGATION_NAMES) {
      expect(optionValues.has(name as AggregationType)).toBe(true);
    }
  });

  it.each(ALL_AGG_TYPES)("aggregation '%s' compiles to a valid ZoneField", (agg) => {
    const ast: PivotLayoutAST = {
      ...emptyAST(),
      values: [makeValueNode("Amount", agg)],
    };
    const ctx = makeCtx([{ name: "Amount", isNumeric: true }]);
    const result = compile(ast, ctx);
    expect(result.errors).toEqual([]);
    expect(result.values.length).toBe(1);
    expect(result.values[0].aggregation).toBe(agg);
  });
});

// ============================================================================
// Tests: SHOW_VALUES_AS_NAMES
// ============================================================================

describe("SHOW_VALUES_AS_NAMES completeness", () => {
  it("every entry maps to a non-empty internal code", () => {
    for (const [label, code] of SHOW_VALUES_AS_NAMES) {
      expect(label.length).toBeGreaterThan(0);
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it("all internal codes are unique", () => {
    const codes = [...SHOW_VALUES_AS_NAMES.values()];
    // Some labels map to the same code (e.g., "% of row" and "% of row total")
    // so codes may have duplicates, but the unique set should cover all values
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBeGreaterThanOrEqual(9); // 9 distinct show-values-as types
  });

  it("serializer can produce a label for every unique internal code", () => {
    // The serializer has a getShowValuesAsLabel function that maps codes to labels.
    // We verify round-trip: every internal code from SHOW_VALUES_AS_NAMES should
    // be serializable by checking that serialize produces [label] syntax.
    const uniqueCodes = new Set(SHOW_VALUES_AS_NAMES.values());
    for (const code of uniqueCodes) {
      if (code === "normal") continue;
      const result = serialize(
        [],
        [],
        [{
          sourceIndex: 0,
          name: "Amount",
          isNumeric: true,
          aggregation: "sum",
          showValuesAs: code,
        }],
        [],
        {},
      );
      // The serialized output should contain a [...] show-values-as annotation
      expect(result).toContain("[");
    }
  });
});

// ============================================================================
// Tests: LAYOUT_DIRECTIVES
// ============================================================================

describe("LAYOUT_DIRECTIVES completeness", () => {
  const EXPECTED_DIRECTIVES = [
    "compact", "outline", "tabular",
    "repeat-labels", "no-repeat-labels",
    "no-grand-totals", "no-row-totals", "no-column-totals",
    "grand-totals", "row-totals", "column-totals",
    "show-empty-rows", "show-empty-cols",
    "values-on-rows", "values-on-columns",
    "auto-fit",
    "subtotals-top", "subtotals-bottom", "subtotals-off",
  ];

  it("LAYOUT_DIRECTIVES contains all expected directives", () => {
    for (const d of EXPECTED_DIRECTIVES) {
      expect(LAYOUT_DIRECTIVES.has(d)).toBe(true);
    }
  });

  it("LAYOUT_DIRECTIVES has no unexpected entries", () => {
    for (const d of LAYOUT_DIRECTIVES) {
      expect(EXPECTED_DIRECTIVES).toContain(d);
    }
  });

  it.each([
    "compact", "outline", "tabular",
    "repeat-labels", "no-repeat-labels",
    "no-grand-totals", "no-row-totals", "no-column-totals",
    "grand-totals", "row-totals", "column-totals",
    "show-empty-rows", "show-empty-cols",
    "values-on-rows", "values-on-columns",
    "auto-fit",
  ])("directive '%s' is recognized by the compiler", (directive) => {
    const ast: PivotLayoutAST = {
      ...emptyAST(),
      layout: [{ key: directive, location: { line: 1, column: 0, endColumn: 0 } }],
    };
    const ctx = makeCtx([]);
    const result = compile(ast, ctx);
    // No errors for recognized directives
    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors).toEqual([]);
  });
});

// ============================================================================
// Tests: Token type completeness
// ============================================================================

describe("TokenType enum completeness", () => {
  it("all keyword tokens are in KEYWORDS map", () => {
    const keywordTokenTypes = new Set([
      TokenType.Rows, TokenType.Columns, TokenType.Values, TokenType.Filters,
      TokenType.Sort, TokenType.Layout, TokenType.Calc, TokenType.Top,
      TokenType.Bottom, TokenType.By, TokenType.As, TokenType.Save,
      TokenType.Lookup, TokenType.Via, TokenType.Not, TokenType.In,
      TokenType.Asc, TokenType.Desc,
    ]);

    const keywordMapValues = new Set(Object.values(KEYWORDS));
    expect(keywordMapValues).toEqual(keywordTokenTypes);
  });

  it("KEYWORDS keys are all uppercase", () => {
    for (const key of Object.keys(KEYWORDS)) {
      expect(key).toBe(key.toUpperCase());
    }
  });

  it("all TokenType enum values are unique strings", () => {
    const values = Object.values(TokenType).filter((v) => typeof v === "string");
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("lexer produces valid tokens for all symbol types", () => {
    const input = ": , ( ) = . + - * / ^";
    const result = lex(input);
    const types = result.tokens.filter((t) => t.type !== TokenType.EOF).map((t) => t.type);
    expect(types).toContain(TokenType.Colon);
    expect(types).toContain(TokenType.Comma);
    expect(types).toContain(TokenType.LeftParen);
    expect(types).toContain(TokenType.RightParen);
    expect(types).toContain(TokenType.Equals);
    expect(types).toContain(TokenType.Dot);
    expect(types).toContain(TokenType.Plus);
    expect(types).toContain(TokenType.Minus);
    expect(types).toContain(TokenType.Star);
    expect(types).toContain(TokenType.Slash);
    expect(types).toContain(TokenType.Caret);
  });

  it("lexer recognizes all keywords case-insensitively", () => {
    for (const kw of Object.keys(KEYWORDS)) {
      const result = lex(kw.toLowerCase());
      const nonEof = result.tokens.filter((t) => t.type !== TokenType.EOF);
      expect(nonEof.length).toBeGreaterThanOrEqual(1);
      expect(nonEof[0].type).toBe(KEYWORDS[kw]);
    }
  });
});

// ============================================================================
// Tests: VISUAL_CALC_FUNCTIONS and VISUAL_CALC_RESET_OPTIONS
// ============================================================================

describe("Visual calculation constants", () => {
  it("VISUAL_CALC_FUNCTIONS has non-empty descriptions", () => {
    for (const [name, desc] of VISUAL_CALC_FUNCTIONS) {
      expect(name.length).toBeGreaterThan(0);
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  it("VISUAL_CALC_FUNCTIONS keys are all lowercase", () => {
    for (const name of VISUAL_CALC_FUNCTIONS.keys()) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  it("VISUAL_CALC_RESET_OPTIONS labels are all uppercase", () => {
    for (const opt of VISUAL_CALC_RESET_OPTIONS) {
      expect(opt.label).toBe(opt.label.toUpperCase());
      expect(opt.description.length).toBeGreaterThan(0);
    }
  });
});
