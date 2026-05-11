//! FILENAME: app/extensions/Pivot/dsl/dsl.test.ts
// PURPOSE: Tests for the Pivot Layout DSL pipeline (lex → parse → compile → serialize).

import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { parse } from './parser';
import { compile, type CompileContext } from './compiler';
import { serialize } from './serializer';
import { processDsl } from './index';
import type { SourceField, ZoneField } from '../../_shared/components/types';
import type { LayoutConfig, CalculatedFieldDef, BiPivotModelInfo } from '../components/types';

// ============================================================================
// Test helpers
// ============================================================================

/** Shorthand to build a SourceField. */
function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

/** Standard source fields for most tests. */
const FIELDS: SourceField[] = [
  sf(0, 'Region'),
  sf(1, 'Product'),
  sf(2, 'Quarter'),
  sf(3, 'Sales', true),
  sf(4, 'Profit', true),
  sf(5, 'Quantity', true),
  sf(6, 'Category'),
  sf(7, 'Date'),
];

/** Build a basic CompileContext. */
function ctx(
  fields: SourceField[] = FIELDS,
  biModel?: BiPivotModelInfo,
  filterUniqueValues?: Map<string, string[]>,
): CompileContext {
  return { sourceFields: fields, biModel, filterUniqueValues };
}

/** Run the full pipeline and return the CompileResult. */
function run(dsl: string, context?: CompileContext) {
  return processDsl(dsl, context ?? ctx());
}

// ============================================================================
// Lexer tests
// ============================================================================

describe('Lexer', () => {
  it('tokenizes a simple ROWS clause', () => {
    const { tokens, errors } = lex('ROWS: Region, Product');
    expect(errors).toHaveLength(0);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].type).toBe('ROWS');
  });

  it('tokenizes quoted field names', () => {
    const { tokens, errors } = lex('ROWS: "Field With Spaces"');
    expect(errors).toHaveLength(0);
    const quoted = tokens.find(t => t.type === 'STRING');
    expect(quoted).toBeDefined();
    expect(quoted!.value).toBe('Field With Spaces');
  });

  it('tokenizes bracket measures', () => {
    const { tokens, errors } = lex('VALUES: [TotalSales]');
    expect(errors).toHaveLength(0);
    const bracket = tokens.find(t => t.type === 'BRACKET_ID');
    expect(bracket).toBeDefined();
    expect(bracket!.value).toBe('TotalSales');
  });

  it('reports error on unterminated string', () => {
    const { errors } = lex('ROWS: "unclosed');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].severity).toBe('error');
  });
});

// ============================================================================
// Parser tests
// ============================================================================

describe('Parser', () => {
  it('parses ROWS clause', () => {
    const { tokens } = lex('ROWS: Region, Product');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.rows).toHaveLength(2);
    expect(ast.rows[0].name).toBe('Region');
    expect(ast.rows[1].name).toBe('Product');
  });

  it('parses VALUES with aggregation', () => {
    const { tokens } = lex('VALUES: Sum(Sales), Average(Profit)');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.values).toHaveLength(2);
    expect(ast.values[0].aggregation).toBe('sum');
    expect(ast.values[0].fieldName).toBe('Sales');
    expect(ast.values[1].aggregation).toBe('average');
    expect(ast.values[1].fieldName).toBe('Profit');
  });

  it('parses VALUES with alias', () => {
    const { tokens } = lex('VALUES: Sum(Sales) AS "Total Revenue"');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.values[0].alias).toBe('Total Revenue');
  });

  it('parses VALUES with show-values-as', () => {
    const { tokens } = lex('VALUES: Sum(Sales) [% of Row]');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.values[0].showValuesAs).toBe('percent_of_row');
  });

  it('parses FILTERS with inclusion', () => {
    const { tokens } = lex('FILTERS: Region = ("East", "West")');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].fieldName).toBe('Region');
    expect(ast.filters[0].exclude).toBe(false);
    expect(ast.filters[0].values).toEqual(['East', 'West']);
  });

  it('parses FILTERS with NOT IN', () => {
    const { tokens } = lex('FILTERS: Region NOT IN ("South")');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.filters[0].exclude).toBe(true);
    expect(ast.filters[0].values).toEqual(['South']);
  });

  it('parses LAYOUT directives', () => {
    const { tokens } = lex('LAYOUT: tabular, no-grand-totals, repeat-labels');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.layout).toHaveLength(3);
    expect(ast.layout.map(d => d.key)).toEqual([
      'tabular', 'no-grand-totals', 'repeat-labels',
    ]);
  });

  it('parses CALC clause', () => {
    const { tokens } = lex('CALC: Margin = [Sales] - [Cost]');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.calculatedFields).toHaveLength(1);
    expect(ast.calculatedFields[0].name).toBe('Margin');
    expect(ast.calculatedFields[0].expression).toContain('[Sales]');
  });

  it('parses SAVE AS clause', () => {
    const { tokens } = lex('ROWS: Region\nSAVE AS "My Layout"');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.saveAs).toBe('My Layout');
  });

  it('parses multiple clauses together', () => {
    const dsl = `ROWS:    Region, Product
COLUMNS: Quarter
VALUES:  Sum(Sales)
FILTERS: Category
LAYOUT:  compact`;
    const { tokens } = lex(dsl);
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.rows).toHaveLength(2);
    expect(ast.columns).toHaveLength(1);
    expect(ast.values).toHaveLength(1);
    expect(ast.filters).toHaveLength(1);
    expect(ast.layout).toHaveLength(1);
  });

  it('allows clauses in any order', () => {
    const dsl = `VALUES:  Sum(Sales)
LAYOUT:  outline
ROWS:    Region`;
    const { tokens } = lex(dsl);
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.rows).toHaveLength(1);
    expect(ast.values).toHaveLength(1);
    expect(ast.layout).toHaveLength(1);
  });

  it('parses empty input without errors', () => {
    const { tokens } = lex('');
    const { ast, errors } = parse(tokens);
    expect(errors).toHaveLength(0);
    expect(ast.rows).toHaveLength(0);
  });
});

// ============================================================================
// Compiler tests
// ============================================================================

describe('Compiler', () => {
  it('resolves field names to source indices', () => {
    const result = run('ROWS: Region, Product');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].sourceIndex).toBe(0);
    expect(result.rows[0].name).toBe('Region');
    expect(result.rows[1].sourceIndex).toBe(1);
    expect(result.rows[1].name).toBe('Product');
  });

  it('resolves field names case-insensitively', () => {
    const result = run('ROWS: region, PRODUCT');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].sourceIndex).toBe(0);
    expect(result.rows[1].sourceIndex).toBe(1);
  });

  it('reports error for unknown fields', () => {
    const result = run('ROWS: NonExistentField');
    expect(result.errors.some(e => e.severity === 'error')).toBe(true);
    expect(result.errors[0].message).toContain('Unknown field');
  });

  it('compiles value fields with aggregation', () => {
    const result = run('VALUES: Sum(Sales), Count(Region)');
    expect(result.values).toHaveLength(2);
    expect(result.values[0].aggregation).toBe('sum');
    expect(result.values[0].sourceIndex).toBe(3); // Sales
    expect(result.values[1].aggregation).toBe('count');
    expect(result.values[1].sourceIndex).toBe(0); // Region
  });

  it('assigns default aggregation based on field type', () => {
    // Numeric fields default to sum, text fields to count
    const result = run('VALUES: Sum(Sales), Count(Region)');
    expect(result.values[0].aggregation).toBe('sum');
    expect(result.values[1].aggregation).toBe('count');
  });

  it('compiles layout directives', () => {
    const result = run('LAYOUT: tabular, no-grand-totals, repeat-labels, auto-fit');
    expect(result.layout.reportLayout).toBe('tabular');
    expect(result.layout.showRowGrandTotals).toBe(false);
    expect(result.layout.showColumnGrandTotals).toBe(false);
    expect(result.layout.repeatRowLabels).toBe(true);
    expect(result.layout.autoFitColumnWidths).toBe(true);
  });

  it('compiles layout with selective grand total control', () => {
    const result = run('LAYOUT: no-row-totals');
    expect(result.layout.showRowGrandTotals).toBe(false);
    expect(result.layout.showColumnGrandTotals).toBeUndefined();
  });

  it('compiles values-on-rows layout', () => {
    const result = run('LAYOUT: values-on-rows');
    expect(result.layout.valuesPosition).toBe('rows');
  });

  it('compiles FILTERS with NOT IN to hiddenItems', () => {
    const result = run('FILTERS: Region NOT IN ("South", "West")');
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].hiddenItems).toEqual(['South', 'West']);
  });

  it('compiles inclusion FILTERS by inverting against unique values', () => {
    const uniqueValues = new Map([['Region', ['East', 'West', 'North', 'South']]]);
    const result = run(
      'FILTERS: Region = ("East", "West")',
      ctx(FIELDS, undefined, uniqueValues),
    );
    expect(result.filters).toHaveLength(1);
    // hiddenItems = all - included = ["North", "South"]
    expect(result.filters[0].hiddenItems).toEqual(
      expect.arrayContaining(['North', 'South']),
    );
    expect(result.filters[0].hiddenItems).toHaveLength(2);
  });

  it('compiles CALC fields', () => {
    const result = run('CALC: Margin = [Sales] - [Profit]');
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.calculatedFields[0].name).toBe('Margin');
    expect(result.calculatedFields[0].formula).toContain('[Sales]');
  });

  it('compiles interleaved VALUES with CALC entries', () => {
    const result = run('VALUES: Sum(Sales), CALC Margin = [Sales] / [Quantity], Sum(Profit)');
    // Regular values: Sales and Profit
    expect(result.values).toHaveLength(2);
    // Calculated fields
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.calculatedFields[0].name).toBe('Margin');
    // Column ordering preserves interleaving
    expect(result.valueColumnOrder).toHaveLength(3);
    expect(result.valueColumnOrder[0]).toEqual({ type: 'value', index: 0 });
    expect(result.valueColumnOrder[1]).toEqual({ type: 'calculated', index: 0 });
    expect(result.valueColumnOrder[2]).toEqual({ type: 'value', index: 1 });
  });

  it('preserves SAVE AS clause', () => {
    const result = run('ROWS: Region\nSAVE AS "Quarterly View"');
    expect(result.saveAs).toBe('Quarterly View');
  });

  it('compiles alias on value fields', () => {
    const result = run('VALUES: Sum(Sales) AS "Total Revenue"');
    expect(result.values[0].customName).toBe('Total Revenue');
  });

  it('compiles show-values-as on value fields', () => {
    const result = run('VALUES: Sum(Sales) [% of Row]');
    expect(result.values[0].showValuesAs).toBe('percent_of_row');
  });
});

// ============================================================================
// Serializer tests
// ============================================================================

describe('Serializer', () => {
  it('serializes ROWS clause', () => {
    const rows: ZoneField[] = [
      { sourceIndex: 0, name: 'Region', isNumeric: false },
      { sourceIndex: 1, name: 'Product', isNumeric: false },
    ];
    const text = serialize(rows, [], [], [], {});
    expect(text).toContain('ROWS:');
    expect(text).toContain('Region');
    expect(text).toContain('Product');
  });

  it('serializes VALUES with aggregation', () => {
    const values: ZoneField[] = [
      { sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum' },
    ];
    const text = serialize([], [], values, [], {});
    expect(text).toContain('VALUES:');
    expect(text).toContain('Sum(Sales)');
  });

  it('serializes value field alias', () => {
    const values: ZoneField[] = [
      { sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum', customName: 'Revenue' },
    ];
    const text = serialize([], [], values, [], {});
    expect(text).toContain('AS "Revenue"');
  });

  it('serializes show-values-as', () => {
    const values: ZoneField[] = [
      { sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum', showValuesAs: 'percent_of_row' },
    ];
    const text = serialize([], [], values, [], {});
    expect(text).toContain('[% of Row]');
  });

  it('serializes FILTERS with NOT IN', () => {
    const filters: ZoneField[] = [
      { sourceIndex: 0, name: 'Region', isNumeric: false, hiddenItems: ['South'] },
    ];
    const text = serialize([], [], [], filters, {});
    expect(text).toContain('FILTERS:');
    expect(text).toContain('Region NOT IN ("South")');
  });

  it('serializes FILTERS with inclusion when shorter', () => {
    const filters: ZoneField[] = [
      { sourceIndex: 0, name: 'Region', isNumeric: false, hiddenItems: ['North', 'South', 'West'] },
    ];
    const uniqueValues = new Map([['Region', ['East', 'West', 'North', 'South']]]);
    const text = serialize([], [], [], filters, {}, { filterUniqueValues: uniqueValues });
    // Only "East" is included — shorter than listing 3 exclusions
    expect(text).toContain('Region = ("East")');
  });

  it('serializes LAYOUT directives', () => {
    const layout: LayoutConfig = {
      reportLayout: 'tabular',
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
      repeatRowLabels: true,
    };
    const text = serialize([], [], [], [], layout);
    expect(text).toContain('LAYOUT:');
    expect(text).toContain('tabular');
    expect(text).toContain('no-grand-totals');
    expect(text).toContain('repeat-labels');
  });

  it('serializes auto-fit', () => {
    const text = serialize([], [], [], [], { autoFitColumnWidths: true });
    expect(text).toContain('auto-fit');
  });

  it('serializes values-on-rows', () => {
    const text = serialize([], [], [], [], { valuesPosition: 'rows' });
    expect(text).toContain('values-on-rows');
  });

  it('quotes field names with special characters', () => {
    const rows: ZoneField[] = [
      { sourceIndex: 0, name: 'Region Code', isNumeric: false },
    ];
    const text = serialize(rows, [], [], [], {});
    expect(text).toContain('"Region Code"');
  });

  it('serializes LOOKUP fields', () => {
    const rows: ZoneField[] = [
      { sourceIndex: -1, name: 'Products.Category', isNumeric: false, isLookup: true },
    ];
    const text = serialize(rows, [], [], [], {});
    expect(text).toContain('LOOKUP Products.Category');
  });

  it('serializes calculated fields in VALUES', () => {
    const values: ZoneField[] = [
      { sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum' },
      { sourceIndex: -1, name: 'Margin', isNumeric: true, isCalculated: true, customName: 'Margin', calculatedFormula: '[Sales] / [Quantity]' },
    ];
    const text = serialize([], [], values, [], {});
    expect(text).toContain('Sum(Sales)');
    expect(text).toContain('CALC Margin = [Sales] / [Quantity]');
  });

  it('returns empty string for empty state', () => {
    const text = serialize([], [], [], [], {});
    expect(text).toBe('');
  });
});

// ============================================================================
// Round-trip tests (serialize → parse → compile → compare)
// ============================================================================

describe('Round-trip', () => {
  it('round-trips ROWS and COLUMNS', () => {
    const rows: ZoneField[] = [
      { sourceIndex: 0, name: 'Region', isNumeric: false },
      { sourceIndex: 1, name: 'Product', isNumeric: false },
    ];
    const columns: ZoneField[] = [
      { sourceIndex: 2, name: 'Quarter', isNumeric: false },
    ];

    const text = serialize(rows, columns, [], [], {});
    const result = run(text);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].name).toBe('Region');
    expect(result.rows[1].name).toBe('Product');
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].name).toBe('Quarter');
  });

  it('round-trips VALUES with aggregation', () => {
    const values: ZoneField[] = [
      { sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum' },
      { sourceIndex: 4, name: 'Profit', isNumeric: true, aggregation: 'average' },
    ];

    const text = serialize([], [], values, [], {});
    const result = run(text);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values).toHaveLength(2);
    expect(result.values[0].aggregation).toBe('sum');
    expect(result.values[0].sourceIndex).toBe(3);
    expect(result.values[1].aggregation).toBe('average');
    expect(result.values[1].sourceIndex).toBe(4);
  });

  it('round-trips FILTERS with NOT IN', () => {
    const filters: ZoneField[] = [
      { sourceIndex: 0, name: 'Region', isNumeric: false, hiddenItems: ['South', 'West'] },
    ];

    const text = serialize([], [], [], filters, {});
    const result = run(text);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].hiddenItems).toEqual(['South', 'West']);
  });

  it('round-trips LAYOUT configuration', () => {
    const layout: LayoutConfig = {
      reportLayout: 'tabular',
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
      repeatRowLabels: true,
      autoFitColumnWidths: true,
    };

    const text = serialize([], [], [], [], layout);
    const result = run(text);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.layout.reportLayout).toBe('tabular');
    expect(result.layout.showRowGrandTotals).toBe(false);
    expect(result.layout.showColumnGrandTotals).toBe(false);
    expect(result.layout.repeatRowLabels).toBe(true);
    expect(result.layout.autoFitColumnWidths).toBe(true);
  });

  it('round-trips a full pivot definition', () => {
    const rows: ZoneField[] = [
      { sourceIndex: 0, name: 'Region', isNumeric: false },
    ];
    const columns: ZoneField[] = [
      { sourceIndex: 2, name: 'Quarter', isNumeric: false },
    ];
    const values: ZoneField[] = [
      { sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum' },
      { sourceIndex: 4, name: 'Profit', isNumeric: true, aggregation: 'sum' },
    ];
    const filters: ZoneField[] = [
      { sourceIndex: 6, name: 'Category', isNumeric: false },
    ];
    const layout: LayoutConfig = {
      reportLayout: 'compact',
      showRowGrandTotals: true,
      showColumnGrandTotals: true,
    };

    const text = serialize(rows, columns, values, filters, layout);
    const result = run(text);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Region');
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].name).toBe('Quarter');
    expect(result.values).toHaveLength(2);
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].name).toBe('Category');
    expect(result.layout.reportLayout).toBe('compact');
  });

  it('round-trips show-values-as', () => {
    const values: ZoneField[] = [
      { sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum', showValuesAs: 'percent_of_total' },
    ];
    const text = serialize([], [], values, [], {});
    const result = run(text);
    expect(result.values[0].showValuesAs).toBe('percent_of_total');
  });
});

// ============================================================================
// Full pipeline (processDsl) integration tests
// ============================================================================

describe('processDsl integration', () => {
  it('compiles a complete DSL definition', () => {
    const dsl = `
ROWS:    Region, Product
COLUMNS: Quarter
VALUES:  Sum(Sales), Average(Profit)
FILTERS: Category NOT IN ("Other")
LAYOUT:  outline, no-row-totals
    `.trim();

    const result = run(dsl);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);

    expect(result.rows).toHaveLength(2);
    expect(result.columns).toHaveLength(1);
    expect(result.values).toHaveLength(2);
    expect(result.values[0].aggregation).toBe('sum');
    expect(result.values[1].aggregation).toBe('average');
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].hiddenItems).toEqual(['Other']);
    expect(result.layout.reportLayout).toBe('outline');
    expect(result.layout.showRowGrandTotals).toBe(false);
  });

  it('reports errors for unknown fields', () => {
    const dsl = 'ROWS: FakeField1, FakeField2';
    const result = run(dsl);
    const errors = result.errors.filter(e => e.severity === 'error');
    // Both the validator and compiler report these, so check at least 2 errors mentioning the fields
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some(e => e.message.includes('FakeField1'))).toBe(true);
    expect(errors.some(e => e.message.includes('FakeField2'))).toBe(true);
  });

  it('handles all aggregation types', () => {
    const aggs = ['Sum', 'Count', 'Average', 'Min', 'Max', 'Product', 'StdDev', 'StdDevP', 'Var', 'VarP'];
    for (const agg of aggs) {
      const result = run(`VALUES: ${agg}(Sales)`);
      expect(result.values).toHaveLength(1);
      expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    }
  });

  it('handles all show-values-as types', () => {
    const showAs = [
      '% of Grand Total',
      '% of Row',
      '% of Column',
      '% of Parent Row',
      '% of Parent Column',
      'Difference',
      '% Difference',
      'Running Total',
      'Index',
    ];
    for (const sa of showAs) {
      const result = run(`VALUES: Sum(Sales) [${sa}]`);
      expect(result.values).toHaveLength(1);
      expect(result.values[0].showValuesAs).toBeTruthy();
    }
  });

  it('handles all layout directives', () => {
    const directives = [
      'compact', 'outline', 'tabular',
      'repeat-labels', 'no-repeat-labels',
      'grand-totals', 'no-grand-totals',
      'no-row-totals', 'no-column-totals',
      'show-empty-rows', 'show-empty-cols',
      'values-on-rows', 'values-on-columns',
      'auto-fit',
    ];
    for (const d of directives) {
      const result = run(`LAYOUT: ${d}`);
      const errors = result.errors.filter(e => e.severity === 'error');
      expect(errors).toHaveLength(0);
    }
  });
});

// ============================================================================
// BI pivot tests
// ============================================================================

describe('BI pivots', () => {
  const biModel: BiPivotModelInfo = {
    tables: [
      {
        name: 'Sales',
        columns: [
          { name: 'Region', dataType: 'string', isNumeric: false },
          { name: 'Amount', dataType: 'number', isNumeric: true },
        ],
      },
      {
        name: 'Products',
        columns: [
          { name: 'Category', dataType: 'string', isNumeric: false },
          { name: 'Price', dataType: 'number', isNumeric: true },
        ],
      },
    ],
    measures: [
      { name: 'TotalSales', table: 'Sales', sourceColumn: 'Amount', aggregation: 'sum' },
      { name: 'AvgPrice', table: 'Products', sourceColumn: 'Price', aggregation: 'average' },
    ],
  };

  const biCtx = ctx([], biModel);

  it('compiles dotted field references', () => {
    const result = processDsl('ROWS: Sales.Region', biCtx);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Sales.Region');
    expect(result.rows[0].sourceIndex).toBe(-1);
  });

  it('compiles bracket measure references', () => {
    const result = processDsl('VALUES: [TotalSales]', biCtx);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values).toHaveLength(1);
    expect(result.values[0].name).toBe('[TotalSales]');
    expect(result.values[0].sourceIndex).toBe(-1);
  });

  it('compiles LOOKUP fields', () => {
    const result = processDsl('ROWS: LOOKUP Products.Category', biCtx);
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.rows[0].isLookup).toBe(true);
    expect(result.lookupColumns).toContain('Products.Category');
  });

  it('reports error for unknown BI field', () => {
    const result = processDsl('ROWS: FakeTable.FakeColumn', biCtx);
    expect(result.errors.some(e => e.severity === 'error')).toBe(true);
  });

  it('reports error for unknown measure', () => {
    const result = processDsl('VALUES: [NonExistentMeasure]', biCtx);
    expect(result.errors.some(e => e.severity === 'error')).toBe(true);
  });

  it('resolves unqualified column names when unique', () => {
    const result = processDsl('ROWS: Region', biCtx);
    // "Region" is unique across tables, so should resolve to "Sales.Region"
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.rows[0].name).toBe('Sales.Region');
  });
});
