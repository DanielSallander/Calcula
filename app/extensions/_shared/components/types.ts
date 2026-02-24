//! FILENAME: app/extensions/_shared/components/types.ts
// PURPOSE: Shared types for the field editor UI (used by Pivot and Tablix).
// CONTEXT: Drag-and-drop types, field representations, and aggregation helpers.

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
