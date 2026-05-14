//! FILENAME: app/extensions/Pivot/lib/namedConfigs.test.ts
// PURPOSE: Tests for named config utilities (pure functions only, no localStorage).

import { describe, it, expect } from 'vitest';
import {
  buildSourceSignature,
  extractReferencedFields,
  validateLayoutCompatibility,
  PIVOT_TEMPLATES,
  type SourceSignature,
} from './namedConfigs';
import type { SourceField } from '../../_shared/components/types';
import type { BiPivotModelInfo } from '../components/types';

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

// ============================================================================
// buildSourceSignature
// ============================================================================

describe('buildSourceSignature', () => {
  it('returns table signature for table-linked pivot', () => {
    const sig = buildSourceSignature([sf(0, 'A')], undefined, 'MyTable');
    expect(sig).toEqual({ type: 'table', tableName: 'MyTable' });
  });

  it('returns BI signature for BI model pivot', () => {
    const biModel: BiPivotModelInfo = {
      tables: [
        { name: 'Sales', columns: [{ name: 'Region', dataType: 'string', isNumeric: false }] },
      ],
      measures: [{ name: 'Total', table: 'Sales', sourceColumn: 'Region', aggregation: 'count' }],
    };
    const sig = buildSourceSignature([], biModel);
    expect(sig?.type).toBe('bi');
    expect(sig?.tables).toHaveLength(1);
    expect(sig?.tables![0].name).toBe('Sales');
    expect(sig?.measures).toEqual(['Total']);
  });

  it('returns undefined for raw range pivot (no table, no BI)', () => {
    const sig = buildSourceSignature([sf(0, 'A')]);
    expect(sig).toBeUndefined();
  });

  it('BI takes precedence over tableName', () => {
    const biModel: BiPivotModelInfo = {
      tables: [{ name: 'T', columns: [] }],
      measures: [],
    };
    const sig = buildSourceSignature([], biModel, 'SomeTable');
    expect(sig?.type).toBe('bi');
  });
});

// ============================================================================
// extractReferencedFields
// ============================================================================

describe('extractReferencedFields', () => {
  it('extracts row and column fields', () => {
    const fields = extractReferencedFields('ROWS: Alpha, Beta\nCOLUMNS: Gamma');
    expect(fields).toContain('Alpha');
    expect(fields).toContain('Beta');
    expect(fields).toContain('Gamma');
  });

  it('extracts value fields', () => {
    const fields = extractReferencedFields('VALUES: Sum(Revenue)');
    expect(fields).toContain('Revenue');
  });

  it('extracts bracket measures with brackets', () => {
    const fields = extractReferencedFields('VALUES: [TotalSales]');
    expect(fields).toContain('[TotalSales]');
  });

  it('extracts filter fields', () => {
    const fields = extractReferencedFields('FILTERS: Category NOT IN ("Other")');
    expect(fields).toContain('Category');
  });

  it('returns empty array for empty input', () => {
    const fields = extractReferencedFields('');
    expect(fields).toHaveLength(0);
  });

  it('deduplicates field names', () => {
    const fields = extractReferencedFields('ROWS: A\nCOLUMNS: A');
    // A appears twice in input but should be deduplicated
    const count = fields.filter(f => f === 'A').length;
    expect(count).toBe(1);
  });

  it('skips inline CALC placeholders', () => {
    // Inline CALC entries in VALUES should not add the CALC name as a "field"
    const fields = extractReferencedFields('VALUES: Sum(Sales), CALC Margin = [Sales] / [Cost]');
    expect(fields).toContain('Sales');
    // "Margin" is a calc name, not a source field reference
  });
});

// ============================================================================
// validateLayoutCompatibility
// ============================================================================

describe('validateLayoutCompatibility', () => {
  const fields = [sf(0, 'Region'), sf(1, 'Product'), sf(2, 'Sales', true)];

  it('returns compatible for valid DSL', () => {
    const result = validateLayoutCompatibility('ROWS: Region\nVALUES: Sum(Sales)', fields);
    expect(result.compatible).toBe(true);
    expect(result.missingFields).toHaveLength(0);
  });

  it('returns incompatible with missing fields', () => {
    const result = validateLayoutCompatibility('ROWS: Region, MissingField', fields);
    expect(result.compatible).toBe(false);
    expect(result.missingFields).toContain('MissingField');
  });

  it('performs case-insensitive matching', () => {
    const result = validateLayoutCompatibility('ROWS: region, PRODUCT', fields);
    expect(result.compatible).toBe(true);
  });

  it('validates BI model fields', () => {
    const biModel: BiPivotModelInfo = {
      tables: [
        { name: 'Sales', columns: [{ name: 'Region', dataType: 'string', isNumeric: false }] },
      ],
      measures: [{ name: 'Total', table: 'Sales', sourceColumn: 'Region', aggregation: 'count' }],
    };
    const result = validateLayoutCompatibility(
      'ROWS: Sales.Region\nVALUES: [Total]',
      [],
      biModel,
    );
    expect(result.compatible).toBe(true);
  });

  it('detects missing BI fields', () => {
    const biModel: BiPivotModelInfo = {
      tables: [{ name: 'T', columns: [] }],
      measures: [],
    };
    const result = validateLayoutCompatibility('VALUES: [NonExistent]', [], biModel);
    expect(result.compatible).toBe(false);
    expect(result.missingFields).toContain('[NonExistent]');
  });

  it('handles empty DSL as compatible', () => {
    const result = validateLayoutCompatibility('', fields);
    expect(result.compatible).toBe(true);
  });
});

// ============================================================================
// PIVOT_TEMPLATES
// ============================================================================

describe('PIVOT_TEMPLATES', () => {
  it('has at least 3 templates', () => {
    expect(PIVOT_TEMPLATES.length).toBeGreaterThanOrEqual(3);
  });

  it('all templates have name, description, and dslText', () => {
    for (const t of PIVOT_TEMPLATES) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.dslText).toBeTruthy();
    }
  });
});
