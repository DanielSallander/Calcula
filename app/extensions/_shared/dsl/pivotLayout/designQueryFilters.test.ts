//! FILENAME: app/extensions/_shared/dsl/pivotLayout/designQueryFilters.test.ts
// PURPOSE: BUG-0197 -- a chart's or report's design query must FILTER by every
//          item filter its text says.
// CONTEXT: A design query runs headlessly against a model (`run_design_query`,
//          and the report commands on the same compute core); there is no
//          pivot whose item list could invert an inclusion `Field = ("a")`,
//          so the compiler reports it unresolved and the request carried no
//          filter at all: `Region = ("East")` in a chart showed every region,
//          with no warning. Owner default 2026-09-28: it must WORK, not warn.
//          The request now carries the inclusion itself (`includedItems`) and
//          the backend inverts it against the query's own result. A ROWS/
//          COLUMNS `NOT IN (...)` was dropped the same way (the mapping never
//          copied a row's list).

import { describe, it, expect } from 'vitest';
import { compileDesignQuery } from './designQuery';
import type { BiPivotModelInfo } from '../../components/types';

const col = (name: string) => ({ name, dataType: 'string', isNumeric: false });
const biModel: BiPivotModelInfo = {
  tables: [
    { name: 'Geo', columns: [col('Region'), col('City')] },
    { name: 'Sales', columns: [col('Channel'), col('Year')] },
  ],
  measures: [{ name: 'Revenue' } as BiPivotModelInfo['measures'][number]],
  connectionId: 'c1',
};

function compiled(text: string) {
  const out = compileDesignQuery(text, 'c1', biModel);
  expect(out.errors).toEqual([]);
  expect(out.request).not.toBeNull();
  return out.request!;
}

describe('compileDesignQuery carries every item filter', () => {
  it('an inclusion filter reaches the request as the items to KEEP', () => {
    const req = compiled('ROWS: Geo.City\nVALUES: [Revenue]\nFILTERS: Geo.Region = ("East", "North")');
    expect(req.filterFields).toEqual([
      { table: 'Geo', column: 'Region', includedItems: ['East', 'North'], hiddenItems: [] },
    ]);
  });

  it('an exclusion filter still reaches it as the items to hide, with no inclusion', () => {
    const req = compiled('ROWS: Geo.City\nVALUES: [Revenue]\nFILTERS: Sales.Year NOT IN ("2023")');
    expect(req.filterFields).toEqual([{ table: 'Sales', column: 'Year', hiddenItems: ['2023'] }]);
    expect(req.filterFields[0]).not.toHaveProperty('includedItems');
  });

  it('a bare filter field is placed and filters nothing', () => {
    const req = compiled('ROWS: Geo.City\nVALUES: [Revenue]\nFILTERS: Sales.Channel');
    expect(req.filterFields).toEqual([{ table: 'Sales', column: 'Channel', hiddenItems: [] }]);
  });

  it("a row's or column's NOT IN list reaches the request", () => {
    const req = compiled(
      'ROWS: Geo.Region NOT IN ("West")\nCOLUMNS: Sales.Year NOT IN ("2022", "2023")\nVALUES: [Revenue]',
    );
    expect(req.rowFields).toEqual([{ table: 'Geo', column: 'Region', hiddenItems: ['West'] }]);
    expect(req.columnFields).toEqual([{ table: 'Sales', column: 'Year', hiddenItems: ['2022', '2023'] }]);
  });

  it('a row with no list carries no hiddenItems key', () => {
    const req = compiled('ROWS: Geo.Region\nVALUES: [Revenue]');
    expect(req.rowFields).toEqual([{ table: 'Geo', column: 'Region' }]);
  });
});

describe('compileDesignQuery sends ONE filter ref per field', () => {
  // Two `=` terms on one field used to collapse to the LAST one (a Map by field
  // name, last wins, handed to both refs): a drill-through's baked
  // `("Bikes")` REPLACED the author's `("Bikes", "Clothing")` -- or, the other
  // way round, a page slicer's whole list replaced the clicked member. The
  // result was silently wrong, not empty. SABOTAGE: rebuild the inclusions as
  // `new Map(unresolvedInclusions.map(u => [u.fieldName, u.values]))`.

  it('two inclusion terms on one field AND together: the INTERSECTION, in the first list\'s order', () => {
    const req = compiled(
      'ROWS: Geo.City\nVALUES: [Revenue]\nFILTERS: Geo.Region = ("East", "North", "West"), Geo.Region = ("West", "East")',
    );
    expect(req.filterFields).toEqual([
      { table: 'Geo', column: 'Region', includedItems: ['East', 'West'], hiddenItems: [] },
    ]);
  });

  it('the author\'s inclusion and a second FILTERS clause (a baked drill term) AND together', () => {
    const req = compiled(
      'ROWS: Geo.City\nVALUES: [Revenue]\nFILTERS: Geo.Region = ("East", "North")\nFILTERS: [Geo.Region] = ("East")',
    );
    expect(req.filterFields).toEqual([
      { table: 'Geo', column: 'Region', includedItems: ['East'], hiddenItems: [] },
    ]);
  });

  it('two lists with no member in common travel as an EMPTY inclusion (keeps nothing), never as "no filter"', () => {
    const req = compiled('ROWS: Geo.City\nVALUES: [Revenue]\nFILTERS: Geo.Region = ("East"), Geo.Region = ("West")');
    expect(req.filterFields).toEqual([{ table: 'Geo', column: 'Region', includedItems: [], hiddenItems: [] }]);
  });

  it('two NOT IN terms on one field UNITE their hidden items, once each', () => {
    const req = compiled(
      'ROWS: Geo.City\nVALUES: [Revenue]\nFILTERS: Sales.Year NOT IN ("2022", "2023"), Sales.Year NOT IN ("2023", "2021")',
    );
    expect(req.filterFields).toEqual([{ table: 'Sales', column: 'Year', hiddenItems: ['2022', '2023', '2021'] }]);
    expect(req.filterFields[0]).not.toHaveProperty('includedItems');
  });

  it('an inclusion and an exclusion on one field ride ONE ref', () => {
    const req = compiled(
      'ROWS: Geo.City\nVALUES: [Revenue]\nFILTERS: Geo.Region = ("East", "West"), Geo.Region NOT IN ("West")',
    );
    expect(req.filterFields).toEqual([
      { table: 'Geo', column: 'Region', includedItems: ['East', 'West'], hiddenItems: ['West'] },
    ]);
  });

  it('different fields stay different refs, in first-appearance order', () => {
    const req = compiled(
      'ROWS: Geo.City\nVALUES: [Revenue]\nFILTERS: Sales.Year NOT IN ("2023"), Geo.Region = ("East"), Sales.Year NOT IN ("2022")',
    );
    expect(req.filterFields).toEqual([
      { table: 'Sales', column: 'Year', hiddenItems: ['2023', '2022'] },
      { table: 'Geo', column: 'Region', includedItems: ['East'], hiddenItems: [] },
    ]);
  });

  it('a bracketed field name with another casing is the same field (the compiler emits the model\'s spelling)', () => {
    const req = compiled('ROWS: Geo.City\nVALUES: [Revenue]\nFILTERS: geo.region = ("East", "North"), [Geo.Region] = ("North")');
    expect(req.filterFields).toEqual([{ table: 'Geo', column: 'Region', includedItems: ['North'], hiddenItems: [] }]);
  });
});
