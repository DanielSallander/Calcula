//! FILENAME: app/extensions/Sparklines/index.ts
// PURPOSE: Sparklines extension entry point. ExtensionModule lifecycle pattern.
// CONTEXT: Registers sparkline rendering, dialog, menu items, and event listeners.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  cellEvents,
  AppEvents,
  ExtensionRegistry,
} from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { drawSparkline } from "./rendering";
import {
  createSparklineGroup,
  removeSparklineGroup,
  updateSparklineGroup,
  getAllGroups,
  getGroupById,
  invalidateDataCache,
  resetSparklineStore,
  saveToBackend,
  loadFromBackend,
  setOnMutationCallback,
} from "./store";
import { CreateSparklineDialog } from "./components/CreateSparklineDialog";
import { handleSelectionChange, resetSelectionHandlerState, ensureDesignTabRegistered } from "./handlers/selectionHandler";
import { handleFillCompleted } from "./handlers/fillHandler";
import { emitAppEvent } from "@api/events";
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

/** Debounced save timer */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Get current active sheet index */
function getActiveSheetIndex(): number {
  const state = getGridStateSnapshot();
  return state?.sheetContext?.activeSheetIndex ?? 0;
}

/** Schedule a debounced save to backend (300ms) */
export function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveToBackend(getActiveSheetIndex());
  }, 300);
}

/** Immediately save to backend (e.g., before sheet switch) */
export function saveNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveToBackend(getActiveSheetIndex());
}

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[Sparklines] Already activated, skipping.");
    return;
  }

  console.log("[Sparklines] Activating...");

  // 0. Set up persistence callback
  setOnMutationCallback(scheduleSave);
  cleanupFns.push(() => setOnMutationCallback(null));

  // 1. Register cell decoration for rendering sparklines
  const unregDecoration = context.grid.decorations.register("sparklines", drawSparkline, 20);
  cleanupFns.push(unregDecoration);

  // 1b. Load sparklines from backend for the current sheet
  loadFromBackend(getActiveSheetIndex());

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

  // 3b. Register API commands for programmatic sparkline management
  ExtensionRegistry.registerCommand({
    id: "sparklines.create",
    name: "Create Sparkline",
    execute: async (ctx) => {
      const args = ctx as unknown as {
        locationStartRow: number; locationStartCol: number;
        locationEndRow: number; locationEndCol: number;
        dataStartRow: number; dataStartCol: number;
        dataEndRow: number; dataEndCol: number;
        type?: SparklineType; color?: string; negativeColor?: string;
      };
      const result = createSparklineGroup(
        { startRow: args.locationStartRow, startCol: args.locationStartCol, endRow: args.locationEndRow, endCol: args.locationEndCol },
        { startRow: args.dataStartRow, startCol: args.dataStartCol, endRow: args.dataEndRow, endCol: args.dataEndCol },
        args.type ?? "line",
        args.color,
        args.negativeColor,
      );
      if (result.valid) {
        emitAppEvent(AppEvents.GRID_REFRESH);
      }
    },
  });

  ExtensionRegistry.registerCommand({
    id: "sparklines.delete",
    name: "Delete Sparkline Group",
    execute: async (ctx) => {
      const args = ctx as unknown as { groupId: number };
      if (removeSparklineGroup(args.groupId)) {
        emitAppEvent(AppEvents.GRID_REFRESH);
      }
    },
  });

  ExtensionRegistry.registerCommand({
    id: "sparklines.update",
    name: "Update Sparkline Group",
    execute: async (ctx) => {
      const args = ctx as unknown as { groupId: number; updates: Record<string, unknown> };
      if (updateSparklineGroup(args.groupId, args.updates)) {
        emitAppEvent(AppEvents.GRID_REFRESH);
      }
    },
  });

  ExtensionRegistry.registerCommand({
    id: "sparklines.clearAll",
    name: "Clear All Sparklines",
    execute: async () => {
      resetSparklineStore();
      emitAppEvent(AppEvents.GRID_REFRESH);
    },
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

  // 5. Save and reload on sheet change
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, () => {
    // Save current sheet's sparklines first, then load the new sheet's
    saveNow();
    invalidateDataCache();
    loadFromBackend(getActiveSheetIndex());
  });
  cleanupFns.push(unsubSheet);

  // 5b. Load from backend on file open / new file
  const unsubAfterOpen = context.events.on(AppEvents.AFTER_OPEN, () => {
    loadFromBackend(getActiveSheetIndex());
  });
  cleanupFns.push(unsubAfterOpen);

  const unsubAfterNew = context.events.on(AppEvents.AFTER_NEW, () => {
    resetSparklineStore();
  });
  cleanupFns.push(unsubAfterNew);

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
