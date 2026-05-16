//! FILENAME: app/extensions/Pivot/dsl/dsl-compile-parameterized.test.ts
// PURPOSE: Heavily parameterized compilation tests for the Pivot Layout DSL.

import { describe, it, expect } from 'vitest';
import { processDsl } from './index';
import { compile, type CompileContext } from './compiler';
import { lex } from './lexer';
import { parse } from './parser';
import type { SourceField } from '../../_shared/components/types';

// ============================================================================
// Helpers
// ============================================================================

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

const FIELDS: SourceField[] = [
  sf(0, 'Region'), sf(1, 'Product'), sf(2, 'Quarter'), sf(3, 'Sales', true),
  sf(4, 'Profit', true), sf(5, 'Quantity', true), sf(6, 'Category'),
  sf(7, 'Date'), sf(8, 'Country'), sf(9, 'City'),
  sf(10, 'Manager'), sf(11, 'Channel'), sf(12, 'Segment'),
  sf(13, 'Revenue', true), sf(14, 'Cost', true), sf(15, 'Margin', true),
  sf(16, 'Year'), sf(17, 'Month'), sf(18, 'Week'), sf(19, 'Day'),
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
// 1. Compile single ROWS field: 50 field name combos
// ============================================================================

describe('compile single ROWS field (50 combos)', () => {
  const fieldCombos: [string, string, number][] = [
    ['Region', 'Region', 0], ['Product', 'Product', 1], ['Quarter', 'Quarter', 2],
    ['Sales', 'Sales', 3], ['Profit', 'Profit', 4], ['Quantity', 'Quantity', 5],
    ['Category', 'Category', 6], ['Date', 'Date', 7], ['Country', 'Country', 8],
    ['City', 'City', 9], ['Manager', 'Manager', 10], ['Channel', 'Channel', 11],
    ['Segment', 'Segment', 12], ['Revenue', 'Revenue', 13], ['Cost', 'Cost', 14],
    ['Margin', 'Margin', 15], ['Year', 'Year', 16], ['Month', 'Month', 17],
    ['Week', 'Week', 18], ['Day', 'Day', 19],
    // Case variations
    ['region', 'Region', 0], ['product', 'Product', 1], ['quarter', 'Quarter', 2],
    ['sales', 'Sales', 3], ['profit', 'Profit', 4], ['quantity', 'Quantity', 5],
    ['category', 'Category', 6], ['date', 'Date', 7], ['country', 'Country', 8],
    ['city', 'City', 9], ['manager', 'Manager', 10], ['channel', 'Channel', 11],
    ['segment', 'Segment', 12], ['revenue', 'Revenue', 13], ['cost', 'Cost', 14],
    ['margin', 'Margin', 15], ['year', 'Year', 16], ['month', 'Month', 17],
    ['week', 'Week', 18], ['day', 'Day', 19],
    // UPPER case
    ['REGION', 'Region', 0], ['PRODUCT', 'Product', 1], ['QUARTER', 'Quarter', 2],
    ['SALES', 'Sales', 3], ['PROFIT', 'Profit', 4], ['QUANTITY', 'Quantity', 5],
    ['CATEGORY', 'Category', 6], ['DATE', 'Date', 7], ['COUNTRY', 'Country', 8],
    ['CITY', 'City', 9],
  ];

  it.each(fieldCombos)(
    'ROWS: %s -> name=%s, sourceIndex=%d',
    (input, expectedName, expectedIndex) => {
      const result = run(`ROWS: ${input}`);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe(expectedName);
      expect(result.rows[0].sourceIndex).toBe(expectedIndex);
      expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    },
  );
});

// ============================================================================
// 2. Compile single VALUES field: 11 aggregations x 10 showValuesAs = 110 combos
// ============================================================================

describe('compile VALUES with aggregation x showValuesAs (110 combos)', () => {
  const aggregations = [
    'sum', 'count', 'average', 'min', 'max',
    'countnumbers', 'stddev', 'stddevp', 'var', 'varp', 'product',
  ] as const;

  const showValuesAsCombos: [string, string][] = [
    ['% of Grand Total', 'percent_of_total'],
    ['% of Row', 'percent_of_row'],
    ['% of Row Total', 'percent_of_row'],
    ['% of Column', 'percent_of_column'],
    ['% of Column Total', 'percent_of_column'],
    ['% of Parent Row', 'percent_of_parent_row'],
    ['% of Parent Column', 'percent_of_parent_column'],
    ['Difference', 'difference'],
    ['% Difference', 'percent_difference'],
    ['Running Total', 'running_total'],
  ];

  const combos: [string, string, string][] = [];
  for (const agg of aggregations) {
    for (const [svaLabel, svaValue] of showValuesAsCombos) {
      combos.push([agg, svaLabel, svaValue]);
    }
  }

  it.each(combos)(
    'VALUES: %s(Sales) [%s] -> showValuesAs=%s',
    (agg, svaLabel, svaValue) => {
      const result = run(`VALUES: ${agg}(Sales) [${svaLabel}]`);
      expect(result.values).toHaveLength(1);
      expect(result.values[0].aggregation).toBe(agg);
      expect(result.values[0].showValuesAs).toBe(svaValue);
      expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    },
  );
});

// ============================================================================
// 3. Compile FILTERS: 30 filter value list combos
// ============================================================================

describe('compile FILTERS (30 combos)', () => {
  const inclusionCases: [string, string, string[], string[], string[]][] = [
    // [label, field, filterValues, allValues, expectedHidden]
    ['single include', 'Region', ['East'], ['East', 'West', 'North', 'South'], ['West', 'North', 'South']],
    ['two includes', 'Region', ['East', 'West'], ['East', 'West', 'North', 'South'], ['North', 'South']],
    ['three includes', 'Region', ['East', 'West', 'North'], ['East', 'West', 'North', 'South'], ['South']],
    ['all included', 'Region', ['East', 'West', 'North', 'South'], ['East', 'West', 'North', 'South'], []],
    ['single value pool', 'Region', ['Only'], ['Only'], []],
    ['include from 5', 'Category', ['A'], ['A', 'B', 'C', 'D', 'E'], ['B', 'C', 'D', 'E']],
    ['include 2 from 5', 'Category', ['A', 'B'], ['A', 'B', 'C', 'D', 'E'], ['C', 'D', 'E']],
    ['include 3 from 5', 'Category', ['A', 'B', 'C'], ['A', 'B', 'C', 'D', 'E'], ['D', 'E']],
    ['include 4 from 5', 'Category', ['A', 'B', 'C', 'D'], ['A', 'B', 'C', 'D', 'E'], ['E']],
    ['include all 5', 'Category', ['A', 'B', 'C', 'D', 'E'], ['A', 'B', 'C', 'D', 'E'], []],
    ['single from 3', 'Product', ['X'], ['X', 'Y', 'Z'], ['Y', 'Z']],
    ['two from 3', 'Product', ['X', 'Y'], ['X', 'Y', 'Z'], ['Z']],
    ['include single', 'Country', ['US'], ['US', 'UK', 'CA', 'DE', 'FR', 'JP'], ['UK', 'CA', 'DE', 'FR', 'JP']],
    ['include two', 'Country', ['US', 'UK'], ['US', 'UK', 'CA', 'DE', 'FR', 'JP'], ['CA', 'DE', 'FR', 'JP']],
    ['include three', 'Country', ['US', 'UK', 'CA'], ['US', 'UK', 'CA', 'DE', 'FR', 'JP'], ['DE', 'FR', 'JP']],
  ];

  it.each(inclusionCases)(
    'FILTERS include: %s on %s',
    (_label, field, filterValues, allValues, expectedHidden) => {
      const valuesStr = filterValues.map(v => `"${v}"`).join(', ');
      const dsl = `FILTERS: ${field} = ${valuesStr}`;
      const fuv = new Map([[field, allValues]]);
      const result = run(dsl, ctx(FIELDS, fuv));
      expect(result.filters).toHaveLength(1);
      expect(result.filters[0].hiddenItems).toEqual(expectedHidden);
    },
  );

  const exclusionCases: [string, string, string[]][] = [
    ['exclude one', 'Region', ['East']],
    ['exclude two', 'Region', ['East', 'West']],
    ['exclude three', 'Region', ['East', 'West', 'North']],
    ['exclude one product', 'Product', ['Widget']],
    ['exclude two products', 'Product', ['Widget', 'Gadget']],
    ['exclude single category', 'Category', ['Electronics']],
    ['exclude two categories', 'Category', ['Electronics', 'Clothing']],
    ['exclude three categories', 'Category', ['A', 'B', 'C']],
    ['exclude one country', 'Country', ['US']],
    ['exclude two countries', 'Country', ['US', 'UK']],
    ['exclude single city', 'City', ['NYC']],
    ['exclude two cities', 'City', ['NYC', 'LA']],
    ['exclude single channel', 'Channel', ['Online']],
    ['exclude two channels', 'Channel', ['Online', 'Retail']],
    ['exclude single segment', 'Segment', ['Enterprise']],
  ];

  it.each(exclusionCases)(
    'FILTERS exclude: %s on %s',
    (_label, field, values) => {
      const valuesStr = values.map(v => `"${v}"`).join(', ');
      const dsl = `FILTERS: ${field} NOT IN ${valuesStr}`;
      const result = run(dsl);
      expect(result.filters).toHaveLength(1);
      expect(result.filters[0].hiddenItems).toEqual(values);
    },
  );
});

// ============================================================================
// 4. Compile LAYOUT: 19 directives x 3 values each = 57 combos
// ============================================================================

describe('compile LAYOUT directives (57 combos)', () => {
  const directiveCases: [string, string, unknown][] = [
    // Report layout
    ['compact', 'reportLayout', 'compact'],
    ['outline', 'reportLayout', 'outline'],
    ['tabular', 'reportLayout', 'tabular'],
    // Repeat labels
    ['repeat-labels', 'repeatRowLabels', true],
    ['no-repeat-labels', 'repeatRowLabels', false],
    // Grand totals
    ['no-grand-totals (row)', 'showRowGrandTotals', false],
    ['no-grand-totals (col)', 'showColumnGrandTotals', false],
    ['grand-totals (row)', 'showRowGrandTotals', true],
    ['grand-totals (col)', 'showColumnGrandTotals', true],
    // Row totals
    ['no-row-totals', 'showRowGrandTotals', false],
    ['row-totals', 'showRowGrandTotals', true],
    // Column totals
    ['no-column-totals', 'showColumnGrandTotals', false],
    ['column-totals', 'showColumnGrandTotals', true],
    // Empty rows/cols
    ['show-empty-rows', 'showEmptyRows', true],
    ['show-empty-cols', 'showEmptyCols', true],
    // Values position
    ['values-on-rows', 'valuesPosition', 'rows'],
    ['values-on-columns', 'valuesPosition', 'columns'],
    // Auto-fit
    ['auto-fit', 'autoFitColumnWidths', true],
  ];

  // Each directive tested alone
  it.each(directiveCases)(
    'LAYOUT: %s -> %s = %s',
    (directive, prop, expected) => {
      const result = run(`LAYOUT: ${directive}`);
      expect((result.layout as Record<string, unknown>)[prop]).toBe(expected);
    },
  );

  // Each directive combined with compact (skip layout-type directives that override compact)
  it.each(directiveCases.filter(([d]) => d !== 'compact' && d !== 'outline' && d !== 'tabular'))(
    'LAYOUT: compact, %s -> %s = %s',
    (directive, prop, expected) => {
      const result = run(`LAYOUT: compact, ${directive}`);
      expect(result.layout.reportLayout).toBe('compact');
      expect((result.layout as Record<string, unknown>)[prop]).toBe(expected);
    },
  );

  // Each directive combined with tabular
  it.each(directiveCases.filter(([d]) => d !== 'tabular' && d !== 'compact' && d !== 'outline'))(
    'LAYOUT: tabular, %s -> %s = %s',
    (directive, prop, expected) => {
      const result = run(`LAYOUT: tabular, ${directive}`);
      expect(result.layout.reportLayout).toBe('tabular');
      expect((result.layout as Record<string, unknown>)[prop]).toBe(expected);
    },
  );
});

// ============================================================================
// 5. Compile CALC expressions: 30 expression combos
// ============================================================================

describe('compile CALC expressions (30 combos)', () => {
  const calcCases: [string, string, string][] = [
    ['simple add', 'Margin', '[Sales] + [Profit]'],
    ['simple subtract', 'Delta', '[Sales] - [Cost]'],
    ['simple multiply', 'Double', '[Sales] * 2'],
    ['simple divide', 'Ratio', '[Sales] / [Cost]'],
    ['percentage', 'Pct', '[Profit] / [Revenue] * 100'],
    ['nested parens', 'Complex', '( [Sales] + [Profit] ) / [Revenue]'],
    ['three fields', 'Total', '[Sales] + [Profit] + [Revenue]'],
    ['subtract three', 'Net', '[Revenue] - [Cost] - [Margin]'],
    ['mixed ops', 'Mixed', '[Sales] * 2 + [Profit]'],
    ['division chain', 'Chain', '[Sales] / [Profit] / [Revenue]'],
    ['constant only', 'Fixed', '100'],
    ['negative constant', 'Neg', '- 50'],
    ['decimal constant', 'Dec', '3.14'],
    ['field times const', 'Scaled', '[Sales] * 1.1'],
    ['const minus field', 'Inv', '1000 - [Sales]'],
    ['power', 'Sq', '[Sales] ^ 2'],
    ['complex expr', 'Weighted', '( [Sales] * 0.7 + [Profit] * 0.3 )'],
    ['four fields', 'All', '[Sales] + [Profit] + [Revenue] + [Cost]'],
    ['deeply nested', 'Deep', '( ( [Sales] + [Profit] ) * ( [Revenue] - [Cost] ) )'],
    ['single field', 'Echo', '[Sales]'],
    ['double field', 'Dbl', '[Sales] + [Sales]'],
    ['zero', 'Zero', '[Sales] - [Sales]'],
    ['fraction', 'Frac', '[Sales] / 3'],
    ['big const', 'Big', '[Sales] * 1000000'],
    ['small const', 'Small', '[Sales] * 0.001'],
    ['add const', 'Plus', '[Sales] + 100'],
    ['sub const', 'Minus', '[Sales] - 50'],
    ['mul div', 'MulDiv', '[Sales] * 2 / 3'],
    ['paren priority', 'Prio', '[Sales] * ( 2 + 3 )'],
    ['triple paren', 'Triple', '( ( ( [Sales] ) ) )'],
  ];

  it.each(calcCases)(
    'CALC: %s -> name=%s, expr=%s',
    (_label, name, expr) => {
      const dsl = `VALUES: sum(Sales)\nCALC: ${name} = ${expr}`;
      const result = run(dsl);
      expect(result.calculatedFields).toHaveLength(1);
      expect(result.calculatedFields[0].name).toBe(name);
      expect(result.calculatedFields[0].formula).toBe(expr);
    },
  );
});

// ============================================================================
// 6. Compile SORT: 20 field x direction combos
// ============================================================================

describe('compile SORT (20 combos)', () => {
  const sortCases: [string, string][] = [
    ['Region', 'ASC'], ['Region', 'DESC'],
    ['Product', 'ASC'], ['Product', 'DESC'],
    ['Sales', 'ASC'], ['Sales', 'DESC'],
    ['Profit', 'ASC'], ['Profit', 'DESC'],
    ['Quantity', 'ASC'], ['Quantity', 'DESC'],
    ['Category', 'ASC'], ['Category', 'DESC'],
    ['Country', 'ASC'], ['Country', 'DESC'],
    ['City', 'ASC'], ['City', 'DESC'],
    ['Manager', 'ASC'], ['Manager', 'DESC'],
    ['Channel', 'ASC'], ['Channel', 'DESC'],
  ];

  it.each(sortCases)(
    'SORT: %s %s',
    (field, direction) => {
      const dsl = `ROWS: ${field}\nSORT: ${field} ${direction}`;
      const result = run(dsl);
      // Sort is in the AST; verify rows compiled and no errors
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe(field);
      expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    },
  );
});

// ============================================================================
// 7. Compile TOP/BOTTOM: 20 count combos
// ============================================================================

describe('compile TOP/BOTTOM (20 combos)', () => {
  const topBottomCases: [string, number, string][] = [
    ['TOP', 1, 'Sales'], ['TOP', 2, 'Sales'], ['TOP', 3, 'Sales'],
    ['TOP', 5, 'Sales'], ['TOP', 10, 'Sales'], ['TOP', 20, 'Sales'],
    ['TOP', 50, 'Sales'], ['TOP', 100, 'Sales'], ['TOP', 3, 'Profit'],
    ['TOP', 5, 'Profit'],
    ['BOTTOM', 1, 'Sales'], ['BOTTOM', 2, 'Sales'], ['BOTTOM', 3, 'Sales'],
    ['BOTTOM', 5, 'Sales'], ['BOTTOM', 10, 'Sales'], ['BOTTOM', 20, 'Sales'],
    ['BOTTOM', 50, 'Sales'], ['BOTTOM', 100, 'Sales'], ['BOTTOM', 3, 'Profit'],
    ['BOTTOM', 5, 'Profit'],
  ];

  it.each(topBottomCases)(
    '%s %d BY sum(%s)',
    (direction, count, field) => {
      const dsl = `ROWS: Region\nVALUES: sum(${field})\n${direction} ${count} BY sum(${field})`;
      const result = run(dsl);
      expect(result.rows).toHaveLength(1);
      expect(result.values).toHaveLength(1);
      expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    },
  );
});

// ============================================================================
// 8. Full pipeline processDsl: 50 different DSL strings
// ============================================================================

describe('full pipeline processDsl (50 combos)', () => {
  const fullPipelineCases: [string, string, number, number, number][] = [
    // [label, dsl, expectedRows, expectedValues, expectedErrors]
    ['rows only', 'ROWS: Region', 1, 0, 0],
    ['rows + values', 'ROWS: Region\nVALUES: sum(Sales)', 1, 1, 0],
    ['two rows', 'ROWS: Region, Product', 2, 0, 0],
    ['three rows', 'ROWS: Region, Product, Category', 3, 0, 0],
    ['rows + two values', 'ROWS: Region\nVALUES: sum(Sales), sum(Profit)', 1, 2, 0],
    ['rows + three values', 'ROWS: Region\nVALUES: sum(Sales), sum(Profit), sum(Quantity)', 1, 3, 0],
    ['rows + count', 'ROWS: Region\nVALUES: count(Product)', 1, 1, 0],
    ['rows + average', 'ROWS: Region\nVALUES: average(Sales)', 1, 1, 0],
    ['rows + min', 'ROWS: Region\nVALUES: min(Sales)', 1, 1, 0],
    ['rows + max', 'ROWS: Region\nVALUES: max(Sales)', 1, 1, 0],
    ['rows + stddev', 'ROWS: Region\nVALUES: stddev(Sales)', 1, 1, 0],
    ['rows + var', 'ROWS: Region\nVALUES: var(Sales)', 1, 1, 0],
    ['rows + product', 'ROWS: Region\nVALUES: product(Sales)', 1, 1, 0],
    ['with layout compact', 'ROWS: Region\nLAYOUT: compact', 1, 0, 0],
    ['with layout tabular', 'ROWS: Region\nLAYOUT: tabular', 1, 0, 0],
    ['with layout outline', 'ROWS: Region\nLAYOUT: outline', 1, 0, 0],
    ['rows + columns', 'ROWS: Region\nCOLUMNS: Quarter', 1, 0, 0],
    ['rows + columns + values', 'ROWS: Region\nCOLUMNS: Quarter\nVALUES: sum(Sales)', 1, 1, 0],
    ['complex layout', 'ROWS: Region\nLAYOUT: compact, no-grand-totals, repeat-labels', 1, 0, 0],
    ['values-on-rows', 'ROWS: Region\nVALUES: sum(Sales)\nLAYOUT: values-on-rows', 1, 1, 0],
    ['sort asc', 'ROWS: Region\nSORT: Region ASC', 1, 0, 0],
    ['sort desc', 'ROWS: Region\nSORT: Region DESC', 1, 0, 0],
    ['empty string', '', 0, 0, 0],
    ['comment only', '# just a comment', 0, 0, 0],
    ['multiple comments', '# line 1\n# line 2\n# line 3', 0, 0, 0],
    ['rows with comment', '# pivot\nROWS: Region', 1, 0, 0],
    ['all zones', 'ROWS: Region\nCOLUMNS: Quarter\nVALUES: sum(Sales)\nLAYOUT: compact', 1, 1, 0],
    ['two rows + values', 'ROWS: Region, Product\nVALUES: sum(Sales)', 2, 1, 0],
    ['three rows + values', 'ROWS: Region, Product, Category\nVALUES: sum(Sales), average(Profit)', 3, 2, 0],
    ['calc field', 'ROWS: Region\nVALUES: sum(Sales)\nCALC: Margin = [Sales] - [Cost]', 1, 1, 0],
    ['two calc fields', 'ROWS: Region\nVALUES: sum(Sales)\nCALC: M1 = [Sales] + 1\nCALC: M2 = [Sales] * 2', 1, 1, 0],
    ['values with alias', 'ROWS: Region\nVALUES: sum(Sales) AS "Total Sales"', 1, 1, 0],
    ['values with SVA', 'ROWS: Region\nVALUES: sum(Sales) [% of Grand Total]', 1, 1, 0],
    ['filter include', 'ROWS: Region\nFILTERS: Region = "East"', 1, 0, 0],
    ['filter exclude', 'ROWS: Region\nFILTERS: Region NOT IN "East"', 1, 0, 0],
    ['top 5', 'ROWS: Region\nVALUES: sum(Sales)\nTOP 5 BY sum(Sales)', 1, 1, 0],
    ['bottom 3', 'ROWS: Region\nVALUES: sum(Sales)\nBOTTOM 3 BY sum(Sales)', 1, 1, 0],
    ['auto-fit', 'ROWS: Region\nLAYOUT: auto-fit', 1, 0, 0],
    ['show-empty-rows', 'ROWS: Region\nLAYOUT: show-empty-rows', 1, 0, 0],
    ['show-empty-cols', 'ROWS: Region\nLAYOUT: show-empty-cols', 1, 0, 0],
    ['no-row-totals', 'ROWS: Region\nLAYOUT: no-row-totals', 1, 0, 0],
    ['no-column-totals', 'ROWS: Region\nLAYOUT: no-column-totals', 1, 0, 0],
    ['row-totals', 'ROWS: Region\nLAYOUT: row-totals', 1, 0, 0],
    ['column-totals', 'ROWS: Region\nLAYOUT: column-totals', 1, 0, 0],
    ['values-on-columns', 'ROWS: Region\nVALUES: sum(Sales)\nLAYOUT: values-on-columns', 1, 1, 0],
    ['case insensitive rows', 'ROWS: region', 1, 0, 0],
    ['mixed case values', 'ROWS: Region\nVALUES: SUM(sales)', 1, 1, 0],
    ['countnumbers', 'ROWS: Region\nVALUES: countnumbers(Sales)', 1, 1, 0],
    ['stddevp', 'ROWS: Region\nVALUES: stddevp(Sales)', 1, 1, 0],
    ['varp', 'ROWS: Region\nVALUES: varp(Sales)', 1, 1, 0],
  ];

  it.each(fullPipelineCases)(
    'processDsl: %s',
    (_label, dsl, expectedRows, expectedValues, expectedErrors) => {
      const result = run(dsl);
      expect(result.rows).toHaveLength(expectedRows);
      expect(result.values).toHaveLength(expectedValues);
      expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(expectedErrors);
    },
  );
});
