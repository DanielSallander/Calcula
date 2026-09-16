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
  // MEASURED 2026-09-16, over 174 corpus tasks: hit@3 was 18%, and the
  // breakdown showed why. Pattern intents are terse dictionary definitions
  // that rarely contain "is", "not", "it", "an", "be", "can" — so those words
  // are RARE in the index, IDF makes them worth 3-5 points EACH, and a request
  // that uses them three times hands 25+ points to whichever pattern happens
  // to contain them. The T() function won a lookup request on exactly that
  // (`is`x3 `not`x3 `it` `an` = 26 of its 31 points) while XLOOKUP sat at #47.
  // Every word below is grammar, not task; none is a function name a synonym
  // hint needs to reach. `if` is deliberately NOT here — it is a synonym target.
  "is", "not", "it", "an", "be", "can", "in", "of", "as", "by", "to", "on", "at",
  "or", "so", "than", "then", "does", "do", "did", "has", "have", "had", "its",
  "their", "there", "these", "those", "they", "them", "only", "also", "just",
  "still", "same", "other", "no", "yes", "up", "down", "out", "will", "would",
  "itself", "you", "your", "we", "our", "one", "two", "three",
  // FUNCTION NAMES THAT ARE ORDINARY ENGLISH WORDS. "rows that match only one
  // condition" is not a request for MATCH, and "the product code" is not one
  // for CODE — yet as tokens they reach those functions' names at weight 3 and
  // pull them into the slate (`CODE, TYPE, CHAR` was served for a padding
  // request; MATCH for the two-condition sum). `and`, `not` and `or` are
  // already here for the same reason. Stopping the token does not orphan the
  // function: the synonym groups pay these functions directly by name, and a
  // user who MEANS the function writes `MATCH(` or `MATCH`, which is
  // `namesFunction`'s job and unaffected by tokenisation.
  "match", "find", "search", "second", "left", "right", "type", "choose",
  "exact", "sign", "code", "char", "fixed", "text",
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
  // ORDER WITHIN A GROUP IS A RANKING, most likely first — `rankPatterns` decays
  // the boost by position. Measured 2026-09-16: with four names at equal weight
  // the "count" group alone took nine of twenty-five failing slates outright
  // (COUNT, COUNTA, COUNTIF filling all three slots while COUNTIFS, COUNTBLANK,
  // DATEDIF and WEEKDAY — what those requests needed — never appeared). The
  // conditional variant leads its group because a request that bothers to
  // describe a condition is asking for it; the plain function still appears.
  [/\b(add up|adds up|sum|sums|total|totals|summera)\b/i, ["sumifs", "sum", "sumif", "sumproduct"]],
  [/\b(count|counts|how many|number of|räkna)\b/i, ["countifs", "countif", "count", "counta"]],
  [/\b(average|averages|mean|medel)\b/i, ["averageifs", "average", "averageif"]],
  [/\b(look ?up|looks up|corresponding|matching row|belongs to|for the \w+ (in|on) row|slå upp)\b/i, ["xlookup", "index", "match", "vlookup"]],
  [/\b(rank|ranks|ranking|ranked|position within|nth largest|third largest|top)\b/i, ["rank.eq", "rank", "large", "small"]],
  [/\b(largest|highest|maximum|max|biggest|störst)\b/i, ["maxifs", "max", "large"]],
  [/\b(smallest|lowest|minimum|min|fewest|minst)\b/i, ["minifs", "min", "small"]],
  [/\b(percent|percentage|share of|proportion|fraction|andel)\b/i, ["sum", "round"]],
  [/\b(round|rounded|rounding|nearest|avrunda)\b/i, ["round", "mround", "roundup", "rounddown"]],
  [/\b(unique|distinct|duplicates|de-?duplicate|unika)\b/i, ["unique", "countif"]],
  [/\b(sort|sorted|sortera|descending|ascending|in order of)\b/i, ["sort", "sortby"]],
  [/\b(filter|filters|only the rows|list the .* (where|whose)|filtrera)\b/i, ["filter"]],
  [/\b(split|splits|separate|dela)\b/i, ["textsplit", "textbefore", "textafter"]],
  [/\b(join|joins|combine|concatenate|into one (cell|text|string)|slå ihop)\b/i, ["textjoin", "concat"]],
  [/\b(days between|months between|working days|business days|datum)\b/i, ["networkdays", "datedif", "workday", "eomonth"]],
  [/\b(if |when the|otherwise|grade|tier|band|category|om )\b/i, ["ifs", "if", "switch"]],
  [/\b(error|errors|#n\/a|fallback|guard|not found)\b/i, ["iferror", "ifna"]],
  [/\b(running total|cumulative|so far|to date|löpande)\b/i, ["sum", "scan"]],
  // --- added 2026-09-16 from the tasks the ranker was measured to miss ---------
  // Text extraction: "the middle block between the first and second hyphen" has
  // no verb the old table knew, so a text-splitting request retrieved SECOND
  // and GET.COLUMN.WIDTH on the strength of "second" and "width".
  [/\b(between|middle|part of|characters|substring|extract|starting at|after the|before the|domain|everything after|everything before)\b/i, ["mid", "find", "textafter", "textbefore", "search"]],
  [/\b(capital letters|upper ?case|uppercase|capitalised|capitalized)\b/i, ["upper", "proper"]],
  [/\b(lower ?case|lowercase)\b/i, ["lower"]],
  [/\b(padded|zero-?padded|leading zeros|thousands separator|two decimals|formatted as|format the number)\b/i, ["text"]],
  [/\b(repeat|repeated|pad(ded)? with|dots|fill to a width|exactly \d+ characters (long|wide))\b/i, ["rept", "len"]],
  [/\b(trailing|leading|extra spaces|double spaces|pasted)\b/i, ["trim", "clean"]],
  [/\b(length of|how long|number of characters)\b/i, ["len"]],
  [/\b(blank|empty|missing|not submitted|has not|have not)\b/i, ["countblank", "isblank"]],
  // Boolean tests: "TRUE or FALSE", "either", "both" describe AND/OR/XOR, which
  // have no verb of their own in a request.
  [/\b(both|all of the|every one of|all three|meets all)\b/i, ["and"]],
  [/\b(either|at least one|any of|outside|beyond|or (above|below|more|less))\b/i, ["or"]],
  [/\b(exactly one|only one of)\b/i, ["xor"]],
  [/\b(means|translate|maps? to|status code|code (in|from) \w+ into)\b/i, ["switch", "ifs"]],
  [/\b(appear|appears|present|exists|is (in|on) the list|membership|anywhere in)\b/i, ["isnumber", "match", "countif"]],
  [/\b(saturday|sunday|weekend|day of the week)\b/i, ["weekday"]],
  [/\b(complete years|years of service|full years|age in years)\b/i, ["datedif"]],
  [/\b(in (january|february|march|april|may|june|july|august|september|october|november|december)|placed in|during the month)\b/i, ["countifs", "sumproduct", "month", "year"]],
  [/\b(last day of the month|end of (the )?month|days until|due date)\b/i, ["eomonth"]],
  [/\b(months? (from|after|before)|renewal|add \d+ months)\b/i, ["edate"]],
  [/\b(position of|row number of|which row|last entry|first entry|last row)\b/i, ["match", "xmatch"]],
  [/\b(two-way|row and column|intersection|at the crossing)\b/i, ["index", "match"]],
  [/\b(next smaller|next larger|discount tier|threshold|falls in|band that)\b/i, ["xlookup", "vlookup", "index"]],
  [/\b(spill|single column|one formula that (lists|returns)|as a list)\b/i, ["filter", "sort", "unique", "sequence"]],
  [/\b(slope|trend line|per unit cost|line of best fit)\b/i, ["slope", "intercept"]],
  [/\b(standard deviation|spread|variability)\b/i, ["stdev.s", "stdev.p", "stdev"]],
  [/\b(median|middle value)\b/i, ["median"]],
  [/\b(monthly payment|loan|instalment|installment)\b/i, ["pmt"]],
  [/\b(net present value|discount rate)\b/i, ["npv", "irr"]],
  [/\b(weighted|sum of the products|multiply .* and add)\b/i, ["sumproduct"]],
  [/\b(is a number|numeric|is text)\b/i, ["isnumber", "istext"]],
];

/** Function-name hints implied by the way the request is phrased. */
export function synonymTerms(rawIntent: string): string[] {
  const out = new Set<string>();
  for (const [re, names] of TASK_SYNONYMS) {
    if (re.test(rawIntent)) for (const n of names) out.add(n);
  }
  return [...out];
}

/**
 * Boost by position within a synonym group: the first name is the best guess.
 *
 * LARGE ON PURPOSE. A matching content word is worth roughly 2-6 points after
 * IDF, so a spread of 4/2.5/1.5/1 let the tokens outvote the hint: SUM and
 * SUMIFS tied on boost for a share-of-total request and SUMIFS won on its rarer
 * name. The group's ranking is the stronger evidence and must dominate; tokens
 * break ties within a rank, not between ranks.
 */
const SYNONYM_BOOSTS = [8, 5, 3, 2] as const;

/**
 * Function name -> flat score bonus, from every synonym group the request fires.
 *
 * FLAT, NOT IDF-WEIGHTED. The hints used to be added to the query as terms and
 * scored through BM25 like any other word, which meant the hint for SUM was worth
 * almost nothing — SUM is called inside a hundred library formulas, so its token
 * has the lowest IDF in the index — while the hint for SUMIFS was worth sixteen
 * points. A share-of-total request (`=B2/SUM(...)`) therefore retrieved SUMIF and
 * SUMIFS and never SUM. A hint is a claim about the FUNCTION, so it is paid to the
 * function, at a rate that says how confident the group is in that member and
 * nothing about how common the word is.
 *
 * A function named in two firing groups keeps its higher boost.
 *
 * MEASURED 2026-09-16, AND THE RESULT IS THE THING TO READ BEFORE TUNING THIS
 * FURTHER. This change, the expanded stopword list, query-term de-duplication and
 * the one-per-function slate together took the offline hit rate — "a retrieved
 * pattern calls a function the reference calls" — from 18% to 38% over 174
 * corpus tasks (48% on the hand tasks alone, from 23%). Then the built-in 1.5B was
 * run on all 181 tasks with nothing else changed: **61/181 before, 61/181 after,
 * nine fixed, nine broken, McNemar p = 1.0.** Doubling the relevance of the
 * examples moved the model NOT AT ALL.
 *
 * So the hit rate is not a proxy for correctness on this model, and the reason is
 * probably the one the failure diagnosis already found: these models choose the
 * right FUNCTION and the wrong CELLS, and an example built on a Microsoft-doc
 * fixture cannot teach which column is which in the user's sheet. Retrieval
 * on-versus-off still measures p = 0.0005, so examples matter — but WHICH
 * examples, at this size, apparently does not. The changes stay because they are
 * neutral and a slate of `T, T, MINIFS` for a lookup was indefensible; do not
 * expect a score from refining them.
 */
export function synonymBoosts(rawIntent: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [re, names] of TASK_SYNONYMS) {
    if (!re.test(rawIntent)) continue;
    names.forEach((n, i) => {
      const boost = SYNONYM_BOOSTS[Math.min(i, SYNONYM_BOOSTS.length - 1)];
      if (boost > (out.get(n) ?? 0)) out.set(n, boost);
    });
  }
  return out;
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
  // UNIQUE terms. BM25 saturates term frequency on the DOCUMENT side and says
  // nothing about the query side, so a request that says "count" three times
  // scored COUNT three times over — 33 points from one word — and pushed the
  // COUNTIFS the request actually needed to fourth place. A word said twice is
  // not twice the evidence.
  const terms = [...new Set(tokenize(query.intent))];
  // Header words describe the data rather than the task, so they count for
  // less; without them a request about "Revenue" cannot find the revenue-shaped
  // examples at all.
  const headerTerms = [...new Set(tokenize((query.headers ?? []).join(" ")))];
  const boosts = synonymBoosts(query.intent);

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
    // A task verb is a much stronger signal about which function is wanted than
    // any noun in the sentence — paid to the FUNCTION as a flat bonus, never as
    // a query term, for the reason on `synonymBoosts`.
    score += boosts.get(doc.pattern.fn.toLowerCase()) ?? 0;

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

  // With three slots, a second example of the same function is a wasted slot
  // whether that function is right or wrong: the slate came back as
  // `T, T, MINIFS` and `SECOND, SECOND, GET.COLUMN.WIDTH` — two thirds of the
  // prompt's examples spent on one irrelevant function. One per function until
  // the slate is wide enough to afford repeats.
  const perFunctionCap = k <= 3 ? 1 : MAX_PER_FUNCTION;
  const perFunction = new Map<string, number>();
  const out: RankedPattern[] = [];
  for (const entry of scored) {
    const fn = entry.pattern.fn;
    const used = perFunction.get(fn) ?? 0;
    if (used >= perFunctionCap) continue;
    perFunction.set(fn, used + 1);
    out.push(entry);
    if (out.length >= k) break;
  }
  return out;
}
