//! FILENAME: app/extensions/Tablix/lib/tablix-api.ts
/**
 * Tablix API
 *
 * TypeScript bindings for the Tauri tablix commands.
 * Provides a clean async interface for creating, updating, and querying tablix reports.
 *
 * ARCHITECTURE NOTE: This file uses the API facade (src/api/backend.ts) instead of
 * importing directly from @tauri-apps/api. This ensures extensions go through the
 * sandboxed API layer, maintaining the Microkernel architecture.
 */

import {
  createTablix as apiCreateTablix,
  updateTablixFields as apiUpdateTablixFields,
  getTablixView as apiGetTablixView,
  deleteTablix as apiDeleteTablix,
  toggleTablixGroup as apiToggleTablixGroup,
  getTablixAtCell as apiGetTablixAtCell,
  getTablixRegionsForSheet as apiGetTablixRegionsForSheet,
  convertPivotToTablix as apiConvertPivotToTablix,
  convertTablixToPivot as apiConvertTablixToPivot,
  refreshTablixCache as apiRefreshTablixCache,
  getTablixFieldUniqueValues as apiGetTablixFieldUniqueValues,
} from '../../../src/api/backend';

// ============================================================================
// Types
// ============================================================================

export type TablixId = number;

/** Data field mode */
export type DataFieldMode = 'aggregated' | 'detail';

/** Group layout */
export type GroupLayout = 'stepped' | 'block';

/** Sort order for fields */
export type SortOrder = 'asc' | 'desc' | 'manual' | 'source';

/** Aggregation types for value fields */
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

/** Request to create a new tablix */
export interface CreateTablixRequest {
  sourceRange: string;
  destinationCell: string;
  sourceSheet?: number;
  destinationSheet?: number;
  hasHeaders?: boolean;
  name?: string;
}

/** Field configuration for row/column groups */
export interface TablixFieldConfig {
  sourceIndex: number;
  name: string;
  sortOrder?: SortOrder;
  showSubtotals?: boolean;
  collapsed?: boolean;
  hiddenItems?: string[];
}

/** Data field configuration */
export interface TablixDataFieldConfig {
  sourceIndex: number;
  name: string;
  mode: DataFieldMode;
  aggregation?: AggregationType;
  numberFormat?: string;
}

/** Layout configuration */
export interface TablixLayoutConfig {
  showRowGrandTotals?: boolean;
  showColumnGrandTotals?: boolean;
  groupLayout?: GroupLayout;
  repeatGroupLabels?: boolean;
  showEmptyGroups?: boolean;
}

/** Request to update tablix fields */
export interface UpdateTablixFieldsRequest {
  tablixId: TablixId;
  rowGroups?: TablixFieldConfig[];
  columnGroups?: TablixFieldConfig[];
  dataFields?: TablixDataFieldConfig[];
  filterFields?: TablixFieldConfig[];
  layout?: TablixLayoutConfig;
}

/** Request to toggle a group's expand/collapse state */
export interface ToggleTablixGroupRequest {
  tablixId: TablixId;
  isRow: boolean;
  fieldIndex: number;
  value?: string;
}

/** Cell value types */
export type TablixCellValue =
  | { type: 'Empty' }
  | { type: 'Number'; data: number }
  | { type: 'Text'; data: string }
  | { type: 'Boolean'; data: boolean }
  | { type: 'Error'; data: string };

/** Cell type identifiers */
export type TablixCellType =
  | 'corner'
  | 'rowGroupHeader'
  | 'columnGroupHeader'
  | 'aggregatedData'
  | 'detailData'
  | 'rowSubtotal'
  | 'columnSubtotal'
  | 'grandTotalRow'
  | 'grandTotalColumn'
  | 'grandTotal'
  | 'blank'
  | 'filterLabel'
  | 'filterDropdown';

/** Background style for cells */
export type TablixBackgroundStyle =
  | 'normal'
  | 'header'
  | 'subtotal'
  | 'total'
  | 'grandTotal'
  | 'alternate'
  | 'filterRow'
  | 'detailRow'
  | 'detailRowAlternate';

/** Row type identifiers */
export type TablixRowType =
  | 'columnHeader'
  | 'groupHeader'
  | 'detail'
  | 'subtotal'
  | 'grandTotal'
  | 'filterRow';

/** Column type identifiers */
export type TablixColumnType =
  | 'rowGroupLabel'
  | 'data'
  | 'subtotal'
  | 'grandTotal';

/** Cell data from the backend */
export interface TablixCellData {
  cellType: TablixCellType;
  value: TablixCellValue;
  formattedValue: string;
  indentLevel: number;
  isBold: boolean;
  isExpandable: boolean;
  isCollapsed: boolean;
  isSpanned: boolean;
  rowSpan: number;
  colSpan: number;
  backgroundStyle: TablixBackgroundStyle;
  numberFormat?: string;
  filterFieldIndex?: number;
}

/** Row data from the backend */
export interface TablixRowData {
  viewRow: number;
  rowType: TablixRowType;
  depth: number;
  visible: boolean;
  sourceRow?: number;
  cells: TablixCellData[];
}

/** Column descriptor from the backend */
export interface TablixColumnData {
  viewCol: number;
  colType: TablixColumnType;
  depth: number;
  widthHint: number;
}

/** Filter row metadata */
export interface TablixFilterRowData {
  fieldIndex: number;
  fieldName: string;
  selectedValues: string[];
  uniqueValues: string[];
  displayValue: string;
  viewRow: number;
}

/** Complete tablix view response */
export interface TablixViewResponse {
  tablixId: TablixId;
  version: number;
  rowCount: number;
  colCount: number;
  rowGroupColCount: number;
  columnHeaderRowCount: number;
  filterRowCount: number;
  filterRows: TablixFilterRowData[];
  rows: TablixRowData[];
  columns: TablixColumnData[];
}

/** Source field info from tablix region check */
export interface SourceFieldInfo {
  index: number;
  name: string;
  isNumeric: boolean;
}

/** Zone field info - represents a field assigned to a zone */
export interface ZoneFieldInfo {
  sourceIndex: number;
  name: string;
  isNumeric: boolean;
  mode?: string;
  aggregation?: string;
}

/** Current field configuration for the tablix editor */
export interface TablixFieldConfiguration {
  rowGroups: ZoneFieldInfo[];
  columnGroups: ZoneFieldInfo[];
  dataFields: ZoneFieldInfo[];
  filterFields: ZoneFieldInfo[];
  layout: TablixLayoutConfig;
}

/** Info about a filter dropdown cell position */
export interface TablixFilterZoneInfo {
  row: number;
  col: number;
  fieldIndex: number;
  fieldName: string;
}

/** Tablix region info returned when checking if a cell is in a tablix */
export interface TablixRegionInfo {
  tablixId: TablixId;
  isEmpty: boolean;
  sourceFields: SourceFieldInfo[];
  fieldConfiguration: TablixFieldConfiguration;
  filterZones: TablixFilterZoneInfo[];
}

/** Tablix region data for rendering placeholders */
export interface TablixRegionData {
  tablixId: TablixId;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  isEmpty: boolean;
}

/** Conversion response */
export interface ConversionResponse {
  newId: number;
  migratedDetailFields: string[];
}

/** Field unique values response */
export interface TablixFieldUniqueValuesResponse {
  fieldIndex: number;
  fieldName: string;
  uniqueValues: string[];
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Creates a new tablix from the specified source range.
 */
export async function createTablix(
  request: CreateTablixRequest
): Promise<TablixViewResponse> {
  return apiCreateTablix<CreateTablixRequest, TablixViewResponse>(request);
}

/**
 * Updates the field configuration of an existing tablix.
 */
export async function updateTablixFields(
  request: UpdateTablixFieldsRequest
): Promise<TablixViewResponse> {
  return apiUpdateTablixFields<UpdateTablixFieldsRequest, TablixViewResponse>(request);
}

/**
 * Gets the current view of a tablix.
 */
export async function getTablixView(tablixId?: TablixId): Promise<TablixViewResponse> {
  return apiGetTablixView<TablixViewResponse>(tablixId);
}

/**
 * Deletes a tablix.
 */
export async function deleteTablix(tablixId: TablixId): Promise<void> {
  return apiDeleteTablix(tablixId);
}

/**
 * Toggles the expand/collapse state of a tablix group.
 */
export async function toggleTablixGroup(
  request: ToggleTablixGroupRequest
): Promise<TablixViewResponse> {
  return apiToggleTablixGroup<ToggleTablixGroupRequest, TablixViewResponse>(request);
}

/**
 * Checks if a cell is within a tablix region.
 */
export async function getTablixAtCell(
  row: number,
  col: number
): Promise<TablixRegionInfo | null> {
  return apiGetTablixAtCell<TablixRegionInfo>(row, col);
}

/**
 * Gets all tablix regions for the current sheet.
 */
export async function getTablixRegionsForSheet(): Promise<TablixRegionData[]> {
  return apiGetTablixRegionsForSheet<TablixRegionData>();
}

/** Convert request type */
export interface ConvertRequest {
  id: number;
}

/**
 * Converts a pivot table to a tablix.
 */
export async function convertPivotToTablix(
  pivotId: number
): Promise<ConversionResponse> {
  return apiConvertPivotToTablix<ConvertRequest, ConversionResponse>({ id: pivotId });
}

/**
 * Converts a tablix to a pivot table.
 * Returns migrated detail field names if any were converted.
 */
export async function convertTablixToPivot(
  tablixId: number
): Promise<ConversionResponse> {
  return apiConvertTablixToPivot<ConvertRequest, ConversionResponse>({ id: tablixId });
}

/**
 * Refreshes the tablix cache from current grid data.
 */
export async function refreshTablixCache(tablixId: TablixId): Promise<TablixViewResponse> {
  return apiRefreshTablixCache<TablixViewResponse>(tablixId);
}

/**
 * Gets unique values for a specific field in a tablix's source data.
 */
export async function getTablixFieldUniqueValues(
  tablixId: TablixId,
  fieldIndex: number
): Promise<TablixFieldUniqueValuesResponse> {
  return apiGetTablixFieldUniqueValues<TablixFieldUniqueValuesResponse>(tablixId, fieldIndex);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Extracts the numeric value from a TablixCellValue.
 */
export function getCellNumericValue(value: TablixCellValue): number {
  if (value.type === 'Number') {
    return value.data;
  }
  return 0;
}

/**
 * Extracts the display string from a TablixCellValue.
 */
export function getCellDisplayValue(value: TablixCellValue): string {
  switch (value.type) {
    case 'Empty':
      return '';
    case 'Number':
      return value.data.toString();
    case 'Text':
      return value.data;
    case 'Boolean':
      return value.data ? 'TRUE' : 'FALSE';
    case 'Error':
      return `#${value.data}`;
  }
}

/**
 * Checks if a cell type is a header cell.
 */
export function isHeaderCell(cellType: TablixCellType): boolean {
  return cellType === 'rowGroupHeader' || cellType === 'columnGroupHeader' || cellType === 'corner';
}

/**
 * Checks if a cell type is a total cell.
 */
export function isTotalCell(cellType: TablixCellType): boolean {
  return (
    cellType === 'rowSubtotal' ||
    cellType === 'columnSubtotal' ||
    cellType === 'grandTotal' ||
    cellType === 'grandTotalRow' ||
    cellType === 'grandTotalColumn'
  );
}

/**
 * Checks if a cell type is a detail data cell.
 */
export function isDetailCell(cellType: TablixCellType): boolean {
  return cellType === 'detailData';
}

/**
 * Checks if a cell type is a filter cell.
 */
export function isFilterCell(cellType: TablixCellType): boolean {
  return cellType === 'filterLabel' || cellType === 'filterDropdown';
}

/**
 * Checks if a row is a detail row.
 */
export function isDetailRow(rowType: TablixRowType): boolean {
  return rowType === 'detail';
}

/**
 * Checks if a row is a filter row.
 */
export function isFilterRow(rowType: TablixRowType): boolean {
  return rowType === 'filterRow';
}
