//! FILENAME: app/src/api/designQueryAssist/nextEdit.ts
// PURPOSE: The next edit a design query probably wants, decided by rules over
//          the strategy's structured fields — no model, no latency, and every
//          suggestion carries the sentence that says where it came from.
// CONTEXT: Owner decisions D8/D9, 2026-09-11 (plan file, `open-items.md`
//          2.AI.10): the "next edit suggestion" surface starts with the
//          design query, as a row of accept-able suggestions under every DSL
//          editor. Most of what such a surface does for a six-line language
//          is deterministic: the business said Revenue is analysed by region
//          and segment, never by product name, that cost is better when lower,
//          that the calendar is the Date table. Those are `DesignStrategySummary`
//          fields, and a rule that reads one can explain itself in a way a
//          model cannot. The model's turn (Milestone B) comes AFTER these, for
//          what they cannot decide.
//
//          PURE, OVER A NEUTRAL FACTS SHAPE. `@api` may not import the DSL
//          parser (it lives in an extension), so the parsed query arrives
//          reduced to names (`QueryFacts`, built by
//          `_shared/dsl/pivotLayout/nextEditFacts.ts`), and an edit leaves as
//          an `EditOp` the same file applies to the TEXT — never a
//          re-serialisation of the person's query. The offline runner and the
//          corpus test drive this exact function.
//
//          THE RULES ARE A LIST. Each is one function with a name, a source
//          and a priority; the owner's later ideas for a richer strategy are
//          one more entry each. Two properties every rule keeps, and the
//          corpus test enforces the first: a rule never fires on a complete,
//          correct query (a suggestion that fights a right answer is a defect,
//          not a feature), and a rule's `reason` names the strategy field or
//          the structural fact it read.

import type { DesignMeasureHints, DesignQueryModel, DesignStrategySummary } from "./types";
import {
  TIME_GRAIN_YEAR,
  chooseCandidates,
  dslFieldRef,
  qualifiedToDsl,
  splitQualified,
  timeGrain,
} from "./candidates";

// ---------------------------------------------------------------------------
// The facts a query is reduced to
// ---------------------------------------------------------------------------

/** A field on an axis or in a filter, as the DSL spells it and as the strategy keys it. */
export interface FactField {
  /** DSL spelling: `Product.Category`, or `[Sales.Order Date]` when quoting is needed. */
  ref: string;
  /** `Table[Column]` when the reference is qualified; null for a bare name. */
  qualified: string | null;
}

export interface FactValue extends FactField {
  /** True for `[Measure]`; `ref` is then the bare measure name. */
  isMeasure: boolean;
  aggregation?: string;
  showAs?: string;
}

export interface FactFilter extends FactField {
  exclude: boolean;
  /** How many values the filter names. A single included value pins an axis to a constant. */
  valueCount: number;
}

export interface FactSort {
  ref: string;
  direction: "asc" | "desc";
}

export interface QueryFacts {
  rows: FactField[];
  columns: FactField[];
  values: FactValue[];
  filters: FactFilter[];
  sort: FactSort[];
  topN: { top: boolean; count: number; by: string } | null;
  layout: string[];
  hasParseErrors: boolean;
}

// ---------------------------------------------------------------------------
// The edits a rule may propose
// ---------------------------------------------------------------------------

export type AxisClause = "ROWS" | "COLUMNS";

export type EditOp =
  /** Add a field to a clause, creating the clause in canonical position when absent. `before` names an existing field to insert ahead of. */
  | { op: "add-field"; clause: "ROWS" | "COLUMNS" | "VALUES" | "FILTERS"; text: string; before?: string }
  /** Remove a field from an axis; the clause goes with its last field. */
  | { op: "remove-field"; clause: AxisClause; ref: string }
  /** Replace one field on an axis with another. */
  | { op: "replace-field"; clause: AxisClause; ref: string; text: string }
  /** Replace the ranking clause (TOP or BOTTOM) with `line`. */
  | { op: "replace-clause"; clause: "TOP" | "BOTTOM"; line: string }
  /** Add a whole clause LINE in canonical position; refused when the clause is already there. */
  | { op: "add-clause"; clause: string; line: string };

export type NextEditKind =
  | "add-values"
  | "add-rows"
  | "remove-never-slice"
  | "rank-direction"
  | "add-coarser-time"
  | "remove-filtered-axis"
  | "key-to-label"
  // --- EXPLORATIONS: offered when the query is already correct ---------------
  | "explore-columns"
  | "explore-time"
  | "explore-rank"
  | "explore-companion-measure"
  | "explore-share-of-total"
  | "explore-drill-level"
  | "explore-sort"
  /** Not a rule: the whole clause a model proposed, constrained by the grammar. */
  | "model-clause";

/**
 * What kind of thing a suggestion IS, which decides where it may appear and
 * when it may be offered.
 *
 * - `correction` — the query is incomplete, or it contradicts the strategy.
 *   Every original rule is one of these, which is why the row was silent on a
 *   finished query: measured over the corpus, 0 of 52 complete correct queries
 *   produced a chip, and stripping the strategy to null changed that number not
 *   at all. The quiet was the rule set, not the model's annotations.
 *
 * - `exploration` — the query is FINE, and here is something else worth looking
 *   at. These are the answer to "why does it so rarely say anything", and they
 *   are held to a different standard in two ways. They are offered only when no
 *   correction is outstanding, because "fix this" and "you could also…" in the
 *   same row makes the important one look optional. And they never reach the
 *   ghost text (owner decision 2026-09-14): a chip can be ignored at no cost,
 *   text at the cursor cannot, and the inline surface already refused a
 *   suggestion source for exactly that reason.
 */
export type NextEditRole = "correction" | "exploration";

export interface NextEditSuggestion {
  /** Stable for the same edit on the same query shape; what a dismissal remembers. */
  id: string;
  kind: NextEditKind;
  /** The chip's label: what accepting does, in the DSL's own words. */
  text: string;
  /** One sentence naming the strategy field or the fact the rule read. */
  reason: string;
  op: EditOp;
  /**
   * Where the suggestion came from. `model` never outranks a rule: a rule can
   * say WHY from the document, and a model can only say that it seemed likely.
   */
  source: "strategy" | "structure" | "model";
  /** Defaults to `correction` so an untagged suggestion keeps the old behaviour. */
  role?: NextEditRole;
  priority: number;
}

/** A suggestion's role, with the default applied. */
export function roleOfSuggestion(s: NextEditSuggestion): NextEditRole {
  return s.role ?? "correction";
}

/** Every rule-sourced suggestion outranks the model's, whatever it proposes. */
export const MODEL_CLAUSE_PRIORITY = 10;

/**
 * A next-clause reply turned into a suggestion, or null when the model said
 * nothing usable.
 *
 * PURE, and here rather than in the row, because the offline runner
 * (`tests/eval/run-next-edit-eval.mjs`) has to turn a reply into a suggestion
 * the same way the row does or its measured rate is a rate about the runner.
 * The grammar permits the empty reply — the prompt ends "if the query is
 * already complete, reply with nothing at all" — so null is an ANSWER here, not
 * a failure, and the rate at which it happens on a finished query is one of the
 * numbers the eval reports.
 */
export function nextClauseSuggestion(replyText: string, modelLabel: string): NextEditSuggestion | null {
  const line = replyText.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return null;
  const keyword = /^([A-Za-z]+)/.exec(line)?.[1]?.toUpperCase();
  if (!keyword) return null;
  return {
    id: `model-clause:${line}`,
    kind: "model-clause",
    text: `Add ${line}`,
    reason: `${modelLabel} suggests this next clause; Calcula checked it against the model before offering it.`,
    op: { op: "add-clause", clause: keyword, line },
    source: "model",
    priority: MODEL_CLAUSE_PRIORITY,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `[Sales.Order Date]`, `"Sales.Order Date"`, `Sales.Order Date` and
 * `sales.order date` are one name.
 *
 * Both quoting forms are stripped because both are spellings the DSL's own
 * serializer writes — `quoteIfNeeded` double-quotes any name with a space in
 * it — while the parser hands the rules the bare name.
 */
export function normalizeRef(ref: string): string {
  return ref
    .trim()
    .replace(/^\[(.*)\]$/s, "$1")
    .replace(/^"(.*)"$/s, "$1")
    .trim()
    .toLowerCase();
}

function sameRef(a: string, b: string): boolean {
  return normalizeRef(a) === normalizeRef(b);
}

/** Case-insensitive lookup of a measure's hints. */
function hintsFor(strategy: DesignStrategySummary | null | undefined, measure: string): DesignMeasureHints | null {
  if (!strategy) return null;
  const direct = strategy.measures[measure];
  if (direct) return direct;
  const key = Object.keys(strategy.measures).find((k) => k.toLowerCase() === measure.toLowerCase());
  return key ? strategy.measures[key] : null;
}

/** Whether `Table[Column]` names a column the model actually has. */
function modelHasColumn(model: DesignQueryModel, qualified: string): boolean {
  const parts = splitQualified(qualified);
  if (!parts) return false;
  const table = model.tables.find((t) => t.name.toLowerCase() === parts[0].toLowerCase());
  return Boolean(table && table.columns.some((c) => c.name.toLowerCase() === parts[1].toLowerCase()));
}

function roleOf(strategy: DesignStrategySummary | null | undefined, qualified: string | null): string | null {
  if (!strategy || !qualified) return null;
  const direct = strategy.columnRoles[qualified];
  if (direct) return direct;
  const key = Object.keys(strategy.columnRoles).find((k) => k.toLowerCase() === qualified.toLowerCase());
  return key ? strategy.columnRoles[key] : null;
}

/**
 * A table's label column, looked up the way every other strategy lookup here
 * works: exact key first, then case-insensitively. The document's table names
 * come from a human-edited file while the query's come from the model, and the
 * compiler resolves a table name case-insensitively — so a rule that did not
 * would go silent on a spelling everything else accepts.
 */
function labelColumnOf(strategy: DesignStrategySummary | null, table: string): string | undefined {
  if (!strategy) return undefined;
  const direct = strategy.labelColumns[table];
  if (direct) return direct;
  const key = Object.keys(strategy.labelColumns).find((k) => k.toLowerCase() === table.toLowerCase());
  return key ? strategy.labelColumns[key] : undefined;
}

/** The column part of a DSL reference: `[Sales.Order Date]` -> `Order Date`. */
function lastSegment(ref: string): string {
  const bare = ref.trim().replace(/^\[|\]$/g, "");
  const dot = bare.lastIndexOf(".");
  return dot >= 0 ? bare.slice(dot + 1) : bare;
}

interface RuleContext {
  facts: QueryFacts;
  model: DesignQueryModel;
  strategy: DesignStrategySummary | null;
  /** Names ranked the way the assistant ranks them; the time groupings are coarse first. */
  timeGroupings: string[];
  fallbackDimensions: string[];
  /** Every field on ROWS and COLUMNS. */
  axes: Array<{ clause: AxisClause; field: FactField }>;
  /** The measures in VALUES, bare names, lead measure first (the strategy's order). */
  measures: string[];
  /**
   * Every `Table[Column]` (lower-cased) that SOME measure in VALUES must never
   * be sliced by. Shared, because two rules need it: one to demand a removal,
   * and the others not to propose the very thing it will demand removing —
   * which is how the first version made the row oscillate between two chips.
   */
  forbidden: ReadonlySet<string>;
  /** The same set in DSL spelling, normalised, for comparing against candidate refs. */
  forbiddenRefs: ReadonlySet<string>;
  /**
   * Refs (normalised) that FILTERS pins to exactly one included value. An axis
   * over one of these can only ever draw one row, so a rule that offers one as
   * a breakdown walks the person straight back into the chip that removes it.
   */
  pinned: ReadonlySet<string>;
}

function onAnAxis(ctx: RuleContext, ref: string): boolean {
  return ctx.axes.some((a) => sameRef(a.field.ref, ref));
}

/** Is this `Table[Column]` forbidden for a measure currently in VALUES? */
function isForbidden(ctx: RuleContext, qualified: string | null): boolean {
  return qualified !== null && ctx.forbidden.has(qualified.toLowerCase());
}

function suggestion(
  kind: NextEditKind,
  text: string,
  reason: string,
  op: EditOp,
  source: NextEditSuggestion["source"],
  priority: number,
): NextEditSuggestion {
  return { id: `${kind}:${JSON.stringify(op)}`, kind, text, reason, op, source, priority };
}

/**
 * An EXPLORATION, which differs from `suggestion` in two ways that matter.
 *
 * Its priority is capped below every correction's, so the sort can never put
 * "you could also add a time axis" above "this query has no VALUES and cannot
 * compile". And it is tagged, which is what lets the ghost text drop the whole
 * family without knowing any individual rule.
 */
const EXPLORATION_MAX_PRIORITY = 40;

function exploration(
  kind: NextEditKind,
  text: string,
  reason: string,
  op: EditOp,
  source: NextEditSuggestion["source"],
  priority: number,
): NextEditSuggestion {
  return {
    id: `${kind}:${JSON.stringify(op)}`,
    kind,
    text,
    reason,
    op,
    source,
    role: "exploration",
    priority: Math.min(priority, EXPLORATION_MAX_PRIORITY),
  };
}

type Rule = (ctx: RuleContext) => NextEditSuggestion[];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** 1. A query with no VALUES cannot compile; the strategy's first measure is the one to start with. */
const missingValues: Rule = (ctx) => {
  if (ctx.facts.values.length > 0 || ctx.model.measures.length === 0) return [];
  const ordered = ctx.strategy?.measureOrder.find((m) => ctx.model.measures.some((x) => x.name === m));
  const measure = ordered ?? ctx.model.measures[0].name;
  return [
    suggestion(
      "add-values",
      `Add VALUES: [${measure}]`,
      ordered
        ? `Every query needs VALUES; ${measure} is first in the strategy's priority order.`
        : `Every query needs VALUES; ${measure} is the model's first measure.`,
      { op: "add-field", clause: "VALUES", text: `[${measure}]` },
      ordered ? "strategy" : "structure",
      100,
    ),
  ];
};

/** 2. A measure with no breakdown at all: the strategy says what it is analysed by. */
const breakdownForLeadMeasure: Rule = (ctx) => {
  if (ctx.facts.rows.length > 0 || ctx.facts.columns.length > 0 || ctx.measures.length === 0) return [];
  const lead = ctx.measures[0];
  const hints = hintsFor(ctx.strategy, lead);
  const fromStrategy = (hints?.analysisDimensions ?? [])
    .filter((q) => modelHasColumn(ctx.model, q))
    .filter((q) => !isForbidden(ctx, q))
    // A column FILTERS already pins to one value is not a breakdown: offering
    // it produces a one-row report and the "remove it from ROWS" chip, which
    // then produces this chip again. The corpus gate cannot see a two-chip
    // cycle, so the exclusion lives here rather than in a test.
    .filter((q) => !ctx.pinned.has(normalizeRef(qualifiedToDsl(q))))
    .map(qualifiedToDsl);
  if (fromStrategy.length > 0) {
    return [
      suggestion(
        "add-rows",
        `Add ROWS: ${fromStrategy[0]}`,
        `The strategy analyses ${lead} by ${fromStrategy[0]}.`,
        { op: "add-field", clause: "ROWS", text: fromStrategy[0] },
        "strategy",
        75,
      ),
    ];
  }
  const fallback = ctx.fallbackDimensions.find(
    (ref) => !ctx.pinned.has(normalizeRef(ref)) && !ctx.forbiddenRefs.has(normalizeRef(ref)),
  );
  if (!fallback) return [];
  return [
    suggestion(
      "add-rows",
      `Add ROWS: ${fallback}`,
      `${lead} has no breakdown yet; ${fallback} is the model's first dimension.`,
      { op: "add-field", clause: "ROWS", text: fallback },
      "structure",
      50,
    ),
  ];
};

// There is deliberately NO "also analyse by the next dimension" rule. The
// first version had one (rows present, no columns, offer the lead measure's
// next analysis dimension as COLUMNS) and the corpus gate refused it on its
// first run: it fired on 44 of 44 complete, correct references — "revenue by
// category" is finished, and a chip saying "also by segment" is the nag this
// engine exists not to be. A breakdown the person did not ask for is the
// model's territory, behind a request, not a rule's.

/** 3. A column the strategy forbids as a breakdown of a measure in VALUES. */
const neverSliceBy: Rule = (ctx) => {
  const out: NextEditSuggestion[] = [];
  for (const axis of ctx.axes) {
    if (!isForbidden(ctx, axis.field.qualified)) continue;
    // Name the measure that forbids it — the FIRST in the strategy's order,
    // which is the one the person is most likely reading the query for.
    const measure = ctx.measures.find((m) =>
      (hintsFor(ctx.strategy, m)?.neverSliceBy ?? []).some(
        (q) => q.toLowerCase() === (axis.field.qualified ?? "").toLowerCase(),
      ),
    );
    if (!measure) continue;
    out.push(
      suggestion(
        "remove-never-slice",
        `Remove ${axis.field.ref} from ${axis.clause}`,
        `The strategy says ${measure} is never sliced by ${axis.field.ref}.`,
        { op: "remove-field", clause: axis.clause, ref: axis.field.ref },
        "strategy",
        90,
      ),
    );
  }
  return out;
};

/** 4. TOP N over a measure that is better when lower lists the worst first. */
const rankDirection: Rule = (ctx) => {
  const top = ctx.facts.topN;
  if (!top || !top.top) return [];
  const hints = hintsFor(ctx.strategy, top.by);
  if (hints?.direction !== "lowerIsBetter") return [];
  const line = `BOTTOM ${top.count} BY [${top.by}]`;
  return [
    suggestion(
      "rank-direction",
      `Use ${line}`,
      `The strategy says ${top.by} is better when lower; TOP lists the worst first, BOTTOM the best.`,
      { op: "replace-clause", clause: "BOTTOM", line },
      "strategy",
      80,
    ),
  ];
};

/**
 * 5. A month, quarter or week on ROWS with no YEAR anywhere adds the same
 * period across every year — January 2023 and January 2024 in one row.
 *
 * THREE THINGS THIS RULE MUST NOT DO, each of them a defect the first version
 * shipped and an adversarial review found:
 *
 *  - It must not fire when the year is on COLUMNS. A month-down, year-across
 *    cross-tab is the most ordinary shape in the language and it already
 *    separates the years; the first version looked only at ROWS, called that
 *    query wrong, and its edit put the year on BOTH axes.
 *  - It must not fire when the coarsest grouping is not actually a YEAR. The
 *    groupings are name-derived, so a calendar whose columns are called
 *    `MonthNumberOfYear` and `WeekNumberOfYear` has no year column in the list
 *    at all — and the first version then offered the month while claiming it
 *    fixed the years.
 *  - It must not fire when a filter already pins the year to one value.
 *
 * The fine grain is still looked for on ROWS only: a fine grain on COLUMNS is
 * a deliberate layout, not a mistake.
 */
const coarserTimeGrain: Rule = (ctx) => {
  if (ctx.timeGroupings.length < 2) return [];
  const coarsest = ctx.timeGroupings[0];
  if (timeGrain(lastSegment(coarsest)) !== TIME_GRAIN_YEAR) return [];
  if (onAnAxis(ctx, coarsest)) return [];
  const fine = ctx.facts.rows.find((r) => ctx.timeGroupings.slice(1).some((g) => sameRef(g, r.ref)));
  if (!fine) return [];
  if (ctx.facts.filters.some((f) => sameRef(f.ref, coarsest) && !f.exclude)) return [];
  return [
    suggestion(
      "add-coarser-time",
      `Add ${coarsest} before ${fine.ref}`,
      ctx.strategy?.calendarTable
        ? `${fine.ref} without ${coarsest} adds the same period across every year (calendar: ${ctx.strategy.calendarTable}).`
        : `${fine.ref} without ${coarsest} adds the same period across every year.`,
      { op: "add-field", clause: "ROWS", text: coarsest, before: fine.ref },
      ctx.strategy?.calendarTable ? "strategy" : "structure",
      65,
    ),
  ];
};

/** 6. A column filtered to one value and also used as an axis is a constant column. */
const filteredAxis: Rule = (ctx) => {
  const out: NextEditSuggestion[] = [];
  for (const filter of ctx.facts.filters) {
    if (filter.exclude || filter.valueCount !== 1) continue;
    for (const axis of ctx.axes) {
      if (sameRef(axis.field.ref, filter.ref)) {
        out.push(
          suggestion(
            "remove-filtered-axis",
            `Remove ${axis.field.ref} from ${axis.clause}`,
            `FILTERS already pins ${filter.ref} to one value, so it can only show one ${axis.clause === "ROWS" ? "row" : "column"}.`,
            { op: "remove-field", clause: axis.clause, ref: axis.field.ref },
            "structure",
            85,
          ),
        );
      }
    }
  }
  return out;
};

/**
 * 7. A key column on an axis, where the strategy names the column a reader
 * recognises the row by.
 *
 * The label is skipped when a measure in VALUES must never be sliced by it —
 * the fixture's own positive control is exactly this shape (`Product` is
 * labelled by `Name`, and `Revenue` may never be sliced by `Product[Name]`),
 * and without the check this rule proposed the column rule 3 would then demand
 * be removed: two chips, each confident, undoing each other.
 */
const keyToLabel: Rule = (ctx) => {
  const out: NextEditSuggestion[] = [];
  for (const axis of ctx.axes) {
    if (roleOf(ctx.strategy, axis.field.qualified) !== "key" || !axis.field.qualified) continue;
    const parts = splitQualified(axis.field.qualified);
    const label = parts ? labelColumnOf(ctx.strategy, parts[0]) : undefined;
    if (!parts || !label) continue;
    if (isForbidden(ctx, `${parts[0]}[${label}]`)) continue;
    const text = dslFieldRef(parts[0], label);
    if (onAnAxis(ctx, text)) continue;
    out.push(
      suggestion(
        "key-to-label",
        `Replace ${axis.field.ref} with ${text}`,
        `${axis.field.ref} is a key; the strategy says ${parts[0]} rows are recognised by ${label}.`,
        { op: "replace-field", clause: axis.clause, ref: axis.field.ref, text },
        "strategy",
        70,
      ),
    );
  }
  return out;
};

// ---------------------------------------------------------------------------
// The explorations
// ---------------------------------------------------------------------------
//
// WHAT MAKES THESE HARDER THAN THE RULES ABOVE, and the reason they were left
// out of the first version.
//
// A correction is safe by construction: it fires because the query is broken, so
// applying it cannot make the query worse. An exploration fires on a query that
// is already RIGHT, which means every one of them is a guess about what the
// person wants next — and the corpus gate exists precisely to stop a rule
// fighting a correct query. One earlier rule was deleted by name for firing on
// 44 of 44 correct references.
//
// Three properties keep them honest, and each is checked by a test:
//
//  1. EVERY EXPLORATION TERMINATES. Applying it must make its own precondition
//     false, or the row offers the same idea forever. Each rule below adds
//     something and keys on that thing's absence.
//  2. EVERY EXPLORATION NAMES ITS EVIDENCE. The reason sentence cites a strategy
//     field or a fact about the model — never "this is common". A suggestion
//     that cannot say why is a nag.
//  3. NONE OF THEM REMOVES ANYTHING. An exploration only ever ADDS. That is what
//     makes the two-tier corpus gate possible: an addition the reference query
//     happens not to have is a difference of taste, while a removal of something
//     the reference keeps is a rule fighting a correct query.

/** E1. A single breakdown on ROWS and nothing on COLUMNS: a cross-tab is one click away. */
const exploreColumns: Rule = (ctx) => {
  if (ctx.measures.length === 0) return [];
  if (ctx.facts.rows.length === 0 || ctx.facts.columns.length > 0) return [];
  const lead = ctx.measures[0];
  const hints = hintsFor(ctx.strategy, lead);
  const fromStrategy = (hints?.analysisDimensions ?? [])
    .filter((q) => modelHasColumn(ctx.model, q))
    .filter((q) => !isForbidden(ctx, q))
    .map(qualifiedToDsl)
    .filter((ref) => !onAnAxis(ctx, ref) && !ctx.pinned.has(normalizeRef(ref)));
  // PREFER A DIFFERENT TABLE THAN THE ONES ALREADY ON AN AXIS.
  //
  // Measured on a real model: a query grouped by `dim_date.year` was offered
  // `dim_date.quarter` to cross it with — two columns of the same date
  // dimension. That is a legal cross-tab and almost never the interesting one;
  // what makes a cross-tab worth building is a SECOND subject, and the person
  // whose rows are years is far likelier to want products across the top than a
  // finer slice of the same calendar. (Year against quarter is also the shape
  // the coarser-time CORRECTION already owns, from the other direction.)
  const axisTables = new Set(
    ctx.axes
      .map((a) => splitQualified(a.field.qualified ?? "")?.[0]?.toLowerCase())
      .filter((t): t is string => Boolean(t)),
  );
  const usable = (ref: string): boolean =>
    !onAnAxis(ctx, ref) &&
    !ctx.pinned.has(normalizeRef(ref)) &&
    !ctx.forbiddenRefs.has(normalizeRef(ref));
  const tableOf = (ref: string): string => normalizeRef(ref).split(".")[0] ?? "";
  const fresh = ctx.fallbackDimensions.filter(
    (ref) => usable(ref) && !axisTables.has(tableOf(ref)),
  );
  const pick =
    fromStrategy[0] ??
    // A dimension from elsewhere first; anything usable only if the model has
    // nothing else to offer.
    fresh[0] ??
    ctx.fallbackDimensions.find(usable);
  if (!pick) return [];
  return [
    exploration(
      "explore-columns",
      `Add COLUMNS: ${pick}`,
      fromStrategy[0]
        ? `The strategy also analyses ${lead} by ${pick}; on COLUMNS it crosses with ${ctx.facts.rows[0].ref}.`
        : `${pick} is another dimension in the model; on COLUMNS it crosses with ${ctx.facts.rows[0].ref}.`,
      { op: "add-field", clause: "COLUMNS", text: pick },
      fromStrategy[0] ? "strategy" : "structure",
      38,
    ),
  ];
};

/** E2. The model has a calendar and the query ignores it entirely. */
const exploreTime: Rule = (ctx) => {
  if (ctx.measures.length === 0 || ctx.timeGroupings.length === 0) return [];
  // "No time anywhere" means no time grouping on either axis. A query already
  // grouped by time is the coarser-grain rule's business, not this one's.
  const anyTime = ctx.timeGroupings.some((g) => onAnAxis(ctx, g));
  if (anyTime) return [];
  const coarsest = ctx.timeGroupings[0];
  if (ctx.pinned.has(normalizeRef(coarsest)) || ctx.forbiddenRefs.has(normalizeRef(coarsest))) {
    return [];
  }
  // COLUMNS when free, ROWS otherwise: time reads naturally across the top, and
  // a second ROWS field nests rather than crosses.
  const clause: AxisClause = ctx.facts.columns.length === 0 ? "COLUMNS" : "ROWS";
  return [
    exploration(
      "explore-time",
      `Add ${clause}: ${coarsest}`,
      ctx.strategy?.timeAxis
        ? `This model's time axis is ${ctx.strategy.timeAxis} and the query has no time in it yet.`
        : `The model has a calendar and the query has no time in it yet.`,
      { op: "add-field", clause, text: coarsest },
      ctx.strategy?.timeAxis ? "strategy" : "structure",
      36,
    ),
  ];
};

/** E3. A breakdown with no ranking: the long tail is usually not the point. */
const exploreRank: Rule = (ctx) => {
  if (ctx.facts.topN) return [];
  if (ctx.facts.rows.length === 0 || ctx.measures.length === 0) return [];
  const measure = ctx.measures[0];
  const hints = hintsFor(ctx.strategy, measure);
  // A measure the strategy says is better LOW is ranked from the bottom; the
  // correction rule for getting this backwards already exists, and an
  // exploration that walked into it would be offering its own bug.
  const lower = hints?.direction === "lowerIsBetter";
  const keyword = lower ? "BOTTOM" : "TOP";
  return [
    exploration(
      "explore-rank",
      `Add ${keyword} 10 BY [${measure}]`,
      lower
        ? `The strategy says ${measure} is better when lower, so the interesting end is the bottom.`
        : `${ctx.facts.rows[0].ref} may have a long tail; ranking shows the ${measure} that matter.`,
      { op: "add-clause", clause: keyword, line: `${keyword} 10 BY [${measure}]` },
      lower ? "strategy" : "structure",
      34,
    ),
  ];
};

/** E4. The strategy ranks another measure next to this one and it is not shown. */
const exploreCompanionMeasure: Rule = (ctx) => {
  const order = ctx.strategy?.measureOrder ?? [];
  if (order.length < 2 || ctx.measures.length === 0) return [];
  const shown = new Set(ctx.measures.map((m) => m.toLowerCase()));
  const lead = ctx.measures[0].toLowerCase();
  const leadAt = order.findIndex((m) => m.toLowerCase() === lead);
  if (leadAt < 0) return [];
  // The neighbour in the strategy's own priority order — the measure whoever
  // annotated this model put next to the one on screen.
  const companion = order
    .slice(leadAt + 1)
    .find((m) => !shown.has(m.toLowerCase()) && ctx.model.measures.some((x) => x.name === m));
  if (!companion) return [];
  return [
    exploration(
      "explore-companion-measure",
      `Add VALUES: [${companion}]`,
      `The strategy ranks ${companion} next after ${ctx.measures[0]}.`,
      { op: "add-field", clause: "VALUES", text: `[${companion}]` },
      "strategy",
      32,
    ),
  ];
};

/** E5. One measure over a breakdown: the share is usually the question. */
const exploreShareOfTotal: Rule = (ctx) => {
  if (ctx.facts.values.length !== 1) return [];
  const only = ctx.facts.values[0];
  if (!only.isMeasure || only.showAs) return [];
  if (ctx.facts.rows.length === 0 && ctx.facts.columns.length === 0) return [];
  // The show-values-as is a BRACKETED SUFFIX, not an `AS` clause — `AS "Name"`
  // is the alias, a different thing entirely, and the serializer writes this
  // form as `[Revenue] [% of Grand Total]`. The first draft of this rule used
  // `AS` and produced a value field the compiler rejected, so the veto dropped
  // it and the rule was silently dead across the whole corpus.
  const text = `[${only.ref}] [% of Grand Total]`;
  return [
    exploration(
      "explore-share-of-total",
      `Add VALUES: ${text}`,
      `With one measure over a breakdown, the share of the total is often the readable form.`,
      { op: "add-field", clause: "VALUES", text },
      "structure",
      30,
    ),
  ];
};

/** E6. An axis sits on a hierarchy level that has a level beneath it. */
const exploreDrillLevel: Rule = (ctx) => {
  const hierarchies = ctx.model.hierarchies ?? [];
  if (hierarchies.length === 0) return [];
  for (const axis of ctx.axes) {
    const qualified = axis.field.qualified;
    if (!qualified) continue;
    for (const h of hierarchies) {
      const levels = h.levels ?? [];
      const at = levels.findIndex(
        (l) => `${h.table}[${l.column}]`.toLowerCase() === qualified.toLowerCase(),
      );
      if (at < 0 || at + 1 >= levels.length) continue;
      const child = qualifiedToDsl(`${h.table}[${levels[at + 1].column}]`);
      if (onAnAxis(ctx, child) || ctx.forbiddenRefs.has(normalizeRef(child))) continue;
      return [
        exploration(
          "explore-drill-level",
          `Add ${axis.clause}: ${child}`,
          `${h.name} goes ${axis.field.ref} → ${child}; adding the next level drills in.`,
          { op: "add-field", clause: axis.clause, text: child },
          "structure",
          28,
        ),
      ];
    }
  }
  return [];
};

/** E7. A ranked-looking report with no SORT reads in whatever order the model returns. */
const exploreSort: Rule = (ctx) => {
  if (ctx.facts.sort.length > 0 || ctx.facts.topN) return [];
  if (ctx.facts.rows.length === 0 || ctx.measures.length === 0) return [];
  const measure = ctx.measures[0];
  const lower = hintsFor(ctx.strategy, measure)?.direction === "lowerIsBetter";
  const dir = lower ? "ASC" : "DESC";
  return [
    exploration(
      "explore-sort",
      `Add SORT: [${measure}] ${dir}`,
      lower
        ? `Nothing orders these rows yet; ${measure} is better when lower, so ascending puts the best first.`
        : `Nothing orders these rows yet; sorting by ${measure} puts the largest first.`,
      { op: "add-clause", clause: "SORT", line: `SORT: [${measure}] ${dir}` },
      lower ? "strategy" : "structure",
      26,
    ),
  ];
};

/** The explorations, offered only when no correction is outstanding. */
export const EXPLORE_RULES: ReadonlyArray<{ name: NextEditKind; rule: Rule }> = [
  { name: "explore-columns", rule: exploreColumns },
  { name: "explore-time", rule: exploreTime },
  { name: "explore-rank", rule: exploreRank },
  { name: "explore-companion-measure", rule: exploreCompanionMeasure },
  { name: "explore-share-of-total", rule: exploreShareOfTotal },
  { name: "explore-drill-level", rule: exploreDrillLevel },
  { name: "explore-sort", rule: exploreSort },
];

/** The list. Order here is not rank; `priority` is. */
export const NEXT_EDIT_RULES: ReadonlyArray<{ name: NextEditKind; rule: Rule }> = [
  { name: "add-values", rule: missingValues },
  { name: "add-rows", rule: breakdownForLeadMeasure },
  { name: "remove-never-slice", rule: neverSliceBy },
  { name: "rank-direction", rule: rankDirection },
  { name: "add-coarser-time", rule: coarserTimeGrain },
  { name: "remove-filtered-axis", rule: filteredAxis },
  { name: "key-to-label", rule: keyToLabel },
];

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Every suggestion the rules make for this query, highest priority first,
 * ONE PER EDIT. A query that does not parse gets the structural rules only
 * as far as its facts go; the caller decides what a chip needs on top
 * (the compiler's blessing, a dismissal list).
 *
 * The dedupe is on the EDIT, not on the rule that proposed it. Two rules can
 * reach the same conclusion from different evidence — a column that is both
 * never-slice-by and pinned by a filter is removed for either reason — and the
 * first version showed that as two identical chips, spending two of the three
 * slots on one edit and leaving the second click a no-op. The higher-priority
 * rule's sentence is the one shown, because it is the more important reason.
 */
export function suggestNextEdits(facts: QueryFacts, model: DesignQueryModel): NextEditSuggestion[] {
  const strategy = model.strategy ?? null;
  const candidates = chooseCandidates(model, "");
  const order = new Map<string, number>();
  (strategy?.measureOrder ?? []).forEach((m, i) => order.set(m.toLowerCase(), i));
  const measures = facts.values
    .filter((v) => v.isMeasure)
    .map((v) => v.ref)
    .sort((a, b) => (order.get(a.toLowerCase()) ?? 999) - (order.get(b.toLowerCase()) ?? 999));

  const forbidden = new Set<string>();
  const forbiddenRefs = new Set<string>();
  for (const measure of measures) {
    for (const q of hintsFor(strategy, measure)?.neverSliceBy ?? []) {
      forbidden.add(q.toLowerCase());
      forbiddenRefs.add(normalizeRef(qualifiedToDsl(q)));
    }
  }
  const pinned = new Set(
    facts.filters.filter((f) => !f.exclude && f.valueCount === 1).map((f) => normalizeRef(f.ref)),
  );

  const ctx: RuleContext = {
    facts,
    model,
    strategy,
    timeGroupings: candidates.timeGroupings,
    fallbackDimensions: candidates.dimensions,
    axes: [
      ...facts.rows.map((field) => ({ clause: "ROWS" as const, field })),
      ...facts.columns.map((field) => ({ clause: "COLUMNS" as const, field })),
    ],
    measures,
    forbidden,
    forbiddenRefs,
    pinned,
  };

  const all: NextEditSuggestion[] = [];
  for (const { rule } of NEXT_EDIT_RULES) all.push(...rule(ctx));

  // EXPLORATIONS ONLY WHEN NOTHING IS WRONG.
  //
  // Corrections and explorations in the same row make the important one look
  // optional: "this query has no VALUES" and "you could also add a time axis"
  // are not two items on one list. So the explorations are asked only when the
  // corrections found nothing — which is also exactly the state the row used to
  // render as silence, and the state the person is in when they want ideas
  // rather than fixes.
  //
  // A query that does not parse gets nothing here either. Explorations reason
  // about a query's SHAPE, and the shape of a half-typed query is not a fact.
  if (all.length === 0 && !facts.hasParseErrors) {
    for (const { rule } of EXPLORE_RULES) all.push(...rule(ctx));
  }

  all.sort((a, b) => b.priority - a.priority || a.text.localeCompare(b.text));

  const seenEdit = new Set<string>();
  const out: NextEditSuggestion[] = [];
  for (const s of all) {
    const edit = JSON.stringify(s.op);
    if (seenEdit.has(edit)) continue;
    seenEdit.add(edit);
    out.push(s);
  }
  return out;
}
