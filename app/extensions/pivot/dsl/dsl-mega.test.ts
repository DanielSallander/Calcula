/**
 * FILENAME: app/extensions/Pivot/dsl/dsl-mega.test.ts
 * PURPOSE: Heavily parameterized mega test suite (1000+ tests) covering
 *          lexer tokens, field resolution, serialization, processDsl, and round-trips.
 */

import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { TokenType, KEYWORDS } from './tokens';
import { compile, type CompileContext } from './compiler';
import { serialize } from './serializer';
import { parse } from './parser';
import { processDsl } from './index';
import type { SourceField, ZoneField } from '../../_shared/components/types';

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
// 1. Lex single tokens (200 cases)
// ---------------------------------------------------------------------------

describe('Mega: Lex single tokens', () => {
  // 50 keyword variants (case-insensitive)
  const keywordCases: [string, TokenType][] = [
    ['ROWS', TokenType.Rows], ['rows', TokenType.Rows], ['Rows', TokenType.Rows],
    ['COLUMNS', TokenType.Columns], ['columns', TokenType.Columns], ['Columns', TokenType.Columns],
    ['VALUES', TokenType.Values], ['values', TokenType.Values], ['Values', TokenType.Values],
    ['FILTERS', TokenType.Filters], ['filters', TokenType.Filters], ['Filters', TokenType.Filters],
    ['SORT', TokenType.Sort], ['sort', TokenType.Sort], ['Sort', TokenType.Sort],
    ['LAYOUT', TokenType.Layout], ['layout', TokenType.Layout], ['Layout', TokenType.Layout],
    ['CALC', TokenType.Calc], ['calc', TokenType.Calc], ['Calc', TokenType.Calc],
    ['TOP', TokenType.Top], ['top', TokenType.Top], ['Top', TokenType.Top],
    ['BOTTOM', TokenType.Bottom], ['bottom', TokenType.Bottom], ['Bottom', TokenType.Bottom],
    ['BY', TokenType.By], ['by', TokenType.By], ['By', TokenType.By],
    ['AS', TokenType.As], ['as', TokenType.As], ['As', TokenType.As],
    ['SAVE', TokenType.Save], ['save', TokenType.Save], ['Save', TokenType.Save],
    ['LOOKUP', TokenType.Lookup], ['lookup', TokenType.Lookup], ['Lookup', TokenType.Lookup],
    ['VIA', TokenType.Via], ['via', TokenType.Via], ['Via', TokenType.Via],
    ['NOT', TokenType.Not], ['not', TokenType.Not], ['Not', TokenType.Not],
    ['IN', TokenType.In], ['in', TokenType.In], ['In', TokenType.In],
    ['ASC', TokenType.Asc], ['asc', TokenType.Asc],
    ['DESC', TokenType.Desc], ['desc', TokenType.Desc],
  ];

  it.each(keywordCases)('keyword "%s" -> %s', (input, expectedType) => {
    const { tokens } = lex(input);
    expect(tokens[0].type).toBe(expectedType);
  });

  // 50 identifiers
  const identCases: string[] = [
    'Region', 'Sales', 'Amount', 'Quantity', 'Product', 'Customer', 'Date',
    'Category', 'SubCategory', 'Country', 'City', 'State', 'Zip', 'Name',
    'Price', 'Cost', 'Profit', 'Margin', 'Tax', 'Discount', 'Revenue',
    'Units', 'Weight', 'Height', 'Width', 'Depth', 'Color', 'Size',
    'Brand', 'Model', 'Year', 'Month', 'Day', 'Quarter', 'Week',
    'Employee', 'Manager', 'Department', 'Division', 'Office', 'Channel',
    'Segment', 'Market', 'Territory', 'Zone', 'Level', 'Tier', 'Grade',
    'Status', 'Priority',
  ];

  it.each(identCases)('identifier "%s"', (input) => {
    const { tokens } = lex(input);
    expect(tokens[0].type).toBe(TokenType.Identifier);
    expect(tokens[0].value).toBe(input);
  });

  // 50 strings
  const stringCases: string[] = Array.from({ length: 50 }, (_, i) => `"str_${i}"`);

  it.each(stringCases)('string literal %s', (input) => {
    const { tokens } = lex(input);
    expect(tokens[0].type).toBe(TokenType.StringLiteral);
    expect(tokens[0].value).toBe(input.slice(1, -1));
  });

  // 50 numbers and symbols
  const numSymCases: [string, TokenType][] = [
    ['0', TokenType.NumberLiteral], ['1', TokenType.NumberLiteral],
    ['10', TokenType.NumberLiteral], ['42', TokenType.NumberLiteral],
    ['99', TokenType.NumberLiteral], ['100', TokenType.NumberLiteral],
    ['255', TokenType.NumberLiteral], ['1000', TokenType.NumberLiteral],
    ['3.14', TokenType.NumberLiteral], ['2.71', TokenType.NumberLiteral],
    ['0.5', TokenType.NumberLiteral], ['1.0', TokenType.NumberLiteral],
    ['99.99', TokenType.NumberLiteral], ['123.456', TokenType.NumberLiteral],
    ['7.7', TokenType.NumberLiteral], ['50.0', TokenType.NumberLiteral],
    ['999', TokenType.NumberLiteral], ['12345', TokenType.NumberLiteral],
    ['6.28', TokenType.NumberLiteral], ['0.001', TokenType.NumberLiteral],
    ['11', TokenType.NumberLiteral], ['22', TokenType.NumberLiteral],
    ['33', TokenType.NumberLiteral], ['44', TokenType.NumberLiteral],
    ['55', TokenType.NumberLiteral], ['66', TokenType.NumberLiteral],
    ['77', TokenType.NumberLiteral], ['88', TokenType.NumberLiteral],
    [':', TokenType.Colon], [',', TokenType.Comma],
    ['(', TokenType.LeftParen], [')', TokenType.RightParen],
    ['=', TokenType.Equals], ['.', TokenType.Dot],
    ['+', TokenType.Plus], ['-', TokenType.Minus],
    ['*', TokenType.Star], ['/', TokenType.Slash],
    ['^', TokenType.Caret],
    [':', TokenType.Colon], [',', TokenType.Comma],
    ['(', TokenType.LeftParen], [')', TokenType.RightParen],
    ['=', TokenType.Equals], ['+', TokenType.Plus],
    ['-', TokenType.Minus], ['*', TokenType.Star],
    ['/', TokenType.Slash], ['^', TokenType.Caret],
    ['.', TokenType.Dot],
  ];

  it.each(numSymCases)('number/symbol "%s" -> %s', (input, expectedType) => {
    const { tokens } = lex(input);
    expect(tokens[0].type).toBe(expectedType);
  });
});

// ---------------------------------------------------------------------------
// 2. Compile field resolution (200 cases)
// ---------------------------------------------------------------------------

describe('Mega: Compile field resolution', () => {
  const fieldNames = [
    'Region', 'Sales', 'Amount', 'Quantity', 'Product', 'Customer', 'Date',
    'Category', 'SubCategory', 'Country', 'City', 'State', 'Zip', 'Name',
    'Price', 'Cost', 'Profit', 'Margin', 'Tax', 'Discount',
  ];

  // Generate 200 cases: each picks a field at a different sourceIndex position
  const resolutionCases: [string, string[], number][] = [];
  for (let i = 0; i < 200; i++) {
    const targetIdx = i % fieldNames.length;
    const targetField = fieldNames[targetIdx];
    // Shuffle prefix fields to vary the sourceIndex
    const prefix = fieldNames.slice(0, targetIdx);
    const suffix = fieldNames.slice(targetIdx);
    const allFields = [...prefix, ...suffix];
    resolutionCases.push([targetField, allFields, prefix.length === 0 ? 0 : 0]);
  }

  // Simpler approach: vary position of target field
  const cases200: [string, number, string[]][] = [];
  for (let i = 0; i < 200; i++) {
    const numBefore = i % 10;
    const target = fieldNames[i % fieldNames.length];
    const before = Array.from({ length: numBefore }, (_, j) => `Filler${j}`);
    const fields = [...before, target];
    cases200.push([target, numBefore, fields]);
  }

  it.each(cases200)(
    'field "%s" at index %d',
    (fieldName, expectedIdx, fields) => {
      const dsl = `ROWS: ${fieldName}`;
      const ctx = makeCtx(fields);
      const result = processDsl(dsl, ctx);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].sourceIndex).toBe(expectedIdx);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Serialize values (200 cases)
// ---------------------------------------------------------------------------

describe('Mega: Serialize field configs', () => {
  // 100 field configs
  const fieldConfigs: [string, string][] = Array.from({ length: 100 }, (_, i) => {
    const name = `Field${i}`;
    return [name, name] as [string, string];
  });

  it.each(fieldConfigs)('serialize row field "%s"', (name, expected) => {
    const rows: ZoneField[] = [{ sourceIndex: 0, name, customName: undefined } as ZoneField];
    const output = serialize(rows, [], [], [], {} as any);
    expect(output).toContain(expected);
  });

  // 100 filter configs
  const filterConfigs: [string, string[], string][] = Array.from({ length: 100 }, (_, i) => {
    const name = `Filter${i}`;
    const hidden = [`val_${i}_a`, `val_${i}_b`];
    return [name, hidden, name] as [string, string[], string];
  });

  it.each(filterConfigs)('serialize filter field "%s"', (name, hiddenItems, expected) => {
    const filters: ZoneField[] = [{
      sourceIndex: 0,
      name,
      customName: undefined,
      hiddenItems,
    } as unknown as ZoneField];
    const output = serialize([], [], [], filters, {} as any);
    expect(output).toContain(expected);
  });
});

// ---------------------------------------------------------------------------
// 4. processDsl end-to-end (200 cases)
// ---------------------------------------------------------------------------

describe('Mega: processDsl end-to-end', () => {
  const baseFields = ['Region', 'Sales', 'Amount', 'Product', 'Category', 'Date'];
  const ctx = makeCtx(baseFields);

  const dslStrings: [string, string][] = [
    // ROWS variants
    ...Array.from({ length: 30 }, (_, i): [string, string] => [
      `rows_${i}`, `ROWS: ${baseFields[i % baseFields.length]}`,
    ]),
    // COLUMNS variants
    ...Array.from({ length: 30 }, (_, i): [string, string] => [
      `cols_${i}`, `COLUMNS: ${baseFields[i % baseFields.length]}`,
    ]),
    // VALUES variants
    ...Array.from({ length: 30 }, (_, i): [string, string] => [
      `vals_sum_${i}`, `VALUES: sum(${baseFields[(i + 1) % baseFields.length]})`,
    ]),
    ...Array.from({ length: 20 }, (_, i): [string, string] => [
      `vals_count_${i}`, `VALUES: count(${baseFields[i % baseFields.length]})`,
    ]),
    ...Array.from({ length: 20 }, (_, i): [string, string] => [
      `vals_avg_${i}`, `VALUES: average(${baseFields[i % baseFields.length]})`,
    ]),
    // FILTERS variants
    ...Array.from({ length: 20 }, (_, i): [string, string] => [
      `filter_${i}`, `FILTERS: ${baseFields[i % baseFields.length]} = "val${i}"`,
    ]),
    // Combined
    ...Array.from({ length: 30 }, (_, i): [string, string] => [
      `combo_${i}`,
      `ROWS: ${baseFields[i % baseFields.length]}\nVALUES: sum(${baseFields[(i + 1) % baseFields.length]})`,
    ]),
    // LAYOUT variants
    ...Array.from({ length: 20 }, (_, i): [string, string] => [
      `layout_${i}`, `ROWS: Region\nLAYOUT: ${['compact', 'outline', 'tabular'][i % 3]}`,
    ]),
    // SORT variants
    ...Array.from({ length: 20 }, (_, i): [string, string] => [
      `sort_${i}`,
      `ROWS: ${baseFields[i % baseFields.length]}\nSORT: ${baseFields[i % baseFields.length]} ${i % 2 === 0 ? 'asc' : 'desc'}`,
    ]),
  ];

  it.each(dslStrings)('case %s does not crash', (_label, dsl) => {
    const result = processDsl(dsl, ctx);
    expect(result).toBeDefined();
    expect(result).toHaveProperty('rows');
    expect(result).toHaveProperty('columns');
    expect(result).toHaveProperty('values');
    expect(result).toHaveProperty('filters');
    expect(result).toHaveProperty('layout');
    expect(Array.isArray(result.rows)).toBe(true);
    expect(Array.isArray(result.columns)).toBe(true);
    expect(Array.isArray(result.values)).toBe(true);
    expect(Array.isArray(result.filters)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Round-trip (200 cases)
// ---------------------------------------------------------------------------

describe('Mega: Round-trip compile -> serialize -> re-compile', () => {
  const baseFields = ['Region', 'Sales', 'Amount', 'Product', 'Category', 'Date'];
  const ctx = makeCtx(baseFields);

  const roundTripDsls: [string, string][] = [
    // Single row field
    ...Array.from({ length: 30 }, (_, i): [string, string] => [
      `rt_row_${i}`, `ROWS: ${baseFields[i % baseFields.length]}`,
    ]),
    // Single column field
    ...Array.from({ length: 30 }, (_, i): [string, string] => [
      `rt_col_${i}`, `COLUMNS: ${baseFields[i % baseFields.length]}`,
    ]),
    // Single value
    ...Array.from({ length: 30 }, (_, i): [string, string] => [
      `rt_val_${i}`, `VALUES: sum(${baseFields[(i + 1) % baseFields.length]})`,
    ]),
    // Row + value
    ...Array.from({ length: 40 }, (_, i): [string, string] => [
      `rt_rv_${i}`,
      `ROWS: ${baseFields[i % baseFields.length]}\nVALUES: sum(${baseFields[(i + 2) % baseFields.length]})`,
    ]),
    // Row + column + value
    ...Array.from({ length: 40 }, (_, i): [string, string] => [
      `rt_rcv_${i}`,
      `ROWS: ${baseFields[i % baseFields.length]}\nCOLUMNS: ${baseFields[(i + 1) % baseFields.length]}\nVALUES: sum(${baseFields[(i + 2) % baseFields.length]})`,
    ]),
    // Multiple rows
    ...Array.from({ length: 30 }, (_, i): [string, string] => [
      `rt_multi_${i}`,
      `ROWS: ${baseFields[i % baseFields.length]}, ${baseFields[(i + 1) % baseFields.length]}`,
    ]),
  ];

  it.each(roundTripDsls)('case %s round-trips field count', (_label, dsl) => {
    const result1 = processDsl(dsl, ctx);
    const serialized = serialize(
      result1.rows, result1.columns, result1.values, result1.filters,
      result1.layout,
    );
    const result2 = processDsl(serialized, ctx);

    const totalFields1 = result1.rows.length + result1.columns.length + result1.values.length;
    const totalFields2 = result2.rows.length + result2.columns.length + result2.values.length;
    expect(totalFields2).toBe(totalFields1);
  });
});
