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
} from "./lib";

export type {
  LayoutConfig,
  AggregationType,
  SheetInfo,
  SheetsResult,
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