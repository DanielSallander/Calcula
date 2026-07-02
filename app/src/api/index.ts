//! FILENAME: app/src/api/index.ts
// PURPOSE: Public API barrel export for the application.
// CONTEXT: Extensions and Shell components import from here.
// UPDATED: Removed Find actions - Find state now lives in the FindReplaceDialog extension.

// ============================================================================
// API Version
// ============================================================================

export { API_VERSION } from "./version";

// ============================================================================
// Commands
// ============================================================================

export { CoreCommands, CommandRegistry } from "./commands";
export type { ICommandRegistry } from "./commands";

// ============================================================================
// Contract (Extension types)
// ============================================================================

export type {
  ExtensionContext,
  ExtensionManifest,
  ExtensionModule,
  IMenuAPI,
  ITaskPaneAPI,
  IDialogAPI,
  IOverlayAPI,
  IStatusBarAPI,
  IActivityBarAPI,
  IEventAPI,
  ICellDecorationAPI,
  IStyleInterceptorAPI,
  IGridOverlayAPI,
  IEditGuardAPI,
  ICellClickAPI,
  INotificationAPI,
  IFormulasAPI,
} from "./contract";

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
  setDisplayZeros,
  setDisplayGridlines,
  setDisplayHeadings,
  setDisplayFormulaBar,
  setReferenceStyle,
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
  getSpillRanges,
  getMergeInfo,
  detectDataRegion,
  getCurrentRegion,
  getSheets,
  addSheet,
  deleteSheet,
  renameSheet,
  moveSheet,
  copySheet,
  hideSheet,
  unhideSheet,
  setTabColor,
  nextSheet,
  previousSheet,
  setScrollArea,
  getScrollArea,
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
  updateCell,
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
  getDefaultDimensions,
  setDefaultRowHeight,
  setDefaultColumnWidth,
  // Fill
  fillRange,
  // Sorting
  sortRange,
  sortRangeByColumn,
  // Border presets
  applyBorderPreset,
  // Multi-Sheet (Sheet Grouping) Operations
  updateCellOnSheets,
  applyFormattingToSheets,
  clearRangeOnSheets,
  // Functions (built-in formula catalog)
  getAllFunctions,
  getFunctionsByCategory,
  getFunctionTemplate,
} from "./lib";

export type {
  LayoutConfig,
  AggregationType,
  CurrentRegionResult,
  SheetInfo,
  SheetVisibility,
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
  runAdvancedFilter,
  isRowFiltered,
  getFilterUniqueValues,
  setColumnFilterValues,
  setColumnCustomFilter,
  setColumnTopBottomFilter,
  setColumnDynamicFilter,
} from "./lib";

// Workbook script runtime (list / read / run saved script modules) — the @api
// surface extensions use instead of importing the ScriptEditor extension internals.
export {
  listWorkbookScripts,
  getWorkbookScript,
  runWorkbookScript,
} from "./workbookScripts";
export type {
  ScriptScope,
  ScriptSummary,
  WorkbookScript,
  ScriptRunResult,
  ScriptRunSuccess,
  ScriptRunError,
} from "./workbookScripts";

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
  applyNamesToFormulas,
} from "./lib";

export type {
  NamedRange,
  NamedRangeResult,
  ApplyNamesResult,
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

export { registerEditGuard, checkRangeGuards } from "./editGuards";
export type { EditGuardResult, EditGuardFn } from "./editGuards";

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
// Formula Reference Interceptors
// ============================================================================

export { registerFormulaReferenceInterceptor } from "./formulaReferenceInterceptors";
export type { FormulaReferenceOverride, FormulaReferenceInterceptorFn } from "./formulaReferenceInterceptors";

// ============================================================================
// Events
// ============================================================================

export { AppEvents, emitAppEvent, onAppEvent, restoreFocusToGrid } from "./events";
export type { AppEventName, FillCompletedPayload, CellValueChange, CellValuesChangedPayload } from "./events";

// ============================================================================
// Cross-Window Events (Tauri)
// ============================================================================

export { emitTauriEvent, listenTauriEvent } from "./backend";
export type { UnlistenFn } from "./backend";

// BI model metadata (for the CUBE formula builder + other model-aware UI)
export {
  biGetConnections,
  biGetModelInfo,
  biGetColumnValues,
  biGetCalculatedMeasures,
  biSetCalculatedMeasures,
} from "./backend";
export type {
  ConnectionInfo,
  BiModelInfo,
  BiTableInfo,
  BiColumnInfo,
  BiMeasureInfo,
  BiHierarchyMeta,
  BiKpiInfo,
  CalculatedMeasure,
} from "./backend";

// BI Model Editor (in-app model authoring — ME-1: measures)
export {
  biModelGetMeasures,
  biModelValidateMeasure,
  biModelUpsertMeasure,
  biModelDeleteMeasure,
  biModelMeasureLineage,
} from "./backend";
export type {
  ModelMeasureInfo,
  MeasureValidation,
  MeasureLineage,
  MeasureLineageColumn,
} from "./backend";

// ============================================================================
// JSON View (generic object inspection/editing)
// ============================================================================

export { getObjectJson, setObjectJson, listObjects, getWorkbookTree } from "./jsonView";
export type { ObjectEntry, TreeNode } from "./jsonView";

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
  CommandGuard,
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
export { navigateToCell, navigateToRange } from "./grid";
export { goToSpecial } from "./grid";
export { borderAround } from "./grid";
export { fillDown, fillRight, fillUp, fillLeft } from "./grid";
export type { GoToSpecialResult, GoToSpecialCriteria } from "./grid";

// Zoom control (programmatic, non-React)
export { getZoom, setZoomLevel } from "./grid";

// View mode control (programmatic, non-React)
export { getViewMode, changeViewMode } from "./grid";

// Status bar text
export { setStatusBarText, clearStatusBarText } from "./grid";

// R1C1 Reference Style
export { getReferenceStyle, changeReferenceStyle, convertFormulaStyle } from "./grid";

// ============================================================================
// Extension Manager
// ============================================================================

// The extension-host surface is an @api INTERFACE (ExtensionManagerApi) + an IoC
// slot the Shell fills at boot — no api->shell dependency. Consumers reach the
// host via getExtensionManager().
export type {
  ExtensionManagerApi,
  LoadedExtension,
  ExtensionStatus,
  ExtensionTrust,
} from "./extensionManager";
export { registerExtensionManager, getExtensionManager } from "./extensionManager";
export { exposeExtensionRuntimeGlobals, getExtensionReact, REACT_GLOBAL } from "./extensionRuntime";

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
  // Shell Component API (top-level app-frame components)
  registerShellComponent,
  unregisterShellComponent,
  getShellComponents,
  onShellComponentsChange,
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
  // Panel API (location-agnostic panels)
  PanelExtensions,
  registerPanel,
  unregisterPanel,
  openPanel,
  closePanel,
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
  // File menu icons
  IconNew,
  IconOpen,
  IconSave,
  IconSaveAs,
  // Insert menu icons
  IconInsertTable,
  IconInsertPivot,
  IconInsertSlicer,
  IconInsertChart,
  IconBookmarks,
  IconBookmarkAdd,
  IconBookmarkRemove,
  IconNext,
  IconPrev,
  // Format menu icons
  IconFormatCells,
  IconCellStyles,
  IconConditionalFormatting,
  // External Data menu icons
  IconGetData,
  IconFromCsv,
  IconExport,
  IconConnections,
  // Edit menu icons
  IconUndo,
  IconRedo,
  IconCut,
  IconCopy,
  IconPaste,
  IconClear,
  IconFill,
  IconFind,
  IconReplace,
  IconMergeCells,
  IconUnmergeCells,
  IconFormatPainter,
  IconCustomLists,
  // View menu icons
  IconNormalView,
  IconPageLayoutView,
  IconPageBreakPreview,
  IconSidebar,
  IconPanels,
  IconFreezePanes,
  IconFreezeRow,
  IconFreezeCol,
  IconFreezeBoth,
  IconUnfreeze,
  IconSplitWindow,
  IconGoToSpecial,
  IconShowFormulas,
  IconDisplayZeros,
  IconPageBreaks,
  IconInsertPageBreak,
  IconRemovePageBreak,
  IconResetPageBreaks,
  IconPrintArea,
  IconOtherOptions,
  // Data menu icons
  IconFilter,
  IconClearFilter,
  IconReapply,
  IconSortAZ,
  IconSortZA,
  IconCustomSort,
  IconRemoveDuplicates,
  IconTextToColumns,
  IconFlashFill,
  IconAdvancedFilter,
  IconValidation,
  IconDataValidation,
  IconCircleInvalid,
  IconClearCircles,
  IconWhatIfAnalysis,
  IconGoalSeek,
  IconScenarioManager,
  IconDataTable,
  IconSolver,
  IconOutline,
  IconGroup,
  IconUngroup,
  IconShowLevel,
  IconSubtotals,
  IconClearOutline,
  IconConsolidate,
  IconSelectVisibleCells,
  // Edit menu icons (paste special / clear / movement)
  IconPasteValues,
  IconPasteFormulas,
  IconPasteFormatting,
  IconPasteLink,
  IconPasteSpecial,
  IconClearFormatting,
  IconClearContents,
  IconClearComments,
  IconClearHyperlinks,
  IconArrowUp,
  IconArrowDown,
  IconMoveSelection,
  IconMoveDirection,
  IconLock,
  // View menu icons (display toggles)
  IconGridlines,
  IconHeadings,
  IconFormulaBar,
  IconR1C1,
  IconEye,
  IconJson,
  IconPin,
  IconMore,
  // File menu icons (security / recovery / print)
  IconEncrypt,
  IconAutoRecover,
  IconClock,
  IconPrint,
  IconPdf,
  IconPageSetup,
  // Print area icons
  IconClearPrintArea,
  IconTitleRows,
  IconTitleCols,
  // Insert menu icons (links / sparklines / controls / shapes)
  IconHyperlink,
  IconFollowLink,
  IconSparkline,
  IconSparklineLine,
  IconSparklineColumn,
  IconSparklineWinLoss,
  IconControls,
  IconButton,
  IconCheckbox,
  IconShapes,
  IconImage,
  IconChartMarks,
  IconChartTransforms,
  IconHighlight,
  // Formulas menu icons (calculation / names / cubes)
  IconIteration,
  IconPrecision,
  IconCalcBeforeSave,
  IconPasteNames,
  IconApplyNames,
  IconCube,
  IconCalculatedMeasure,
  IconCustomFunctions,
  // Data menu icons (forms)
  IconDataForm,
  // Developer menu icons
  IconWorkbookExplorer,
  IconRunTests,
  IconTestPanel,
  IconServer,
  IconAIChat,
  IconNotebook,
  IconScript,
  IconTemplate,
  IconMarketplace,
  IconDesignMode,
  // External data & distribution icons
  IconDataModel,
  IconRefreshData,
  IconPackage,
  IconPublishPackage,
  IconSubscribePackage,
  IconRefreshSubscriptions,
  IconManageSubscriptions,
  IconCollectedResponses,
  IconAuditLog,
  IconOverrides,
  IconWriteback,
  IconWritebackPane,
  // Conditional formatting icons
  IconHighlightCells,
  IconGreaterThan,
  IconLessThan,
  IconBetween,
  IconEqualTo,
  IconTextContains,
  IconDuplicateValues,
  IconUniqueValues,
  IconTopBottom,
  IconTop10,
  IconTopPercent,
  IconBottom10,
  IconBottomPercent,
  IconAboveAverage,
  IconBelowAverage,
  IconColorScales,
  IconDataBars,
  IconIconSets,
  IconNewRule,
  IconManageRules,
} from "./menuIcons";

// ============================================================================
// File Format API (Custom Importers/Exporters)
// ============================================================================

export {
  registerFileFormat,
  findImporter,
  findExporter,
  getFileFormats,
  getFileDialogFilters,
  subscribeToFileFormats,
} from "./fileFormats";
export type {
  ImportCellData,
  ImportSheetData,
  ImportResult,
  ExportContext,
  FileFormatRegistration,
  IFileFormatAPI,
} from "./fileFormats";

// ============================================================================
// Custom Cell Editors API
// ============================================================================

export {
  registerCellEditor,
  findCellEditor,
  hasCellEditors,
  subscribeToCellEditors,
} from "./cellEditors";
export type {
  CellEditorContext,
  CellEditorProps,
  CellEditorRegistration,
  ICellEditorAPI,
} from "./cellEditors";

// ============================================================================
// Locale / Regional Settings API
// ============================================================================

export {
  getLocaleSettings,
  setLocale,
  getSupportedLocales,
  getCachedLocale,
  onLocaleChanged,
} from "./locale";
export type {
  LocaleSettings,
  SupportedLocaleEntry,
} from "./locale";

// ============================================================================
// Extension Settings API
// ============================================================================

export {
  getSetting,
  setSetting,
  removeSetting,
  registerSettingDefinitions,
  getAllSettingDefinitions,
  subscribeToSettings,
} from "./settings";
export type {
  SettingDefinition,
  ISettingsAPI,
} from "./settings";

// ============================================================================
// ============================================================================
// Keybindings API (Centralized, user-configurable)
// ============================================================================

export {
  initKeybindings,
  registerKeybinding,
  getAllKeybindings,
  getKeybinding,
  getKeybindingsForCategory,
  getCategories,
  getEffectiveCombo,
  getDefaultCombo,
  hasUserOverride,
  setUserKeybinding,
  resetUserKeybinding,
  resetAllKeybindings,
  findConflicts,
  parseCombo,
  matchesEvent as matchesKeybindingEvent,
  formatCombo,
  eventToCombo,
  handleGlobalKeyDown,
  subscribeToKeybindingChanges,
  addCustomKeybinding,
  removeCustomKeybinding,
  getAvailableCommands,
} from "./keybindings";
export type {
  KeyBinding,
  ParsedCombo,
  IKeybindingsAPI,
} from "./keybindings";

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
// Custom Formula Functions API
// ============================================================================

export {
  registerFunction as registerFormulaFunction,
  getCustomFunction,
  getAllCustomFunctions,
  hasCustomFunction,
  executeCustomFunction,
  subscribeToCustomFunctions,
  getCustomFunctionCount,
} from "./formulaFunctions";
export type {
  CustomFunctionDef,
} from "./formulaFunctions";
// User-authored JS formula functions (sandboxed): generate library + install.
export {
  generateLibrarySource,
  installCustomFunctions,
  uninstallCustomFunctions,
  customFunctionsInstalled,
  loadPersistedLibrary,
  savePersistedLibrary,
  loadAndInstallCustomFunctions,
  validateFunctionName,
  validateParam,
} from "./customFunctions";
export type { CustomFunctionUdf, CustomFunctionLibrary } from "./customFunctions";
// Sandboxed chart marks (B8.D.2): author/persist/mount/register a chart-mark library.
export {
  installChartMarkLibrary,
  uninstallChartMarks,
  uninstallChartMarksQueued,
  chartMarksInstalled,
  loadPersistedMarkLibrary,
  loadPersistedMarkLibraryWithProvenance,
  savePersistedMarkLibrary,
  markLibraryConsentSource,
  CHART_MARKS_SCRIPT_ID,
  validateMarkId,
  generateMarkSource,
  markScriptId,
  MARK_ID_PREFIX,
} from "./chartMarkScripts";
export type { ChartMarkScript, ChartMarkLibrary, MarkLayoutFamily, SandboxMarkRegistrar, PersistedMarkLibrary } from "./chartMarkScripts";
// Sandboxed chart transforms (Feature 1): author/persist/mount a transform library
// + the reader-side routing (isSandboxTransformMounted / runSandboxTransform).
export {
  installChartTransformLibrary,
  uninstallChartTransforms,
  uninstallChartTransformsQueued,
  chartTransformsInstalled,
  loadPersistedTransformLibrary,
  loadPersistedTransformLibraryWithProvenance,
  savePersistedTransformLibrary,
  transformLibraryConsentSource,
  validateTransformType,
  generateTransformSource,
  isSandboxTransformMounted,
  runSandboxTransform,
  TRANSFORM_TYPE_PREFIX,
  CHART_TRANSFORMS_SCRIPT_ID,
} from "./chartTransformScripts";
export type { ChartTransformScript, ChartTransformLibrary, PersistedTransformLibrary } from "./chartTransformScripts";
// UDF evaluation bridge (Wave 3 / C1): makes registered custom functions
// actually evaluate in worksheet formulas (broker-mediated, pre-fetched).
export {
  installUdfEvaluation,
  uninstallUdfEvaluation,
  resolveUdfsForEdit,
  type UdfValue,
} from "./formulaUdf";
// Unified script-surface taxonomy (Wave 3 / C3): the one queryable source of
// truth for where code runs and what it can touch.
export {
  SCRIPT_SURFACES,
  getScriptSurface,
  executableScriptSurfaces,
  type ScriptSurface,
  type ScriptSurfaceId,
  type ScriptRuntime,
} from "./scriptSurfaces";

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
export type {
  Selection,
  SelectionType,
  Viewport,
  GridConfig,
  DimensionOverrides,
  CellData,
  StyleData,
  FillData,
  FillParam,
  PatternType,
  GradientDirection,
  ViewMode,
  SortRangeResult,
  UnderlineStyle,
} from "./types";

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
// App Appearance / Skins API
// ----------------------------------------------------------------------------
// The application chrome + grid SKIN (light/dark/custom). This is DISTINCT from
// the Document Theme API above (which colors cell content). Use these to read,
// switch, and contribute skins; never reuse THEME_CHANGED for appearance.
// ============================================================================

export {
  listAvailableSkins,
  getActiveSkin,
  getActiveSkinId,
  setActiveSkin,
  registerSkin,
  onSkinChanged,
  subscribeToAppearance,
  getSkinTokens,
  getSkinGridTheme,
  LIGHT_SKIN_ID,
  DARK_SKIN_ID,
  BUILTIN_DEFAULT_SKIN_ID,
} from "./appearance";

export type {
  Skin,
  SkinBase,
  SkinDensity,
  SkinAssets,
  ThemeTokenName,
  AccessibilityOverride,
  AppearanceChangedPayload,
} from "./appearance";

// Enterprise appearance policy (advisory default) + accessibility resolution.
export {
  resolveEffectiveSkinId,
  getManagedAppearanceInfo,
  refreshManagedAppearance,
  getUserAccessibility,
  setUserAccessibility,
  applyAccessibilityFromPrefs,
} from "./appearancePolicy";

export type { EffectiveAppearancePolicy, SkinTrust } from "./appearancePolicy";

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
  getCalculationState,
  calculateNow,
  recalcWithCube,
  calculateSheet,
  getIterationSettings,
  setIterationSettings,
} from "./lib";

export type {
  IterationSettings,
} from "./lib";

// ============================================================================
// Distribution (.calp)
// ============================================================================

export {
  publishPackage,
  publishPreview,
  publishModel,
  pullPackage,
  browseRegistry,
  getSubscriptions,
  getPackageObjects,
  getOverrides,
  revertOverride,
  acceptUpstream,
  keepOverride,
  exportOverrides,
  importOverrides,
  refreshPreview,
  refreshApply,
  detach,
  refreshData,
  saveDataSourceConfig,
  getDataSources,
  getSheetIdForIndex,
} from "./distribution";

export type {
  PublishParams,
  PublishResponse,
  PublishReport,
  PublishReportItem,
  PublishPreviewResponse,
  PublishModelParams,
  PullParams,
  PullResponse,
  PackageInfo,
  VersionInfo,
  SheetInfo as DistSheetInfo,
  SubscriptionManifest,
  Subscription,
  SubscribedSheet,
  SubscribedObject,
  PackageObjectInfo,
  PackageSheetObjectInfo,
  PackageObjectsResponse,
  OverrideLayer,
  CellOverride,
  OverrideValue,
  OverridePatch,
  RefreshPreview,
  SubscriptionPreview,
  SheetChangeInfo,
  RefreshResult,
  StructuralConflict,
  DataRefreshResponse,
  DataSourceNeedsConfig,
  DataSourceInfo,
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

// ============================================================================
// Named Cell Styles API
// ============================================================================

export {
  getNamedStyles,
  createNamedStyle,
  deleteNamedStyle,
  applyNamedStyle,
} from "./lib";

export type {
  NamedCellStyle,
} from "./lib";

// ============================================================================
// Workbook Properties API
// ============================================================================

export {
  getWorkbookProperties,
  setWorkbookProperties,
} from "./lib";

export type {
  WorkbookProperties,
} from "./lib";

// ============================================================================
// Range API
// ============================================================================

export { CellRange } from "./range";

// Canonical shared object model — Workbook/Sheet levels above the CellRange seed
// (C3). See docs/design/c3-shared-object-model.md.
export { Workbook, Sheet, workbook } from "./objectModel";
// SheetVisibility is already re-exported from "./lib" (the canonical tauri-api
// type); objectModel.ts declares a structurally-identical local copy for its
// own use. Re-exporting it here too would be a duplicate-identifier clash.

// ============================================================================
// Scriptable Objects API
// ============================================================================

export {
  ObjectScriptManager,
  resetObjectScriptManager,
  callExposedMethod,
  listExposedMethods,
  SCRIPT_API_VERSION,
  isApiVersionCompatible,
} from "./scriptableObjects";

export type {
  ScriptAccessLevel,
  ScriptableObjectType,
  ObjectScriptDefinition,
  ObjectLifecycleStage,
  BaseObjectContext,
  WorkbookContext,
  SheetContext as ScriptSheetContext,
  CellContext,
  RowContext,
  ColumnContext,
  SlicerContext,
  ChartContext,
  PivotContext,
  ObjectContextMap,
  ObjectScriptSetup,
  IObjectScriptAPI,
  UnlockedAPI,
  ScriptProvenance,
} from "./scriptableObjects";

// ============================================================================
// Script Host (tier broker, allowlist, audit — transparency surface)
// ============================================================================

export { ALLOWLIST, SCRIPT_SUBSCRIBABLE_APP_EVENTS } from "./scriptHost/allowlist";
export type { MethodPolicy, Tier as ScriptTierName, CapabilityId, MethodClass } from "./scriptHost/allowlist";
export { getAuditTail, getAuditTotal, onAudit, clearAudit } from "./scriptHost/auditRing";
export type { AuditEntry } from "./scriptHost/auditRing";
export { listMountedHandles, listExposed, BrokerError } from "./scriptHost/broker";
export type { ScriptHandle, RpcErrorCode } from "./scriptHost/broker";
export {
  hostValidateScript,
  listFaultedScripts,
  getShapeBitmap,
  hasShapeBitmapRenderer,
  getSlicerItemBitmap,
  hasSlicerItemBitmapRenderer,
  getChartMarkBitmap,
  hasChartMarkBitmapRenderer,
} from "./scriptHost/host";
export { getCellRenderStats, getChartMarkGeometry } from "./scriptHost/renderCache";
export type { SandboxHitGeometry, SandboxHitRect } from "./scriptHost/protocol";
export { resolveCapabilityRequest, getGrantedOrigins, getScriptGrants, revokeCapability, recordCapabilityGrant, describeCapability } from "./scriptHost/capabilities";
export type { CapabilityRequestPayload, CapabilityDecision } from "./scriptHost/capabilities";
export { parseDeclaredCapabilities, applyConsentedCapabilities } from "./scriptHost/capabilities";
// Distributed-script consent store (promoted from ScriptableObjects so the Charts
// sandboxed transform/mark libraries reuse the SAME store + file, not a parallel one).
export {
  sha256Hex,
  loadConsents,
  recordConsent,
  isConsentCurrent,
  getChangedScripts,
} from "./distributedConsent";
export type {
  ConsentedScript,
  CapabilityGrant,
  ConsentRecord,
  ChangedScript,
} from "./distributedConsent";
export type { DeclaredCapabilities } from "./scriptHost/capabilities";

export {
  getScaffoldTemplate,
  getContextDocumentation,
} from "./scriptableObjectScaffolds";

// ============================================================================
// Component Store Registry (IoC for Slicer/Chart/Pivot stores)
// ============================================================================

export {
  registerSlicerStoreService,
  registerTimelineStoreService,
  registerChartStoreService,
  registerPivotStoreService,
  registerBiConnectionService,
  getSlicerStoreService,
  getTimelineStoreService,
  getChartStoreService,
  getPivotStoreService,
  getBiConnectionService,
} from "./componentStoreRegistry";

export type {
  ISlicerStoreService,
  ITimelineStoreService,
  IChartStoreService,
  IPivotStoreService,
  IBiConnectionService,
} from "./componentStoreRegistry";

// ============================================================================
// Chart Mark Registry (IoC for built-in + extension chart types)
// ============================================================================

export {
  registerChartMark,
  unregisterChartMark,
  getChartMark,
  getChartMarkMeta,
  isChartMarkRegistered,
  listChartMarks,
} from "./chartMarks";

// Custom chart-data transform registry (dogfooding extension point, symmetric to
// the chart-mark registry).
export {
  registerChartTransform,
  unregisterChartTransform,
  getChartTransform,
  isChartTransformRegistered,
  listChartTransforms,
  isBuiltinTransformType,
} from "./chartTransforms";
export type { ChartTransformDefinition, ChartTransformContext } from "./chartTransforms";

export type {
  ChartMarkDefinition,
  ChartMarkMeta,
  ChartMarkLayout,
} from "./chartMarks";

export {
  listObjectScripts,
  getObjectScript,
  getObjectScriptByTarget,
  saveObjectScript,
  deleteObjectScript,
  deleteObjectScriptsForInstance,
  loadAllObjectScripts,
} from "./objectScriptBackend";

// ---- Code inventory (T1: "Code in This File" transparency inspector) ----
// Read-path @api bindings for the notebook and module-script populations
// (previously reachable only from inside their owning extensions), plus the
// unified inventory aggregator that joins all code-residence surfaces.
export {
  listNotebooks,
  loadNotebook,
} from "./notebookBackend";
export type {
  NotebookSummaryData,
  NotebookDocumentData,
  NotebookCellData,
} from "./notebookBackend";
// Generic per-extension workbook persistence (any extension can persist JSON
// state into the .cala without a new typed file-format field).
export {
  getExtensionData,
  setExtensionData,
  setExtensionDataUndoable,
  clearExtensionData,
} from "./extensionData";
// Feature-neutral rendering / frame-capture facade (Charts provides the impl via
// registerChartRenderingApi; capture/export pipelines consume the helpers).
export {
  registerChartRenderingApi,
  getChartRenderingApi,
  getChartFrameBitmap,
  getChartFrameImageData,
  isChartRenderPending,
  isChartRenderCurrent,
  chartsIdle,
  awaitRenderSettled,
  captureGridRegion,
  isGridCaptureReady,
  getGridCanvas,
} from "./rendering";
export type { ChartRenderingApi, RenderSettleOptions, CaptureRange } from "./rendering";
// Feature-neutral chart-param control facade (Charts provides the impl via
// registerChartParamController; drivers/UI enumerate + sweep chart params).
export {
  registerChartParamController,
  getChartParamController,
  listAnimatableCharts,
  listChartParams,
  getChartParamValue,
  setChartParamValue,
  clearChartParamValue,
} from "./chartParams";
export type {
  ChartParamController,
  ChartParamValue,
  ChartParamBinding,
  AnimatableChart,
  ChartParameter,
} from "./chartParams";
// Scope-injected expression evaluation via the real engine (the sanctioned
// replacement for hand-rolled in-extension formula evaluators).
export {
  evaluateScoped,
  evaluateExpression,
} from "./formulaEval";
export type { ScopeValue, EvalScope, EvalResultValue } from "./formulaEval";
// Backend command capability model (A3): the privileged-command surface + the
// capability check a governed ExtensionContext.invokeBackend will enforce.
export {
  PRIVILEGED_BACKEND_COMMANDS,
  isPrivilegedCommand,
  commandCapability,
  assertExtensionMayInvoke,
  BackendCapabilityError,
  createBackendChannel,
} from "./backendCommands";
export type {
  PrivilegedCapability,
  BackendChannel,
  BackendInvokeArgs,
  RawBackendInvoke,
} from "./backendCommands";
// Shared script-security gate (honors the global Script Security setting before
// mounting/executing user scripts — used by the object-script surface too).
export {
  getScriptExecutionStatus,
  grantScriptSessionApproval,
  ensureScriptsAllowed,
} from "./scriptSecurity";
export type { ScriptExecutionStatus } from "./scriptSecurity";
export {
  listModuleScripts,
  getModuleScript,
  describeModuleScriptScope,
} from "./moduleScriptBackend";
export type {
  ModuleScriptSummary,
  ModuleScriptData,
  ModuleScriptScope,
} from "./moduleScriptBackend";
export {
  getWorkbookCodeUnits,
  summarizeCodeInventory,
  codeUnitReachesBeyondGrid,
} from "./codeInventory";
export type { CodeUnit, CodeInventorySummary } from "./codeInventory";

// ---- Design Mode (app-global flag) + object script-presence badges (T4) ----
export {
  getDesignMode,
  setDesignMode,
  toggleDesignMode,
  onDesignModeChange,
  DESIGN_MODE_CHANGED_EVENT,
} from "./designMode";
export {
  hasObjectScript,
  onObjectScriptPresenceChange,
  refreshObjectScriptPresence,
  markObjectScript,
  unmarkObjectScript,
  drawScriptBadge,
  drawObjectScriptBadgeIfPresent,
  initObjectScriptBadges,
} from "./objectScriptBadge";