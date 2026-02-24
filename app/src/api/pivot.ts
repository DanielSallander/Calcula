//! FILENAME: app/src/api/pivot.ts
// PURPOSE: Pivot Table API Facade for extensions.
// CONTEXT: The ONLY entry point for the Pivot Extension to talk to the engine.
// Extensions import from this module instead of core/lib/pivot-api directly.

// Import from extension-local pivot-api (API layer bridges to extension code)
import {
  // Core operations
  createPivotTable,
  updatePivotFields,
  togglePivotGroup,
  getPivotView,
  deletePivotTable,
  refreshPivotCache,

  // Query operations
  getPivotSourceData,
  getPivotAtCell,
  getPivotRegionsForSheet,
  getPivotFieldUniqueValues,

  // Utility functions
  getCellNumericValue,
  getCellDisplayValue,
  isHeaderCell,
  isTotalCell,
  isFilterCell,
  isDataRow,
  isFilterRow,
  createFieldConfig,
  createValueFieldConfig,
  createLayoutConfig,

  // New Excel-compatible operations
  getPivotTableInfo,
  updatePivotProperties,
  getPivotLayoutRanges,
  updatePivotLayout,
  getPivotHierarchies,
  addPivotHierarchy,
  removePivotHierarchy,
  movePivotField,
  setPivotAggregation,
  setPivotNumberFormat,
  applyPivotFilter,
  clearPivotFilter,
  sortPivotField,
  getPivotFieldInfo,
  setPivotItemVisibility,
  getAllPivotTables,
  refreshAllPivotTables,

  // Expand/Collapse and Grouping
  setPivotItemExpanded,
  expandCollapseLevel,
  expandCollapseAll,
  groupPivotField,
  createManualGroup,
  ungroupPivotField,
  drillThroughToSheet,
} from '../../extensions/Pivot/lib/pivot-api';

// Re-export types so extensions can import them from this module
export type {
  PivotId,
  SortOrder,
  AggregationType,
  ShowValuesAs,
  ReportLayout,
  ValuesPosition,
  CreatePivotRequest,
  PivotFieldConfig,
  ValueFieldConfig,
  LayoutConfig,
  UpdatePivotFieldsRequest,
  ToggleGroupRequest,
  PivotCellValue,
  PivotCellType,
  BackgroundStyle,
  PivotRowType,
  PivotColumnType,
  PivotCellData,
  PivotRowData,
  PivotColumnData,
  FilterRowData,
  PivotViewResponse,
  SourceDataResponse,
  GroupPath,
  SourceFieldInfo,
  ZoneFieldInfo,
  PivotFieldConfiguration,
  FilterZoneInfo,
  PivotRegionInfo,
  PivotRegionData,
  FieldUniqueValuesResponse,
  // New Excel-compatible types
  PivotLayoutType,
  SubtotalLocationType,
  AggregationFunction,
  ShowAsCalculation,
  PivotFilterType,
  SortBy,
  PivotAxis,
  LabelFilterCondition,
  ValueFilterCondition,
  PivotLabelFilter,
  PivotValueFilter,
  PivotManualFilter,
  PivotFilters,
  ShowAsRule,
  Subtotals,
  ExtendedLayoutConfig,
  PivotTableInfo,
  RangeInfo,
  PivotLayoutRanges,
  PivotFieldInfoResponse,
  PivotItemInfo,
  DataHierarchyInfo,
  RowColumnHierarchyInfo,
  PivotHierarchiesInfo,
  UpdatePivotPropertiesRequest,
  UpdatePivotLayoutRequest,
  AddHierarchyRequest,
  RemoveHierarchyRequest,
  MoveFieldRequest,
  SetAggregationRequest,
  SetNumberFormatRequest,
  ApplyPivotFilterRequest,
  ClearPivotFilterRequest,
  SortPivotFieldRequest,
  SetItemVisibilityRequest,
  // Expand/Collapse and Grouping types
  SetItemExpandedRequest,
  ExpandCollapseLevelRequest,
  ExpandCollapseAllRequest,
  DateGroupLevel,
  ManualGroupConfig,
  FieldGroupingConfig,
  GroupFieldRequest,
  CreateManualGroupRequest,
  UngroupFieldRequest,
  DrillThroughRequest,
  DrillThroughResponse,
} from '../../extensions/Pivot/lib/pivot-api';

export type {
  PivotInteractiveBounds,
} from '../../extensions/Pivot/rendering/pivot';

/**
 * Pivot Table API Facade.
 * The ONLY entry point for the Pivot Extension to talk to the engine.
 */
export const pivot = {
  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  /** Creates a new pivot table from the specified source range. */
  create: createPivotTable,

  /** Updates the field configuration of an existing pivot table. */
  updateFields: updatePivotFields,

  /** Toggles the expand/collapse state of a pivot group. */
  toggleGroup: togglePivotGroup,

  /** Gets the current view of a pivot table. */
  getView: getPivotView,

  /** Deletes a pivot table. */
  delete: deletePivotTable,

  /** Refreshes the pivot cache from current grid data. */
  refreshCache: refreshPivotCache,

  // ---------------------------------------------------------------------------
  // Query operations
  // ---------------------------------------------------------------------------

  /** Gets source data for drill-down (detail view). */
  getSourceData: getPivotSourceData,

  /** Checks if a cell is within a pivot table region. */
  getAtCell: getPivotAtCell,

  /** Gets all pivot regions for the current sheet. */
  getRegionsForSheet: getPivotRegionsForSheet,

  /** Gets unique values for a specific field (used for filter dropdowns). */
  getFieldUniqueValues: getPivotFieldUniqueValues,

  // ---------------------------------------------------------------------------
  // Cell utility functions
  // ---------------------------------------------------------------------------

  /** Extracts the numeric value from a PivotCellValue. */
  getCellNumericValue,

  /** Extracts the display string from a PivotCellValue. */
  getCellDisplayValue,

  /** Checks if a cell is a header cell (row or column). */
  isHeaderCell,

  /** Checks if a cell is a total cell (subtotal or grand total). */
  isTotalCell,

  /** Checks if a cell is a filter cell. */
  isFilterCell,

  /** Checks if a row is a data row (not header or total). */
  isDataRow,

  /** Checks if a row is a filter row. */
  isFilterRow,

  // ---------------------------------------------------------------------------
  // Configuration builders
  // ---------------------------------------------------------------------------

  /** Creates a default field configuration for row/column areas. */
  createFieldConfig,

  /** Creates a default value field configuration. */
  createValueFieldConfig,

  /** Creates a default layout configuration. */
  createLayoutConfig,

  // ---------------------------------------------------------------------------
  // Excel-compatible API operations
  // ---------------------------------------------------------------------------

  /** Gets pivot table properties and info. */
  getInfo: getPivotTableInfo,

  /** Updates pivot table properties. */
  updateProperties: updatePivotProperties,

  /** Gets pivot layout ranges (data body, row labels, column labels, filter axis). */
  getLayoutRanges: getPivotLayoutRanges,

  /** Updates pivot layout properties. */
  updateLayout: updatePivotLayout,

  /** Gets all hierarchies info for a pivot table. */
  getHierarchies: getPivotHierarchies,

  /** Adds a field to a hierarchy. */
  addHierarchy: addPivotHierarchy,

  /** Removes a field from a hierarchy. */
  removeHierarchy: removePivotHierarchy,

  /** Moves a field between hierarchies. */
  moveField: movePivotField,

  /** Sets the aggregation function for a value field. */
  setAggregation: setPivotAggregation,

  /** Sets the number format for a value field. */
  setNumberFormat: setPivotNumberFormat,

  /** Applies a filter to a pivot field. */
  applyFilter: applyPivotFilter,

  /** Clears filters from a pivot field. */
  clearFilter: clearPivotFilter,

  /** Sorts a pivot field by labels. */
  sortField: sortPivotField,

  /** Gets pivot field info including items and filters. */
  getFieldInfo: getPivotFieldInfo,

  /** Sets a pivot item's visibility. */
  setItemVisibility: setPivotItemVisibility,

  /** Gets a list of all pivot tables in the workbook. */
  getAll: getAllPivotTables,

  /** Refreshes all pivot tables in the workbook. */
  refreshAll: refreshAllPivotTables,

  // ---------------------------------------------------------------------------
  // Expand/Collapse and Grouping
  // ---------------------------------------------------------------------------

  /** Sets the expand/collapse state of a specific pivot item. */
  setItemExpanded: setPivotItemExpanded,

  /** Expands or collapses all items at a specific field level. */
  expandCollapseLevel,

  /** Expands or collapses all fields in the entire pivot table. */
  expandCollapseAll,

  /** Applies grouping (date, number binning, or manual) to a pivot field. */
  groupPivotField,

  /** Creates a manual group on a pivot field. */
  createManualGroup,

  /** Removes all grouping from a pivot field. */
  ungroupPivotField,

  // ---------------------------------------------------------------------------
  // Drill-Through
  // ---------------------------------------------------------------------------

  /** Drill through a data cell to a new sheet with matching source rows. */
  drillThroughToSheet,
};
