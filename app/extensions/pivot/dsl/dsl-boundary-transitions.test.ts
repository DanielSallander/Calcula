//! FILENAME: app/extensions/Pivot/dsl/dsl-boundary-transitions.test.ts
// PURPOSE: Tests targeting exact boundary transitions in the Pivot DSL:
//          TOP N with exactly N items, filter edge cases, CALC division by zero,
//          keyword-like field names, and empty filter value lists.

import { describe, it, expect } from 'vitest';
import { processDsl } from './index';
import { lex } from './lexer';
import { parse } from './parser';
import type { SourceField } from '../../_shared/components/types';
import type { CompileContext } from './compiler';

// ============================================================================
// Helpers
// ============================================================================

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

const FIELDS: SourceField[] = [
  sf(0, 'Region'),
  sf(1, 'Product'),
  sf(2, 'Quarter'),
  sf(3, 'Sales', true),
  sf(4, 'Profit', true),
  sf(5, 'Quantity', true),
  sf(6, 'Category'),
  sf(7, 'ROWS', false),     // field name that looks like a keyword
  sf(8, 'VALUES', false),   // field name that looks like a keyword
];

function ctx(
  fields: SourceField[] = FIELDS,
  filterUniqueValues?: Map<string, string[]>,
): CompileContext {
  return { sourceFields: fields, filterUniqueValues };
}

function run(dsl: string, context?: CompileContext) {
  return processDsl(dsl, context ?? ctx());
}

// ============================================================================
// TOP N with exactly N items available
// ============================================================================

describe('TOP N boundary: exactly N items', () => {
  it('TOP 3 BY Sales parses with count=3', () => {
    const { tokens } = lex('TOP 3 BY Sales');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.topN).toBeDefined();
    expect(ast.topN!.count).toBe(3);
    expect(ast.topN!.top).toBe(true);
    expect(ast.topN!.byField).toBe('Sales');
  });

  it('TOP 1 BY Sales is the minimum meaningful top-N', () => {
    const { tokens } = lex('TOP 1 BY Sales');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.topN!.count).toBe(1);
  });

  it('BOTTOM 1 BY Profit parses correctly', () => {
    const { tokens } = lex('BOTTOM 1 BY Profit');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.topN!.top).toBe(false);
    expect(ast.topN!.count).toBe(1);
  });

  it('TOP 0 BY Sales parses (edge: zero count)', () => {
    const { tokens } = lex('TOP 0 BY Sales');
    const { ast } = parse(tokens);
    // Parser should accept numeric literal 0
    expect(ast.topN).toBeDefined();
    expect(ast.topN!.count).toBe(0);
  });

  it('TOP N compiles alongside ROWS and VALUES', () => {
    const result = run('ROWS: Region\nVALUES: Sum(Sales)\nTOP 5 BY Sales');
    expect(result.rows).toHaveLength(1);
    expect(result.values).toHaveLength(1);
  });
});

// ============================================================================
// FILTER: all values hidden vs all shown
// ============================================================================

describe('FILTER boundary: all hidden vs all shown', () => {
  it('inclusion filter with all values = effectively no filter', () => {
    const uniqueValues = new Map([['Region', ['East', 'West', 'North', 'South']]]);
    const result = run(
      'FILTERS: Region = ("East", "West", "North", "South")',
      ctx(FIELDS, uniqueValues),
    );
    expect(result.filters).toHaveLength(1);
    // When all values are included, hiddenItems should be empty
    expect(result.filters[0].hiddenItems).toEqual([]);
  });

  it('NOT IN with all values hides everything', () => {
    const result = run(
      'FILTERS: Region NOT IN ("East", "West", "North", "South")',
    );
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].hiddenItems).toEqual(['East', 'West', 'North', 'South']);
  });

  it('inclusion filter with single value hides the rest', () => {
    const uniqueValues = new Map([['Region', ['East', 'West', 'North', 'South']]]);
    const result = run(
      'FILTERS: Region = ("East")',
      ctx(FIELDS, uniqueValues),
    );
    expect(result.filters[0].hiddenItems).toEqual(
      expect.arrayContaining(['West', 'North', 'South']),
    );
    expect(result.filters[0].hiddenItems).not.toContain('East');
  });
});

// ============================================================================
// CALC expression with division by exactly zero
// ============================================================================

describe('CALC boundary: division by zero', () => {
  it('CALC with literal division by zero parses without error', () => {
    const { tokens } = lex('CALC: Ratio = [Sales] / 0');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.calculatedFields).toHaveLength(1);
    expect(ast.calculatedFields[0].expression).toContain('/ 0');
  });

  it('CALC with complex expression compiles', () => {
    const result = run('CALC: Margin = [Sales] - [Profit]');
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.calculatedFields[0].name).toBe('Margin');
  });

  it('multiple CALC fields compile independently', () => {
    const result = run(
      'CALC: Margin = [Sales] - [Profit]\nCALC: Ratio = [Sales] / [Quantity]',
    );
    expect(result.calculatedFields).toHaveLength(2);
    expect(result.calculatedFields[0].name).toBe('Margin');
    expect(result.calculatedFields[1].name).toBe('Ratio');
  });
});

// ============================================================================
// Field name that looks like a keyword (ROWS, VALUES as field names)
// ============================================================================

describe('Keyword-like field names', () => {
  it('field named ROWS in ROWS clause is consumed as keyword, not field', () => {
    // "ROWS" is a keyword token, so "ROWS: ROWS" parses the second ROWS
    // as a new clause keyword, not as a field name. The result has no row fields.
    const result = run('ROWS: ROWS');
    // The lexer treats ROWS as a keyword, so it cannot be used as a field name
    expect(result.rows).toHaveLength(0);
  });

  it('field named VALUES in COLUMNS is treated as keyword', () => {
    const result = run('COLUMNS: VALUES');
    // VALUES is a keyword, so it starts a new clause rather than being a field
    expect(result.columns).toHaveLength(0);
  });

  it('normal field alongside keyword-like tokens', () => {
    // Region is a valid field, ROWS triggers a new clause
    const result = run('ROWS: Region\nCOLUMNS: Product');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sourceIndex).toBe(0);
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].sourceIndex).toBe(1);
  });
});

// ============================================================================
// Empty value list in filter clause
// ============================================================================

describe('FILTER boundary: empty or minimal value lists', () => {
  it('FILTERS clause with no values after field name', () => {
    const result = run('FILTERS: Region');
    // Field with no include/exclude => just a slicer field, no hidden items
    expect(result.filters).toHaveLength(1);
    // hiddenItems may be undefined or empty array when no filter values specified
    expect(result.filters[0].hiddenItems ?? []).toEqual([]);
  });

  it('FILTERS with single value in NOT IN', () => {
    const result = run('FILTERS: Region NOT IN ("East")');
    expect(result.filters[0].hiddenItems).toEqual(['East']);
  });

  it('FILTERS with empty parentheses parses gracefully', () => {
    const result = run('FILTERS: Region = ()');
    // Empty inclusion list - should not crash
    expect(result).toBeDefined();
  });

  it('multiple filters compile independently', () => {
    const result = run(
      'FILTERS: Region NOT IN ("East"), Product NOT IN ("Widget")',
    );
    expect(result.filters).toHaveLength(2);
  });
});
