//! FILENAME: app/extensions/pivot/components/types.ts
// Pivot Editor Types - Matching Rust backend definitions
// Shared types are re-exported from _shared/components/types

import type {
  FieldIndex,
  SourceField,
  ZoneField,
  AggregationType,
  SortOrder,
  MeasureField,
} from '../../_shared/components/types';

// Re-export shared types used by both Pivot and Tablix
export type {
  FieldIndex,
  AggregationType,
  SortOrder,
  SourceField,
  DropZoneType,
  DragField,
  ZoneField,
  AggregationOption,
  MeasureField,
} from '../../_shared/components/types';
export {
  AGGREGATION_OPTIONS,
  getDefaultAggregation,
  getValueFieldDisplayName,
} from '../../_shared/components/types';

// --- Pivot-specific types below ---

export type PivotId = number;

// Show values as matching ShowValuesAs enum
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

// Report layout matching ReportLayout enum
export type ReportLayout = 'compact' | 'outline' | 'tabular';

// Values position matching ValuesPosition enum
export type ValuesPosition = 'columns' | 'rows';

// Field configuration matching PivotFieldConfig in pivot_commands.rs
export interface PivotFieldConfig {
  sourceIndex: FieldIndex;
  name: string;
  sortOrder?: SortOrder;
  showSubtotals?: boolean;
  collapsed?: boolean;
  hiddenItems?: string[];
}

// Value field configuration matching ValueFieldConfig in pivot_commands.rs
export interface ValueFieldConfig {
  sourceIndex: FieldIndex;
  name: string;
  aggregation: AggregationType;
  numberFormat?: string;
  showValuesAs?: ShowValuesAs;
  customName?: string;
}

// Layout configuration matching LayoutConfig in pivot_commands.rs
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

// Update request matching UpdatePivotFieldsRequest in pivot_commands.rs
export interface UpdatePivotFieldsRequest {
  pivotId: PivotId;
  rowFields?: PivotFieldConfig[];
  columnFields?: PivotFieldConfig[];
  valueFields?: ValueFieldConfig[];
  filterFields?: PivotFieldConfig[];
  layout?: LayoutConfig;
  calculatedFields?: CalculatedFieldDef[];
  valueColumnOrder?: ValueColumnRefDef[];
}

// Editor state
export interface PivotEditorState {
  pivotId: PivotId;
  sourceFields: SourceField[];
  filters: ZoneField[];
  columns: ZoneField[];
  rows: ZoneField[];
  values: ZoneField[];
  layout: LayoutConfig;
}

// --- BI Pivot Types ---

/** BI model info sent from backend for the hierarchical field list */
export interface BiPivotModelInfo {
  tables: BiModelTable[];
  measures: MeasureField[];
  /** All columns toggled to LOOKUP mode ("Table.Column" keys) */
  lookupColumns?: string[];
  /** The connection ID this pivot is associated with (BI pivots only) */
  connectionId?: number;
  /** Hierarchies defined in the BI model (drill-down paths). */
  hierarchies?: BiHierarchyMeta[];
}

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

/** Reference to a hierarchy placed on a pivot axis (sent to backend). */
export interface BiHierarchyFieldRef {
  /** Hierarchy name. */
  hierarchy: string;
  /** Table the hierarchy belongs to. */
  table: string;
  /** Currently expanded node paths (e.g., ["USA", "USA|California"]). */
  expanded?: string[];
}

/** Reference to a table column (for BI pivot row/column/filter fields) */
export interface BiFieldRef {
  table: string;
  column: string;
  /** When true, this field is a lookup column (resolved post-aggregation). */
  isLookup?: boolean;
  /** Items to hide from the filter. Only relevant for filter fields. */
  hiddenItems?: string[];
}

/** Reference to a model measure (for BI pivot value fields) */
export interface BiValueFieldRef {
  measureName: string;
  customName?: string;
}

/** Request to create a BI model pivot */
export interface CreatePivotFromBiModelRequest {
  destinationCell: string;
  destinationSheet?: number;
  name?: string;
  connectionString?: string;
}

/** Request to update field assignments on a BI-backed pivot */
export interface UpdateBiPivotFieldsRequest {
  pivotId: PivotId;
  rowFields: BiFieldRef[];
  columnFields: BiFieldRef[];
  valueFields: BiValueFieldRef[];
  filterFields: BiFieldRef[];
  /** Fields needed only by slicers — included in the query but not shown as visible filter rows */
  slicerFields?: BiFieldRef[];
  /** Hierarchies placed on the row axis (drill-down). */
  rowHierarchies?: BiHierarchyFieldRef[];
  /** Hierarchies placed on the column axis (drill-down). */
  columnHierarchies?: BiHierarchyFieldRef[];
  layout?: LayoutConfig;
  /** All columns toggled to LOOKUP mode, including those not in zones */
  lookupColumns?: string[];
  /** Calculated fields (replaces all when provided) */
  calculatedFields?: CalculatedFieldDef[];
  /** Unified column ordering for interleaving values and calculated fields. */
  valueColumnOrder?: ValueColumnRefDef[];
}
