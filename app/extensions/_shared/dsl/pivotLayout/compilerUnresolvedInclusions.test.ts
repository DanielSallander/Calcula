//! FILENAME: app/extensions/_shared/dsl/pivotLayout/compilerUnresolvedInclusions.test.ts
// PURPOSE: The compiler REPORTS an inclusion filter (`Field = ("a", "b")`) it
//          could not invert into hidden items (`CompileResult.unresolvedInclusions`)
//          -- and reports nothing else.
// CONTEXT: Fix round 4, F4. A filter stores the items it HIDES, so `= (...)`
//          is inverted against the field's full item list
//          (`filterUniqueValues`). Without one the compiler hands the field back
//          with NO hidden items -- the same shape as a clause with no list -- and
//          the pivot editor read that as "remove the filter" (review3 finding
//          3). Round 3's fix inferred the unresolved fields from which item
//          lists the compiler LOOKED UP; the compiler now says so itself, where
//          it gives up, so a consumer never has to guess.

import { describe, it, expect } from 'vitest';
import { compile, lex, parse, processDsl, type CompileContext } from './index';
import type { BiPivotModelInfo, SourceField } from '../../components/types';

const col = (name: string) => ({ name, dataType: 'string', isNumeric: false });
const biModel: BiPivotModelInfo = {
  tables: [
    { name: 'Geo', columns: [col('Region')] },
    { name: 'Sales', columns: [col('Channel'), col('Year')] },
  ],
  measures: [{ name: 'Revenue' } as BiPivotModelInfo['measures'][number]],
  connectionId: 'c1',
};
const FIELDS: SourceField[] = [
  { index: 0, name: 'Region', isNumeric: false },
  { index: 1, name: 'Channel', isNumeric: false },
  { index: 2, name: 'Sales', isNumeric: true },
];

const BI_TEXT =
  'ROWS: Geo.Region\nVALUES: [Revenue]\nFILTERS: Sales.Channel = ("Store"), Sales.Year NOT IN ("2023")';

function bi(filterUniqueValues?: Map<string, string[]>): CompileContext {
  return { sourceFields: [], biModel, filterUniqueValues };
}

describe('CompileResult.unresolvedInclusions', () => {
  it('names an inclusion whose item list is not loaded, with its clause location, and leaves it unfiltered', () => {
    const res = processDsl(BI_TEXT, bi(new Map()));
    expect(res.unresolvedInclusions).toHaveLength(1);
    const [u] = res.unresolvedInclusions;
    expect(u.fieldName).toBe('Sales.Channel');
    expect(u.location.line).toBe(3);
    expect(u.location.column).toBeGreaterThan(0);
    // The field is still placed, with no list: the shape the report exists to disambiguate.
    const channel = res.filters.find((f) => f.name === 'Sales.Channel');
    expect(channel).toBeDefined();
    expect(channel!.hiddenItems).toBeUndefined();
    // The compiler adds no diagnostic of its own: the reaction is the consumer's.
    expect(res.errors).toEqual([]);
  });

  it('is empty when the item list IS loaded (the inclusion inverts)', () => {
    const res = processDsl(BI_TEXT, bi(new Map([['Sales.Channel', ['Store', 'Web', 'Phone']]])));
    expect(res.unresolvedInclusions).toEqual([]);
    expect(res.filters[0].hiddenItems).toEqual(['Web', 'Phone']);
  });

  it('an EMPTY item list cannot invert either, so it is reported', () => {
    const res = processDsl(BI_TEXT, bi(new Map([['Sales.Channel', []]])));
    expect(res.unresolvedInclusions.map((u) => u.fieldName)).toEqual(['Sales.Channel']);
  });

  it('never reports a NOT IN clause or a bare filter field, whatever the item lists hold', () => {
    const text = 'ROWS: Geo.Region\nVALUES: [Revenue]\nFILTERS: Sales.Year NOT IN ("2023"), Sales.Channel';
    // No lists at all, and an empty list for each: neither clause needs inverting.
    expect(processDsl(text, bi()).unresolvedInclusions).toEqual([]);
    expect(
      processDsl(text, bi(new Map([['Sales.Year', []], ['Sales.Channel', []]]))).unresolvedInclusions,
    ).toEqual([]);
  });

  it('reports on the regular (range) pivot path too, by the source field name', () => {
    const res = processDsl('ROWS: Region\nVALUES: Sum(Sales)\nFILTERS: Channel = ("Store", "Web")', {
      sourceFields: FIELDS,
    });
    expect(res.unresolvedInclusions.map((u) => u.fieldName)).toEqual(['Channel']);
    expect(res.unresolvedInclusions[0].location.line).toBe(3);
  });

  it('an unknown filter field is an error, not an unresolved inclusion', () => {
    const res = processDsl('ROWS: Region\nVALUES: Sum(Sales)\nFILTERS: Nope = ("x")', { sourceFields: FIELDS });
    expect(res.unresolvedInclusions).toEqual([]);
    expect(res.errors.some((e) => e.severity === 'error' && e.message.includes('Nope'))).toBe(true);
  });

  it('`compile` itself carries it (not only the processDsl wrapper)', () => {
    const { ast } = parse(lex(BI_TEXT).tokens);
    const res = compile(ast, bi());
    expect(res.unresolvedInclusions.map((u) => u.fieldName)).toEqual(['Sales.Channel']);
  });
});
