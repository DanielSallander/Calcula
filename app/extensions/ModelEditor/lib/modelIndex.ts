// FILENAME: app/extensions/ModelEditor/lib/modelIndex.ts
// PURPOSE: A flat, searchable index of every named object in the model.
// CONTEXT: There was NO search of any kind in this window. The only two search
//          inputs in the whole editor were inside the CLI reference pane and
//          the function-docs panel — neither of which finds a measure. On a
//          300-measure model the only way to reach an object was to know which
//          of twenty sections owned it and then scroll.
//
//          Built entirely from the `ModelOverview` the app ALREADY HOLDS, so
//          opening the palette costs ZERO backend calls and cannot be stale
//          relative to what is on screen — it is derived from the same object
//          every section renders.

import type { ModelOverview } from "@api";
import type { SectionId } from "../components/editorShared";

/** What kind of thing an entry is — drives the group heading and the icon. */
export type IndexKind =
  | "table"
  | "column"
  | "measure"
  | "relationship"
  | "hierarchy"
  | "kpi"
  | "calcGroup"
  | "calcItem"
  | "calcTable"
  | "tableVariable"
  | "context"
  | "contextColumn"
  | "scriptFunction"
  | "role"
  | "perspective"
  | "culture"
  | "source"
  | "writeback"
  | "section";

export interface IndexEntry {
  kind: IndexKind;
  /** The name typed against. */
  name: string;
  /** Owning table / folder / source, shown as secondary text. */
  context?: string;
  /** Where selecting it goes. */
  section: SectionId;
  /** What to select once there. For a column this is its TABLE, because the
   *  Tables section selects tables, not columns. */
  selection?: string;
  /** Extra text that should match but is not displayed (e.g. a formula). */
  haystack?: string;
}

/** Group heading + display order for each kind. */
export const KIND_LABEL: Record<IndexKind, string> = {
  table: "Tables",
  column: "Columns",
  measure: "Measures",
  relationship: "Relationships",
  hierarchy: "Hierarchies",
  kpi: "KPIs",
  calcGroup: "Calculation groups",
  calcItem: "Calculation items",
  calcTable: "Calculated tables",
  tableVariable: "Table variables",
  context: "Contexts",
  contextColumn: "Context columns",
  scriptFunction: "Script functions",
  role: "Security roles",
  perspective: "Perspectives",
  culture: "Translations",
  source: "Sources",
  writeback: "Writeback columns",
  section: "Go to",
};

const KIND_ORDER: IndexKind[] = [
  "measure",
  "table",
  "column",
  "relationship",
  "hierarchy",
  "kpi",
  "calcGroup",
  "calcItem",
  "calcTable",
  "tableVariable",
  "context",
  "contextColumn",
  "scriptFunction",
  "role",
  "perspective",
  "culture",
  "source",
  "writeback",
  "section",
];

/** `measure:` / `table:` / `column:` … scope prefixes the user can type. */
const SCOPE_WORDS: Record<string, IndexKind> = {
  measure: "measure",
  measures: "measure",
  table: "table",
  tables: "table",
  column: "column",
  columns: "column",
  relationship: "relationship",
  rel: "relationship",
  hierarchy: "hierarchy",
  kpi: "kpi",
  context: "context",
  role: "role",
  source: "source",
  section: "section",
};

/** Every rail destination, so the palette can also just navigate. */
const SECTION_ENTRIES: Array<{ name: string; section: SectionId }> = [
  { name: "Overview", section: "overview" },
  { name: "Connections", section: "connections" },
  { name: "Import", section: "import" },
  { name: "Settings", section: "settings" },
  { name: "Tables", section: "tables" },
  { name: "Relationships", section: "relationships" },
  { name: "Hierarchies", section: "hierarchies" },
  { name: "Lineage", section: "lineage" },
  { name: "Measures", section: "measures" },
  { name: "Calculation Groups", section: "calcGroups" },
  { name: "Script Functions", section: "scriptFunctions" },
  { name: "Calculated Tables", section: "globals" },
  { name: "Table Variables", section: "tableVariables" },
  { name: "Contexts", section: "contexts" },
  { name: "Security Roles", section: "roles" },
  { name: "Perspectives", section: "perspectives" },
  { name: "Translations", section: "translations" },
  { name: "KPIs", section: "kpis" },
  { name: "Strategy", section: "strategy" },
  { name: "Testing Ground", section: "testing" },
];

/**
 * Flatten a model into searchable entries.
 *
 * Columns are included even though there can be thousands of them: on a real
 * model "which table holds `postalcode`" is a question people actually have,
 * and the alternative — opening tables one at a time — is the thing this
 * replaces. Ranking keeps them below their own table so they never bury it.
 */
export function buildModelIndex(overview: ModelOverview | null): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const s of SECTION_ENTRIES) out.push({ kind: "section", name: s.name, section: s.section });
  if (!overview) return out;

  for (const t of overview.tables) {
    out.push({
      kind: "table",
      name: t.name,
      context: t.displayName ?? undefined,
      section: "tables",
      selection: t.name,
    });
    for (const c of t.columns) {
      out.push({
        kind: "column",
        name: c.name,
        context: t.name,
        section: "tables",
        // The Tables section selects a TABLE; the column is what you were
        // looking for, the table is where it lives.
        selection: t.name,
        haystack: c.formula ?? undefined,
      });
    }
  }

  for (const m of overview.measures) {
    out.push({
      kind: "measure",
      name: m.name,
      // The FOLDER, not the inferred home table: the folder is what the author
      // chose and what the Measures tree is organised by.
      context: m.group ?? m.table,
      section: "measures",
      selection: m.name,
      haystack: m.formula,
    });
  }

  for (const r of overview.relationships) {
    out.push({
      kind: "relationship",
      name: r.name,
      context: `${r.fromTable} → ${r.toTable}`,
      section: "relationships",
      selection: r.name,
    });
  }
  for (const h of overview.hierarchies) {
    out.push({ kind: "hierarchy", name: h.name, context: h.table, section: "hierarchies", selection: h.name });
  }
  for (const k of overview.kpis) {
    out.push({ kind: "kpi", name: k.name, context: k.baseMeasure, section: "kpis", selection: k.name });
  }
  for (const g of overview.calculationGroups) {
    out.push({ kind: "calcGroup", name: g.name, section: "calcGroups", selection: g.name });
    for (const item of g.items) {
      out.push({
        kind: "calcItem",
        name: item.name,
        context: g.name,
        section: "calcGroups",
        selection: g.name,
        haystack: item.formula,
      });
    }
  }
  for (const g of overview.globalVariables) {
    out.push({
      kind: "calcTable",
      name: g.name,
      section: "globals",
      selection: g.name,
      haystack: g.expression,
    });
  }
  for (const v of overview.tableVariables) {
    out.push({ kind: "tableVariable", name: v.name, context: v.source, section: "tableVariables", selection: v.name });
  }
  for (const c of overview.contexts) {
    out.push({
      kind: "context",
      name: c.name,
      section: "contexts",
      selection: c.name,
      haystack: c.expression,
    });
  }
  for (const c of overview.contextColumns) {
    out.push({
      kind: "contextColumn",
      name: c.name,
      context: c.table,
      section: "tables",
      selection: c.table,
      haystack: c.expression,
    });
  }
  for (const f of overview.scriptFunctions) {
    out.push({ kind: "scriptFunction", name: f.name, section: "scriptFunctions", selection: f.name });
  }
  for (const r of overview.securityRoles) {
    out.push({ kind: "role", name: r.name, section: "roles", selection: r.name });
  }
  for (const p of overview.perspectives) {
    out.push({ kind: "perspective", name: p.name, section: "perspectives", selection: p.name });
  }
  for (const c of overview.cultures) {
    out.push({ kind: "culture", name: c.locale, section: "translations", selection: c.locale });
  }
  for (const s of overview.sources) {
    out.push({
      kind: "source",
      name: s.displayName ?? s.id,
      context: s.database || s.host || undefined,
      section: "connections",
      selection: s.id,
    });
  }
  for (const w of overview.writebackColumns) {
    out.push({ kind: "writeback", name: w.name, context: w.table, section: "tables", selection: w.table });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface ScoredEntry {
  entry: IndexEntry;
  score: number;
  /** Character offsets in `entry.name` that matched, for highlighting. */
  hits: number[];
}

/**
 * Subsequence match with a bonus for contiguity and word starts — the standard
 * "fuzzy" behaviour people expect from Ctrl+P, without a dependency. Returns
 * null when the query is not a subsequence of the target at all.
 */
function fuzzy(query: string, target: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return { score: 0, hits: [] };

  // Exact and prefix are ranked far above any subsequence.
  if (t === q) return { score: 1000, hits: [...Array(q.length).keys()] };
  if (t.startsWith(q)) return { score: 800, hits: [...Array(q.length).keys()] };

  const idx = t.indexOf(q);
  if (idx >= 0) {
    // A contiguous run — much better than a scattered subsequence. Starting at
    // a word boundary is better still.
    const boundary = idx === 0 || /[^a-z0-9]/.test(t[idx - 1]);
    return {
      score: (boundary ? 600 : 400) - idx,
      hits: Array.from({ length: q.length }, (_, i) => idx + i),
    };
  }

  let ti = 0;
  let score = 0;
  let last = -2;
  const hits: number[] = [];
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    if (found === last + 1) score += 8;
    if (found === 0 || /[^a-z0-9]/.test(t[found - 1])) score += 6;
    score -= Math.min(found - ti, 6);
    hits.push(found);
    last = found;
    ti = found + 1;
  }
  return { score, hits };
}

/**
 * Rank the index against a query.
 *
 * UNCAPPED by design: a cap is how "there are no more results" becomes a lie,
 * and the caller renders into a scroller anyway. `limit` exists only so a
 * caller can bound its own DOM.
 */
export function searchIndex(
  entries: IndexEntry[],
  rawQuery: string,
  limit = 200,
): ScoredEntry[] {
  let query = rawQuery.trim();
  let scope: IndexKind | null = null;

  // `measure: revenue` — a scope prefix narrows the kind.
  const scoped = /^([a-z]+)\s*:\s*(.*)$/i.exec(query);
  if (scoped) {
    const k = SCOPE_WORDS[scoped[1].toLowerCase()];
    if (k) {
      scope = k;
      query = scoped[2].trim();
    }
  }

  // A qualified reference: `Fact_Sales[Margin]`.
  const qualified = /^(.+?)\[(.*)\]$/.exec(query);
  let tableFilter: string | null = null;
  if (qualified) {
    tableFilter = qualified[1].trim().toLowerCase();
    query = qualified[2].trim();
  }

  const out: ScoredEntry[] = [];
  for (const entry of entries) {
    if (scope && entry.kind !== scope) continue;
    if (tableFilter && !(entry.context ?? "").toLowerCase().includes(tableFilter)) continue;

    if (query === "") {
      // An empty query after a scope still means "show me these".
      if (scope || tableFilter) out.push({ entry, score: 0, hits: [] });
      continue;
    }

    const m = fuzzy(query, entry.name);
    if (m) {
      out.push({ entry, score: m.score + kindBias(entry.kind), hits: m.hits });
      continue;
    }
    // Secondary surfaces match, but never outrank a name match.
    //
    // NOT for columns. A column's context is its table, so "cust" would drag in
    // every one of dim_customer's columns — eleven rows of `city`, `country`,
    // `postalcode` that contain no "cust" anywhere — and bury the actual hits.
    // "Columns of this table" already has a precise spelling: the qualified
    // reference `dim_customer[...]`.
    const ctx = entry.kind !== "column" && entry.context ? fuzzy(query, entry.context) : null;
    if (ctx) {
      out.push({ entry, score: ctx.score - 300 + kindBias(entry.kind), hits: [] });
      continue;
    }
    if (entry.haystack && entry.haystack.toLowerCase().includes(query.toLowerCase())) {
      out.push({ entry, score: -500 + kindBias(entry.kind), hits: [] });
    }
  }

  out.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_ORDER.indexOf(a.entry.kind) - KIND_ORDER.indexOf(b.entry.kind) ||
      a.entry.name.localeCompare(b.entry.name),
  );
  return out.slice(0, limit);
}

/** Columns are numerous; nudge them below the objects people usually mean. */
function kindBias(kind: IndexKind): number {
  if (kind === "column") return -12;
  if (kind === "section") return -6;
  return 0;
}

/** Group ranked results by kind, preserving rank order within each group. */
export function groupByKind(scored: ScoredEntry[]): Array<{ kind: IndexKind; items: ScoredEntry[] }> {
  const byKind = new Map<IndexKind, ScoredEntry[]>();
  for (const s of scored) {
    const arr = byKind.get(s.entry.kind) ?? [];
    arr.push(s);
    byKind.set(s.entry.kind, arr);
  }
  return KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({ kind: k, items: byKind.get(k)! }));
}
