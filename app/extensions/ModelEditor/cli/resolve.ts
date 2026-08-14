// FILENAME: app/extensions/ModelEditor/cli/resolve.ts
// PURPOSE: MODEL-specific name resolution for CLI targets. The generic glob
//          machinery (isPattern/globToRegex/globMatch/filterNames/matchNamed/
//          requireOne) moved to the shared kernel and is re-exported here so
//          readers/writers/tests import unchanged; the ModelOverview matchers
//          (tables, columns, relationships) are this domain's own.

import type {
  ModelColumnInfo,
  ModelOverview,
  ModelRelationshipInfo,
  ModelTableInfo,
} from "@api";
import { CliError } from "./lex";
import type { ValueTok } from "./lex";
import { globMatch, globToRegex } from "../../_shared/cli/glob";

export {
  filterNames,
  globMatch,
  globToRegex,
  isPattern,
  matchNamed,
  requireOne,
} from "../../_shared/cli/glob";

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
