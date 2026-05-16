//! FILENAME: app/extensions/Pivot/dsl/dsl-field-names-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for field name lexing, round-trip, and clause usage.
// TARGET: 330+ test cases via it.each.

import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { parse } from './parser';
import { serialize } from './serializer';
import { TokenType, KEYWORDS } from './tokens';
import type { ZoneField } from '../../_shared/components/types';
import type { LayoutConfig } from '../components/types';

// ============================================================================
// Helpers
// ============================================================================

function lexFieldTokens(input: string) {
  const result = lex(input);
  return result.tokens.filter(t => t.type !== TokenType.EOF && t.type !== TokenType.Newline);
}

function defaultLayout(): LayoutConfig {
  return {
    reportLayout: undefined,
    repeatRowLabels: undefined,
    showRowGrandTotals: undefined,
    showColumnGrandTotals: undefined,
    showEmptyRows: false,
    showEmptyCols: false,
    valuesPosition: 'columns',
    autoFitColumnWidths: false,
  };
}

function makeZoneField(name: string, index: number = 0): ZoneField {
  return { index, name, isNumeric: false };
}

function makeValueField(name: string, index: number = 0): ZoneField {
  return { index, name, isNumeric: true, aggregation: 'sum' };
}

function makeFilterField(name: string, index: number = 0): ZoneField {
  return { index, name, isNumeric: false, hiddenItems: ['x'] };
}

// ============================================================================
// 1. Field name lexing: 100 names via it.each
// ============================================================================

describe('Field name lexing - 100 names', () => {

  // --- Simple identifiers (lex as Identifier or keyword) ---
  const simpleIdentifiers: [string, string, TokenType][] = [
    ['Sales', 'Sales', TokenType.Identifier],
    ['Region', 'Region', TokenType.Identifier],
    ['x', 'x', TokenType.Identifier],
    ['A', 'A', TokenType.Identifier],
    ['_private', '_private', TokenType.Identifier],
    ['__double', '__double', TokenType.Identifier],
    ['camelCase', 'camelCase', TokenType.Identifier],
    ['PascalCase', 'PascalCase', TokenType.Identifier],
    ['ALLCAPS', 'ALLCAPS', TokenType.Identifier],
    ['lowercase', 'lowercase', TokenType.Identifier],
    ['a1', 'a1', TokenType.Identifier],
    ['field123', 'field123', TokenType.Identifier],
    ['_0', '_0', TokenType.Identifier],
    ['ABC_DEF', 'ABC_DEF', TokenType.Identifier],
    ['z9z9z9', 'z9z9z9', TokenType.Identifier],
  ];

  it.each(simpleIdentifiers)(
    'lexes simple identifier %s',
    (input, expectedValue, expectedType) => {
      const tokens = lexFieldTokens(input);
      expect(tokens.length).toBeGreaterThanOrEqual(1);
      expect(tokens[0].value).toBe(expectedValue);
      expect(tokens[0].type).toBe(expectedType);
    },
  );

  // --- Quoted strings (lex as StringLiteral) ---
  const quotedStrings: [string, string][] = [
    ['"Sales Amount"', 'Sales Amount'],
    ['"hello world"', 'hello world'],
    ['"with,comma"', 'with,comma'],
    ['"with:colon"', 'with:colon'],
    ['"with(parens)"', 'with(parens)'],
    ['"with=equals"', 'with=equals'],
    ['"with.dot"', 'with.dot'],
    ['"123numeric"', '123numeric'],
    ['"  spaces  "', '  spaces  '],
    ['""', ''],
    ['"a"', 'a'],
    ['"ROWS"', 'ROWS'],
    ['"VALUES"', 'VALUES'],
    ['"Sum"', 'Sum'],
    ['"ASC"', 'ASC'],
    ['"true"', 'true'],
    ['"false"', 'false'],
    ['"null"', 'null'],
    ['"123"', '123'],
    ['"3.14"', '3.14'],
  ];

  it.each(quotedStrings)(
    'lexes quoted string %s',
    (input, expectedContent) => {
      const tokens = lexFieldTokens(input);
      expect(tokens.length).toBeGreaterThanOrEqual(1);
      const strToken = tokens.find(t => t.type === TokenType.StringLiteral);
      expect(strToken).toBeDefined();
      expect(strToken!.value).toBe(expectedContent);
    },
  );

  // --- Dotted identifiers ---
  const dottedNames: [string, string][] = [
    ['Table.Column', 'Table.Column'],
    ['Customers.Region', 'Customers.Region'],
    ['Sales.Amount', 'Sales.Amount'],
    ['A.B', 'A.B'],
    ['abc.def', 'abc.def'],
    ['_a._b', '_a._b'],
    ['X1.Y2', 'X1.Y2'],
    ['LONG.SHORT', 'LONG.SHORT'],
  ];

  it.each(dottedNames)(
    'lexes dotted identifier %s',
    (input, expectedValue) => {
      const tokens = lexFieldTokens(input);
      const dotted = tokens.find(t => t.type === TokenType.DottedIdentifier);
      expect(dotted).toBeDefined();
      expect(dotted!.value).toBe(expectedValue);
    },
  );

  // --- Hyphenated identifiers (like layout directives) ---
  const hyphenatedNames: [string, string][] = [
    ['repeat-labels', 'repeat-labels'],
    ['no-grand-totals', 'no-grand-totals'],
    ['auto-fit', 'auto-fit'],
    ['show-empty-rows', 'show-empty-rows'],
    ['my-custom-field', 'my-custom-field'],
    ['a-b', 'a-b'],
    ['x-y-z', 'x-y-z'],
  ];

  it.each(hyphenatedNames)(
    'lexes hyphenated identifier %s',
    (input, expectedValue) => {
      const tokens = lexFieldTokens(input);
      expect(tokens[0].value).toBe(expectedValue);
      expect(tokens[0].type).toBe(TokenType.Identifier);
    },
  );

  // --- Bracket identifiers ---
  const bracketNames: [string, string][] = [
    ['[Total Revenue]', 'Total Revenue'],
    ['[Sum of Sales]', 'Sum of Sales'],
    ['[% of Row]', '% of Row'],
    ['[a]', 'a'],
    ['[123]', '123'],
    ['[with spaces and stuff]', 'with spaces and stuff'],
    ['[ROWS]', 'ROWS'],
    ['[comma,here]', 'comma,here'],
    ['[dot.here]', 'dot.here'],
    ['[equals=here]', 'equals=here'],
  ];

  it.each(bracketNames)(
    'lexes bracket identifier %s',
    (input, expectedContent) => {
      const tokens = lexFieldTokens(input);
      const bracket = tokens.find(t => t.type === TokenType.BracketIdentifier);
      expect(bracket).toBeDefined();
      expect(bracket!.value).toBe(expectedContent);
    },
  );

  // --- Keywords recognized as keyword tokens ---
  const keywords: [string, TokenType][] = [
    ['ROWS', TokenType.Rows],
    ['rows', TokenType.Rows],
    ['Rows', TokenType.Rows],
    ['COLUMNS', TokenType.Columns],
    ['VALUES', TokenType.Values],
    ['FILTERS', TokenType.Filters],
    ['SORT', TokenType.Sort],
    ['LAYOUT', TokenType.Layout],
    ['CALC', TokenType.Calc],
    ['TOP', TokenType.Top],
    ['BOTTOM', TokenType.Bottom],
    ['BY', TokenType.By],
    ['AS', TokenType.As],
    ['ASC', TokenType.Asc],
    ['DESC', TokenType.Desc],
    ['SAVE', TokenType.Save],
    ['NOT', TokenType.Not],
    ['IN', TokenType.In],
    ['VIA', TokenType.Via],
    ['LOOKUP', TokenType.Lookup],
  ];

  it.each(keywords)(
    'lexes keyword %s as %s',
    (input, expectedType) => {
      const tokens = lexFieldTokens(input);
      expect(tokens[0].type).toBe(expectedType);
    },
  );

  // --- Numbers ---
  const numbers: [string, string][] = [
    ['0', '0'],
    ['1', '1'],
    ['42', '42'],
    ['999', '999'],
    ['3.14', '3.14'],
    ['0.5', '0.5'],
    ['100.00', '100.00'],
  ];

  it.each(numbers)(
    'lexes number %s',
    (input, expectedValue) => {
      const tokens = lexFieldTokens(input);
      expect(tokens[0].type).toBe(TokenType.NumberLiteral);
      expect(tokens[0].value).toBe(expectedValue);
    },
  );

  // --- Unknown/special characters produce errors ---
  const unknownChars: string[] = ['@', '!', '~', '`', '?', '&', '%', '$', '{', '}', '\\', '|'];

  it.each(unknownChars)(
    'reports error for unknown character %s',
    (ch) => {
      const result = lex(ch);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    },
  );
});

// ============================================================================
// 2. Field name round-trip (serialize -> lex -> verify): 50 names
// ============================================================================

describe('Field name round-trip (serialize -> re-lex) - 50 names', () => {

  const roundTripNames: [string, string][] = [
    // Simple names that don't need quoting
    ['Sales', 'Sales'],
    ['Region', 'Region'],
    ['Amount', 'Amount'],
    ['X', 'X'],
    ['_field', '_field'],
    ['count99', 'count99'],
    ['ABC', 'ABC'],
    ['myField', 'myField'],
    ['Data2024', 'Data2024'],
    ['TOTAL', 'TOTAL'],
    // Names that need quoting for serialize (contain special chars)
    ['Sales Amount', '"Sales Amount"'],
    ['with,comma', '"with,comma"'],
    ['with:colon', '"with:colon"'],
    ['with(paren', '"with(paren"'],
    ['with)paren', '"with)paren"'],
    ['with=eq', '"with=eq"'],
    ['with.dot', 'with.dot'],
    ['has space', '"has space"'],
    ['has\ttab', '"has\ttab"'],
    ['[bracket]', '"[bracket]"'],
    ['has#hash', '"has#hash"'],
    // Dotted names (Table.Column pattern stays unquoted)
    ['Table.Column', 'Table.Column'],
    ['Customers.Region', 'Customers.Region'],
    ['A.B', 'A.B'],
    // More simple identifiers
    ['Profit', 'Profit'],
    ['Discount', 'Discount'],
    ['Cost', 'Cost'],
    ['Revenue', 'Revenue'],
    ['Margin', 'Margin'],
    ['Price', 'Price'],
    ['Units', 'Units'],
    ['Year', 'Year'],
    ['Month', 'Month'],
    ['Day', 'Day'],
    ['Quarter', 'Quarter'],
    ['Week', 'Week'],
    ['Name', 'Name'],
    ['City', 'City'],
    ['State', 'State'],
    ['Country', 'Country'],
    ['Address', 'Address'],
    ['Phone', 'Phone'],
    ['Email', 'Email'],
    ['Status', 'Status'],
    ['Type', 'Type'],
    ['Code', 'Code'],
    ['ID', 'ID'],
    ['Date', 'Date'],
    ['Time', 'Time'],
    ['Value', 'Value'],
  ];

  it.each(roundTripNames)(
    'round-trip for field name %s',
    (name, expectedSerialized) => {
      // Serialize via ROWS clause
      const dsl = serialize(
        [makeZoneField(name)],
        [],
        [],
        [],
        defaultLayout(),
      );
      expect(dsl).toContain(expectedSerialized);

      // Re-lex the serialized output
      const result = lex(dsl);
      expect(result.errors).toHaveLength(0);

      // The field name should appear as some token
      const nonStructural = result.tokens.filter(
        t => t.type !== TokenType.EOF && t.type !== TokenType.Newline
          && t.type !== TokenType.Colon && t.type !== TokenType.Comment,
      );
      expect(nonStructural.length).toBeGreaterThanOrEqual(1);
    },
  );
});

// ============================================================================
// 3. Field name in each clause type: 30 names x 6 clause types = 180 tests
// ============================================================================

describe('Field name in each clause type - 180 tests', () => {

  const clauseFieldNames: string[] = [
    'Sales', 'Region', 'Product', 'Amount', 'Quantity',
    'Category', 'Profit', 'Discount', 'Cost', 'Revenue',
    'Margin', 'Price', 'Units', 'Year', 'Month',
    'Quarter', 'City', 'State', 'Country', 'Name',
    'Type', 'Code', 'ID', 'Date', 'Value',
    'Status', 'Phone', 'Email', 'Address', 'Week',
  ];

  const clauseTypes: [string, (name: string) => string][] = [
    ['ROWS', (n) => `ROWS: ${n}`],
    ['COLUMNS', (n) => `COLUMNS: ${n}`],
    ['VALUES (sum)', (n) => `VALUES: Sum(${n})`],
    ['FILTERS', (n) => `FILTERS: ${n}`],
    ['SORT', (n) => `SORT: ${n} ASC`],
    ['FILTERS NOT IN', (n) => `FILTERS: ${n} NOT IN ("x")`],
  ];

  const combos = clauseFieldNames.flatMap(name =>
    clauseTypes.map(([clauseName, buildDsl]) => ({
      name,
      clauseName,
      dsl: buildDsl(name),
    })),
  );

  it.each(combos)(
    'field "$name" in $clauseName clause',
    ({ dsl }) => {
      const lexResult = lex(dsl);
      expect(lexResult.errors).toHaveLength(0);

      const parseResult = parse(lexResult.tokens);
      expect(parseResult.errors).toHaveLength(0);

      // At least one clause should have content
      const ast = parseResult.ast;
      const hasContent =
        ast.rows.length > 0 ||
        ast.columns.length > 0 ||
        ast.values.length > 0 ||
        ast.filters.length > 0 ||
        ast.sort.length > 0;
      expect(hasContent).toBe(true);
    },
  );
});
