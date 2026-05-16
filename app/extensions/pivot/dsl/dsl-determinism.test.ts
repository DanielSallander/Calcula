//! FILENAME: app/extensions/Pivot/dsl/dsl-determinism.test.ts
// PURPOSE: Verify output determinism for the Pivot DSL pipeline.
//          Each stage is called 50 times with identical input; all outputs
//          must be identical.

import { describe, it, expect } from "vitest";
import { lex } from "./lexer";
import { parse } from "./parser";
import { compile, type CompileContext } from "./compiler";
import { serialize } from "./serializer";
import { processDsl } from "./index";
import type { SourceField, ZoneField } from "../../_shared/components/types";
import type { LayoutConfig } from "../components/types";

// ============================================================================
// Helpers
// ============================================================================

const ITERATIONS = 50;

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

const COMPLEX_DSL = `ROWS: Region, Product
COLUMNS: Quarter
VALUES: SUM(Sales), AVERAGE(Profit)
FILTER: Category = "Electronics"
SORT: Sales DESC
LAYOUT: tabular
GRAND TOTALS: rows, columns
CALC: Margin = [Sales] - [Profit]
TOP 5 BY SUM(Sales)`;

const SIMPLE_DSL = `ROWS: Region
VALUES: SUM(Sales)`;

const MULTI_VALUE_DSL = `ROWS: Region, Category
COLUMNS: Quarter
VALUES: SUM(Sales), COUNT(Quantity), AVERAGE(Profit)
SORT: Region ASC
LAYOUT: compact`;

/** Run fn N times and assert all outputs are identical via JSON.stringify. */
function assertDeterministic<T>(fn: () => T, n = ITERATIONS): T {
  const first = fn();
  const firstJson = JSON.stringify(first);
  for (let i = 1; i < n; i++) {
    expect(JSON.stringify(fn())).toBe(firstJson);
  }
  return first;
}

// ===========================================================================
// Lexer determinism
// ===========================================================================

describe("determinism: lex", () => {
  it("complex multi-clause DSL produces identical tokens 50 times", () => {
    assertDeterministic(() => lex(COMPLEX_DSL));
  });

  it("simple DSL produces identical tokens 50 times", () => {
    assertDeterministic(() => lex(SIMPLE_DSL));
  });

  it("multi-value DSL produces identical tokens 50 times", () => {
    assertDeterministic(() => lex(MULTI_VALUE_DSL));
  });
});

// ===========================================================================
// Parser determinism
// ===========================================================================

describe("determinism: parse", () => {
  it("complex DSL produces identical AST 50 times", () => {
    const { tokens } = lex(COMPLEX_DSL);
    assertDeterministic(() => parse(tokens));
  });

  it("simple DSL produces identical AST 50 times", () => {
    const { tokens } = lex(SIMPLE_DSL);
    assertDeterministic(() => parse(tokens));
  });

  it("multi-value DSL produces identical AST 50 times", () => {
    const { tokens } = lex(MULTI_VALUE_DSL);
    assertDeterministic(() => parse(tokens));
  });
});

// ===========================================================================
// Compiler determinism
// ===========================================================================

describe("determinism: compile", () => {
  it("complex DSL produces identical compile result 50 times", () => {
    const { tokens } = lex(COMPLEX_DSL);
    const { ast } = parse(tokens);
    assertDeterministic(() => compile(ast, ctx()));
  });

  it("simple DSL produces identical compile result 50 times", () => {
    const { tokens } = lex(SIMPLE_DSL);
    const { ast } = parse(tokens);
    assertDeterministic(() => compile(ast, ctx()));
  });

  it("multi-value DSL produces identical compile result 50 times", () => {
    const { tokens } = lex(MULTI_VALUE_DSL);
    const { ast } = parse(tokens);
    assertDeterministic(() => compile(ast, ctx()));
  });
});

// ===========================================================================
// Serializer determinism
// ===========================================================================

describe("determinism: serialize", () => {
  it("round-trip serialization is deterministic 50 times", () => {
    const rows: ZoneField[] = [
      { sourceIndex: 0, name: "Region", isNumeric: false },
      { sourceIndex: 1, name: "Product", isNumeric: false },
    ];
    const columns: ZoneField[] = [
      { sourceIndex: 2, name: "Quarter", isNumeric: false },
    ];
    const values: ZoneField[] = [
      { sourceIndex: 3, name: "Sales", isNumeric: true, aggregation: "SUM" },
      { sourceIndex: 4, name: "Profit", isNumeric: true, aggregation: "AVERAGE" },
    ];
    const filters: ZoneField[] = [
      { sourceIndex: 6, name: "Category", isNumeric: false },
    ];
    const layout: LayoutConfig = {
      showRowGrandTotals: true,
      showColumnGrandTotals: true,
      reportLayout: "tabular",
    };
    assertDeterministic(() => serialize(rows, columns, values, filters, layout));
  });

  it("empty zones serialize deterministically 50 times", () => {
    const layout: LayoutConfig = {};
    assertDeterministic(() => serialize([], [], [], [], layout));
  });

  it("values with custom names serialize deterministically", () => {
    const values: ZoneField[] = [
      { sourceIndex: 3, name: "Sales", isNumeric: true, aggregation: "SUM", customName: "Total Sales" },
      { sourceIndex: 5, name: "Quantity", isNumeric: true, aggregation: "COUNT", customName: "Item Count" },
    ];
    const layout: LayoutConfig = { reportLayout: "compact" };
    assertDeterministic(() => serialize([], [], values, [], layout));
  });
});

// ===========================================================================
// processDsl end-to-end determinism
// ===========================================================================

describe("determinism: processDsl end-to-end", () => {
  it("complex DSL produces identical end-to-end result 50 times", () => {
    assertDeterministic(() => processDsl(COMPLEX_DSL, ctx()));
  });

  it("simple DSL produces identical end-to-end result 50 times", () => {
    assertDeterministic(() => processDsl(SIMPLE_DSL, ctx()));
  });

  it("multi-value DSL produces identical end-to-end result 50 times", () => {
    assertDeterministic(() => processDsl(MULTI_VALUE_DSL, ctx()));
  });

  it("DSL with errors produces identical error output 50 times", () => {
    const badDsl = `ROWS: NonExistentField
VALUES: SUM(AlsoMissing)`;
    assertDeterministic(() => processDsl(badDsl, ctx()));
  });

  it("empty DSL produces identical result 50 times", () => {
    assertDeterministic(() => processDsl("", ctx()));
  });
});
