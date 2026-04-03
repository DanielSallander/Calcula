//! FILENAME: app/extensions/Sparklines/index.ts
// PURPOSE: Sparklines extension entry point. ExtensionModule lifecycle pattern.
// CONTEXT: Registers sparkline rendering, dialog, menu items, and event listeners.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  cellEvents,
  AppEvents,
  ExtensionRegistry,
} from "@api";
import { drawSparkline } from "./rendering";
import { invalidateDataCache, resetSparklineStore } from "./store";
import { CreateSparklineDialog } from "./components/CreateSparklineDialog";
import { handleSelectionChange, resetSelectionHandlerState } from "./handlers/selectionHandler";
import { handleFillCompleted } from "./handlers/fillHandler";
import type { FillCompletedPayload } from "@api/events";
import type { SparklineType } from "./types";

// ============================================================================
// Constants
// ============================================================================

export const SPARKLINE_DIALOG_ID = "sparkline:createDialog";

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
    console.warn("[Sparklines] Already activated, skipping.");
    return;
  }

  console.log("[Sparklines] Activating...");

  // 1. Register cell decoration for rendering sparklines
  const unregDecoration = context.grid.decorations.register("sparklines", drawSparkline, 20);
  cleanupFns.push(unregDecoration);

  // 2. Register dialog
  context.ui.dialogs.register({
    id: SPARKLINE_DIALOG_ID,
    component: CreateSparklineDialog,
    priority: 50,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(SPARKLINE_DIALOG_ID));

  // 3. Register menu items under Insert > Sparklines
  context.ui.menus.registerItem("insert", {
    id: "insert.sparklines",
    label: "Sparklines",
    children: [
      {
        id: "insert.sparklines.line",
        label: "Line",
        action: () => context.ui.dialogs.show(SPARKLINE_DIALOG_ID, { sparklineType: "line" as SparklineType }),
      },
      {
        id: "insert.sparklines.column",
        label: "Column",
        action: () => context.ui.dialogs.show(SPARKLINE_DIALOG_ID, { sparklineType: "column" as SparklineType }),
      },
      {
        id: "insert.sparklines.winloss",
        label: "Win/Loss",
        action: () => context.ui.dialogs.show(SPARKLINE_DIALOG_ID, { sparklineType: "winloss" as SparklineType }),
      },
    ],
  });

  // 4. Subscribe to cell data changes to invalidate sparkline data cache
  const unsubCells = cellEvents.subscribe(() => {
    invalidateDataCache();
  });
  cleanupFns.push(unsubCells);

  const unsubData = context.events.on(AppEvents.DATA_CHANGED, () => {
    invalidateDataCache();
  });
  cleanupFns.push(unsubData);

  // 5. Reset on sheet change
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, () => {
    invalidateDataCache();
  });
  cleanupFns.push(unsubSheet);

  // 6. Subscribe to selection changes for the contextual Sparkline ribbon tab
  const unsubSelection = ExtensionRegistry.onSelectionChange(handleSelectionChange);
  cleanupFns.push(unsubSelection);

  // 7. Subscribe to fill-completed events for sparkline propagation
  const unsubFill = context.events.on<FillCompletedPayload>(
    AppEvents.FILL_COMPLETED,
    handleFillCompleted,
  );
  cleanupFns.push(unsubFill);

  isActivated = true;
  console.log("[Sparklines] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[Sparklines] Deactivating...");

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

  isActivated = false;
  console.log("[Sparklines] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.sparklines",
    name: "Sparklines",
    version: "1.0.0",
    description: "In-cell sparkline charts (line, column, win/loss).",
  },
  activate,
  deactivate,
};

export default extension;
