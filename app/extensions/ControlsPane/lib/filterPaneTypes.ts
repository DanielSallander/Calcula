//! FILENAME: app/extensions/ControlsPane/lib/filterPaneTypes.ts
// PURPOSE: TypeScript types mirroring Rust ribbon_filter types.
// CONTEXT: Ribbon filter values always come from a Calcula model (BI)
//          connection; filters apply to the visuals of that connection --
//          its BI pivots (the backend route) and its charts, cards, KPIs and
//          gauges (through @api/reportFilters, filterReportPublisher.ts).

import type { VisualRef } from "@api/reportFilters";

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
  /** For manual mode ("Selected visuals"): the selected target pivots. The
   *  other selected visuals are in `connectedVisuals`. */
  connectedPivots: string[];
  connectedSheets: number[];
  /** For manual mode ("Selected visuals"): the non-pivot visuals this filter
   *  reaches, by canvas object ref. Pivots stay in `connectedPivots`. Absent on
   *  the wire when empty; cleared by the backend outside manual mode. */
  connectedVisuals?: VisualRef[];
  displayMode: RibbonFilterDisplayMode;
  selectedItems: string[] | null;
  dependentFilters: string[];
  dependentSlicers: string[];
  advancedFilter: AdvancedFilter | null;
  hideNoData: boolean;
  indicateNoData: boolean;
  sortNoDataLast: boolean;
  showSelectAll: boolean;
  singleSelect: boolean;
  order: number;
  buttonColumns: number;
  buttonRows: number;
  /** Filter level: 1 = ordinary, 2-9 = PINNED — a pinned filter survives a
   * measure's bare CLEAR/RESET/CLEAREXCEPT and is stripped only by an
   * explicit `CLEAR(…, LEVEL n)` at or above its level. */
  filterLevel: number;
}

/** One member of the list with its state (mirrors Rust `slicer::types::SlicerItem`). */
export interface SlicerItem {
  /** The member KEY (invariant canonical text): what the selection stores and
   *  what selection, has-data and filters match on. The blank member's key is
   *  "" (ruling Q8). */
  key: string;
  /** The app-locale display text ("(Blank)" for the blank member). Shown,
   *  searched, never matched on. */
  label: string;
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
  /** Manual mode's "Selected visuals" (see `RibbonFilter.connectedVisuals`). */
  connectedVisuals?: VisualRef[];
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
  /** Replaces the "Selected visuals" list (manual mode only). */
  connectedVisuals?: VisualRef[];
  dependentFilters?: string[];
  dependentSlicers?: string[];
  advancedFilter?: AdvancedFilter | null;
  hideNoData?: boolean;
  indicateNoData?: boolean;
  sortNoDataLast?: boolean;
  showSelectAll?: boolean;
  singleSelect?: boolean;
  /** New filter level (1 = ordinary, 2-9 = pinned). */
  filterLevel?: number;
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
