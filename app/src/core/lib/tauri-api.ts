// FILENAME: app/src/core/lib/tauri-api.ts
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