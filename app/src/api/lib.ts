//! FILENAME: app/src/api/lib.ts
// PURPOSE: Backend API wrappers for extensions.
// CONTEXT: Extensions call these functions to interact with the Tauri backend.

// ============================================================================
// Tauri API - Core spreadsheet operations
// ============================================================================

export {
  // Cell operations
  getViewportCells,
  getCell,
  updateCell,
  clearCell,
  clearRange,
  getGridBounds,
  getCellCount,

  // Navigation
  findCtrlArrowTarget,
  indexToCol,
  colToIndex,

  // Dimensions
  setColumnWidth,
  getColumnWidth,
  getAllColumnWidths,
  setRowHeight,
  getRowHeight,
  getAllRowHeights,

  // Styles
  getStyle,
  getAllStyles,
  setCellStyle,
  applyFormatting,
  getStyleCount,

  // Functions
  getFunctionsByCategory,
  getAllFunctions,
  getFunctionTemplate,

  // Calculation
  setCalculationMode,
  getCalculationMode,
  calculateNow,
  calculateSheet,

  // Sheets
  getSheets,
  getActiveSheet,
  setActiveSheet,
  addSheet,
  deleteSheet,
  renameSheet,

  // Row/Column operations
  insertRows,
  insertColumns,
  deleteRows,
  deleteColumns,

  // Undo/Redo
  getUndoState,
  undo,
  redo,

  // Find & Replace
  findAll,
  countMatches,
  replaceAll,
  replaceSingle,

  // Freeze panes
  setFreezePanes,
  getFreezePanes,

  // Merge cells
  mergeCells,
  unmergeCells,
  getMergedRegions,
  getMergeInfo,
} from "../core/lib/tauri-api";

// Type exports from tauri-api
export type {
  ArrowDirection,
  SheetInfo,
  SheetsResult,
  UndoState,
  UndoResult,
  FindResult,
  ReplaceResult,
  FindOptions,
  FreezeConfig as TauriFreezeConfig,
  MergedRegion as TauriMergedRegion,
  MergeResult,
} from "../core/lib/tauri-api";

// ============================================================================
// Pivot API - Pivot table operations
// ============================================================================

export {
  // Core pivot operations
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
} from "../../extensions/Pivot/lib/pivot-api";

// ============================================================================
// Grid Renderer - Pivot interactive bounds
// ============================================================================

export type {
  PivotInteractiveBounds,
} from "../../extensions/Pivot/rendering/pivot";

// Type exports from pivot-api
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
} from "../../extensions/Pivot/lib/pivot-api";
