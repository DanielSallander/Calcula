//! FILENAME: app/extensions/Pivot/lib/pivot-api-utils.test.ts
// PURPOSE: Additional tests for pivot-api utility functions not covered by pivot-api.test.ts.

import { describe, it, expect } from 'vitest';
import {
  isFilterCell,
  isDataRow,
  isFilterRow,
  isHeaderCell,
  isTotalCell,
  createLayoutConfig,
  createFieldConfig,
  createValueFieldConfig,
  getCellNumericValue,
  getCellDisplayValue,
  type PivotCellType,
  type PivotRowType,
} from './pivot-api';

// ============================================================================
// isFilterCell
// ============================================================================

describe('isFilterCell', () => {
  it('returns true for FilterLabel', () => {
    expect(isFilterCell('FilterLabel')).toBe(true);
  });

  it('returns true for FilterDropdown', () => {
    expect(isFilterCell('FilterDropdown')).toBe(true);
  });

  it('returns false for Data', () => {
    expect(isFilterCell('Data')).toBe(false);
  });

  it('returns false for RowHeader', () => {
    expect(isFilterCell('RowHeader')).toBe(false);
  });

  it('returns false for GrandTotal', () => {
    expect(isFilterCell('GrandTotal')).toBe(false);
  });
});

// ============================================================================
// isDataRow
// ============================================================================

describe('isDataRow', () => {
  it('returns true for Data row type', () => {
    expect(isDataRow('Data')).toBe(true);
  });

  it('returns false for ColumnHeader', () => {
    expect(isDataRow('ColumnHeader')).toBe(false);
  });

  it('returns false for Subtotal', () => {
    expect(isDataRow('Subtotal')).toBe(false);
  });

  it('returns false for GrandTotal', () => {
    expect(isDataRow('GrandTotal')).toBe(false);
  });

  it('returns false for FilterRow', () => {
    expect(isDataRow('FilterRow')).toBe(false);
  });
});

// ============================================================================
// isFilterRow
// ============================================================================

describe('isFilterRow', () => {
  it('returns true for FilterRow', () => {
    expect(isFilterRow('FilterRow')).toBe(true);
  });

  it('returns false for Data', () => {
    expect(isFilterRow('Data')).toBe(false);
  });

  it('returns false for ColumnHeader', () => {
    expect(isFilterRow('ColumnHeader')).toBe(false);
  });
});

// ============================================================================
// isHeaderCell - extended coverage
// ============================================================================

describe('isHeaderCell extended', () => {
  it('returns true for RowLabelHeader', () => {
    expect(isHeaderCell('RowLabelHeader')).toBe(true);
  });

  it('returns true for ColumnLabelHeader', () => {
    expect(isHeaderCell('ColumnLabelHeader')).toBe(true);
  });

  it('returns false for Blank', () => {
    expect(isHeaderCell('Blank')).toBe(false);
  });

  it('returns false for FilterLabel', () => {
    expect(isHeaderCell('FilterLabel')).toBe(false);
  });
});

// ============================================================================
// isTotalCell - extended coverage
// ============================================================================

describe('isTotalCell extended', () => {
  it('returns false for Blank', () => {
    expect(isTotalCell('Blank')).toBe(false);
  });

  it('returns false for Corner', () => {
    expect(isTotalCell('Corner')).toBe(false);
  });

  it('returns false for FilterLabel', () => {
    expect(isTotalCell('FilterLabel')).toBe(false);
  });
});

// ============================================================================
// createLayoutConfig
// ============================================================================

describe('createLayoutConfig', () => {
  it('creates config with all defaults', () => {
    const config = createLayoutConfig();
    expect(config.showRowGrandTotals).toBe(true);
    expect(config.showColumnGrandTotals).toBe(true);
    expect(config.reportLayout).toBe('compact');
    expect(config.repeatRowLabels).toBe(false);
    expect(config.showEmptyRows).toBe(false);
    expect(config.showEmptyCols).toBe(false);
    expect(config.valuesPosition).toBe('columns');
  });

  it('allows overriding individual properties', () => {
    const config = createLayoutConfig({
      reportLayout: 'tabular',
      repeatRowLabels: true,
      valuesPosition: 'rows',
    });
    expect(config.reportLayout).toBe('tabular');
    expect(config.repeatRowLabels).toBe(true);
    expect(config.valuesPosition).toBe('rows');
    // Non-overridden properties keep defaults
    expect(config.showRowGrandTotals).toBe(true);
  });

  it('allows disabling grand totals', () => {
    const config = createLayoutConfig({
      showRowGrandTotals: false,
      showColumnGrandTotals: false,
    });
    expect(config.showRowGrandTotals).toBe(false);
    expect(config.showColumnGrandTotals).toBe(false);
  });
});

// ============================================================================
// createFieldConfig - extended edge cases
// ============================================================================

describe('createFieldConfig extended', () => {
  it('allows setting hiddenItems', () => {
    const config = createFieldConfig(0, 'Region', {
      hiddenItems: ['South', 'West'],
    });
    expect(config.hiddenItems).toEqual(['South', 'West']);
  });

  it('allows setting showSubtotals to false', () => {
    const config = createFieldConfig(0, 'Region', {
      showSubtotals: false,
    });
    expect(config.showSubtotals).toBe(false);
  });
});

// ============================================================================
// getCellNumericValue - boundary values
// ============================================================================

describe('getCellNumericValue boundaries', () => {
  it('handles zero', () => {
    expect(getCellNumericValue(0)).toBe(0);
  });

  it('handles negative numbers', () => {
    expect(getCellNumericValue(-42.5)).toBe(-42.5);
  });

  it('handles Infinity', () => {
    expect(getCellNumericValue(Infinity)).toBe(Infinity);
  });

  it('handles NaN', () => {
    expect(getCellNumericValue(NaN)).toBeNaN();
  });

  it('handles very large numbers', () => {
    expect(getCellNumericValue(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('handles undefined-like values returning 0', () => {
    expect(getCellNumericValue(null)).toBe(0);
    expect(getCellNumericValue('')).toBe(0);
    expect(getCellNumericValue(false)).toBe(0);
  });
});

// ============================================================================
// getCellDisplayValue - boundary values
// ============================================================================

describe('getCellDisplayValue boundaries', () => {
  it('handles 0', () => {
    expect(getCellDisplayValue(0)).toBe('0');
  });

  it('handles negative numbers', () => {
    expect(getCellDisplayValue(-1.5)).toBe('-1.5');
  });

  it('handles empty string', () => {
    expect(getCellDisplayValue('')).toBe('');
  });

  it('handles error strings', () => {
    expect(getCellDisplayValue('#DIV/0!')).toBe('#DIV/0!');
    expect(getCellDisplayValue('#N/A')).toBe('#N/A');
    expect(getCellDisplayValue('#REF!')).toBe('#REF!');
  });

  it('handles very long strings', () => {
    const long = 'x'.repeat(10000);
    expect(getCellDisplayValue(long)).toBe(long);
  });
});
