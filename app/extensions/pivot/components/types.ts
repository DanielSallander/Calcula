//! FILENAME: app/extensions/pivot/components/types.ts
// Pivot Editor Types - Matching Rust backend definitions
// Shared types are re-exported from _shared/components/types

import type {
  FieldIndex,
  SourceField,
  ZoneField,
  AggregationType,
  SortOrder,
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
}

// Update request matching UpdatePivotFieldsRequest in pivot_commands.rs
export interface UpdatePivotFieldsRequest {
  pivotId: PivotId;
  rowFields?: PivotFieldConfig[];
  columnFields?: PivotFieldConfig[];
  valueFields?: ValueFieldConfig[];
  filterFields?: PivotFieldConfig[];
  layout?: LayoutConfig;
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
