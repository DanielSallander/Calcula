//! FILENAME: app/src/api/designQueryAssist/grammar.ts
// PURPOSE: A GBNF grammar, built per request from the candidate names, that
//          makes an invented column IMPOSSIBLE rather than unlikely.
// CONTEXT: A JSON schema constrains the ENVELOPE; a grammar constrains the
//          CONTENT. With this grammar a runtime that honours it (llama.cpp's
//          server) can only emit a query whose every dimension and measure is
//          one the model was shown, whose clauses are spelled the one way the
//          parser accepts, and whose layout words are from the closed list.
//          The reply is then the bare query, not JSON — the extractor accepts
//          both.
//
//          WHAT IT DOES NOT CONSTRAIN, deliberately: filter VALUES are free
//          strings (the members of a dimension are data, not vocabulary, and
//          the compiler checks nothing about them either), and an alias is
//          free text. CALC and SAVE are absent: a model is not taught them.
//
//          GBNF, in the subset llama.cpp documents: `name ::= ...`, quoted
//          terminals with backslash escapes, character classes, `|`, `?`, `*`,
//          `+` and parentheses. A test on the `_shared` side samples this
//          grammar hundreds of times and compiles every sample against the
//          fixture model, and matches every corpus reference against it — so
//          "the grammar and the parser agree" is a measurement, not a hope.

import type { DesignQueryCandidates } from "./types";
import { DSL_LAYOUT_DIRECTIVES, DSL_SHOW_VALUES_AS, DSL_TAUGHT_AGGREGATIONS } from "./vocabulary";

/** A GBNF terminal: double-quoted, backslash and quote escaped. */
export function gbnfTerminal(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function alternatives(names: readonly string[]): string {
  return names.map(gbnfTerminal).join(" | ");
}

/**
 * The grammar for one request, or null when the candidates cannot make a
 * valid query at all (no measure and no numeric column, or no dimension):
 * a grammar with an empty alternative is a runtime error, and a null tells
 * the caller to fall back to the schema.
 */
export function buildDesignQueryGrammar(c: DesignQueryCandidates): string | null {
  const hasMeasures = c.measures.length > 0;
  const hasNumeric = c.numericColumns.length > 0;
  if (!hasMeasures && !hasNumeric) return null;
  if (c.dimensions.length === 0 && c.timeGroupings.length === 0) return null;

  const dims = [...new Set([...c.dimensions, ...c.timeGroupings])];
  const rules: string[] = [];
  rules.push('root ::= clause ("\\n" clause)* "\\n"?');
  rules.push("clause ::= rows | columns | values | filters | sort | topn | layout");
  rules.push('rows ::= "ROWS: " dims');
  rules.push('columns ::= "COLUMNS: " dims');
  rules.push('values ::= "VALUES: " val (", " val)*');
  rules.push('filters ::= "FILTERS: " filter (", " filter)*');
  rules.push('sort ::= "SORT: " sortitem (", " sortitem)*');
  rules.push('topn ::= ("TOP " | "BOTTOM ") [1-9] [0-9]? [0-9]? " BY " valref');
  rules.push('layout ::= "LAYOUT: " directive (", " directive)*');
  rules.push('dims ::= dim (", " dim)*');
  rules.push(`dim ::= ${alternatives(dims)}`);
  rules.push("val ::= valref alias? sva?");

  const valrefs: string[] = [];
  if (hasMeasures) {
    rules.push(`measure ::= ${alternatives(c.measures.map((m) => `[${m}]`))}`);
    valrefs.push("measure");
  }
  if (hasNumeric) {
    rules.push(`numcol ::= ${alternatives(c.numericColumns)}`);
    rules.push(`agg ::= ${alternatives(DSL_TAUGHT_AGGREGATIONS)}`);
    valrefs.push('agg "(" numcol ")"');
  }
  rules.push(`valref ::= ${valrefs.join(" | ")}`);
  rules.push('alias ::= " AS \\"" [^"\\n]+ "\\""');
  rules.push(`sva ::= " [" (${alternatives(DSL_SHOW_VALUES_AS)}) "]"`);
  rules.push('filter ::= dim ((" = " | " NOT IN ") vals)?');
  rules.push('vals ::= "(" str (", " str)* ")"');
  rules.push('str ::= "\\"" [^"\\n]* "\\""');
  // SORT orders row and column LABELS; the DSL ranks by a measure's value only
  // through TOP/BOTTOM N BY [Measure]. A grammar that let `SORT: [Revenue]`
  // through would hand the compiler a query it refuses.
  rules.push('sortitem ::= dim (" ASC" | " DESC")?');
  rules.push(`directive ::= ${alternatives(DSL_LAYOUT_DIRECTIVES)}`);
  return rules.join("\n") + "\n";
}
