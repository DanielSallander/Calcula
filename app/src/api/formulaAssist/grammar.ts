//! FILENAME: app/src/api/formulaAssist/grammar.ts
// PURPOSE: A GBNF grammar for the formula proposal, for a runtime that
//          honours one: the same JSON envelope the schema asks for, with the
//          formula inside it constrained to formula SYNTAX — so a reply cannot
//          fail to parse, cannot use a locale separator, and cannot leave a
//          parenthesis open.
// CONTEXT: Measured on the eval corpus before this existed (formula-assist.md
//          §7): 11 of 60 formulas from a 1.5B coder model failed to PARSE, and
//          36 of 60 from a 1B. A schema constrains the envelope only; the
//          `formula` string inside it is free text. This grammar is the lever
//          the M1 write-up named and could not pull until a runtime that
//          honours grammars shipped (Step 3, 2026-09-10).
//
//          WHAT IT CONSTRAINS: the shape of the JSON reply, and the formula's
//          syntax — numbers, text literals with doubled quotes, error
//          literals, array constants, calls with omitted arguments (a call is
//          a suffix, so a LAMBDA can be called in place), A1 and whole-row or
//          whole-column ranges, sheet-qualified and structured references
//          (with or without the table name), defined names, the operators,
//          `%` and `#` postfixes, `@` implicit intersection. Function names
//          are ANY identifier: the catalogue has 526 entries, naming them
//          would cost more tokens than the rest of the prompt, and the
//          verifier already refuses an invented one. The grammar's job is
//          syntax; the engine's job is meaning.
//
//          WHAT IT DOES NOT CONSTRAIN, deliberately: operator precedence (a
//          syntactic grammar has no reason to), whether a name exists, whether
//          a range is sensible. Those are the verifier's, as they were.
//
//          THE JSON CONTEXT IS THE TRAP. Every quote the formula needs is
//          `\"` inside the JSON string, and every backslash `\\`. The rules
//          below spell those escapes in GBNF, and the test in the
//          FormulaAssist extension matches every corpus reference and every
//          pattern-library formula (as `JSON.stringify` renders them) against
//          this grammar, so the escaping is proved rather than believed.
//
//          GBNF as llama.cpp documents it, plus the `{m,n}` bounds it accepts.
//          Sizes match the schema's: an explanation of at most 240 characters,
//          at most three assumptions.

/** The explanation bound, matching `schema.ts`. Measured: unbounded fields loop. */
const MAX_EXPLANATION_CHARS = 240;
const MAX_ASSUMPTIONS = 3;

/**
 * The rules for a formula's syntax INSIDE a JSON string: `eq` is an escaped
 * quote, `tchar` a text-literal character as JSON renders it. Shared by the
 * envelope grammars below; exported so a bare-formula grammar can reuse them.
 */
/**
 * EVERY REPETITION IS BOUNDED. The first version used `*` and `+`, and the
 * built-in runtime's 1.5B found the holes: twelve of ninety-seven replies ran
 * to the 600-token limit, one of them a quoted sheet name that swallowed
 * `|)` and never closed. A grammar that permits an unbounded run of
 * whitespace, name characters or text characters lets a small model at
 * temperature 0 loop inside the law; llama.cpp's own JSON grammar bounds its
 * whitespace to twenty characters for the same reason. The bounds below are
 * generous for any formula a person writes and fatal for a loop.
 */
export const FORMULA_EXPRESSION_RULES: readonly string[] = [
  // An escaped quote as it appears inside the JSON string: backslash, quote.
  'eq ::= "\\\\\\""',
  'ws ::= [ ]{0,2}',
  'expr ::= ws operand (ws binop ws operand){0,40} ws',
  // A call is a SUFFIX on any operand, not a rule of its own: `SUM(A1)` is the
  // name SUM called, and `LAMBDA(a,b,a+b)(1,2)` is a call called again.
  'operand ::= prefix{0,2} atom suffix{0,3}',
  'prefix ::= "-" | "+" | "@"',
  'suffix ::= "(" ws args ws ")" | "%" | "#"',
  'atom ::= number | text | errlit | array | ref | "(" expr ")"',
  'number ::= [0-9]{1,20} ("." [0-9]{0,20})? exponent? | "." [0-9]{1,20} exponent?',
  'exponent ::= [eE] [-+]? [0-9]{1,4}',
  // A text literal: "..." with a doubled quote for an embedded one, all as
  // JSON renders it. A raw quote or backslash cannot appear in a JSON string.
  'text ::= eq tchar{0,120} eq',
  'tchar ::= [^"\\\\\\x00-\\x1F] | eq eq | "\\\\\\\\"',
  'errlit ::= "#N/A" | "#VALUE!" | "#REF!" | "#DIV/0!" | "#NAME?" | "#NUM!" | "#NULL!" | "#SPILL!" | "#CALC!"',
  'array ::= "{" ws arow (ws ";" ws arow){0,50} ws "}"',
  'arow ::= aconst (ws "," ws aconst){0,50}',
  'aconst ::= "-"? number | text | "TRUE" | "FALSE" | errlit',
  // Arguments separated by commas; an argument may be omitted (`IF(A1,,B1)`).
  'args ::= expr? (ws "," ws expr?){0,30}',
  // `[@Amount]` is a structured reference with no table name: inside a table.
  'ref ::= (sheet "!")? (cell (":" cell)? | colrange | rowrange | structured | bracketed | name)',
  // A quoted sheet name: Excel forbids : \ / ? * [ ] in one and caps it at 31
  // characters; the grammar also keeps out the punctuation a call uses, so a
  // model that reaches for a single quote where a text literal belongs cannot
  // swallow the rest of the formula into a "sheet name".
  "sheet ::= \"'\" [A-Za-z0-9 _.&#+\\-\\u00C0-\\u024F]{1,31} \"'\" | [A-Za-z_] [A-Za-z0-9_.]{0,30}",
  'cell ::= "$"? [A-Za-z]{1,3} "$"? [1-9] [0-9]{0,6}',
  'colrange ::= "$"? [A-Za-z]{1,3} ":" "$"? [A-Za-z]{1,3}',
  'rowrange ::= "$"? [1-9] [0-9]{0,6} ":" "$"? [1-9] [0-9]{0,6}',
  // Table1[Amount], Table1[[#Headers],[Amount]], Table1[@Amount].
  'structured ::= name bracketed',
  'bracketed ::= "[" sitem{0,60} "]"',
  'sitem ::= [^\\[\\]"\\\\\\x00-\\x1F] | "[" [^\\[\\]"\\\\\\x00-\\x1F]{0,40} "]"',
  'name ::= [A-Za-z_] [A-Za-z0-9_.]{0,40}',
  // `:` is the reference operator, so `A1:INDEX(B:B,3)` is a range.
  'binop ::= "+" | "-" | "*" | "/" | "^" | "&" | "<>" | "<=" | ">=" | "=" | "<" | ">" | ":"',
];

/** JSON string characters, as JSON allows them: no raw quote, backslash or control. */
const JSON_STRING_RULES: readonly string[] = [
  'q ::= "\\""',
  'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F]{4}',
  `jtext ::= q jchar{0,${MAX_EXPLANATION_CHARS}} q`,
  // Bounded like llama.cpp's own JSON grammar: unbounded whitespace is a loop.
  'jws ::= [ \\n\\t]{0,4}',
  'bool ::= "true" | "false"',
];

export interface FormulaGrammarOptions {
  /** Drop the `assumptions` list, the way `FORMULA_PROPOSAL_SCHEMA_LEAN` does. */
  lean?: boolean;
}

/**
 * The grammar for one proposal: the JSON envelope `extractProposal` reads,
 * with the formula string constrained to formula syntax.
 */
export function buildFormulaGrammar(opts: FormulaGrammarOptions = {}): string {
  const assumptions = opts.lean
    ? ""
    : ` jws "," jws q "assumptions" q jws ":" jws "[" jws (jtext (jws "," jws jtext){0,${MAX_ASSUMPTIONS - 1}})? jws "]"`;
  const root =
    'root ::= "{" jws q "formula" q jws ":" jws q "=" expr q' +
    ' jws "," jws q "explanation" q jws ":" jws jtext' +
    assumptions +
    ' jws "," jws q "fillDown" q jws ":" jws bool jws "}"';
  return [root, ...JSON_STRING_RULES, ...FORMULA_EXPRESSION_RULES].join("\n") + "\n";
}
