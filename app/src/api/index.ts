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
  // Selection and viewport
  Selection,
  SelectionType,
  Viewport,
  ClipboardMode,

  // Grid configuration
  GridConfig,
  FreezeConfig,
  DimensionOverrides,

  // Editing state
  EditingCell,

  // Cell data
  CellData,
  StyleData,
  DimensionData,

  // Formatting
  FormattingOptions,
  FormattingResult,

  // Functions
  FunctionInfo,

  // Formula references
  FormulaReference,

  // Merged cells
  MergedRegion,

  // Pivot regions
  PivotRegionData,
} from "./types";

export { DEFAULT_FREEZE_CONFIG, DEFAULT_GRID_CONFIG } from "./types";

// ============================================================================
// UI - Task Pane, Dialog, and Overlay registration
// ============================================================================
export {
  // Task Pane
  TaskPaneExtensions,
  registerTaskPane,
  unregisterTaskPane,
  openTaskPane,
  closeTaskPane,
  getTaskPane,

  // Task Pane - Additional accessors for extensions
  showTaskPaneContainer,
  hideTaskPaneContainer,
  isTaskPaneContainerOpen,
  getTaskPaneManuallyClosed,
  clearTaskPaneManuallyClosed,
  useIsTaskPaneOpen,
  useOpenTaskPaneAction,
  useCloseTaskPaneAction,

  // Dialogs
  DialogExtensions,
  registerDialog,
  unregisterDialog,
  showDialog,
  hideDialog,

  // Overlays
  OverlayExtensions,
  registerOverlay,
  unregisterOverlay,
  showOverlay,
  hideOverlay,
  hideAllOverlays,
} from "./ui";

export type {
  TaskPaneViewDefinition,
  TaskPaneViewProps,
  TaskPaneContextKey,
  DialogDefinition,
  DialogProps,
  OverlayDefinition,
  OverlayProps,
  OverlayLayer,
  AnchorRect,
} from "./ui";

// ============================================================================
// Extensions - Extension registry and context menus
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
} from "./extensions";

// ============================================================================
// Library - Backend API functions (Tauri / non-pivot)
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
  // Pivot API (legacy bare exports - prefer importing `pivot` from "./pivot")
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
  PivotInteractiveBounds,
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

// ============================================================================
// Grid - Grid operations (freeze panes, etc.)
// ============================================================================
export {
  freezePanes,
  loadFreezePanesConfig,
  getFreezePanesConfig,
} from "./grid";

// ============================================================================
// Filesystem - File operations (legacy bare exports - prefer `workspace` from "./system")
// ============================================================================
export {
  newFile,
  openFile,
  saveFile,
  saveFileAs,
  isFileModified,
  markFileModified,
  getCurrentFilePath,
} from "./filesystem";

// ============================================================================
// System API - Workspace facade (preferred over bare filesystem exports)
// ============================================================================
export { workspace } from "./system";

// ============================================================================
// Pivot API - Pivot facade (preferred over bare pivot exports from lib)
// ============================================================================
export { pivot } from "./pivot";