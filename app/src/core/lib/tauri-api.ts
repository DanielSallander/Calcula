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
  return invoke<CellData[]>("get_viewport_cells", {
    startRow,
    startCol,
    endRow,
    endCol,
  });
}

export async function getCell(row: number, col: number): Promise<CellData | null> {
  return invoke<CellData | null>("get_cell", { row, col });
}

export async function updateCell(
  row: number,
  col: number,
  input: string
): Promise<CellData[]> {
  console.log(`[tauri-api] updateCell(${row}, ${col}, "${input}")`);
  // FIXED: Mapped 'input' to 'value' to match Rust command signature
  const result = await invoke<CellData[]>("update_cell", { row, col, value: input });
  console.log(`[tauri-api] updateCell returned ${result.length} updated cells`);
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
  // FIXED: Mapped 'styleIndex' to 'style_index' to match Rust command signature
  return invoke<CellData>("set_cell_style", { row, col, style_index: styleIndex });
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
      textColor: formatting.textColor,
      backgroundColor: formatting.backgroundColor,
      textAlign: formatting.textAlign,
      numberFormat: formatting.numberFormat,
      wrapText: formatting.wrapText,
      textRotation: formatting.textRotation,
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