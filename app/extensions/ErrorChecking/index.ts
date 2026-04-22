//! FILENAME: app/extensions/ErrorChecking/index.ts
// PURPOSE: Error Checking extension entry point. Registers green triangle indicators
//          for cells with potential errors (number stored as text, formula errors).
// CONTEXT: Activated by the shell during app initialization.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { AppEvents, cellEvents } from "@api";

import { drawErrorTriangle } from "./rendering/errorTriangleRenderer";
import {
  refreshErrorIndicatorsImmediate,
  resetErrorStore,
} from "./lib/errorCheckingStore";

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
    console.warn("[ErrorChecking] Already activated, skipping.");
    return;
  }

  console.log("[ErrorChecking] Activating...");

  // 1. Register cell decoration for green error indicator triangles
  //    Priority 10: draw underneath annotations (priority 5) but above most decorations
  const unregDecoration = context.grid.decorations.register(
    "error-checking-triangles",
    drawErrorTriangle,
    10
  );
  cleanupFns.push(unregDecoration);

  // 2. Subscribe to cell data changes (edits, formula recalculations)
  const unsubCells = cellEvents.subscribe(() => {
    refreshErrorIndicatorsImmediate();
  });
  cleanupFns.push(unsubCells);

  // 3. Subscribe to sheet changes
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, () => {
    resetErrorStore();
    refreshErrorIndicatorsImmediate();
  });
  cleanupFns.push(unsubSheet);

  // 4. Subscribe to data changes (batch operations, paste, fill, etc.)
  const unsubData = context.events.on(AppEvents.DATA_CHANGED, () => {
    refreshErrorIndicatorsImmediate();
  });
  cleanupFns.push(unsubData);

  // 5. Initial load
  refreshErrorIndicatorsImmediate();

  isActivated = true;
  console.log("[ErrorChecking] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[ErrorChecking] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[ErrorChecking] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  resetErrorStore();

  isActivated = false;
  console.log("[ErrorChecking] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.error-checking",
    name: "Error Checking",
    version: "1.0.0",
    description:
      "Displays green triangle indicators on cells with potential errors such as numbers stored as text or formula errors.",
  },
  activate,
  deactivate,
};

export default extension;
