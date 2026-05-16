//! FILENAME: app/extensions/Pivot/dsl/serializer-deep.test.ts
// PURPOSE: Deep tests for DSL serializer covering edge cases and round-trips.

import { describe, it, expect } from 'vitest';
import { serialize, type SerializeOptions } from './serializer';
import { lex } from './lexer';
import { parse } from './parser';
import { SHOW_VALUES_AS_NAMES } from './tokens';
import type { ZoneField } from '../../_shared/components/types';
import type { LayoutConfig, CalculatedFieldDef } from '../components/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zf(
  name: string,
  overrides: Partial<ZoneField> = {},
): ZoneField {
  return { sourceIndex: 0, name, isNumeric: false, ...overrides };
}

function valueField(
  name: string,
  agg: ZoneField['aggregation'] = 'sum',
  overrides: Partial<ZoneField> = {},
): ZoneField {
  return zf(name, { aggregation: agg, isNumeric: true, ...overrides });
}

const emptyLayout: LayoutConfig = {};

/** Round-trip: serialize -> lex -> parse and return the AST. */
function roundTrip(
  rows: ZoneField[],
  columns: ZoneField[],
  values: ZoneField[],
  filters: ZoneField[],
  layout: LayoutConfig,
  options: SerializeOptions = {},
) {
  const text = serialize(rows, columns, values, filters, layout, options);
  const { tokens } = lex(text);
  const { ast, errors } = parse(tokens);
  return { text, ast, errors };
}

// ============================================================================
// Every clause type simultaneously
// ============================================================================

describe('serialize with all clause types at once', () => {
  it('produces output containing ROWS, COLUMNS, VALUES, FILTERS, LAYOUT, SAVE AS', () => {
    const rows = [zf('Region'), zf('Country')];
    const columns = [zf('Year')];
    const values = [valueField('Sales'), valueField('Quantity', 'count')];
    const filters = [zf('Category', { hiddenItems: ['Other'] })];
    const layout: LayoutConfig = {
      reportLayout: 'tabular',
      repeatRowLabels: true,
      showRowGrandTotals: false,
      showColumnGrandTotals: true,
      showEmptyRows: true,
      valuesPosition: 'rows',
      autoFitColumnWidths: true,
    };

    const text = serialize(rows, columns, values, filters, layout, {
      saveAs: 'My Report',
    });

    expect(text).toContain('ROWS:');
    expect(text).toContain('Region');
    expect(text).toContain('Country');
    expect(text).toContain('COLUMNS:');
    expect(text).toContain('Year');
    expect(text).toContain('VALUES:');
    expect(text).toContain('Sum(Sales)');
    expect(text).toContain('Count(Quantity)');
    expect(text).toContain('FILTERS:');
    expect(text).toContain('NOT IN');
    expect(text).toContain('LAYOUT:');
    expect(text).toContain('tabular');
    expect(text).toContain('repeat-labels');
    expect(text).toContain('no-row-totals');
    expect(text).toContain('show-empty-rows');
    expect(text).toContain('values-on-rows');
    expect(text).toContain('auto-fit');
    expect(text).toContain('SAVE AS "My Report"');
  });

  it('round-trips all clause types through lex/parse', () => {
    const rows = [zf('Region')];
    const columns = [zf('Year')];
    const values = [valueField('Sales')];
    const filters = [zf('Status', { hiddenItems: ['Inactive'] })];
    const layout: LayoutConfig = { reportLayout: 'compact' };

    const { ast, errors } = roundTrip(rows, columns, values, filters, layout, {
      saveAs: 'TestLayout',
    });

    expect(errors).toHaveLength(0);
    expect(ast.rows).toHaveLength(1);
    expect(ast.columns).toHaveLength(1);
    expect(ast.values).toHaveLength(1);
    expect(ast.filters).toHaveLength(1);
    expect(ast.saveAs).toBe('TestLayout');
  });
});

// ============================================================================
// Calculated fields with complex expressions
// ============================================================================

describe('serialize calculated fields', () => {
  it('serializes inline CALC in values zone', () => {
    const values = [
      valueField('Sales'),
      zf('Margin', {
        isCalculated: true,
        calculatedFormula: '[Sales] - [Cost]',
        customName: 'Margin',
      }),
    ];

    const text = serialize([], [], values, [], emptyLayout);
    expect(text).toContain('CALC Margin = [Sales] - [Cost]');
    expect(text).toContain('Sum(Sales)');
  });

  it('serializes complex nested expressions', () => {
    const values = [
      zf('Pct', {
        isCalculated: true,
        calculatedFormula: '([Revenue] - [Cost]) / [Revenue] * 100',
        customName: 'Pct',
      }),
    ];

    const text = serialize([], [], values, [], emptyLayout);
    expect(text).toContain('CALC Pct = ([Revenue] - [Cost]) / [Revenue] * 100');
  });

  it('round-trips calculated fields', () => {
    const values = [
      valueField('Revenue'),
      zf('Ratio', {
        isCalculated: true,
        calculatedFormula: '[Revenue] / [Cost]',
        customName: 'Ratio',
      }),
    ];

    const { ast, errors } = roundTrip([], [], values, [], emptyLayout);
    expect(errors).toHaveLength(0);
    expect(ast.values).toHaveLength(2);
    // The calc field should appear in calculatedFields
    expect(ast.calculatedFields.length).toBeGreaterThanOrEqual(1);
    expect(ast.calculatedFields[0].name).toBe('Ratio');
    expect(ast.calculatedFields[0].expression).toContain('[Revenue] / [Cost]');
  });

  it('preserves order of mixed values and calcs', () => {
    const values = [
      valueField('A'),
      zf('X', { isCalculated: true, calculatedFormula: '[A]*2', customName: 'X' }),
      valueField('B'),
      zf('Y', { isCalculated: true, calculatedFormula: '[B]+1', customName: 'Y' }),
    ];

    const text = serialize([], [], values, [], emptyLayout);
    const aIdx = text.indexOf('Sum(A)');
    const xIdx = text.indexOf('CALC X');
    const bIdx = text.indexOf('Sum(B)');
    const yIdx = text.indexOf('CALC Y');
    expect(aIdx).toBeLessThan(xIdx);
    expect(xIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(yIdx);
  });
});

// ============================================================================
// Filters: NOT IN, large value lists, inclusion shortening
// ============================================================================

describe('serialize filters', () => {
  it('uses NOT IN for exclusion filters', () => {
    const filters = [zf('Category', { hiddenItems: ['A', 'B'] })];
    const text = serialize([], [], [], filters, emptyLayout);
    expect(text).toContain('Category NOT IN ("A", "B")');
  });

  it('uses inclusion (=) when shorter than NOT IN given unique values', () => {
    // 5 unique values, hiding 4 -> inclusion of 1 value is shorter
    const filters = [zf('Status', { hiddenItems: ['B', 'C', 'D', 'E'] })];
    const options: SerializeOptions = {
      filterUniqueValues: new Map([['Status', ['A', 'B', 'C', 'D', 'E']]]),
    };
    const text = serialize([], [], [], filters, emptyLayout, options);
    expect(text).toContain('Status = ("A")');
    expect(text).not.toContain('NOT IN');
  });

  it('falls back to NOT IN when exclusion is shorter', () => {
    // 5 unique values, hiding 1 -> NOT IN is shorter
    const filters = [zf('Status', { hiddenItems: ['E'] })];
    const options: SerializeOptions = {
      filterUniqueValues: new Map([['Status', ['A', 'B', 'C', 'D', 'E']]]),
    };
    const text = serialize([], [], [], filters, emptyLayout, options);
    expect(text).toContain('NOT IN ("E")');
  });

  it('serializes large value list (100+ items) in NOT IN', () => {
    const items = Array.from({ length: 120 }, (_, i) => `Item${i}`);
    const filters = [zf('Product', { hiddenItems: items })];
    const text = serialize([], [], [], filters, emptyLayout);
    expect(text).toContain('NOT IN');
    expect(text).toContain('"Item0"');
    expect(text).toContain('"Item119"');
    // Should contain all 120 items
    const quoteCount = (text.match(/"Item\d+"/g) ?? []).length;
    expect(quoteCount).toBe(120);
  });

  it('serializes large inclusion list when shorter than NOT IN', () => {
    const all = Array.from({ length: 150 }, (_, i) => `V${i}`);
    // Hide 140 of 150 -> include 10 is shorter
    const hidden = all.slice(0, 140);
    const filters = [zf('Code', { hiddenItems: hidden })];
    const options: SerializeOptions = {
      filterUniqueValues: new Map([['Code', all]]),
    };
    const text = serialize([], [], [], filters, emptyLayout, options);
    expect(text).toContain('Code = (');
    expect(text).not.toContain('NOT IN');
  });

  it('escapes double quotes in filter values', () => {
    const filters = [zf('Name', { hiddenItems: ['He said "hello"'] })];
    const text = serialize([], [], [], filters, emptyLayout);
    expect(text).toContain('\\"hello\\"');
  });

  it('round-trips NOT IN filter', () => {
    const filters = [zf('Region', { hiddenItems: ['West', 'East'] })];
    const { ast, errors } = roundTrip([], [], [], filters, emptyLayout);
    expect(errors).toHaveLength(0);
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].exclude).toBe(true);
    expect(ast.filters[0].values).toContain('West');
    expect(ast.filters[0].values).toContain('East');
  });
});

// ============================================================================
// Layout directives combined with aliases
// ============================================================================

describe('serialize layout + aliases', () => {
  it('combines all layout directives', () => {
    const layout: LayoutConfig = {
      reportLayout: 'outline',
      repeatRowLabels: false,
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
      showEmptyRows: true,
      showEmptyCols: true,
      valuesPosition: 'rows',
      autoFitColumnWidths: true,
    };
    const text = serialize([], [], [], [], layout);
    expect(text).toContain('outline');
    expect(text).toContain('no-repeat-labels');
    expect(text).toContain('no-grand-totals');
    expect(text).toContain('show-empty-rows');
    expect(text).toContain('show-empty-cols');
    expect(text).toContain('values-on-rows');
    expect(text).toContain('auto-fit');
  });

  it('serializes value field with AS alias', () => {
    const values = [
      valueField('Revenue', 'sum', { customName: 'Total Revenue' }),
    ];
    const text = serialize([], [], values, [], emptyLayout);
    expect(text).toContain('Sum(Revenue) AS "Total Revenue"');
  });

  it('does not emit AS when customName matches default display name', () => {
    // Default display name for sum of Sales is "Sum of Sales"
    const values = [
      valueField('Sales', 'sum', { customName: 'Sum of Sales' }),
    ];
    const text = serialize([], [], values, [], emptyLayout);
    expect(text).not.toContain('AS');
  });

  it('round-trips alias through lex/parse', () => {
    const values = [
      valueField('Amount', 'average', { customName: 'Avg Amount' }),
    ];
    const { ast, errors } = roundTrip([], [], values, [], emptyLayout);
    expect(errors).toHaveLength(0);
    expect(ast.values[0].alias).toBe('Avg Amount');
  });
});

// ============================================================================
// SAVE AS with special characters
// ============================================================================

describe('serialize SAVE AS', () => {
  it('handles simple name', () => {
    const text = serialize([], [], [], [], emptyLayout, { saveAs: 'MyLayout' });
    expect(text).toContain('SAVE AS "MyLayout"');
  });

  it('handles name with spaces and punctuation', () => {
    const text = serialize([], [], [], [], emptyLayout, {
      saveAs: 'Q4 2025 - Sales (Final)',
    });
    expect(text).toContain('SAVE AS "Q4 2025 - Sales (Final)"');
  });

  it('handles name with unicode characters', () => {
    const text = serialize([], [], [], [], emptyLayout, {
      saveAs: 'Rapport Financier',
    });
    expect(text).toContain('SAVE AS "Rapport Financier"');
  });

  it('round-trips SAVE AS with special characters', () => {
    const { ast, errors } = roundTrip([], [], [], [], emptyLayout, {
      saveAs: 'Test [v2] (draft)',
    });
    expect(errors).toHaveLength(0);
    expect(ast.saveAs).toBe('Test [v2] (draft)');
  });
});

// ============================================================================
// Round-trip all SHOW_VALUES_AS types
// ============================================================================

describe('round-trip all SHOW_VALUES_AS types', () => {
  const showValuesAsTypes = [
    'percent_of_total',
    'percent_of_row',
    'percent_of_column',
    'percent_of_parent_row',
    'percent_of_parent_column',
    'difference',
    'percent_difference',
    'running_total',
    'index',
  ] as const;

  for (const sva of showValuesAsTypes) {
    it(`round-trips showValuesAs="${sva}"`, () => {
      const values = [valueField('Amount', 'sum', { showValuesAs: sva })];
      const { text, ast, errors } = roundTrip([], [], values, [], emptyLayout);
      expect(errors).toHaveLength(0);
      expect(ast.values).toHaveLength(1);
      expect(ast.values[0].showValuesAs).toBe(sva);
    });
  }

  it('does not emit bracket annotation for "normal"', () => {
    const values = [valueField('Amount', 'sum', { showValuesAs: 'normal' })];
    const text = serialize([], [], values, [], emptyLayout);
    expect(text).not.toContain('[');
  });
});

// ============================================================================
// Empty / minimal configurations
// ============================================================================

describe('serialize empty/minimal configs', () => {
  it('produces empty string for no fields and no layout', () => {
    const text = serialize([], [], [], [], emptyLayout);
    expect(text).toBe('');
  });

  it('produces only ROWS line for rows-only config', () => {
    const text = serialize([zf('A')], [], [], [], emptyLayout);
    expect(text).toBe('ROWS:    A');
  });

  it('produces only VALUES line for values-only config', () => {
    const text = serialize([], [], [valueField('X')], [], emptyLayout);
    expect(text).toBe('VALUES:  Sum(X)');
  });

  it('produces only LAYOUT line when only layout is set', () => {
    const text = serialize([], [], [], [], { reportLayout: 'tabular' });
    expect(text).toBe('LAYOUT:  tabular');
  });

  it('produces only SAVE AS when saveAs is set with empty zones', () => {
    const text = serialize([], [], [], [], emptyLayout, { saveAs: 'Empty' });
    expect(text).toBe('SAVE AS "Empty"');
  });
});

// ============================================================================
// BI-style dotted field names
// ============================================================================

describe('serialize BI-style dotted field names', () => {
  it('does not quote simple dotted names (Table.Column)', () => {
    const rows = [zf('Sales.Region')];
    const text = serialize(rows, [], [], [], emptyLayout);
    expect(text).toContain('Sales.Region');
    expect(text).not.toContain('"Sales.Region"');
  });

  it('quotes dotted names with special characters', () => {
    const rows = [zf('My Table.My Column')];
    const text = serialize(rows, [], [], [], emptyLayout);
    // Has spaces so needs quoting
    expect(text).toContain('"My Table.My Column"');
  });

  it('serializes BI measure references with brackets', () => {
    const values = [
      valueField('TotalSales', 'sum', { customName: 'TotalSales' }),
    ];
    const biModel = {
      tables: [],
      measures: [{ name: 'TotalSales', table: 'Sales', sourceColumn: 'Amount', aggregation: 'sum' as const }],
    };
    const text = serialize([], [], values, [], emptyLayout, { biModel });
    expect(text).toContain('[TotalSales]');
  });

  it('round-trips dotted field names', () => {
    const rows = [zf('Customers.Region')];
    const { ast, errors } = roundTrip(rows, [], [], [], emptyLayout);
    expect(errors).toHaveLength(0);
    expect(ast.rows[0].name).toBe('Customers.Region');
  });
});
