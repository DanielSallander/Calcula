//! FILENAME: app/extensions/_shared/components/cultureLookup.ts
// PURPOSE: Pure helpers for BI model CULTURES (per-locale metadata
//   translations): resolve which culture applies to a locale, and look up
//   translated display names/descriptions for tables, columns, and measures.
// CONTEXT: Used by TableFieldList to swap field-list LABELS only. Display-only
//   — all keys, drag names, and queries keep the raw object names; an unknown
//   locale simply resolves to no culture (fail open: raw names show).

/** One object's translated metadata within a culture (mirrors Rust
 *  `BiNameTranslationMeta` / engine `NameTranslation`). `object` is a table
 *  name, a qualified `Table[column]` ref, or a measure name depending on the
 *  owning list. */
export interface BiNameTranslationInfo {
  object: string;
  /** Translated display name (null/absent = keep the raw display). */
  displayName?: string | null;
  /** Translated description (null/absent = keep the raw description). */
  description?: string | null;
}

/** A culture: per-locale display-name/description translations (mirrors Rust
 *  `BiCultureMeta` / engine `Culture`). */
export interface BiCultureInfo {
  /** BCP-47 locale id (e.g. "sv-SE"). */
  locale: string;
  tables: BiNameTranslationInfo[];
  columns: BiNameTranslationInfo[];
  measures: BiNameTranslationInfo[];
}

/** The language subtag of a BCP-47 locale id ("sv-SE" -> "sv"). */
function languageOf(locale: string): string {
  const trimmed = locale.trim().toLowerCase();
  const dash = trimmed.indexOf('-');
  return dash >= 0 ? trimmed.slice(0, dash) : trimmed;
}

/**
 * Resolve which culture applies to a locale:
 * 1. exact locale match (case-insensitive, trimmed), else
 * 2. the first culture whose language prefix (before "-") matches the
 *    locale's language prefix ("sv" matches "sv-FI" against "sv-SE"), else
 * 3. null (no translation — raw names show).
 */
export function resolveCulture<C extends BiCultureInfo>(
  cultures: C[] | null | undefined,
  locale: string | null | undefined,
): C | null {
  if (!cultures || cultures.length === 0 || !locale) return null;
  const wanted = locale.trim().toLowerCase();
  if (!wanted) return null;
  const exact = cultures.find((c) => c.locale.trim().toLowerCase() === wanted);
  if (exact) return exact;
  const wantedLang = languageOf(wanted);
  return cultures.find((c) => languageOf(c.locale) === wantedLang) ?? null;
}

/** Case-insensitive translation lookups for one resolved culture. Every
 *  method returns null when the object has no translation (show raw). */
export interface CultureLookup {
  /** Translated display name for a table. */
  table(name: string): string | null;
  /** Translated display name for a column (raw table + column names). */
  column(table: string, column: string): string | null;
  /** Translated description for a column (tooltip text). */
  columnDescription(table: string, column: string): string | null;
  /** Translated display name for a measure. */
  measure(name: string): string | null;
}

const EMPTY_LOOKUP: CultureLookup = {
  table: () => null,
  column: () => null,
  columnDescription: () => null,
  measure: () => null,
};

function toMap(translations: BiNameTranslationInfo[]): Map<string, BiNameTranslationInfo> {
  const map = new Map<string, BiNameTranslationInfo>();
  for (const t of translations) {
    const key = t.object.trim().toLowerCase();
    // First entry wins, matching the engine's find() semantics.
    if (key && !map.has(key)) map.set(key, t);
  }
  return map;
}

/** Build constant-time translation lookups for a culture (null = no active
 *  culture; every lookup returns null so raw names show). */
export function buildCultureLookup(culture: BiCultureInfo | null | undefined): CultureLookup {
  if (!culture) return EMPTY_LOOKUP;
  const tables = toMap(culture.tables);
  const columns = toMap(culture.columns);
  const measures = toMap(culture.measures);
  const nonEmpty = (s: string | null | undefined): string | null => {
    const trimmed = (s ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const columnKey = (table: string, column: string) =>
    `${table.trim()}[${column.trim()}]`.toLowerCase();
  return {
    table: (name) => nonEmpty(tables.get(name.trim().toLowerCase())?.displayName),
    column: (table, column) => nonEmpty(columns.get(columnKey(table, column))?.displayName),
    columnDescription: (table, column) =>
      nonEmpty(columns.get(columnKey(table, column))?.description),
    measure: (name) => nonEmpty(measures.get(name.trim().toLowerCase())?.displayName),
  };
}
