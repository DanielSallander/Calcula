//! FILENAME: app/extensions/AdvancedFilter/lib/advancedFilterEngine.ts
// PURPOSE: Core logic for Excel-style Advanced Filter.
// CONTEXT: Parses criteria ranges, matches rows, supports filter-in-place and copy-to.

import {
  getViewportCells,
  updateCellsBatch,
  setHiddenRows,
  dispatchGridAction,
  emitAppEvent,
  AppEvents,
  indexToCol,
  colToIndex,
  setAdvancedFilterHiddenRows,
  clearAdvancedFilterHiddenRows,
} from "@api";
import type { CellData } from "@api";
import type {
  AdvancedFilterParams,
  AdvancedFilterResult,
  ParsedCriterion,
  CriteriaRow,
} from "../types";

// ============================================================================
// Range Reference Helpers
// ============================================================================

/**
 * Parse an A1-style range string like "A1:D10" into [startRow, startCol, endRow, endCol].
 * Row numbers are 1-based in the string but returned as 0-based.
 */
export function parseRangeRef(ref: string): [number, number, number, number] | null {
  const trimmed = ref.trim().toUpperCase();
  const match = trimmed.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match) {
    // Try single cell reference like "A1"
    const singleMatch = trimmed.match(/^([A-Z]+)(\d+)$/);
    if (singleMatch) {
      const col = colToIndex(singleMatch[1]);
      const row = parseInt(singleMatch[2], 10) - 1;
      return [row, col, row, col];
    }
    return null;
  }
  const startCol = colToIndex(match[1]);
  const startRow = parseInt(match[2], 10) - 1;
  const endCol = colToIndex(match[3]);
  const endRow = parseInt(match[4], 10) - 1;
  return [startRow, startCol, endRow, endCol];
}

/**
 * Format a range tuple as an A1-style reference string.
 */
export function formatRangeRef(startRow: number, startCol: number, endRow: number, endCol: number): string {
  return `${indexToCol(startCol)}${startRow + 1}:${indexToCol(endCol)}${endRow + 1}`;
}

/**
 * Format a single cell as an A1-style reference.
 */
export function formatCellRef(row: number, col: number): string {
  return `${indexToCol(col)}${row + 1}`;
}

// ============================================================================
// Criteria Parsing
// ============================================================================

/**
 * Parse a single criteria cell value into an operator and comparison value.
 * Supports: =value, <>value, >value, <value, >=value, <=value, value (implicit =)
 * Wildcards: * (any chars), ? (single char)
 */
export function parseCriterion(cellValue: string): ParsedCriterion {
  const trimmed = cellValue.trim();

  if (trimmed === "") {
    return { operator: "=", value: "", hasWildcard: false };
  }

  // Check for comparison operators (order matters: >= before >, <= before <)
  for (const op of [">=", "<=", "<>", ">", "<", "="] as const) {
    if (trimmed.startsWith(op)) {
      const val = trimmed.slice(op.length).trim();
      return {
        operator: op,
        value: val,
        hasWildcard: (op === "=" || op === "<>") && /[*?]/.test(val),
      };
    }
  }

  // No operator prefix => implicit equals
  return {
    operator: "=",
    value: trimmed,
    hasWildcard: /[*?]/.test(trimmed),
  };
}

/**
 * Convert a wildcard pattern (* and ?) to a RegExp.
 */
function wildcardToRegex(pattern: string): RegExp {
  // Escape regex special chars except * and ?
  const escaped = pattern.replace(/([.+^${}()|[\]\\])/g, "\\$1");
  const regexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`, "i");
}

/**
 * Compare a cell value against a parsed criterion.
 */
function matchesCriterion(cellValue: string, criterion: ParsedCriterion): boolean {
  // Empty criterion matches everything
  if (criterion.value === "" && criterion.operator === "=") {
    return true;
  }

  const cv = cellValue.trim();
  const cv_lower = cv.toLowerCase();
  const crit_lower = criterion.value.toLowerCase();

  // Try numeric comparison first
  const cellNum = parseFloat(cv);
  const critNum = parseFloat(criterion.value);
  const bothNumeric = !isNaN(cellNum) && !isNaN(critNum) && cv !== "" && criterion.value !== "";

  switch (criterion.operator) {
    case "=":
      if (criterion.hasWildcard) {
        return wildcardToRegex(criterion.value).test(cv);
      }
      if (bothNumeric) return cellNum === critNum;
      return cv_lower === crit_lower;

    case "<>":
      if (criterion.hasWildcard) {
        return !wildcardToRegex(criterion.value).test(cv);
      }
      if (bothNumeric) return cellNum !== critNum;
      return cv_lower !== crit_lower;

    case ">":
      if (bothNumeric) return cellNum > critNum;
      return cv_lower > crit_lower;

    case "<":
      if (bothNumeric) return cellNum < critNum;
      return cv_lower < crit_lower;

    case ">=":
      if (bothNumeric) return cellNum >= critNum;
      return cv_lower >= crit_lower;

    case "<=":
      if (bothNumeric) return cellNum <= critNum;
      return cv_lower <= crit_lower;

    default:
      return false;
  }
}

// ============================================================================
// Criteria Range Reading
// ============================================================================

/**
 * Build a cell value lookup map from a CellData array.
 * Key: "row,col" => display value.
 */
function buildCellMap(cells: CellData[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cell of cells) {
    map.set(`${cell.row},${cell.col}`, cell.display);
  }
  return map;
}

/**
 * Read the criteria range and parse it into CriteriaRows.
 * First row = headers that must match list range headers.
 * Subsequent rows = criteria (same row = AND, different rows = OR).
 */
async function parseCriteriaRange(
  criteriaRange: [number, number, number, number],
  listHeaders: Map<string, number>, // header name (lowercase) => column index relative to list
): Promise<CriteriaRow[]> {
  const [crStartRow, crStartCol, crEndRow, crEndCol] = criteriaRange;

  const cells = await getViewportCells(crStartRow, crStartCol, crEndRow, crEndCol);
  const cellMap = buildCellMap(cells);

  // Read criteria headers (first row)
  const criteriaHeaderMap: Map<number, number> = new Map(); // criteria col => list col index
  for (let col = crStartCol; col <= crEndCol; col++) {
    const headerVal = (cellMap.get(`${crStartRow},${col}`) ?? "").trim().toLowerCase();
    if (headerVal !== "" && listHeaders.has(headerVal)) {
      criteriaHeaderMap.set(col, listHeaders.get(headerVal)!);
    }
  }

  // Parse criteria rows (rows below the header)
  const criteriaRows: CriteriaRow[] = [];
  for (let row = crStartRow + 1; row <= crEndRow; row++) {
    const conditions = new Map<number, ParsedCriterion>();
    let hasAnyCriterion = false;

    for (const [crCol, listColIdx] of criteriaHeaderMap) {
      const val = (cellMap.get(`${row},${crCol}`) ?? "").trim();
      if (val !== "") {
        conditions.set(listColIdx, parseCriterion(val));
        hasAnyCriterion = true;
      }
    }

    // Only add rows that have at least one non-empty criterion
    if (hasAnyCriterion) {
      criteriaRows.push({ conditions });
    }
  }

  return criteriaRows;
}

// ============================================================================
// Row Matching
// ============================================================================

/**
 * Check if a single data row matches one CriteriaRow (all conditions must match = AND).
 */
function rowMatchesCriteriaRow(
  rowValues: Map<number, string>, // col index relative to list => display value
  criteriaRow: CriteriaRow,
): boolean {
  for (const [colIdx, criterion] of criteriaRow.conditions) {
    const cellValue = rowValues.get(colIdx) ?? "";
    if (!matchesCriterion(cellValue, criterion)) {
      return false; // AND: any failure = no match
    }
  }
  return true;
}

/**
 * Check if a data row matches any of the criteria rows (OR between rows).
 */
function rowMatchesAnyCriteria(
  rowValues: Map<number, string>,
  criteriaRows: CriteriaRow[],
): boolean {
  // If no criteria rows, match everything
  if (criteriaRows.length === 0) return true;

  for (const cr of criteriaRows) {
    if (rowMatchesCriteriaRow(rowValues, cr)) {
      return true; // OR: any success = match
    }
  }
  return false;
}

// ============================================================================
// Unique Record Detection
// ============================================================================

/**
 * Generate a key for a row's values to detect duplicates.
 */
function rowKey(rowValues: Map<number, string>, colCount: number): string {
  const parts: string[] = [];
  for (let c = 0; c < colCount; c++) {
    parts.push((rowValues.get(c) ?? "").toLowerCase());
  }
  return parts.join("\x00");
}

// ============================================================================
// Main Advanced Filter Execution
// ============================================================================

/**
 * Execute an Advanced Filter operation.
 */
export async function executeAdvancedFilter(params: AdvancedFilterParams): Promise<AdvancedFilterResult> {
  const { listRange, criteriaRange, action, copyTo, uniqueRecordsOnly } = params;
  const [lStartRow, lStartCol, lEndRow, lEndCol] = listRange;

  // 1. Read all list data
  const listCells = await getViewportCells(lStartRow, lStartCol, lEndRow, lEndCol);
  const listCellMap = buildCellMap(listCells);

  // 2. Build header name => relative column index mapping
  const listHeaders = new Map<string, number>();
  const colCount = lEndCol - lStartCol + 1;
  for (let col = lStartCol; col <= lEndCol; col++) {
    const headerVal = (listCellMap.get(`${lStartRow},${col}`) ?? "").trim().toLowerCase();
    if (headerVal !== "") {
      listHeaders.set(headerVal, col - lStartCol);
    }
  }

  if (listHeaders.size === 0) {
    return { success: false, matchCount: 0, affectedRows: 0, error: "No headers found in list range." };
  }

  // 3. Parse criteria range
  const criteriaRows = await parseCriteriaRange(criteriaRange, listHeaders);

  // 4. Evaluate each data row
  const matchingRows: number[] = []; // absolute row indices
  const seenKeys = new Set<string>();

  for (let row = lStartRow + 1; row <= lEndRow; row++) {
    // Build row values map (relative col index => value)
    const rowValues = new Map<number, string>();
    for (let col = lStartCol; col <= lEndCol; col++) {
      rowValues.set(col - lStartCol, listCellMap.get(`${row},${col}`) ?? "");
    }

    // Check criteria match
    if (!rowMatchesAnyCriteria(rowValues, criteriaRows)) {
      continue;
    }

    // Check uniqueness
    if (uniqueRecordsOnly) {
      const key = rowKey(rowValues, colCount);
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
    }

    matchingRows.push(row);
  }

  // 5. Apply the result
  if (action === "filterInPlace") {
    // Hide non-matching data rows
    const hiddenRows: number[] = [];
    for (let row = lStartRow + 1; row <= lEndRow; row++) {
      if (!matchingRows.includes(row)) {
        hiddenRows.push(row);
      }
    }
    dispatchGridAction(setHiddenRows(hiddenRows));
    // Sync to backend so getHiddenRows() returns correct results
    await setAdvancedFilterHiddenRows(hiddenRows);
    emitAppEvent(AppEvents.GRID_REFRESH);

    return {
      success: true,
      matchCount: matchingRows.length,
      affectedRows: hiddenRows.length,
    };
  } else if (action === "copyToLocation" && copyTo) {
    // Copy headers + matching rows to the destination
    const [destRow, destCol] = copyTo;
    const updates: Array<{ row: number; col: number; value: string }> = [];

    // Copy headers
    for (let c = 0; c < colCount; c++) {
      const headerVal = listCellMap.get(`${lStartRow},${lStartCol + c}`) ?? "";
      updates.push({ row: destRow, col: destCol + c, value: headerVal });
    }

    // Copy matching data rows
    for (let i = 0; i < matchingRows.length; i++) {
      const srcRow = matchingRows[i];
      for (let c = 0; c < colCount; c++) {
        const val = listCellMap.get(`${srcRow},${lStartCol + c}`) ?? "";
        updates.push({ row: destRow + 1 + i, col: destCol + c, value: val });
      }
    }

    await updateCellsBatch(updates);
    emitAppEvent(AppEvents.GRID_REFRESH);

    return {
      success: true,
      matchCount: matchingRows.length,
      affectedRows: matchingRows.length,
    };
  }

  return { success: false, matchCount: 0, affectedRows: 0, error: "Invalid action or missing copy-to location." };
}

/**
 * Clear Advanced Filter (unhide all rows).
 */
export function clearAdvancedFilter(): void {
  dispatchGridAction(setHiddenRows([]));
  // Clear backend state
  clearAdvancedFilterHiddenRows();
  emitAppEvent(AppEvents.GRID_REFRESH);
}
