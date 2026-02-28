//! FILENAME: app/extensions/ConditionalFormatting/index.ts
// PURPOSE: Conditional Formatting extension entry point. Registers/unregisters all components.
// CONTEXT: Called from extensions/index.ts during app initialization.

import {
  registerStyleInterceptor,
  registerGridOverlay,
  registerDialog,
  unregisterDialog,
  onAppEvent,
  AppEvents,
  ExtensionRegistry,
  cellEvents,
  type OverlayRegistration,
} from "../../src/api";

import {
  refreshRules,
  evaluateViewport,
  invalidateCache,
  resetState,
} from "./lib/cfStore";
import { conditionalFormattingInterceptor } from "./lib/cfInterceptor";
import { setMenuSelection, registerCFMenuItems } from "./handlers/homeMenuBuilder";
import { QUICK_CF_DIALOG_ID, RULES_MANAGER_DIALOG_ID, NEW_RULE_DIALOG_ID } from "./handlers/homeMenuBuilder";
import { renderDataBars } from "./rendering/dataBarRenderer";
import { renderIconSets } from "./rendering/iconSetRenderer";
import { QuickCFDialog } from "./components/QuickCFDialog";
import { RulesManagerDialog } from "./components/RulesManagerDialog";
import { NewRuleDialog } from "./components/NewRuleDialog";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerConditionalFormattingExtension(): void {
  console.log("[ConditionalFormatting] Registering...");

  // 1. Register style interceptor
  // Priority 100: runs AFTER all other interceptors (Table=5, Checkbox=5).
  // This ensures Conditional Formatting overrides Computed Properties
  // (which apply at the base styleIndex level, before interceptors) and
  // other feature interceptors when they set the same style properties.
  const unregInterceptor = registerStyleInterceptor(
    "conditional-formatting",
    conditionalFormattingInterceptor,
    100
  );
  cleanupFns.push(unregInterceptor);

  // 2. Register grid overlay for data bars
  const unregDataBarOverlay = registerGridOverlay({
    type: "cf-data-bar",
    render: renderDataBars,
    priority: 5,
  } as OverlayRegistration);
  cleanupFns.push(unregDataBarOverlay);

  // 3. Register grid overlay for icon sets
  const unregIconSetOverlay = registerGridOverlay({
    type: "cf-icon-set",
    render: renderIconSets,
    priority: 6,
  } as OverlayRegistration);
  cleanupFns.push(unregIconSetOverlay);

  // 4. Register dialogs
  registerDialog({
    id: QUICK_CF_DIALOG_ID,
    component: QuickCFDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(QUICK_CF_DIALOG_ID));

  registerDialog({
    id: RULES_MANAGER_DIALOG_ID,
    component: RulesManagerDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(RULES_MANAGER_DIALOG_ID));

  registerDialog({
    id: NEW_RULE_DIALOG_ID,
    component: NewRuleDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(NEW_RULE_DIALOG_ID));

  // 5. Register menu items
  registerCFMenuItems();

  // 6. Subscribe to events

  // Selection changed: update cached selection for menu actions
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setMenuSelection({
      startRow: sel.startRow ?? sel.activeRow,
      startCol: sel.startCol ?? sel.activeCol,
      endRow: sel.endRow ?? sel.activeRow,
      endCol: sel.endCol ?? sel.activeCol,
    });
  });
  cleanupFns.push(unsubSelection);

  // Sheet changed: reset state and reload
  const unsubSheet = onAppEvent(AppEvents.SHEET_CHANGED, () => {
    resetState();
    refreshRules().then(() => {
      evaluateViewport(0, 0, 100, 30);
    });
  });
  cleanupFns.push(unsubSheet);

  // Cell data changed: invalidate and re-evaluate
  const unsubCells = cellEvents.subscribe(() => {
    invalidateCache();
  });
  cleanupFns.push(unsubCells);

  // Data changed event: invalidate and re-evaluate
  const unsubData = onAppEvent(AppEvents.DATA_CHANGED, () => {
    invalidateCache();
  });
  cleanupFns.push(unsubData);

  // 7. Initial load
  refreshRules().then(() => {
    // Evaluate a default viewport area on initial load
    evaluateViewport(0, 0, 100, 30);
  });

  console.log("[ConditionalFormatting] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterConditionalFormattingExtension(): void {
  console.log("[ConditionalFormatting] Unregistering...");

  // Run cleanup functions
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[ConditionalFormatting] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  // Reset state
  resetState();

  console.log("[ConditionalFormatting] Unregistered.");
}
