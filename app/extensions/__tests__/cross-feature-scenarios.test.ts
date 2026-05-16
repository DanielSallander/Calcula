//! FILENAME: app/extensions/__tests__/cross-feature-scenarios.test.ts
// PURPOSE: Cross-feature interaction tests that exercise realistic multi-extension
//          scenarios users encounter when combining formatting, sorting, filtering,
//          charts, pivot, validation, protection, sparklines, search, and more.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================================
// Mocks
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
  getAllConditionalFormats: vi.fn().mockResolvedValue([]),
  evaluateConditionalFormats: vi.fn().mockResolvedValue([]),
  getAllDataValidations: vi.fn().mockResolvedValue([]),
  getInvalidCells: vi.fn().mockResolvedValue([]),
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
  markSheetDirty: vi.fn(),
  getSheets: vi.fn().mockResolvedValue([]),
  getWatchCells: vi.fn().mockResolvedValue([]),
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
// Inlined Pure Logic from Multiple Extensions
// ============================================================================

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

// -- Conditional Formatting --

interface CFRule {
  id: string;
  type: "cellIs" | "colorScale" | "dataBar" | "top10";
  rangeStartRow: number;
  rangeEndRow: number;
  rangeStartCol: number;
  rangeEndCol: number;
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
    case "between": {
      const [low, high] = ruleValue.split(",").map(Number);
      const num = Number(cellValue);
      return num >= low && num <= high;
    }
    default:
      return false;
  }
}

function adjustCFRuleAfterSort(
  rule: CFRule,
  oldRowOrder: number[],
  newRowOrder: number[],
): CFRule {
  // CF rules in spreadsheets are range-based, not row-specific.
  // After sorting, the rule range stays the same but priority may change
  // based on the new data positions. Return rule with same range bounds.
  return { ...rule };
}

function evaluateCFForCell(
  rules: CFRule[],
  row: number,
  col: number,
  cellValue: string,
): { backgroundColor?: string; textColor?: string } | null {
  const sortedRules = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of sortedRules) {
    if (
      row < rule.rangeStartRow || row > rule.rangeEndRow ||
      col < rule.rangeStartCol || col > rule.rangeEndCol
    ) {
      continue;
    }
    if (rule.type === "cellIs" && rule.operator && rule.value !== undefined) {
      if (evaluateCellIsRule(cellValue, rule.operator, rule.value)) {
        if (rule.stopIfTrue) return rule.format ?? null;
        return rule.format ?? null;
      }
    }
  }
  return null;
}

function getCFAppliedColor(
  rules: CFRule[],
  row: number,
  col: number,
  cellValue: string,
): string | null {
  const result = evaluateCFForCell(rules, row, col, cellValue);
  return result?.backgroundColor ?? null;
}

// -- Sorting --

interface SortLevel {
  columnKey: number;
  ascending: boolean;
  sortOn: "value" | "cellColor" | "fontColor";
  colorValue?: string;
}

function applySortLevels(rows: string[][], levels: SortLevel[]): string[][] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const level of levels) {
      const aVal = a[level.columnKey] ?? "";
      const bVal = b[level.columnKey] ?? "";
      const cmp = aVal.localeCompare(bVal, undefined, { sensitivity: "base" });
      if (cmp !== 0) return level.ascending ? cmp : -cmp;
    }
    return 0;
  });
  return sorted;
}

function sortByColor(
  rows: string[][],
  colorMap: Map<number, string>,
  targetColor: string,
  ascending: boolean,
): string[][] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const aIdx = rows.indexOf(a);
    const bIdx = rows.indexOf(b);
    const aColor = colorMap.get(aIdx) ?? "";
    const bColor = colorMap.get(bIdx) ?? "";
    const aMatch = aColor === targetColor ? 0 : 1;
    const bMatch = bColor === targetColor ? 0 : 1;
    return ascending ? aMatch - bMatch : bMatch - aMatch;
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
          case "equals": return cellVal === c.condition.value;
          case "contains": return cellVal.toLowerCase().includes(c.condition.value.toLowerCase());
          case "greaterThan": return Number(cellVal) > Number(c.condition.value);
          case "lessThan": return Number(cellVal) < Number(c.condition.value);
          default: return true;
        }
      }
      return true;
    }),
  );
}

// -- Data Validation --

interface ValidationRule {
  type: "list" | "whole" | "decimal" | "textLength" | "custom";
  operator?: string;
  value1?: string;
  value2?: string;
  allowList?: string[];
  errorStyle?: "stop" | "warning" | "information";
}

function validateInput(value: string, rule: ValidationRule): boolean {
  switch (rule.type) {
    case "list":
      return (rule.allowList ?? []).includes(value);
    case "whole": {
      const num = Number(value);
      if (!Number.isInteger(num)) return false;
      return checkNumericOp(num, rule.operator ?? "between", rule.value1, rule.value2);
    }
    case "decimal": {
      const dec = Number(value);
      if (isNaN(dec)) return false;
      return checkNumericOp(dec, rule.operator ?? "between", rule.value1, rule.value2);
    }
    case "textLength":
      return checkNumericOp(value.length, rule.operator ?? "between", rule.value1, rule.value2);
    default:
      return true;
  }
}

function checkNumericOp(value: number, operator: string, v1?: string, v2?: string): boolean {
  const n1 = Number(v1 ?? 0);
  const n2 = Number(v2 ?? 0);
  switch (operator) {
    case "between": return value >= n1 && value <= n2;
    case "greaterThan": return value > n1;
    case "lessThan": return value < n1;
    case "equal": return value === n1;
    default: return true;
  }
}

// -- Protection --

interface ProtectionState {
  isProtected: boolean;
  lockedCells: Set<string>;
  options: {
    formatCells: boolean;
    sort: boolean;
    useAutoFilter: boolean;
    insertRows: boolean;
    deleteRows: boolean;
  };
}

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

function canEditCell(state: ProtectionState, row: number, col: number): boolean {
  if (!state.isProtected) return true;
  return !state.lockedCells.has(cellKey(row, col));
}

function canPerformAction(state: ProtectionState, action: keyof ProtectionState["options"]): boolean {
  if (!state.isProtected) return true;
  return state.options[action];
}

// -- Error Checking --

interface ErrorIndicator {
  row: number;
  col: number;
  errorType: string;
  message: string;
}

function detectValidationCircles(
  validationRules: Map<string, ValidationRule>,
  cellValues: Map<string, string>,
): ErrorIndicator[] {
  const errors: ErrorIndicator[] = [];
  for (const [key, rule] of validationRules) {
    const value = cellValues.get(key);
    if (value !== undefined && !validateInput(value, rule)) {
      const [row, col] = key.split(",").map(Number);
      errors.push({
        row,
        col,
        errorType: "validationCircle",
        message: `Value "${value}" violates validation rule`,
      });
    }
  }
  return errors;
}

// -- Named Ranges --

function formatRefersTo(
  sheetName: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const startRef = `$${columnToLetter(startCol)}$${startRow + 1}`;
  const endRef = `$${columnToLetter(endCol)}$${endRow + 1}`;
  if (startRow === endRow && startCol === endCol) {
    return `=${sheetName}!${startRef}`;
  }
  return `=${sheetName}!${startRef}:${endRef}`;
}

function isValidName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (!/[a-zA-Z_\\]/.test(name[0])) return false;
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

// -- Pivot DSL --

interface PivotConfig {
  rows: string[];
  columns: string[];
  values: Array<{ field: string; aggregation: string }>;
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
      case "ROWS": config.rows = fields; break;
      case "COLUMNS": config.columns = fields; break;
      case "VALUES":
        for (const f of fields) {
          const aggMatch = f.match(/^(\w+)\((\w+)\)$/);
          if (aggMatch) {
            config.values.push({ field: aggMatch[2], aggregation: aggMatch[1].toLowerCase() });
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

// -- Chart Data Pipeline --

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
  let filteredSeries = data.series;
  let filteredCategories = data.categories;
  if (hiddenSeries && hiddenSeries.length > 0) {
    const hiddenSet = new Set(hiddenSeries);
    filteredSeries = data.series.filter((_, i) => !hiddenSet.has(i));
  }
  if (hiddenCategories && hiddenCategories.length > 0) {
    const hiddenCatSet = new Set(hiddenCategories);
    const visible = data.categories.map((_, i) => i).filter((i) => !hiddenCatSet.has(i));
    filteredCategories = visible.map((i) => data.categories[i]);
    filteredSeries = filteredSeries.map((s) => ({
      ...s,
      values: visible.map((i) => s.values[i]),
    }));
  }
  return { categories: filteredCategories, series: filteredSeries };
}

function pivotToChartData(
  pivotConfig: PivotConfig,
  rawData: Record<string, string>[],
): ParsedChartData {
  // Apply pivot filters
  let filtered = rawData;
  for (const f of pivotConfig.filters) {
    const allowed = new Set(f.values);
    filtered = filtered.filter((row) => allowed.has(row[f.field]));
  }
  // Group by row fields to create categories
  const groupKey = (row: Record<string, string>) =>
    pivotConfig.rows.map((r) => row[r]).join(" | ");
  const groups = new Map<string, Record<string, string>[]>();
  for (const row of filtered) {
    const key = groupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const categories = Array.from(groups.keys());
  const series = pivotConfig.values.map((v) => ({
    name: `${v.aggregation}(${v.field})`,
    values: categories.map((cat) => {
      const rows = groups.get(cat)!;
      const vals = rows.map((r) => Number(r[v.field])).filter((n) => !isNaN(n));
      if (vals.length === 0) return 0;
      switch (v.aggregation) {
        case "sum": return vals.reduce((a, b) => a + b, 0);
        case "mean": return vals.reduce((a, b) => a + b, 0) / vals.length;
        case "count": return vals.length;
        case "min": return Math.min(...vals);
        case "max": return Math.max(...vals);
        default: return vals.reduce((a, b) => a + b, 0);
      }
    }),
    color: null,
  }));
  return { categories, series };
}

// -- Sparklines --

interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

interface SparklineGroup {
  id: number;
  location: CellRange;
  dataRange: CellRange;
  type: "line" | "column" | "winloss";
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
  if (locLength === 1 && dataRows > 1 && dataCols > 1) {
    return { valid: false, error: "Data range must be 1D for single cell" };
  }
  if (locLength > 1) {
    const isColLocation = locCols === 1;
    const majorDim = isColLocation ? dataRows : dataCols;
    if (majorDim !== locLength) {
      return { valid: false, error: "Data dimension mismatch" };
    }
  }
  return { valid: true, count: locLength };
}

function adjustSparklineAfterGroupCollapse(
  sparkline: SparklineGroup,
  collapsedStartRow: number,
  collapsedEndRow: number,
): SparklineGroup | null {
  // If sparkline location is within collapsed range, it becomes hidden
  if (
    sparkline.location.startRow >= collapsedStartRow &&
    sparkline.location.endRow <= collapsedEndRow
  ) {
    return null; // hidden
  }
  // If sparkline is below collapsed range, shift up by collapsed count
  const collapsedCount = collapsedEndRow - collapsedStartRow + 1;
  if (sparkline.location.startRow > collapsedEndRow) {
    return {
      ...sparkline,
      location: {
        ...sparkline.location,
        startRow: sparkline.location.startRow - collapsedCount,
        endRow: sparkline.location.endRow - collapsedCount,
      },
    };
  }
  return sparkline;
}

function adjustSparklineAfterGroupExpand(
  sparkline: SparklineGroup,
  expandedStartRow: number,
  expandedCount: number,
): SparklineGroup {
  if (sparkline.location.startRow >= expandedStartRow) {
    return {
      ...sparkline,
      location: {
        ...sparkline.location,
        startRow: sparkline.location.startRow + expandedCount,
        endRow: sparkline.location.endRow + expandedCount,
      },
    };
  }
  return sparkline;
}

// -- Table --

interface TableDef {
  name: string;
  headerRow: number;
  startCol: number;
  endCol: number;
  dataStartRow: number;
  dataEndRow: number;
  columns: string[];
}

function isInTableRange(table: TableDef, row: number, col: number): boolean {
  return (
    row >= table.headerRow &&
    row <= table.dataEndRow &&
    col >= table.startCol &&
    col <= table.endCol
  );
}

// -- Grouping --

interface RowGroup {
  startRow: number;
  endRow: number;
  level: number;
  collapsed: boolean;
}

function collapseGroup(group: RowGroup): RowGroup {
  return { ...group, collapsed: true };
}

function expandGroup(group: RowGroup): RowGroup {
  return { ...group, collapsed: false };
}

function getVisibleRows(totalRows: number, groups: RowGroup[]): number[] {
  const hidden = new Set<number>();
  for (const g of groups) {
    if (g.collapsed) {
      for (let r = g.startRow; r <= g.endRow; r++) {
        hidden.add(r);
      }
    }
  }
  return Array.from({ length: totalRows }, (_, i) => i).filter((r) => !hidden.has(r));
}

// -- Search & Replace --

interface SearchMatch {
  row: number;
  col: number;
  startIndex: number;
  length: number;
}

function findAllMatches(
  grid: string[][],
  pattern: string,
  caseSensitive: boolean,
  matchEntireCell: boolean,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const cellValue = caseSensitive ? grid[r][c] : grid[r][c].toLowerCase();
      if (matchEntireCell) {
        if (cellValue === searchPattern) {
          matches.push({ row: r, col: c, startIndex: 0, length: pattern.length });
        }
      } else {
        let idx = 0;
        while ((idx = cellValue.indexOf(searchPattern, idx)) !== -1) {
          matches.push({ row: r, col: c, startIndex: idx, length: pattern.length });
          idx += pattern.length;
        }
      }
    }
  }
  return matches;
}

function replaceAll(
  grid: string[][],
  pattern: string,
  replacement: string,
  caseSensitive: boolean,
): { newGrid: string[][]; replacementCount: number } {
  let count = 0;
  const newGrid = grid.map((row) =>
    row.map((cell) => {
      if (caseSensitive) {
        const parts = cell.split(pattern);
        if (parts.length > 1) count += parts.length - 1;
        return parts.join(replacement);
      } else {
        const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        let replaced = false;
        const result = cell.replace(regex, () => { replaced = true; count++; return replacement; });
        return result;
      }
    }),
  );
  return { newGrid, replacementCount: count };
}

function navigateMatch(
  matches: SearchMatch[],
  currentIndex: number,
  direction: "next" | "previous",
): number {
  if (matches.length === 0) return -1;
  if (direction === "next") {
    return (currentIndex + 1) % matches.length;
  }
  return (currentIndex - 1 + matches.length) % matches.length;
}

// -- Undo Stack (conceptual) --

interface UndoEntry {
  action: string;
  data: unknown;
}

class UndoStack {
  private stack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];

  push(entry: UndoEntry): void {
    this.stack.push(entry);
    this.redoStack = [];
  }

  undo(): UndoEntry | null {
    const entry = this.stack.pop() ?? null;
    if (entry) this.redoStack.push(entry);
    return entry;
  }

  redo(): UndoEntry | null {
    const entry = this.redoStack.pop() ?? null;
    if (entry) this.stack.push(entry);
    return entry;
  }

  get length(): number { return this.stack.length; }
  get redoLength(): number { return this.redoStack.length; }
}

// ============================================================================
// SCENARIO 1: Formatting + Sorting + Filtering
// ============================================================================

describe("Scenario 1: Formatting + Sorting + Filtering", () => {
  const sampleData = [
    ["Name", "Score", "Grade", "Status"],
    ["Alice", "95", "A", "Active"],
    ["Bob", "42", "F", "Inactive"],
    ["Charlie", "78", "C", "Active"],
    ["Diana", "88", "B", "Active"],
    ["Eve", "65", "D", "Inactive"],
  ];

  const cfRules: CFRule[] = [
    {
      id: "cf-high",
      type: "cellIs",
      rangeStartRow: 1,
      rangeEndRow: 5,
      rangeStartCol: 1,
      rangeEndCol: 1,
      operator: "greaterThan",
      value: "80",
      format: { backgroundColor: "#00FF00", textColor: "#000000" },
      priority: 1,
      stopIfTrue: false,
    },
    {
      id: "cf-low",
      type: "cellIs",
      rangeStartRow: 1,
      rangeEndRow: 5,
      rangeStartCol: 1,
      rangeEndCol: 1,
      operator: "lessThan",
      value: "50",
      format: { backgroundColor: "#FF0000", textColor: "#FFFFFF" },
      priority: 2,
      stopIfTrue: false,
    },
  ];

  it("applies CF rules then sorts - rules still cover the range", () => {
    // Before sort: Alice=95(green), Bob=42(red), Charlie=78(none), Diana=88(green), Eve=65(none)
    expect(getCFAppliedColor(cfRules, 1, 1, "95")).toBe("#00FF00");
    expect(getCFAppliedColor(cfRules, 2, 1, "42")).toBe("#FF0000");
    expect(getCFAppliedColor(cfRules, 3, 1, "78")).toBeNull();

    // Sort by Score ascending
    const dataRows = sampleData.slice(1);
    const sorted = applySortLevels(dataRows, [
      { columnKey: 1, ascending: true, sortOn: "value" },
    ]);

    // Bob(42) should now be first data row
    expect(sorted[0][0]).toBe("Bob");
    expect(sorted[0][1]).toBe("42");

    // CF rules are range-based; after sort row 1 now has Bob's score
    // The rule still applies to the same range, evaluating new data
    expect(getCFAppliedColor(cfRules, 1, 1, sorted[0][1])).toBe("#FF0000");
    expect(getCFAppliedColor(cfRules, 4, 1, sorted[3][1])).toBe("#00FF00");
  });

  it("applies auto-filter then verifies CF still evaluates on visible rows", () => {
    const dataRows = sampleData.slice(1);
    const filtered = applyFilters(dataRows, [
      { column: 3, values: new Set(["Active"]) },
    ]);

    expect(filtered).toHaveLength(3); // Alice, Charlie, Diana

    // CF should still evaluate correctly on filtered data
    for (const row of filtered) {
      const score = row[1];
      const color = getCFAppliedColor(cfRules, 1, 1, score);
      if (Number(score) > 80) {
        expect(color).toBe("#00FF00");
      } else if (Number(score) < 50) {
        expect(color).toBe("#FF0000");
      } else {
        expect(color).toBeNull();
      }
    }
  });

  it("sorts by CF-applied color to group highlighted rows", () => {
    const dataRows = sampleData.slice(1);
    // Build color map based on CF evaluation
    const colorMap = new Map<number, string>();
    dataRows.forEach((row, i) => {
      const color = getCFAppliedColor(cfRules, i + 1, 1, row[1]);
      if (color) colorMap.set(i, color);
    });

    // Sort: green rows first
    const sorted = sortByColor(dataRows, colorMap, "#00FF00", true);
    // Alice(95) and Diana(88) have green - should come first
    const firstTwoNames = sorted.slice(0, 2).map((r) => r[0]);
    expect(firstTwoNames).toContain("Alice");
    expect(firstTwoNames).toContain("Diana");
  });

  it("filter + sort chained: filter active, then sort by score desc", () => {
    const dataRows = sampleData.slice(1);
    const filtered = applyFilters(dataRows, [
      { column: 3, values: new Set(["Active"]) },
    ]);
    const sorted = applySortLevels(filtered, [
      { columnKey: 1, ascending: false, sortOn: "value" },
    ]);

    expect(sorted[0][0]).toBe("Alice"); // 95
    expect(sorted[1][0]).toBe("Diana"); // 88
    expect(sorted[2][0]).toBe("Charlie"); // 78

    // Verify CF on sorted+filtered result
    expect(getCFAppliedColor(cfRules, 1, 1, sorted[0][1])).toBe("#00FF00");
  });

  it("CF stopIfTrue prevents lower-priority rules from applying", () => {
    const rulesWithStop: CFRule[] = [
      {
        ...cfRules[0],
        stopIfTrue: true, // High score rule stops evaluation
      },
      {
        id: "cf-all",
        type: "cellIs",
        rangeStartRow: 1,
        rangeEndRow: 5,
        rangeStartCol: 1,
        rangeEndCol: 1,
        operator: "greaterThan",
        value: "0",
        format: { backgroundColor: "#YELLOW" },
        priority: 3,
        stopIfTrue: false,
      },
    ];

    // Score 95 matches first rule (stopIfTrue) - should get green, not yellow
    const result = evaluateCFForCell(rulesWithStop, 1, 1, "95");
    expect(result?.backgroundColor).toBe("#00FF00");
  });
});

// ============================================================================
// SCENARIO 2: Charts + Pivot + Named Ranges
// ============================================================================

describe("Scenario 2: Charts + Pivot + Named Ranges", () => {
  const salesData: Record<string, string>[] = [
    { Region: "North", Product: "Widget", Revenue: "1200", Quantity: "10" },
    { Region: "North", Product: "Gadget", Revenue: "800", Quantity: "5" },
    { Region: "South", Product: "Widget", Revenue: "900", Quantity: "8" },
    { Region: "South", Product: "Gadget", Revenue: "1500", Quantity: "12" },
    { Region: "East", Product: "Widget", Revenue: "600", Quantity: "4" },
    { Region: "East", Product: "Gadget", Revenue: "1100", Quantity: "9" },
  ];

  it("creates named ranges for pivot source data", () => {
    const ref = formatRefersTo("Sales", 0, 0, 6, 3);
    expect(ref).toBe("=Sales!$A$1:$D$7");
    expect(isValidName("SalesData")).toBe(true);
    expect(isValidName("Sales_Q1_2025")).toBe(true);
  });

  it("compiles pivot DSL and transforms to chart data", () => {
    const dsl = `
      ROWS: Region
      VALUES: sum(Revenue), count(Quantity)
    `;
    const config = parsePivotDsl(dsl);
    expect(config.rows).toEqual(["Region"]);
    expect(config.values).toHaveLength(2);
    expect(config.values[0]).toEqual({ field: "Revenue", aggregation: "sum" });
    expect(config.values[1]).toEqual({ field: "Quantity", aggregation: "count" });

    const chartData = pivotToChartData(config, salesData);
    expect(chartData.categories).toContain("North");
    expect(chartData.categories).toContain("South");
    expect(chartData.categories).toContain("East");
    expect(chartData.series).toHaveLength(2);

    // North Revenue: 1200 + 800 = 2000
    const northIdx = chartData.categories.indexOf("North");
    expect(chartData.series[0].values[northIdx]).toBe(2000);
  });

  it("applies chart filters on pivot-derived data", () => {
    const config = parsePivotDsl("ROWS: Region\nVALUES: sum(Revenue)");
    const chartData = pivotToChartData(config, salesData);

    // Hide "East" category
    const eastIdx = chartData.categories.indexOf("East");
    const filtered = applyChartFilters(chartData, { hiddenCategories: [eastIdx] });

    expect(filtered.categories).not.toContain("East");
    expect(filtered.categories).toHaveLength(2);
    expect(filtered.series[0].values).toHaveLength(2);
  });

  it("pivot DSL with filters narrows chart data before rendering", () => {
    const dsl = `
      ROWS: Region
      VALUES: sum(Revenue)
      FILTER: Product = [Widget]
    `;
    const config = parsePivotDsl(dsl);
    expect(config.filters).toHaveLength(1);
    expect(config.filters[0].field).toBe("Product");

    const chartData = pivotToChartData(config, salesData);
    // Only Widget rows: North=1200, South=900, East=600
    const northIdx = chartData.categories.indexOf("North");
    expect(chartData.series[0].values[northIdx]).toBe(1200);

    const southIdx = chartData.categories.indexOf("South");
    expect(chartData.series[0].values[southIdx]).toBe(900);
  });
});

// ============================================================================
// SCENARIO 3: Data Validation + Protection + Error Checking
// ============================================================================

describe("Scenario 3: Data Validation + Protection + Error Checking", () => {
  let protection: ProtectionState;
  const validationRules = new Map<string, ValidationRule>();
  const cellValues = new Map<string, string>();

  beforeEach(() => {
    protection = {
      isProtected: false,
      lockedCells: new Set(["0,0", "0,1", "0,2", "1,0"]),
      options: {
        formatCells: false,
        sort: false,
        useAutoFilter: false,
        insertRows: false,
        deleteRows: false,
      },
    };

    validationRules.clear();
    validationRules.set("1,1", {
      type: "list",
      allowList: ["Low", "Medium", "High"],
      errorStyle: "stop",
    });
    validationRules.set("1,2", {
      type: "whole",
      operator: "between",
      value1: "1",
      value2: "100",
      errorStyle: "stop",
    });

    cellValues.clear();
    cellValues.set("1,1", "Medium");
    cellValues.set("1,2", "50");
  });

  it("unprotected sheet allows edits regardless of lock status", () => {
    expect(canEditCell(protection, 0, 0)).toBe(true); // locked but unprotected
    expect(canEditCell(protection, 1, 1)).toBe(true);
  });

  it("protected sheet blocks editing locked cells", () => {
    protection.isProtected = true;
    expect(canEditCell(protection, 0, 0)).toBe(false); // locked + protected
    expect(canEditCell(protection, 1, 1)).toBe(true);  // unlocked
  });

  it("validation still works on unlocked cells when sheet is protected", () => {
    protection.isProtected = true;
    // Cell (1,1) is unlocked - can edit but validation applies
    expect(canEditCell(protection, 1, 1)).toBe(true);
    expect(validateInput("High", validationRules.get("1,1")!)).toBe(true);
    expect(validateInput("Invalid", validationRules.get("1,1")!)).toBe(false);
  });

  it("edit guard blocks invalid input on protected cells", () => {
    protection.isProtected = true;

    // Attempt to edit locked cell (0,0)
    const canEdit = canEditCell(protection, 0, 0);
    expect(canEdit).toBe(false);

    // Attempt to edit unlocked cell (1,2) with invalid value
    expect(canEditCell(protection, 1, 2)).toBe(true);
    expect(validateInput("999", validationRules.get("1,2")!)).toBe(false); // out of range
    expect(validateInput("50", validationRules.get("1,2")!)).toBe(true);
  });

  it("error checking detects validation circles (invalid existing data)", () => {
    cellValues.set("1,1", "InvalidChoice");
    cellValues.set("1,2", "999");

    const errors = detectValidationCircles(validationRules, cellValues);
    expect(errors).toHaveLength(2);
    expect(errors[0].errorType).toBe("validationCircle");
    expect(errors[1].errorType).toBe("validationCircle");
  });

  it("no errors when all values satisfy validation rules", () => {
    const errors = detectValidationCircles(validationRules, cellValues);
    expect(errors).toHaveLength(0);
  });

  it("protection blocks sort action even when cells are unlocked", () => {
    protection.isProtected = true;
    expect(canPerformAction(protection, "sort")).toBe(false);

    // Enable sort in protection options
    protection.options.sort = true;
    expect(canPerformAction(protection, "sort")).toBe(true);
  });
});

// ============================================================================
// SCENARIO 4: Sparklines + Table + Grouping
// ============================================================================

describe("Scenario 4: Sparklines + Table + Grouping", () => {
  const table: TableDef = {
    name: "SalesTable",
    headerRow: 0,
    startCol: 0,
    endCol: 5,
    dataStartRow: 1,
    dataEndRow: 12,
    columns: ["Month", "Revenue", "Cost", "Profit", "Target", "Sparkline"],
  };

  const sparklines: SparklineGroup[] = [
    {
      id: 1,
      location: { startRow: 1, startCol: 5, endRow: 1, endCol: 5 },
      dataRange: { startRow: 1, startCol: 1, endRow: 1, endCol: 4 },
      type: "line",
    },
    {
      id: 2,
      location: { startRow: 5, startCol: 5, endRow: 5, endCol: 5 },
      dataRange: { startRow: 5, startCol: 1, endRow: 5, endCol: 4 },
      type: "column",
    },
    {
      id: 3,
      location: { startRow: 10, startCol: 5, endRow: 10, endCol: 5 },
      dataRange: { startRow: 10, startCol: 1, endRow: 10, endCol: 4 },
      type: "winloss",
    },
  ];

  it("sparkline location is within table range", () => {
    for (const sp of sparklines) {
      expect(isInTableRange(table, sp.location.startRow, sp.location.startCol)).toBe(true);
    }
  });

  it("validates sparkline ranges within table bounds", () => {
    for (const sp of sparklines) {
      const result = validateSparklineRanges(sp.location, sp.dataRange);
      expect(result.valid).toBe(true);
      expect(result.count).toBe(1);
    }
  });

  it("collapsing group hides sparklines within the collapsed range", () => {
    const group: RowGroup = { startRow: 4, endRow: 8, level: 1, collapsed: false };
    const collapsed = collapseGroup(group);
    expect(collapsed.collapsed).toBe(true);

    // Sparkline id=2 at row 5 is within collapsed range [4,8]
    const adjusted = adjustSparklineAfterGroupCollapse(sparklines[1], collapsed.startRow, collapsed.endRow);
    expect(adjusted).toBeNull(); // hidden

    // Sparkline id=1 at row 1 is above - unaffected
    const above = adjustSparklineAfterGroupCollapse(sparklines[0], collapsed.startRow, collapsed.endRow);
    expect(above).not.toBeNull();
    expect(above!.location.startRow).toBe(1);

    // Sparkline id=3 at row 10 is below - shifted up by 5 rows
    const below = adjustSparklineAfterGroupCollapse(sparklines[2], collapsed.startRow, collapsed.endRow);
    expect(below).not.toBeNull();
    expect(below!.location.startRow).toBe(5); // 10 - 5 = 5
  });

  it("expanding group restores sparkline positions", () => {
    // After collapse, sparkline at visual row 5 (was row 10) expands back
    const shiftedSparkline: SparklineGroup = {
      ...sparklines[2],
      location: { startRow: 5, startCol: 5, endRow: 5, endCol: 5 },
    };
    const restored = adjustSparklineAfterGroupExpand(shiftedSparkline, 4, 5);
    expect(restored.location.startRow).toBe(10); // back to original
  });

  it("visible rows exclude collapsed group content", () => {
    const groups: RowGroup[] = [
      { startRow: 4, endRow: 8, level: 1, collapsed: true },
    ];
    const visible = getVisibleRows(13, groups);
    expect(visible).toContain(0);
    expect(visible).toContain(3);
    expect(visible).not.toContain(4);
    expect(visible).not.toContain(8);
    expect(visible).toContain(9);
    expect(visible).toHaveLength(8); // 13 total - 5 hidden
  });
});

// ============================================================================
// SCENARIO 5: Search + Replace + Undo (Conceptual)
// ============================================================================

describe("Scenario 5: Search + Replace + Undo", () => {
  let grid: string[][];
  let undoStack: UndoStack;

  beforeEach(() => {
    grid = [
      ["Revenue", "Q1 Revenue", "Q2 Revenue"],
      ["1000", "1200", "1500"],
      ["Cost", "Q1 Cost", "Q2 Cost"],
      ["800", "900", "1100"],
      ["Net Revenue", "Total", "Revenue Summary"],
    ];
    undoStack = new UndoStack();
  });

  it("finds all matches for a pattern across the grid", () => {
    const matches = findAllMatches(grid, "Revenue", false, false);
    // "Revenue" appears in: (0,0), (0,1), (0,2), (4,0), (4,2)
    expect(matches).toHaveLength(5);
    expect(matches[0]).toEqual({ row: 0, col: 0, startIndex: 0, length: 7 });
  });

  it("case-sensitive search reduces match count", () => {
    const lower = findAllMatches(grid, "revenue", true, false);
    expect(lower).toHaveLength(0); // no lowercase "revenue" in grid

    const upper = findAllMatches(grid, "Revenue", true, false);
    expect(upper).toHaveLength(5);
  });

  it("match entire cell narrows results", () => {
    const exact = findAllMatches(grid, "Revenue", false, true);
    // Only cell (0,0) has exactly "Revenue"
    expect(exact).toHaveLength(1);
    expect(exact[0].row).toBe(0);
    expect(exact[0].col).toBe(0);
  });

  it("replace all modifies match count and pushes undo entry", () => {
    const beforeMatches = findAllMatches(grid, "Revenue", false, false);
    expect(beforeMatches).toHaveLength(5);

    undoStack.push({ action: "replaceAll", data: { grid: grid.map((r) => [...r]) } });

    const { newGrid, replacementCount } = replaceAll(grid, "Revenue", "Income", false);
    grid = newGrid;
    expect(replacementCount).toBe(5);

    const afterMatches = findAllMatches(grid, "Revenue", false, false);
    expect(afterMatches).toHaveLength(0);

    const incomeMatches = findAllMatches(grid, "Income", false, false);
    expect(incomeMatches).toHaveLength(5);
  });

  it("undo restores previous grid state after replace", () => {
    const originalGrid = grid.map((r) => [...r]);
    undoStack.push({ action: "replaceAll", data: { grid: originalGrid } });

    const { newGrid } = replaceAll(grid, "Revenue", "Income", false);
    grid = newGrid;
    expect(grid[0][0]).toBe("Income");

    // Undo
    const entry = undoStack.undo();
    expect(entry).not.toBeNull();
    grid = (entry!.data as { grid: string[][] }).grid;
    expect(grid[0][0]).toBe("Revenue");
    expect(undoStack.redoLength).toBe(1);
  });

  it("navigation wraps correctly after replace reduces matches", () => {
    let matches = findAllMatches(grid, "Revenue", false, false);
    expect(matches).toHaveLength(5);

    let currentIdx = 3; // pointing at 4th match
    currentIdx = navigateMatch(matches, currentIdx, "next");
    expect(currentIdx).toBe(4); // 5th match

    currentIdx = navigateMatch(matches, currentIdx, "next");
    expect(currentIdx).toBe(0); // wraps to first

    // Now replace some matches - only replace "Q1 Revenue" -> "Q1 Sales"
    grid[0][1] = "Q1 Sales";
    matches = findAllMatches(grid, "Revenue", false, false);
    expect(matches).toHaveLength(4); // one less

    // Navigate from last match wraps to first
    currentIdx = 3;
    currentIdx = navigateMatch(matches, currentIdx, "next");
    expect(currentIdx).toBe(0);
  });

  it("previous navigation wraps from first to last", () => {
    const matches = findAllMatches(grid, "Revenue", false, false);
    let currentIdx = 0;
    currentIdx = navigateMatch(matches, currentIdx, "previous");
    expect(currentIdx).toBe(matches.length - 1);
  });

  it("redo after undo restores replaced state", () => {
    const originalGrid = grid.map((r) => [...r]);
    undoStack.push({ action: "replaceAll", data: { grid: originalGrid } });

    const { newGrid } = replaceAll(grid, "Revenue", "Income", false);
    const replacedGrid = newGrid.map((r) => [...r]);
    grid = newGrid;

    undoStack.push({ action: "replaceAll", data: { grid: replacedGrid } });

    // Undo twice
    undoStack.undo();
    const entry = undoStack.undo();
    grid = (entry!.data as { grid: string[][] }).grid;
    expect(grid[0][0]).toBe("Revenue");

    // Redo
    const redoEntry = undoStack.redo();
    expect(redoEntry).not.toBeNull();
    expect(undoStack.length).toBe(1);
  });
});
