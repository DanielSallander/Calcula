// FILENAME: app/extensions/ModelEditor/lib/strategyTypes.ts
// PURPOSE: TypeScript mirrors of the insights strategy document
//          (app/src-tauri/src/insights/strategy/types.rs) plus the PURE
//          helpers both consumers share — the Strategy tab and the CLI verbs.
// CONTEXT: Three properties of the Rust side leak straight into this file and
//          must not be softened here.
//
//          (1) EVERY container carries `deny_unknown_fields`. A key this file
//          invents, or an `undefined`/`null` that survives serialization into
//          a `Vec`/`BTreeMap` field, is REFUSED by the backend rather than
//          ignored. That is why nothing is sent raw: `toWireDoc` prunes every
//          absent value, so what leaves here is exactly what the validator
//          judged and what the writer stored.
//
//          (2) A `QualifiedColumn` is the ONE string `Table[Column]` on the
//          wire — it is a map KEY in a scope, and a JSON object cannot have a
//          structured key. `parseQualifiedColumn` mirrors the Rust `FromStr`
//          character for character, including the refusal of a bracket inside
//          the column name.
//
//          (3) INFERENCE IS A DRAFT, NEVER AN ANSWER. `inferStrategyDraft`
//          reproduces the reasoning `facts.rs` uses to build the base layer —
//          KPI band ordering, the unit a format string implies, a table's
//          position in the relationship graph — and stamps every entry
//          `reviewed: false`. The whole point of the Strategy tab is that a
//          person can see at a glance which of these a machine guessed; an
//          inferred entry that arrived marked reviewed would erase exactly
//          that distinction.

import type {
  ModelColumnInfo,
  ModelOverview,
  ModelRelationshipInfo,
  ModelTableInfo,
} from "@api";

// ---------------------------------------------------------------------------
// Enumerations (mirrors of the Rust `rename_all = "camelCase"` unit enums)
// ---------------------------------------------------------------------------

export type Direction = "higherIsBetter" | "lowerIsBetter" | "targetBand" | "neutral";

export const DIRECTIONS: Direction[] = [
  "higherIsBetter",
  "lowerIsBetter",
  "targetBand",
  "neutral",
];

export type Additivity =
  | "additive"
  | "nonAdditive"
  | "lastValue"
  | "firstValue"
  | "average"
  | "max"
  | "min";

export const ADDITIVITIES: Additivity[] = [
  "additive",
  "nonAdditive",
  "lastValue",
  "firstValue",
  "average",
  "max",
  "min",
];

export type Unit = "currency" | "percent" | "ratio" | "count" | "duration" | "other";

export const UNITS: Unit[] = ["currency", "percent", "ratio", "count", "duration", "other"];

export type Cadence = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export const CADENCES: Cadence[] = ["daily", "weekly", "monthly", "quarterly", "yearly"];

/** What a column is FOR. Only analysis/filter/hierarchy may scope a rule. */
export type Role = "key" | "analysis" | "label" | "filter" | "hierarchy" | "ignore";

export const ROLES: Role[] = ["key", "analysis", "label", "filter", "hierarchy", "ignore"];

/** Roles a rule scope and a fact slice may name (mirrors `Role::may_scope`). */
export function roleMayScope(role: Role): boolean {
  return role === "analysis" || role === "filter" || role === "hierarchy";
}

export type TableKind = "fact" | "dimension" | "bridge" | "calendar" | "other";

export const TABLE_KINDS: TableKind[] = ["fact", "dimension", "bridge", "calendar", "other"];

export type ExpectedStatus = "favourable" | "unfavourable" | "neutral" | "suppressed";

// ---------------------------------------------------------------------------
// Tagged unions
//
// The strategy document is HAND-AUTHORED, so its wire shape was chosen for a
// person reading it rather than for serde's defaults. `Target` and
// `Materiality` are internally tagged (`{"type": "literal", "value": 0.38}`)
// and `ScopeValue` is untagged, so a member list is the bare array anyone would
// write. These mirror `app/src-tauri/src/insights/strategy/types.rs`; the Rust
// side pins the exact JSON in its own tests.
// ---------------------------------------------------------------------------

/** What "on target" means. A GOAL supplied by the business, never an observation. */
export type Target =
  | { type: "literal"; value: number }
  | { type: "measure"; ref: string }
  | { type: "band"; low: number; high: number }
  /** "Whatever the model's own KPI says." Resolution turns it into a number. */
  | { type: "kpi" };

/** The floor below which a movement is not worth saying out loud. */
export type Materiality =
  | { type: "absolute"; value: number }
  | { type: "relative"; value: number };

/**
 * One column's constraint inside a scope.
 *
 * A member list is a bare array. A date range omits `to` to mean "from this
 * date onwards", which is how a business rule is actually stated and what keeps
 * it true when next year's data arrives.
 */
export type ScopeValue =
  | string[]
  /** ISO-8601 bounds; the overlap checker compares them as TEXT. */
  | { from: string; to?: string };

/** column (`Table[Column]`) -> allowed members. An absent column is unconstrained. */
export type Scope = Record<string, ScopeValue>;

export interface AggregationSpec {
  default: Additivity;
  byDimension?: Record<string, Additivity>;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export const STRATEGY_DOC_VERSION = 1;

/** The one and only payload a rule may carry. It cannot introduce a number. */
export interface AttributeSet {
  direction?: Direction;
  target?: Target;
  materiality?: Materiality;
  cadence?: Cadence;
  aggregation?: AggregationSpec;
  /** Fact KINDS to withhold in this scope. It can only take facts away. */
  suppress?: string[];
  rankWeight?: number;
}

export interface ModelStrategy {
  defaultTimeAxis?: string;
  /** `MM-DD`, e.g. "04-01" for an April fiscal year. */
  fiscalYearStart?: string;
  reportingCurrency?: string;
  /** Measure names, most important first. */
  priority?: string[];
}

export interface MeasureStrategy {
  direction?: Direction;
  aggregation?: AggregationSpec;
  unit?: Unit;
  target?: Target;
  materiality?: Materiality;
  cadence?: Cadence;
  priority?: number;
  /** Columns worth breaking this measure down by (`Table[Column]`). */
  analysisDimensions?: string[];
  /** Columns that must never appear in a fact about this measure. */
  neverSliceBy?: string[];
  /** PROSE. Reaches wording and nothing else. */
  context?: string;
  /** Has a human confirmed this entry? A generated draft is `false`. */
  reviewed: boolean;
}

export interface ColumnStrategy {
  role: Role;
  priority?: number;
}

export interface TableStrategy {
  kind?: TableKind;
  /** The column a reader recognises a row by ("Product Name", not "ProductKey"). */
  labelColumn?: string;
  columns?: Record<string, ColumnStrategy>;
  hierarchies?: string[][];
  reviewed: boolean;
}

export interface Rule {
  id: string;
  measure: string;
  scope?: Scope;
  set: AttributeSet;
  /** PROSE. Wording only. */
  note?: string;
}

export interface PeriodAnnotation {
  id: string;
  measure?: string;
  scope?: Scope;
  note: string;
}

export interface TestGiven {
  delta: number;
  value?: number;
  baseline?: number;
}

export interface TestExpect {
  status: ExpectedStatus;
  decidedBy?: string;
}

export interface StrategyTest {
  measure: string;
  scope?: Scope;
  given: TestGiven;
  expect: TestExpect;
}

export interface StrategyDoc {
  version: number;
  model?: ModelStrategy;
  measures?: Record<string, MeasureStrategy>;
  tables?: Record<string, TableStrategy>;
  rules?: Rule[];
  periods?: PeriodAnnotation[];
  tests?: StrategyTest[];
}

// ---------------------------------------------------------------------------
// Findings (validate.rs)
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  /** A stable kebab-case code, so a UI can group and a test can assert. */
  code: string;
  /** Where in the document, e.g. `rules[2].scope` or `measures['Revenue']`. */
  path: string;
  message: string;
}

/** The shape `set` / `validate` / `runTests` / `delete` return. */
export interface StrategyOpResult {
  written: boolean;
  findings: Finding[];
}

export function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

/** Findings anchored at `path` or at anything nested under it.
 *
 *  A finding on `measures['Revenue'].direction` belongs to the Revenue ROW, so
 *  a bare equality test would leave the most specific findings — the ones that
 *  actually name a field — attached to nothing at all. */
export function findingsAtPath(findings: Finding[], path: string): Finding[] {
  return findings.filter(
    (f) => f.path === path || f.path.startsWith(`${path}.`) || f.path.startsWith(`${path}[`),
  );
}

export function measurePath(name: string): string {
  return `measures['${name}']`;
}

export function tablePath(name: string): string {
  return `tables['${name}']`;
}

export function rulePath(index: number): string {
  return `rules[${index}]`;
}

// ---------------------------------------------------------------------------
// QualifiedColumn — the `Table[Column]` wire string
// ---------------------------------------------------------------------------

export interface QualifiedColumn {
  table: string;
  column: string;
}

export function formatQualifiedColumn(qc: QualifiedColumn): string {
  return `${qc.table}[${qc.column}]`;
}

/** Mirrors the Rust `FromStr`: same acceptances, same refusals, same reasons. */
export function parseQualifiedColumn(
  text: string,
): { ok: true; value: QualifiedColumn } | { ok: false; reason: string } {
  const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  const open = text.indexOf("[");
  if (open < 0) return fail(`'${text}' is not a Table[Column] reference: no '[' in it`);
  if (!text.endsWith("]")) {
    return fail(`'${text}' is not a Table[Column] reference: it does not end with ']'`);
  }
  const table = text.slice(0, open).trim();
  const column = text.slice(open + 1, text.length - 1);
  if (table === "") return fail(`'${text}' is not a Table[Column] reference: the table name is empty`);
  if (column === "") return fail(`'${text}' is not a Table[Column] reference: the column name is empty`);
  if (column.includes("[") || column.includes("]")) {
    return fail(`'${text}' is not a Table[Column] reference: the column name contains a bracket`);
  }
  return { ok: true, value: { table, column } };
}

/** Every `Table[Column]` the model actually has, in table then column order. */
export function modelColumnRefs(overview: ModelOverview): string[] {
  return overview.tables.flatMap((t) => t.columns.map((c) => `${t.name}[${c.name}]`));
}

export function modelHasColumn(overview: ModelOverview, ref: string): boolean {
  const parsed = parseQualifiedColumn(ref);
  if (!parsed.ok) return false;
  const table = overview.tables.find((t) => t.name === parsed.value.table);
  return table !== undefined && table.columns.some((c) => c.name === parsed.value.column);
}

/**
 * Resolve a user-typed column reference against the MODEL.
 *
 * Accepts the qualified `Table[Column]` form, and a bare column name when the
 * model has exactly one column by that name. Everything else is an error with
 * a reason — never a best guess. A scope whose column does not exist is a rule
 * that silently never fires, which is indistinguishable from a rule the author
 * simply mis-typed, so this refuses rather than accepting free text.
 */
export function resolveColumnRef(
  overview: ModelOverview,
  text: string,
): { ok: true; ref: string } | { ok: false; error: string } {
  const raw = text.trim();
  if (raw === "") return { ok: false, error: "a column reference cannot be empty" };
  if (raw.includes("[")) {
    const parsed = parseQualifiedColumn(raw);
    if (!parsed.ok) return { ok: false, error: parsed.reason };
    const ref = formatQualifiedColumn(parsed.value);
    if (!modelHasColumn(overview, ref)) {
      return { ok: false, error: `'${ref}' is not a column in this model` };
    }
    return { ok: true, ref };
  }
  const matches = overview.tables
    .filter((t) => t.columns.some((c) => c.name === raw))
    .map((t) => `${t.name}[${raw}]`);
  if (matches.length === 1) return { ok: true, ref: matches[0] };
  if (matches.length === 0) {
    return { ok: false, error: `'${raw}' is not a column in this model` };
  }
  return {
    ok: false,
    error: `'${raw}' is ambiguous — ${matches.join(", ")} all match; qualify it as Table[Column]`,
  };
}

// ---------------------------------------------------------------------------
// Scope text form (`Dept=A;Region=Nordics,Baltics`)
// ---------------------------------------------------------------------------

const DATE_RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/**
 * Parse the CLI's scope spelling into a `Scope`.
 *
 * `Dept=A;Region=Nordics,Baltics` — semicolons separate columns, commas
 * separate members, and `from..to` (both ISO-8601) is a date range. Every
 * column is resolved against the model, so a typo is an error here rather than
 * a rule that never fires.
 */
export function parseScopeSpec(
  overview: ModelOverview,
  text: string,
): { ok: true; scope: Scope } | { ok: false; error: string } {
  const scope: Scope = {};
  const body = text.trim();
  if (body === "") return { ok: true, scope };
  for (const clause of body.split(";")) {
    const part = clause.trim();
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq < 0) {
      return {
        ok: false,
        error: `'${part}' is not a scope clause — write Column=Member[,Member] separated by ';'`,
      };
    }
    const resolved = resolveColumnRef(overview, part.slice(0, eq));
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (scope[resolved.ref] !== undefined) {
      return {
        ok: false,
        error: `'${resolved.ref}' is constrained twice in the same scope; a column may appear once`,
      };
    }
    const valueText = part.slice(eq + 1).trim();
    const range = DATE_RANGE_RE.exec(valueText);
    if (range) {
      scope[resolved.ref] = { from: range[1], to: range[2] };
      continue;
    }
    const members = valueText
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m !== "");
    if (members.length === 0) {
      return {
        ok: false,
        error: `'${resolved.ref}' is constrained to no members, so the scope is empty`,
      };
    }
    scope[resolved.ref] = members;
  }
  return { ok: true, scope };
}

/** The scope back as the text form the CLI accepts (and a grid cell shows). */
export function formatScopeSpec(scope: Scope | undefined): string {
  const entries = Object.entries(scope ?? {});
  if (entries.length === 0) return "";
  return entries
    .map(([col, value]) =>
      Array.isArray(value)
        ? `${col}=${value.join(",")}`
        : // An open-ended range prints its start and nothing after the dots,
          // which is how it is written and how it round-trips.
          `${col}=${value.from}..${value.to ?? ""}`,
    )
    .join("; ");
}

// ---------------------------------------------------------------------------
// Target / materiality text forms
// ---------------------------------------------------------------------------

/**
 * `kpi` | `measure:<Name>` | `band:<low>,<high>` | a plain number.
 *
 * An empty string means CLEAR, which is why the result distinguishes "no
 * target" from "could not read a target".
 */
export function parseTargetSpec(
  text: string,
): { ok: true; target: Target | undefined } | { ok: false; error: string } {
  const raw = text.trim();
  if (raw === "") return { ok: true, target: undefined };
  const lower = raw.toLowerCase();
  if (lower === "kpi") return { ok: true, target: { type: "kpi" } };
  if (lower.startsWith("measure:")) {
    const ref = raw.slice("measure:".length).trim();
    if (ref === "") return { ok: false, error: "measure: needs a measure name" };
    return { ok: true, target: { type: "measure", ref } };
  }
  if (lower.startsWith("band:")) {
    const parts = raw
      .slice("band:".length)
      .split(",")
      .map((p) => p.trim());
    if (parts.length !== 2) return { ok: false, error: "band: needs a low and a high, e.g. band:0.8,1.2" };
    const low = Number(parts[0]);
    const high = Number(parts[1]);
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      return { ok: false, error: `band bounds must be numbers (got '${raw}')` };
    }
    return { ok: true, target: { type: "band", low, high } };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      error: `'${raw}' is not a target — use a number, kpi, measure:<Name> or band:<low>,<high>`,
    };
  }
  return { ok: true, target: { type: "literal", value } };
}

export function formatTargetSpec(target: Target | undefined): string {
  if (target === undefined) return "";
  switch (target.type) {
    case "kpi":
      return "kpi";
    case "literal":
      return String(target.value);
    case "measure":
      return `measure:${target.ref}`;
    case "band":
      return `band:${target.low},${target.high}`;
  }
}

/** `2%` (relative) | `rel:0.02` | `abs:1000` | a plain number (absolute). */
export function parseMaterialitySpec(
  text: string,
): { ok: true; materiality: Materiality | undefined } | { ok: false; error: string } {
  const raw = text.trim();
  if (raw === "") return { ok: true, materiality: undefined };
  const lower = raw.toLowerCase();
  if (lower.endsWith("%")) {
    const pct = Number(raw.slice(0, -1).trim());
    if (!Number.isFinite(pct)) return { ok: false, error: `'${raw}' is not a percentage` };
    // A percentage is written as a FRACTION on the wire (0.02 for two percent),
    // which is what the resolver compares a delta against.
    return { ok: true, materiality: { type: "relative", value: pct / 100 } };
  }
  const prefixed = /^(rel|relative|abs|absolute):(.*)$/.exec(lower);
  if (prefixed) {
    const value = Number(prefixed[2].trim());
    if (!Number.isFinite(value)) return { ok: false, error: `'${raw}' is not a number` };
    return prefixed[1].startsWith("rel")
      ? { ok: true, materiality: { type: "relative", value } }
      : { ok: true, materiality: { type: "absolute", value } };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, error: `'${raw}' is not a materiality — use 1000, 2% or rel:0.02` };
  }
  return { ok: true, materiality: { type: "absolute", value } };
}

export function formatMaterialitySpec(m: Materiality | undefined): string {
  if (m === undefined) return "";
  return m.type === "absolute" ? String(m.value) : `${m.value * 100}%`;
}

// ---------------------------------------------------------------------------
// The wire form
// ---------------------------------------------------------------------------

/**
 * Strip every absent value before the document crosses IPC.
 *
 * `deny_unknown_fields` is only half the contract: the other half is that a
 * `null` where the Rust field is a `Vec` or a `BTreeMap` is a DESERIALIZATION
 * ERROR, not an omission. `JSON.stringify` drops `undefined` but keeps `null`,
 * and an object that has been through a React state update is full of both, so
 * the pruning is explicit here rather than left to the serializer.
 */
export function toWireDoc(doc: StrategyDoc): StrategyDoc {
  return pruneEmpty(doc) as StrategyDoc;
}

function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneEmpty);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw === undefined || raw === null) continue;
      if (Array.isArray(raw) && raw.length === 0) continue;
      if (
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        Object.keys(raw as object).length === 0 &&
        // `set: {}` is a legal (if pointless) rule payload the validator warns
        // about; dropping it would make the rule unreadable to serde, which
        // requires the field.
        key !== "set"
      ) {
        continue;
      }
      out[key] = pruneEmpty(raw);
    }
    return out;
  }
  return value;
}

export function emptyStrategyDoc(): StrategyDoc {
  return { version: STRATEGY_DOC_VERSION };
}

/** The entry for one measure, or the unconfirmed blank a missing entry means. */
export function measureEntry(doc: StrategyDoc, name: string): MeasureStrategy {
  return doc.measures?.[name] ?? { reviewed: false };
}

export function tableEntry(doc: StrategyDoc, name: string): TableStrategy {
  return doc.tables?.[name] ?? { reviewed: false };
}

export function columnEntry(
  doc: StrategyDoc,
  table: string,
  column: string,
): ColumnStrategy | undefined {
  return doc.tables?.[table]?.columns?.[column];
}

/** Immutably replace one measure entry. */
export function withMeasure(
  doc: StrategyDoc,
  name: string,
  patch: Partial<MeasureStrategy>,
): StrategyDoc {
  const current = measureEntry(doc, name);
  return { ...doc, measures: { ...(doc.measures ?? {}), [name]: { ...current, ...patch } } };
}

/** Immutably replace one table entry. */
export function withTable(
  doc: StrategyDoc,
  name: string,
  patch: Partial<TableStrategy>,
): StrategyDoc {
  const current = tableEntry(doc, name);
  return { ...doc, tables: { ...(doc.tables ?? {}), [name]: { ...current, ...patch } } };
}

/** Immutably replace one column entry inside its table. */
export function withColumn(
  doc: StrategyDoc,
  table: string,
  column: string,
  patch: Partial<ColumnStrategy>,
): StrategyDoc {
  const entry = tableEntry(doc, table);
  const current = entry.columns?.[column] ?? { role: "ignore" as Role };
  return withTable(doc, table, {
    columns: { ...(entry.columns ?? {}), [column]: { ...current, ...patch } },
  });
}

/** Add or replace a rule by id (ids are how a finding names its rule). */
export function withRule(doc: StrategyDoc, rule: Rule): StrategyDoc {
  const rules = doc.rules ?? [];
  const at = rules.findIndex((r) => r.id === rule.id);
  const next = at >= 0 ? rules.map((r, i) => (i === at ? rule : r)) : [...rules, rule];
  return { ...doc, rules: next };
}

export function withoutRule(doc: StrategyDoc, id: string): StrategyDoc {
  return { ...doc, rules: (doc.rules ?? []).filter((r) => r.id !== id) };
}

/** Mark every measure and table entry the document HAS as human-confirmed. */
export function confirmAll(doc: StrategyDoc, measures: string[], tables: string[]): StrategyDoc {
  let next = doc;
  for (const name of measures) next = withMeasure(next, name, { reviewed: true });
  for (const name of tables) next = withTable(next, name, { reviewed: true });
  return next;
}

// ---------------------------------------------------------------------------
// Inference — the draft a person then confirms
// ---------------------------------------------------------------------------

/**
 * The unit a number-format string implies.
 *
 * A port of `unit_from_format` (facts.rs), traps included: an escaped or quoted
 * percent sign is DECORATION, and reading `#,##0" %"` as a percent reports the
 * value a hundred times too small.
 */
export function unitFromFormat(format: string | null): Unit | undefined {
  if (!format) return undefined;
  let significant = "";
  let inQuotes = false;
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    significant += c;
  }
  if (significant.includes("%")) return "percent";
  const lower = significant.toLowerCase();
  if (
    lower.includes("[$") ||
    significant.includes("$") ||
    significant.includes("€") ||
    significant.includes("£") ||
    lower.includes("kr")
  ) {
    return "currency";
  }
  if (
    significant !== "" &&
    [...significant].every((c) => "#0, _-()".includes(c)) &&
    !significant.includes(".")
  ) {
    return "count";
  }
  return undefined;
}

/** Do the bands run bad -> good as the number grows? (`KpiFacts::ratio_ascending`) */
function bandsAscending(bands: number[]): boolean {
  return bands.length >= 2 && bands.every((b, i) => i === 0 || bands[i - 1] < b);
}

function bandsDescending(bands: number[]): boolean {
  return bands.length >= 2 && bands.every((b, i) => i === 0 || bands[i - 1] > b);
}

/** A table's position in the relationship graph (`classify_table` in facts.rs). */
function classifyTable(
  table: ModelTableInfo,
  dateTable: string | null,
  relationships: ModelRelationshipInfo[],
): TableKind {
  if (dateTable === table.name) return "calendar";
  const active = relationships.filter((r) => r.active);
  const fromSide = active.some((r) => r.fromTable === table.name);
  // Only a to-ONE endpoint makes the far side a lookup: a many-to-many
  // relationship has no dimension side, and calling one of its ends a dimension
  // is how a bridge table ends up offered as an analysis axis.
  const toSide = active.some(
    (r) =>
      r.toTable === table.name &&
      (r.cardinality === "manyToOne" || r.cardinality === "oneToOne"),
  );
  if (fromSide && !toSide) return "fact";
  if (!fromSide && toSide) return "dimension";
  if (fromSide && toSide) return "bridge";
  return "other";
}

const TEXT_TYPES = new Set(["String", "Utf8", "Text"]);
const DATE_TYPES = new Set(["Date", "Date32", "Date64", "Timestamp", "DateTime"]);

function isTextColumn(c: ModelColumnInfo): boolean {
  return TEXT_TYPES.has(c.dataType);
}

function isDateColumn(c: ModelColumnInfo): boolean {
  return DATE_TYPES.has(c.dataType) || c.dataType.startsWith("Timestamp");
}

/**
 * Guess one column's role.
 *
 * Deliberately conservative in ONE direction: a column it cannot place becomes
 * `ignore`, which only withholds a breakdown. Guessing `analysis` on an invoice
 * id produces one fact per record — a report that is technically true and
 * completely useless — so the doubt resolves towards saying less.
 */
function inferRole(
  table: ModelTableInfo,
  column: ModelColumnInfo,
  relationshipColumns: Set<string>,
  dateTable: string | null,
): Role {
  if (relationshipColumns.has(`${table.name}[${column.name}]`)) return "key";
  const lower = column.name.toLowerCase();
  if (lower === "id" || lower.endsWith("id") || lower.endsWith("key") || lower.endsWith("code")) {
    return "key";
  }
  if (dateTable === table.name && isDateColumn(column)) return "hierarchy";
  if (isTextColumn(column)) return "analysis";
  return "ignore";
}

/**
 * Build the unreviewed draft the Strategy tab shows before anyone confirms it.
 *
 * Everything here is a GUESS and is stamped `reviewed: false`, including the
 * entries it is most confident about. The tab's contrast between confirmed and
 * inferred is the product; a draft that arrived pre-confirmed would delete it.
 */
export function inferStrategyDraft(overview: ModelOverview): StrategyDoc {
  const doc: StrategyDoc = { version: STRATEGY_DOC_VERSION };

  const relationshipColumns = new Set<string>();
  for (const rel of overview.relationships) {
    if (!rel.active) continue;
    for (const cond of rel.conditions) {
      relationshipColumns.add(`${rel.fromTable}[${cond.fromColumn}]`);
      relationshipColumns.add(`${rel.toTable}[${cond.toColumn}]`);
    }
  }

  const tables: Record<string, TableStrategy> = {};
  for (const table of overview.tables) {
    const columns: Record<string, ColumnStrategy> = {};
    for (const column of table.columns) {
      columns[column.name] = {
        role: inferRole(table, column, relationshipColumns, overview.dateTable),
      };
    }
    // The label column is what a reader recognises a row by, so a key never
    // qualifies however text-like its name is.
    const label = table.columns.find(
      (c) => isTextColumn(c) && columns[c.name].role !== "key",
    );
    tables[table.name] = {
      kind: classifyTable(table, overview.dateTable, overview.relationships),
      labelColumn: label?.name,
      columns,
      reviewed: false,
    };
  }
  doc.tables = tables;

  const kpiByMeasure = new Map(overview.kpis.map((k) => [k.baseMeasure, k]));
  const measures: Record<string, MeasureStrategy> = {};
  for (const measure of overview.measures) {
    const kpi = kpiByMeasure.get(measure.name);
    const bands = kpi?.statusBands.map((b) => b.threshold) ?? [];
    let direction: Direction | undefined;
    if (bandsAscending(bands)) direction = "higherIsBetter";
    else if (bandsDescending(bands)) direction = "lowerIsBetter";
    measures[measure.name] = {
      direction,
      unit: unitFromFormat(measure.formatString),
      // A model KPI already states the goal; inheriting it beats inventing one.
      target: kpi ? { type: "kpi" as const } : undefined,
      reviewed: false,
    };
  }
  doc.measures = measures;

  return doc;
}
