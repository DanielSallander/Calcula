//! FILENAME: app/extensions/Slicer/lib/slicerTypes.ts
// PURPOSE: TypeScript interfaces mirroring Rust slicer types.

export type SlicerSourceType = "table" | "pivot";

/** A typed reference to a pivot or table that a slicer filters. */
export interface SlicerConnection {
  sourceType: SlicerSourceType;
  sourceId: number;
}

/** Selection behavior mode for a slicer. */
export type SlicerSelectionMode = "standard" | "single" | "multi";

/** Layout arrangement for slicer items. */
export type SlicerArrangement = "grid" | "horizontal" | "vertical";

export interface Slicer {
  id: number;
  name: string;
  headerText: string | null;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceType: SlicerSourceType;
  /** The pivot/table ID used as the data source for fetching slicer items. */
  cacheSourceId: number;
  fieldName: string;
  selectedItems: string[] | null;
  showHeader: boolean;
  columns: number;
  stylePreset: string;
  selectionMode: SlicerSelectionMode;
  hideNoData: boolean;
  indicateNoData: boolean;
  sortNoDataLast: boolean;
  forceSelection: boolean;
  showSelectAll: boolean;
  arrangement: SlicerArrangement;
  rows: number;
  itemGap: number;
  autogrid: boolean;
  itemPadding: number;
  buttonRadius: number;
  connectedSources: SlicerConnection[];
}

export interface SlicerItem {
  value: string;
  selected: boolean;
  hasData: boolean;
}

export interface CreateSlicerParams {
  name: string;
  sheetIndex: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  sourceType: SlicerSourceType;
  /** The pivot/table ID used as the data source for fetching slicer items. */
  cacheSourceId: number;
  fieldName: string;
  /** Initial Report Connections (pivots/tables this slicer filters). */
  connectedSources: SlicerConnection[];
  columns?: number;
  stylePreset?: string;
}

export interface UpdateSlicerParams {
  name?: string;
  headerText?: string | null;
  showHeader?: boolean;
  columns?: number;
  stylePreset?: string;
  selectionMode?: SlicerSelectionMode;
  hideNoData?: boolean;
  indicateNoData?: boolean;
  sortNoDataLast?: boolean;
  forceSelection?: boolean;
  showSelectAll?: boolean;
  arrangement?: SlicerArrangement;
  rows?: number;
  itemGap?: number;
  autogrid?: boolean;
  itemPadding?: number;
  buttonRadius?: number;
  connectedSources?: SlicerConnection[];
}

// ============================================================================
// Slicer Computed Properties
// ============================================================================

export interface SlicerComputedPropertyData {
  id: number;
  slicerId: number;
  attribute: string;
  formula: string;
  currentValue?: string;
}

export interface SlicerComputedPropertyResult {
  success: boolean;
  properties: SlicerComputedPropertyData[];
  slicerChanged?: boolean;
}
