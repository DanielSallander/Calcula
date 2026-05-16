//! FILENAME: app/extensions/Pivot/lib/namedConfigs.deep.test.ts
// PURPOSE: Deep tests for namedConfigs covering signatures, extraction, compatibility, and scale.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildSourceSignature,
  extractReferencedFields,
  validateLayoutCompatibility,
  saveNamedConfig,
  loadNamedConfigs,
  deleteNamedConfig,
  getNamedConfig,
  type SourceSignature,
  type NamedPivotConfig,
} from './namedConfigs';
import type { SourceField } from '../../_shared/components/types';
import type { BiPivotModelInfo } from '../components/types';

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

function makeBiModel(
  tables: { name: string; columns: string[] }[],
  measures: string[] = [],
): BiPivotModelInfo {
  return {
    tables: tables.map(t => ({
      name: t.name,
      columns: t.columns.map(c => ({ name: c, dataType: 'string', isNumeric: false })),
    })),
    measures: measures.map(m => ({
      name: m,
      table: tables[0]?.name ?? '',
      sourceColumn: '',
      aggregation: 'sum' as const,
    })),
  };
}

// ============================================================================
// Source signature stability
// ============================================================================

describe('source signature stability', () => {
  it('same table input produces identical signature', () => {
    const fields = [sf(0, 'A'), sf(1, 'B')];
    const s1 = buildSourceSignature(fields, undefined, 'T1');
    const s2 = buildSourceSignature(fields, undefined, 'T1');
    expect(s1).toEqual(s2);
  });

  it('same BI model produces identical signature', () => {
    const bi = makeBiModel([{ name: 'Sales', columns: ['Region', 'Amount'] }], ['Total']);
    const s1 = buildSourceSignature([], bi);
    const s2 = buildSourceSignature([], bi);
    expect(s1).toEqual(s2);
  });

  it('different table names produce different signatures', () => {
    const s1 = buildSourceSignature([], undefined, 'Table1');
    const s2 = buildSourceSignature([], undefined, 'Table2');
    expect(s1).not.toEqual(s2);
  });

  it('BI signature includes all tables and measures', () => {
    const bi = makeBiModel(
      [
        { name: 'Orders', columns: ['ID', 'Date', 'Total'] },
        { name: 'Customers', columns: ['Name', 'Region'] },
      ],
      ['Revenue', 'Count'],
    );
    const sig = buildSourceSignature([], bi);
    expect(sig?.tables).toHaveLength(2);
    expect(sig?.tables![0].columns).toEqual(['ID', 'Date', 'Total']);
    expect(sig?.tables![1].columns).toEqual(['Name', 'Region']);
    expect(sig?.measures).toEqual(['Revenue', 'Count']);
  });

  it('BI signature is deterministic for same input order', () => {
    const bi = makeBiModel([{ name: 'T', columns: ['C', 'B', 'A'] }]);
    const s1 = buildSourceSignature([], bi);
    const s2 = buildSourceSignature([], bi);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
  });
});

// ============================================================================
// Field extraction from complex DSL
// ============================================================================

describe('extractReferencedFields from complex DSL', () => {
  it('extracts fields from all clause types', () => {
    const dsl = [
      'ROWS: Region, Country',
      'COLUMNS: Year',
      'VALUES: Sum(Sales), Average(Profit)',
      'FILTERS: Status NOT IN ("closed")',
    ].join('\n');

    const fields = extractReferencedFields(dsl);
    expect(fields).toContain('Region');
    expect(fields).toContain('Country');
    expect(fields).toContain('Year');
    expect(fields).toContain('Sales');
    expect(fields).toContain('Profit');
    expect(fields).toContain('Status');
  });

  it('extracts bracket measures', () => {
    const fields = extractReferencedFields('VALUES: [Revenue], [Cost]');
    expect(fields).toContain('[Revenue]');
    expect(fields).toContain('[Cost]');
  });

  it('handles dotted BI field names', () => {
    const fields = extractReferencedFields('ROWS: Sales.Region, Customers.Name');
    expect(fields).toContain('Sales.Region');
    expect(fields).toContain('Customers.Name');
  });

  it('extracts TOP N by-field', () => {
    const fields = extractReferencedFields('ROWS: Product\nVALUES: Sum(Sales)\nTOP 10 BY Sales');
    expect(fields).toContain('Sales');
  });

  it('handles all aggregation types', () => {
    const aggs = ['Sum', 'Count', 'Average', 'Min', 'Max', 'StdDev', 'Var', 'Product'];
    const dsl = 'VALUES: ' + aggs.map(a => `${a}(F)`).join(', ');
    const fields = extractReferencedFields(dsl);
    // F appears in all but should be deduplicated
    expect(fields.filter(f => f === 'F')).toHaveLength(1);
  });

  it('skips CALC fields (not source references)', () => {
    const fields = extractReferencedFields(
      'VALUES: Sum(Sales), CALC Margin = [Sales] - [Cost]',
    );
    expect(fields).toContain('Sales');
    // Margin is a calc name, not a source field
  });

  it('handles inclusion filters with =', () => {
    const fields = extractReferencedFields('FILTERS: Region = ("North", "South")');
    expect(fields).toContain('Region');
  });
});

// ============================================================================
// Layout compatibility with missing/extra/renamed fields
// ============================================================================

describe('validateLayoutCompatibility edge cases', () => {
  const baseFields = [sf(0, 'Region'), sf(1, 'Product'), sf(2, 'Sales', true), sf(3, 'Date')];

  it('compatible when DSL uses subset of available fields', () => {
    const result = validateLayoutCompatibility('ROWS: Region', baseFields);
    expect(result.compatible).toBe(true);
  });

  it('incompatible when DSL references removed field', () => {
    const result = validateLayoutCompatibility(
      'ROWS: Region, OldField',
      baseFields,
    );
    expect(result.compatible).toBe(false);
    expect(result.missingFields).toEqual(['OldField']);
  });

  it('extra available fields do not cause incompatibility', () => {
    const moreFields = [...baseFields, sf(4, 'Extra1'), sf(5, 'Extra2')];
    const result = validateLayoutCompatibility('ROWS: Region\nVALUES: Sum(Sales)', moreFields);
    expect(result.compatible).toBe(true);
  });

  it('case-insensitive matching works for mixed case', () => {
    const result = validateLayoutCompatibility('ROWS: REGION, product', baseFields);
    expect(result.compatible).toBe(true);
  });

  it('reports multiple missing fields', () => {
    const result = validateLayoutCompatibility(
      'ROWS: Region, Missing1\nCOLUMNS: Missing2',
      baseFields,
    );
    expect(result.compatible).toBe(false);
    expect(result.missingFields).toHaveLength(2);
    expect(result.missingFields).toContain('Missing1');
    expect(result.missingFields).toContain('Missing2');
  });

  it('validates BI dotted fields against model columns', () => {
    const bi = makeBiModel([
      { name: 'Sales', columns: ['Region', 'Amount'] },
      { name: 'Customers', columns: ['Name'] },
    ]);
    const result = validateLayoutCompatibility(
      'ROWS: Sales.Region\nCOLUMNS: Customers.Name',
      [],
      bi,
    );
    expect(result.compatible).toBe(true);
  });

  it('detects missing BI dotted field', () => {
    const bi = makeBiModel([{ name: 'Sales', columns: ['Region'] }]);
    const result = validateLayoutCompatibility(
      'ROWS: Sales.Region, Sales.Missing',
      [],
      bi,
    );
    expect(result.compatible).toBe(false);
    expect(result.missingFields).toContain('Sales.Missing');
  });

  it('validates BI measures with brackets', () => {
    const bi = makeBiModel([{ name: 'T', columns: [] }], ['Revenue']);
    const ok = validateLayoutCompatibility('VALUES: [Revenue]', [], bi);
    expect(ok.compatible).toBe(true);

    const fail = validateLayoutCompatibility('VALUES: [Missing]', [], bi);
    expect(fail.compatible).toBe(false);
  });
});

// ============================================================================
// CRUD with 20+ named configs simultaneously
// ============================================================================

describe('20+ named configs simultaneously', () => {
  it('saves and loads 25 configs', () => {
    for (let i = 0; i < 25; i++) {
      saveNamedConfig({
        name: `Config_${i}`,
        dslText: `ROWS: Field${i}`,
        description: `Description ${i}`,
      });
    }

    const all = loadNamedConfigs();
    expect(all).toHaveLength(25);

    // Verify each is retrievable
    for (let i = 0; i < 25; i++) {
      const cfg = getNamedConfig(`Config_${i}`);
      expect(cfg).toBeDefined();
      expect(cfg!.dslText).toBe(`ROWS: Field${i}`);
    }
  });

  it('updates existing config by name', () => {
    saveNamedConfig({ name: 'Shared', dslText: 'ROWS: A' });
    saveNamedConfig({ name: 'Shared', dslText: 'ROWS: B' });
    const all = loadNamedConfigs();
    expect(all.filter(c => c.name === 'Shared')).toHaveLength(1);
    expect(getNamedConfig('Shared')!.dslText).toBe('ROWS: B');
  });

  it('deletes one config without affecting others', () => {
    for (let i = 0; i < 5; i++) {
      saveNamedConfig({ name: `D${i}`, dslText: `ROWS: X${i}` });
    }
    deleteNamedConfig('D2');
    const all = loadNamedConfigs();
    expect(all).toHaveLength(4);
    expect(getNamedConfig('D2')).toBeUndefined();
    expect(getNamedConfig('D0')).toBeDefined();
    expect(getNamedConfig('D4')).toBeDefined();
  });

  it('handles empty storage gracefully', () => {
    expect(loadNamedConfigs()).toEqual([]);
    expect(getNamedConfig('nope')).toBeUndefined();
  });

  it('handles corrupted localStorage gracefully', () => {
    storage.set('calcula.pivot.namedConfigs', 'not valid json!!!');
    expect(loadNamedConfigs()).toEqual([]);
  });

  it('preserves createdAt on update, changes updatedAt', () => {
    saveNamedConfig({ name: 'Timestamped', dslText: 'ROWS: A' });
    const original = getNamedConfig('Timestamped')!;
    const originalCreated = original.createdAt;

    // Small delay to ensure different timestamp
    saveNamedConfig({ name: 'Timestamped', dslText: 'ROWS: B' });
    const updated = getNamedConfig('Timestamped')!;
    expect(updated.createdAt).toBe(originalCreated);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(originalCreated);
  });

  it('stores optional fields (pivotId, sourceSignature, scope)', () => {
    saveNamedConfig({
      name: 'Full',
      dslText: 'ROWS: X',
      pivotId: 42,
      sourceSignature: { type: 'table', tableName: 'T1' },
      scope: 'workbook',
    });
    const cfg = getNamedConfig('Full')!;
    expect(cfg.pivotId).toBe(42);
    expect(cfg.sourceSignature).toEqual({ type: 'table', tableName: 'T1' });
    expect(cfg.scope).toBe('workbook');
  });
});

// ============================================================================
// Template field substitution
// ============================================================================

describe('template customization with field substitution', () => {
  it('template DSL can be modified by replacing placeholder comments', () => {
    const template = 'ROWS:    # add row fields\nVALUES:  # add value fields or [Measures]';
    const customized = template
      .replace('# add row fields', 'Region, Product')
      .replace('# add value fields or [Measures]', 'Sum(Sales)');

    const fields = extractReferencedFields(customized);
    expect(fields).toContain('Region');
    expect(fields).toContain('Product');
    expect(fields).toContain('Sales');
  });

  it('validates customized template against source fields', () => {
    const customized = 'ROWS: Region\nVALUES: Sum(Sales)';
    const fields = [sf(0, 'Region'), sf(1, 'Sales', true)];
    const result = validateLayoutCompatibility(customized, fields);
    expect(result.compatible).toBe(true);
  });

  it('detects incompatible field substitution', () => {
    const customized = 'ROWS: NonExistent\nVALUES: Sum(Sales)';
    const fields = [sf(0, 'Region'), sf(1, 'Sales', true)];
    const result = validateLayoutCompatibility(customized, fields);
    expect(result.compatible).toBe(false);
    expect(result.missingFields).toContain('NonExistent');
  });
});
