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
//          (3) INFERENCE IS A DRAFT, NEVER AN ANSWER — AND IT HAPPENS ONCE,
//          IN RUST. This file used to carry a second inference ladder
//          (`inferStrategyDraft`) beside `insights/strategy/infer.rs`. Two
//          heuristics that disagree about what a column is FOR is a guarantee
//          of drift, and this one was measurably the worse: it matched
//          `dataType` against exact strings, but the backend sends
//          `format!("{:?}", data_type)`, so every `Decimal(38, 10)` column
//          matched nothing and fell through to `ignore`. It is gone. The
//          drafting op is `strategyInfer` (`strategyBackend.ts`), and what it
//          returns is still stamped `reviewed: false` — a person confirms it
//          row by row.
//
//          (4) WHO SAID SO IS A SEPARATE AXIS FROM WHETHER ANYONE AGREED.
//          `reviewed` answers "has a human confirmed this?"; `source` answers
//          "did a machine guess these values or did a person type them?". The
//          badge needs both, plus a third fact neither field carries — whether
//          the entry says ANYTHING at all — because a measure the document
//          never mentions and a measure a machine guessed at are not the same
//          row. `entryState` is the one place that ladder is decided.
//
//          (5) CONFIRMATION IS ABOUT VALUES, NOT ABOUT ROWS. `reviewed` says a
//          human vouched for what the entry SAYS, so an edit must drop it —
//          `authoringStamp` writes `source: "authored"` and `reviewed: false`
//          together, and only a patch that touches nothing but `reviewed` /
//          `source` leaves both alone. Confirm and un-confirm therefore cannot
//          re-author, and an edit cannot leave a stale confirmation standing
//          over a value nobody has read.
//
//          (6) DIVERGENCE IS COMPUTED, NEVER STORED. A row confirmed last week
//          can disagree with what inference would propose today — a column was
//          added, a measure renamed, calendar detection flipped. Rather than
//          storing a hash of the confirmed values (which needs maintaining on
//          every edit, goes stale in its own way, and knows nothing about a
//          document written before it existed), `measureDivergences` and its
//          siblings diff the entry against a fresh draft on every render. The
//          diff is SHOWN; nothing is ever applied without a person asking.

import type { ModelOverview } from "@api";

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
  /**
   * An acceptable range. Each bound carries its own inclusivity, and ABSENT
   * means inclusive — "between 0.8 and 1.2" is how a band is stated, so the
   * common case writes no key at all and the wire form of an ordinary band is
   * unchanged. Only an exclusive bound is spelled out, which is why a document
   * cannot acquire two new keys per band just by being opened.
   */
  | { type: "band"; low: number; high: number; lowInclusive?: boolean; highInclusive?: boolean }
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
  /**
   * Additivity EXCEPTIONS, keyed the way the engine looks them up: it tries
   * `Table[Column]` first, then a bare column name, then a bare table name. A
   * semi-additive balance is the case this exists for — additive over product
   * and region, last-value over the date table.
   */
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

/**
 * The model-wide block.
 *
 * It carries `reviewed`/`source` for the same reason every measure and table
 * entry does: `defaultTimeAxis` is a GUESS — inference picks it from a calendar
 * that was itself guessed — and a panel with no badge cannot tell a person that
 * the axis every time-series fact is computed against is nobody's decision yet.
 * The granularity is the PANEL, not the field: there is no per-field row here
 * to confirm, and four badges over four boxes would say less than one.
 */
export interface ModelStrategy {
  defaultTimeAxis?: string;
  /** `MM-DD`, e.g. "04-01" for an April fiscal year. */
  fiscalYearStart?: string;
  reportingCurrency?: string;
  /** Measure names, most important first. */
  priority?: string[];
  /** Has a human confirmed this panel? A generated draft is `false`. */
  reviewed: boolean;
  /** Where the values came from. Absent means the drafting op wrote them. */
  source?: StrategySource;
}

/**
 * Who put the VALUES in an entry.
 *
 * Absent on a document written before the field existed, which is why every
 * reader treats "absent" as `inferred` — the only way a pre-`source` entry got
 * its values was the drafting op.
 */
export type StrategySource = "inferred" | "authored";

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
  /** Where the values came from. Absent means the drafting op wrote them. */
  source?: StrategySource;
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
  /** Where the values came from. Absent means the drafting op wrote them. */
  source?: StrategySource;
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
 * Build a band, spelling out only the bounds that are EXCLUSIVE.
 *
 * The one constructor, so nothing anywhere writes `lowInclusive: true` — an
 * absent key already means inclusive, and a document that gains two redundant
 * keys per band every time someone opens the editor is a document nobody can
 * review a diff of.
 */
export function bandTarget(
  low: number,
  high: number,
  lowInclusive = true,
  highInclusive = true,
): Target {
  const band: Target = { type: "band", low, high };
  if (!lowInclusive) band.lowInclusive = false;
  if (!highInclusive) band.highInclusive = false;
  return band;
}

/** Is this bound inclusive? Absent means yes — see `bandTarget`. */
export function bandLowInclusive(band: { lowInclusive?: boolean }): boolean {
  return band.lowInclusive !== false;
}

export function bandHighInclusive(band: { highInclusive?: boolean }): boolean {
  return band.highInclusive !== false;
}

/**
 * `kpi` | `measure:<Name>` | `band:<low>,<high>` | a plain number.
 *
 * A band may carry INTERVAL BRACKETS — `band:[0.8,1.2)` — where `[`/`]` is an
 * inclusive bound and `(`/`)` an exclusive one. The bare `band:0.8,1.2` is the
 * both-inclusive spelling and stays exactly what it always was on the wire, so
 * an existing document neither changes shape nor re-reads differently.
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
    let body = raw.slice("band:".length).trim();
    let lowInclusive = true;
    let highInclusive = true;
    if (body.startsWith("[") || body.startsWith("(")) {
      if (!body.endsWith("]") && !body.endsWith(")")) {
        return {
          ok: false,
          error: `'${raw}' opens an interval and never closes it — write band:[0.8,1.2) or band:0.8,1.2`,
        };
      }
      lowInclusive = body.startsWith("[");
      highInclusive = body.endsWith("]");
      body = body.slice(1, -1);
    }
    const parts = body.split(",").map((p) => p.trim());
    if (parts.length !== 2) return { ok: false, error: "band: needs a low and a high, e.g. band:0.8,1.2" };
    const low = Number(parts[0]);
    const high = Number(parts[1]);
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      return { ok: false, error: `band bounds must be numbers (got '${raw}')` };
    }
    return { ok: true, target: bandTarget(low, high, lowInclusive, highInclusive) };
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
    case "band": {
      const lowIn = bandLowInclusive(target);
      const highIn = bandHighInclusive(target);
      // The ordinary band prints the way it always did. Brackets appear only
      // when they SAY something — a spelling that changed for every band would
      // rewrite every document that round-trips through this editor.
      if (lowIn && highIn) return `band:${target.low},${target.high}`;
      return `band:${lowIn ? "[" : "("}${target.low},${target.high}${highIn ? "]" : ")"}`;
    }
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

/** The model-wide block, or the unconfirmed blank a missing one means. */
export function modelEntry(doc: StrategyDoc): ModelStrategy {
  return doc.model ?? { reviewed: false };
}

export function columnEntry(
  doc: StrategyDoc,
  table: string,
  column: string,
): ColumnStrategy | undefined {
  return doc.tables?.[table]?.columns?.[column];
}

/**
 * Does this patch AUTHOR anything?
 *
 * Confirming an entry (`reviewed: true`) is a human act, but it does not make
 * the values human-written: the whole point of the tab is that a person can
 * agree with a machine's guess and still see it was a guess. So a patch that
 * touches only `reviewed` (or restates `source` itself) leaves the origin
 * alone; anything that changes, adds or CLEARS a value re-stamps it. Clearing
 * counts — deleting a guessed target is a decision a person made.
 */
function patchAuthorsValues(patch: object): boolean {
  return Object.keys(patch).some((key) => key !== "reviewed" && key !== "source");
}

/**
 * What an AUTHORING patch does to the entry's metadata, before the patch itself
 * is applied over it.
 *
 * Two stamps, and the second one was missing:
 *
 * `source: "authored"` — a row a person typed must never keep claiming a
 * machine guessed it.
 *
 * `reviewed: false` — CONFIRMATION IS ABOUT VALUES, NOT ABOUT ROWS. `reviewed`
 * is what the decomposition engine reads as "a human vouched for this", so an
 * entry that keeps `reviewed: true` across an edit is vouching for a value no
 * human ever saw. That is the same defect as a `{reviewed: true}` entry with no
 * reader, one step further along: the flag is read, and it is now false.
 *
 * The patch is spread AFTER, so an explicit `reviewed` in it still wins — which
 * is how the CLI's `set measure … unit=currency reviewed=true` states both
 * things in one act.
 */
function authoringStamp(patch: object): { source: StrategySource; reviewed: boolean } | null {
  return patchAuthorsValues(patch) ? { source: "authored", reviewed: false } : null;
}

/**
 * Immutably replace one measure entry, re-stamping `source` and dropping a
 * stale confirmation when the patch touches a value. See `authoringStamp`.
 */
export function withMeasure(
  doc: StrategyDoc,
  name: string,
  patch: Partial<MeasureStrategy>,
): StrategyDoc {
  const current = measureEntry(doc, name);
  const stamp = authoringStamp(patch);
  const authored: Partial<MeasureStrategy> = stamp === null ? patch : { ...stamp, ...patch };
  return { ...doc, measures: { ...(doc.measures ?? {}), [name]: { ...current, ...authored } } };
}

/** Immutably replace one table entry. Re-stamps like `withMeasure`. */
export function withTable(
  doc: StrategyDoc,
  name: string,
  patch: Partial<TableStrategy>,
): StrategyDoc {
  const current = tableEntry(doc, name);
  const stamp = authoringStamp(patch);
  const authored: Partial<TableStrategy> = stamp === null ? patch : { ...stamp, ...patch };
  return { ...doc, tables: { ...(doc.tables ?? {}), [name]: { ...current, ...authored } } };
}

/**
 * Immutably replace part of the model-wide block.
 *
 * The sibling of `withMeasure` / `withTable`, and it lives beside them rather
 * than in the panel that calls it: the model block carries the same
 * `reviewed`/`source` pair, so a second implementation of the stamping rule in
 * a component is a second place for it to drift.
 */
export function withModel(doc: StrategyDoc, patch: Partial<ModelStrategy>): StrategyDoc {
  const current = modelEntry(doc);
  const stamp = authoringStamp(patch);
  const authored: Partial<ModelStrategy> = stamp === null ? patch : { ...stamp, ...patch };
  return { ...doc, model: { ...current, ...authored } };
}

/** Immutably replace one column entry inside its table.
 *
 *  It writes through `withTable`, so setting a column's role also stamps the
 *  TABLE entry `authored` — the column map is part of what that entry says. */
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
// The three-state badge — what an entry SAYS, and who said it
// ---------------------------------------------------------------------------

/**
 * Every field of a measure entry that carries an actual VALUE.
 *
 * `reviewed` and `source` are metadata ABOUT the entry, not things it says, so
 * they are absent here on purpose. This list is enumerated rather than derived
 * from `Object.keys` because a key count cannot tell an empty array from a
 * value, and because a field added to `MeasureStrategy` and forgotten here
 * would make `measureHasValues` quietly answer "empty" about a row that says
 * something. `strategyTypes.test.ts` pins the list against
 * `Required<MeasureStrategy>` in both directions.
 */
export const MEASURE_VALUE_FIELDS = [
  "direction",
  "aggregation",
  "unit",
  "target",
  "materiality",
  "cadence",
  "priority",
  "analysisDimensions",
  "neverSliceBy",
  "context",
] as const;

/** The same list for a table entry. See `MEASURE_VALUE_FIELDS`. */
export const TABLE_VALUE_FIELDS = ["kind", "labelColumn", "columns", "hierarchies"] as const;

/** The same list for the model-wide block. See `MEASURE_VALUE_FIELDS`. */
export const MODEL_VALUE_FIELDS = [
  "defaultTimeAxis",
  "fiscalYearStart",
  "reportingCurrency",
  "priority",
] as const;

/** Does this measure entry state anything at all? */
export function measureHasValues(e: MeasureStrategy): boolean {
  return (
    e.direction !== undefined ||
    e.aggregation !== undefined ||
    e.unit !== undefined ||
    e.target !== undefined ||
    e.materiality !== undefined ||
    e.cadence !== undefined ||
    e.priority !== undefined ||
    (e.analysisDimensions?.length ?? 0) > 0 ||
    (e.neverSliceBy?.length ?? 0) > 0 ||
    (e.context ?? "").trim() !== ""
  );
}

/** Does this table entry state anything at all? */
export function tableHasValues(e: TableStrategy): boolean {
  return (
    e.kind !== undefined ||
    (e.labelColumn ?? "") !== "" ||
    Object.keys(e.columns ?? {}).length > 0 ||
    (e.hierarchies?.length ?? 0) > 0
  );
}

/** Does the model-wide block state anything at all? */
export function modelHasValues(e: ModelStrategy): boolean {
  return (
    (e.defaultTimeAxis ?? "") !== "" ||
    (e.fiscalYearStart ?? "") !== "" ||
    (e.reportingCurrency ?? "") !== "" ||
    (e.priority?.length ?? 0) > 0
  );
}

/**
 * What the row's badge says.
 *
 * `empty` — the document does not mention this measure or table, or mentions
 *   it and states nothing. `measureEntry`/`tableEntry` hand back
 *   `{ reviewed: false }` for a name the document never mentions, so without
 *   this state a never-set row and a machine-guessed row render identically.
 * `inferred` — values a machine proposed and nobody has agreed to yet.
 * `authored` — values a person typed and has not (or no longer) confirmed.
 * `confirmed` — a human said yes.
 */
export type EntryState = "empty" | "inferred" | "authored" | "confirmed";

/** The metadata half of an entry — the part `entryState` reads. */
export interface ReviewableEntry {
  reviewed: boolean;
  source?: StrategySource;
}

/**
 * Decide a row's badge from its metadata plus whether it says anything.
 *
 * EMPTY BEATS CONFIRMED, and that ordering is the point: `confirmAll` marks
 * every measure and table NAME reviewed, including the ones the document never
 * gave a value to. If `reviewed` won, a bulk confirm would paint "confirmed"
 * across rows that state nothing — a claim that someone agreed to a strategy
 * nobody wrote. Confirming an empty row states nothing, so it still reads
 * empty.
 *
 * An absent `source` reads as `inferred`: a document written before the field
 * existed can only have got its values from the drafting op.
 */
export function entryState(e: ReviewableEntry, hasValues: boolean): EntryState {
  if (!hasValues) return "empty";
  if (e.reviewed) return "confirmed";
  return e.source === "authored" ? "authored" : "inferred";
}

/** Do a human's fingerprints sit on this entry's values? Only those rows can
 *  be OVERTAKEN by inference — an inferred row that disagrees with today's
 *  inference is a stale draft, not a decision anybody has to be told about. */
export function stateIsHumanDecision(state: EntryState): boolean {
  return state === "confirmed" || state === "authored";
}

// ---------------------------------------------------------------------------
// Divergence — where a stored decision and today's inference disagree
// ---------------------------------------------------------------------------

/**
 * One field where the document and a fresh inference draft say different
 * things.
 *
 * IT IS COMPUTED LIVE, NEVER STORED. The alternative — hashing the values at
 * the moment of confirmation — needs maintaining on every edit, goes stale in
 * its own way, and says nothing at all about a document written before the
 * hash existed. Inference is model-only: it takes no engine lock and issues no
 * query, so re-running it on load costs a call the tab already makes.
 */
export interface Divergence {
  /** The document key, e.g. `direction`. */
  field: string;
  /** What the entry says today — `""` when it says nothing about this field. */
  yours: string;
  /** What inference proposes now. Never `""`: an absence is not a proposal. */
  inference: string;
}

/** Is this a value at all, or one of the several spellings of "nothing"? */
function statesSomething(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/** Key-sorted JSON, so two structurally equal values compare equal however
 *  their keys were ordered by whoever built them. */
function canonical(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * One field's value as a person reads it.
 *
 * The tagged unions get their own spelling because `[object Object]` beside
 * "you confirmed" is worse than saying nothing at all.
 */
export function formatFieldValue(field: string, value: unknown): string {
  if (!statesSomething(value)) return "";
  switch (field) {
    case "target":
      return formatTargetSpec(value as Target);
    case "materiality":
      return formatMaterialitySpec(value as Materiality);
    case "aggregation":
      return formatAggregationSpec(value as AggregationSpec);
    case "columns":
      return Object.entries(value as Record<string, ColumnStrategy>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, c]) => `${name}: ${c.role}`)
        .join(", ");
    case "hierarchies":
      return (value as string[][]).map((h) => h.join(" > ")).join("; ");
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/**
 * Every field where `proposed` says something the entry does not.
 *
 * A field inference is SILENT about is never a divergence: the draft proposes
 * what it can read off the model, and "no opinion" is not a disagreement. The
 * other direction does count — an entry silent where inference now proposes a
 * value is exactly the case a new column or a renamed measure creates, and it
 * is the one a confirmed row hides best.
 */
function divergencesOf<T extends object>(
  fields: readonly string[],
  entry: T,
  proposed: T | undefined,
): Divergence[] {
  if (proposed === undefined) return [];
  const out: Divergence[] = [];
  for (const field of fields) {
    const want = (proposed as Record<string, unknown>)[field];
    if (!statesSomething(want)) continue;
    const have = (entry as Record<string, unknown>)[field];
    if (canonical(have) === canonical(want)) continue;
    out.push({
      field,
      yours: formatFieldValue(field, have),
      inference: formatFieldValue(field, want),
    });
  }
  return out;
}

export function measureDivergences(
  entry: MeasureStrategy,
  proposed: MeasureStrategy | undefined,
): Divergence[] {
  return divergencesOf(MEASURE_VALUE_FIELDS, entry, proposed);
}

export function tableDivergences(
  entry: TableStrategy,
  proposed: TableStrategy | undefined,
): Divergence[] {
  return divergencesOf(TABLE_VALUE_FIELDS, entry, proposed);
}

export function modelDivergences(
  entry: ModelStrategy,
  proposed: ModelStrategy | undefined,
): Divergence[] {
  return divergencesOf(MODEL_VALUE_FIELDS, entry, proposed);
}

/**
 * The patch that takes inference's answer for exactly the diverging fields.
 *
 * It carries `source: "inferred"` and `reviewed: false` DELIBERATELY. The
 * values are the machine's, so calling them authored would be the same lie the
 * `source` axis exists to prevent; and nobody has yet vouched for the new
 * values, so the row goes back to being a proposal a person confirms. Taking
 * inference's value is one decision — "use this" — not two.
 */
export function inferenceTakePatch<T extends object>(
  proposed: T,
  divergences: Divergence[],
): Partial<T> & ReviewableEntry {
  const patch: Record<string, unknown> = { source: "inferred", reviewed: false };
  for (const d of divergences) patch[d.field] = (proposed as Record<string, unknown>)[d.field];
  return patch as Partial<T> & ReviewableEntry;
}

// ---------------------------------------------------------------------------
// The band direction — a statement that is only half made
// ---------------------------------------------------------------------------

/**
 * Is this entry claiming a band direction without a band?
 *
 * `targetBand` is the one direction that needs a second value to mean
 * anything: with no band the resolver has nothing to compare against, every
 * favourability comes back `None` and the measure's Variance fact is never
 * emitted — silently, because a missing fact looks exactly like a fact that
 * was never interesting. The Rust validator REFUSES the document in this state;
 * this predicate is what lets the tab say so at the keystroke instead of at
 * Save, and it deliberately mirrors that rule rather than inventing a stricter
 * one of its own.
 */
export function bandDirectionIsIncomplete(entry: {
  direction?: Direction;
  target?: Target;
}): boolean {
  return entry.direction === "targetBand" && entry.target?.type !== "band";
}

/**
 * Does ANY declaration in the document give this measure a band?
 *
 * SCOPE-BLIND, exactly like the Rust `has_a_band_anywhere`. A band declared on
 * the measure entry is a band a rule's `targetBand` direction can land on, so a
 * rule that only narrows the direction is legal and must stay authorable —
 * refusing it here would be a second, stricter rule nobody wrote down, which is
 * the failure mode the fiscal-year check already documents. What the caller is
 * catching is the measure whose band exists NOWHERE, which can never be judged.
 *
 * `exceptRule` leaves out the rule currently being edited: its own new `set` is
 * what the caller has just examined, and counting the version still in the
 * document would let a band the user has just deleted vouch for its own removal.
 *
 * A `kpi` target does not count, and that is the Rust rule too: a KPI resolves
 * to a literal target, never to a band.
 */
export function bandExistsAnywhere(
  doc: StrategyDoc,
  measure: string,
  exceptRule?: string,
): boolean {
  if (doc.measures?.[measure]?.target?.type === "band") return true;
  return (doc.rules ?? []).some(
    (r) => r.measure === measure && r.id !== exceptRule && r.set.target?.type === "band",
  );
}

// ---------------------------------------------------------------------------
// Aggregation — a default PLUS its exceptions
// ---------------------------------------------------------------------------

/** Human wording for an additivity, for a cell that has one line to say it in. */
export const ADDITIVITY_LABELS: Record<Additivity, string> = {
  additive: "additive",
  nonAdditive: "non-additive",
  lastValue: "last value",
  firstValue: "first value",
  average: "average",
  max: "max",
  min: "min",
};

/**
 * Change the default additivity, KEEPING the per-dimension exceptions.
 *
 * This is a data-loss fix. The editor used to write
 * `aggregation: v === "" ? undefined : { default: v }`, and because
 * `withMeasure` merges shallowly that REPLACED the whole spec — so picking a
 * default silently deleted `byDimension`. The Rust inferrer writes exactly
 * that map for a semi-additive balance (`{ <date table>: lastValue }`), and
 * the collapsed cell never showed it, so the map was invisible before it was
 * destroyed.
 *
 * Clearing the default (`next === undefined`) still drops the whole spec, and
 * that is not an oversight: `AggregationSpec.default` is REQUIRED on the Rust
 * side, so an exception list with nothing to be an exception TO cannot be
 * represented at all. Clearing is a deliberate, user-initiated erase; the
 * silent one was the bug.
 */
export function withAggregationDefault(
  spec: AggregationSpec | undefined,
  next: Additivity | undefined,
): AggregationSpec | undefined {
  if (next === undefined) return undefined;
  if (spec === undefined) return { default: next };
  return { ...spec, default: next };
}

/**
 * Add, change or remove ONE per-dimension exception.
 *
 * Removing the last exception leaves `byDimension` ABSENT rather than `{}`:
 * an empty map and a missing one mean the same thing to the reader but not to
 * a diff, and a document that gains a `"byDimension": {}` every time someone
 * opens the editor is a document nobody can review.
 *
 * With no spec there is nothing to make an exception to — the Rust type
 * requires a default — so this returns `undefined` rather than inventing
 * `additive` as one. Fabricating a default nobody chose is the same class of
 * lie this file's other helpers exist to prevent; the caller offers the
 * exception control only once a default is set.
 */
export function withAggregationException(
  spec: AggregationSpec | undefined,
  dimension: string,
  additivity: Additivity | undefined,
): AggregationSpec | undefined {
  if (spec === undefined) return undefined;
  const key = dimension.trim();
  if (key === "") return spec;
  const next: Record<string, Additivity> = { ...(spec.byDimension ?? {}) };
  if (additivity === undefined) delete next[key];
  else next[key] = additivity;
  if (Object.keys(next).length === 0) {
    const { byDimension: _dropped, ...rest } = spec;
    return rest;
  }
  return { ...spec, byDimension: next };
}

/** How many exceptions a collapsed cell spells out before it summarises. */
const AGGREGATION_EXCEPTIONS_SHOWN = 2;

/**
 * The collapsed cell text: `""`, `"additive"`, or
 * `"additive (Date: last value)"`.
 *
 * The exceptions are IN the summary because the bug they caused was that they
 * were not: a cell showing only `.default` gave no hint that anything else was
 * stored, so nobody could tell that editing the default was about to throw
 * something away. Exceptions are listed in dimension order (never insertion
 * order — a cell whose text depends on which key was typed first cannot be
 * asserted on), at most two, then `+N more`.
 */
export function formatAggregationSpec(spec: AggregationSpec | undefined): string {
  if (spec === undefined) return "";
  const base = ADDITIVITY_LABELS[spec.default] ?? spec.default;
  const exceptions = Object.entries(spec.byDimension ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (exceptions.length === 0) return base;
  const shown = exceptions
    .slice(0, AGGREGATION_EXCEPTIONS_SHOWN)
    .map(([dim, add]) => `${dim}: ${ADDITIVITY_LABELS[add] ?? add}`);
  const hidden = exceptions.length - shown.length;
  if (hidden > 0) shown.push(`+${hidden} more`);
  return `${base} (${shown.join(", ")})`;
}

/**
 * The dimensions a measure's aggregation may carry an exception for.
 *
 * A CLOSED list, and that is the requirement rather than a convenience: the
 * engine resolves `byDimension` by trying `Table[Column]`, then a bare column,
 * then a bare table, and a key that matches none of those is not an error
 * anywhere — it is an exception that never applies. A typo must therefore be
 * unreachable from the UI.
 *
 * It offers the bare TABLE spelling, which is what a person means by "over
 * Date": the measure's own table plus every table one active relationship away
 * from it, in either direction (a fact table is usually the from-side, but a
 * header/detail pair puts it on the other end). Names not in the model are
 * dropped — a relationship endpoint that names no table cannot be offered.
 */
export function aggregationDimensionOptions(
  overview: ModelOverview,
  measureTable: string,
): string[] {
  const known = new Set(overview.tables.map((t) => t.name));
  const neighbours = new Set<string>();
  for (const rel of overview.relationships) {
    if (!rel.active) continue;
    if (rel.fromTable === measureTable && known.has(rel.toTable)) neighbours.add(rel.toTable);
    if (rel.toTable === measureTable && known.has(rel.fromTable)) neighbours.add(rel.fromTable);
  }
  neighbours.delete(measureTable);
  const rest = [...neighbours].sort((a, b) => a.localeCompare(b));
  // The measure's own table leads: "over the fact grain" is the exception a
  // person reaches for first, and burying it alphabetically hides it.
  return known.has(measureTable) ? [measureTable, ...rest] : rest;
}

// ---------------------------------------------------------------------------
// Role ordering — how a table's columns are disclosed
// ---------------------------------------------------------------------------

/**
 * Roles most-useful-first.
 *
 * A table can have a hundred columns and a reader wants three of them: the
 * ones a report can be broken down by. So the two roles that may SCOPE a rule
 * lead, `label` (what a row is recognised by) follows, and `key`/`ignore` —
 * the columns that exist for the model's plumbing rather than for a reader —
 * sink to the bottom. Order lives here, not in the component, so the CLI can
 * print the same order later without a second opinion about what matters.
 */
export const ROLE_DISPLAY_ORDER: readonly Role[] = [
  "analysis",
  "hierarchy",
  "filter",
  "label",
  "key",
  "ignore",
];

/** A column as the disclosure sorts it: a name, and the role the document gave
 *  it (absent when the document has no entry for that column at all). */
export interface RoleSortableColumn {
  name: string;
  role?: Role;
}

/** Where a role sits in `ROLE_DISPLAY_ORDER`. An unclassified column ranks
 *  after every classified one, `ignore` included: "nobody has said what this is
 *  for" is a weaker claim than "not worth breaking down by", and that
 *  unclassified tail is exactly what a person opens a table to triage. */
function roleRank(role: Role | undefined): number {
  if (role === undefined) return ROLE_DISPLAY_ORDER.length;
  const at = ROLE_DISPLAY_ORDER.indexOf(role);
  return at < 0 ? ROLE_DISPLAY_ORDER.length : at;
}

/** Order two roles by `ROLE_DISPLAY_ORDER` alone. */
export function compareRoles(a: Role | undefined, b: Role | undefined): number {
  return roleRank(a) - roleRank(b);
}

/**
 * Sort by `ROLE_DISPLAY_ORDER`, then by name.
 *
 * It takes EITHER a column (`{ name, role }`) or a bare `Role`, and that is a
 * deliberate accommodation rather than a leftover: the same ordering is needed
 * both where the caller has whole columns to sort and where it has already
 * projected them down to roles and breaks its own name ties. Two spellings of
 * one order beat two orders. Given bare roles there is no name to fall back on,
 * so ties come back 0 and the caller's own tiebreak decides.
 */
export function compareColumnsByRole(
  a: Role | RoleSortableColumn,
  b: Role | RoleSortableColumn,
): number {
  const roleOf = (x: Role | RoleSortableColumn): Role | undefined =>
    typeof x === "string" ? x : x.role;
  const byRole = compareRoles(roleOf(a), roleOf(b));
  if (byRole !== 0) return byRole;
  if (typeof a === "string" || typeof b === "string") return 0;
  return a.name.localeCompare(b.name);
}
