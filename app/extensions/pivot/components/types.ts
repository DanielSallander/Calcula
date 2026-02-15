//! FILENAME: app/extensions/pivot/components/types.ts
// Pivot Editor Types - Matching Rust backend definitions

export type PivotId = number;
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

// Source field from the data - used in the field list
export interface SourceField {
  index: FieldIndex;
  name: string;
  isNumeric: boolean;
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
  showValuesAs?: ShowValuesAs;
  // For filter fields
  hiddenItems?: string[];
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
  return `${aggLabel} of ${name}`;
}