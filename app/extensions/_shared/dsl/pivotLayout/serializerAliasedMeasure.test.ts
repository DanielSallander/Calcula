//! FILENAME: app/extensions/_shared/dsl/pivotLayout/serializerAliasedMeasure.test.ts
// PURPOSE: BUG-0480 -- the serializer writes a BI measure under its OWN name and
//          its alias only in the AS clause. It used to write the alias in the
//          brackets (`[Revenue] AS "Sales"` -> `[Sales] AS "Sales"`), a query
//          that names a measure that does not exist, or silently a DIFFERENT
//          one when the model has a measure called like the alias.
// CONTEXT: Every caller that regenerates DSL from zones goes through
//          serializeValueField: the pivot editor's Design tab after a visual
//          edit, getPivotDsl over the backend's field configuration, and the
//          design-query chart's Fields wells.

import { describe, it, expect } from 'vitest';
import { processDsl, serialize } from './index';
import { sameDesignQuery } from './canonical';
import type { BiPivotModelInfo, SourceField, ZoneField } from '../../components/types';

const col = (name: string, isNumeric = false) => ({ name, dataType: isNumeric ? 'number' : 'string', isNumeric });

const MODEL: BiPivotModelInfo = {
  tables: [{ name: 'Geo', columns: [col('Region'), col('City')] }],
  measures: [
    { name: 'Revenue', table: 'Sales', sourceColumn: 'amount', aggregation: 'sum' },
    { name: 'Cost', table: 'Sales', sourceColumn: 'cost', aggregation: 'sum' },
  ],
  connectionId: 'conn-a',
};

/** Compile against the model, then serialize the compiled zones back. */
function biRoundTrip(dsl: string): { text: string; values: ZoneField[] } {
  const compiled = processDsl(dsl, { sourceFields: [], biModel: MODEL });
  expect(compiled.errors.filter((e) => e.severity === 'error')).toEqual([]);
  const text = serialize(compiled.rows, compiled.columns, compiled.values, compiled.filters, compiled.layout, {
    biModel: MODEL,
  });
  return { text, values: compiled.values };
}

/** Re-compile serialized text and return its value fields (errors fail the test). */
function recompileValues(text: string): ZoneField[] {
  const again = processDsl(text, { sourceFields: [], biModel: MODEL });
  expect(again.errors.filter((e) => e.severity === 'error')).toEqual([]);
  return again.values;
}

describe('BUG-0480: an aliased BI measure is written under its own name', () => {
  it('[Revenue] AS "Sales" round-trips as itself, not as [Sales]', () => {
    const dsl = 'ROWS: Geo.Region\nVALUES: [Revenue] AS "Sales"';
    const { text, values } = biRoundTrip(dsl);
    // The compiler's own shape: the measure in `name`, the alias in customName.
    expect(values[0]).toMatchObject({ name: '[Revenue]', customName: 'Sales' });

    expect(text).toContain('VALUES:  [Revenue] AS "Sales"');
    expect(text).not.toContain('[Sales]');
    expect(sameDesignQuery(text, dsl)).toBe(true);

    // And the regenerated text still compiles to the SAME measure.
    expect(recompileValues(text)[0]).toMatchObject({ name: '[Revenue]', customName: 'Sales' });
  });

  it('an alias spelled like ANOTHER measure never re-points the field at that measure', () => {
    const dsl = 'ROWS: Geo.Region\nVALUES: [Revenue] AS "Cost"';
    const { text } = biRoundTrip(dsl);
    expect(text).toContain('VALUES:  [Revenue] AS "Cost"');
    expect(text).not.toContain('[Cost]');
    const values = recompileValues(text);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ name: '[Revenue]', customName: 'Cost' });
  });

  it('two measures, one aliased: each keeps its own measure and only the alias carries AS', () => {
    const dsl = 'ROWS: Geo.Region\nVALUES: [Revenue] AS "Sales", [Cost]';
    const { text } = biRoundTrip(dsl);
    expect(text).toContain('[Revenue] AS "Sales"');
    expect(text).toMatch(/\[Cost\](?! AS)/);
    expect(sameDesignQuery(text, dsl)).toBe(true);
    expect(recompileValues(text).map((v) => v.name)).toEqual(['[Revenue]', '[Cost]']);
  });

  it('a non-aliased measure is written bare, with no AS clause', () => {
    const dsl = 'ROWS: Geo.Region\nVALUES: [Revenue]';
    const { text } = biRoundTrip(dsl);
    expect(text).toContain('VALUES:  [Revenue]');
    expect(text).not.toContain(' AS ');
    expect(sameDesignQuery(text, dsl)).toBe(true);
  });

  it('the backend field-configuration shape (getPivotDsl) keeps the measure, aliases it in AS', () => {
    // pivot_field_configuration -> value_zone_fields: name keeps the "[...]"
    // wrapper (the measure), custom_name holds the user's alias.
    const value: ZoneField = { sourceIndex: 3, name: '[Revenue]', isNumeric: true, aggregation: 'sum', customName: 'Sales' };
    const text = serialize([], [], [value], [], {}, { biModel: MODEL });
    expect(text).toBe('VALUES:  [Revenue] AS "Sales"');
  });

  it('a bracketed measure the model no longer has is written as itself (the compiler reports it), never as its alias', () => {
    const value: ZoneField = { sourceIndex: -1, name: '[Gone]', isNumeric: true, aggregation: 'sum', customName: 'Cost' };
    const text = serialize([], [], [value], [], {}, { biModel: MODEL });
    expect(text).toBe('VALUES:  [Gone] AS "Cost"');
    const again = processDsl(text, { sourceFields: [], biModel: MODEL });
    expect(again.errors.some((e) => e.severity === 'error' && e.message.includes('[Gone]'))).toBe(true);
  });
});

describe('a sheet (non-BI) value field with a custom name is unchanged', () => {
  const SOURCE: SourceField[] = [
    { index: 0, name: 'Region', isNumeric: false },
    { index: 1, name: 'Revenue', isNumeric: true },
  ];

  it('Sum(Revenue) AS "Total Revenue" round-trips', () => {
    const dsl = 'ROWS: Region\nVALUES: Sum(Revenue) AS "Total Revenue"';
    const compiled = processDsl(dsl, { sourceFields: SOURCE });
    expect(compiled.errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(compiled.values[0]).toMatchObject({ name: 'Revenue', customName: 'Total Revenue' });
    const text = serialize(compiled.rows, compiled.columns, compiled.values, compiled.filters, compiled.layout);
    expect(text).toContain('VALUES:  Sum(Revenue) AS "Total Revenue"');
    expect(sameDesignQuery(text, dsl)).toBe(true);
  });

  it('a sheet field whose custom name is spelled like a measure stays an aggregation (no biModel)', () => {
    const value: ZoneField = { sourceIndex: 1, name: 'Revenue', isNumeric: true, aggregation: 'sum', customName: '[Cost]' };
    expect(serialize([], [], [value], [], {})).toBe('VALUES:  Sum(Revenue) AS "[Cost]"');
  });
});

// revD#3: the AS clause and SAVE AS wrote their name raw, so a name with a
// double quote in it ended the string literal at that quote and the regenerated
// text no longer compiled ("Unterminated string literal"). Every other literal
// goes through the lexer's one escape, the doubled quote.
describe('revD#3: a name with a double quote in it is escaped, and round-trips', () => {
  const SOURCE: SourceField[] = [
    { index: 0, name: 'Region', isNumeric: false },
    { index: 1, name: 'Revenue', isNumeric: true },
  ];

  it('a BI measure aliased Sa"les: [Revenue] AS "Sa""les" compiles back to the same alias', () => {
    const dsl = 'ROWS: Geo.Region\nVALUES: [Revenue] AS "Sa""les"';
    const { text, values } = biRoundTrip(dsl);
    expect(values[0]).toMatchObject({ name: '[Revenue]', customName: 'Sa"les' });
    expect(text).toContain('VALUES:  [Revenue] AS "Sa""les"');
    expect(recompileValues(text)[0]).toMatchObject({ name: '[Revenue]', customName: 'Sa"les' });
    expect(sameDesignQuery(text, dsl)).toBe(true);
  });

  it('a sheet field renamed Q "1" (Value Field Settings): Sum(Revenue) AS "Q ""1""" compiles back', () => {
    const dsl = 'ROWS: Region\nVALUES: Sum(Revenue) AS "Q ""1"""';
    const compiled = processDsl(dsl, { sourceFields: SOURCE });
    expect(compiled.errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(compiled.values[0]).toMatchObject({ name: 'Revenue', customName: 'Q "1"' });
    const text = serialize(compiled.rows, compiled.columns, compiled.values, compiled.filters, compiled.layout);
    expect(text).toContain('VALUES:  Sum(Revenue) AS "Q ""1"""');
    const again = processDsl(text, { sourceFields: SOURCE });
    expect(again.errors.filter((e) => e.severity === 'error'), `the regenerated text does not compile:\n${text}`).toEqual([]);
    expect(again.values[0]).toMatchObject({ name: 'Revenue', customName: 'Q "1"' });
  });

  it('SAVE AS a layout named My "best" layout writes the doubled quote and compiles back to the name', () => {
    const value: ZoneField = { sourceIndex: 1, name: 'Revenue', isNumeric: true, aggregation: 'sum' };
    const text = serialize([], [], [value], [], {}, { saveAs: 'My "best" layout' });
    expect(text).toContain('SAVE AS "My ""best"" layout"');
    const again = processDsl(text, { sourceFields: SOURCE });
    expect(again.errors.filter((e) => e.severity === 'error'), `the regenerated text does not compile:\n${text}`).toEqual([]);
    expect(again.saveAs).toBe('My "best" layout');
  });
});
