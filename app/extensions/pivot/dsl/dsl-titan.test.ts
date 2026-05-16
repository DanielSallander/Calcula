//! FILENAME: app/extensions/Pivot/dsl/dsl-titan.test.ts
// PURPOSE: Massive parameterized tests (12000+) for DSL lexer, compiler, and round-trip.

import { describe, it, expect } from 'vitest';
import { lex, processDsl, serialize, TokenType } from './index';
import type { SourceField } from '../../_shared/components/types';

// ---------- Test data generators ----------

const sourceFields: SourceField[] = Array.from({ length: 4000 }, (_, i) => ({
  index: i,
  name: `Field_${i}`,
  isNumeric: i % 2 === 0,
}));

const lexCases: [string][] = Array.from({ length: 4000 }, (_, i) => [`Field_${i}`]);

const rowsCases: [string, string, SourceField[]][] = Array.from({ length: 4000 }, (_, i) => [
  `ROWS: Field_${i}`,
  `Field_${i}`,
  sourceFields.slice(0, i + 1),
]);

const roundTripCases: [string, string, SourceField[]][] = Array.from({ length: 4000 }, (_, i) => [
  `ROWS: Field_${i}`,
  `Field_${i}`,
  sourceFields.slice(0, i + 1),
]);

// ---------- 1. Lex identifiers: 4000 cases ----------

describe('DSL Titan: lex identifiers', () => {
  it.each(lexCases)('lex("%s") produces IDENTIFIER token', (input) => {
    const { tokens } = lex(input);
    const identTokens = tokens.filter(t => t.type === TokenType.Identifier);
    expect(identTokens.length).toBeGreaterThanOrEqual(1);
    expect(identTokens[0].value).toBe(input);
  });
});

// ---------- 2. processDsl ROWS: 4000 cases ----------

describe('DSL Titan: processDsl ROWS', () => {
  it.each(rowsCases)('processDsl("%s") yields rows[0].name = "%s"', (dslText, fieldName, fields) => {
    const result = processDsl(dslText, { sourceFields: fields });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].name).toBe(fieldName);
  });
});

// ---------- 3. Round-trip: 4000 cases ----------

describe('DSL Titan: round-trip compile then serialize', () => {
  it.each(roundTripCases)('round-trip "%s" contains "%s"', (dslText, fieldName, fields) => {
    const result = processDsl(dslText, { sourceFields: fields });
    const output = serialize(result.rows, result.columns, result.values, result.filters, result.layout);
    expect(output).toContain(fieldName);
  });
});
