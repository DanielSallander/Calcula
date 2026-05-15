//! FILENAME: app/extensions/Pivot/dsl/dsl-snapshots.test.ts
// PURPOSE: Snapshot tests to catch accidental changes to DSL compilation and serialization.

import { describe, it, expect } from 'vitest';
import { processDsl, type CompileContext } from './index';
import { serialize } from './serializer';
import { TokenType, AGGREGATION_NAMES, LAYOUT_DIRECTIVES, SHOW_VALUES_AS_NAMES } from './tokens';
import type { SourceField, ZoneField } from '../../_shared/components/types';
import type { LayoutConfig } from '../components/types';

// ============================================================================
// Test helpers
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
  sf(7, 'Date'),
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
// Compiled output snapshots for representative DSL strings
// ============================================================================

describe('DSL compilation snapshots', () => {
  const cases: [string, string][] = [
    ['simple rows and values', 'ROWS: Region\nVALUES: Sum(Sales)'],
    ['multiple rows and columns', 'ROWS: Region, Product\nCOLUMNS: Quarter\nVALUES: Sum(Sales)'],
    ['multiple value aggregations', 'ROWS: Region\nVALUES: Sum(Sales), Average(Profit), Count(Product)'],
    ['layout directives', 'ROWS: Region\nVALUES: Sum(Sales)\nLAYOUT: tabular, no-grand-totals, repeat-labels'],
    ['filter with NOT IN', 'ROWS: Region\nVALUES: Sum(Sales)\nFILTERS: Region NOT IN ("East", "West")'],
    ['value alias', 'ROWS: Region\nVALUES: Sum(Sales) AS "Total Revenue"'],
    ['show values as percentage', 'ROWS: Region\nVALUES: Sum(Sales) [% of Row]'],
    ['calculated field', 'ROWS: Region\nVALUES: Sum(Sales), Sum(Profit)\nCALC: Margin = [Profit] / [Sales]'],
    ['compact layout with values on rows', 'ROWS: Region, Category\nVALUES: Sum(Sales), Sum(Profit)\nLAYOUT: compact, values-on-rows'],
    ['all clauses combined', 'ROWS: Region, Product\nCOLUMNS: Quarter\nVALUES: Sum(Sales), Max(Profit)\nFILTERS: Category NOT IN ("Office")\nLAYOUT: outline, no-row-totals, auto-fit'],
  ];

  for (const [label, dsl] of cases) {
    it(`"${label}" matches snapshot`, () => {
      const result = run(dsl);
      // Snapshot the structured output (rows, columns, values, filters, layout, errors)
      expect({
        rows: result.rows,
        columns: result.columns,
        values: result.values,
        filters: result.filters,
        layout: result.layout,
        calculatedFields: result.calculatedFields,
        valueColumnOrder: result.valueColumnOrder,
        errors: result.errors,
      }).toMatchSnapshot();
    });
  }
});

// ============================================================================
// Error message snapshots for common error patterns
// ============================================================================

describe('DSL error message snapshots', () => {
  const errorCases: [string, string][] = [
    ['unknown field', 'ROWS: NonExistent\nVALUES: Sum(Sales)'],
    ['unknown field in values', 'ROWS: Region\nVALUES: Sum(FakeField)'],
    ['unknown aggregation field', 'ROWS: Region\nVALUES: Sum(Missing)'],
    ['empty input', ''],
    ['only whitespace and comments', '# This is a comment\n# Another comment'],
  ];

  for (const [label, dsl] of errorCases) {
    it(`"${label}" errors match snapshot`, () => {
      const result = run(dsl);
      expect(result.errors).toMatchSnapshot();
      expect(result.parseErrors).toMatchSnapshot();
    });
  }
});

// ============================================================================
// Serializer output snapshots
// ============================================================================

describe('DSL serializer snapshots', () => {
  it('simple rows + values round-trip', () => {
    const output = serialize(
      [{ sourceIndex: 0, name: 'Region', isNumeric: false }],
      [],
      [{ sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum' }],
      [],
      {},
    );
    expect(output).toMatchInlineSnapshot(`"ROWS:    Region
VALUES:  Sum(Sales)"`);
  });

  it('rows + columns + values', () => {
    const output = serialize(
      [{ sourceIndex: 0, name: 'Region', isNumeric: false }],
      [{ sourceIndex: 2, name: 'Quarter', isNumeric: false }],
      [{ sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum' }],
      [],
      {},
    );
    expect(output).toMatchSnapshot();
  });

  it('multiple values with aliases', () => {
    const output = serialize(
      [{ sourceIndex: 0, name: 'Region', isNumeric: false }],
      [],
      [
        { sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum', customName: 'Total Sales' },
        { sourceIndex: 4, name: 'Profit', isNumeric: true, aggregation: 'average', customName: 'Avg Profit' },
      ],
      [],
      {},
    );
    expect(output).toMatchSnapshot();
  });

  it('filters with NOT IN', () => {
    const output = serialize(
      [{ sourceIndex: 0, name: 'Region', isNumeric: false }],
      [],
      [{ sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum' }],
      [{ sourceIndex: 6, name: 'Category', isNumeric: false, hiddenItems: ['Office', 'Furniture'] }],
      {},
    );
    expect(output).toMatchSnapshot();
  });

  it('layout directives', () => {
    const layout: LayoutConfig = {
      reportLayout: 'tabular',
      repeatRowLabels: true,
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
      autoFitColumnWidths: true,
    };
    const output = serialize(
      [{ sourceIndex: 0, name: 'Region', isNumeric: false }],
      [],
      [{ sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum' }],
      [],
      layout,
    );
    expect(output).toMatchSnapshot();
  });

  it('save as clause', () => {
    const output = serialize(
      [{ sourceIndex: 0, name: 'Region', isNumeric: false }],
      [],
      [{ sourceIndex: 3, name: 'Sales', isNumeric: true, aggregation: 'sum' }],
      [],
      {},
      { saveAs: 'My Report' },
    );
    expect(output).toMatchSnapshot();
  });
});

// ============================================================================
// Token constant snapshots
// ============================================================================

describe('DSL token constants', () => {
  it('AGGREGATION_NAMES matches snapshot', () => {
    expect([...AGGREGATION_NAMES].sort()).toMatchSnapshot();
  });

  it('LAYOUT_DIRECTIVES matches snapshot', () => {
    expect([...LAYOUT_DIRECTIVES].sort()).toMatchSnapshot();
  });

  it('SHOW_VALUES_AS_NAMES matches snapshot', () => {
    expect(Object.fromEntries(SHOW_VALUES_AS_NAMES)).toMatchSnapshot();
  });
});
