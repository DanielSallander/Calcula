//! FILENAME: app/extensions/Pivot/dsl/parser.ts
// PURPOSE: Recursive-descent parser for the Pivot Layout DSL.
// CONTEXT: Transforms a token stream into an AST with error recovery.

import { TokenType, AGGREGATION_NAMES, SHOW_VALUES_AS_NAMES, type Token } from './tokens';
import {
  type PivotLayoutAST, type FieldNode, type ValueFieldNode,
  type FilterFieldNode, type SortNode, type LayoutDirective,
  type CalcFieldNode, type TopNNode, type GroupingNode, type ViaNode,
  emptyAST,
} from './ast';
import { type DslError, type SourceLocation, dslError } from './errors';
import type { AggregationType } from '../../_shared/components/types';

/** Result of parsing a token stream. */
export interface ParseResult {
  ast: PivotLayoutAST;
  errors: DslError[];
}

/**
 * Parse a token stream into a PivotLayoutAST.
 * Uses error recovery: on parse failure within a clause, skips to the next
 * clause keyword and continues, accumulating errors.
 */
export function parse(tokens: Token[]): ParseResult {
  const parser = new Parser(tokens);
  return parser.parse();
}

// ---------------------------------------------------------------------------
// Parser implementation
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos: number = 0;
  private errors: DslError[] = [];
  private ast: PivotLayoutAST = emptyAST();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ParseResult {
    this.skipNewlines();

    while (!this.isAtEnd()) {
      this.parseClause();
      this.skipNewlines();
    }

    return { ast: this.ast, errors: this.errors };
  }

  // --- Clause dispatch ---

  private parseClause(): void {
    const tok = this.peek();

    switch (tok.type) {
      case TokenType.Rows:
        this.advance();
        this.expect(TokenType.Colon, 'Expected ":" after ROWS');
        this.ast.rows = this.parseFieldList();
        break;
      case TokenType.Columns:
        this.advance();
        this.expect(TokenType.Colon, 'Expected ":" after COLUMNS');
        this.ast.columns = this.parseFieldList();
        break;
      case TokenType.Values:
        this.advance();
        this.expect(TokenType.Colon, 'Expected ":" after VALUES');
        this.ast.values = this.parseValueFieldList();
        break;
      case TokenType.Filters:
        this.advance();
        this.expect(TokenType.Colon, 'Expected ":" after FILTERS');
        this.ast.filters = this.parseFilterList();
        break;
      case TokenType.Sort:
        this.advance();
        this.expect(TokenType.Colon, 'Expected ":" after SORT');
        this.ast.sort = this.parseSortList();
        break;
      case TokenType.Layout:
        this.advance();
        this.expect(TokenType.Colon, 'Expected ":" after LAYOUT');
        this.ast.layout = this.parseLayoutDirectives();
        break;
      case TokenType.Calc:
        this.advance();
        this.expect(TokenType.Colon, 'Expected ":" after CALC');
        this.ast.calculatedFields.push(this.parseCalcField());
        break;
      case TokenType.Top:
      case TokenType.Bottom:
        this.ast.topN = this.parseTopN();
        break;
      case TokenType.Save:
        this.ast.saveAs = this.parseSaveAs();
        break;
      case TokenType.Comment:
        this.advance(); // skip comment tokens
        break;
      default:
        this.errors.push(dslError(
          `Unexpected token "${tok.value}". Expected a clause keyword (ROWS, COLUMNS, VALUES, FILTERS, SORT, LAYOUT, CALC, TOP, SAVE).`,
          tok.location,
        ));
        this.skipToNextClause();
        break;
    }
  }

  // --- ROWS / COLUMNS field list ---

  private parseFieldList(): FieldNode[] {
    const fields: FieldNode[] = [];
    const first = this.tryParseFieldRef();
    if (first) fields.push(first);
    else return fields;

    while (this.match(TokenType.Comma)) {
      this.skipNewlines();
      const field = this.tryParseFieldRef();
      if (field) {
        fields.push(field);
      } else {
        break;
      }
    }
    return fields;
  }

  private tryParseFieldRef(): FieldNode | null {
    this.skipNewlines();
    const startTok = this.peek();

    // LOOKUP prefix
    let isLookup = false;
    if (startTok.type === TokenType.Lookup) {
      isLookup = true;
      this.advance();
    }

    const nameResult = this.parseFieldName();
    if (!nameResult) return null;

    const node: FieldNode = {
      name: nameResult.name,
      table: nameResult.table,
      column: nameResult.column,
      isLookup,
      location: startTok.location,
    };

    // Field options: (no-subtotals), (subtotals: off)
    if (this.check(TokenType.LeftParen)) {
      this.parseFieldOptions(node);
    }

    // Grouping: .group(quarters) or .bin(10, 20, 80)
    if (this.check(TokenType.Dot)) {
      node.grouping = this.parseGrouping();
    }

    // VIA: VIA Orders.OrderDate
    if (this.check(TokenType.Via)) {
      node.via = this.parseVia();
    }

    return node;
  }

  // --- VALUES field list ---

  private parseValueFieldList(): ValueFieldNode[] {
    const fields: ValueFieldNode[] = [];
    const first = this.tryParseValueField();
    if (first) fields.push(first);
    else return fields;

    while (this.match(TokenType.Comma)) {
      this.skipNewlines();
      const field = this.tryParseValueField();
      if (field) {
        fields.push(field);
      } else {
        break;
      }
    }
    return fields;
  }

  private tryParseValueField(): ValueFieldNode | null {
    this.skipNewlines();
    const tok = this.peek();

    // Inline CALC: CALC Name = expression
    if (tok.type === TokenType.Calc) {
      this.advance(); // consume CALC
      const calcField = this.parseCalcField(true);
      const calcIndex = this.ast.calculatedFields.length;
      this.ast.calculatedFields.push(calcField);
      // Return a placeholder ValueFieldNode that marks this position as a calc field
      return {
        fieldName: calcField.name,
        isMeasure: false,
        inlineCalcIndex: calcIndex,
        location: tok.location,
      };
    }

    // Bracket measure: [Total Revenue]
    if (tok.type === TokenType.BracketIdentifier) {
      this.advance();
      const node: ValueFieldNode = {
        fieldName: tok.value,
        isMeasure: true,
        location: tok.location,
      };
      this.parseValueFieldSuffix(node);
      return node;
    }

    // Aggregation call: Sum(Sales) or Sum(Sales.Amount)
    if (this.isAggregationFunction()) {
      const aggTok = this.advance();
      const aggregation = aggTok.value.toLowerCase() as AggregationType;
      this.expect(TokenType.LeftParen, `Expected "(" after aggregation function "${aggTok.value}"`);
      const nameResult = this.parseFieldName();
      if (!nameResult) {
        this.errors.push(dslError('Expected field name inside aggregation', aggTok.location));
        this.skipToCommaOrNewline();
        return null;
      }
      this.expect(TokenType.RightParen, 'Expected ")" after field name in aggregation');
      const node: ValueFieldNode = {
        fieldName: nameResult.name,
        table: nameResult.table,
        column: nameResult.column,
        aggregation,
        isMeasure: false,
        location: aggTok.location,
      };
      this.parseValueFieldSuffix(node);
      return node;
    }

    // Bare field name (default aggregation will be assigned by compiler)
    const nameResult = this.parseFieldName();
    if (!nameResult) return null;

    const node: ValueFieldNode = {
      fieldName: nameResult.name,
      table: nameResult.table,
      column: nameResult.column,
      isMeasure: false,
      location: tok.location,
    };
    this.parseValueFieldSuffix(node);
    return node;
  }

  /** Parse the optional AS "alias" and [show-values-as] suffix on a value field. */
  private parseValueFieldSuffix(node: ValueFieldNode): void {
    // AS "alias"
    if (this.check(TokenType.As)) {
      this.advance();
      const strTok = this.peek();
      if (strTok.type === TokenType.StringLiteral) {
        this.advance();
        node.alias = strTok.value;
      } else {
        this.errors.push(dslError('Expected quoted string after AS', strTok.location));
      }
    }

    // [% of Row] or [Difference] etc.
    if (this.check(TokenType.BracketIdentifier)) {
      const bracketTok = this.advance();
      const normalized = bracketTok.value.toLowerCase().trim();
      const mapped = SHOW_VALUES_AS_NAMES.get(normalized);
      if (mapped) {
        node.showValuesAs = mapped;
      } else {
        this.errors.push(dslError(
          `Unknown show-values-as: "${bracketTok.value}". Valid options: ${[...SHOW_VALUES_AS_NAMES.keys()].join(', ')}`,
          bracketTok.location,
        ));
      }
    }
  }

  // --- FILTERS list ---
  //
  // Syntax:
  //   FILTERS: DimA, DimB = ("val1", "val2"), DimC NOT IN ("val3")
  //
  // Filters are comma-separated. Value lists use parentheses to avoid
  // ambiguity with the filter separator comma. A filter without = or NOT IN
  // is a plain filter field (no value restriction).

  private parseFilterList(): FilterFieldNode[] {
    const filters: FilterFieldNode[] = [];
    const first = this.tryParseFilter();
    if (first) filters.push(first);
    else return filters;

    while (this.match(TokenType.Comma)) {
      this.skipNewlines();
      const f = this.tryParseFilter();
      if (f) {
        filters.push(f);
      } else {
        break;
      }
    }
    return filters;
  }

  private tryParseFilter(): FilterFieldNode | null {
    this.skipNewlines();
    const tok = this.peek();
    const nameResult = this.parseFieldName();
    if (!nameResult) return null;

    let exclude = false;
    let hasOperator = false;

    // = (...) or NOT IN (...)
    if (this.match(TokenType.Not)) {
      if (this.check(TokenType.In)) {
        this.advance();
      }
      exclude = true;
      hasOperator = true;
    } else if (this.match(TokenType.Equals)) {
      hasOperator = true;
    }

    // No operator → plain filter field (no value restriction)
    if (!hasOperator) {
      return {
        fieldName: nameResult.name,
        table: nameResult.table,
        column: nameResult.column,
        values: [],
        exclude: false,
        location: tok.location,
      };
    }

    // Parse value list — with or without parentheses
    const values: string[] = [];
    const hasParen = this.match(TokenType.LeftParen);

    const valTok = this.peek();
    if (valTok.type === TokenType.StringLiteral) {
      this.advance();
      values.push(valTok.value);
      while (this.match(TokenType.Comma)) {
        this.skipNewlines();
        const nextVal = this.peek();
        if (nextVal.type === TokenType.StringLiteral) {
          this.advance();
          values.push(nextVal.value);
        } else {
          break;
        }
      }
    } else {
      this.errors.push(dslError('Expected quoted string value after "=" or "NOT IN"', valTok.location));
    }

    if (hasParen) {
      this.expect(TokenType.RightParen, 'Expected ")" to close filter value list');
    }

    return {
      fieldName: nameResult.name,
      table: nameResult.table,
      column: nameResult.column,
      values,
      exclude,
      location: tok.location,
    };
  }

  // --- SORT list ---

  private parseSortList(): SortNode[] {
    const items: SortNode[] = [];
    const first = this.tryParseSortItem();
    if (first) items.push(first);
    else return items;

    while (this.match(TokenType.Comma)) {
      this.skipNewlines();
      const item = this.tryParseSortItem();
      if (item) items.push(item);
      else break;
    }
    return items;
  }

  private tryParseSortItem(): SortNode | null {
    this.skipNewlines();
    const tok = this.peek();
    const nameResult = this.parseFieldName();
    if (!nameResult) return null;

    let direction: 'asc' | 'desc' = 'asc';
    if (this.match(TokenType.Asc)) {
      direction = 'asc';
    } else if (this.match(TokenType.Desc)) {
      direction = 'desc';
    }

    return { fieldName: nameResult.name, direction, location: tok.location };
  }

  // --- LAYOUT directives ---

  private parseLayoutDirectives(): LayoutDirective[] {
    const directives: LayoutDirective[] = [];
    const first = this.tryParseLayoutDirective();
    if (first) directives.push(first);
    else return directives;

    while (this.match(TokenType.Comma)) {
      this.skipNewlines();
      const d = this.tryParseLayoutDirective();
      if (d) directives.push(d);
      else break;
    }
    return directives;
  }

  private tryParseLayoutDirective(): LayoutDirective | null {
    this.skipNewlines();
    const tok = this.peek();
    if (tok.type === TokenType.Identifier) {
      this.advance();
      // Accept hyphenated identifiers as-is (they were already joined by the lexer)
      return { key: tok.value.toLowerCase(), location: tok.location };
    }
    // Also accept some keywords that might be used as directive names
    if (tok.type === TokenType.Identifier || isAnyIdentLike(tok)) {
      this.advance();
      return { key: tok.value.toLowerCase(), location: tok.location };
    }
    return null;
  }

  // --- CALC field ---

  /**
   * Parse a calculated field definition: Name = expression.
   * @param inline If true, parsing inside VALUES clause — stop at comma (not inside parens).
   */
  private parseCalcField(inline: boolean = false): CalcFieldNode {
    const nameTok = this.peek();
    let name = '';
    if (nameTok.type === TokenType.Identifier || nameTok.type === TokenType.StringLiteral) {
      this.advance();
      name = nameTok.value;
    } else {
      this.errors.push(dslError('Expected field name for calculated field', nameTok.location));
      name = '?';
    }

    this.expect(TokenType.Equals, 'Expected "=" after calculated field name');

    // Capture tokens as the expression (opaque to the DSL parser).
    // Bracket identifiers must be reconstructed with their brackets since the
    // lexer strips them (e.g., [TotalSales] is stored as value="TotalSales").
    // When inline (inside VALUES), stop at a top-level comma so the next
    // value field can be parsed.
    let expression = '';
    let parenDepth = 0;
    while (!this.isAtEnd() && !this.check(TokenType.Newline) && !this.check(TokenType.EOF)) {
      // In inline mode, stop at comma when not inside parentheses
      if (inline && parenDepth === 0 && this.check(TokenType.Comma)) {
        break;
      }
      const tok = this.advance();
      if (tok.type === TokenType.LeftParen) parenDepth++;
      if (tok.type === TokenType.RightParen) parenDepth = Math.max(0, parenDepth - 1);
      if (tok.type === TokenType.BracketIdentifier) {
        expression += `[${tok.value}]`;
      } else if (tok.type === TokenType.StringLiteral) {
        expression += `"${tok.value}"`;
      } else {
        expression += tok.value;
      }
      // Add spacing for readability
      if (!this.check(TokenType.Newline) && !this.check(TokenType.EOF) &&
          !(inline && parenDepth === 0 && this.check(TokenType.Comma))) {
        expression += ' ';
      }
    }

    return {
      name,
      expression: expression.trim(),
      location: nameTok.location,
    };
  }

  // --- TOP N ---

  private parseTopN(): TopNNode {
    const tok = this.advance(); // TOP or BOTTOM
    const top = tok.type === TokenType.Top;

    let count = 10;
    const numTok = this.peek();
    if (numTok.type === TokenType.NumberLiteral) {
      this.advance();
      count = parseInt(numTok.value, 10);
    } else {
      this.errors.push(dslError('Expected a number after TOP/BOTTOM', numTok.location));
    }

    this.expect(TokenType.By, 'Expected BY after TOP/BOTTOM count');

    // The "by" field can be an aggregation call or a plain field
    let byField = '';
    let byAggregation: AggregationType | undefined;

    if (this.isAggregationFunction()) {
      const aggTok = this.advance();
      byAggregation = aggTok.value.toLowerCase() as AggregationType;
      this.expect(TokenType.LeftParen, `Expected "(" after "${aggTok.value}"`);
      const nameResult = this.parseFieldName();
      byField = nameResult?.name ?? '?';
      this.expect(TokenType.RightParen, 'Expected ")"');
    } else {
      const nameResult = this.parseFieldName();
      byField = nameResult?.name ?? '?';
    }

    return { count, top, byField, byAggregation, location: tok.location };
  }

  // --- SAVE AS ---

  private parseSaveAs(): string {
    this.advance(); // SAVE
    this.expect(TokenType.As, 'Expected AS after SAVE');
    const strTok = this.peek();
    if (strTok.type === TokenType.StringLiteral) {
      this.advance();
      return strTok.value;
    }
    this.errors.push(dslError('Expected quoted string after SAVE AS', strTok.location));
    return '';
  }

  // --- Field name parsing (shared) ---

  /** Parse a field name: Identifier, DottedIdentifier, or StringLiteral. */
  private parseFieldName(): { name: string; table?: string; column?: string } | null {
    const tok = this.peek();

    if (tok.type === TokenType.DottedIdentifier) {
      this.advance();
      const dotIdx = tok.value.indexOf('.');
      return {
        name: tok.value,
        table: tok.value.substring(0, dotIdx),
        column: tok.value.substring(dotIdx + 1),
      };
    }

    if (tok.type === TokenType.Identifier) {
      this.advance();
      return { name: tok.value };
    }

    if (tok.type === TokenType.StringLiteral) {
      this.advance();
      return { name: tok.value };
    }

    // Some keywords may appear as field names (e.g., a column named "Index")
    if (isAnyIdentLike(tok)) {
      this.advance();
      return { name: tok.value };
    }

    return null;
  }

  // --- Field options: (no-subtotals) etc. ---

  private parseFieldOptions(node: FieldNode): void {
    this.advance(); // consume (
    while (!this.isAtEnd() && !this.check(TokenType.RightParen)) {
      const optTok = this.peek();
      if (optTok.type === TokenType.Identifier) {
        this.advance();
        const opt = optTok.value.toLowerCase();
        if (opt === 'no-subtotals') {
          node.subtotals = false;
        } else if (opt === 'subtotals') {
          // subtotals: on/off
          if (this.match(TokenType.Colon)) {
            const valTok = this.peek();
            if (valTok.type === TokenType.Identifier) {
              this.advance();
              node.subtotals = valTok.value.toLowerCase() !== 'off';
            }
          } else {
            node.subtotals = true;
          }
        } else {
          this.errors.push(dslError(`Unknown field option: "${opt}"`, optTok.location));
        }
      } else {
        break;
      }
      this.match(TokenType.Comma); // optional comma between options
    }
    this.expect(TokenType.RightParen, 'Expected ")" to close field options');
  }

  // --- Grouping: .group(...) or .bin(...) ---

  private parseGrouping(): GroupingNode {
    const dotTok = this.advance(); // consume .
    const funcTok = this.peek();

    if (funcTok.type !== TokenType.Identifier) {
      this.errors.push(dslError('Expected "group" or "bin" after "."', funcTok.location));
      return { type: 'date', location: dotTok.location };
    }

    this.advance();
    const func = funcTok.value.toLowerCase();
    this.expect(TokenType.LeftParen, `Expected "(" after "${funcTok.value}"`);

    if (func === 'group') {
      const levels: string[] = [];
      while (!this.isAtEnd() && !this.check(TokenType.RightParen)) {
        const levelTok = this.peek();
        if (levelTok.type === TokenType.Identifier) {
          this.advance();
          levels.push(levelTok.value.toLowerCase());
        } else {
          break;
        }
        this.match(TokenType.Comma); // optional comma
      }
      this.expect(TokenType.RightParen, 'Expected ")"');
      return { type: 'date', levels, location: dotTok.location };
    }

    if (func === 'bin') {
      const params: number[] = [];
      while (!this.isAtEnd() && !this.check(TokenType.RightParen)) {
        const numTok = this.peek();
        if (numTok.type === TokenType.NumberLiteral) {
          this.advance();
          params.push(parseFloat(numTok.value));
        } else {
          break;
        }
        this.match(TokenType.Comma); // optional comma
      }
      this.expect(TokenType.RightParen, 'Expected ")"');
      return { type: 'number', params, location: dotTok.location };
    }

    this.errors.push(dslError(`Unknown grouping function: "${func}". Expected "group" or "bin".`, funcTok.location));
    this.skipToCommaOrNewline();
    return { type: 'date', location: dotTok.location };
  }

  // --- VIA ---

  private parseVia(): ViaNode {
    const viaTok = this.advance(); // consume VIA
    const nameResult = this.parseFieldName();
    return {
      path: nameResult?.name ?? '?',
      location: viaTok.location,
    };
  }

  // --- Helpers ---

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: TokenType.EOF, value: '', location: { line: 1, column: 0, endColumn: 0 } };
  }

  private advance(): Token {
    const tok = this.peek();
    if (this.pos < this.tokens.length) this.pos++;
    return tok;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private match(type: TokenType): boolean {
    if (this.check(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(type: TokenType, message: string): Token | null {
    if (this.check(type)) {
      return this.advance();
    }
    this.errors.push(dslError(message, this.peek().location));
    return null;
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private skipNewlines(): void {
    while (this.check(TokenType.Newline) || this.check(TokenType.Comment)) {
      this.advance();
    }
  }

  /** Check if current token is an aggregation function name (followed by `(`). */
  private isAggregationFunction(): boolean {
    const tok = this.peek();
    if (tok.type !== TokenType.Identifier) return false;
    if (!AGGREGATION_NAMES.has(tok.value.toLowerCase())) return false;
    // Peek ahead for (
    const next = this.pos + 1 < this.tokens.length ? this.tokens[this.pos + 1] : null;
    return next !== null && next.type === TokenType.LeftParen;
  }

  /** Skip tokens until we find a clause keyword or EOF. */
  private skipToNextClause(): void {
    while (!this.isAtEnd()) {
      const tok = this.peek();
      if (isClauseStart(tok.type)) return;
      this.advance();
    }
  }

  /** Skip tokens until comma or newline. */
  private skipToCommaOrNewline(): void {
    while (!this.isAtEnd() && !this.check(TokenType.Comma) && !this.check(TokenType.Newline)) {
      this.advance();
    }
  }
}

// --- Utility functions ---

/** Check if a token type is a clause-starting keyword. */
function isClauseStart(type: TokenType): boolean {
  return type === TokenType.Rows || type === TokenType.Columns ||
    type === TokenType.Values || type === TokenType.Filters ||
    type === TokenType.Sort || type === TokenType.Layout ||
    type === TokenType.Calc || type === TokenType.Top ||
    type === TokenType.Bottom || type === TokenType.Save;
}

/** Check if a token looks like an identifier (including keywords that could be field names). */
function isAnyIdentLike(tok: Token): boolean {
  // Keywords that might collide with field names
  return tok.type === TokenType.Identifier ||
    tok.type === TokenType.Asc || tok.type === TokenType.Desc ||
    tok.type === TokenType.By || tok.type === TokenType.In ||
    tok.type === TokenType.Not || tok.type === TokenType.As;
}
