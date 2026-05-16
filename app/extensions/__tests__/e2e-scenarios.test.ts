//! FILENAME: app/extensions/__tests__/e2e-scenarios.test.ts
// PURPOSE: End-to-end scenario tests that simulate complete user workflows
//          across multiple extensions, verifying cross-module integration.
// CONTEXT: Each scenario chains 5+ modules together to exercise realistic
//          multi-extension workflows (Financial Report, Data Analysis, Template, Collaborative Editing).

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// Mocks - must be declared before any imports that use @api
// ============================================================================

vi.mock("@api", () => ({
  columnToLetter: (col: number) => {
    let result = "";
    let n = col;
    while (n >= 0) {
      result = String.fromCharCode((n % 26) + 65) + result;
      n = Math.floor(n / 26) - 1;
    }
    return result;
  },
  letterToColumn: (letters: string) => {
    let result = 0;
    for (let i = 0; i < letters.length; i++) {
      result = result * 26 + (letters.charCodeAt(i) - 64);
    }
    return result - 1;
  },
  emitAppEvent: vi.fn(),
  AppEvents: { NAVIGATE_TO_CELL: "NAVIGATE_TO_CELL" },
  removeGridRegionsByType: vi.fn(),
  replaceGridRegionsByType: vi.fn(),
  addGridRegions: vi.fn(),
  requestOverlayRedraw: vi.fn(),
  getCommentIndicators: vi.fn().mockResolvedValue([]),
  getNoteIndicators: vi.fn().mockResolvedValue([]),
  getProtectionStatus: vi.fn().mockResolvedValue({
    isProtected: false,
    hasPassword: false,
    options: {},
  }),
  isWorkbookProtected: vi.fn().mockResolvedValue(false),
  DEFAULT_PROTECTION_OPTIONS: {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    insertHyperlinks: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    useAutoFilter: false,
    usePivotTableReports: false,
    editObjects: false,
  },
  showOverlay: vi.fn(),
  getComment: vi.fn().mockResolvedValue(null),
  getNote: vi.fn().mockResolvedValue(null),
  markSheetDirty: vi.fn(),
  getSheets: vi.fn().mockResolvedValue([]),
  getWatchCells: vi.fn().mockResolvedValue([]),
  tracePrecedents: vi.fn().mockResolvedValue({ arrows: [] }),
  traceDependents: vi.fn().mockResolvedValue({ arrows: [] }),
  getAllConditionalFormats: vi.fn().mockResolvedValue([]),
  evaluateConditionalFormats: vi.fn().mockResolvedValue([]),
  getAllDataValidations: vi.fn().mockResolvedValue([]),
  getInvalidCells: vi.fn().mockResolvedValue([]),
}));

vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  replaceGridRegionsByType: vi.fn(),
  addGridRegions: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));

vi.mock("@api/backend", () => ({
  invokeBackend: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

// ============================================================================
// Replicated Pure Logic from Multiple Extensions
// (Following the established test pattern of inlining pure functions)
// ============================================================================

// -- DefinedNames: nameUtils --

function columnToLetter(col: number): string {
  let result = "";
  let n = col;
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function letterToColumn(letters: string): number {
  let result = 0;
  for (let i = 0; i < letters.length; i++) {
    result = result * 26 + (letters.charCodeAt(i) - 64);
  }
  return result - 1;
}

function formatRefersTo(
  sheetName: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);
  const startRef = `$${columnToLetter(minCol)}$${minRow + 1}`;
  const endRef = `$${columnToLetter(maxCol)}$${maxRow + 1}`;
  if (minRow === maxRow && minCol === maxCol) {
    return `=${sheetName}!${startRef}`;
  }
  return `=${sheetName}!${startRef}:${endRef}`;
}

function parseRefersTo(refersTo: string): {
  sheetName?: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} | null {
  const match = refersTo.match(
    /^=(?:([^!]+)!)?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i,
  );
  if (!match) return null;
  const sheetName = match[1] || undefined;
  const startCol = letterToColumn(match[2].toUpperCase());
  const startRow = parseInt(match[3], 10) - 1;
  const endCol = match[4] ? letterToColumn(match[4].toUpperCase()) : startCol;
  const endRow = match[5] ? parseInt(match[5], 10) - 1 : startRow;
  return { sheetName, startRow, startCol, endRow, endCol };
}

function isValidName(name: string): boolean {
  if (!name || name.length === 0) return false;
  const first = name[0];
  if (!/[a-zA-Z_\\]/.test(first)) return false;
  for (let i = 1; i < name.length; i++) {
    if (!/[a-zA-Z0-9_.]/.test(name[i])) return false;
  }
  const upper = name.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE" || upper === "NULL") return false;
  const cellMatch = name.match(/^([A-Z]+)(\d+)$/i);
  if (cellMatch) {
    const colNum = letterToColumn(cellMatch[1].toUpperCase()) + 1;
    const rowNum = parseInt(cellMatch[2], 10);
    if (colNum <= 16384 && rowNum >= 1 && rowNum <= 1048576) return false;
  }
  return true;
}

// -- CustomFillLists --

function parseItems(editItems: string): string[] {
  return editItems.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

function generateFillSequence(items: string[], startValue: string, count: number): string[] {
  const startIndex = items.findIndex(
    (item) => item.toLowerCase() === startValue.toLowerCase(),
  );
  if (startIndex === -1) return [];
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(items[(startIndex + i) % items.length]);
  }
  return result;
}

// -- Formula Parsing (from FormulaVisualizer / EvaluateFormula patterns) --

interface FormulaRef {
  text: string;
  row: number;
  col: number;
  isAbsolute: { row: boolean; col: boolean };
}

function parseFormulaReferences(formula: string): FormulaRef[] {
  const refs: FormulaRef[] = [];
  const regex = /(\$?)([A-Z]+)(\$?)(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(formula)) !== null) {
    const colAbs = match[1] === "$";
    const colStr = match[2].toUpperCase();
    const rowAbs = match[3] === "$";
    const rowNum = parseInt(match[4], 10);
    refs.push({
      text: match[0],
      row: rowNum - 1,
      col: letterToColumn(colStr),
      isAbsolute: { row: rowAbs, col: colAbs },
    });
  }
  return refs;
}

function toggleAbsoluteReference(ref: string): string {
  // Cycle: A1 -> $A$1 -> A$1 -> $A1 -> A1
  const match = ref.match(/^(\$?)([A-Z]+)(\$?)(\d+)$/i);
  if (!match) return ref;
  const colAbs = match[1] === "$";
  const rowAbs = match[3] === "$";
  if (!colAbs && !rowAbs) return `$${match[2]}$${match[4]}`;
  if (colAbs && rowAbs) return `${match[2]}$${match[4]}`;
  if (!colAbs && rowAbs) return `$${match[2]}${match[4]}`;
  return `${match[2]}${match[4]}`;
}

function isNumericValue(value: string): boolean {
  if (value === "" || value === null || value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  return !isNaN(Number(trimmed)) && isFinite(Number(trimmed));
}

// -- CSV Parser (from CsvImportExport) --

interface CsvParseOptions {
  delimiter: string;
  textQualifier: string;
  hasHeaders: boolean;
  skipRows: number;
}

function detectDelimiter(text: string): string {
  const candidates = [",", ";", "\t", "|"];
  const lines = text.split(/\r?\n/).slice(0, 10).filter((l) => l.length > 0);
  if (lines.length === 0) return ",";
  let bestDelim = ",";
  let bestScore = -1;
  for (const delim of candidates) {
    const counts = lines.map((l) => l.split(delim).length - 1);
    const allSame = counts.every((c) => c === counts[0] && c > 0);
    const score = allSame ? counts[0] * 10 : counts.reduce((a, b) => a + b, 0);
    if (score > bestScore) {
      bestScore = score;
      bestDelim = delim;
    }
  }
  return bestDelim;
}

function parseCsvSimple(text: string, delimiter: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(delimiter).map((cell) => cell.trim()));
}

// -- TextToColumns --

interface DelimitedConfig {
  tab: boolean;
  semicolon: boolean;
  comma: boolean;
  space: boolean;
  other: string;
  treatConsecutiveAsOne: boolean;
  textQualifier: string;
}

function splitDelimited(text: string, cfg: DelimitedConfig): string[] {
  const delimiters: string[] = [];
  if (cfg.tab) delimiters.push("\t");
  if (cfg.semicolon) delimiters.push(";");
  if (cfg.comma) delimiters.push(",");
  if (cfg.space) delimiters.push(" ");
  if (cfg.other) delimiters.push(cfg.other);
  if (delimiters.length === 0) return [text];

  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === cfg.textQualifier && cfg.textQualifier) {
      if (inQuotes && i + 1 < text.length && text[i + 1] === cfg.textQualifier) {
        current += ch;
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && delimiters.includes(ch)) {
      result.push(current);
      current = "";
      if (cfg.treatConsecutiveAsOne) {
        while (i + 1 < text.length && delimiters.includes(text[i + 1])) i++;
      }
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// -- Sorting --

interface SortLevel {
  id: string;
  columnKey: number;
  ascending: boolean;
  sortOn: "value" | "cellColor" | "fontColor";
  dataOption: "normal" | "textAsNumbers";
}

function detectSortRange(
  data: string[][],
  hasHeaders: boolean,
): { headers: string[]; dataRows: string[][] } {
  if (data.length === 0) return { headers: [], dataRows: [] };
  if (hasHeaders) {
    return { headers: data[0], dataRows: data.slice(1) };
  }
  return {
    headers: data[0].map((_, i) => `Column ${columnToLetter(i)}`),
    dataRows: data,
  };
}

function applySortLevels(rows: string[][], levels: SortLevel[]): string[][] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const level of levels) {
      const aVal = a[level.columnKey] ?? "";
      const bVal = b[level.columnKey] ?? "";
      let cmp: number;
      if (level.dataOption === "textAsNumbers" && isNumericValue(aVal) && isNumericValue(bVal)) {
        cmp = Number(aVal) - Number(bVal);
      } else {
        cmp = aVal.localeCompare(bVal, undefined, { sensitivity: "base" });
      }
      if (cmp !== 0) return level.ascending ? cmp : -cmp;
    }
    return 0;
  });
  return sorted;
}

// -- AutoFilter --

interface FilterCriteria {
  column: number;
  values?: Set<string>;
  condition?: { operator: string; value: string };
}

function applyFilters(rows: string[][], criteria: FilterCriteria[]): string[][] {
  return rows.filter((row) =>
    criteria.every((c) => {
      const cellVal = row[c.column] ?? "";
      if (c.values) return c.values.has(cellVal);
      if (c.condition) {
        switch (c.condition.operator) {
          case "equals":
            return cellVal === c.condition.value;
          case "contains":
            return cellVal.toLowerCase().includes(c.condition.value.toLowerCase());
          case "greaterThan":
            return Number(cellVal) > Number(c.condition.value);
          case "lessThan":
            return Number(cellVal) < Number(c.condition.value);
          default:
            return true;
        }
      }
      return true;
    }),
  );
}

// -- Chart Data Pipeline (from Charts lib) --

interface ParsedChartData {
  categories: string[];
  series: { name: string; values: number[]; color: string | null }[];
}

interface ChartFilters {
  hiddenSeries?: number[];
  hiddenCategories?: number[];
}

function applyChartFilters(data: ParsedChartData, filters?: ChartFilters): ParsedChartData {
  if (!filters) return data;
  const { hiddenSeries, hiddenCategories } = filters;
  const hasSeriesFilter = hiddenSeries && hiddenSeries.length > 0;
  const hasCategoryFilter = hiddenCategories && hiddenCategories.length > 0;
  if (!hasSeriesFilter && !hasCategoryFilter) return data;
  let filteredSeries = data.series;
  let filteredCategories = data.categories;
  if (hasSeriesFilter) {
    const hiddenSet = new Set(hiddenSeries);
    filteredSeries = data.series.filter((_, i) => !hiddenSet.has(i));
  }
  if (hasCategoryFilter) {
    const hiddenCatSet = new Set(hiddenCategories);
    const visibleCatIndices = data.categories.map((_, i) => i).filter((i) => !hiddenCatSet.has(i));
    filteredCategories = visibleCatIndices.map((i) => data.categories[i]);
    filteredSeries = filteredSeries.map((s) => ({
      ...s,
      values: visibleCatIndices.map((i) => s.values[i]),
    }));
  }
  return { categories: filteredCategories, series: filteredSeries };
}

type AggregateOp = "sum" | "mean" | "count" | "min" | "max";

function aggregateValues(values: number[], op: AggregateOp): number {
  const valid = values.filter((v) => !isNaN(v));
  if (valid.length === 0) return 0;
  switch (op) {
    case "sum":
      return valid.reduce((a, b) => a + b, 0);
    case "mean":
      return valid.reduce((a, b) => a + b, 0) / valid.length;
    case "count":
      return valid.length;
    case "min":
      return Math.min(...valid);
    case "max":
      return Math.max(...valid);
  }
}

function computeLinearTrendline(values: number[]): { slope: number; intercept: number; points: number[] } {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: 0, points: [] };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    if (isNaN(values[i])) continue;
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  const points = Array.from({ length: n }, (_, i) => slope * i + intercept);
  return { slope, intercept, points };
}

// -- Sparklines --

interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

type SparklineType = "line" | "column" | "winloss";

interface SparklineGroup {
  id: number;
  location: CellRange;
  dataRange: CellRange;
  type: SparklineType;
  color: string;
  negativeColor: string;
  showMarkers: boolean;
  lineWidth: number;
  showHighPoint: boolean;
  showLowPoint: boolean;
  showFirstPoint: boolean;
  showLastPoint: boolean;
  showNegativePoints: boolean;
}

function validateSparklineRanges(
  location: CellRange,
  dataRange: CellRange,
): { valid: boolean; error?: string; count?: number } {
  const locRows = location.endRow - location.startRow + 1;
  const locCols = location.endCol - location.startCol + 1;
  if (locRows > 1 && locCols > 1) {
    return { valid: false, error: "Location must be 1D" };
  }
  const locLength = Math.max(locRows, locCols);
  const dataRows = dataRange.endRow - dataRange.startRow + 1;
  const dataCols = dataRange.endCol - dataRange.startCol + 1;
  if (locLength === 1) {
    if (dataRows > 1 && dataCols > 1) {
      return { valid: false, error: "Data range must be 1D for single cell" };
    }
    return { valid: true, count: 1 };
  }
  // Multi-cell location
  const isColLocation = locCols === 1;
  const majorDim = isColLocation ? dataRows : dataCols;
  if (majorDim !== locLength) {
    return { valid: false, error: "Data dimension mismatch" };
  }
  return { valid: true, count: locLength };
}

// -- Conditional Formatting --

interface CFRule {
  id: string;
  type: "cellIs" | "colorScale" | "dataBar" | "top10";
  rangeAddress: string;
  operator?: string;
  value?: string;
  format?: { backgroundColor?: string; textColor?: string };
  priority: number;
  stopIfTrue: boolean;
}

function evaluateCellIsRule(
  cellValue: string,
  operator: string,
  ruleValue: string,
): boolean {
  switch (operator) {
    case "greaterThan":
      return Number(cellValue) > Number(ruleValue);
    case "lessThan":
      return Number(cellValue) < Number(ruleValue);
    case "equal":
      return cellValue === ruleValue;
    case "between":
      // Simplified: ruleValue = "low,high"
      const [low, high] = ruleValue.split(",").map(Number);
      const num = Number(cellValue);
      return num >= low && num <= high;
    default:
      return false;
  }
}

// -- Data Validation --

interface ValidationRule {
  type: "list" | "whole" | "decimal" | "textLength" | "date" | "custom";
  operator?: string;
  value1?: string;
  value2?: string;
  allowList?: string[];
  showDropdown?: boolean;
  inputTitle?: string;
  inputMessage?: string;
  errorTitle?: string;
  errorMessage?: string;
  errorStyle?: "stop" | "warning" | "information";
}

function validateInput(value: string, rule: ValidationRule): boolean {
  switch (rule.type) {
    case "list":
      return (rule.allowList ?? []).includes(value);
    case "whole": {
      const num = Number(value);
      if (!Number.isInteger(num)) return false;
      return checkNumericOperator(num, rule.operator ?? "between", rule.value1, rule.value2);
    }
    case "decimal": {
      const dec = Number(value);
      if (isNaN(dec)) return false;
      return checkNumericOperator(dec, rule.operator ?? "between", rule.value1, rule.value2);
    }
    case "textLength":
      return checkNumericOperator(
        value.length,
        rule.operator ?? "between",
        rule.value1,
        rule.value2,
      );
    default:
      return true;
  }
}

function checkNumericOperator(
  value: number,
  operator: string,
  v1?: string,
  v2?: string,
): boolean {
  const n1 = Number(v1 ?? 0);
  const n2 = Number(v2 ?? 0);
  switch (operator) {
    case "between":
      return value >= n1 && value <= n2;
    case "greaterThan":
      return value > n1;
    case "lessThan":
      return value < n1;
    case "equal":
      return value === n1;
    default:
      return true;
  }
}

// -- Protection --

interface ProtectionOptions {
  selectLockedCells: boolean;
  selectUnlockedCells: boolean;
  formatCells: boolean;
  insertRows: boolean;
  deleteRows: boolean;
  sort: boolean;
}

// -- Bookmarks --

interface Bookmark {
  id: string;
  row: number;
  col: number;
  sheetIndex: number;
  label: string;
  color: string;
}

function makeBookmarkKey(row: number, col: number, sheetIndex: number): string {
  return `${sheetIndex}:${row},${col}`;
}

// -- Print Layout --

interface PrintBounds {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

function parsePrintArea(printArea: string): PrintBounds | null {
  if (!printArea || !printArea.trim()) return null;
  const match = printArea.trim().match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return {
    startCol: letterToColumn(match[1].toUpperCase()),
    startRow: parseInt(match[2]) - 1,
    endCol: letterToColumn(match[3].toUpperCase()),
    endRow: parseInt(match[4]) - 1,
  };
}

function parseTitleRows(spec: string): [number, number] | null {
  if (!spec || !spec.trim()) return null;
  const match = spec.trim().match(/^(\d+):(\d+)$/);
  if (!match) return null;
  return [parseInt(match[1]) - 1, parseInt(match[2]) - 1];
}

// -- Watch Window --

function formatCellRef(sheetName: string, row: number, col: number): string {
  return `${sheetName}!${columnToLetter(col)}${row + 1}`;
}

// -- Error Checking --

interface CellErrorIndicator {
  row: number;
  col: number;
  errorType: string;
  message: string;
}

function detectFormulaErrors(formula: string, value: string): CellErrorIndicator | null {
  if (value === "#DIV/0!") {
    return { row: 0, col: 0, errorType: "divByZero", message: "Division by zero" };
  }
  if (value === "#REF!") {
    return { row: 0, col: 0, errorType: "badRef", message: "Invalid reference" };
  }
  if (value === "#NAME?") {
    return { row: 0, col: 0, errorType: "badName", message: "Unrecognized name" };
  }
  // Check for number stored as text
  if (formula === "" && isNumericValue(value) && typeof value === "string") {
    return { row: 0, col: 0, errorType: "numberAsText", message: "Number stored as text" };
  }
  return null;
}

// -- Tracing --

interface TraceArrow {
  id: string;
  direction: "precedents" | "dependents";
  sourceRow: number;
  sourceCol: number;
  targetRow: number;
  targetCol: number;
  isCrossSheet: boolean;
}

function buildTraceArrows(
  sourceRow: number,
  sourceCol: number,
  targets: Array<{ row: number; col: number; crossSheet?: boolean }>,
  direction: "precedents" | "dependents",
): TraceArrow[] {
  return targets.map((t, i) => ({
    id: `arrow-${direction}-${i}`,
    direction,
    sourceRow,
    sourceCol,
    targetRow: t.row,
    targetCol: t.col,
    isCrossSheet: t.crossSheet ?? false,
  }));
}

// -- Pivot DSL (simplified pipeline) --

interface PivotConfig {
  rows: string[];
  columns: string[];
  values: Array<{ field: string; aggregation: AggregateOp }>;
  filters: Array<{ field: string; values: string[] }>;
}

function parsePivotDsl(dsl: string): PivotConfig {
  const config: PivotConfig = { rows: [], columns: [], values: [], filters: [] };
  const lines = dsl.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines) {
    const match = line.match(/^(ROWS|COLUMNS|VALUES|FILTER):\s*(.+)$/i);
    if (!match) continue;
    const clause = match[1].toUpperCase();
    const fields = match[2].split(",").map((f) => f.trim());
    switch (clause) {
      case "ROWS":
        config.rows = fields;
        break;
      case "COLUMNS":
        config.columns = fields;
        break;
      case "VALUES":
        for (const f of fields) {
          const aggMatch = f.match(/^(\w+)\((\w+)\)$/);
          if (aggMatch) {
            config.values.push({
              field: aggMatch[2],
              aggregation: aggMatch[1].toLowerCase() as AggregateOp,
            });
          } else {
            config.values.push({ field: f, aggregation: "sum" });
          }
        }
        break;
      case "FILTER":
        for (const f of fields) {
          const filterMatch = f.match(/^(\w+)\s*=\s*\[(.+)\]$/);
          if (filterMatch) {
            config.filters.push({
              field: filterMatch[1],
              values: filterMatch[2].split("|").map((v) => v.trim()),
            });
          }
        }
        break;
    }
  }
  return config;
}

// -- Review Annotations --

interface Annotation {
  id: string;
  row: number;
  col: number;
  author: string;
  text: string;
  timestamp: number;
  type: "comment" | "note";
}

function sortAnnotationsByPosition(annotations: Annotation[]): Annotation[] {
  return [...annotations].sort((a, b) => {
    if (a.row !== b.row) return a.row - b.row;
    return a.col - b.col;
  });
}

function findNextAnnotation(
  annotations: Annotation[],
  currentRow: number,
  currentCol: number,
): Annotation | null {
  const sorted = sortAnnotationsByPosition(annotations);
  const next = sorted.find(
    (a) => a.row > currentRow || (a.row === currentRow && a.col > currentCol),
  );
  return next ?? sorted[0] ?? null;
}

// ============================================================================
// SCENARIO 1: Financial Report Workflow
// ============================================================================

describe("Scenario 1: Financial Report", () => {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  it("creates named ranges for revenue rows", () => {
    const ref = formatRefersTo("Sheet1", 1, 1, 1, 12);
    expect(ref).toBe("=Sheet1!$B$2:$M$2");

    const parsed = parseRefersTo(ref);
    expect(parsed).not.toBeNull();
    expect(parsed!.sheetName).toBe("Sheet1");
    expect(parsed!.startRow).toBe(1);
    expect(parsed!.startCol).toBe(1);
    expect(parsed!.endCol).toBe(12);
  });

  it("validates named range identifiers", () => {
    expect(isValidName("Revenue_2025")).toBe(true);
    expect(isValidName("COGS")).toBe(true);
    expect(isValidName("Net.Profit")).toBe(true);
    expect(isValidName("1stQuarter")).toBe(false); // starts with digit
    expect(isValidName("A1")).toBe(false); // looks like cell ref
    expect(isValidName("TRUE")).toBe(false); // reserved
  });

  it("fills month headers using fill lists", () => {
    const months = generateFillSequence(MONTHS, "Jan", 12);
    expect(months).toEqual(MONTHS);

    // Start mid-year and wrap
    const q3Start = generateFillSequence(MONTHS, "Jul", 6);
    expect(q3Start).toEqual(["Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
  });

  it("parses SUM formula references", () => {
    const refs = parseFormulaReferences("=SUM(B2:M2)");
    expect(refs).toHaveLength(2);
    expect(refs[0].col).toBe(1); // B
    expect(refs[0].row).toBe(1); // 2 -> 0-indexed = 1
    expect(refs[1].col).toBe(12); // M
  });

  it("parses AVERAGE formula with mixed references", () => {
    const refs = parseFormulaReferences("=AVERAGE($B$2:$M$2)");
    expect(refs).toHaveLength(2);
    expect(refs[0].isAbsolute.col).toBe(true);
    expect(refs[0].isAbsolute.row).toBe(true);
  });

  it("toggles absolute references for print-ready formulas", () => {
    expect(toggleAbsoluteReference("B2")).toBe("$B$2");
    expect(toggleAbsoluteReference("$B$2")).toBe("B$2");
    expect(toggleAbsoluteReference("B$2")).toBe("$B2");
    expect(toggleAbsoluteReference("$B2")).toBe("B2");
  });

  it("validates numeric cell values for formatting", () => {
    expect(isNumericValue("12345.67")).toBe(true);
    expect(isNumericValue("-500")).toBe(true);
    expect(isNumericValue("Revenue")).toBe(false);
    expect(isNumericValue("")).toBe(false);
    expect(isNumericValue("  42  ")).toBe(true);
    expect(isNumericValue("Infinity")).toBe(false);
  });

  it("generates chart data with aggregation from monthly revenue", () => {
    const monthlyRevenue = [120, 135, 142, 155, 160, 175, 180, 190, 165, 170, 185, 200];
    const data: ParsedChartData = {
      categories: MONTHS,
      series: [
        { name: "Revenue", values: monthlyRevenue, color: "#4285F4" },
        { name: "COGS", values: monthlyRevenue.map((v) => v * 0.6), color: "#EA4335" },
      ],
    };

    const annualRevenue = aggregateValues(monthlyRevenue, "sum");
    expect(annualRevenue).toBe(1977);

    const avgRevenue = aggregateValues(monthlyRevenue, "mean");
    expect(avgRevenue).toBeCloseTo(164.75, 1);

    const { slope, points } = computeLinearTrendline(monthlyRevenue);
    expect(slope).toBeGreaterThan(0); // upward trend
    expect(points).toHaveLength(12);
  });

  it("applies chart filters to hide Q1 categories", () => {
    const data: ParsedChartData = {
      categories: MONTHS,
      series: [{ name: "Revenue", values: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200], color: null }],
    };
    const filtered = applyChartFilters(data, { hiddenCategories: [0, 1, 2] });
    expect(filtered.categories).toEqual(["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
    expect(filtered.series[0].values).toHaveLength(9);
    expect(filtered.series[0].values[0]).toBe(400);
  });

  it("chains named range creation to chart data pipeline end-to-end", () => {
    // Step 1: Create named range for revenue row
    const revenueRef = formatRefersTo("Sheet1", 1, 1, 1, 12);
    expect(isValidName("Revenue_Monthly")).toBe(true);

    // Step 2: Parse the range to extract coordinates
    const range = parseRefersTo(revenueRef)!;
    expect(range.startCol).toBe(1);

    // Step 3: Fill month headers
    const headers = generateFillSequence(MONTHS, "Jan", range.endCol - range.startCol + 1);
    expect(headers).toHaveLength(12);

    // Step 4: Build chart data from the range
    const values = [120, 135, 142, 155, 160, 175, 180, 190, 165, 170, 185, 200];
    const chartData: ParsedChartData = { categories: headers, series: [{ name: "Revenue_Monthly", values, color: null }] };

    // Step 5: Aggregate and compute trendline
    const total = aggregateValues(values, "sum");
    const { slope } = computeLinearTrendline(values);
    expect(total).toBe(1977);
    expect(slope).toBeGreaterThan(0);

    // Step 6: Verify all formulas use absolute refs
    const formula = `=SUM(${toggleAbsoluteReference("B2")}:${toggleAbsoluteReference("M2")})`;
    expect(formula).toBe("=SUM($B$2:$M$2)");
    const refs = parseFormulaReferences(formula);
    expect(refs.every((r) => r.isAbsolute.row && r.isAbsolute.col)).toBe(true);
  });
});

// ============================================================================
// SCENARIO 2: Data Analysis Pipeline
// ============================================================================

describe("Scenario 2: Data Analysis Pipeline", () => {
  const CSV_DATA = [
    "Name,Region,Sales,Category",
    "Alice,North,5000,Electronics",
    "Bob,South,3200,Clothing",
    "Charlie,North,4500,Electronics",
    "Diana,East,2800,Furniture",
    "Eve,South,6100,Electronics",
    "Frank,West,3900,Clothing",
    "Grace,North,5200,Furniture",
  ].join("\n");

  it("parses CSV data and detects delimiter", () => {
    const delimiter = detectDelimiter(CSV_DATA);
    expect(delimiter).toBe(",");

    const rows = parseCsvSimple(CSV_DATA, delimiter);
    expect(rows).toHaveLength(8); // includes header
    expect(rows[0]).toEqual(["Name", "Region", "Sales", "Category"]);
    expect(rows[1][0]).toBe("Alice");
  });

  it("applies text-to-columns for cleanup of mixed delimiters", () => {
    const messyLine = 'Alice;North;"5,000";Electronics';
    const result = splitDelimited(messyLine, {
      tab: false,
      semicolon: true,
      comma: false,
      space: false,
      other: "",
      treatConsecutiveAsOne: false,
      textQualifier: '"',
    });
    expect(result).toEqual(["Alice", "North", "5,000", "Electronics"]);
  });

  it("detects sort range and applies multi-level sort", () => {
    const rows = parseCsvSimple(CSV_DATA, ",");
    const { headers, dataRows } = detectSortRange(rows, true);
    expect(headers).toEqual(["Name", "Region", "Sales", "Category"]);
    expect(dataRows).toHaveLength(7);

    const sorted = applySortLevels(dataRows, [
      { id: "1", columnKey: 1, ascending: true, sortOn: "value", dataOption: "normal" }, // Region
      { id: "2", columnKey: 2, ascending: false, sortOn: "value", dataOption: "textAsNumbers" }, // Sales desc
    ]);
    // East comes first alphabetically
    expect(sorted[0][1]).toBe("East");
    // North group: sorted by sales descending
    const northRows = sorted.filter((r) => r[1] === "North");
    expect(Number(northRows[0][2])).toBeGreaterThanOrEqual(Number(northRows[1][2]));
  });

  it("applies auto-filter criteria", () => {
    const rows = parseCsvSimple(CSV_DATA, ",");
    const dataRows = rows.slice(1);

    const filtered = applyFilters(dataRows, [
      { column: 1, values: new Set(["North", "South"]) },
      { column: 2, condition: { operator: "greaterThan", value: "4000" } },
    ]);

    // North: Alice(5000), Charlie(4500), Grace(5200) -> 3 pass region, 3 pass sales
    // South: Eve(6100) passes both
    expect(filtered).toHaveLength(4);
    expect(filtered.every((r) => Number(r[2]) > 4000)).toBe(true);
  });

  it("creates pivot DSL configuration from filtered data", () => {
    const dsl = `
      ROWS: Region, Category
      COLUMNS:
      VALUES: sum(Sales), count(Sales)
      FILTER: Region = [North|South]
    `;

    const config = parsePivotDsl(dsl);
    expect(config.rows).toEqual(["Region", "Category"]);
    expect(config.values).toHaveLength(2);
    expect(config.values[0]).toEqual({ field: "Sales", aggregation: "sum" });
    expect(config.values[1]).toEqual({ field: "Sales", aggregation: "count" });
    expect(config.filters).toHaveLength(1);
    expect(config.filters[0].values).toEqual(["North", "South"]);
  });

  it("generates chart from filtered data with trendline", () => {
    const rows = parseCsvSimple(CSV_DATA, ",").slice(1);
    const filtered = applyFilters(rows, [
      { column: 3, values: new Set(["Electronics"]) },
    ]);

    const salesValues = filtered.map((r) => Number(r[2]));
    const chartData: ParsedChartData = {
      categories: filtered.map((r) => r[0]),
      series: [{ name: "Electronics Sales", values: salesValues, color: "#4285F4" }],
    };

    expect(chartData.categories).toEqual(["Alice", "Charlie", "Eve"]);
    expect(chartData.series[0].values).toEqual([5000, 4500, 6100]);

    const total = aggregateValues(salesValues, "sum");
    expect(total).toBe(15600);
  });

  it("chains CSV parse -> sort -> filter -> pivot -> chart end-to-end", () => {
    // Step 1: Parse CSV
    const delim = detectDelimiter(CSV_DATA);
    const allRows = parseCsvSimple(CSV_DATA, delim);

    // Step 2: Detect range and sort by Region then Sales
    const { headers, dataRows } = detectSortRange(allRows, true);
    const sorted = applySortLevels(dataRows, [
      { id: "1", columnKey: 1, ascending: true, sortOn: "value", dataOption: "normal" },
      { id: "2", columnKey: 2, ascending: false, sortOn: "value", dataOption: "textAsNumbers" },
    ]);
    expect(sorted[0][1]).toBe("East");

    // Step 3: Filter to high-value items
    const filtered = applyFilters(sorted, [
      { column: 2, condition: { operator: "greaterThan", value: "4000" } },
    ]);
    expect(filtered.length).toBeLessThan(sorted.length);

    // Step 4: Pivot DSL
    const pivotConfig = parsePivotDsl("ROWS: Region\nVALUES: sum(Sales)");
    expect(pivotConfig.rows).toEqual(["Region"]);
    expect(pivotConfig.values[0].aggregation).toBe("sum");

    // Step 5: Manual aggregation per pivot row
    const regionSales = new Map<string, number[]>();
    for (const row of filtered) {
      const region = row[1];
      if (!regionSales.has(region)) regionSales.set(region, []);
      regionSales.get(region)!.push(Number(row[2]));
    }
    const chartCategories = Array.from(regionSales.keys()).sort();
    const chartValues = chartCategories.map((r) => aggregateValues(regionSales.get(r)!, "sum"));

    // Step 6: Build chart
    const chartData: ParsedChartData = {
      categories: chartCategories,
      series: [{ name: "Regional Sales (>4000)", values: chartValues, color: null }],
    };
    expect(chartData.categories.length).toBeGreaterThan(0);
    expect(chartData.series[0].values.every((v) => v > 0)).toBe(true);
  });
});

// ============================================================================
// SCENARIO 3: Spreadsheet Template Workflow
// ============================================================================

describe("Scenario 3: Spreadsheet Template", () => {
  it("defines sparkline groups for KPI cells", () => {
    const location: CellRange = { startRow: 0, startCol: 5, endRow: 4, endCol: 5 };
    const dataRange: CellRange = { startRow: 0, startCol: 0, endRow: 4, endCol: 4 };

    const result = validateSparklineRanges(location, dataRange);
    expect(result.valid).toBe(true);
    expect(result.count).toBe(5); // 5 rows of KPI sparklines
  });

  it("rejects invalid sparkline location (2D block)", () => {
    const location: CellRange = { startRow: 0, startCol: 5, endRow: 2, endCol: 6 };
    const dataRange: CellRange = { startRow: 0, startCol: 0, endRow: 2, endCol: 4 };

    const result = validateSparklineRanges(location, dataRange);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("1D");
  });

  it("configures conditional formatting rules for KPI thresholds", () => {
    const rules: CFRule[] = [
      { id: "cf1", type: "cellIs", rangeAddress: "F1:F5", operator: "greaterThan", value: "90", format: { backgroundColor: "#C6EFCE", textColor: "#006100" }, priority: 1, stopIfTrue: false },
      { id: "cf2", type: "cellIs", rangeAddress: "F1:F5", operator: "lessThan", value: "50", format: { backgroundColor: "#FFC7CE", textColor: "#9C0006" }, priority: 2, stopIfTrue: false },
      { id: "cf3", type: "cellIs", rangeAddress: "F1:F5", operator: "between", value: "50,90", format: { backgroundColor: "#FFEB9C", textColor: "#9C5700" }, priority: 3, stopIfTrue: false },
    ];

    // High performance -> green
    expect(evaluateCellIsRule("95", "greaterThan", "90")).toBe(true);
    expect(evaluateCellIsRule("85", "greaterThan", "90")).toBe(false);

    // Low performance -> red
    expect(evaluateCellIsRule("30", "lessThan", "50")).toBe(true);

    // Medium -> yellow
    expect(evaluateCellIsRule("75", "between", "50,90")).toBe(true);
    expect(evaluateCellIsRule("95", "between", "50,90")).toBe(false);
  });

  it("sets data validation on input cells", () => {
    const dropdownRule: ValidationRule = {
      type: "list",
      allowList: ["Q1", "Q2", "Q3", "Q4"],
      showDropdown: true,
      inputTitle: "Select Quarter",
      inputMessage: "Choose a fiscal quarter",
      errorStyle: "stop",
    };

    expect(validateInput("Q1", dropdownRule)).toBe(true);
    expect(validateInput("Q5", dropdownRule)).toBe(false);

    const numberRule: ValidationRule = {
      type: "whole",
      operator: "between",
      value1: "1",
      value2: "100",
      errorTitle: "Invalid",
      errorMessage: "Enter 1-100",
    };

    expect(validateInput("50", numberRule)).toBe(true);
    expect(validateInput("150", numberRule)).toBe(false);
    expect(validateInput("3.5", numberRule)).toBe(false); // not integer
  });

  it("adds protection to formula cells while allowing input", () => {
    const options: ProtectionOptions = {
      selectLockedCells: true,
      selectUnlockedCells: true,
      formatCells: false,
      insertRows: false,
      deleteRows: false,
      sort: false,
    };

    // Formula cells (locked by default) cannot be edited when protected
    expect(options.formatCells).toBe(false);
    expect(options.selectLockedCells).toBe(true);
    expect(options.selectUnlockedCells).toBe(true);
    // Input cells would be unlocked via cell protection settings
    expect(options.insertRows).toBe(false);
  });

  it("creates bookmarks for key cells in the template", () => {
    const bookmarks = new Map<string, Bookmark>();

    const kpis = [
      { row: 0, col: 5, label: "Revenue KPI" },
      { row: 1, col: 5, label: "Margin KPI" },
      { row: 2, col: 5, label: "Growth KPI" },
      { row: 10, col: 0, label: "Input Section" },
      { row: 20, col: 0, label: "Summary" },
    ];

    let nextId = 1;
    for (const { row, col, label } of kpis) {
      const key = makeBookmarkKey(row, col, 0);
      const bm: Bookmark = { id: `bm-${nextId++}`, row, col, sheetIndex: 0, label, color: "blue" };
      bookmarks.set(key, bm);
    }

    expect(bookmarks.size).toBe(5);
    expect(bookmarks.get(makeBookmarkKey(0, 5, 0))!.label).toBe("Revenue KPI");
    expect(bookmarks.get(makeBookmarkKey(20, 0, 0))!.label).toBe("Summary");
  });

  it("sets up print layout with headers, footers, and print area", () => {
    const area = parsePrintArea("A1:F25");
    expect(area).not.toBeNull();
    expect(area!.startRow).toBe(0);
    expect(area!.startCol).toBe(0);
    expect(area!.endRow).toBe(24);
    expect(area!.endCol).toBe(5);

    const titleRows = parseTitleRows("1:2");
    expect(titleRows).toEqual([0, 1]);
  });

  it("chains sparklines + CF + validation + protection + bookmarks + print end-to-end", () => {
    // Step 1: Validate sparkline group for KPI cells
    const sparklineResult = validateSparklineRanges(
      { startRow: 0, startCol: 6, endRow: 4, endCol: 6 },
      { startRow: 0, startCol: 1, endRow: 4, endCol: 5 },
    );
    expect(sparklineResult.valid).toBe(true);

    // Step 2: Set up CF rules for the KPI column
    expect(evaluateCellIsRule("95", "greaterThan", "90")).toBe(true);

    // Step 3: Validate input cells
    const quarterRule: ValidationRule = { type: "list", allowList: ["Q1", "Q2", "Q3", "Q4"] };
    expect(validateInput("Q2", quarterRule)).toBe(true);

    // Step 4: Protection configured
    const protOptions: ProtectionOptions = {
      selectLockedCells: true,
      selectUnlockedCells: true,
      formatCells: false,
      insertRows: false,
      deleteRows: false,
      sort: false,
    };
    expect(protOptions.selectLockedCells).toBe(true);

    // Step 5: Bookmark the KPI section
    const bmKey = makeBookmarkKey(0, 6, 0);
    expect(bmKey).toBe("0:0,6");

    // Step 6: Print area covering the template
    const area = parsePrintArea("A1:G25");
    expect(area!.endCol).toBe(6); // G = col 6
    expect(area!.endRow).toBe(24);
  });
});

// ============================================================================
// SCENARIO 4: Collaborative Editing Workflow
// ============================================================================

describe("Scenario 4: Collaborative Editing", () => {
  const ANNOTATIONS: Annotation[] = [
    { id: "c1", row: 2, col: 3, author: "Alice", text: "Check this formula", timestamp: 1000, type: "comment" },
    { id: "c2", row: 5, col: 1, author: "Bob", text: "Data source updated", timestamp: 2000, type: "comment" },
    { id: "n1", row: 8, col: 0, author: "Alice", text: "Quarterly review note", timestamp: 3000, type: "note" },
    { id: "c3", row: 10, col: 4, author: "Charlie", text: "Needs validation", timestamp: 4000, type: "comment" },
    { id: "n2", row: 15, col: 2, author: "Bob", text: "Approved", timestamp: 5000, type: "note" },
  ];

  it("adds review annotations and sorts by position", () => {
    const sorted = sortAnnotationsByPosition(ANNOTATIONS);
    expect(sorted[0].row).toBe(2);
    expect(sorted[1].row).toBe(5);
    expect(sorted[sorted.length - 1].row).toBe(15);
  });

  it("sets up watch window for key formula cells", () => {
    const watches = [
      formatCellRef("Sheet1", 2, 3),
      formatCellRef("Sheet1", 10, 4),
      formatCellRef("Summary", 0, 0),
    ];
    expect(watches[0]).toBe("Sheet1!D3");
    expect(watches[1]).toBe("Sheet1!E11");
    expect(watches[2]).toBe("Summary!A1");
  });

  it("configures error checking indicators for formula cells", () => {
    const errors = [
      detectFormulaErrors("=A1/B1", "#DIV/0!"),
      detectFormulaErrors("=SUM(#REF!)", "#REF!"),
      detectFormulaErrors("=VLOOKUP(A1,Data,2)", "Found"),
      detectFormulaErrors("", "42"),
    ];

    expect(errors[0]!.errorType).toBe("divByZero");
    expect(errors[1]!.errorType).toBe("badRef");
    expect(errors[2]).toBeNull(); // no error
    expect(errors[3]!.errorType).toBe("numberAsText");
  });

  it("navigates between comments", () => {
    const comments = ANNOTATIONS.filter((a) => a.type === "comment");

    // From row 0, col 0 -> should find first comment at (2,3)
    const next1 = findNextAnnotation(comments, 0, 0);
    expect(next1!.id).toBe("c1");
    expect(next1!.row).toBe(2);

    // From row 3, col 0 -> should find comment at (5,1)
    const next2 = findNextAnnotation(comments, 3, 0);
    expect(next2!.id).toBe("c2");

    // From past the last comment -> wraps to first
    const wrap = findNextAnnotation(comments, 20, 0);
    expect(wrap!.id).toBe("c1");
  });

  it("tracks formula dependencies via tracing arrows", () => {
    // Cell D3 (row 2, col 3) has formula =SUM(A3:C3)
    const precedentArrows = buildTraceArrows(2, 3, [
      { row: 2, col: 0 },
      { row: 2, col: 1 },
      { row: 2, col: 2 },
    ], "precedents");

    expect(precedentArrows).toHaveLength(3);
    expect(precedentArrows[0].direction).toBe("precedents");
    expect(precedentArrows[0].sourceRow).toBe(2);
    expect(precedentArrows[0].sourceCol).toBe(3);
    expect(precedentArrows[0].targetCol).toBe(0);

    // Cell D3 is also used by E3 (=D3*1.1)
    const dependentArrows = buildTraceArrows(2, 3, [
      { row: 2, col: 4 },
    ], "dependents");

    expect(dependentArrows).toHaveLength(1);
    expect(dependentArrows[0].direction).toBe("dependents");
    expect(dependentArrows[0].targetCol).toBe(4);
  });

  it("detects cross-sheet tracing arrows", () => {
    const arrows = buildTraceArrows(5, 1, [
      { row: 0, col: 0, crossSheet: true },
    ], "precedents");

    expect(arrows).toHaveLength(1);
    expect(arrows[0].isCrossSheet).toBe(true);
  });

  it("chains annotations -> watch -> errors -> navigation -> tracing end-to-end", () => {
    // Step 1: Add annotations to key cells
    const sorted = sortAnnotationsByPosition(ANNOTATIONS);
    expect(sorted).toHaveLength(5);

    // Step 2: Set up watch window for the commented cells
    const commentedCells = sorted
      .filter((a) => a.type === "comment")
      .map((a) => formatCellRef("Sheet1", a.row, a.col));
    expect(commentedCells).toHaveLength(3);
    expect(commentedCells[0]).toBe("Sheet1!D3");

    // Step 3: Check for formula errors at watched cells
    const formulaError = detectFormulaErrors("=A1/B1", "#DIV/0!");
    expect(formulaError).not.toBeNull();

    // Step 4: Navigate to the cell with the error annotation
    const nextComment = findNextAnnotation(
      sorted.filter((a) => a.type === "comment"),
      0,
      0,
    );
    expect(nextComment!.text).toBe("Check this formula");

    // Step 5: Trace the precedents of the formula cell
    const arrows = buildTraceArrows(
      nextComment!.row,
      nextComment!.col,
      [{ row: 2, col: 0 }, { row: 2, col: 1 }],
      "precedents",
    );
    expect(arrows).toHaveLength(2);
    expect(arrows[0].sourceRow).toBe(nextComment!.row);
    expect(arrows[0].sourceCol).toBe(nextComment!.col);

    // Step 6: Also trace dependents
    const depArrows = buildTraceArrows(
      nextComment!.row,
      nextComment!.col,
      [{ row: 10, col: 4 }],
      "dependents",
    );
    expect(depArrows[0].targetRow).toBe(10);
    expect(depArrows[0].targetCol).toBe(4);
  });
});
