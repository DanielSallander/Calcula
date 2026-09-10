// FILENAME: app/extensions/ModelEditor/cli/whereClause.ts
// PURPOSE: Evaluate a `where key=value` clause against the objects a target
//          pattern matched.
// CONTEXT: The CLI's globs match NAMES only (`matchTables`/`matchColumns`/
//          `matchRelationships` all glob on a name), so "every measure with no
//          format string" or "every visible key column" was inexpressible —
//          and those are exactly the sweeps a BI developer does before shipping
//          a model.
//
//          THE PROPERTY KEYS ARE THE SET-OPTION KEYS, deliberately. `set column
//          * hidden=true where hidden=false` uses ONE vocabulary in both
//          halves; a separate filter language would be a second thing to learn
//          and a second thing to drift. The readers below are therefore keyed
//          to `MODEL_OPTION_TABLES`' audited names, plus a small number of
//          read-only facts (a column's owning `table`, a relationship's
//          `from`/`to`) that you can filter on but not assign.
//
//          UNKNOWN KEYS ARE AN ERROR, NEVER A NON-MATCH. `where hiden=true`
//          (typo) silently matching nothing would look exactly like "no columns
//          are hidden", and the user would believe it.

import type {
  ModelColumnInfo,
  ModelMeasureInfo,
  ModelRelationshipInfo,
  ModelTableInfo,
} from "@api";
import type { WherePredicate } from "../../_shared/cli/parse";
import { CliError } from "./lex";

/** The kinds a `where` clause can filter, and what it can read on each. */
export type WhereKind = "column" | "measure" | "table" | "relationship";

/**
 * A property reader returns the value as a STRING, because the clause compares
 * strings. `null` means "unset", which compares equal to the empty value —
 * that is what makes `where format=` mean "has no format string".
 */
type Reader<T> = (obj: T) => string | null;

/** Booleans compare as `true`/`false`, matching how the option grammar writes
 *  them, so `hidden=true` reads the same on both sides of the command. */
const bool = (b: boolean): string => (b ? "true" : "false");

const COLUMN_READERS: Record<string, Reader<{ table: ModelTableInfo; column: ModelColumnInfo }>> = {
  hidden: ({ column }) => bool(column.isHidden),
  format: ({ column }) => column.formatString,
  type: ({ column }) => column.dataType,
  description: ({ column }) => column.description,
  displayname: ({ column }) => column.displayName,
  sortby: ({ column }) => column.sortByColumn,
  lookup: ({ column }) => column.lookupResolution,
  /** Read-only: the owning table. This is the key that makes
   *  `set column * hidden=true where table="Fact_Sales"` work at all. */
  table: ({ table }) => table.name,
  calculated: ({ column }) => bool(column.isCalculated),
};

const MEASURE_READERS: Record<string, Reader<ModelMeasureInfo>> = {
  hidden: (m) => bool(m.isHidden),
  format: (m) => m.formatString,
  formatexpr: (m) => m.formatStringExpression,
  folder: (m) => m.group,
  description: (m) => m.description,
  /** Read-only: the measure's home table. It is INFERRED from the formula and
   *  has no setter, so it can be filtered on but never assigned. */
  table: (m) => m.table,
};

const TABLE_READERS: Record<string, Reader<ModelTableInfo>> = {
  hidden: (t) => bool(t.isHidden),
  description: (t) => t.description,
  displayname: (t) => t.displayName,
  storage: (t) => t.storageMode,
  /** Read-only facts. */
  bound: (t) => bool(t.bound),
  source: (t) => t.sourceId,
};

const RELATIONSHIP_READERS: Record<string, Reader<ModelRelationshipInfo>> = {
  active: (r) => bool(r.active),
  cardinality: (r) => r.cardinality,
  propagation: (r) => r.filterPropagation,
  /** Read-only endpoints. */
  from: (r) => r.fromTable,
  to: (r) => r.toTable,
};

const READERS: Record<WhereKind, Record<string, Reader<never>>> = {
  column: COLUMN_READERS as Record<string, Reader<never>>,
  measure: MEASURE_READERS as Record<string, Reader<never>>,
  table: TABLE_READERS as Record<string, Reader<never>>,
  relationship: RELATIONSHIP_READERS as Record<string, Reader<never>>,
};

/** Kinds that accept a clause at all. */
export function whereKindOf(kind: string | null): WhereKind | null {
  return kind === "column" || kind === "measure" || kind === "table" || kind === "relationship"
    ? kind
    : null;
}

/** The filterable keys for a kind, for help and error messages. */
export function whereKeysFor(kind: WhereKind): string[] {
  return Object.keys(READERS[kind]).sort();
}

/**
 * Check every predicate names a readable property, BEFORE any matching runs.
 *
 * Separate from evaluation so a typo fails the whole command rather than
 * quietly filtering everything out — a `where` that matches nothing is
 * indistinguishable from a `where` that is spelled wrong, and one of those is
 * a true answer while the other is a lie.
 */
export function validateWhere(
  where: WherePredicate[],
  kind: string | null,
  line: number,
): WhereKind {
  const wk = whereKindOf(kind);
  if (!wk) {
    throw new CliError(
      `\`where\` cannot filter ${kind ?? "this"} — it is supported on column, measure, ` +
        `table and relationship`,
      line,
    );
  }
  const known = READERS[wk];
  for (const p of where) {
    if (!(p.key in known)) {
      throw new CliError(
        `\`where ${p.key}=…\` is not a property of a ${wk}. Try: ${whereKeysFor(wk).join(", ")}`,
        p.line,
      );
    }
  }
  return wk;
}

/** Does one object satisfy every predicate? */
export function matchesWhere<T>(obj: T, where: WherePredicate[], kind: WhereKind): boolean {
  const readers = READERS[kind] as unknown as Record<string, Reader<T>>;
  return where.every((p) => {
    const actual = readers[p.key](obj);
    // `null` (unset) and `""` are the same answer to "does it have one?", which
    // is what `where format=` asks.
    const lhs = (actual ?? "").trim();
    // Case-insensitive: the rest of this grammar matches names case-insensitively
    // (globToRegex), and `where storage=inmemory` failing on capitalisation
    // would be a rule that exists nowhere else in the language.
    return lhs.toLowerCase() === p.value.trim().toLowerCase();
  });
}

/** A human-readable rendering of the clause, for error messages. */
export function describeWhere(where: WherePredicate[]): string {
  return where.map((p) => `${p.key}=${p.value === "" ? "(empty)" : p.value}`).join(" and ");
}
