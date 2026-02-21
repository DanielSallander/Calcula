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
  updateCellsBatch,
  clearCell,
  clearRange,
  getGridBounds,
  getCellCount,

  // Navigation
  findCtrlArrowTarget,
  detectDataRegion,
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
  beginUndoTransaction,
  commitUndoTransaction,

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

  // Named ranges
  createNamedRange,
  updateNamedRange,
  deleteNamedRange,
  getNamedRange,
  getAllNamedRanges,
  getNamedRangeForSelection,
  renameNamedRange,

  // Data validation
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

  // Comments
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

  // Grouping / Outline
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
  CellUpdateInput,
  // Grouping types
  GroupResult,
  OutlineInfo,
  OutlineSettings,
  RowOutlineSymbol,
  ColOutlineSymbol,
  RowGroup,
  ColumnGroup,
  SheetOutline,
} from "../core/lib/tauri-api";

// Named range type exports
export type {
  NamedRange,
  NamedRangeResult,
} from "../core/types";

// Data validation type exports
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
} from "../core/types";

// Data validation helper exports
export {
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
} from "../core/types";

// Comment type exports
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
} from "../core/types";

// Comment helper exports
export { DEFAULT_COMMENT_AUTHOR } from "../core/types";

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
} from "./backend";

// AutoFilter type exports
export type {
  AutoFilterInfo,
  AutoFilterResult,
  FilterCriteria,
  FilterOn,
  DynamicFilterCriteria,
  FilterOperator,
  UniqueValue,
  UniqueValuesResult,
} from "./backend";

// ============================================================================
// Remove Duplicates API
// ============================================================================

export {
  removeDuplicates,
} from "./backend";

export type {
  RemoveDuplicatesResult,
} from "./backend";

// ============================================================================
// Goal Seek API
// ============================================================================

export {
  goalSeek,
} from "./backend";

export type {
  GoalSeekParams,
  GoalSeekResult,
} from "./backend";

// ============================================================================
// Grouping / Outline Settings API
// ============================================================================

export {
  getOutlineSettings,
  setOutlineSettings,
} from "./backend";

export type { SummaryPosition } from "./backend";

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
} from "./backend";

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
} from "./backend";

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
  // Defaults
  DEFAULT_PROTECTION_OPTIONS,
  DEFAULT_CELL_PROTECTION,
} from "./backend";

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
} from "./backend";

// ============================================================================
// Tracing API (Trace Precedents / Trace Dependents)
// ============================================================================

export {
  tracePrecedents,
  traceDependents,
} from "./backend";

export type {
  TraceCellRef,
  TraceRange,
  TraceCrossSheetRef,
  TraceResult,
} from "./backend";

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
} from "./backend";

export type {
  EvalStepState,
} from "./backend";

// ============================================================================
// Data Consolidation API
// ============================================================================

export {
  consolidateData,
} from "./backend";

export type {
  ConsolidationFunction,
  ConsolidationSourceRange,
  ConsolidateParams,
  ConsolidateResult,
} from "./backend";
