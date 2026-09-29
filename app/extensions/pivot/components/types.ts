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

// Re-export the shared field-editor types from _shared/components/types
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
  /** Items to hide -- honoured on EVERY zone (rows, columns, filters, slicer
   *  fields), and THREE-state (mirrors `BiFieldRef` in @api/pivotTypes):
   *  - ABSENT: keep what this Table.Column hides on the pivot NOW. The editor
   *    sends this for every real field whose item filter it did not edit --
   *    a chip's own list is a display copy that a slicer, the header dropdown
   *    or a ribbon filter may have changed since (see biFieldsRequest.ts).
   *  - a non-empty list: exactly these are hidden.
   *  - `[]`: the filter was REMOVED (e.g. a deleted `NOT IN` clause).
   *  A calculation-group pseudo ref always carries its chip's item subset. */
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
  /** Fields needed only by slicers — included in the query but not shown as
   *  visible filter rows. ABSENT (or null) = KEEP the slicer fields the pivot
   *  already carries, with their hidden items; `[]` = clear them all; a list =
   *  exactly these (mirrors `UpdateBiPivotFieldsRequest` in @api/pivotTypes).
   *  The field-list editor never sends it, so a layout edit keeps every slicer
   *  and ribbon filter on the pivot. */
  slicerFields?: BiFieldRef[] | null;
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
