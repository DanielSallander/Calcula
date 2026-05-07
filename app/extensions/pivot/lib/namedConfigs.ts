//! FILENAME: app/extensions/Pivot/lib/namedConfigs.ts
// PURPOSE: CRUD operations for named pivot layout configs with source binding.
// CONTEXT: Stored in localStorage for now; future integration with .calp publish format.

import { lex, parse } from '../dsl';
import type { SourceField, BiPivotModelInfo } from '../components/types';

const STORAGE_KEY = 'calcula.pivot.namedConfigs';

/** Describes what data source a layout was created against. */
export interface SourceSignature {
  type: 'table' | 'bi';
  /** Table: source table name for Table-linked pivots. */
  tableName?: string;
  /** BI: tables with their column names. */
  tables?: { name: string; columns: string[] }[];
  /** BI: measure names. */
  measures?: string[];
}

/** Result of validating a layout against a target data source. */
export interface FieldValidationResult {
  compatible: boolean;
  missingFields: string[];
}

/** A saved pivot layout configuration. */
export interface NamedPivotConfig {
  name: string;
  dslText: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  /** Optional pivot ID this config was created from. */
  pivotId?: number;
  /** Source binding metadata for compatibility checking. */
  sourceSignature?: SourceSignature;
  /** Where this config is stored: 'user' (localStorage) or 'workbook' (.cala). */
  scope?: 'user' | 'workbook';
}

/** Load all named configs from localStorage. */
export function loadNamedConfigs(): NamedPivotConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as NamedPivotConfig[];
  } catch {
    return [];
  }
}

/** Save a named config. Creates new or updates existing (by name). */
export function saveNamedConfig(config: Omit<NamedPivotConfig, 'createdAt' | 'updatedAt'> & { createdAt?: number }): void {
  const configs = loadNamedConfigs();
  const now = Date.now();
  const existing = configs.findIndex(c => c.name === config.name);

  if (existing >= 0) {
    configs[existing] = {
      ...configs[existing],
      ...config,
      updatedAt: now,
    };
  } else {
    configs.push({
      ...config,
      createdAt: now,
      updatedAt: now,
    });
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

/** Delete a named config by name. */
export function deleteNamedConfig(name: string): void {
  const configs = loadNamedConfigs().filter(c => c.name !== name);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

/** Get a specific named config by name. */
export function getNamedConfig(name: string): NamedPivotConfig | undefined {
  return loadNamedConfigs().find(c => c.name === name);
}

/** Build a source signature from the current pivot's available fields.
 *  Returns undefined for raw-range pivots (no table, no BI) — save is not allowed. */
export function buildSourceSignature(
  sourceFields: SourceField[],
  biModel?: BiPivotModelInfo,
  tableName?: string,
): SourceSignature | undefined {
  if (biModel) {
    return {
      type: 'bi',
      tables: biModel.tables.map(t => ({
        name: t.name,
        columns: t.columns.map(c => c.name),
      })),
      measures: biModel.measures.map(m => m.name),
    };
  }
  if (tableName) {
    return {
      type: 'table',
      tableName,
    };
  }
  // Raw range pivot — no save allowed
  return undefined;
}

/**
 * Extract all field names referenced in a DSL text (without needing CompileContext).
 * Returns raw field names as written in the DSL.
 */
export function extractReferencedFields(dslText: string): string[] {
  const { tokens } = lex(dslText);
  const { ast } = parse(tokens);
  const names = new Set<string>();

  for (const f of ast.rows) names.add(f.name);
  for (const f of ast.columns) names.add(f.name);
  for (const f of ast.values) {
    if (f.inlineCalcIndex !== undefined) continue;
    if (f.isMeasure) {
      names.add(`[${f.fieldName}]`);
    } else {
      names.add(f.fieldName);
    }
  }
  for (const f of ast.filters) names.add(f.fieldName);
  if (ast.topN) names.add(ast.topN.byField);

  return [...names];
}

/**
 * Validate whether a saved layout's referenced fields are available in the target data source.
 * Returns { compatible, missingFields }.
 */
export function validateLayoutCompatibility(
  dslText: string,
  sourceFields: SourceField[],
  biModel?: BiPivotModelInfo,
): FieldValidationResult {
  const referenced = extractReferencedFields(dslText);
  const available = new Set<string>();

  if (biModel) {
    for (const t of biModel.tables) {
      for (const c of t.columns) {
        available.add(`${t.name}.${c.name}`);
      }
    }
    for (const m of biModel.measures) {
      available.add(`[${m.name}]`);
    }
  } else {
    for (const f of sourceFields) {
      available.add(f.name);
    }
  }

  // Case-insensitive lookup
  const availableLower = new Map<string, string>();
  for (const a of available) availableLower.set(a.toLowerCase(), a);

  const missing: string[] = [];
  for (const r of referenced) {
    if (!availableLower.has(r.toLowerCase())) missing.push(r);
  }

  return {
    compatible: missing.length === 0,
    missingFields: missing,
  };
}

/** Common pivot layout templates. */
export const PIVOT_TEMPLATES: { name: string; description: string; dslText: string }[] = [
  {
    name: 'Basic Summary',
    description: 'Simple rows and values layout',
    dslText: `ROWS:    # add row fields\nVALUES:  # add value fields or [Measures]\nLAYOUT:  compact`,
  },
  {
    name: 'Cross-Tab',
    description: 'Rows vs columns comparison',
    dslText: `ROWS:    # add row fields\nCOLUMNS: # add column fields\nVALUES:  # add value fields or [Measures]\nLAYOUT:  tabular`,
  },
  {
    name: 'Year-over-Year',
    description: 'Time-based comparison with date grouping',
    dslText: `ROWS:    # add row fields\nCOLUMNS: # add a date field, e.g.: OrderDate.group(years, quarters)\nVALUES:  # add value fields or [Measures]\nLAYOUT:  tabular, repeat-labels`,
  },
  {
    name: 'Detailed Report',
    description: 'Tabular layout with repeat labels, no totals',
    dslText: `ROWS:    # add row fields\nVALUES:  # add value fields or [Measures]\nLAYOUT:  tabular, repeat-labels, no-grand-totals`,
  },
  {
    name: 'Top 10 Analysis',
    description: 'Ranked top items',
    dslText: `ROWS:    # add row fields\nVALUES:  # add value fields or [Measures]\nTOP 10 BY # add a value field\nLAYOUT:  compact`,
  },
];
