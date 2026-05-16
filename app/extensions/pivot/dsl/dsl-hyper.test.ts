/**
 * FILENAME: app/extensions/Pivot/dsl/dsl-hyper.test.ts
 * PURPOSE: Hyper-parameterized test suite (3000+ tests) using programmatically
 *          generated test arrays for lexer tokens, processDsl, serialization,
 *          round-trips, and compile errors.
 */

import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { TokenType } from './tokens';
import { parse } from './parser';
import { compile, type CompileContext } from './compiler';
import { serialize } from './serializer';
import { processDsl } from './index';
import type { SourceField } from '../../_shared/components/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(fields: string[]): CompileContext {
  return {
    sourceFields: fields.map((name, i) => ({
      name,
      index: i,
      dataType: 'string' as const,
    })) as SourceField[],
  };
}

// ---------------------------------------------------------------------------
// 1. Lex identifier tokens (1000 cases)
// ---------------------------------------------------------------------------

const identCases = Array.from({ length: 1000 }, (_, i) => [`Field_${i}`]);

describe('Hyper: Lex identifier tokens (1000 cases)', () => {
  it.each(identCases)('lexes "%s" as IDENTIFIER', (name) => {
    const { tokens, errors } = lex(name);
    expect(errors).toHaveLength(0);
    const identTokens = tokens.filter(t => t.type === TokenType.Identifier);
    expect(identTokens.length).toBeGreaterThanOrEqual(1);
    expect(identTokens[0].type).toBe(TokenType.Identifier);
    expect(identTokens[0].value).toBe(name);
  });
});

// ---------------------------------------------------------------------------
// 2. processDsl with ROWS (500 cases)
// ---------------------------------------------------------------------------

const rowsCases = Array.from({ length: 500 }, (_, i) => [`ROWS: Field_${i}`, `Field_${i}`]);

describe('Hyper: processDsl with ROWS (500 cases)', () => {
  it.each(rowsCases)('processDsl("%s") produces row named "%s"', (dsl, expectedName) => {
    const ctx = makeCtx([expectedName]);
    const result = processDsl(dsl, ctx);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe(expectedName);
  });
});

// ---------------------------------------------------------------------------
// 3. processDsl with VALUES (500 cases)
// ---------------------------------------------------------------------------

const valuesCases = Array.from({ length: 500 }, (_, i) => [`VALUES: SUM(Field_${i})`, `Field_${i}`]);

describe('Hyper: processDsl with VALUES (500 cases)', () => {
  it.each(valuesCases)('processDsl("%s") produces value field for "%s"', (dsl, fieldName) => {
    const ctx = makeCtx([fieldName]);
    const result = processDsl(dsl, ctx);
    expect(result.values).toHaveLength(1);
    expect(result.values[0].name).toBe(fieldName);
    expect(result.values[0].aggregation).toBe('sum');
  });
});

// ---------------------------------------------------------------------------
// 4. Serialize/round-trip (500 cases)
// ---------------------------------------------------------------------------

const roundTripCases = Array.from({ length: 500 }, (_, i) => [`Field_${i}`]);

describe('Hyper: Serialize/round-trip (500 cases)', () => {
  it.each(roundTripCases)('round-trips ROWS: %s through serialize and re-parse', (fieldName) => {
    const ctx = makeCtx([fieldName]);
    const dsl = `ROWS: ${fieldName}`;
    const result1 = processDsl(dsl, ctx);
    expect(result1.rows).toHaveLength(1);

    // Serialize the compiled state back to DSL text
    const serialized = serialize(
      result1.rows,
      result1.columns,
      result1.values,
      result1.filters,
      result1.layout,
    );

    // Re-parse the serialized text
    const result2 = processDsl(serialized, ctx);
    expect(result2.rows).toHaveLength(1);
    expect(result2.rows[0].name).toBe(fieldName);
  });
});

// ---------------------------------------------------------------------------
// 5. Compile error for unknown fields (500 cases)
// ---------------------------------------------------------------------------

const errorCases = Array.from({ length: 500 }, (_, i) => [`ROWS: Unknown_${i}`, `Unknown_${i}`]);

describe('Hyper: Compile error for unknown fields (500 cases)', () => {
  it.each(errorCases)('processDsl("%s") produces error for unknown field "%s"', (dsl, unknownName) => {
    // Context has NO fields, so any field reference should error
    const ctx = makeCtx([]);
    const result = processDsl(dsl, ctx);
    expect(result.errors.length).toBeGreaterThan(0);
    // At least one error should mention the unknown field
    const relevant = result.errors.some(e =>
      e.message.toLowerCase().includes('unknown') ||
      e.message.toLowerCase().includes('not found') ||
      e.message.includes(unknownName)
    );
    expect(relevant).toBe(true);
  });
});
