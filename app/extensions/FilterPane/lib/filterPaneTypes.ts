//! FILENAME: app/extensions/FilterPane/lib/filterPaneTypes.ts
// PURPOSE: TypeScript types mirroring Rust ribbon_filter types.

export type ConnectionMode = "manual" | "bySheet" | "workbook";
export type RibbonFilterDisplayMode = "checklist" | "buttons" | "dropdown";
export type SlicerSourceType = "table" | "pivot" | "biConnection";

export interface SlicerConnection {
  sourceType: SlicerSourceType;
  sourceId: number;
}

export type FieldDataType = "text" | "number" | "date" | "unknown";

export interface RibbonFilter {
  id: number;
  name: string;
  sourceType: SlicerSourceType;
  cacheSourceId: number;
  fieldName: string;
  fieldDataType: FieldDataType;
  connectionMode: ConnectionMode;
  connectedSources: SlicerConnection[];
  connectedSheets: number[];
  displayMode: RibbonFilterDisplayMode;
  selectedItems: string[] | null;
  crossFilterTargets: number[];
  advancedFilter: AdvancedFilter | null;
  order: number;
  buttonColumns: number;
  buttonRows: number;
}

export interface SlicerItem {
  value: string;
  selected: boolean;
  hasData: boolean;
}

export interface CreateRibbonFilterParams {
  name: string;
  sourceType: SlicerSourceType;
  cacheSourceId: number;
  fieldName: string;
  fieldDataType?: FieldDataType;
  connectionMode?: ConnectionMode;
  connectedSources?: SlicerConnection[];
  connectedSheets?: number[];
  displayMode?: RibbonFilterDisplayMode;
  order?: number;
}

export interface UpdateRibbonFilterParams {
  name?: string;
  displayMode?: RibbonFilterDisplayMode;
  order?: number;
  buttonColumns?: number;
  buttonRows?: number;
  connectionMode?: ConnectionMode;
  connectedSources?: SlicerConnection[];
  connectedSheets?: number[];
  crossFilterTargets?: number[];
  advancedFilter?: AdvancedFilter | null;
}

export type AdvancedFilterOperator =
  // Numeric
  | "isLessThan"
  | "isLessThanOrEqualTo"
  | "isGreaterThan"
  | "isGreaterThanOrEqualTo"
  // Text
  | "contains"
  | "doesNotContain"
  | "startsWith"
  | "doesNotStartWith"
  // Date
  | "isAfter"
  | "isOnOrAfter"
  | "isBefore"
  | "isOnOrBefore"
  // Common
  | "is"
  | "isNot"
  | "isBlank"
  | "isNotBlank"
  | "isEmpty"
  | "isNotEmpty";

export type AdvancedFilterLogic = "and" | "or";

export interface AdvancedFilterCondition {
  operator: AdvancedFilterOperator;
  value: string;
}

export interface AdvancedFilter {
  condition1: AdvancedFilterCondition;
  condition2?: AdvancedFilterCondition | null;
  logic: AdvancedFilterLogic;
}
