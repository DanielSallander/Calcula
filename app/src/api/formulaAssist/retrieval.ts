//! FILENAME: app/src/api/formulaAssist/retrieval.ts
// PURPOSE: Pick the worked examples most likely to help with THIS request, out
//          of the verified pattern library.
// CONTEXT: Many formula requests are near-duplicates of something the function
//          documentation already answers correctly. Showing a small model two or
//          three of those costs about 120 prompt tokens and asks it to imitate
//          rather than invent — which is the thing small models are good at.
//
//          BM25, not embeddings, and dependency-free on purpose. An embedding
//          index would mean a model download, a new wire and a startup cost, to
//          beat lexical matching on a corpus whose queries and documents share a
//          vocabulary (function names, header words). The upgrade path stays
//          open: `rankPatterns` is the seam, and a hybrid scorer would slot in
//          behind it. Measure BM25 first — that is what `--retrieval 0|3` in the
//          eval runner exists to settle.
//
//          The library is passed IN rather than imported. The generated artifact
//          is ~350 KB, and a static import here would drag it into every bundle
//          that touches the formula assistant whether or not retrieval is on.

import type { RetrievablePattern } from "./types";

/** Standard BM25 knobs. */
const K1 = 1.2;
const B = 0.75;

/** Weight applied to a term found in the pattern's function name. */
const FIELD_WEIGHTS = { fn: 3, intent: 1, formula: 1 } as const;

/** Boost for a query term that IS a function name in the library. */
const EXACT_FUNCTION_BOOST = 5;

/** At most this many patterns per function, so one doc cannot fill the slate. */
const MAX_PER_FUNCTION = 2;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "each", "every",
  "when", "where", "which", "what", "how", "all", "any", "are", "was", "were",
  "put", "get", "set", "use", "using", "value", "values", "cell", "cells",
  "column", "columns", "row", "rows", "table", "sheet", "must", "should",
  "och", "för", "med", "som", "att", "den", "det", "till", "från", "varje",
]);

/** `A1`, `C10`, `$B$2` and friends: addresses, not words. */
const CELL_REFERENCE = /^[a-z]{1,3}\d{1,7}$/;

/** Lowercase word tokens, stopwords removed, dotted names also split. */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-zåäöéü0-9.]+/g) ?? [];
  const out: string[] = [];
  for (const token of raw) {
    const t = token.replace(/^\.+|\.+$/g, "");
    if (!t) continue;
    // A cell address says where, never what. Indexing them lets a request that
    // mentions A1:C10 match every example whose fixture happens to start at A1.
    if (CELL_REFERENCE.test(t)) continue;
    if (!STOPWORDS.has(t) && t.length > 1) out.push(t);
    // A dotted function name is also indexed by its parts, so "norm dist"
    // reaches NORM.DIST.
    if (t.includes(".")) {
      for (const part of t.split(".")) {
        if (part.length > 1 && !STOPWORDS.has(part)) out.push(part);
      }
    }
  }
  return out;
}

/**
 * What people SAY, mapped to what the function is CALLED.
 *
 * The gap this closes is the whole difficulty of lexical retrieval here. A
 * request is a task description ("add up the Amount where the Region is North");
 * a pattern's text is a dictionary definition ("sums values in a range that
 * satisfy multiple conditions"). They share almost no words, so BM25 alone
 * ranked a present-value example above SUMIFS for that request.
 *
 * These are general spreadsheet vocabulary rather than anything fitted to a
 * corpus, and they are one-directional hints: they ADD candidate function names
 * to the query, and BM25 still decides among them. A wrong hint costs a slot,
 * never a wrong answer, because the verifier downstream does not care where a
 * formula came from.
 */
const TASK_SYNONYMS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\b(add up|adds up|sum|sums|total|totals|summera)\b/i, ["sum", "sumif", "sumifs", "sumproduct"]],
  [/\b(count|counts|how many|number of|räkna)\b/i, ["count", "counta", "countif", "countifs"]],
  [/\b(average|averages|mean|medel)\b/i, ["average", "averageif", "averageifs"]],
  [/\b(look ?up|looks up|corresponding|matching row|slå upp)\b/i, ["xlookup", "vlookup", "index", "match"]],
  [/\b(rank|ranks|ranking|nth largest|third largest|top)\b/i, ["rank", "large", "small", "sortby"]],
  [/\b(largest|highest|maximum|max|störst)\b/i, ["max", "maxifs", "large"]],
  [/\b(smallest|lowest|minimum|min|minst)\b/i, ["min", "minifs", "small"]],
  [/\b(percent|percentage|share of|proportion|andel)\b/i, ["sum", "round"]],
  [/\b(round|rounded|rounding|avrunda)\b/i, ["round", "mround", "roundup", "rounddown"]],
  [/\b(unique|distinct|duplicates|unika)\b/i, ["unique", "countif"]],
  [/\b(sort|sorted|sortera)\b/i, ["sort", "sortby"]],
  [/\b(filter|filters|only the rows|filtrera)\b/i, ["filter"]],
  [/\b(split|splits|separate|dela)\b/i, ["textsplit", "textbefore", "textafter"]],
  [/\b(join|joins|combine|concatenate|slå ihop)\b/i, ["textjoin", "concat"]],
  [/\b(days between|months between|working days|weekday|datum)\b/i, ["datedif", "networkdays", "eomonth", "edate"]],
  [/\b(if |when the|otherwise|grade|tier|category|om )\b/i, ["if", "ifs", "switch"]],
  [/\b(error|errors|#n\/a|fallback|guard)\b/i, ["iferror", "ifna"]],
  [/\b(running total|cumulative|löpande)\b/i, ["sum", "scan"]],
];

/** Function-name hints implied by the way the request is phrased. */
export function synonymTerms(rawIntent: string): string[] {
  const out = new Set<string>();
  for (const [re, names] of TASK_SYNONYMS) {
    if (re.test(rawIntent)) for (const n of names) out.add(n);
  }
  return [...out];
}

/** The function names a formula calls: an identifier immediately before `(`. */
export function functionNamesIn(formula: string): string[] {
  return (formula.match(/[A-Za-z][A-Za-z0-9._]*(?=\s*\()/g) ?? []).map((s) => s.toUpperCase());
}

interface IndexedDoc {
  readonly pattern: RetrievablePattern;
  /** term -> weighted frequency */
  readonly terms: Map<string, number>;
  readonly length: number;
}

export interface PatternIndex {
  readonly docs: readonly IndexedDoc[];
  readonly df: ReadonlyMap<string, number>;
  readonly avgLength: number;
  readonly functionNames: ReadonlySet<string>;
}

/** Build a searchable index over a pattern library. Pure and deterministic. */
export function buildIndex(patterns: readonly RetrievablePattern[]): PatternIndex {
  const docs: IndexedDoc[] = [];
  const df = new Map<string, number>();
  const functionNames = new Set<string>();

  for (const pattern of patterns) {
    functionNames.add(pattern.fn.toLowerCase());
    const terms = new Map<string, number>();
    const add = (text: string, weight: number): void => {
      for (const t of tokenize(text)) terms.set(t, (terms.get(t) ?? 0) + weight);
    };
    add(pattern.fn, FIELD_WEIGHTS.fn);
    add(pattern.intent, FIELD_WEIGHTS.intent);
    // THE FUNCTIONS THE FORMULA CALLS, NOT THE FORMULA'S TEXT. A doc example's
    // string literals are its fixture's vocabulary — "Sales", "North",
    // "Geo[Region]", "Widget" — and they are rare, so IDF makes them dominate.
    // Indexed whole, a request about a sales table by region retrieved
    // CUBEMEMBERPROPERTY ahead of SUMIFS on the strength of two words inside a
    // quoted argument. What a formula is ABOUT is which functions it calls.
    add(functionNamesIn(pattern.formula).join(" "), FIELD_WEIGHTS.formula);

    let length = 0;
    for (const n of terms.values()) length += n;
    for (const term of terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    docs.push({ pattern, terms, length });
  }

  const avgLength = docs.length ? docs.reduce((a, d) => a + d.length, 0) / docs.length : 1;
  return { docs, df, avgLength, functionNames };
}

export interface RetrievalQuery {
  /** What the user asked for. */
  readonly intent: string;
  /** Header words from the region, which say what the data is about. */
  readonly headers?: readonly string[];
}

export interface RankedPattern {
  readonly pattern: RetrievablePattern;
  readonly score: number;
}

/**
 * Did the request NAME this function, as opposed to happening to use a word that
 * is also a function name?
 *
 * Requires the name in upper case, or immediately followed by `(`. Both are how
 * a person writes a function they mean; neither is how they write a verb.
 */
export function namesFunction(rawIntent: string, fn: string): boolean {
  const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A following `(` is unambiguous at any length: nobody writes "SUM(" meaning
  // the English verb.
  if (new RegExp(`\\b${escaped}\\s*\\(`, "i").test(rawIntent)) return true;
  // Otherwise the bare upper-case name counts only when it is too long to be a
  // capitalised English word. AND, OR, NOT and IF are routinely written in caps
  // for emphasis — "where Region is North AND the Rep is Alice" is not a request
  // for the AND function — and every one of them is three characters or fewer.
  if (fn.length <= 3) return false;
  return new RegExp(`\\b${escaped}\\b`).test(rawIntent);
}

/**
 * The `k` most relevant patterns, best first.
 *
 * Deterministic: ties break on id, so the same query always produces the same
 * prompt and a measurement can be repeated.
 */
export function rankPatterns(
  index: PatternIndex,
  query: RetrievalQuery,
  k = 3,
): RankedPattern[] {
  if (index.docs.length === 0) return [];
  const terms = tokenize(query.intent);
  // Header words describe the data rather than the task, so they count for
  // less; without them a request about "Revenue" cannot find the revenue-shaped
  // examples at all.
  const headerTerms = tokenize((query.headers ?? []).join(" "));
  const synonyms = synonymTerms(query.intent);

  const N = index.docs.length;
  const scored: RankedPattern[] = [];
  for (const doc of index.docs) {
    let score = 0;
    const accumulate = (list: string[], weight: number): void => {
      for (const term of list) {
        const f = doc.terms.get(term);
        if (!f) continue;
        const n = index.df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const norm = f * (K1 + 1);
        const denom = f + K1 * (1 - B + (B * doc.length) / index.avgLength);
        score += weight * idf * (norm / denom);
      }
    };
    accumulate(terms, 1);
    accumulate(headerTerms, 0.5);
    // Weighted above the literal words because a task verb is a much stronger
    // signal about which function is wanted than any noun in the sentence.
    accumulate(synonyms, 1.5);

    // A function the user NAMED outranks anything lexical matching can infer —
    // but the test is CASE-SENSITIVE against the raw request, and that is not a
    // detail. Dozens of Calcula's functions are also ordinary English words:
    // MATCH, SUM, IF, TEXT, VALUE, LEFT, FIND, CHOOSE, INDEX, ROW, COUNT,
    // SEARCH, TRIM, EXACT, LARGE, SMALL, TYPE. Matching them case-insensitively
    // made "rows that MATCH only one of the two conditions" retrieve the MATCH
    // function, and a SUMIFS request came back with MATCH, PV and
    // CUBEMEMBERPROPERTY as its worked examples. A user who means the function
    // writes its name the way the product does.
    if (namesFunction(query.intent, doc.pattern.fn)) score += EXACT_FUNCTION_BOOST;
    if (score > 0) scored.push({ pattern: doc.pattern, score });
  }

  scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.pattern.id.localeCompare(b.pattern.id),
  );

  const perFunction = new Map<string, number>();
  const out: RankedPattern[] = [];
  for (const entry of scored) {
    const fn = entry.pattern.fn;
    const used = perFunction.get(fn) ?? 0;
    if (used >= MAX_PER_FUNCTION) continue;
    perFunction.set(fn, used + 1);
    out.push(entry);
    if (out.length >= k) break;
  }
  return out;
}
