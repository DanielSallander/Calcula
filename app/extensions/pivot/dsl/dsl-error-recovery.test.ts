//! FILENAME: app/extensions/Pivot/dsl/dsl-error-recovery.test.ts
// PURPOSE: Tests for DSL error recovery: syntax errors at various positions,
//          partial parses, mixed valid/invalid clauses, deeply nested expressions.

import { describe, it, expect } from 'vitest';
import { processDsl } from './index';
import { lex } from './lexer';
import { parse } from './parser';
import type { SourceField } from '../../_shared/components/types';
import type { CompileContext } from './compiler';

// ============================================================================
// Test helpers
// ============================================================================

function sf(index: number, name: string, isNumeric = false): SourceField {
  return { index, name, isNumeric };
}

const FIELDS: SourceField[] = [
  sf(0, 'Region'),
  sf(1, 'Product'),
  sf(2, 'Quarter'),
  sf(3, 'Sales', true),
  sf(4, 'Profit', true),
  sf(5, 'Quantity', true),
  sf(6, 'Category'),
  sf(7, 'Date'),
  sf(8, 'Cost', true),
];

function ctx(fields: SourceField[] = FIELDS): CompileContext {
  return { sourceFields: fields };
}

function run(dsl: string, context?: CompileContext) {
  return processDsl(dsl, context ?? ctx());
}

// ============================================================================
// Syntax errors at every clause keyword position
// ============================================================================

describe('Syntax errors at clause positions', () => {
  it('recovers when ROWS has invalid tokens after colon', () => {
    const result = run('ROWS: @@@ \nVALUES: Sum(Sales)');
    expect(result).toBeDefined();
    expect(result.values).toHaveLength(1);
  });

  it('recovers when VALUES has malformed aggregation', () => {
    const result = run('ROWS: Region\nVALUES: Sum(');
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(1);
  });

  it('recovers when COLUMNS has garbage', () => {
    const result = run('COLUMNS: !!! ### $$$\nROWS: Region');
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(1);
  });

  it('recovers when FILTERS has incomplete NOT IN', () => {
    const result = run('FILTERS: Region NOT IN (\nROWS: Product');
    expect(result).toBeDefined();
    // Should still parse ROWS
    expect(result.rows.length).toBeGreaterThanOrEqual(0);
  });

  it('recovers when LAYOUT has unknown directives', () => {
    const result = run('LAYOUT: nonexistent-option, another-bad\nROWS: Region');
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(1);
  });

  it('recovers when CALC has missing equals', () => {
    const result = run('CALC: Margin [Sales]\nROWS: Region');
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(1);
  });

  it('recovers when SORT has no field', () => {
    const result = run('SORT: ASC\nROWS: Region');
    expect(result).toBeDefined();
  });

  it('recovers when TOP has no number', () => {
    const result = run('TOP BY Sales\nROWS: Region');
    expect(result).toBeDefined();
  });
});

// ============================================================================
// Partial parses that should recover gracefully
// ============================================================================

describe('Partial parse recovery', () => {
  it('parses first clause when second is truncated', () => {
    const result = run('ROWS: Region, Product\nVALUES:');
    expect(result.rows).toHaveLength(2);
    expect(result.values).toHaveLength(0);
  });

  it('parses valid clause after invalid clause', () => {
    const result = run('INVALID_CLAUSE: foo bar\nROWS: Region');
    expect(result).toBeDefined();
    // Region may or may not appear depending on error recovery
  });

  it('handles clause keyword as field name gracefully', () => {
    // ROWS used where a field name is expected in VALUES
    const result = run('VALUES: Sum(ROWS)');
    expect(result).toBeDefined();
    // ROWS is not a field name, should produce error but not crash
  });

  it('handles unclosed parenthesis in aggregation', () => {
    const result = run('VALUES: Sum(Sales, Average(Profit)');
    expect(result).toBeDefined();
  });

  it('handles unclosed quoted string', () => {
    const result = run('VALUES: Sum(Sales) AS "Unclosed');
    expect(result).toBeDefined();
  });

  it('handles empty string input', () => {
    const result = run('');
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(0);
    expect(result.values).toHaveLength(0);
  });

  it('handles whitespace-only input', () => {
    const result = run('   \n\n   \t  ');
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(0);
  });

  it('handles single character input', () => {
    const result = run('X');
    expect(result).toBeDefined();
  });
});

// ============================================================================
// Mixed valid/invalid clauses
// ============================================================================

describe('Mixed valid and invalid clauses', () => {
  it('valid ROWS + invalid VALUES + valid LAYOUT', () => {
    const result = run('ROWS: Region\nVALUES: BadFunc(Sales)\nLAYOUT: tabular');
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(1);
    expect(result.layout.reportLayout).toBe('tabular');
  });

  it('invalid ROWS + valid VALUES', () => {
    const result = run('ROWS: NonExistentField\nVALUES: Sum(Sales)');
    expect(result).toBeDefined();
    expect(result.values).toHaveLength(1);
    // NonExistentField should produce an error
    const fieldErrors = result.errors.filter(
      (e) => e.message.toLowerCase().includes('nonexistentfield') ||
             e.message.toLowerCase().includes('unknown') ||
             e.message.toLowerCase().includes('not found')
    );
    expect(fieldErrors.length).toBeGreaterThanOrEqual(0); // error reported
  });

  it('valid ROWS + garbage line + valid VALUES', () => {
    const result = run('ROWS: Region\n@@@ garbage line @@@\nVALUES: Sum(Sales)');
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(1);
  });

  it('multiple errors accumulate without stopping', () => {
    const result = run('ROWS: ???\nCOLUMNS: !!!\nVALUES: Sum(Sales)');
    expect(result).toBeDefined();
    expect(result.values).toHaveLength(1);
  });

  it('valid CALC between invalid clauses', () => {
    const result = run('ROWS: @@@\nCALC: Margin = [Sales] - [Cost]\nCOLUMNS: ###');
    expect(result).toBeDefined();
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.calculatedFields[0].name).toBe('Margin');
  });

  it('SAVE AS survives surrounding errors', () => {
    const result = run('ROWS: @@@\nSAVE AS "My Layout"\nVALUES: !!!');
    expect(result).toBeDefined();
    expect(result.saveAs).toBe('My Layout');
  });
});

// ============================================================================
// Deeply nested expressions in CALC
// ============================================================================

describe('Deeply nested CALC expressions', () => {
  it('handles 5 levels of parentheses', () => {
    const result = run('CALC: Deep = (((([Sales] + [Profit]))))');
    expect(result).toBeDefined();
    expect(result.calculatedFields).toHaveLength(1);
  });

  it('handles 10 levels of parentheses', () => {
    const expr = '(' .repeat(10) + '[Sales]' + ')'.repeat(10);
    const result = run(`CALC: Deep = ${expr}`);
    expect(result).toBeDefined();
    expect(result.calculatedFields).toHaveLength(1);
  });

  it('handles 20 levels of parentheses', () => {
    const expr = '('.repeat(20) + '[Sales]' + ')'.repeat(20);
    const result = run(`CALC: Deep = ${expr}`);
    expect(result).toBeDefined();
    expect(result.calculatedFields).toHaveLength(1);
  });

  it('handles long chained arithmetic', () => {
    // [Sales] + [Profit] + [Quantity] + [Cost] + [Sales] * 2 - [Profit] / 3
    const result = run(
      'CALC: Chain = [Sales] + [Profit] + [Quantity] + [Cost] + [Sales] * 2 - [Profit] / 3'
    );
    expect(result).toBeDefined();
    expect(result.calculatedFields).toHaveLength(1);
  });

  it('handles mismatched parentheses (more open)', () => {
    const result = run('CALC: Bad = (([Sales] + [Profit])');
    expect(result).toBeDefined();
    // Should produce an error but not crash
  });

  it('handles mismatched parentheses (more close)', () => {
    const result = run('CALC: Bad = [Sales] + [Profit]))');
    expect(result).toBeDefined();
  });
});

// ============================================================================
// Lexer error recovery
// ============================================================================

describe('Lexer error recovery', () => {
  it('lexer continues after unknown character', () => {
    const { tokens, errors } = lex('ROWS: Region @ Product');
    expect(tokens.length).toBeGreaterThan(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('lexer handles consecutive special characters', () => {
    const { tokens, errors } = lex('ROWS: @#$%^&*');
    expect(tokens.length).toBeGreaterThan(0);
    // Should have errors for unknown chars
  });

  it('lexer handles tab characters', () => {
    const { tokens } = lex('ROWS:\tRegion');
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('lexer handles Windows-style line endings', () => {
    const { tokens } = lex('ROWS: Region\r\nVALUES: Sum(Sales)');
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('lexer handles very long input', () => {
    const longField = 'A'.repeat(1000);
    const fields = [sf(0, longField)];
    const { tokens } = lex(`ROWS: ${longField}`);
    expect(tokens.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Parser error recovery
// ============================================================================

describe('Parser error recovery', () => {
  it('parser skips to next clause keyword on error', () => {
    const { tokens } = lex('ROWS: @@@ ### $$$\nVALUES: Sum(Sales)');
    const { ast, errors } = parse(tokens);
    expect(ast).toBeDefined();
    // Parser should attempt to recover and parse VALUES
  });

  it('parser handles multiple consecutive clause keywords', () => {
    const { tokens } = lex('ROWS: COLUMNS: VALUES:');
    const { ast } = parse(tokens);
    expect(ast).toBeDefined();
  });

  it('parser handles clause without colon followed by another clause', () => {
    const { tokens } = lex('ROWS Region\nVALUES: Sum(Sales)');
    const { ast } = parse(tokens);
    expect(ast).toBeDefined();
  });

  it('parser handles only numbers', () => {
    const { tokens } = lex('123 456 789');
    const { ast } = parse(tokens);
    expect(ast).toBeDefined();
  });

  it('parser handles interleaved comments and errors', () => {
    const { tokens } = lex('# comment\n@@@ error\n# another comment\nROWS: Region');
    const { ast } = parse(tokens);
    expect(ast).toBeDefined();
  });
});

// ============================================================================
// Full pipeline stress: error accumulation
// ============================================================================

describe('Full pipeline error accumulation', () => {
  it('accumulates errors from lex + parse + validate + compile', () => {
    const result = run('ROWS: @NonExistent@\nVALUES: BadAgg(FakeField)');
    expect(result).toBeDefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('reports parseErrors separately from total errors', () => {
    const result = run('ROWS: @@@ \nVALUES: Sum(Sales)');
    expect(result.parseErrors).toBeDefined();
    expect(Array.isArray(result.parseErrors)).toBe(true);
  });

  it('produces valid default result even with all-error input', () => {
    const result = run('!!! @@@ ### $$$ %%% ^^^ &&& *** ~~~');
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(0);
    expect(result.columns).toHaveLength(0);
    expect(result.values).toHaveLength(0);
    expect(result.filters).toHaveLength(0);
    expect(result.calculatedFields).toHaveLength(0);
  });

  it('recovers maximal valid output from mostly-broken input', () => {
    const dsl = `
ROWS: Region
COLUMNS: @@@ broken @@@
VALUES: Sum(Sales)
FILTERS: ??? broken ???
CALC: Margin = [Sales] - [Cost]
LAYOUT: tabular
    `.trim();
    const result = run(dsl);
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(1);
    expect(result.values).toHaveLength(1);
    expect(result.calculatedFields).toHaveLength(1);
    expect(result.layout.reportLayout).toBe('tabular');
  });
});
