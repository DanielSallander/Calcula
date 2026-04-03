//! FILENAME: app/extensions/Tracing/index.ts
// PURPOSE: Tracing extension entry point (Trace Precedents / Trace Dependents).
// CONTEXT: Registers the grid overlay, menu, dialog, and event subscriptions.
//          Activated by the shell during app initialization.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  AppEvents,
  ExtensionRegistry,
} from "@api";
import type { OverlayRegistration } from "@api";
import { renderTraceArrows } from "./rendering/traceArrowRenderer";
import { hitTestTraceArrow } from "./rendering/traceArrowHitTest";
import { registerFormulasMenu } from "./handlers/formulasMenuBuilder";
import { clearTraces, setCurrentSelection } from "./lib/tracingStore";
import { GoToDialog } from "./components/GoToDialog";

// ============================================================================
// Constants
// ============================================================================

const REGION_TYPE = "tracing";

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
    console.warn("[Tracing] Already activated, skipping.");
    return;
  }

  console.log("[Tracing] Activating...");

  // 1. Register grid overlay for trace arrows
  const unregOverlay = context.grid.overlays.register({
    type: REGION_TYPE,
    render: renderTraceArrows,
    hitTest: hitTestTraceArrow,
    priority: 25,
  } as OverlayRegistration);
  cleanupFns.push(unregOverlay);

  // 2. Register the "Go To" dialog for cross-sheet navigation
  context.ui.dialogs.register({
    id: "tracing-goto",
    component: GoToDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("tracing-goto"));

  // 3. Register the Formulas menu
  registerFormulasMenu(context);

  // 4. Clear traces on sheet change
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, () => {
    clearTraces();
  });
  cleanupFns.push(unsubSheet);

  // 5. Clear traces when cells are updated (dependency graph may have changed)
  const unsubCells = context.events.on(AppEvents.CELLS_UPDATED, () => {
    clearTraces();
  });
  cleanupFns.push(unsubCells);

  // 6. Track current selection for menu commands
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(
      sel
        ? { row: sel.startRow, col: sel.startCol }
        : null,
    );
  });
  cleanupFns.push(unsubSelection);

  isActivated = true;
  console.log("[Tracing] Activated successfully.");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  if (!isActivated) return;

  console.log("[Tracing] Deactivating...");

  clearTraces();

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Tracing] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  isActivated = false;
  console.log("[Tracing] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.tracing",
    name: "Tracing",
    version: "1.0.0",
    description: "Trace precedents, trace dependents, and remove arrows for formula auditing.",
  },
  activate,
  deactivate,
};

export default extension;
