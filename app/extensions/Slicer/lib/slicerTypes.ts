//! FILENAME: app/extensions/Slicer/lib/slicerTypes.ts
// PURPOSE: TypeScript interfaces mirroring Rust slicer types.

export type SlicerSourceType = "table" | "pivot";

/** A typed reference to a pivot or table that a slicer filters. */
export interface SlicerConnection {
  sourceType: SlicerSourceType;
  sourceId: string;
}

/** Selection behavior mode for a slicer. */
export type SlicerSelectionMode = "standard" | "single" | "multi";

/** Layout arrangement for slicer items. */
export type SlicerArrangement = "grid" | "horizontal" | "vertical";

export interface Slicer {
  id: string;
  name: string;
  headerText: string | null;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceType: SlicerSourceType;
  /** The pivot/table ID used as the data source for fetching slicer items. */
  cacheSourceId: string;
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
  /** Filter level: 1 = ordinary slicer, 2-9 = PINNED — a pinned slicer's
   * filter survives a measure's bare CLEAR/RESET/CLEAREXCEPT and is stripped
   * only by an explicit `CLEAR(…, LEVEL n)` at or above its level. */
  filterLevel: number;
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
  cacheSourceId: string;
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
  /** New filter level (1 = ordinary, 2-9 = pinned). */
  filterLevel?: number;
}

// ============================================================================
// Slicer Computed Properties
// ============================================================================

export interface SlicerComputedPropertyData {
  id: string;
  slicerId: string;
  attribute: string;
  formula: string;
  currentValue?: string;
}

export interface SlicerComputedPropertyResult {
  success: boolean;
  properties: SlicerComputedPropertyData[];
  slicerChanged?: boolean;
}
