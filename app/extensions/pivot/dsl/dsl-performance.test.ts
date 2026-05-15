//! FILENAME: app/extensions/Pivot/dsl/dsl-performance.test.ts
// PURPOSE: Performance regression tests for the Pivot DSL pipeline.
// CONTEXT: Ensures lex/parse/compile and serialization remain fast at scale.

import { describe, it, expect } from "vitest";
import { lex } from "./lexer";
import { parse } from "./parser";
import { processDsl } from "./index";
import { serialize } from "./serializer";
import type { CompileContext } from "./compiler";
import type { SourceField, ZoneField } from "../../_shared/components/types";
import type { LayoutConfig } from "../components/types";

// ============================================================================
// Helpers
// ============================================================================

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

function ctx(fields: SourceField[]): CompileContext {
  return { sourceFields: fields };
}

/** Build a realistic DSL string with many fields. */
function buildDslString(fieldCount: number, fields: SourceField[]): string {
  const rowFields = fields.slice(0, Math.min(5, fieldCount));
  const colFields = fields.slice(5, Math.min(8, fieldCount));
  const numericFields = fields.filter((f) => f.isNumeric).slice(0, 3);
  const filterFields = fields.slice(8, Math.min(10, fieldCount));

  const lines: string[] = [];
  if (rowFields.length > 0) {
    lines.push(`ROWS: ${rowFields.map((f) => f.name).join(", ")}`);
  }
  if (colFields.length > 0) {
    lines.push(`COLUMNS: ${colFields.map((f) => f.name).join(", ")}`);
  }
  if (numericFields.length > 0) {
    lines.push(`VALUES: ${numericFields.map((f) => `Sum(${f.name})`).join(", ")}`);
  }
  if (filterFields.length > 0) {
    lines.push(`FILTERS: ${filterFields.map((f) => f.name).join(", ")}`);
  }
  return lines.join("\n");
}

const FIELD_COUNT = 20;
const fields: SourceField[] = Array.from({ length: FIELD_COUNT }, (_, i) =>
  sf(i, `Field${i}`, i >= FIELD_COUNT / 2),
);

// ============================================================================
// Lex + Parse + Compile 100 DSL strings
// ============================================================================

describe("performance: DSL lex + parse + compile", () => {
  it("processes 100 DSL strings under 200ms", () => {
    const dslStrings: string[] = [];
    for (let i = 0; i < 100; i++) {
      dslStrings.push(buildDslString(FIELD_COUNT, fields));
    }

    const start = performance.now();
    for (const dsl of dslStrings) {
      const result = processDsl(dsl, ctx(fields));
      // Sanity: no hard errors
      expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(600); // 3x headroom
  });
});

// ============================================================================
// Serialize + re-parse round trip 100 times
// ============================================================================

describe("performance: DSL serialize + re-parse round trip", () => {
  it("completes 100 round trips under 300ms", () => {
    // First compile a DSL to get zone fields
    const dsl = buildDslString(FIELD_COUNT, fields);
    const compiled = processDsl(dsl, ctx(fields));

    // Build ZoneField arrays from compiled result
    const rows: ZoneField[] = compiled.rows.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
      isNumeric: false,
    }));
    const columns: ZoneField[] = compiled.columns.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
      isNumeric: false,
    }));
    const values: ZoneField[] = compiled.values.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
      isNumeric: true,
      aggregation: f.aggregation,
    }));
    const filters: ZoneField[] = compiled.filters.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
      isNumeric: false,
    }));

    const layout: LayoutConfig = {};

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const text = serialize(rows, columns, values, filters, layout);
      // Re-parse the serialized text
      const tokens = lex(text);
      parse(tokens);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(900); // 3x headroom
  });
});
