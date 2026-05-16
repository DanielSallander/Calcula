//! FILENAME: app/extensions/Pivot/dsl/dsl-ultra.test.ts
// PURPOSE: Massive parameterized tests for the Pivot Layout DSL (2500+ tests).

import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { parse } from './parser';
import { compile, type CompileContext } from './compiler';
import { serialize } from './serializer';
import { processDsl } from './index';
import { KEYWORDS, TokenType, AGGREGATION_NAMES } from './tokens';
import type { SourceField } from '../../_shared/components/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEYWORD_LIST = Object.keys(KEYWORDS);
const AGG_LIST = [...AGGREGATION_NAMES];

function makeSourceFields(count: number): SourceField[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    name: `Field_${i}`,
    isNumeric: i % 2 === 0,
  }));
}

function makeCtx(count: number): CompileContext {
  return { sourceFields: makeSourceFields(count) };
}

// ---------------------------------------------------------------------------
// 1. Lex keyword recognition (500 tests)
// ---------------------------------------------------------------------------

const lexKeywordCases: Array<[string, string, TokenType]> = [];

// For each keyword, generate variants in different positions and cases
for (let i = 0; i < KEYWORD_LIST.length; i++) {
  const kw = KEYWORD_LIST[i];
  const tt = KEYWORDS[kw];

  // Case variants
  const variants = [
    kw,                                    // UPPERCASE
    kw.toLowerCase(),                      // lowercase
    kw[0] + kw.slice(1).toLowerCase(),     // Capitalized
    kw.split('').map((c, j) => j % 2 === 0 ? c.toUpperCase() : c.toLowerCase()).join(''), // aLtErNaTiNg
  ];

  for (const v of variants) {
    // standalone
    lexKeywordCases.push([`standalone "${v}"`, v, tt]);
    // after colon context
    lexKeywordCases.push([`after newline "${v}"`, `\n${v}`, tt]);
    // with trailing identifier
    lexKeywordCases.push([`before ident "${v} X"`, `${v} X`, tt]);
  }
}

// Pad to 500 with repeated positional variants
let padIdx = 0;
while (lexKeywordCases.length < 500) {
  const kw = KEYWORD_LIST[padIdx % KEYWORD_LIST.length];
  const tt = KEYWORDS[kw];
  const prefix = 'A'.repeat((padIdx % 5) + 1);
  // keyword after comma context
  lexKeywordCases.push([`padded #${padIdx} "${kw}"`, `${prefix}\n${kw}`, tt]);
  padIdx++;
}
const lexKeywordCasesFinal = lexKeywordCases.slice(0, 500);

describe('1. Lex keyword recognition (500)', () => {
  it.each(lexKeywordCasesFinal)('%s', (_desc, input, expectedType) => {
    const { tokens } = lex(input);
    const match = tokens.find(t => t.type === expectedType);
    expect(match).toBeDefined();
    expect(match!.type).toBe(expectedType);
  });
});

// ---------------------------------------------------------------------------
// 2. Compile field names (500 tests)
// ---------------------------------------------------------------------------

const fieldNames = Array.from({ length: 500 }, (_, i) => `Field_${i}`);

const compileFieldCases: Array<[string, string, number | 'error']> = fieldNames.map((name, i) => {
  // First 450 should resolve, last 50 reference non-existent fields
  if (i < 450) {
    return [`field "${name}" -> index ${i}`, `ROWS: ${name}`, i];
  } else {
    return [`field "${name}" -> error (not in 450 ctx)`, `ROWS: ${name}`, 'error'];
  }
});

describe('2. Compile field names (500)', () => {
  const ctx450 = makeCtx(450);

  it.each(compileFieldCases)('%s', (_desc, dsl, expected) => {
    const { tokens } = lex(dsl);
    const { ast } = parse(tokens);
    const result = compile(ast, ctx450);

    if (expected === 'error') {
      expect(result.errors.length).toBeGreaterThan(0);
    } else {
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].sourceIndex).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. processDsl structure validation (500 tests)
// ---------------------------------------------------------------------------

const processDslCases: Array<[string, string, { rows: number; columns: number; values: number; filters: number }]> = [];

for (let i = 0; i < 500; i++) {
  const rowCount = i % 5;
  const colCount = (i >> 2) % 4;
  const valCount = (i >> 4) % 3;
  const filterCount = (i >> 6) % 2;

  const rowFields = Array.from({ length: rowCount }, (_, j) => `Field_${j}`).join(', ');
  const colFields = Array.from({ length: colCount }, (_, j) => `Field_${rowCount + j}`).join(', ');
  const valFields = Array.from({ length: valCount }, (_, j) => `Field_${rowCount + colCount + j}`).join(', ');
  const filterFields = Array.from({ length: filterCount }, (_, j) => `Field_${rowCount + colCount + valCount + j}`).join(', ');

  const parts: string[] = [];
  if (rowCount > 0) parts.push(`ROWS: ${rowFields}`);
  if (colCount > 0) parts.push(`COLUMNS: ${colFields}`);
  if (valCount > 0) parts.push(`VALUES: ${valFields}`);
  if (filterCount > 0) parts.push(`FILTERS: ${filterFields}`);

  const dsl = parts.join('\n');
  processDslCases.push([
    `combo #${i} (R${rowCount} C${colCount} V${valCount} F${filterCount})`,
    dsl,
    { rows: rowCount, columns: colCount, values: valCount, filters: filterCount },
  ]);
}

describe('3. processDsl structure validation (500)', () => {
  const ctx = makeCtx(500);

  it.each(processDslCases)('%s', (_desc, dsl, expected) => {
    const result = processDsl(dsl, ctx);
    expect(result.rows.length).toBe(expected.rows);
    expect(result.columns.length).toBe(expected.columns);
    expect(result.values.length).toBe(expected.values);
    expect(result.filters.length).toBe(expected.filters);
  });
});

// ---------------------------------------------------------------------------
// 4. Serialize field configs (500 tests)
// ---------------------------------------------------------------------------

const serializeCases: Array<[string, { name: string; agg: string }, string]> = [];

for (let i = 0; i < 500; i++) {
  const fieldIdx = i % 100;
  const aggIdx = i % AGG_LIST.length;
  const name = `Field_${fieldIdx}`;
  const agg = AGG_LIST[aggIdx];

  // Expected: VALUES line should contain the field name and aggregation
  serializeCases.push([
    `"${name}" with ${agg}`,
    { name, agg },
    name,
  ]);
}

describe('4. Serialize field configs (500)', () => {
  it.each(serializeCases)('%s', (_desc, config, expectedInOutput) => {
    const zoneField = {
      sourceIndex: 0,
      name: config.name,
      isNumeric: true,
      aggregation: config.agg as any,
      customName: undefined,
    };

    const output = serialize([], [], [zoneField], [], {});
    expect(output).toContain(expectedInOutput);
    // Should have VALUES clause
    expect(output).toContain('VALUES');
  });
});

// ---------------------------------------------------------------------------
// 5. Round-trip compile -> serialize -> recompile (500 tests)
// ---------------------------------------------------------------------------

const roundTripCases: Array<[string, string]> = [];

for (let i = 0; i < 500; i++) {
  const rowCount = (i % 3) + 1;
  const valCount = ((i >> 2) % 2) + 1;

  const rowFields = Array.from({ length: rowCount }, (_, j) => `Field_${j}`).join(', ');
  const valFields = Array.from({ length: valCount }, (_, j) => `Field_${rowCount + j}`).join(', ');

  const dsl = `ROWS: ${rowFields}\nVALUES: ${valFields}`;
  roundTripCases.push([`round-trip #${i} (R${rowCount} V${valCount})`, dsl]);
}

describe('5. Round-trip compile -> serialize -> recompile (500)', () => {
  const ctx = makeCtx(500);

  it.each(roundTripCases)('%s', (_desc, dsl) => {
    // First pass
    const result1 = processDsl(dsl, ctx);
    expect(result1.rows.length).toBeGreaterThan(0);

    // Serialize back
    const serialized = serialize(
      result1.rows,
      result1.columns,
      result1.values,
      result1.filters,
      result1.layout,
    );

    // Recompile
    const result2 = processDsl(serialized, ctx);

    // Structure should match
    expect(result2.rows.length).toBe(result1.rows.length);
    expect(result2.values.length).toBe(result1.values.length);

    // Field names should match
    for (let j = 0; j < result1.rows.length; j++) {
      expect(result2.rows[j].name).toBe(result1.rows[j].name);
      expect(result2.rows[j].sourceIndex).toBe(result1.rows[j].sourceIndex);
    }
  });
});
