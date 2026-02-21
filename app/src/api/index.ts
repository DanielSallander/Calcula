//! FILENAME: app/src/api/index.ts
// PURPOSE: Public API barrel export for the application.
// CONTEXT: Extensions and Shell components import from here.
// UPDATED: Removed Find actions - Find state now lives in the FindReplaceDialog extension.

// ============================================================================
// Commands
// ============================================================================

export { CoreCommands, CommandRegistry } from "./commands";
export type { ICommandRegistry } from "./commands";

// ============================================================================
// Contract (Extension types)
// ============================================================================

export type { ExtensionContext, ExtensionManifest, ExtensionModule } from "./contract";

// ============================================================================
// Grid API
// ============================================================================

export {
  // Context hooks
  useGridContext,
  useGridState,
  useGridDispatch,
  // Actions (Find actions removed - they live in FindReplaceDialog extension)
  setSelection,
  clearSelection,
  extendSelection,
  moveSelection,
  setViewport,
  updateScroll,
  scrollBy,
  scrollToCell,
  scrollToPosition,
  startEditing,
  updateEditing,
  stopEditing,
  updateConfig,
  setViewportSize,
  setViewportDimensions,
  expandVirtualBounds,
  setVirtualBounds,
  resetVirtualBounds,
  setFormulaReferences,
  clearFormulaReferences,
  setColumnWidth,
  setRowHeight,
  setAllDimensions,
  setClipboard,
  clearClipboard,
  setSheetContext,
  setActiveSheet,
  setFreezeConfig,
  setHiddenRows,
  setHiddenCols,
  setManuallyHiddenRows,
  setManuallyHiddenCols,
  setGroupHiddenRows,
  setGroupHiddenCols,
} from "./grid";

export type { GridAction, SetSelectionPayload } from "./grid";

// ============================================================================
// Backend API (Sheets, Cells, etc.)
// ============================================================================

export {
  findAll,
  replaceAll,
  replaceSingle,
  getCell,
  getViewportCells,
  getMergeInfo,
  detectDataRegion,
  getSheets,
  addSheet,
  deleteSheet,
  renameSheet,
  indexToCol,
  colToIndex,
  setActiveSheet as setActiveSheetApi,
  setCellStyle,
  beginUndoTransaction,
  commitUndoTransaction,
  removeDuplicates,
  updateCellsBatch,
} from "./lib";

export type {
  LayoutConfig,
  AggregationType,
  SheetInfo,
  SheetsResult,
  RemoveDuplicatesResult,
  CellUpdateInput,
} from "./lib";

// ============================================================================
// Goal Seek API
// ============================================================================

export {
  goalSeek,
} from "./lib";

export type {
  GoalSeekParams,
  GoalSeekResult,
} from "./lib";

// ============================================================================
// AutoFilter API
// ============================================================================

export {
  applyAutoFilter,
  clearColumnCriteria,
  clearAutoFilterCriteria,
  reapplyAutoFilter,
  removeAutoFilter,
  getAutoFilter,
  getAutoFilterRange,
  getHiddenRows,
  isRowFiltered,
  getFilterUniqueValues,
  setColumnFilterValues,
  setColumnCustomFilter,
  setColumnTopBottomFilter,
  setColumnDynamicFilter,
} from "./lib";

export type {
  AutoFilterInfo,
  AutoFilterResult,
  FilterCriteria,
  FilterOn,
  DynamicFilterCriteria,
  FilterOperator,
  UniqueValue,
  UniqueValuesResult,
} from "./lib";

// ============================================================================
// Grouping / Outline API
// ============================================================================

export {
  groupRows,
  ungroupRows,
  groupColumns,
  ungroupColumns,
  collapseRowGroup,
  expandRowGroup,
  collapseColumnGroup,
  expandColumnGroup,
  showOutlineLevel,
  getOutlineInfo,
  getHiddenRowsByGroup,
  getHiddenColsByGroup,
  clearOutline,
  getOutlineSettings,
  setOutlineSettings,
} from "./lib";

export type {
  GroupResult,
  OutlineInfo,
  OutlineSettings,
  SummaryPosition,
  RowOutlineSymbol,
  ColOutlineSymbol,
  RowGroup,
  ColumnGroup,
  SheetOutline,
} from "./lib";

// ============================================================================
// Cell Events
// ============================================================================

export { cellEvents } from "./cellEvents";

// ============================================================================
// Types (utility functions & types)
// ============================================================================

export { columnToLetter, letterToColumn, isFormulaExpectingReference } from "./types";

// ============================================================================
// Grid Dispatch Bridge (for non-React code)
// ============================================================================

export { dispatchGridAction } from "./gridDispatch";

// ============================================================================
// Edit Guards
// ============================================================================

export { registerEditGuard } from "./editGuards";

// ============================================================================
// Commit Guards
// ============================================================================

export { registerCommitGuard } from "./commitGuards";
export type { CommitGuardResult, CommitGuardFn } from "./commitGuards";

// ============================================================================
// Cell Click Interceptors
// ============================================================================

export { registerCellClickInterceptor } from "./cellClickInterceptors";

// ============================================================================
// Events
// ============================================================================

export { AppEvents, emitAppEvent, onAppEvent, restoreFocusToGrid } from "./events";
export type { AppEventName } from "./events";

// ============================================================================
// Extension Registry & Extensions
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
// Context Menu Types
// ============================================================================

export type { ContextMenuRequestPayload } from "./contextMenuTypes";

// ============================================================================
// Grid API (freeze panes orchestration)
// ============================================================================

export { freezePanes, loadFreezePanesConfig } from "./grid";

// ============================================================================
// Extension Manager
// ============================================================================

export { ExtensionManager } from "../shell/registries/ExtensionManager";
export type { LoadedExtension, ExtensionStatus } from "../shell/registries/ExtensionManager";

// ============================================================================
// UI Registration API
// ============================================================================

export {
  // Menu API
  registerMenu,
  registerMenuItem,
  getMenus,
  subscribeToMenus,
  // Task Pane API
  registerTaskPane,
  unregisterTaskPane,
  openTaskPane,
  closeTaskPane,
  getTaskPane,
  showTaskPaneContainer,
  hideTaskPaneContainer,
  isTaskPaneContainerOpen,
  useIsTaskPaneOpen,
  useOpenTaskPaneAction,
  useCloseTaskPaneAction,
  getTaskPaneManuallyClosed,
  clearTaskPaneManuallyClosed,
  markTaskPaneManuallyClosed,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  useTaskPaneOpenPaneIds,
  useTaskPaneManuallyClosed,
  useTaskPaneActiveContextKeys,
  // Dialog API
  registerDialog,
  unregisterDialog,
  showDialog,
  hideDialog,
  // Overlay API
  registerOverlay,
  unregisterOverlay,
  showOverlay,
  hideOverlay,
  hideAllOverlays,
  // Registries (for direct access if needed)
  TaskPaneExtensions,
  DialogExtensions,
  OverlayExtensions,
} from "./ui";

// ============================================================================
// UI Types
// ============================================================================

export type {
  MenuDefinition,
  MenuItemDefinition,
  TaskPaneViewDefinition,
  TaskPaneViewProps,
  TaskPaneContextKey,
  DialogDefinition,
  DialogProps,
  OverlayDefinition,
  OverlayProps,
  OverlayLayer,
  AnchorRect,
} from "./uiTypes";

// ============================================================================
// Formula Autocomplete API
// ============================================================================

export {
  isFormulaAutocompleteVisible,
  setFormulaAutocompleteVisible,
  AutocompleteEvents,
} from "./formulaAutocomplete";
export type {
  AutocompleteInputPayload,
  AutocompleteKeyPayload,
  AutocompleteAcceptedPayload,
} from "./formulaAutocomplete";

// ============================================================================
// Grid Overlays
// ============================================================================

export {
  registerGridOverlay,
  addGridRegions,
  removeGridRegionsByType,
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnWidth,
  overlayGetRowHeight,
  overlayGetColumnsWidth,
  overlayGetRowsHeight,
  registerPostHeaderOverlay,
  getGridRegions,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  type GridRegion,
  requestOverlayRedraw,
  type OverlayRegistration,
  type OverlayRenderContext,
  type OverlayHitTestContext,
  type GlobalOverlayRendererFn,
} from "./gridOverlays";

// Style Interceptors
export {
  registerStyleInterceptor,
  unregisterStyleInterceptor,
  hasStyleInterceptors,
  markRangeDirty,
  markSheetDirty,
} from "./styleInterceptors";

export type {
  IStyleOverride,
  CellCoords,
  BaseStyleInfo,
  StyleInterceptorFn,
} from "./styleInterceptors";

// Core types re-exported for extension use
export type { Viewport, GridConfig, DimensionOverrides } from "./types";

// ============================================================================
// Data Validation API
// ============================================================================

export {
  setDataValidation,
  clearDataValidation,
  getDataValidation,
  getAllDataValidations,
  validateCell,
  getValidationPrompt,
  getInvalidCells,
  getValidationListValues,
  hasInCellDropdown,
  validatePendingValue,
  // Helpers
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
  DEFAULT_VALIDATION,
  createWholeNumberRule,
  createDecimalRule,
  createListRule,
  createListRuleFromRange,
  createTextLengthRule,
  createCustomRule,
  createDateRule,
  createTimeRule,
} from "./lib";

export type {
  DataValidationType,
  DataValidationOperator,
  DataValidationAlertStyle,
  NumericRule,
  DateRule,
  TimeRule,
  ListSource,
  ListRule,
  CustomRule,
  DataValidationRule,
  DataValidationErrorAlert,
  DataValidationPrompt,
  DataValidation,
  ValidationRange,
  DataValidationResult,
  InvalidCellsResult,
  CellValidationResult,
} from "./lib";

// ============================================================================
// Conditional Formatting API
// ============================================================================

export {
  addConditionalFormat,
  updateConditionalFormat,
  deleteConditionalFormat,
  reorderConditionalFormats,
  getConditionalFormat,
  getAllConditionalFormats,
  evaluateConditionalFormats,
  clearConditionalFormatsInRange,
} from "./lib";

export type {
  CFValueType,
  ColorScalePoint,
  ColorScaleRule,
  DataBarDirection,
  DataBarAxisPosition,
  DataBarRule,
  IconSetType,
  ThresholdOperator,
  IconSetThreshold,
  IconSetRule,
  CellValueOperator,
  CellValueRule,
  TextRuleType,
  ContainsTextRule,
  TopBottomType,
  TopBottomRule,
  AverageRuleType,
  AboveAverageRule,
  TimePeriod,
  TimePeriodRule,
  ExpressionRule,
  DuplicateValuesRule,
  UniqueValuesRule,
  BlankCellsRule,
  NoBlanksRule,
  ErrorCellsRule,
  NoErrorsRule,
  ConditionalFormatRule,
  ConditionalFormat,
  ConditionalFormatRange,
  ConditionalFormatDefinition,
  CFResult,
  CellConditionalFormat,
  EvaluateCFResult,
  AddCFParams,
  UpdateCFParams,
} from "./lib";

// ============================================================================
// Protection API
// ============================================================================

export {
  // Sheet protection
  protectSheet,
  unprotectSheet,
  updateProtectionOptions,
  addAllowEditRange,
  removeAllowEditRange,
  getAllowEditRanges,
  getProtectionStatus,
  isSheetProtected,
  canEditCell,
  canPerformAction,
  setCellProtection,
  getCellProtection,
  verifyEditRangePassword,
  // Workbook protection
  protectWorkbook,
  unprotectWorkbook,
  isWorkbookProtected,
  getWorkbookProtectionStatus,
  // Default values
  DEFAULT_PROTECTION_OPTIONS,
  DEFAULT_CELL_PROTECTION,
} from "./lib";

export type {
  SheetProtectionOptions,
  AllowEditRange,
  SheetProtection,
  CellProtection,
  ProtectionResult,
  ProtectionCheckResult,
  ProtectionStatus,
  ProtectSheetParams,
  AddAllowEditRangeParams,
  SetCellProtectionParams,
  WorkbookProtectionStatus,
  WorkbookProtectionResult,
} from "./lib";

// ============================================================================
// Tracing API (Trace Precedents / Trace Dependents)
// ============================================================================

export {
  tracePrecedents,
  traceDependents,
} from "./lib";

export type {
  TraceCellRef,
  TraceRange,
  TraceCrossSheetRef,
  TraceResult,
} from "./lib";

// ============================================================================
// Evaluate Formula API (step-by-step formula debugger)
// ============================================================================

export {
  evalFormulaInit,
  evalFormulaEvaluate,
  evalFormulaStepIn,
  evalFormulaStepOut,
  evalFormulaRestart,
  evalFormulaClose,
} from "./lib";

export type {
  EvalStepState,
} from "./lib";

// ============================================================================
// Data Consolidation API
// ============================================================================

export {
  consolidateData,
} from "./lib";

export type {
  ConsolidationFunction,
  ConsolidationSourceRange,
  ConsolidateParams,
  ConsolidateResult,
} from "./lib";