//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/functionCatalog.ts
// PURPOSE: Fetch, cache, and filter the formula function catalog from the Rust backend.
// CONTEXT: Provides ranked/filtered results for the autocomplete dropdown.

import { getAllFunctions } from "../../../src/api/lib";
import type { FunctionInfo } from "../../../src/api/types";

// ============================================================================
// Common functions that should appear at the top of results
// ============================================================================

const COMMON_FUNCTIONS: Record<string, number> = {
  SUM: 100,
  IF: 95,
  AVERAGE: 90,
  COUNT: 85,
  MAX: 80,
  MIN: 75,
  XLOOKUP: 70,
  XLOOKUPS: 68,
  CONCATENATE: 65,
  COUNTA: 60,
  ROUND: 55,
  AND: 50,
  OR: 45,
  NOT: 40,
  LEN: 35,
  LEFT: 30,
  RIGHT: 25,
  TRIM: 20,
  ISNUMBER: 15,
  ISBLANK: 10,
  ABS: 5,
  ROW: 38,
  COLUMN: 37,
  "SET.ROW.HEIGHT": 3,
  "SET.COLUMN.WIDTH": 3,
  "SET.CELL.FILLCOLOR": 2,
  "GET.ROW.HEIGHT": 2,
  "GET.COLUMN.WIDTH": 2,
  "GET.CELL.FILLCOLOR": 2,
};

// ============================================================================
// Cache
// ============================================================================

let cachedFunctions: FunctionInfo[] = [];

/**
 * Load the function catalog from the Rust backend. Cached after first call.
 */
export async function loadFunctionCatalog(): Promise<FunctionInfo[]> {
  if (cachedFunctions.length > 0) {
    return cachedFunctions;
  }
  try {
    console.log("[FormulaAutocomplete] Loading function catalog...");
    const result = await getAllFunctions();
    console.log("[FormulaAutocomplete] getAllFunctions returned:", JSON.stringify(result).substring(0, 200));
    cachedFunctions = result.functions;
    console.log("[FormulaAutocomplete] Cached", cachedFunctions.length, "functions");
  } catch (error) {
    console.error("[FormulaAutocomplete] Failed to load function catalog:", error);
  }
  return cachedFunctions;
}

/**
 * Get the cached function catalog (synchronous). Returns empty if not yet loaded.
 */
export function getFunctionCatalog(): FunctionInfo[] {
  return cachedFunctions;
}

// ============================================================================
// Filtering & Scoring
// ============================================================================

/**
 * A scored function with match highlight ranges.
 */
export interface ScoredFunction {
  info: FunctionInfo;
  /** Higher score = higher in the list */
  score: number;
  /** Character ranges to highlight in the function name [start, end) */
  matchRanges: Array<[number, number]>;
}

/**
 * Filter and rank functions matching the partial token.
 * Returns up to `limit` results sorted by relevance.
 *
 * Scoring:
 *   - Prefix match: 200 + popularity bonus
 *   - Substring match: 50 + position bonus + popularity bonus
 *   - Shorter names rank higher (less to type)
 */
export function filterFunctions(token: string, limit: number = 10): ScoredFunction[] {
  if (!token || cachedFunctions.length === 0) {
    return [];
  }

  const upper = token.toUpperCase();
  const results: ScoredFunction[] = [];

  for (const fn of cachedFunctions) {
    const nameUpper = fn.name.toUpperCase();
    const popularityBonus = COMMON_FUNCTIONS[fn.name] || 0;

    // Prefix match (strongest signal)
    if (nameUpper.startsWith(upper)) {
      const score = 200 + popularityBonus + (20 - fn.name.length);
      results.push({
        info: fn,
        score,
        matchRanges: [[0, upper.length]],
      });
      continue;
    }

    // Substring match (weaker signal)
    const idx = nameUpper.indexOf(upper);
    if (idx >= 0) {
      const score = 50 + popularityBonus + (10 - idx);
      results.push({
        info: fn,
        score,
        matchRanges: [[idx, idx + upper.length]],
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Look up a specific function by name (case-insensitive).
 * Used for argument hints when the user is inside a function call.
 */
export function getFunctionByName(name: string): FunctionInfo | undefined {
  const upper = name.toUpperCase();
  return cachedFunctions.find((fn) => fn.name.toUpperCase() === upper);
}
