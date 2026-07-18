// PURPOSE: Tests for calculation groups in the Pivot Layout DSL. A calc group
//          is a DIMENSION (Power BI-style): its plain name is a valid
//          ROWS/COLUMNS/FILTERS entry, resolving to a zone chip named after
//          the group; `NOT IN (...)` carries the item subset
//          (parse -> compile -> validate -> serialize round-trip).
import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { parse } from './parser';
import { compile, type CompileContext } from './compiler';
import { validate } from './validator';
import { serialize } from './serializer';
import type { BiPivotModelInfo, LayoutConfig, ZoneField } from '../../components/types';

const biModel: BiPivotModelInfo = {
  tables: [
    {
      name: 'dim_date',
      columns: [{ name: 'year', dataType: 'int', isNumeric: true }],
    },
  ],
  measures: [{ name: 'Revenue', table: 'fact', sourceColumn: '', aggregation: 'sum' }],
  calculationGroups: [
    {
      name: 'Time',
      items: [
        { name: 'Current', source: 'SELECTEDMEASURE()' },
        { name: 'YTD', source: 'TOTALYTD(SELECTEDMEASURE())' },
        { name: 'PY', source: 'CALCULATE(SELECTEDMEASURE())' },
      ],
    },
  ],
};

function compileDsl(dsl: string, ctx: CompileContext) {
  const { tokens } = lex(dsl);
  const { ast } = parse(tokens);
  return { result: compile(ast, ctx), ast };
}

const ctx: CompileContext = { sourceFields: [], biModel };

describe('calculation groups as dimension fields', () => {
  it('resolves a group name as a ROWS entry (canonical casing)', () => {
    const { result } = compileDsl('ROWS: time\nVALUES: [Revenue]', ctx);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sourceIndex: -1,
      name: 'Time',
      isNumeric: false,
    });
  });

  it('resolves a group name as a COLUMNS entry', () => {
    const { result } = compileDsl('COLUMNS: Time\nVALUES: [Revenue]', ctx);
    expect(result.errors).toHaveLength(0);
    expect(result.columns[0].name).toBe('Time');
  });

  it('resolves a group name as a FILTERS entry with NOT IN item subset', () => {
    const { result } = compileDsl('ROWS: dim_date.year\nFILTERS: Time NOT IN ("PY")', ctx);
    expect(result.errors).toHaveLength(0);
    expect(result.filters[0]).toMatchObject({
      name: 'Time',
      hiddenItems: ['PY'],
    });
  });

  it('carries a NOT IN item subset on a ROWS entry', () => {
    const { result } = compileDsl('ROWS: Time NOT IN ("YTD", "PY")\nVALUES: [Revenue]', ctx);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]).toMatchObject({
      name: 'Time',
      hiddenItems: ['YTD', 'PY'],
    });
  });

  it('errors when a group is used in VALUES', () => {
    const { result } = compileDsl('VALUES: Sum(Time)', ctx);
    expect(result.errors.some(e => /is a dimension/.test(e.message))).toBe(true);
  });

  it('validator accepts a group entry and rejects unknown names', () => {
    const good = compileDsl('ROWS: Time\nVALUES: [Revenue]', ctx);
    expect(validate(good.ast, { sourceFields: [], biModel })).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/Unknown field/) }),
      ]),
    );

    const bad = compileDsl('ROWS: Nope\nVALUES: [Revenue]', ctx);
    expect(
      validate(bad.ast, { sourceFields: [], biModel }).some(e => /Unknown field/.test(e.message)),
    ).toBe(true);
  });

  it('serializes a placed group chip with its item subset and round-trips', () => {
    const rows: ZoneField[] = [
      { sourceIndex: -1, name: 'Time', isNumeric: false, hiddenItems: ['PY'] },
    ];
    const text = serialize(rows, [], [], [], {} as LayoutConfig, { biModel });
    expect(text).toContain('Time NOT IN ("PY")');

    const { result } = compileDsl(text, ctx);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]).toMatchObject({ name: 'Time', hiddenItems: ['PY'] });
  });

  it('CALCGROUP is no longer a clause keyword', () => {
    const { tokens } = lex('CALCGROUP: Time');
    const { errors } = parse(tokens);
    expect(errors.some(e => /Unexpected token/.test(e.message))).toBe(true);
  });
});
