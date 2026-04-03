//! FILENAME: app/extensions/ConditionalFormatting/index.ts
// PURPOSE: Conditional Formatting extension entry point. ExtensionModule lifecycle.
// CONTEXT: Activated by the shell during app initialization.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  AppEvents,
  ExtensionRegistry,
  cellEvents,
  type OverlayRegistration,
} from "@api";

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
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[ConditionalFormatting] Already activated, skipping.");
    return;
  }

  console.log("[ConditionalFormatting] Activating...");

  // 1. Register style interceptor
  // Priority 100: runs AFTER all other interceptors (Table=5, Checkbox=5).
  // This ensures Conditional Formatting overrides Computed Properties
  // (which apply at the base styleIndex level, before interceptors) and
  // other feature interceptors when they set the same style properties.
  const unregInterceptor = context.grid.styleInterceptors.register(
    "conditional-formatting",
    conditionalFormattingInterceptor,
    100
  );
  cleanupFns.push(unregInterceptor);

  // 2. Register grid overlay for data bars
  const unregDataBarOverlay = context.grid.overlays.register({
    type: "cf-data-bar",
    render: renderDataBars,
    priority: 5,
  } as OverlayRegistration);
  cleanupFns.push(unregDataBarOverlay);

  // 3. Register grid overlay for icon sets
  const unregIconSetOverlay = context.grid.overlays.register({
    type: "cf-icon-set",
    render: renderIconSets,
    priority: 6,
  } as OverlayRegistration);
  cleanupFns.push(unregIconSetOverlay);

  // 4. Register dialogs
  context.ui.dialogs.register({
    id: QUICK_CF_DIALOG_ID,
    component: QuickCFDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(QUICK_CF_DIALOG_ID));

  context.ui.dialogs.register({
    id: RULES_MANAGER_DIALOG_ID,
    component: RulesManagerDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(RULES_MANAGER_DIALOG_ID));

  context.ui.dialogs.register({
    id: NEW_RULE_DIALOG_ID,
    component: NewRuleDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(NEW_RULE_DIALOG_ID));

  // 5. Register menu items
  registerCFMenuItems(context);

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
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, () => {
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
  const unsubData = context.events.on(AppEvents.DATA_CHANGED, () => {
    invalidateCache();
  });
  cleanupFns.push(unsubData);

  // 7. Initial load
  refreshRules().then(() => {
    // Evaluate a default viewport area on initial load
    evaluateViewport(0, 0, 100, 30);
  });

  isActivated = true;
  console.log("[ConditionalFormatting] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[ConditionalFormatting] Deactivating...");

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

  isActivated = false;
  console.log("[ConditionalFormatting] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.conditional-formatting",
    name: "Conditional Formatting",
    version: "1.0.0",
    description: "Highlight cells, color scales, data bars, icon sets, and rule management for conditional formatting.",
  },
  activate,
  deactivate,
};

export default extension;
