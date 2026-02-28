//! FILENAME: app/extensions/Sparklines/index.ts
// PURPOSE: Sparklines extension entry point. Registers/unregisters all components.
// CONTEXT: Called from extensions/index.ts during app initialization.

import {
  registerDialog,
  unregisterDialog,
  registerMenuItem,
  showDialog,
  onAppEvent,
  AppEvents,
  cellEvents,
  ExtensionRegistry,
} from "../../src/api";
import { registerCellDecoration } from "../../src/api/cellDecorations";
import { drawSparkline } from "./rendering";
import { invalidateDataCache, resetSparklineStore } from "./store";
import { CreateSparklineDialog } from "./components/CreateSparklineDialog";
import { handleSelectionChange, resetSelectionHandlerState } from "./handlers/selectionHandler";
import { handleFillCompleted } from "./handlers/fillHandler";
import type { FillCompletedPayload } from "../../src/api/events";
import type { SparklineType } from "./types";

// ============================================================================
// Constants
// ============================================================================

export const SPARKLINE_DIALOG_ID = "sparkline:createDialog";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerSparklineExtension(): void {
  console.log("[Sparklines] Registering...");

  // 1. Register cell decoration for rendering sparklines
  const unregDecoration = registerCellDecoration("sparklines", drawSparkline, 20);
  cleanupFns.push(unregDecoration);

  // 2. Register dialog
  registerDialog({
    id: SPARKLINE_DIALOG_ID,
    component: CreateSparklineDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(SPARKLINE_DIALOG_ID));

  // 3. Register menu items under Insert > Sparklines
  registerMenuItem("insert", {
    id: "insert.sparklines",
    label: "Sparklines",
    children: [
      {
        id: "insert.sparklines.line",
        label: "Line",
        action: () => showDialog(SPARKLINE_DIALOG_ID, { sparklineType: "line" as SparklineType }),
      },
      {
        id: "insert.sparklines.column",
        label: "Column",
        action: () => showDialog(SPARKLINE_DIALOG_ID, { sparklineType: "column" as SparklineType }),
      },
      {
        id: "insert.sparklines.winloss",
        label: "Win/Loss",
        action: () => showDialog(SPARKLINE_DIALOG_ID, { sparklineType: "winloss" as SparklineType }),
      },
    ],
  });

  // 4. Subscribe to cell data changes to invalidate sparkline data cache
  const unsubCells = cellEvents.subscribe(() => {
    invalidateDataCache();
  });
  cleanupFns.push(unsubCells);

  const unsubData = onAppEvent(AppEvents.DATA_CHANGED, () => {
    invalidateDataCache();
  });
  cleanupFns.push(unsubData);

  // 5. Reset on sheet change
  const unsubSheet = onAppEvent(AppEvents.SHEET_CHANGED, () => {
    invalidateDataCache();
  });
  cleanupFns.push(unsubSheet);

  // 6. Subscribe to selection changes for the contextual Sparkline ribbon tab
  const unsubSelection = ExtensionRegistry.onSelectionChange(handleSelectionChange);
  cleanupFns.push(unsubSelection);

  // 7. Subscribe to fill-completed events for sparkline propagation
  const unsubFill = onAppEvent<FillCompletedPayload>(
    AppEvents.FILL_COMPLETED,
    handleFillCompleted,
  );
  cleanupFns.push(unsubFill);

  console.log("[Sparklines] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterSparklineExtension(): void {
  console.log("[Sparklines] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Sparklines] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  resetSelectionHandlerState();
  resetSparklineStore();

  console.log("[Sparklines] Unregistered.");
}
