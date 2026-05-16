//! FILENAME: app/extensions/Pivot/lib/pivot-cell-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for pivot cell utility functions.

import { describe, it, expect } from 'vitest';
import {
  getCellNumericValue,
  getCellDisplayValue,
  isHeaderCell,
  isTotalCell,
  isFilterCell,
  type PivotCellValue,
  type PivotCellType,
} from './pivot-api';

// ============================================================================
// 1. getCellNumericValue: 100 value combos
// ============================================================================

describe('getCellNumericValue (100 combos)', () => {
  const numericCases: [string, PivotCellValue, number][] = [
    // Integers
    ['zero', 0, 0], ['one', 1, 1], ['negative one', -1, -1],
    ['ten', 10, 10], ['hundred', 100, 100], ['thousand', 1000, 1000],
    ['million', 1000000, 1000000], ['minus ten', -10, -10],
    ['minus hundred', -100, -100], ['minus thousand', -1000, -1000],
    // Floats
    ['pi', 3.14159, 3.14159], ['e', 2.71828, 2.71828],
    ['half', 0.5, 0.5], ['third', 0.333, 0.333],
    ['quarter', 0.25, 0.25], ['eighth', 0.125, 0.125],
    ['neg half', -0.5, -0.5], ['neg pi', -3.14, -3.14],
    ['small', 0.001, 0.001], ['tiny', 0.0001, 0.0001],
    // Special numbers
    ['max safe int', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ['min safe int', Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
    ['max value', Number.MAX_VALUE, Number.MAX_VALUE],
    ['min value', Number.MIN_VALUE, Number.MIN_VALUE],
    ['epsilon', Number.EPSILON, Number.EPSILON],
    ['neg zero', -0, -0],
    ['infinity', Infinity, Infinity],
    ['neg infinity', -Infinity, -Infinity],
    ['NaN', NaN, NaN],
    // Large numbers
    ['1e6', 1e6, 1e6], ['1e9', 1e9, 1e9], ['1e12', 1e12, 1e12],
    ['1e-6', 1e-6, 1e-6], ['1e-9', 1e-9, 1e-9], ['1e-12', 1e-12, 1e-12],
    // Specific business values
    ['price 9.99', 9.99, 9.99], ['price 19.95', 19.95, 19.95],
    ['price 99.99', 99.99, 99.99], ['price 0.01', 0.01, 0.01],
    ['pct 50', 50, 50], ['pct 100', 100, 100],
    ['pct 0.5', 0.5, 0.5], ['pct 99.9', 99.9, 99.9],
    // Two-digit
    ['11', 11, 11], ['22', 22, 22], ['33', 33, 33], ['44', 44, 44],
    ['55', 55, 55], ['66', 66, 66], ['77', 77, 77], ['88', 88, 88],
    ['99', 99, 99], ['12', 12, 12],
    // Negative floats
    ['-0.01', -0.01, -0.01], ['-0.1', -0.1, -0.1],
    ['-1.5', -1.5, -1.5], ['-2.5', -2.5, -2.5],
    ['-9.99', -9.99, -9.99], ['-99.99', -99.99, -99.99],
    // Strings -> 0
    ['empty string', '', 0], ['hello', 'hello', 0],
    ['number string', '42', 0], ['float string', '3.14', 0],
    ['space', ' ', 0], ['tab', '\t', 0],
    ['error string', '#ERROR', 0], ['#N/A', '#N/A', 0],
    ['#DIV/0!', '#DIV/0!', 0], ['#VALUE!', '#VALUE!', 0],
    ['#REF!', '#REF!', 0], ['#NAME?', '#NAME?', 0],
    ['long string', 'a'.repeat(100), 0],
    ['unicode', '\u00e9\u00e0\u00fc', 0],
    // Null -> 0
    ['null', null, 0],
    // Booleans -> 0
    ['true', true, 0], ['false', false, 0],
    // More integers
    ['2', 2, 2], ['3', 3, 3], ['4', 4, 4], ['5', 5, 5],
    ['6', 6, 6], ['7', 7, 7], ['8', 8, 8], ['9', 9, 9],
    ['500', 500, 500], ['999', 999, 999],
    ['1234', 1234, 1234], ['5678', 5678, 5678],
    ['-2', -2, -2], ['-3', -3, -3], ['-4', -4, -4], ['-5', -5, -5],
    ['-500', -500, -500], ['-999', -999, -999],
  ];

  it.each(numericCases)(
    'getCellNumericValue(%s) = %d',
    (_label, input, expected) => {
      const result = getCellNumericValue(input);
      if (typeof expected === 'number' && isNaN(expected)) {
        expect(isNaN(result)).toBe(true);
      } else {
        expect(result).toBe(expected);
      }
    },
  );
});

// ============================================================================
// 2. getCellDisplayValue: 50 value combos
// ============================================================================

describe('getCellDisplayValue (50 combos)', () => {
  const displayCases: [string, PivotCellValue, string][] = [
    // Numbers
    ['zero', 0, '0'], ['one', 1, '1'], ['negative', -1, '-1'],
    ['float', 3.14, '3.14'], ['large', 1000000, '1000000'],
    ['small float', 0.001, '0.001'], ['neg float', -2.5, '-2.5'],
    ['infinity', Infinity, 'Infinity'], ['neg infinity', -Infinity, '-Infinity'],
    ['NaN', NaN, 'NaN'],
    // Strings
    ['hello', 'hello', 'hello'], ['empty', '', ''],
    ['space', ' ', ' '], ['number str', '42', '42'],
    ['special', '#ERROR', '#ERROR'], ['#N/A', '#N/A', '#N/A'],
    ['#DIV/0!', '#DIV/0!', '#DIV/0!'], ['#VALUE!', '#VALUE!', '#VALUE!'],
    ['#REF!', '#REF!', '#REF!'], ['#NAME?', '#NAME?', '#NAME?'],
    ['long', 'abcdefghij', 'abcdefghij'],
    ['unicode', '\u00e9\u00e0', '\u00e9\u00e0'],
    ['tab', '\t', '\t'], ['newline', '\n', '\n'],
    ['multi word', 'hello world', 'hello world'],
    // Booleans
    ['true', true, 'TRUE'], ['false', false, 'FALSE'],
    // Null / undefined
    ['null', null, ''],
    // More numbers
    ['10', 10, '10'], ['100', 100, '100'], ['1000', 1000, '1000'],
    ['-10', -10, '-10'], ['-100', -100, '-100'],
    ['0.5', 0.5, '0.5'], ['0.25', 0.25, '0.25'], ['0.125', 0.125, '0.125'],
    ['99.99', 99.99, '99.99'], ['9.99', 9.99, '9.99'],
    // More strings
    ['dash', '-', '-'], ['dot', '.', '.'], ['comma', ',', ','],
    ['colon', ':', ':'], ['semi', ';', ';'],
    ['parens', '(test)', '(test)'], ['brackets', '[test]', '[test]'],
    ['braces', '{test}', '{test}'], ['angle', '<test>', '<test>'],
    ['slash', 'a/b', 'a/b'], ['backslash', 'a\\b', 'a\\b'],
    ['quotes', '"test"', '"test"'], ['apostrophe', "it's", "it's"],
    ['percent', '50%', '50%'], ['dollar', '$100', '$100'],
  ];

  it.each(displayCases)(
    'getCellDisplayValue(%s)',
    (_label, input, expected) => {
      expect(getCellDisplayValue(input)).toBe(expected);
    },
  );
});

// ============================================================================
// 3. isHeaderCell / isTotalCell / isFilterCell: all 14 cell types x 3 guards = 42 tests
// ============================================================================

describe('cell type guards (42 combos)', () => {
  const allCellTypes: PivotCellType[] = [
    'Data', 'RowHeader', 'ColumnHeader', 'Corner',
    'RowSubtotal', 'ColumnSubtotal', 'GrandTotal',
    'GrandTotalRow', 'GrandTotalColumn', 'Blank',
    'FilterLabel', 'FilterDropdown',
    'RowLabelHeader', 'ColumnLabelHeader',
  ];

  const headerTypes = new Set<PivotCellType>([
    'RowHeader', 'ColumnHeader', 'Corner', 'RowLabelHeader', 'ColumnLabelHeader',
  ]);
  const totalTypes = new Set<PivotCellType>([
    'RowSubtotal', 'ColumnSubtotal', 'GrandTotal', 'GrandTotalRow', 'GrandTotalColumn',
  ]);
  const filterTypes = new Set<PivotCellType>([
    'FilterLabel', 'FilterDropdown',
  ]);

  describe('isHeaderCell', () => {
    it.each(allCellTypes)(
      'isHeaderCell(%s)',
      (cellType) => {
        expect(isHeaderCell(cellType)).toBe(headerTypes.has(cellType));
      },
    );
  });

  describe('isTotalCell', () => {
    it.each(allCellTypes)(
      'isTotalCell(%s)',
      (cellType) => {
        expect(isTotalCell(cellType)).toBe(totalTypes.has(cellType));
      },
    );
  });

  describe('isFilterCell', () => {
    it.each(allCellTypes)(
      'isFilterCell(%s)',
      (cellType) => {
        expect(isFilterCell(cellType)).toBe(filterTypes.has(cellType));
      },
    );
  });
});
