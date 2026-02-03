//! FILENAME: app/extensions/_standard/conditional-formatting/index.ts
// PURPOSE: Conditional Formatting Extension entry point
// CONTEXT: Registers the style interceptor and UI components
// ARCHITECTURE: Extension that uses only the public API

import type { ExtensionModule, ExtensionContext } from "../../../src/api/contract";
import { 
  registerStyleInterceptor, 
  markSheetDirty,
  type IStyleOverride,
  type BaseStyleInfo,
  type CellCoords,
} from "../../../src/api/styleInterceptors";
import { onAppEvent, AppEvents, emitAppEvent } from "../../../src/api/events";
import { registerMenu, registerDialog } from "../../../src/api/ui";
import type { ConditionalRule, RuleSet, RangeContext } from "./types";
import { 
  evaluateRule, 
  generateRuleId, 
  setRangeContext, 
  clearRangeContextCache,
  clearSheetContextCache,
  buildRangeContext,
} from "./ruleEvaluator";

// ============================================================================
// Extension State
// ============================================================================

let cleanupInterceptor: (() => void) | null = null;
let cleanupDataListener: (() => void) | null = null;
let cleanupSheetListener: (() => void) | null = null;
let extensionContext: ExtensionContext | null = null;

// Rule storage - keyed by sheetIndex, then by ruleId
const ruleSets = new Map<number, RuleSet>();

// Cell data cache for range context building
const cellDataCache = new Map<string, Map<string, string>>();

// ============================================================================
// Style Interceptor
// ============================================================================

/**
 * The main style interceptor for conditional formatting.
 * Evaluates all rules for the current sheet and returns style overrides.
 */
function conditionalFormattingInterceptor(
  cellValue: string,
  baseStyle: BaseStyleInfo,
  coords: CellCoords
): IStyleOverride | null {
  const sheetIndex = coords.sheetIndex ?? 0;
  const ruleSet = ruleSets.get(sheetIndex);
  
  if (!ruleSet || ruleSet.rules.length === 0) {
    return null;
  }
  
  // Check each rule in priority order
  for (const rule of ruleSet.rules) {
    if (!rule.enabled) continue;
    
    // Check if cell is in rule's apply range
    if (!isCellInRange(coords.row, coords.col, rule.range)) {
      continue;
    }
    
    // Evaluate the rule condition
    if (evaluateRule(rule, cellValue, coords)) {
      // Return the style override from the rule
      // If stopIfTrue, this will be the only style applied
      return rule.style;
    }
    
    // If stopIfTrue was set on a non-matching rule, continue to next
  }
  
  return null;
}

/**
 * Check if a cell is within a rule's apply range.
 */
function isCellInRange(
  row: number,
  col: number,
  range: { startRow: number; startCol: number; endRow: number; endCol: number }
): boolean {
  return (
    row >= range.startRow &&
    row <= range.endRow &&
    col >= range.startCol &&
    col <= range.endCol
  );
}

// ============================================================================
// Range Context Management
// ============================================================================

/**
 * Update range context for rules that need it (top10, aboveAverage, duplicates).
 * This should be called when data changes or rules are modified.
 */
export async function updateRangeContexts(sheetIndex: number): Promise<void> {
  const ruleSet = ruleSets.get(sheetIndex);
  if (!ruleSet) return;
  
  for (const rule of ruleSet.rules) {
    if (!rule.enabled) continue;
    
    // Only these rule types need range context
    const needsContext = 
      rule.condition.type === "top10" ||
      rule.condition.type === "aboveAverage" ||
      rule.condition.type === "duplicates";
    
    if (!needsContext) continue;
    
    // Collect cell values from the range
    const values = await collectRangeValues(sheetIndex, rule.range);
    const context = buildRangeContext(values);
    setRangeContext(rule, sheetIndex, context);
  }
}

/**
 * Collect cell values from a range.
 * Uses cached data if available, otherwise fetches from backend.
 */
async function collectRangeValues(
  sheetIndex: number,
  range: { startRow: number; startCol: number; endRow: number; endCol: number }
): Promise<string[]> {
  const values: string[] = [];
  
  // For now, we'll use a simple approach - in production this would
  // integrate with the grid's cell data cache
  const cacheKey = `${sheetIndex}`;
  const sheetCache = cellDataCache.get(cacheKey);
  
  for (let row = range.startRow; row <= range.endRow; row++) {
    for (let col = range.startCol; col <= range.endCol; col++) {
      const cellKey = `${row},${col}`;
      const value = sheetCache?.get(cellKey) ?? "";
      values.push(value);
    }
  }
  
  return values;
}

/**
 * Update cell data in cache (called from data change events).
 */
export function updateCellDataCache(
  sheetIndex: number, 
  row: number, 
  col: number, 
  value: string
): void {
  const cacheKey = `${sheetIndex}`;
  let sheetCache = cellDataCache.get(cacheKey);
  if (!sheetCache) {
    sheetCache = new Map();
    cellDataCache.set(cacheKey, sheetCache);
  }
  sheetCache.set(`${row},${col}`, value);
}

/**
 * Bulk update cell data cache.
 */
export function bulkUpdateCellDataCache(
  sheetIndex: number,
  cells: Array<{ row: number; col: number; value: string }>
): void {
  const cacheKey = `${sheetIndex}`;
  let sheetCache = cellDataCache.get(cacheKey);
  if (!sheetCache) {
    sheetCache = new Map();
    cellDataCache.set(cacheKey, sheetCache);
  }
  for (const cell of cells) {
    sheetCache.set(`${cell.row},${cell.col}`, cell.value);
  }
}

// ============================================================================
// Rule Management API (exported for external use)
// ============================================================================

/**
 * Add a conditional formatting rule.
 */
export function addRule(sheetIndex: number, rule: ConditionalRule): void {
  let ruleSet = ruleSets.get(sheetIndex);
  if (!ruleSet) {
    ruleSet = { sheetIndex, rules: [] };
    ruleSets.set(sheetIndex, ruleSet);
  }
  
  // Ensure rule has an ID
  if (!rule.id) {
    rule.id = generateRuleId();
  }
  
  ruleSet.rules.push(rule);
  
  // Sort by priority if specified
  ruleSet.rules.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  
  // Update range context if needed
  updateRangeContexts(sheetIndex);
  
  // Mark the rule's range as dirty to trigger re-render
  markSheetDirty();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Remove a conditional formatting rule by ID.
 */
export function removeRule(sheetIndex: number, ruleId: string): void {
  const ruleSet = ruleSets.get(sheetIndex);
  if (!ruleSet) return;
  
  ruleSet.rules = ruleSet.rules.filter(r => r.id !== ruleId);
  
  markSheetDirty();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Update an existing rule.
 */
export function updateRule(sheetIndex: number, ruleId: string, updates: Partial<ConditionalRule>): void {
  const ruleSet = ruleSets.get(sheetIndex);
  if (!ruleSet) return;
  
  const rule = ruleSet.rules.find(r => r.id === ruleId);
  if (rule) {
    Object.assign(rule, updates);
    
    // Re-sort if priority changed
    if (updates.priority !== undefined) {
      ruleSet.rules.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    }
    
    // Update range context if condition changed
    if (updates.condition || updates.range) {
      updateRangeContexts(sheetIndex);
    }
    
    markSheetDirty();
    emitAppEvent(AppEvents.GRID_REFRESH);
  }
}

/**
 * Get all rules for a sheet.
 */
export function getRules(sheetIndex: number): ConditionalRule[] {
  return ruleSets.get(sheetIndex)?.rules ?? [];
}

/**
 * Reorder rules (affects priority - first match wins).
 */
export function reorderRules(sheetIndex: number, ruleIds: string[]): void {
  const ruleSet = ruleSets.get(sheetIndex);
  if (!ruleSet) return;
  
  const ruleMap = new Map(ruleSet.rules.map(r => [r.id, r]));
  ruleSet.rules = ruleIds
    .map(id => ruleMap.get(id))
    .filter((r): r is ConditionalRule => r !== undefined);
  
  // Update priorities based on new order
  ruleSet.rules.forEach((rule, index) => {
    rule.priority = index;
  });
  
  markSheetDirty();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Clear all rules for a sheet.
 */
export function clearRules(sheetIndex: number): void {
  ruleSets.delete(sheetIndex);
  clearSheetContextCache(sheetIndex);
  markSheetDirty();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Get rule by ID.
 */
export function getRule(sheetIndex: number, ruleId: string): ConditionalRule | undefined {
  return ruleSets.get(sheetIndex)?.rules.find(r => r.id === ruleId);
}

/**
 * Toggle rule enabled state.
 */
export function toggleRule(sheetIndex: number, ruleId: string): void {
  const rule = getRule(sheetIndex, ruleId);
  if (rule) {
    rule.enabled = !rule.enabled;
    markSheetDirty();
    emitAppEvent(AppEvents.GRID_REFRESH);
  }
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

/**
 * Activate the conditional formatting extension.
 */
function activate(context: ExtensionContext): void {
  console.log("[ConditionalFormatting] Activating extension");
  extensionContext = context;
  
  // Register the style interceptor
  cleanupInterceptor = registerStyleInterceptor(
    "conditional-formatting",
    conditionalFormattingInterceptor,
    10 // Priority: run after base styles but before other visual effects
  );
  
  // Listen for data changes to re-evaluate rules
  cleanupDataListener = onAppEvent(AppEvents.DATA_CHANGED, (event) => {
    const detail = event as { sheetIndex?: number };
    const sheetIndex = detail?.sheetIndex ?? 0;
    updateRangeContexts(sheetIndex);
    markSheetDirty();
    emitAppEvent(AppEvents.GRID_REFRESH);
  });
  
  // Listen for sheet changes
  cleanupSheetListener = onAppEvent(AppEvents.SHEET_CHANGED, () => {
    markSheetDirty();
  });
  
  // Register the Rule Manager dialog
  registerDialog("conditional-formatting-manager", {
    id: "conditional-formatting-manager",
    title: "Manage Conditional Formatting Rules",
    width: 700,
    height: 500,
  });
  
  // Register ribbon menu item
  registerConditionalFormattingMenu();
  
  console.log("[ConditionalFormatting] Extension activated");
}

/**
 * Deactivate the conditional formatting extension.
 */
function deactivate(): void {
  console.log("[ConditionalFormatting] Deactivating extension");
  
  if (cleanupInterceptor) {
    cleanupInterceptor();
    cleanupInterceptor = null;
  }
  
  if (cleanupDataListener) {
    cleanupDataListener();
    cleanupDataListener = null;
  }
  
  if (cleanupSheetListener) {
    cleanupSheetListener();
    cleanupSheetListener = null;
  }
  
  // Clear all rules and caches
  ruleSets.clear();
  cellDataCache.clear();
  clearRangeContextCache();
  extensionContext = null;
  
  console.log("[ConditionalFormatting] Extension deactivated");
}

/**
 * Register the Conditional Formatting menu in the ribbon.
 */
function registerConditionalFormattingMenu(): void {
  registerMenu({
    id: "conditional-formatting",
    label: "Conditional Formatting",
    parentId: "home", // Goes in Home tab
    items: [
      {
        id: "cf-highlight-cells",
        label: "Highlight Cells Rules",
        icon: "highlight",
        children: [
          { id: "cf-greater-than", label: "Greater Than...", action: "cf:greaterThan" },
          { id: "cf-less-than", label: "Less Than...", action: "cf:lessThan" },
          { id: "cf-between", label: "Between...", action: "cf:between" },
          { id: "cf-equal-to", label: "Equal To...", action: "cf:equalTo" },
          { id: "cf-text-contains", label: "Text that Contains...", action: "cf:textContains" },
          { id: "cf-date-occurring", label: "A Date Occurring...", action: "cf:dateOccurring" },
          { id: "cf-duplicate", label: "Duplicate Values...", action: "cf:duplicate" },
        ],
      },
      {
        id: "cf-top-bottom",
        label: "Top/Bottom Rules",
        icon: "ranking",
        children: [
          { id: "cf-top-10", label: "Top 10 Items...", action: "cf:top10Items" },
          { id: "cf-top-10-percent", label: "Top 10%...", action: "cf:top10Percent" },
          { id: "cf-bottom-10", label: "Bottom 10 Items...", action: "cf:bottom10Items" },
          { id: "cf-bottom-10-percent", label: "Bottom 10%...", action: "cf:bottom10Percent" },
          { id: "cf-above-average", label: "Above Average...", action: "cf:aboveAverage" },
          { id: "cf-below-average", label: "Below Average...", action: "cf:belowAverage" },
        ],
      },
      { type: "separator" },
      { id: "cf-new-rule", label: "New Rule...", action: "cf:newRule", icon: "plus" },
      { id: "cf-clear-rules", label: "Clear Rules", action: "cf:clearRules", icon: "trash" },
      { id: "cf-manage-rules", label: "Manage Rules...", action: "cf:manageRules", icon: "settings" },
    ],
  });
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.conditional-formatting",
    name: "Conditional Formatting",
    version: "1.0.0",
    description: "Apply visual formatting to cells based on their values.",
  },
  activate,
  deactivate,
};

export default extension;

// Re-export types and utilities for consumers
export { generateRuleId, buildRangeContext };
export type { ConditionalRule, RuleCondition, RuleType, RangeContext } from "./types";
export { PRESET_STYLES, QUICK_FORMAT_PRESETS } from "./types";