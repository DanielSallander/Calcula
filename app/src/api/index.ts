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
  setSplitConfig,
  setViewMode,
  setShowFormulas,
  setHiddenRows,
  setHiddenCols,
  setManuallyHiddenRows,
  setManuallyHiddenCols,
  setGroupHiddenRows,
  setGroupHiddenCols,
  setZoom,
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
  getWatchCells,
  getCellsInCols,
  getViewportCells,
  getMergeInfo,
  detectDataRegion,
  getSheets,
  addSheet,
  deleteSheet,
  renameSheet,
  moveSheet,
  copySheet,
  hideSheet,
  unhideSheet,
  setTabColor,
  indexToCol,
  colToIndex,
  setActiveSheet as setActiveSheetApi,
  setCellStyle,
  setCellRichText,
  beginUndoTransaction,
  commitUndoTransaction,
  undo,
  redo,
  removeDuplicates,
  updateCellsBatch,
  // Clipboard
  getInternalClipboard,
  // Formula shifting
  shiftFormulasBatch,
  // Status bar aggregation
  getSelectionAggregations,
  // Merge cells
  mergeCells,
  unmergeCells,
  getMergedRegions,
  // Row/Column operations
  insertRows,
  insertColumns,
  deleteRows,
  deleteColumns,
  getColumnWidth,
  getRowHeight,
  // Sorting
  sortRange,
  sortRangeByColumn,
  // Multi-Sheet (Sheet Grouping) Operations
  updateCellOnSheets,
  applyFormattingToSheets,
  clearRangeOnSheets,
} from "./lib";

export type {
  LayoutConfig,
  AggregationType,
  SheetInfo,
  SheetsResult,
  RemoveDuplicatesResult,
  CellUpdateInput,
  FormulaShiftInput,
  ClipboardData,
  SelectionAggregationResult,
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
  setAdvancedFilterHiddenRows,
  clearAdvancedFilterHiddenRows,
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
// Named Ranges API
// ============================================================================

export {
  createNamedRange,
  updateNamedRange,
  deleteNamedRange,
  getNamedRange,
  getAllNamedRanges,
  getNamedRangeForSelection,
  renameNamedRange,
} from "./lib";

export type {
  NamedRange,
  NamedRangeResult,
} from "./lib";

// ============================================================================
// Notifications API
// ============================================================================

export { showToast } from "./notifications";
export type { ToastOptions } from "./notifications";

// ============================================================================
// Cell Events
// ============================================================================

export { cellEvents } from "./cellEvents";

// ============================================================================
// Types (utility functions & types)
// ============================================================================

export { columnToLetter, letterToColumn, isFormulaExpectingReference, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT, ZOOM_STEP, ZOOM_PRESETS } from "./types";

// Formula reference parsing
export { parseFormulaReferences } from "../core/lib/formulaRefParser";
export type { FormulaReferenceWithPosition } from "../core/lib/formulaRefParser";

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

export { registerCellClickInterceptor, registerCellCursorInterceptor } from "./cellClickInterceptors";

// ============================================================================
// Cell Double-Click Interceptors
// ============================================================================

export { registerCellDoubleClickInterceptor } from "./cellDoubleClickInterceptors";

// ============================================================================
// Events
// ============================================================================

export { AppEvents, emitAppEvent, onAppEvent, restoreFocusToGrid } from "./events";
export type { AppEventName, FillCompletedPayload } from "./events";

// ============================================================================
// Cross-Window Events (Tauri)
// ============================================================================

export { emitTauriEvent, listenTauriEvent } from "./backend";
export type { UnlistenFn } from "./backend";

// ============================================================================
// Sheet Grouping (Multi-Sheet Selection)
// ============================================================================

export {
  getSelectedSheetIndices,
  setSelectedSheetIndices,
  isSheetGroupingActive,
  getGroupedSheetIndices,
  clearSheetGrouping,
  toggleSheetInGroup,
} from "../core/state/sheetGrouping";

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
export { splitWindow, loadSplitWindowConfig, removeSplitWindow } from "./grid";
export { goToSpecial } from "./grid";
export type { GoToSpecialResult, GoToSpecialCriteria } from "./grid";

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
  notifyMenusChanged,
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
  // Status Bar API
  registerStatusBarItem,
  unregisterStatusBarItem,
  getStatusBarItems,
  subscribeToStatusBar,
  // Activity Bar API
  registerActivityView,
  unregisterActivityView,
  openActivityView,
  closeActivityView,
  toggleActivityView,
  isActivityBarOpen,
  getActiveActivityViewId,
  useIsActivityBarOpen,
  useActiveActivityViewId,
  ActivityBarExtensions,
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
  StatusBarItemDefinition,
  StatusBarAlignment,
  ActivityViewDefinition,
  ActivityViewProps,
} from "./uiTypes";

// ============================================================================
// Menu Icons
// ============================================================================

export {
  IconTracePrecedents,
  IconTraceDependents,
  IconRemoveArrows,
  IconNameManager,
  IconEvaluateFormula,
  IconVisualizeFormula,
  IconCalcOptions,
  IconCalculate,
  IconDefineName,
  IconDefineFunction,
  IconAutomatic,
  IconManual,
  IconCalcWorksheet,
  IconCalcWorkbook,
  IconProtectSheet,
  IconProtectWorkbook,
  IconCellProtection,
  IconNewComment,
  IconNewNote,
  IconShowAllComments,
  IconShowAllNotes,
  IconDeleteAll,
} from "./menuIcons";

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
  replaceGridRegionsByType,
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

// Cell Decorations
export {
  registerCellDecoration,
  unregisterCellDecoration,
  hasCellDecorations,
  applyCellDecorations,
} from "./cellDecorations";

export type {
  CellDecorationContext,
  CellDecorationFn,
  CellDecorationRegistration,
} from "./cellDecorations";

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

// Column Header Overrides
export {
  setColumnHeaderOverrideProvider,
  getColumnHeaderOverride,
  registerColumnHeaderClickInterceptor,
  checkColumnHeaderClickInterceptor,
} from "./columnHeaderOverrides";

export type {
  ColumnHeaderOverride,
  ColumnHeaderOverrideProvider,
  ColumnHeaderClickResult,
  ColumnHeaderClickInterceptorFn,
} from "./columnHeaderOverrides";

// Core types re-exported for extension use
export type { Selection, SelectionType, Viewport, GridConfig, DimensionOverrides } from "./types";

// ============================================================================
// Theme API
// ============================================================================

export {
  getDocumentTheme,
  setDocumentTheme,
  listBuiltinThemes,
  getThemeColorPalette,
  onThemeChanged,
  getCachedTheme,
  clearThemeCache,
} from "./theme";

export type {
  ThemeDefinitionData,
  ThemeColorsData,
  ThemeFontsData,
  ThemeColorInfo,
  SetThemeResult,
} from "../core/types/types";

// ============================================================================
// Fill Lists API (Custom AutoFill Lists)
// ============================================================================

export { FillListRegistry } from "./fillLists";
export type { FillList, FillListMatch } from "./fillLists";

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
// Comments API
// ============================================================================

export {
  addComment,
  updateComment,
  deleteComment,
  getComment,
  getCommentById,
  getAllComments,
  getCommentsForSheet,
  getCommentIndicators,
  getCommentIndicatorsInRange,
  resolveComment,
  addReply,
  updateReply,
  deleteReply,
  moveComment,
  getCommentCount,
  hasComment,
  clearAllComments,
  clearCommentsInRange,
  DEFAULT_COMMENT_AUTHOR,
} from "./lib";

export type {
  Comment,
  CommentReply,
  CommentMention,
  CommentContentType,
  CommentResult,
  ReplyResult,
  CommentIndicator,
  AddCommentParams,
  UpdateCommentParams,
  AddReplyParams,
  UpdateReplyParams,
} from "./lib";

// ============================================================================
// Notes API
// ============================================================================

export {
  addNote,
  updateNote,
  deleteNote,
  getNote,
  getNoteById,
  getAllNotes,
  getNoteIndicators,
  getNoteIndicatorsInRange,
  resizeNote,
  toggleNoteVisibility,
  showAllNotes,
  moveNote,
  hasNote,
  clearAllNotes,
  clearNotesInRange,
  convertNoteToComment,
  DEFAULT_NOTE_SIZE,
  DEFAULT_NOTE_AUTHOR,
} from "./lib";

export type {
  Note,
  NoteResult,
  NoteIndicator,
  AddNoteParams,
  UpdateNoteParams,
  ResizeNoteParams,
  CellAnnotationType,
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
// Formula Evaluation Plan (visual formula debugger)
// ============================================================================

export {
  getFormulaEvalPlan,
} from "./lib";

export type {
  EvalPlanNode,
  EvalReductionStep,
  FormulaEvalPlan,
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

// ============================================================================
// Number Format Preview API
// ============================================================================

export {
  previewNumberFormat,
} from "./lib";

export type {
  PreviewResult,
} from "./lib";

// ============================================================================
// Calculation API
// ============================================================================

export {
  setCalculationMode,
  getCalculationMode,
  calculateNow,
  calculateSheet,
} from "./lib";

// ============================================================================
// Distribution API
// ============================================================================

export {
  registerRegistryProvider,
  unregisterRegistryProvider,
  getRegistryProviders,
  getRegistryProvider,
  parsePackageInfo,
  browsePackages,
  exportAsPackage,
  importPackage,
  downloadPackage,
  publishPackage,
} from "./distribution";

export type {
  PackageInfo,
  PackageContent,
  DataSourceDeclaration,
  DataSourceColumn,
  ImportResult,
  ImportBinding,
  PublishResult,
  RegistryProvider,
  RegistryQuery,
  RegistrySearchResult,
  VersionInfo,
  UpdateInfo,
} from "./distribution";

// ============================================================================
// Scenario Manager
// ============================================================================

export {
  scenarioList,
  scenarioAdd,
  scenarioDelete,
  scenarioShow,
  scenarioSummary,
  scenarioMerge,
} from "./lib";

export type {
  ScenarioCell,
  Scenario,
  ScenarioAddParams,
  ScenarioShowParams,
  ScenarioDeleteParams,
  ScenarioSummaryRow,
  ScenarioSummaryParams,
  ScenarioSummaryResult,
  ScenarioShowResult,
  ScenarioListResult,
  ScenarioResult,
} from "./lib";

// ============================================================================
// Data Tables
// ============================================================================

export {
  dataTableOneVar,
  dataTableTwoVar,
} from "./lib";

export type {
  DataTableOneVarParams,
  DataTableTwoVarParams,
  DataTableCellResult,
  DataTableResult,
} from "./lib";

// ============================================================================
// Solver
// ============================================================================

export {
  solverSolve,
  solverRevert,
} from "./lib";

export type {
  SolverObjective,
  ConstraintOperator,
  SolverConstraint,
  SolverMethod,
  SolverVariableCell,
  SolverParams,
  SolverVariableValue,
  SolverResultData,
} from "./lib";