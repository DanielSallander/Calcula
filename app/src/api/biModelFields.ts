//! FILENAME: app/src/api/biModelFields.ts
// PURPOSE: The NAMES in the loaded semantic model — tables, columns, measures —
//          readable synchronously, so a decision that has to be made BEFORE a
//          model turn can ask "does this message name one of our fields?"
// CONTEXT: The intent router's `bi-query` rule (docs/design/ai-intent-router.md
//          §4b) is not vocabulary: "revenue by region" is a report request
//          because *revenue* and *region* are fields of the model that is open,
//          and no keyword table can imitate that. The chat reaches the model
//          only through TOOLS today, which means a model turn — the thing a
//          router runs before. So the names are cached here, warmed once per
//          connection and again on `bi:model-changed`, and read without a wait.
//
//          A SEAM, NOT ANOTHER HAND-ROLLED CALL. `get_connection_bi_model` is
//          already invoked directly by five extensions (Charts twice, Pivot,
//          Reports twice). This module invokes it through a caller-supplied
//          channel — `@api` binds no backend of its own — and is the one place
//          that decides what a "field name" is for matching purposes.
//
//          WHAT A FIELD NAME IS, for matching. A measure is `Revenue`; a column
//          is `SubcategoryName`; a person types "revenue", "subcategory" or
//          "subcategories". So every name is indexed lower-cased, and a
//          camel-case name is ALSO indexed by its parts — minus the parts that
//          are generic (`name`, `id`, `key`, `code`, `number`, `type`), which
//          would otherwise make "first and last name" look like a report about
//          `SubcategoryName`. Calendar columns are flagged, because a calendar
//          word on its own is a TIME EXPRESSION, not a report: "is this month
//          better than last month" names `Month` twice and wants an analysis.

import { onAppEvent } from "./events";

/** A connection's BI model, as the command returns it — only the parts read here. */
export interface ModelFieldsSource {
  tables?: ReadonlyArray<{ name: string; columns?: ReadonlyArray<{ name: string }> }>;
  measures?: ReadonlyArray<{ name: string }>;
}

/** The lower-cased names of one or more models, ready for word matching. */
export interface ModelFieldIndex {
  /** Measure names, lower-cased: `revenue`, `marginpct`. */
  readonly measures: ReadonlySet<string>;
  /** Column names that are not calendar columns, plus their non-generic parts. */
  readonly dimensions: ReadonlySet<string>;
  /** Calendar column names (`year`, `month`, `monthname`, `date`, ...). */
  readonly calendar: ReadonlySet<string>;
  /** Table names, lower-cased. */
  readonly tables: ReadonlySet<string>;
  /** How many connections contributed. Zero means "no model is loaded". */
  readonly connections: number;
}

export const EMPTY_MODEL_FIELDS: ModelFieldIndex = {
  measures: new Set(),
  dimensions: new Set(),
  calendar: new Set(),
  tables: new Set(),
  connections: 0,
};

/** Parts of a camel-case name that say nothing about the business. */
const GENERIC_PARTS = new Set(["name", "id", "key", "code", "number", "num", "type", "value", "desc", "description"]);

/** Column names (or parts) that denote a calendar grain rather than a business dimension. */
const CALENDAR_WORDS = new Set([
  "date", "day", "week", "month", "monthname", "monthnumber", "quarter", "year", "fiscalyear",
  "fiscalquarter", "period", "time", "hour", "minute",
]);

/** `SubcategoryName` -> ["subcategory", "name"]; `MarginPct` -> ["margin", "pct"]. */
function camelParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter((p) => p.length > 1);
}

/**
 * Build the index for one model. Pure; the seam below is its only stateful user.
 *
 * Exported on its own so an offline runner can build the same index from a
 * fixture file and score the router against exactly what the product would
 * see — a re-implementation in the runner would score the copy.
 */
export function buildModelFieldIndex(models: ReadonlyArray<ModelFieldsSource>): ModelFieldIndex {
  const measures = new Set<string>();
  const dimensions = new Set<string>();
  const calendar = new Set<string>();
  const tables = new Set<string>();

  for (const model of models) {
    for (const m of model.measures ?? []) {
      const lower = m.name.toLowerCase();
      measures.add(lower);
      for (const part of camelParts(m.name)) {
        if (!GENERIC_PARTS.has(part)) measures.add(part);
      }
    }
    for (const t of model.tables ?? []) {
      const tableLower = t.name.toLowerCase();
      tables.add(tableLower);
      // A table name is how people refer to its rows — "customers", "products".
      if (!CALENDAR_WORDS.has(tableLower)) dimensions.add(tableLower);
      for (const c of t.columns ?? []) {
        const lower = c.name.toLowerCase();
        const parts = camelParts(c.name);
        const isCalendar =
          CALENDAR_WORDS.has(lower) || CALENDAR_WORDS.has(tableLower) || parts.every((p) => CALENDAR_WORDS.has(p) || GENERIC_PARTS.has(p));
        const target = isCalendar ? calendar : dimensions;
        // A key column (`ProductKey`, `GeoKey`) is not something a person asks
        // for by name; its parts are all generic once "key" is removed... except
        // the entity ("product"), which the TABLE already contributes.
        if (/key$/i.test(c.name)) continue;
        target.add(lower);
        for (const part of parts) {
          if (GENERIC_PARTS.has(part)) continue;
          (CALENDAR_WORDS.has(part) ? calendar : target).add(part);
        }
      }
    }
  }

  return { measures, dimensions, calendar, tables, connections: models.length };
}

// ---------------------------------------------------------------------------
// The seam: a cache per connection, warmed by an injected invoker
// ---------------------------------------------------------------------------

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let invoker: Invoke | null = null;
const byConnection = new Map<string, ModelFieldsSource>();
let index: ModelFieldIndex = EMPTY_MODEL_FIELDS;
let override: ModelFieldIndex | null = null;

function rebuild(): void {
  index = buildModelFieldIndex([...byConnection.values()]);
}

/**
 * Bind the backend channel this seam warms through, and start refreshing on
 * `bi:model-changed`. Returns the unsubscribe. Call once, from an extension's
 * `activate()`, with that extension's own bound channel — `@api` binds nothing.
 */
export function configureModelFields(options: { invoke: Invoke }): () => void {
  invoker = options.invoke;
  const off = onAppEvent<{ connectionId?: string } | undefined>("bi:model-changed", (detail) => {
    const id = detail?.connectionId;
    // A changed connection is re-warmed; an event with no id re-warms them all,
    // because the alternative is serving names the Model Editor just renamed.
    const ids = id ? [id] : [...byConnection.keys()];
    void warmModelFields(ids);
  });
  return () => {
    off();
    if (invoker === options.invoke) invoker = null;
  };
}

/**
 * Fetch and cache the field names of these connections. Fails SOFT per
 * connection: a connection that cannot be described simply contributes nothing,
 * and the router falls back to its vocabulary rules for it.
 */
export async function warmModelFields(connectionIds: ReadonlyArray<string>): Promise<void> {
  if (!invoker) return;
  await Promise.all(
    connectionIds.map(async (connectionId) => {
      try {
        const info = await invoker!<ModelFieldsSource | null>("get_connection_bi_model", { connectionId });
        if (info) byConnection.set(connectionId, info);
        else byConnection.delete(connectionId);
      } catch {
        byConnection.delete(connectionId);
      }
    }),
  );
  rebuild();
}

/** The current index — synchronous, never stale-blocking, empty when no model is loaded. */
export function modelFieldIndex(): ModelFieldIndex {
  return override ?? index;
}

/** Drop everything cached. */
export function resetModelFields(): void {
  byConnection.clear();
  index = EMPTY_MODEL_FIELDS;
  override = null;
}

/** Tests: pin an index without any backend. `null` restores the real cache. */
export function __setModelFieldsForTest(next: ModelFieldIndex | null): void {
  override = next;
}
