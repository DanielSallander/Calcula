//! FILENAME: app/src/api/designQueryAssist/prompt.ts
// PURPOSE: What the model is asked, and the cheat-sheet that makes a closed
//          vocabulary out of the DSL.
// CONTEXT: The system prompt is BYTE-STABLE: it names no model-specific
//          thing, so a provider's prefix cache hits across every request in a
//          session. Everything that depends on the model — the candidate
//          names, the examples built from them, the request — is the user
//          message. A repair turn is APPENDED, never a rewrite of the first
//          message, for the same cache reason and because the model has to see
//          what it wrote and what the compiler said about it.
//
//          THE EXAMPLES ARE BUILT FROM THE CANDIDATES. A worked example with
//          invented names teaches a small model to use invented names; one
//          built from the first measure and the first dimensions it was just
//          shown teaches it to use those. Retrieval from a pattern library is
//          the formula assistant's design and may come here once a corpus
//          exists to retrieve from; until then three shaped examples cost
//          about eighty tokens.

import type { DesignQueryCandidates } from "./types";
import { buildNextClauseGrammar, type PresentClauses } from "./grammar";
import { DSL_LAYOUT_DIRECTIVES, DSL_SHOW_VALUES_AS, DSL_TAUGHT_AGGREGATIONS } from "./vocabulary";

/** The clause reference a model is shown. Kept short: every line is prompt tokens on a CPU. */
export const DESIGN_QUERY_CHEAT_SHEET = [
  "A design query is plain text, ONE clause per line:",
  "ROWS: Table.Column, Table.Column      the row groups (dimensions)",
  "COLUMNS: Table.Column                 optional column groups",
  "VALUES: [Measure], [Measure]          the numbers; measures in square brackets",
  '  A measure may be renamed with AS "Alias", and shown as a share or a running figure with a',
  `  bracketed label after it: ${DSL_SHOW_VALUES_AS.map((s) => `[${s}]`).join(", ")}.`,
  `  A numeric column may be aggregated instead of a measure: ${DSL_TAUGHT_AGGREGATIONS.map((a) => `${a}(Table.Column)`).join(", ")}.`,
  'FILTERS: Table.Column = ("value", "value")   or   Table.Column NOT IN ("value")   quoted values',
  "SORT: Table.Column DESC               orders the row LABELS (never a measure's values)",
  "TOP 10 BY [Measure]   or   BOTTOM 5 BY [Measure]     the only way to rank by a measure",
  "LAYOUT: tabular, no-grand-totals      only when asked; the directives are " +
    `${DSL_LAYOUT_DIRECTIVES.slice(0, 3).join(", ")}, ${DSL_LAYOUT_DIRECTIVES.slice(5, 8).join(", ")}, subtotals-off`,
].join("\n");

/**
 * How the model is asked to answer. `json` is the schema path (every
 * runtime); `bare` is the grammar path, where the runtime can only emit the
 * query itself and a prompt that asked for JSON would be fighting the grammar
 * from the first token — measured on the built-in runtime: every reply began
 * with a LAYOUT line nobody asked for, because LAYOUT was the most probable
 * legal continuation of an answer the model wanted to start with `{"dsl":`.
 */
export type DesignQueryReplyFormat = "json" | "bare";

const RULES_COMMON = [
  "- Use ONLY the measures and dimensions listed in the request, spelled exactly as listed. Never invent a name; if nothing listed fits, choose the closest listed name.",
  "- Every query has VALUES and at least one of ROWS or COLUMNS.",
  "- When the request mentions a period (year, month, quarter, over time), group by the calendar columns listed under Time.",
  "- \"highest first\", \"largest\", \"top\" or \"most\" means TOP N BY [Measure]; SORT cannot order by a measure.",
  "- Keep it minimal: no clause the request does not ask for. No CALC, no SAVE. Add LAYOUT only when the request mentions layout, totals or subtotals.",
  "- A bracketed label after a measure ([% of grand total], [difference], [running total]...) only when the request asks for a share, a percentage, a difference or a running total; never on a plain ranking.",
  "- FILTERS restricts the rows; do not also put the filtered column in ROWS or COLUMNS unless the request asks to see it.",
  "- Write a measure bare: [Customers], never count([Customers]) or [Customers] [average]. Aggregate only a listed numeric column: average(Sales.Amount).",
];

function systemPrompt(format: DesignQueryReplyFormat): string {
  const reply =
    format === "json"
      ? "- Reply with JSON matching the schema: \"dsl\" holds the whole query with real line breaks between clauses, \"explanation\" is one sentence."
      : "- Reply with the query only: the clauses, one per line, starting with the first clause. No JSON, no explanation, nothing before or after the query.";
  return [
    "You write ONE design query for Calcula, a spreadsheet with a semantic model. The query is compiled and run by Calcula, which checks every name.",
    "",
    DESIGN_QUERY_CHEAT_SHEET,
    "",
    "Rules:",
    ...RULES_COMMON,
    reply,
  ].join("\n");
}

/** The system prompt for the schema path. Byte-stable for a session. */
export const DESIGN_QUERY_SYSTEM_PROMPT = systemPrompt("json");

/** The system prompt for the grammar path. Byte-stable for a session. */
export const DESIGN_QUERY_SYSTEM_PROMPT_BARE = systemPrompt("bare");

/** The prompt for a reply format. */
export function designQuerySystemPrompt(format: DesignQueryReplyFormat): string {
  return format === "bare" ? DESIGN_QUERY_SYSTEM_PROMPT_BARE : DESIGN_QUERY_SYSTEM_PROMPT;
}

/** One worked example in the reply format the model is asked for. */
function example(request: string, dsl: string, explanation: string, format: DesignQueryReplyFormat): string {
  if (format === "bare") return `Request: ${request}\n${dsl}`;
  return `Request: ${request}\n${JSON.stringify({ dsl, explanation })}`;
}

/**
 * The shaped examples, built from the names the model was just shown.
 *
 * EVERY EXAMPLE MUST COMPILE AND MATCH THE GRAMMAR, and a test proves it. The
 * first version of the second example sorted by a measure — the one shape the
 * compiler refuses — and both small coder models copied it into a quarter of
 * their answers; the first share example carried a TOP 10 nobody asked for,
 * and that was copied too. A worked example is the strongest instruction a
 * small model receives, so each one shows exactly one thing and nothing extra.
 *
 * In the `bare` format the examples are the query text itself, the way the
 * grammar path's reply must look.
 */
export function buildExamples(c: DesignQueryCandidates, format: DesignQueryReplyFormat = "json"): string[] {
  const m0 = c.measures[0];
  const m1 = c.measures[1] ?? c.measures[0];
  const d0 = c.dimensions[0];
  const d1 = c.dimensions[1] ?? c.dimensions[0];
  const time = c.timeGroupings[0] ?? null;
  const out: string[] = [];
  if (m0 && d0) {
    out.push(example(`${wordsOf(m0)} by ${wordsOf(d0)}`, `ROWS: ${d0}\nVALUES: [${m0}]`, `${wordsOf(m0)} for each ${wordsOf(d0)}.`, format));
  }
  if (m0 && m1 && d0 && d1 && d1 !== d0 && m1 !== m0) {
    out.push(example(
      `${wordsOf(m0)} and ${wordsOf(m1)} by ${wordsOf(d0)}, split by ${wordsOf(d1)}`,
      `ROWS: ${d0}\nCOLUMNS: ${d1}\nVALUES: [${m0}], [${m1}]`,
      `${wordsOf(m0)} and ${wordsOf(m1)} by ${wordsOf(d0)} and ${wordsOf(d1)}.`,
      format,
    ));
  }
  if (m0 && time) {
    out.push(example(`${wordsOf(m0)} per ${wordsOf(time)}`, `ROWS: ${time}\nVALUES: [${m0}]`, `${wordsOf(m0)} over time.`, format));
  }
  // The share form, because a model shown only "[Measure]" puts the
  // show-values-as label where a measure goes (measured: `VALUES: [% of grand
  // total]` from both small coder models). Nothing else in it.
  if (m0 && d0) {
    out.push(example(
      `share of total ${wordsOf(m0)} by ${wordsOf(d0)}`,
      `ROWS: ${d0}\nVALUES: [${m0}] [% of grand total]`,
      `Each ${wordsOf(d0)}'s share of ${wordsOf(m0)}.`,
      format,
    ));
  }
  // The ranking form, because "highest first" is otherwise written as a SORT
  // by a measure, which the compiler refuses.
  if (m0 && d0) {
    out.push(example(
      `the three ${wordsOf(d0)} with the highest ${wordsOf(m0)}`,
      `ROWS: ${d0}\nVALUES: [${m0}]\nTOP 3 BY [${m0}]`,
      `The three ${wordsOf(d0)} with the most ${wordsOf(m0)}.`,
      format,
    ));
  }
  // The aggregation form, because "average amount" is otherwise written as a
  // bracketed label or a bracketed call, neither of which is a thing.
  const n0 = c.numericColumns[0];
  if (n0 && d0) {
    out.push(example(
      `average ${wordsOf(n0)} by ${wordsOf(d0)}`,
      `ROWS: ${d0}\nVALUES: average(${n0})`,
      `The average ${wordsOf(n0)} for each ${wordsOf(d0)}.`,
      format,
    ));
  }
  return out;
}

/** `Product.Category` -> "product category"; `[Sales.Order Date]` -> "sales order date". */
function wordsOf(ref: string): string {
  return ref
    .replace(/^\[|\]$/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._]/g, " ")
    .toLowerCase();
}

export interface UserPromptParts {
  readonly intent: string;
  readonly candidates: DesignQueryCandidates;
  /** Include the shaped examples. On by default; the eval runner can switch them off to measure them. */
  readonly examples?: boolean;
  /** The reply format the examples are shown in. Defaults to the schema path's JSON. */
  readonly format?: DesignQueryReplyFormat;
}

/**
 * The system prompt for a NEXT-CLAUSE completion. Byte-stable for a session.
 *
 * A different job from drafting, and a much smaller one: the person is typing a
 * query, not describing one, so there is no request to interpret — only "what
 * plausibly comes next, given what is already there". The grammar can emit
 * exactly one clause and nothing else, so the prompt asks for exactly that; a
 * prompt asking for more under a grammar that forbids it is what made every
 * drafted reply open with an unasked LAYOUT line (§14.3).
 *
 * It is also allowed to answer NOTHING. A finished query is the common case in
 * an editor, and a model that must always say something will always say
 * something.
 */
export const DESIGN_QUERY_NEXT_CLAUSE_PROMPT = [
  "You complete a design query for Calcula, a spreadsheet with a semantic model. The query is compiled and run by Calcula, which checks every name.",
  "",
  DESIGN_QUERY_CHEAT_SHEET,
  "",
  "Rules:",
  "- Reply with ONE more clause for the query below, and nothing else. No JSON, no explanation, no repetition of the clauses already there.",
  "- Use ONLY the measures and dimensions listed, spelled exactly as listed. Never invent a name.",
  "- Add only a clause the query plainly wants: a measure when it has none, a breakdown when it has none, a filter or a ranking the wording of the names suggests.",
  "- If the query is already complete, reply with nothing at all.",
].join("\n");

/** The names, as the drafting prompt lists them. Shared by both user messages. */
function nameBlocks(c: DesignQueryCandidates): string[] {
  const blocks: string[] = [];
  const measureLine = c.measures.length
    ? `Measures (most important first): ${c.measures.map((m) => `[${m}]`).join(", ")}` +
      (c.droppedMeasures > 0 ? ` (and ${c.droppedMeasures} more not listed)` : "")
    : "Measures: none declared.";
  blocks.push(measureLine);

  const dimensionLine = c.dimensions.length
    ? `Dimensions: ${c.dimensions.join(", ")}` +
      (c.droppedDimensions > 0 ? ` (and ${c.droppedDimensions} more not listed)` : "")
    : "Dimensions: none.";
  blocks.push(dimensionLine);

  if (c.numericColumns.length) {
    blocks.push(
      `Numeric columns you may aggregate with ${DSL_TAUGHT_AGGREGATIONS.join("/")}: ${c.numericColumns.join(", ")}`,
    );
  }

  if (c.timeGroupings.length || c.timeAxis) {
    const groupings = c.timeGroupings.length ? ` Group time by: ${c.timeGroupings.join(", ")}.` : "";
    blocks.push(`Time: ${c.timeAxis ?? "the calendar"}.${groupings}`);
  } else {
    blocks.push("Time: this model has no calendar; do not group by time.");
  }
  return blocks;
}

/** The user message for a next-clause completion: the names, then the query so far. */
export function buildNextClauseUserPrompt(candidates: DesignQueryCandidates, dsl: string): string {
  return [...nameBlocks(candidates), `Query so far:\n${dsl.trim()}`].join("\n\n");
}

/**
 * The reply budget for one clause.
 *
 * A clause is a few tokens; a model that starts explaining fills whatever it is
 * given. It lives on the request rather than at each call site because the row
 * and the offline runner must send the same number — a runner with its own copy
 * measures a budget the product does not use.
 */
export const NEXT_CLAUSE_MAX_TOKENS = 48;

/** Everything one next-clause request needs, or null when none should be sent. */
export interface NextClauseRequest {
  system: string;
  user: string;
  grammar: string;
  maxTokens: number;
}

/**
 * Assemble the whole next-clause request: prompt, names and grammar.
 *
 * ONE definition, so the product's row and the offline runner send the same
 * bytes. A runner that rebuilt the request would measure a port of the
 * pipeline rather than the pipeline — the mistake the design-query runner was
 * written to avoid, and the reason that one drives `draftDesignQuery` itself.
 * Null when the query is already complete or the model cannot express one.
 */
export function buildNextClauseRequest(
  candidates: DesignQueryCandidates,
  present: PresentClauses,
  dsl: string,
): NextClauseRequest | null {
  const grammar = buildNextClauseGrammar(candidates, present);
  if (!grammar) return null;
  return {
    system: DESIGN_QUERY_NEXT_CLAUSE_PROMPT,
    user: buildNextClauseUserPrompt(candidates, dsl),
    grammar,
    maxTokens: NEXT_CLAUSE_MAX_TOKENS,
  };
}

/** The user message: the names, the time axis, the examples, then the request. */
export function buildUserPrompt(parts: UserPromptParts): string {
  const c = parts.candidates;
  const blocks: string[] = [];

  const measureLine = c.measures.length
    ? `Measures (most important first): ${c.measures.map((m) => `[${m}]`).join(", ")}` +
      (c.droppedMeasures > 0 ? ` (and ${c.droppedMeasures} more not listed)` : "")
    : "Measures: none declared.";
  blocks.push(measureLine);

  const dimensionLine = c.dimensions.length
    ? `Dimensions: ${c.dimensions.join(", ")}` +
      (c.droppedDimensions > 0 ? ` (and ${c.droppedDimensions} more not listed)` : "")
    : "Dimensions: none.";
  blocks.push(dimensionLine);

  if (c.numericColumns.length) {
    blocks.push(
      `Numeric columns you may aggregate with ${DSL_TAUGHT_AGGREGATIONS.join("/")}: ${c.numericColumns.join(", ")}`,
    );
  }

  if (c.timeGroupings.length || c.timeAxis) {
    const groupings = c.timeGroupings.length ? ` Group time by: ${c.timeGroupings.join(", ")}.` : "";
    blocks.push(`Time: ${c.timeAxis ?? "the calendar"}.${groupings}`);
  } else {
    blocks.push("Time: this model has no calendar; do not group by time.");
  }

  if (parts.examples !== false) {
    const examples = buildExamples(c, parts.format ?? "json");
    if (examples.length) blocks.push(`Examples:\n${examples.join("\n")}`);
  }

  blocks.push(`Request: ${parts.intent.trim()}`);
  return blocks.join("\n\n");
}

/** One compiler finding, as the repair message quotes it. */
export interface CompilerFinding {
  line?: number;
  message: string;
}

/**
 * The follow-up after a proposal failed to compile. Appended, never
 * substituted for the original message.
 */
export function buildRepairPrompt(
  previousDsl: string,
  findings: readonly CompilerFinding[],
  format: DesignQueryReplyFormat = "json",
): string {
  return [
    "Your query was:",
    previousDsl,
    "",
    "Calcula's compiler reported:",
    ...findings.slice(0, 4).map((f) => `- ${f.line !== undefined ? `line ${f.line}: ` : ""}${f.message}`),
    "",
    format === "json"
      ? "Return a corrected query in the same JSON shape, using only the listed names."
      : "Return the corrected query only, one clause per line, using only the listed names.",
  ].join("\n");
}

/** A crude token estimate, matching the 3.6 chars/token the repo uses elsewhere. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}
