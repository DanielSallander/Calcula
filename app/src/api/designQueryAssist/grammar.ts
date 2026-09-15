//! FILENAME: app/src/api/designQueryAssist/grammar.ts
// PURPOSE: GBNF grammars built per request from the candidate names, that make
//          an invented column IMPOSSIBLE rather than unlikely — one for a whole
//          query (the drafting assistant) and one for the single clause that
//          may legally come next (the next-edit row's model chip).
// CONTEXT: A JSON schema constrains the ENVELOPE; a grammar constrains the
//          CONTENT. With this grammar a runtime that honours it (llama.cpp's
//          server, and the copy of it Calcula bundles) can only emit a query
//          whose every dimension and measure is one the model was shown, whose
//          clauses are spelled the one way the parser accepts, and whose layout
//          words are from the closed list. The reply is then the bare query,
//          not JSON — the extractor accepts both.
//
//          WHAT IT DOES NOT CONSTRAIN, deliberately: filter VALUES are free
//          strings (the members of a dimension are data, not vocabulary, and
//          the compiler checks nothing about them either), and an alias is
//          free text. CALC and SAVE are absent: a model is not taught them.
//
//          WHAT IT CONSTRAINS BEYOND THE NAMES: the clause ORDER. ROWS,
//          COLUMNS, VALUES, FILTERS, SORT, TOP/BOTTOM, LAYOUT, each at most
//          once, VALUES and one of ROWS/COLUMNS required — the serializer's
//          order and every corpus reference's. The parser accepts any order
//          from a person; the model gets only the one that carries meaning.
//
//          ONE SET OF CLAUSE BODIES, TWO GRAMMARS. `clauseRules` below is the
//          single definition of what a ROWS, VALUES, FILTERS, SORT, TOP or
//          LAYOUT clause may contain; the whole-query grammar and the
//          next-clause grammar differ only in their `root`. A second copy of
//          those bodies is precisely the drift this repo keeps finding, and
//          `designQueryGrammar.test.ts` samples BOTH and compiles the samples.
//
//          GBNF, in the subset llama.cpp documents: `name ::= ...`, quoted
//          terminals with backslash escapes, character classes, `|`, `?`, `*`,
//          `+` and parentheses.

import type { DesignQueryCandidates } from "./types";
import { DSL_LAYOUT_DIRECTIVES, DSL_SHOW_VALUES_AS, DSL_TAUGHT_AGGREGATIONS } from "./vocabulary";

/** A GBNF terminal: double-quoted, backslash and quote escaped. */
export function gbnfTerminal(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function alternatives(names: readonly string[]): string {
  return names.map(gbnfTerminal).join(" | ");
}

/** The clause names, in the canonical order both grammars impose. */
export const GRAMMAR_CLAUSES = ["ROWS", "COLUMNS", "VALUES", "FILTERS", "SORT", "TOP", "LAYOUT"] as const;
export type GrammarClause = (typeof GRAMMAR_CLAUSES)[number];

/** The GBNF rule name for each clause. `TOP` covers BOTTOM too — one slot. */
const RULE_OF: Record<GrammarClause, string> = {
  ROWS: "rows",
  COLUMNS: "columns",
  VALUES: "values",
  FILTERS: "filters",
  SORT: "sort",
  TOP: "topn",
  LAYOUT: "layout",
};

/** Whether the candidates can express a query at all. */
function usable(c: DesignQueryCandidates): boolean {
  if (c.measures.length === 0 && c.numericColumns.length === 0) return false;
  return c.dimensions.length > 0 || c.timeGroupings.length > 0;
}

/**
 * How many EXTRA items a clause may list after its first.
 *
 * BOUNDED, because an unbounded `*` is an invitation a small model accepts.
 * Measured on the built-in 1.5B: asked for the clause after `ROWS:
 * Product.Category`, it answered `VALUES: [Revenue], [MarginPct], [Margin],
 * [Cost], [Customers], [Quantity]` — every measure it had been shown, in the
 * order it had been shown them — and did the same for every prefix. It is the
 * formula grammar's lesson again (bounding every repetition there cut
 * truncation from 84 to 0 and ran 2.8x faster): a repetition the grammar does
 * not close is one the model fills.
 *
 * Three extra, so four in all. The widest clause in all 52 correct queries of
 * `tests/eval/design-queries.json` lists TWO, so this forbids nothing the
 * corpus calls right, and `designQueryGrammar.test.ts` checks every reference
 * against the grammar built for it rather than trusting that sentence. One
 * extra was measured too: it cut the next-clause median from 674 ms to 554 ms
 * and moved the exact rate not at all (0/80 either way), so the ceiling is set
 * for the DRAFTING grammar's comfort — a request may reasonably ask for three
 * measures — rather than tuned for a chip the measurement did not save.
 */
const MAX_EXTRA_CLAUSE_ITEMS = 3;

/**
 * How many EXTRA members a filter's value list may carry after its first.
 *
 * MUCH LOOSER than the clause bound, and for a different reason. Cutting a
 * clause short costs a field the person can add back; cutting a FILTER short
 * changes what the query MEANS, and silently — `Country = ("USA", "Canada",
 * "Mexico", "Brazil")` where six were wanted is not a shorter answer, it is a
 * wrong one, and nothing downstream can tell. The members of a dimension are
 * data rather than vocabulary, so this exists only to stop a runaway, not to
 * shape an answer; nineteen extra is far past any list a person reads off a
 * slicer and still far short of a loop.
 */
const MAX_EXTRA_FILTER_VALUES = 19;

/**
 * Every rule except `root`: the clause bodies, the names, and the value forms.
 * Shared by both grammars, so neither can teach a shape the other refuses.
 */
function clauseRules(c: DesignQueryCandidates, allow?: { showAs?: boolean }): string[] {
  const hasMeasures = c.measures.length > 0;
  const hasNumeric = c.numericColumns.length > 0;
  const dims = [...new Set([...c.dimensions, ...c.timeGroupings])];
  const more = (rule: string) => `(", " ${rule}){0,${MAX_EXTRA_CLAUSE_ITEMS}}`;
  const rules: string[] = [];
  rules.push('nl ::= "\\n"');
  rules.push('rows ::= "ROWS: " dims');
  rules.push('columns ::= "COLUMNS: " dims');
  rules.push(`values ::= "VALUES: " val ${more("val")}`);
  rules.push(`filters ::= "FILTERS: " filter ${more("filter")}`);
  rules.push(`sort ::= "SORT: " sortitem ${more("sortitem")}`);
  rules.push('topn ::= ("TOP " | "BOTTOM ") [1-9] [0-9]? [0-9]? " BY " valref');
  rules.push(`layout ::= "LAYOUT: " directive ${more("directive")}`);
  rules.push(`dims ::= dim ${more("dim")}`);
  rules.push(`dim ::= ${alternatives(dims)}`);
  // Dropping `sva?` removes the ONLY route to a show-values-as suffix, so an
  // unasked "[% of grand total]" becomes unwriteable rather than discouraged.
  rules.push(allow?.showAs === false ? "val ::= valref alias?" : "val ::= valref alias? sva?");

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
  if (allow?.showAs !== false) rules.push(`sva ::= " [" (${alternatives(DSL_SHOW_VALUES_AS)}) "]"`);
  rules.push('filter ::= dim ((" = " | " NOT IN ") vals)?');
  rules.push(`vals ::= "(" str (", " str){0,${MAX_EXTRA_FILTER_VALUES}} ")"`);
  rules.push('str ::= "\\"" [^"\\n]* "\\""');
  // SORT orders row and column LABELS; the DSL ranks by a measure's value only
  // through TOP/BOTTOM N BY [Measure]. A grammar that let `SORT: [Revenue]`
  // through would hand the compiler a query it refuses.
  rules.push('sortitem ::= dim (" ASC" | " DESC")?');
  rules.push(`directive ::= ${alternatives(DSL_LAYOUT_DIRECTIVES)}`);
  return rules;
}

/**
 * The grammar for one request, or null when the candidates cannot make a
 * valid query at all (no measure and no numeric column, or no dimension):
 * a grammar with an empty alternative is a runtime error, and a null tells
 * the caller to fall back to the schema.
 */
/**
 * Clauses a caller may forbid the grammar from emitting at all.
 *
 * MEASURED 2026-09-15, AND THE ANSWER IS NO. Keep this seam, do not build a
 * clause detector on it, and read this note before proposing one again.
 *
 * The premise was good: 20 of 23 remaining design-query failures were
 * over-production — an unasked TOP, an unasked share label, an extra name, a
 * filtered column repeated — so the model looked like it knew Calcula and
 * lacked restraint. A production that does not exist cannot be emitted, which
 * is a stronger guarantee than an instruction (the prompt already states all
 * four restraint rules in plain English and the 1.5B ignores them; more prompt
 * engineering measured p = 0.375).
 *
 * So the ceiling was measured with a PERFECT gate — `--clause-gate oracle` in
 * `run-design-query-eval.mjs` reads each task's own tags, i.e. the answer, to
 * decide what the model may write. Over the 40-task corpus on the built-in
 * 1.5B: **17/40 -> 18/40, one task fixed, none broken, McNemar p = 1.0.**
 * `classify-design-failures.mjs` says why the prior was wrong: only 4 failing
 * tasks had a gateable defect as their SOLE difference from the reference, and
 * suppressing the production on those mostly produced a DIFFERENT wrong answer
 * rather than the right one.
 *
 * The lesson generalises past this feature: **constraining what a model may not
 * say does not tell it what to say.** A grammar buys structural guarantees —
 * everything compiles, no invented name, half the latency — and buys no
 * judgement at all.
 *
 * NAMES ARE DELIBERATELY NOT GATEABLE EITHER. Narrowing the NAME set to what an
 * intent mentions was measured and refuted separately: 23 of the 99 names a
 * correct answer needs would become unwriteable, including one in every Swedish
 * task ("omsättning" never reaches Revenue). Restrict the CLAUSES, never the
 * names — and now, on the evidence above, mostly do not restrict at all.
 */
export interface AllowedClauses {
  /** `TOP n BY [m]` / `BOTTOM n BY [m]`. */
  topN?: boolean;
  /** The `[% of grand total]` style suffix on a value. */
  showAs?: boolean;
  layout?: boolean;
}

export function buildDesignQueryGrammar(
  c: DesignQueryCandidates,
  allowed?: AllowedClauses,
): string | null {
  if (!usable(c)) return null;
  const topOk = allowed?.topN !== false;
  const showAsOk = allowed?.showAs !== false;
  const layoutOk = allowed?.layout !== false;
  // THE CLAUSES COME IN THE CANONICAL ORDER, EACH AT MOST ONCE. The first
  // version let any clause follow any other, and the built-in runtime's
  // 1.5B used the freedom: a second VALUES after COLUMNS, LAYOUT first, a
  // trailing TOP nobody asked for.
  const rules = [
    'root ::= head "\\n" values (nl filters)? (nl sort)?' +
      (topOk ? " (nl topn)?" : "") +
      (layoutOk ? " (nl layout)?" : "") +
      ' "\\n"?',
    'head ::= rows ("\\n" columns)? | columns',
    ...clauseRules(c, { showAs: showAsOk }),
  ];
  // A production nothing references is legal GBNF but noise; dropping the rule
  // as well as the reference keeps the grammar readable when it is dumped for
  // debugging, which is how the "unasked LAYOUT on every reply" defect was found.
  return rules
    .filter((r) => (topOk || !r.startsWith("topn ::=")) && (layoutOk || !r.startsWith("layout ::=")))
    .join("\n") + "\n";
}

/** What the query already has, for deciding which clause may come next. */
export interface PresentClauses {
  rows: boolean;
  columns: boolean;
  values: boolean;
  filters: boolean;
  sort: boolean;
  topN: boolean;
  layout: boolean;
}

/**
 * Which clauses may still be added to a query that already has `present`,
 * listed in the canonical order.
 *
 * Simply the ones it does not have. WHERE a new clause goes is not the model's
 * problem — `applyEditOp` inserts it in canonical position — so constraining
 * the model to clauses that come after the last one present would only forbid
 * useful answers: a query that already carries a LAYOUT can perfectly well
 * still want a FILTERS, and each clause may appear once, which is the only
 * constraint that actually matters.
 */
export function allowedNextClauses(present: PresentClauses): GrammarClause[] {
  const have: Record<GrammarClause, boolean> = {
    ROWS: present.rows,
    COLUMNS: present.columns,
    VALUES: present.values,
    FILTERS: present.filters,
    SORT: present.sort,
    TOP: present.topN,
    LAYOUT: present.layout,
  };
  return GRAMMAR_CLAUSES.filter((clause) => !have[clause]);
}

/**
 * The grammar of ONE clause that may legally follow the query so far, or null
 * when nothing may (the query is complete) or the candidates cannot express a
 * query at all.
 *
 * Used by the next-edit row's model chip: the rules decide what they can, and
 * the model is asked only for the next clause, constrained to the names it was
 * shown and to the clauses that may actually come next. A completion that
 * cannot name a column and cannot put a clause in the wrong place leaves the
 * model exactly one job — choosing which of the offered things the person meant.
 */
export function buildNextClauseGrammar(c: DesignQueryCandidates, present: PresentClauses): string | null {
  if (!usable(c)) return null;
  const allowed = allowedNextClauses(present);
  if (allowed.length === 0) return null;
  // EVERY legal next clause, not a favourite. A first version narrowed this to
  // VALUES whenever VALUES was missing, on the reasoning that a query without a
  // measure means nothing — and five corpus references write `COLUMNS:` as
  // their second line, so the grammar would have forbidden the model from ever
  // writing the clause the corpus itself calls right. Supplying a missing
  // VALUES is the Tier-0 rule's job anyway, at the top priority on the row.
  //
  // THE WHOLE CLAUSE IS OPTIONAL, so the empty reply is legal. The prompt ends
  // "If the query is already complete, reply with nothing at all", and a root
  // that demanded a clause made that sentence a lie the model could not obey:
  // on a finished query the sampler's only legal tokens spelled a clause, so
  // the model always proposed one and only the compile veto stood between the
  // person and a chip nobody wanted — and a syntactically fine LAYOUT adds no
  // error and no warning, so the veto passes it. An optional root lets the
  // runtime emit end-of-sequence at the first token, which is what "nothing"
  // means to a grammar, and makes the no-clause rate a number we can measure
  // rather than a zero we built in.
  const root = `root ::= nextclause?`;
  const nextclause = `nextclause ::= (${allowed.map((clause) => RULE_OF[clause]).join(" | ")}) "\\n"?`;
  return [root, nextclause, ...clauseRules(c)].join("\n") + "\n";
}
