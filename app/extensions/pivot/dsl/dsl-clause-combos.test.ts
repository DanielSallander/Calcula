//! FILENAME: app/extensions/Pivot/dsl/dsl-clause-combos.test.ts
// PURPOSE: Combinatorial tests for DSL clause pairs, triples, aggregation x showValuesAs,
//          and layout directive combinations.

import { describe, it, expect } from 'vitest';
import { processDsl } from './index';
import type { CompileContext, CompileResult } from './compiler';
import type { SourceField } from '../../_shared/components/types';

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

function ctx(): CompileContext {
  return { sourceFields: FIELDS };
}

function run(dsl: string): CompileResult & { parseErrors: import('./errors').DslError[] } {
  return processDsl(dsl, ctx());
}

function expectNoErrors(result: CompileResult & { parseErrors: any[] }): void {
  const errors = [...result.errors, ...result.parseErrors].filter(e => e.severity === 'error');
  expect(errors).toHaveLength(0);
}

// ============================================================================
// All pairs of clause types
// ============================================================================

const CLAUSE_SNIPPETS: Record<string, string> = {
  ROWS: 'ROWS: Region',
  COLUMNS: 'COLUMNS: Quarter',
  VALUES: 'VALUES: sum(Sales)',
  FILTERS: 'FILTERS: Product = "Widget"',
  SORT: 'SORT: Region ASC',
  LAYOUT: 'LAYOUT: compact',
};

const CLAUSE_KEYS = Object.keys(CLAUSE_SNIPPETS);

describe('clause pairs', () => {
  for (let i = 0; i < CLAUSE_KEYS.length; i++) {
    for (let j = i + 1; j < CLAUSE_KEYS.length; j++) {
      const a = CLAUSE_KEYS[i];
      const b = CLAUSE_KEYS[j];

      it(`${a} + ${b}`, () => {
        const dsl = `${CLAUSE_SNIPPETS[a]}\n${CLAUSE_SNIPPETS[b]}`;
        const result = run(dsl);
        expectNoErrors(result);
      });
    }
  }
});

// ============================================================================
// All triples of clause types
// ============================================================================

describe('clause triples', () => {
  // Generate all C(6,3) = 20 triples
  for (let i = 0; i < CLAUSE_KEYS.length; i++) {
    for (let j = i + 1; j < CLAUSE_KEYS.length; j++) {
      for (let k = j + 1; k < CLAUSE_KEYS.length; k++) {
        const a = CLAUSE_KEYS[i];
        const b = CLAUSE_KEYS[j];
        const c = CLAUSE_KEYS[k];

        it(`${a} + ${b} + ${c}`, () => {
          const dsl = `${CLAUSE_SNIPPETS[a]}\n${CLAUSE_SNIPPETS[b]}\n${CLAUSE_SNIPPETS[c]}`;
          const result = run(dsl);
          expectNoErrors(result);
        });
      }
    }
  }
});

// ============================================================================
// Every aggregation x every showValuesAs combination
// ============================================================================

const AGGREGATIONS = ['sum', 'count', 'average', 'min', 'max'];
const SHOW_VALUES_AS = [
  '% of grand total',
  '% of row',
  '% of column',
  '% of parent row',
  '% of parent column',
  'difference',
  '% difference',
  'running total',
  'index',
];

describe('aggregation x showValuesAs', () => {
  for (const agg of AGGREGATIONS) {
    for (const sva of SHOW_VALUES_AS) {
      it(`${agg}(Sales) [${sva}]`, () => {
        const dsl = `ROWS: Region\nVALUES: ${agg}(Sales) [${sva}]`;
        const result = run(dsl);
        expectNoErrors(result);
        expect(result.values.length).toBeGreaterThanOrEqual(1);
      });
    }
  }
});

// ============================================================================
// Layout directive combinations
// ============================================================================

const LAYOUT_COMBOS: Array<{ label: string; directives: string }> = [
  { label: 'compact + grand-totals', directives: 'compact, grand-totals' },
  { label: 'compact + no-grand-totals', directives: 'compact, no-grand-totals' },
  { label: 'compact + repeat-labels', directives: 'compact, repeat-labels' },
  { label: 'tabular + grand-totals', directives: 'tabular, grand-totals' },
  { label: 'tabular + no-grand-totals', directives: 'tabular, no-grand-totals' },
  { label: 'tabular + no-row-totals', directives: 'tabular, no-row-totals' },
  { label: 'tabular + no-column-totals', directives: 'tabular, no-column-totals' },
  { label: 'outline + repeat-labels', directives: 'outline, repeat-labels' },
  { label: 'outline + no-repeat-labels', directives: 'outline, no-repeat-labels' },
  { label: 'compact + subtotals-top', directives: 'compact, subtotals-top' },
  { label: 'compact + subtotals-bottom', directives: 'compact, subtotals-bottom' },
  { label: 'compact + subtotals-off', directives: 'compact, subtotals-off' },
  { label: 'tabular + values-on-rows', directives: 'tabular, values-on-rows' },
  { label: 'tabular + values-on-columns', directives: 'tabular, values-on-columns' },
  { label: 'compact + auto-fit', directives: 'compact, auto-fit' },
  { label: 'tabular + show-empty-rows + show-empty-cols', directives: 'tabular, show-empty-rows, show-empty-cols' },
  { label: 'outline + grand-totals + repeat-labels + auto-fit', directives: 'outline, grand-totals, repeat-labels, auto-fit' },
  { label: 'compact + no-row-totals + no-column-totals', directives: 'compact, no-row-totals, no-column-totals' },
];

describe('layout directive combinations', () => {
  for (const { label, directives } of LAYOUT_COMBOS) {
    it(label, () => {
      const dsl = `ROWS: Region\nVALUES: sum(Sales)\nLAYOUT: ${directives}`;
      const result = run(dsl);
      expectNoErrors(result);
      expect(result.layout).toBeDefined();
    });
  }
});
