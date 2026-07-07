import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { TokenType } from './tokens';

// Helper: lex and return just the token types (excluding EOF)
function types(input: string): TokenType[] {
  return lex(input).tokens.filter(t => t.type !== TokenType.EOF).map(t => t.type);
}

// Helper: lex and return token values (excluding EOF)
function values(input: string): string[] {
  return lex(input).tokens.filter(t => t.type !== TokenType.EOF).map(t => t.value);
}

describe('Lexer coverage', () => {
  // ---------------------------------------------------------------
  // Keywords (all variants, case insensitive)
  // ---------------------------------------------------------------
  describe('keywords', () => {
    const cases: [string, TokenType][] = [
      ['ROWS', TokenType.Rows],
      ['rows', TokenType.Rows],
      ['Rows', TokenType.Rows],
      ['COLUMNS', TokenType.Columns],
      ['VALUES', TokenType.Values],
      ['FILTERS', TokenType.Filters],
      ['SORT', TokenType.Sort],
      ['LAYOUT', TokenType.Layout],
      ['CALC', TokenType.Calc],
      ['TOP', TokenType.Top],
      ['BOTTOM', TokenType.Bottom],
      ['BY', TokenType.By],
      ['AS', TokenType.As],
      ['SAVE', TokenType.Save],
      ['LOOKUP', TokenType.Lookup],
      ['VIA', TokenType.Via],
      ['NOT', TokenType.Not],
      ['IN', TokenType.In],
      ['ASC', TokenType.Asc],
      ['DESC', TokenType.Desc],
    ];

    it.each(cases)('recognizes keyword %s', (input, expected) => {
      const result = lex(input);
      expect(result.tokens[0].type).toBe(expected);
      expect(result.errors).toHaveLength(0);
    });

    it('is case-insensitive for mixed case', () => {
      expect(lex('rOwS').tokens[0].type).toBe(TokenType.Rows);
      expect(lex('FiLtErS').tokens[0].type).toBe(TokenType.Filters);
    });
  });

  // ---------------------------------------------------------------
  // All operator / symbol tokens
  // ---------------------------------------------------------------
  describe('symbols', () => {
    it('produces all single-character symbol tokens', () => {
      const result = lex(': , ( ) = . + - * / ^');
      const toks = result.tokens.filter(t => t.type !== TokenType.EOF);
      expect(toks.map(t => t.type)).toEqual([
        TokenType.Colon,
        TokenType.Comma,
        TokenType.LeftParen,
        TokenType.RightParen,
        TokenType.Equals,
        TokenType.Dot,
        TokenType.Plus,
        TokenType.Minus,
        TokenType.Star,
        TokenType.Slash,
        TokenType.Caret,
      ]);
    });
  });

  // ---------------------------------------------------------------
  // String literals
  // ---------------------------------------------------------------
  describe('string literals', () => {
    it('lexes a simple string', () => {
      const r = lex('"hello world"');
      expect(r.tokens[0].type).toBe(TokenType.StringLiteral);
      expect(r.tokens[0].value).toBe('hello world');
    });

    it('lexes an empty string', () => {
      const r = lex('""');
      expect(r.tokens[0].type).toBe(TokenType.StringLiteral);
      expect(r.tokens[0].value).toBe('');
    });

    it('reports error for unterminated string at newline', () => {
      const r = lex('"unterminated\n');
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].message).toContain('Unterminated string');
      expect(r.tokens[0].type).toBe(TokenType.StringLiteral);
      expect(r.tokens[0].value).toBe('unterminated');
    });

    it('reports error for unterminated string at EOF', () => {
      const r = lex('"noclose');
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].message).toContain('Unterminated string');
    });
  });

  // ---------------------------------------------------------------
  // Number literals
  // ---------------------------------------------------------------
  describe('number literals', () => {
    it('lexes an integer', () => {
      const r = lex('42');
      expect(r.tokens[0].type).toBe(TokenType.NumberLiteral);
      expect(r.tokens[0].value).toBe('42');
    });

    it('lexes a decimal number', () => {
      const r = lex('3.14');
      expect(r.tokens[0].type).toBe(TokenType.NumberLiteral);
      expect(r.tokens[0].value).toBe('3.14');
    });

    it('does not consume trailing dot without digit', () => {
      // "10." followed by non-digit should produce "10" then "."
      const r = lex('10.abc');
      // 10 is a number, then . triggers dotted-ident backtrack attempt on abc
      // Actually: 10 is parsed as number. Then .abc -- dot is consumed as Dot, abc as Identifier
      expect(r.tokens[0].type).toBe(TokenType.NumberLiteral);
      expect(r.tokens[0].value).toBe('10');
    });

    it('lexes multi-digit decimal', () => {
      const r = lex('100.555');
      expect(r.tokens[0].value).toBe('100.555');
    });
  });

  // ---------------------------------------------------------------
  // Identifiers
  // ---------------------------------------------------------------
  describe('identifiers', () => {
    it('lexes a simple identifier', () => {
      const r = lex('Region');
      expect(r.tokens[0].type).toBe(TokenType.Identifier);
      expect(r.tokens[0].value).toBe('Region');
    });

    it('lexes identifier with underscores', () => {
      const r = lex('_my_field');
      expect(r.tokens[0].type).toBe(TokenType.Identifier);
      expect(r.tokens[0].value).toBe('_my_field');
    });

    it('lexes identifier with digits', () => {
      const r = lex('field2');
      expect(r.tokens[0].type).toBe(TokenType.Identifier);
      expect(r.tokens[0].value).toBe('field2');
    });

    it('lexes a hyphenated identifier', () => {
      const r = lex('repeat-labels');
      expect(r.tokens[0].type).toBe(TokenType.Identifier);
      expect(r.tokens[0].value).toBe('repeat-labels');
    });
  });

  // ---------------------------------------------------------------
  // Dotted identifiers
  // ---------------------------------------------------------------
  describe('dotted identifiers', () => {
    it('lexes Table.Column', () => {
      const r = lex('Customers.Region');
      expect(r.tokens[0].type).toBe(TokenType.DottedIdentifier);
      expect(r.tokens[0].value).toBe('Customers.Region');
    });

    it('backtracks dot when not followed by identifier start', () => {
      // "abc.123" -- dot not followed by ident start, so abc is Identifier, dot is separate
      const r = lex('abc.123');
      expect(r.tokens[0].type).toBe(TokenType.Identifier);
      expect(r.tokens[0].value).toBe('abc');
      expect(r.tokens[1].type).toBe(TokenType.Dot);
      expect(r.tokens[2].type).toBe(TokenType.NumberLiteral);
    });
  });

  // ---------------------------------------------------------------
  // Bracket identifiers
  // ---------------------------------------------------------------
  describe('bracket identifiers', () => {
    it('lexes [Total Revenue]', () => {
      const r = lex('[Total Revenue]');
      expect(r.tokens[0].type).toBe(TokenType.BracketIdentifier);
      expect(r.tokens[0].value).toBe('Total Revenue');
    });

    it('reports error for unterminated bracket at newline', () => {
      const r = lex('[broken\n');
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].message).toContain('Unterminated bracket');
    });

    it('reports error for unterminated bracket at EOF', () => {
      const r = lex('[noclose');
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].message).toContain('Unterminated bracket');
    });
  });

  // ---------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------
  describe('comments', () => {
    it('lexes a comment token', () => {
      const r = lex('# this is a comment');
      expect(r.tokens[0].type).toBe(TokenType.Comment);
      expect(r.tokens[0].value).toBe('# this is a comment');
    });

    it('comment stops at newline', () => {
      const r = lex('# comment\nROWS');
      const toks = r.tokens.filter(t => t.type !== TokenType.EOF);
      expect(toks[0].type).toBe(TokenType.Comment);
      expect(toks[1].type).toBe(TokenType.Newline);
      expect(toks[2].type).toBe(TokenType.Rows);
    });
  });

  // ---------------------------------------------------------------
  // Newlines and whitespace
  // ---------------------------------------------------------------
  describe('whitespace and newlines', () => {
    it('skips spaces and tabs', () => {
      const r = lex('  \t ROWS');
      const toks = r.tokens.filter(t => t.type !== TokenType.EOF);
      expect(toks).toHaveLength(1);
      expect(toks[0].type).toBe(TokenType.Rows);
    });

    it('produces Newline tokens', () => {
      const r = lex('A\nB');
      expect(types('A\nB')).toEqual([
        TokenType.Identifier,
        TokenType.Newline,
        TokenType.Identifier,
      ]);
    });

    it('skips carriage returns', () => {
      const r = lex('A\r\nB');
      // \r is skipped, \n produces Newline
      const toks = r.tokens.filter(t => t.type !== TokenType.EOF);
      expect(toks.map(t => t.type)).toContain(TokenType.Newline);
    });
  });

  // ---------------------------------------------------------------
  // Error tokens for unknown characters
  // ---------------------------------------------------------------
  describe('unknown characters', () => {
    it('reports error for unexpected characters', () => {
      const r = lex('@');
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].message).toContain("Unexpected character: '@'");
    });

    it('continues lexing after unknown character', () => {
      const r = lex('@ ROWS');
      expect(r.errors).toHaveLength(1);
      expect(r.tokens.some(t => t.type === TokenType.Rows)).toBe(true);
    });

    it('reports multiple unknown characters', () => {
      const r = lex('@ $ %');
      expect(r.errors).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------
  // Location tracking
  // ---------------------------------------------------------------
  describe('location tracking', () => {
    it('tracks column for first token', () => {
      const r = lex('ROWS');
      expect(r.tokens[0].location).toEqual({ line: 1, column: 0, endColumn: 4 });
    });

    it('tracks column with leading whitespace', () => {
      const r = lex('  ROWS');
      expect(r.tokens[0].location).toEqual({ line: 1, column: 2, endColumn: 6 });
    });

    it('tracks line numbers across newlines', () => {
      const r = lex('ROWS\nCOLUMNS');
      const colTok = r.tokens.find(t => t.type === TokenType.Columns)!;
      expect(colTok.location.line).toBe(2);
      expect(colTok.location.column).toBe(0);
    });

    it('tracks location for multi-line input precisely', () => {
      const r = lex('ROWS: A\n  VALUES: B');
      const valTok = r.tokens.find(t => t.type === TokenType.Values)!;
      expect(valTok.location.line).toBe(2);
      expect(valTok.location.column).toBe(2);
    });
  });

  // ---------------------------------------------------------------
  // EOF
  // ---------------------------------------------------------------
  describe('EOF', () => {
    it('always ends with EOF token', () => {
      const r = lex('');
      expect(r.tokens).toHaveLength(1);
      expect(r.tokens[0].type).toBe(TokenType.EOF);
    });

    it('EOF after content', () => {
      const r = lex('ROWS');
      const last = r.tokens[r.tokens.length - 1];
      expect(last.type).toBe(TokenType.EOF);
    });
  });

  // ---------------------------------------------------------------
  // Negative / minus as operator
  // ---------------------------------------------------------------
  describe('minus as operator token', () => {
    it('lexes minus between identifiers', () => {
      const r = lex('A - B');
      expect(types('A - B')).toEqual([
        TokenType.Identifier,
        TokenType.Minus,
        TokenType.Identifier,
      ]);
    });
  });
});
