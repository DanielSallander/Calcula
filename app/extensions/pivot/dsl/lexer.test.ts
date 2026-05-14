//! FILENAME: app/extensions/Pivot/dsl/lexer.test.ts
// PURPOSE: Edge-case tests for the Pivot DSL lexer.

import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { TokenType } from './tokens';

/** Helper: get token types (excluding EOF). */
function types(input: string): TokenType[] {
  const { tokens } = lex(input);
  return tokens.filter(t => t.type !== TokenType.EOF).map(t => t.type);
}

/** Helper: get token values (excluding EOF, Newline, Comment). */
function values(input: string): string[] {
  const { tokens } = lex(input);
  return tokens
    .filter(t => t.type !== TokenType.EOF && t.type !== TokenType.Newline && t.type !== TokenType.Comment)
    .map(t => t.value);
}

describe('Lexer edge cases', () => {
  // --- Empty / whitespace-only input ---

  it('produces only EOF for empty input', () => {
    const { tokens, errors } = lex('');
    expect(errors).toHaveLength(0);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe(TokenType.EOF);
  });

  it('produces only EOF for whitespace-only input', () => {
    const { tokens, errors } = lex('   \t  \r  ');
    expect(errors).toHaveLength(0);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe(TokenType.EOF);
  });

  it('handles newline-only input', () => {
    const { tokens, errors } = lex('\n\n\n');
    expect(errors).toHaveLength(0);
    const nonEof = tokens.filter(t => t.type !== TokenType.EOF);
    expect(nonEof.every(t => t.type === TokenType.Newline)).toBe(true);
    expect(nonEof).toHaveLength(3);
  });

  // --- String literal edge cases ---

  it('handles empty string literal', () => {
    const { tokens, errors } = lex('""');
    expect(errors).toHaveLength(0);
    const str = tokens.find(t => t.type === TokenType.StringLiteral);
    expect(str).toBeDefined();
    expect(str!.value).toBe('');
  });

  it('handles string with special characters', () => {
    const { tokens, errors } = lex('"hello!@#$%^&*()"');
    expect(errors).toHaveLength(0);
    const str = tokens.find(t => t.type === TokenType.StringLiteral);
    expect(str!.value).toBe('hello!@#$%^&*()');
  });

  it('string terminated by newline reports error', () => {
    const { tokens, errors } = lex('"unterminated\nsecond line');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Unterminated string');
    // The string should still be captured up to the newline
    const str = tokens.find(t => t.type === TokenType.StringLiteral);
    expect(str!.value).toBe('unterminated');
  });

  it('handles multiple strings on same line', () => {
    const { tokens, errors } = lex('"one" "two" "three"');
    expect(errors).toHaveLength(0);
    const strs = tokens.filter(t => t.type === TokenType.StringLiteral);
    expect(strs).toHaveLength(3);
    expect(strs.map(s => s.value)).toEqual(['one', 'two', 'three']);
  });

  // --- Bracket identifier edge cases ---

  it('handles empty bracket identifier', () => {
    const { tokens, errors } = lex('[]');
    expect(errors).toHaveLength(0);
    const b = tokens.find(t => t.type === TokenType.BracketIdentifier);
    expect(b!.value).toBe('');
  });

  it('handles bracket with spaces and special chars', () => {
    const { tokens, errors } = lex('[% of Grand Total]');
    expect(errors).toHaveLength(0);
    const b = tokens.find(t => t.type === TokenType.BracketIdentifier);
    expect(b!.value).toBe('% of Grand Total');
  });

  it('reports error for unterminated bracket', () => {
    const { errors } = lex('[missing close');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Unterminated bracket');
  });

  it('handles bracket terminated by newline as error', () => {
    const { errors } = lex('[oops\nnext');
    expect(errors.length).toBeGreaterThan(0);
  });

  // --- Number literals ---

  it('tokenizes integers', () => {
    const { tokens, errors } = lex('42');
    expect(errors).toHaveLength(0);
    const num = tokens.find(t => t.type === TokenType.NumberLiteral);
    expect(num!.value).toBe('42');
  });

  it('tokenizes decimals', () => {
    const { tokens, errors } = lex('3.14');
    expect(errors).toHaveLength(0);
    const num = tokens.find(t => t.type === TokenType.NumberLiteral);
    expect(num!.value).toBe('3.14');
  });

  it('number followed by dot and non-digit stays as integer', () => {
    // "10.Region" should be 10 + . + Identifier
    const { tokens, errors } = lex('10.Region');
    expect(errors).toHaveLength(0);
    const num = tokens.find(t => t.type === TokenType.NumberLiteral);
    expect(num!.value).toBe('10');
    expect(tokens.some(t => t.type === TokenType.Dot)).toBe(true);
  });

  // --- Dotted identifiers ---

  it('tokenizes dotted identifiers', () => {
    const { tokens, errors } = lex('Sales.Revenue');
    expect(errors).toHaveLength(0);
    const dot = tokens.find(t => t.type === TokenType.DottedIdentifier);
    expect(dot!.value).toBe('Sales.Revenue');
  });

  it('identifier followed by dot at end of input remains as identifier + dot', () => {
    const { tokens, errors } = lex('Sales.');
    expect(errors).toHaveLength(0);
    // Should be Identifier + Dot since there's nothing after the dot
    const ident = tokens.find(t => t.type === TokenType.Identifier || t.type === TokenType.DottedIdentifier);
    expect(ident).toBeDefined();
  });

  // --- Hyphenated identifiers (layout directives) ---

  it('tokenizes hyphenated identifiers', () => {
    const { tokens, errors } = lex('repeat-labels');
    expect(errors).toHaveLength(0);
    const ident = tokens.find(t => t.type === TokenType.Identifier);
    expect(ident!.value).toBe('repeat-labels');
  });

  it('tokenizes multi-hyphenated identifiers', () => {
    const { tokens, errors } = lex('no-grand-totals');
    expect(errors).toHaveLength(0);
    const ident = tokens.find(t => t.type === TokenType.Identifier);
    expect(ident!.value).toBe('no-grand-totals');
  });

  // --- Keywords are case-insensitive ---

  it('recognizes keywords regardless of case', () => {
    const cases = ['ROWS', 'rows', 'Rows', 'rOwS'];
    for (const kw of cases) {
      const { tokens } = lex(kw + ':');
      expect(tokens[0].type).toBe(TokenType.Rows);
    }
  });

  // --- Comments ---

  it('tokenizes comments', () => {
    const { tokens, errors } = lex('# this is a comment');
    expect(errors).toHaveLength(0);
    const comment = tokens.find(t => t.type === TokenType.Comment);
    expect(comment).toBeDefined();
    expect(comment!.value).toContain('this is a comment');
  });

  it('comment ends at newline', () => {
    const { tokens } = lex('# comment\nROWS: Region');
    const comment = tokens.find(t => t.type === TokenType.Comment);
    expect(comment!.value).not.toContain('ROWS');
    expect(tokens.some(t => t.type === TokenType.Rows)).toBe(true);
  });

  // --- Operator symbols ---

  it('tokenizes all arithmetic operators', () => {
    const { tokens, errors } = lex('+ - * / ^');
    expect(errors).toHaveLength(0);
    const ops = tokens.filter(t =>
      [TokenType.Plus, TokenType.Minus, TokenType.Star, TokenType.Slash, TokenType.Caret].includes(t.type)
    );
    expect(ops).toHaveLength(5);
  });

  // --- Unknown characters ---

  it('reports error for unknown characters but continues lexing', () => {
    const { tokens, errors } = lex('ROWS: Region & Product');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Unexpected character');
    // Should still produce tokens for ROWS, Region, Product
    expect(tokens.some(t => t.type === TokenType.Rows)).toBe(true);
  });

  it('handles multiple unknown characters', () => {
    const { errors } = lex('~!@');
    // ~ and @ are unknown (! is also unknown)
    expect(errors.length).toBe(3);
  });

  // --- Location tracking ---

  it('tracks line numbers across newlines', () => {
    const { tokens } = lex('ROWS: A\nVALUES: B');
    const valuesToken = tokens.find(t => t.type === TokenType.Values);
    expect(valuesToken!.location.line).toBe(2);
  });

  it('tracks column positions', () => {
    const { tokens } = lex('ROWS: Region');
    const rowsToken = tokens[0];
    expect(rowsToken.location.column).toBe(0);
    // "Region" starts after "ROWS: " (6 chars)
    const regionToken = tokens.find(t => t.type === TokenType.Identifier);
    expect(regionToken!.location.column).toBe(6);
  });

  // --- Very long input ---

  it('handles a very long identifier', () => {
    const longName = 'A'.repeat(500);
    const { tokens, errors } = lex(`ROWS: ${longName}`);
    expect(errors).toHaveLength(0);
    const ident = tokens.find(t => t.type === TokenType.Identifier);
    expect(ident!.value).toBe(longName);
  });

  it('handles a very long string literal', () => {
    const longStr = 'x'.repeat(1000);
    const { tokens, errors } = lex(`"${longStr}"`);
    expect(errors).toHaveLength(0);
    const str = tokens.find(t => t.type === TokenType.StringLiteral);
    expect(str!.value).toBe(longStr);
  });

  // --- Expression-like input in CALC ---

  it('tokenizes a complex arithmetic expression', () => {
    const { tokens, errors } = lex('[Sales] / [Quantity] * 100 + 0.5');
    expect(errors).toHaveLength(0);
    const brackets = tokens.filter(t => t.type === TokenType.BracketIdentifier);
    expect(brackets).toHaveLength(2);
    expect(brackets[0].value).toBe('Sales');
    expect(brackets[1].value).toBe('Quantity');
  });

  // --- Underscore in identifiers ---

  it('handles underscores in identifiers', () => {
    const { tokens, errors } = lex('my_field_name');
    expect(errors).toHaveLength(0);
    const ident = tokens.find(t => t.type === TokenType.Identifier);
    expect(ident!.value).toBe('my_field_name');
  });

  it('handles identifier starting with underscore', () => {
    const { tokens, errors } = lex('_private');
    expect(errors).toHaveLength(0);
    const ident = tokens.find(t => t.type === TokenType.Identifier);
    expect(ident!.value).toBe('_private');
  });
});
