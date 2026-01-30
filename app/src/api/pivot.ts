//! FILENAME: app/src/api/pivot.ts
// PURPOSE: Pivot Table API Facade for extensions.
// CONTEXT: The ONLY entry point for the Pivot Extension to talk to the engine.
// Extensions import from this module instead of core/lib/pivot-api directly.

// Import internal core logic (allowed in the API layer, forbidden in extensions)
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
} from '../core/lib/pivot-api';

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
} from '../core/lib/pivot-api';

export type {
  PivotInteractiveBounds,
} from '../core/lib/gridRenderer/rendering/pivot';

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
};
