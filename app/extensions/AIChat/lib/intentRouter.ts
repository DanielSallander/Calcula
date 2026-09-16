//! FILENAME: app/extensions/AIChat/lib/intentRouter.ts
// PURPOSE: Decide, BEFORE any model sees a chat message, which of nine kinds of
//          request it is — and refuse to decide when the words support two.
// CONTEXT: The AI programme's M4 (docs/design/ai-intent-router.md). Every
//          measurement this programme has taken says the same thing: models are
//          good at GENERATING and bad at ROUTING, and the gap does not close
//          with size — handed 24 tools a 3B named a real one 0 times in 4, and
//          a 7B invented names at the same rate. So routing is deterministic,
//          here, and a model is only ever asked to fill a slot something else
//          then checks.
//
//          TWO DETECTORS BECAME ONE ROUTER. `scriptIntent` and `analysisIntent`
//          ran independently on every message and nothing arbitrated; "write a
//          macro that flags outliers every month" got the Tier-0 fact bundle AND
//          the script offer, and between them they could express three of the
//          nine intents. Measured over the 214-utterance corpus: 24 routed
//          correctly. This module routes every message exactly once.
//
//          THE CONTRACT THAT SHAPES EVERYTHING BELOW: a DECISIVE route must be
//          right, essentially always. A decisive wrong route is the
//          apply-formatting-over-the-wrong-range failure, and it is silent. So:
//            - every strong signal is COLLECTED, never first-match short-circuited;
//            - a handful of documented precedence pairs resolve the confusions
//              the corpus is densest on;
//            - if two strong classes survive, the answer is "ask", not a guess;
//            - `unclear` has no vocabulary and is the fallback arm only;
//          and a CI test routes the whole corpus and fails on ONE decisive miss.
//
//          RULES ARE DERIVED, NOT GUESSED. The `script` table is built from
//          durability — an event, a schedule, persistence, a run-time dialog, an
//          exposed entry point, a network capability — because 23 of 31 real
//          script requests carry no trigger word at all; "when this button is
//          clicked" is how a person asks for automation. `bi-query` is not a
//          word list either: it reads the LOADED MODEL's field names through
//          `@api/biModelFields`, so "revenue by region" routes on what the
//          workbook actually contains and improves as the model gains fields.

import type { ModelFieldIndex } from "@api";

/**
 * Does the text contain `needle` AS A WORD?
 *
 * `includes` was WRONG, not merely loose. "spreadsheet" contains "sheet", so "a
 * script for my spreadsheet that colours each selected cell" built a
 * SheetContext surface — no `onClick` anywhere in it — for what is almost always
 * a button request; *description*, *subscription*, *transcript* and
 * *prescription* all contain "script" and each rendered a script offer card. A
 * miss is the acceptable failure; a confident wrong answer is not.
 */
export function mentionsWord(text: string, needle: string): boolean {
  // The needles are fixed lowercase tables, but escaped anyway: an entry with a
  // "." or a "(" in it would otherwise silently become a wildcard.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/**
 * The object type a message hints at, or null.
 *
 * Used to PRESELECT the dropdown in the guided flow — where the user sees and
 * can change it — AND to pick the API slice the chat shows the model before it
 * writes anything, where nobody sees it at all. That second consumer is why the
 * match has to be word-accurate: a wrong answer is a prompt that confidently
 * describes the wrong object's hooks, and the model's draft is dead.
 *
 * ORDER MATTERS: first hit wins, so the NAMED objects come first and the generic
 * grid words last. "add a button to my spreadsheet" is a button request that
 * happens to mention where the button goes.
 */
const TYPE_HINTS: ReadonlyArray<[string, string]> = [
  ["button", "button"],
  ["chart", "chart"],
  ["pivot", "pivot"],
  ["slicer", "slicer"],
  ["timeline", "timeline"],
  ["shape", "shape"],
  // "form" as a WORD, so "format" and "formula" do not match.
  ["form", "form"],
  ["text box", "textbox"],
  ["textbox", "textbox"],
  ["table", "table"],
  ["named range", "namedRange"],
  ["workbook", "workbook"],
  ["sheet", "sheet"],
  ["worksheet", "sheet"],
  // The grid primitives, last. They are real object types (`DRAFT_OBJECT_TYPES`
  // in chatTools.ts), and until they were listed "when this cell changes" got
  // the BUTTON surface — a documented miss, but a miss on the commonest way to
  // describe a cell script.
  ["cell", "cell"],
  ["row", "row"],
  ["column", "column"],
];

export function guessObjectType(message: string): string | null {
  const text = message.toLowerCase();
  for (const [needle, type] of TYPE_HINTS) {
    if (mentionsWord(text, needle)) return type;
  }
  return null;
}

export type Intent =
  | "formula"
  | "format"
  | "data-op"
  | "analyze"
  | "chart"
  | "script"
  | "bi-query"
  | "question"
  | "unclear";

export const INTENTS: readonly Intent[] = [
  "formula", "format", "data-op", "analyze", "chart", "script", "bi-query", "question", "unclear",
];

export interface RouteContext {
  /** The loaded model's field names; `null`/absent means no model is open. */
  fields?: ModelFieldIndex | null;
}

export interface IntentRoute {
  intent: Intent;
  /**
   * A rule that has to be right fired ALONE. Only a decisive route may change
   * what the chat does silently (which tools it sends, whether the API surface
   * is built); a non-decisive one is a lean, and the general loop stays.
   */
  decisive: boolean;
  /** The evidence, for an honest one-line notice: `["durable: when this", ...]`. */
  matched: string[];
  /** Two strong classes survived precedence; the chat should ask which. */
  clarify?: [Intent, Intent];
  /** The object a script would attach to, for the offer card and the API surface. */
  objectType: string | null;
}

// ---------------------------------------------------------------------------
// Vocabulary — every single word is matched AS A WORD via `mentionsWord`;
// multi-word phrases as substrings (a phrase boundary is a word boundary).
// ---------------------------------------------------------------------------

/** An event the automation should respond to. */
const SCRIPT_EVENT = [
  "when this", "when the", "when a ", "when i ", "whenever", "every time", "each time",
  "on click", "is clicked", "gets clicked", "on open", "when it opens", "when the workbook",
  "when new data", "on change", "when it changes", "as soon as", "any time ",
];
/** A schedule — fires as script only beside an automation verb (see `scheduleIsAutomation`). */
const SCRIPT_SCHEDULE = /\b(every|each)\s+(\d+\s+)?(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|morning|evening|night|nights|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
/** Verbs that make a schedule an instruction rather than a grouping. */
const AUTOMATION_VERBS = [
  "refresh", "update", "email", "send", "run", "recalculate", "recalc", "automate", "copy",
  "export", "import", "backup", "back up", "remind", "notify", "log", "check", "download",
  "fetch", "sync", "regenerate", "rebuild", "flag", "highlight", "colour", "color", "bold",
  "format", "clear", "reset", "archive", "save", "print", "post", "pull", "push", "readjust",
  "adjust", "load", "reload", "recompute",
];
/** State that outlives the session. */
const SCRIPT_PERSIST = [
  "across sessions", "survives reopening", "so it survives", "after the workbook is reopened",
  "after reopening", "keep doing it", "remember", "remembering", "persist", "persistent",
  "store the count", "keep a count", "keep track",
];
/** A run-time interaction with the person. */
const SCRIPT_RUNTIME = [
  "ask the user", "ask me", "prompt the user", "prompt me", "pop up", "popup", "pop-up",
  "show it to the user", "tell the user", "tell me if", "confirm before", "confirmation before",
  "a message saying", "message box", "dialog", "dialogue", "alert", "log the", "log its",
  "log how", "log it", "log what", "log which", "console", "show it in a message", "warn me",
];
/** An exposed entry point — something with a handle the person will use again. */
const SCRIPT_ENTRY = [
  "expose a command", "expose two commands", "expose commands", "make a form", "a form with",
  "a form that", "build a form", "create a form", "add a button", "a button that", "a button which",
  "button", "menu item", "keyboard shortcut", "shortcut key", "hotkey", "command that",
  "a command i can",
];
/** Reaching outside the workbook needs a declared capability — script territory. */
const SCRIPT_CAPABILITY = [
  "http://", "https://", "download", "downloads", "fetch", "fetches", "from the web",
  "web request", "an api", "the api", "rest api", "json", "url", "endpoint",
];
/** The words that mean it outright. */
const SCRIPT_EXPLICIT = [
  "script", "scripts", "macro", "macros", "automate", "automated", "automation", "automatically",
  "reusable", "scripted", "add-in", "addin", "plugin",
];
/** "Do it to the workbook now" — overrides an explicit script word, never a durable one. */
const SCRIPT_ONEOFF = ["just", "right now", "one-off", "one off", "quickly", "for now", "the simplest way"];

const CHART_WORDS = [
  "chart", "charts", "diagram", "diagrams", "plot", "plots", "graph", "graphs", "trendline",
  "trend line", "bar chart", "line chart", "pie chart", "scatter", "sparkline", "sparklines",
  "axis", "axes", "legend", "visualise", "visualize", "visualisation", "visualization",
];

/** Explicit formula language — never bare statistics, which belong to reports. */
const FORMULA_WORDS = [
  "formula", "formulas", "formulae", "function", "functions", "vlookup", "xlookup", "hlookup",
  "sumif", "sumifs", "countif", "countifs", "sumproduct", "index match", "index/match", "lambda",
  "array formula", "cell reference", "absolute reference", "circular reference",
];
const ERROR_CODE = /#(div\/0!?|value!?|ref!?|name\??|n\/a|num!?|null!?|spill!?|calc!?|division)/i;

/** Appearance, and only appearance. */
const FORMAT_WORDS = [
  "bold", "italic", "italics", "underline", "underlined", "strikethrough", "background",
  "fill colour", "fill color", "colour", "color", "coloured", "colored", "font", "fonts",
  "highlight", "highlighted", "border", "borders", "freeze", "unfreeze", "centre", "center",
  "centred", "centered", "align", "aligned", "alignment", "wrap", "indent", "number format",
  "date format", "as currency", "as a currency", "as text", "as a date", "as a percentage",
  "as percentage", "as percent", "with one decimal", "with two decimals", "decimal places",
  "decimals", "reformat", "conditional formatting", "column width", "column widths", "row height",
  "house style", "house number format", "house format", "grey", "gray", "red", "green", "yellow",
  "blue", "orange",
];
/** "format" is a verb as well as a noun; both mean appearance. */
const FORMAT_VERB = /\b(format|formats|formatted|formatting|reformat|style|styled|styles)\b/;

/** An edit to what the sheet HOLDS — needs a target to be decisive. */
const DATAOP_VERBS = [
  "put", "set", "write", "enter", "type", "copy", "paste", "move", "insert", "delete", "remove",
  "clear", "sort", "split", "replace", "merge", "fill", "duplicate", "dedupe", "deduplicate",
  "rename", "recalculate", "recalculates", "recalculating", "recalculation", "recalc", "transpose",
  "trim", "convert", "combine", "append", "add a sheet", "add a new sheet", "new sheet",
  "create a table", "make a table", "add a table", "text to columns", "find and replace",
  "replace all", "remove duplicates", "drop", "swap",
  // "add" alone is far too loose ("add up column B" is a formula); these are
  // the sheet edits people spell with it.
  "add a column", "add columns", "add a row", "add rows", "add a header", "add a total row",
  "add a new column", "add a new row",
];
/** Targets that make a write verb an edit rather than an idea. */
const DATAOP_TARGETS = [
  "column", "columns", "row", "rows", "sheet", "table", "range", "cell", "cells", "selection",
  "these", "this", "header", "headers", "the empty", "the blank", "duplicates", "duplicate rows",
  "workbook", "everything", "the whole",
];
const CELL_REF = /(?<![A-Za-z0-9])\$?[A-Za-z]{1,3}\$?\d{1,7}(?:\s*:\s*\$?[A-Za-z]{1,3}\$?\d{1,7})?(?![A-Za-z0-9])/;
const COLUMN_LETTER = /\bcolumn\s+[A-Z]\b/i;

const ANALYZE_WORDS = [
  "analyse", "analyze", "analysis", "analysing", "analyzing", "insight", "insights", "trend",
  "trends", "trending", "outlier", "outliers", "anomaly", "anomalies", "correlation",
  "correlations", "correlate", "correlated", "seasonality", "seasonal", "unusual", "healthy",
  "summarise", "summarize", "summary of", "compare", "comparison", "improving", "declining",
  "spike", "spikes", "dip", "dips",
];
const ANALYZE_PHRASES = [
  "what is going on", "what's going on", "whats going on", "what is happening", "what's happening",
  "whats happening", "what happened", "what stands out", "anything interesting", "anything unusual",
  "anything notable", "anything odd", "explain the data", "explain this data", "explain these numbers",
  "explain the numbers", "explain this range", "explain the selection", "explain this chart",
  "tell me about this data", "tell me about the data", "describe this data", "describe the data",
  "move together", "better or worse", "what changed", "how does this look", "how do these look",
  "make sense of", "what do these numbers", "what do the numbers", "these numbers",
];

/** Questions ABOUT the product or about spreadsheets, with no cell target. */
const QUESTION_PHRASES = [
  "what does", "what is a", "what is an", "what are", "how do i", "how do you", "how can i",
  "can calcula", "does calcula", "can this", "is there a way", "is it possible", "tell me how",
  "what's the difference", "what is the difference", "should i use", "which is better",
  "which chart type", "which function", "what function", "explain how", "help me understand",
  "how does", "what happens if", "how big", "how many", "how much", "report the number",
  "what version", "where is", "where do i",
];

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/** The first list entry present — a phrase as a substring, a word as a word. */
function firstHit(text: string, list: ReadonlyArray<string>): string | null {
  for (const w of list) {
    if (w.includes(" ") || w.includes("/") || w.includes(":") || w.includes("-")) {
      if (text.includes(w)) return w;
    } else if (mentionsWord(text, w)) {
      return w;
    }
  }
  return null;
}

/** `Category` from "categories"; `subcategory` from "subcategories". */
function singular(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("ches") || word.endsWith("shes")) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

/**
 * A small lexicon of what people CALL a field, keyed by what the model calls
 * it. General spreadsheet vocabulary, deliberately not fitted to any corpus:
 * a model whose measure is `Revenue` is asked about "sales" and "turnover".
 */
const FIELD_SYNONYMS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["revenue", ["sales", "turnover", "income", "takings"]],
  ["cost", ["costs", "spend", "spending", "expense", "expenses"]],
  ["margin", ["profit", "profits"]],
  ["quantity", ["units", "volume", "qty", "pieces"]],
  ["customers", ["clients", "accounts"]],
  ["customer", ["client", "account"]],
  ["product", ["item", "sku"]],
  ["products", ["items", "skus"]],
  ["country", ["nation", "market"]],
  ["countries", ["nations", "markets"]],
  ["region", ["area", "territory"]],
  ["regions", ["areas", "territories"]],
  ["category", ["family", "group"]],
  ["segment", ["tier", "band"]],
];

interface FieldHits {
  /** Distinct measures named. */
  measures: string[];
  /** Distinct non-calendar dimensions or tables named. */
  dimensions: string[];
  /** Distinct calendar words named. */
  calendar: string[];
}

/** Which of the model's fields the message names, by class. */
export function fieldsNamed(text: string, fields: ModelFieldIndex | null | undefined): FieldHits {
  const hits: FieldHits = { measures: [], dimensions: [], calendar: [] };
  if (!fields || fields.connections === 0) return hits;
  const seen = new Set<string>();
  const words = text.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [];
  // ONE WORD, ONE FIELD. "sales" is the `Sales` table AND a synonym for the
  // `Revenue` measure; counted twice it made "analyse the sales and automate it
  // weekly" name two fields and read as a report. The first classification a
  // word earns is the only one it earns.
  const consider = (candidate: string, source: string): boolean => {
    if (seen.has(candidate)) return false;
    if (fields.measures.has(candidate)) {
      seen.add(candidate);
      hits.measures.push(source);
      return true;
    }
    if (fields.dimensions.has(candidate) || fields.tables.has(candidate)) {
      seen.add(candidate);
      hits.dimensions.push(source);
      return true;
    }
    if (fields.calendar.has(candidate)) {
      seen.add(candidate);
      hits.calendar.push(source);
      return true;
    }
    return false;
  };
  for (const w of words) {
    if (consider(w, w)) continue;
    const s = singular(w);
    if (s !== w && consider(s, w)) continue;
    for (const [name, aliases] of FIELD_SYNONYMS) {
      if (aliases.includes(w) && (consider(name, w) || consider(singular(name), w))) break;
    }
  }
  return hits;
}

/** Is the schedule an instruction ("every week, refresh") or a grouping ("revenue for every month")? */
function scheduleIsAutomation(text: string): boolean {
  const m = SCRIPT_SCHEDULE.exec(text);
  if (!m) return false;
  // A grouping preposition immediately before it reads as a period, not a timer.
  const before = text.slice(Math.max(0, m.index - 6), m.index);
  if (/\b(for|per|by|of|in)\s*$/.test(before)) return false;
  return AUTOMATION_VERBS.some((v) => mentionsWord(text, v)) || /^\s*(every|each)\b/.test(text);
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

interface Signals {
  script: string | null;
  scriptOneOff: string | null;
  chart: string | null;
  formula: string | null;
  format: string | null;
  dataOp: string | null;
  analyze: string | null;
  biStrong: string | null;
  biWeak: string | null;
  question: string | null;
  cellRef: boolean;
}

function collect(text: string, fields: ModelFieldIndex | null | undefined): Signals {
  const t = text.toLowerCase();
  const cellRef = CELL_REF.test(text) || COLUMN_LETTER.test(text);

  // --- script: any durability signal ------------------------------------
  let script: string | null = null;
  const ev = firstHit(t, SCRIPT_EVENT);
  const persist = firstHit(t, SCRIPT_PERSIST);
  const runtime = firstHit(t, SCRIPT_RUNTIME);
  const entry = firstHit(t, SCRIPT_ENTRY);
  const capability = firstHit(t, SCRIPT_CAPABILITY);
  const explicit = firstHit(t, SCRIPT_EXPLICIT);
  if (ev) script = `event: ${ev.trim()}`;
  else if (scheduleIsAutomation(t)) script = `schedule: ${SCRIPT_SCHEDULE.exec(t)![0]}`;
  else if (persist) script = `persists: ${persist}`;
  else if (runtime) script = `run-time: ${runtime}`;
  else if (entry) script = `entry point: ${entry}`;
  else if (capability) script = `capability: ${capability}`;
  else if (explicit) script = `explicit: ${explicit}`;
  const scriptOneOff = firstHit(t, SCRIPT_ONEOFF);

  // --- the rest ----------------------------------------------------------
  const chart = firstHit(t, CHART_WORDS);
  const errorCode = ERROR_CODE.exec(text)?.[0] ?? null;
  // A NEGATED formula word is the person ruling formulas OUT — "in the script
  // itself (not with a formula)" — and must not count as asking for one.
  const formulaNegated = /\b(not with|without|instead of|rather than|no|not|never)\s+(a |an |the |any )?formulas?\b/.test(t);
  const formulaWord = formulaNegated ? null : firstHit(t, FORMULA_WORDS);
  const formula = t.trim().startsWith("=") ? "leading =" : formulaWord ?? (errorCode ? `error code ${errorCode}` : null);

  const named = fieldsNamed(text, fields);
  const business = named.measures.length + named.dimensions.length;
  // A report names a measure or a business dimension; a calendar word alone is
  // a time expression. Two business names, or one plus a calendar grain, is a
  // report by construction — "revenue by region", "revenue per year".
  const biStrong =
    !cellRef && (business >= 2 || (business >= 1 && named.calendar.length >= 1))
      ? `fields: ${[...named.measures, ...named.dimensions, ...named.calendar].join(", ")}`
      : null;
  const biWeak = !biStrong && !cellRef && business >= 1 ? `field: ${[...named.measures, ...named.dimensions][0]}` : null;

  // Number-format words that are ALSO report vocabulary ("as a percentage of
  // each row") only count as formatting when no report is being named.
  let format = firstHit(t, FORMAT_WORDS) ?? (FORMAT_VERB.test(t) ? FORMAT_VERB.exec(t)![0] : null);
  if (format && biStrong && /percent|decimal/.test(format)) format = null;

  const verb = firstHit(t, DATAOP_VERBS);
  const target = firstHit(t, DATAOP_TARGETS);
  const dataOp = verb && (cellRef || target) ? `edit: ${verb}${cellRef ? " + cell" : ` + ${target}`}` : null;

  const analyze = formulaWord ? null : firstHit(t, ANALYZE_WORDS) ?? firstHit(t, ANALYZE_PHRASES);
  const question = firstHit(t, QUESTION_PHRASES);

  return { script, scriptOneOff, chart, formula, format, dataOp, analyze, biStrong, biWeak, question, cellRef };
}

// ---------------------------------------------------------------------------
// Arbitration
// ---------------------------------------------------------------------------

/** A fixed rank for naming the two members of a clarify pair, nothing more. */
const CLARIFY_ORDER: readonly Intent[] = ["script", "chart", "formula", "bi-query", "analyze", "format", "data-op"];

export function routeIntent(text: string, ctx: RouteContext = {}): IntentRoute {
  const objectType = guessObjectType(text);
  const s = collect(text, ctx.fields);
  const matched: string[] = [];

  // 1. A leading `=` is a formula, full stop.
  if (s.formula === "leading =") {
    return { intent: "formula", decisive: true, matched: ["leading ="], objectType };
  }

  // 2. Strong signals, collected. A one-off phrase cancels an EXPLICIT script
  //    word ("just automate this") and never a durable signal: "when this
  //    button is clicked, just copy A1" is still a button.
  const strong = new Map<Intent, string>();
  if (s.script && !(s.scriptOneOff && s.script.startsWith("explicit"))) strong.set("script", s.script);
  if (s.chart) strong.set("chart", `chart: ${s.chart}`);
  if (s.formula) strong.set("formula", `formula: ${s.formula}`);
  if (s.biStrong) strong.set("bi-query", s.biStrong);
  if (s.analyze) strong.set("analyze", `analysis: ${s.analyze}`);
  if (s.format) strong.set("format", `appearance: ${s.format}`);
  if (s.dataOp) strong.set("data-op", s.dataOp);

  // 3. Precedence pairs — each one a confusion the corpus is dense on, with the
  //    reason recorded, so a later reader can tell a rule from a preference.
  const drop = (loser: Intent, why: string) => {
    if (strong.has(loser)) {
      matched.push(`(${loser} yields: ${why})`);
      strong.delete(loser);
    }
  };
  if (strong.has("script")) {
    // Formatting or editing ON AN EVENT is automation: "bold the header every
    // time new data is imported", "when clicked, copy A1 to B1".
    drop("format", "durable");
    drop("data-op", "durable");
    // "write a macro that flags outliers" — the macro is the deliverable.
    if (s.script?.startsWith("explicit") || s.script?.startsWith("entry")) drop("analyze", "explicit automation");
  }
  if (strong.has("chart")) {
    // "line chart of revenue by month" is a chart; "add a trendline" is a chart change.
    drop("bi-query", "the chart is the request");
    drop("analyze", "the chart is the request");
    drop("format", "chart appearance is the chart tool's");
  }
  if (strong.has("bi-query")) {
    // A message that names model fields is asking for a report; one that names a
    // statistic without them is asking for an analysis (design §4b).
    drop("analyze", "names model fields");
    drop("data-op", "names model fields");
    // "flat table style, and drop the total column" describes the REPORT's
    // layout — tabular, totals, subtotals — not the sheet's appearance. A word
    // like "bold" beside model fields is genuinely mixed and still asks.
    if (s.format && /style|tabular|outline|compact|total|subtotal|layout/.test(s.format)) {
      drop("format", "report layout, not sheet appearance");
    }
  }
  if (strong.has("formula") && strong.has("data-op")) {
    // The VERB governs: "read the formula in C10 and copy it into C11" is a copy;
    // "write a formula to look up the price" is a formula.
    const copyish = /\b(copy|paste|move|duplicate)\b/.test(text.toLowerCase());
    if (copyish) drop("formula", "the verb is a copy");
    else drop("data-op", "the formula is the deliverable");
  }
  if (strong.has("formula")) drop("analyze", "explicitly about a formula");
  if (strong.has("data-op") && strong.has("format")) {
    // "put a Totals header in A1, sum column C into B1, and bold both": the
    // edits carry the request and the formatting is a trailing conjunct — but
    // only when the edit has a CELL target; "make A1:D1 bold" has no write verb.
    if (s.dataOp?.includes("+ cell")) drop("format", "an edit with a cell target");
  }

  // 4. Exactly one strong class is decisive. Two is a question for the person.
  if (strong.size === 1) {
    const [[intent, evidence]] = [...strong.entries()];
    return { intent, decisive: true, matched: [evidence, ...matched], objectType };
  }
  if (strong.size >= 2) {
    const pair = CLARIFY_ORDER.filter((i) => strong.has(i)).slice(0, 2) as [Intent, Intent];
    return {
      intent: "unclear",
      decisive: false,
      matched: [...pair.map((i) => strong.get(i)!), ...matched],
      clarify: pair,
      objectType,
    };
  }

  // 5. Leans. Never decisive: the general loop keeps every tool.
  if (s.biWeak) return { intent: "bi-query", decisive: false, matched: [s.biWeak], objectType };
  if (s.question) return { intent: "question", decisive: false, matched: [`question: ${s.question}`], objectType };
  if (s.cellRef) return { intent: "data-op", decisive: false, matched: ["a cell reference and no other signal"], objectType };
  return { intent: "unclear", decisive: false, matched: ["no signal"], objectType };
}

/** The one-line transcript notice for a route, or null when there is nothing worth saying. */
export function describeRoute(route: IntentRoute): string | null {
  if (route.clarify) {
    return `This reads as either ${route.clarify[0]} or ${route.clarify[1]} — say which and I will do that; for now I will treat it as a general request.`;
  }
  if (!route.decisive || route.intent === "unclear" || route.intent === "question") return null;
  const evidence = route.matched.filter((m) => !m.startsWith("("))[0];
  return `Routed as ${route.intent}${evidence ? ` (${evidence})` : ""}.`;
}
