//! FILENAME: app/extensions/Tracing/index.ts
// PURPOSE: Tracing extension entry point (Trace Precedents / Trace Dependents).
// CONTEXT: Registers the grid overlay, menu, dialog, and event subscriptions.
//          Called from extensions/index.ts during app initialization.

import {
  registerGridOverlay,
  onAppEvent,
  AppEvents,
  ExtensionRegistry,
  DialogExtensions,
} from "../../src/api";
import type { OverlayRegistration } from "../../src/api";
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
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerTracingExtension(): void {
  console.log("[Tracing] Registering...");

  // 1. Register grid overlay for trace arrows
  const unregOverlay = registerGridOverlay({
    type: REGION_TYPE,
    render: renderTraceArrows,
    hitTest: hitTestTraceArrow,
    priority: 25,
  } as OverlayRegistration);
  cleanupFns.push(unregOverlay);

  // 2. Register the "Go To" dialog for cross-sheet navigation
  DialogExtensions.registerDialog({
    id: "tracing-goto",
    component: GoToDialog,
    priority: 50,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("tracing-goto"));

  // 3. Register the Formulas menu
  registerFormulasMenu();

  // 4. Clear traces on sheet change
  const unsubSheet = onAppEvent(AppEvents.SHEET_CHANGED, () => {
    clearTraces();
  });
  cleanupFns.push(unsubSheet);

  // 5. Clear traces when cells are updated (dependency graph may have changed)
  const unsubCells = onAppEvent(AppEvents.CELLS_UPDATED, () => {
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

  console.log("[Tracing] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterTracingExtension(): void {
  console.log("[Tracing] Unregistering...");

  clearTraces();

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Tracing] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[Tracing] Unregistered.");
}
