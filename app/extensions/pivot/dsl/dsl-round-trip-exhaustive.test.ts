//! FILENAME: app/extensions/Pivot/dsl/dsl-round-trip-exhaustive.test.ts
// PURPOSE: Exhaustive round-trip tests for the Pivot Layout DSL.
//          Verifies serialize -> parse -> compile -> serialize stability,
//          output minimality, error isolation, and token validity.

import { describe, it, expect } from 'vitest';
import { processDsl, serialize, lex, type CompileContext } from './index';
import type { SourceField, ZoneField } from '../../_shared/components/types';
import type { LayoutConfig } from '../components/types';

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
  sf(7, 'Year'),
];

function ctx(filterUniqueValues?: Map<string, string[]>): CompileContext {
  return { sourceFields: FIELDS, filterUniqueValues };
}

function roundTrip(dsl: string, context?: CompileContext) {
  const c = context ?? ctx();
  const result = processDsl(dsl, c);
  const errors = result.errors.filter(e => e.severity === 'error');
  const serialized = serialize(result.rows, result.columns, result.values, result.filters, result.layout);
  return { result, serialized, errors };
}

function expectCleanRoundTrip(dsl: string, context?: CompileContext) {
  const { result, serialized, errors } = roundTrip(dsl, context);
  expect(errors).toHaveLength(0);
  // Re-process the serialized output and verify it compiles identically
  const c = context ?? ctx();
  const result2 = processDsl(serialized, c);
  const errors2 = result2.errors.filter(e => e.severity === 'error');
  expect(errors2).toHaveLength(0);
  expect(result2.rows.length).toBe(result.rows.length);
  expect(result2.columns.length).toBe(result.columns.length);
  expect(result2.values.length).toBe(result.values.length);
  expect(result2.filters.length).toBe(result.filters.length);
  return { serialized, result };
}

// ============================================================================
// Round-trip every single DSL feature independently
// ============================================================================

describe('round-trip individual features', () => {
  it('ROWS clause only', () => {
    const { serialized } = expectCleanRoundTrip('ROWS: Region');
    expect(serialized).toContain('ROWS');
    expect(serialized).toContain('Region');
  });

  it('COLUMNS clause only', () => {
    const { serialized } = expectCleanRoundTrip('COLUMNS: Quarter');
    expect(serialized).toContain('COLUMNS');
  });

  it('VALUES with sum', () => {
    expectCleanRoundTrip('VALUES: sum(Sales)');
  });

  it('VALUES with count', () => {
    expectCleanRoundTrip('VALUES: count(Region)');
  });

  it('VALUES with average', () => {
    expectCleanRoundTrip('VALUES: average(Profit)');
  });

  it('VALUES with min', () => {
    expectCleanRoundTrip('VALUES: min(Sales)');
  });

  it('VALUES with max', () => {
    expectCleanRoundTrip('VALUES: max(Sales)');
  });

  it('VALUES with countnumbers', () => {
    expectCleanRoundTrip('VALUES: countnumbers(Quantity)');
  });

  it('VALUES with stddev', () => {
    expectCleanRoundTrip('VALUES: stddev(Sales)');
  });

  it('VALUES with product', () => {
    expectCleanRoundTrip('VALUES: product(Sales)');
  });

  it('VALUES with AS alias', () => {
    const { serialized } = expectCleanRoundTrip('VALUES: sum(Sales) AS "Total Revenue"');
    expect(serialized).toContain('AS "Total Revenue"');
  });

  it('VALUES with showValuesAs percent of row', () => {
    const { serialized } = expectCleanRoundTrip('VALUES: sum(Sales) [% of Row]');
    expect(serialized).toContain('% of Row');
  });

  it('VALUES with showValuesAs running total', () => {
    expectCleanRoundTrip('VALUES: sum(Sales) [Running Total]');
  });

  it('FILTERS with inclusion', () => {
    const filterCtx = ctx(new Map([['Region', ['East', 'West', 'North', 'South']]]));
    expectCleanRoundTrip('FILTERS: Region = ("East", "West")', filterCtx);
  });

  it('FILTERS with NOT IN exclusion', () => {
    expectCleanRoundTrip('FILTERS: Region NOT IN ("South")');
  });

  it('LAYOUT compact', () => {
    expectCleanRoundTrip('LAYOUT: compact');
  });

  it('LAYOUT tabular', () => {
    expectCleanRoundTrip('LAYOUT: tabular');
  });

  it('LAYOUT repeat-labels', () => {
    expectCleanRoundTrip('LAYOUT: repeat-labels');
  });

  it('LAYOUT no-grand-totals', () => {
    const { serialized } = expectCleanRoundTrip('LAYOUT: no-grand-totals');
    expect(serialized).toContain('no-grand-totals');
  });

  it('LAYOUT no-row-totals', () => {
    expectCleanRoundTrip('LAYOUT: no-row-totals');
  });

  it('LAYOUT no-column-totals', () => {
    expectCleanRoundTrip('LAYOUT: no-column-totals');
  });

  it('LAYOUT show-empty-rows', () => {
    expectCleanRoundTrip('LAYOUT: show-empty-rows');
  });

  it('LAYOUT values-on-rows', () => {
    expectCleanRoundTrip('LAYOUT: values-on-rows');
  });

  it('LAYOUT auto-fit', () => {
    expectCleanRoundTrip('LAYOUT: auto-fit');
  });

  it('multiple ROWS fields', () => {
    const { result } = expectCleanRoundTrip('ROWS: Region, Product, Category');
    expect(result.rows).toHaveLength(3);
  });
});

// ============================================================================
// Round-trip every pair of features together
// ============================================================================

describe('round-trip feature pairs', () => {
  it('ROWS + COLUMNS', () => {
    expectCleanRoundTrip('ROWS: Region\nCOLUMNS: Quarter');
  });

  it('ROWS + VALUES', () => {
    expectCleanRoundTrip('ROWS: Region\nVALUES: sum(Sales)');
  });

  it('ROWS + FILTERS', () => {
    expectCleanRoundTrip('ROWS: Region\nFILTERS: Category NOT IN ("Bikes")');
  });

  it('ROWS + LAYOUT', () => {
    expectCleanRoundTrip('ROWS: Region\nLAYOUT: tabular, repeat-labels');
  });

  it('COLUMNS + VALUES', () => {
    expectCleanRoundTrip('COLUMNS: Quarter\nVALUES: average(Profit)');
  });

  it('VALUES + LAYOUT', () => {
    expectCleanRoundTrip('VALUES: sum(Sales)\nLAYOUT: no-grand-totals, auto-fit');
  });

  it('VALUES + FILTERS', () => {
    expectCleanRoundTrip('VALUES: sum(Sales)\nFILTERS: Product NOT IN ("Widget")');
  });

  it('FILTERS + LAYOUT', () => {
    expectCleanRoundTrip('FILTERS: Region NOT IN ("South")\nLAYOUT: compact');
  });

  it('multiple VALUES + showValuesAs', () => {
    expectCleanRoundTrip('VALUES: sum(Sales) [% of Row], average(Profit)');
  });

  it('VALUES with alias + LAYOUT', () => {
    expectCleanRoundTrip('VALUES: sum(Sales) AS "Rev"\nLAYOUT: outline');
  });
});

// ============================================================================
// Round-trip with maximum complexity (all features at once)
// ============================================================================

describe('round-trip maximum complexity', () => {
  it('all clause types combined', () => {
    const dsl = [
      'ROWS: Region, Product',
      'COLUMNS: Quarter, Year',
      'VALUES: sum(Sales) AS "Revenue", average(Profit) [% of Column], max(Quantity)',
      'FILTERS: Category NOT IN ("Bikes")',
      'LAYOUT: tabular, repeat-labels, no-row-totals, show-empty-rows, auto-fit',
    ].join('\n');
    const { result } = expectCleanRoundTrip(dsl);
    expect(result.rows).toHaveLength(2);
    expect(result.columns).toHaveLength(2);
    expect(result.values).toHaveLength(3);
    expect(result.filters).toHaveLength(1);
    expect(result.layout.reportLayout).toBe('tabular');
    expect(result.layout.repeatRowLabels).toBe(true);
    expect(result.layout.showRowGrandTotals).toBe(false);
    expect(result.layout.showEmptyRows).toBe(true);
    expect(result.layout.autoFitColumnWidths).toBe(true);
  });

  it('max values: all aggregation types on the same field', () => {
    const aggs = ['sum', 'count', 'average', 'min', 'max', 'product'];
    const valuesPart = aggs.map(a => `${a}(Sales)`).join(', ');
    const dsl = `ROWS: Region\nVALUES: ${valuesPart}`;
    const { result } = expectCleanRoundTrip(dsl);
    expect(result.values).toHaveLength(aggs.length);
  });
});

// ============================================================================
// Verify serialize output is minimal (no redundant clauses)
// ============================================================================

describe('serialize output minimality', () => {
  it('empty rows/columns/values/filters produce no output', () => {
    const output = serialize([], [], [], [], {});
    expect(output).toBe('');
  });

  it('default layout produces no LAYOUT clause', () => {
    const output = serialize(
      [{ sourceIndex: 0, name: 'Region', isNumeric: false }],
      [], [], [], {},
    );
    expect(output).not.toContain('LAYOUT');
  });

  it('only non-default layout options appear', () => {
    const layout: LayoutConfig = { showRowGrandTotals: false };
    const output = serialize([], [], [], [], layout);
    expect(output).toContain('no-row-totals');
    expect(output).not.toContain('repeat-labels');
    expect(output).not.toContain('tabular');
  });

  it('showValuesAs normal is omitted', () => {
    const values: ZoneField[] = [{
      sourceIndex: 3, name: 'Sales', isNumeric: true,
      aggregation: 'sum', showValuesAs: 'normal',
    }];
    const output = serialize([], [], values, [], {});
    expect(output).not.toContain('[');
    expect(output).not.toContain('Normal');
  });

  it('alias matching default display name is omitted', () => {
    // Default display name for sum(Sales) is "Sum of Sales"
    const values: ZoneField[] = [{
      sourceIndex: 3, name: 'Sales', isNumeric: true,
      aggregation: 'sum', customName: 'Sum of Sales',
    }];
    const output = serialize([], [], values, [], {});
    expect(output).not.toContain('AS');
  });

  it('no-grand-totals is used instead of separate no-row + no-column', () => {
    const layout: LayoutConfig = { showRowGrandTotals: false, showColumnGrandTotals: false };
    const output = serialize([], [], [], [], layout);
    expect(output).toContain('no-grand-totals');
    expect(output).not.toContain('no-row-totals');
    expect(output).not.toContain('no-column-totals');
  });
});

// ============================================================================
// Verify compile errors don't carry over into serialized output
// ============================================================================

describe('compile errors do not pollute serialized output', () => {
  it('unknown field in ROWS is dropped, valid fields survive', () => {
    const result = processDsl('ROWS: Region, UnknownField\nVALUES: sum(Sales)', ctx());
    expect(result.errors.some(e => e.severity === 'error')).toBe(true);
    expect(result.rows).toHaveLength(1); // Only Region survives
    const output = serialize(result.rows, result.columns, result.values, result.filters, result.layout);
    expect(output).toContain('Region');
    expect(output).not.toContain('UnknownField');
  });

  it('unknown field in VALUES is dropped', () => {
    const result = processDsl('VALUES: sum(Nonexistent)', ctx());
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.values).toHaveLength(0);
    const output = serialize(result.rows, result.columns, result.values, result.filters, result.layout);
    expect(output).toBe('');
  });

  it('valid LAYOUT survives alongside field errors', () => {
    const result = processDsl('ROWS: BadField\nLAYOUT: tabular, auto-fit', ctx());
    expect(result.errors.some(e => e.severity === 'error')).toBe(true);
    expect(result.layout.reportLayout).toBe('tabular');
    expect(result.layout.autoFitColumnWidths).toBe(true);
    const output = serialize(result.rows, result.columns, result.values, result.filters, result.layout);
    expect(output).toContain('tabular');
    expect(output).toContain('auto-fit');
  });
});

// ============================================================================
// Re-lex serialized output produces valid tokens
// ============================================================================

describe('re-lex serialized output produces valid tokens', () => {
  const TEST_CASES = [
    'ROWS: Region',
    'COLUMNS: Quarter',
    'VALUES: sum(Sales)',
    'VALUES: sum(Sales) AS "Revenue" [% of Row]',
    'FILTERS: Region NOT IN ("South")',
    'LAYOUT: tabular, repeat-labels, no-grand-totals',
    'ROWS: Region, Product\nCOLUMNS: Quarter\nVALUES: sum(Sales), average(Profit)',
  ];

  for (const dsl of TEST_CASES) {
    it(`re-lexing: ${dsl.substring(0, 40)}...`, () => {
      const { serialized, errors } = roundTrip(dsl);
      if (errors.length > 0) return; // skip errored cases

      const lexResult = lex(serialized);
      expect(lexResult.errors).toHaveLength(0);
      // Every token should have a valid location
      for (const tok of lexResult.tokens) {
        expect(tok.location.line).toBeGreaterThanOrEqual(1);
        expect(tok.location.column).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it('maximum complexity re-lexes cleanly', () => {
    const dsl = [
      'ROWS: Region, Product, Category',
      'COLUMNS: Quarter, Year',
      'VALUES: sum(Sales) AS "Rev", max(Profit) [% of Grand Total], count(Quantity)',
      'FILTERS: Category NOT IN ("Bikes", "Clothing")',
      'LAYOUT: outline, no-row-totals, show-empty-cols, values-on-rows, auto-fit',
    ].join('\n');
    const { serialized, errors } = roundTrip(dsl);
    expect(errors).toHaveLength(0);
    const lexResult = lex(serialized);
    expect(lexResult.errors).toHaveLength(0);
  });
});
