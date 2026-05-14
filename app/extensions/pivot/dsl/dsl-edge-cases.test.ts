//! FILENAME: app/extensions/Pivot/dsl/dsl-edge-cases.test.ts
// PURPOSE: Edge-case tests for the full DSL pipeline (malformed input, boundary tokens, etc.).

import { describe, it, expect } from 'vitest';
import { processDsl } from './index';
import { lex } from './lexer';
import { parse } from './parser';
import type { SourceField } from '../../_shared/components/types';
import type { CompileContext } from './compiler';

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
  sf(7, 'Date'),
  sf(8, 'Cost', true),
];

function ctx(fields: SourceField[] = FIELDS): CompileContext {
  return { sourceFields: fields };
}

function run(dsl: string, context?: CompileContext) {
  return processDsl(dsl, context ?? ctx());
}

// ============================================================================
// Malformed / degenerate input
// ============================================================================

describe('Malformed input', () => {
  it('handles clause keyword with no colon', () => {
    const result = run('ROWS Region');
    // Should not crash; may produce errors or treat ROWS as identifier
    expect(result).toBeDefined();
  });

  it('handles clause keyword with no fields after colon', () => {
    const result = run('ROWS:');
    // Empty rows is valid (no fields specified)
    expect(result.rows).toHaveLength(0);
  });

  it('handles trailing comma in field list', () => {
    const result = run('ROWS: Region,');
    // Should parse Region, trailing comma may be ignored or cause warning
    expect(result.rows.length).toBeGreaterThanOrEqual(0);
  });

  it('handles leading comma in field list', () => {
    const result = run('ROWS: , Region');
    expect(result).toBeDefined();
  });

  it('handles double comma in field list', () => {
    const result = run('ROWS: Region,, Product');
    expect(result).toBeDefined();
  });

  it('handles only whitespace after colon', () => {
    const result = run('ROWS:   \nVALUES: Sum(Sales)');
    expect(result.values).toHaveLength(1);
  });

  it('handles duplicate clause keywords', () => {
    const result = run('ROWS: Region\nROWS: Product');
    // Second ROWS should either append or override
    expect(result).toBeDefined();
  });

  it('handles completely random text', () => {
    const result = run('hello world foo bar');
    // Should produce errors but not crash
    expect(result).toBeDefined();
  });

  it('handles only comments', () => {
    const result = run('# just a comment\n# another comment');
    expect(result.rows).toHaveLength(0);
    expect(result.values).toHaveLength(0);
  });

  it('handles comment after clause', () => {
    const result = run('ROWS: Region # this is the region field');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Region');
  });
});

// ============================================================================
// Special characters in field names (via quoted strings)
// ============================================================================

describe('Special characters in field names', () => {
  it('handles field names with parentheses via quotes', () => {
    const fields = [sf(0, 'Sales (USD)', true)];
    const result = run('VALUES: Sum("Sales (USD)")', ctx(fields));
    // This depends on parser support for quoted field names in aggregation calls
    expect(result).toBeDefined();
  });

  it('handles field names with numbers', () => {
    const fields = [sf(0, 'Q1Sales', true)];
    const result = run('VALUES: Sum(Q1Sales)', ctx(fields));
    expect(result.values).toHaveLength(1);
  });

  it('handles field names with underscores', () => {
    const fields = [sf(0, 'total_revenue', true)];
    const result = run('VALUES: Sum(total_revenue)', ctx(fields));
    expect(result.values).toHaveLength(1);
  });
});

// ============================================================================
// CALC expressions - edge cases
// ============================================================================

describe('CALC expression edge cases', () => {
  it('handles simple CALC expression', () => {
    const result = run('CALC: Margin = [Sales] - [Cost]');
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.calculatedFields[0].name).toBe('Margin');
    expect(result.calculatedFields[0].formula).toContain('[Sales]');
    expect(result.calculatedFields[0].formula).toContain('[Cost]');
  });

  it('handles CALC with division (potential div-by-zero)', () => {
    const result = run('CALC: Ratio = [Sales] / [Quantity]');
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.calculatedFields[0].formula).toContain('/');
  });

  it('handles CALC with multiplication and addition', () => {
    const result = run('CALC: Total = [Sales] * 1.1 + [Profit]');
    expect(result.calculatedFields).toHaveLength(1);
  });

  it('handles CALC with exponentiation', () => {
    const result = run('CALC: Squared = [Sales] ^ 2');
    expect(result.calculatedFields).toHaveLength(1);
  });

  it('handles multiple CALC clauses', () => {
    const result = run('CALC: A = [Sales] + [Profit]\nCALC: B = [Sales] - [Profit]');
    expect(result.calculatedFields).toHaveLength(2);
    expect(result.calculatedFields[0].name).toBe('A');
    expect(result.calculatedFields[1].name).toBe('B');
  });

  it('handles CALC inline within VALUES', () => {
    const result = run('VALUES: Sum(Sales), CALC Margin = [Sales] / [Cost], Sum(Profit)');
    expect(result.values).toHaveLength(2); // Sales and Profit
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.valueColumnOrder).toHaveLength(3);
    // Order: value0, calc0, value1
    expect(result.valueColumnOrder[0]).toEqual({ type: 'value', index: 0 });
    expect(result.valueColumnOrder[1]).toEqual({ type: 'calculated', index: 0 });
    expect(result.valueColumnOrder[2]).toEqual({ type: 'value', index: 1 });
  });
});

// ============================================================================
// FILTERS - edge cases
// ============================================================================

describe('FILTER edge cases', () => {
  it('handles filter with single value', () => {
    const result = run('FILTERS: Region NOT IN ("East")');
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].hiddenItems).toEqual(['East']);
  });

  it('handles filter with many values', () => {
    const values = Array.from({ length: 50 }, (_, i) => `"Value${i}"`).join(', ');
    const result = run(`FILTERS: Region NOT IN (${values})`);
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].hiddenItems).toHaveLength(50);
  });

  it('handles filter field without explicit values', () => {
    const result = run('FILTERS: Category');
    expect(result.filters).toHaveLength(1);
    // No hiddenItems since no values specified
  });

  it('handles multiple filters', () => {
    const result = run('FILTERS: Region NOT IN ("South"), Category NOT IN ("Other")');
    expect(result.filters).toHaveLength(2);
  });

  it('inclusion filter without unique values leaves hiddenItems undefined', () => {
    // No filterUniqueValues provided, so inclusion filter can't be inverted
    const result = run('FILTERS: Region = ("East")');
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].hiddenItems).toBeUndefined();
  });

  it('inclusion filter WITH unique values inverts correctly', () => {
    const uniqueValues = new Map([['Region', ['East', 'West', 'North', 'South']]]);
    const result = run('FILTERS: Region = ("East", "West")', { sourceFields: FIELDS, filterUniqueValues: uniqueValues });
    expect(result.filters[0].hiddenItems).toEqual(expect.arrayContaining(['North', 'South']));
    expect(result.filters[0].hiddenItems).toHaveLength(2);
  });
});

// ============================================================================
// LAYOUT - conflicting directives
// ============================================================================

describe('LAYOUT conflicting directives', () => {
  it('last layout type wins', () => {
    const result = run('LAYOUT: compact, tabular');
    expect(result.layout.reportLayout).toBe('tabular');
  });

  it('no-grand-totals then grand-totals: last wins', () => {
    const result = run('LAYOUT: no-grand-totals, grand-totals');
    expect(result.layout.showRowGrandTotals).toBe(true);
    expect(result.layout.showColumnGrandTotals).toBe(true);
  });

  it('repeat-labels and no-repeat-labels: last wins', () => {
    const result = run('LAYOUT: repeat-labels, no-repeat-labels');
    expect(result.layout.repeatRowLabels).toBe(false);
  });

  it('selective total override: no-row-totals with column-totals', () => {
    const result = run('LAYOUT: no-row-totals, column-totals');
    expect(result.layout.showRowGrandTotals).toBe(false);
    expect(result.layout.showColumnGrandTotals).toBe(true);
  });
});

// ============================================================================
// SORT clause
// ============================================================================

describe('SORT clause', () => {
  it('parses SORT with ASC', () => {
    const { tokens } = lex('SORT: Region ASC');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.sort).toHaveLength(1);
    expect(ast.sort[0].fieldName).toBe('Region');
    expect(ast.sort[0].direction).toBe('asc');
  });

  it('parses SORT with DESC', () => {
    const { tokens } = lex('SORT: Region DESC');
    const { ast } = parse(tokens);
    expect(ast.sort[0].direction).toBe('desc');
  });
});

// ============================================================================
// TOP N clause
// ============================================================================

describe('TOP N clause', () => {
  it('parses TOP N BY field', () => {
    const { tokens } = lex('TOP 10 BY Sales');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.topN).toBeDefined();
    expect(ast.topN!.count).toBe(10);
    expect(ast.topN!.top).toBe(true);
    expect(ast.topN!.byField).toBe('Sales');
  });

  it('parses BOTTOM N BY field', () => {
    const { tokens } = lex('BOTTOM 5 BY Profit');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.topN).toBeDefined();
    expect(ast.topN!.count).toBe(5);
    expect(ast.topN!.top).toBe(false);
  });
});

// ============================================================================
// SAVE AS clause edge cases
// ============================================================================

describe('SAVE AS edge cases', () => {
  it('preserves spaces in save-as name', () => {
    const result = run('ROWS: Region\nSAVE AS "My Custom Layout Name"');
    expect(result.saveAs).toBe('My Custom Layout Name');
  });

  it('handles SAVE AS with special characters in name', () => {
    const result = run('ROWS: Region\nSAVE AS "Q1 2024 - Sales Report"');
    expect(result.saveAs).toBe('Q1 2024 - Sales Report');
  });
});

// ============================================================================
// Very long DSL definitions
// ============================================================================

describe('Stress tests', () => {
  it('handles many fields in ROWS', () => {
    const fields = Array.from({ length: 20 }, (_, i) => sf(i, `Field${i}`));
    const fieldNames = fields.map(f => f.name).join(', ');
    const result = run(`ROWS: ${fieldNames}`, ctx(fields));
    expect(result.rows).toHaveLength(20);
  });

  it('handles many VALUES', () => {
    const fields = Array.from({ length: 15 }, (_, i) => sf(i, `Metric${i}`, true));
    const valExprs = fields.map(f => `Sum(${f.name})`).join(', ');
    const result = run(`VALUES: ${valExprs}`, ctx(fields));
    expect(result.values).toHaveLength(15);
  });

  it('handles a complex multi-clause DSL', () => {
    const dsl = `
ROWS:    Region, Product, Category
COLUMNS: Quarter, Date
VALUES:  Sum(Sales) AS "Total Sales" [% of Row], Average(Profit), Count(Region)
FILTERS: Category NOT IN ("Other", "Unknown")
CALC:    Margin = [Sales] - [Profit]
LAYOUT:  tabular, repeat-labels, no-row-totals, auto-fit
SAVE AS "Complex Report"
    `.trim();
    const result = run(dsl);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.rows).toHaveLength(3);
    expect(result.columns).toHaveLength(2);
    expect(result.values).toHaveLength(3);
    expect(result.values[0].customName).toBe('Total Sales');
    expect(result.values[0].showValuesAs).toBe('percent_of_row');
    expect(result.filters).toHaveLength(1);
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.layout.reportLayout).toBe('tabular');
    expect(result.layout.repeatRowLabels).toBe(true);
    expect(result.layout.showRowGrandTotals).toBe(false);
    expect(result.layout.autoFitColumnWidths).toBe(true);
    expect(result.saveAs).toBe('Complex Report');
  });
});
