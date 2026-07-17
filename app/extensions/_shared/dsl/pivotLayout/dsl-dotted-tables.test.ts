//! FILENAME: app/extensions/_shared/dsl/pivotLayout/dsl-dotted-tables.test.ts
// PURPOSE: Field references over BI models whose TABLE names contain dots
//   (schema-qualified imports like "BI.dim_customer"). The field key
//   "BI.dim_customer.fullname" has three dot-separated segments; the parser
//   must keep the whole chain as one name (only ".group(" / ".bin(" ends it),
//   and the compiler must resolve it against the model with canonical casing.
//   Also covers the [bracketed] field-name quoting form in ROWS/COLUMNS/etc.

import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { parse } from './parser';
import { processDsl } from './index';
import { serialize } from './serializer';
import { compileDesignQuery } from './designQuery';
import type { CompileContext } from './compiler';
import type { BiPivotModelInfo, SourceField } from '../../components/types';

const MODEL: BiPivotModelInfo = {
  tables: [
    {
      name: 'BI.dim_customer',
      columns: [
        { name: 'fullname', dataType: 'string', isNumeric: false },
        { name: 'customerid', dataType: 'number', isNumeric: true },
      ],
    },
    {
      name: 'BI.fact_sales',
      columns: [
        { name: 'revenue', dataType: 'number', isNumeric: true },
        { name: 'orderdate', dataType: 'date', isNumeric: false },
      ],
    },
  ],
  measures: [
    { name: 'Revenue', table: 'BI.fact_sales', sourceColumn: 'revenue', aggregation: 'sum' },
  ],
};

const biCtx = (): CompileContext => ({ sourceFields: [], biModel: MODEL });

const hardErrors = (r: { errors: { severity: string; message: string }[] }) =>
  r.errors.filter((e) => e.severity === 'error').map((e) => e.message);

function parseText(text: string) {
  return parse(lex(text).tokens);
}

describe('dotted table names (schema-qualified "BI.dim_customer")', () => {
  it('parser keeps the full three-segment chain as one field name', () => {
    const r = parseText('ROWS: BI.dim_customer.fullname');
    expect(r.errors).toHaveLength(0);
    expect(r.ast.rows).toHaveLength(1);
    expect(r.ast.rows[0].name).toBe('BI.dim_customer.fullname');
  });

  it('compiles ROWS + measure VALUES against the model', () => {
    const r = processDsl('ROWS: BI.dim_customer.fullname\nVALUES: [Revenue]', biCtx());
    expect(hardErrors(r)).toHaveLength(0);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].name).toBe('BI.dim_customer.fullname');
    expect(r.values[0].name).toBe('[Revenue]');
  });

  it('accepts the [bracketed] quoting form for field names', () => {
    const r = processDsl('ROWS: [BI.dim_customer.fullname]\nVALUES: [Revenue]', biCtx());
    expect(hardErrors(r)).toHaveLength(0);
    expect(r.rows[0].name).toBe('BI.dim_customer.fullname');
  });

  it('canonicalizes user-typed casing to the model casing', () => {
    const r = processDsl('ROWS: bi.DIM_CUSTOMER.FullName\nVALUES: [Revenue]', biCtx());
    expect(hardErrors(r)).toHaveLength(0);
    expect(r.rows[0].name).toBe('BI.dim_customer.fullname');
  });

  it('resolves isNumeric via the full key (default aggregation = sum)', () => {
    const r = processDsl('ROWS: BI.dim_customer.fullname\nVALUES: BI.fact_sales.revenue', biCtx());
    expect(hardErrors(r)).toHaveLength(0);
    expect(r.values[0].name).toBe('BI.fact_sales.revenue');
    expect(r.values[0].isNumeric).toBe(true);
    expect(r.values[0].aggregation).toBe('sum');
  });

  it('supports aggregation calls over dotted-table fields', () => {
    const r = processDsl(
      'ROWS: BI.dim_customer.fullname\nVALUES: Average(BI.fact_sales.revenue)',
      biCtx(),
    );
    expect(hardErrors(r)).toHaveLength(0);
    expect(r.values[0].aggregation).toBe('average');
  });

  it('supports FILTERS and SORT on dotted-table fields', () => {
    const r = processDsl(
      'ROWS: BI.dim_customer.fullname\nVALUES: [Revenue]\n' +
        'FILTERS: BI.dim_customer.customerid NOT IN ("1")\nSORT: BI.dim_customer.fullname DESC',
      biCtx(),
    );
    expect(hardErrors(r)).toHaveLength(0);
    expect(r.filters[0].name).toBe('BI.dim_customer.customerid');
    expect(r.filters[0].hiddenItems).toEqual(['1']);
  });

  it('still parses grouping calls after a three-segment field', () => {
    const r = parseText('ROWS: BI.fact_sales.orderdate.group(years, quarters)');
    expect(r.errors).toHaveLength(0);
    expect(r.ast.rows[0].name).toBe('BI.fact_sales.orderdate');
    expect(r.ast.rows[0].grouping).toEqual(
      expect.objectContaining({ type: 'date', levels: ['years', 'quarters'] }),
    );
  });

  it('still reports unknown fields', () => {
    const r = processDsl('ROWS: BI.dim_customer.nope\nVALUES: [Revenue]', biCtx());
    expect(hardErrors(r).some((m) => m.includes('Unknown field'))).toBe(true);
  });

  it('field options still work after a three-segment field', () => {
    const r = processDsl(
      'ROWS: BI.dim_customer.fullname (no-subtotals)\nVALUES: [Revenue]',
      biCtx(),
    );
    expect(hardErrors(r)).toHaveLength(0);
    expect(r.rows[0].name).toBe('BI.dim_customer.fullname');
  });
});

describe('compileDesignQuery with dotted table names', () => {
  it('splits row fields at the table boundary, not the first dot', () => {
    const compiled = compileDesignQuery(
      'ROWS: BI.dim_customer.fullname\nVALUES: [Revenue]',
      'conn-1',
      MODEL,
    );
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.request).not.toBeNull();
    expect(compiled.request!.rowFields).toEqual([
      { table: 'BI.dim_customer', column: 'fullname', isLookup: undefined },
    ]);
    // customName carries the visual-editor bracket convention for measures
    expect(compiled.request!.valueFields).toEqual([
      { measureName: 'Revenue', customName: '[Revenue]' },
    ]);
  });

  it('bracketed field form produces the same request', () => {
    const compiled = compileDesignQuery(
      'ROWS: [BI.dim_customer.fullname]\nVALUES: [Revenue]',
      'conn-1',
      MODEL,
    );
    expect(compiled.errors).toHaveLength(0);
    expect(compiled.request!.rowFields[0]).toEqual(
      expect.objectContaining({ table: 'BI.dim_customer', column: 'fullname' }),
    );
  });
});

describe('serializer round-trip with dotted table names', () => {
  it('emits three-segment field keys unquoted and re-compiles them', () => {
    const text = serialize(
      [{ sourceIndex: -1, name: 'BI.dim_customer.fullname', isNumeric: false }],
      [],
      [
        {
          sourceIndex: -1,
          name: '[Revenue]',
          isNumeric: true,
          aggregation: 'sum',
          customName: '[Revenue]',
        },
      ],
      [],
      {},
      { biModel: MODEL },
    );
    expect(text).toContain('BI.dim_customer.fullname');
    expect(text).not.toContain('"BI.dim_customer.fullname"');

    const r = processDsl(text, biCtx());
    expect(hardErrors(r)).toHaveLength(0);
    expect(r.rows[0].name).toBe('BI.dim_customer.fullname');
    expect(r.values[0].name).toBe('[Revenue]');
  });
});

describe('flat (grid) fields whose names contain dots', () => {
  const FLAT: SourceField[] = [
    { index: 0, name: 'Order.Ref', isNumeric: false },
    { index: 1, name: 'Sales', isNumeric: true },
  ];
  const gridCtx = (): CompileContext => ({ sourceFields: FLAT });

  it('quoted form resolves as a literal flat name', () => {
    const r = processDsl('ROWS: "Order.Ref"\nVALUES: Sum(Sales)', gridCtx());
    expect(hardErrors(r)).toHaveLength(0);
    expect(r.rows[0].name).toBe('Order.Ref');
    expect(r.rows[0].sourceIndex).toBe(0);
  });

  it('bare dotted form also resolves against flat fields', () => {
    const r = processDsl('ROWS: Order.Ref\nVALUES: Sum(Sales)', gridCtx());
    expect(hardErrors(r)).toHaveLength(0);
    expect(r.rows[0].sourceIndex).toBe(0);
  });
});
