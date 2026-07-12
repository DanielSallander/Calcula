//! FILENAME: app/extensions/_shared/dsl/pivotLayout/controlRefs.test.ts
// PURPOSE: Field parameters — @CONTROL(name) substitution unit tests.

import { describe, it, expect } from 'vitest';
import { substituteControlRefs } from './controlRefs';

const RESOLVE = (name: string): string | undefined =>
  ({ groupfield: 'Customer.city', topn: '5' })[name.toLowerCase()];

describe('substituteControlRefs', () => {
  it('substitutes a resolved reference in place', () => {
    const r = substituteControlRefs('ROWS: @CONTROL(GroupField)', RESOLVE);
    expect(r.text).toBe('ROWS: Customer.city');
    expect(r.controls).toEqual(['GroupField']);
    expect(r.errors).toEqual([]);
  });

  it('substitutes multiple references and is case-insensitive on the keyword', () => {
    const r = substituteControlRefs(
      'ROWS: @control(GroupField)\nTOPN: @CONTROL(TopN) BY Revenue',
      RESOLVE,
    );
    expect(r.text).toBe('ROWS: Customer.city\nTOPN: 5 BY Revenue');
    expect(r.controls).toEqual(['GroupField', 'TopN']);
    expect(r.errors).toEqual([]);
  });

  it('reports an unknown control and leaves the reference in place', () => {
    const r = substituteControlRefs('ROWS: @CONTROL(Nope)', RESOLVE);
    expect(r.text).toBe('ROWS: @CONTROL(Nope)');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].severity).toBe('error');
    expect(r.errors[0].message).toContain("'Nope'");
    expect(r.errors[0].location.line).toBe(1);
  });

  it('reports an empty reference', () => {
    const r = substituteControlRefs('ROWS: @CONTROL(  )', RESOLVE);
    expect(r.errors).toHaveLength(1);
    expect(r.controls).toEqual([]);
  });

  it('locates errors on the right line', () => {
    const r = substituteControlRefs('ROWS: a\nCOLUMNS: @CONTROL(Missing)', RESOLVE);
    expect(r.errors[0].location.line).toBe(2);
    expect(r.errors[0].location.column).toBe(9);
  });

  it('passes through text with no references untouched', () => {
    const text = 'ROWS: region\nVALUES: SUM(amount)';
    const r = substituteControlRefs(text, RESOLVE);
    expect(r.text).toBe(text);
    expect(r.controls).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('dedupes repeated references (case-insensitively) in controls list', () => {
    const r = substituteControlRefs(
      'ROWS: @CONTROL(GroupField)\nCOLUMNS: @CONTROL(groupfield)',
      RESOLVE,
    );
    expect(r.controls).toEqual(['GroupField']);
  });
});
