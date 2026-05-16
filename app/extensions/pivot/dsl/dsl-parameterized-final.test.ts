//! FILENAME: app/extensions/Pivot/dsl/dsl-parameterized-final.test.ts
// PURPOSE: Heavily parameterized tests for all DSL modules using it.each.
// TARGET: 300+ test cases via combinatorial expansion.

import { describe, it, expect } from 'vitest';
import { lex } from './lexer';
import { parse } from './parser';
import { compile, type CompileContext } from './compiler';
import { serialize } from './serializer';
import { validate, type ValidateContext } from './validator';
import { processDsl } from './index';
import { TokenType, KEYWORDS, AGGREGATION_NAMES, SHOW_VALUES_AS_NAMES, LAYOUT_DIRECTIVES } from './tokens';
import type { SourceField, AggregationType, ZoneField } from '../../_shared/components/types';
import type { LayoutConfig } from '../components/types';

// ============================================================================
// Helpers
// ============================================================================

const loc = { line: 1, column: 0, endColumn: 0 };

const sampleSourceFields: SourceField[] = [
  { index: 0, name: 'Region', isNumeric: false },
  { index: 1, name: 'Product', isNumeric: false },
  { index: 2, name: 'Sales', isNumeric: true },
  { index: 3, name: 'Quantity', isNumeric: true },
  { index: 4, name: 'Category', isNumeric: false },
  { index: 5, name: 'Profit', isNumeric: true },
  { index: 6, name: 'Discount', isNumeric: true },
  { index: 7, name: 'Cost', isNumeric: true },
  { index: 8, name: 'Year', isNumeric: false },
  { index: 9, name: 'Month', isNumeric: false },
  { index: 10, name: 'Index', isNumeric: true },
];

function makeCtx(extra?: Partial<CompileContext>): CompileContext {
  return { sourceFields: sampleSourceFields, ...extra };
}

function makeValidateCtx(extra?: Partial<ValidateContext>): ValidateContext {
  return { sourceFields: sampleSourceFields, ...extra };
}

// ============================================================================
// 1. Lex every keyword (18 keywords) x 3 case variants = 54 tests
// ============================================================================

const allKeywords = Object.keys(KEYWORDS) as string[];

const keywordCaseVariants: [string, string, TokenType][] = allKeywords.flatMap(kw => {
  const tt = KEYWORDS[kw];
  return [
    [`UPPER: ${kw}`, kw, tt],
    [`lower: ${kw.toLowerCase()}`, kw.toLowerCase(), tt],
    [`Mixed: ${kw.charAt(0) + kw.slice(1).toLowerCase()}`, kw.charAt(0) + kw.slice(1).toLowerCase(), tt],
  ] as [string, string, TokenType][];
});

describe('Lexer: keyword case variants', () => {
  it.each(keywordCaseVariants)(
    '%s -> %s',
    (_label, input, expectedType) => {
      // Wrap in a context where it won't be parsed as part of a clause
      const { tokens, errors } = lex(input);
      const kwToken = tokens.find(t => t.type !== TokenType.EOF);
      expect(kwToken).toBeDefined();
      expect(kwToken!.type).toBe(expectedType);
      expect(errors).toHaveLength(0);
    },
  );
});

// ============================================================================
// 2. Lex every symbol token (11 symbols) with context = 11 tests
// ============================================================================

const symbolTests: [string, string, TokenType][] = [
  ['colon', ':', TokenType.Colon],
  ['comma', ',', TokenType.Comma],
  ['left paren', '(', TokenType.LeftParen],
  ['right paren', ')', TokenType.RightParen],
  ['equals', '=', TokenType.Equals],
  ['dot', '.', TokenType.Dot],
  ['plus', '+', TokenType.Plus],
  ['minus', '-', TokenType.Minus],
  ['star', '*', TokenType.Star],
  ['slash', '/', TokenType.Slash],
  ['caret', '^', TokenType.Caret],
];

describe('Lexer: symbol tokens', () => {
  it.each(symbolTests)(
    'lexes %s as %s',
    (_label, input, expectedType) => {
      const { tokens, errors } = lex(input);
      const sym = tokens.find(t => t.type !== TokenType.EOF);
      expect(sym).toBeDefined();
      expect(sym!.type).toBe(expectedType);
      expect(sym!.value).toBe(input);
      expect(errors).toHaveLength(0);
    },
  );
});

// ============================================================================
// 3. Parse every clause type x 3 complexity levels = 24 tests
// ============================================================================

const clauseParseTests: [string, string, (ast: ReturnType<typeof parse>['ast']) => void][] = [
  // ROWS: simple
  ['ROWS simple', 'ROWS: Region', ast => {
    expect(ast.rows).toHaveLength(1);
    expect(ast.rows[0].name).toBe('Region');
  }],
  // ROWS: medium
  ['ROWS medium', 'ROWS: Region, Product', ast => {
    expect(ast.rows).toHaveLength(2);
  }],
  // ROWS: complex with options
  ['ROWS complex', 'ROWS: Region(no-subtotals), Product', ast => {
    expect(ast.rows).toHaveLength(2);
    expect(ast.rows[0].subtotals).toBe(false);
  }],

  // COLUMNS: simple
  ['COLUMNS simple', 'COLUMNS: Year', ast => {
    expect(ast.columns).toHaveLength(1);
  }],
  // COLUMNS: medium
  ['COLUMNS medium', 'COLUMNS: Year, Month', ast => {
    expect(ast.columns).toHaveLength(2);
  }],
  // COLUMNS: complex
  ['COLUMNS complex', 'COLUMNS: Year(subtotals: off), Month', ast => {
    expect(ast.columns).toHaveLength(2);
    expect(ast.columns[0].subtotals).toBe(false);
  }],

  // VALUES: simple
  ['VALUES simple', 'VALUES: Sum(Sales)', ast => {
    expect(ast.values).toHaveLength(1);
    expect(ast.values[0].aggregation).toBe('sum');
  }],
  // VALUES: medium with alias
  ['VALUES medium', 'VALUES: Sum(Sales) AS "Total Sales"', ast => {
    expect(ast.values).toHaveLength(1);
    expect(ast.values[0].alias).toBe('Total Sales');
  }],
  // VALUES: complex with show-values-as
  ['VALUES complex', 'VALUES: Sum(Sales) [% of Row], Count(Quantity)', ast => {
    expect(ast.values).toHaveLength(2);
    expect(ast.values[0].showValuesAs).toBe('percent_of_row');
  }],

  // FILTERS: simple
  ['FILTERS simple', 'FILTERS: Region', ast => {
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].values).toHaveLength(0);
  }],
  // FILTERS: medium with values
  ['FILTERS medium', 'FILTERS: Region = ("East", "West")', ast => {
    expect(ast.filters).toHaveLength(1);
    expect(ast.filters[0].values).toEqual(['East', 'West']);
  }],
  // FILTERS: complex NOT IN
  ['FILTERS complex', 'FILTERS: Region NOT IN ("South"), Category = ("A")', ast => {
    expect(ast.filters).toHaveLength(2);
    expect(ast.filters[0].exclude).toBe(true);
    expect(ast.filters[1].exclude).toBe(false);
  }],

  // SORT: simple
  ['SORT simple', 'SORT: Region', ast => {
    expect(ast.sort).toHaveLength(1);
    expect(ast.sort[0].direction).toBe('asc');
  }],
  // SORT: medium
  ['SORT medium', 'SORT: Region ASC, Sales DESC', ast => {
    expect(ast.sort).toHaveLength(2);
    expect(ast.sort[1].direction).toBe('desc');
  }],
  // SORT: complex
  ['SORT complex', 'SORT: Region ASC, Product DESC, Year ASC', ast => {
    expect(ast.sort).toHaveLength(3);
  }],

  // LAYOUT: simple
  ['LAYOUT simple', 'LAYOUT: compact', ast => {
    expect(ast.layout).toHaveLength(1);
    expect(ast.layout[0].key).toBe('compact');
  }],
  // LAYOUT: medium
  ['LAYOUT medium', 'LAYOUT: tabular, repeat-labels', ast => {
    expect(ast.layout).toHaveLength(2);
  }],
  // LAYOUT: complex
  ['LAYOUT complex', 'LAYOUT: outline, no-grand-totals, show-empty-rows, auto-fit', ast => {
    expect(ast.layout).toHaveLength(4);
  }],

  // CALC: simple
  ['CALC simple', 'CALC: Margin = [Sales] - [Cost]', ast => {
    expect(ast.calculatedFields).toHaveLength(1);
    expect(ast.calculatedFields[0].name).toBe('Margin');
  }],
  // CALC: medium
  ['CALC medium', 'CALC: Ratio = [Sales] / [Quantity]', ast => {
    expect(ast.calculatedFields[0].expression).toContain('/');
  }],
  // CALC: complex with parens
  ['CALC complex', 'CALC: Score = ([Sales] * 2) + [Profit]', ast => {
    expect(ast.calculatedFields[0].expression).toContain('*');
    expect(ast.calculatedFields[0].expression).toContain('+');
  }],

  // TOP: simple
  ['TOP simple', 'TOP 5 BY Sales', ast => {
    expect(ast.topN).toBeDefined();
    expect(ast.topN!.top).toBe(true);
    expect(ast.topN!.count).toBe(5);
  }],
  // TOP: medium with aggregation
  ['TOP medium', 'TOP 10 BY Sum(Sales)', ast => {
    expect(ast.topN!.byAggregation).toBe('sum');
  }],
  // BOTTOM
  ['BOTTOM complex', 'BOTTOM 3 BY Average(Profit)', ast => {
    expect(ast.topN!.top).toBe(false);
    expect(ast.topN!.byAggregation).toBe('average');
    expect(ast.topN!.count).toBe(3);
  }],
];

describe('Parser: clause types x complexity', () => {
  it.each(clauseParseTests)(
    '%s',
    (_label, input, assertFn) => {
      const { tokens } = lex(input);
      const { ast, errors } = parse(tokens);
      expect(errors).toHaveLength(0);
      assertFn(ast);
    },
  );
});

// ============================================================================
// 4. Compile with every aggregation (11) x every showValuesAs (10) = 110 tests
// ============================================================================

const allAggregations: AggregationType[] = [
  'sum', 'count', 'average', 'min', 'max',
  'countnumbers', 'stddev', 'stddevp', 'var', 'varp', 'product',
];

// Map from internal showValuesAs to a DSL bracket label that the parser accepts
const showValuesAsLabels: [string, string][] = [
  ['percent_of_total', '% of Grand Total'],
  ['percent_of_row', '% of Row'],
  ['percent_of_column', '% of Column'],
  ['percent_of_parent_row', '% of Parent Row'],
  ['percent_of_parent_column', '% of Parent Column'],
  ['difference', 'Difference'],
  ['percent_difference', '% Difference'],
  ['running_total', 'Running Total'],
  ['index', 'Index'],
];

// Normal (no showValuesAs) for each aggregation
const aggOnlyCases: [string, string][] = allAggregations.map(agg => [
  agg,
  `VALUES: ${capitalize(agg)}(Sales)`,
]);

// Cross product: aggregation x showValuesAs
const aggShowValuesCases: [string, string, string, string][] = allAggregations.flatMap(agg =>
  showValuesAsLabels.map(([internal, label]) => [
    `${agg} x ${internal}`,
    `VALUES: ${capitalize(agg)}(Sales) [${label}]`,
    agg,
    internal,
  ] as [string, string, string, string]),
);

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

describe('Compile: aggregation x showValuesAs', () => {
  it.each(aggOnlyCases)(
    'aggregation %s compiles without showValuesAs',
    (agg, dsl) => {
      const fullDsl = `ROWS: Region\n${dsl}`;
      const result = processDsl(fullDsl, makeCtx());
      const compileErrors = result.errors.filter(e => e.severity === 'error');
      expect(compileErrors).toHaveLength(0);
      expect(result.values).toHaveLength(1);
      expect(result.values[0].aggregation).toBe(agg);
    },
  );

  it.each(aggShowValuesCases)(
    '%s',
    (_label, dsl, agg, showAs) => {
      const fullDsl = `ROWS: Region\n${dsl}`;
      const result = processDsl(fullDsl, makeCtx());
      const compileErrors = result.errors.filter(e => e.severity === 'error');
      expect(compileErrors).toHaveLength(0);
      expect(result.values).toHaveLength(1);
      expect(result.values[0].aggregation).toBe(agg);
      expect(result.values[0].showValuesAs).toBe(showAs);
    },
  );
});

// ============================================================================
// 5. Serialize every aggregation x round-trip = 11 tests
// ============================================================================

describe('Serializer: aggregation round-trip', () => {
  it.each(allAggregations)(
    'round-trips aggregation %s',
    (agg) => {
      const values: ZoneField[] = [{
        sourceIndex: 2,
        name: 'Sales',
        isNumeric: true,
        aggregation: agg,
      }];
      const text = serialize([], [], values, [], {});
      expect(text).toContain('VALUES:');
      expect(text.toLowerCase()).toContain(agg);

      // Parse back and compile
      const result = processDsl(text, makeCtx());
      const compileErrors = result.errors.filter(e => e.severity === 'error');
      expect(compileErrors).toHaveLength(0);
      expect(result.values).toHaveLength(1);
      expect(result.values[0].aggregation).toBe(agg);
    },
  );
});

// ============================================================================
// 6. Serialize every showValuesAs x round-trip = 10 tests (9 named + normal)
// ============================================================================

const allShowValuesAs: [string, string | undefined][] = [
  ['normal', undefined],  // normal produces no bracket suffix
  ...showValuesAsLabels.map(([internal]) => [internal, internal] as [string, string | undefined]),
];

describe('Serializer: showValuesAs round-trip', () => {
  it.each(allShowValuesAs)(
    'round-trips showValuesAs %s',
    (showAs, expectedAfterRoundTrip) => {
      const values: ZoneField[] = [{
        sourceIndex: 2,
        name: 'Sales',
        isNumeric: true,
        aggregation: 'sum',
        showValuesAs: showAs,
      }];
      const text = serialize([], [], values, [], {});

      if (showAs === 'normal') {
        // normal should NOT produce a bracket suffix
        expect(text).not.toMatch(/\[.*\]/);
      } else {
        expect(text).toMatch(/\[.*\]/);
      }

      // Parse back
      const result = processDsl(text, makeCtx());
      const compileErrors = result.errors.filter(e => e.severity === 'error');
      expect(compileErrors).toHaveLength(0);
      expect(result.values).toHaveLength(1);
      if (expectedAfterRoundTrip) {
        expect(result.values[0].showValuesAs).toBe(expectedAfterRoundTrip);
      }
    },
  );
});

// ============================================================================
// 7. Validate every error type = 15+ tests
// ============================================================================

const validationErrorTests: [string, string, string, string][] = [
  // [label, dsl, expectedSeverity, expectedMessageSubstring]
  ['unknown row field', 'ROWS: UnknownField\nVALUES: Sum(Sales)', 'error', 'Unknown field'],
  ['unknown column field', 'COLUMNS: BadCol\nVALUES: Sum(Sales)', 'error', 'Unknown field'],
  ['unknown value field', 'ROWS: Region\nVALUES: Sum(BadField)', 'error', 'Unknown field'],
  ['unknown filter field', 'FILTERS: BadFilter = ("x")', 'error', 'Unknown field'],
  ['unknown sort field', 'SORT: BadSort ASC', 'error', 'Unknown sort field'],
  ['unknown layout directive', 'LAYOUT: invalid-directive', 'warning', 'Unknown layout directive'],
  ['duplicate field in ROWS', 'ROWS: Region, Region\nVALUES: Sum(Sales)', 'warning', 'Duplicate field'],
  ['field in both ROWS and COLUMNS', 'ROWS: Region\nCOLUMNS: Region\nVALUES: Sum(Sales)', 'warning', 'appears in both'],
  ['numeric agg on non-numeric', 'ROWS: Region\nVALUES: Sum(Product)', 'warning', 'non-numeric'],
  ['no VALUES hint', 'ROWS: Region', 'info', 'No VALUES defined'],
  ['bracket measure without BI', 'VALUES: [TotalSales]', 'error', 'require a BI model'],
  ['filter with no values', 'FILTERS: Region', 'warning', 'no values specified'],
  ['LOOKUP without BI', 'ROWS: LOOKUP Region\nVALUES: Sum(Sales)', 'error', 'LOOKUP fields are only supported'],
  ['unknown field in value agg', 'ROWS: Region\nVALUES: Average(Missing)', 'error', 'Unknown field'],
  ['multiple errors: unknown fields', 'ROWS: Bad1\nCOLUMNS: Bad2\nVALUES: Sum(Sales)', 'error', 'Unknown field'],
];

describe('Validator: error types', () => {
  it.each(validationErrorTests)(
    '%s',
    (_label, dsl, severity, messageSubstr) => {
      const result = processDsl(dsl, makeCtx());
      const matching = result.errors.filter(
        e => e.severity === severity && e.message.includes(messageSubstr),
      );
      expect(matching.length).toBeGreaterThanOrEqual(1);
    },
  );
});

// ============================================================================
// 8. processDsl with 20 representative DSL strings = 20 tests
// ============================================================================

const processDslTests: [string, string, (r: ReturnType<typeof processDsl>) => void][] = [
  ['empty string', '', r => {
    expect(r.rows).toHaveLength(0);
    expect(r.values).toHaveLength(0);
  }],
  ['rows only', 'ROWS: Region', r => {
    expect(r.rows).toHaveLength(1);
  }],
  ['rows and values', 'ROWS: Region\nVALUES: Sum(Sales)', r => {
    expect(r.rows).toHaveLength(1);
    expect(r.values).toHaveLength(1);
  }],
  ['multiple rows', 'ROWS: Region, Product, Category', r => {
    expect(r.rows).toHaveLength(3);
  }],
  ['multiple values', 'ROWS: Region\nVALUES: Sum(Sales), Count(Quantity)', r => {
    expect(r.values).toHaveLength(2);
  }],
  ['columns and values', 'COLUMNS: Year\nVALUES: Sum(Sales)', r => {
    expect(r.columns).toHaveLength(1);
    expect(r.values).toHaveLength(1);
  }],
  ['full basic pivot', 'ROWS: Region\nCOLUMNS: Year\nVALUES: Sum(Sales)', r => {
    expect(r.rows).toHaveLength(1);
    expect(r.columns).toHaveLength(1);
    expect(r.values).toHaveLength(1);
  }],
  ['with filters', 'ROWS: Region\nVALUES: Sum(Sales)\nFILTERS: Category = ("A")', r => {
    expect(r.filters).toHaveLength(1);
  }],
  ['with sort', 'ROWS: Region\nVALUES: Sum(Sales)\nSORT: Region DESC', r => {
    // Sort is parsed but not compiled into a separate zone
    const { tokens } = lex('SORT: Region DESC');
    const { ast } = parse(tokens);
    expect(ast.sort).toHaveLength(1);
  }],
  ['with layout compact', 'ROWS: Region\nVALUES: Sum(Sales)\nLAYOUT: compact', r => {
    expect(r.layout.reportLayout).toBe('compact');
  }],
  ['with layout tabular', 'ROWS: Region\nVALUES: Sum(Sales)\nLAYOUT: tabular', r => {
    expect(r.layout.reportLayout).toBe('tabular');
  }],
  ['with layout outline', 'ROWS: Region\nVALUES: Sum(Sales)\nLAYOUT: outline', r => {
    expect(r.layout.reportLayout).toBe('outline');
  }],
  ['layout no-grand-totals', 'ROWS: Region\nVALUES: Sum(Sales)\nLAYOUT: no-grand-totals', r => {
    expect(r.layout.showRowGrandTotals).toBe(false);
    expect(r.layout.showColumnGrandTotals).toBe(false);
  }],
  ['layout values-on-rows', 'ROWS: Region\nVALUES: Sum(Sales)\nLAYOUT: values-on-rows', r => {
    expect(r.layout.valuesPosition).toBe('rows');
  }],
  ['layout auto-fit', 'ROWS: Region\nVALUES: Sum(Sales)\nLAYOUT: auto-fit', r => {
    expect(r.layout.autoFitColumnWidths).toBe(true);
  }],
  ['with alias', 'ROWS: Region\nVALUES: Sum(Sales) AS "Revenue"', r => {
    expect(r.values[0].customName).toBe('Revenue');
  }],
  ['with showValuesAs', 'ROWS: Region\nVALUES: Sum(Sales) [% of Row]', r => {
    expect(r.values[0].showValuesAs).toBe('percent_of_row');
  }],
  ['with calc field', 'ROWS: Region\nVALUES: Sum(Sales)\nCALC: Margin = [Sales] - [Cost]', r => {
    expect(r.calculatedFields).toHaveLength(1);
    expect(r.calculatedFields[0].name).toBe('Margin');
  }],
  ['with top N', 'ROWS: Region\nVALUES: Sum(Sales)\nTOP 5 BY Sum(Sales)', r => {
    // topN is on the AST, not directly on CompileResult
    // But it should compile without errors
    const compileErrors = r.errors.filter(e => e.severity === 'error');
    expect(compileErrors).toHaveLength(0);
  }],
  ['with comments', '# This is a comment\nROWS: Region\n# Another comment\nVALUES: Sum(Sales)', r => {
    expect(r.rows).toHaveLength(1);
    expect(r.values).toHaveLength(1);
    const compileErrors = r.errors.filter(e => e.severity === 'error');
    expect(compileErrors).toHaveLength(0);
  }],
];

describe('processDsl: representative DSL strings', () => {
  it.each(processDslTests)(
    '%s',
    (_label, dsl, assertFn) => {
      const result = processDsl(dsl, makeCtx());
      assertFn(result);
    },
  );
});

// ============================================================================
// Additional lexer tests: literals and special tokens
// ============================================================================

const literalTests: [string, string, TokenType, string][] = [
  ['integer', '42', TokenType.NumberLiteral, '42'],
  ['decimal', '3.14', TokenType.NumberLiteral, '3.14'],
  ['string literal', '"hello world"', TokenType.StringLiteral, 'hello world'],
  ['bracket identifier', '[Total Revenue]', TokenType.BracketIdentifier, 'Total Revenue'],
  ['identifier', 'RegionName', TokenType.Identifier, 'RegionName'],
  ['dotted identifier', 'Sales.Amount', TokenType.DottedIdentifier, 'Sales.Amount'],
  ['hyphenated identifier', 'no-subtotals', TokenType.Identifier, 'no-subtotals'],
  ['comment', '# this is a comment', TokenType.Comment, '# this is a comment'],
];

describe('Lexer: literal and special tokens', () => {
  it.each(literalTests)(
    'lexes %s correctly',
    (_label, input, expectedType, expectedValue) => {
      const { tokens, errors } = lex(input);
      const tok = tokens.find(t => t.type !== TokenType.EOF && t.type !== TokenType.Newline);
      expect(tok).toBeDefined();
      expect(tok!.type).toBe(expectedType);
      expect(tok!.value).toBe(expectedValue);
      expect(errors).toHaveLength(0);
    },
  );
});

// ============================================================================
// Lexer: error recovery
// ============================================================================

const lexerErrorTests: [string, string, number][] = [
  ['unterminated string', '"hello', 1],
  ['unterminated bracket', '[Total', 1],
  ['unknown character @', '@', 1],
  ['unknown character &', '&', 1],
  ['unknown character ~', '~', 1],
];

describe('Lexer: error recovery', () => {
  it.each(lexerErrorTests)(
    'reports error for %s',
    (_label, input, expectedErrorCount) => {
      const { errors } = lex(input);
      expect(errors).toHaveLength(expectedErrorCount);
    },
  );
});

// ============================================================================
// Parser: error recovery for malformed clauses
// ============================================================================

const parserErrorTests: [string, string][] = [
  ['missing colon after ROWS', 'ROWS Region'],
  ['missing colon after VALUES', 'VALUES Sum(Sales)'],
  ['unexpected token', 'ROWS: Region\n42'],
  ['missing paren in aggregation', 'VALUES: Sum Sales)'],
  ['missing closing paren', 'VALUES: Sum(Sales'],
];

describe('Parser: error recovery', () => {
  it.each(parserErrorTests)(
    'recovers from %s',
    (_label, input) => {
      const { tokens } = lex(input);
      const { errors } = parse(tokens);
      expect(errors.length).toBeGreaterThanOrEqual(1);
    },
  );
});

// ============================================================================
// Layout directives: exhaustive set
// ============================================================================

const layoutDirectiveTests = [...LAYOUT_DIRECTIVES].map(d => [d] as [string]);

describe('Layout directives: all recognized', () => {
  it.each(layoutDirectiveTests)(
    'directive "%s" parses without error',
    (directive) => {
      const dsl = `LAYOUT: ${directive}`;
      const { tokens } = lex(dsl);
      const { ast, errors } = parse(tokens);
      expect(errors).toHaveLength(0);
      expect(ast.layout).toHaveLength(1);
      expect(ast.layout[0].key).toBe(directive);
    },
  );
});

// ============================================================================
// SHOW_VALUES_AS_NAMES: all entries parse correctly
// ============================================================================

const showValuesAsEntries = [...SHOW_VALUES_AS_NAMES.entries()].map(
  ([label, internal]) => [label, internal] as [string, string],
);

describe('ShowValuesAs: all entries parse correctly', () => {
  it.each(showValuesAsEntries)(
    '"%s" maps to %s',
    (label, internal) => {
      const dsl = `VALUES: Sum(Sales) [${label}]`;
      const { tokens } = lex(dsl);
      const { ast, errors } = parse(tokens);
      expect(errors).toHaveLength(0);
      expect(ast.values).toHaveLength(1);
      expect(ast.values[0].showValuesAs).toBe(internal);
    },
  );
});

// ============================================================================
// AGGREGATION_NAMES: all entries parse as aggregation calls
// ============================================================================

const aggregationNameTests = [...AGGREGATION_NAMES].map(name => [name] as [string]);

describe('Aggregation names: all parse as aggregation calls', () => {
  it.each(aggregationNameTests)(
    '%s(Sales) parses correctly',
    (aggName) => {
      const dsl = `VALUES: ${aggName}(Sales)`;
      const { tokens } = lex(dsl);
      const { ast, errors } = parse(tokens);
      expect(errors).toHaveLength(0);
      expect(ast.values).toHaveLength(1);
      expect(ast.values[0].aggregation).toBe(aggName);
    },
  );
});
