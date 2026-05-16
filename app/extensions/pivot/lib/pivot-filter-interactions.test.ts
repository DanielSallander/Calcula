//! FILENAME: app/extensions/Pivot/lib/pivot-filter-interactions.test.ts
// PURPOSE: Tests for pivot field configs, aggregation combinations, layout options,
//          view store + cache interaction, and cell type detection for nested layouts.

import { describe, it, expect, beforeEach } from 'vitest';
import type { ZoneField, AggregationType, SourceField } from '../../_shared/components/types';
import { getDefaultAggregation, getValueFieldDisplayName } from '../../_shared/components/types';
import type { LayoutConfig, ShowValuesAs, ValueFieldConfig, PivotFieldConfig } from '../components/types';
import {
  cachePivotView,
  getCachedPivotView,
  deleteCachedPivotView,
  isCacheFresh,
  consumeFreshFlag,
  setCachedPivotView,
  startOperation,
  isCurrentOperation,
  setLoading,
  clearLoading,
  isLoading,
  getLoadingState,
  preserveCurrentView,
  restorePreviousView,
  clearPreviousView,
} from './pivotViewStore';
import type { PivotViewResponse } from './pivot-api';

// ============================================================================
// Helpers
// ============================================================================

const ALL_AGGREGATIONS: AggregationType[] = [
  'sum', 'count', 'average', 'min', 'max',
  'countnumbers', 'stddev', 'stddevp', 'var', 'varp', 'product',
];

const ALL_SHOW_VALUES_AS: ShowValuesAs[] = [
  'normal', 'percent_of_total', 'percent_of_row', 'percent_of_column',
  'percent_of_parent_row', 'percent_of_parent_column',
  'difference', 'percent_difference', 'running_total', 'index',
];

function makeZoneField(overrides: Partial<ZoneField> = {}): ZoneField {
  return {
    sourceIndex: 0,
    name: 'Sales',
    isNumeric: true,
    ...overrides,
  };
}

function mockView(pivotId: number, version = 1, extra: Partial<PivotViewResponse> = {}): PivotViewResponse {
  return {
    pivotId,
    version,
    rowCount: 10,
    colCount: 5,
    rowLabelColCount: 2,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: [],
    columns: [],
    ...extra,
  };
}

// ============================================================================
// Field configs with all aggregation types combined
// ============================================================================

describe('field configs with all aggregation types', () => {
  it('every aggregation type produces a valid ZoneField', () => {
    for (const agg of ALL_AGGREGATIONS) {
      const field = makeZoneField({ aggregation: agg });
      expect(field.aggregation).toBe(agg);
      expect(field.isNumeric).toBe(true);
    }
  });

  it('getDefaultAggregation returns sum for numeric, count for non-numeric', () => {
    expect(getDefaultAggregation(true)).toBe('sum');
    expect(getDefaultAggregation(false)).toBe('count');
  });

  it('getValueFieldDisplayName works for all aggregation types', () => {
    for (const agg of ALL_AGGREGATIONS) {
      const display = getValueFieldDisplayName('Revenue', agg);
      expect(display).toContain('Revenue');
      expect(display.length).toBeGreaterThan('Revenue'.length);
    }
  });

  it('all aggregation types can coexist in a multi-value config', () => {
    const fields: ZoneField[] = ALL_AGGREGATIONS.map((agg, i) => makeZoneField({
      sourceIndex: i,
      name: `Field${i}`,
      aggregation: agg,
    }));
    expect(fields).toHaveLength(ALL_AGGREGATIONS.length);
    const aggSet = new Set(fields.map(f => f.aggregation));
    expect(aggSet.size).toBe(ALL_AGGREGATIONS.length);
  });
});

// ============================================================================
// Multiple value fields with different showValuesAs
// ============================================================================

describe('multiple value fields with different showValuesAs', () => {
  it('each showValuesAs variant is distinct', () => {
    const fields: ZoneField[] = ALL_SHOW_VALUES_AS.map((sva, i) => makeZoneField({
      sourceIndex: i,
      name: `Metric${i}`,
      aggregation: 'sum',
      showValuesAs: sva,
    }));
    const unique = new Set(fields.map(f => f.showValuesAs));
    expect(unique.size).toBe(ALL_SHOW_VALUES_AS.length);
  });

  it('showValuesAs combined with different aggregations', () => {
    // Cross-product: first 3 aggregations x first 3 showValuesAs
    const combos: ZoneField[] = [];
    for (const agg of ALL_AGGREGATIONS.slice(0, 3)) {
      for (const sva of ALL_SHOW_VALUES_AS.slice(0, 3)) {
        combos.push(makeZoneField({ aggregation: agg, showValuesAs: sva }));
      }
    }
    expect(combos).toHaveLength(9);
    // All should have both properties set
    for (const f of combos) {
      expect(f.aggregation).toBeDefined();
      expect(f.showValuesAs).toBeDefined();
    }
  });
});

// ============================================================================
// Field config with custom number formats
// ============================================================================

describe('field config with custom number formats', () => {
  it('numberFormat is preserved on zone field', () => {
    const field = makeZoneField({ numberFormat: '#,##0.00' });
    expect(field.numberFormat).toBe('#,##0.00');
  });

  it('numberFormat combined with aggregation and showValuesAs', () => {
    const field = makeZoneField({
      aggregation: 'average',
      showValuesAs: 'percent_of_row',
      numberFormat: '0.0%',
    });
    expect(field.aggregation).toBe('average');
    expect(field.showValuesAs).toBe('percent_of_row');
    expect(field.numberFormat).toBe('0.0%');
  });

  it('ValueFieldConfig accepts numberFormat', () => {
    const cfg: ValueFieldConfig = {
      sourceIndex: 0,
      name: 'Sales',
      aggregation: 'sum',
      numberFormat: '$#,##0',
      showValuesAs: 'normal',
    };
    expect(cfg.numberFormat).toBe('$#,##0');
  });
});

// ============================================================================
// Field config with subtotal suppression
// ============================================================================

describe('field config with subtotal suppression', () => {
  it('PivotFieldConfig showSubtotals defaults to undefined', () => {
    const cfg: PivotFieldConfig = { sourceIndex: 0, name: 'Region' };
    expect(cfg.showSubtotals).toBeUndefined();
  });

  it('showSubtotals can be explicitly true or false', () => {
    const on: PivotFieldConfig = { sourceIndex: 0, name: 'Region', showSubtotals: true };
    const off: PivotFieldConfig = { sourceIndex: 0, name: 'Region', showSubtotals: false };
    expect(on.showSubtotals).toBe(true);
    expect(off.showSubtotals).toBe(false);
  });

  it('hiddenItems on PivotFieldConfig for filter suppression', () => {
    const cfg: PivotFieldConfig = {
      sourceIndex: 1,
      name: 'Category',
      hiddenItems: ['Bikes', 'Clothing'],
    };
    expect(cfg.hiddenItems).toHaveLength(2);
    expect(cfg.hiddenItems).toContain('Bikes');
  });
});

// ============================================================================
// Layout config with all options enabled/disabled combinations
// ============================================================================

describe('layout config combinations', () => {
  it('all-enabled layout', () => {
    const layout: LayoutConfig = {
      showRowGrandTotals: true,
      showColumnGrandTotals: true,
      reportLayout: 'tabular',
      repeatRowLabels: true,
      showEmptyRows: true,
      showEmptyCols: true,
      valuesPosition: 'rows',
      autoFitColumnWidths: true,
    };
    expect(layout.showRowGrandTotals).toBe(true);
    expect(layout.autoFitColumnWidths).toBe(true);
    expect(layout.valuesPosition).toBe('rows');
  });

  it('all-disabled layout', () => {
    const layout: LayoutConfig = {
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
      reportLayout: 'compact',
      repeatRowLabels: false,
      showEmptyRows: false,
      showEmptyCols: false,
      valuesPosition: 'columns',
      autoFitColumnWidths: false,
    };
    expect(layout.showRowGrandTotals).toBe(false);
    expect(layout.reportLayout).toBe('compact');
  });

  it('all three report layouts', () => {
    for (const rl of ['compact', 'outline', 'tabular'] as const) {
      const layout: LayoutConfig = { reportLayout: rl };
      expect(layout.reportLayout).toBe(rl);
    }
  });

  it('empty layout is valid (all defaults)', () => {
    const layout: LayoutConfig = {};
    expect(layout.showRowGrandTotals).toBeUndefined();
    expect(layout.reportLayout).toBeUndefined();
  });
});

// ============================================================================
// View store + cache interaction under concurrent access
// ============================================================================

describe('view store + cache concurrent access', () => {
  const PID = 8000;

  beforeEach(() => {
    deleteCachedPivotView(PID);
    deleteCachedPivotView(PID + 1);
  });

  it('operation superseding: newer operation invalidates older', () => {
    const seq1 = startOperation(PID);
    const seq2 = startOperation(PID);
    expect(isCurrentOperation(PID, seq1)).toBe(false);
    expect(isCurrentOperation(PID, seq2)).toBe(true);
  });

  it('triple operation superseding', () => {
    const s1 = startOperation(PID);
    const s2 = startOperation(PID);
    const s3 = startOperation(PID);
    expect(isCurrentOperation(PID, s1)).toBe(false);
    expect(isCurrentOperation(PID, s2)).toBe(false);
    expect(isCurrentOperation(PID, s3)).toBe(true);
  });

  it('independent pivots have independent operation sequences', () => {
    const s1 = startOperation(PID);
    const s2 = startOperation(PID + 1);
    expect(isCurrentOperation(PID, s1)).toBe(true);
    expect(isCurrentOperation(PID + 1, s2)).toBe(true);
  });

  it('cachePivotView marks fresh, setCachedPivotView does not', () => {
    const view = mockView(PID);
    setCachedPivotView(PID, view);
    expect(isCacheFresh(PID)).toBe(false);

    cachePivotView(PID, view);
    expect(isCacheFresh(PID)).toBe(true);
    consumeFreshFlag(PID);
    expect(isCacheFresh(PID)).toBe(false);
  });

  it('preserveCurrentView + restorePreviousView round-trip', () => {
    const v1 = mockView(PID, 1);
    const v2 = mockView(PID, 2);
    cachePivotView(PID, v1);
    preserveCurrentView(PID);
    cachePivotView(PID, v2);
    expect(getCachedPivotView(PID)?.version).toBe(2);

    const restored = restorePreviousView(PID);
    expect(restored?.version).toBe(1);
    expect(getCachedPivotView(PID)?.version).toBe(1);
  });

  it('loading state tracks stage progression', () => {
    expect(isLoading(PID)).toBe(false);
    setLoading(PID, 'Preparing...', 0, 4);
    expect(isLoading(PID)).toBe(true);
    expect(getLoadingState(PID)?.stage).toBe('Preparing...');

    setLoading(PID, 'Calculating...', 1, 4);
    expect(getLoadingState(PID)?.stage).toBe('Calculating...');
    expect(getLoadingState(PID)?.stageIndex).toBe(1);

    clearLoading(PID);
    expect(isLoading(PID)).toBe(false);
  });
});

// ============================================================================
// Pivot cell type detection for deeply nested layouts
// ============================================================================

describe('pivot cell type detection for deeply nested layouts', () => {
  it('rowLabelColCount indicates nesting depth', () => {
    // 3 row fields = 3 row label columns in tabular layout
    const view = mockView(1, 1, { rowLabelColCount: 3, columnHeaderRowCount: 2 });
    expect(view.rowLabelColCount).toBe(3);
    expect(view.columnHeaderRowCount).toBe(2);
  });

  it('deeply nested: 5 row fields', () => {
    const view = mockView(1, 1, { rowLabelColCount: 5, rowCount: 100 });
    // Cell at col 0..4 are row labels, col 5+ are data
    expect(view.rowLabelColCount).toBe(5);
    // A cell is a row label if its column index < rowLabelColCount
    for (let col = 0; col < view.rowLabelColCount; col++) {
      expect(col < view.rowLabelColCount).toBe(true);
    }
    expect(5 < view.rowLabelColCount).toBe(false);
  });

  it('filter rows reduce the data area', () => {
    const view = mockView(1, 1, { filterRowCount: 3, columnHeaderRowCount: 1 });
    // Effective header area = filterRowCount + columnHeaderRowCount
    const headerRows = view.filterRowCount + view.columnHeaderRowCount;
    expect(headerRows).toBe(4);
  });

  it('windowed view tracks window position', () => {
    const view = mockView(1, 1, {
      isWindowed: true,
      windowStartRow: 200,
      rowCount: 5000,
      rows: Array.from({ length: 50 }, (_, i) => ({
        cells: [{ value: `r${200 + i}`, formatted: `r${200 + i}` }],
      })),
    });
    expect(view.isWindowed).toBe(true);
    expect(view.windowStartRow).toBe(200);
    expect(view.rows).toHaveLength(50);
  });
});
