import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { parse } from './parser';
import { validate, type ValidateContext } from './validator';
import type { PivotLayoutAST } from './ast';
import { emptyAST } from './ast';
import type { SourceField } from '../../_shared/components/types';
import type { BiPivotModelInfo } from '../components/types';

/** Parse DSL and return the AST. */
function ast(input: string): PivotLayoutAST {
  return parse(lex(input).tokens).ast;
}

/** Standard source fields. */
const FIELDS: SourceField[] = [
  { index: 0, name: 'Region', isNumeric: false },
  { index: 1, name: 'Product', isNumeric: false },
  { index: 2, name: 'Sales', isNumeric: true },
  { index: 3, name: 'Profit', isNumeric: true },
  { index: 4, name: 'Date', isNumeric: false },
  { index: 5, name: 'Category', isNumeric: false },
];

function ctx(fields: SourceField[] = FIELDS, biModel?: BiPivotModelInfo): ValidateContext {
  return { sourceFields: fields, biModel };
}

/** BI model fixture. */
const BI_MODEL: BiPivotModelInfo = {
  tables: [
    {
      name: 'Sales',
      columns: [
        { name: 'Amount', dataType: 'number', isNumeric: true },
        { name: 'Region', dataType: 'string', isNumeric: false },
      ],
    },
    {
      name: 'Customers',
      columns: [
        { name: 'Name', dataType: 'string', isNumeric: false },
      ],
    },
  ],
  measures: [
    { name: 'Total Revenue', table: 'Sales', sourceColumn: 'Amount', aggregation: 'sum' },
  ],
};

describe('Validator coverage', () => {
  // ---------------------------------------------------------------
  // Field existence
  // ---------------------------------------------------------------
  describe('field existence', () => {
    it('accepts known fields in ROWS', () => {
      const errors = validate(ast('ROWS: Region, Product'), ctx());
      const fieldErrors = errors.filter(e => e.severity === 'error');
      // info about missing VALUES is ok
      expect(fieldErrors).toHaveLength(0);
    });

    it('reports unknown field in ROWS', () => {
      const errors = validate(ast('ROWS: Unknown'), ctx());
      expect(errors.some(e => e.severity === 'error' && e.message.includes('Unknown field'))).toBe(true);
    });

    it('reports unknown field in COLUMNS', () => {
      const errors = validate(ast('COLUMNS: Bogus'), ctx());
      expect(errors.some(e => e.severity === 'error' && e.message.includes('Unknown field'))).toBe(true);
    });

    it('reports unknown field in VALUES', () => {
      const errors = validate(ast('VALUES: Sum(Nonexistent)'), ctx());
      expect(errors.some(e => e.severity === 'error' && e.message.includes('Unknown field'))).toBe(true);
    });

    it('reports unknown field in FILTERS', () => {
      const errors = validate(ast('FILTERS: Missing = ("x")'), ctx());
      expect(errors.some(e => e.severity === 'error' && e.message.includes('Unknown field'))).toBe(true);
    });

    it('reports unknown field in SORT', () => {
      const errors = validate(ast('SORT: Nope'), ctx());
      expect(errors.some(e => e.severity === 'error' && e.message.includes('Unknown sort field'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Cross-zone duplicate detection
  // ---------------------------------------------------------------
  describe('duplicate detection', () => {
    it('warns when field appears in both ROWS and COLUMNS', () => {
      const errors = validate(ast('ROWS: Region\nCOLUMNS: Region'), ctx());
      expect(errors.some(e => e.severity === 'warning' && e.message.includes('both ROWS and COLUMNS'))).toBe(true);
    });

    it('warns when field appears twice in same zone', () => {
      const errors = validate(ast('ROWS: Region, Region'), ctx());
      expect(errors.some(e => e.severity === 'warning' && e.message.includes('Duplicate field'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // VALUES-specific validations
  // ---------------------------------------------------------------
  describe('values validations', () => {
    it('warns about numeric aggregation on non-numeric field', () => {
      const errors = validate(ast('VALUES: Sum(Region)'), ctx());
      expect(errors.some(e => e.severity === 'warning' && e.message.includes('non-numeric'))).toBe(true);
    });

    it('does not warn for Count on non-numeric field', () => {
      const errors = validate(ast('VALUES: Count(Region)'), ctx());
      expect(errors.filter(e => e.severity === 'warning' && e.message.includes('non-numeric'))).toHaveLength(0);
    });

    it('does not warn for numeric aggregation on numeric field', () => {
      const errors = validate(ast('VALUES: Sum(Sales)'), ctx());
      expect(errors.filter(e => e.severity === 'warning' && e.message.includes('non-numeric'))).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------
  // FILTERS validations
  // ---------------------------------------------------------------
  describe('filter validations', () => {
    it('warns when filter has no values', () => {
      const errors = validate(ast('FILTERS: Region'), ctx());
      expect(errors.some(e => e.severity === 'warning' && e.message.includes('no values'))).toBe(true);
    });

    it('no warning when filter has values', () => {
      const errors = validate(ast('FILTERS: Region = ("US")'), ctx());
      expect(errors.filter(e => e.message.includes('no values'))).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------
  // LAYOUT validations
  // ---------------------------------------------------------------
  describe('layout validations', () => {
    it('warns for unknown layout directive', () => {
      const errors = validate(ast('LAYOUT: bogus'), ctx());
      expect(errors.some(e => e.severity === 'warning' && e.message.includes('Unknown layout directive'))).toBe(true);
    });

    it('accepts known layout directives', () => {
      const errors = validate(ast('LAYOUT: compact'), ctx());
      expect(errors.filter(e => e.message.includes('Unknown layout'))).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------
  // Info severity: no VALUES hint
  // ---------------------------------------------------------------
  describe('info diagnostics', () => {
    it('emits info when ROWS defined but no VALUES', () => {
      const errors = validate(ast('ROWS: Region'), ctx());
      expect(errors.some(e => e.severity === 'info' && e.message.includes('No VALUES defined'))).toBe(true);
    });

    it('does not emit info when both ROWS and VALUES defined', () => {
      const errors = validate(ast('ROWS: Region\nVALUES: Sum(Sales)'), ctx());
      expect(errors.filter(e => e.severity === 'info')).toHaveLength(0);
    });

    it('does not emit info when nothing is defined', () => {
      const errors = validate(emptyAST(), ctx());
      expect(errors.filter(e => e.severity === 'info')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------
  // BI-specific validations
  // ---------------------------------------------------------------
  describe('BI model', () => {
    it('accepts dotted BI field names', () => {
      const errors = validate(ast('ROWS: Sales.Region'), ctx([], BI_MODEL));
      const fieldErrors = errors.filter(e => e.severity === 'error' && e.message.includes('Unknown field'));
      expect(fieldErrors).toHaveLength(0);
    });

    it('reports unknown dotted BI field', () => {
      const errors = validate(ast('ROWS: Sales.Bogus'), ctx([], BI_MODEL));
      expect(errors.some(e => e.severity === 'error' && e.message.includes('Unknown field'))).toBe(true);
    });

    it('accepts known BI measures', () => {
      const errors = validate(ast('VALUES: [Total Revenue]'), ctx([], BI_MODEL));
      expect(errors.filter(e => e.severity === 'error' && e.message.includes('Unknown measure'))).toHaveLength(0);
    });

    it('reports unknown BI measure', () => {
      const errors = validate(ast('VALUES: [Fake Measure]'), ctx([], BI_MODEL));
      expect(errors.some(e => e.severity === 'error' && e.message.includes('Unknown measure'))).toBe(true);
    });

    it('reports bracket measure without BI model', () => {
      const errors = validate(ast('VALUES: [Revenue]'), ctx());
      expect(errors.some(e => e.severity === 'error' && e.message.includes('require a BI model'))).toBe(true);
    });

    it('reports LOOKUP without BI model', () => {
      const errors = validate(ast('ROWS: LOOKUP Region'), ctx());
      expect(errors.some(e => e.severity === 'error' && e.message.includes('LOOKUP fields are only supported'))).toBe(true);
    });

    it('accepts LOOKUP with BI model', () => {
      const errors = validate(ast('ROWS: LOOKUP Customers.Name'), ctx([], BI_MODEL));
      expect(errors.filter(e => e.message.includes('LOOKUP'))).toHaveLength(0);
    });

    it('resolves unqualified column names from BI model', () => {
      // BI model adds column names to fieldNames set too
      const errors = validate(ast('ROWS: Amount'), ctx([], BI_MODEL));
      const fieldErrors = errors.filter(e => e.severity === 'error' && e.message.includes('Unknown field'));
      expect(fieldErrors).toHaveLength(0);
    });
  });
});
