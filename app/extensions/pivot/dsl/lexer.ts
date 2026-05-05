//! FILENAME: app/extensions/Pivot/dsl/lexer.ts
// PURPOSE: Tokenizer for the Pivot Layout DSL.
// CONTEXT: Converts raw DSL text into a stream of tokens for the parser.

import { TokenType, KEYWORDS, type Token } from './tokens';
import { type DslError, dslError } from './errors';

/** Result of lexing a DSL string. */
export interface LexResult {
  tokens: Token[];
  errors: DslError[];
}

/**
 * Tokenize a Pivot Layout DSL string.
 * Produces a token stream with line/column info for every token.
 * Unknown characters are reported as errors but do not abort lexing.
 */
export function lex(input: string): LexResult {
  const tokens: Token[] = [];
  const errors: DslError[] = [];
  let pos = 0;
  let line = 1;
  let col = 0;

  function peek(): string {
    return pos < input.length ? input[pos] : '';
  }

  function advance(): string {
    const ch = input[pos++];
    if (ch === '\n') {
      line++;
      col = 0;
    } else {
      col++;
    }
    return ch;
  }

  function makeToken(type: TokenType, value: string, startCol: number, startLine: number): Token {
    return {
      type,
      value,
      location: { line: startLine, column: startCol, endColumn: startCol + value.length },
    };
  }

  while (pos < input.length) {
    const ch = peek();
    const startCol = col;
    const startLine = line;

    // Whitespace (not newlines)
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }

    // Newline
    if (ch === '\n') {
      advance();
      tokens.push(makeToken(TokenType.Newline, '\n', startCol, startLine));
      continue;
    }

    // Comment: # until end of line
    if (ch === '#') {
      let comment = '';
      while (pos < input.length && peek() !== '\n') {
        comment += advance();
      }
      tokens.push(makeToken(TokenType.Comment, comment, startCol, startLine));
      continue;
    }

    // String literal: "..."
    if (ch === '"') {
      advance(); // skip opening quote
      let str = '';
      while (pos < input.length && peek() !== '"' && peek() !== '\n') {
        str += advance();
      }
      if (peek() === '"') {
        advance(); // skip closing quote
      } else {
        errors.push(dslError('Unterminated string literal', {
          line: startLine, column: startCol, endColumn: col,
        }));
      }
      tokens.push(makeToken(TokenType.StringLiteral, str, startCol, startLine));
      continue;
    }

    // Bracket identifier: [...]
    if (ch === '[') {
      // Check if this looks like a show-values-as bracket (e.g., [% of Row])
      // or a measure identifier (e.g., [Total Revenue])
      advance(); // skip [
      let content = '';
      while (pos < input.length && peek() !== ']' && peek() !== '\n') {
        content += advance();
      }
      if (peek() === ']') {
        advance(); // skip ]
      } else {
        errors.push(dslError('Unterminated bracket identifier', {
          line: startLine, column: startCol, endColumn: col,
        }));
      }
      tokens.push(makeToken(TokenType.BracketIdentifier, content, startCol, startLine));
      continue;
    }

    // Number literal
    if (isDigit(ch)) {
      let num = '';
      while (pos < input.length && isDigit(peek())) {
        num += advance();
      }
      if (pos < input.length && peek() === '.') {
        // Could be a decimal or a dotted identifier starting with digits (unlikely)
        // Peek ahead to see if next char after . is a digit
        const nextPos = pos + 1;
        if (nextPos < input.length && isDigit(input[nextPos])) {
          num += advance(); // consume .
          while (pos < input.length && isDigit(peek())) {
            num += advance();
          }
        }
      }
      tokens.push(makeToken(TokenType.NumberLiteral, num, startCol, startLine));
      continue;
    }

    // Identifier, keyword, or dotted identifier
    if (isIdentStart(ch)) {
      let ident = '';
      while (pos < input.length && isIdentChar(peek())) {
        ident += advance();
      }
      // Check for hyphenated identifiers (layout directives like "repeat-labels")
      while (pos < input.length && peek() === '-' && pos + 1 < input.length && isIdentStart(input[pos + 1])) {
        ident += advance(); // consume -
        while (pos < input.length && isIdentChar(peek())) {
          ident += advance();
        }
      }

      // Check for dotted identifier: Identifier.Identifier
      if (pos < input.length && peek() === '.') {
        const savedPos = pos;
        const savedCol = col;
        const savedLine = line;
        const dotCh = advance(); // consume .
        if (pos < input.length && isIdentStart(peek())) {
          let afterDot = '';
          while (pos < input.length && isIdentChar(peek())) {
            afterDot += advance();
          }
          tokens.push(makeToken(TokenType.DottedIdentifier, ident + '.' + afterDot, startCol, startLine));
          continue;
        } else {
          // Not a dotted identifier -- backtrack the dot
          pos = savedPos;
          col = savedCol;
          // line wouldn't change from a dot
        }
      }

      // Check if keyword
      const upper = ident.toUpperCase();
      const kwType = KEYWORDS[upper];
      if (kwType !== undefined) {
        tokens.push(makeToken(kwType, ident, startCol, startLine));
      } else {
        tokens.push(makeToken(TokenType.Identifier, ident, startCol, startLine));
      }
      continue;
    }

    // Single-character symbols
    const symbolMap: Record<string, TokenType> = {
      ':': TokenType.Colon,
      ',': TokenType.Comma,
      '(': TokenType.LeftParen,
      ')': TokenType.RightParen,
      '=': TokenType.Equals,
      '.': TokenType.Dot,
      '+': TokenType.Plus,
      '-': TokenType.Minus,
      '*': TokenType.Star,
      '/': TokenType.Slash,
      '^': TokenType.Caret,
    };

    const symType = symbolMap[ch];
    if (symType !== undefined) {
      advance();
      tokens.push(makeToken(symType, ch, startCol, startLine));
      continue;
    }

    // Unknown character
    advance();
    errors.push(dslError(`Unexpected character: '${ch}'`, {
      line: startLine, column: startCol, endColumn: startCol + 1,
    }));
  }

  // Always end with EOF
  tokens.push(makeToken(TokenType.EOF, '', col, line));
  return { tokens, errors };
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}
