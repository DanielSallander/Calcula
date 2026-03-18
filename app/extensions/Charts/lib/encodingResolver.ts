//! FILENAME: app/extensions/Charts/lib/encodingResolver.ts
// PURPOSE: Resolve conditional encoding values per data point.
// CONTEXT: Used by chart painters to determine per-point visual properties
//          (color, opacity, size) based on SeriesEncoding definitions.

import type { ConditionalValue, ValueCondition, SeriesEncoding } from "../types";
import { getSeriesColor } from "../rendering/chartTheme";

// ============================================================================
// Condition Evaluation
// ============================================================================

/**
 * Evaluate a ValueCondition against a data point.
 * Returns true if the condition matches.
 */
function evaluateCondition(
  condition: ValueCondition,
  value: number,
  category: string,
): boolean {
  const testValue = condition.field === "category" ? category : value;

  if (condition.oneOf != null) {
    return condition.oneOf.includes(testValue);
  }

  // Numeric comparisons (only meaningful for numeric field or numeric value)
  const numVal = typeof testValue === "number" ? testValue : parseFloat(testValue as string);
  if (isNaN(numVal)) return false;

  if (condition.gt != null && !(numVal > condition.gt)) return false;
  if (condition.lt != null && !(numVal < condition.lt)) return false;
  if (condition.gte != null && !(numVal >= condition.gte)) return false;
  if (condition.lte != null && !(numVal <= condition.lte)) return false;

  return true;
}

// ============================================================================
// Conditional Value Resolution
// ============================================================================

/**
 * Resolve a ConditionalValue to its concrete value for a given data point.
 * - If the encoding is a static value (string/number), return it directly.
 * - If it's a conditional object, evaluate the condition and return value or otherwise.
 */
export function resolveConditional<T>(
  encoding: ConditionalValue<T>,
  value: number,
  category: string,
): T {
  if (typeof encoding === "object" && encoding !== null && "condition" in encoding) {
    const cond = encoding as { condition: ValueCondition; value: T; otherwise: T };
    return evaluateCondition(cond.condition, value, category)
      ? cond.value
      : cond.otherwise;
  }
  return encoding as T;
}

// ============================================================================
// High-Level Encoding Helpers
// ============================================================================

/**
 * Get the color for a specific data point, considering series encoding.
 * Falls back to palette color if no encoding is defined.
 */
export function resolvePointColor(
  encoding: SeriesEncoding | undefined,
  palette: string,
  seriesIndex: number,
  seriesColorOverride: string | null,
  value: number,
  category: string,
): string {
  if (encoding?.color != null) {
    return resolveConditional(encoding.color, value, category);
  }
  return getSeriesColor(palette, seriesIndex, seriesColorOverride);
}

/**
 * Get the opacity for a specific data point, considering series encoding.
 * Returns undefined if no opacity encoding is set (painter uses its default).
 */
export function resolvePointOpacity(
  encoding: SeriesEncoding | undefined,
  value: number,
  category: string,
): number | undefined {
  if (encoding?.opacity != null) {
    return resolveConditional(encoding.opacity, value, category);
  }
  return undefined;
}

/**
 * Get the size for a specific data point, considering series encoding.
 * Returns undefined if no size encoding is set (painter uses its default).
 */
export function resolvePointSize(
  encoding: SeriesEncoding | undefined,
  value: number,
  category: string,
): number | undefined {
  if (encoding?.size != null) {
    return resolveConditional(encoding.size, value, category);
  }
  return undefined;
}
