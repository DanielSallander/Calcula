import { describe, it, expect } from 'vitest';
import { splitBiFieldKey } from './biFieldKey';

describe('splitBiFieldKey', () => {
  const tables = ['BI.dim_customer', 'BI.fact_sales', 'dim_date'];

  it('resolves dotted table names by longest prefix', () => {
    expect(splitBiFieldKey('BI.dim_customer.fullname', tables)).toEqual({
      table: 'BI.dim_customer',
      column: 'fullname',
    });
  });

  it('resolves plain table names', () => {
    expect(splitBiFieldKey('dim_date.year', tables)).toEqual({
      table: 'dim_date',
      column: 'year',
    });
  });

  it('falls back to first-dot split for unknown dotted keys', () => {
    expect(splitBiFieldKey('Orders.Amount', tables)).toEqual({
      table: 'Orders',
      column: 'Amount',
    });
  });

  it('falls back to first-dot split without a table list', () => {
    expect(splitBiFieldKey('Orders.Amount')).toEqual({
      table: 'Orders',
      column: 'Amount',
    });
  });

  it('returns an empty table for bare column names', () => {
    expect(splitBiFieldKey('Amount', tables)).toEqual({ table: '', column: 'Amount' });
  });

  it('does not treat a key that exactly equals a table name as a prefix match', () => {
    expect(splitBiFieldKey('BI.fact_sales', tables)).toEqual({
      table: 'BI',
      column: 'fact_sales',
    });
  });
});
