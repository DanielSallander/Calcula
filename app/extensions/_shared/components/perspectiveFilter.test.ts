//! FILENAME: app/extensions/_shared/components/perspectiveFilter.test.ts
// PURPOSE: Unit tests for the perspective display filter (field-list subsets).

import { describe, it, expect } from 'vitest';
import { applyPerspective, type BiPerspectiveInfo } from './perspectiveFilter';

const MODEL = {
  tables: [
    {
      name: 'Sales',
      columns: [{ name: 'amount' }, { name: 'qty' }, { name: 'region' }],
    },
    {
      name: 'Customer',
      columns: [{ name: 'name' }, { name: 'city' }, { name: 'email' }],
    },
    {
      name: 'AuditLog',
      columns: [{ name: 'entry' }],
    },
  ],
  measures: [{ name: 'Revenue' }, { name: 'Units' }, { name: 'Margin' }],
  hierarchies: [
    { table: 'Sales', name: 'Geo' },
    { table: 'Customer', name: 'CustGeo' },
  ],
};

const PERSPECTIVES: BiPerspectiveInfo[] = [
  {
    name: 'Sales view',
    tables: ['Sales'],
    columns: ['Customer[city]'],
    measures: ['Revenue'],
    description: 'Sales team',
  },
  {
    name: 'Empty',
    tables: [],
    columns: [],
    measures: [],
  },
];

describe('applyPerspective', () => {
  it('returns the model unchanged with no selection', () => {
    expect(applyPerspective(MODEL, PERSPECTIVES, null)).toBe(MODEL);
    expect(applyPerspective(MODEL, PERSPECTIVES, undefined)).toBe(MODEL);
  });

  it('returns the model unchanged for an unknown perspective name', () => {
    expect(applyPerspective(MODEL, PERSPECTIVES, 'Deleted one')).toBe(MODEL);
  });

  it('keeps fully-listed tables with all columns', () => {
    const r = applyPerspective(MODEL, PERSPECTIVES, 'Sales view');
    const sales = r.tables.find((t) => t.name === 'Sales');
    expect(sales?.columns.map((c) => c.name)).toEqual(['amount', 'qty', 'region']);
  });

  it('keeps only individually-listed columns of other tables', () => {
    const r = applyPerspective(MODEL, PERSPECTIVES, 'Sales view');
    const customer = r.tables.find((t) => t.name === 'Customer');
    expect(customer?.columns.map((c) => c.name)).toEqual(['city']);
  });

  it('drops tables with no listing at all', () => {
    const r = applyPerspective(MODEL, PERSPECTIVES, 'Sales view');
    expect(r.tables.find((t) => t.name === 'AuditLog')).toBeUndefined();
  });

  it('filters measures to the listed names', () => {
    const r = applyPerspective(MODEL, PERSPECTIVES, 'Sales view');
    expect(r.measures.map((m) => m.name)).toEqual(['Revenue']);
  });

  it('keeps hierarchies only on fully-listed tables', () => {
    const r = applyPerspective(MODEL, PERSPECTIVES, 'Sales view');
    expect(r.hierarchies?.map((h) => h.name)).toEqual(['Geo']);
  });

  it('matches names case-insensitively (perspective, table, column, measure)', () => {
    const r = applyPerspective(
      MODEL,
      [
        {
          name: 'CI',
          tables: ['SALES'],
          columns: ['customer[CITY]'],
          measures: ['revenue'],
        },
      ],
      'ci',
    );
    expect(r.tables.map((t) => t.name)).toEqual(['Sales', 'Customer']);
    expect(r.measures.map((m) => m.name)).toEqual(['Revenue']);
  });

  it('an empty perspective shows nothing', () => {
    const r = applyPerspective(MODEL, PERSPECTIVES, 'Empty');
    expect(r.tables).toEqual([]);
    expect(r.measures).toEqual([]);
    expect(r.hierarchies).toEqual([]);
  });

  it('ignores malformed column refs', () => {
    const r = applyPerspective(
      MODEL,
      [
        {
          name: 'Malformed',
          tables: [],
          columns: ['not_qualified', '[onlycol]', 'Customer[city]'],
          measures: [],
        },
      ],
      'Malformed',
    );
    expect(r.tables.map((t) => t.name)).toEqual(['Customer']);
    expect(r.tables[0].columns.map((c) => c.name)).toEqual(['city']);
  });

  it('handles a model without hierarchies', () => {
    const r = applyPerspective(
      { tables: MODEL.tables, measures: MODEL.measures },
      PERSPECTIVES,
      'Sales view',
    );
    expect(r.hierarchies).toBeUndefined();
  });
});
