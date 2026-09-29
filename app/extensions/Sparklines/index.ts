//! FILENAME: app/extensions/Sparklines/index.ts
// PURPOSE: Sparklines extension entry point. ExtensionModule lifecycle pattern.
// CONTEXT: Registers sparkline rendering, dialog, menu items, and event listeners.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  cellEvents,
  AppEvents,
  ExtensionRegistry,
  IconSparkline,
  IconSparklineLine,
  IconSparklineColumn,
  IconSparklineWinLoss,
  type CommandDefinition,
} from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { refuseIfSelectionOwned, onSelectionOwnershipChanged } from "@api/selectionOwner";
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
import {
  handleSelectionChange,
  resetSelectionHandlerState,
  ensureDesignTabRegistered,
  syncDesignTabToSelectionOwner,
} from "./handlers/selectionHandler";
import { handleFillCompleted } from "./handlers/fillHandler";
import { emitAppEvent } from "@api/events";
import type { FillCompletedPayload } from "@api/events";
import type { SparklineType } from "./types";
import { sparklinesBackend } from "./lib/sparklinesBackend";

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

/** The add-in whose contributions are the sparklines.* commands. */
const SPARKLINE_COMMANDS_ADDIN_ID = "calcula.sparklines.commands";

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[Sparklines] Already activated, skipping.");
    return;
  }

  console.log("[Sparklines] Activating...");

  // 0a. Bind the capability-gated backend channel before any backend call (A3).
  sparklinesBackend.set(context.invokeBackend);

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

  // 3. Register menu items under Insert > Sparklines. The dialog places the
  //    sparklines in Core's selection -- HIDDEN while something else owns the
  //    selection (a floating grid's selected cell) -- so every type refuses,
  //    once (D4, BUG-0185 class).
  const openCreateDialog = (sparklineType: SparklineType): void => {
    if (refuseIfSelectionOwned("Insert Sparklines")) return;
    context.ui.dialogs.show(SPARKLINE_DIALOG_ID, { sparklineType });
  };
  context.ui.menus.registerItem("insert", {
    id: "insert.sparklines",
    label: "Sparklines",
    icon: IconSparkline,
    children: [
      {
        id: "insert.sparklines.line",
        label: "Line",
        icon: IconSparklineLine,
        action: () => openCreateDialog("line"),
      },
      {
        id: "insert.sparklines.column",
        label: "Column",
        icon: IconSparklineColumn,
        action: () => openCreateDialog("column"),
      },
      {
        id: "insert.sparklines.winloss",
        label: "Win/Loss",
        icon: IconSparklineWinLoss,
        action: () => openCreateDialog("winloss"),
      },
    ],
  });

  // 3b. Register API commands for programmatic sparkline management. They are
  //     an add-in's contributions, taken away WITH the extension by one
  //     unregisterAddIn (the D3 / W21 class: before registerCommand had an
  //     inverse, sparklines.* outlived deactivate; ExtensionRegistry
  //     .unregisterCommand exists since wave D, and the add-in stays the one
  //     call for the three), as is the Insert > Sparklines item.
  cleanupFns.push(() => context.ui.menus.unregisterItem("insert", "insert.sparklines"));
  const sparklineCommands: CommandDefinition[] = [];
  sparklineCommands.push({
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

  sparklineCommands.push({
    id: "sparklines.delete",
    name: "Delete Sparkline Group",
    execute: async (ctx) => {
      const args = ctx as unknown as { groupId: number };
      if (removeSparklineGroup(args.groupId)) {
        emitAppEvent(AppEvents.GRID_REFRESH);
      }
    },
  });

  sparklineCommands.push({
    id: "sparklines.update",
    name: "Update Sparkline Group",
    execute: async (ctx) => {
      const args = ctx as unknown as { groupId: number; updates: Record<string, unknown> };
      if (updateSparklineGroup(args.groupId, args.updates)) {
        emitAppEvent(AppEvents.GRID_REFRESH);
      }
    },
  });

  sparklineCommands.push({
    id: "sparklines.clearAll",
    name: "Clear All Sparklines",
    execute: async () => {
      resetSparklineStore();
      emitAppEvent(AppEvents.GRID_REFRESH);
    },
  });
  ExtensionRegistry.registerAddIn({
    id: SPARKLINE_COMMANDS_ADDIN_ID,
    name: "Sparklines",
    version: "1.0.0",
    description: "Sparkline commands (create, delete, update, clear all).",
    commands: sparklineCommands,
  });
  cleanupFns.push(() => ExtensionRegistry.unregisterAddIn(SPARKLINE_COMMANDS_ADDIN_ID));

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

  // 5c. Undo/redo of sparkline operations restores backend state — re-pull
  // (dispatched by the core undo handler when UndoResult.objectsChanged).
  const handleSparklinesRefresh = () => {
    invalidateDataCache();
    loadFromBackend(getActiveSheetIndex());
  };
  window.addEventListener("sparklines:refresh", handleSparklinesRefresh);
  cleanupFns.push(() => {
    window.removeEventListener("sparklines:refresh", handleSparklinesRefresh);
  });

  // 6. Subscribe to selection changes for the contextual Sparkline ribbon tab
  const unsubSelection = ExtensionRegistry.onSelectionChange(handleSelectionChange);
  cleanupFns.push(unsubSelection);
  // ...and to a selection owner's claim starting or ending: the tab stands
  // aside while a floating grid's cell holds the selection (W22).
  cleanupFns.push(onSelectionOwnershipChanged(() => syncDesignTabToSelectionOwner()));

  // 7. Subscribe to fill-completed events for sparkline propagation
  const unsubFill = context.events.on<FillCompletedPayload>(
    AppEvents.FILL_COMPLETED,
    handleFillCompleted,
  );
  cleanupFns.push(unsubFill);

  isActivated = true;

  // Expose lifecycle functions for E2E invariant testing
  (window as any).__CALCULA_SPARKLINES__ = {
    createSparklineGroup,
    removeSparklineGroup,
    getAllGroups,
    ensureDesignTabRegistered,
  };

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
