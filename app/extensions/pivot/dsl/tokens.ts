//! FILENAME: app/extensions/Pivot/dsl/tokens.ts
// PURPOSE: Token types for the Pivot Layout DSL lexer.
// CONTEXT: Consumed by the parser to build the AST.

import type { SourceLocation } from './errors';

/** All recognized token types. */
export enum TokenType {
  // --- Keywords (clause starters) ---
  Rows = 'ROWS',
  Columns = 'COLUMNS',
  Values = 'VALUES',
  Filters = 'FILTERS',
  Sort = 'SORT',
  Layout = 'LAYOUT',
  Calc = 'CALC',
  Top = 'TOP',
  Bottom = 'BOTTOM',
  By = 'BY',
  As = 'AS',
  Save = 'SAVE',
  Lookup = 'LOOKUP',
  Via = 'VIA',
  Not = 'NOT',
  In = 'IN',

  // --- Sort directions ---
  Asc = 'ASC',
  Desc = 'DESC',

  // --- Literals ---
  Identifier = 'IDENTIFIER',         // Region, Sales, tabular
  DottedIdentifier = 'DOTTED_IDENT', // Customers.Region
  BracketIdentifier = 'BRACKET_ID',  // [Total Revenue]
  StringLiteral = 'STRING',          // "Sweden"
  NumberLiteral = 'NUMBER',          // 10, 3.14

  // --- Symbols ---
  Colon = ':',
  Comma = ',',
  LeftParen = '(',
  RightParen = ')',
  Equals = '=',
  Dot = '.',
  Plus = '+',
  Minus = '-',
  Star = '*',
  Slash = '/',
  Caret = '^',

  // --- Structural ---
  Newline = 'NEWLINE',
  Comment = 'COMMENT',               // # comment line
  EOF = 'EOF',
}

/** A single token produced by the lexer. */
export interface Token {
  type: TokenType;
  value: string;
  location: SourceLocation;
}

/**
 * Keywords are case-insensitive identifiers with special meaning.
 * Map from UPPERCASE to the corresponding TokenType.
 */
export const KEYWORDS: Record<string, TokenType> = {
  'ROWS': TokenType.Rows,
  'COLUMNS': TokenType.Columns,
  'VALUES': TokenType.Values,
  'FILTERS': TokenType.Filters,
  'SORT': TokenType.Sort,
  'LAYOUT': TokenType.Layout,
  'CALC': TokenType.Calc,
  'TOP': TokenType.Top,
  'BOTTOM': TokenType.Bottom,
  'BY': TokenType.By,
  'AS': TokenType.As,
  'SAVE': TokenType.Save,
  'LOOKUP': TokenType.Lookup,
  'VIA': TokenType.Via,
  'NOT': TokenType.Not,
  'IN': TokenType.In,
  'ASC': TokenType.Asc,
  'DESC': TokenType.Desc,
};

/** Aggregation function names recognized in the VALUES clause. */
export const AGGREGATION_NAMES: ReadonlySet<string> = new Set([
  'sum', 'count', 'average', 'min', 'max',
  'countnumbers', 'stddev', 'stddevp', 'var', 'varp', 'product',
]);

/** Layout directive names recognized in the LAYOUT clause. */
export const LAYOUT_DIRECTIVES: ReadonlySet<string> = new Set([
  'compact', 'outline', 'tabular',
  'repeat-labels', 'no-repeat-labels',
  'no-grand-totals', 'no-row-totals', 'no-column-totals',
  'grand-totals', 'row-totals', 'column-totals',
  'show-empty-rows', 'show-empty-cols',
  'values-on-rows', 'values-on-columns',
  'auto-fit',
  'subtotals-top', 'subtotals-bottom', 'subtotals-off',
]);

/** Show-values-as names recognized inside [ ] after a value field. */
export const SHOW_VALUES_AS_NAMES: ReadonlyMap<string, string> = new Map([
  ['% of grand total', 'percent_of_total'],
  ['% of row', 'percent_of_row'],
  ['% of row total', 'percent_of_row'],
  ['% of column', 'percent_of_column'],
  ['% of column total', 'percent_of_column'],
  ['% of parent row', 'percent_of_parent_row'],
  ['% of parent column', 'percent_of_parent_column'],
  ['difference', 'difference'],
  ['% difference', 'percent_difference'],
  ['running total', 'running_total'],
  ['index', 'index'],
]);
