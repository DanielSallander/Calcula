//! FILENAME: app/extensions/Pivot/dsl/dsl-show-values-as.test.ts
// PURPOSE: Tests for SHOW_VALUES_AS types in the DSL pipeline (parse, compile, serialize).

import { describe, it, expect } from 'vitest';
import { processDsl } from './index';
import { serialize } from './serializer';
import { SHOW_VALUES_AS_NAMES } from './tokens';
import type { CompileContext } from './compiler';
import type { SourceField, ZoneField } from '../../_shared/components/types';

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
];

function ctx(fields: SourceField[] = FIELDS): CompileContext {
  return { sourceFields: fields };
}

function run(dsl: string, context?: CompileContext) {
  return processDsl(dsl, context ?? ctx());
}

function getFirstValueShowAs(dsl: string): string | undefined {
  const result = run(dsl);
  expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
  return result.values[0]?.showValuesAs;
}

// ============================================================================
// All SHOW_VALUES_AS types
// ============================================================================

describe('ShowValuesAs: % of Grand Total', () => {
  it('parses [% of Grand Total] suffix', () => {
    expect(getFirstValueShowAs(
      'ROWS: Region\nVALUES: Sum(Sales) [% of Grand Total]'
    )).toBe('percent_of_total');
  });

  it('serializes percent_of_total back to DSL', () => {
    const values: ZoneField[] = [{
      sourceIndex: 3, name: 'Sales', isNumeric: true,
      aggregation: 'sum', showValuesAs: 'percent_of_total',
    }];
    const text = serialize([], [], values, [], {});
    expect(text).toContain('[% of Grand Total]');
  });
});

describe('ShowValuesAs: % of Row Total', () => {
  it('parses [% of Row] suffix', () => {
    expect(getFirstValueShowAs(
      'ROWS: Region\nVALUES: Sum(Sales) [% of Row]'
    )).toBe('percent_of_row');
  });

  it('parses [% of Row Total] suffix (alias)', () => {
    expect(getFirstValueShowAs(
      'ROWS: Region\nVALUES: Sum(Sales) [% of Row Total]'
    )).toBe('percent_of_row');
  });

  it('serializes percent_of_row', () => {
    const values: ZoneField[] = [{
      sourceIndex: 3, name: 'Sales', isNumeric: true,
      aggregation: 'sum', showValuesAs: 'percent_of_row',
    }];
    const text = serialize([], [], values, [], {});
    expect(text).toContain('[% of Row]');
  });
});

describe('ShowValuesAs: % of Column Total', () => {
  it('parses [% of Column] suffix', () => {
    expect(getFirstValueShowAs(
      'ROWS: Region\nVALUES: Sum(Sales) [% of Column]'
    )).toBe('percent_of_column');
  });

  it('parses [% of Column Total] suffix (alias)', () => {
    expect(getFirstValueShowAs(
      'ROWS: Region\nVALUES: Sum(Sales) [% of Column Total]'
    )).toBe('percent_of_column');
  });
});

describe('ShowValuesAs: % of Parent Row', () => {
  it('parses [% of Parent Row] suffix', () => {
    expect(getFirstValueShowAs(
      'ROWS: Region, Product\nVALUES: Sum(Sales) [% of Parent Row]'
    )).toBe('percent_of_parent_row');
  });
});

describe('ShowValuesAs: % of Parent Column', () => {
  it('parses [% of Parent Column] suffix', () => {
    expect(getFirstValueShowAs(
      'COLUMNS: Quarter\nVALUES: Sum(Sales) [% of Parent Column]'
    )).toBe('percent_of_parent_column');
  });
});

describe('ShowValuesAs: Difference From', () => {
  it('parses [Difference] suffix', () => {
    expect(getFirstValueShowAs(
      'ROWS: Region\nVALUES: Sum(Sales) [Difference]'
    )).toBe('difference');
  });
});

describe('ShowValuesAs: % Difference', () => {
  it('parses [% Difference] suffix', () => {
    expect(getFirstValueShowAs(
      'ROWS: Region\nVALUES: Sum(Sales) [% Difference]'
    )).toBe('percent_difference');
  });
});

describe('ShowValuesAs: Running Total', () => {
  it('parses [Running Total] suffix', () => {
    expect(getFirstValueShowAs(
      'ROWS: Region\nVALUES: Sum(Sales) [Running Total]'
    )).toBe('running_total');
  });
});

describe('ShowValuesAs: Index', () => {
  it('parses [Index] suffix', () => {
    expect(getFirstValueShowAs(
      'ROWS: Region\nVALUES: Sum(Sales) [Index]'
    )).toBe('index');
  });
});

describe('ShowValuesAs: none / normal', () => {
  it('no suffix means no showValuesAs', () => {
    const result = run('ROWS: Region\nVALUES: Sum(Sales)');
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.showValuesAs).toBeUndefined();
  });

  it('serializer omits suffix for normal showValuesAs', () => {
    const values: ZoneField[] = [{
      sourceIndex: 3, name: 'Sales', isNumeric: true,
      aggregation: 'sum', showValuesAs: 'normal',
    }];
    const text = serialize([], [], values, [], {});
    expect(text).not.toContain('[');
  });
});

// ============================================================================
// Combined with different aggregation types
// ============================================================================

describe('ShowValuesAs combined with aggregation types', () => {
  it('Average with % of Grand Total', () => {
    const result = run('ROWS: Region\nVALUES: Average(Sales) [% of Grand Total]');
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.aggregation).toBe('average');
    expect(result.values[0]?.showValuesAs).toBe('percent_of_total');
  });

  it('Count with % of Row', () => {
    const result = run('ROWS: Region\nVALUES: Count(Product) [% of Row]');
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.aggregation).toBe('count');
    expect(result.values[0]?.showValuesAs).toBe('percent_of_row');
  });

  it('Max with Running Total', () => {
    const result = run('ROWS: Region\nVALUES: Max(Sales) [Running Total]');
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.aggregation).toBe('max');
    expect(result.values[0]?.showValuesAs).toBe('running_total');
  });

  it('Min with % of Column', () => {
    const result = run('ROWS: Region\nVALUES: Min(Profit) [% of Column]');
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.aggregation).toBe('min');
    expect(result.values[0]?.showValuesAs).toBe('percent_of_column');
  });

  it('Product with Index', () => {
    const result = run('ROWS: Region\nVALUES: Product(Quantity) [Index]');
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.aggregation).toBe('product');
    expect(result.values[0]?.showValuesAs).toBe('index');
  });
});

// ============================================================================
// Multiple values with different show-as
// ============================================================================

describe('Multiple values with different ShowValuesAs', () => {
  it('each value field can have its own showValuesAs', () => {
    const result = run(
      'ROWS: Region\nVALUES: Sum(Sales) [% of Grand Total],\n' +
      '        Average(Profit) [% of Row],\n' +
      '        Count(Quantity) [Running Total]'
    );
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values).toHaveLength(3);
    expect(result.values[0]?.showValuesAs).toBe('percent_of_total');
    expect(result.values[1]?.showValuesAs).toBe('percent_of_row');
    expect(result.values[2]?.showValuesAs).toBe('running_total');
  });

  it('mixed: some with showValuesAs, some without', () => {
    const result = run(
      'ROWS: Region\nVALUES: Sum(Sales), Average(Profit) [% of Column]'
    );
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.showValuesAs).toBeUndefined();
    expect(result.values[1]?.showValuesAs).toBe('percent_of_column');
  });
});

// ============================================================================
// ShowValuesAs with alias (AS)
// ============================================================================

describe('ShowValuesAs with AS alias', () => {
  it('parses showValuesAs combined with alias', () => {
    const result = run(
      'ROWS: Region\nVALUES: Sum(Sales) AS "Revenue %" [% of Grand Total]'
    );
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.customName).toBe('Revenue %');
    expect(result.values[0]?.showValuesAs).toBe('percent_of_total');
  });
});

// ============================================================================
// Round-trip: parse -> compile -> serialize -> parse
// ============================================================================

describe('ShowValuesAs round-trip', () => {
  const showAsCases: [string, string][] = [
    ['percent_of_total', '% of Grand Total'],
    ['percent_of_row', '% of Row'],
    ['percent_of_column', '% of Column'],
    ['percent_of_parent_row', '% of Parent Row'],
    ['percent_of_parent_column', '% of Parent Column'],
    ['difference', 'Difference'],
    ['percent_difference', '% Difference'],
    ['running_total', 'Running Total'],
    ['index', 'Index'],
  ];

  for (const [internalName, label] of showAsCases) {
    it(`round-trips ${internalName}`, () => {
      const values: ZoneField[] = [{
        sourceIndex: 3, name: 'Sales', isNumeric: true,
        aggregation: 'sum', showValuesAs: internalName,
      }];
      const rows: ZoneField[] = [{
        sourceIndex: 0, name: 'Region', isNumeric: false,
      }];

      const text = serialize(rows, [], values, [], {});
      expect(text).toContain(`[${label}]`);

      // Parse it back
      const result = run(text);
      expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
      expect(result.values[0]?.showValuesAs).toBe(internalName);
    });
  }
});

// ============================================================================
// Edge cases: missing base fields and unknown ShowValuesAs
// ============================================================================

describe('ShowValuesAs edge cases', () => {
  it('SHOW_VALUES_AS_NAMES map has all expected entries', () => {
    expect(SHOW_VALUES_AS_NAMES.size).toBeGreaterThanOrEqual(11);
    expect(SHOW_VALUES_AS_NAMES.get('% of grand total')).toBe('percent_of_total');
    expect(SHOW_VALUES_AS_NAMES.get('running total')).toBe('running_total');
    expect(SHOW_VALUES_AS_NAMES.get('index')).toBe('index');
  });

  it('values-only DSL (no rows) with showValuesAs still compiles', () => {
    const result = run('VALUES: Sum(Sales) [% of Grand Total]');
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.showValuesAs).toBe('percent_of_total');
  });

  it('showValuesAs with calculated field in VALUES', () => {
    const result = run(
      'ROWS: Region\nVALUES: Sum(Sales),\n' +
      '        CALC Margin = Sales - Profit'
    );
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.calculatedFields[0].name).toBe('Margin');
  });

  it('showValuesAs does not interfere with number format', () => {
    const values: ZoneField[] = [{
      sourceIndex: 3, name: 'Sales', isNumeric: true,
      aggregation: 'sum', showValuesAs: 'percent_of_total',
      numberFormat: '0.0%',
    }];
    const text = serialize([], [], values, [], {});
    expect(text).toContain('[% of Grand Total]');
    // numberFormat is not serialized in DSL (it's a property of the value field config)
  });

  it('percent_of_parent with single-level rows', () => {
    // Valid syntax, but semantically the parent is the grand total
    const result = run(
      'ROWS: Region\nVALUES: Sum(Sales) [% of Parent Row]'
    );
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.showValuesAs).toBe('percent_of_parent_row');
  });

  it('showValuesAs with empty rows and columns', () => {
    // No row/column fields, just a value with show-as
    const result = run('VALUES: Sum(Sales) [% of Column]');
    expect(result.errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(result.values[0]?.showValuesAs).toBe('percent_of_column');
  });
});
