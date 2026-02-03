//! FILENAME: app/extensions/_standard/conditional-formatting/ruleEvaluator.ts
// PURPOSE: Rule evaluation engine for conditional formatting
// CONTEXT: Evaluates whether a cell value matches a rule's condition

import type { CellCoords } from "../../../src/api/styleInterceptors";
import type { 
  ConditionalRule, 
  RuleCondition,
  CellValueCondition,
  TextCondition,
  Top10Condition,
  AboveAverageCondition,
  DuplicatesCondition,
  RangeContext,
} from "./types";

// ============================================================================
// Range Context Cache
// ============================================================================

// Cache for range context to avoid recomputing for every cell
const rangeContextCache = new Map<string, RangeContext>();

/**
 * Generate a cache key for a rule's range.
 */
function getRangeCacheKey(rule: ConditionalRule, sheetIndex: number): string {
  const { startRow, startCol, endRow, endCol } = rule.range;
  return `${sheetIndex}:${startRow},${startCol}:${endRow},${endCol}:${rule.id}`;
}

/**
 * Set the range context for a rule (called by the extension before render).
 */
export function setRangeContext(rule: ConditionalRule, sheetIndex: number, context: RangeContext): void {
  const key = getRangeCacheKey(rule, sheetIndex);
  rangeContextCache.set(key, context);
}

/**
 * Get the range context for a rule.
 */
export function getRangeContext(rule: ConditionalRule, sheetIndex: number): RangeContext | undefined {
  const key = getRangeCacheKey(rule, sheetIndex);
  return rangeContextCache.get(key);
}

/**
 * Clear all range context caches.
 */
export function clearRangeContextCache(): void {
  rangeContextCache.clear();
}

/**
 * Clear context for a specific sheet.
 */
export function clearSheetContextCache(sheetIndex: number): void {
  const prefix = `${sheetIndex}:`;
  for (const key of rangeContextCache.keys()) {
    if (key.startsWith(prefix)) {
      rangeContextCache.delete(key);
    }
  }
}

// ============================================================================
// Main Evaluation Functions
// ============================================================================

/**
 * Evaluate whether a rule's condition is met for a given cell.
 */
export function evaluateRule(
  rule: ConditionalRule,
  cellValue: string,
  coords: CellCoords
): boolean {
  const sheetIndex = coords.sheetIndex ?? 0;
  const context = getRangeContext(rule, sheetIndex);
  return evaluateCondition(rule.condition, cellValue, coords, context);
}

/**
 * Evaluate a condition against a cell value.
 */
export function evaluateCondition(
  condition: RuleCondition,
  cellValue: string,
  coords: CellCoords,
  context?: RangeContext
): boolean {
  switch (condition.type) {
    case "cellValue":
      return evaluateCellValueCondition(condition, cellValue);
    case "text":
      return evaluateTextCondition(condition, cellValue);
    case "top10":
      return evaluateTop10Condition(condition, cellValue, context);
    case "aboveAverage":
      return evaluateAboveAverageCondition(condition, cellValue, context);
    case "duplicates":
      return evaluateDuplicatesCondition(condition, cellValue, context);
    case "formula":
      // Formula evaluation requires the formula engine
      // Placeholder for future implementation
      return false;
    default:
      return false;
  }
}

/**
 * Evaluate a cell value comparison condition.
 */
function evaluateCellValueCondition(
  condition: CellValueCondition,
  cellValue: string
): boolean {
  // Try to parse as number
  const numValue = parseFloat(cellValue);
  const isNumeric = !isNaN(numValue) && isFinite(numValue);
  
  // Get threshold values
  const threshold1 = typeof condition.value1 === "string" 
    ? parseFloat(condition.value1) 
    : condition.value1;
  const threshold2 = condition.value2 !== undefined
    ? (typeof condition.value2 === "string" ? parseFloat(condition.value2) : condition.value2)
    : undefined;
  
  // For numeric comparisons, both cell value and threshold must be numeric
  if (!isNumeric || isNaN(threshold1)) {
    // Fall back to string comparison for equality operators
    if (condition.operator === "equal") {
      return cellValue === String(condition.value1);
    }
    if (condition.operator === "notEqual") {
      return cellValue !== String(condition.value1);
    }
    return false;
  }
  
  switch (condition.operator) {
    case "greaterThan":
      return numValue > threshold1;
    case "lessThan":
      return numValue < threshold1;
    case "greaterThanOrEqual":
      return numValue >= threshold1;
    case "lessThanOrEqual":
      return numValue <= threshold1;
    case "equal":
      return numValue === threshold1;
    case "notEqual":
      return numValue !== threshold1;
    case "between":
      if (threshold2 === undefined || isNaN(threshold2)) return false;
      return numValue >= Math.min(threshold1, threshold2) && 
             numValue <= Math.max(threshold1, threshold2);
    case "notBetween":
      if (threshold2 === undefined || isNaN(threshold2)) return false;
      return numValue < Math.min(threshold1, threshold2) || 
             numValue > Math.max(threshold1, threshold2);
    default:
      return false;
  }
}

/**
 * Evaluate a text condition.
 */
function evaluateTextCondition(
  condition: TextCondition,
  cellValue: string
): boolean {
  const compareValue = condition.caseSensitive 
    ? cellValue 
    : cellValue.toLowerCase();
  const searchValue = condition.caseSensitive 
    ? condition.value 
    : condition.value.toLowerCase();
  
  switch (condition.operator) {
    case "contains":
      return compareValue.includes(searchValue);
    case "notContains":
      return !compareValue.includes(searchValue);
    case "beginsWith":
      return compareValue.startsWith(searchValue);
    case "endsWith":
      return compareValue.endsWith(searchValue);
    case "equals":
      return compareValue === searchValue;
    case "notEquals":
      return compareValue !== searchValue;
    default:
      return false;
  }
}

/**
 * Evaluate a Top/Bottom N condition.
 */
function evaluateTop10Condition(
  condition: Top10Condition,
  cellValue: string,
  context?: RangeContext
): boolean {
  if (!context || context.sortedValues.length === 0) {
    return false;
  }
  
  const numValue = parseFloat(cellValue);
  if (isNaN(numValue) || !isFinite(numValue)) {
    return false;
  }
  
  const { sortedValues } = context;
  const totalCount = sortedValues.length;
  
  // Calculate how many items to include
  let itemCount: number;
  if (condition.percent) {
    itemCount = Math.ceil((condition.count / 100) * totalCount);
  } else {
    itemCount = Math.min(condition.count, totalCount);
  }
  
  if (itemCount <= 0) {
    return false;
  }
  
  if (condition.direction === "top") {
    // Get threshold for top N (values >= this threshold are in top N)
    const thresholdIndex = Math.max(0, totalCount - itemCount);
    const threshold = sortedValues[thresholdIndex];
    return numValue >= threshold;
  } else {
    // Get threshold for bottom N (values <= this threshold are in bottom N)
    const thresholdIndex = Math.min(itemCount - 1, totalCount - 1);
    const threshold = sortedValues[thresholdIndex];
    return numValue <= threshold;
  }
}

/**
 * Evaluate an Above/Below Average condition.
 */
function evaluateAboveAverageCondition(
  condition: AboveAverageCondition,
  cellValue: string,
  context?: RangeContext
): boolean {
  if (!context || context.stats.count === 0) {
    return false;
  }
  
  const numValue = parseFloat(cellValue);
  if (isNaN(numValue) || !isFinite(numValue)) {
    return false;
  }
  
  const average = context.stats.average;
  
  switch (condition.direction) {
    case "above":
      return numValue > average;
    case "below":
      return numValue < average;
    case "equalOrAbove":
      return numValue >= average;
    case "equalOrBelow":
      return numValue <= average;
    default:
      return false;
  }
}

/**
 * Evaluate a Duplicates/Unique condition.
 */
function evaluateDuplicatesCondition(
  condition: DuplicatesCondition,
  cellValue: string,
  context?: RangeContext
): boolean {
  if (!context) {
    return false;
  }
  
  // Normalize value for comparison (trim whitespace, case-insensitive)
  const normalizedValue = cellValue.trim().toLowerCase();
  
  // Skip empty cells
  if (normalizedValue === "") {
    return false;
  }
  
  const count = context.valueCounts.get(normalizedValue) ?? 0;
  const isDuplicate = count > 1;
  
  // If unique: true, highlight values that appear exactly once
  // If unique: false, highlight values that appear more than once
  return condition.unique ? !isDuplicate : isDuplicate;
}

// ============================================================================
// Range Context Builder
// ============================================================================

/**
 * Build a RangeContext from an array of cell values.
 * Call this when the range data changes and before rendering.
 */
export function buildRangeContext(values: string[]): RangeContext {
  const numericValues: number[] = [];
  const allValues: string[] = [];
  const valueCounts = new Map<string, number>();
  
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  
  for (const value of values) {
    allValues.push(value);
    
    // Count for duplicates (normalized)
    const normalized = value.trim().toLowerCase();
    if (normalized !== "") {
      valueCounts.set(normalized, (valueCounts.get(normalized) ?? 0) + 1);
    }
    
    // Numeric processing
    const numValue = parseFloat(value);
    if (!isNaN(numValue) && isFinite(numValue)) {
      numericValues.push(numValue);
      sum += numValue;
      min = Math.min(min, numValue);
      max = Math.max(max, numValue);
    }
  }
  
  // Sort for percentile calculations
  const sortedValues = [...numericValues].sort((a, b) => a - b);
  
  const count = numericValues.length;
  const average = count > 0 ? sum / count : 0;
  
  return {
    numericValues,
    allValues,
    valueCounts,
    stats: {
      sum,
      count,
      average,
      min: count > 0 ? min : 0,
      max: count > 0 ? max : 0,
    },
    sortedValues,
  };
}

/**
 * Generate a unique rule ID.
 */
export function generateRuleId(): string {
  return `cf-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}