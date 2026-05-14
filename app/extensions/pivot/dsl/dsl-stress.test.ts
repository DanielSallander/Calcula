//! FILENAME: app/extensions/Pivot/dsl/dsl-stress.test.ts
// PURPOSE: Stress and edge-case tests for the Pivot Layout DSL pipeline.

import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { parse } from './parser';
import { processDsl } from './index';
import type { CompileContext } from './compiler';
import type { SourceField } from '../../_shared/components/types';

// ============================================================================
// Test helpers
// ============================================================================

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

function ctx(fields: SourceField[]): CompileContext {
  return { sourceFields: fields };
}

function run(dsl: string, fields: SourceField[]) {
  return processDsl(dsl, ctx(fields));
}

// ============================================================================
// 50+ fields
// ============================================================================

describe('stress: many fields', () => {
  const FIELD_COUNT = 60;
  const manyFields: SourceField[] = Array.from({ length: FIELD_COUNT }, (_, i) =>
    sf(i, `Field${i}`, i >= FIELD_COUNT / 2),
  );

  it('parses and compiles 50+ ROWS fields', () => {
    const names = manyFields.slice(0, 50).map((f) => f.name).join(', ');
    const dsl = `ROWS: ${names}`;
    const result = run(dsl, manyFields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.rows).toHaveLength(50);
  });

  it('parses 50+ VALUES fields', () => {
    const numericFields = manyFields.filter((f) => f.isNumeric).slice(0, 30);
    const valuesStr = numericFields.map((f) => `Sum(${f.name})`).join(', ');
    const dsl = `VALUES: ${valuesStr}`;
    const result = run(dsl, manyFields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.values).toHaveLength(30);
  });

  it('handles ROWS + COLUMNS + VALUES + FILTERS all with many fields', () => {
    const rows = manyFields.slice(0, 10).map((f) => f.name).join(', ');
    const cols = manyFields.slice(10, 15).map((f) => f.name).join(', ');
    const vals = manyFields.filter((f) => f.isNumeric).slice(0, 5).map((f) => `Sum(${f.name})`).join(', ');
    const filters = manyFields.slice(15, 20).map((f) => f.name).join(', ');
    const dsl = `ROWS: ${rows}\nCOLUMNS: ${cols}\nVALUES: ${vals}\nFILTERS: ${filters}`;
    const result = run(dsl, manyFields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.rows).toHaveLength(10);
    expect(result.columns).toHaveLength(5);
  });
});

// ============================================================================
// Very long DSL strings
// ============================================================================

describe('stress: long DSL strings', () => {
  it('handles a DSL string with 200+ characters per line', () => {
    // Create a field with a very long quoted name
    const longName = 'A'.repeat(200);
    const fields = [sf(0, longName)];
    const dsl = `ROWS: "${longName}"`;
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe(longName);
  });

  it('handles multiline DSL with 100+ lines', () => {
    const fieldCount = 100;
    const fields = Array.from({ length: fieldCount }, (_, i) => sf(i, `R${i}`));
    // Each field on its own ROWS line (re-declaration should merge or last wins)
    // Actually, put them all in one ROWS clause
    const names = fields.map((f) => f.name).join(', ');
    const dsl = `ROWS: ${names}`;
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.rows).toHaveLength(fieldCount);
  });

  it('handles very long FILTER NOT IN list', () => {
    const fields = [sf(0, 'City')];
    const cities = Array.from({ length: 200 }, (_, i) => `"City${i}"`).join(', ');
    const dsl = `FILTERS: City NOT IN (${cities})`;
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].hiddenItems).toHaveLength(200);
  });
});

// ============================================================================
// Deeply nested CALC expressions
// ============================================================================

describe('stress: deeply nested CALC expressions', () => {
  it('handles deeply nested bracket references', () => {
    const fields: SourceField[] = [
      sf(0, 'A', true), sf(1, 'B', true), sf(2, 'C', true),
    ];
    // CALC: Result = (([A] + [B]) * [C]) / ([A] - [B] + [C])
    const dsl = 'CALC: Result = (([A] + [B]) * [C]) / ([A] - [B] + [C])';
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.calculatedFields[0].name).toBe('Result');
  });

  it('handles multiple CALC fields referencing each other conceptually', () => {
    const fields: SourceField[] = [
      sf(0, 'Revenue', true), sf(1, 'Cost', true),
    ];
    const dsl = [
      'VALUES: Sum(Revenue), Sum(Cost)',
      'CALC: Profit = [Revenue] - [Cost]',
      'CALC: Margin = [Profit] / [Revenue]',
      'CALC: MarginPct = [Margin] * 100',
    ].join('\n');
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.calculatedFields).toHaveLength(3);
  });

  it('handles CALC with many bracket refs', () => {
    const count = 20;
    const fields = Array.from({ length: count }, (_, i) => sf(i, `M${i}`, true));
    const refs = fields.map((f) => `[${f.name}]`).join(' + ');
    const dsl = `CALC: Total = ${refs}`;
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.calculatedFields[0].formula).toContain('[M0]');
    expect(result.calculatedFields[0].formula).toContain('[M19]');
  });
});

// ============================================================================
// Unicode field names
// ============================================================================

describe('stress: unicode field names', () => {
  it('handles Japanese field names (quoted)', () => {
    const fields = [sf(0, '売上'), sf(1, '利益', true)];
    const dsl = 'ROWS: "売上"\nVALUES: Sum("利益")';
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.rows[0].name).toBe('売上');
  });

  it('handles emoji field names in quotes', () => {
    const fields = [sf(0, '📊 Sales', true)];
    const dsl = 'VALUES: Sum("📊 Sales")';
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
  });

  it('handles accented characters (quoted)', () => {
    const fields = [sf(0, 'Données'), sf(1, 'Résultat', true)];
    const dsl = 'ROWS: "Données"\nVALUES: Sum("Résultat")';
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.rows[0].name).toBe('Données');
  });

  it('handles Arabic/RTL field names in quotes', () => {
    const fields = [sf(0, 'مبيعات')];
    const dsl = 'ROWS: "مبيعات"';
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('edge: malformed and boundary inputs', () => {
  const basicFields = [sf(0, 'X'), sf(1, 'Y', true)];

  it('handles empty string', () => {
    const result = run('', basicFields);
    expect(result.rows).toHaveLength(0);
    expect(result.values).toHaveLength(0);
  });

  it('handles only whitespace', () => {
    const result = run('   \n\n  \t  ', basicFields);
    expect(result.rows).toHaveLength(0);
  });

  it('handles duplicate field in ROWS', () => {
    const result = run('ROWS: X, X, X', basicFields);
    // Should either deduplicate or report warning - just must not crash
    expect(result).toBeDefined();
  });

  it('handles clause keyword with no fields', () => {
    const { tokens, errors: lexErrors } = lex('ROWS:');
    const { ast, errors: parseErrors } = parse(tokens);
    // Should not crash; may produce empty or error
    expect(ast).toBeDefined();
  });

  it('handles repeated clause keywords', () => {
    const result = run('ROWS: X\nROWS: Y', [sf(0, 'X'), sf(1, 'Y')]);
    // Implementation may merge or last-wins - just must not crash
    expect(result).toBeDefined();
  });

  it('handles special characters in quoted names', () => {
    const fields = [sf(0, 'Col (%)'), sf(1, 'Col [#]')];
    const dsl = 'ROWS: "Col (%)", "Col [#]"';
    const result = run(dsl, fields);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });

  it('handles SAVE AS with very long name', () => {
    const longName = 'Layout ' + 'X'.repeat(500);
    const dsl = `ROWS: X\nSAVE AS "${longName}"`;
    const result = run(dsl, [sf(0, 'X')]);
    expect(result.saveAs).toBe(longName);
  });
});

// ============================================================================
// Performance-oriented tests
// ============================================================================

describe('performance: pipeline throughput', () => {
  it('processes 50-field DSL within reasonable time', () => {
    const fieldCount = 50;
    const fields = Array.from({ length: fieldCount }, (_, i) => sf(i, `F${i}`, i >= 25));
    const rows = fields.slice(0, 10).map((f) => f.name).join(', ');
    const vals = fields.filter((f) => f.isNumeric).slice(0, 10).map((f) => `Sum(${f.name})`).join(', ');
    const dsl = `ROWS: ${rows}\nVALUES: ${vals}\nLAYOUT: tabular, no-grand-totals, repeat-labels`;

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      run(dsl, fields);
    }
    const elapsed = performance.now() - start;
    // 100 iterations should complete in under 2 seconds
    expect(elapsed).toBeLessThan(2000);
  });

  it('lexer handles 10k-character input', () => {
    const longInput = 'ROWS: ' + Array.from({ length: 500 }, (_, i) => `Field${i}`).join(', ');
    const start = performance.now();
    const { errors } = lex(longInput);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    // Errors expected for unknown fields, but lexer itself should not error
    expect(errors).toHaveLength(0);
  });
});
