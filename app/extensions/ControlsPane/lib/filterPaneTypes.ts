//! FILENAME: app/extensions/ControlsPane/lib/filterPaneTypes.ts
// PURPOSE: TypeScript types mirroring Rust ribbon_filter types.
// CONTEXT: Ribbon filter values always come from a Calcula model (BI)
//          connection; filters apply to the BI pivots of that connection.

export type ConnectionMode = "manual" | "bySheet" | "workbook";
export type RibbonFilterDisplayMode = "checklist" | "buttons" | "dropdown";

export type FieldDataType = "text" | "number" | "date" | "unknown";

export interface RibbonFilter {
  id: string;
  name: string;
  /** The Calcula model (BI) connection providing this filter's values. */
  connectionId: string;
  /** For filters on a package-pulled connection: the stable package
   *  data-source id (backend re-binds connectionId by it after re-pull). */
  dataSourceId?: string | null;
  /** Field to filter on, in "Table.Column" form. */
  fieldName: string;
  fieldDataType: FieldDataType;
  connectionMode: ConnectionMode;
  /** For manual mode: explicitly selected target pivots. */
  connectedPivots: string[];
  connectedSheets: number[];
  displayMode: RibbonFilterDisplayMode;
  selectedItems: string[] | null;
  crossFilterTargets: string[];
  crossFilterSlicerTargets: string[];
  advancedFilter: AdvancedFilter | null;
  hideNoData: boolean;
  indicateNoData: boolean;
  sortNoDataLast: boolean;
  showSelectAll: boolean;
  singleSelect: boolean;
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
  connectionId: string;
  fieldName: string;
  fieldDataType?: FieldDataType;
  connectionMode?: ConnectionMode;
  connectedPivots?: string[];
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
  connectedPivots?: string[];
  connectedSheets?: number[];
  crossFilterTargets?: string[];
  crossFilterSlicerTargets?: string[];
  advancedFilter?: AdvancedFilter | null;
  hideNoData?: boolean;
  indicateNoData?: boolean;
  sortNoDataLast?: boolean;
  showSelectAll?: boolean;
  singleSelect?: boolean;
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
