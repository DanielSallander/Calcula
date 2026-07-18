//! FILENAME: app/extensions/pivot/components/types.ts
// Pivot Editor Types - Matching Rust backend definitions
// Shared types are re-exported from _shared/components/types

import type {
  FieldIndex,
  SourceField,
  ZoneField,
  AggregationType,
  SortOrder,
  // Pivot-layout / BI-model types now live in _shared (with the DSL that uses
  // them). Imported here for internal use; re-exported below for continuity.
  ShowValuesAs,
  LayoutConfig,
  CalculatedFieldDef,
  ValueColumnRefDef,
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

// Re-export the pivot-layout / BI-model types that moved to _shared alongside
// the pivot-layout DSL, so existing `../components/types` importers keep working.
export type {
  ShowValuesAs,
  ReportLayout,
  ValuesPosition,
  LayoutConfig,
  CalculatedFieldDef,
  ValueColumnRefDef,
  BiPivotModelInfo,
  BiPerspectiveInfo,
  BiCultureInfo,
  BiNameTranslationInfo,
  BiModelTable,
  BiModelColumn,
  BiCalcGroup,
  BiCalcGroupItem,
  BiHierarchyMeta,
  BiHierarchyLevel,
  BiRaggedBehavior,
} from '../../_shared/components/types';
export { CALC_GROUP_TABLE } from '../../_shared/components/types';

// --- Pivot-specific types below ---

export type PivotId = string;

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
