//! FILENAME: app/src/api/designQueryAssist/candidates.ts
// PURPOSE: Decide which measure and dimension names a model is shown, and in
//          what order.
// CONTEXT: This is where the strategy layer is a real consumer outside the
//          insights engine. Section 2 of the strategy design doc lets
//          STRUCTURED attributes decide which things are offered and how they
//          rank; the declared priority order, the analysis dimensions, the
//          never-slice-by list and the column roles do exactly that here.
//          Prose never reaches this file.
//
//          THE CAP IS THE POINT. A 1.5B model holds a few dozen names in its
//          head; a warehouse model has hundreds of columns, most of them keys.
//          So: everything the request itself names comes first, then what the
//          strategy ranks, then the rest — and past the cap the prompt says
//          how many were left out, because a list presented as complete when
//          it is not is the quiet failure every other surface here refuses.
//
//          NAMES ARE MATCHED AS WORDS. "customers by region" should reach
//          `Customer.Segment` and `Geography.Region` through their word parts
//          ("customer", "region"), and a four-letter prefix match lets an
//          inflected word reach its stem — but "id" never matches "identity",
//          because a key column is exactly the thing this must NOT promote.

import type {
  DesignQueryCandidates,
  DesignQueryModel,
  DesignQueryTable,
} from "./types";

export const MAX_CANDIDATE_MEASURES = 20;
export const MAX_CANDIDATE_DIMENSIONS = 24;
export const MAX_CANDIDATE_NUMERIC_COLUMNS = 8;

/** A column that is a key by name. Demoted unless the strategy says otherwise. */
const KEY_SUFFIX = /(key|id|_id|guid)$/i;

const NUMERIC_TYPES = new Set([
  "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64",
  "float32", "float64", "decimal", "number", "integer", "float", "double",
]);

const DATE_TYPES = new Set(["date", "timestamp", "datetime", "date32", "date64"]);

/** Words too common to carry a match on their own. English and Swedish. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "each", "every",
  "per", "by", "of", "in", "on", "a", "an", "to", "as", "show", "me", "give",
  "report", "table", "pivot", "query", "list", "all", "top", "bottom", "total",
  "och", "för", "med", "som", "att", "den", "det", "till", "från", "varje", "per",
  "visa", "mig", "rapport", "tabell", "alla",
]);

/** `Product[Category]` -> `["Product", "Category"]`. Null when not that shape. */
export function splitQualified(qualified: string): [string, string] | null {
  const open = qualified.lastIndexOf("[");
  if (open <= 0 || !qualified.endsWith("]")) return null;
  return [qualified.slice(0, open), qualified.slice(open + 1, -1)];
}

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A `Table.Column` reference as the DSL spells it: dotted when both halves are
 * plain identifiers, bracket-quoted otherwise (the parser's escape hatch for
 * names with spaces or dots).
 */
export function dslFieldRef(table: string, column: string): string {
  return PLAIN_IDENT.test(table) && PLAIN_IDENT.test(column)
    ? `${table}.${column}`
    : `[${table}.${column}]`;
}

/** `Product[Category]` in DSL spelling, or the input unchanged when it is not qualified. */
export function qualifiedToDsl(qualified: string): string {
  const parts = splitQualified(qualified);
  return parts ? dslFieldRef(parts[0], parts[1]) : qualified;
}

/**
 * The word parts of a name, lowercased: CamelCase, underscores, dots, spaces
 * and digit boundaries all split. `OrderDate_2024` -> order, date, 2024.
 */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9åäöéü]+/)
    .filter((t) => t.length > 0);
}

/** The intent's words, stopwords removed. */
export function intentTokens(intent: string): Set<string> {
  const out = new Set<string>();
  for (const t of nameTokens(intent)) {
    if (t.length > 1 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/**
 * How many of a name's word parts the intent mentions.
 *
 * Exact first; then a prefix of at least four characters in EITHER direction,
 * so "customers" reaches "customer" and "region" reaches "regions". Two-letter
 * parts never prefix-match: "id" must not reach "identity".
 */
export function intentOverlap(tokens: Set<string>, name: string): number {
  let hits = 0;
  for (const part of nameTokens(name)) {
    if (tokens.has(part)) {
      hits++;
      continue;
    }
    if (part.length < 4) continue;
    for (const t of tokens) {
      if (t.length >= 4 && (t.startsWith(part) || part.startsWith(t))) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

function isNumericColumn(c: { dataType?: string; isNumeric?: boolean }): boolean {
  if (c.isNumeric !== undefined) return c.isNumeric;
  return c.dataType !== undefined && NUMERIC_TYPES.has(c.dataType.toLowerCase());
}

function isDateColumn(c: { dataType?: string }): boolean {
  return c.dataType !== undefined && DATE_TYPES.has(c.dataType.toLowerCase());
}

interface ScoredName {
  name: string;
  score: number;
  order: number;
}

function takeRanked(scored: ScoredName[], cap: number): { names: string[]; dropped: number } {
  scored.sort((a, b) => b.score - a.score || a.order - b.order || a.name.localeCompare(b.name));
  return {
    names: scored.slice(0, cap).map((s) => s.name),
    dropped: Math.max(0, scored.length - cap),
  };
}

/** The calendar table, from the strategy or from the table with a Date-typed column and a Year-like one. */
function calendarOf(model: DesignQueryModel): DesignQueryTable | null {
  const declared = model.strategy?.calendarTable;
  if (declared) {
    const t = model.tables.find((x) => x.name === declared);
    if (t) return t;
  }
  const withDate = model.tables.filter((t) => t.columns.some(isDateColumn));
  const withYear = withDate.find((t) =>
    t.columns.some((c) => /^(year|month|quarter|år|månad|kvartal)/i.test(c.name)),
  );
  return withYear ?? (withDate.length === 1 ? withDate[0] : null);
}

/**
 * Choose what to show the model.
 *
 * Measures: what the request names, then the strategy's order, then the rest by
 * name. Dimensions: what the request names, then the analysis dimensions of the
 * chosen measures, then columns the strategy roles `analysis`/`hierarchy`/
 * `filter` or names as a label, then calendar columns, then everything else
 * that is not a key — minus any column a chosen measure must never be sliced
 * by. Both lists are capped and the cap is reported.
 */
/** `timeGrain` for a column that names no period at all. */
export const TIME_GRAIN_NONE = 9;
/** The grain a year column has. Nothing is coarser. */
export const TIME_GRAIN_YEAR = 0;

/**
 * How coarse a calendar column is: year 0, quarter 1, month 2, week 3, and
 * `TIME_GRAIN_NONE` for a name that does not announce a period.
 *
 * NAME-BASED AND DELIBERATELY NARROW. It matches a name that STARTS with the
 * period word, in English or Swedish, which is what an inferred calendar's
 * columns are called in every model this has been run against. It therefore
 * answers `TIME_GRAIN_NONE` for `CalendarYear` and `MonthNumberOfYear`, and
 * that is the honest answer: this function is how the time rules decide
 * whether they may claim anything about years, and a rule that guesses wrong
 * about a column's grain states a falsehood to the user. Exported so those
 * rules ask instead of assuming that the first grouping is the year.
 */
export function timeGrain(columnName: string): number {
  const n = columnName.toLowerCase();
  if (/^(year|år)/.test(n)) return TIME_GRAIN_YEAR;
  if (/^(quarter|kvartal)/.test(n)) return 1;
  if (/^(month|månad)/.test(n)) return 2;
  if (/^(week|vecka)/.test(n)) return 3;
  return TIME_GRAIN_NONE;
}

/**
 * Does this calendar column REPEAT every year, or does it carry its own year?
 *
 * `timeGrain` answers how COARSE a column is and says nothing about this, and
 * conflating the two states a falsehood. `Month` in the fixture calendar holds
 * `"2024-01"`, `"2025-01"` — already year-qualified, so it never merges one
 * January into another. `MonthName` holds `"January"` and does. Both are grain 2.
 *
 * The coarser-time rule exists to warn that a fine grain "adds the same period
 * across every year". That sentence is TRUE of a cyclical column and FALSE of an
 * absolute one, and the rule stated it about `Date.Month` for three tasks before
 * this function existed (found 2026-09-15 when the corpus grew to 122 and gained
 * tasks that group by the absolute month).
 *
 * DELIBERATELY NARROW, AND THE ASYMMETRY IS THE POINT. It answers true only for a
 * period word carrying an explicit cyclical qualifier — `MonthName`,
 * `MonthNumber`, `QuarterOfYear`, `WeekNumber`, `DayOfWeek`. A BARE `Month` or
 * `Quarter` answers FALSE even though some model somewhere surely numbers its
 * months 1-12, because the two mistakes do not cost the same: saying "cyclical"
 * wrongly makes a CORRECTION fight a correct query, which the corpus gate forbids
 * outright, while saying "absolute" wrongly merely withholds a suggestion.
 */
export function isCyclicalPeriod(columnName: string): boolean {
  if (timeGrain(columnName) === TIME_GRAIN_NONE) return false;
  const n = columnName.toLowerCase();
  return /(name|namn|number|nummer|nr|ofyear|ofweek|ofmonth|index)/.test(n);
}

export function chooseCandidates(
  model: DesignQueryModel,
  intent: string,
  caps: { measures?: number; dimensions?: number; numericColumns?: number } = {},
): DesignQueryCandidates {
  const tokens = intentTokens(intent);
  const strategy = model.strategy ?? null;
  const measureCap = caps.measures ?? MAX_CANDIDATE_MEASURES;
  const dimensionCap = caps.dimensions ?? MAX_CANDIDATE_DIMENSIONS;
  const numericCap = caps.numericColumns ?? MAX_CANDIDATE_NUMERIC_COLUMNS;

  // --- Measures ---------------------------------------------------------
  const strategyRank = new Map<string, number>();
  (strategy?.measureOrder ?? []).forEach((m, i) => strategyRank.set(m, i));
  const measureNames = model.measures.map((m) => m.name);
  const scoredMeasures: ScoredName[] = measureNames.map((name, i) => {
    const mentioned = intentOverlap(tokens, name);
    const rank = strategyRank.get(name);
    // Named by the person: 1000 per matching word. Ranked by the business:
    // 100 minus the position. Else nothing, and the declaration order decides.
    const score = mentioned * 1000 + (rank !== undefined ? Math.max(1, 100 - rank) : 0);
    return { name, score, order: i };
  });
  const measures = takeRanked(scoredMeasures, measureCap);

  // The measures whose strategy hints shape the dimension list: the ones the
  // request names, else the top few by rank.
  const leadMeasures = scoredMeasures
    .filter((m) => m.score >= 1000)
    .map((m) => m.name)
    .concat(measures.names.slice(0, 3))
    .filter((v, i, a) => a.indexOf(v) === i);

  const analysisDims = new Set<string>();
  const neverSlice = new Set<string>();
  for (const name of leadMeasures) {
    const hints = strategy?.measures[name];
    if (!hints) continue;
    for (const d of hints.analysisDimensions) analysisDims.add(qualifiedToDsl(d));
    for (const d of hints.neverSliceBy) neverSlice.add(qualifiedToDsl(d));
  }

  // --- Dimensions -------------------------------------------------------
  const calendar = calendarOf(model);
  const roles = strategy?.columnRoles ?? {};
  const labels = new Set(
    Object.entries(strategy?.labelColumns ?? {}).map(([t, c]) => dslFieldRef(t, c)),
  );
  const scoredDims: ScoredName[] = [];
  const scoredNumeric: ScoredName[] = [];
  let order = 0;
  for (const table of model.tables) {
    const isCalendar = calendar !== null && table.name === calendar.name;
    for (const column of table.columns) {
      const ref = dslFieldRef(table.name, column.name);
      const role = roles[`${table.name}[${column.name}]`];
      order++;
      if (neverSlice.has(ref)) continue;
      const keyByName = KEY_SUFFIX.test(column.name);
      const keyByRole = role === "key";
      if (keyByRole || (keyByName && role === undefined)) continue;

      // The column's own words weigh more than its table's: "customers by
      // region" should lift Geography.Region above Customer.Name, and a table
      // word alone must not put every column of that table on the list.
      const mentioned = intentOverlap(tokens, column.name) * 1000 + intentOverlap(tokens, table.name) * 300;

      // A numeric column on a non-calendar table is a value to AGGREGATE, not
      // an axis to group by — unless the strategy says it is an analysis axis.
      // Checked BEFORE the `ignore` role: inference marks a fact table's amount
      // columns `ignore` precisely because they are not slicing axes, and
      // that says nothing about summing them.
      const numeric = isNumericColumn(column);
      if (numeric && !isCalendar && role !== "analysis" && role !== "hierarchy") {
        scoredNumeric.push({ name: ref, score: mentioned, order });
        continue;
      }
      if (role === "ignore") continue;

      let score = mentioned;
      if (analysisDims.has(ref)) score += 400;
      if (role === "analysis" || role === "hierarchy") score += 300;
      if (role === "filter") score += 200;
      if (labels.has(ref) || role === "label") score += 150;
      if (isCalendar) score += 100;
      scoredDims.push({ name: ref, score, order });
    }
  }
  const dimensions = takeRanked(scoredDims, dimensionCap);
  const numeric = takeRanked(scoredNumeric, numericCap);

  // --- Time ---------------------------------------------------------------
  let timeAxis: string | null = null;
  if (strategy?.timeAxis) {
    timeAxis = qualifiedToDsl(strategy.timeAxis);
  } else if (calendar) {
    const dateCol = calendar.columns.find(isDateColumn);
    if (dateCol) timeAxis = dslFieldRef(calendar.name, dateCol.name);
  }
  const timeGroupings: string[] = [];
  if (calendar) {
    const candidates = calendar.columns
      .filter((c) => {
        const role = roles[`${calendar.name}[${c.name}]`];
        return timeGrain(c.name) < TIME_GRAIN_NONE && !KEY_SUFFIX.test(c.name) && role !== "ignore" && role !== "key";
      })
      .sort((a, b) => timeGrain(a.name) - timeGrain(b.name) || a.name.localeCompare(b.name));
    for (const c of candidates) timeGroupings.push(dslFieldRef(calendar.name, c.name));
  }

  return {
    measures: measures.names,
    dimensions: dimensions.names,
    numericColumns: numeric.names,
    timeAxis,
    timeGroupings,
    droppedMeasures: measures.dropped,
    droppedDimensions: dimensions.dropped,
  };
}
