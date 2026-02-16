//! FILENAME: app/src/core/lib/tauri-api.ts
// PURPOSE: TypeScript API wrapper for Tauri backend commands.
// CONTEXT: Provides type-safe functions to invoke Rust commands from the frontend.
// Handles all communication with the Tauri backend including cell operations,
// styling, formatting, function library, and calculation mode.

import { invoke } from "@tauri-apps/api/core";
import type {
  CellData,
  StyleData,
  DimensionData,
  FormattingOptions,
  FormattingResult,
  FunctionInfo,
} from "../types";

// ============================================================================
// Cell Operations
// ============================================================================

export function indexToCol(index: number): string {
  let col = "";
  while (index >= 0) {
    col = String.fromCharCode(65 + (index % 26)) + col;
    index = Math.floor(index / 26) - 1;
  }
  return col;
}

export function colToIndex(col: string): number {
  let index = 0;
  for (let i = 0; i < col.length; i++) {
    index = index * 26 + (col.charCodeAt(i) - 64);
  }
  return index - 1;
}

export async function getViewportCells(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<CellData[]> {
  const t0 = performance.now();
  const result = await invoke<CellData[]>("get_viewport_cells", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
  const dt = performance.now() - t0;
  console.log(`[PERF][bridge] getViewportCells(${startRow},${startCol})-(${endRow},${endCol}) => ${result.length} cells | ipc=${dt.toFixed(1)}ms`);
  return result;
}

export async function getCell(row: number, col: number): Promise<CellData | null> {
  const t0 = performance.now();
  const result = await invoke<CellData | null>("get_cell", { row, col });
  const dt = performance.now() - t0;
  if (dt > 1) {
    console.log(`[PERF][bridge] getCell(${row},${col}) | ipc=${dt.toFixed(1)}ms`);
  }
  return result;
}

export async function updateCell(
  row: number,
  col: number,
  input: string
): Promise<CellData[]> {
  const t0 = performance.now();
  // FIXED: Mapped 'input' to 'value' to match Rust command signature
  const result = await invoke<CellData[]>("update_cell", { row, col, value: input });
  const dt = performance.now() - t0;
  console.log(`[PERF][bridge] updateCell(${row},${col}) => ${result.length} cells | ipc=${dt.toFixed(1)}ms`);
  return result;
}

/**
 * Input for batch cell updates.
 */
export interface CellUpdateInput {
  row: number;
  col: number;
  value: string;
}

/**
 * Batch update multiple cells in a single operation.
 * This is significantly faster than calling updateCell multiple times
 * because it sends all updates in a single IPC call.
 * @param updates - Array of cell updates with row, col, and value
 * @returns Array of all updated cells (including dependents)
 */
export async function updateCellsBatch(
  updates: CellUpdateInput[]
): Promise<CellData[]> {
  const t0 = performance.now();
  const result = await invoke<CellData[]>("update_cells_batch", { updates });
  const dt = performance.now() - t0;
  console.log(`[PERF][bridge] updateCellsBatch(${updates.length}) => ${result.length} cells | ipc=${dt.toFixed(1)}ms`);
  return result;
}

export async function clearCell(row: number, col: number): Promise<void> {
  return invoke<void>("clear_cell", { row, col });
}

export async function clearRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<number> {
  return invoke<number>("clear_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

export async function getGridBounds(): Promise<[number, number]> {
  return invoke<[number, number]>("get_grid_bounds");
}

export async function getCellCount(): Promise<number> {
  return invoke<number>("get_cell_count");
}

/**
 * Get all non-empty cells in a row range using sparse iteration.
 * Much faster than getViewportCells for full-width row reads.
 */
export async function getCellsInRows(
  startRow: number,
  endRow: number
): Promise<CellData[]> {
  return invoke<CellData[]>("get_cells_in_rows", { startRow, endRow });
}

/**
 * Get all non-empty cells in a column range using sparse iteration.
 * Much faster than getViewportCells for full-height column reads.
 */
export async function getCellsInCols(
  startCol: number,
  endCol: number
): Promise<CellData[]> {
  return invoke<CellData[]>("get_cells_in_cols", { startCol, endCol });
}

/**
 * Check if any cells with actual content exist in a range.
 * Returns true if any cell has a value or formula (ignores style-only cells).
 */
export async function hasContentInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<boolean> {
  return invoke<boolean>("has_content_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

// ============================================================================
// Navigation Operations
// ============================================================================

export type ArrowDirection = "up" | "down" | "left" | "right";

/**
 * Find the target cell for Ctrl+Arrow navigation (Excel-like behavior).
 * @param row - Current row position
 * @param col - Current column position
 * @param direction - Direction to navigate ("up", "down", "left", "right")
 * @param maxRow - Maximum row index (totalRows - 1)
 * @param maxCol - Maximum column index (totalCols - 1)
 * @returns Target [row, col] position
 */
export async function findCtrlArrowTarget(
  row: number,
  col: number,
  direction: ArrowDirection,
  maxRow: number,
  maxCol: number
): Promise<[number, number]> {
  return invoke<[number, number]>("find_ctrl_arrow_target", {
    row,
    col,
    direction,
    maxRow,
    maxCol,
  });
}

/**
 * Detect the contiguous data region around a cell (Excel's CurrentRegion).
 * Returns [startRow, startCol, endRow, endCol] or null if the cell is isolated/empty.
 */
export async function detectDataRegion(
  row: number,
  col: number
): Promise<[number, number, number, number] | null> {
  return invoke<[number, number, number, number] | null>("detect_data_region", {
    row,
    col,
  });
}

// ============================================================================
// Dimension Operations
// ============================================================================

export async function setColumnWidth(col: number, width: number): Promise<void> {
  return invoke<void>("set_column_width", { col, width });
}

export async function getColumnWidth(col: number): Promise<number | null> {
  return invoke<number | null>("get_column_width", { col });
}

export async function getAllColumnWidths(): Promise<DimensionData[]> {
  return invoke<DimensionData[]>("get_all_column_widths");
}

export async function setRowHeight(row: number, height: number): Promise<void> {
  return invoke<void>("set_row_height", { row, height });
}

export async function getRowHeight(row: number): Promise<number | null> {
  return invoke<number | null>("get_row_height", { row });
}

export async function getAllRowHeights(): Promise<DimensionData[]> {
  return invoke<DimensionData[]>("get_all_row_heights");
}

// ============================================================================
// Style Operations
// ============================================================================

export async function getStyle(styleIndex: number): Promise<StyleData> {
  // FIXED: Mapped 'styleIndex' to 'style_index' if Rust expects snake_case (standard practice)
  // Assuming get_style(index: usize) in Rust based on context, but keeping key flexible
  // NOTE: get_style definition in commands.rs uses `index`, not `style_index`. Keeping as is based on step 3 file.
  // Rust: pub fn get_style(state: State<AppState>, index: usize) -> StyleData
  return invoke<StyleData>("get_style", { index: styleIndex });
}

export async function getAllStyles(): Promise<StyleData[]> {
  return invoke<StyleData[]>("get_all_styles");
}

export async function setCellStyle(
  row: number,
  col: number,
  styleIndex: number
): Promise<CellData> {
  return invoke<CellData>("set_cell_style", { row, col, styleIndex });
}

export async function applyFormatting(
  rows: number[],
  cols: number[],
  formatting: FormattingOptions
): Promise<FormattingResult> {
  console.log(
    "[tauri-api] applyFormatting:",
    "rows=",
    rows,
    "cols=",
    cols,
    "formatting=",
    formatting
  );
  const result = await invoke<FormattingResult>("apply_formatting", {
    params: {
      rows,
      cols,
      bold: formatting.bold,
      italic: formatting.italic,
      underline: formatting.underline,
      strikethrough: formatting.strikethrough,
      fontSize: formatting.fontSize,
      fontFamily: formatting.fontFamily,
      textColor: formatting.textColor,
      backgroundColor: formatting.backgroundColor,
      textAlign: formatting.textAlign,
      verticalAlign: formatting.verticalAlign,
      numberFormat: formatting.numberFormat,
      wrapText: formatting.wrapText,
      textRotation: formatting.textRotation,
      borderTop: formatting.borderTop,
      borderRight: formatting.borderRight,
      borderBottom: formatting.borderBottom,
      borderLeft: formatting.borderLeft,
    },
  });
  console.log(
    "[tauri-api] applyFormatting result:",
    "cells=",
    result.cells.length,
    "styles=",
    result.styles.length
  );
  return result;
}

export async function getStyleCount(): Promise<number> {
  return invoke<number>("get_style_count");
}

// ============================================================================
// Function Library Operations
// ============================================================================

export async function getFunctionsByCategory(
  category: string
): Promise<{ functions: FunctionInfo[] }> {
  return invoke<{ functions: FunctionInfo[] }>("get_functions_by_category", {
    category,
  });
}

export async function getAllFunctions(): Promise<{ functions: FunctionInfo[] }> {
  return invoke<{ functions: FunctionInfo[] }>("get_all_functions");
}

export async function getFunctionTemplate(functionName: string): Promise<string> {
  return invoke<string>("get_function_template", { functionName });
}

// ============================================================================
// Calculation Mode Operations
// ============================================================================

export async function setCalculationMode(mode: "automatic" | "manual"): Promise<string> {
  return invoke<string>("set_calculation_mode", { mode });
}

export async function getCalculationMode(): Promise<string> {
  return invoke<string>("get_calculation_mode");
}

export async function calculateNow(): Promise<CellData[]> {
  console.log("[tauri-api] calculateNow - recalculating all formulas");
  const result = await invoke<CellData[]>("calculate_now");
  console.log(`[tauri-api] calculateNow returned ${result.length} updated cells`);
  return result;
}

export async function calculateSheet(): Promise<CellData[]> {
  console.log("[tauri-api] calculateSheet - recalculating current sheet");
  const result = await invoke<CellData[]>("calculate_sheet");
  console.log(`[tauri-api] calculateSheet returned ${result.length} updated cells`);
  return result;
}

// ============================================================================
// Sheet Operations
// ============================================================================

export interface SheetInfo {
  index: number;
  name: string;
}

export interface SheetsResult {
  sheets: SheetInfo[];
  activeIndex: number;
}

export async function getSheets(): Promise<SheetsResult> {
  return invoke<SheetsResult>("get_sheets");
}

export async function getActiveSheet(): Promise<number> {
  return invoke<number>("get_active_sheet");
}

export async function setActiveSheet(index: number): Promise<SheetsResult> {
  return invoke<SheetsResult>("set_active_sheet", { index });
}

export async function addSheet(name?: string): Promise<SheetsResult> {
  return invoke<SheetsResult>("add_sheet", { name: name ?? null });
}

export async function deleteSheet(index: number): Promise<SheetsResult> {
  return invoke<SheetsResult>("delete_sheet", { index });
}

export async function renameSheet(index: number, newName: string): Promise<SheetsResult> {
  // FIXED: Mapped 'newName' to 'new_name' to match Rust command signature
  return invoke<SheetsResult>("rename_sheet", { index, new_name: newName });
}

/**
 * Insert rows at the specified position, shifting existing rows down.
 * @param row - The row index where new rows will be inserted
 * @param count - Number of rows to insert
 */
export async function insertRows(row: number, count: number): Promise<CellData[]> {
  console.log(`[tauri-api] insertRows(${row}, ${count})`);
  const result = await invoke<CellData[]>("insert_rows", { row, count });
  console.log(`[tauri-api] insertRows returned ${result.length} updated cells`);
  return result;
}

/**
 * Insert columns at the specified position, shifting existing columns right.
 * @param col - The column index where new columns will be inserted
 * @param count - Number of columns to insert
 */
export async function insertColumns(col: number, count: number): Promise<CellData[]> {
  console.log(`[tauri-api] insertColumns(${col}, ${count})`);
  const result = await invoke<CellData[]>("insert_columns", { col, count });
  console.log(`[tauri-api] insertColumns returned ${result.length} updated cells`);
  return result;
}

/**
 * Delete rows at the specified position, shifting remaining rows up.
 * @param row - The row index where deletion starts
 * @param count - Number of rows to delete
 */
export async function deleteRows(row: number, count: number): Promise<CellData[]> {
  console.log(`[tauri-api] deleteRows(${row}, ${count})`);
  const result = await invoke<CellData[]>("delete_rows", { row, count });
  console.log(`[tauri-api] deleteRows returned ${result.length} updated cells`);
  return result;
}

/**
 * Delete columns at the specified position, shifting remaining columns left.
 * @param col - The column index where deletion starts
 * @param count - Number of columns to delete
 */
export async function deleteColumns(col: number, count: number): Promise<CellData[]> {
  console.log(`[tauri-api] deleteColumns(${col}, ${count})`);
  const result = await invoke<CellData[]>("delete_columns", { col, count });
  console.log(`[tauri-api] deleteColumns returned ${result.length} updated cells`);
  return result;
}

// ============================================================================
// Undo/Redo Operations
// ============================================================================

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoDescription: string | null;
  redoDescription: string | null;
}

export interface UndoResult {
  success: boolean;
  description: string | null;
  updatedCells: CellData[];
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Begin an undo transaction. All subsequent cell changes will be grouped
 * into a single undoable action until commitUndoTransaction() is called.
 * @param description - Human-readable label for the transaction (e.g., "Paste 10 cells")
 */
export async function beginUndoTransaction(description: string): Promise<void> {
  return invoke<void>("begin_undo_transaction", { description });
}

/**
 * Commit the current undo transaction, finalizing it as a single undo entry.
 */
export async function commitUndoTransaction(): Promise<void> {
  return invoke<void>("commit_undo_transaction");
}

/**
 * Cancel the current undo transaction without saving it.
 */
export async function cancelUndoTransaction(): Promise<void> {
  return invoke<void>("cancel_undo_transaction");
}

/**
 * Get the current undo/redo state.
 */
export async function getUndoState(): Promise<UndoState> {
  return invoke<UndoState>("get_undo_state");
}

/**
 * Undo the last action.
 */
export async function undo(): Promise<UndoResult> {
  console.log("[tauri-api] undo");
  const result = await invoke<UndoResult>("undo");
  console.log(`[tauri-api] undo returned ${result.updatedCells.length} updated cells, canUndo=${result.canUndo}, canRedo=${result.canRedo}`);
  return result;
}

/**
 * Redo the last undone action.
 */
export async function redo(): Promise<UndoResult> {
  console.log("[tauri-api] redo");
  const result = await invoke<UndoResult>("redo");
  console.log(`[tauri-api] redo returned ${result.updatedCells.length} updated cells, canUndo=${result.canUndo}, canRedo=${result.canRedo}`);
  return result;
}

// ============================================================================
// Find & Replace Operations
// ============================================================================

export interface FindResult {
  matches: [number, number][];
  totalCount: number;
}

export interface ReplaceResult {
  updatedCells: CellData[];
  replacementCount: number;
}

export interface FindOptions {
  caseSensitive?: boolean;
  matchEntireCell?: boolean;
  searchFormulas?: boolean;
}

/**
 * Find all cells matching the search query.
 * Returns coordinates sorted in reading order (row, then column).
 */
export async function findAll(
  query: string,
  options: FindOptions = {}
): Promise<FindResult> {
  const {
    caseSensitive = false,
    matchEntireCell = false,
    searchFormulas = false,
  } = options;

  return invoke<FindResult>("find_all", {
    query,
    caseSensitive,
    matchEntireCell,
    searchFormulas,
  });
}

/**
 * Count matches without returning coordinates (faster for display).
 */
export async function countMatches(
  query: string,
  options: FindOptions = {}
): Promise<number> {
  const {
    caseSensitive = false,
    matchEntireCell = false,
    searchFormulas = false,
  } = options;

  return invoke<number>("count_matches", {
    query,
    caseSensitive,
    matchEntireCell,
    searchFormulas,
  });
}

/**
 * Replace all occurrences. This is an atomic operation for undo.
 */
export async function replaceAll(
  search: string,
  replacement: string,
  options: { caseSensitive?: boolean; matchEntireCell?: boolean } = {}
): Promise<ReplaceResult> {
  const { caseSensitive = false, matchEntireCell = false } = options;

  console.log(
    `[tauri-api] replaceAll("${search}" -> "${replacement}", caseSensitive=${caseSensitive})`
  );

  const result = await invoke<ReplaceResult>("replace_all", {
    search,
    replacement,
    caseSensitive,
    matchEntireCell,
  });

  console.log(
    `[tauri-api] replaceAll completed: ${result.replacementCount} replacements`
  );

  return result;
}

/**
 * Replace a single occurrence in a specific cell.
 */
export async function replaceSingle(
  row: number,
  col: number,
  search: string,
  replacement: string,
  caseSensitive: boolean = false
): Promise<CellData | null> {
  return invoke<CellData | null>("replace_single", {
    row,
    col,
    search,
    replacement,
    caseSensitive,
  });
}


// ============================================================================
// FREEZE PANES API
// ============================================================================

export interface FreezeConfig {
  freezeRow: number | null;
  freezeCol: number | null;
}

export async function setFreezePanes(
  freezeRow: number | null,
  freezeCol: number | null
): Promise<SheetsResult> {
  console.log('[tauri-api] setFreezePanes called with:', { freezeRow, freezeCol });
  const result = await invoke<SheetsResult>("set_freeze_panes", { freezeRow, freezeCol });
  console.log('[tauri-api] setFreezePanes result:', result);
  return result;
}

export async function getFreezePanes(): Promise<FreezeConfig> {
  console.log('[tauri-api] getFreezePanes called');
  const result = await invoke<FreezeConfig>("get_freeze_panes", {});
  console.log('[tauri-api] getFreezePanes result:', result);
  return result;
}

// ============================================================================
// MERGE CELLS API
// ============================================================================

export interface MergedRegion {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface MergeResult {
  success: boolean;
  mergedRegions: MergedRegion[];
  updatedCells: CellData[];
}

/**
 * Merge cells in the specified range.
 * The top-left cell becomes the master cell.
 */
export async function mergeCells(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<MergeResult> {
  console.log(`[tauri-api] mergeCells(${startRow}, ${startCol}, ${endRow}, ${endCol})`);
  const result = await invoke<MergeResult>("merge_cells", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
  console.log(`[tauri-api] mergeCells result:`, result);
  return result;
}

/**
 * Unmerge cells at the specified position.
 */
export async function unmergeCells(row: number, col: number): Promise<MergeResult> {
  console.log(`[tauri-api] unmergeCells(${row}, ${col})`);
  const result = await invoke<MergeResult>("unmerge_cells", { row, col });
  console.log(`[tauri-api] unmergeCells result:`, result);
  return result;
}

/**
 * Get all merged regions for the current sheet.
 */
export async function getMergedRegions(): Promise<MergedRegion[]> {
  return invoke<MergedRegion[]>("get_merged_regions");
}

/**
 * Check if a cell is part of a merged region.
 */
export async function getMergeInfo(
  row: number,
  col: number
): Promise<MergedRegion | null> {
  return invoke<MergedRegion | null>("get_merge_info", { row, col });
}

export async function shiftFormulaForFill(
  formula: string,
  rowDelta: number,
  colDelta: number
): Promise<string> {
  return await invoke<string>("shift_formula_for_fill", {
    formula,
    rowDelta,
    colDelta,
  });
}

/**
 * Input for batch formula shifting.
 */
export interface FormulaShiftInput {
  formula: string;
  rowDelta: number;
  colDelta: number;
}

/**
 * Batch shift multiple formulas at once for fill operations.
 * This is significantly faster than calling shiftFormulaForFill multiple times
 * because it processes all formulas in a single IPC call.
 * @param inputs - Array of formula shift inputs
 * @returns Array of shifted formulas in the same order as inputs
 */
export async function shiftFormulasBatch(
  inputs: FormulaShiftInput[]
): Promise<string[]> {
  if (inputs.length === 0) {
    return [];
  }
  const t0 = performance.now();
  const result = await invoke<{ formulas: string[] }>("shift_formulas_batch", {
    inputs,
  });
  const dt = performance.now() - t0;
  console.log(`[PERF][bridge] shiftFormulasBatch(${inputs.length}) | ipc=${dt.toFixed(1)}ms`);
  return result.formulas;
}

// ============================================================================
// Named Ranges
// ============================================================================

import type {
  NamedRange,
  NamedRangeResult,
  ResolvedRange,
  DataValidation,
  DataValidationResult,
  DataValidationPrompt,
  InvalidCellsResult,
  CellValidationResult,
  ValidationRange,
} from "../types";

/**
 * Create a new named range.
 */
export async function createNamedRange(
  name: string,
  sheetIndex: number | null,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  comment?: string
): Promise<NamedRangeResult> {
  return invoke<NamedRangeResult>("create_named_range", {
    name,
    sheetIndex,
    startRow,
    startCol,
    endRow,
    endCol,
    comment: comment ?? null,
  });
}

/**
 * Update an existing named range.
 */
export async function updateNamedRange(
  name: string,
  sheetIndex: number | null,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  comment?: string
): Promise<NamedRangeResult> {
  return invoke<NamedRangeResult>("update_named_range", {
    name,
    sheetIndex,
    startRow,
    startCol,
    endRow,
    endCol,
    comment: comment ?? null,
  });
}

/**
 * Delete a named range.
 */
export async function deleteNamedRange(name: string): Promise<NamedRangeResult> {
  return invoke<NamedRangeResult>("delete_named_range", { name });
}

/**
 * Get a named range by name.
 */
export async function getNamedRange(name: string): Promise<NamedRange | null> {
  return invoke<NamedRange | null>("get_named_range", { name });
}

/**
 * Get all named ranges.
 */
export async function getAllNamedRanges(): Promise<NamedRange[]> {
  return invoke<NamedRange[]>("get_all_named_ranges");
}

/**
 * Resolve a named range to its coordinates for formula evaluation.
 */
export async function resolveNamedRange(
  name: string,
  currentSheetIndex: number
): Promise<ResolvedRange | null> {
  return invoke<ResolvedRange | null>("resolve_named_range", {
    name,
    currentSheetIndex,
  });
}

/**
 * Rename a named range.
 */
export async function renameNamedRange(
  oldName: string,
  newName: string
): Promise<NamedRangeResult> {
  return invoke<NamedRangeResult>("rename_named_range", { oldName, newName });
}

// ============================================================================
// Data Validation
// ============================================================================

/**
 * Set data validation on a range.
 */
export async function setDataValidation(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  validation: DataValidation
): Promise<DataValidationResult> {
  console.log(
    `[tauri-api] setDataValidation(${startRow}, ${startCol}, ${endRow}, ${endCol})`,
    validation
  );
  return invoke<DataValidationResult>("set_data_validation", {
    startRow,
    startCol,
    endRow,
    endCol,
    validation,
  });
}

/**
 * Clear data validation from a range.
 */
export async function clearDataValidation(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<DataValidationResult> {
  console.log(
    `[tauri-api] clearDataValidation(${startRow}, ${startCol}, ${endRow}, ${endCol})`
  );
  return invoke<DataValidationResult>("clear_data_validation", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

/**
 * Get data validation for a specific cell.
 */
export async function getDataValidation(
  row: number,
  col: number
): Promise<DataValidation | null> {
  return invoke<DataValidation | null>("get_data_validation", { row, col });
}

/**
 * Get all validation ranges for the current sheet.
 */
export async function getAllDataValidations(): Promise<ValidationRange[]> {
  return invoke<ValidationRange[]>("get_all_data_validations");
}

/**
 * Validate a cell value against its validation rule.
 */
export async function validateCell(
  row: number,
  col: number
): Promise<CellValidationResult> {
  return invoke<CellValidationResult>("validate_cell", { row, col });
}

/**
 * Get the input prompt for a cell (if any).
 */
export async function getValidationPrompt(
  row: number,
  col: number
): Promise<DataValidationPrompt | null> {
  return invoke<DataValidationPrompt | null>("get_validation_prompt", { row, col });
}

/**
 * Get all invalid cells in the current sheet.
 */
export async function getInvalidCells(): Promise<InvalidCellsResult> {
  return invoke<InvalidCellsResult>("get_invalid_cells");
}

/**
 * Get dropdown list values for a cell with list validation.
 */
export async function getValidationListValues(
  row: number,
  col: number
): Promise<string[] | null> {
  return invoke<string[] | null>("get_validation_list_values", { row, col });
}

/**
 * Check if a cell has an in-cell dropdown.
 */
export async function hasInCellDropdown(
  row: number,
  col: number
): Promise<boolean> {
  return invoke<boolean>("has_in_cell_dropdown", { row, col });
}

// ============================================================================
// Comments / Notes
// ============================================================================

import type {
  Comment,
  CommentResult,
  ReplyResult,
  CommentIndicator,
  AddCommentParams,
  UpdateCommentParams,
  AddReplyParams,
  UpdateReplyParams,
} from "../types";

/**
 * Add a comment to a cell.
 */
export async function addComment(params: AddCommentParams): Promise<CommentResult> {
  console.log(`[tauri-api] addComment(${params.row}, ${params.col})`);
  return invoke<CommentResult>("add_comment", { params });
}

/**
 * Update an existing comment's content.
 */
export async function updateComment(params: UpdateCommentParams): Promise<CommentResult> {
  console.log(`[tauri-api] updateComment(${params.commentId})`);
  return invoke<CommentResult>("update_comment", { params });
}

/**
 * Delete a comment and all its replies.
 */
export async function deleteComment(commentId: string): Promise<CommentResult> {
  console.log(`[tauri-api] deleteComment(${commentId})`);
  return invoke<CommentResult>("delete_comment", { commentId });
}

/**
 * Get a comment at a specific cell.
 */
export async function getComment(row: number, col: number): Promise<Comment | null> {
  return invoke<Comment | null>("get_comment", { row, col });
}

/**
 * Get a comment by ID.
 */
export async function getCommentById(commentId: string): Promise<Comment | null> {
  return invoke<Comment | null>("get_comment_by_id", { commentId });
}

/**
 * Get all comments for the current sheet.
 */
export async function getAllComments(): Promise<Comment[]> {
  return invoke<Comment[]>("get_all_comments");
}

/**
 * Get all comments for a specific sheet.
 */
export async function getCommentsForSheet(sheetIndex: number): Promise<Comment[]> {
  return invoke<Comment[]>("get_comments_for_sheet", { sheetIndex });
}

/**
 * Get comment indicators for the current sheet (for rendering comment markers).
 */
export async function getCommentIndicators(): Promise<CommentIndicator[]> {
  return invoke<CommentIndicator[]>("get_comment_indicators");
}

/**
 * Get comment indicators for a viewport range.
 */
export async function getCommentIndicatorsInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<CommentIndicator[]> {
  return invoke<CommentIndicator[]>("get_comment_indicators_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

/**
 * Set the resolved status of a comment.
 */
export async function resolveComment(
  commentId: string,
  resolved: boolean
): Promise<CommentResult> {
  console.log(`[tauri-api] resolveComment(${commentId}, ${resolved})`);
  return invoke<CommentResult>("resolve_comment", { commentId, resolved });
}

/**
 * Add a reply to a comment.
 */
export async function addReply(params: AddReplyParams): Promise<ReplyResult> {
  console.log(`[tauri-api] addReply(${params.commentId})`);
  return invoke<ReplyResult>("add_reply", { params });
}

/**
 * Update a reply's content.
 */
export async function updateReply(params: UpdateReplyParams): Promise<ReplyResult> {
  console.log(`[tauri-api] updateReply(${params.commentId}, ${params.replyId})`);
  return invoke<ReplyResult>("update_reply", { params });
}

/**
 * Delete a reply from a comment.
 */
export async function deleteReply(
  commentId: string,
  replyId: string
): Promise<ReplyResult> {
  console.log(`[tauri-api] deleteReply(${commentId}, ${replyId})`);
  return invoke<ReplyResult>("delete_reply", { commentId, replyId });
}

/**
 * Move a comment to a different cell.
 */
export async function moveComment(
  commentId: string,
  newRow: number,
  newCol: number
): Promise<CommentResult> {
  console.log(`[tauri-api] moveComment(${commentId}, ${newRow}, ${newCol})`);
  return invoke<CommentResult>("move_comment", { commentId, newRow, newCol });
}

/**
 * Get the total count of comments on the current sheet.
 */
export async function getCommentCount(): Promise<number> {
  return invoke<number>("get_comment_count");
}

/**
 * Check if a cell has a comment.
 */
export async function hasComment(row: number, col: number): Promise<boolean> {
  return invoke<boolean>("has_comment", { row, col });
}

/**
 * Clear all comments from the current sheet.
 */
export async function clearAllComments(): Promise<number> {
  console.log("[tauri-api] clearAllComments");
  return invoke<number>("clear_all_comments");
}

/**
 * Clear comments in a range.
 */
export async function clearCommentsInRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): Promise<number> {
  console.log(
    `[tauri-api] clearCommentsInRange(${startRow}, ${startCol}, ${endRow}, ${endCol})`
  );
  return invoke<number>("clear_comments_in_range", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}