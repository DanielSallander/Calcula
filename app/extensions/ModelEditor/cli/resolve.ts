// FILENAME: app/extensions/ModelEditor/cli/resolve.ts
// PURPOSE: Name resolution for CLI targets: glob wildcards (* and ?) matched
//          case-insensitively against the current ModelOverview. Writes use
//          these to expand patterns into concrete objects; reads use them to
//          filter listings.

import type {
  ModelColumnInfo,
  ModelOverview,
  ModelRelationshipInfo,
  ModelTableInfo,
} from "@api";
import { CliError } from "./lex";
import type { ValueTok } from "./lex";

export function isPattern(s: string): boolean {
  return s.includes("*") || s.includes("?");
}

/** Compile a glob (`*` = any run, `?` = one char) to a case-insensitive,
 *  whole-string regex. A non-pattern compiles to an exact (ci) match. */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
}

export function globMatch(pattern: string, name: string): boolean {
  return globToRegex(pattern).test(name);
}

/** Filter names by a glob; exact (ci) names pass through unchanged. */
export function filterNames(pattern: string | null, names: string[]): string[] {
  if (pattern === null || pattern === "" || pattern === "*") return names;
  const re = globToRegex(pattern);
  return names.filter((n) => re.test(n));
}

// ---------------------------------------------------------------------------
// Kind-specific matchers
// ---------------------------------------------------------------------------

export function matchTables(overview: ModelOverview, pattern: string): ModelTableInfo[] {
  const re = globToRegex(pattern);
  return overview.tables.filter((t) => re.test(t.name) || (t.displayName !== null && re.test(t.displayName)));
}

/** Resolve a pattern to EXACTLY one table (writes that need a single home). */
export function requireTable(overview: ModelOverview, name: string, line: number): ModelTableInfo {
  const matches = matchTables(overview, name);
  if (matches.length === 0) throw new CliError(`No table matches '${name}'`, line);
  if (matches.length > 1) {
    throw new CliError(
      `'${name}' matches ${matches.length} tables (${matches.map((t) => t.name).join(", ")}) — be specific`,
      line,
    );
  }
  return matches[0];
}

export interface ColumnMatch {
  table: ModelTableInfo;
  column: ModelColumnInfo;
}

/** Match a `Table[Column]` reference (either part may be a glob). */
export function matchColumns(
  overview: ModelOverview,
  tablePattern: string,
  columnPattern: string,
): ColumnMatch[] {
  const tre = globToRegex(tablePattern);
  const cre = globToRegex(columnPattern);
  const out: ColumnMatch[] = [];
  for (const t of overview.tables) {
    if (!tre.test(t.name) && !(t.displayName !== null && tre.test(t.displayName))) continue;
    for (const c of t.columns) {
      if (cre.test(c.name) || (c.displayName !== null && cre.test(c.displayName))) {
        out.push({ table: t, column: c });
      }
    }
  }
  return out;
}

/** Match relationships by NAME pattern or by `from -> to` endpoint pattern.
 *  Endpoints may be bare tables (`* -> Customer`) or column refs
 *  (`Sales[CustomerId] -> Customer[Id]`, matched against any join condition). */
export function matchRelationships(
  overview: ModelOverview,
  namePattern: string | null,
  from: ValueTok | null,
  to: ValueTok | null,
): ModelRelationshipInfo[] {
  return overview.relationships.filter((r) => {
    if (namePattern !== null && !globMatch(namePattern, r.name)) return false;
    if (from && !endpointMatches(r, from, "from")) return false;
    if (to && !endpointMatches(r, to, "to")) return false;
    return true;
  });
}

function endpointMatches(
  r: ModelRelationshipInfo,
  tok: ValueTok,
  side: "from" | "to",
): boolean {
  const table = side === "from" ? r.fromTable : r.toTable;
  if (tok.kind === "colref") {
    if (!globMatch(tok.table ?? "*", table)) return false;
    const cre = globToRegex(tok.column ?? "*");
    return r.conditions.some((c) => cre.test(side === "from" ? c.fromColumn : c.toColumn));
  }
  return globMatch(tok.text, table);
}

/** Generic by-name matcher for list-shaped overview collections. */
export function matchNamed<T>(items: T[], nameOf: (item: T) => string, pattern: string): T[] {
  const re = globToRegex(pattern);
  return items.filter((it) => re.test(nameOf(it)));
}

/** Resolve to exactly one item or fail with a helpful message. */
export function requireOne<T>(
  items: T[],
  nameOf: (item: T) => string,
  pattern: string,
  kindLabel: string,
  line: number,
): T {
  const matches = matchNamed(items, nameOf, pattern);
  if (matches.length === 0) throw new CliError(`No ${kindLabel} matches '${pattern}'`, line);
  if (matches.length > 1) {
    throw new CliError(
      `'${pattern}' matches ${matches.length} ${kindLabel}s (${matches
        .slice(0, 6)
        .map(nameOf)
        .join(", ")}${matches.length > 6 ? ", …" : ""}) — be specific`,
      line,
    );
  }
  return matches[0];
}
