//! FILENAME: app/extensions/_shared/components/types.ts
// PURPOSE: Shared types for the field editor UI (used by Pivot and Tablix).
// CONTEXT: Drag-and-drop types, field representations, and aggregation helpers.

// The perspective / culture display-metadata types live beside their pure
// filter/lookup helpers; re-exported here so BiPivotModelInfo is complete.
import type { BiPerspectiveInfo } from './perspectiveFilter';
import type { BiCultureInfo } from './cultureLookup';
export type { BiPerspectiveInfo } from './perspectiveFilter';
export type { BiCultureInfo, BiNameTranslationInfo } from './cultureLookup';

export type FieldIndex = number;

// Aggregation types matching AggregationType enum in definition.rs
export type AggregationType =
  | 'sum'
  | 'count'
  | 'average'
  | 'min'
  | 'max'
  | 'countnumbers'
  | 'stddev'
  | 'stddevp'
  | 'var'
  | 'varp'
  | 'product';

// Sort order matching SortOrder enum
export type SortOrder = 'asc' | 'desc' | 'manual' | 'source';

// Source field from the data - used in the field list
export interface SourceField {
  index: FieldIndex;
  name: string;
  isNumeric: boolean;
  /** Table name for BI pivots (e.g., "Sales"). Absent for range pivots. */
  tableName?: string;
}

// Measure field from a BI model
export interface MeasureField {
  name: string;
  table: string;
  sourceColumn: string;
  aggregation: AggregationType;
}

// Drop zone identifiers
export type DropZoneType = 'filters' | 'columns' | 'rows' | 'values';

// Internal field representation for drag and drop
export interface DragField {
  sourceIndex: FieldIndex;
  name: string;
  isNumeric: boolean;
  fromZone?: DropZoneType;
  fromIndex?: number;
}

// Field in a drop zone
export interface ZoneField {
  sourceIndex: FieldIndex;
  name: string;
  isNumeric: boolean;
  // For value fields
  aggregation?: AggregationType;
  customName?: string;
  numberFormat?: string;
  showValuesAs?: string;
  // For filter fields
  hiddenItems?: string[];
  // For tablix data fields
  mode?: string;
  // For BI pivot fields: whether this is a LOOKUP (attribute) rather than GROUP
  isLookup?: boolean;
  // For calculated fields in the VALUES zone
  isCalculated?: boolean;
  calculatedFormula?: string;
  // For "Show Values As" calculations that reference another field/item
  baseField?: string;
  baseItem?: string;
}

// Aggregation option for the dropdown menu
export interface AggregationOption {
  value: AggregationType;
  label: string;
}

export const AGGREGATION_OPTIONS: AggregationOption[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'count', label: 'Count' },
  { value: 'average', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'countnumbers', label: 'Count Numbers' },
  { value: 'stddev', label: 'Std Dev' },
  { value: 'stddevp', label: 'Std Dev (Population)' },
  { value: 'var', label: 'Variance' },
  { value: 'varp', label: 'Variance (Population)' },
  { value: 'product', label: 'Product' },
];

// Helper to get default aggregation based on field type
export function getDefaultAggregation(isNumeric: boolean): AggregationType {
  return isNumeric ? 'sum' : 'count';
}

// Helper to get display name for value field
export function getValueFieldDisplayName(
  name: string,
  aggregation: AggregationType
): string {
  const aggLabel =
    AGGREGATION_OPTIONS.find((opt) => opt.value === aggregation)?.label ||
    'Sum';

  // Strip any existing aggregation prefix to prevent "Sum of Sum of Y"
  let baseName = name;
  for (const opt of AGGREGATION_OPTIONS) {
    const prefix = `${opt.label} of `;
    if (baseName.startsWith(prefix)) {
      baseName = baseName.substring(prefix.length);
      break;
    }
  }

  return `${aggLabel} of ${baseName}`;
}

// ============================================================================
// Pivot-layout / BI-model types (shared with the pivot-layout DSL)
// ----------------------------------------------------------------------------
// These describe the pivot-layout DSL's compile context (the BI model) and its
// layout / value-field output. They live here — not in the Pivot extension — so
// the relocated DSL in _shared/dsl/pivotLayout can reference them without
// importing an extension (sibling-isolation boundary). The Pivot extension
// re-exports them from its own components/types for continuity.
// ============================================================================

/** Show-values-as mode (matches the Rust ShowValuesAs enum). */
export type ShowValuesAs =
  | 'normal'
  | 'percent_of_total'
  | 'percent_of_row'
  | 'percent_of_column'
  | 'percent_of_parent_row'
  | 'percent_of_parent_column'
  | 'difference'
  | 'percent_difference'
  | 'running_total'
  | 'percent_of_running_total'
  | 'rank_ascending'
  | 'rank_descending'
  | 'index';

/** Report layout (matches the Rust ReportLayout enum). */
export type ReportLayout = 'compact' | 'outline' | 'tabular';

/** Values position (matches the Rust ValuesPosition enum). */
export type ValuesPosition = 'columns' | 'rows';

/** Layout configuration (matches LayoutConfig in pivot_commands.rs). */
export interface LayoutConfig {
  showRowGrandTotals?: boolean;
  showColumnGrandTotals?: boolean;
  reportLayout?: ReportLayout;
  repeatRowLabels?: boolean;
  showEmptyRows?: boolean;
  showEmptyCols?: boolean;
  valuesPosition?: ValuesPosition;
  autoFitColumnWidths?: boolean;
  /** PivotTable style theme ID (frontend-only for now) */
  styleId?: string;
}

/** Inline calculated field definition. */
export interface CalculatedFieldDef {
  name: string;
  formula: string;
  numberFormat?: string;
}

/** Reference to a value or calculated field in the unified column ordering. */
export type ValueColumnRefDef =
  | { type: 'value'; index: number }
  | { type: 'calculated'; index: number };

/** BI model info sent from backend for the hierarchical field list. */
export interface BiPivotModelInfo {
  tables: BiModelTable[];
  measures: MeasureField[];
  /** All columns toggled to LOOKUP mode ("Table.Column" keys) */
  lookupColumns?: string[];
  /** The connection ID this pivot is associated with (BI pivots only) */
  connectionId?: string;
  /** Hierarchies defined in the BI model (drill-down paths). */
  hierarchies?: BiHierarchyMeta[];
  /** Calculation groups defined in the BI model. Placed as DIMENSIONS
   *  (Power BI-style): a zone field named after the group whose members are
   *  its calculation items. */
  calculationGroups?: BiCalcGroup[];
  /** ISO-8601 time this pivot's data was last fetched ("Data as of …"). */
  dataAsOf?: string;
  /** Perspectives defined in the BI model (field-list display subsets). */
  perspectives?: BiPerspectiveInfo[];
  /** The perspective selected for this pivot's field list (null = all). */
  selectedPerspective?: string | null;
  /** Cultures defined in the BI model (per-locale metadata translations,
   *  display-only — keys and queries always use raw names). */
  cultures?: BiCultureInfo[];
}

/** A calculation group + its items (read-only metadata). */
export interface BiCalcGroup {
  name: string;
  items: BiCalcGroupItem[];
}

export interface BiCalcGroupItem {
  name: string;
  source?: string;
}

/** Pseudo table name marking a calculation-group field reference on the wire
 *  (mirrors Rust CALC_GROUP_TABLE). Zone chips carry the plain group name;
 *  requests send `{ table: CALC_GROUP_TABLE, column: <group name> }`. */
export const CALC_GROUP_TABLE = '__calcgroup__';

/** Table metadata from a BI model */
export interface BiModelTable {
  name: string;
  columns: BiModelColumn[];
}

/** Column metadata from a BI model table */
export interface BiModelColumn {
  name: string;
  dataType: string;
  isNumeric: boolean;
  /** Custom lookup resolution expression (e.g., "MAX(category_name)"). */
  lookupResolution?: string;
  /** Sort-by column name: sort this column's pivot items by another column's values.
   *  Example: monthName sorted by monthNumber for calendar ordering. */
  sortByColumn?: string;
  /** True for a WRITEBACK column: end users type its values in pivot cells
   *  when it is placed as a lookup on leaf rows. */
  isWritebackColumn?: boolean;
}

/** Ragged hierarchy behavior — how to handle missing intermediate levels. */
export type BiRaggedBehavior = 'ShowBlanks' | 'HideMembers' | 'RepeatParent' | 'ShowAsLeaf';

/** A single level within a hierarchy. */
export interface BiHierarchyLevel {
  column: string;
  displayName?: string;
  optional?: boolean;
}

/** A hierarchy defined on a BI model table — represents a drill-down path. */
export interface BiHierarchyMeta {
  name: string;
  table: string;
  levels: BiHierarchyLevel[];
  raggedBehavior?: BiRaggedBehavior;
}
