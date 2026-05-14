//! FILENAME: app/extensions/Pivot/dsl/validator.test.ts
// PURPOSE: Tests for the DSL semantic validator.

import { describe, it, expect } from 'vitest';
import { validate, type ValidateContext } from './validator';
import { emptyAST, type PivotLayoutAST, type FieldNode, type ValueFieldNode, type FilterFieldNode } from './ast';
import type { SourceField } from '../../_shared/components/types';
import type { BiPivotModelInfo } from '../components/types';

const LOC = { line: 1, column: 0, endColumn: 10 };

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

const FIELDS: SourceField[] = [
  sf(0, 'Region'),
  sf(1, 'Product'),
  sf(2, 'Sales', true),
  sf(3, 'Profit', true),
];

function ctx(fields: SourceField[] = FIELDS, biModel?: BiPivotModelInfo): ValidateContext {
  return { sourceFields: fields, biModel };
}

function fieldNode(name: string, overrides?: Partial<FieldNode>): FieldNode {
  return { name, isLookup: false, location: LOC, ...overrides };
}

function valueNode(fieldName: string, overrides?: Partial<ValueFieldNode>): ValueFieldNode {
  return { fieldName, isMeasure: false, location: LOC, ...overrides };
}

function filterNode(fieldName: string, values: string[] = [], exclude = false): FilterFieldNode {
  return { fieldName, values, exclude, location: LOC };
}

describe('Validator', () => {
  // --- Field existence ---

  it('reports no errors for valid fields', () => {
    const ast = emptyAST();
    ast.rows = [fieldNode('Region')];
    ast.values = [valueNode('Sales', { aggregation: 'sum' })];
    const errors = validate(ast, ctx());
    const hard = errors.filter(e => e.severity === 'error');
    expect(hard).toHaveLength(0);
  });

  it('reports error for unknown row field', () => {
    const ast = emptyAST();
    ast.rows = [fieldNode('NonExistent')];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'error' && e.message.includes('Unknown field'))).toBe(true);
  });

  it('reports error for unknown column field', () => {
    const ast = emptyAST();
    ast.columns = [fieldNode('Bogus')];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'error' && e.message.includes('Bogus'))).toBe(true);
  });

  it('reports error for unknown value field', () => {
    const ast = emptyAST();
    ast.values = [valueNode('Missing', { aggregation: 'sum' })];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'error' && e.message.includes('Missing'))).toBe(true);
  });

  it('reports error for unknown filter field', () => {
    const ast = emptyAST();
    ast.filters = [filterNode('FakeField', ['a'])];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'error' && e.message.includes('FakeField'))).toBe(true);
  });

  // --- Duplicate field detection ---

  it('warns for duplicate field in ROWS', () => {
    const ast = emptyAST();
    ast.rows = [fieldNode('Region'), fieldNode('Region')];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'warning' && e.message.includes('Duplicate'))).toBe(true);
  });

  it('warns when same field appears in ROWS and COLUMNS', () => {
    const ast = emptyAST();
    ast.rows = [fieldNode('Region')];
    ast.columns = [fieldNode('Region')];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'warning' && e.message.includes('both'))).toBe(true);
  });

  // --- Aggregation warnings ---

  it('warns when using numeric aggregation on non-numeric field', () => {
    const ast = emptyAST();
    ast.values = [valueNode('Region', { aggregation: 'sum' })];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'warning' && e.message.includes('non-numeric'))).toBe(true);
  });

  it('does not warn for count on non-numeric field', () => {
    const ast = emptyAST();
    ast.values = [valueNode('Region', { aggregation: 'count' })];
    const errors = validate(ast, ctx());
    const aggWarnings = errors.filter(e => e.severity === 'warning' && e.message.includes('non-numeric'));
    expect(aggWarnings).toHaveLength(0);
  });

  it('does not warn for sum on numeric field', () => {
    const ast = emptyAST();
    ast.values = [valueNode('Sales', { aggregation: 'sum' })];
    const errors = validate(ast, ctx());
    const aggWarnings = errors.filter(e => e.severity === 'warning' && e.message.includes('non-numeric'));
    expect(aggWarnings).toHaveLength(0);
  });

  // --- Filter warnings ---

  it('warns for filter with no values', () => {
    const ast = emptyAST();
    ast.filters = [filterNode('Region', [])];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'warning' && e.message.includes('no values'))).toBe(true);
  });

  // --- Layout directive validation ---

  it('warns for unknown layout directive', () => {
    const ast = emptyAST();
    ast.layout = [{ key: 'banana', location: LOC }];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'warning' && e.message.includes('Unknown layout directive'))).toBe(true);
  });

  it('accepts valid layout directives without warnings', () => {
    const ast = emptyAST();
    ast.layout = [
      { key: 'compact', location: LOC },
      { key: 'repeat-labels', location: LOC },
      { key: 'no-grand-totals', location: LOC },
    ];
    const errors = validate(ast, ctx());
    const layoutWarnings = errors.filter(e => e.message.includes('layout directive'));
    expect(layoutWarnings).toHaveLength(0);
  });

  // --- Informational hints ---

  it('provides info hint when VALUES is missing but ROWS present', () => {
    const ast = emptyAST();
    ast.rows = [fieldNode('Region')];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'info' && e.message.includes('No VALUES'))).toBe(true);
  });

  it('does not provide info hint when all zones are empty', () => {
    const ast = emptyAST();
    const errors = validate(ast, ctx());
    const infos = errors.filter(e => e.severity === 'info');
    expect(infos).toHaveLength(0);
  });

  // --- SORT validation ---

  it('reports error for unknown sort field', () => {
    const ast = emptyAST();
    ast.sort = [{ fieldName: 'Bogus', direction: 'asc', location: LOC }];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'error' && e.message.includes('sort field'))).toBe(true);
  });

  it('accepts valid sort field', () => {
    const ast = emptyAST();
    ast.sort = [{ fieldName: 'Region', direction: 'desc', location: LOC }];
    const errors = validate(ast, ctx());
    const sortErrors = errors.filter(e => e.severity === 'error' && e.message.includes('sort'));
    expect(sortErrors).toHaveLength(0);
  });

  // --- LOOKUP validation ---

  it('reports error for LOOKUP without BI model', () => {
    const ast = emptyAST();
    ast.rows = [fieldNode('Region', { isLookup: true })];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'error' && e.message.includes('LOOKUP'))).toBe(true);
  });

  // --- Bracket measure validation ---

  it('reports error for bracket measure without BI model', () => {
    const ast = emptyAST();
    ast.values = [valueNode('TotalSales', { isMeasure: true })];
    const errors = validate(ast, ctx());
    expect(errors.some(e => e.severity === 'error' && e.message.includes('Bracket measures'))).toBe(true);
  });

  // --- BI model validation ---

  describe('BI model', () => {
    const biModel: BiPivotModelInfo = {
      tables: [
        { name: 'Sales', columns: [{ name: 'Region', dataType: 'string', isNumeric: false }] },
      ],
      measures: [{ name: 'Total', table: 'Sales', sourceColumn: 'Region', aggregation: 'count' }],
    };

    it('accepts valid BI dotted field', () => {
      const ast = emptyAST();
      ast.rows = [fieldNode('Sales.Region', { table: 'Sales', column: 'Region' })];
      const errors = validate(ast, ctx([], biModel));
      const hard = errors.filter(e => e.severity === 'error');
      expect(hard).toHaveLength(0);
    });

    it('reports error for unknown BI dotted field', () => {
      const ast = emptyAST();
      ast.rows = [fieldNode('Fake.Column', { table: 'Fake', column: 'Column' })];
      const errors = validate(ast, ctx([], biModel));
      expect(errors.some(e => e.severity === 'error')).toBe(true);
    });

    it('accepts valid bracket measure with BI model', () => {
      const ast = emptyAST();
      ast.values = [valueNode('Total', { isMeasure: true })];
      const errors = validate(ast, ctx([], biModel));
      const measureErrors = errors.filter(e => e.severity === 'error' && e.message.includes('measure'));
      expect(measureErrors).toHaveLength(0);
    });

    it('reports error for unknown bracket measure', () => {
      const ast = emptyAST();
      ast.values = [valueNode('FakeMeasure', { isMeasure: true })];
      const errors = validate(ast, ctx([], biModel));
      expect(errors.some(e => e.severity === 'error' && e.message.includes('Unknown measure'))).toBe(true);
    });

    it('skips inline CALC placeholders in value validation', () => {
      const ast = emptyAST();
      ast.values = [valueNode('ignored', { inlineCalcIndex: 0 })];
      const errors = validate(ast, ctx());
      // Should not report unknown field for the CALC placeholder
      const fieldErrors = errors.filter(e => e.severity === 'error' && e.message.includes('Unknown field'));
      expect(fieldErrors).toHaveLength(0);
    });
  });
});
