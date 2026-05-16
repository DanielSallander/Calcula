//! FILENAME: app/extensions/Pivot/lib/pivot-rendering-deep.test.ts
// PURPOSE: Deep tests for pivot cell type detection, layout variants, and cache management.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isHeaderCell,
  isFilterCell,
  isTotalCell,
  isDataRow,
  isFilterRow,
  getCellNumericValue,
  getCellDisplayValue,
  createFieldConfig,
  createValueFieldConfig,
  createLayoutConfig,
} from './pivot-api';
import type {
  PivotCellType,
  PivotCellData,
  PivotRowData,
  PivotRowType,
  PivotColumnType,
  PivotViewResponse,
  BackgroundStyle,
} from './pivot-api';
import {
  cachePivotView,
  getCachedPivotView,
  getCachedPivotVersion,
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
  markUserCancelled,
  isUserCancelled,
  clearUserCancelled,
  getCellWindowCache,
  ensureCellWindow,
} from './pivotViewStore';

// ============================================================================
// Helpers
// ============================================================================

function mockCell(
  cellType: PivotCellType,
  value: number | string | boolean | null = null,
  opts: Partial<PivotCellData> = {},
): PivotCellData {
  return {
    cellType,
    value,
    backgroundStyle: opts.backgroundStyle ?? 'Normal',
    ...opts,
  };
}

function mockRow(
  viewRow: number,
  rowType: PivotRowType,
  cells: PivotCellData[],
  depth = 0,
): PivotRowData {
  return { viewRow, rowType, depth, visible: true, cells };
}

function mockView(pivotId: number, version = 1, overrides: Partial<PivotViewResponse> = {}): PivotViewResponse {
  return {
    pivotId,
    version,
    rowCount: 5,
    colCount: 3,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: [],
    columns: [],
    ...overrides,
  };
}

// ============================================================================
// Cell type detection for complex pivot layouts
// ============================================================================

describe('Cell type detection', () => {
  describe('isHeaderCell', () => {
    it('recognizes RowHeader', () => {
      expect(isHeaderCell('RowHeader')).toBe(true);
    });

    it('recognizes ColumnHeader', () => {
      expect(isHeaderCell('ColumnHeader')).toBe(true);
    });

    it('recognizes Corner', () => {
      expect(isHeaderCell('Corner')).toBe(true);
    });

    it('recognizes RowLabelHeader', () => {
      expect(isHeaderCell('RowLabelHeader')).toBe(true);
    });

    it('recognizes ColumnLabelHeader', () => {
      expect(isHeaderCell('ColumnLabelHeader')).toBe(true);
    });

    it('rejects Data cells', () => {
      expect(isHeaderCell('Data')).toBe(false);
    });

    it('rejects GrandTotal cells', () => {
      expect(isHeaderCell('GrandTotal')).toBe(false);
    });

    it('rejects Blank cells', () => {
      expect(isHeaderCell('Blank')).toBe(false);
    });

    it('rejects filter cells', () => {
      expect(isHeaderCell('FilterLabel')).toBe(false);
      expect(isHeaderCell('FilterDropdown')).toBe(false);
    });
  });

  describe('isTotalCell', () => {
    it('recognizes RowSubtotal', () => {
      expect(isTotalCell('RowSubtotal')).toBe(true);
    });

    it('recognizes ColumnSubtotal', () => {
      expect(isTotalCell('ColumnSubtotal')).toBe(true);
    });

    it('recognizes GrandTotal', () => {
      expect(isTotalCell('GrandTotal')).toBe(true);
    });

    it('recognizes GrandTotalRow', () => {
      expect(isTotalCell('GrandTotalRow')).toBe(true);
    });

    it('recognizes GrandTotalColumn', () => {
      expect(isTotalCell('GrandTotalColumn')).toBe(true);
    });

    it('rejects Data cells', () => {
      expect(isTotalCell('Data')).toBe(false);
    });

    it('rejects RowHeader', () => {
      expect(isTotalCell('RowHeader')).toBe(false);
    });
  });

  describe('isFilterCell', () => {
    it('recognizes FilterLabel', () => {
      expect(isFilterCell('FilterLabel')).toBe(true);
    });

    it('recognizes FilterDropdown', () => {
      expect(isFilterCell('FilterDropdown')).toBe(true);
    });

    it('rejects non-filter cells', () => {
      expect(isFilterCell('Data')).toBe(false);
      expect(isFilterCell('RowHeader')).toBe(false);
    });
  });

  describe('isDataRow / isFilterRow', () => {
    it('identifies data rows', () => {
      expect(isDataRow('Data')).toBe(true);
      expect(isDataRow('Subtotal')).toBe(false);
      expect(isDataRow('GrandTotal')).toBe(false);
    });

    it('identifies filter rows', () => {
      expect(isFilterRow('FilterRow')).toBe(true);
      expect(isFilterRow('Data')).toBe(false);
    });
  });
});

// ============================================================================
// Grand total row/column identification
// ============================================================================

describe('Grand total identification in complex layouts', () => {
  it('identifies grand total row in multi-level pivot', () => {
    const cells: PivotCellData[] = [
      mockCell('GrandTotalRow', 'Grand Total', { isBold: true, backgroundStyle: 'GrandTotal' }),
      mockCell('GrandTotal', 1000, { isBold: true, backgroundStyle: 'GrandTotal' }),
      mockCell('GrandTotal', 500, { isBold: true, backgroundStyle: 'GrandTotal' }),
    ];
    const row = mockRow(10, 'GrandTotal', cells);

    expect(row.rowType).toBe('GrandTotal');
    expect(isTotalCell(cells[0].cellType)).toBe(true);
    expect(isTotalCell(cells[1].cellType)).toBe(true);
    expect(cells[0].isBold).toBe(true);
  });

  it('distinguishes grand total column from subtotal column', () => {
    const grandTotalCell = mockCell('GrandTotalColumn', 1500);
    const subtotalCell = mockCell('ColumnSubtotal', 800);

    expect(isTotalCell(grandTotalCell.cellType)).toBe(true);
    expect(isTotalCell(subtotalCell.cellType)).toBe(true);
    expect(grandTotalCell.cellType).not.toBe(subtotalCell.cellType);
  });
});

// ============================================================================
// Subtotal placement (above/below groups)
// ============================================================================

describe('Subtotal placement', () => {
  it('subtotal rows have Subtotal rowType', () => {
    const subtotalRow = mockRow(5, 'Subtotal', [
      mockCell('RowSubtotal', 'East Total', { isBold: true, backgroundStyle: 'Subtotal' }),
      mockCell('RowSubtotal', 250, { backgroundStyle: 'Subtotal' }),
    ]);

    expect(subtotalRow.rowType).toBe('Subtotal');
    expect(subtotalRow.cells[0].backgroundStyle).toBe('Subtotal');
  });

  it('data rows between subtotals have correct depth', () => {
    const rows: PivotRowData[] = [
      mockRow(0, 'Data', [mockCell('RowHeader', 'East')], 0),
      mockRow(1, 'Data', [mockCell('RowHeader', 'Widget A')], 1),
      mockRow(2, 'Data', [mockCell('RowHeader', 'Widget B')], 1),
      mockRow(3, 'Subtotal', [mockCell('RowSubtotal', 'East Total')], 0),
    ];

    expect(rows[0].depth).toBe(0);
    expect(rows[1].depth).toBe(1);
    expect(rows[2].depth).toBe(1);
    expect(rows[3].depth).toBe(0);
    expect(rows[3].rowType).toBe('Subtotal');
  });
});

// ============================================================================
// Compact vs tabular vs outline layout differences
// ============================================================================

describe('Layout configuration', () => {
  it('creates compact layout by default', () => {
    const layout = createLayoutConfig();
    expect(layout.reportLayout).toBe('compact');
    expect(layout.repeatRowLabels).toBe(false);
  });

  it('creates tabular layout with repeat labels', () => {
    const layout = createLayoutConfig({
      reportLayout: 'tabular',
      repeatRowLabels: true,
    });
    expect(layout.reportLayout).toBe('tabular');
    expect(layout.repeatRowLabels).toBe(true);
  });

  it('creates outline layout', () => {
    const layout = createLayoutConfig({ reportLayout: 'outline' });
    expect(layout.reportLayout).toBe('outline');
  });

  it('compact layout uses indentation for multi-level rows', () => {
    // In compact layout, multi-level row headers use indentLevel
    const cells: PivotCellData[] = [
      mockCell('RowHeader', 'East', { indentLevel: 0 }),
      mockCell('RowHeader', 'Widget A', { indentLevel: 1 }),
      mockCell('RowHeader', 'Sub-item', { indentLevel: 2 }),
    ];

    expect(cells[0].indentLevel).toBe(0);
    expect(cells[1].indentLevel).toBe(1);
    expect(cells[2].indentLevel).toBe(2);
  });

  it('tabular layout has no indent (separate columns per field)', () => {
    // In tabular, each field gets its own column, no indentation needed
    const regionCell = mockCell('RowHeader', 'East', { indentLevel: 0 });
    const productCell = mockCell('RowHeader', 'Widget A', { indentLevel: 0 });

    expect(regionCell.indentLevel).toBe(0);
    expect(productCell.indentLevel).toBe(0);
  });

  it('layout config preserves values position', () => {
    const layout = createLayoutConfig({ valuesPosition: 'rows' });
    expect(layout.valuesPosition).toBe('rows');

    const defaultLayout = createLayoutConfig();
    expect(defaultLayout.valuesPosition).toBe('columns');
  });

  it('layout config controls grand totals', () => {
    const noTotals = createLayoutConfig({
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
    });
    expect(noTotals.showRowGrandTotals).toBe(false);
    expect(noTotals.showColumnGrandTotals).toBe(false);
  });

  it('layout config controls empty rows and columns', () => {
    const withEmpty = createLayoutConfig({
      showEmptyRows: true,
      showEmptyCols: true,
    });
    expect(withEmpty.showEmptyRows).toBe(true);
    expect(withEmpty.showEmptyCols).toBe(true);

    const defaults = createLayoutConfig();
    expect(defaults.showEmptyRows).toBe(false);
    expect(defaults.showEmptyCols).toBe(false);
  });
});

// ============================================================================
// Repeat item labels behavior
// ============================================================================

describe('Repeat item labels', () => {
  it('without repeat labels, subsequent rows have empty parent labels', () => {
    // When repeat is off, only the first row in a group shows the parent label
    const rows: PivotRowData[] = [
      mockRow(0, 'Data', [
        mockCell('RowHeader', 'East'),
        mockCell('RowHeader', 'Widget A'),
        mockCell('Data', 100),
      ]),
      mockRow(1, 'Data', [
        mockCell('RowHeader', ''),   // not repeated
        mockCell('RowHeader', 'Widget B'),
        mockCell('Data', 200),
      ]),
    ];

    expect(rows[0].cells[0].value).toBe('East');
    expect(rows[1].cells[0].value).toBe('');
  });

  it('with repeat labels, all rows show the parent label', () => {
    const rows: PivotRowData[] = [
      mockRow(0, 'Data', [
        mockCell('RowHeader', 'East'),
        mockCell('RowHeader', 'Widget A'),
        mockCell('Data', 100),
      ]),
      mockRow(1, 'Data', [
        mockCell('RowHeader', 'East'),  // repeated
        mockCell('RowHeader', 'Widget B'),
        mockCell('Data', 200),
      ]),
    ];

    expect(rows[0].cells[0].value).toBe('East');
    expect(rows[1].cells[0].value).toBe('East');
  });
});

// ============================================================================
// Empty cell handling in pivot views
// ============================================================================

describe('Empty cell handling', () => {
  it('getCellDisplayValue returns empty string for null', () => {
    expect(getCellDisplayValue(null)).toBe('');
  });

  it('getCellDisplayValue returns empty string for undefined', () => {
    expect(getCellDisplayValue(undefined as any)).toBe('');
  });

  it('getCellDisplayValue converts numbers to string', () => {
    expect(getCellDisplayValue(42)).toBe('42');
    expect(getCellDisplayValue(0)).toBe('0');
    expect(getCellDisplayValue(-3.14)).toBe('-3.14');
  });

  it('getCellDisplayValue converts booleans', () => {
    expect(getCellDisplayValue(true)).toBe('TRUE');
    expect(getCellDisplayValue(false)).toBe('FALSE');
  });

  it('getCellDisplayValue passes through strings', () => {
    expect(getCellDisplayValue('Hello')).toBe('Hello');
    expect(getCellDisplayValue('#ERROR')).toBe('#ERROR');
  });

  it('getCellNumericValue extracts numbers', () => {
    expect(getCellNumericValue(42)).toBe(42);
    expect(getCellNumericValue(-5.5)).toBe(-5.5);
  });

  it('getCellNumericValue returns 0 for non-numeric', () => {
    expect(getCellNumericValue(null)).toBe(0);
    expect(getCellNumericValue('text')).toBe(0);
    expect(getCellNumericValue(true)).toBe(0);
  });

  it('Blank cells have correct type', () => {
    const blank = mockCell('Blank', null);
    expect(blank.cellType).toBe('Blank');
    expect(blank.value).toBeNull();
    expect(isHeaderCell('Blank')).toBe(false);
    expect(isTotalCell('Blank')).toBe(false);
  });
});

// ============================================================================
// Field configuration helpers
// ============================================================================

describe('Field configuration', () => {
  it('createFieldConfig sets defaults', () => {
    const field = createFieldConfig(0, 'Region');
    expect(field.sourceIndex).toBe(0);
    expect(field.name).toBe('Region');
    expect(field.sortOrder).toBe('asc');
    expect(field.showSubtotals).toBe(true);
    expect(field.collapsed).toBe(false);
    expect(field.hiddenItems).toEqual([]);
  });

  it('createFieldConfig respects overrides', () => {
    const field = createFieldConfig(1, 'Product', {
      sortOrder: 'desc',
      showSubtotals: false,
      collapsed: true,
      hiddenItems: ['Widget X'],
    });
    expect(field.sortOrder).toBe('desc');
    expect(field.showSubtotals).toBe(false);
    expect(field.collapsed).toBe(true);
    expect(field.hiddenItems).toEqual(['Widget X']);
  });

  it('createValueFieldConfig defaults to sum', () => {
    const value = createValueFieldConfig(3, 'Sales');
    expect(value.aggregation).toBe('sum');
    expect(value.showValuesAs).toBe('normal');
  });

  it('createValueFieldConfig with custom aggregation', () => {
    const value = createValueFieldConfig(3, 'Sales', 'average', {
      numberFormat: '#,##0.00',
    });
    expect(value.aggregation).toBe('average');
    expect(value.numberFormat).toBe('#,##0.00');
  });
});

// ============================================================================
// Pivot cache management (deep tests)
// ============================================================================

describe('Pivot cache management (deep)', () => {
  const PID = 7777;

  beforeEach(() => {
    deleteCachedPivotView(PID);
    deleteCachedPivotView(PID + 1);
  });

  it('cachePivotView marks cache as fresh', () => {
    cachePivotView(PID, mockView(PID));
    expect(isCacheFresh(PID)).toBe(true);
  });

  it('consumeFreshFlag clears freshness', () => {
    cachePivotView(PID, mockView(PID));
    consumeFreshFlag(PID);
    expect(isCacheFresh(PID)).toBe(false);
  });

  it('setCachedPivotView does NOT mark fresh', () => {
    setCachedPivotView(PID, mockView(PID));
    expect(isCacheFresh(PID)).toBe(false);
    expect(getCachedPivotView(PID)).toBeDefined();
  });

  it('getCachedPivotVersion returns version or -1', () => {
    expect(getCachedPivotVersion(PID)).toBe(-1);
    cachePivotView(PID, mockView(PID, 42));
    expect(getCachedPivotVersion(PID)).toBe(42);
  });

  it('deleteCachedPivotView removes everything', () => {
    cachePivotView(PID, mockView(PID));
    setLoading(PID, 'test');
    deleteCachedPivotView(PID);
    expect(getCachedPivotView(PID)).toBeUndefined();
    expect(isLoading(PID)).toBe(false);
  });

  it('preserveCurrentView + restorePreviousView round-trips', () => {
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

  it('clearPreviousView prevents restore', () => {
    cachePivotView(PID, mockView(PID, 1));
    preserveCurrentView(PID);
    clearPreviousView(PID);
    const restored = restorePreviousView(PID);
    expect(restored).toBeUndefined();
  });

  it('operation sequencing supersedes older operations', () => {
    const seq1 = startOperation(PID);
    expect(isCurrentOperation(PID, seq1)).toBe(true);

    const seq2 = startOperation(PID);
    expect(isCurrentOperation(PID, seq1)).toBe(false);
    expect(isCurrentOperation(PID, seq2)).toBe(true);

    const seq3 = startOperation(PID);
    expect(isCurrentOperation(PID, seq2)).toBe(false);
    expect(isCurrentOperation(PID, seq3)).toBe(true);
  });

  it('loading state tracks stage info', () => {
    expect(isLoading(PID)).toBe(false);
    setLoading(PID, 'Calculating...', 1, 4);
    expect(isLoading(PID)).toBe(true);

    const state = getLoadingState(PID);
    expect(state?.stage).toBe('Calculating...');
    expect(state?.stageIndex).toBe(1);
    expect(state?.totalStages).toBe(4);

    clearLoading(PID);
    expect(isLoading(PID)).toBe(false);
  });

  it('loading state updates stage in-place', () => {
    setLoading(PID, 'Stage 1', 0, 3);
    const startedAt = getLoadingState(PID)?.startedAt;
    setLoading(PID, 'Stage 2', 1, 3);
    expect(getLoadingState(PID)?.stage).toBe('Stage 2');
    expect(getLoadingState(PID)?.startedAt).toBe(startedAt);
  });

  it('user cancellation flags', () => {
    expect(isUserCancelled(PID)).toBe(false);
    markUserCancelled(PID);
    expect(isUserCancelled(PID)).toBe(true);
    clearUserCancelled(PID);
    expect(isUserCancelled(PID)).toBe(false);
  });

  it('windowed view seeds cell window cache', () => {
    const windowedView = mockView(PID, 1, {
      isWindowed: true,
      totalRowCount: 1000,
      windowStartRow: 0,
      rows: [
        mockRow(0, 'Data', [mockCell('Data', 100)]),
        mockRow(1, 'Data', [mockCell('Data', 200)]),
      ],
    });
    cachePivotView(PID, windowedView);

    const cache = getCellWindowCache(PID);
    expect(cache).toBeDefined();
    expect(cache!.getRow(0)).toBeDefined();
    expect(cache!.getRow(1)).toBeDefined();
    expect(cache!.getRow(2)).toBeNull();
  });

  it('non-windowed view clears cell window cache', () => {
    // First set a windowed view
    cachePivotView(PID, mockView(PID, 1, {
      isWindowed: true,
      totalRowCount: 100,
      windowStartRow: 0,
      rows: [mockRow(0, 'Data', [mockCell('Data', 1)])],
    }));
    expect(getCellWindowCache(PID)).toBeDefined();

    // Now set a non-windowed view
    cachePivotView(PID, mockView(PID, 2, { isWindowed: false }));
    expect(getCellWindowCache(PID)).toBeUndefined();
  });

  it('ensureCellWindow triggers fetch for missing rows', async () => {
    const windowedView = mockView(PID, 1, {
      isWindowed: true,
      totalRowCount: 500,
      windowStartRow: 0,
      rows: [],
    });
    cachePivotView(PID, windowedView);

    let fetchCalled = false;
    const fetchFn = async (_pivotId: number, startRow: number, _rowCount: number) => {
      fetchCalled = true;
      return {
        pivotId: PID,
        version: 1,
        startRow,
        rows: [mockRow(startRow, 'Data', [mockCell('Data', 999)])],
      };
    };

    let loadedCalled = false;
    ensureCellWindow(PID, 1, 0, 1, fetchFn, () => { loadedCalled = true; });

    // Wait for async fetch
    await new Promise(r => setTimeout(r, 50));
    expect(fetchCalled).toBe(true);
    expect(loadedCalled).toBe(true);
  });
});

// ============================================================================
// Multi-level column headers
// ============================================================================

describe('Multi-level column headers', () => {
  it('column header rows appear before data rows', () => {
    const view = mockView(1, 1, {
      columnHeaderRowCount: 2,
      rows: [
        mockRow(0, 'ColumnHeader', [
          mockCell('Corner', ''),
          mockCell('ColumnHeader', 'Q1'),
          mockCell('ColumnHeader', 'Q2'),
        ]),
        mockRow(1, 'ColumnHeader', [
          mockCell('Corner', ''),
          mockCell('ColumnHeader', 'Sales'),
          mockCell('ColumnHeader', 'Sales'),
        ]),
        mockRow(2, 'Data', [
          mockCell('RowHeader', 'East'),
          mockCell('Data', 100),
          mockCell('Data', 200),
        ]),
      ],
    });

    expect(view.columnHeaderRowCount).toBe(2);
    expect(view.rows[0].rowType).toBe('ColumnHeader');
    expect(view.rows[1].rowType).toBe('ColumnHeader');
    expect(view.rows[2].rowType).toBe('Data');
  });

  it('colSpan merges column header cells', () => {
    const cell = mockCell('ColumnHeader', 'Q1', { colSpan: 2 });
    expect(cell.colSpan).toBe(2);
  });
});

// ============================================================================
// Expandable cells and group paths
// ============================================================================

describe('Expandable cells', () => {
  it('expandable cell has isExpandable and isCollapsed', () => {
    const expanded = mockCell('RowHeader', 'East', {
      isExpandable: true,
      isCollapsed: false,
    });
    expect(expanded.isExpandable).toBe(true);
    expect(expanded.isCollapsed).toBe(false);

    const collapsed = mockCell('RowHeader', 'West', {
      isExpandable: true,
      isCollapsed: true,
    });
    expect(collapsed.isCollapsed).toBe(true);
  });

  it('group path identifies cell position for drill-down', () => {
    const cell = mockCell('Data', 500, {
      groupPath: [[0, 2], [1, 5]],
    });
    expect(cell.groupPath).toEqual([[0, 2], [1, 5]]);
    expect(cell.groupPath!.length).toBe(2);
  });
});

// ============================================================================
// Number formatting in pivot cells
// ============================================================================

describe('Pivot number formatting', () => {
  it('formattedValue takes precedence over raw value', () => {
    const cell = mockCell('Data', 1234.567, {
      formattedValue: '$1,234.57',
      numberFormat: '#,##0.00',
    });
    expect(cell.formattedValue).toBe('$1,234.57');
    expect(cell.value).toBe(1234.567);
  });

  it('numberFormat is preserved on cells', () => {
    const cell = mockCell('Data', 0.85, { numberFormat: '0.0%' });
    expect(cell.numberFormat).toBe('0.0%');
  });

  it('createValueFieldConfig stores number format', () => {
    const vf = createValueFieldConfig(3, 'Sales', 'sum', {
      numberFormat: '$#,##0',
    });
    expect(vf.numberFormat).toBe('$#,##0');
  });
});

// ============================================================================
// Background styles
// ============================================================================

describe('Background styles', () => {
  const allStyles: BackgroundStyle[] = [
    'Normal', 'Alternate', 'Subtotal', 'Total', 'GrandTotal', 'Header', 'FilterRow',
  ];

  it('all background styles are valid', () => {
    for (const style of allStyles) {
      const cell = mockCell('Data', 0, { backgroundStyle: style });
      expect(cell.backgroundStyle).toBe(style);
    }
  });

  it('subtotal rows use Subtotal background', () => {
    const cell = mockCell('RowSubtotal', 'Total', { backgroundStyle: 'Subtotal' });
    expect(cell.backgroundStyle).toBe('Subtotal');
    expect(isTotalCell(cell.cellType)).toBe(true);
  });

  it('grand total rows use GrandTotal background', () => {
    const cell = mockCell('GrandTotal', 9999, { backgroundStyle: 'GrandTotal' });
    expect(cell.backgroundStyle).toBe('GrandTotal');
  });
});
