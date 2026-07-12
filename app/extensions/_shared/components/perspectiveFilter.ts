//! FILENAME: app/extensions/_shared/components/perspectiveFilter.ts
// PURPOSE: Pure display filter applying a BI model PERSPECTIVE (a named
//   presentation subset: tables shown in full, individually shown
//   "Table[column]" refs, shown measures) to a field-list model.
// CONTEXT: Used by TableFieldList's perspective picker. Display-only — this
//   never restricts queries (object-level security does that engine-side);
//   an unknown/removed perspective name filters nothing (fail open for a
//   presentation concern: better to show everything than an empty list).

/** A perspective as surfaced in BI pivot metadata (mirrors Rust
 *  `BiPerspectiveMeta` / engine `Perspective`). */
export interface BiPerspectiveInfo {
  name: string;
  /** Tables shown in full (all their columns). */
  tables: string[];
  /** Individually shown qualified `Table[column]` refs. */
  columns: string[];
  /** Measures shown. */
  measures: string[];
  description?: string | null;
}

interface TableLike {
  name: string;
  columns: Array<{ name: string }>;
}

interface MeasureLike {
  name: string;
}

interface HierarchyLike {
  table: string;
}

export interface PerspectiveFilterable<
  T extends TableLike,
  M extends MeasureLike,
  H extends HierarchyLike,
> {
  tables: T[];
  measures: M[];
  hierarchies?: H[];
}

/**
 * Filter a field-list model down to the named perspective (case-insensitive):
 * - a table listed in `perspective.tables` keeps ALL its columns;
 * - a table only referenced via `perspective.columns` keeps just those columns;
 * - measures keep only the listed names;
 * - hierarchies show only on fully-listed tables (their level columns are
 *   guaranteed present there).
 *
 * `selected` of null/undefined, or a name matching no perspective, returns the
 * model unchanged.
 */
export function applyPerspective<
  T extends TableLike,
  M extends MeasureLike,
  H extends HierarchyLike,
>(
  model: PerspectiveFilterable<T, M, H>,
  perspectives: BiPerspectiveInfo[] | undefined,
  selected: string | null | undefined,
): PerspectiveFilterable<T, M, H> {
  if (!selected) return model;
  const wanted = selected.trim().toLowerCase();
  const p = (perspectives ?? []).find((x) => x.name.trim().toLowerCase() === wanted);
  if (!p) return model;

  const fullTables = new Set(p.tables.map((t) => t.trim().toLowerCase()));
  const colsByTable = new Map<string, Set<string>>();
  for (const ref of p.columns) {
    const trimmed = ref.trim();
    const open = trimmed.indexOf('[');
    if (open <= 0 || !trimmed.endsWith(']')) continue;
    const table = trimmed.slice(0, open).trim().toLowerCase();
    const column = trimmed.slice(open + 1, -1).trim().toLowerCase();
    if (!table || !column) continue;
    const set = colsByTable.get(table) ?? new Set<string>();
    set.add(column);
    colsByTable.set(table, set);
  }
  const measureSet = new Set(p.measures.map((m) => m.trim().toLowerCase()));

  const tables = model.tables
    .map((t) => {
      const key = t.name.trim().toLowerCase();
      if (fullTables.has(key)) return t;
      const cols = colsByTable.get(key);
      if (!cols) return null;
      const columns = t.columns.filter((c) => cols.has(c.name.trim().toLowerCase()));
      return columns.length > 0 ? ({ ...t, columns } as T) : null;
    })
    .filter((t): t is T => t !== null);

  const measures = model.measures.filter((m) =>
    measureSet.has(m.name.trim().toLowerCase()),
  );

  const hierarchies = model.hierarchies?.filter((h) =>
    fullTables.has(h.table.trim().toLowerCase()),
  );

  return { tables, measures, hierarchies };
}
