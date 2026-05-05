//! FILENAME: app/extensions/Pivot/dsl/serializer.ts
// PURPOSE: Serialize pivot zone state back into DSL text.
// CONTEXT: Used for bidirectional sync — when the visual editor changes,
//          the Design tab text is regenerated from the current zone state.

import type { ZoneField, AggregationType } from '../../_shared/components/types';
import { AGGREGATION_OPTIONS, getValueFieldDisplayName } from '../../_shared/components/types';
import type { LayoutConfig, BiPivotModelInfo, CalculatedFieldDef } from '../../Pivot/components/types';

/** Options controlling serialization output. */
export interface SerializeOptions {
  biModel?: BiPivotModelInfo;
  /** If set, include a SAVE AS clause with this name. */
  saveAs?: string;
  /** Calculated fields to serialize as CALC clauses. */
  calculatedFields?: CalculatedFieldDef[];
  /**
   * Map from filter field name/sourceIndex to all unique values for that field.
   * When available, the serializer uses whichever of = (inclusion) or NOT IN
   * (exclusion) produces a shorter output.
   */
  filterUniqueValues?: Map<string, string[]>;
}

/** Characters that require a field name to be quoted in the DSL. */
const SPECIAL_CHARS = /[,:()=.\[\]"#\s]/;

/**
 * Serialize the current pivot zone state into DSL text.
 * Produces a canonical, round-trippable representation.
 */
export function serialize(
  rows: ZoneField[],
  columns: ZoneField[],
  values: ZoneField[],
  filters: ZoneField[],
  layout: LayoutConfig,
  options: SerializeOptions = {},
): string {
  const lines: string[] = [];

  if (rows.length > 0) {
    lines.push(`ROWS:    ${serializeFieldList(rows, options)}`);
  }

  if (columns.length > 0) {
    lines.push(`COLUMNS: ${serializeFieldList(columns, options)}`);
  }

  // Serialize VALUES with inline CALC entries to preserve interleaved order.
  // CALC fields appear as "CALC Name = formula" within the VALUES list.
  if (values.length > 0) {
    const parts: string[] = [];
    for (const v of values) {
      if (v.isCalculated) {
        const name = v.customName || v.name;
        const formula = v.calculatedFormula || '';
        parts.push(`CALC ${name} = ${formula}`);
      } else {
        parts.push(serializeValueField(v, options));
      }
    }
    if (parts.length > 1) {
      lines.push(`VALUES:  ${parts.join(',\n         ')}`);
    } else if (parts.length === 1) {
      lines.push(`VALUES:  ${parts[0]}`);
    }
  }

  if (filters.length > 0) {
    lines.push(`FILTERS: ${serializeFilters(filters, options)}`);
  }

  const layoutStr = serializeLayout(layout);
  if (layoutStr) {
    lines.push(`LAYOUT:  ${layoutStr}`);
  }

  if (options.saveAs) {
    lines.push(`SAVE AS "${options.saveAs}"`);
  }

  return lines.join('\n');
}

// --- Field list (ROWS / COLUMNS) ---

function serializeFieldList(fields: ZoneField[], options: SerializeOptions): string {
  return fields.map(f => serializeFieldRef(f, options)).join(', ');
}

function serializeFieldRef(field: ZoneField, options: SerializeOptions): string {
  let result = '';

  // LOOKUP prefix for BI fields
  if (field.isLookup) {
    result += 'LOOKUP ';
  }

  result += quoteIfNeeded(field.name);

  return result;
}

// --- Value fields ---

function serializeValueFields(fields: ZoneField[], options: SerializeOptions): string {
  const parts = fields.map(f => serializeValueField(f, options));

  // If multiple value fields, put each on its own line with alignment
  if (parts.length > 1) {
    return parts.join(',\n         ');
  }
  return parts.join(', ');
}

function serializeValueField(field: ZoneField, options: SerializeOptions): string {
  let result = '';

  // Check if this is a BI measure. Measure fields have names like "[TotalSales]"
  // (with brackets) while model measures have names like "TotalSales" (without).
  // Also check customName which may hold the original measure name.
  const stripBrackets = (s: string) =>
    s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  const fieldNameBare = stripBrackets(field.name);
  const customNameBare = field.customName ? stripBrackets(field.customName) : '';
  const isBiMeasure = options.biModel?.measures.some(
    m => m.name === fieldNameBare || m.name === customNameBare
      || m.name === field.name || m.name === field.customName
  );

  if (isBiMeasure) {
    // Use the bare name (without brackets) since the DSL syntax adds them
    result = `[${customNameBare || fieldNameBare}]`;
  } else {
    const aggLabel = getAggregationLabel(field.aggregation ?? 'sum');
    const fieldName = quoteIfNeeded(field.name);
    result = `${aggLabel}(${fieldName})`;
  }

  // AS "alias" — only if customName differs from default display name
  if (field.customName) {
    const defaultName = field.aggregation
      ? getValueFieldDisplayName(field.name, field.aggregation)
      : field.name;
    if (field.customName !== defaultName && field.customName !== field.name) {
      result += ` AS "${field.customName}"`;
    }
  }

  // Show values as: [% of Row] etc.
  if (field.showValuesAs && field.showValuesAs !== 'normal') {
    const label = getShowValuesAsLabel(field.showValuesAs);
    if (label) {
      result += ` [${label}]`;
    }
  }

  return result;
}

// --- Filters ---

function serializeFilters(fields: ZoneField[], options: SerializeOptions): string {
  const parts = fields.map(f => serializeFilter(f, options));
  if (parts.length > 1) {
    return parts.join(',\n         ');
  }
  return parts.join(', ');
}

function serializeFilter(field: ZoneField, options: SerializeOptions): string {
  const name = quoteIfNeeded(field.name);

  if (field.hiddenItems && field.hiddenItems.length > 0) {
    // hiddenItems stores items to HIDE (exclude).
    // If we know all unique values, use whichever representation is shorter.
    const allValues = options.filterUniqueValues?.get(field.name);
    if (allValues && allValues.length > 0) {
      const hiddenSet = new Set(field.hiddenItems);
      const includedValues = allValues.filter(v => !hiddenSet.has(v));

      // Use inclusion (=) if it's shorter than exclusion (NOT IN)
      if (includedValues.length <= field.hiddenItems.length) {
        const vals = includedValues.map(v => `"${escapeString(v)}"`).join(', ');
        return `${name} = (${vals})`;
      }
    }

    // Default: use NOT IN (direct representation of hiddenItems)
    const vals = field.hiddenItems.map(v => `"${escapeString(v)}"`).join(', ');
    return `${name} NOT IN (${vals})`;
  }

  // Filter with no specific values — just the field name
  return name;
}

// --- Layout ---

function serializeLayout(layout: LayoutConfig): string {
  const parts: string[] = [];

  if (layout.reportLayout) {
    parts.push(layout.reportLayout);
  }

  if (layout.repeatRowLabels === true) {
    parts.push('repeat-labels');
  } else if (layout.repeatRowLabels === false) {
    parts.push('no-repeat-labels');
  }

  if (layout.showRowGrandTotals === false && layout.showColumnGrandTotals === false) {
    parts.push('no-grand-totals');
  } else {
    if (layout.showRowGrandTotals === false) {
      parts.push('no-row-totals');
    }
    if (layout.showColumnGrandTotals === false) {
      parts.push('no-column-totals');
    }
  }

  if (layout.showEmptyRows) parts.push('show-empty-rows');
  if (layout.showEmptyCols) parts.push('show-empty-cols');

  if (layout.valuesPosition === 'rows') {
    parts.push('values-on-rows');
  }

  if (layout.autoFitColumnWidths) {
    parts.push('auto-fit');
  }

  return parts.join(', ');
}

// --- Helpers ---

/** Quote a field name if it contains special characters. */
function quoteIfNeeded(name: string): string {
  if (SPECIAL_CHARS.test(name)) {
    // Don't re-quote dotted BI names (Table.Column) — those are valid unquoted
    if (/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return name;
    }
    return `"${escapeString(name)}"`;
  }
  return name;
}

/** Escape double quotes within a string. */
function escapeString(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** Get the display label for an aggregation type (capitalized for DSL). */
function getAggregationLabel(agg: AggregationType): string {
  const labels: Record<AggregationType, string> = {
    sum: 'Sum',
    count: 'Count',
    average: 'Average',
    min: 'Min',
    max: 'Max',
    countnumbers: 'CountNumbers',
    stddev: 'StdDev',
    stddevp: 'StdDevP',
    var: 'Var',
    varp: 'VarP',
    product: 'Product',
  };
  return labels[agg] ?? 'Sum';
}

/** Get the display label for a show-values-as type. */
function getShowValuesAsLabel(showAs: string): string | null {
  const labels: Record<string, string> = {
    'percent_of_total': '% of Grand Total',
    'percent_of_row': '% of Row',
    'percent_of_column': '% of Column',
    'percent_of_parent_row': '% of Parent Row',
    'percent_of_parent_column': '% of Parent Column',
    'difference': 'Difference',
    'percent_difference': '% Difference',
    'running_total': 'Running Total',
    'index': 'Index',
  };
  return labels[showAs] ?? null;
}
