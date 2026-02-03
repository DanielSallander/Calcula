//! FILENAME: app/extensions/_standard/conditional-formatting/types.ts
// PURPOSE: Type definitions for conditional formatting rules
// CONTEXT: Defines the structure of formatting rules and conditions

import type { IStyleOverride } from "../../../src/api/styleInterceptors";

// ============================================================================
// Rule Condition Types
// ============================================================================

export type ComparisonOperator = 
  | "greaterThan"
  | "lessThan"
  | "greaterThanOrEqual"
  | "lessThanOrEqual"
  | "equal"
  | "notEqual"
  | "between"
  | "notBetween";

export type TextOperator =
  | "contains"
  | "notContains"
  | "beginsWith"
  | "endsWith"
  | "equals"
  | "notEquals";

export type RuleType =
  | "cellValue"      // Compare cell value against a threshold
  | "text"           // Text-based conditions
  | "top10"          // Top/Bottom N values
  | "aboveAverage"   // Above/below average
  | "duplicates"     // Duplicate/unique values
  | "formula"        // Custom formula
  | "colorScale"     // Gradient color scale
  | "dataBar"        // Data bars
  | "iconSet";       // Icon sets

// ============================================================================
// Rule Conditions
// ============================================================================

export interface CellValueCondition {
  type: "cellValue";
  operator: ComparisonOperator;
  value1: number | string;
  value2?: number | string; // For "between" operator
}

export interface TextCondition {
  type: "text";
  operator: TextOperator;
  value: string;
  caseSensitive?: boolean;
}

export interface Top10Condition {
  type: "top10";
  direction: "top" | "bottom";
  count: number;
  percent?: boolean; // If true, count is a percentage
}

export interface AboveAverageCondition {
  type: "aboveAverage";
  direction: "above" | "below" | "equalOrAbove" | "equalOrBelow";
}

export interface DuplicatesCondition {
  type: "duplicates";
  unique: boolean; // If true, highlight unique values instead
}

export interface FormulaCondition {
  type: "formula";
  formula: string; // e.g., "=A1>B1"
}

export type RuleCondition =
  | CellValueCondition
  | TextCondition
  | Top10Condition
  | AboveAverageCondition
  | DuplicatesCondition
  | FormulaCondition;

// ============================================================================
// Conditional Formatting Rule
// ============================================================================

export interface ConditionalRule {
  /** Unique identifier for this rule */
  id: string;
  
  /** Human-readable name for the rule */
  name?: string;
  
  /** Whether the rule is currently enabled */
  enabled: boolean;
  
  /** The condition that triggers this rule */
  condition: RuleCondition;
  
  /** The style to apply when condition is met */
  style: IStyleOverride;
  
  /** The range this rule applies to */
  range: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  };
  
  /** Stop evaluating rules after this one matches (stopIfTrue) */
  stopIfTrue?: boolean;
  
  /** Priority (lower = evaluated first) */
  priority?: number;
}

// ============================================================================
// Rule Set (per sheet)
// ============================================================================

export interface RuleSet {
  sheetIndex: number;
  rules: ConditionalRule[];
}

// ============================================================================
// Range Context for complex rule evaluation
// ============================================================================

export interface RangeContext {
  /** All numeric values in the range */
  numericValues: number[];
  /** All string values in the range */
  allValues: string[];
  /** Map of value to count for duplicate detection */
  valueCounts: Map<string, number>;
  /** Computed statistics */
  stats: {
    sum: number;
    count: number;
    average: number;
    min: number;
    max: number;
  };
  /** Sorted numeric values for percentile calculations */
  sortedValues: number[];
}

// ============================================================================
// Preset Styles
// ============================================================================

export const PRESET_STYLES = {
  lightRedFill: {
    backgroundColor: "#ffc7ce",
    textColor: "#9c0006",
  },
  lightYellowFill: {
    backgroundColor: "#ffeb9c",
    textColor: "#9c5700",
  },
  lightGreenFill: {
    backgroundColor: "#c6efce",
    textColor: "#006100",
  },
  redText: {
    textColor: "#ff0000",
  },
  greenText: {
    textColor: "#00aa00",
  },
  boldRed: {
    textColor: "#ff0000",
    bold: true,
  },
  // Additional presets for common scenarios
  redFillWhiteText: {
    backgroundColor: "#ff0000",
    textColor: "#ffffff",
  },
  greenFillWhiteText: {
    backgroundColor: "#00aa00",
    textColor: "#ffffff",
  },
  yellowFill: {
    backgroundColor: "#ffff00",
  },
  orangeFill: {
    backgroundColor: "#ffc000",
  },
  blueFill: {
    backgroundColor: "#5b9bd5",
    textColor: "#ffffff",
  },
} as const;

// ============================================================================
// Quick Format Presets
// ============================================================================

export interface QuickFormatPreset {
  id: string;
  label: string;
  description: string;
  createCondition: (value?: string) => RuleCondition;
  style: IStyleOverride;
}

export const QUICK_FORMAT_PRESETS: QuickFormatPreset[] = [
  {
    id: "greater-than",
    label: "Greater Than...",
    description: "Highlight cells greater than a value",
    createCondition: (value = "0") => ({
      type: "cellValue",
      operator: "greaterThan",
      value1: parseFloat(value) || 0,
    }),
    style: PRESET_STYLES.lightGreenFill,
  },
  {
    id: "less-than",
    label: "Less Than...",
    description: "Highlight cells less than a value",
    createCondition: (value = "0") => ({
      type: "cellValue",
      operator: "lessThan",
      value1: parseFloat(value) || 0,
    }),
    style: PRESET_STYLES.lightRedFill,
  },
  {
    id: "between",
    label: "Between...",
    description: "Highlight cells between two values",
    createCondition: () => ({
      type: "cellValue",
      operator: "between",
      value1: 0,
      value2: 100,
    }),
    style: PRESET_STYLES.lightYellowFill,
  },
  {
    id: "equal-to",
    label: "Equal To...",
    description: "Highlight cells equal to a value",
    createCondition: (value = "0") => ({
      type: "cellValue",
      operator: "equal",
      value1: value,
    }),
    style: PRESET_STYLES.yellowFill,
  },
  {
    id: "text-contains",
    label: "Text Contains...",
    description: "Highlight cells containing specific text",
    createCondition: (value = "") => ({
      type: "text",
      operator: "contains",
      value: value,
    }),
    style: PRESET_STYLES.lightYellowFill,
  },
  {
    id: "duplicates",
    label: "Duplicate Values",
    description: "Highlight duplicate values in range",
    createCondition: () => ({
      type: "duplicates",
      unique: false,
    }),
    style: PRESET_STYLES.lightRedFill,
  },
  {
    id: "unique",
    label: "Unique Values",
    description: "Highlight unique values in range",
    createCondition: () => ({
      type: "duplicates",
      unique: true,
    }),
    style: PRESET_STYLES.lightGreenFill,
  },
  {
    id: "top-10",
    label: "Top 10 Items",
    description: "Highlight top 10 values",
    createCondition: () => ({
      type: "top10",
      direction: "top",
      count: 10,
    }),
    style: PRESET_STYLES.lightGreenFill,
  },
  {
    id: "bottom-10",
    label: "Bottom 10 Items",
    description: "Highlight bottom 10 values",
    createCondition: () => ({
      type: "top10",
      direction: "bottom",
      count: 10,
    }),
    style: PRESET_STYLES.lightRedFill,
  },
  {
    id: "above-average",
    label: "Above Average",
    description: "Highlight values above average",
    createCondition: () => ({
      type: "aboveAverage",
      direction: "above",
    }),
    style: PRESET_STYLES.lightGreenFill,
  },
  {
    id: "below-average",
    label: "Below Average",
    description: "Highlight values below average",
    createCondition: () => ({
      type: "aboveAverage",
      direction: "below",
    }),
    style: PRESET_STYLES.lightRedFill,
  },
];

// ============================================================================
// Operator Display Labels
// ============================================================================

export const COMPARISON_OPERATOR_LABELS: Record<ComparisonOperator, string> = {
  greaterThan: "Greater than",
  lessThan: "Less than",
  greaterThanOrEqual: "Greater than or equal to",
  lessThanOrEqual: "Less than or equal to",
  equal: "Equal to",
  notEqual: "Not equal to",
  between: "Between",
  notBetween: "Not between",
};

export const TEXT_OPERATOR_LABELS: Record<TextOperator, string> = {
  contains: "Contains",
  notContains: "Does not contain",
  beginsWith: "Begins with",
  endsWith: "Ends with",
  equals: "Equals",
  notEquals: "Does not equal",
};