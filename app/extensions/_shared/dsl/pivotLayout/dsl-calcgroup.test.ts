// PURPOSE: Tests for the CALCGROUP clause in the Pivot Layout DSL
//          (parse -> compile -> validate -> serialize round-trip).
import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { parse } from './parser';
import { compile, type CompileContext } from './compiler';
import { serialize } from './serializer';
import type { BiPivotModelInfo, LayoutConfig } from '../../components/types';

const biModel: BiPivotModelInfo = {
  tables: [],
  measures: [],
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
  return compile(ast, ctx);
}

const ctx: CompileContext = { sourceFields: [], biModel };

describe('CALCGROUP clause', () => {
  it('compiles a group with no items to all-items (empty list)', () => {
    const result = compileDsl('CALCGROUP: Time', ctx);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedCalcGroup).toEqual({ group: 'Time', items: [] });
  });

  it('compiles a group with a parenthesized item subset', () => {
    const result = compileDsl('CALCGROUP: Time (Current, YTD)', ctx);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedCalcGroup).toEqual({ group: 'Time', items: ['Current', 'YTD'] });
  });

  it('canonicalizes item casing to the model declaration', () => {
    const result = compileDsl('CALCGROUP: time (current, ytd)', ctx);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedCalcGroup).toEqual({ group: 'Time', items: ['Current', 'YTD'] });
  });

  it('errors on an unknown group', () => {
    const result = compileDsl('CALCGROUP: Nope', ctx);
    expect(result.appliedCalcGroup).toBeUndefined();
    expect(result.errors.some(e => /Unknown calculation group/.test(e.message))).toBe(true);
  });

  it('errors on an unknown item', () => {
    const result = compileDsl('CALCGROUP: Time (Current, Bogus)', ctx);
    expect(result.errors.some(e => /Unknown calculation item/.test(e.message))).toBe(true);
  });

  it('errors when used without a BI model', () => {
    const result = compileDsl('CALCGROUP: Time', { sourceFields: [] });
    expect(result.appliedCalcGroup).toBeUndefined();
    expect(result.errors.some(e => /only supported for BI/.test(e.message))).toBe(true);
  });

  it('serializes an applied group with items', () => {
    const text = serialize([], [], [], [], {} as LayoutConfig, {
      biModel,
      appliedCalcGroup: { group: 'Time', items: ['Current', 'YTD'] },
    });
    expect(text).toContain('CALCGROUP: Time (Current, YTD)');
  });

  it('serializes an all-items group without parentheses', () => {
    const text = serialize([], [], [], [], {} as LayoutConfig, {
      biModel,
      appliedCalcGroup: { group: 'Time', items: [] },
    });
    expect(text).toContain('CALCGROUP: Time');
    expect(text).not.toContain('(');
  });

  it('round-trips serialize -> parse -> compile', () => {
    const text = serialize([], [], [], [], {} as LayoutConfig, {
      biModel,
      appliedCalcGroup: { group: 'Time', items: ['Current', 'PY'] },
    });
    const result = compileDsl(text, ctx);
    expect(result.errors).toHaveLength(0);
    expect(result.appliedCalcGroup).toEqual({ group: 'Time', items: ['Current', 'PY'] });
  });
});
