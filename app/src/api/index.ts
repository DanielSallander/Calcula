//! FILENAME: app/src/api/index.ts
// PURPOSE: Public API facade for extensions.
// CONTEXT: Extensions should ONLY import from this module (or its submodules).
// This ensures a stable API surface and enforces architectural boundaries.
//
// ARCHITECTURE RULES:
// 1. Core must NEVER import from api, shell, or extensions
// 2. Extensions must ONLY import from api
// 3. Shell can import from core and api

// ============================================================================
// Events - Application-wide event system
// ============================================================================
export { AppEvents, emitAppEvent, onAppEvent, restoreFocusToGrid } from "./events";
export type { AppEventType } from "./events";

// ============================================================================
// Types - Core type definitions
// ============================================================================
export type {
  Selection,
  SelectionType,
  Viewport,
  ClipboardMode,
  GridConfig,
  FreezeConfig,
  DimensionOverrides,
  EditingCell,
  CellData,
  StyleData,
  DimensionData,
  FormattingOptions,
  FormattingResult,
  FunctionInfo,
  FormulaReference,
  MergedRegion,
  PivotRegionData,
} from "./types";

export { DEFAULT_FREEZE_CONFIG, DEFAULT_GRID_CONFIG } from "./types";

// ============================================================================
// Extensions - Extension registration APIs
// ============================================================================
export {
  ExtensionRegistry,
  gridExtensions,
  gridCommands,
  isClickWithinSelection,
  GridMenuGroups,
  registerCoreGridContextMenu,
  sheetExtensions,
  registerCoreSheetContextMenu,
  TaskPaneExtensions,
  DialogExtensions,
  OverlayExtensions,
} from "./extensions";

export type {
  AddInManifest,
  CommandDefinition,
  RibbonTabDefinition,
  RibbonGroupDefinition,
  RibbonContext,
  GridMenuContext,
  GridContextMenuItem,
  SheetContext,
  SheetContextMenuItem,
  TaskPaneViewDefinition,
  TaskPaneViewProps,
  TaskPaneContextKey,
  DialogDefinition,
  DialogProps,
  OverlayDefinition,
  OverlayProps,
  OverlayLayer,
  AnchorRect,
} from "./extensions";

// ============================================================================
// Library - Backend API functions
// ============================================================================
export {
  // Tauri API
  getViewportCells,
  getCell,
  updateCell,
  clearCell,
  clearRange,
  getGridBounds,
  getCellCount,
  findCtrlArrowTarget,
  indexToCol,
  colToIndex,
  setColumnWidth,
  getColumnWidth,
  getAllColumnWidths,
  setRowHeight,
  getRowHeight,
  getAllRowHeights,
  getStyle,
  getAllStyles,
  setCellStyle,
  applyFormatting,
  getStyleCount,
  getFunctionsByCategory,
  getAllFunctions,
  getFunctionTemplate,
  setCalculationMode,
  getCalculationMode,
  calculateNow,
  calculateSheet,
  getSheets,
  getActiveSheet,
  setActiveSheet,
  addSheet,
  deleteSheet,
  renameSheet,
  insertRows,
  insertColumns,
  deleteRows,
  deleteColumns,
  getUndoState,
  undo,
  redo,
  findAll,
  countMatches,
  replaceAll,
  replaceSingle,
  setFreezePanes,
  getFreezePanes,
  mergeCells,
  unmergeCells,
  getMergedRegions,
  getMergeInfo,
  // Pivot API
  createPivotTable,
  updatePivotFields,
  togglePivotGroup,
  getPivotView,
  deletePivotTable,
  refreshPivotCache,
  getPivotSourceData,
  getPivotAtCell,
  getPivotRegionsForSheet,
  getPivotFieldUniqueValues,
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
} from "./lib";

export type {
  ArrowDirection,
  SheetInfo,
  SheetsResult,
  UndoState,
  UndoResult,
  FindResult,
  ReplaceResult,
  FindOptions,
  TauriFreezeConfig,
  TauriMergedRegion,
  MergeResult,
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
  FieldUniqueValuesResponse,
} from "./lib";

// ============================================================================
// Components - UI components for extensions
// ============================================================================
export {
  RibbonButton,
  RibbonGroup,
  RibbonSeparator,
  RibbonDropdownButton,
} from "./components";

export type {
  RibbonButtonProps,
  RibbonGroupProps,
  RibbonDropdownButtonProps,
} from "./components";

// Re-export ribbon styles
export * from "../shell/Ribbon/styles";
