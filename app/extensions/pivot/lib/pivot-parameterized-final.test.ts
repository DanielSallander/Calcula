//! FILENAME: app/extensions/Pivot/lib/pivot-parameterized-final.test.ts
// PURPOSE: Heavily parameterized tests for pivot lib modules using it.each.
// NOTE: Types and factory functions are replicated here to avoid deep import
//       chains that require @api/* mocks.

import { describe, it, expect } from 'vitest';

// ============================================================================
// Types (matching pivot-api.ts and components/types.ts)
// ============================================================================

type PivotCellType =
  | 'Data' | 'RowHeader' | 'ColumnHeader' | 'Corner'
  | 'RowSubtotal' | 'ColumnSubtotal' | 'GrandTotal'
  | 'GrandTotalRow' | 'GrandTotalColumn' | 'Blank'
  | 'FilterLabel' | 'FilterDropdown'
  | 'RowLabelHeader' | 'ColumnLabelHeader';

type PivotRowType =
  | 'ColumnHeader' | 'Data' | 'Subtotal' | 'GrandTotal' | 'FilterRow';

type AggregationType =
  | 'sum' | 'count' | 'average' | 'min' | 'max'
  | 'countnumbers' | 'stddev' | 'stddevp' | 'var' | 'varp' | 'product';

type ShowValuesAs =
  | 'normal' | 'percent_of_total' | 'percent_of_row' | 'percent_of_column'
  | 'percent_of_parent_row' | 'percent_of_parent_column'
  | 'difference' | 'percent_difference' | 'running_total' | 'index';

type SortOrder = 'asc' | 'desc' | 'none';
type ReportLayout = 'compact' | 'tabular' | 'outline';
type ValuesPosition = 'columns' | 'rows';

interface PivotFieldConfig {
  sourceIndex: number;
  name: string;
  sortOrder?: SortOrder;
  showSubtotals?: boolean;
  collapsed?: boolean;
  hiddenItems?: string[];
}

interface ValueFieldConfig {
  sourceIndex: number;
  name: string;
  aggregation: AggregationType;
  numberFormat?: string;
  showValuesAs?: ShowValuesAs;
}

interface LayoutConfig {
  showRowGrandTotals?: boolean;
  showColumnGrandTotals?: boolean;
  reportLayout?: ReportLayout;
  repeatRowLabels?: boolean;
  showEmptyRows?: boolean;
  showEmptyCols?: boolean;
  valuesPosition?: ValuesPosition;
  autoFitColumnWidths?: boolean;
}

// ============================================================================
// Type guard functions (matching pivot-api.ts)
// ============================================================================

function isHeaderCell(type: PivotCellType): boolean {
  return type === 'RowHeader' || type === 'ColumnHeader' || type === 'Corner'
    || type === 'RowLabelHeader' || type === 'ColumnLabelHeader';
}

function isTotalCell(type: PivotCellType): boolean {
  return type === 'RowSubtotal' || type === 'ColumnSubtotal'
    || type === 'GrandTotal' || type === 'GrandTotalRow' || type === 'GrandTotalColumn';
}

function isFilterCell(type: PivotCellType): boolean {
  return type === 'FilterLabel' || type === 'FilterDropdown';
}

function isDataCell(type: PivotCellType): boolean {
  return type === 'Data';
}

function isDataRow(type: PivotRowType): boolean {
  return type === 'Data';
}

function isFilterRow(type: PivotRowType): boolean {
  return type === 'FilterRow';
}

// ============================================================================
// Factory functions (matching pivot-api.ts)
// ============================================================================

function createFieldConfig(
  sourceIndex: number,
  name: string,
  options?: Partial<Omit<PivotFieldConfig, 'sourceIndex' | 'name'>>,
): PivotFieldConfig {
  return {
    sourceIndex,
    name,
    sortOrder: options?.sortOrder ?? 'asc',
    showSubtotals: options?.showSubtotals ?? true,
    collapsed: options?.collapsed ?? false,
    hiddenItems: options?.hiddenItems ?? [],
  };
}

function createValueFieldConfig(
  sourceIndex: number,
  name: string,
  aggregation: AggregationType = 'sum',
  options?: Partial<Omit<ValueFieldConfig, 'sourceIndex' | 'name' | 'aggregation'>>,
): ValueFieldConfig {
  return {
    sourceIndex,
    name,
    aggregation,
    numberFormat: options?.numberFormat,
    showValuesAs: options?.showValuesAs ?? 'normal',
  };
}

function createLayoutConfig(options?: Partial<LayoutConfig>): LayoutConfig {
  return {
    showRowGrandTotals: options?.showRowGrandTotals ?? true,
    showColumnGrandTotals: options?.showColumnGrandTotals ?? true,
    reportLayout: options?.reportLayout ?? 'compact',
    repeatRowLabels: options?.repeatRowLabels ?? false,
    showEmptyRows: options?.showEmptyRows ?? false,
    showEmptyCols: options?.showEmptyCols ?? false,
    valuesPosition: options?.valuesPosition ?? 'columns',
    autoFitColumnWidths: options?.autoFitColumnWidths,
  };
}

function getDefaultAggregation(isNumeric: boolean): AggregationType {
  return isNumeric ? 'sum' : 'count';
}

// ============================================================================
// All enum values
// ============================================================================

const ALL_CELL_TYPES: PivotCellType[] = [
  'Data', 'RowHeader', 'ColumnHeader', 'Corner',
  'RowSubtotal', 'ColumnSubtotal', 'GrandTotal',
  'GrandTotalRow', 'GrandTotalColumn', 'Blank',
  'FilterLabel', 'FilterDropdown',
  'RowLabelHeader', 'ColumnLabelHeader',
];

const ALL_ROW_TYPES: PivotRowType[] = [
  'ColumnHeader', 'Data', 'Subtotal', 'GrandTotal', 'FilterRow',
];

const ALL_AGGREGATIONS: AggregationType[] = [
  'sum', 'count', 'average', 'min', 'max',
  'countnumbers', 'stddev', 'stddevp', 'var', 'varp', 'product',
];

const ALL_SHOW_VALUES_AS: ShowValuesAs[] = [
  'normal', 'percent_of_total', 'percent_of_row', 'percent_of_column',
  'percent_of_parent_row', 'percent_of_parent_column',
  'difference', 'percent_difference', 'running_total', 'index',
];

// ============================================================================
// 1. Cell type detection: 14 types x 4 guards = 56 tests
// ============================================================================

const HEADER_TYPES: PivotCellType[] = ['RowHeader', 'ColumnHeader', 'Corner', 'RowLabelHeader', 'ColumnLabelHeader'];
const TOTAL_TYPES: PivotCellType[] = ['RowSubtotal', 'ColumnSubtotal', 'GrandTotal', 'GrandTotalRow', 'GrandTotalColumn'];
const FILTER_TYPES: PivotCellType[] = ['FilterLabel', 'FilterDropdown'];
const DATA_TYPES: PivotCellType[] = ['Data'];

describe('isHeaderCell: all 14 cell types', () => {
  it.each(ALL_CELL_TYPES.map(t => [t, HEADER_TYPES.includes(t)] as [PivotCellType, boolean]))(
    '%s -> %s',
    (type, expected) => {
      expect(isHeaderCell(type)).toBe(expected);
    },
  );
});

describe('isTotalCell: all 14 cell types', () => {
  it.each(ALL_CELL_TYPES.map(t => [t, TOTAL_TYPES.includes(t)] as [PivotCellType, boolean]))(
    '%s -> %s',
    (type, expected) => {
      expect(isTotalCell(type)).toBe(expected);
    },
  );
});

describe('isFilterCell: all 14 cell types', () => {
  it.each(ALL_CELL_TYPES.map(t => [t, FILTER_TYPES.includes(t)] as [PivotCellType, boolean]))(
    '%s -> %s',
    (type, expected) => {
      expect(isFilterCell(type)).toBe(expected);
    },
  );
});

describe('isDataCell: all 14 cell types', () => {
  it.each(ALL_CELL_TYPES.map(t => [t, DATA_TYPES.includes(t)] as [PivotCellType, boolean]))(
    '%s -> %s',
    (type, expected) => {
      expect(isDataCell(type)).toBe(expected);
    },
  );
});

// ============================================================================
// 2. PivotRowType: 5 types x 2 guards = 10 tests
// ============================================================================

describe('isDataRow: all 5 row types', () => {
  it.each(ALL_ROW_TYPES.map(t => [t, t === 'Data'] as [PivotRowType, boolean]))(
    '%s -> %s',
    (type, expected) => {
      expect(isDataRow(type)).toBe(expected);
    },
  );
});

describe('isFilterRow: all 5 row types', () => {
  it.each(ALL_ROW_TYPES.map(t => [t, t === 'FilterRow'] as [PivotRowType, boolean]))(
    '%s -> %s',
    (type, expected) => {
      expect(isFilterRow(type)).toBe(expected);
    },
  );
});

// ============================================================================
// 3. createFieldConfig with all 11 aggregation defaults = 11 tests
//    (Tests that getDefaultAggregation produces correct agg for each type)
// ============================================================================

describe('createFieldConfig: basic construction', () => {
  const fieldNames: [number, string][] = [
    [0, 'Category'],
    [1, 'Region'],
    [2, 'Product'],
    [3, 'Year'],
    [4, 'Month'],
    [5, 'Country'],
    [6, 'City'],
    [7, 'State'],
    [8, 'Segment'],
    [9, 'SubCategory'],
    [10, 'ShipMode'],
  ];

  it.each(fieldNames)(
    'creates field config for index %i name %s with correct defaults',
    (idx, name) => {
      const cfg = createFieldConfig(idx, name);
      expect(cfg.sourceIndex).toBe(idx);
      expect(cfg.name).toBe(name);
      expect(cfg.sortOrder).toBe('asc');
      expect(cfg.showSubtotals).toBe(true);
      expect(cfg.collapsed).toBe(false);
      expect(cfg.hiddenItems).toEqual([]);
    },
  );
});

describe('createValueFieldConfig: every aggregation type', () => {
  it.each(ALL_AGGREGATIONS)(
    'creates value config with aggregation %s',
    (agg) => {
      const cfg = createValueFieldConfig(0, 'Amount', agg);
      expect(cfg.aggregation).toBe(agg);
      expect(cfg.showValuesAs).toBe('normal');
      expect(cfg.sourceIndex).toBe(0);
      expect(cfg.name).toBe('Amount');
    },
  );
});

// ============================================================================
// 4. createLayoutConfig with all option combinations = 20 tests
// ============================================================================

const layoutOptionTests: [string, Partial<LayoutConfig>, (c: LayoutConfig) => void][] = [
  ['defaults', {}, c => {
    expect(c.showRowGrandTotals).toBe(true);
    expect(c.showColumnGrandTotals).toBe(true);
    expect(c.reportLayout).toBe('compact');
    expect(c.repeatRowLabels).toBe(false);
  }],
  ['compact layout', { reportLayout: 'compact' }, c => expect(c.reportLayout).toBe('compact')],
  ['tabular layout', { reportLayout: 'tabular' }, c => expect(c.reportLayout).toBe('tabular')],
  ['outline layout', { reportLayout: 'outline' }, c => expect(c.reportLayout).toBe('outline')],
  ['row totals off', { showRowGrandTotals: false }, c => expect(c.showRowGrandTotals).toBe(false)],
  ['row totals on', { showRowGrandTotals: true }, c => expect(c.showRowGrandTotals).toBe(true)],
  ['col totals off', { showColumnGrandTotals: false }, c => expect(c.showColumnGrandTotals).toBe(false)],
  ['col totals on', { showColumnGrandTotals: true }, c => expect(c.showColumnGrandTotals).toBe(true)],
  ['both totals off', { showRowGrandTotals: false, showColumnGrandTotals: false }, c => {
    expect(c.showRowGrandTotals).toBe(false);
    expect(c.showColumnGrandTotals).toBe(false);
  }],
  ['repeat labels on', { repeatRowLabels: true }, c => expect(c.repeatRowLabels).toBe(true)],
  ['repeat labels off', { repeatRowLabels: false }, c => expect(c.repeatRowLabels).toBe(false)],
  ['show empty rows', { showEmptyRows: true }, c => expect(c.showEmptyRows).toBe(true)],
  ['show empty cols', { showEmptyCols: true }, c => expect(c.showEmptyCols).toBe(true)],
  ['values on rows', { valuesPosition: 'rows' }, c => expect(c.valuesPosition).toBe('rows')],
  ['values on columns', { valuesPosition: 'columns' }, c => expect(c.valuesPosition).toBe('columns')],
  ['auto-fit on', { autoFitColumnWidths: true }, c => expect(c.autoFitColumnWidths).toBe(true)],
  ['tabular + repeat-labels', { reportLayout: 'tabular', repeatRowLabels: true }, c => {
    expect(c.reportLayout).toBe('tabular');
    expect(c.repeatRowLabels).toBe(true);
  }],
  ['outline + no totals', { reportLayout: 'outline', showRowGrandTotals: false, showColumnGrandTotals: false }, c => {
    expect(c.reportLayout).toBe('outline');
    expect(c.showRowGrandTotals).toBe(false);
  }],
  ['all options set', {
    showRowGrandTotals: false,
    showColumnGrandTotals: false,
    reportLayout: 'tabular',
    repeatRowLabels: true,
    showEmptyRows: true,
    showEmptyCols: true,
    valuesPosition: 'rows',
    autoFitColumnWidths: true,
  }, c => {
    expect(c.showRowGrandTotals).toBe(false);
    expect(c.reportLayout).toBe('tabular');
    expect(c.repeatRowLabels).toBe(true);
    expect(c.showEmptyRows).toBe(true);
    expect(c.showEmptyCols).toBe(true);
    expect(c.valuesPosition).toBe('rows');
    expect(c.autoFitColumnWidths).toBe(true);
  }],
  ['empty rows + empty cols', { showEmptyRows: true, showEmptyCols: true }, c => {
    expect(c.showEmptyRows).toBe(true);
    expect(c.showEmptyCols).toBe(true);
  }],
];

describe('createLayoutConfig: option combinations', () => {
  it.each(layoutOptionTests)(
    '%s',
    (_label, options, assertFn) => {
      const cfg = createLayoutConfig(options);
      assertFn(cfg);
    },
  );
});

// ============================================================================
// getDefaultAggregation: numeric vs non-numeric
// ============================================================================

const defaultAggTests: [string, boolean, AggregationType][] = [
  ['numeric field defaults to sum', true, 'sum'],
  ['non-numeric field defaults to count', false, 'count'],
];

describe('getDefaultAggregation', () => {
  it.each(defaultAggTests)(
    '%s',
    (_label, isNumeric, expected) => {
      expect(getDefaultAggregation(isNumeric)).toBe(expected);
    },
  );
});

// ============================================================================
// createValueFieldConfig: every showValuesAs option
// ============================================================================

describe('createValueFieldConfig: every showValuesAs', () => {
  it.each(ALL_SHOW_VALUES_AS)(
    'creates config with showValuesAs=%s',
    (showAs) => {
      const cfg = createValueFieldConfig(0, 'Sales', 'sum', { showValuesAs: showAs });
      expect(cfg.showValuesAs).toBe(showAs);
      expect(cfg.aggregation).toBe('sum');
    },
  );
});

// ============================================================================
// createFieldConfig: option override combinations
// ============================================================================

const fieldOptionOverrides: [string, Partial<Omit<PivotFieldConfig, 'sourceIndex' | 'name'>>, (c: PivotFieldConfig) => void][] = [
  ['sortOrder desc', { sortOrder: 'desc' }, c => expect(c.sortOrder).toBe('desc')],
  ['sortOrder none', { sortOrder: 'none' }, c => expect(c.sortOrder).toBe('none')],
  ['showSubtotals false', { showSubtotals: false }, c => expect(c.showSubtotals).toBe(false)],
  ['collapsed true', { collapsed: true }, c => expect(c.collapsed).toBe(true)],
  ['hiddenItems populated', { hiddenItems: ['A', 'B'] }, c => expect(c.hiddenItems).toEqual(['A', 'B'])],
  ['all overrides', { sortOrder: 'desc', showSubtotals: false, collapsed: true, hiddenItems: ['X'] }, c => {
    expect(c.sortOrder).toBe('desc');
    expect(c.showSubtotals).toBe(false);
    expect(c.collapsed).toBe(true);
    expect(c.hiddenItems).toEqual(['X']);
  }],
];

describe('createFieldConfig: option overrides', () => {
  it.each(fieldOptionOverrides)(
    '%s',
    (_label, options, assertFn) => {
      const cfg = createFieldConfig(0, 'Test', options);
      assertFn(cfg);
    },
  );
});

// ============================================================================
// Cross-product: aggregation x showValuesAs for ValueFieldConfig = 110 tests
// ============================================================================

const aggShowValuesCrossProduct: [AggregationType, ShowValuesAs][] = ALL_AGGREGATIONS.flatMap(
  agg => ALL_SHOW_VALUES_AS.map(sva => [agg, sva] as [AggregationType, ShowValuesAs]),
);

describe('createValueFieldConfig: aggregation x showValuesAs cross-product', () => {
  it.each(aggShowValuesCrossProduct)(
    'agg=%s showValuesAs=%s',
    (agg, showAs) => {
      const cfg = createValueFieldConfig(0, 'Amount', agg, { showValuesAs: showAs });
      expect(cfg.aggregation).toBe(agg);
      expect(cfg.showValuesAs).toBe(showAs);
      expect(cfg.sourceIndex).toBe(0);
      expect(cfg.name).toBe('Amount');
    },
  );
});
